/**
 * lib/pack.js — 分层压缩：「按月打包 + 月摘要」（v0.3.3）。
 *
 * ## 解决什么
 * daily 每天一个文件、每轮都写。一年后：365 个文件、几 MB 流水，而常驻索引的
 * 预算固定（8000 字符 / 36 条）——结果就是**高价值结论被流水挤掉**（实测已到 99% 占用）。
 *
 * ## 怎么做（借 Codex「Token Budget」的思路，但守住我们的底线）
 * 不"压缩掉"内容，而是**分层 + 留线索 + 按需下探**：
 *
 *   热区  `daily/YYYY-MM-DD.md`（最近 `dailyHotDays` 天的原文，全文可检索）
 *   温区  `DIGEST.md` 里每月 **一条** 月摘要（10–24 条要点 + 指向打包文件的指针）
 *   冷区  `daily/archive/YYYY-MM.md`（整月原文按月打包；仍是 daily 语义，
 *          但归入 archive 轨 → 不进常驻索引，可用 `includeArchived` 检索）
 *
 * 三条硬规则：
 *  1. **只打包"整月都已过热点期"的月份**——半月打包会让指针与幂等性都变复杂；
 *  2. **保护性内容永不打包**（过敏/禁忌/合规…，见 config.protectedKeywords）；
 *  3. **原文不删**：从日文件"移动"到月文件；只有当天文件空了才删那个空文件。
 *
 * ## 幂等
 * 月摘要由"该月条目 + 固定规则"决定：同样的输入重算 → 同样的文本；
 * 打包后日文件里的条目消失，所以第二次 plan 不会再提出同一个月份。
 *
 * @module vanwork-memory-core/lib/pack
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appendEntry, removeEntries, stamped } from './memfile.js'
import { parseEntries } from './scanner.js'
import { isProtectedBody } from './suspect.js'

/** 月摘要条目的正文上限（它进常驻索引，必须短）。 */
export const DIGEST_TEXT_CAP = 1400

/** 日期 → `YYYY-MM`。 */
export function monthOf(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null
}

/**
 * 某月打包后的归档文件相对路径。
 * @param {{scope: string, projectId: string|null}} entry - 归属。
 * @param {string} month - `YYYY-MM`。
 * @returns {string} 相对记忆根的 POSIX 路径。
 */
export function packRelFor({ scope, projectId }, month) {
  const base = scope === 'project' && projectId ? `projects/${projectId}/daily/archive` : 'daily/archive'
  return `${base}/${month}.md`
}

/**
 * 某月摘要的目标文件（温区）。
 * @param {{scope: string, projectId: string|null}} entry - 归属。
 * @returns {string} `DIGEST.md` 或 `projects/<id>/DIGEST.md`。
 */
export function digestRelFor({ scope, projectId }) {
  return scope === 'project' && projectId ? `projects/${projectId}/DIGEST.md` : 'DIGEST.md'
}

/** 读一个文件的条目数（不存在算 0）。 */
function entryCountOf(memoryDir, rel) {
  const full = join(memoryDir, rel)
  if (!existsSync(full)) return 0
  try {
    return parseEntries(readFileSync(full, 'utf8')).length
  } catch {
    return 0
  }
}

/**
 * 生成月摘要文本（机械，不需要模型）。
 *
 * 每条要点都带指针 `:: daily/archive/YYYY-MM.md#<序号>`——序号按**打包后的**
 * 位置算（startOrdinal + i），这样 `mem_read` 能直接命中。
 *
 * @param {object} p - { month, entries, packRel, startOrdinal, maxBullets, scopeLabel }。
 * @returns {string} 摘要正文（未加时间戳）。
 */
export function renderDigest({ month, entries = [], packRel, startOrdinal = 0, maxBullets = 24, scopeLabel = '' }) {
  const sorted = [...entries].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
  const shown = sorted.slice(0, maxBullets)
  const lines = []
  const head = `月摘要 ${month}${scopeLabel ? `（${scopeLabel}）` : ''}：${sorted.length} 条流水已打包到 ${packRel}，原文仍可检索（mem_search(includeArchived=true)）。`
  lines.push(head)
  for (let i = 0; i < shown.length; i += 1) {
    const entry = shown[i]
    const day = String(entry.date ?? '').slice(8, 10) || '??'
    const summary = String(entry.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 110)
    lines.push(`- ${day}日 ${summary} :: ${packRel}#${startOrdinal + i}`)
  }
  if (sorted.length > shown.length) {
    lines.push(`- …另有 ${sorted.length - shown.length} 条（${packRel} 里有全文）`)
  }
  const text = lines.join('\n')
  return text.length > DIGEST_TEXT_CAP ? `${text.slice(0, DIGEST_TEXT_CAP)}…` : text
}

/**
 * 找出可打包的月份并生成方案动作。
 *
 * 判据（全部满足才打包）：
 *  1. 该月**所有** daily 条目都老于 `dailyHotDays`（整月已过热点期）；
 *  2. 条目数 ≥ `monthlyPackMinEntries`（太少的月份不值得单独成包）；
 *  3. 未被保护（保护性内容留在热区，永不打包）；
 *  4. 该月还没打包过（目标文件里没有"月摘要 YYYY-MM"字样）。
 *
 * @param {object} p - { entries, config, now, memoryDir }。
 * @returns {object[]} pack 动作数组。
 */
export function planPacks({ entries = [], config, now = Date.now(), memoryDir = '' } = {}) {
  if (config?.monthlyPackEnabled === false) return []
  const hotDays = Math.max(1, Number(config?.dailyHotDays ?? 30))
  const minEntries = Math.max(1, Number(config?.monthlyPackMinEntries ?? 3))
  const maxBullets = Math.max(1, Number(config?.monthlyDigestMaxBullets ?? 24))
  const keywords = config?.protectedKeywords ?? []

  // 1) 按 (scope, projectId, month) 分桶，只收 daily 轨
  const buckets = new Map()
  for (const entry of entries) {
    if (entry.track !== 'daily') continue
    const month = monthOf(entry.date)
    if (month === null) continue
    const key = `${entry.scope}|${entry.projectId ?? '-'}|${month}`
    const bucket = buckets.get(key) ?? { key, scope: entry.scope, projectId: entry.projectId, month, entries: [] }
    bucket.entries.push(entry)
    buckets.set(key, bucket)
  }

  const actions = []
  for (const bucket of buckets.values()) {
    // 2) 整月都要过热点期
    const allOld = bucket.entries.every((entry) => (entry.ageDays ?? 0) >= hotDays)
    if (!allOld) continue
    // 3) 保护性内容留在热区（打包 = 移出常驻注入，等于变相下沉）
    const protectedCount = bucket.entries.filter((entry) => isProtectedBody(entry.body, keywords)).length
    const packable = bucket.entries.filter((entry) => !isProtectedBody(entry.body, keywords))
    if (packable.length === 0) continue
    if (packable.length < minEntries) continue

    const packRel = packRelFor(bucket, bucket.month)
    // 4) 幂等：目标文件里已有该月摘要 → 这个月已经打包过
    const targetFull = join(memoryDir, packRel)
    if (existsSync(targetFull)) {
      try {
        if (readFileSync(targetFull, 'utf8').includes(`月摘要 ${bucket.month}`)) continue
      } catch { /* 读失败就当没打包过，按普通流程走 */ }
    }

    const startOrdinal = entryCountOf(memoryDir, packRel)
    const digestRel = digestRelFor(bucket)
    const digestText = renderDigest({
      month: bucket.month,
      entries: packable,
      packRel,
      startOrdinal,
      maxBullets,
      scopeLabel: bucket.scope === 'project' ? `project:${bucket.projectId}` : '',
    })
    actions.push({
      type: 'pack',
      month: bucket.month,
      scope: bucket.scope,
      projectId: bucket.projectId,
      entries: packable.map((entry) => ({
        rel: entry.rel,
        body: entry.body,
        summary: entry.summary,
        date: entry.date,
        chars: entry.chars ?? 0,
      })),
      sourceFiles: [...new Set(packable.map((entry) => entry.rel))],
      count: packable.length,
      protectedKept: protectedCount,
      target: packRel,
      digestTarget: digestRel,
      digestText,
      startOrdinal,
      chars: packable.reduce((sum, entry) => sum + (entry.chars ?? 0), 0),
    })
  }

  // 月份升序：先处理更老的月份（读起来也更自然）
  return actions.sort((a, b) => String(a.month).localeCompare(String(b.month)))
}

/**
 * 执行一个 pack 动作：移入月文件 → 写月摘要 → 清掉空日文件。
 *
 * 顺序有意如此：
 *  1. 先 append 到月文件（万一中途失败，原文还在日文件里，不会丢）；
 *  2. 再从日文件移除（这一步有备份）；
 *  3. 最后写月摘要（前两步都成功才写，避免"有摘要没内容"）。
 *
 * @param {object} p - { action, config, coreDir, memoryDir, backupDir, stamp, now }。
 * @returns {{ok: boolean, moved: number, appended: number, digest: string, removedFiles: string[], errors: string[]}}
 */
export function applyPack({ action, config, coreDir, memoryDir, backupDir = null, stamp = '', now = Date.now() }) {
  const result = { ok: false, moved: 0, appended: 0, digest: null, removedFiles: [], errors: [] }
  const root = resolve(memoryDir)
  const guard = (rel) => {
    const full = resolve(root, rel)
    if (full !== root && !full.startsWith(root)) return null
    return full
  }

  const packPath = guard(action.target)
  const digestPath = guard(action.digestTarget)
  if (packPath === null || digestPath === null) {
    result.errors.push('路径越界')
    return result
  }

  const time = `${stamp} ${new Date(now).toTimeString().slice(0, 5)}`
  // 1) 移入月文件（按日期顺序追加，与 startOrdinal 的指针序号一致）
  const ordered = [...action.entries].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
  for (const entry of ordered) {
    const outcome = appendEntry(packPath, stamped(entry.body, time), { backupDir, stamp })
    if (outcome?.ok === false || outcome?.locked === false) {
      result.errors.push(`追加打包文件失败：${entry.rel}`)
      continue
    }
    result.appended += 1
  }
  if (result.appended !== ordered.length) return result

  // 2) 从日文件移除（逐文件一次调用，减少加锁次数）
  const byFile = new Map()
  for (const entry of ordered) {
    if (!byFile.has(entry.rel)) byFile.set(entry.rel, [])
    byFile.get(entry.rel).push(entry.body)
  }
  for (const [rel, bodies] of byFile) {
    const sourcePath = guard(rel)
    if (sourcePath === null) { result.errors.push(`路径越界：${rel}`); continue }
    const outcome = removeEntries(sourcePath, bodies, { backupDir, stamp })
    if (outcome?.locked === false) { result.errors.push(`移除失败（取不到锁）：${rel}`); continue }
    result.moved += outcome?.removed ?? 0
  }

  // 3) 清掉空日文件（只删"移除后一个条目都不剩"的文件）
  for (const rel of byFile.keys()) {
    const full = guard(rel)
    if (full === null || !existsSync(full)) continue
    try {
      if (parseEntries(readFileSync(full, 'utf8')).length === 0) {
        unlinkSync(full)
        result.removedFiles.push(rel)
      }
    } catch { /* 删不掉就留着，不影响正确性 */ }
  }

  // 4) 写月摘要（温区）
  const digestOutcome = appendEntry(digestPath, stamped(action.digestText, time), { backupDir, stamp })
  if (digestOutcome?.ok === false || digestOutcome?.locked === false) result.errors.push('写月摘要失败')
  else result.digest = action.digestTarget

  result.ok = result.errors.length === 0
  return result
}