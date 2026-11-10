/**
 * 检索门槛标定（scripts/calibrate-search.mjs）的单元测试。
 *
 * 守的是一条**决策纪律**：门槛只能从本机分布读出来，不能照抄别人的 0.3/0.5–0.7。
 * 这组测试用合成账本把三种真实形态都钉住：
 *   ① 两组可分（空查组最高分明显低于命中组）→ 应给出"不误杀"的绝对门槛；
 *   ② 两组不可分（空查也能捞到高分）→ 应明确说"问题不在门槛"，而不是硬给一个数；
 *   ③ 样本太少 → 应拒绝给建议（宁可不给，也不给一个没有依据的数）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { calibrate, evaluateThreshold, splitTopScores } from '../scripts/calibrate-search.mjs'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-calib-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

const NOW = new Date('2026-11-02T12:00:00.000Z')

/**
 * 造一个 dshHome：<home>/memory-core/ledger.jsonl。
 *
 * @param {Array<{hits: number, top: number|null, query?: string}>} spec - 事件规格。
 * @returns {string} dshHome。
 */
function makeHome(spec) {
  const home = mkdtempSync(join(sandbox, 'home-'))
  mkdirSync(join(home, 'memory-core'), { recursive: true })
  const lines = spec.map((item, i) => JSON.stringify({
    t: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
    k: 'search',
    query: item.query ?? `q${i}`,
    mode: 'bm25',
    candidates: 8,
    hits: item.hits,
    ok: item.hits > 0,
    top: item.top,
  }))
  writeFileSync(join(home, 'memory-core', 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  return home
}

describe('splitTopScores', () => {
  it('按 hits 分成命中组与空查组；没有 top 的老记录计入 legacy 而不进分布', () => {
    const events = [
      { t: '2026-11-02T00:00:00.000Z', k: 'search', hits: 2, top: 0.6 },
      { t: '2026-11-02T00:00:01.000Z', k: 'search', hits: 0, top: 0.2 },
      { t: '2026-11-02T00:00:02.000Z', k: 'search', hits: 3 }, // 0.4.5 之前：没有 top
      { t: '2026-11-02T00:00:03.000Z', k: 'write' },
    ]
    const split = splitTopScores(events, Date.parse('2026-10-01T00:00:00.000Z'))
    assert.deepEqual(split.hit, [0.6])
    assert.deepEqual(split.miss, [0.2])
    assert.equal(split.legacy, 1)
  })
})

describe('evaluateThreshold', () => {
  it('统计保留/误杀/过滤（边界用 >= 且容忍浮点）', () => {
    const row = evaluateThreshold([0.2, 0.4, 0.6], [0.1, 0.3], 0.3)
    assert.equal(row.hitKept, 2) // 0.4, 0.6
    assert.equal(row.hitDropped, 1) // 0.2
    assert.equal(row.missFiltered, 1) // 0.1
    assert.equal(row.missKept, 1) // 0.3 刚好等于门槛 → 保留
  })
})

describe('calibrate（三种真实形态）', () => {
  it('① 两组可分：给出"零误杀"的绝对门槛，并写进 YAML 片段', () => {
    const home = makeHome([
      // 命中组：最高分 0.55 ~ 0.90
      { hits: 2, top: 0.55 }, { hits: 1, top: 0.62 }, { hits: 3, top: 0.71 },
      { hits: 1, top: 0.80 }, { hits: 2, top: 0.90 },
      // 空查组：最高分 0.05 ~ 0.30（明显低于命中组）
      { hits: 0, top: 0.05 }, { hits: 0, top: 0.12 }, { hits: 0, top: 0.18 },
      { hits: 0, top: 0.24 }, { hits: 0, top: 0.30 }, { hits: 0, top: 0.30 },
    ])
    // 样本不足时不给建议（MIN_SAMPLES=20），所以再补一批
    const more = []
    for (let i = 0; i < 10; i += 1) {
      more.push({ hits: 1, top: 0.6 + i * 0.01 })
      more.push({ hits: 0, top: 0.1 + i * 0.01 })
    }
    const home2 = makeHome([
      { hits: 2, top: 0.55 }, { hits: 1, top: 0.62 }, { hits: 3, top: 0.71 }, { hits: 1, top: 0.80 }, { hits: 2, top: 0.90 },
      { hits: 0, top: 0.05 }, { hits: 0, top: 0.12 }, { hits: 0, top: 0.18 }, { hits: 0, top: 0.24 }, { hits: 0, top: 0.30 }, { hits: 0, top: 0.30 },
      ...more,
    ])
    const { code, report, lines } = calibrate({ days: 30, home: home2 }, NOW)
    assert.equal(code, 0, lines.join('\n'))
    assert.ok(report.recommendation, lines.join('\n'))
    assert.equal(report.recommendation.hitDropped, 0, '推荐门槛不允许误杀命中')
    assert.ok(report.recommendation.missFiltered > 0, '推荐门槛必须真的砍掉空查')
    const text = lines.join('\n')
    assert.match(text, /searchMinScore: [0-9.]+/)
    assert.match(text, /searchMinScoreMode: absolute/)
    assert.ok(report.valid >= 20)
    rmSync(home, { recursive: true, force: true })
  })

  it('② 两组不可分：明确说"问题不在门槛"，不给数字', () => {
    const spec = []
    for (let i = 0; i < 12; i += 1) {
      spec.push({ hits: 1, top: 0.4 + i * 0.01 })
      spec.push({ hits: 0, top: 0.5 + i * 0.01 }) // 空查也捞到高分
    }
    const { code, report, lines } = calibrate({ days: 30, home: makeHome(spec) }, NOW)
    assert.equal(code, 0)
    assert.equal(report.recommendation, null)
    const text = lines.join('\n')
    assert.match(text, /问题不在门槛/)
    assert.match(text, /保持 searchMinScore=0/)
  })

  it('③ 样本太少：拒绝给建议（exit=2 表示"再攒几天"，不是失败）', () => {
    const { code, report, lines } = calibrate({ days: 30, home: makeHome([{ hits: 1, top: 0.7 }, { hits: 0, top: 0.2 }]) }, NOW)
    assert.equal(code, 2)
    assert.equal(report.recommendation, null)
    assert.match(lines.join('\n'), /不足 20 条/)
  })

  it('④ 账本不存在：说清楚去哪找（不抛异常）', () => {
    const { code, lines } = calibrate({ days: 30, home: join(sandbox, 'nope') }, NOW)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /没有找到审计账本/)
  })

  it('⑤ 老账本（全是 0.4.5 之前、没有 top）：提示"历史命中率偏乐观"并拒绝标定', () => {
    const home = mkdtempSync(join(sandbox, 'home-legacy-'))
    mkdirSync(join(home, 'memory-core'), { recursive: true })
    const lines = []
    for (let i = 0; i < 8; i += 1) lines.push(JSON.stringify({ t: '2026-11-02T00:00:00.000Z', k: 'search', hits: 8, query: 'q' }))
    writeFileSync(join(home, 'memory-core', 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8')
    const out = calibrate({ days: 30, home }, NOW)
    assert.equal(out.code, 2)
    assert.match(out.lines.join('\n'), /只记命中/)
  })
})