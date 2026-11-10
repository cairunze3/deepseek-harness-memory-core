/**
 * 「先流水、后结论」两段式写入（v0.6.2）。
 *
 * 这组测试守的是**行为契约**，不是文案：本机账本 11-03~11-04 是
 * `extract→queue ×8 / add→key ×1 / add→daily ×0`，根 `daily/` 断档 7 天——
 * 结论都在、流水全丢。原因是 v0.5.x 的写入纪律只说"落正轨"，而模型把"正轨"
 * 读成 KEY/MEMORY 这类结论轨，于是流水轨被整条跳过。
 *
 * 所以这里同时验证三件事：
 *   1. 提示词在两种注入模式（索引 / 按需检索）里都说"先 daily 再结论"，且文本同源；
 *   2. `dailyFirstWrite=false` 能干净回退（可回退是能被信任的前提）；
 *   3. 工具面确实支持这条路径：daily 免 confirm、落到当天文件、项目内落项目目录，
 *      并且 key 仍然需要 confirm（两段的门槛不同才叫"两段"）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { apply } from '../lib/index.js'
import { renderIndexSnapshot, renderPointerBlock, renderWriteRules } from '../lib/inject.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-dailyfirst-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
let projectCwd
let projectId

beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
  projectCwd = mkdtempSync(join(sandbox, 'proj-'))
  projectId = 'p1'
  mkdirSync(join(memoryDir, 'projects', projectId), { recursive: true })
})

const today = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fakeCtx() {
  const state = { contexts: [], tools: [], effects: 0 }
  return {
    state,
    systemPrompt: { context(definition) { state.contexts.push(definition); return () => {} } },
    tools: { register(definition) { state.tools.push(definition); return () => {} } },
    effect(callback) { state.effects += 1; return callback() },
    on() { return () => {} },
    get() { return undefined },
  }
}

function setup(config) {
  const ctx = fakeCtx()
  const { runtime } = apply(ctx, { memoryDir, coreDir, ...config })
  const byName = (toolName) => ctx.state.tools.find((t) => t.name === toolName)
  const exec = { agent: { session: { header: { cwd: projectCwd } } } }
  return { runtime, byName, exec, ctx }
}

const oneEntry = () => ([{
  entryId: 'e1', track: 'memory', scope: 'global', rel: 'MEMORY.md', body: '端口 8080',
  summary: '端口', stamp: '2026-11-04 09:00', date: '2026-11-04', mtime: Date.now(),
  importance: 'normal', type: 'fact',
}])

describe('提示词：两段式写入', () => {
  it('默认开启：索引模式里先 daily 流水、再结论', () => {
    const { text } = renderIndexSnapshot({ entries: oneEntry(), config: {}, now: Date.now() })
    assert.match(text, /先流水后结论/)
    assert.match(text, /track="daily"/, '没给出 daily 的具体调用形状')
    assert.match(text, /免 ?confirm/, '没说 daily 免确认（否则模型会以为要用户点头）')
    assert.match(text, /别跳过它只写结论/, '没点名"只写结论"这个具体失败模式')
    // 第二段仍在：结论要写长轨、且门槛更高
    assert.match(text, /track="key"/)
    assert.match(text, /track="memory"/)
    assert.match(text, /confirm=true/)
  })

  it('按需检索模式也带同一段（两种模式不许漂移）', () => {
    const pointer = renderPointerBlock({ entries: oneEntry(), config: {} })
    const index = renderIndexSnapshot({ entries: oneEntry(), config: {}, now: Date.now() }).text
    for (const line of renderWriteRules({})) {
      assert.ok(pointer.includes(line), `pointer 模式缺这行：${line.slice(0, 30)}…`)
      assert.ok(index.includes(line), `index 模式缺这行：${line.slice(0, 30)}…`)
    }
  })

  it('dailyFirstWrite=false 干净回退：不提流水，但仍讲落正轨与队列', () => {
    const rules = renderWriteRules({ dailyFirstWrite: false })
    const text = rules.join('\n')
    assert.ok(!/track="daily"/.test(text), '关掉后仍出现 daily 指令')
    assert.match(text, /mem_write\(confirm=true, source="user-stated"\)/)
    assert.match(text, /待巩固队列/)
  })

  it('writeDiscipline=false 时整段消失（两段式不会自己冒出来）', () => {
    assert.deepEqual(renderWriteRules({ writeDiscipline: false }), [])
    assert.deepEqual(renderWriteRules({ writeDiscipline: false, dailyFirstWrite: true }), [])
    const { text } = renderIndexSnapshot({ entries: oneEntry(), config: { writeDiscipline: false }, now: Date.now() })
    assert.equal(/写入纪律|先流水后结论/.test(text), false)
  })

  it('加了这一段仍不越预算（24 行 / 2000 字符）', () => {
    const config = { indexMaxLines: 24, indexMaxChars: 2000 }
    const r = renderIndexSnapshot({ entries: [], config, now: Date.now() })
    assert.ok(r.lines <= config.indexMaxLines, `lines=${r.lines}`)
    assert.ok(r.chars <= config.indexMaxChars, `chars=${r.chars}`)
  })

  it('文本只取决于配置，不随状态变化（prefix 缓存友好的前提）', () => {
    assert.deepEqual(renderWriteRules({}), renderWriteRules({}))
    const a = renderIndexSnapshot({ entries: [], config: {}, now: Date.now() }).text
    const b = renderIndexSnapshot({ entries: oneEntry(), config: {}, now: Date.now() }).text
    for (const line of renderWriteRules({})) {
      assert.ok(a.includes(line) && b.includes(line), '纪律行应与条目状态无关')
    }
  })
})

describe('工具面：这条路径真的走得通', () => {
  it('mem_write 的工具描述里写清了两段顺序（模型读的是这里）', () => {
    const { byName } = setup()
    const desc = byName('mem_write').description
    assert.match(desc, /先流水后结论|先追加一条/)
    assert.match(desc, /daily/)
    const trackDoc = byName('mem_write').parameters.properties.track.description
    assert.match(trackDoc, /免 ?confirm/, 'track 参数说明没交代 daily 免确认')
  })

  it('daily 免 confirm：直接落 daily/<今天>.md', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_write').execute({
      action: 'add', track: 'daily', scope: 'global',
      content: '排查了 X，排除网络问题，疑似缓存。',
    }, exec)
    assert.match(out, /已写入 daily\//, out)
    const file = join(memoryDir, 'daily', `${today()}.md`)
    assert.ok(existsSync(file), '没落盘到当天的 daily')
    assert.match(readFileSync(file, 'utf8'), /排除网络问题/)
  })

  it('项目内 daily 落 projects/<id>/daily/<今天>.md（scope=project）', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_write').execute({
      action: 'add', track: 'daily', scope: 'project',
      content: '改了检索排序，验证通过。',
    }, exec)
    assert.match(out, /已写入 projects\//, out)
    const file = join(memoryDir, 'projects', projectId, 'daily', `${today()}.md`)
    assert.ok(existsSync(file), '项目内 daily 没落进项目目录')
  })

  it('结论轨仍然要 confirm（两段的门槛必须不同）', async () => {
    const { byName, exec } = setup()
    const refused = await byName('mem_write').execute({
      action: 'add', track: 'key', scope: 'project', content: '结论：走 BM25。',
    }, exec)
    assert.match(refused, /confirm=true/, '结论轨不该免确认')
    const ok = await byName('mem_write').execute({
      action: 'add', track: 'key', scope: 'project', content: '结论：走 BM25。', confirm: true,
    }, exec)
    assert.match(ok, /已写入 projects\//, ok)
  })

  it('一轮完整的两段写入：流水 + 结论都在，且都能被扫描到', async () => {
    const { runtime, byName, exec } = setup()
    const write = byName('mem_write')
    await write.execute({ action: 'add', track: 'daily', scope: 'project', content: '试了 A 方案，慢；试了 B，快 3 倍。' }, exec)
    await write.execute({ action: 'add', track: 'key', scope: 'project', content: '结论：用 B 方案（索引预排序）。', confirm: true }, exec)

    const entries = runtime.getSnapshot({ cwd: projectCwd, force: true }).entries
    const daily = entries.filter((e) => e.track === 'daily')
    const key = entries.filter((e) => e.track === 'key')
    assert.equal(daily.length, 1, '流水没进索引')
    assert.equal(key.length, 1, '结论没进索引')
    assert.match(daily[0].body, /试了 A 方案/)
    // 流水留在日志轨、结论留在 KEY：不能出现"结论写进 daily"或反之
    assert.match(key[0].rel, /KEY\.md$/)
    assert.match(daily[0].rel, /daily\//)
  })

  it('daily 写入进账本（可审计：事后能查"哪天有没有流水"）', async () => {
    const { runtime, byName, exec } = setup()
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '一条流水。' }, exec)
    const writes = runtime.ledger.tail({ limit: 20 }).filter((r) => r.k === 'write' && r.track === 'daily')
    assert.equal(writes.length, 1, '账本里没有 daily 写入记录')
    assert.match(String(writes[0].rel), /^daily\//)
  })
})

describe('确定性兜底：跳过流水时当场提醒（不靠提示词的概率）', () => {
  it('先写结论、当天没流水 → 工具返回值点名缺口', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_write').execute({
      action: 'add', track: 'key', scope: 'project', content: '结论：走 B 方案。', confirm: true,
    }, exec)
    assert.match(out, /今天还没有 daily 流水/, out)
    assert.match(out, /track="daily"/, '提醒里没给出可照抄的调用形状')
  })

  it('当天已有流水 → 不再提醒（稳态零成本）', async () => {
    const { byName, exec } = setup()
    const write = byName('mem_write')
    await write.execute({ action: 'add', track: 'daily', scope: 'project', content: '试了 B，快 3 倍。' }, exec)
    const out = await write.execute({ action: 'add', track: 'key', scope: 'project', content: '结论：走 B 方案。', confirm: true }, exec)
    assert.equal(/今天还没有 daily 流水/.test(out), false, out)
  })

  it('写流水本身不会被提醒（否则每次写日志都多一行噪音）', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '一条流水。' }, exec)
    assert.equal(/今天还没有 daily 流水/.test(out), false, out)
  })

  it('dailyFirstWrite=false → 不提醒（与提示词同步回退）', async () => {
    const { byName, exec } = setup({ dailyFirstWrite: false })
    const out = await byName('mem_write').execute({
      action: 'add', track: 'key', scope: 'project', content: '结论：走 B 方案。', confirm: true,
    }, exec)
    assert.equal(/今天还没有 daily 流水/.test(out), false, out)
  })
})

describe('预建文件与两段式不冲突', () => {
  it('预建的 daily 文件带说明、但没有假条目（写入前后都是 0/1 条）', async () => {
    const { runtime, byName, exec } = setup()
    const file = join(memoryDir, 'daily', `${today()}.md`)
    assert.ok(existsSync(file), '今天的 daily 应被预建')
    const before = runtime.getSnapshot({ cwd: projectCwd, force: true }).entries.filter((e) => e.track === 'daily')
    assert.equal(before.length, 0, '预建的 daily 不该产生条目')
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '第一条真流水。' }, exec)
    const afterEntries = runtime.getSnapshot({ cwd: projectCwd, force: true }).entries.filter((e) => e.track === 'daily')
    assert.equal(afterEntries.length, 1)
    assert.match(readFileSync(file, 'utf8'), /^<!--/, '说明注释应留在文件头')
  })
})
