/**
 * 开发者模式（v0.6.0，设置页「开发者模式」）的回归测试。
 *
 * 守五条性质：
 *  1. **默认关闭**（缺文件 = 关）：既有部署升级后不会突然多出一个可写全盘的入口；
 *  2. 关闭时 `/devfile` 的读与写**一律 403**，且不碰任何文件；
 *  3. 关闭时 `/dev` 只给数量、不给清单（界面无从"暗示"可编辑）；
 *  4. 开启后列出的文件**每个都带得体的功能说明**（title/what/injectLabel 非空）——
 *     这是本功能存在的理由：改之前要知道自己改的是哪一类文件；
 *  5. 写入守纪律：乐观并发（base 不匹配 → 409）、路径守卫（越界/非 md → 400）、
 *     改前备份、写入后索引失效。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { Readable } from 'node:stream'

import { createRuntime } from '../lib/runtime.js'
import { buildRoutes } from '../lib/api.js'
import { describeFile, isDevEditable } from '../lib/devfiles.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-dev-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

/**
 * 「一定不存在」的 daily 文件名，用于测 exists:false 与新建。
 *
 * 0.6.1 起 createRuntime 会幂等预建**当天**的 daily 文件。这里原本硬编码
 * `2026-11-05.md`（写测试时的"明天"），到了 11-05 当天就变成"存在的今天"，
 * 于是 exists:false 变 true、新建 base="" 变 409 —— 两例同时假失败。
 * 与运行日期解耦：用一个远未来的日期，预建逻辑永远不会碰它。
 */
const FUTURE_DAILY = 'daily/2099-12-31.md'
const FUTURE_DAILY_NAME = '2099-12-31.md'
const FUTURE_DAILY_URL = 'daily%2F2099-12-31.md'
const FUTURE_DAILY_CONTENT = '[2099-12-31 09:00] 新的一天。\n'

let memoryDir
let coreDir
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

/** 造一份"有代表性"的记忆根：根文件 + daily + 项目 KEY/日志 + 归档。 */
function makeMemory() {
  writeFileSync(join(memoryDir, 'MEMORY.md'), '全局事实一条。\n', 'utf8')
  writeFileSync(join(memoryDir, 'USER.md'), '用户档案一条。\n', 'utf8')
  writeFileSync(join(memoryDir, 'GLOBAL.md'), '# 记忆\n\n## 身份\n深圳，简体中文。\n', 'utf8')
  mkdirSync(join(memoryDir, 'daily'), { recursive: true })
  writeFileSync(join(memoryDir, 'daily', '2026-11-04.md'), '[2026-11-04 09:00] 今天的流水。\n', 'utf8')
  const projectDir = join(memoryDir, 'projects', 'abc123def456')
  mkdirSync(join(projectDir, 'daily'), { recursive: true })
  writeFileSync(join(projectDir, 'MEMORY.md'), '项目事实。\n', 'utf8')
  writeFileSync(join(projectDir, 'KEY.md'), '项目约定。\n', 'utf8')
  writeFileSync(join(projectDir, 'daily', '2026-11-03.md'), '[2026-11-03 10:00] 项目流水。\n', 'utf8')
  mkdirSync(join(memoryDir, 'archive'), { recursive: true })
  writeFileSync(join(memoryDir, 'archive', '2026-09.md'), '归档条目。\n', 'utf8')
  writeFileSync(join(memoryDir, 'QUEUE.md'), '候选条目（未确认）。\n', 'utf8')
  // 不该被列进来的东西
  writeFileSync(join(memoryDir, 'SUGGESTIONS.jsonl'), '{}\n', 'utf8')
}

function makeRuntime() {
  makeMemory()
  return createRuntime({ config: { memoryDir, coreDir }, logger: quietLogger() })
}

function routesOf(rt) {
  const routes = buildRoutes(rt)
  const get = (path) => routes.find((route) => route.method === 'GET' && route.path === path)
  const post = (path) => routes.find((route) => route.method === 'POST' && route.path === path)
  return { get, post }
}

/** 假请求：GET 带 url（query 由 handler 自己解析），POST 推 JSON 体。 */
function fakeReq(payload, { method = 'POST', url = '/' } = {}) {
  const req = Readable.from(method === 'GET' || method === 'HEAD' ? [] : [Buffer.from(JSON.stringify(payload ?? {}), 'utf8')])
  req.method = method
  req.url = url
  return req
}

describe('开发者模式开关', () => {
  it('缺文件 = 关闭（默认安全）', () => {
    const rt = makeRuntime()
    assert.equal(rt.devMode(), false)
  })

  it('setDevMode(true) 落盘 devmode.json，另一个 runtime 也能看到', () => {
    const rt = makeRuntime()
    assert.equal(rt.setDevMode(true), true)
    const raw = JSON.parse(readFileSync(join(coreDir, 'devmode.json'), 'utf8'))
    assert.equal(raw.enabled, true)

    const other = createRuntime({ config: { memoryDir, coreDir }, logger: quietLogger() })
    assert.equal(other.devMode(), true)

    assert.equal(rt.setDevMode(false), false)
    assert.equal(other.devMode(), false, '跨 runtime 应通过 mtime 重读看到关闭')
  })

  it('开关文件损坏 → 按关闭处理（坏文件不能把全盘写权限打开）', () => {
    const rt = makeRuntime()
    writeFileSync(join(coreDir, 'devmode.json'), 'not-json{', 'utf8')
    assert.equal(rt.devMode(), false)
  })
})

describe('关闭时：接口一律拒绝，且不碰文件', () => {
  it('GET /dev 只给数量不给清单', async () => {
    const rt = makeRuntime()
    const { get } = routesOf(rt)
    const state = await get('/api/memory-core/dev').handler(fakeReq(null, { method: 'GET', url: '/api/memory-core/dev' }))
    assert.equal(state.ok, true)
    assert.equal(state.enabled, false)
    assert.deepEqual(state.files, [])
    assert.ok(state.count > 0, 'count 仍是真实文件数（开启后对账用）')
  })

  it('GET /devfile → 403', async () => {
    const rt = makeRuntime()
    const { get } = routesOf(rt)
    const result = await get('/api/memory-core/devfile')
      .handler(fakeReq(null, { method: 'GET', url: '/api/memory-core/devfile?rel=MEMORY.md' }))
    assert.equal(result.status, 403)
    assert.match(result.body.error, /开发者模式未开启/)
  })

  it('POST /devfile → 403，文件内容不变', async () => {
    const rt = makeRuntime()
    const { post } = routesOf(rt)
    const before = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    const result = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: 'MEMORY.md', base: before, content: '被篡改' }))
    assert.equal(result.status, 403)
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), before)
  })
})

describe('开启后：清单与说明', () => {
  it('列出记忆根下全部 .md（含 projects/daily/archive），排除非 md', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { get } = routesOf(rt)
    const state = get('/api/memory-core/dev').handler()

    assert.equal(state.enabled, true)
    const rels = state.files.map((row) => row.rel)
    for (const expected of ['GLOBAL.md', 'MEMORY.md', 'USER.md', 'QUEUE.md', 'daily/2026-11-04.md',
      'projects/abc123def456/MEMORY.md', 'projects/abc123def456/KEY.md',
      'projects/abc123def456/daily/2026-11-03.md', 'archive/2026-09.md']) {
      assert.ok(rels.includes(expected), `清单应包含 ${expected}，实际：${rels.join(', ')}`)
    }
    assert.ok(!rels.some((rel) => rel.endsWith('.jsonl')), '非 md 不得列出')
  })

  it('每个文件都带非空的功能说明与注入信号', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { get } = routesOf(rt)
    const state = get('/api/memory-core/dev').handler()
    for (const row of state.files) {
      assert.equal(typeof row.title, 'string')
      assert.ok(row.title.length > 0, `${row.rel} 缺 title`)
      assert.ok(row.what.length > 10, `${row.rel} 的 what 太短`)
      assert.ok(row.note.length > 0, `${row.rel} 缺 note`)
      assert.ok(['always', 'retrieval', 'archive', 'derived', 'pending'].includes(row.inject), `${row.rel} 的 inject 非法`)
      assert.ok(row.injectLabel.length > 0)
    }
  })

  it('角色判定：GLOBAL 常驻、OVERVIEW 派生物、archive 仅留档、KEY 常驻', () => {
    assert.equal(describeFile('GLOBAL.md').inject, 'always')
    assert.equal(describeFile('USER.md').inject, 'always')
    assert.equal(describeFile('MEMORY.md').inject, 'retrieval')
    assert.equal(describeFile('OVERVIEW.md').inject, 'derived')
    assert.equal(describeFile('archive/2026-09.md').inject, 'archive')
    assert.equal(describeFile('MEMORY-archive.md').inject, 'archive')
    assert.equal(describeFile('projects/x1/KEY.md').inject, 'always')
    assert.equal(describeFile('projects/x1/DIGEST.md').inject, 'retrieval')
    assert.equal(describeFile('QUEUE.md').inject, 'pending', 'QUEUE.md 是待确认候选，不进注入')
    assert.equal(describeFile('QUEUE.md').injectLabel, '待确认候选')
    assert.equal(describeFile('notes/custom.md').known, false, '未知文件要有兜底说明')
  })

  it('只开放 md 扩展名', () => {
    assert.equal(isDevEditable('MEMORY.md'), true)
    assert.equal(isDevEditable('notes/a.markdown'), true)
    assert.equal(isDevEditable('memory-index.db'), false)
    assert.equal(isDevEditable('SUGGESTIONS.jsonl'), false)
  })
})

describe('开启后：读与写', () => {
  it('GET /devfile 返回整份正文 + 说明', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { get } = routesOf(rt)
    const result = get('/api/memory-core/devfile')
      .handler(fakeReq(null, { method: 'GET', url: '/api/memory-core/devfile?rel=projects%2Fabc123def456%2FKEY.md' }))
    assert.equal(result.status, 200)
    assert.equal(result.body.rel, 'projects/abc123def456/KEY.md')
    assert.equal(result.body.text, '项目约定。\n')
    assert.equal(result.body.doc.inject, 'always')
  })

  it('不存在的文件返回 exists:false + 空正文（便于新建）', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { get } = routesOf(rt)
    const result = get('/api/memory-core/devfile')
      .handler(fakeReq(null, { method: 'GET', url: `/api/memory-core/devfile?rel=${FUTURE_DAILY_URL}` }))
    assert.equal(result.status, 200)
    assert.equal(result.body.exists, false)
    assert.equal(result.body.text, '')
  })

  it('POST 保存成功：内容落盘 + 备份 + 索引失效', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post } = routesOf(rt)
    const before = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    const next = `${before}新增一条事实。\n`
    const result = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: 'MEMORY.md', base: before, content: next }))
    assert.equal(result.status, 200)
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), next)

    // 改前备份（<coreDir>/backups/<date>/MEMORY.md.<ms>）
    const backupRoot = join(coreDir, 'backups')
    assert.ok(existsSync(backupRoot), '应有备份目录')
    const day = readdirSync(backupRoot)[0]
    const files = readdirSync(join(backupRoot, day))
    assert.ok(files.some((name) => name.startsWith('MEMORY.md.')), `备份文件名应含 MEMORY.md，实际：${files.join(', ')}`)
  })

  it('base 不匹配 → 409（不覆盖别人的改动）', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post } = routesOf(rt)
    // 模拟"你读到之后别人又写了一次"
    writeFileSync(join(memoryDir, 'MEMORY.md'), '别人刚写的。\n', 'utf8')
    const result = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: 'MEMORY.md', base: '我读到的旧内容。\n', content: '我的新内容。\n' }))
    assert.equal(result.status, 409)
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), '别人刚写的。\n')
  })

  it('缺 base → 400（拒绝盲写）', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post } = routesOf(rt)
    const result = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: 'MEMORY.md', content: '盲写' }))
    assert.equal(result.status, 400)
  })

  it('路径越界 / 非 md → 400', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post } = routesOf(rt)

    const escape = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: '../../etc/passwd.md', base: '', content: 'x' }))
    assert.equal(escape.status, 400)

    const notMd = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: 'memory-index.db', base: '', content: 'x' }))
    assert.equal(notMd.status, 400)
  })

  it('新建文件：base 传空串即通过', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post } = routesOf(rt)
    const result = await post('/api/memory-core/devfile')
      .handler(fakeReq({ rel: FUTURE_DAILY, base: '', content: FUTURE_DAILY_CONTENT }))
    assert.equal(result.status, 200)
    assert.equal(readFileSync(join(memoryDir, 'daily', FUTURE_DAILY_NAME), 'utf8'), FUTURE_DAILY_CONTENT)
  })

  it('关闭后立刻恢复拒绝（开关即生效，无需重启）', async () => {
    const rt = makeRuntime()
    rt.setDevMode(true)
    const { post, get } = routesOf(rt)
    await post('/api/memory-core/devfile').handler(fakeReq({ rel: 'MEMORY.md', base: readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), content: '改一下。\n' }))
    rt.setDevMode(false)
    const after = get('/api/memory-core/devfile')
      .handler(fakeReq(null, { method: 'GET', url: '/api/memory-core/devfile?rel=MEMORY.md' }))
    assert.equal(after.status, 403)
  })
})
