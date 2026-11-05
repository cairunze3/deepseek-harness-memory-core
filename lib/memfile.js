/**
 * lib/memfile.js — 记忆文件的安全读写原语。
 *
 * 所有会改动记忆正本的写操作都必须经过这里，统一获得四条保证：
 *  1. **锁**：跨进程互斥（`withLock`），不会与 memory-evolve 的写入交错；
 *  2. **备份**：改前先把原文件复制到 `<coreDir>/backups/`；
 *  3. **原子写**：临时文件 → fsync → rename（断电不留半截文件）；
 *  4. **保留原格式**：按文件既有的条目分隔方式（`§` / 时间戳行 / 整文件）
 *     原样重组，绝不会把一份文件"顺手"规范化成另一种格式。
 *
 * 第 4 条是刻意的克制：这些文件同时被 dsh-memory-evolve 读写，本插件没有
 * 权力改变它们的格式（改了就会破坏对方的分隔符约定与同步合并锚点）。
 * **唯一例外**是与对方同名的归档文件（`*-archive.md`，见 `isEvolveArchiveFile`）：
 * 那些文件必须按 § 规范写，否则对方的 `parseEntries` 会把多条并成一条。
 *
 * @module vanwork-memory-core/lib/memfile
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ensureDir, writeFileAtomic } from './fsutil.js'
import { withLock } from './lock.js'
import { ENTRY_DELIMITER, STAMP_RE, stripTags } from './scanner.js'

/**
 * dsh-memory-evolve 的目录级写锁文件名（与它 store.js 的 withLock 一致）。
 * 本插件写记忆文件时按需抢它，见 `legacyLockCompat` 配置。
 */
export const LEGACY_LOCK_NAME = '.memory.lock'

/** 写原语里锁的等待上限（本地小文件，超过就如实失败而不是无限等）。 */
export const WRITE_LOCK_TIMEOUT_MS = 4_000

/**
 * 在**跨进程锁**保护下改一份记忆文件。
 *
 * 两条必须遵守的性质（缺一条就等于没有并发保护）：
 *  1. **锁的粒度是目标文件**：锁文件放同目录、名字取自目标文件名，这样
 *     两个进程改不同的记忆文件互不阻塞，改同一个文件才排队；
 *  2. **临界区内重新读文件**：进来的 `fn` 必须在锁内自己 `readChunks`，
 *     不能复用锁外读到的内容——否则"读-改-写"仍然会丢掉并发写入的那一条
 *     （这正是没有锁时最隐蔽的丢数据方式）。
 *
 * 锁的陈旧回收与超时沿用 lock.js 的默认值（60s 视为遗弃 / 4s 等待上限），
 * 失败时**如实返回 ok:false 与原因**，绝不静默继续写。
 *
 * @param {string} file - 目标文件绝对路径。
 * @param {(ctx: {file: string, dir: string, lockPath: string}) => object} fn - 临界区。
 * @param {{legacyDir?: string|null, legacyTimeoutMs?: number}} [lockOpts] - 互操作锁选项。
 * @returns {object} 临界区返回值，附加 `locked` 字段（false 表示未取到锁）。
 */
export function withFileWriteLock(file, fn, lockOpts = {}) {
  const dir = dirname(file)
  const lockPath = join(dir, `.${basename(file)}.lock`)
  const run = () => {
    const outcome = withLock(lockPath, () => fn({ file, dir, lockPath }), {
      timeoutMs: lockOpts.lockTimeoutMs ?? WRITE_LOCK_TIMEOUT_MS,
      // 陈旧回收默认 60s（lock.js 的 STALE_LOCK_MS）；测试要"把锁按久一点"
      // 时可以把 staleMs 调大，避免进程存活但锁被误判为遗弃而回收。
      staleMs: lockOpts.staleMs,
      label: `memory-write:${basename(file)}`,
    })
    if (outcome.ok) return { ...outcome.value, locked: true }
    return {
      ok: false,
      locked: false,
      file,
      reason: `未能取得文件锁（${outcome.reason}）——另一个进程正在写这份记忆，未做任何改动。`,
      holder: outcome.holder ?? null,
    }
  }

  const legacyDir = typeof lockOpts.legacyDir === 'string' && lockOpts.legacyDir.trim() !== ''
    ? lockOpts.legacyDir
    : null
  if (legacyDir === null) return run()

  // 与 dsh-memory-evolve 互操作：它的所有主轨写入在 <记忆目录>/.memory.lock 内。
  // 顺序固定为「先 legacy、后 per-file」，所有写手都走同一入口，因此没有
  // 交叉顺序 → 不可能死锁。**绝不删除对方的锁文件**：unlink 只由 withLock
  // 在自己成功获取后释放时执行（此时锁是我们的）。
  const legacy = withLock(join(legacyDir, LEGACY_LOCK_NAME), run, {
    timeoutMs: lockOpts.legacyTimeoutMs ?? 1_500,
    staleMs: lockOpts.legacyStaleMs,
    label: `memory-write-legacy:${basename(file)}`,
  })
  if (legacy.ok) return legacy.value
  return {
    ok: false,
    locked: false,
    file,
    reason: `未能取得与 dsh-memory-evolve 的互操作锁（${legacy.reason}）——它正在写记忆，未做任何改动。`,
    holder: legacy.holder ?? null,
  }
}

/** 文件既有的条目分隔方式。 */
const DELIMITER_RE = /\n[ \t]*§[ \t]*\n/

/**
 * 判定文件的条目形态。
 * @returns {'delimiter'|'stamp'|'whole'}
 */
export function detectMode(text) {
  const raw = String(text ?? '')
  if (DELIMITER_RE.test(raw)) return 'delimiter'
  if (raw.split('\n').some((line) => STAMP_RE.test(line.trim()))) return 'stamp'
  return 'whole'
}

/**
 * 读取文件并切成块（与 scanner 的拆分保持一致）。
 * @returns {{chunks: string[], mode: string, exists: boolean, raw: string}}
 */
export function readChunks(file) {
  if (!existsSync(file)) return { chunks: [], mode: 'whole', exists: false, raw: '' }
  const raw = readFileSync(file, 'utf8')
  const mode = detectMode(raw)
  let chunks
  if (mode === 'delimiter') {
    chunks = raw.split(DELIMITER_RE).map((chunk) => chunk.trim()).filter((chunk) => chunk !== '')
  } else if (mode === 'stamp') {
    chunks = []
    let buffer = []
    const flush = () => {
      const body = buffer.join('\n').trim()
      buffer = []
      if (body !== '') chunks.push(body)
    }
    for (const line of raw.split('\n')) {
      if (STAMP_RE.test(line.trim()) && buffer.some((l) => l.trim() !== '')) flush()
      buffer.push(line)
    }
    flush()
  } else {
    const whole = raw.trim()
    chunks = whole === '' ? [] : [whole]
  }
  return { chunks, mode, exists: true, raw }
}

/** 按形态重组文件文本。 */
export function joinChunks(chunks, mode) {
  if (chunks.length === 0) return ''
  if (mode === 'delimiter') return `${chunks.join(ENTRY_DELIMITER)}\n`
  return `${chunks.join('\n')}\n`
}

/**
 * 备份一个文件到 `<backupDir>/<stamp>/<扁平化路径>`。
 * @returns {string|null} 备份文件路径，或 null（原文件不存在）。
 */
export function backupFile(file, backupDir, stamp) {
  if (!existsSync(file)) return null
  const flat = `${file.replace(/\\/g, '/').replace(/[:/]+/g, '_')}`
  const target = join(backupDir, stamp, flat)
  ensureDir(dirname(target))
  try {
    copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/**
 * dsh-memory-evolve 的 `ArchiveStore.fileOf` 命名（逐字对齐，2026-10-26）：
 * `MEMORY-archive.md` / `USER-archive.md` / `KEY-archive.md` / `TODO-archive.md`。
 *
 * 为什么这些文件必须按 § 规范落盘：对方的 `parseEntries` 只认 `\n§\n`。
 * 归档是"多条长期堆在同一份文件"的形态，若我们按"时间戳行"追加，它的
 * 记忆 Tab 归档页会把两条并成一条（点"移回主记忆"时整块搬回主轨）。
 */
const EVOLVE_ARCHIVE_RE = /^(?:MEMORY|USER|KEY|TODO)-archive\.md$/i

/** 该文件是否属于 memory-evolve 的归档命名（决定落盘分隔方式）。 */
export function isEvolveArchiveFile(file) {
  return EVOLVE_ARCHIVE_RE.test(basename(String(file ?? '')))
}

/**
 * 该路径是否落在**归档目录**里（`archive/…`，含 `daily/archive/YYYY-MM.md`）。
 *
 * 为什么和"归档文件名"分开判：月度打包（lib/pack.js）用的是**目录形态**，
 * 文件名是 `2025-03.md`，不匹配 `*-archive.md`。若不把它一起纳入 § 规则，
 * 新建的月文件会按"无分隔符 → 换行"追加，**多天的条目会并成一条**
 * （2026-10-28 实测：3 条打包后只剩 1 条）。
 */
export function isArchiveDirPath(file) {
  const normalized = String(file ?? '').replace(/\\/g, '/')
  return /(^|\/)archive\//i.test(normalized) || /\/archive$/i.test(normalized)
}

/** 该文件是否必须按 § 规范落盘（对方的归档页 + 我们的月打包都要）。 */
export function isDelimiterFile(file) {
  return isEvolveArchiveFile(file) || isArchiveDirPath(file)
}

/**
 * 决定追加时的条目分隔方式。
 *
 * `opts.mode`：`'auto'`（默认）| `'delimiter'`（强制 §）。auto 下，归档文件
 * 与归档目录里的文件一律用 §（**对方要读、月打包也要按条可寻址**），
 * 其余文件严格沿用既有形态。
 */
function resolveAppendMode(file, opts, detected) {
  if (opts.mode === 'delimiter') return 'delimiter'
  if (opts.mode === undefined || opts.mode === 'auto') return isDelimiterFile(file) ? 'delimiter' : detected
  return detected
}

/**
 * 向文件追加一条条目（按既有形态选择分隔方式）。
 *
 * @param {string} file - 目标文件。
 * @param {string} body - 条目正文。
 * @param {object} [opts] - { backupDir, stamp, mode }。
 * @returns {{ok: boolean, file: string, backup: string|null, mode: string, bytes: number}}
 */
export function appendEntry(file, body, opts = {}) {
  const text = String(body ?? '').trim()
  if (text === '') return { ok: false, file, backup: null, mode: 'whole', bytes: 0 }
  // 读-改-写全程在文件锁内（并发写入不会互相丢条目）。
  // 把 opts 里的锁参数传下去：否则"锁等多久""陈旧多久算遗弃"这两个旋钮
  // 在调用方配了也不生效（曾经真的踩到：测试配了 120ms，实际还是等 4 秒）。
  return withFileWriteLock(file, () => {
    const { chunks, mode: detected, exists } = readChunks(file)
    const mode = resolveAppendMode(file, opts, detected)
    const backup = exists && opts.backupDir ? backupFile(file, opts.backupDir, opts.stamp ?? 'now') : null
    const next = [...chunks, text]
    const content = joinChunks(next, mode)
    writeFileAtomic(file, content, { mode: 0o600 })
    return { ok: true, file, backup, mode, bytes: Buffer.byteLength(content, 'utf8') }
  }, lockOptsOf(opts))
}

/**
 * 删除文件中正文精确等于给定集合的条目。
 * 只做精确匹配——避免"相似就删"的误删（删除是不可逆的方向）。
 *
 * @param {string} file - 目标文件。
 * @param {Iterable<string>} bodies - 待删除条目正文集合。
 * @param {object} [opts] - { backupDir, stamp }。
 * @returns {{ok: boolean, file: string, removed: number, backup: string|null, mode: string, remaining: number}}
 */
export function removeEntries(file, bodies, opts = {}) {
  const wanted = new Set([...bodies].map((body) => String(body).trim()))
  return withFileWriteLock(file, () => {
    const { chunks, mode, exists } = readChunks(file)
    if (!exists) return { ok: false, file, removed: 0, backup: null, mode, remaining: 0 }
    const remaining = chunks.filter((chunk) => !wanted.has(chunk.trim()))
    const removed = chunks.length - remaining.length
    if (removed === 0) return { ok: true, file, removed: 0, backup: null, mode, remaining: chunks.length }
    const backup = opts.backupDir ? backupFile(file, opts.backupDir, opts.stamp ?? 'now') : null
    writeFileAtomic(file, joinChunks(remaining, mode), { mode: 0o600 })
    return { ok: true, file, removed, backup, mode, remaining: remaining.length }
  }, lockOptsOf(opts))
}

/**
 * 就地替换一条条目（正文精确匹配旧值）。
 * @returns {{ok: boolean, file: string, replaced: number, backup: string|null, mode: string}}
 */
export function replaceEntry(file, oldBody, newBody, opts = {}) {
  const target = String(oldBody).trim()
  const replacement = String(newBody).trim()
  return withFileWriteLock(file, () => {
    const { chunks, mode, exists } = readChunks(file)
    if (!exists) return { ok: false, file, replaced: 0, backup: null, mode }
    let replaced = 0
    const next = chunks.map((chunk) => {
      if (chunk.trim() === target) { replaced += 1; return replacement }
      return chunk
    })
    if (replaced === 0) return { ok: true, file, replaced: 0, backup: null, mode }
    const backup = opts.backupDir ? backupFile(file, opts.backupDir, opts.stamp ?? 'now') : null
    writeFileAtomic(file, joinChunks(next, mode), { mode: 0o600 })
    return { ok: true, file, replaced, backup, mode }
  }, lockOptsOf(opts))
}

/**
 * 约束校验：条目该落到哪个目录 —— 采纳 Qoder 的 pinned type 强制。
 *
 * 规则（写错 scope 直接拒绝，而不是靠模型自觉）：
 *  - 全局轨（user / memory）只能写在记忆根下；
 *  - 项目轨（key / project / daily-of-project）只能写在 `projects/<id>/` 下；
 *  - `user` 轨**永远不许**写进项目目录（用户档案是跨项目的，写进项目 = 之后
 *    换项目就丢了，Qoder 把这类错位列为不可纠正的风险）。
 *
 * @param {{scope: string, track: string}} request - 写入请求。
 * @param {string} rel - 计算出的相对路径。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateScopeRouting(request, rel) {
  const inProject = rel.startsWith('projects/')
  if (request.track === 'user' && inProject) {
    return { ok: false, reason: 'pinned type 违规：user（用户档案）必须写在记忆根，不能落进项目目录' }
  }
  if (request.track === 'key' && !inProject) {
    return { ok: false, reason: 'pinned type 违规：key（项目关键记忆）必须写在 projects/<projectId>/ 下' }
  }
  if (request.scope === 'project' && !inProject) {
    return { ok: false, reason: 'pinned type 违规：scope=project 的写入必须落在 projects/<projectId>/ 下' }
  }
  if (request.scope === 'global' && inProject) {
    return { ok: false, reason: 'pinned type 违规：scope=global 的写入不能落在项目目录' }
  }
  return { ok: true }
}

/** 计算某轨默认的目标文件相对路径。 */
export function targetRelFor({ scope, track, projectId, date }, { today }) {
  if (scope === 'project') {
    const base = `projects/${projectId}`
    if (track === 'daily') return `${base}/daily/${date ?? today}.md`
    if (track === 'archive') return `${base}/archive/${today}.md`
    if (track === 'key') return `${base}/KEY.md`
    if (track === 'user') return `${base}/USER.md`
    return `${base}/MEMORY.md`
  }
  if (track === 'daily') return `daily/${date ?? today}.md`
  if (track === 'user') return 'USER.md'
  if (track === 'archive') return `archive/${today}.md`
  return 'MEMORY.md'
}

/**
 * 归档目标：把条目移出主轨，但绝不删除。
 *
 * **命名与 dsh-memory-evolve 的 `ArchiveStore.fileOf` 逐字对齐**（用户
 * 2026-10-26 拍板）：不对齐时，本插件产生的归档与取代留档在对方的记忆
 * Tab 归档页里**看不见、也移不回主记忆**（那张页签只列三个固定文件）。
 *
 * ```
 * memory（全局）→ MEMORY-archive.md
 * user  （全局）→ USER-archive.md
 * key   （项目）→ projects/<projectId>/KEY-archive.md
 * 其余轨（项目日志 / 每日日志）→ 对方没有对应页签，沿用按日分文件的私名
 * ```
 *
 * 项目日志/每日日志保持私名的理由：对方没有这两个归档页签，改名字只会
 * 让文件从"按日期可辨"变成"含义不明的 MEMORY-archive"。
 *
 * @param {{scope: string, track: string, projectId?: string|null}} target - 被归档的条目。
 * @param {{today: string}} opts - 日期戳（仅私名路径用得到）。
 * @returns {string} 相对记忆根的 POSIX 路径。
 */
export function archiveRelFor({ scope, track, projectId }, { today }) {
  if (track === 'memory' && scope === 'global') return 'MEMORY-archive.md'
  if (track === 'user' && scope === 'global') return 'USER-archive.md'
  if (track === 'key' && scope === 'project' && projectId) return `projects/${projectId}/KEY-archive.md`
  if (scope === 'project') return `projects/${projectId}/archive/${track}-${today}.md`
  return `archive/${track}-${today}.md`
}

/** 条目时间戳前缀（与 memory-evolve 的写法一致：`[YYYY-MM-DD HH:MM]`）。 */
export function stamped(entry, stamp) {
  const body = String(entry ?? '').trim()
  if (STAMP_RE.test(stripTags(body))) return body
  return `[${stamp}] ${body}`
}

/** 取代标记（L2）：`[superseded-by:<id>] ` 前缀。 */
export function supersededTag(replacementId) {
  return `[superseded-by:${String(replacementId).replace(/[\]\n\r]/g, '')}]`
}

/**
 * 把一条条目标记为被取代（L2）——**只打标记，不移动、不删除**。
 *
 * 与 `removeEntries` 的分工：取代的完整动作 = 「在新位置留一条带标记的副本」
 * + 「从原位置移除」。这里只做标记，搬运由调用方（consolidate / tools）
 * 显式组合，因为"搬到哪里"取决于轨道语义，不该由文件原语猜。
 *
 * @param {string} file - 目标文件。
 * @param {string} oldBody - 被取代条目的正文。
 * @param {string} replacementId - 取代它的条目 id。
 * @param {object} [opts] - { backupDir, stamp }。
 * @returns {{ok: boolean, file: string, marked: number, backup: string|null, mode: string}}
 */
export function markSuperseded(file, oldBody, replacementId, opts = {}) {
  const target = String(oldBody).trim()
  return withFileWriteLock(file, () => {
    const { chunks, mode, exists } = readChunks(file)
    if (!exists) return { ok: false, file, marked: 0, backup: null, mode }
    let marked = 0
    const next = chunks.map((chunk) => {
      if (chunk.trim() !== target) return chunk
      if (/^\s*\[superseded-by:/.test(chunk)) return chunk // 已标记，幂等
      marked += 1
      return `${supersededTag(replacementId)} ${chunk}`
    })
    if (marked === 0) return { ok: true, file, marked: 0, backup: null, mode }
    // 修复（2026-10-27）：这里原来误用了未定义的 `backupDir`——该分支一旦
    // 被调用就是 ReferenceError（静默把"取代"变成失败）。正确来源是 opts。
    const backup = opts.backupDir ? backupFile(file, opts.backupDir, opts.stamp ?? 'now') : null
    writeFileAtomic(file, joinChunks(next, mode), { mode: 0o600 })
    return { ok: true, file, marked, backup, mode }
  }, lockOptsOf(opts))
}

/**
 * 从写原语的 opts 里挑出锁相关参数（见 withFileWriteLock 的 lockOpts）。
 * @param {object} opts - 写原语选项。
 * @returns {object} 锁选项。
 */
function lockOptsOf(opts = {}) {
  const out = {}
  if (opts.legacyDir !== undefined) out.legacyDir = opts.legacyDir
  if (opts.legacyTimeoutMs !== undefined) out.legacyTimeoutMs = opts.legacyTimeoutMs
  if (opts.legacyStaleMs !== undefined) out.legacyStaleMs = opts.legacyStaleMs
  if (opts.lockTimeoutMs !== undefined) out.lockTimeoutMs = opts.lockTimeoutMs
  if (opts.staleMs !== undefined) out.staleMs = opts.staleMs
  return out
}

/** 便于测试/诊断：某个文件当前有多少条目。 */
export function entryCountOf(file) {
  return readChunks(file).chunks.length
}