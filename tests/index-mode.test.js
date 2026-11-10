/**
 * tests/index-mode.test.js — 注入形态的契约：`pointer`（按需检索）vs `index`（常驻目录）。
 *
 * 钉死的核心性质：**pointer 模式的成本与记忆库规模无关**。
 * 104 条和 2000 条注入的文本长度必须几乎一样——否则"按需检索"就名不副实，
 * 退化成另一份随规模增长的常驻清单。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderPointerBlock, renderIndexSnapshot } from '../lib/inject.js'

/** 造 n 条条目（只填索引渲染需要的字段）。 */
function makeEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    entryId: `e${i}`,
    rel: `projects/abc/KEY.md`,
    ordinal: i,
    track: 'key',
    scope: 'project',
    projectId: 'abc',
    summary: `第 ${i} 条记忆的摘要`,
    date: '2026-11-03',
    time: '17:00',
    mtime: Date.now() - i * 1000,
    body: `第 ${i} 条正文`,
    chars: 20,
  }))
}

describe('pointer 模式：按需检索', () => {
  it('不注入任何条目索引行（存货清单不进输入）', () => {
    const text = renderPointerBlock({ entries: makeEntries(40), config: {} })
    assert.ok(text.includes('<memory_index'), '缺少 memory_index 块')
    assert.ok(!text.includes('GLOBAL.md#'), 'pointer 模式里出现了条目指针')
    assert.ok(!text.includes('第 0 条记忆的摘要'), 'pointer 模式里出现了条目摘要')
    assert.ok(!/^\s*-\s*\[/m.test(text), 'pointer 模式里出现了索引行')
  })

  it('成本与记忆库规模无关（104 条 vs 2000 条长度差 < 60 字符）', () => {
    const small = renderPointerBlock({ entries: makeEntries(104), config: {} })
    const large = renderPointerBlock({ entries: makeEntries(2000), config: {} })
    assert.ok(Math.abs(large.length - small.length) < 60,
      `规模从 104 涨到 2000，注入长度 ${small.length} → ${large.length}（差 ${Math.abs(large.length - small.length)}）`)
    assert.ok(small.length < 1200, `pointer 块过长：${small.length} 字符`)
  })

  it('说清楚"怎么检索"和"什么时候必须搜"', () => {
    const text = renderPointerBlock({ entries: makeEntries(10), config: {} })
    assert.ok(text.includes('mem_search'), '没有告诉模型用 mem_search')
    assert.ok(text.includes('mem_read'), '没有告诉模型用 mem_read 读全文')
    assert.ok(text.includes('不要因为"我没见过"') || text.includes('先搜一次'), '缺少"搜不到 ≠ 没发生过"的纪律')
  })

  it('空库时明说库是空的，并仍然给写入纪律', () => {
    const text = renderPointerBlock({ entries: [], config: {} })
    assert.ok(text.includes('空的'), '空库没有明说')
    assert.ok(text.includes('mem_write'), '空库没有给写入纪律')
  })

  it('统计行在末尾（条目数变化不会打掉前缀）', () => {
    const text = renderPointerBlock({ entries: makeEntries(7), config: {} })
    const lines = text.split('\n')
    assert.ok(lines.at(-2).includes('条目 7'), `统计行不在末尾：${lines.at(-2)}`)
    assert.ok(text.includes('按需检索模式'))
  })
})

describe('静默纪律：记忆动作不进回复', () => {
  // 真机三次踩到：模型先问"要不要把这条从队列晋升"（0.5.4 修），
  // 又把用户"记一下 X"这类元要求复述成清单展示（0.5.6 修），
  // 再在开头播报"我先处理这两个会话摘要，然后搜索记忆"（0.5.7 修）。
  // 用户要的是记忆**发生**，不是看它记账、也不是看它报流程。
  it('pointer 块要求静默：不宣告、不报告队列、不复述元要求', () => {
    const text = renderPointerBlock({ entries: makeEntries(10), config: {} })
    assert.ok(text.includes('静默'), '缺少静默纪律')
    assert.ok(text.includes('已记住') || text.includes('已记录'), '静默纪律没有点名要禁的措辞')
    assert.ok(text.includes('复述'), '没有禁止复述"记一下 X"这类元要求')
    assert.ok(text.includes('开头别说'), '没有禁止事前过程播报')
    assert.ok(text.includes('检索到几条'), '没有禁止报告检索统计')
  })

  it('index 模式页脚同样要求静默', () => {
    const rendered = renderIndexSnapshot({
      entries: makeEntries(20), config: {}, now: Date.now(), projectId: 'abc',
    })
    assert.ok(rendered.text.includes('静默'), 'index 模式页脚缺少静默纪律')
    assert.ok(!rendered.text.includes('不要问"要不要晋升"') === false, '丢了"不要问晋升"')
    assert.ok(rendered.text.includes('开头别说'), 'index 模式页脚没禁止事前播报')
  })

  it('抽取注入块要求"静默做完 + 不要宣告"', async () => {
    const { renderDigestBlock } = await import('../lib/session-digest.js')
    const text = renderDigestBlock({
      sessionId: 'session-x', at: Date.now(), userTurnCount: 2,
      userTurns: ['我要买净水器', '另外记一下：记录用品牌+型号的格式'],
    })
    assert.ok(text.includes('不要宣告'), '抽取块没有要求做完不要宣告')
    assert.ok(text.includes('本轮先静默做完这件事'), '丢了"静默做完再回答"的先后顺序')
    assert.ok(text.includes('开头别说'), '抽取块没禁止"我先处理摘要"这类开场白')
  })

  it('mem_extract 工具描述也禁止事前播报（源码级，防回潮）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
    assert.ok(src.includes('开头别说"我先处理摘要'), 'mem_extract 描述没禁止事前播报')
  })
})

describe('index 模式：旧行为保持不变', () => {
  it('仍然注入条目索引行', () => {
    const rendered = renderIndexSnapshot({
      entries: makeEntries(30), config: {}, now: Date.now(), projectId: 'abc', projectLabel: 'P',
    })
    assert.ok(rendered.text.includes('第 0 条记忆的摘要'), 'index 模式丢了条目行')
    assert.ok(rendered.text.includes('<memory_index>'))
    assert.ok(rendered.text.length > 200)
  })
})
