/**
 * 「索引分槽」的回归测试（v0.3.2：注入文本位置稳定，保护 prefix 缓存）。
 *
 * 守的性质：
 *  1. **入槽即定序**：已入槽条目位置不变，排名变化不会重排；
 *  2. **新增只追加**：新条目排到末尾，绝不插队；
 *  3. **超容量只挤尾**：容量不够时新条目被 defer，不从中间挖洞；
 *  4. **内容寻址**：条目正文不变则槽位键不变（文件重排不影响）；
 *  5. **定期重排**：超期才允许重排（丢一次缓存，之后重新稳定）；
 *  6. **统计行在页脚**：它是每次写入都会变的行，必须放在末尾而不是开头。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { assignSlots, entrySlotKey, readSlots, shouldResort, stablePrefix, writeSlots } from '../lib/slots.js'
import { renderIndexSnapshot } from '../lib/inject.js'
import { resolveConfig } from '../lib/config.js'
import { createRuntime } from '../lib/runtime.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-slots-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let coreDir
beforeEach(() => { coreDir = mkdtempSync(join(sandbox, 'core-')) })

/** 造一条渲染用的条目。 */
function entry(ord, body, extra = {}) {
  return {
    entryId: `e${ord}`, path: 'C:/m/X.md', rel: 'X.md', root: 'C:/m', ordinal: ord,
    scope: 'global', track: extra.track ?? 'memory', projectId: null, projectLabel: null,
    date: extra.date ?? '2026-10-28', time: '10:00', stamp: null, recencyKey: 'x',
    summary: body.slice(0, 40), body, chars: body.length, bytes: body.length,
    mtime: extra.mtime ?? Date.parse('2026-10-28T02:00:00Z'), ageDays: 0, contentHash: `h${ord}`,
    idTag: null, branchTag: null, dshOnly: false, supersededBy: null, suspect: null, indexedBody: body,
  }
}

const SESSION = { id: 'sess-slots', turnsSinceWrite: 0 }

// ─────────────────────────────────────────────────────────────────────────────
describe('槽位键：内容寻址', () => {
  it('同一正文得到同一键；正文变了键就变', () => {
    assert.equal(entrySlotKey(entry(0, '同一段内容')), entrySlotKey(entry(7, '同一段内容')))
    assert.notEqual(entrySlotKey(entry(0, '同一段内容')), entrySlotKey(entry(0, '同一段内容改了一个字')))
  })

  it('正文为空时退回 entryId（不让空正文共享一个键）', () => {
    assert.equal(entrySlotKey({ entryId: 'abc', body: '   ' }), 'abc')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('分配槽位：追加式、不插队', () => {
  it('沿用旧顺序：内部顺序原样保留，新条目追加到末尾', () => {
    const a = entry(0, 'A'), b = entry(1, 'B'), c = entry(2, 'C')
    const first = assignSlots({ candidates: [a, b], previous: [], capacity: 10 })
    assert.deepEqual(first.ordered.map((e) => e.entryId), ['e0', 'e1'])
    // 第二轮：b 的排名升到前面，但已入槽 → 位置不变
    const second = assignSlots({ candidates: [b, a, c], previous: first.slots, capacity: 10 })
    assert.deepEqual(second.ordered.map((e) => e.entryId), ['e0', 'e1', 'e2'])
    assert.equal(second.appended, 1)
    assert.equal(second.kept, 2)
  })

  it('容量满了：新条目不抢占，deferred 计数如实给出', () => {
    const a = entry(0, 'A'), b = entry(1, 'B')
    const first = assignSlots({ candidates: [a, b], previous: [], capacity: 2 })
    const second = assignSlots({ candidates: [entry(2, 'C'), a, b], previous: first.slots, capacity: 2 })
    assert.deepEqual(second.ordered.map((e) => e.entryId), ['e0', 'e1'], '已入槽的位置不得被挤动')
    assert.equal(second.deferred, 1)
    assert.equal(second.appended, 0)
  })

  it('条目不可注入（归档/被取代）时，槽位自然空出给新条目', () => {
    const a = entry(0, 'A'), b = entry(1, 'B')
    const first = assignSlots({ candidates: [a, b], previous: [], capacity: 2 })
    const second = assignSlots({ candidates: [a, entry(2, 'C')], previous: first.slots, capacity: 2 })
    assert.deepEqual(second.ordered.map((e) => e.entryId), ['e0', 'e2'])
    assert.equal(second.evicted, 1)
  })

  it('§ 相同正文只占一个槽（去重）', () => {
    const dup = assignSlots({ candidates: [entry(0, '一样的内容'), entry(1, '一样的内容')], previous: [], capacity: 5 })
    assert.equal(dup.ordered.length, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('重排时机', () => {
  it('从未排过 → 重排；超期 → 重排；刚排过 → 不重排', () => {
    const now = Date.parse('2026-10-28T12:00:00Z')
    assert.equal(shouldResort({ updatedAt: 0, now, everyHours: 6 }), true)
    assert.equal(shouldResort({ updatedAt: now - 7 * 3_600_000, now, everyHours: 6 }), true)
    assert.equal(shouldResort({ updatedAt: now - 3_600_000, now, everyHours: 6 }), false)
    assert.equal(shouldResort({ updatedAt: now - 3_600_000, now, everyHours: 6, force: true }), true)
    // everyHours=0 → 永不因时间重排
    assert.equal(shouldResort({ updatedAt: 1, now, everyHours: 0 }), false)
  })

  it('槽位文件读写往返（坏文件当作没有历史）', () => {
    writeSlots(coreDir, ['k1', 'k2'])
    const state = readSlots(coreDir)
    assert.deepEqual(state.slots, ['k1', 'k2'])
    assert.ok(state.updatedAt > 0)
    writeSlots(coreDir, ['k3'])
    assert.deepEqual(readSlots(coreDir).slots, ['k3'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('渲染：前缀稳定 + 统计行在页脚', () => {
  const config = resolveConfig({})

  function render(entries, previousSlots) {
    return renderIndexSnapshot({ entries, config, now: Date.parse('2026-10-28T02:10:00Z'), session: SESSION, previousSlots })
  }

  it('写一条"中段轨道"的新条目时，已有条目的行逐字节不变（这是缓存的全部意义）', () => {
    const base = Array.from({ length: 10 }, (_, i) => entry(i, `第 ${i + 1} 条长期记忆，内容足够长以便进入常驻索引`))
    const newer = entry(99, '本轮新增的一条关键记忆，按轨道顺序本应排在中段', { track: 'key', mtime: Date.parse('2026-10-28T02:10:00Z') })

    const before = render(base, null)
    const withoutSlots = render([...base, newer], null)
    const withSlots = render([...base, newer], before.slots)

    const pOld = stablePrefix({ previous: before.text, next: withoutSlots.text })
    const pNew = stablePrefix({ previous: before.text, next: withSlots.text })

    assert.ok(pNew.startsWith > pOld.startsWith, `分槽应更稳：分槽 ${pNew.startsWith} vs 旧 ${pOld.startsWith}`)
    // 分槽后：旧条目一行都没变（差异只出现在新增的那一行）
    const oldLines = before.text.split('\n').filter((line) => line.startsWith('- ['))
    const newLines = new Set(withSlots.text.split('\n'))
    for (const line of oldLines) assert.ok(newLines.has(line), `旧条目行不应变化：${line.slice(0, 40)}`)
  })

  it('统计行（条目 N / 本次注入 M）在页脚，不在开头', () => {
    const rendered = render([entry(0, '一条足够长的记忆内容用于渲染索引行'), entry(1, '第二条足够长的记忆内容')], null)
    const lines = rendered.text.split('\n')
    const statAt = lines.findIndex((line) => line.startsWith('条目 '))
    const firstEntryAt = lines.findIndex((line) => line.startsWith('- ['))
    const closeAt = lines.findIndex((line) => line === '</memory_index>')
    assert.ok(statAt > firstEntryAt, '统计行必须在条目之后（否则每次写入都改前缀）')
    assert.ok(statAt < closeAt)
    assert.ok(statAt >= lines.length - 8, '统计行应在末尾几行内（页脚区）')
  })

  it('返回 slots 供调用方持久化；close 后仍可复用', () => {
    const base = [entry(0, '甲'), entry(1, '乙')]
    const first = render(base, null)
    assert.equal(first.slots.length, 2)
    const second = render(base, first.slots)
    assert.deepEqual(second.slots, first.slots, '无变化时槽位应完全一致')
    assert.equal(second.text, first.text, '无变化时整段文本应逐字节相同')
  })

  it('关闭 indexStableSlots 时退回按排名渲染（行为可回退）', () => {
    const off = resolveConfig({ indexStableSlots: false })
    const base = [entry(0, '甲'), entry(1, '乙')]
    const rendered = renderIndexSnapshot({ entries: base, config: off, now: Date.now(), session: SESSION, previousSlots: ['whatever'] })
    assert.equal(rendered.slotInfo, null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('运行时：槽位持久化与失效', () => {
  function runtimeOf(extra = {}) {
    return createRuntime({
      config: { memoryDir: mkdtempSync(join(sandbox, 'mem-')), coreDir, ...extra },
      logger: { info() {}, warn() {} },
    })
  }

  it('首次返回 null（要求重排），保存后返回同一序列，且落盘', () => {
    const rt = runtimeOf()
    assert.equal(rt.indexSlots(), null, '从未排过 → 必须重排')
    rt.saveIndexSlots(['k1', 'k2'])
    assert.deepEqual(rt.indexSlots(), ['k1', 'k2'])
    assert.deepEqual(readSlots(coreDir).slots, ['k1', 'k2'], '应落盘，重启后顺序不丢')
    rt.close?.()
  })

  it('invalidate 之后要求重排；关闭开关时恒为 null', () => {
    const rt = runtimeOf()
    rt.saveIndexSlots(['k1'])
    assert.deepEqual(rt.indexSlots(), ['k1'])
    rt.invalidateIndexSlots()
    assert.equal(rt.indexSlots(), null)
    const off = runtimeOf({ indexStableSlots: false })
    off.saveIndexSlots(['k9'])
    assert.equal(off.indexSlots(), null, '关闭分槽后不该有槽位')
  })

  it('超过重排周期后要求重排（丢一次缓存，之后重新稳定）', () => {
    const rt = runtimeOf({ indexResortEveryHours: 0.0001 })
    rt.saveIndexSlots(['k1'])
    assert.deepEqual(rt.indexSlots(), ['k1'])
    // 直接把盘上的 updatedAt 改旧，模拟"已超期"
    writeSlots(coreDir, ['k1'], Date.now() - 10_000)
    const fresh = runtimeOf({ indexResortEveryHours: 0.0001 })
    assert.equal(fresh.indexSlots(), null)
  })
})