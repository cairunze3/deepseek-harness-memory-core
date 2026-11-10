/**
 * lib/audit.js — 「到底谁在管存储」的自证报告。
 *
 * 为什么需要这个工具：本项目把记忆拆成了两层——**正本（谁写）与常驻注入
 * （谁往上下文里放东西）可能分别由两个插件承担**。这种"分工"在正常运行时
 * 完全不可见：模型只看到一段 `<memory_index>`、用户只看到几个工具名，没人
 * 知道写入编排到底落在哪一侧。于是「存储逻辑换没换」这件事就只能靠翻代码
 * 回答——那是文档的活，不该是每次都要做的活。
 *
 * 本模块把它变成**可复算的观测**：读磁盘事实与配置事实，给出
 * 「当前授权 = 谁」的判定，以及每条判据的证据与不通过时的修法。
 *
 * 设计纪律：
 *  - **只读**：不写任何文件、不改任何配置（`mem_audit` 的定位是体检，不是修复）；
 *  - **不谎报**：读不到的项一律 `state='unknown'` 并给出原因，绝不用默认值
 *    假装"已经关掉了/已经生效了"（记忆系统里最贵的错误就是让人以为自己被
 *    记着/被清掉了）；
 *  - **跨插件事实靠文本探测**：另一个插件的源码不在本插件包里，且会被宿主
 *    升级整体替换，所以这里只做**保守的字符串探测**并明确标注"探测，非解析"。
 *
 * @module vanwork-memory-core/lib/audit
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from './paths.js'
import { TOOL_NAMES } from './tool-names.js'

/** 报告里的判定取值。 */
export const PASS = 'ok'
export const WARN = 'warn'
export const UNKNOWN = 'unknown'

/** 宿主 profile patch 的候选位置（按层序，从用户层到 home 层）。 */
function patchCandidates(dshHome) {
  return [
    join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    join(dshHome, 'cordis.patch.yml'),
  ]
}

function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readJsonSafe(file) {
  const text = readTextSafe(file)
  if (text === null) return { state: UNKNOWN, reason: '文件不存在或不可读', path: file, data: null }
  try {
    return { state: PASS, path: file, data: JSON.parse(text) }
  } catch (error) {
    return { state: WARN, reason: `JSON 解析失败：${error?.message ?? error}`, path: file, data: null }
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

/**
 * 生成「存储授权」报告。
 *
 * @param {object} p - { rt, entries, files, stats, cwd, indexError }。
 * @returns {object} 结构化报告（`authority` 是给机器读的结论）。
 */
export function buildAudit({ rt, entries = [], files = [], stats = null, cwd = null, indexError = null, toolNames = null } = {}) {
  const config = rt?.config ?? {}
  const dshHome = resolveDshHome(config.dshHome)
  const memoryDir = rt?.memoryDir ?? null
  const coreDir = rt?.coreDir ?? null

  const checks = []
  const findings = []
  const add = (check) => { checks.push(check); return check }

  // ── 1) 正本：谁拥有记忆文件 ────────────────────────────────────────────
  const memoryExists = memoryDir ? existsSync(memoryDir) : false
  const trackCounts = stats?.trackCounts ?? {}
  const trackLine = Object.entries(trackCounts).map(([track, count]) => `${track}:${count}`).join(' · ')
  add({
    id: 'store.canon',
    title: '记忆正本（Markdown）',
    state: memoryExists ? PASS : UNKNOWN,
    detail: memoryExists
      ? `${memoryDir} · 条目 ${entries.length} · 文件 ${files.length}${trackLine ? ` · 轨道 ${trackLine}` : ''}`
      : `未找到记忆根 ${memoryDir ?? '(未配置)'}——本插件会按需创建，但此时还没有任何正本`,
    evidence: memoryDir ? [`root=${memoryDir}`, `entries=${entries.length}`, `files=${files.length}`] : [],
  })

  // ── 2) 索引与账本：写入编排真的走的是新插件吗 ─────────────────────────
  const dbPath = stats?.dbPath ?? (coreDir ? join(coreDir, 'memory-index.db') : null)
  const dbMtime = dbPath ? mtimeOf(dbPath) : null
  add({
    id: 'index.self',
    title: '自有派生索引（新插件）',
    state: indexError ? WARN : dbMtime !== null ? PASS : UNKNOWN,
    detail: indexError
      ? `索引后端不可用（${indexError}）——记忆功能降级，但正本完好`
      : dbMtime !== null
        ? `${dbPath} · 后端 ${stats?.backend ?? '—'} · 最近写入 ${new Date(dbMtime).toLocaleString()}`
        : `尚未建立索引（${dbPath ?? '(未配置)'}）——首次扫描后生成，属正常`,
    evidence: [dbPath ? `index=${dbPath}` : 'index=(none)', coreDir ? `coreDir=${coreDir}` : 'coreDir=(none)'],
  })

  const ledgerPath = coreDir ? join(coreDir, 'ledger.jsonl') : null
  const ledgerMtime = ledgerPath ? mtimeOf(ledgerPath) : null
  add({
    id: 'ledger.self',
    title: '审计账本（新插件写入动作）',
    state: config.ledgerEnabled === false ? WARN : ledgerMtime !== null ? PASS : UNKNOWN,
    detail: config.ledgerEnabled === false
      ? '账本已在配置里关闭（ledgerEnabled=false）——写入不再留审计痕迹'
      : ledgerMtime !== null
        ? `${ledgerPath} · 最近一条 ${new Date(ledgerMtime).toLocaleString()}`
        : `尚无账本（${ledgerPath ?? '(未配置)'}）——还没有发生任何写入/检索`,
    evidence: [ledgerPath ? `ledger=${ledgerPath}` : 'ledger=(none)'],
  })

  // ── 3) 注入编排：谁是常驻索引的来源 ───────────────────────────────────
  add({
    id: 'inject.self',
    title: '常驻索引注入（新插件）',
    state: config.injectIndex === false ? WARN : PASS,
    detail: config.injectIndex === false
      ? '已关闭（injectIndex=false）——常驻索引完全交给别的实现'
      : `启用 · 排序位 order=${config.indexOrder} · 预算 ${config.indexMaxLines} 行 / ${config.indexMaxChars} 字符 · 名称 memory-core:index`,
    evidence: [`injectIndex=${config.injectIndex !== false}`, `injectExclude=[${(config.injectExclude ?? []).join(',')}]`],
  })

  // 探针：另一个实现是否也在注入（源里是否还在注册快照）。
  const patchFiles = patchCandidates(dshHome)
  const patchTexts = patchFiles.map((file) => ({ file, text: readTextSafe(file) }))
  const memoryEvolveDir = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-memory-evolve')
  const evolveIndex = join(memoryEvolveDir, 'lib', 'index.js')
  const evolveExists = existsSync(evolveIndex)
  const evolveSource = evolveExists ? (readTextSafe(evolveIndex) ?? '') : ''
  const evolveRegistersSnapshot = evolveExists ? /systemPrompt\.context\(/.test(evolveSource) : false
  // 写入面探针：它是否仍**无条件**注册 memory 工具（`:1716` 那种写法）。
  const evolveRegistersMemoryTool = evolveExists ? /tools\.register\(\s*memoryTool\(/.test(evolveSource) : false
  // 写入面是否双份（在判定之前就要用到，所以在这里先算）。
  const legacyWriteSurface = evolveExists && evolveRegistersMemoryTool

  // 运行期覆盖（旧实现把它存在记忆根下）。
  const evolveStatePath = memoryDir ? join(memoryDir, 'plugin-state.json') : null
  const evolveState = evolveStatePath ? readJsonSafe(evolveStatePath) : { state: UNKNOWN, data: null, path: '(未配置)' }
  const evolveInject = evolveState.data && typeof evolveState.data === 'object' && 'injectMemory' in evolveState.data
    ? evolveState.data.injectMemory === true
    : null

  add({
    id: 'inject.legacy',
    title: '旧的快照注入（dsh-memory-evolve）',
    // 三种"没有旧注入"的情形必须分开报，否则用户看到的符号一样、含义完全不同：
    //  · 源码不存在 → **它没装**（2026-10-28 内置更新后就是这一种）→ PASS，
    //    这时若还把它报成"？未知"，会让人误以为"探测失败、可能还在跑";
    //  · 源码在但不再注册 systemPrompt.context → PASS（版本变了）;
    //  · 开关被显式关掉 → PASS;
    //  · 其余（在注册且没关）→ WARN。
    state: !evolveExists ? PASS : !evolveRegistersSnapshot ? PASS : evolveInject === false ? PASS : WARN,
    detail: !evolveExists
      ? `未安装：${evolveIndex} 不存在（旧插件已从 profile 移除）——常驻注入只有新插件一条来源`
      : !evolveRegistersSnapshot
        ? '探测：该插件的源码里已经看不到 systemPrompt.context 注册（可能换过版本或被裁剪）——不再有第二套常驻注入'
        : evolveInject === false
          ? '已关闭（plugin-state.json: injectMemory=false）——常驻注入只有新插件一条来源'
          : evolveInject === null
            ? '探测：仍在注册 systemPrompt.context，且记忆根下没有 plugin-state.json（即 injectMemory 停在默认 true）→ 两套注入同时在跑'
            : 'plugin-state.json 里 injectMemory=true → 两套注入同时在跑',
    evidence: [
      `evolveIndex=${evolveIndex}`,
      `installed=${evolveExists}`,
      `registers systemPrompt.context=${evolveRegistersSnapshot}`,
      `plugin-state.json=${evolveState.state === PASS ? `injectMemory=${String(evolveInject)}` : evolveState.reason ?? evolveState.path}`,
    ],
  })
  if (evolveExists && evolveRegistersSnapshot && evolveInject !== false) {
    findings.push({
      severity: 'warn',
      code: 'duplicate-injection',
      message: '两套注入同时在跑：本插件注入 <memory_index>，dsh-memory-evolve 仍在注入它的快照。'
        + '修法二选一：① 在 <记忆根>/plugin-state.json 写入 {"injectMemory": false} 并把本插件的 injectExclude 清空；'
        + '② 保留旧注入，把本插件的 injectExclude 设为它负责的轨（如 ["global:memory","global:user","project:key"]）。',
    })
  }

  // ── 4) 工具面：写入这道门由谁提供 ─────────────────────────────────────
  const coreToolPrefixes = TOOL_NAMES
  add({
    id: 'tools.self',
    title: '写入编排工具（新插件）',
    state: config.searchEnabled === false ? WARN : PASS,
    detail: config.searchEnabled === false
      ? '工具面已关闭（searchEnabled=false）——模型只能靠 read/grep 直接看文件'
      : `已注册 ${coreToolPrefixes.length} 个：${coreToolPrefixes.join(' / ')}（写入走 memfile 的锁 + 备份 + 原子写）`,
    evidence: [`searchEnabled=${config.searchEnabled !== false}`, 'namespace=mem_*'],
  })

  // 写入路径是否**真的跑过**：审计账本里的 write 记录条数（证据而非声明）。
  const ledgerStats = safeLedgerStats(rt)
  const writesRecorded = ledgerStats?.byKind?.write ?? null
  add({
    id: 'write.path',
    title: '新写入路径的实际执行证据',
    state: ledgerStats === null ? UNKNOWN : writesRecorded > 0 ? PASS : WARN,
    detail: ledgerStats === null
      ? '审计账本未启用或不可读——无法用"是否真的写过"来佐证（不猜）'
      : writesRecorded > 0
        ? `账本里有 ${writesRecorded} 条 write 记录（最近：${ledgerStats.recentWrite ?? '—'}）——本插件的写入编排确实在跑`
        : '账本里还没有任何 write 记录：新写入路径尚未被使用过（此时只能说"已装载"，不能说"已验证"）',
    evidence: [ledgerStats === null ? 'ledger=unavailable' : `ledger.entries=${ledgerStats.entries} · write=${writesRecorded} · kinds=${Object.keys(ledgerStats.byKind ?? {}).join(',')}`],
  })

  add({
    id: 'tools.legacy',
    title: '旧的写入工具（dsh-memory-evolve 的 memory）',
    // 同上：**没装**就是没有第二套写入面（PASS），不是"探测失败"（UNKNOWN）。
    // 2026-10-28 内置更新把旧插件从 profile 移除后，这里从 ⚠ 变成 ✓。
    state: !evolveExists ? PASS : evolveRegistersMemoryTool ? WARN : PASS,
    detail: !evolveExists
      ? `未安装：${evolveIndex} 不存在（旧插件已从 profile 移除）——写入面只剩新插件的 mem_*`
      : evolveRegistersMemoryTool
        ? '探测：该插件在 lib/index.js 里**无条件**注册 memory 工具（没有开关），所以只要它被装载，写入这条门就是两个实现都能走。'
          + '它注册的 memory 与 mem_* 不撞名，因此不会报错——这正是"看起来只有一套、实际有两套"的隐蔽之处。'
        : '探测：源码里看不到 memory 工具的无条件注册——写入面只有新插件（仍建议以 mem_*/mem_write 为准）。',
    evidence: [`evolveIndex=${evolveIndex}`, `installed=${evolveExists}`, `registers tools.register(memoryTool(...)=${evolveRegistersMemoryTool}`],
  })
  if (legacyWriteSurface) {
    findings.push({
      severity: 'info',
      code: 'dual-write-surface',
      message: '写入面是双份：模型可能调用 memory（旧）或 mem_write（新），两者都会改同一批文件。'
        + '两套写的是同一份正本、格式契约一致，但只有新插件这一侧有跨进程锁与锁内重校验。'
        + '收编它只有两条路：① 约定"只用 mem_* 工具写记忆"（零成本，推荐）；'
        + '② 摘掉它的插件行（会连带失去它的记忆 Tab / dtodo / 同步，见技术文档 §6）。',
    })
  }

  // ── 4.1) 会话工具面（如果宿主透传了清单）：把"双写"从代码探测升级为会话事实 ──
  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const names = new Set(toolNames.map((name) => String(name)))
    const hasLegacyMemory = names.has('memory')
    const memTools = [...names].filter((name) => name.startsWith('mem_')).sort()
    add({
      id: 'tools.session',
      title: '本次会话实际可见的写入工具',
      state: hasLegacyMemory ? WARN : PASS,
      detail: hasLegacyMemory
        ? '会话里**同时**存在 `memory`（旧插件，无锁/无备份/无账本）与 `mem_*`（新插件）。'
          + '按约定请只用下面的 mem_* 写记忆。'
        : '会话里只有新插件的 `mem_*` 工具——写入面在这个会话里是单份的。',
      evidence: [
        `mem_* = ${memTools.join(' / ') || '（无）'}`,
        `旧工具 memory = ${hasLegacyMemory ? '可见' : '不可见'}`,
        '（本项依赖宿主把工具清单透传给工具上下文；拿不到时不出这一项，不猜）',
      ],
    })
  }

  // ── 5) 装载事实：本插件是否真被 profile 挂上 ──────────────────────────
  const selfNeedle = join('plugins', 'vanwork-memory-core')
  const patchHits = patchTexts
    .filter((item) => item.text !== null && item.text.includes('vanwork-memory-core'))
    .map((item) => item.file)
  add({
    id: 'load.patch',
    title: 'profile patch 里的装载条目',
    state: patchHits.length > 0 ? PASS : UNKNOWN,
    detail: patchHits.length > 0
      ? `已登记：${patchHits.join(' · ')}`
      : `在 ${patchFiles.map((f) => f).join(' 与 ')} 里没找到 vanwork-memory-core 的条目（探测为纯字符串匹配，非 YAML 解析）`,
    evidence: [`needle=${selfNeedle}`, `patchFiles=${patchFiles.join(',')}`],
  })

  // 每轮写入交接的取证：未写计数与桥接基线（回答"提醒为什么还在响"）。
  const counters = typeof rt?.counters === 'function' ? rt.counters() : null
  add({
    id: 'reminder.state',
    title: '每轮写入交接的状态',
    state: counters === null ? UNKNOWN : PASS,
    detail: counters === null
      ? '运行时未提供计数（可能是旧代码或替身运行时）'
      : `未写计数：${Object.keys(counters.gaps ?? {}).length === 0 ? '（尚无会话）' : Object.entries(counters.gaps).map(([id, gap]) => `${String(id).slice(0, 12)}…=${gap}`).join(' · ')}`
        + ` · 桥接基线 ${counters.bridge?.observedMtime ? new Date(counters.bridge.observedMtime).toLocaleString() : '（尚未观测到记忆文件）'}`
        + ` · 阈值 ${config.writeReminderAfter ?? 5}`,
    evidence: [
      `writeReminder=${config.writeReminder !== false}`,
      `externalWriteThrottleMs=${config.externalWriteThrottleMs ?? 2000}`,
      `排障：提醒在"刚写过"之后仍出现，就看这里的未写计数是不是没归零（归零只由 mem_write 或桥接触发）`,
    ],
  })

  // 判定：谁在管存储 ───────────────────────────────────────────────
  const ownStore = memoryExists && entries.length >= 0 && config.injectIndex !== false && config.searchEnabled !== false
  // 常驻注入是否只剩一条来源：探测不到旧插件源码，或它已不再注册，或它的注入被关掉。
  const injectionNormalized = !evolveExists || !evolveRegistersSnapshot || evolveInject === false
  // 写入编排是否归新插件。
  //
  // ⚠ 修一个真实的口径缺陷（2026-10-27，用户当场发现"写入编排归新插件 = 否"）：
  // 原来这一项写成 `evolveExists && evolveInject === false`，含义被悄悄换成了
  // "旧插件还在、且它的**注入**被关掉"——两个条件都与"写入编排归谁"无关：
  //   ① 探针找不到旧插件源码时反而判 false；
  //   ② 关它的注入需要摘插件行，而摘了就同时没了 memory 工具——于是"归一"永远
  //      不可能达成、判定恒为否（这正是用户看到的那一版）。
  // 现在按**实际行为**判：新插件写入编排已装载，且（旧写入面不在 **或**
  // 用户已显式声明"就只走新插件的写入路径"，见 config.exclusiveWritePath）。
  const writeOrchestrationNew = config.searchEnabled !== false
    && (config.exclusiveWritePath === true || !legacyWriteSurface || evolveInject === false)

  let authority = 'memory-core (own store + own tools)'
  const authorityNotes = []
  if (injectionNormalized) authorityNotes.push('常驻注入：新插件唯一来源')
  else authorityNotes.push('常驻注入：两套并存（尚未归一）')
  if (writeOrchestrationNew) authorityNotes.push('写入编排：归新插件（memfile 原语：锁 + 备份 + 原子写）')
  else authorityNotes.push('写入编排：旧 memory 工具仍在（双份）')
  if (legacyWriteSurface) authorityNotes.push('写入面：新旧两套工具都能写（建议约定只用 mem_*）')
  else authorityNotes.push('写入面：仅新插件（未探测到旧写入工具）')

  // ── 4.2) 可疑记忆（静默标记）：它**不是问题**，但必须可观测 ────────────────
  // 设计取舍（2026-10-27 与用户讨论后拍板）：噪声不打断写入、不弹窗，只在
  // "再次出现"时提示；但"静默"不等于"秘密"——这里如实给出规模、理由分布与孤儿数。
  if (config.suspectEnabled !== false) {
    let summary = null
    try {
      summary = rt?.suspects ? rt.suspects() : null
    } catch { /* 观测失败不影响主判定 */ }
    if (summary) {
      const orphans = summary.items.filter((item) => item.orphan).length
      const reasons = Object.entries(summary.byReason).map(([reason, count]) => `${reason}:${count}`).join(' · ')
      add({
        id: 'suspect.marks',
        title: '可疑记忆（静默标记，不打扰用户但可查）',
        state: PASS,
        detail: summary.total === 0
          ? '没有条目被标记为可疑。'
          : `共 ${summary.total} 条${reasons ? `（${reasons}）` : ''}：判据只看证据（像碎片 / 无外部锚点 / 与既有条目冲突），**不看是否与主流相悖**；`
            + '保护性内容（过敏/禁忌/合规…）永不被标，也不参与"按命中率下沉"。',
        evidence: [
          `标记文件：${coreDir ? `${coreDir}/suspect.json` : '（未知）'}`,
          `孤儿标记（正文已变 → 自动失效）：${orphans} 条`,
          `处置：核实后 mem_write(action="verify")；确认是噪声可留在原地（不会自动归档）`,
        ],
      })
    }
  }

  return {
    at: new Date().toISOString(),
    cwd,
    memoryDir,
    coreDir,
    dshHome,
    authority,
    authorityNotes,
    normalized: {
      injection: injectionNormalized,
      writeOrchestration: writeOrchestrationNew,
      ownStore,
    },
    checks,
    findings,
  }
}

/**
 * 渲染成给模型/用户看的文本报告。
 * @param {object} report - buildAudit 的返回值。
 * @returns {string}
 */
export function renderAudit(report) {
  const mark = { ok: '✓', warn: '⚠', unknown: '？' }
  const lines = []
  lines.push('# 记忆存储授权自检（mem_audit）')
  lines.push(`判定：**${report.authority}**`)
  for (const note of report.authorityNotes ?? []) lines.push(`  · ${note}`)
  lines.push(`记忆根 ${report.memoryDir ?? '—'}`)
  lines.push(`状态目录 ${report.coreDir ?? '—'}`)
  lines.push(`DSH home ${report.dshHome ?? '—'}`)
  lines.push('')
  lines.push('## 逐项证据')
  for (const check of report.checks ?? []) {
    lines.push(`${mark[check.state] ?? '·'} [${check.id}] ${check.title}`)
    lines.push(`    ${check.detail}`)
    for (const item of check.evidence ?? []) lines.push(`    · ${item}`)
  }
  lines.push('')
  lines.push('## 归一状态')
  const n = report.normalized ?? {}
  lines.push(`常驻注入归一（唯一来源）：${n.injection ? '是' : '否'}`)
  lines.push(`写入编排归新插件：${n.writeOrchestration ? '是' : '否'}`)
  lines.push(`正本与索引自持：${n.ownStore ? '是' : '否'}`)
  lines.push('（口径：写入编排只看"新插件的写入路径是否在跑 + 旧写入面是否被收编/约定让位"，'
    + '与"旧插件在不在"无关；要让它变成"是"，把 config.exclusiveWritePath 设为 true（约定只用 mem_* 写），'
    + '或摘掉旧插件的插件行。）')
  if ((report.findings ?? []).length > 0) {
    lines.push('')
    lines.push('## 待办（按严重度）')
    for (const finding of report.findings) lines.push(`· [${finding.severity}] ${finding.code}：${finding.message}`)
  } else {
    lines.push('')
    lines.push('无待办：存储与注入都只有一个来源。')
  }
  lines.push('')
  lines.push('说明：跨插件的事实是**字符串探测**（非 YAML/源码解析），随宿主的托管升级可能变化；本报告只读，不做修复。')
  return lines.join('\n')
}

/**
 * 读审计账本的统计（用于"新写入路径是否真的跑过"）。失败返回 null（不猜）。
 *
 * @param {object} rt - 运行时。
 * @returns {object|null} `{ entries, byKind, recentWrite }`；不可用时 null。
 */
function safeLedgerStats(rt) {
  try {
    const stats = rt?.ledger?.stats?.()
    if (!stats || typeof stats !== 'object') return null
    let recentWrite = null
    try {
      const tail = rt.ledger.tail?.({ limit: 50 }) ?? []
      const lastWrite = [...tail].reverse().find((record) => record?.k === 'write')
      if (lastWrite) {
        recentWrite = `${lastWrite.t ?? '—'} ${String(lastWrite.rel ?? lastWrite.action ?? '').slice(0, 60)}`
      }
    } catch { /* 尾部读取失败不影响主体统计 */ }
    return { ...stats, recentWrite }
  } catch {
    return null
  }
}