/**
 * lib/revisions.js — 逐条修订历史（"改得安全"第三件）。
 *
 * 现有的备份是**按天按文件的整份**（`backups/<date>/…MEMORY.md`），回滚粒度太粗：
 * 想知道"这条上周被谁改成什么"、想只回滚一条，整份备份帮不上。
 *
 * 这里记一条**追加式**的修订日志：每次通过本插件（含 GUI 与 `mem_write`）改动某条记忆，
 * 都记下 `before/after` 的**哈希 + 摘录**（不存全文——那会让日志迅速膨胀好几倍；
 * 全文仍可从当天的整份备份里找回）。
 *
 * 设计取舍：
 *  - **追加式**（append-only）：不改旧记录，天然可审计；
 *  - **有界**：超过 `revisionsMaxBytes` 轮转成 `.1`（保留一代），不影响主流程；
 *  - **失败不影响写入**：记修订是观测，记不上也要让业务写入成功。
 *
 * @module vanwork-memory-core/lib/revisions
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, sha1hex } from './fsutil.js'

/** 修订日志文件名（放派生物目录：它是观测数据，删了不影响记忆本身）。 */
export const REVISIONS_FILE = 'revisions.jsonl'

/** 单次默认上限（10MB 的日志已经能装下数十万次编辑）。 */
const DEFAULT_MAX_BYTES = 10_000_000
/** 摘要摘录长度（只够看出改了什么，不复制全文）。 */
const PREVIEW_CHARS = 160

/** 取一小段可读摘要（压平空白、截断）。 */
export function previewOf(text, limit = PREVIEW_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * 记一条修订。
 *
 * @param {object} p - 参数。
 * @param {string} p.coreDir - 派生物目录。
 * @param {string} p.rel - 记忆文件的相对路径。
 * @param {string} [p.pointer] - 条目指针（`rel#序号`）。
 * @param {string} p.before - 改前正文。
 * @param {string} p.after - 改后正文。
 * @param {string} [p.source] - 谁改的：`mem_write` / `gui` / `consolidate`。
 * @param {number} [p.now] - 时间。
 * @returns {{ok: boolean, entry?: object, error?: string}} 记录失败时 `ok:false`（调用方不该因此失败）。
 */
export function recordRevision({ coreDir, rel, pointer = null, before = '', after = '', source = 'unknown', now = Date.now() }) {
  try {
    ensureDir(coreDir)
    const file = join(coreDir, REVISIONS_FILE)
    rotateIfNeeded(file, DEFAULT_MAX_BYTES)
    const entry = {
      t: new Date(now).toISOString(),
      rel,
      pointer,
      source,
      beforeHash: sha1hex(String(before), 16),
      afterHash: sha1hex(String(after), 16),
      beforeChars: String(before).length,
      afterChars: String(after).length,
      beforePreview: previewOf(before),
      afterPreview: previewOf(after),
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    return { ok: true, entry }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 超过上限就把当前日志轮转成 `.1`（只留一代，够排查即可）。 */
function rotateIfNeeded(file, maxBytes) {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return
    renameSync(file, `${file}.1`)
  } catch { /* 轮转失败就继续追加，不能让观测影响业务 */ }
}

/**
 * 读最近 N 条修订（新的在前）。
 * @param {object} p - { coreDir, limit }。
 * @returns {object[]} 修订记录。
 */
export function readRevisions({ coreDir, limit = 20 } = {}) {
  const file = join(coreDir, REVISIONS_FILE)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line, parseError: true } }
    })
  } catch {
    return []
  }
}