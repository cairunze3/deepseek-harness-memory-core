/**
 * lib/inject.js — 索引常驻注入（硬预算 + 陈旧提醒 + 溢出自修复）。
 *
 * 这是把四家做法**合成一处**的地方：
 *  - Qoder：索引先行、正文按需读、**硬预算**（它用 200 行 / 25KB，这里收紧到
 *    120 行 / 8KB）；读时按 mtime 打「N 天未复核」提醒。
 *  - WorkBuddy：**超预算不静默丢弃**，而是把"先压缩记忆"写成 Agent 的前置
 *    必做任务，让记忆系统自我修复（报告点名这是它整套设计里最巧的一点）。
 *  - OfficeClaw：轨道分层 + 渐进式披露（注入摘要、正文按需展开）。
 *  - Generative Agents / 文章 5.5：注入排序用「重要性 × 新颖性」，
 *    避免头部被同主题条目占满（多样性），并限制常驻成本。
 *
 * 注入文本必须**由可复算的状态决定**：DSH 只在渲染文本变化时才重新追加
 * 上下文（保护 prompt 缓存前缀）。所以这里不写"现在几点"，只写日期桶、
 * 条目数与内容哈希派生量。
 *
 * @module vanwork-memory-core/lib/inject
 */

import { importanceOf, noveltyOf, tokenSetOf } from './retrieve.js'
import { assignSlots, entrySlotKey } from './slots.js'

/**
 * 注入时排除的轨道。
 *
 * - `queue`（待确认队列）：未经用户确认的候选可能本身就是噪声或错误信息；
 * - `ledger` / `suggestions`：审计与队列文件，不是记忆内容；
 * - `archive`（归档）：**归档的目的就是不再占用常驻预算**——需要时通过
 *   `mem_search(includeArchived=true)` 显式召回。这条与 memory-evolve 的
 *   "归档条目不再注入上下文"保持一致，否则归档就失去了意义。
 */
export const NEVER_INJECT = new Set(['queue', 'ledger', 'suggestions', 'archive'])

/** 注入时各轨的展示顺序（稳定输出 → 缓存友好）。`global` 是槽位式全局记忆，排最前。 */
export const TRACK_ORDER = ['global', 'overview', 'user', 'memory', 'key', 'digest', 'project', 'daily']

/** 单条索引行的最大字符数（超出则压到摘要）。 */
const MAX_INDEX_LINE_CHARS = 160

/**
 * 该条目是否被 `injectExclude` 排除。
 *
 * 支持两种写法（见 config.js 的 injectExclude 注释）：
 *  - `"scope:track"` 精确匹配（如 `global:memory`）；
 *  - `"track"` 匹配该轨的所有 scope（如 `daily`）。
 *
 * 存在的理由：与 dsh-memory-evolve 共存时做**注入分工**，避免同一内容注入两遍。
 *
 * @param {object} entry - 条目。
 * @param {Set<string>} exclude - 排除表。
 * @returns {boolean}
 */
export function isExcludedFromIndex(entry, exclude) {
  if (!exclude || exclude.size === 0) return false
  return exclude.has(`${entry.scope}:${entry.track}`) || exclude.has(entry.track)
}

/**
 * 挑选进入常驻索引的条目。
 *
 * @param {object[]} entries - 全部条目。
 * @param {object} p - { config, now, projectId, projectLabel }。
 * @returns {{selected: object[], omitted: number, total: number}}
 */
export function selectForIndex(entries, { config, now = Date.now(), projectId = null } = {}) {
  const exclude = new Set(config?.injectExclude ?? [])
  const eligible = []
  for (const entry of entries ?? []) {
    if (NEVER_INJECT.has(entry.track)) continue
    if (entry.dshOnly) continue
    // 被取代（L2）的条目绝不进常驻索引：它可能还在原轨（只打了标记没搬走），
    // 而"不再误导"正是取代这个动作的全部意义。
    if (entry.supersededBy) continue
    // 可疑条目按配置处置：hide = 不进常驻索引（省预算），但仍可被 mem_search 召回。
    if (config?.suspectInIndex === 'hide' && entry.suspect) continue
    // 与 memory-evolve 的分工：让出它负责注入的轨，避免重复占用常驻预算。
    if (isExcludedFromIndex(entry, exclude)) continue
    if (entry.scope === 'project' && projectId !== null && entry.projectId !== projectId) continue
    eligible.push(entry)
  }

  const scored = eligible.map((entry) => ({
    entry,
    importance: importanceOf(entry, { now, config }),
  }))
  scored.sort((a, b) => b.importance - a.importance)

  // **贪心多样化选择**（Generative Agents 的"相关性 × 新颖性"）。
  //
  // 必须逐条迭代：每挑一条，就用"已挑中的那些"重新给候选打分。
  // 这里踩过一次坑——先对全池算一遍 novelty（此时已挑集合为空，所有 novelty
  // 都是 1）、再排序取头部，等价于**纯按重要性排序**，多样化完全没生效。
  const topN = config?.indexTopN ?? 40
  const pool = scored.slice(0, Math.max(topN * 4, 80))
  const selected = []
  const picked = new Set()
  const seenTokenSets = []

  while (selected.length < topN && picked.size < pool.length) {
    let best = null
    for (const candidate of pool) {
      if (picked.has(candidate.entry.entryId)) continue
      const novelty = noveltyOf(candidate.entry, seenTokenSets)
      const score = candidate.importance * (0.7 + 0.3 * novelty)
      if (best === null || score > best.score) best = { candidate, novelty, score }
    }
    if (best === null) break
    picked.add(best.candidate.entry.entryId)
    best.candidate.novelty = best.novelty
    best.candidate.finalScore = best.score
    selected.push(best.candidate.entry)
    seenTokenSets.push(tokenSetOf(best.candidate.entry))
  }

  return { selected, omitted: Math.max(0, eligible.length - selected.length), total: eligible.length }
}

/**
 * 渲染常驻索引快照。
 *
 * @param {object} p - { entries, stats, config, now, projectId, projectLabel, extras, session }。
 * @returns {{text: string, lines: number, chars: number, overflow: boolean, included: number, omitted: number, dropped: number}}
 */
export function renderIndexSnapshot({
  entries = [], stats = null, config, now = Date.now(), projectId = null, projectLabel = null, extras = {}, session = null,
  previousSlots = null,
} = {}) {
  const maxLines = config?.indexMaxLines ?? 120
  const maxChars = config?.indexMaxChars ?? 8000
  const topN = config?.indexTopN ?? 40
  // 懒加载（双段注入，2026-10-30 用户拍板「方案 b」）：会话初期只注入核心段
  // （GLOBAL 槽位 + 当前项目的 key 条目），mem_* 工具被用过（extras.awake）或
  // 轮次达标后才展开全量目录。`=== true` 的判定让手写 config（不含该键）保持旧行为。
  const lazy = config?.lazyIndex === true && extras.awake !== true
    && (Array.isArray(entries) ? entries.length : 0) > (config?.lazyMinEntries ?? 24)
  let poolEntries = entries
  let selectConfig = config
  if (lazy) {
    poolEntries = entries.filter((entry) => entry.track === 'global'
      || (entry.track === 'key' && entry.scope === 'project' && projectId !== null && entry.projectId === projectId))
    selectConfig = { ...config, indexTopN: Math.min(topN, config?.lazyTopN ?? 16) }
  }
  const { selected, omitted, total } = selectForIndex(poolEntries, { config: selectConfig, now, projectId })

  // 页脚两行的派生（都由状态决定，不含"现在几点"，因此渲染稳定）。
  const footerExtras = {
    ...extras,
    sessionLine: extras.sessionLine ?? renderSessionLine(session),
    writeHint: extras.writeHint ?? renderWriteHint(session, config),
  }

  const ranked = [...selected].sort((a, b) => {
    const ta = TRACK_ORDER.indexOf(a.track)
    const tb = TRACK_ORDER.indexOf(b.track)
    const ra = ta === -1 ? TRACK_ORDER.length : ta
    const rb = tb === -1 ? TRACK_ORDER.length : tb
    if (ra !== rb) return ra - rb
    return b.mtime - a.mtime
  })

  // **分槽**（2026-10-28）：排名只决定"谁能进槽"，不决定"已进槽的顺序"。
  // 理由见 lib/slots.js 顶部注释：注入块在系统提示里，它一动，后面的整段历史
  // 都无法命中 prefix 缓存；实测"写一条新记忆 → 几乎整块错位"。
  // `previousSlots == null`（或关闭该开关）时退回旧行为：完全按排名渲染。
  let ordered = ranked
  let slotInfo = null
  if (Array.isArray(previousSlots) && config?.indexStableSlots !== false) {
    const assigned = assignSlots({ candidates: ranked, previous: previousSlots, capacity: topN })
    ordered = assigned.ordered
    // 只回传计数，不回传条目对象（避免把整批条目挂在返回值上）。
    slotInfo = {
      kept: assigned.kept,
      appended: assigned.appended,
      evicted: assigned.evicted,
      deferred: assigned.deferred,
      resorted: assigned.resorted,
    }
  }
  // 懒加载模式下的 omitted 没有提示价值（"没注入"是设计而非选择结果），
  // 置零以避免页脚出现误导性的"另有 N 条未注入"行。
  let omittedEffective = Math.max(omitted, Math.max(0, total - ordered.length))
  if (lazy) omittedEffective = 0
  const slots = ordered.map(entrySlotKey)

  const header = []
  header.push('<memory_index>')
  header.push(lazy
    ? '记忆索引（精简模式：本会话尚未用到记忆，仅注入核心画像；用 mem_search 召回、或随对话深入将展开全量目录）'
    : '记忆索引（派生自本地 Markdown 正本；正文按需用 mem_read 展开，语义召回用 mem_search）')
  // 空记忆库的**首位**提醒（2026-11-02 第二轮实测）：把"写入纪律"只放页脚时，
  // S1 首条种子句仍然只得到一句"明白…有什么我能帮上忙的？"——0 次工具调用，
  // 三条事实（编号/港口/客户）当场蒸发，后面 2 道回忆题直接答"没有记录"。
  // 页脚在长上下文尾部容易被当成"使用说明"，而开头是模型最先照着做的地方。
  // 只在索引为空时加（此时正是最该写的时候），不增加稳态成本。
  if ((config?.writeDiscipline !== false) && ordered.length === 0) {
    // 0.4.9：清单式枚举（编号/名称/日期/参数/偏好）会被模型当成"只记这类东西"，
    // 改成"你回答所依赖、且结束后查不到的信息"，把任务状态也算进来。
    // 0.6.2：空库这一条也带上"先流水"，否则首轮就养成"只记结论"的习惯
    // （空库时模型最容易被这句话塑形，而它后面几轮会照着这个形状写）。
    header.push('【先写后答】记忆库目前是空的：本轮用户给你的信息里，凡是**你等下答话要用、'
      + '而会话结束就查不到**的（他在做什么、已排除什么、编号/参数/偏好），'
      + (config?.dailyFirstWrite === false
        ? '先用 mem_write(confirm=true, source="user-stated") 静默落盘，不要播报这一步，再回答。'
        : '先用 mem_write(action="add", track="daily", scope="project"或"global", content=…) 追加一条今天的流水，'
          + '再把结论用 mem_write(confirm=true, source="user-stated") 落正轨；两步都静默，不要播报，再回答。'))
  }
  // 条目总数以**本次扫描到的条目**为准，而不是索引统计——索引可能刚同步失败，
  // 那时 stats.entryCount 会是 0，写进上下文就等于对模型撒谎。
  const totalCount = Array.isArray(entries) ? entries.length : (stats?.entryCount ?? total)
  // 统计行**放到页脚**（2026-10-28）：它每次写入都变（条目数/注入数/未注入数），
  // 放在开头等于每次写入都改前缀——这正是文章里 World State 要避免的事。
  // 挪到末尾后，稳定部分（条目区）逐字节不变，只有尾部会变。
  const statLine = lazy
    ? [
      `条目 ${totalCount}`,
      `核心段 ${ordered.length}`,
      projectLabel ? `项目 ${projectLabel}` : null,
    ].filter(Boolean).join(' · ') + ' · 精简模式（全量目录待展开）'
    : [
      `条目 ${totalCount}`,
      `本次注入 ${ordered.length}`,
      projectLabel ? `项目 ${projectLabel}` : null,
      omittedEffective > 0 ? `未注入 ${omittedEffective}` : null,
    ].filter(Boolean).join(' · ')
  footerExtras.statLine = extras.statLine ?? statLine

  // 可疑提示的**最坏情况**文本：用于预算预留（实际文本要在择优后才确定，
// 但预留必须按"可能最长"算，否则硬行数预算会被这一行悄悄撑破）。
  const suspectsInPool = ordered.filter((entry) => entry.suspect).length
  const reserveExtras = suspectsInPool > 0 && config?.suspectInIndex !== 'off'
    ? { ...footerExtras, suspectHint: `可疑条目 ${suspectsInPool} 条（索引里的 ⚠?）：判据是"缺证据"而不是"与主流相悖"；类型 fragment/inferred/contested/lowconfidence。若要据此断言，先用 mem_read 看理由，或直接向用户核对一句。` }
    : footerExtras

  // 预算分配：**先给页脚预留最坏情况的空间**（页脚里可能包含 7 行的
  // "ACTION REQUIRED" 自修复指令）。不预留的话，溢出时总行数会超过
  // indexMaxLines——那样"硬预算"就只是对条目区的软约束，整体成本不受控。
  // 预算预留要按**最坏情况**算：`truncated:true` 且 `droppedByBudget:1` 会走
  // "溢出 → self-repair"那条最长的分支（7 行 ACTION REQUIRED），这样无论最终
  // 落在哪个分支，总行数都不会超出 indexMaxLines。
  // 写入纪律文本（单一来源；预留与实际用的是同一份，长度天然一致）。
  const writeRules = renderWriteRules(config)
  const footerWorstCase = buildFooter({
    truncated: true, droppedByBudget: 1, extras: reserveExtras, maxLines, maxChars,
    dropped: omitted + 1, omitted, totalCount, overflowPolicy: config?.overflowPolicy, writeRules,
  })
  // 页脚元素里可能含内嵌换行（自修复指令是一整块文本），所以预留量必须按
  // **拼接后的实际行数**算，而不是数组长度——否则硬预算会被页脚悄悄撑破。
  const footerWorstText = footerWorstCase.join('\n')
  const reserveLines = footerWorstText.split('\n').length
  const reserveChars = footerWorstText.length + 1
  const lineBudget = Math.max(1, maxLines - header.length - reserveLines)
  const charBudget = Math.max(200, maxChars - header.join('\n').length - reserveChars)

  const body = []
  let droppedByBudget = 0
  let bodyChars = 0
  let suspectInjected = 0
  for (const entry of ordered) {
    const line = formatIndexLine(entry, now, config)
    if (body.length + 1 > lineBudget || bodyChars + line.length + 1 > charBudget) { droppedByBudget += 1; continue }
    body.push(line)
    if (entry.suspect) suspectInjected += 1
    bodyChars += line.length + 1
  }
  // 可疑条目提示（**静默但不秘密**）：不单独打扰用户，但要让模型看得见——
  // 否则标记只是装饰。文本由"本次注入里有几条可疑"决定，是状态的确定函数。
  if (suspectInjected > 0 && config?.suspectInIndex !== 'off') {
    const reasons = [...new Set(ordered.filter((entry) => entry.suspect).map((entry) => entry.suspect.reason ?? 'unknown'))]
    footerExtras.suspectHint = `可疑条目 ${suspectInjected} 条（索引里的 ⚠?）：判据是"缺证据"而不是"与主流相悖"；`
      + `类型 ${reasons.join('/')}。若要据此断言，先用 mem_read 看理由，或直接向用户核对一句。`
  }

  const truncated = droppedByBudget > 0 || omittedEffective > 0
  const footer = buildFooter({
    truncated, droppedByBudget, extras: footerExtras, maxLines, maxChars, dropped: droppedByBudget + omittedEffective, omitted: omittedEffective,
    totalCount, included: ordered.length - droppedByBudget, overflowPolicy: config?.overflowPolicy, writeRules,
  })

  const text = sanitizeIndexText([...header, ...body, ...footer].join('\n'))
  return {
    text,
    lines: text.split('\n').length,
    chars: text.length,
    // ⚠ 口径修正（2026-10-27，用户侧实测发现"误报溢出"）：
    // `overflow` 必须只表示**预算装不下**（有条目被预算挤掉），而不是"有条目没入选"。
    // `indexTopN` 按重要性 × 新颖性主动不选低价值条目，那是**设计**、不是溢出；
    // 把两者混在一起会让每次渲染都挂一块 `ACTION REQUIRED`，逼模型去做无意义的整理
    // （实测：39 条注入、1 条未入选、预算还剩 448 字符，却被判为"已超出常驻预算"）。
    // 未入选的条数仍在 `omitted` 里如实给出，需要时可以据此提示，但不冒充溢出。
    overflow: droppedByBudget > 0,
    included: ordered.length - droppedByBudget,
    omitted: omittedEffective,
    dropped: droppedByBudget + omittedEffective,
    droppedByBudget,
    // 槽位让调用方持久化（下一次渲染沿用同一顺序 → 前缀稳定）。
    slots,
    slotInfo,
  }
}

/**
 * 写入纪律正文（**单一来源**，2026-11-04 抽出）。
 *
 * 为什么抽出来：这段文字原来在索引页脚（`buildFooter`）与按需检索块
 * （`renderPointerBlock`）各写一份，措辞已经漂移（一处只讲"落正轨"，一处讲了
 * confirm 的分支）。写入纪律是**行为契约**——同一契约有两份措辞就等于有两套行为，
 * 而模型读到哪一份取决于注入模式，这不该是随机变量。
 *
 * 文本只取决于配置、不依赖任何运行时状态，所以它落在注入块的**稳定段**里，
 * 不会每轮变一次打掉 prompt 前缀缓存（与页脚统计行同一取舍）。
 *
 * 「先流水、后结论」（2026-11-04，`dailyFirstWrite`）：v0.5.x 只说"落正轨"，
 * 模型把"正轨"理解成 KEY/MEMORY 这类结论轨，于是**流水轨被整条跳过**——本机账本
 * 11-03~11-04 是 `extract→queue ×8`、`add→key ×1`、`add→daily ×0`，根 `daily/`
 * 断档 7 天。所以这里把两段写成两个显式步骤，并点名"别跳过它只写结论"这个具体失败模式。
 *
 * @param {object} config - 解析后的配置。
 * @returns {string[]} 0~4 行文本（`writeDiscipline:false` 时返回空数组）。
 */
export function renderWriteRules(config) {
  if (config?.writeDiscipline === false) return []
  const lines = []
  // 判据：对自身输出做自检（"哪些前提只有用户能给"），不需要给用户的句子分类。
  lines.push('写入纪律：每轮答完回看自己的答案——**哪些前提是用户刚给的、会话结束就查不到**'
    + '（他在做什么、已排除什么、当前结论，以及编号/名称/日期/参数/偏好）？')

  if (config?.dailyFirstWrite === false) {
    // 回退分支（v0.5.x 措辞）：只说落正轨，不提流水。
    lines.push('当轮就用 mem_write(confirm=true, source="user-stated") 落正轨；'
      + '你自己推断或信息不全的不带 confirm。')
  } else {
    lines.push('写入**分两段，先流水后结论**：'
      + '① 有实质进展（排查/决策/改完代码/得出结论）先追加 daily 流水 '
      + '`mem_write(action="add", track="daily", scope="project"或"global", '
      + 'content="做了什么 · 试了什么 · 结论")`——**免 confirm**，直接进今天的日志；'
      + '它是事后唯一能还原"当时怎么想的"的原料，**别跳过它只写结论**。'
      + '② 结论/决策/约定再写长轨：项目内 `track="key"`、跨项目 `track="memory"`、'
      + '身份偏好 `track="user"`（这三轨要 confirm=true 才直写正轨）。')
  }

  lines.push('你自己推断或信息不全的不带 confirm → 进待巩固队列 `QUEUE.md`'
    + '（被检索命中后自动转正，不需要用户确认）。'
    + '记忆动作一律**静默**：开头别说"我先查一下/我先看下记忆"，写完别说"已记录/已记住"，'
    + '别报告"检索到几条"或队列状态、不要问"要不要晋升"，'
    + '别复述用户"记一下 X"这类元要求——照做，别复述。')
  lines.push('高频漏写：把背景交代当成"任务上下文"（"我在排查 X、已排除 Y"下一轮就没了）；'
    + '只说"记下了"却没落盘；只写结论不写流水。'
    + '记忆里搜不到 ≠ 没发生过——别据此断言"不在这台机器上"。')
  return lines
}

/**
 * **按需检索模式**的注入块（2026-11-03 用户拍板）。
 *
 * 与 `renderIndexSnapshot` 的分工：
 *  - 那条路把**条目索引行**常驻进 systemPrompt（最多 `indexTopN` 条 /
 *    `indexMaxChars` 字符），记忆越多、每轮输入越贵——104 条实测 641 token，
 *    全量展开后上限 8000 字符（约 4700 token），且会随记忆增长一直涨；
 *  - 这条路只注入"你怎么检索"，**条目一律不进输入**，用到时由 `mem_search`
 *    现取、命中后 `mem_read` 读全文。成本恒定，与记忆库规模无关。
 *
 * 为什么不干脆 `injectIndex: false`：关掉后模型压根不知道有记忆系统，实测会退化成
 * "记忆里没有 = 没发生过"。所以必须留一小块——留的是**方法与纪律**，不是存货清单。
 *
 * 长度只随"统计行里的数字"变化，且那行放在末尾（prefix 缓存的考虑与索引模式一致）。
 */
/**
 * pointer 模式的核心记忆预取。
 *
 * 为什么不是"全量目录"：pointer 的契约是成本与库规模无关；预取只取
 * global / user / 当前项目 key 这类**跨轮稳定**的核心记忆，最多 N 条。
 * 它是"自动召回"的低成本近似：宿主没有把当前用户消息暴露给注入渲染，
 * 所以不能按 query 做语义预取；但至少让模型不必先想起来调用工具才能看见核心事实。
 */
/** 预取会每轮进输入：口令/密钥类条目不自动预取，但仍可用 mem_read 显式读。 */
const POINTER_SECRET_RE = /(?:password|passwd|secret|token|api[_-]?key|口令|密码|密钥|凭证)/i
function selectPointerRecall(entries, { config, projectId = null, now = Date.now() } = {}) {
  const topN = Math.max(0, Math.min(20, Math.trunc(Number(config?.pointerRecallTopN ?? 2)) || 0))
  if (topN === 0) return []
  const pool = (entries ?? []).filter((entry) => {
    if (!entry || entry.dshOnly || entry.supersededBy) return false
    if (config?.suspectInIndex === 'hide' && entry.suspect) return false
    if (!['global', 'user', 'key'].includes(entry.track)) return false
    if (POINTER_SECRET_RE.test(`${entry.summary ?? ''} ${entry.body ?? ''}`)) return false
    if (entry.scope === 'project' && (projectId === null || entry.projectId !== projectId)) return false
    return true
  })
  const ordered = pool
    .map((entry) => ({ entry, importance: importanceOf(entry, { now, config }) }))
    .sort((a, b) => b.importance - a.importance)
  // GLOBAL.md 的槽位天然是 8 条同权重条目；不设上限会把项目 key 全部挤掉。
  // 预取不是“把 GLOBAL 全列一遍”，最多取 1 个槽位。
  const picked = []
  let globalPicked = 0
  for (const item of ordered) {
    if (item.entry.track === 'global') {
      if (globalPicked >= 1) continue
      globalPicked += 1
    }
    picked.push(item.entry)
    if (picked.length >= topN) break
  }
  return picked
}

/** GLOBAL 槽位条目的 summary 是标题；预取时显示槽值，而不是只显示标题。 */
function pointerSummaryOf(entry) {
  const raw = String(entry?.body ?? '').trim()
  if (/^#{1,6}\s/m.test(raw)) {
    const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const content = lines.slice(1).join(' ').replace(/^#{1,6}\s*/, '').trim()
    if (content !== '') return clip(content, 120)
  }
  return String(entry?.summary ?? '')
}

export function renderPointerBlock({
  entries = [], config, projectId = null, projectLabel = null, session = null, extras = {},
} = {}) {
  const total = Array.isArray(entries) ? entries.length : 0
  const now = Date.now()
  const recall = selectPointerRecall(entries, { config, projectId, now })
  const lines = []
  lines.push('<memory_index mode="on-demand">')
  lines.push(total === 0
    ? '本机记忆库**目前是空的**；本轮也不预载任何条目。'
    : recall.length > 0
      ? `本机有长期记忆（Markdown 正本）。本轮**自动预取 ${recall.length} 条核心记忆**（不是全量目录），其余条目按需检索。`
      : '本机有长期记忆（Markdown 正本）。本轮**不预载任何记忆条目**——条目不占输入，用到再取。')
  lines.push('需要回忆时调 mem_search(query="<自足的一句话：专有名词/文件名/日期/编号>")，'
    + '命中后用 mem_read(pointer) 读全文。检索按字面匹配：'
    + '代词式查询（"这个/那个/刚才说的"）召不回任何东西。')
  lines.push('什么时候**必须**搜：涉及用户说过的事实与偏好、编号/参数/日期、项目结论与进展、'
    + '之前排查过什么或排除了什么。不要因为"我没见过"就断言某事没发生过或"不在这台机器上"——用 mem_search 核实一次。')
  if (recall.length > 0) {
    lines.push('以下为自动预取的核心记忆（不是全量目录；细节用 mem_read）：')
    for (const entry of recall) lines.push(formatIndexLine({ ...entry, summary: pointerSummaryOf(entry) }, now, config))
    lines.push('其余条目仍按需 mem_search；预取条数由 pointerRecallTopN 控制。')
  }
  // 写入纪律：与索引模式共用同一份文本（单一来源见 renderWriteRules）。
  lines.push(...renderWriteRules(config))
  const hint = extras.writeHint ?? renderWriteHint(session, config)
  if (typeof hint === 'string' && hint !== '') lines.push(hint)
  const sessionLine = extras.sessionLine ?? renderSessionLine(session)
  if (typeof sessionLine === 'string' && sessionLine !== '') lines.push(sessionLine)
  lines.push([`条目 ${total}`, projectLabel ? `项目 ${projectLabel}` : null, '按需检索模式'].filter(Boolean).join(' · '))
  lines.push('</memory_index>')
  return sanitizeIndexText(lines.join('\n'))
}

/**
 * 净化注入文本。
 *
 * 为什么必须做：DSH 会把这段文本当模板变量去求值，记忆正文里一旦出现
 * `{{…}}` 就可能让渲染抛错——**一个记忆条目的内容不该有能力让整个会话起不来**。
 * 这里把双花括号折成全角形式（语义不变、模板不再认），与 dsh-memory-evolve 的
 * `sanitizeSnapshotBody` 同一取舍。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 净化后的文本。
 */
/**
 * 空记忆库的注入（2026-11-02 实测后新增）。
 *
 * 为什么需要：`renderSnapshotFor` 里原本有一句 `if (entries.length === 0) return ''`
 * —— 空库时**一行都不注入**。于是"第一次使用插件"的第一轮，模型既不知道有记忆工具、
 * 也看不到任何写入指令，对用户陈述只回一句"明白，有什么我能帮上忙的？"。S1 实测三次
 * （0.4.5 / 0.4.6 / 0.4.7）都在这一步丢掉三条事实（项目编号、港口、客户），
 * 后面两道回忆题必然答"没有这条记录"。这不是检索问题，是**第一轮根本没有入口**。
 *
 * 代价：只在空库时出现（一旦写下第一条就消失），两行、约 60 token；稳态零成本。
 *
 * @param {object} config - 解析后的配置。
 * @returns {string} 注入文本，或 ''（配置关掉时）。
 */
export function renderEmptyIndexHint(config) {
  if (config?.emptyIndexHint === false) return ''
  // 0.6.2：与 renderWriteRules 同一套两段式（空库这一屏往往是模型唯一读到的写法）。
  const write = config?.dailyFirstWrite === false
    ? '先用 mem_write(confirm=true, source="user-stated") 静默落盘，不要播报这一步，再回答；'
    : '先用 mem_write(action="add", track="daily", scope="project"或"global", content=…) 追加一条今天的流水，'
      + '再把结论用 mem_write(confirm=true, source="user-stated") 落正轨（两步都静默，不要播报），再回答；'
  return '<memory_index>\n'
    + '记忆索引（空）：本机还没有任何记忆条目。若用户本轮陈述了可复用事实'
    + '（编号 / 名称 / 日期 / 参数 / 偏好）或有实质进展，' + write
    + '你自己推断或信息不全的，不带 confirm（进待巩固队列，被检索命中后自动转正）。\n'
    + '</memory_index>'
}

export function sanitizeIndexText(text) {  return String(text ?? '').replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
}

/**
 * 会话身份行（"我是谁"）。
 *
 * 格式刻意与 dsh-memory-evolve 的 `snap.sessionPlain` / `snap.sessionNamed`
 * **逐字同款**：广播、会话协作、把 ID 告知对方这些流程都读这行，改了格式
 * 等于悄悄改契约。没有会话视角时（子代理、无 agent 的渲染）返回空串。
 *
 * @param {{id?: string, title?: string, alias?: string}|null} session - 会话信息。
 * @returns {string} 一行文本，或 ''。
 */
export function renderSessionLine(session) {
  const id = session?.id
  if (typeof id !== 'string' || id === '') return ''
  const title = typeof session?.title === 'string' && session.title.trim() !== '' ? session.title.trim() : null
  const alias = typeof session?.alias === 'string' && session.alias.trim() !== '' ? session.alias.trim() : null
  if (title === null && alias === null) return `会话 ID（记住它：用它与各模块消息里的 session id 比对判断是谁；回复时也可把此 ID 告知对方）：${id}`
  const bits = []
  if (title !== null) bits.push(`名称：${title}`)
  if (alias !== null) bits.push(`别名：${alias}`)
  bits.push(`ID：${id}`)
  return `你的会话：${bits.join(' · ')}`
}

/**
 * 每轮写入提醒（接管 dsh-memory-evolve 的"未写看门狗"职责）。
 *
 * 渲染只取决于**阈值布尔**，不输出计数：DSH 只在文本变化时才重新追加这段
 * 上下文，把计数写进文本会让每一轮都变化、把 prompt 缓存前缀打掉（旧实现
 * 的看门狗也是这个取舍）。于是这行只有"出现 / 消失"两次跳变。
 *
 * @param {{turnsSinceWrite?: number}|null} session - 会话计数视图。
 * @param {object} config - 解析后的配置。
 * @returns {string} 一行文本，或 ''。
 */
export function renderWriteHint(session, config) {
  if (config?.writeReminder === false) return ''
  const gap = Number(session?.turnsSinceWrite ?? 0)
  const threshold = config?.writeReminderAfter ?? 5
  if (!Number.isFinite(gap) || gap < threshold) return ''
  const text = typeof config?.writeReminderText === 'string' && config.writeReminderText.trim() !== ''
    ? config.writeReminderText.trim()
    : (config?.dailyFirstWrite === false
      ? '记忆交接提醒：最近若干轮没有写入记忆。若本轮产生了值得跨会话保留的进展，请用 mem_write 记录（daily/project 可直接追加）。'
      : '记忆交接提醒：最近若干轮没有写入记忆。若本轮有实质进展，先补一条 daily 流水（track="daily"，免 confirm），再把结论写进 key/memory。')
  return text
}

/** 组装页脚（溢出与非溢出两种形态；预算预留要按"最长的那个"算）。 */
function buildFooter({ truncated, droppedByBudget = 0, extras = {}, maxLines, maxChars, dropped = 0, omitted = 0, totalCount = 0, included = 0, overflowPolicy = 'self-repair', writeRules = [] }) {
  const footer = []
  if (typeof extras.statLine === 'string' && extras.statLine !== '') footer.push(extras.statLine)
  footer.push('记忆使用纪律：索引行是指针而非事实；标 ⚠ 的条目在据此断言前必须先用 mem_read 核对现状。'
    + '需要按需召回时，把 mem_search 的查询式写成**自足的一句话**（专有名词/文件名/日期），不要用"这个/那个/刚才说的"这类代词——检索是按字面匹配的，代词召不回任何东西。')
  // 写入纪律（2026-11-02 实测后补；2026-11-04 抽出成 renderWriteRules 与按需
  // 检索模式共用同一份文本）。只讲"什么该落盘、带不带 confirm、先写哪段"，
  // 不讲工具用法——工具说明由工具自己给。
  //
  // 0.4.9 判据重写（2026-11-03）：0.4.6~0.4.8 的判据是"用户明确陈述的可复用事实
  // （编号/名称/日期/参数/偏好）"，模型据此把用户的**背景交代**归到"任务上下文"
  // 而不是"事实"，于是 Gatekeeper 那类"我在排查 X、已排除 Y"的会话零写入，
  // 下一轮又断言"信息不在这台机器上"。判据改成**回答依赖**：回头看自己的答案
  // 用了哪些只有用户能提供的前提——那些会话一结束就无处可查，是可机械执行的判定。
  //
  // 静默纪律（2026-11-03 实测）：模型会把记忆系统的内部动作搬进回复——先问
  // "要不要晋升"（0.5.4 修），又把用户"记一下 X"这类元要求复述成清单展示出来
  // （0.5.6 修）；0.5.7 再修**事前过程播报**——"我先处理这两个会话摘要，然后
  // 搜索记忆"就是被"先做完这件事，再回答"的顺序指令诱导出来的。用户要的是记忆
  // **发生**，不是看他记账，也不是看他报流程。
  for (const line of writeRules) footer.push(line)
  // 会话身份段：这一行过去由 dsh-memory-evolve 的快照提供（"我是谁"、回复时把
  // ID 告知对方）。本插件接管注入后必须自己带上，否则广播/协作类对话会失去
  // 判断 sender/recipients 的唯一依据。
  if (typeof extras.sessionLine === 'string' && extras.sessionLine !== '') footer.push(extras.sessionLine)
  if (typeof extras.writeHint === 'string' && extras.writeHint !== '') footer.push(extras.writeHint)
  if (typeof extras.suspectHint === 'string' && extras.suspectHint !== '') footer.push(extras.suspectHint)
  if (typeof extras.consolidationHint === 'string' && extras.consolidationHint !== '') footer.push(extras.consolidationHint)
  if (truncated) {
    footer.push('')
    // 两种情况必须分开（2026-10-27 口径修正）：
    //  · 预算装不下（droppedByBudget>0）→ 这是**溢出**，按 overflowPolicy 处理
    //    （self-repair 要求模型先整理记忆）；
    //  · 只是"没被选中"（omitted>0，按重要性 × 新颖性主动不注入）→ 这是**设计**，
    //    给一行如实说明即可，**不能**挂 ACTION REQUIRED 逼模型做无意义的整理。
    const overBudget = droppedByBudget > 0
    if (overBudget) {
      if ((overflowPolicy ?? 'self-repair') === 'self-repair') {
        footer.push(renderSelfRepair({ maxLines, maxChars, droppedByBudget, omitted, totalCount, included }))
      } else {
        footer.push(`（索引超出常驻预算：本次仅注入 ${included} 条，另有 ${droppedByBudget} 条被预算挤掉。建议调用 mem_consolidate 压缩记忆。）`)
      }
    } else {
      footer.push(`（另有 ${omitted} 条未注入：按重要性 × 新颖性主动不选，不是预算溢出；需要时用 mem_search 召回。）`)
    }
  }
  footer.push('</memory_index>')
  return footer
}

/** 单条索引行的呈现。 */
function formatIndexLine(entry, now, config) {
  const tag = entry.scope === 'project' ? `proj:${entry.projectLabel ?? entry.projectId ?? '?'}` : entry.track
  const age = entry.date ? ageBadge(entry.date, now, config) : ''
  const summary = clip(String(entry.summary ?? '').replace(/\s+/g, ' ').trim(), MAX_INDEX_LINE_CHARS - 40)
  const when = entry.date ? `${entry.date}${entry.time ? ` ${entry.time}` : ''}` : ''
  const pointer = `${entry.rel}#${entry.ordinal}`
  // `⚠?` = 可疑（不是"错"）：判据是缺证据，不是与主流相悖。用户看得懂、模型看得到。
  const flag = entry.suspect ? '⚠?' : ''
  return `- [${tag}]${flag}${age} ${summary}${when ? ` — ${when}` : ''} :: ${pointer}`
}

/** 陈旧徽标：`(Nd)` 提示已过时，`⚠Nd` 要求先复核。 */
function ageBadge(date, now, config) {
  const parsed = Date.parse(`${date}T00:00:00`)
  if (!Number.isFinite(parsed)) return ''
  const days = Math.max(0, Math.floor((now - parsed) / 86_400_000))
  const warnDays = config?.stalenessWarnDays ?? 90
  const staleDays = config?.stalenessDays ?? 30
  if (days >= warnDays) return ` ⚠${days}d`
  if (days >= staleDays) return ` (${days}d)`
  return ''
}

/**
 * WorkBuddy 式的"溢出自修复"指令：把压缩记忆变成 Agent 的前置必做任务，
 * 而不是静默截断（Qoder 的缺陷，见其报告第 9 节风险 2）。
 */
function renderSelfRepair({ maxLines, maxChars, droppedByBudget = 0, omitted = 0, totalCount, included }) {
  return [
    '**ACTION REQUIRED**：记忆索引已超出常驻预算',
    `（预算 ${maxLines} 行 / ${maxChars} 字符；本次注入 ${included} 条，另有 ${droppedByBudget} 条被预算挤掉`
      + `${omitted > 0 ? `，以及 ${omitted} 条按重要性主动未入选` : ''}）。`,
    '在继续用户的请求之前，先判断这是哪一类满：',
    '1. 调用 `mem_health` 看结构问题（近重复 / 超期日志 / 超长条目）——有就整理：',
    '   `mem_consolidate`（action=plan）拿方案 → 确认后 apply → `mem_reindex` 重建索引；',
    '2. 若 `mem_consolidate(action=plan)` 报「没有需要整合的内容」，那是**数量增长**而不是结构退化，',
    '   整理救不了预算：此时应调预算或调注入条数（`indexTopN` / `indexMaxChars`，都是一行配置），',
    `   或把低价值条目显式归档（memory 现有 ${totalCount} 条）。`,
  ].join('\n')
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}