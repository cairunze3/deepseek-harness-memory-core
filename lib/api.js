/**
 * lib/api.js — 给管理界面用的 HTTP 接口（"只做编辑和展示"）。
 *
 * ## 为什么走 HTTP
 * 本插件没有客户端半（`.jsx`/构建链），但宿主 offer 了 `ctx.webServer.register`。
 * 于是最省事又最稳的路径是：**宿主半注册几个 REST 路由**，客户端半（几十行）只负责
 * 列表/编辑/保存。这样界面逻辑与记忆逻辑之间有一层明确的契约，也方便用 curl 验证。
 *
 * ## 铁律：界面编辑也必须走同一条闸门
 * 保存不是 `writeFileSync`，而是 `memfile.replaceEntry` —— 它有：
 *   - 跨进程锁（含与旧实现的 `.memory.lock` 互操作）
 *   - 改前备份
 *   - 原子写
 *   - **锁内重读 + 按"用户看到的那份正文"精确匹配**（这就是乐观并发：
 *     如果这期间别人改过，匹配不上 → 拒绝，而不是覆盖）
 *
 * ## 接口
 * `GET  /api/memory-core/state`       → 规模/分轨统计/可疑数/预算占用
 * `GET  /api/memory-core/entries`     → 列表（可按 track / 只看可疑筛选）
 * `GET  /api/memory-core/entry?ptr=`  → 单条全文（含 etag = 正文哈希）
 * `POST /api/memory-core/entry`       → 保存 { pointer, base, content }；base 不匹配 → 409
 * `GET  /api/memory-core/validate`    → 格式体检（结构问题）
 * `GET  /api/memory-core/revisions`   → 最近修订
 * `POST /api/memory-core/verify`      → 清掉某条的可疑标记
 *
 * @module vanwork-memory-core/lib/api
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { replaceEntry } from './memfile.js'
import { entrySlotKey } from './slots.js'
import { recordRevision, readRevisions } from './revisions.js'
import { validateFiles } from './validate.js'
import { clearMark, readMarks } from './suspect.js'
import { bodyKey } from './suspect.js'
import { OVERVIEW_REL, countPointers, overviewStampOf, renderOverview } from './overview.js'
import { GLOBAL_REL, applyOps, describeDiff, diffSlots, parseSlots, renderSlots, slotsChars } from './global.js'

const PREFIX = '/api/memory-core'

/** 解析 `rel#ordinal` 指针。 */
export function parsePointer(pointer) {
  const text = String(pointer ?? '').trim()
  const at = text.lastIndexOf('#')
  if (at <= 0) return null
  const rel = text.slice(0, at)
  const ordinal = Number(text.slice(at + 1))
  if (!Number.isInteger(ordinal) || ordinal < 0) return null
  if (rel.includes('..')) return null
  return { rel, ordinal }
}

/** 路径必须在记忆根内（防目录穿越）。 */
function guardPath(memoryDir, rel) {
  const root = resolve(memoryDir)
  const full = resolve(root, rel)
  if (full !== root && !full.startsWith(root)) return null
  return full
}

/** 把扫描条目转成界面要的形状（只给必要字段，避免把整库正文推给浏览器）。 */
function toRow(entry) {
  return {
    pointer: `${entry.rel}#${entry.ordinal}`,
    rel: entry.rel,
    ordinal: entry.ordinal,
    track: entry.track,
    scope: entry.scope,
    projectId: entry.projectId ?? null,
    date: entry.date ?? null,
    time: entry.time ?? null,
    summary: entry.summary,
    chars: entry.chars,
    ageDays: entry.ageDays ?? null,
    suspect: entry.suspect ? { reason: entry.suspect.reason, reasonText: entry.suspect.reasonText, markedAt: entry.suspect.markedAt, hits: entry.suspect.hits ?? 0 } : null,
    supersededBy: entry.supersededBy ?? null,
    etag: bodyKey(entry.body),
  }
}

/** 读请求体（有上限，防误发大文件把内存打满）。 */
function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((done, fail) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { fail(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        done(text === '' ? {} : JSON.parse(text))
      } catch (error) { fail(error) }
    })
    req.on('error', fail)
  })
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 原子写整份文件（概览是派生物，整份替换是对的；但仍备份 + 记修订）。 */
function writeWholeFile(full, content, { backupDir = null, stamp = null } = {}) {
  const before = existsSync(full) ? readFileSync(full, 'utf8') : ''
  if (backupDir && before !== '') {
    try {
      const target = join(backupDir, stamp ?? 'today')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, `${basename(full)}.${Date.now()}`), before, 'utf8')
    } catch { /* 备份失败不阻断写入，但修订记录仍会留痕 */ }
  }
  const tmp = `${full}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, full)
  return { before, after: content }
}

/**
 * 组装路由（**不直接注册**，方便单测用假 req/res 驱动）。
 *
 * @param {object} rt - runtime。
 * @param {object} [opts] - { config }。
 * @returns {Array<{path: string, method: string, handler: Function}>} 路由表。
 */
export function buildRoutes(rt, opts = {}) {
  const config = opts.config ?? rt.config ?? {}
  const memoryDir = rt.memoryDir
  const coreDir = rt.coreDir

  /** 取一份新鲜快照（界面要看到刚写的）。 */
  const snapshot = () => rt.getSnapshot({ force: true })

  function state() {
    const snap = snapshot()
    const byTrack = {}
    for (const entry of snap.entries) byTrack[entry.track] = (byTrack[entry.track] ?? 0) + 1
    let suspects = 0
    try { suspects = Object.keys(readMarks(coreDir).marks).length } catch { suspects = 0 }
    return {
      ok: true,
      memoryDir,
      coreDir,
      entries: snap.entries.length,
      files: snap.files.length,
      byTrack,
      suspects,
      budget: {
        indexTopN: config.indexTopN ?? 40,
        indexMaxChars: config.indexMaxChars ?? 8000,
        injectExclude: config.injectExclude ?? [],
      },
      scannedAt: snap.scannedAt ?? null,
    }
  }

  function list(query) {
    const snap = snapshot()
    const track = query.get('track')
    const onlySuspect = query.get('suspect') === '1'
    const keyword = (query.get('q') ?? '').trim().toLowerCase()
    let rows = snap.entries.map(toRow)
    if (track && track !== 'all') rows = rows.filter((row) => row.track === track)
    if (onlySuspect) rows = rows.filter((row) => row.suspect !== null)
    if (keyword !== '') rows = rows.filter((row) => `${row.summary} ${row.pointer}`.toLowerCase().includes(keyword))
    // 默认按日期倒序（界面上"最近的先看到"最有用）
    rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.ordinal - a.ordinal)
    return { ok: true, total: rows.length, tracks: [...new Set(snap.entries.map((entry) => entry.track))].sort(), rows }
  }

  function entryOf(query) {
    const parsed = parsePointer(query.get('ptr'))
    if (parsed === null) return { status: 400, body: { ok: false, error: '指针格式应为 rel#序号' } }
    const snap = snapshot()
    const entry = snap.entries.find((candidate) => candidate.rel === parsed.rel && candidate.ordinal === parsed.ordinal)
    if (!entry) return { status: 404, body: { ok: false, error: '没找到该条目（可能已被归档或删除）' } }
    return { status: 200, body: { ok: true, ...toRow(entry), body: entry.body, hash: bodyKey(entry.body) } }
  }

  async function save(req) {
    let payload
    try { payload = await readJsonBody(req) } catch (error) {
      return { status: 400, body: { ok: false, error: `请求体不是合法 JSON：${error.message}` } }
    }
    const parsed = parsePointer(payload.pointer)
    if (parsed === null) return { status: 400, body: { ok: false, error: '指针格式应为 rel#序号' } }
    const base = typeof payload.base === 'string' ? payload.base : ''
    const content = typeof payload.content === 'string' ? payload.content.trim() : ''
    if (content === '') return { status: 400, body: { ok: false, error: '内容不能为空（要删除请用 mem_write(action=remove)）' } }

    const full = guardPath(memoryDir, parsed.rel)
    if (full === null) return { status: 400, body: { ok: false, error: '路径越界' } }

    // 乐观并发：把"用户看到的那份正文"作为匹配依据交给 replaceEntry。
    // 它在**锁内重读**之后才做匹配——期间若有人改过，就匹配不上（0 条），
    // 于是我们如实返回 409，而不是把别人的改动覆盖掉。
    const outcome = replaceEntry(full, base, content, {
      backupDir: config.backupBeforeWrite !== false ? join(coreDir, 'backups') : undefined,
      stamp: new Date().toISOString().slice(0, 10),
    })
    if (outcome?.locked === false) {
      return { status: 503, body: { ok: false, error: '取不到写锁，请稍后重试（未改动任何内容）' } }
    }
    if ((outcome?.replaced ?? 0) === 0) {
      return { status: 409, body: { ok: false, conflict: true, error: '这条记忆在你编辑期间被改过了（或用原文匹配不到）。请重新载入后再保存。' } }
    }

    const revision = recordRevision({ coreDir, rel: parsed.rel, pointer: `${parsed.rel}#${parsed.ordinal}`, before: base, after: content, source: 'gui' })
    rt.ledger?.append('write', { action: 'replace', track: 'gui', rel: parsed.rel, bytes: outcome.bytes ?? null, source: 'gui' })
    rt.invalidate()
    rt.invalidateIndexSlots?.()
    return { status: 200, body: { ok: true, pointer: payload.pointer, revision: revision.ok ? revision.entry : null } }
  }

  // ── 全局记忆（GLOBAL.md，槽位模型）──────────────────────────────────────
  const globalPath = () => guardPath(memoryDir, GLOBAL_REL)

  /** 读现状：槽列表 + 纯文本 + 体量。没文件就返回空槽（前端显示"还没有"）。 */
  function globalState() {
    const full = globalPath()
    const text = full && existsSync(full) ? readFileSync(full, 'utf8') : ''
    const slots = parseSlots(text)
    return {
      ok: true,
      rel: GLOBAL_REL,
      exists: text !== '',
      text,
      slots,
      chars: slotsChars(slots),
      updatedAt: (/(?:更新于|生成于) (\d{4}-\d{2}-\d{2})/.exec(text) ?? [])[1] ?? null,
    }
  }

  /**
   * 保存全局记忆。两种载荷都支持：
   *  - `{ base, content }` —— 面板「更新记忆」手改后保存（整份文本，base 做乐观并发）
   *  - `{ base, ops }`     —— 模型合并（槽操作；服务端算 diff 并回报）
   */
  async function saveGlobal(req) {
    let payload
    try { payload = await readJsonBody(req) } catch (error) {
      return { status: 400, body: { ok: false, error: `请求体不是合法 JSON：${error.message}` } }
    }
    const full = globalPath()
    if (full === null) return { status: 400, body: { ok: false, error: '路径越界' } }
    const current = existsSync(full) ? readFileSync(full, 'utf8') : ''
    const base = typeof payload.base === 'string' ? payload.base : null
    if (base !== null && base !== current) {
      return { status: 409, body: { ok: false, conflict: true, error: '这份记忆在你编辑期间被改过了（或被合并过）。请重新载入。' } }
    }

    let content
    let changes = []
    let rejected = []
    if (Array.isArray(payload.ops)) {
      const before = parseSlots(current)
      const result = applyOps(before, payload.ops)
      changes = result.changes
      rejected = result.rejected
      if (changes.length === 0) {
        return { status: 200, body: { ok: true, changed: false, message: describeDiff(diffSlots(before, before)), changes, rejected } }
      }
      content = renderSlots(result.slots, { stamp: new Date().toISOString().slice(0, 10) })
    } else {
      content = typeof payload.content === 'string' ? payload.content : ''
      if (content.trim() === '') return { status: 400, body: { ok: false, error: '内容不能为空' } }
      const before = parseSlots(current)
      const after = parseSlots(content)
      const diff = diffSlots(before, after)
      changes = [
        ...diff.added.map((name) => ({ op: 'add', name })),
        ...diff.changed.map((item) => ({ op: 'set', name: item.name, from: item.from, to: item.to })),
        ...diff.removed.map((name) => ({ op: 'del', name })),
      ]
    }

    const written = writeWholeFile(full, content, {
      backupDir: config.backupBeforeWrite !== false ? join(coreDir, 'backups') : null,
      stamp: new Date().toISOString().slice(0, 10),
    })
    recordRevision({ coreDir, rel: GLOBAL_REL, pointer: GLOBAL_REL, before: written.before, after: content, source: 'global' })
    rt.ledger?.append('write', { action: 'global', track: 'global', rel: GLOBAL_REL, bytes: content.length, changes: changes.length, source: 'gui' })
    rt.invalidate()
    rt.invalidateIndexSlots?.()
    const slots = parseSlots(content)
    return { status: 200, body: { ok: true, changed: true, rel: GLOBAL_REL, chars: slotsChars(slots), slots: slots.length, changes, rejected, text: content } }
  }

  function validate() {
    const snap = snapshot()
    const files = []
    for (const file of snap.files) {
      const full = guardPath(memoryDir, file.rel)
      if (full === null) continue
      try { files.push({ rel: file.rel, text: readFileSync(full, 'utf8') }) } catch { /* 读不到就跳过 */ }
    }
    const result = validateFiles(files)
    return { ok: true, ...result }
  }

  // ── 全局概览（OVERVIEW.md）────────────────────────────────────────────────
  const overviewPath = () => guardPath(memoryDir, OVERVIEW_REL)

  /** 生成一份新概览（不落盘）。 */
  function generateOverview() {
    const snap = snapshot()
    return renderOverview({ entries: snap.entries, projectLabel: snap.projectLabel, now: Date.now() })
  }

  /** 读现状 + 是否"过期"（条目数变了就算过期）。 */
  function overviewState(query) {
    const snap = snapshot()
    const full = overviewPath()
    const text = full && existsSync(full) ? readFileSync(full, 'utf8') : ''
    const want = query.get('generate') === '1'
    const body = want || text === '' ? generateOverview() : text
    return {
      ok: true,
      rel: OVERVIEW_REL,
      text: body,
      exists: text !== '',
      generated: text === '' || want,
      stamp: overviewStampOf(body),
      pointers: countPointers(body),
      entries: snap.entries.length,
    }
  }

  /** 保存概览（整份替换；备份 + 修订 + 账本）。 */
  async function saveOverview(req) {
    let payload
    try { payload = await readJsonBody(req) } catch (error) {
      return { status: 400, body: { ok: false, error: `请求体不是合法 JSON：${error.message}` } }
    }
    const content = typeof payload.content === 'string' ? payload.content : ''
    if (content.trim() === '') return { status: 400, body: { ok: false, error: '概览不能为空' } }
    const full = overviewPath()
    if (full === null) return { status: 400, body: { ok: false, error: '路径越界' } }

    // 乐观并发：面板载入时带 base（原文），不匹配就 409。
    const base = typeof payload.base === 'string' ? payload.base : null
    const current = existsSync(full) ? readFileSync(full, 'utf8') : ''
    if (base !== null && base !== current) {
      return { status: 409, body: { ok: false, conflict: true, error: '概览在你编辑期间被改过了（或已重新生成）。请重新载入。' } }
    }
    const written = writeWholeFile(full, content, {
      backupDir: config.backupBeforeWrite !== false ? join(coreDir, 'backups') : null,
      stamp: new Date().toISOString().slice(0, 10),
    })
    recordRevision({ coreDir, rel: OVERVIEW_REL, pointer: OVERVIEW_REL, before: written.before, after: content, source: 'overview' })
    rt.ledger?.append('write', { action: 'overview', track: 'overview', rel: OVERVIEW_REL, bytes: content.length, source: 'gui' })
    rt.invalidate()
    rt.invalidateIndexSlots?.()
    return { status: 200, body: { ok: true, rel: OVERVIEW_REL, chars: content.length, pointers: countPointers(content) } }
  }

  async function verify(req) {
    let payload
    try { payload = await readJsonBody(req) } catch (error) {
      return { status: 400, body: { ok: false, error: `请求体不是合法 JSON：${error.message}` } }
    }
    const parsed = parsePointer(payload.pointer)
    if (parsed === null) return { status: 400, body: { ok: false, error: '指针格式应为 rel#序号' } }
    const snap = snapshot()
    const entry = snap.entries.find((candidate) => candidate.rel === parsed.rel && candidate.ordinal === parsed.ordinal)
    if (!entry) return { status: 404, body: { ok: false, error: '没找到该条目' } }
    const cleared = clearMark({ coreDir, body: entry.body })
    rt.invalidate()
    return { status: 200, body: { ok: true, removed: cleared.removed } }
  }

  return [
    { method: 'GET', path: `${PREFIX}/state`, handler: () => state() },
    { method: 'GET', path: `${PREFIX}/global`, handler: () => globalState() },
    { method: 'POST', path: `${PREFIX}/global`, handler: (req) => saveGlobal(req) },
    { method: 'GET', path: `${PREFIX}/overview`, handler: (req) => overviewState(new URL(req.url, 'http://local').searchParams) },
    { method: 'POST', path: `${PREFIX}/overview`, handler: (req) => saveOverview(req) },
    { method: 'GET', path: `${PREFIX}/entries`, handler: (req) => list(new URL(req.url, 'http://local').searchParams) },
    { method: 'GET', path: `${PREFIX}/entry`, handler: (req) => entryOf(new URL(req.url, 'http://local').searchParams) },
    { method: 'POST', path: `${PREFIX}/entry`, handler: (req) => save(req) },
    { method: 'GET', path: `${PREFIX}/validate`, handler: () => validate() },
    { method: 'GET', path: `${PREFIX}/revisions`, handler: (req) => {
      const limit = Number(new URL(req.url, 'http://local').searchParams.get('limit') ?? '20')
      return { ok: true, rows: readRevisions({ coreDir, limit: Number.isFinite(limit) ? limit : 20 }) }
    } },
    { method: 'POST', path: `${PREFIX}/verify`, handler: (req) => verify(req) },
  ]
}

/**
 * 把路由注册到 host 的 webServer 上（`ctx.webServer.register`）。
 *
 * @param {object} rt - runtime。
 * @param {object} webServer - `ctx.webServer`。
 * @param {Function} effect - `ctx.effect`。
 * @returns {number} 注册的路由数。
 */
export function registerRoutes(rt, webServer, effect) {
  const routes = buildRoutes(rt)
  let count = 0
  for (const route of routes) {
    const handler = async (req, res) => {
      if (req.method !== route.method) {
        // 允许 GET 路由被 HEAD 探测
        if (!(route.method === 'GET' && req.method === 'HEAD')) return sendJson(res, 405, { ok: false, error: '方法不允许' })
      }
      try {
        const result = await route.handler(req, res)
        // handler 既可以返回 { status, body }，也可以直接返回 body
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) sendJson(res, result.status, result.body)
        else sendJson(res, 200, result ?? { ok: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    effect(() => webServer.register({ kind: 'exact', path: route.path, handler }), `memory-core: ${route.path}`)
    count += 1
  }
  return count
}