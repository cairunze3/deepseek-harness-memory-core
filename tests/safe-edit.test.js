/**
 * "改得安全"三件套 + 管理接口的回归测试（v0.3.5）。
 *
 * 用户故事：旧插件走了，记忆 Tab 也没了。现在要能**直接编辑记忆**，但不能因此
 * 把记忆改坏、也不能和 agent 的写入互相覆盖。于是三件事：
 *
 *  1. **格式体检**（lib/validate.js）：手改最常见的破坏是漏 `§`（两条并成一条）；
 *  2. **乐观并发**：保存时带"我载入的那份正文"，被别人改过就 409，而不是覆盖；
 *  3. **逐条修订**（lib/revisions.js）：谁在什么时候把哪条从什么改成什么。
 *
 * 另外验一下管理接口的路由表（用假 req/res 驱动，不需要真起服务）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { validateMemoryText, validateFiles } from '../lib/validate.js'
import { readRevisions, recordRevision, previewOf, REVISIONS_FILE } from '../lib/revisions.js'
import { buildRoutes, parsePointer } from '../lib/api.js'
import { createRuntime } from '../lib/runtime.js'
import { resolveConfig } from '../lib/config.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-safe-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

function write(rel, text) {
  const full = join(memoryDir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

// ─────────────────────────────────────────────────────────────────────────────
describe('① 格式体检：把"改坏了"变成可发现', () => {
  it('正常文件无问题', () => {
    const result = validateMemoryText('[2026-01-01 09:00] 一条正常记忆。\n§\n[2026-01-02 09:00] 另一条。\n')
    assert.equal(result.ok, true)
    assert.equal(result.issues.length, 0)
    assert.equal(result.entries, 2)
  })

  it('多条时间戳但没有 § → error（否则会被并成一条）', () => {
    const result = validateMemoryText('[2026-01-01 09:00] 甲。\n[2026-01-02 09:00] 乙。\n')
    assert.equal(result.ok, false)
    const issue = result.issues.find((item) => item.code === 'broken-delimiter')
    assert.ok(issue, '应报 broken-delimiter')
    assert.equal(issue.level, 'error')
    assert.match(issue.message, /一条/)
    assert.ok(issue.fix, '应给出修法')
  })

  it('标签未闭合 / 空条目 / 首尾多余 § 都能识别', () => {
    const unclosed = validateMemoryText('[summary:没闭合\n[2026-01-01 09:00] 内容。')
    assert.ok(unclosed.issues.some((item) => item.code === 'unclosed-tag'))
    const empty = validateMemoryText('甲\n§\n\n§\n乙')
    assert.ok(empty.issues.some((item) => item.code === 'empty-entry'))
    const leading = validateMemoryText('§\n[2026-01-01 09:00] 内容。')
    assert.ok(leading.issues.some((item) => item.code === 'leading-delimiter'))
  })

  // 回归（2026-11-02 记忆插件 A/B 测试实测损坏形态）：
  // 上一条正文与下一条摘要被粘成一行（`…信息）[summary:…]`），说明两条记忆被并成一条。
  it('行内标签（正文与下一条摘要粘连）→ error', () => {
    const glued = validateMemoryText(
      '[2026-11-02 10:00] A 的正文（补充原有信息）[summary:B 的摘要]\n[2026-11-02 11:00] B 的正文\n')
    const issue = glued.issues.find((item) => item.code === 'inline-tag')
    assert.ok(issue, '应报 inline-tag')
    assert.equal(issue.level, 'error')
    assert.ok(issue.fix, '应给出修法')
  })

  it('行首标签是正常写法，不误报 inline-tag', () => {
    const result = validateMemoryText('[summary:摘要]\n[2026-11-02 10:00] 正文\n§\n[2026-11-02 11:00] 另一条\n')
    assert.ok(!result.issues.some((item) => item.code === 'inline-tag'))
  })

  it('时间戳与标签同行是合法写法，不误报 inline-tag', () => {
    // 第一版修复脚本把这种形式也拆了一行（实测把 MEMORY.md 拆坏），回归守住。
    const result = validateMemoryText('[2026-11-02 14:48] [summary:同行摘要]\n正文\n')
    assert.ok(!result.issues.some((item) => item.code === 'inline-tag'))
  })

  it('重复 id 报警（跨设备合并会指向错条目）', () => {
    const result = validateMemoryText('[id:abc] 甲\n§\n[id:abc] 乙')
    const issue = result.issues.find((item) => item.code === 'duplicate-id')
    assert.ok(issue)
    assert.equal(issue.level, 'warn')
  })

  it('批量体检只返回有问题的文件', () => {
    const result = validateFiles([
      { rel: 'ok.md', text: '[2026-01-01 09:00] 好。' },
      { rel: 'bad.md', text: '[2026-01-01 09:00] 甲。\n[2026-01-02 09:00] 乙。' },
    ])
    assert.equal(result.checked, 2)
    assert.equal(result.problems.length, 1)
    assert.equal(result.problems[0].rel, 'bad.md')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('③ 修订历史：谁把哪条从什么改成什么', () => {
  it('记一条修订，含哈希与摘录（不存全文）', () => {
    const result = recordRevision({ coreDir, rel: 'MEMORY.md', pointer: 'MEMORY.md#0', before: '旧内容', after: '新内容', source: 'gui' })
    assert.equal(result.ok, true)
    const rows = readRevisions({ coreDir })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].pointer, 'MEMORY.md#0')
    assert.equal(rows[0].source, 'gui')
    assert.notEqual(rows[0].beforeHash, rows[0].afterHash)
    assert.equal(rows[0].beforePreview, '旧内容')
    // 不存全文：整条记录里不该出现"超长原文"
    assert.ok(!JSON.stringify(rows[0]).includes('x'.repeat(500)))
  })

  it('新的在前，可按 limit 截断', () => {
    for (let i = 0; i < 5; i += 1) {
      recordRevision({ coreDir, rel: 'M.md', pointer: `M.md#${i}`, before: `${i}`, after: `${i + 1}`, now: Date.now() + i })
    }
    const rows = readRevisions({ coreDir, limit: 3 })
    assert.equal(rows.length, 3)
    assert.equal(rows[0].pointer, 'M.md#4', '最近的在前')
  })

  it('记不上也不该抛（观测不能影响业务）', () => {
    const result = recordRevision({ coreDir: join(coreDir, 'nope', '\u0000bad'), rel: 'x', before: 'a', after: 'b' })
    assert.equal(result.ok, false)
    assert.ok(typeof result.error === 'string')
  })

  it('previewOf 压平空白并截断', () => {
    assert.equal(previewOf('  a\n\n b  '), 'a b')
    assert.ok(previewOf('x'.repeat(500)).length <= 161)
  })

  it('日志落在派生物目录（不动记忆正本）', () => {
    recordRevision({ coreDir, rel: 'M.md', before: 'a', after: 'b' })
    const file = join(coreDir, REVISIONS_FILE)
    assert.ok(readFileSync(file, 'utf8').includes('"source"'))
    assert.ok(!file.startsWith(memoryDir))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('② 乐观并发 + 管理接口（假 req/res 驱动路由表）', () => {
  function runtimeOf() {
    // ⚠ 顺序很重要：先把默认配置铺开，再用本次测试的临时目录**覆盖**。
    // 反过来写（`{ memoryDir, coreDir, ...resolveConfig({}) }`）会让默认值赢，
    // 测试就跑到**真实记忆根**上去了（第一次写这组用例时就是这么错的：
    // 列表返回 73 条而不是 2 条）。
    return createRuntime({
      config: { ...resolveConfig({}), memoryDir, coreDir },
      logger: { info() {}, warn() {} },
    })
  }

  /** 造一个假的 req/res，跑一条路由。 */
  async function call(route, { method = route.method, url = route.path, body = null } = {}) {
    const req = {
      method,
      url,
      on(event, handler) {
        if (event === 'data' && body !== null) handler(Buffer.from(JSON.stringify(body), 'utf8'))
        if (event === 'end') handler()
        return req
      },
      destroy() {},
    }
    const res = { statusCode: 0, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value }, end(text) { this.body = text ?? '' } }
    const result = await route.handler(req, res)
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      return { status: result.status, payload: result.body }
    }
    return { status: res.statusCode || 200, payload: result ?? JSON.parse(res.body || '{}') }
  }

  const find = (routes, path, method) => routes.find((route) => route.path === path && route.method === method)

  it('parsePointer 只接受 rel#序号，且拒绝目录穿越', () => {
    assert.deepEqual(parsePointer('MEMORY.md#0'), { rel: 'MEMORY.md', ordinal: 0 })
    assert.equal(parsePointer('MEMORY.md'), null)
    assert.equal(parsePointer('MEMORY.md#x'), null)
    assert.equal(parsePointer('../etc/passwd#0'), null)
  })

  it('GET /entries 返回列表；GET /entry 返回全文与 hash', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲条内容。\n§\n[2026-01-02 09:00] 乙条内容。\n')
    const routes = buildRoutes(runtimeOf())
    const list = await call(find(routes, '/api/memory-core/entries', 'GET'))
    assert.equal(list.payload.ok, true)
    assert.equal(list.payload.rows.length, 2)
    assert.ok(list.payload.rows[0].pointer.includes('#'))

    const detail = await call(find(routes, '/api/memory-core/entry', 'GET'), { url: '/api/memory-core/entry?ptr=MEMORY.md%230' })
    assert.equal(detail.status, 200)
    assert.match(detail.payload.body, /甲条内容/)
    assert.ok(detail.payload.hash.length >= 8, '应给出 etag（正文哈希）')
  })

  it('保存：正常写入 + 记录修订 + 备份', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲条内容。\n')
    const routes = buildRoutes(runtimeOf())
    const detail = await call(find(routes, '/api/memory-core/entry', 'GET'), { url: '/api/memory-core/entry?ptr=MEMORY.md%230' })
    const saved = await call(find(routes, '/api/memory-core/entry', 'POST'), {
      body: { pointer: 'MEMORY.md#0', base: detail.payload.body, content: '[2026-01-01 09:00] 甲条内容（已改）。' },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.match(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), /已改/)
    assert.equal(readRevisions({ coreDir }).length, 1, '应留下修订记录')
  })

  it('保存：**base 与现状不符 → 409**，且文件不被覆盖（这就是乐观并发）', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲条内容。\n')
    const routes = buildRoutes(runtimeOf())
    const saved = await call(find(routes, '/api/memory-core/entry', 'POST'), {
      body: { pointer: 'MEMORY.md#0', base: '[2026-01-01 09:00] 别人刚改过的内容。', content: '[2026-01-01 09:00] 我的版本。' },
    })
    assert.equal(saved.status, 409, '冲突必须被拒绝')
    assert.equal(saved.payload.conflict, true)
    const onDisk = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    assert.match(onDisk, /甲条内容/, '原文件不能被覆盖')
    assert.ok(!onDisk.includes('我的版本'))
    assert.equal(readRevisions({ coreDir }).length, 0, '冲突不该留修订记录')
  })

  it('保存：空内容 / 坏指针 / 越界都被拒绝', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲。\n')
    const routes = buildRoutes(runtimeOf())
    const empty = await call(find(routes, '/api/memory-core/entry', 'POST'), { body: { pointer: 'MEMORY.md#0', base: 'x', content: '   ' } })
    assert.equal(empty.status, 400)
    const bad = await call(find(routes, '/api/memory-core/entry', 'POST'), { body: { pointer: 'nohash', base: 'x', content: 'y' } })
    assert.equal(bad.status, 400)
    const escape = await call(find(routes, '/api/memory-core/entry', 'POST'), { body: { pointer: '../x#0', base: 'x', content: 'y' } })
    assert.equal(escape.status, 400)
  })

  it('GET /state 报规模与预算；GET /validate 报结构问题', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲。\n[2026-01-01 10:00] 乙。\n') // 故意缺 §
    const runtime = runtimeOf()
    const routes = buildRoutes(runtime)
    const state = await call(find(routes, '/api/memory-core/state', 'GET'))
    assert.equal(state.payload.ok, true)
    assert.ok(state.payload.entries >= 1)
    assert.equal(state.payload.budget.indexTopN, resolveConfig({}).indexTopN)
    const check = await call(find(routes, '/api/memory-core/validate', 'GET'))
    assert.equal(check.payload.problems.length, 1)
    assert.equal(check.payload.problems[0].issues[0].code, 'broken-delimiter')
  })

  it('GET /overview 生成全局概览（分节 + 指针）；POST 保存为 OVERVIEW.md', async () => {
    write('USER.md', '[2026-01-01 09:00] 用户偏好结论先行。\n')
    write('MEMORY.md', '[2026-01-02 09:00] 约定：只用 mem_* 写记忆。\n')
    const runtime = runtimeOf()
    const routes = buildRoutes(runtime)

    const generated = await call(find(routes, '/api/memory-core/overview', 'GET'), { url: '/api/memory-core/overview?generate=1' })
    assert.equal(generated.payload.ok, true)
    assert.match(generated.payload.text, /用户（我是谁 \/ 偏好）/)
    assert.match(generated.payload.text, /约定与决策/)
    assert.match(generated.payload.text, /:: USER\.md#0/)
    assert.equal(generated.payload.exists, false, '还没落盘')

    const saved = await call(find(routes, '/api/memory-core/overview', 'POST'), {
      body: { base: '', content: generated.payload.text },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.payload))
    assert.ok(existsSync(join(memoryDir, 'OVERVIEW.md')), '应写成 OVERVIEW.md')
    assert.ok(saved.payload.pointers >= 1)

    const again = await call(find(routes, '/api/memory-core/overview', 'GET'), { url: '/api/memory-core/overview' })
    assert.equal(again.payload.exists, true)
    assert.match(String(again.payload.stamp), /^\d{4}-\d{2}-\d{2}$/)
  })

  it('POST /overview 带过期 base → 409（防覆盖别人刚重新生成的概览）', async () => {
    const runtime = runtimeOf()
    const routes = buildRoutes(runtime)
    await call(find(routes, '/api/memory-core/overview', 'POST'), { body: { base: '', content: '第一版概览\n' } })
    const conflict = await call(find(routes, '/api/memory-core/overview', 'POST'), { body: { base: '旧的概览', content: '我的新版\n' } })
    assert.equal(conflict.status, 409)
    assert.equal(readFileSync(join(memoryDir, 'OVERVIEW.md'), 'utf8').includes('第一版概览'), true, '原内容不能被覆盖')
  })

  it('POST /verify 清掉可疑标记', async () => {
    write('MEMORY.md', '[2026-01-01 09:00] 甲条内容。\n')
    const runtime = runtimeOf()
    const { markSuspect } = await import('../lib/suspect.js')
    markSuspect({ coreDir: runtime.coreDir, body: '[2026-01-01 09:00] 甲条内容。', reason: 'fragment' })
    runtime.invalidate()
    const routes = buildRoutes(runtime)
    const verified = await call(find(routes, '/api/memory-core/verify', 'POST'), { body: { pointer: 'MEMORY.md#0' } })
    assert.equal(verified.payload.ok, true)
    assert.equal(verified.payload.removed, true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('插件的界面装配：路由是否真的注册到 webServer', () => {
  /**
   * 这一组守的是一次真实的线上事故（2026-10-28）：
   * 客户端面板能打开，但每个请求都失败。日志里是
   *   "[memory-core] 本上下文没有 webServer 服务，管理界面不启用"
   * 根因：`ctx.get('webServer')` 在**裸 Context** 上能拿到服务，但在**插件上下文**里
   * 返回 undefined。而 `webServer` 又不能写进 `inject`（写成必需 → 没有它的上下文
   * 整个不装载，mount-probe 7/7 → 0/7；写成 `{required, optional}` → 本版 cordis 不认）。
   *
   * 结论：必须用 `ctx.inject(['webServer'], scope => …)` —— 等服务就绪的回调作用域。
   */
  function fakeCtx() {
    return {
      effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
      systemPrompt: { context() { return () => {} } },
      tools: { register() { return () => {} } },
    }
  }

  it('走 ctx.inject 时注册全部路由', async () => {
    const routes = []
    const ctx = fakeCtx()
    ctx.inject = (deps, callback) => callback({ webServer: { register(route) { routes.push(route); return () => {} } }, effect(fn) { return fn() } })
    const { apply } = await import('../lib/index.js')
    apply(ctx, { memoryDir, coreDir })
    // buildRoutes 共 17 个 method 级条目，其中 /switch /global /overview /entry /dev
    // /devfile 六组同路径 GET/POST 合并成一条 exact 路由 → 11 条路径（见 api.js 的实测教训注释）。
    assert.equal(routes.length, 11, `应注册 11 条路由，实际 ${routes.length}`)
    assert.ok(routes.every((route) => route.path.startsWith('/api/memory-core/')))
    assert.ok(routes.some((route) => route.path === '/api/memory-core/state' && route.kind === 'exact'))
  })

  it('没有 ctx.inject 时退回直接读取（有服务就注册）', async () => {
    const routes = []
    const ctx = fakeCtx()
    ctx.get = (name) => (name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : undefined)
    const { apply } = await import('../lib/index.js')
    apply(ctx, { memoryDir, coreDir })
    assert.equal(routes.length, 11)
  })

  it('服务始终不出现时安静跳过（不抛、不影响装载）', async () => {
    const ctx = fakeCtx()
    ctx.inject = (deps, callback) => callback({ webServer: undefined, effect(fn) { return fn() } })
    const { apply } = await import('../lib/index.js')
    assert.doesNotThrow(() => apply(ctx, { memoryDir, coreDir }))
  })

  it('uiEnabled=false 时完全不注册', async () => {
    const routes = []
    const ctx = fakeCtx()
    ctx.inject = (deps, callback) => callback({ webServer: { register(route) { routes.push(route); return () => {} } }, effect(fn) { return fn() } })
    const { apply } = await import('../lib/index.js')
    apply(ctx, { memoryDir, coreDir, uiEnabled: false })
    assert.equal(routes.length, 0)
  })
})