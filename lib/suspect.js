/**
 * lib/suspect.js — 「可疑记忆」的静默标记与延迟裁决（v0.3.1）。
 *
 * ## 这一层解决什么
 * 写作入记忆时**不打断用户**（不做逐步确认），但把"可能不可靠"这件事记下来：
 *  - 判据只看**证据**（是不是碎片、有没有外部锚点、是否与既有条目冲突），
 *    **绝不看"是否与主流认知相悖"**——那会变成思想审查，而不是噪声过滤；
 *  - 标记**静默**：不弹窗、不询问；但**不秘密**：落盘、可列出、体检可见、可清除；
 *  - 只在它**再次出现**时才说话（写入相似 / 检索命中）——提醒对象是**模型**，
 *    不是用户：一条"曾被标为可疑"的条目被用到时，模型应先去核对或问一句；
 *  - 长期没人再提 → 自然下沉（不删除、不归档，那是整合的事）。
 *
 * ## 为什么标记是"内容寻址"而不是"id 寻址"
 * 条目的 `[id:]` 只在旧插件的同步开启时才写，而 `stableEntryId` 含序号，文件被
 * 重写/重排就会变。标记跟着**内容**走才不会因为重排而丢失：键 = 规范化正文的
 * sha1 前 16 位。副作用正好是我们要的——**正文一改，旧标记自然失效**（新内容
 * 重新评估），不需要额外的过期逻辑。
 *
 * ## 与"取代 / 归档"的分工
 *  - **可疑标记**：不动正本、可逆、零成本，表达"这条可能不可靠，用之前先核对"；
 *  - **取代（L2）**：结论变更，要留档 + 标记 + confirm，表达"这条是错的，正确结论在别处"；
 *  - **归档（L1）**：移出常驻预算，表达"这条不该再占注意力了"。
 *  三者互不替代：可疑 ≠ 错误，噪声 ≠ 该删。
 *
 * @module vanwork-memory-core/lib/suspect
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, sha1hex, writeFileAtomic } from './fsutil.js'
import { STAMP_RE, stripTags } from './scanner.js'

/** 标记文件（放在派生物目录：它可重建、可整份删除，不动记忆正本）。 */
export const SUSPECT_FILE = 'suspect.json'

/** 标记理由 → 给模型/用户看的一句话（原因必须可解释，否则复核时无从判断）。 */
export const SUSPECT_REASON_TEXT = {
  fragment: '碎片内容：太短、或没有可指认的对象，像是误触发的半句话',
  inferred: 'AI 推断：写入时声明为 agent-inferred，没有任何外部锚点（用户陈述或工具观测）',
  contested: '与既有条目冲突：同主题上两说法不一致，且没有明确的修订标记',
  lowconfidence: '低置信：写入方主动声明了不确定',
}

/** 合法的理由码（写错的值一律拒收，避免标记语义漂移）。 */
export const SUSPECT_REASONS = Object.freeze(Object.keys(SUSPECT_REASON_TEXT))

/**
 * 规范化正文：剥掉头部标签与时间戳、压平空白。
 *
 * 幂等是关键——写入口用的是"刚写下的带标签正文"，扫描侧用的是"已剥离的正文"，
 * 同一个函数处理两者必须得到同一个键。
 *
 * @param {string} text - 任意形态的条目文本。
 * @returns {string} 规范化后的正文。
 */
export function normalizeForMark(text) {
  let body = String(text ?? '')
  body = stripTags(body)
  body = body.replace(new RegExp(STAMP_RE.source, 'g'), '')
  return body.replace(/\s+/g, ' ').trim()
}

/**
 * 内容寻址键：规范化正文的 sha1 前 16 位。
 * @param {string} text - 条目文本。
 * @returns {string} 16 位十六进制键。
 */
export function bodyKey(text) {
  return sha1hex(normalizeForMark(text), 16)
}

/** 标记文件路径。 */
export function suspectPath(coreDir) {
  return join(coreDir, SUSPECT_FILE)
}

/**
 * 读全部标记（缺失/损坏一律返回空集，绝不抛——标记是辅助信息，不该拖垮记忆本身）。
 * @param {string} coreDir - 派生物目录。
 * @returns {{version: number, marks: Record<string, object>}}
 */
export function readMarks(coreDir) {
  const file = suspectPath(coreDir)
  if (!existsSync(file)) return { version: 1, marks: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const marks = parsed && typeof parsed.marks === 'object' && parsed.marks !== null ? parsed.marks : {}
    return { version: Number(parsed?.version ?? 1), marks }
  } catch {
    return { version: 1, marks: {} }
  }
}

/**
 * 写回标记文件（原子写）。
 * @param {string} coreDir - 派生物目录。
 * @param {Record<string, object>} marks - 标记表。
 * @returns {number} 写出的标记条数。
 */
export function writeMarks(coreDir, marks) {
  ensureDir(coreDir)
  const payload = { version: 1, updatedAt: new Date().toISOString(), marks: marks ?? {} }
  writeFileAtomic(suspectPath(coreDir), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  return Object.keys(payload.marks).length
}

/**
 * 打一个可疑标记（已存在则只更新理由与时间，不清零命中计数）。
 *
 * @param {object} p - { coreDir, body, reason, source, now }。
 * @returns {{ok: boolean, key: string, created: boolean, reason?: string}}
 */
export function markSuspect({ coreDir, body, reason = 'fragment', source = null, now = Date.now() }) {
  const key = bodyKey(body)
  const code = SUSPECT_REASONS.includes(reason) ? reason : 'fragment'
  const { marks } = readMarks(coreDir)
  const existing = marks[key]
  marks[key] = {
    reason: code,
    reasonText: SUSPECT_REASON_TEXT[code],
    source: source ?? existing?.source ?? null,
    markedAt: existing?.markedAt ?? new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    hits: existing?.hits ?? 0,
    lastSeenAt: existing?.lastSeenAt ?? null,
  }
  writeMarks(coreDir, marks)
  return { ok: true, key, created: existing === undefined }
}

/**
 * 清除标记（核实通过 / 内容已变）。
 * @param {object} p - { coreDir, body }。
 * @returns {{ok: boolean, key: string, removed: boolean}}
 */
export function clearMark({ coreDir, body }) {
  const key = bodyKey(body)
  const { marks } = readMarks(coreDir)
  const existed = marks[key] !== undefined
  delete marks[key]
  if (existed) writeMarks(coreDir, marks)
  return { ok: true, key, removed: existed }
}

/**
 * 记录"这条又被提到了"（写入相似 / 检索命中时调用）。
 *
 * 注意语义：它**只**记"再次出现"这个事实，**绝不**因此提升可信度——
 * 用户重复自己的观点只提升"这是用户的立场"，不提升"这是真的"；
 * 而 AI 自己引用自己更是自我坐实，必须排除（调用方负责区分来源）。
 *
 * @param {object} p - { coreDir, bodies: string[], now }。
 * @returns {{ok: boolean, touched: number}}
 */
export function recordMentions({ coreDir, bodies = [], now = Date.now() }) {
  if (bodies.length === 0) return { ok: true, touched: 0 }
  const { marks } = readMarks(coreDir)
  let touched = 0
  for (const body of bodies) {
    const key = bodyKey(body)
    const mark = marks[key]
    if (!mark) continue
    mark.hits = (mark.hits ?? 0) + 1
    mark.lastSeenAt = new Date(now).toISOString()
    touched += 1
  }
  if (touched > 0) writeMarks(coreDir, marks)
  return { ok: true, touched }
}

/**
 * 把标记贴到扫描出来的条目上（`entry.suspect = mark | null`）。
 * @param {object[]} entries - 扫描条目。
 * @param {Record<string, object>} marks - 标记表。
 * @returns {number} 命中标记的条目数。
 */
export function annotateEntries(entries, marks) {
  let hit = 0
  for (const entry of entries ?? []) {
    const key = bodyKey(entry.body)
    const mark = marks?.[key] ?? null
    entry.suspect = mark
    entry.suspectKey = mark ? key : null
    if (mark) hit += 1
  }
  return hit
}

/**
 * 清理"孤儿标记"：正文已不存在（被改写/删除/归档走了）的标记直接丢弃。
 *
 * 这是标记的**到期机制**：内容一变，键就变，旧标记自动作废——不需要 TTL，
 * 也不会因为"忘了清"而让一个正确的想法长期带伤。
 *
 * @param {object} p - { coreDir, entries }。
 * @returns {{removed: number, remaining: number}}
 */
export function pruneOrphans({ coreDir, entries = [] }) {
  const { marks } = readMarks(coreDir)
  const alive = new Set((entries ?? []).map((entry) => bodyKey(entry.body)))
  let removed = 0
  for (const key of Object.keys(marks)) {
    if (!alive.has(key)) { delete marks[key]; removed += 1 }
  }
  if (removed > 0) writeMarks(coreDir, marks)
  return { removed, remaining: Object.keys(marks).length }
}

/**
 * "碎片"启发式：不判断内容真假，只判断**它是不是一条完整的陈述**。
 *
 * 三条廉价判据（任一命中即视为碎片）：
 *  1. 规范化后短于 `minChars`；
 *  2. 没有任何字母/数字/汉字（纯标点或表情）；
 *  3. 只有一行且无动词性内容可判——这里退化为"极短 + 无标点结尾"，不做语言分析。
 *
 * @param {string} body - 条目正文。
 * @param {{minChars?: number}} [opts] - 阈值。
 * @returns {boolean} 是否像碎片。
 */
export function isFragmentBody(body, { minChars = 12 } = {}) {
  const text = normalizeForMark(body)
  if (text === '') return true
  if (text.length < minChars) return true
  if (!/[\p{L}\p{N}]/u.test(text)) return true
  return false
}

/**
 * 保护性内容：命中的条目不参与"按命中率下沉/归档"这类操作。
 *
 * 理由（用户 2026-10-27 拍板的约束）：一辈子只说一次却至关重要的信息
 * （过敏、禁忌、不可逆代价、合规红线）如果按"没人再提就忽略"处理，是灾难。
 *
 * @param {string} body - 条目正文。
 * @param {string[]} keywords - 关键词表（配置项 protectedKeywords）。
 * @returns {boolean} 是否受保护。
 */
export function isProtectedBody(body, keywords = []) {
  const text = normalizeForMark(body)
  if (text === '') return false
  return keywords.some((keyword) => keyword && text.includes(keyword))
}

/**
 * 汇总视图（供 mem_health / mem_audit 展示：静默但可查）。
 * @param {object} p - { coreDir, entries }。
 * @returns {{total: number, items: object[], byReason: Record<string, number>}}
 */
export function summarizeMarks({ coreDir, entries = [] }) {
  const { marks } = readMarks(coreDir)
  const alive = new Set((entries ?? []).map((entry) => bodyKey(entry.body)))
  const items = []
  const byReason = {}
  for (const [key, mark] of Object.entries(marks)) {
    const reason = mark?.reason ?? 'unknown'
    byReason[reason] = (byReason[reason] ?? 0) + 1
    const entry = (entries ?? []).find((candidate) => bodyKey(candidate.body) === key) ?? null
    items.push({
      key,
      reason,
      reasonText: mark?.reasonText ?? SUSPECT_REASON_TEXT[reason] ?? '',
      markedAt: mark?.markedAt ?? null,
      hits: mark?.hits ?? 0,
      lastSeenAt: mark?.lastSeenAt ?? null,
      orphan: !alive.has(key),
      rel: entry ? `${entry.rel}#${entry.ordinal}` : null,
      summary: entry?.summary ?? null,
    })
  }
  items.sort((a, b) => String(b.markedAt ?? '').localeCompare(String(a.markedAt ?? '')))
  return { total: items.length, items, byReason }
}