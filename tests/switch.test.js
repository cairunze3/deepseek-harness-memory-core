/**
 * 运行时总开关（v0.4.2，设置页「启用记忆」）的回归测试。
 *
 * 守四条性质：
 *  1. 缺文件 = 启用（既有部署零迁移）；
 *  2. 停用后：注入渲染返回 ''（零预算、不记账），mem_* 工具调用期拒绝；
 *  3. 开关是**全机共享**的：第二个 runtime（模拟另一进程/上下文）能看到切换；
 *  4. 开关文件损坏/删掉 → 按启用处理（开关坏掉不能把记忆锁死）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { Readable } from 'node:stream'

import { createRuntime } from '../lib/runtime.js'
import { renderSnapshotFor } from '../lib/index.js'
import { buildTools } from '../lib/tools.js'
import { buildRoutes, registerRoutes } from '../lib/api.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-switch-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

/** 造一个带两条记忆的运行时（daily 一条，方便断言注入非空）。 */
function makeRuntime() {
  mkdirSync(join(memoryDir, 'daily'), { recursive: true })
  writeFileSync(join(memoryDir, 'daily', '2026-11-02.md'), '[2026-11-02 10:00] 上午：验证开关。\n')
  return createRuntime({ config: { memoryDir, coreDir }, logger: quietLogger() })
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} }
}

describe('开关默认与切换', () => {
  it('缺文件 = 启用（enabled() 为 true）', () => {
    const rt = makeRuntime()
    assert.equal(rt.enabled(), true)
  })

  it('setEnabled(false) 落盘且本运行时立刻可见', () => {
    const rt = makeRuntime()
    assert.equal(rt.setEnabled(false), false)
    assert.equal(rt.enabled(), false)
    const raw = JSON.parse(readFileSync(join(coreDir, 'switch.json'), 'utf8'))
    assert.equal(raw.enabled, false)
    assert.equal(rt.setEnabled(true), true)
    assert.equal(rt.enabled(), true)
  })

  it('开关文件损坏 → 按启用处理', () => {
    const rt = makeRuntime()
    writeFileSync(join(coreDir, 'switch.json'), 'not-json{', 'utf8')
    assert.equal(rt.enabled(), true)
  })

  it('另一个 runtime（另一进程语义）能看到切换', () => {
    const a = makeRuntime()
    const b = createRuntime({ config: { memoryDir, coreDir }, logger: quietLogger() })
    assert.equal(a.setEnabled(false), false)
    assert.equal(b.enabled(), false, '跨 runtime 应通过 mtime 重读看到停用')
    assert.equal(a.setEnabled(true), true)
    assert.equal(b.enabled(), true)
  })
})

describe('停用对注入与工具的效应', () => {
  it('停用时 renderSnapshotFor 返回空串，且不累积轮次计数', () => {
    const rt = makeRuntime()
    rt.setEnabled(false)
    const text = renderSnapshotFor(rt, {})
    assert.equal(text, '')
    // 停用期间不该记账：轮次计数仍是 0
    assert.equal(rt.counters().turns.__default__ ?? 0, 0)
    // 重新启用后恢复注入
    rt.setEnabled(true)
    assert.notEqual(renderSnapshotFor(rt, {}), '')
  })

  it('停用时 mem_* 工具调用期拒绝（返回停用说明，不碰文件）', async () => {
    const rt = makeRuntime()
    rt.setEnabled(false)
    const before = readFileSync(join(memoryDir, 'daily', '2026-11-02.md'), 'utf8')
    const tools = buildTools(rt)
    const search = tools.find((tool) => tool.name === 'mem_search')
    const reply = await search.execute({ query: '开关' }, {})
    assert.match(String(reply), /已在设置中停用/)
    assert.equal(readFileSync(join(memoryDir, 'daily', '2026-11-02.md'), 'utf8'), before, '停用期间文件不得被改动')
  })
})

describe('开关的 HTTP 接口', () => {
  it('GET /switch 读状态；POST /switch 写状态并生效', async () => {
    const rt = makeRuntime()
    const routes = buildRoutes(rt)
    const get = routes.find((route) => route.method === 'GET' && route.path === '/api/memory-core/switch')
    const post = routes.find((route) => route.method === 'POST' && route.path === '/api/memory-core/switch')

    const state = get.handler()
    assert.equal(state.ok, true)
    assert.equal(state.enabled, true)

    const saved = await post.handler(fakeReq({ enabled: false }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.enabled, false)
    assert.equal(rt.enabled(), false)

    // 非法载荷
    const bad = await post.handler(fakeReq({ enabled: 'yes' }))
    assert.equal(bad.status, 400)
  })

  it('/state 的返回里带 enabled', () => {
    const rt = makeRuntime()
    rt.setEnabled(false)
    const routes = buildRoutes(rt)
    const state = routes.find((route) => route.path === '/api/memory-core/state').handler()
    assert.equal(state.enabled, false)
  })
})

/** 假请求对象：只提供 api.js 的 readJsonBody 需要的事件流。 */
function fakeReq(payload, method = 'POST') {
  const body = JSON.stringify(payload)
  // 真实 http.IncomingMessage 的 'data' 事件推的是 Buffer；推字符串会让
  // readJsonBody 的 Buffer.concat 抛 TypeError（被 saveSwitch 捕获成 400）。
  const req = Readable.from(method === 'GET' || method === 'HEAD' ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  return req
}

/** 假响应对象：收集状态码与响应体。 */
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.setHeader = (key, value) => { res.headers[key] = value }
  res.end = (text) => { res.body = String(text ?? ''); return res }
  return res
}

describe('注册：同路径 GET/POST 必须合并成一个 exact 路由', () => {
  /**
   * 2026-11-02 实测教训：宿主的 exact 路由表按路径判重（不含方法），GET 与
   * POST 分开注册会在第二条抛 duplicate exact route 并连坐中断后续所有注册。
   * 这组用例守的是：注册出来的路径不重复，且合并后的 handler 按方法分发。
   */
  function registerAll(rt) {
    const registrations = []
    const webServer = { register: ({ path, handler }) => { registrations.push({ path, handler }); return () => {} } }
    const effect = (fn) => { fn(); return () => {} }
    const count = registerRoutes(rt, webServer, effect)
    return { count, registrations }
  }

  it('注册的路径无重复（同路径 GET/POST 只注册一次）', () => {
    const rt = makeRuntime()
    const { count, registrations } = registerAll(rt)
    const paths = registrations.map((item) => item.path)
    assert.equal(new Set(paths).size, paths.length, `路径必须唯一，实际：${paths.join(', ')}`)
    assert.equal(count, paths.length)
  })

  it('合并后的 handler 按方法分发：GET 读开关、POST 写开关', async () => {
    const rt = makeRuntime()
    const { registrations } = registerAll(rt)
    const route = registrations.find((item) => item.path === '/api/memory-core/switch')
    assert.notEqual(route, null, '应有 /switch 路由')

    const getRes = fakeRes()
    await route.handler(fakeReq(null, 'GET'), getRes)
    assert.equal(getRes.statusCode, 200)
    assert.equal(JSON.parse(getRes.body).enabled, true)

    const postRes = fakeRes()
    await route.handler(fakeReq({ enabled: false }), postRes)
    assert.equal(postRes.statusCode, 200)
    assert.equal(JSON.parse(postRes.body).enabled, false)
    assert.equal(rt.enabled(), false)

    rt.setEnabled(true)
  })

  it('不支持的方法返回 405', async () => {
    const rt = makeRuntime()
    const { registrations } = registerAll(rt)
    const route = registrations.find((item) => item.path === '/api/memory-core/switch')
    const res = fakeRes()
    await route.handler(fakeReq(null, 'PUT'), res)
    assert.equal(res.statusCode, 405)
  })
})
