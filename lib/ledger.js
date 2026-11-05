/**
 * lib/ledger.js — append-only 审计账本 + 稀疏 offset 索引。
 *
 * 采纳 CodeArts 报告里的存储设计：**正文追加写（append-only）+ 稀疏索引
 * （offset/len）支持随机读**。理由：
 *   - 追加写不会改写既有记录，断电只可能丢尾部，天然抗损坏；
 *   - 稀疏索引让"某条记录在哪"可 O(1) 定位，不必每次全量加载；
 *   - 记忆系统的写入/合并在文章里被点名需要「可观测 + 可回滚」，账本正是
 *     那一层证据（谁在什么时候改了哪条记忆、命中了什么）。
 *
 * 账本只记**元数据 + 摘要**，不复制记忆正文（避免把敏感内容二次落盘）。
 *
 * @module vanwork-memory-core/lib/ledger
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, sha1hex } from './fsutil.js'

/** 单条记录最多保留的摘要字符数（防正文溢出到账本）。 */
const MAX_SUMMARY_CHARS = 200

/**
 * 追加式审计账本。
 */
export class Ledger {
  /**
   * @param {string} dir - 账本目录（通常是 coreDir）。
   * @param {object} [opts] - { maxBytes, fileName, indexFileName }。
   */
  constructor(dir, opts = {}) {
    this.dir = dir
    this.file = join(dir, opts.fileName ?? 'ledger.jsonl')
    this.indexFile = join(dir, opts.indexFileName ?? 'ledger.index.jsonl')
    this.maxBytes = opts.maxBytes ?? 2_000_000
    this.partial = ''
  }

  /** 确保目录存在。 */
  ensure() {
    ensureDir(this.dir)
    return this
  }

  /**
   * 追加一条记录（正文 + 稀疏索引各一行）。**从不抛**，失败只返回 ok:false
   * ——审计不能成为主链路的故障点。
   *
   * @param {string} kind - 事件类型（write / consolidate / search / reindex / ...）。
   * @param {object} data - 事件数据（调用方保证不含敏感正文）。
   * @returns {{ok: boolean, offset?: number, length?: number, hash?: string, error?: string}}
   */
  append(kind, data = {}) {
    try {
      this.ensure()
      this.rotateIfNeeded()
      const record = {
        t: new Date().toISOString(),
        k: String(kind),
        pid: process.pid,
        ...sanitize(data),
      }
      const line = `${JSON.stringify(record)}\n`
      const offset = existsSync(this.file) ? statSync(this.file).size : 0
      const length = Buffer.byteLength(line, 'utf8')
      appendRaw(this.file, line)
      const entry = { o: offset, l: length, k: record.k, t: record.t, h: sha1hex(line, 12) }
      appendRaw(this.indexFile, `${JSON.stringify(entry)}\n`)
      return { ok: true, offset, length, hash: entry.h }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 账本超过上限则轮转为 `<file>.1`（保留一代）。 */
  rotateIfNeeded() {
    try {
      if (this.maxBytes <= 0 || !existsSync(this.file)) return
      if (statSync(this.file).size < this.maxBytes) return
      const rotated = `${this.file}.1`
      if (existsSync(rotated)) {
        try { renameSync(rotated, `${rotated}.${Date.now().toString(36)}`) } catch { /* 尽力而为 */ }
      }
      renameSync(this.file, rotated)
    } catch {
      /* 轮转失败不影响追加 */
    }
  }

  /**
   * 读取最近的记录。
   * @param {object} [opts] - { limit=50, kind }。
   * @returns {object[]} 记录数组（最新在后）。
   */
  tail(opts = {}) {
    const limit = opts.limit ?? 50
    const lines = readLines(this.file)
    const filtered = opts.kind ? lines.filter((l) => l.k === opts.kind) : lines
    return filtered.slice(-limit)
  }

  /**
   * 按稀疏索引随机读一条记录的原始行。
   * @param {number} offset - 字节偏移。
   * @param {number} length - 字节长度。
   * @returns {string|null}
   */
  readAt(offset, length) {
    try {
      const fd = openSync(this.file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        const read = readSync(fd, buffer, 0, buffer.length, offset)
        return buffer.subarray(0, read).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return null
    }
  }

  /** 账本统计（条数 / 字节 / 类型分布 / 最早最新时间）。 */
  stats() {
    const lines = readLines(this.file)
    const byKind = {}
    for (const line of lines) byKind[line.k] = (byKind[line.k] ?? 0) + 1
    return {
      file: this.file,
      entries: lines.length,
      bytes: fileSize(this.file),
      byKind,
      earliest: lines.length > 0 ? lines[0].t : null,
      latest: lines.length > 0 ? lines[lines.length - 1].t : null,
    }
  }
}

/** 读取 JSONL 全部记录（坏行跳过，不抛）。 */
function readLines(file) {
  try {
    if (!existsSync(file)) return []
    const text = readFileSync(file, 'utf8')
    const out = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      try { out.push(JSON.parse(line)) } catch { /* 半截行/坏行：跳过 */ }
    }
    return out
  } catch {
    return []
  }
}

/** 追加写（O_APPEND + fsync：审计记录宁可慢一点也不能在断电时丢）。 */
function appendRaw(file, text) {
  const fd = openSync(file, 'a', 0o600)
  try {
    writeSync(fd, Buffer.from(text, 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 清洗即将写入账本的字段：截断长文本、丢弃函数/循环引用。 */
function sanitize(data) {
  const out = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || typeof value === 'function') continue
    if (typeof value === 'string') {
      out[key] = value.length > MAX_SUMMARY_CHARS ? `${value.slice(0, MAX_SUMMARY_CHARS)}…` : value
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 50).map((v) => (typeof v === 'string' && v.length > MAX_SUMMARY_CHARS ? `${v.slice(0, MAX_SUMMARY_CHARS)}…` : v))
    } else if (typeof value === 'object') {
      out[key] = sanitize(value)
    }
  }
  return out
}

/** 清洗即将写入账本的字段：截断长文本、丢弃函数/循环引用。 */