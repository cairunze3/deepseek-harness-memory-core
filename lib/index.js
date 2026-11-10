/**
 * vanwork-memory-core — VanWork（DeepSeek Harness）的本地记忆核心层。
 *
 * 一句话：**在既有记忆正本之上，补上"索引常驻 + 硬预算 + 混合检索 + 自我整合
 * + 云端分层"这五件现有实现没做的事，且不与 dsh-memory-evolve 抢任何东西。**
 *
 * ## 与 dsh-memory-evolve 的边界（这是本插件最重要的设计约束）
 *
 * | 维度 | dsh-memory-evolve | vanwork-memory-core |
 * |---|---|---|
 * | 记忆正本 | 拥有（`<dshHome>/memories/**.md`） | **只读+受控编辑**，不另建存储 |
 * | 工具命名空间 | `memory` / `memory_suggest` / `dtodo` / `de_*` | `mem_*`（完全不撞名） |
 * | 待办 / 会话编排 / 画板 / 通知 | 提供 | 不碰 |
 * | 检索 | 文件名/内容级本地文件搜索 | **条目级 BM25 索引**（可选向量融合） |
 * | 索引常驻 | 注入 KEY 摘要（渐进式披露） | 注入**全轨索引 + 硬预算 + 溢出自修复** |
 * | 整合 | `memory-consolidate` 技能（模型驱动） | **可复算的计划 + 指纹校验 + 备份回滚** |
 * | 云端 | 私有 Git 记忆仓库同步 | **分层判定 + 上云前脱敏**（v0.1 不联网） |
 *
 * 为什么不做成 memory-evolve 的补丁：那个包在 profile 里是
 * `vanwork.managedByHost: true`（由 VanWork 托管、随升级整体替换），
 * 改它等于改一个会被覆盖的文件。做成独立 bundle 才能长期存活。
 *
 * ## 插件契约（与 DSH 0.2.0-rc.2 的 cordis 装载器对齐）
 *
 * ```js
 * export const name = 'vanwork-memory-core'
 * export const inject = ['systemPrompt', 'tools']
 * export function apply(ctx, rawConfig) { … }
 * ```
 * 零 `@deepseek-ai/*` 依赖：profile 的 node_modules 解析不到 runtime app 的包，
 * 所以这里只用 Node 内建模块 + cordis 注入的 `ctx`（与 dsh-memory-evolve 同款取舍）。
 *
 * @module vanwork-memory-core
 */

import { DEFAULTS, resolveConfig } from './config.js'
import { createRuntime } from './runtime.js'
import { renderIndexSnapshot, renderEmptyIndexHint, renderPointerBlock } from './inject.js'
import { buildTools } from './tools.js'
import { readJson } from './fsutil.js'
import { buildSessionDigestText, STATE_FILE_NAME } from './session-digest.js'
import { registerRoutes } from './api.js'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'vanwork-memory-core'

/**
 * 声明式注入：`systemPrompt`（注入索引）与 `tools`（注册工具）必需。
 *
 * `webServer`（管理界面用的 /api/memory-core/*）**故意不写在这里**——写进来会让
 * 没有 web 服务的上下文整个不装载。改为 `ctx.inject([...])` 的等待式注入，
 * 详见 `mountUi` 的注释（那里记了三条被实测排除的错路）。
 */
export const inject = ['systemPrompt', 'tools']

/**
 * 装配管理界面（HTTP 接口）。
 *
 * ## 为什么用 `ctx.inject([...])` 而不是直接读 `ctx.webServer`
 * 2026-10-28 实测三轮，把三条错路都排除掉了：
 *  1. 把 `webServer` 写进 `inject` 数组 → 没有 web 服务的上下文**整个不装载**
 *     （mount-probe 7/7 → 0/7）；
 *  2. 写成 `{ required, optional }` 对象 → 本版 cordis 不认，仍然 0/7；
 *  3. 运行期 `ctx.get('webServer')` → 在裸 Context 上能拿到，但在**插件上下文**里
 *     返回 undefined（14:55 的日志原话："本上下文没有 webServer 服务"）。
 *
 * 正规做法是 `ctx.inject([...], scope => …)`：它创建一个**等服务就绪**的作用域，
 * 服务出现时才回调（本插件可能比 web 服务先装载，这条路能兜住启动顺序）。
 */
function mountUi(ctx, runtime, logger, config) {
  if (config.uiEnabled === false) return
  runtime.uiStatus = { registered: 0, reason: 'pending' }

  const register = (scope, webServer) => {
    try {
      if (!webServer || typeof webServer.register !== 'function') {
        runtime.uiStatus = { registered: 0, reason: 'no-webServer' }
        logger.info?.('[memory-core] 本上下文没有 webServer 服务，管理界面不启用（记忆与工具不受影响）')
        return
      }
      const count = registerRoutes(runtime, webServer, (fn, label) => scope.effect(fn, label))
      runtime.uiStatus = { registered: count, reason: 'ok' }
      logger.info?.(`[memory-core] 管理接口已注册：${count} 条路由（/api/memory-core/*）`)
    } catch (error) {
      runtime.uiStatus = { registered: 0, reason: `error: ${error?.message ?? error}` }
      logger.warn?.(`[memory-core] 管理接口注册失败（不影响记忆本身）：${error?.message ?? error}`)
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => register(scope, scope.webServer))
      return
    } catch (error) {
      logger.warn?.(`[memory-core] ctx.inject 不可用，退回直接读取：${error?.message ?? error}`)
    }
  }
  register(ctx, safeService(ctx, 'webServer'))
}

/** 读一个可能没声明的服务（cordis 对未声明的服务会抛，所以必须 try）。 */
function safeService(ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct) return direct
  } catch { /* 未声明：cordis 会抛，落到下面继续尝试 */ }
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

export { DEFAULTS, resolveConfig }

/**
 * 装配插件。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} [rawConfig] - profile patch / 运行时面板传入的配置。
 * @returns {{runtime: object}} 句柄（便于测试与诊断）。
 */
export function apply(ctx, rawConfig = {}) {
  const logger = console
  const runtime = createRuntime({ config: rawConfig, logger, ctx })
  const config = runtime.config

  // ── 1) 索引常驻注入 ──────────────────────────────────────────────────────
  // 采纳 Qoder 的「systemPrompt context 只在文本变化时重新追加」这条性质：
  // 渲染必须是状态的确定函数，否则每一步都会重发一块上下文、把 prompt 缓存打掉。
  if (config.injectIndex !== false) {
    ctx.effect(() => {
      try {
        return ctx.systemPrompt.context({
          name: 'memory-core:index',
          order: config.indexOrder,
          text: (context) => renderSnapshotFor(runtime, context),
        })
      } catch (error) {
        // 幂等保护：某些 loader 情形下同一 ctx 会被装配两次，global 层同名
        // 重复插入会抛 "already registered"。命中时跳过，别让整个 apply 失败
        // 连带工具也注册不上。
        if (error instanceof Error && error.message.includes('already registered')) {
          logger.warn?.('[memory-core] memory-core:index 已注册，跳过重复注册')
          return () => {}
        }
        throw error
      }
    }, 'vanwork-memory-core: index snapshot')
  }

  // ── 2) 工具面 ────────────────────────────────────────────────────────────
  if (config.searchEnabled !== false) {
    ctx.effect(() => {
      const definitions = buildTools(runtime)
      const disposers = []
      for (const definition of definitions) {
        try {
          const dispose = ctx.tools.register(definition)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          logger.warn?.(`[memory-core] 工具 ${definition.name} 注册失败：${error?.message ?? error}`)
        }
      }
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 已释放 */ }
        }
      }
    }, 'vanwork-memory-core: tools')
  }

  // ── 3) 管理界面（HTTP 接口）──────────────────────────────────────────────
  // 旧插件走了以后，记忆 Tab 也跟着没了。这里补一个**只做展示与编辑**的面：
  //   宿主半注册 /api/memory-core/*（本文件），客户端半 lib/client.js 挂到设置页。
  // 取不到 webServer 时安静跳过——界面是附加能力，不该拖垮记忆本身。
  if (config.uiEnabled !== false) {
    mountUi(ctx, runtime, logger, config)
  }

  // ── 4) 生命周期 ─────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    try { runtime.close() } catch { /* 关闭失败无需处理 */ }
  }, 'vanwork-memory-core: lifecycle')

  logger.info?.(`[memory-core] 已装载：记忆根 ${runtime.memoryDir} · 状态目录 ${runtime.coreDir}`)
  return { runtime }
}

/**
 * 渲染常驻索引快照（同步；异常一律降级为一行状态，绝不抛进 DSH 的组装链路）。
 *
 * @param {object} runtime - 运行时。
 * @param {object} [context] - DSH 传入的组装上下文（含 agent）。
 * @returns {string} 注入文本；记忆集为空时返回 ''（不占用任何上下文预算）。
 */
/**
 * 本进程内"这个会话该注入哪段摘要"的缓存。
 *
 * ## 为什么是缓存而不是"端一次就置位"（真机实测修正，0.5.2）
 *
 * 原来写成 `if (digestOffered.has(sid)) return ''` —— 第一次调返回 852 字符，
 * 之后同一会话内一律返回空串。真机日志暴露了坑：**同一个 step 里这个 text 回调
 * 被调了 4 次**（20.291 端出 / 20.308 / 20.518 / 20.722 全 skip）。
 * 而 systemPrompt context 是"文本变化时重新追加"，取值取决于最后一次 ——
 * 于是 852 字符的摘要被后面的空串覆盖掉，模型根本没看到，日志却显示"端出了"。
 *
 * 改成缓存：首次算出来就记住，本会话内**每次调用返回同一段文本**。
 * 这同时满足原设计那条约束（渲染必须是状态的确定函数），文本不变 → prompt 缓存不掉。
 *
 * 空结果不缓存：一个会话里先没候选、后来有了（别处关了窗口）还能补端。
 */
const digestCache = new Map()

/**
 * 会话边界抽取的注入文本（每个会话稳定返回同一段，失败静默）。
 *
 * 放在注入链路里而不是定时任务：插件没有 session 生命周期钩子，
 * 唯一"必然会被调用"的时机就是组装 systemPrompt——它在新会话的第一轮一定会跑。
 */
function sessionDigestOnce(runtime, agent, cwd = null) {
  if (runtime.config?.sessionExtract === false) return ''
  const sid = agent?.session?.id
  // 诊断日志：注入链路没有回调，出问题时"到底有没有跑到这一步"无从查起。
  // 真机试跑期间必须能回答：sid 拿到了吗？是没候选、被跳过、还是抛出异常？
  // 写在 memory-core（插件自有目录，可删可重建），每行一句，不参与索引。
  const logOnce = (msg) => {
    if (runtime.config?.sessionExtractLog === false) return
    try {
      appendFileSync(join(runtime.coreDir, 'session-digest.log'),
        `${new Date().toISOString()} sid=${typeof sid === 'string' && sid !== '' ? sid : '(空)'} ${msg}\n`)
    } catch { /* 日志失败绝不影响注入 */ }
  }
  if (typeof sid !== 'string' || sid === '') { logOnce('skip: 拿不到 session.id'); return '' }
  if (digestCache.has(sid)) {
    const cached = digestCache.get(sid)
    logOnce(`reuse: 复用缓存 ${cached.length} 字符`)
    return cached
  }
  try {
    const text = buildSessionDigestText({
      // 把当前 cwd 一起带进去：抽取要按项目过滤，不能把别的项目的会话端出来
      config: { ...runtime.config, currentCwd: cwd },
      currentSessionId: sid,
      stateFile: join(runtime.coreDir, STATE_FILE_NAME),
    })
    // 空结果不缓存（后面可能有了）；非空缓存，保证本会话内文本恒定
    if (text !== '') digestCache.set(sid, text)
    logOnce(text === '' ? 'ok: 无候选可端' : `ok: 首次端出 ${text.length} 字符（已缓存）`)
    return text
  } catch (e) {
    // 抽取是增强能力：读不到会话文件、解压失败、状态损坏，都不该影响记忆索引注入本身。
    logOnce(`error: ${e && e.message ? e.message : String(e)}`)
    return ''
  }
}

/**
 * 解析实际注入形态（0.8.0）。
 *
 * - pointer：成本恒定，条目按需检索；
 * - index：目录常驻；
 * - auto：小库走 index（看得见目录），大库走 pointer（成本可控）；空库走 pointer。
 *
 * @param {object[]} entries - 当前条目。
 * @param {object} config - 解析后的配置。
 * @returns {'pointer'|'index'}
 */
export function resolveInjectionMode(entries, config = {}) {
  const configured = config.indexMode ?? 'pointer'
  if (configured === 'pointer' || configured === 'index') return configured
  if (!Array.isArray(entries) || entries.length === 0) return 'pointer'
  return entries.length <= (config.autoIndexMaxEntries ?? 40) ? 'index' : 'pointer'
}

export function renderSnapshotFor(runtime, context = {}) {
  try {
    // 总开关（设置页）：停用时一行都不注入（零上下文成本），也不做轮次记账
    // ——停用期间的对话不应该累积出"好多轮没写记忆"的计数。
    if (runtime.enabled?.() === false) return ''
    const agent = context?.agent
    const cwd = runtime.cwdOf(agent)
    const snapshot = runtime.getSnapshot({ cwd })
    const emptyIndex = !snapshot || snapshot.entries.length === 0
    // emptyIndexHint=false 的旧契约是「空库一行都不注入」，管的是**整条注入链路**，
    // 不只是那两行提示。必须在 sessionDigestOnce 之前返回：会话边界摘要同样是注入文本，
    // 经 withDigest 从后门拼回来会让开关形同虚设（0.6.2 解包自检 449/450 暴露的真缺陷）。
    // pointer / index 两条分支共用这一处判定，行为不再分叉。
    if (emptyIndex && runtime.config.emptyIndexHint === false) return ''
    // 会话边界抽取：挂在注入链路上（新会话第一轮必然经过这里），每会话最多一次。
    // 与索引正文**分开拼接**：索引是稳态缓存前缀，摘要块只在首轮出现一次。
    const digest = sessionDigestOnce(runtime, agent, cwd)
    const withDigest = (text) => (digest === '' ? text : (text === '' ? digest : `${text}\n${digest}`))
    // 按需检索模式（0.5.5）：只注入"怎么检索"，条目一律不进输入。
    // 空库时也走这一支（块里自带"库是空的"+ 写入纪律），不走 renderEmptyIndexHint。
    // indexMode='auto'（0.8.0）：小库走 index（模型看得见目录），大库走 pointer（成本恒定）。
    // 空库固定走 pointer：block 自带"库是空的 + 写入纪律"，比空 index 提示更完整。
    const mode = resolveInjectionMode(snapshot?.entries ?? [], runtime.config)
    if (mode === 'pointer') {
      return withDigest(renderPointerBlock({
        entries: snapshot?.entries ?? [],
        config: runtime.config,
        projectId: snapshot?.projectId ?? null,
        projectLabel: snapshot?.projectLabel ?? null,
        session: sessionView(runtime, agent, context),
      }))
    }
    // 空库不再静默：模型必须知道"有记忆工具、这一轮该落盘"（见 renderEmptyIndexHint 的注释）
    if (emptyIndex) return withDigest(renderEmptyIndexHint(runtime.config))
    // 记账必须在渲染之前：这一轮开始时就"多了一轮没写记忆"，写入成功会归零。
    // 渲染只取阈值布尔（见 inject.js 的 renderWriteHint），所以计数不进文本、
    // 不会每轮打掉 prompt 缓存前缀。
    runtime.noteTurn(agent)
    // 懒加载（2026-10-30）：本会话用过记忆工具、或轮次已达阈值 → 注入展开全量目录；
    // 否则只注入核心段（GLOBAL 槽位 + 当前项目 key）。跳变最多一次，护缓存前缀。
    const awake = runtime.memoryUsedOf?.(agent) === true
      || (runtime.turnsOf?.(agent) ?? 0) >= (runtime.config.lazyWakeTurns ?? 3)
    const session = sessionView(runtime, agent, context)
    const rendered = renderIndexSnapshot({
      entries: snapshot.entries,
      stats: snapshot.stats,
      config: runtime.config,
      now: Date.now(),
      projectId: snapshot.projectId,
      projectLabel: snapshot.projectLabel,
      session,
      extras: { consolidationHint: runtime.consolidationHint(), awake },
      // 分槽：把上一轮的顺序交进去，让"已入槽的条目"位置不变。
      // runtime 会在需要全量重排时返回 null（首次 / 超期 / 显式失效）。
      previousSlots: runtime.indexSlots ? runtime.indexSlots() : null,
    })
    // 持久化本轮顺序：下一轮沿用，前缀才稳定。
    if (rendered && Array.isArray(rendered.slots)) runtime.saveIndexSlots?.(rendered.slots)
    return withDigest(rendered.text)
  } catch (error) {
    return `<memory_index status="degraded">记忆索引暂不可用（${error instanceof Error ? error.message : String(error)}）。记忆文件本身完好，可用 read/grep 直接查看。</memory_index>`
  }
}

/**
 * 组装注入用的会话视图（身份 + 未写计数）。
 *
 * 别名读的是 dsh-memory-evolve 的 `aliases.json`（同一份，见 config.aliasesFile）：
 * 用户在它那边设过的别名，在这里显示成同一个名字。标题优先取注入上下文里
 * 已经带上的（DSH 的 sessionTitle 服务不在本插件的声明式依赖里，够用即可，
 * 拿不到就只显示 ID —— 与对方"有就显示、没有就不显示"的兼容逻辑一致）。
 *
 * @param {object} runtime - 运行时。
 * @param {object|undefined} agent - 会话 agent。
 * @param {object} context - DSH 传入的组装上下文。
 * @returns {{id?: string, title?: string, alias?: string, turnsSinceWrite: number}}
 */
function sessionView(runtime, agent, context) {
  const id = agent?.session?.id
  const rawTitle = context?.session?.title ?? context?.sessionTitle ?? agent?.session?.header?.title
  const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : undefined
  const aliasesFile = typeof runtime.config.aliasesFile === 'string' && runtime.config.aliasesFile !== ''
    ? runtime.config.aliasesFile
    : join(runtime.memoryDir, 'aliases.json')
  const table = readJson(aliasesFile, null)
  const alias = typeof id === 'string' && table && typeof table[id] === 'string' && table[id].trim() !== ''
    ? table[id].trim()
    : undefined
  return { id, title, alias, turnsSinceWrite: runtime.turnsSinceWriteOf(agent) }
}