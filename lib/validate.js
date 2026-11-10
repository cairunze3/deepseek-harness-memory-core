/**
 * lib/validate.js — 记忆文件的**格式体检**（"改得安全"第一件）。
 *
 * 为什么需要：记忆是 Markdown 正本，用户完全可以直接编辑。手改最常见的破坏是
 * **漏掉 `§` 分隔符**——那不是"格式难看"，而是**两条并成一条**（我们的 appendEntry
 * 已踩过这个坑：3 条打包成 1 条）。所以这里把"结构是否还能被正确切分"变成
 * 一个可以随时跑的检查，而不是等出问题再猜。
 *
 * 检查项（全部是**结构**问题，不判断内容好坏）：
 *  1. `broken-delimiter`：有多条时间戳但没有 `§` → 会被解析成一条；
 *  2. `unclosed-tag`：`[summary:` / `[id:` 没有闭合的 `]`；
 *  3. `empty-entry`：`§` 之间是空的（会产生空条目）；
 *  4. `leading-delimiter` / `trailing-delimiter`：开头或结尾多一个 `§`；
 *  5. `duplicate-id`：同一个 `[id:…]` 出现两次（合并锚点会指向错的条目）；
 *  6. `inline-tag`：标签不在行首（两条记忆被粘成一条的留痕，见下方第 5) 项说明）。
 *
 * @module vanwork-memory-core/lib/validate
 */

import { ENTRY_DELIMITER, STAMP_RE, parseEntries } from './scanner.js'

/** 一条问题：`{ code, level, message, fix? }`。 */
const issue = (code, level, message, fix = null) => ({ code, level, message, fix })

/**
 * 体检一份记忆文件的文本。
 *
 * @param {string} text - 文件内容。
 * @param {string} [rel] - 相对路径（只用于提示）。
 * @returns {{ok: boolean, issues: object[], entries: number, chars: number}}
 */
export function validateMemoryText(text, rel = '') {
  const raw = String(text ?? '')
  const issues = []
  const trimmed = raw.trim()

  if (trimmed === '') {
    return { ok: true, issues: [], entries: 0, chars: raw.length }
  }

  // 1) 分隔符形态：有多条时间戳却没有 §，说明会被并成一条
  const hasDelimiter = raw.includes(ENTRY_DELIMITER)
  // ⚠ 必须带上 `m`：STAMP_RE 用 `^` 锚定行首（多行模式），丢掉 flag 就只匹配第一行，
  // 于是"多条时间戳却缺 §"这种最该报的问题反而漏报（测试当场抓到）。
  const stampLines = (raw.match(new RegExp(STAMP_RE.source, 'gm')) ?? []).length
  if (!hasDelimiter && stampLines >= 2) {
    issues.push(issue('broken-delimiter', 'error',
      `文件里有 ${stampLines} 条带时间戳的内容，但没有 \`§\` 分隔符——它们会被当成**一条**记忆。`,
      `在每两条之间加一行只含 § 的分隔行（共需 ${stampLines - 1} 个）`))
  }

  // 2) 标签闭合——闭合的 `]` 必须与 `[` 在**同一行**。
  // 反例（测试抓到）：`[summary:没闭合\n[2026-01-01 09:00] 内容。` 里，若允许跨行，
  // `[^\]]*` 会一路吃到下一行时间戳的 `]`，于是"未闭合"被误判为闭合。
  for (const tag of ['summary', 'id', 'superseded-by']) {
    const opens = (raw.match(new RegExp(`\\[${tag}:`, 'g')) ?? []).length
    const closes = (raw.match(new RegExp(`\\[${tag}:[^\\]\\n]*\\]`, 'g')) ?? []).length
    if (opens > closes) {
      issues.push(issue('unclosed-tag', 'error', `有 ${opens - closes} 个 \`[${tag}:…]\` 标签没有闭合的 \`]\`。`,
        '补上 `]`（必须与 `[` 在同一行），或整段删掉该标签'))
    }
  }

  // 3) 空条目 / 首尾多余分隔符
  const chunks = raw.split(ENTRY_DELIMITER)
  if (chunks.some((chunk, index) => index > 0 && index < chunks.length - 1 && chunk.trim() === '')) {
    issues.push(issue('empty-entry', 'warn', '存在两个 `§` 之间没有任何内容的情况（会产生空条目）。', '删掉多余的分隔行'))
  }
  if (raw.trimStart().startsWith('§')) {
    issues.push(issue('leading-delimiter', 'warn', '文件开头就是 `§`。', '删掉开头那一行'))
  }
  if (raw.trimEnd().endsWith('§')) {
    issues.push(issue('trailing-delimiter', 'warn', '文件结尾多了一个 `§`。', '删掉结尾那一行'))
  }

  // 4) 重复 id（只在有 id 标签时检查）
  const ids = [...raw.matchAll(/\[id:([^\]]+)\]/g)].map((match) => match[1].trim())
  const seen = new Set()
  const duplicated = new Set()
  for (const id of ids) {
    if (seen.has(id)) duplicated.add(id)
    seen.add(id)
  }
  if (duplicated.size > 0) {
    issues.push(issue('duplicate-id', 'warn',
      `同一个 \`[id:…]\` 出现了多次：${[...duplicated].slice(0, 3).join('、')}（跨设备合并会指向错条目）。`,
      '删掉重复的 id 标签，或重新分配'))
  }

  // 5) 行内标签：标签不在行首 → 正文与下一条的标签被粘在了一起
  //
  // 这是 2026-11-02 记忆插件 A/B 测试里真实发生的损坏形态：
  // `[2026-11-02] …（补充原有信息）[summary:Aster 二期验收 …]` ——
  // 上一条正文与下一条摘要被并进同一个条目。它不是"格式难看"，而是**切块错误**
  // 的留痕：索引里那一条的正文会同时包含两条内容，模型据此 replace 就会改错条目。
  // 前面那个字符不能是 `]`：`[2026-11-02 14:48] [summary:…]` 是合法写法（时间戳与标签同行），
  // 只有"标签前面是正文"才是粘连。
  const inlineTags = [...raw.matchAll(/[^\]\s][ \t]*\[(summary|superseded-by|id):([^\]\n]*)\]/g)]
  if (inlineTags.length > 0) {
    const samples = inlineTags.slice(0, 2).map((m) => `…${m[0].trim().slice(-40)}`)
    issues.push(issue('inline-tag', 'error',
      `有 ${inlineTags.length} 处标签不在行首（例：${samples.join(' / ')}）——正文与下一条的标签粘在了一起，`
      + '说明有两条记忆被并成了同一条。',
      '在标签前补换行；若同一段里出现了两个 `[summary:…]`，需要把两条按条目拆开（旧的重复摘要直接删掉）'))
  }

  const entries = parseEntries(raw).length
  return {
    ok: issues.every((item) => item.level !== 'error'),
    issues,
    entries,
    chars: raw.length,
  }
}

/**
 * 批量体检（给 API 与体检报告用）。
 * @param {Array<{rel: string, text: string}>} files - 文件清单。
 * @returns {{checked: number, problems: object[]}}
 */
export function validateFiles(files = []) {
  const problems = []
  for (const file of files) {
    const result = validateMemoryText(file.text, file.rel)
    if (result.issues.length > 0) problems.push({ rel: file.rel, issues: result.issues, entries: result.entries })
  }
  return { checked: files.length, problems }
}