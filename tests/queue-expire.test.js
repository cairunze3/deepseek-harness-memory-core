/**
 * tests/queue-expire.test.js — 「待巩固队列超期归档」的行为契约（2026-11-06）。
 *
 * 钉死三件事：
 *  ① 超过 queueStaleDays 且从未被召回/复述的候选，在整合方案里产生 queue-expire 提议；
 *  ② apply 后候选从 QUEUE.md 移入 QUEUE-archive.md（移动，不是复制/删除）；
 *  ③ queueStaleDays=0 时关闭时效清理，不产生任何 queue-expire 提议。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildPlan } from '../lib/consolidate.js'

/** 造两条 queue 候选：一条"老到超期"，一条"还很新鲜"。 */
function entries({ now }) {
  // 用 date 决定 ageDays：老条目日期距今 > queueStaleDays。
  const oldDate = '2026-01-01'
  const freshDate = '2026-11-05'
  const oldBody = `[${oldDate} 10:00] [queue:key|project|abc123] 很久以前的一句候选，一直没被召回。`
  const freshBody = `[${freshDate} 10:00] [queue:user|global] 最近的一句候选，还没到超期。`
  return {
    old: { entryId: 'old', rel: 'QUEUE.md', track: 'queue', body: oldBody, date: oldDate, ageDays: 300, summary: '很久以前的一句候选' },
    fresh: { entryId: 'fresh', rel: 'QUEUE.md', track: 'queue', body: freshBody, date: freshDate, ageDays: 1, summary: '最近的一句候选' },
    oldBody, freshBody,
  }
}

function config(overrides = {}) {
  return {
    queueStaleDays: 90,
    queuePromoteEnabled: true,
    consolidateEnabled: true,
    monthlyPackEnabled: true,
    staleArchiveDays: 180,
    dailyRetentionDays: 30,
    duplicateThreshold: 0.82,
    ...overrides,
  }
}

describe('queue-expire：待巩固队列超期归档', () => {
  it('超期候选进 queue-expire 提议，新鲜候选不处理', () => {
    const e = entries({ now: Date.now() })
    const plan = buildPlan({
      entries: [e.old, e.fresh], files: [{ rel: 'QUEUE.md' }], config: config(), now: Date.now(),
      accessCounts: new Map(), memoryDir: '',
    })
    const expires = plan.actions.filter((a) => a.type === 'queue-expire')
    assert.equal(expires.length, 1, `应只有 1 条 queue-expire，实际 ${expires.length}`)
    assert.equal(expires[0].entryId, 'old')
    assert.equal(expires[0].ageDays, 300)
    assert.equal(plan.counts.queueExpire, 1)
    // 新鲜候选既不晋升也不超期
    assert.ok(!plan.actions.some((a) => a.type === 'queue-expire' && a.entryId === 'fresh'), '新鲜候选不该被超期归档')
  })

  it('已被晋升提议的候选不再重复进 queue-expire', () => {
    const e = entries({ now: Date.now() })
    // 让 old 同时满足"被召回"（→promote）与"超期"（→queue-expire），
    // promote 应胜出，queue-expire 不得抢同一条。
    const plan = buildPlan({
      entries: [e.old], files: [{ rel: 'QUEUE.md' }], config: config(), now: Date.now(),
      accessCounts: new Map([['old', { count: 1 }]]), memoryDir: '',
    })
    const promotes = plan.actions.filter((a) => a.type === 'promote' && a.entryId === 'old')
    const expires = plan.actions.filter((a) => a.type === 'queue-expire' && a.entryId === 'old')
    assert.equal(promotes.length, 1, '被召回的候选应产生 promote 提议')
    assert.equal(expires.length, 0, '被晋升的候选不应再被超期归档')
  })

  it('queueStaleDays=0 关闭时效清理', () => {
    const e = entries({ now: Date.now() })
    const plan = buildPlan({
      entries: [e.old, e.fresh], files: [{ rel: 'QUEUE.md' }], config: config({ queueStaleDays: 0 }), now: Date.now(),
      accessCounts: new Map(), memoryDir: '',
    })
    assert.equal(plan.actions.filter((a) => a.type === 'queue-expire').length, 0, '关闭时效应无 queue-expire')
  })
})

describe('queue-expire：保护性候选不按"没人再提"归档（0.8.0）', () => {
  it('命中保护性关键词的超期候选不产生 queue-expire', () => {
    const e = entries({ now: Date.now() })
    const protectedEntry = {
      ...e.old,
      entryId: 'protected',
      body: e.old.body.replace('很久以前的一句候选', '对海鲜过敏，这是不可逆代价'),
      summary: '对海鲜过敏',
    }
    const plan = buildPlan({
      entries: [protectedEntry], files: [{ rel: 'QUEUE.md' }], config: config({ protectedKeywords: ['过敏'] }),
      now: Date.now(), accessCounts: new Map(), memoryDir: '',
    })
    assert.equal(plan.actions.filter((a) => a.type === 'queue-expire').length, 0)
  })
})