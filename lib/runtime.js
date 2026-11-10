/**
 * lib/runtime.js — 插件运行时：索引生命周期 + 快照缓存 + 项目身份。
 *
 * 三条硬约束驱动了这里的每个设计：
 *  1. **注入渲染是同步的**（DSH 的组装链路同步求值 `context.text`），所以
 *     扫描与索引必须能同步完成——因此这里不用 worker、不用异步 IO。
 *  2. **插件故障不能拖垮宿主**：索引打不开、扫描失败，都降级为"只剩提示
 *     文本"，绝不把异常抛进 DSH 的组装链路。
 *  3. **常驻成本要有闸门**：扫描按 `scanThrottleMs` 节流，写入后主动失效，
 *     不会每个模型步都重扫整个记忆根。
 *
 * @module vanwork-memory-core/lib/runtime
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './config.js'
import { Ledger } from './ledger.js'
import { openIndex } from './indexdb.js'
import { coreRoot, listProjectDirs, memoryRoot, resolveProjectDir, resolveProjectId } from './paths.js'
import { ensureRootLayout, scanRoot } from './scanner.js'
import { annotateEntries, readMarks, summarizeMarks } from './suspect.js'
import { readSlots, shouldResort, writeSlots } from './slots.js'
import { buildEmbeddingProvider } from './retrieve.js'
import { cloudPlan } from './cloud.js'
import { dueInfo, readState } from './consolidate.js'

/** 「别的写者是否写了记忆」的采样节流（毫秒）。 */
const EXTERNAL_CHECK_THROTTLE_MS = 2_000

/** mtime 推进容差（毫秒）：小于它的差异视为同一批写入/时钟抖动，不算"别人写了"。 */
const EXTERNAL_MTIME_TOLERANCE_MS = 1_000

/** 直接 stat 的关键记忆文件（浅扫之外的第一批候选）。 */
const MEMORY_MTIME_TARGETS = ['MEMORY.md', 'USER.md', 'SUGGESTIONS.jsonl']

/** stat 一个路径的 mtime（失败返回 null）。 */
function mtimeMsSafe(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * 创建运行时。
 *
 * @param {object} p - { config, logger, ctx }。
 * @returns {object} 运行时句柄。
 */
export function createRuntime({ config: rawConfig = {}, logger = console, ctx = null } = {}) {
  const config = resolveConfig(rawConfig)
  const memoryDir = memoryRoot(config)
  const coreDir = coreRoot(config)

  if (config.standaloneStore !== false) {
    try {
      // 2026-11-04：不再只在"记忆根不存在"时布局。每次启动都幂等补齐应有文件
      // （只写不存在的路径，已有内容一个字都不动）。这样打开记忆根就能看到
      // 完整的轨结构，而不是"用得多了才长出文件"。
      ensureRootLayout(memoryDir, { precreate: config.precreateFiles !== false })
    } catch (error) {
      logger?.warn?.(`[memory-core] 记忆根初始化失败：${error?.message ?? error}`)
    }
  }

  // 审计账本可整体关闭（ledgerEnabled=false）：关闭后各工具里的
  // `rt.ledger?.append(...)` 全部自动变成 no-op（全程可选链，无需分支）。
  const ledger = config.ledgerEnabled === false
    ? null
    : new Ledger(coreDir, { maxBytes: config.ledgerMaxBytes })
  const provider = safe(() => buildEmbeddingProvider(config, logger), logger, 'embedding 初始化')

  /** @type {object|null} 索引句柄（懒加载）。 */
  let index = null
  let indexError = null
  /** @type {object|null} 最近一次扫描结果。 */
  let snapshot = null
  let lastScanAt = 0
  let lastEntryCount = null
  /** 索引槽位状态（懒加载：既在内存里，也落盘，重启后顺序不被打乱）。 */
  let slotState = null

  /**
   * 每会话的「轮次 / 距上次写入」计数。
   *
   * 为什么要按会话分段（而不是一个全局计数）：注入的提醒必须只反映**这个
   * 会话**的写入情况——否则另一个会话写了记忆，本会话的提醒就消失了，
   * 模型会以为"我刚记过"。这与 dsh-memory-evolve 的 writeGapCounter 同款
   * 取舍（它也按 agent 分段）。
   *
   * 计数只在内存里（进程重启即归零）：它驱动的是**提示**而不是事实，
   * 丢了最多让提醒晚几轮出现，绝不会造成错误的状态判断。
   */
  const writeGaps = new Map()
  /** 上一次记账用的时间戳（同一轮被渲染多次时不重复计数）。 */
  const lastTurnStamps = new Map()
  /** 只用于诊断的累计轮次。 */
  const turnsVisited = new Map()
  /** 上次观察到的最新记忆文件 mtime（用于桥接"别的写者"）。 */
  let lastObservedMtime = null
  let lastExternalCheck = 0
  /**
   * 本会话是否调用过记忆工具（懒加载注入的唤醒条件之一，2026-10-30）。
   * 只在内存里：它驱动的是注入的"核心段 → 全量目录"跳变，重启后回到核心段
   * 是正确行为（新会话本来就该从省成本的状态开始）。
   */
  const memoryUsed = new Map()

  // ── 运行时总开关（2026-11-02：设置页「记忆管理」的启用/停用）──────────────
  /**
   * 为什么放 coreDir 而不是 profile 配置：profile 改动要重启才生效，而开关
   * 要的是「点一下立刻生效」——它是**运行时状态**而不是配置。落在
   * `<coreDir>/switch.json`（`{ "enabled": false }`）：
   *   - **缺文件 = 启用**（默认开，与所有既有部署兼容）；
   *   - 读不出来/文件损坏 → 也按启用处理——开关文件坏掉不该把记忆整个锁死；
   *   - 想强制恢复启用，删掉这个文件即可。
   *
   * 每次调用只 stat 一下 mtime，变了才重读：多进程/多上下文里另一处改了
   * 开关，这里下一次渲染就能看到（开关是全机共享的，不按会话分）。
   */
  /**
   * 布尔开关工厂：`<coreDir>/<name>.json`（`{ "enabled": bool }`）+ mtime 缓存。
   *
   * 抽出工厂是因为现在有两个开关（总开关 / 开发者模式），机制完全一样：
   * 缺文件 = 取 `fallback`；文件损坏 = 也取 `fallback`（开关坏掉不该把功能锁死）；
   * 想强制复位，删掉对应文件即可。
   *
   * @param {string} file - 开关文件绝对路径。
   * @param {object} [opts] - { fallback=true, coerce=(raw)=>raw!==false }。
   */
  function createFlag(file, opts = {}) {
    const fallback = opts.fallback ?? true
    const coerce = opts.coerce ?? ((raw) => raw !== false)
    let cache = { value: fallback, mtime: null }

    return {
      get() {
        let mtime = null
        try { mtime = statSync(file).mtimeMs } catch { mtime = null }
        if (mtime === null) {
          if (cache.mtime !== null || cache.value !== fallback) cache = { value: fallback, mtime: null }
          return fallback
        }
        if (cache.mtime !== mtime) {
          let value = fallback
          try { value = coerce(JSON.parse(readFileSync(file, 'utf8')).enabled) } catch { value = fallback }
          cache = { value, mtime }
        }
        return cache.value
      },

      /** 写开关（原子写 + 刷新缓存；失败如实返回旧状态并告警，绝不抛）。 */
      set(value) {
        const next = value === true
        try {
          mkdirSync(coreDir, { recursive: true })
          const tmp = `${file}.tmp-${process.pid}`
          writeFileSync(tmp, `${JSON.stringify({ enabled: next, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
          renameSync(tmp, file)
        } catch (error) {
          logger?.warn?.(`[memory-core] 写开关失败（保持原状态 ${cache.value ? '开' : '关'}）：${error?.message ?? error}`)
          return cache.value
        }
        cache = { value: next, mtime: safe(() => statSync(file).mtimeMs, logger, 'flag stat') ?? Date.now() }
        return cache.value
      },
    }
  }

  const switchFlag = createFlag(join(coreDir, 'switch.json'), { fallback: true })
  /**
   * 开发者模式（2026-11-04）：设置页里把记忆根下**全部 .md** 开放成可读可写。
   * **默认关闭**——它绕过 `mem_*` 的写入门槛与条目级校验，属于"我知道我在干什么"
   * 的开关；关闭时所有 dev 接口一律 403，界面只有总开关与 GLOBAL.md。
   */
  const devFlag = createFlag(join(coreDir, 'devmode.json'), { fallback: false, coerce: (raw) => raw === true })

  /** 总开关是否打开（缺文件/读失败 → true）。 */
  function enabled() { return switchFlag.get() }
  function setEnabled(value) { return switchFlag.set(value) }

  /** 开发者模式是否打开（缺文件/读失败 → false）。 */
  function devMode() { return devFlag.get() }
  function setDevMode(value) { return devFlag.set(value) }

  /**
   * 幂等补齐记忆布局（启动后也可再调）。
   *
   * 为什么不放进 `refresh`：那条路径在每个模型步都可能跑，而"渲染路径不该写盘"
   * 是这里的硬纪律（见 refresh 里可疑标记那段注释）。所以补齐只发生在两个明确时机：
   *  1. 插件装载时（root 级）；
   *  2. 用户打开管理面板 / 开发者模式时（root + 所有已存在的项目目录）。
   * 跨天的 `daily/<today>.md` 也靠这两个时机补上，而不是每一步都 stat。
   *
   * @param {object} [opts] - { all=true }：是否连已存在的项目目录一起补。
   * @returns {{created: string[]}}
   */
  function ensureLayout(opts = {}) {
    if (config.standaloneStore === false) return { created: [] }
    if (config.precreateFiles === false) return { created: [] }
    const projectDirs = opts.all === false ? [] : listProjectDirs(join(memoryDir, 'projects')).map((item) => item.dir)
    return ensureRootLayout(memoryDir, { precreate: true, projectDirs })
  }

  /** 会话分段键：优先 agent.session.id，缺失时落到本进程的默认桶。 */
  function sessionKeyOf(agent) {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : '__default__'
  }

  /** 该会话距上次写入经过了多少轮。 */
  function turnsSinceWriteOf(agent) {
    return writeGaps.get(sessionKeyOf(agent)) ?? 0
  }

  /** 该会话累计轮次（懒加载注入的唤醒条件之二：闲聊通常两三轮就结束）。 */
  function turnsOf(agent) {
    return turnsVisited.get(sessionKeyOf(agent)) ?? 0
  }

  /** 本会话用过了记忆工具（mem_search/mem_read/mem_write/…）→ 唤醒全量注入。 */
  function noteMemoryUse(agent) {
    memoryUsed.set(sessionKeyOf(agent), true)
  }

  /** 本会话是否用过记忆工具。 */
  function memoryUsedOf(agent) {
    return memoryUsed.get(sessionKeyOf(agent)) === true
  }

  /** 记录一轮对话（由注入渲染的副作用调用；同一 agent 的连续渲染最多计一次）。 */
  function noteTurn(agent, opts = {}) {
    const key = sessionKeyOf(agent)
    const stamp = opts.stamp ?? null
    // 桥接"别的写者也写了记忆"：旧实现的 memory 工具、记忆 Tab 的编辑都不经过
    // 本插件，所以它们写完我们的计数不会归零——不桥接的话会一直误报"最近若干轮
    // 没有写入记忆"。做法是**纯状态**的：看记忆根下最新 mtime 有没有推进。
    // 见 detectExternalWrite 的保守规则（只看"观测点 → 观测点"的单向推进）。
    if (detectExternalWrite()) {
      // 有人（旧 memory 工具 / 记忆 Tab / 别的进程）刚刚写了记忆 → 这个会话的
      // "未写"计数归零，**并且这一轮不再累加**：刚写过就是刚写过，把这一轮也算成
      // "没写"会让提醒立刻又冒出来。
      writeGaps.set(key, 0)
      lastTurnStamps.delete(key)
      return 0
    }
    if (stamp !== null && lastTurnStamps.get(key) === stamp) return turnsSinceWriteOf(agent)
    if (stamp !== null) lastTurnStamps.set(key, stamp)
    turnsVisited.set(key, (turnsVisited.get(key) ?? 0) + 1)
    const gap = (writeGaps.get(key) ?? 0) + 1
    writeGaps.set(key, gap)
    return gap
  }

  /**
   * 记忆根下是否有文件在我们上次记账之后被写过（含别人写的）。
   *
   * 规则（刻意保守，宁可漏报也不误报）：
   *  - 只有**前后两次都观测到真实 mtime**、且新值推进超过容差，才判定"有人写了"；
   *    这样"记忆根刚被创建、文件凭空出现"或"本进程重启后第一次观测"都不会误判；
   *  - **绝不使用未来时间戳做基线**：宿主时钟可能领先文件系统（实测本机就有
   *    数秒级偏移），拿 `Date.now()` 当基线会把之后所有真实写入都判成"不新"。
   *
   * 成本：一次浅扫描（最多 60 个 stat）+ 节流（默认 2s，可配）。
   */
  function detectExternalWrite() {
    const now = Date.now()
    // 节流可配（默认 2s）：设 0 表示每次都检查（测试与"写入很频繁"的部署可用）。
    const throttle = Number.isFinite(config.externalWriteThrottleMs) ? config.externalWriteThrottleMs : EXTERNAL_CHECK_THROTTLE_MS
    if (now - lastExternalCheck < throttle) return false
    lastExternalCheck = now
    const newest = newestMemoryMtime()
    if (newest === null) return false
    if (lastObservedMtime === null) {
      lastObservedMtime = newest
      return false
    }
    const advanced = newest - lastObservedMtime > EXTERNAL_MTIME_TOLERANCE_MS
    if (newest > lastObservedMtime) lastObservedMtime = newest
    return advanced
  }

  /** 记忆根下最新的文件 mtime（浅扫，最多 60 个文件）。 */
  function newestMemoryMtime() {
    let newest = null
    for (const rel of MEMORY_MTIME_TARGETS) {
      const mtime = mtimeMsSafe(join(memoryDir, rel))
      if (mtime !== null && (newest === null || mtime > newest)) newest = mtime
    }
    try {
      for (const dir of ['', join('daily'), join('projects')]) {
        const base = dir === '' ? memoryDir : join(memoryDir, dir)
        const entries = readdirSync(base, { withFileTypes: true })
        let seen = 0
        for (const entry of entries) {
          if (seen >= 60) break
          const full = join(base, entry.name)
          const mtime = entry.isDirectory() ? null : mtimeMsSafe(full)
          if (mtime !== null) {
            seen += 1
            if (newest === null || mtime > newest) newest = mtime
          }
        }
      }
    } catch { /* 目录不存在/不可读：忽略 */ }
    return newest
  }

  /** 记忆写入成功 → 该会话的"未写"计数归零。 */
  function noteWrite(agent) {
    const key = sessionKeyOf(agent)
    writeGaps.set(key, 0)
    lastTurnStamps.delete(key)
    lastObservedMtime = newestMemoryMtime()
    return 0
  }

  /** 诊断用：当前所有会话的计数（不注入，仅工具/测试读取）。 */
  function counters() {
    return {
      turns: Object.fromEntries(turnsVisited),
      gaps: Object.fromEntries(writeGaps),
      /** 桥接基线（最新观测到的记忆文件 mtime）与观测时刻——诊断"提醒为何还在响"。 */
      bridge: { observedMtime: lastObservedMtime, lastCheckAt: lastExternalCheck },
    }
  }

  function ensureIndex() {
    if (index !== null || indexError !== null) return index
    try {
      index = openIndex({ dir: coreDir, backend: 'auto', logger })
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[memory-core] 索引不可用，记忆功能降级为纯提示：${indexError}`)
    }
    return index
  }

  /**
   * 取当前快照（必要时重扫）。
   * @param {object} [opts] - { force, cwd }。
   */
  function getSnapshot(opts = {}) {
    const now = Date.now()
    const stale = snapshot === null || (now - lastScanAt) >= (config.scanThrottleMs ?? 10_000)
    if (opts.force === true || stale) refresh({ cwd: opts.cwd, now })
    return snapshot
  }

  /**
   * 重扫记忆根并增量同步索引。
   * @param {object} [opts] - { cwd, now }。
   */
  function refresh(opts = {}) {
    const now = opts.now ?? Date.now()
    const cwd = opts.cwd ?? null
    let scan
    try {
      scan = scanRoot(memoryDir, { maxFiles: config.scanMaxFiles, maxDepth: config.scanMaxDepth, now })
    } catch (error) {
      logger?.warn?.(`[memory-core] 扫描失败：${error?.message ?? error}`)
      scan = { root: memoryDir, exists: false, entries: [], files: [], skipped: [] }
    }

    let sync = { added: 0, removed: 0, filesIndexed: 0 }
    const handle = ensureIndex()
    if (handle) {
      try {
        sync = handle.sync(scan.entries, scan.files)
      } catch (error) {
        logger?.warn?.(`[memory-core] 索引同步失败：${error?.message ?? error}`)
      }
    }

    const identity = cwd ? resolveProjectId(cwd) : null
    let projectId = identity?.id ?? null
    let projectLabel = identity?.displayName ?? null
    if (cwd) {
      try {
        const dir = resolveProjectDir(memoryDir, cwd, { allowSingleProjectFallback: true })
        projectId = dir.id
        projectLabel = dir.displayName ?? projectLabel
      } catch { /* 保持按 cwd 算出的身份 */ }
    }

    const stats = handle ? safe(() => handle.stats(), logger, '索引统计') : null
    // 可疑标记是"贴"在条目上的（内容寻址），刷新时只读地贴上：
    // 这里**不清理孤儿标记**——渲染路径不该写盘，孤儿留给 mem_consolidate(apply)
    // 与 mem_reindex 处理，并在体检里标 orphan 可见。
    const suspectMarks = config.suspectEnabled === false ? {} : readMarks(coreDir).marks
    const suspectHit = annotateEntries(scan.entries, suspectMarks)
    snapshot = {
      ...scan,
      sync,
      stats,
      indexError,
      projectId,
      projectLabel,
      cwd,
      scannedAt: now,
      suspectHit,
      suspectTotal: Object.keys(suspectMarks).length,
    }
    lastScanAt = now
    const newCount = scan.entries.length
    if (lastEntryCount !== null && newCount > lastEntryCount) snapshot.newSinceLastCheck = newCount - lastEntryCount
    lastEntryCount = newCount
    return snapshot
  }

  /** 让下一次取快照必然重扫（写入/整合之后调用）。 */
  function invalidate() {
    lastScanAt = 0
  }

  /** 解析会话工作目录。 */
  function cwdOf(agent) {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : null
  }

  /** 整合是否到期（供注入提示与健康检查）。 */
  function consolidation() {
    const snap = getSnapshot()
    const state = readState(coreDir)
    const info = dueInfo({ state, entryCount: snap.entries.length, config, now: Date.now() })
    return { ...info, state }
  }

  /** 云端分层画像（供健康检查）。 */
  function cloud() {
    const snap = getSnapshot()
    return cloudPlan(snap.entries, config)
  }

  /** 可疑标记的汇总（静默但可查：mem_health / mem_audit 用）。 */
  function suspects() {
    const snap = getSnapshot()
    return summarizeMarks({ coreDir, entries: snap.entries })
  }

  /** 读原始标记表（少量场景需要按 body 查）。 */
  function marks() {
    return readMarks(coreDir).marks
  }

  /**
   * 常驻索引的槽位（用于让注入文本在两次渲染之间保持位置稳定）。
   *
   * 返回 `null` 表示**这一轮做全量重排**（排名决定顺序）：首次、显式失效、
   * 或距上次超过 `indexResortEveryHours`。重排会丢一次 prefix 缓存，
   * 之后就重新稳定——这与 Codex「压缩只丢一次」的处理一致。
   *
   * @returns {string[]|null} 槽位键序列，或 null（要求重排）。
   */
  function indexSlots() {
    if (config.indexStableSlots === false) return null
    const resort = shouldResort({
      updatedAt: slotState?.updatedAt ?? 0,
      now: Date.now(),
      everyHours: config.indexResortEveryHours,
    })
    if (resort && slotState !== null) return null
    if (slotState === null) {
      slotState = readSlots(coreDir)
      if (shouldResort({ updatedAt: slotState.updatedAt, now: Date.now(), everyHours: config.indexResortEveryHours })) return null
    }
    return slotState.slots.length > 0 ? slotState.slots : null
  }

  /** 保存这一轮渲染出来的槽位顺序。 */
  function saveIndexSlots(slots) {
    if (config.indexStableSlots === false || !Array.isArray(slots)) return 0
    const now = Date.now()
    slotState = { updatedAt: now, slots: [...slots] }
    return writeSlots(coreDir, slotState.slots, now)
  }

  /** 让下一次渲染做全量重排（写记忆/整合/重建索引之后调用）。 */
  function invalidateIndexSlots() {
    slotState = { updatedAt: 0, slots: [] }
  }

  /**
   * 回灌向量索引：把"还没有向量"的条目算出来写进索引（**仅当 embedding 启用**）。
   *
   * 这是把"语义检索是空管道"补上的那一步——`retrieve.js` 早就会读 `vectors`，
   * `indexdb.js` 早就会 `putVectors`，缺的只是"谁来写向量"。这里补上写入点。
   *
   * 三条纪律：
   *  - **绝不在渲染热路径里调用**（provider.embed 是异步 + 可能联网）；只在
   *    `mem_reindex` / `mem_write(add)` 这类本来就异步的工具里 await；
   *  - 没 provider / 没开开关 → 直接返回 skipped，不联网、不报错；
   *  - 任何一次 embed 失败一律 catch 后降级返回，绝不让调用方（写入/重建）失败。
   *
   * @param {{force?: boolean}} [opts] - force=true 时即便已有向量也重算。
   * @returns {Promise<{ok: boolean, skipped?: string, embedded: number, total: number, error?: string}>}
   */
  async function syncVectors(opts = {}) {
    if (!provider || config.embedding?.enabled !== true) {
      return { ok: true, skipped: 'embedding-off', embedded: 0, total: 0 }
    }
    const handle = ensureIndex()
    if (!handle) return { ok: false, skipped: 'no-index', embedded: 0, total: 0 }
    const snap = getSnapshot({ force: opts.force === true ? true : false })
    const entries = snap.entries ?? []
    const total = entries.length
    try {
      const have = handle.getVectors(entries.map((entry) => entry.entryId))
      const missing = opts.force === true ? entries : entries.filter((entry) => !have.has(entry.entryId))
      if (missing.length === 0) return { ok: true, embedded: 0, total }
      const batch = Math.max(1, config.embedding.batchSize || 32)
      let embedded = 0
      for (let i = 0; i < missing.length; i += batch) {
        const slice = missing.slice(i, i + batch)
        const texts = slice.map((entry) => `${entry.summary ?? ''} ${entry.indexedBody ?? entry.body ?? ''}`)
        const vectors = await provider.embed(texts)
        const items = slice
          .map((entry, j) => ({ entryId: entry.entryId, model: provider.model, vec: vectors?.[j] }))
          .filter((item) => Array.isArray(item.vec) && item.vec.length > 0)
        if (items.length > 0) handle.putVectors(items)
        embedded += items.length
      }
      ledger?.append('vectors', { embedded, total, force: opts.force === true })
      return { ok: true, embedded, total }
    } catch (error) {
      logger?.warn?.(`[memory-core] 向量回灌失败（已降级，不影响检索）：${error?.message ?? error}`)
      return { ok: false, error: error instanceof Error ? error.message : String(error), embedded: 0, total }
    }
  }

  /** 注入提示文本中的整合线索（一行）。 */
  function consolidationHint() {
    try {
      const info = consolidation()
      if (!info.due) return ''
      return `整合提示：记忆已到可整合的时机（${info.reasons.length === 0 ? '间隔与增量均满足阈值' : info.reasons.join('；')}），执行 mem_consolidate（action=plan）查看方案。`
    } catch {
      return ''
    }
  }

  function close() {
    if (index) safe(() => index.close(), logger, '索引关闭')
    index = null
    snapshot = null
  }

  return {
    config,
    memoryDir,
    coreDir,
    ledger,
    provider,
    getSnapshot,
    refresh,
    invalidate,
    ensureIndex,
    cwdOf,
    consolidation,
    consolidationHint,
    cloud,
    suspects,
    marks,
    indexSlots,
    saveIndexSlots,
    invalidateIndexSlots,
    syncVectors,
    close,
    // 运行时总开关（设置页启用/停用）
    enabled,
    setEnabled,
    // 开发者模式（设置页「开发者模式」：开放记忆根下全部 .md 的读写）
    devMode,
    setDevMode,
    // 幂等补齐记忆布局（面板打开时把"应有文件"补齐）
    ensureLayout,
    // 每轮写入交接（接管 memory-evolve 的"未写看门狗"职责）
    sessionKeyOf,
    noteTurn,
    noteWrite,
    turnsSinceWriteOf,
    counters,
    // 懒加载注入（2026-10-30）：会话是否已"真的在用记忆"
    noteMemoryUse,
    memoryUsedOf,
    turnsOf,
    get indexError() { return indexError },
    /** 便于测试注入：把索引换成别的实现。 */
    _setIndex(handle) { index = handle; indexError = null },
  }
}

/** 统一的项目内目标文件路径（供写入使用）。 */
export function targetFile(memoryDir, rel) {
  return join(memoryDir, rel)
}

/** 安全执行：失败返回 fallback 并告警，绝不把异常抛出去。 */
export function safe(fn, logger = console, label = 'operation') {
  try {
    return fn()
  } catch (error) {
    logger?.warn?.(`[memory-core] ${label} 失败：${error?.message ?? error}`)
    return null
  }
}