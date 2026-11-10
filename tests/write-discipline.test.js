import test from 'node:test'
import assert from 'node:assert/strict'
import { renderIndexSnapshot } from '../lib/inject.js'

// 写入纪律（0.4.6）：这条不是"文案优化"，是 2026-11-02 S1 实测暴露的失效点——
// 模型对用户陈述只回"记下了"却不调 mem_write，后续回忆题直接答"没有记录"；
// 或者调了但不带 confirm，全部落进 QUEUE.md 候选（按设计不进常驻索引）。
test('写入纪律默认注入，且明确 confirm 与排队两种分支', () => {
  const r = renderIndexSnapshot({ entries: [], config: {}, now: Date.now() })
  assert.match(r.text, /写入纪律/)
  assert.match(r.text, /confirm=true/)
  assert.match(r.text, /source="user-stated"/)
  assert.match(r.text, /待巩固队列/)
})

test('writeDiscipline=false 时整条消失（可回退）', () => {
  const r = renderIndexSnapshot({ entries: [], config: { writeDiscipline: false }, now: Date.now() })
  assert.equal(/写入纪律/.test(r.text), false)
  assert.equal(/先写后答/.test(r.text), false)
})

// 0.4.7：页脚那条被模型当"使用说明"忽略了（S1 #1 实测 0 次工具调用），
// 所以空库时在**首位**再放一条短指令。有记忆时不再加，避免稳态成本。
test('索引为空时，首位出现「先写后答」', () => {
  const r = renderIndexSnapshot({ entries: [], config: {}, now: Date.now() })
  const lines = r.text.split('\n')
  assert.ok(lines.slice(0, 4).some(l => /先写后答/.test(l)), r.text.slice(0, 200))
})

test('索引非空时不打扰（避免每轮多付 token）', () => {
  const entries = [{
    entryId: 'a1', track: 'memory', scope: 'global', rel: 'MEMORY.md', body: 'Aster 项目编号 AST-7742',
    summary: 'Aster 编号', stamp: '2026-11-02 17:00', mtime: Date.now(), importance: 'normal', type: 'fact',
  }]
  const r = renderIndexSnapshot({ entries, config: {}, now: Date.now() })
  assert.equal(/先写后答/.test(r.text), false)
})

test('加了这一行后仍不越预算（页脚预留必须把它算进去）', () => {
  const config = { indexMaxLines: 24, indexMaxChars: 2000 }
  const r = renderIndexSnapshot({ entries: [], config, now: Date.now() })
  assert.ok(r.lines <= config.indexMaxLines, `lines=${r.lines}`)
  assert.ok(r.chars <= config.indexMaxChars, `chars=${r.chars}`)
})
