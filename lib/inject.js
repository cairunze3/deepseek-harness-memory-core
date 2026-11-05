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
  const { selected, omitted, total } = selectForIndex(entries, { config, now, projectId })

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
  const omittedEffective = Math.max(omitted, Math.max(0, total - ordered.length))
  const slots = ordered.map(entrySlotKey)

  const header = []
  header.push('<memory_index>')
  header.push('记忆索引（派生自本地 Markdown 正本；正文按需用 mem_read 展开，语义召回用 mem_search）')
  // 条目总数以**本次扫描到的条目**为准，而不是索引统计——索引可能刚同步失败，
  // 那时 stats.entryCount 会是 0，写进上下文就等于对模型撒谎。
  const totalCount = Array.isArray(entries) ? entries.length : (stats?.entryCount ?? total)
  // 统计行**放到页脚**（2026-10-28）：它每次写入都变（条目数/注入数/未注入数），
  // 放在开头等于每次写入都改前缀——这正是文章里 World State 要避免的事。
  // 挪到末尾后，稳定部分（条目区）逐字节不变，只有尾部会变。
  const statLine = [
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
  const footerWorstCase = buildFooter({
    truncated: true, droppedByBudget: 1, extras: reserveExtras, maxLines, maxChars,
    dropped: omitted + 1, omitted, totalCount, overflowPolicy: config?.overflowPolicy,
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
    totalCount, included: ordered.length - droppedByBudget, overflowPolicy: config?.overflowPolicy,
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
export function sanitizeIndexText(text) {
  return String(text ?? '').replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝')
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
    : '记忆交接提醒：最近若干轮没有写入记忆。若本轮产生了值得跨会话保留的进展，请用 mem_write 记录（daily/project 可直接追加）。'
  return text
}

/** 组装页脚（溢出与非溢出两种形态；预算预留要按"最长的那个"算）。 */
function buildFooter({ truncated, droppedByBudget = 0, extras = {}, maxLines, maxChars, dropped = 0, omitted = 0, totalCount = 0, included = 0, overflowPolicy = 'self-repair' }) {
  const footer = []
  if (typeof extras.statLine === 'string' && extras.statLine !== '') footer.push(extras.statLine)
  footer.push('记忆使用纪律：索引行是指针而非事实；标 ⚠ 的条目在据此断言前必须先用 mem_read 核对现状。')
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
  return `- [${tag}]${flag}${age} ${summary} — ${when} :: ${pointer}`
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