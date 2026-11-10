/**
 * 槽位式全局记忆（`GLOBAL.md`）的回归测试（v0.4.0）。
 *
 * 用户故事：条目列表太臃肿，想要**一页**看完的记忆。方案不是"再列一遍"，而是
 * **槽位模型**：槽间叠加、槽内重写、槽数封顶。这组用例守的就是这三条性质，
 * 以及"合并不会把用户手改的内容冲掉"。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import {
  GLOBAL_REL, MAX_SLOTS, MAX_SLOT_CHARS,
  applyOps, clipValue, describeDiff, diffSlots, parseSlots, renderSlots, slotsChars,
} from '../lib/global.js'
import { buildRoutes } from '../lib/api.js'
import { createRuntime } from '../lib/runtime.js'
import { resolveConfig } from '../lib/config.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-global-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

const sample = renderSlots([
  { name: '身份', value: '蔡润泽，深圳，简体中文。' },
  { name: '投资风格', value: 'A股基本面+催化剂；逆向抄底、分批建仓。' },
])

describe('槽位解析与渲染', () => {
  it('parseSlots 按 ## 切槽，忽略注释与一级标题', () => {
    const slots = parseSlots(sample)
    assert.equal(slots.length, 2)
    assert.equal(slots[0].name, '身份')
    assert.match(slots[0].value, /蔡润泽/)
    assert.equal(slots[1].name, '投资风格')
  })

  it('渲染 → 解析 往返稳定（可 diff）', () => {
    const once = renderSlots(parseSlots(sample))
    const twice = renderSlots(parseSlots(once))
    assert.equal(once, twice)
  })

  it('多行正文会被压成一句话', () => {
    const slots = parseSlots('## 身份\n第一行\n第二行\n')
    assert.equal(slots[0].value, '第一行 第二行')
  })
})

describe('槽内重写、槽间叠加', () => {
  it('set 已存在的槽 → 只有那个槽变，别的槽逐字不动', () => {
    const before = parseSlots(sample)
    const { slots, changes } = applyOps(before, [{ op: 'set', name: '投资风格', value: '改为：只做红利高股息。' }])
    assert.equal(changes.length, 1)
    assert.equal(changes[0].op, 'set')
    assert.equal(slots.find((s) => s.name === '身份').value, before[0].value, '身份槽必须原封不动')
    assert.equal(slots.find((s) => s.name === '投资风格').value, '改为：只做红利高股息。')
  })

  it('set 不存在的槽 → 新增（在末尾）', () => {
    const { slots, changes } = applyOps(parseSlots(sample), [{ op: 'set', name: '近期计划', value: '济州岛' }])
    assert.equal(changes[0].op, 'add')
    assert.equal(slots.length, 3)
    assert.equal(slots[2].name, '近期计划')
  })

  it('del 删除槽；删不存在的报 not-found 但不炸', () => {
    const { slots, changes } = applyOps(parseSlots(sample), [{ op: 'del', name: '身份' }, { op: 'del', name: '不存在' }])
    assert.equal(slots.length, 1)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].op, 'del')
  })

  it('超出槽上限 → 拒绝（这就是"不膨胀"的硬约束）', () => {
    const full = Array.from({ length: MAX_SLOTS }, (_, i) => ({ name: `槽${i}`, value: 'x' }))
    const { rejected, slots } = applyOps(full, [{ op: 'set', name: '新槽', value: 'y' }])
    assert.equal(slots.length, MAX_SLOTS)
    assert.equal(rejected[0].reason, 'full')
  })

  it('单槽超长会被截断（一个槽不写小作文）', () => {
    const long = 'X'.repeat(MAX_SLOT_CHARS + 40)
    assert.equal(clipValue(long).length, MAX_SLOT_CHARS)
    const { slots } = applyOps([], [{ op: 'set', name: '身份', value: long }])
    assert.equal(slots[0].value.length, MAX_SLOT_CHARS)
  })

  it('值相同 → 不产生变更（避免无意义的写入与修订记录）', () => {
    const before = parseSlots(sample)
    const { changes } = applyOps(before, [{ op: 'set', name: '身份', value: before[0].value }])
    assert.equal(changes.length, 0)
  })

  it('diffSlots / describeDiff 用来说清"改了什么"', () => {
    const before = parseSlots(sample)
    const after = applyOps(before, [{ op: 'set', name: '新增项', value: 'v' }, { op: 'del', name: '身份' }]).slots
    const diff = diffSlots(before, after)
    assert.deepEqual(diff.added, ['新增项'])
    assert.deepEqual(diff.removed, ['身份'])
    const text = describeDiff(diff)
    assert.match(text, /新增 1 槽/)
    assert.match(text, /删除 1 槽/)
  })

  it('体量是可控的（8 槽 ≈ 几百字符，不是几千）', () => {
    const slots = Array.from({ length: MAX_SLOTS }, (_, i) => ({ name: `槽${i}`, value: '一句四十字左右的内容，用来估算总体量是否一屏装得下。' }))
    assert.ok(slotsChars(slots) < 700, `实际 ${slotsChars(slots)}`)
  })
})

describe('接口：读 / 手改 / 槽位合并', () => {
  function runtimeOf() {
    return createRuntime({ config: { ...resolveConfig({}), memoryDir, coreDir }, logger: { info() {}, warn() {} } })
  }
  async function call(route, { method = route.method, url = route.path, body = null } = {}) {
    const req = {
      method, url,
      on(event, handler) {
        if (event === 'data' && body !== null) handler(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') handler()
        return req
      },
      destroy() {},
    }
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(t) { this.body = t ?? '' } }
    const result = await route.handler(req, res)
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) return { status: result.status, payload: result.body }
    return { status: res.statusCode || 200, payload: result ?? {} }
  }
  const find = (routes, path, method) => routes.find((r) => r.path === path && r.method === method)

  /** 读现状（2026-11-04 起 GLOBAL.md 默认预建，手改的 base 必须取自这里）。 */
  async function readGlobal(routes) {
    return (await call(find(routes, '/api/memory-core/global', 'GET'))).payload
  }

  it('预建的 GLOBAL.md 只有说明、没有槽（说明注释不算槽）', async () => {
    const routes = buildRoutes(runtimeOf())
    const state = await readGlobal(routes)
    assert.equal(state.ok, true)
    assert.equal(state.exists, true, '默认预建（precreateFiles 默认开）')
    assert.deepEqual(state.slots, [], '文件头说明与 `# 记忆` 都不算槽')
    assert.match(state.text, /<!--/, '预建文件带功能说明注释')
  })

  it('POST content 手改 → 落盘 GLOBAL.md + 记修订', async () => {
    const routes = buildRoutes(runtimeOf())
    const base = (await readGlobal(routes)).text
    const saved = await call(find(routes, '/api/memory-core/global', 'POST'), { body: { base, content: sample } })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.equal(saved.payload.slots, 2)
    assert.match(readFileSync(join(memoryDir, GLOBAL_REL), 'utf8'), /蔡润泽/)
  })

  it('POST ops 合并 → 只动指定的槽', async () => {
    const routes = buildRoutes(runtimeOf())
    await call(find(routes, '/api/memory-core/global', 'POST'), { body: { base: (await readGlobal(routes)).text, content: sample } })
    const merged = await call(find(routes, '/api/memory-core/global', 'POST'), {
      body: { base: null, ops: [{ op: 'set', name: '当前持仓', value: '空仓约 1 万' }] },
    })
    assert.equal(merged.status, 200)
    assert.equal(merged.payload.changes.length, 1)
    assert.equal(merged.payload.slots, 3)
    const text = readFileSync(join(memoryDir, GLOBAL_REL), 'utf8')
    assert.match(text, /蔡润泽/, '原有槽必须还在')
    assert.match(text, /空仓约 1 万/)
  })

  it('base 过期 → 409，且文件不被覆盖（保住用户手改）', async () => {
    const routes = buildRoutes(runtimeOf())
    await call(find(routes, '/api/memory-core/global', 'POST'), { body: { base: (await readGlobal(routes)).text, content: sample } })
    const conflict = await call(find(routes, '/api/memory-core/global', 'POST'), { body: { base: '过期的旧内容', content: '我的新版' } })
    assert.equal(conflict.status, 409)
    assert.match(readFileSync(join(memoryDir, GLOBAL_REL), 'utf8'), /蔡润泽/, '原内容不能被冲掉')
  })

  it('ops 与现状一致 → changed:false（不写盘、不留无意义修订）', async () => {
    const routes = buildRoutes(runtimeOf())
    await call(find(routes, '/api/memory-core/global', 'POST'), { body: { base: (await readGlobal(routes)).text, content: sample } })
    const noop = await call(find(routes, '/api/memory-core/global', 'POST'), {
      body: { base: null, ops: [{ op: 'set', name: '身份', value: '蔡润泽，深圳，简体中文。' }] },
    })
    assert.equal(noop.payload.changed, false)
  })
})

describe('注入：global 轨排在最前', () => {
  it('轨道顺序与权重都把它放第一', async () => {
    const { TRACK_ORDER } = await import('../lib/inject.js')
    const { TRACK_WEIGHT } = await import('../lib/retrieve.js')
    assert.equal(TRACK_ORDER[0], 'global')
    assert.equal(TRACK_WEIGHT.global, 1)
    assert.ok(TRACK_WEIGHT.global >= TRACK_WEIGHT.daily)
  })
})