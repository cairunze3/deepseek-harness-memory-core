/**
 * lib/slots.js — 常驻索引的「分槽」：让注入文本在两次渲染之间保持**位置稳定**。
 *
 * ## 为什么需要它
 * 实测（2026-10-28）：写下 1 条记忆后，注入文本几乎整块变化——因为条目顺序是
 * 按「轨道 + mtime」现算的，一条新条目插进中间，后面每一行都错位。而注入块在
 * **系统提示**里，它一变，后面的整段对话历史全部无法命中 prefix 缓存。
 *
 * 借鉴 Codex 的 World State（[文章] 里的说法）：护住 KV Cache 的关键不是"发 diff"，
 * 而是**结构稳定、值可变**——Section 有稳定 ID 与固定位置，"没变的部分"才留得住。
 *
 * 于是这里的规则很简单：
 *  1. **入槽即定序**：条目一旦进槽，位置就固定（不再按排名/mtime 重排）；
 *  2. **新增只追加**：新条目排在末尾，绝不到中间插队；
 *  3. **超容量只挤尾**：容量不够时从**尾部**淘汰（不从中段挖洞，避免整段错位）；
 *  4. **定期全量重排**：每 N 小时（或显式 reindex）允许一次重排——那一次会丢缓存，
 *     之后就重新稳定下来（这与 Codex「压缩只丢一次」的处理方式一致）。
 *
 * ## 取舍（必须说清）
 * 追加式排序意味着：**新来的高价值条目要等尾部腾出位置**，不能立刻挤掉中间的弱条目。
 * 这是刻意的：位置稳定带来的缓存收益，大于"立刻最优排序"的收益；而没进索引的条目
 * 仍然可用 `mem_search` 召回。重排周期就是给"排序质量"留的补偿窗口。
 *
 * @module vanwork-memory-core/lib/slots
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, sha1hex, writeFileAtomic } from './fsutil.js'

/** 槽位状态文件名（放派生物目录：它可重建，删了下次自动重新排序）。 */
export const SLOTS_FILE = 'index-slots.json'

/**
 * 条目的槽位键：**内容寻址**（正文 hash），而不是 `entryId`。
 *
 * 理由：`entryId` 含"文件内序号"，前面删掉一条就会整体位移；正文 hash 不受
 * 重排影响，只有"这条内容真的改了"才会换槽——那时换槽正是我们想要的。
 *
 * @param {object} entry - 扫描条目。
 * @returns {string} 16 位十六进制键（空正文时退回 entryId）。
 */
export function entrySlotKey(entry) {
  const body = String(entry?.body ?? '').trim()
  if (body !== '') return sha1hex(body, 16)
  return String(entry?.entryId ?? '')
}

/**
 * 读槽位状态（缺失/损坏一律当成"没有历史"，返回空——绝不抛）。
 * @param {string} coreDir - 派生物目录。
 * @returns {{version: number, updatedAt: number, slots: string[]}}
 */
export function readSlots(coreDir) {
  const file = join(coreDir, SLOTS_FILE)
  if (!existsSync(file)) return { version: 1, updatedAt: 0, slots: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const slots = Array.isArray(parsed?.slots) ? parsed.slots.filter((key) => typeof key === 'string' && key !== '') : []
    return { version: Number(parsed?.version ?? 1), updatedAt: Number(parsed?.updatedAt ?? 0), slots }
  } catch {
    return { version: 1, updatedAt: 0, slots: [] }
  }
}

/**
 * 写槽位状态（原子写）。
 * @param {string} coreDir - 派生物目录。
 * @param {string[]} slots - 槽位键序列。
 * @param {number} [now] - 更新时间。
 * @returns {number} 槽位数。
 */
export function writeSlots(coreDir, slots, now = Date.now()) {
  ensureDir(coreDir)
  writeFileAtomic(join(coreDir, SLOTS_FILE), `${JSON.stringify({ version: 1, updatedAt: now, slots }, null, 2)}\n`, { mode: 0o600 })
  return slots.length
}

/**
 * 分配槽位：**保持已有条目的相对位置，新条目只追加到末尾**。
 *
 * @param {object} p - 参数。
 * @param {object[]} p.candidates - 候选条目，**必须已经按排名排好序**（新条目按优劣入槽）。
 * @param {string[]} [p.previous] - 上一次的槽位键序列（空数组 = 全量重排）。
 * @param {number} p.capacity - 槽位上限（通常就是 `indexTopN`）。
 * @param {(entry: object) => string} [p.keyOf] - 取键函数。
 * @returns {{ordered: object[], slots: string[], kept: number, appended: number, evicted: number, deferred: number, resorted: boolean}}
 */
export function assignSlots({ candidates = [], previous = [], capacity = 40, keyOf = entrySlotKey } = {}) {
  const cap = Math.max(1, Math.trunc(capacity) || 40)
  const byKey = new Map()
  for (const entry of candidates) {
    const key = keyOf(entry)
    if (key !== '' && !byKey.has(key)) byKey.set(key, entry)
  }

  const resorted = previous.length === 0
  const ordered = []
  const used = new Set()

  // 1) 沿用旧槽位：顺序原样保留（这是"位置稳定"的全部来源）
  for (const key of previous) {
    if (used.has(key)) continue
    const entry = byKey.get(key)
    if (!entry) continue // 条目已不可注入（归档/被取代/被排除）→ 槽位自然空出
    if (ordered.length >= cap) { used.add(key); continue } // 容量变小：尾部淘汰
    ordered.push(entry)
    used.add(key)
  }
  const kept = ordered.length

  // 2) 新条目：只在**末尾**追加，且不抢占已有位置
  const fresh = candidates.filter((entry) => !used.has(keyOf(entry)))
  let appended = 0
  let deferred = 0
  for (const entry of fresh) {
    const key = keyOf(entry)
    if (key === '' || used.has(key)) continue
    if (ordered.length >= cap) { deferred += 1; continue }
    ordered.push(entry)
    used.add(key)
    appended += 1
  }

  const slots = ordered.map(keyOf)
  const evicted = Math.max(0, previous.filter((key) => !slots.includes(key)).length)
  return { ordered, slots, kept, appended, evicted, deferred, resorted }
}

/**
 * 是否该做一次**全量重排**（会丢一次缓存，之后重新稳定）。
 *
 * 触发条件：从未排过 / 显式要求 / 距上次超过 `everyHours`。
 * @param {object} p - { updatedAt, now, everyHours, force }。
 * @returns {boolean}
 */
export function shouldResort({ updatedAt = 0, now = Date.now(), everyHours = 6, force = false } = {}) {
  if (force) return true
  if (!updatedAt) return true
  const everyMs = Math.max(0, Number(everyHours) || 0) * 3_600_000
  if (everyMs === 0) return false
  return now - updatedAt >= everyMs
}

/**
 * 两次渲染之间的"结构稳定性"指标（用于测试与体检，不参与注入）。
 *
 * 计算最长公共前缀：从第 1 行起，两次渲染逐行相同的最长长度。
 * 这正是 prefix 缓存能用到的部分——越大越省。
 *
 * @param {string} previous - 上一次的注入文本。
 * @param {string} next - 这次的注入文本。
 * @returns {{startsWith: number, previousLines: number, nextLines: number, ratio: number}}
 */
export function stablePrefix({ previous = '', next = '' } = {}) {
  const a = String(previous).split('\n')
  const b = String(next).split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return {
    startsWith: i,
    previousLines: a.length,
    nextLines: b.length,
    ratio: a.length === 0 ? 0 : Number((i / a.length).toFixed(3)),
  }
}