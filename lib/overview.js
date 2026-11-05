/**
 * lib/overview.js — 全局记忆概览（"类似 AGENTS.md 的那一页"）。
 *
 * ## 为什么要它
 * 正本按**会话/日期/轨道**分片（`daily/2026-10-28.md`、`projects/<id>/MEMORY.md`…），
 * 这对机器友好，对人不友好：想快速知道"这个 AI 现在到底记得我什么"，得翻几十个条目。
 *
 * 所以这里生成**一份** `OVERVIEW.md`：分节的、一屏能看完的摘要，每条都带指针
 * （`:: projects/xxx/MEMORY.md#12`），点开就能回到原文。
 *
 * ## 三条纪律
 *  1. **它是派生物，不是正本**：文件头写明"改这里不会改原文"；重新生成会覆盖本页；
 *  2. **只做取舍，不做加工**：只挑条目、截断摘要，**不改写内容**（改写会让"摘要漂移"）；
 *  3. **每条都有指针**：概览永远不是"唯一真相"，它只是入口。
 *
 * @module vanwork-memory-core/lib/overview
 */

import { parseEntries } from './scanner.js'

/** 概览文件相对路径（全局唯一一份）。 */
export const OVERVIEW_REL = 'OVERVIEW.md'

/** 每节最多几条（概览要短，超出的靠 mem_search）。 */
export const OVERVIEW_LIMITS = { user: 8, decisions: 8, project: 12, recent: 10 }

/** 判定"这是约定/决策"的关键词（与整合里的修订标记复用同一套直觉，但更宽）。 */
const DECISION_HINTS = [
  '约定', '决定', '不要', '必须', '只用', '禁止', '偏好', '优先', '默认', '规则', '口径',
  'convention', 'decision', 'must', 'never', 'prefer', 'default',
]

/** 摘要压缩：压平空白 + 去掉重复的前缀标签 + 截断（概览行必须短）。 */
function line(summary, limit = 96) {
  let text = String(summary ?? '').replace(/\s+/g, ' ').trim()
  // 去掉开头连续重复的 `[Tag] [Tag] ` 前缀（旧实现常写两遍项目名，观感很差）。
  for (let i = 0; i < 4; i += 1) {
    const stripped = text.replace(/^\[[^\]]{1,24}\]\s*/, '')
    if (stripped === text) break
    text = stripped
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 指针（`rel#序号`）。 */
const pointerOf = (entry) => `${entry.rel}#${entry.ordinal}`

/** 是否像"约定/决策"。 */
function looksLikeDecision(entry) {
  const text = `${entry.summary ?? ''} ${String(entry.body ?? '').slice(0, 200)}`.toLowerCase()
  return DECISION_HINTS.some((hint) => text.includes(hint.toLowerCase()))
}

/** 按日期倒序（没日期的排最后）。 */
function byNewest(a, b) {
  return String(b.date ?? '').localeCompare(String(a.date ?? ''))
}

/**
 * 渲染概览正文。
 *
 * @param {object} p - 参数。
 * @param {object[]} p.entries - 扫描条目。
 * @param {string|null} [p.projectLabel] - 当前项目名。
 * @param {number} [p.now] - 时间。
 * @param {object} [p.limits] - 覆盖默认条数上限。
 * @returns {string} Markdown 正文（不含时间戳，便于 diff）。
 */
export function renderOverview({ entries = [], projectLabel = null, now = Date.now(), limits = {} } = {}) {
  const cap = { ...OVERVIEW_LIMITS, ...limits }
  // 归档/队列不参与概览：它们不该占用"我该记住什么"的注意力。
  const usable = entries.filter((entry) => entry.track !== 'archive' && entry.track !== 'queue' && !entry.supersededBy)
  // 概览里**一条只出现一次**：先被前面小节收走的，后面不再重复
  // （否则「约定与决策」和「当前项目」会各列一遍，读者以为有两件事）。
  const used = new Set()
  const take = (rows, limit) => {
    const picked = []
    for (const entry of rows) {
      if (picked.length >= limit) break
      const pointer = pointerOf(entry)
      if (used.has(pointer)) continue
      used.add(pointer)
      picked.push(entry)
    }
    return picked
  }

  const user = take(usable.filter((entry) => entry.track === 'user').sort(byNewest), cap.user)
  const decisions = take(
    // **排除 daily**：日志里到处都是"约定""决定"这些词，混进来会把这一节变成流水账。
    usable
      .filter((entry) => entry.track !== 'daily' && entry.track !== 'user' && looksLikeDecision(entry))
      .sort(byNewest),
    cap.decisions,
  )
  const project = take(
    usable.filter((entry) => entry.track === 'key' || entry.scope === 'project').sort(byNewest),
    cap.project,
  )
  const recent = take(usable.filter((entry) => (entry.ageDays ?? 999) <= 7).sort(byNewest), cap.recent)

  const section = (title, rows, hint) => {
    const out = [`## ${title}`]
    if (rows.length === 0) out.push(hint ?? '_（暂无）_')
    else for (const entry of rows) out.push(`- ${line(entry.summary)} :: ${pointerOf(entry)}`)
    return out
  }

  const total = usable.length
  const stamp = new Date(now).toISOString().slice(0, 10)
  const lines = []
  lines.push(`> 这是**派生物**：由 ${total} 条记忆自动挑出来的概览，改这里不会改原文；`)
  lines.push('> 要改某一条，点它后面的指针；要重新生成，用面板上的「重新生成」。')
  lines.push('')
  lines.push(`共 ${total} 条 · 生成于 ${stamp}${projectLabel ? ` · 当前项目 ${projectLabel}` : ''}`)
  lines.push('')
  lines.push(...section('用户（我是谁 / 偏好）', user, '_（还没有用户档案：可以说“记住我喜欢…”）_'))
  lines.push('')
  lines.push(...section('约定与决策（不要被推翻的东西）', decisions, '_（还没有明显的约定/决策条目）_'))
  lines.push('')
  lines.push(...section('当前项目', project, '_（这个项目还没有专门记忆）_'))
  lines.push('')
  lines.push(...section('最近 7 天', recent, '_（最近没有新增）_'))
  lines.push('')
  lines.push('---')
  lines.push('需要细节时：上表每条都能按指针打开；找不到就用 `mem_search` 做语义召回。')
  return lines.join('\n')
}

/**
 * 从已有文件文本里取"上次生成时间"（用于面板显示"新鲜度"）。
 * @param {string} text - `OVERVIEW.md` 内容。
 * @returns {string|null} `YYYY-MM-DD` 或 null。
 */
export function overviewStampOf(text) {
  const match = /生成于 (\d{4}-\d{2}-\d{2})/.exec(String(text ?? ''))
  return match ? match[1] : null
}

/**
 * 粗略统计概览里列了多少条指针（面板显示用）。
 * @param {string} text - 概览正文。
 * @returns {number}
 */
export function countPointers(text) {
  return parseEntries(String(text ?? '')).length > 0
    ? (String(text).match(/:: \S+#\d+/g) ?? []).length
    : 0
}