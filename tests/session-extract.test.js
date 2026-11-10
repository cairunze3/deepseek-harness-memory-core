/**
 * 会话边界抽取（0.5.0）的回归测试。
 *
 * 这一组守的是"漏写的兜底真的能兜住"这条链路上的四个可验证点：
 *  1. **只抽真人说的话**——同一个 `user/message` 事件类型里混着 5 类系统注入，
 *     不过滤就会把系统提示词碎片抽成"记忆"；
 *  2. **挑对象要挑对**——跳过当前会话、跳过还在写的会话、跳过已抽取的；
 *  3. **端给模型的块里必须有落盘指令**（工具名 + 会话 id + 空数组语义），
 *     否则模型看完原文只会说"我帮你整理一下"；
 *  4. **落点只能是队列**——mem_extract 没有 confirm 口子，写完还要把会话标成已抽取
 *     （否则每次开新会话都会重复抽同一段对话，队列会被灌成一片重复）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  STATE_FILE_NAME, buildSessionDigestText, decompressFrames, extractTurns, isExtracted,
  listSessionFiles, loadState, markExtracted, parseEvents, pickPendingSession,
  readSessionDigest, renderDigestBlock, renderDigestBlocks,
} from '../lib/session-digest.js'
import { createRuntime } from '../lib/runtime.js'
import { renderSnapshotFor } from '../lib/index.js'
import { parseQueueBody } from '../lib/consolidate.js'
import { sessionKey } from '../lib/session-digest.js'
import { buildTools } from '../lib/tools.js'
import { readChunks } from '../lib/memfile.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-session-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let dshHome
let memoryDir
let coreDir
beforeEach(() => {
  dshHome = mkdtempSync(join(sandbox, 'dsh-'))
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

/** 造一个多帧 zstd 会话文件（真实文件就是逐帧追加的，单帧解压只能拿到开头）。 */
function writeSession(id, frames, { cwd = 'C:\\demo\\proj', mtime = null } = {}) {
  const dir = join(dshHome, 'sessions', '--C-demo-proj--', id)
  mkdirSync(dir, { recursive: true })
  const bufs = frames.map((lines) => zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')))
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(bufs))
  if (mtime !== null) utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}

const userMsg = (text, kind = 'user') => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: kind ? { kind } : {}, role: 'user' },
})
const assistantMsg = (text) => ({ type: 'assistant/message', data: { content: [{ type: 'text', text }] } })

// ─────────────────────────────────────────────────────────────────────────────
describe('会话文件解析', () => {
  it('多帧 zstd 全部解压（只解第一帧会丢掉后面的所有轮次）', () => {
    const file = writeSession('session-a', [
      [{ type: 'session', id: 'session-a', createdAt: 1 }],
      [userMsg('第一轮'), assistantMsg('收到')],
      [userMsg('第二轮')],
    ])
    const buf = readFileSync(file)
    const text = decompressFrames(buf)
    const lines = text.split('\n').filter(Boolean)
    assert.equal(lines.length, 4, '三帧共 4 条事件')
    assert.equal(parseEvents(text).length, 4)
  })

  it('只抽 source.kind=user 的消息，跳过五类系统注入', () => {
    const events = [
      { type: 'session', id: 'session-b', createdAt: 1700000000000 },
      userMsg('我在排查 gatekeeper 的 ACL 冲突，证书和 NTP 都排掉了', 'user'),
      userMsg('<system-reminder>运行时上下文…</system-reminder>', 'runtime-context'),
      userMsg('<available_skills>…</available_skills>', 'skill-catalog'),
      userMsg('AGENTS.md 的内容', 'agent-instructions'),
      userMsg('now is 2026-11-03', 'time-context'),
      assistantMsg('结论：怀疑 group 继承顺序'),
    ]
    const turns = extractTurns(events)
    assert.equal(turns.userTurns.length, 1)
    assert.match(turns.userTurns[0], /gatekeeper/)
    assert.equal(turns.assistantTail, '结论：怀疑 group 继承顺序')
    assert.equal(turns.createdAt, 1700000000000)
  })

  it('同一类事件里的缺 kind 消息也不抽（宁漏不脏）', () => {
    const turns = extractTurns([userMsg('没有 kind 的老格式消息', null)])
    assert.equal(turns.userTurns.length, 0)
  })

  it('轮数与单轮长度都有上界', () => {
    const many = Array.from({ length: 30 }, (_, i) => userMsg(`第 ${i} 轮 ${'x'.repeat(500)}`))
    const turns = extractTurns(many, { maxTurns: 5, perTurnChars: 50 })
    assert.equal(turns.userTurns.length, 5)
    assert.equal(turns.userTurnCount, 30, '原始轮数要留着（写进摘要块的 turns 属性）')
    for (const t of turns.userTurns) assert.ok(t.length <= 51, `单轮被截断：${t.length}`)
  })

  it('只有系统注入、没有真人说话的会话不算可抽会话', () => {
    const file = writeSession('session-c', [[{ type: 'session', id: 'session-c' }], [userMsg('系统上下文', 'runtime-context')]])
    assert.equal(readSessionDigest(file), null)
  })

  it('会话文件列表按 mtime 倒序，且只认 session.v4', () => {
    const old = writeSession('session-old', [[userMsg('老')]], { mtime: 1000 })
    const fresh = writeSession('session-fresh', [[userMsg('新')]], { mtime: 9000 })
    const list = listSessionFiles(dshHome)
    assert.deepEqual(list.map((x) => x.sessionId), ['session-fresh', 'session-old'])
    assert.equal(list[0].file, fresh)
    assert.ok(old)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('挑哪个会话来抽', () => {
  it('跳过当前会话（不能抽自己）', () => {
    writeSession('session-me', [[userMsg('我自己')]], { mtime: 1000 })
    const { session, reason } = pickPendingSession({ dshHome, currentSessionId: 'session-me', state: { extracted: {} }, minAgeMs: 0, now: 10_000 })
    assert.equal(session, null)
    assert.equal(reason, 'nothing-pending')
  })

  it('跳过还在写的会话（另一个窗口的会话可能没结束）', () => {
    writeSession('session-live', [[userMsg('进行中')]], { mtime: 9_900 })
    const { session } = pickPendingSession({ dshHome, currentSessionId: 'session-new', state: { extracted: {} }, minAgeMs: 5_000, now: 10_000 })
    assert.equal(session, null)
  })

  it('跳过已抽取过的会话，取最近一个未抽取的', () => {
    writeSession('session-1', [[userMsg('第一段')]], { mtime: 1_000 })
    writeSession('session-2', [[userMsg('第二段')]], { mtime: 2_000 })
    // 键必须归一：直接写 'session-2' 查不到（真实键是 '2'），这条测试曾经因此假绿
    const state = { extracted: { [sessionKey('session-2')]: { at: 'x', count: 1 } } }
    const { session } = pickPendingSession({ dshHome, currentSessionId: 'session-3', state, minAgeMs: 0, now: 10_000 })
    assert.equal(session.sessionId, 'session-1')
  })

  // 挑选策略被实测推翻过两次，现在的规则分两层（见 session-digest.js 的注释）：
  //   24 小时内的会话 → 抽最新的那个；没有新鲜的 → 按最老清账
  it('24 小时内的会话优先抽最新关掉的那个（用户刚说完的话要先被记住）', () => {
    // 真机事故：7 天积压 27 个时按"最老优先"，用户当天说的 gatekeeper 事实排在队尾，
    // 要开 20 多次新会话才轮得到 —— 机制等于没有。
    const now = 1_700_000_000_000
    const hour = 3600 * 1000
    writeSession('session-old', [[userMsg('昨天关掉的')]], { mtime: now - 30 * hour })
    writeSession('session-newest', [[userMsg('刚刚关掉的')]], { mtime: now - 1 * hour })
    const { session } = pickPendingSession({ dshHome, currentSessionId: 'cur', state: { extracted: {} }, minAgeMs: 0, now })
    assert.equal(session.sessionId, 'session-newest')
  })

  it('24 小时内没有新会话时，按最老清账（保证没有哪一段永远轮不到）', () => {
    const now = 1_700_000_000_000
    const hour = 3600 * 1000
    writeSession('session-old', [[userMsg('三天前')]], { mtime: now - 72 * hour })
    writeSession('session-less-old', [[userMsg('两天前')]], { mtime: now - 48 * hour })
    const { session } = pickPendingSession({ dshHome, currentSessionId: 'cur', state: { extracted: {} }, minAgeMs: 0, now })
    assert.equal(session.sessionId, 'session-old', '都过窗口了，从最老的开始清')
  })

  it('新鲜窗口内端过一次但仍没抽取，下次还会继续端它（重试而非跳过）', () => {
    const now = 1_700_000_000_000
    const hour = 3600 * 1000
    writeSession('session-old', [[userMsg('要抽的内容')]], { mtime: now - 30 * hour })
    writeSession('session-new', [[userMsg('更新的会话')]], { mtime: now - 1 * hour })
    // 状态键用 sessionKey 归一：直接写目录名 'session-new' 会读不到（键是 'new'）
    const state = { extracted: {}, offered: { [sessionKey('session-new')]: 1 } }
    const { session } = pickPendingSession({ dshHome, currentSessionId: 'cur2', state, minAgeMs: 0, maxOffers: 2, now })
    assert.equal(session.sessionId, 'session-new', '还剩一次机会，应该继续端它')
  })

  it('超出回溯期限的历史会话静默跳过（不占 abandoned，那是"端过没被抽"的账）', () => {
    const day = 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    writeSession('session-ancient', [[userMsg('很久以前')]], { mtime: now - 30 * day })
    writeSession('session-recent', [[userMsg('最近')]], { mtime: now - 1 * day })
    const { session, abandoned } = pickPendingSession({ dshHome, currentSessionId: 'cur', state: { extracted: {} }, minAgeMs: 0, horizonDays: 7, now })
    assert.equal(session.sessionId, 'session-recent')
    // 真机干跑发现：75 个会话里 50 个在 7 天外，全记 abandoned 会把状态文件堆成噪声
    assert.deepEqual(abandoned, [], 'horizon 外从没端过，不算放弃')
  })

  it('端满上限的会话被跳过（不会一直卡在它身上）', () => {
    writeSession('session-1', [[userMsg('端过一次')]], { mtime: 1_000 })
    writeSession('session-2', [[userMsg('端满了两次')]], { mtime: 2_000 })
    const state = { extracted: {}, offered: { [sessionKey('session-1')]: 1, [sessionKey('session-2')]: 2 } }
    const { session, abandoned } = pickPendingSession({ dshHome, currentSessionId: 'new', state, minAgeMs: 0, maxOffers: 2, now: 10_000 })
    assert.equal(session.sessionId, 'session-1', '还剩一次机会的优先于已放弃的')
    // abandoned 是惰性收集的：一旦选定就停，不会把后面的也都算进去
    assert.ok(Array.isArray(abandoned))
    assert.equal(abandoned.includes('session-1'), false)
  })

  it('没有会话目录时返回 no-sessions 而不是抛错', () => {
    const { session, reason } = pickPendingSession({ dshHome, currentSessionId: 'x', state: { extracted: {} }, minAgeMs: 0 })
    assert.equal(session, null)
    assert.equal(reason, 'no-sessions')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('注入块', () => {
  const digest = {
    sessionId: 'session-x',
    createdAt: Date.UTC(2026, 10, 3, 5, 30),
    userTurns: ['我在排查 gatekeeper 的 ACL 冲突', '现在怀疑 group 继承顺序'],
    userTurnCount: 2,
    assistantTail: '建议先展开组继承链',
  }

  it('带上工具名、会话 id、空数组语义与落点说明', () => {
    const text = renderDigestBlock(digest)
    assert.match(text, /<session_digest/)
    assert.match(text, /session-x/)
    assert.match(text, /mem_extract\(/)
    assert.match(text, /QUEUE\.md/)
    assert.match(text, /candidates=\[\]/, '没有关键点时也要有个明确的收尾动作')
    assert.match(text, /\[用户\] 我在排查 gatekeeper/)
  })

  it('字符预算生效（超长会话不会把首轮 prompt 撑爆）', () => {
    const long = { ...digest, userTurns: Array.from({ length: 40 }, (_, i) => `第 ${i} 条 ${'y'.repeat(200)}`) }
    const text = renderDigestBlock(long, { maxChars: 900 })
    assert.ok(text.length <= 1_100, `实际 ${text.length}`)
    assert.match(text, /<\/session_digest>$/)
  })

  it('多段渲染：单段时与单段函数逐字一致（不吃两套规则）', () => {
    assert.equal(renderDigestBlocks([digest], { maxChars: 2600 }), renderDigestBlock(digest, { maxChars: 2600 }))
    assert.equal(renderDigestBlocks([], { maxChars: 2600 }), '')
  })

  it('多段渲染：规则只写一次，两段 id 都在，且不越总预算', () => {
    const second = {
      sessionId: 'session-y',
      createdAt: Date.UTC(2026, 10, 3, 6, 0),
      userTurns: ['第二个会话里用户交代了 etcd 连接上限 200'],
      userTurnCount: 1,
      assistantTail: '建议先看连接池',
    }
    const text = renderDigestBlocks([digest, second], { maxChars: 1200 })
    assert.equal((text.match(/抽取规则/g) || []).length, 1, '规则说明只该出现一次')
    assert.match(text, /count="2"/)
    assert.match(text, /sessionId="session-x"/)
    assert.match(text, /sessionId="session-y"/)
    // 每段标题里的 id 必须是真 id，不能是占位符——模型会原样照抄进 mem_extract
    assert.doesNotMatch(text, /sessionId="</)
    assert.ok(text.length <= 1_400, `实际 ${text.length}`)
  })

  it('sessionExtract=false 时一条都不注入（可回退）', () => {
    writeSession('session-1', [[userMsg('要抽的内容')]], { mtime: 1_000 })
    const stateFile = join(coreDir, STATE_FILE_NAME)
    const text = buildSessionDigestText({ config: { dshHome, sessionExtract: false }, currentSessionId: 'new', stateFile, now: 10_000 })
    assert.equal(text, '')
  })

  it('抽取一次后写状态：offered 计数 +1，但不标 extracted（那是落盘才算）', () => {
    writeSession('session-1', [[userMsg('要抽的内容')]], { mtime: 1_000 })
    const stateFile = join(coreDir, STATE_FILE_NAME)
    const text = buildSessionDigestText({ config: { dshHome, sessionExtractMinAgeMs: 0 }, currentSessionId: 'new', stateFile, now: 10_000 })
    assert.match(text, /session_digest/)
    const state = loadState(stateFile)
    assert.equal(state.offered[sessionKey('session-1')], 1)
    assert.equal(state.extracted[sessionKey('session-1')], undefined)
    // 再端一次会继续计数（模型没照做时，下一个会话还会再问一次）
    buildSessionDigestText({ config: { dshHome, sessionExtractMinAgeMs: 0 }, currentSessionId: 'new2', stateFile, now: 20_000 })
    assert.equal(loadState(stateFile).offered[sessionKey('session-1')], 2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 真机实测（2026-11-03，0.5.2）：注入文本必须是"本会话内的确定函数"
describe('注入稳定性（真机日志暴露：同一个 step 里 text 回调被调了 4 次）', () => {
  it('同一会话连续组装多次，摘要块必须每次都在（否则会被后一次的空串覆盖）', () => {
    // 真实事故：第 1 次返回 852 字符，后 3 次返回空串（digestOffered 已置位），
    // 而 systemPrompt 取最后一次 → 模型根本没看到，日志却显示"端出了"。
    // mtime 必须落在 horizonDays（7 天）内，否则会被当成历史会话静默跳过
    writeSession('session-prev', [[userMsg('上一个会话的内容')]], { mtime: Date.now() - 60_000 })
    const rt = createRuntime({ config: { memoryDir, coreDir, dshHome, sessionExtractMinAgeMs: 0 }, logger: { info() {}, warn() {} } })
    const ag = { session: { id: 'session-busy', header: { cwd: 'C:////demo////proj' } } }
    const first = renderSnapshotFor(rt, { agent: ag })
    const second = renderSnapshotFor(rt, { agent: ag })
    const third = renderSnapshotFor(rt, { agent: ag })
    assert.ok(first.includes('<session_digest source='), '首次应带摘要块')
    assert.equal(second, first, '第二次必须与第一次逐字相同（文本不变才不掉 prompt 缓存）')
    assert.equal(third, first, '第三次同样')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 真机实测（2026-11-03）暴露的三个问题：两个目录命名并存、状态键不归一、空会话卡队首
describe('真实会话目录的两代命名', () => {
  it('裸 uuid 目录也要被扫到（旧格式会话不带 session- 前缀）', () => {
    // 真机 45 个目录里 18 个是裸 uuid；按前缀过滤会漏掉 40% 的会话
    writeSession('1e0f9b9a-42d4-4f30-86ff-553d49dde8f6', [[userMsg('旧格式会话')]], { mtime: 1_000 })
    writeSession('session-2633ae5e', [[userMsg('新格式会话')]], { mtime: 2_000 })
    const ids = listSessionFiles(dshHome).map((f) => f.sessionId).sort()
    assert.deepEqual(ids, ['1e0f9b9a-42d4-4f30-86ff-553d49dde8f6', 'session-2633ae5e'])
  })

  it('跳过自己：两种 id 形态都要能对上（否则新会话会把自己端出去抽）', () => {
    // 运行时 agent.session.id 是 `session-<uuid>`，而旧目录名是裸 uuid
    const uuid = '1e0f9b9a-42d4-4f30-86ff-553d49dde8f6'
    writeSession(uuid, [[userMsg('当前这个会话自己')]], { mtime: 1_000 })
    writeSession('session-older', [[userMsg('更早的会话')]], { mtime: 500 })
    const { session } = pickPendingSession({
      dshHome, currentSessionId: `session-${uuid}`, state: { extracted: {} }, minAgeMs: 0, now: 10_000,
    })
    assert.equal(session.sessionId, 'session-older', '不能把当前会话自己当历史端出去')
  })

  it('端出去→抽取→不再重复端：注入块里的 id 与目录名形态不同也要能对上', () => {
    // 真机链路：目录名是裸 uuid，注入块里写的是事件 id（带 session- 前缀），
    // mem_extract 回传的是后者。若不做归一，同一会话会被反复端出来抽第二次。
    const now = 1_700_000_000_000
    const hour = 3600 * 1000
    const uuid = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
    // uuid 是刚关掉的那个（最新）→ 第一次一定端它
    writeSession(uuid, [[userMsg('把这段对话抽一下')]], { mtime: now - 1 * hour })
    writeSession('session-next', [[userMsg('更早的会话')]], { mtime: now - 2 * hour })
    const stateFile = join(coreDir, STATE_FILE_NAME)
    const text = buildSessionDigestText({ config: { dshHome, sessionExtractMinAgeMs: 0 }, currentSessionId: 'cur', stateFile, now })
    assert.match(text, /session_digest/)
    // 模型回传的 id：从注入块里原样取（就是带前缀那种）
    const m = text.match(/sessionId="([^"]+)"/)
    assert.ok(m, '注入块里应带 sessionId')
    markExtracted(stateFile, m[1], { count: 2, mode: 'tool' })
    assert.equal(isExtracted(stateFile, uuid), true, '目录名形态也要认出已抽取')
    assert.equal(isExtracted(stateFile, m[1]), true)
    // 再挑一次：该会话必须被跳过，轮到后面的
    const again = buildSessionDigestText({ config: { dshHome, sessionExtractMinAgeMs: 0 }, currentSessionId: 'cur2', stateFile, now })
    assert.doesNotMatch(again, new RegExp(uuid), '已抽取的会话不该再端')
    assert.match(again, /session-next/, '应该轮到下一个候选')
  })

  it('解不出用户发言的会话记进 unreadable，不再挡住后面的正常会话', () => {
    // 空会话（只有系统注入）如果卡在队首，因为不消耗 offered，会永远轮不到后面的
    const now = 1_700_000_000_000
    const hour = 3600 * 1000
    // 空会话是最近关掉的那个（先被试），真正有内容的更早
    writeSession('session-empty', [[{ type: 'system/message', data: { content: [] } }]], { mtime: now - 1 * hour })
    writeSession('session-real', [[userMsg('真正有内容的')]], { mtime: now - 2 * hour })
    const { session, unreadable } = pickPendingSession({
      dshHome, currentSessionId: 'cur', state: { extracted: {} }, minAgeMs: 0, now,
    })
    // 空会话先被试，但读不出内容 → 同一次挑选里就该跳过它，直接给出真正有内容的那个
    assert.equal(session.sessionId, 'session-real')
    assert.deepEqual(unreadable, [sessionKey('session-empty')], '跳过的原因要留痕')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('mem_extract：只能进队列', () => {
  function runtimeOf(extra = {}) {
    return createRuntime({ config: { memoryDir, coreDir, dshHome, ...extra }, logger: { info() {}, warn() {} } })
  }
  function toolOf(rt) {
    return buildTools(rt).find((t) => t.name === 'mem_extract')
  }
  const agent = (cwd) => ({ session: { id: 'session-new', header: { cwd } } })
  // 用产品函数而不是手工 split('§')：QUEUE.md 默认预建，文件最前面有一段功能说明
  // （HTML 注释）。手工 split 会把它并进第一条，`parseQueueBody` 就会拿到 null。
  const queueEntries = () => {
    const f = join(memoryDir, 'QUEUE.md')
    if (!existsSync(f)) return []
    return readChunks(f).chunks
  }

  it('没有 confirm 参数（结构上就绕不过审查）', () => {
    const tool = toolOf(runtimeOf())
    assert.equal(tool.parameters.properties.confirm, undefined)
  })

  it('候选写进 QUEUE.md，带 queue 头标签与项目路由', async () => {
    const cwd = join(sandbox, 'proj-a')
    mkdirSync(cwd, { recursive: true })
    const tool = toolOf(runtimeOf())
    const out = await tool.execute({
      sessionId: 'session-1',
      candidates: [
        { text: 'gatekeeper 的 ACL 冲突，已排除证书过期与 NTP 偏差', track: 'key', scope: 'project', summary: 'GK 排查进度' },
        { text: '当前怀疑 group 继承顺序', track: 'key', scope: 'project' },
      ],
    }, { agent: agent(cwd) })
    assert.match(out, /抽出 2 条候选/)
    const entries = queueEntries()
    assert.equal(entries.length, 2)
    assert.match(entries[0], /\[queue:track=key scope=project id=/)
    assert.match(entries[0], /已排除证书过期/)
    assert.match(entries[0], /\[summary:GK 排查进度\]/)
    // 队列条目必须能被晋升逻辑解析（时间戳与 summary 在前，parseQueueBody 会先剥掉）
    const meta = parseQueueBody(entries[0])
    assert.equal(meta.track, 'key')
    assert.equal(meta.scope, 'project')
    assert.match(meta.content, /已排除证书过期/)
    assert.equal(parseQueueBody(entries[1]).track, 'key')
    // 正轨一个字都不该动（两个文件默认预建，但里面只有说明、没有任何条目）
    const realEntries = (rel) => {
      const f = join(memoryDir, rel)
      return existsSync(f) ? readChunks(f).chunks : []
    }
    assert.deepEqual(realEntries('MEMORY.md'), [], '正轨不得被写入')
    assert.deepEqual(realEntries('USER.md'), [], '正轨不得被写入')
  })

  it('同一会话重复抽取被拦下（否则每轮开新会话就重复灌队列）', async () => {
    const cwd = join(sandbox, 'proj-b')
    mkdirSync(cwd, { recursive: true })
    const tool = toolOf(runtimeOf())
    const args = { sessionId: 'session-dup', candidates: [{ text: '一条', track: 'key', scope: 'project' }] }
    const first = await tool.execute(args, { agent: agent(cwd) })
    assert.match(first, /抽出 1 条候选/)
    const second = await tool.execute(args, { agent: agent(cwd) })
    assert.match(second, /已经抽取过/)
    assert.equal(queueEntries().length, 1, '队列里只有第一条')
    assert.equal(isExtracted(join(coreDir, STATE_FILE_NAME), 'session-dup'), true)
  })

  it('candidates=[] 也算抽完（会话标已抽取，避免下次再来烦）', async () => {
    const tool = toolOf(runtimeOf())
    const out = await tool.execute({ sessionId: 'session-empty', candidates: [] }, { agent: agent(join(sandbox, 'proj-c')) })
    assert.match(out, /没有关键点/)
    assert.equal(isExtracted(join(coreDir, STATE_FILE_NAME), 'session-empty'), true)
    assert.equal(queueEntries().length, 0)
  })

  it('空文本候选被丢掉，不会写出一条只有标签的空记忆', async () => {
    const cwd = join(sandbox, 'proj-d')
    mkdirSync(cwd, { recursive: true })
    const tool = toolOf(runtimeOf())
    const out = await tool.execute({
      sessionId: 'session-blank',
      candidates: [{ text: '   ' }, { text: '有内容', track: 'key', scope: 'project' }],
    }, { agent: agent(cwd) })
    assert.match(out, /抽出 1 条候选/)
    assert.equal(queueEntries().length, 1)
  })

  it('与正轨重复的候选不写队列（否则晋升时会被自己刷成"第二次出现"）', async () => {
    const cwd = join(sandbox, 'proj-dup')
    mkdirSync(cwd, { recursive: true })
    const rt = runtimeOf()
    const tool = toolOf(rt)
    // 先按"当轮已经写过"的形态写进正轨
    const write = buildTools(rt).find((t) => t.name === 'mem_write')
    await write.execute({
      action: 'add', track: 'key', scope: 'project', confirm: true, source: 'user-stated',
      content: 'gatekeeper 的 ACL 冲突：证书过期与 NTP 偏差已排除，当前怀疑 group 继承顺序',
    }, { agent: agent(cwd) })
    const out = await tool.execute({
      sessionId: 'session-dup2',
      candidates: [{ text: 'gatekeeper 的 ACL 冲突，证书过期和 NTP 偏差都已经排除了，现在怀疑 group 继承顺序', track: 'key', scope: 'project' }],
    }, { agent: agent(cwd) })
    assert.match(out, /与正轨已有条目重复/)
    assert.equal(queueEntries().length, 0, '正轨有的东西不该再进队列')
    assert.equal(isExtracted(join(coreDir, STATE_FILE_NAME), 'session-dup2'), true, '跳过也算抽完')
  })

  it('同主题但不同事实的候选不会被去重误杀', async () => {
    const cwd = join(sandbox, 'proj-diff')
    mkdirSync(cwd, { recursive: true })
    const rt = runtimeOf()
    const write = buildTools(rt).find((t) => t.name === 'mem_write')
    await write.execute({
      action: 'add', track: 'key', scope: 'project', confirm: true, source: 'user-stated',
      content: 'gatekeeper 的 ACL 冲突：证书过期与 NTP 偏差已排除，当前怀疑 group 继承顺序',
    }, { agent: agent(cwd) })
    const out = await toolOf(rt).execute({
      sessionId: 'session-diff',
      candidates: [{ text: 'gatekeeper 的 etcd 连接数上限从 200 调到了 800', track: 'key', scope: 'project' }],
    }, { agent: agent(cwd) })
    assert.match(out, /抽出 1 条候选/, '同一服务下的另一条事实必须留下来')
    assert.equal(queueEntries().length, 1)
  })

  it('队列被配置关掉时如实拒绝，不偷偷写正轨', async () => {
    const tool = toolOf(runtimeOf({ writeQueueEnabled: false }))
    const out = await tool.execute({ sessionId: 'session-off', candidates: [{ text: 'x' }] }, { agent: agent(join(sandbox, 'proj-e')) })
    assert.match(out, /writeQueueEnabled=false/)
    assert.equal(queueEntries().length, 0)
  })

  it('markExtracted / isExtracted 往返，状态文件坏了也不抛', () => {
    const stateFile = join(coreDir, STATE_FILE_NAME)
    assert.equal(isExtracted(stateFile, 's1'), false)
    markExtracted(stateFile, 's1', { count: 3 })
    assert.equal(isExtracted(stateFile, 's1'), true)
    writeFileSync(stateFile, '{ 半个 json', 'utf8')
    assert.equal(isExtracted(stateFile, 's1'), false, '损坏时降级为"没抽过"，最多重抽一次')
    assert.doesNotThrow(() => loadState(stateFile))
  })
})
