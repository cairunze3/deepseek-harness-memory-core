/**
 * 检索观测（lib/querylog.js）的单元测试。
 *
 * 这个模块守的是一条很容易被忽略的纪律：**度量层不能有幸存者偏差**。
 * 工具层（tools.js）负责"空查也记账"，这里负责"记下来的东西怎么算"——
 * 两者任何一环失守，"记忆到底有没有被用上"就会变成一句凭感觉的结论。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CLUSTER_TOKENS, DEFAULT_WINDOW_DAYS, clusterKey, queryTokens, renderSearchEvent, renderSummaryLines,
  searchEvent, summarizeSearchEvents,
} from '../lib/querylog.js'
import { tokenize } from '../lib/scanner.js'

const NOW = Date.parse('2026-11-02T12:00:00.000Z')

/** 造一条账本事件。 */
function ev(at, query, hits, extra = {}) {
  return { t: at, k: 'search', ...searchEvent({ query, hits, topScore: extra.top ?? null, mode: extra.mode ?? 'bm25', ...extra }) }
}

describe('searchEvent', () => {
  it('ok 是派生字段：hits 决定它（空查也必须能落盘）', () => {
    assert.equal(searchEvent({ query: 'x', hits: 0 }).ok, false)
    assert.equal(searchEvent({ query: 'x', hits: 2 }).ok, true)
  })

  it('top 非数字时归一为 null（而不是 undefined，JSON 里 undefined 会整个消失）', () => {
    assert.equal(searchEvent({ query: 'x', hits: 1 }).top, null)
    assert.equal(searchEvent({ query: 'x', hits: 1, topScore: Number.NaN }).top, null)
    assert.equal(searchEvent({ query: 'x', hits: 1, topScore: 0.42 }).top, 0.42)
  })

  it('查询式截断到 120 字符（账本不存整段对话）', () => {
    const long = '查'.repeat(500)
    assert.equal(searchEvent({ query: long, hits: 1 }).query.length, 120)
  })
})

describe('summarizeSearchEvents', () => {
  it('没有样本时命中率是 null 而不是 0 或 100（"没查过"≠"全没中"）', () => {
    const s = summarizeSearchEvents([], { now: NOW })
    assert.equal(s.total, 0)
    assert.equal(s.hitRate, null)
    assert.equal(s.avgTop, null)
  })

  it('命中率 = 命中 / 总次数，空查进分母', () => {
    const s = summarizeSearchEvents([
      ev('2026-11-01T01:00:00.000Z', '索引 派生物', 2, { top: 0.5 }),
      ev('2026-11-01T02:00:00.000Z', '不存在的主题', 0),
      ev('2026-11-01T03:00:00.000Z', '另一个不存在的主题', 0),
      ev('2026-11-01T04:00:00.000Z', '索引', 1, { top: 0.3 }),
    ], { now: NOW })
    assert.equal(s.total, 4)
    assert.equal(s.hits, 2)
    assert.equal(s.empty, 2)
    assert.equal(s.hitRate, 0.5)
  })

  it('缺失 hits 的老记录不计入分母（升级前的账本不该污染比率）', () => {
    const s = summarizeSearchEvents([
      { t: '2026-11-01T01:00:00.000Z', k: 'search', query: '老记录' },
      { t: '2026-11-01T02:00:00.000Z', k: 'search', query: '老记录2', hits: null },
      ev('2026-11-01T03:00:00.000Z', '索引', 1),
    ], { now: NOW })
    assert.equal(s.total, 1)
    assert.equal(s.hits, 1)
  })

  it('窗口外的记录被剔除', () => {
    const s = summarizeSearchEvents([
      ev('2026-01-01T00:00:00.000Z', '很早以前', 0),
      ev('2026-11-01T00:00:00.000Z', '最近', 1),
    ], { now: NOW, windowDays: 30 })
    assert.equal(s.total, 1)
    assert.equal(s.hits, 1)
  })

  it('非 search 事件（write/read/audit）不影响口径', () => {
    const s = summarizeSearchEvents([
      { t: '2026-11-01T00:00:00.000Z', k: 'write', track: 'daily' },
      { t: '2026-11-01T00:00:01.000Z', k: 'read', rel: 'MEMORY.md' },
      ev('2026-11-01T00:00:02.000Z', '查询', 1),
    ], { now: NOW })
    assert.equal(s.total, 1)
  })

  it('空查簇按主题聚合：同一主题换措辞问，算同一个簇', () => {
    const s = summarizeSearchEvents([
      ev('2026-11-01T00:00:00.000Z', '记忆插件打包步骤', 0),
      ev('2026-11-01T00:00:01.000Z', '打包记忆插件的步骤', 0),
      ev('2026-11-01T00:00:02.000Z', '阿里云 记忆 概念', 0),
    ], { now: NOW, tokenize })
    assert.ok(s.emptyClusters.length >= 1)
    assert.equal(s.emptyClusters[0].count, 2, JSON.stringify(s.emptyClusters))
  })

  it('低分计数：top 低于阈值才计（阈值 0 = 不统计）', () => {
    const events = [
      ev('2026-11-01T00:00:00.000Z', 'a', 1, { top: 0.1 }),
      ev('2026-11-01T00:00:01.000Z', 'b', 1, { top: 0.9 }),
      ev('2026-11-01T00:00:02.000Z', 'c', 0),
    ]
    assert.equal(summarizeSearchEvents(events, { now: NOW }).lowScore, 0)
    assert.equal(summarizeSearchEvents(events, { now: NOW, lowScore: 0.5 }).lowScore, 1)
  })

  it('平均最高分只对带分数的记录求平均', () => {
    const s = summarizeSearchEvents([
      ev('2026-11-01T00:00:00.000Z', 'a', 1, { top: 0.2 }),
      ev('2026-11-01T00:00:01.000Z', 'b', 1, { top: 0.4 }),
      ev('2026-11-01T00:00:02.000Z', 'c', 0),
    ], { now: NOW })
    assert.equal(s.avgTop, 0.3)
    assert.equal(s.unscored, 1)
  })
})

describe('clusterKey / queryTokens', () => {
  it('同一措辞得到同一 token 集合（与语序无关的部分由重叠度聚类负责）', () => {
    assert.deepEqual([...queryTokens('记忆插件打包', tokenize)], [...queryTokens('记忆插件打包', tokenize)])
    assert.equal(clusterKey('记忆插件打包', tokenize), clusterKey('记忆插件打包', tokenize))
  })

  it('中文 bigram 下换语序会改变 token 集合——所以聚类不能靠字符串相等', () => {
    assert.notEqual(clusterKey('记忆插件打包', tokenize), clusterKey('打包记忆插件', tokenize))
  })

  it(`最多取 ${CLUSTER_TOKENS} 个 token（长查询不该独占一个簇）`, () => {
    assert.ok(queryTokens('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸', tokenize).size <= CLUSTER_TOKENS)
  })

  it('空查询得到空集合与空键（不参与聚类）', () => {
    assert.equal(queryTokens('', tokenize).size, 0)
    assert.equal(clusterKey('', tokenize), '')
    assert.equal(clusterKey(null, tokenize), '')
  })
})

describe('渲染', () => {
  it('空查率 ≥50% 时给出"先别调检索参数"的口径提示', () => {
    const s = summarizeSearchEvents([
      ev('2026-11-01T00:00:00.000Z', 'a', 0),
      ev('2026-11-01T00:00:01.000Z', 'b', 0),
      ev('2026-11-01T00:00:02.000Z', 'c', 1),
    ], { now: NOW })
    const text = renderSummaryLines(s, {}).join('\n')
    assert.match(text, /空查占 67%/)
    assert.match(text, /先别调检索参数/)
  })

  it('零样本时说清楚"查过才有分母"', () => {
    const text = renderSummaryLines(summarizeSearchEvents([], { now: NOW }), {}).join('\n')
    assert.match(text, new RegExp(`近 ${DEFAULT_WINDOW_DAYS} 天没有检索记录`))
  })

  it('单条事件渲染含 hits / top / 查询式', () => {
    const line = renderSearchEvent(ev('2026-11-01T03:04:05.000Z', '索引 派生物', 2, { top: 0.4321 }))
    assert.match(line, /hits=2/)
    assert.match(line, /top=0\.4321/)
    assert.match(line, /索引 派生物/)
  })
})