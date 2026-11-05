/**
 * lib/fsutil.js — 零依赖文件/哈希/时间工具。
 *
 * 设计约束（沿用 dsh-memory-evolve 的经验）：插件**不 import 任何
 * `@deepseek-ai/*` 包**——profile 的 node_modules 不是 runtime app 的祖先
 * 目录，跨目录解析不可靠；插件只依赖 Node 内建模块 + cordis 注入的 ctx。
 * 因此这里自备一组小工具。
 *
 * @module vanwork-memory-core/lib/fsutil
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** 递归创建目录（幂等）。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** sha1 十六进制（可截断）。 */
export function sha1hex(text, length = 40) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, length)
}

/** sha256 十六进制（可截断）。 */
export function sha256hex(text, length = 64) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length)
}

/** 新的 UUID（审计/条目 id 用）。 */
export function uuid() {
  return randomUUID()
}

/** ISO 时间戳（毫秒精度）。 */
export function nowIso(date = new Date()) {
  return date.toISOString()
}

/** `YYYY-MM-DD`（本地时区，与 memory-evolve 的 daily 文件名一致）。 */
export function dateStamp(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

/** `HH:MM`（本地时区）。 */
export function timeStamp(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

/** 读 JSON，失败返回 fallback（绝不抛）。 */
export function readJson(file, fallback = null) {
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖。
 *
 * 「原子」的实用含义：任何时刻读到的要么是完整旧内容、要么是完整新内容，
 * 断电不会留下半截文件（对照 memory-evolve 的同步写盘与 CodeArts 的
 * append-only 设计）。写入失败时清理临时文件后原样抛出。
 *
 * @param {string} file - 目标文件绝对路径。
 * @param {string|Buffer} data - 内容。
 * @param {object} [opts] - { mode } 文件权限（默认 0o600，应对 Qoder 报告里的明文 0644 风险）。
 */
export function writeFileAtomic(file, data, opts = {}) {
  const mode = opts.mode ?? 0o600
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  let fd = null
  try {
    fd = openSync(tmp, 'w', mode)
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (error) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关闭 */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 尽力而为 */ }
    throw error
  }
  return file
}

/** 目录是否存在且为目录。 */
export function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 文件是否存在且为文件。 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 文件 mtime（毫秒），不存在返回 null。 */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** 文件大小（字节），不存在返回 -1。 */
export function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/**
 * 递归列出目录下的文件（不含符号链接目标的递归，避免环）。
 *
 * @param {string} root - 起始目录。
 * @param {object} [opts] - { maxFiles=5000, maxDepth=6, filter=(path)=>bool }。
 * @returns {string[]} 绝对路径列表（确定性排序，便于快照比对）。
 */
export function listFiles(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? 5000
  const maxDepth = opts.maxDepth ?? 6
  const filter = opts.filter ?? (() => true)
  const out = []
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full, depth + 1)
      } else if (entry.isFile() && filter(full)) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

/** 把路径显示成相对某根目录的 POSIX 形式（跨设备日志/快照稳定）。 */
export function relativePosix(root, full) {
  if (typeof full !== 'string') return ''
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(full)
  if (f === r) return '.'
  return f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f
}

/** 同步睡眠（锁自旋用；Atomics.wait 不占 CPU）。 */
export function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}