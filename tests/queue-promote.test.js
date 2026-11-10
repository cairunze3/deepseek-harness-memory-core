/**
 * tests/queue-promote.test.js — 「命中即确认」的行为契约。
 *
 * 这里钉死三件事：
 *  ① 被召回过的候选真的从 QUEUE.md 移进正轨（是移动，不是复制）；
 *  ② 没被召回的候选留在队列里、缺 projectId 的 key 候选不转正；
 *  ③ 面向模型的措辞里不再出现"用户确认后才晋升"——那句话正是真机那句
 *     "要不要我把这条从队列晋升为正式记忆"的来源。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { autoPromoteAfterSearch, promoteQueueHits, readPromoteState, writePromoteState } from '../lib/queue-promote.js'
import { renderDigestBlock } from '../lib/session-digest.js'

const TS = '2026-11-03 17:13'

/** 建一个最小记忆库：QUEUE.md 三条候选（两条可转正，一条缺 projectId）。 */
function setup() {
  const memoryDir = mkdtempSync(join(tmpdir(), 'qpromote-mem-'))
  const coreDir = mkdtempSync(join(tmpdir(), 'qpromote-core-'))
  const bodies = {
    hit: `[${TS}] [queue:key|project|abc123] 用户要换路由器，预算 800 以内。`,
    cold: `[${TS}] [queue:key|project|abc123] 用户家里是联通 1000M 宽带。`,
    orphan: `[${TS}] [queue:key] 缺 projectId 的 key 候选不该转正。`,
  }
  writeFileSync(join(memoryDir, 'QUEUE.md'), [bodies.hit, '§', bodies.cold, '§', bodies.orphan].join('\n'), 'utf8')
  const entries = [
    { entryId: 'hit', rel: 'QUEUE.md', track: 'queue', body: bodies.hit },
    { entryId: 'cold', rel: 'QUEUE.md', track: 'queue', body: bodies.cold },
    { entryId: 'orphan', rel: 'QUEUE.md', track: 'queue', body: bodies.orphan },
  ]
  return { memoryDir, coreDir, bodies, entries }
}

describe('promoteQueueHits：命中即转正', () => {
  it('被召回过的候选移进目标轨，并从 QUEUE.md 里消失（移动而非复制）', () => {
    const { memoryDir, coreDir, bodies, entries } = setup()
    const accessCounts = new Map([
      ['hit', { count: 1 }],
      ['cold', { count: 0 }],
      ['orphan', { count: 3 }],
    ])
    const result = promoteQueueHits({
      entries, accessCounts, coreDir, memoryDir, minHits: 1,
    })
    assert.equal(result.promoted.length, 1, `实际转正 ${result.promoted.length} 条`)
    assert.equal(result.errors.length, 0)

    const queue = readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8')
    assert.ok(!queue.includes(bodies.hit), '已转正的候选仍留在 QUEUE.md 里')
    assert.ok(queue.includes(bodies.cold), '没被召回的候选不该被移走')
    assert.ok(queue.includes(bodies.orphan), '缺 projectId 的候选不该被移走')

    const target = join(memoryDir, result.promoted[0].to)
    assert.ok(existsSync(target), `目标轨文件不存在：${result.promoted[0].to}`)
    assert.ok(readFileSync(target, 'utf8').includes('预算 800 以内'), '目标轨里找不到候选正文')
  })

  it('没有够格候选时零副作用（不建文件、不报错）', () => {
    const { memoryDir, coreDir, entries } = setup()
    const result = promoteQueueHits({
      entries, accessCounts: new Map(), coreDir, memoryDir, minHits: 1,
    })
    assert.equal(result.promoted.length, 0)
    assert.equal(result.errors.length, 0)
    const queue = readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8')
    assert.ok(queue.includes('联通 1000M'), '空跑却动了两队列')
  })

  it('minHits=2 时只召回过一次的候选不转正（阈值可收紧）', () => {
    const { memoryDir, coreDir, entries } = setup()
    const result = promoteQueueHits({
      entries,
      accessCounts: new Map([['hit', { count: 1 }]]),
      coreDir, memoryDir, minHits: 2,
    })
    assert.equal(result.promoted.length, 0)
    assert.ok(readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8').includes('预算 800 以内'))
  })
})

describe('autoPromoteAfterSearch：当轮命中 + 升级后回溯', () => {
  function fakeRt({ memoryDir, coreDir, entries, counts }) {
    let invalidated = false
    return {
      rt: {
        config: { backupBeforeWrite: false, queuePromoteMinHits: 1 },
        coreDir,
        memoryDir,
        getSnapshot: () => ({ entries }),
        ensureIndex: () => ({ accessCounts: (ids) => new Map(ids.map((id) => [id, { count: counts[id] ?? 0 }])) }),
        invalidate: () => { invalidated = true },
        ledger: null,
      },
      wasInvalidated: () => invalidated,
    }
  }

  it('首次检索会把历史上被命中过的候选一并回溯转正（老队列不留堆积）', () => {
    const { memoryDir, coreDir, bodies, entries } = setup()
    const { rt, wasInvalidated } = fakeRt({ memoryDir, coreDir, entries, counts: { hit: 1, cold: 2 } })
    const first = autoPromoteAfterSearch(rt, ['hit'])
    assert.equal(first.promoted.length, 2, `回溯应转正 2 条，实际 ${first.promoted.length}`)
    assert.ok(wasInvalidated(), '转正后没有让快照失效，模型会读到已移走的条目')
    const queue = readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8')
    assert.ok(!queue.includes(bodies.hit) && !queue.includes(bodies.cold))
    assert.ok(queue.includes(bodies.orphan), '缺 projectId 的候选仍应留在队列')
    assert.ok(readPromoteState(coreDir).backfilledAt != null, '回溯标记没落盘')
  })

  it('回溯只做一次：之后只转正当轮命中的候选', () => {
    const { memoryDir, coreDir, bodies, entries } = setup()
    const { rt } = fakeRt({ memoryDir, coreDir, entries, counts: { hit: 1, cold: 2 } })
    autoPromoteAfterSearch(rt, ['hit'])
    // 第二轮：cold 历史上命中过、但没被本轮命中；它已在回溯里转过正，不该再被动一次
    // （否则同一句话会被第二次追加进正轨——快照比磁盘旧时的典型重复写）。
    const second = autoPromoteAfterSearch(rt, ['hit'])
    assert.equal(second.promoted.length, 0, '回溯标记失效，旧候选被重复处理')
    const queue = readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8')
    assert.ok(queue.includes(bodies.orphan), '缺 projectId 的候选应始终留在队列')
    assert.ok(!queue.includes(bodies.cold), 'cold 已在回溯中转正，不该还在队列里')
  })

  it('queuePromoteMinHits=2 时第一次命中不转正，第二次才转正（默认新增的证据门槛）', () => {
    const { memoryDir, coreDir, bodies, entries } = setup()
    const { rt } = fakeRt({ memoryDir, coreDir, entries, counts: { hit: 1, cold: 0 } })
    rt.config.queuePromoteMinHits = 2
    const first = autoPromoteAfterSearch(rt, ['hit'])
    assert.equal(first.promoted.length, 0, '第一次命中就转正了，证据门槛没生效')
    assert.ok(readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8').includes(bodies.hit))
    // 模拟第二次召回：索引计数变成 2
    const fake = fakeRt({ memoryDir, coreDir, entries, counts: { hit: 2, cold: 0 } })
    const second = autoPromoteAfterSearch(fake.rt, ['hit'])
    assert.equal(second.promoted.length, 1, '第二次命中仍没有转正')
    assert.ok(!readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8').includes(bodies.hit))
  })

  it('config.queuePromoteOnRecall=false 时整条链路关闭', () => {
    const { memoryDir, coreDir, entries } = setup()
    const { rt } = fakeRt({ memoryDir, coreDir, entries, counts: { hit: 1 } })
    rt.config.queuePromoteOnRecall = false
    const result = autoPromoteAfterSearch(rt, ['hit'])
    assert.equal(result.promoted.length, 0)
    assert.equal(result.reason, 'disabled')
    assert.ok(readFileSync(join(memoryDir, 'QUEUE.md'), 'utf8').includes('预算 800 以内'))
  })

  it('运行时抛错时不影响检索（错误被吞掉，返回空结果）', () => {
    const broken = {
      config: {},
      coreDir: null,
      getSnapshot: () => { throw new Error('快照坏了') },
    }
    const result = autoPromoteAfterSearch(broken, ['x'])
    assert.equal(result.promoted.length, 0)
    assert.ok(result.errors.length > 0)
  })
})

describe('措辞契约：不再让用户确认', () => {
  it('注入块里不再出现"用户确认后才晋升"，改为自动转正并禁止向用户报告', () => {
    const text = renderDigestBlock({
      sessionId: 'session-abc', at: Date.now(), userTurnCount: 1,
      userTurns: ['我想换个路由器，预算 800 以内。'],
    })
    assert.ok(!text.includes('用户确认后才晋升'), '仍在提示"用户确认后才晋升"')
    assert.ok(text.includes('自动转正'), '没有说明自动转正')
    assert.ok(/不要.*(报告|问)|不要.*队列/.test(text), '没有禁止向用户报告队列状态')
  })

  it('工具描述与写入纪律里不再出现"用户确认后…晋升"', async () => {
    const { readFileSync: rf } = await import('node:fs')
    for (const file of ['lib/tools.js', 'lib/inject.js', 'lib/session-digest.js', 'lib/config.js']) {
      const src = rf(new URL(`../${file}`, import.meta.url), 'utf8')
      assert.ok(!src.includes('用户确认后才晋升'), `${file} 仍有"用户确认后才晋升"`)
      assert.ok(!src.includes('用户确认后由 mem_consolidate 晋升'), `${file} 仍把晋升绑在 mem_consolidate 上`)
    }
  })

  it('状态读写往返（回溯标记可持久化）', () => {
    const coreDir = mkdtempSync(join(tmpdir(), 'qpromote-state-'))
    assert.deepEqual(readPromoteState(coreDir), {})
    writePromoteState(coreDir, { backfilledAt: 123, promotedTotal: 2 })
    assert.equal(readPromoteState(coreDir).promotedTotal, 2)
  })
})
