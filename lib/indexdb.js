/**
 * lib/indexdb.js — 派生索引（可整份删除重建）。
 *
 * 采纳 OfficeClaw 报告的检索设计：**BM25 关键词索引 + 可选向量 + 混合**，
 * 但把载体从"平台统一管理的数据库"改成"插件自有的派生索引"——因为本插件
 * 刻意不做第二份记忆正本（见 scanner.js 头注释）。索引掉了可以重建，
 * 记忆掉了不可恢复，两者必须分开。
 *
 * 两套后端，同一接口：
 *  - `sqlite`：Node 22 内建 `node:sqlite` + FTS5（BM25 排序、可扩展到大体量）。
 *    代价：该模块目前标记为 experimental，加载时 Node 会打一行 ExperimentalWarning。
 *  - `json`：纯 JS 倒排索引 + BM25（零依赖、零告警、零原生模块；条目数千级够用）。
 *
 * `backend: 'auto'`（默认）先试 sqlite，失败静默回退 json——插件绝不能因为
 * 一个可选加速器而拖垮宿主启动。
 *
 * @module vanwork-memory-core/lib/indexdb
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDir, writeFileAtomic } from './fsutil.js'
import { tokenize, toMatchExpression } from './scanner.js'

const require = createRequire(import.meta.url)

/**
 * SQLite 绑定值归一。
 *
 * `node:sqlite` 对 `undefined` 会抛 "Provided value cannot be bound to SQLite
 * parameter N"，而 `undefined` 在 JS 对象里随处可见（少写一个字段就会出现）。
 * 这里统一把 `undefined` 折成 `null`、布尔折成 0/1——把"少字段"从一个致命
 * 错误降级为一条空列。这个坑在开发本插件时真实踩过一次：`classifyFile` 少
 * 返回一个 `projectId` 就让整个索引静默失效。
 */
const bind = (value) => (value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value)
const bindAll = (values) => values.map(bind)

/** BM25 参数（与 FTS5 默认一致的量级）。 */
const BM25_K1 = 1.2
const BM25_B = 0.75
/** 索引 schema 版本：变更时自动整份重建（索引是派生物，不需要迁移逻辑）。 */
export const INDEX_SCHEMA_VERSION = 3

/**
 * 打开索引。
 * @param {object} p - { dir, backend='auto', logger }。
 * @returns {SqliteIndex|JsonIndex}
 */
export function openIndex({ dir, backend = 'auto', logger = console } = {}) {
  ensureDir(dir)
  if (backend === 'sqlite' || backend === 'auto') {
    try {
      const sqlite = loadSqlite()
      if (sqlite) return new SqliteIndex(join(dir, 'memory-index.db'), sqlite, logger)
      if (backend === 'sqlite') logger?.warn?.('[memory-core] sqlite 后端不可用，已回退 json 后端')
    } catch (error) {
      if (backend === 'sqlite') throw error
      logger?.warn?.(`[memory-core] sqlite 后端初始化失败（${error?.message ?? error}），已回退 json 后端`)
    }
  }
  return new JsonIndex(join(dir, 'memory-index.json'), logger)
}

function loadSqlite() {
  try {
    return require('node:sqlite')
  } catch {
    return null
  }
}

/**
 * 条目（camelCase，scanner 的形状）→ 行（snake_case，SQLite 的形状）。
 *
 * 两个后端**必须返回同一种行形状**：否则调用方就得同时处理 `entry_id` 与
 * `entryId`，而任何一处漏判都会静默产出 `undefined` 字段（开发时真实踩过：
 * 测试断言 `hits[0].entry_id` 拿到 undefined，正是 JSON 后端直接吐回了
 * 原始条目对象）。形状统一放在这一个函数里，是让两套后端"可互换"的最低成本。
 */
function toRow(entry) {
  return {
    entry_id: entry.entryId,
    path: entry.path,
    rel: entry.rel,
    root: entry.root,
    ordinal: entry.ordinal ?? 0,
    scope: entry.scope,
    track: entry.track,
    project_id: entry.projectId ?? null,
    project_label: entry.projectLabel ?? null,
    date: entry.date ?? null,
    time: entry.time ?? null,
    stamp: entry.stamp ?? null,
    summary: entry.summary,
    body: entry.body,
    chars: entry.chars,
    bytes: entry.bytes,
    mtime: entry.mtime,
    age_days: entry.ageDays ?? null,
    id_tag: entry.idTag ?? null,
    branch_tag: entry.branchTag ?? null,
    superseded_by: entry.supersededBy ?? null,
    dsh_only: entry.dshOnly === true ? 1 : 0,
    file_hash: entry.contentHash ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite + FTS5 后端
// ─────────────────────────────────────────────────────────────────────────────

class SqliteIndex {
  constructor(dbPath, sqlite, logger) {
    this.kind = 'sqlite'
    this.dbPath = dbPath
    this.logger = logger
    ensureDir(dirname(dbPath))
    this.db = new sqlite.DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.#migrate()
  }

  #migrate() {
    // schema 版本不符 → 整份重建。索引是派生物，"迁移"没有意义；反过来，
    // 试图在既有表上补列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
    // 会让新列永远缺失，静默产出错误结果。
    const existingVersion = this.getMeta('schema_version')
    if (existingVersion !== null && existingVersion !== String(INDEX_SCHEMA_VERSION)) {
      this.db.exec(`
        DROP TABLE IF EXISTS fts;
        DROP TABLE IF EXISTS entries;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS access;
        DROP TABLE IF EXISTS vectors;
      `)
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, rel TEXT, root TEXT, mtime INTEGER, size INTEGER,
        hash TEXT, entry_count INTEGER, scope TEXT, track TEXT, project_id TEXT,
        indexed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY, path TEXT, rel TEXT, root TEXT,
        ordinal INTEGER, scope TEXT, track TEXT, project_id TEXT, project_label TEXT,
        date TEXT, "time" TEXT, stamp TEXT, summary TEXT, body TEXT, chars INTEGER,
        bytes INTEGER, mtime INTEGER, age_days INTEGER, id_tag TEXT, branch_tag TEXT,
        superseded_by TEXT, dsh_only INTEGER, file_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS access (
        entry_id TEXT PRIMARY KEY, count INTEGER DEFAULT 0, last_access INTEGER
      );
      CREATE TABLE IF NOT EXISTS vectors (
        entry_id TEXT PRIMARY KEY, model TEXT, dim INTEGER, vec TEXT, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS entries_track ON entries(track);
      CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope);
      CREATE INDEX IF NOT EXISTS entries_project ON entries(project_id);
      CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
      CREATE INDEX IF NOT EXISTS entries_rel ON entries(rel, ordinal);
    `)
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(entry_id UNINDEXED, tokens, tokenize='unicode61')`)
    this.setMeta('schema_version', String(INDEX_SCHEMA_VERSION))
  }

  getMeta(key) {
    try {
      const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(key)
      return row ? row.v : null
    } catch {
      return null
    }
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, String(value))
  }

  /** 增量同步：按文件 hash 判断是否需要重建该文件的条目。 */
  sync(entries, files) {
    const now = Date.now()
    const knownPaths = new Set(files.map((f) => f.path))
    let added = 0
    let removed = 0
    let filesIndexed = 0

    const deleteByPath = this.db.prepare('DELETE FROM fts WHERE entry_id IN (SELECT entry_id FROM entries WHERE path = ?)')
    const deleteEntries = this.db.prepare('DELETE FROM entries WHERE path = ?')
    const upsertFile = this.db.prepare(`
      INSERT INTO files(path, rel, root, mtime, size, hash, entry_count, scope, track, project_id, indexed_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        rel=excluded.rel, root=excluded.root, mtime=excluded.mtime, size=excluded.size,
        hash=excluded.hash, entry_count=excluded.entry_count, scope=excluded.scope,
        track=excluded.track, project_id=excluded.project_id, indexed_at=excluded.indexed_at
    `)
    const insertEntry = this.db.prepare(`
      INSERT INTO entries(entry_id, path, rel, root, ordinal, scope, track, project_id, project_label,
        date, "time", stamp, summary, body, chars, bytes, mtime, age_days, id_tag, branch_tag,
        superseded_by, dsh_only, file_hash)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        path=excluded.path, rel=excluded.rel, root=excluded.root, ordinal=excluded.ordinal,
        scope=excluded.scope,
        track=excluded.track, project_id=excluded.project_id, project_label=excluded.project_label,
        date=excluded.date, "time"=excluded."time", stamp=excluded.stamp, summary=excluded.summary,
        body=excluded.body, chars=excluded.chars, bytes=excluded.bytes, mtime=excluded.mtime,
        age_days=excluded.age_days, id_tag=excluded.id_tag, branch_tag=excluded.branch_tag,
        superseded_by=excluded.superseded_by, dsh_only=excluded.dsh_only, file_hash=excluded.file_hash
    `)
    const insertFts = this.db.prepare('INSERT INTO fts(entry_id, tokens) VALUES(?, ?)')

    const existingHashes = new Map()
    for (const row of this.db.prepare('SELECT path, hash, entry_count FROM files').all()) {
      existingHashes.set(row.path, { hash: row.hash, entryCount: row.entry_count })
    }

    this.db.exec('BEGIN')
    try {
      // 1) 已消失的文件：清条目
      for (const path of existingHashes.keys()) {
        if (!knownPaths.has(path)) {
          removed += this.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE path = ?').get(path).n
          deleteByPath.run(path)
          deleteEntries.run(path)
          this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
        }
      }
      // 2) 新增/变更的文件
      for (const file of files) {
        const prior = existingHashes.get(file.path)
        const entriesOfFile = entries.filter((e) => e.path === file.path)
        upsertFile.run(...bindAll([
          file.path, file.rel, file.root, file.mtime, file.size, file.hash,
          entriesOfFile.length, file.scope, file.track, file.projectId, now,
        ]))
        if (prior && prior.hash === file.hash && prior.entryCount === entriesOfFile.length) continue
        filesIndexed += 1
        removed += this.db.prepare('SELECT COUNT(*) AS n FROM entries WHERE path = ?').get(file.path).n
        deleteByPath.run(file.path)
        deleteEntries.run(file.path)
        for (const entry of entriesOfFile) {
          insertEntry.run(...bindAll([
            entry.entryId, entry.path, entry.rel, entry.root, entry.ordinal, entry.scope, entry.track,
            entry.projectId, entry.projectLabel, entry.date, entry.time, entry.stamp,
            entry.summary, entry.body, entry.chars, entry.bytes, entry.mtime, entry.ageDays,
            entry.idTag, entry.branchTag, entry.supersededBy, entry.dshOnly, entry.contentHash,
          ]))
          insertFts.run(entry.entryId, tokenize(`${entry.summary} ${entry.indexedBody}`).join(' '))
          added += 1
        }
      }
      this.setMeta('last_sync', String(now))
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      throw error
    }
    return { added, removed, filesIndexed }
  }

  /**
   * BM25 检索。
   * @param {string} query - 自然语言查询。
   * @param {object} [opts] - { limit, tracks, scopes, projectId, projectIds, includeArchived }。
   * @returns {Array<object>} 命中（按 rank 升序，含 bm25 原始分数）。
   */
  search(query, opts = {}) {
    const match = toMatchExpression(query)
    if (match === '') return []
    const limit = Math.max(1, opts.limit ?? 10)
    const where = []
    const params = []
    if (Array.isArray(opts.tracks) && opts.tracks.length > 0) {
      where.push(`e.track IN (${opts.tracks.map(() => '?').join(',')})`)
      params.push(...opts.tracks)
    }
    if (Array.isArray(opts.scopes) && opts.scopes.length > 0) {
      where.push(`e.scope IN (${opts.scopes.map(() => '?').join(',')})`)
      params.push(...opts.scopes)
    }
    if (opts.projectId) { where.push('e.project_id = ?'); params.push(opts.projectId) }
    if (Array.isArray(opts.projectIds) && opts.projectIds.length > 0) {
      where.push(`e.project_id IN (${opts.projectIds.map(() => '?').join(',')})`)
      params.push(...opts.projectIds)
    }
    if (opts.includeArchived !== true) where.push("e.track <> 'archive'")
    // 被取代（L2）的条目默认不召回：它可能还在原轨（例如人工只打了标记没搬走），
    // 所以这里除了归档还要单独挡一道。要看"曾经的错误结论"就显式
    // includeArchived=true（那条路会同时放开这两个条件）。
    if (opts.includeArchived !== true) where.push('e.superseded_by IS NULL')

    const sql = `
      SELECT e.*, bm25(fts) AS score
      FROM fts JOIN entries e ON e.entry_id = fts.entry_id
      WHERE fts MATCH ?${where.length > 0 ? ` AND ${where.join(' AND ')}` : ''}
      ORDER BY score ASC
      LIMIT ?
    `
    let rows
    try {
      rows = this.db.prepare(sql).all(match, ...params, limit)
    } catch {
      return []
    }
    return rows.map((row, index) => ({ ...row, rank: index + 1, bm25: row.score }))
  }

  getById(entryId) {
    try {
      return this.db.prepare('SELECT * FROM entries WHERE entry_id = ?').get(entryId) ?? null
    } catch {
      return null
    }
  }

  getByIds(entryIds) {
    if (!Array.isArray(entryIds) || entryIds.length === 0) return []
    const placeholders = entryIds.map(() => '?').join(',')
    try {
      return this.db.prepare(`SELECT * FROM entries WHERE entry_id IN (${placeholders})`).all(...entryIds)
    } catch {
      return []
    }
  }

  allEntries(opts = {}) {
    const where = []
    const params = []
    if (Array.isArray(opts.tracks) && opts.tracks.length > 0) {
      where.push(`track IN (${opts.tracks.map(() => '?').join(',')})`)
      params.push(...opts.tracks)
    }
    if (Array.isArray(opts.scopes) && opts.scopes.length > 0) {
      where.push(`scope IN (${opts.scopes.map(() => '?').join(',')})`)
      params.push(...opts.scopes)
    }
    if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId) }
    const sql = `SELECT * FROM entries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY mtime DESC LIMIT ?`
    try {
      return this.db.prepare(sql).all(...params, opts.limit ?? 2000)
    } catch {
      return []
    }
  }

  recordAccess(entryIds) {
    if (!Array.isArray(entryIds) || entryIds.length === 0) return
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO access(entry_id, count, last_access) VALUES(?, 1, ?)
      ON CONFLICT(entry_id) DO UPDATE SET count = count + 1, last_access = excluded.last_access
    `)
    this.db.exec('BEGIN')
    try {
      for (const id of entryIds) stmt.run(id, now)
      this.db.exec('COMMIT')
    } catch {
      try { this.db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    }
  }

  accessCounts(entryIds) {
    if (!Array.isArray(entryIds) || entryIds.length === 0) return new Map()
    const placeholders = entryIds.map(() => '?').join(',')
    try {
      const rows = this.db.prepare(`SELECT entry_id, count, last_access FROM access WHERE entry_id IN (${placeholders})`).all(...entryIds)
      return new Map(rows.map((r) => [r.entry_id, r]))
    } catch {
      return new Map()
    }
  }

  putVectors(items) {
    if (!Array.isArray(items) || items.length === 0) return
    const stmt = this.db.prepare(`
      INSERT INTO vectors(entry_id, model, dim, vec, updated_at) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec, updated_at=excluded.updated_at
    `)
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      for (const item of items) stmt.run(item.entryId, item.model ?? '', item.vec.length, JSON.stringify(item.vec), now)
      this.db.exec('COMMIT')
    } catch {
      try { this.db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    }
  }

  getVectors(entryIds) {
    if (!Array.isArray(entryIds) || entryIds.length === 0) return new Map()
    const placeholders = entryIds.map(() => '?').join(',')
    try {
      const rows = this.db.prepare(`SELECT entry_id, model, dim, vec FROM vectors WHERE entry_id IN (${placeholders})`).all(...entryIds)
      return new Map(rows.map((r) => [r.entry_id, { model: r.model, dim: r.dim, vec: JSON.parse(r.vec) }]))
    } catch {
      return new Map()
    }
  }

  stats() {
    const one = (sql, ...params) => {
      try { return this.db.prepare(sql).get(...params) } catch { return null }
    }
    const trackRows = (() => {
      try { return this.db.prepare('SELECT track, COUNT(*) AS n FROM entries GROUP BY track ORDER BY n DESC').all() } catch { return [] }
    })()
    const counts = one('SELECT COUNT(*) AS n FROM entries')
    const fileCount = one('SELECT COUNT(*) AS n FROM files')
    const bounds = one('SELECT MIN(date) AS oldest, MAX(date) AS newest, SUM(bytes) AS bytes FROM entries')
    return {
      backend: 'sqlite',
      dbPath: this.dbPath,
      entryCount: counts?.n ?? 0,
      fileCount: fileCount?.n ?? 0,
      trackCounts: Object.fromEntries(trackRows.map((r) => [r.track, r.n])),
      oldest: bounds?.oldest ?? null,
      newest: bounds?.newest ?? null,
      bodyBytes: bounds?.bytes ?? 0,
      lastSyncAt: Number(this.getMeta('last_sync') ?? 0) || null,
      schemaVersion: INDEX_SCHEMA_VERSION,
    }
  }

  close() {
    try { this.db.close() } catch { /* 已关闭 */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯 JS 倒排索引后端（零依赖回退）
// ─────────────────────────────────────────────────────────────────────────────

class JsonIndex {
  constructor(file, logger) {
    this.kind = 'json'
    this.file = file
    this.logger = logger
    /** @type {Map<string, object>} entryId → entry */
    this.entries = new Map()
    /** @type {Map<string, object>} path → file record */
    this.files = new Map()
    /** @type {Map<string, {count:number,last:number}>} */
    this.access = new Map()
    /** @type {Map<string, number[]>} */
    this.vectors = new Map()
    this.lastSyncAt = null
    this.#load()
  }

  #load() {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw?.schemaVersion !== INDEX_SCHEMA_VERSION) return
      for (const entry of raw.entries ?? []) this.entries.set(entry.entryId, entry)
      for (const file of raw.files ?? []) this.files.set(file.path, file)
      for (const [id, value] of Object.entries(raw.access ?? {})) this.access.set(id, value)
      for (const [id, value] of Object.entries(raw.vectors ?? {})) this.vectors.set(id, value)
      this.lastSyncAt = raw.lastSyncAt ?? null
    } catch {
      // 索引损坏 → 丢弃重建（索引是派生物，没有恢复价值）
      this.entries = new Map()
      this.files = new Map()
    }
  }

  #persist() {
    try {
      writeFileAtomic(this.file, JSON.stringify({
        schemaVersion: INDEX_SCHEMA_VERSION,
        lastSyncAt: this.lastSyncAt,
        files: [...this.files.values()],
        entries: [...this.entries.values()],
        access: Object.fromEntries(this.access),
        vectors: Object.fromEntries(this.vectors),
      }), { mode: 0o600 })
    } catch (error) {
      this.logger?.warn?.(`[memory-core] 索引落盘失败：${error?.message ?? error}`)
    }
  }

  sync(entries, files) {
    let added = 0
    let removed = 0
    let filesIndexed = 0
    const knownPaths = new Set(files.map((f) => f.path))

    for (const [path] of this.files) {
      if (knownPaths.has(path)) continue
      for (const [id, entry] of this.entries) if (entry.path === path) { this.entries.delete(id); removed += 1 }
      this.files.delete(path)
    }

    for (const file of files) {
      const prior = this.files.get(file.path)
      this.files.set(file.path, { ...file, indexedAt: Date.now() })
      const entriesOfFile = entries.filter((e) => e.path === file.path)
      if (prior && prior.hash === file.hash && prior.entryCount === entriesOfFile.length) continue
      filesIndexed += 1
      for (const [id, entry] of this.entries) if (entry.path === file.path) { this.entries.delete(id); removed += 1 }
      for (const entry of entriesOfFile) { this.entries.set(entry.entryId, entry); added += 1 }
    }

    this.lastSyncAt = Date.now()
    this.#persist()
    return { added, removed, filesIndexed }
  }

  /** 构建倒排索引（每次检索现算；条目数千级时开销可忽略）。 */
  #postings() {
    const docs = [...this.entries.values()]
    const index = new Map()
    const lengths = []
    let totalLength = 0
    docs.forEach((doc, docIndex) => {
      const tokens = tokenize(`${doc.summary} ${doc.indexedBody ?? doc.body}`)
      lengths.push(tokens.length || 1)
      totalLength += tokens.length
      const seen = new Set()
      for (const token of tokens) {
        if (seen.has(token)) continue
        seen.add(token)
        let list = index.get(token)
        if (!list) { list = []; index.set(token, list) }
        list.push(docIndex)
      }
    })
    return { docs, index, lengths, avgdl: docs.length > 0 ? totalLength / docs.length : 0 }
  }

  search(query, opts = {}) {
    const { docs, index, lengths, avgdl } = this.#postings()
    if (docs.length === 0) return []
    const tokens = tokenize(query)
    if (tokens.length === 0) return []
    const scores = new Map()
    const N = docs.length
    for (const token of tokens) {
      const list = index.get(token)
      if (!list) continue
      const df = list.length
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      for (const docIndex of list) {
        const dl = lengths[docIndex] ?? 1
        const tf = 1
        const score = idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgdl || 1))))
        scores.set(docIndex, (scores.get(docIndex) ?? 0) + score)
      }
    }
    const passes = (entry) => {
      if (Array.isArray(opts.tracks) && opts.tracks.length > 0 && !opts.tracks.includes(entry.track)) return false
      if (Array.isArray(opts.scopes) && opts.scopes.length > 0 && !opts.scopes.includes(entry.scope)) return false
      if (opts.projectId && entry.projectId !== opts.projectId) return false
      if (Array.isArray(opts.projectIds) && opts.projectIds.length > 0 && !opts.projectIds.includes(entry.projectId)) return false
      if (opts.includeArchived !== true && entry.track === 'archive') return false
      if (opts.includeArchived !== true && entry.supersededBy) return false
      return true
    }
    return [...scores.entries()]
      .filter(([docIndex]) => passes(docs[docIndex]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, opts.limit ?? 10))
      .map(([docIndex, score], i) => ({ ...toRow(docs[docIndex]), score: -score, bm25: -score, rank: i + 1 }))
  }

  getById(entryId) {
    const entry = this.entries.get(entryId)
    return entry ? toRow(entry) : null
  }

  getByIds(entryIds) {
    return (entryIds ?? []).map((id) => this.entries.get(id)).filter(Boolean).map(toRow)
  }

  allEntries(opts = {}) {
    const passes = (entry) => {
      if (Array.isArray(opts.tracks) && opts.tracks.length > 0 && !opts.tracks.includes(entry.track)) return false
      if (Array.isArray(opts.scopes) && opts.scopes.length > 0 && !opts.scopes.includes(entry.scope)) return false
      if (opts.projectId && entry.projectId !== opts.projectId) return false
      return true
    }
    return [...this.entries.values()]
      .filter(passes)
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
      .slice(0, opts.limit ?? 2000)
      .map(toRow)
  }

  recordAccess(entryIds) {
    const now = Date.now()
    for (const id of entryIds ?? []) {
      const prior = this.access.get(id) ?? { count: 0, last: 0 }
      this.access.set(id, { count: prior.count + 1, last: now })
    }
    this.#persist()
  }

  accessCounts(entryIds) {
    const out = new Map()
    for (const id of entryIds ?? []) {
      const value = this.access.get(id)
      if (value) out.set(id, { entry_id: id, count: value.count, last_access: value.last })
    }
    return out
  }

  putVectors(items) {
    for (const item of items ?? []) this.vectors.set(item.entryId, { model: item.model ?? '', dim: item.vec.length, vec: item.vec })
    this.#persist()
  }

  getVectors(entryIds) {
    const out = new Map()
    for (const id of entryIds ?? []) {
      const value = this.vectors.get(id)
      if (value) out.set(id, value)
    }
    return out
  }

  stats() {
    const trackCounts = {}
    let bytes = 0
    let oldest = null
    let newest = null
    for (const entry of this.entries.values()) {
      trackCounts[entry.track] = (trackCounts[entry.track] ?? 0) + 1
      bytes += entry.bytes ?? 0
      if (entry.date) {
        if (oldest === null || entry.date < oldest) oldest = entry.date
        if (newest === null || entry.date > newest) newest = entry.date
      }
    }
    return {
      backend: 'json',
      dbPath: this.file,
      entryCount: this.entries.size,
      fileCount: this.files.size,
      trackCounts,
      oldest,
      newest,
      bodyBytes: bytes,
      lastSyncAt: this.lastSyncAt,
      schemaVersion: INDEX_SCHEMA_VERSION,
    }
  }

  close() {
    this.#persist()
  }
}

/** 暴露 BM25 参数供测试断言（避免测试里复制常量）。 */
export const BM25_PARAMS = { k1: BM25_K1, b: BM25_B }