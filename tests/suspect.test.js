/**
 * 「可疑记忆」的回归测试（v0.3.1：静默标记 + 延迟裁决）。
 *
 * 这一组守的是与用户讨论后拍板的四条性质：
 *  1. **标记只看证据**：碎片 / 无外部锚点（agent-inferred）/ 与既有条目冲突；
 *     **绝不看"是否与主流相悖"**——保护性内容（过敏/禁忌/合规）永不被标；
 *  2. **静默但不秘密**：不打断写入（不额外要 confirm），但落盘、可列出、可清除；
 *  3. **只在再次出现时说话**：写入相似 / 检索命中 / mem_read 才提示，且提示对象是模型；
 *  4. **标记是内容寻址 + 自动到期**：正文一改旧标记自然失效，不需要 TTL。
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import {
  bodyKey, clearMark, isFragmentBody, isProtectedBody, markSuspect,
  normalizeForMark, pruneOrphans, readMarks, recordMentions, summarizeMarks, suspectPath,
} from '../lib/suspect.js'
import { createRuntime } from '../lib/runtime.js'
import { renderIndexSnapshot, selectForIndex } from '../lib/inject.js'
import { buildPlan, estimateModelTokens, renderPlan } from '../lib/consolidate.js'
import { buildTools } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-suspect-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
let cwd
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
  cwd = mkdtempSync(join(sandbox, 'proj-'))
})

function runtimeOf(extra = {}) {
  return createRuntime({
    config: { memoryDir, coreDir, ...extra },
    logger: { info() {}, warn() {} },
  })
}

function agent() {
  return { session: { id: 'sess-suspect', header: { cwd } } }
}

/** 用真实工具定义执行一次（等价于模型调用）。 */
async function callTool(rt, name, args) {
  const definition = buildTools(rt).find((tool) => tool.name === name)
  assert.ok(definition, `工具 ${name} 应存在`)
  return String(await definition.execute(args, { agent: agent() }) ?? '')
}

/** 把记忆根下所有 Markdown 正文拼起来（断言"正本有没有被改"用）。 */
function readAllMemory(dir = memoryDir) {
  let out = ''
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name)
    if (item.isDirectory()) out += readAllMemory(full)
    else if (item.name.endsWith('.md')) out += readFileSync(full, 'utf8')
  }
  return out
}

/** 造一条扫描器形状的条目（用于 consolidate 的纯函数测试）。 */
function entry(id, body, extra = {}) {
  return {
    entryId: id,
    path: join(memoryDir, extra.rel ?? 'MEMORY.md'),
    rel: extra.rel ?? 'MEMORY.md',
    root: memoryDir,
    ordinal: extra.ordinal ?? 0,
    scope: extra.scope ?? 'global',
    track: extra.track ?? 'memory',
    projectId: extra.projectId ?? null,
    projectLabel: null,
    date: extra.date ?? '2026-01-01',
    time: null,
    stamp: null,
    recencyKey: '2026-01-01T00:00',
    summary: extra.summary ?? body.slice(0, 40),
    body,
    chars: body.length,
    bytes: Buffer.byteLength(body, 'utf8'),
    mtime: extra.mtime ?? Date.now(),
    ageDays: extra.ageDays ?? 0,
    contentHash: `hash-${id}`,
    idTag: null,
    branchTag: null,
    dshOnly: false,
    supersededBy: extra.supersededBy ?? null,
    suspect: extra.suspect ?? null,
    indexedBody: body,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('可疑标记：内容寻址 + 自动到期', () => {
  it('bodyKey 幂等：带标签/时间戳的正文与剥离后的正文得到同一个键', () => {
    const raw = '[2026-01-01 09:00] 用户偏好结论先行'
    assert.equal(bodyKey(raw), bodyKey('用户偏好结论先行'))
    assert.equal(normalizeForMark(raw), '用户偏好结论先行')
    assert.equal(normalizeForMark('  [summary:x]\n 内容  '), '内容')
  })

  it('标记 / 读取 / 清除的往返，并如实报告 created', () => {
    const body = '这条内容有点可疑'
    const first = markSuspect({ coreDir, body, reason: 'inferred', source: 'test' })
    assert.equal(first.created, true)
    const marks = readMarks(coreDir).marks
    assert.equal(Object.keys(marks).length, 1)
    assert.equal(marks[first.key].reasonText.length > 0, true)

    const again = markSuspect({ coreDir, body, reason: 'inferred' })
    assert.equal(again.created, false, '重复标记不应重复计数')
    assert.equal(Object.keys(readMarks(coreDir).marks).length, 1)

    assert.equal(clearMark({ coreDir, body }).removed, true)
    assert.equal(Object.keys(readMarks(coreDir).marks).length, 0)
    assert.equal(clearMark({ coreDir, body }).removed, false)
  })

  it('正文一改，旧标记自动作废（内容寻址 = 天然的到期机制）', () => {
    markSuspect({ coreDir, body: '旧内容', reason: 'fragment' })
    const pruned = pruneOrphans({ coreDir, entries: [entry('e1', '新内容')] })
    assert.equal(pruned.removed, 1)
    assert.equal(pruned.remaining, 0)
  })

  it('标记只记"再次出现"，不因此提升可信度', () => {
    const body = '一条被标为可疑的旧内容'
    markSuspect({ coreDir, body, reason: 'contested' })
    assert.equal(recordMentions({ coreDir, bodies: [body] }).touched, 1)
    const mark = readMarks(coreDir).marks[bodyKey(body)]
    assert.equal(mark.hits, 1)
    assert.equal(mark.reason, 'contested', '理由不会被"再次出现"改写')
    assert.equal(recordMentions({ coreDir, bodies: ['无关内容'] }).touched, 0)
  })

  it('标记文件放在派生物目录（不动记忆正本）', () => {
    markSuspect({ coreDir, body: 'x', reason: 'fragment' })
    assert.equal(suspectPath(coreDir).startsWith(memoryDir), false)
    assert.ok(readFileSync(suspectPath(coreDir), 'utf8').includes('marks'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('判据：只看证据，不看是否主流', () => {
  it('碎片启发式', () => {
    assert.equal(isFragmentBody('嗯', { minChars: 12 }), true)
    assert.equal(isFragmentBody('……？！', { minChars: 12 }), true)
    assert.equal(isFragmentBody('', { minChars: 12 }), true)
    assert.equal(isFragmentBody('用户偏好结论先行，并要求表格化呈现', { minChars: 12 }), false)
  })

  it('保护性内容永不被标（过敏/禁忌/合规这类不能按"没人再提"处理）', () => {
    const keywords = resolveConfig({}).protectedKeywords
    assert.equal(isProtectedBody('对青霉素过敏，禁止使用', keywords), true)
    assert.equal(isProtectedBody('compliance red line: 不得外发客户数据', keywords), true)
    assert.equal(isProtectedBody('今天天气不错', keywords), false)
    // 一条体系完整但"非主流"的观点**不该**被保护性规则命中，也不该被碎片规则命中
    const heterodox = '相对论与经典力学的分歧：我认为在强场下必须用弯曲时空描述，因为等效原理要求局部惯性系存在'
    assert.equal(isProtectedBody(heterodox, keywords), false)
    assert.equal(isFragmentBody(heterodox, { minChars: 12 }), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('写入路径：静默标记 + 不打扰', () => {
  it('source=agent-inferred → 自动标为可疑，且不需要额外 confirm', () => {
    const rt = runtimeOf()
    return callTool(rt, 'mem_write', {
      action: 'add', track: 'project', scope: 'project', content: '我推断这个项目下周会切到 V4 内核（没有任何依据）',
      source: 'agent-inferred',
    }).then((out) => {
      assert.match(out, /已写入/)
      assert.match(out, /静默/)
      const marks = rt.marks()
      assert.equal(Object.keys(marks).length, 1)
      assert.equal(Object.values(marks)[0].reason, 'inferred')
    })
  })

  it('碎片内容 → 标为 fragment；正常内容 → 不标', async () => {
    const rt = runtimeOf()
    await callTool(rt, 'mem_write', { action: 'add', track: 'project', scope: 'project', content: '嗯' })
    assert.equal(Object.keys(rt.marks()).length, 1)
    await callTool(rt, 'mem_write', {
      action: 'add', track: 'project', scope: 'project',
      content: '今天把记忆索引的预算从 120 行调到 36 条注入上限，实测不再溢出。',
    })
    assert.equal(Object.keys(rt.marks()).length, 1, '正常内容不应被标记')
  })

  it('保护性内容即使在 daily 轨也不会被标记', async () => {
    const rt = runtimeOf()
    const out = await callTool(rt, 'mem_write', {
      action: 'add', track: 'daily', scope: 'global', content: '用户对某药物过敏，需要记牢',
    })
    assert.match(out, /受保护内容/)
    assert.equal(Object.keys(rt.marks()).length, 0)
  })

  it('flag / verify 只动标记、不动正文，且不要求 confirm', async () => {
    const rt = runtimeOf()
    await callTool(rt, 'mem_write', { action: 'add', track: 'project', scope: 'project', content: '一条正常但值得复核的结论' })
    const before = readAllMemory()
    const flagged = await callTool(rt, 'mem_write', {
      action: 'flag', track: 'project', scope: 'project', match: '值得复核', reason: 'lowconfidence',
    })
    assert.match(flagged, /标为可疑/)
    assert.equal(Object.keys(rt.marks()).length, 1)
    const verified = await callTool(rt, 'mem_write', {
      action: 'verify', track: 'project', scope: 'project', match: '值得复核',
    })
    assert.match(verified, /标记已清除/)
    assert.equal(Object.keys(rt.marks()).length, 0)
    assert.equal(readAllMemory(), before, 'flag/verify 不得改动记忆正本一个字节')
  })

  it('再次提及：与已标记条目高度相似时提示复核，并记录"又出现了"', async () => {
    const rt = runtimeOf()
    const original = '这条结论是 AI 自己推断的，缺少外部依据，所以被标为可疑'
    await callTool(rt, 'mem_write', { action: 'add', track: 'project', scope: 'project', content: original, source: 'agent-inferred' })
    assert.equal(Object.keys(rt.marks()).length, 1)
    const again = await callTool(rt, 'mem_write', {
      action: 'add', track: 'project', scope: 'project',
      content: '这条结论是 AI 自己推断出来的，缺少外部依据，因此被标为可疑',
    })
    assert.match(again, /高度相似/)
    assert.match(again, /verify/)
    const mark = Object.values(rt.marks())[0]
    assert.ok(mark.hits >= 1, '应记录"再次出现"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('注入与检索：静默但不秘密', () => {
  it('索引行带 ⚠?，页脚给一行提示（模型看得见）', () => {
    const rt = runtimeOf()
    const snap = rt.getSnapshot({ cwd, force: true })
    void snap
    const marked = entry('m1', '一条被标为可疑的条目内容足够长', { suspect: { reason: 'inferred', reasonText: 'AI 推断', markedAt: '2026-01-01T00:00:00.000Z' } })
    const rendered = renderIndexSnapshot({
      entries: [marked, entry('m2', '一条正常的条目内容也足够长')],
      config: resolveConfig({}),
      now: Date.now(),
    })
    assert.ok(rendered.text.includes('⚠?'), '可疑条目应有可见标记')
    assert.ok(rendered.text.includes('可疑条目 1 条'))
    assert.ok(rendered.text.includes('缺证据'), '提示必须说清判据不是"与主流相悖"')
  })

  it('suspectInIndex=hide 时可疑条目不进常驻索引（仍可检索）', () => {
    const entries = [
      entry('a', '可疑条目', { suspect: { reason: 'fragment' } }),
      entry('b', '正常条目'),
    ]
    const flagged = selectForIndex(entries, { config: resolveConfig({}) })
    assert.equal(flagged.selected.length, 2)
    const hidden = selectForIndex(entries, { config: resolveConfig({ suspectInIndex: 'hide' }) })
    assert.equal(hidden.selected.length, 1)
    assert.equal(hidden.selected[0].entryId, 'b')
  })

  it('mem_search 命中可疑条目时当场提示，并记录提及', async () => {
    const rt = runtimeOf()
    writeFileSync(join(memoryDir, 'MEMORY.md'), [
      '[2026-01-01 09:00] 一条正常结论：索引是派生物，可重建。',
      '§',
      '[2026-01-01 10:00] 一条可疑结论：这个季度一定会涨（AI 推断，无依据）。',
      '',
    ].join('\n'), 'utf8')
    markSuspect({ coreDir, body: '一条可疑结论：这个季度一定会涨（AI 推断，无依据）。', reason: 'inferred' })
    const out = await callTool(rt, 'mem_search', { query: '可疑结论 季度', limit: 5 })
    assert.match(out, /⚠\?可疑/)
    assert.match(out, /曾被标为可疑/)
    const hits = Object.values(rt.marks()).map((mark) => mark.hits ?? 0)
    assert.ok(hits.some((count) => count >= 1), '检索命中应记录"再次出现"')
  })

  it('mem_read 读可疑条目时给出理由与处置建议', async () => {
    const rt = runtimeOf()
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01 10:00] 一条可疑结论：这里需要复核。\n', 'utf8')
    markSuspect({ coreDir, body: '一条可疑结论：这里需要复核。', reason: 'contested' })
    const out = await callTool(rt, 'mem_read', { pointer: 'MEMORY.md#0' })
    assert.match(out, /被标记为可疑/)
    assert.match(out, /contested/)
    assert.match(out, /不是/)
  })

  it('mem_health 有可疑条目一节（静默但可查）', async () => {
    const rt = runtimeOf()
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-01-01 10:00] 内容。\n', 'utf8')
    markSuspect({ coreDir, body: '内容。', reason: 'fragment' })
    const out = await callTool(rt, 'mem_health', {})
    assert.match(out, /## 可疑条目/)
    assert.match(out, /fragment:1/)
    assert.match(out, /不看是否与主流相悖/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('整理：标记随方案落地，保护性内容不进冷归档', () => {
  it('plan 提出 fragment 可疑标记，apply 落标记（不动正文）', () => {
    const fragments = [entry('f1', '嗯', { rel: 'MEMORY.md' })]
    const config = resolveConfig({})
    const plan = buildPlan({ entries: fragments, files: [{ rel: 'MEMORY.md' }], config, now: Date.now(), memoryDir })
    assert.equal(plan.counts.suspect, 1)
    assert.equal(plan.suspects[0].reason, 'fragment')
    assert.match(renderPlan(plan), /可疑标记/)
  })

  it('保护性内容不会被提议归档（哪怕超期且从未被检索）', () => {
    const config = resolveConfig({})
    const old = 400
    const entries = [
      entry('p1', '用户对青霉素过敏，这条要一直留着', { ageDays: old, date: '2025-01-01' }),
      entry('p2', '一条普通的旧结论，可以归档', { ageDays: old, date: '2025-01-01', ordinal: 1 }),
    ]
    const plan = buildPlan({ entries, files: [{ rel: 'MEMORY.md' }], config, now: Date.now(), memoryDir })
    const archived = plan.actions.filter((action) => action.type === 'archive').map((action) => action.entryId)
    assert.ok(!archived.includes('p1'), '受保护内容不得进入冷归档')
    assert.ok(archived.includes('p2'))
  })

  it('可疑标记进方案指纹（记忆一变，旧名单不会被照贴）', () => {
    const config = resolveConfig({})
    const a = buildPlan({ entries: [entry('f1', '嗯')], files: [{ rel: 'MEMORY.md' }], config, now: Date.now(), memoryDir })
    const b = buildPlan({ entries: [entry('f1', '嗯'), entry('x', '后续写入的新内容')], files: [{ rel: 'MEMORY.md' }], config, now: Date.now(), memoryDir })
    assert.notEqual(a.planId, b.planId)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('模型成本估算（回答"整理要是交给模型，花多少 token"）', () => {
  it('空方案 → 0 token', () => {
    const estimate = estimateModelTokens({ actions: [], contradictions: [] })
    assert.equal(estimate.chars, 0)
    assert.equal(estimate.tokens, 0)
  })

  it('有 sourceChars 的蒸馏 → 给出"若让模型重写摘要"的可选成本（中文 1 token ≈ 1.5 字符）', () => {
    const plan = { actions: [{ type: 'distill', proposedText: 'x'.repeat(5000), sourceChars: 8000 }], contradictions: [] }
    const estimate = estimateModelTokens(plan)
    assert.equal(estimate.chars, 8000)
    assert.equal(estimate.tokens, 5334)
  })

  it('没有 sourceChars 的蒸馏动作不虚报成本（旧口径拿本地草案长度充数，已修正）', () => {
    const plan = { actions: [{ type: 'distill', proposedText: 'x'.repeat(5000) }], contradictions: [] }
    assert.equal(estimateModelTokens(plan).chars, 0, '草案是本地生成的，不是送模型的量')
  })

  it('含取代提议时按两条正文之和估算', () => {
    const plan = {
      actions: [],
      contradictions: [{ keep: { body: 'y'.repeat(150) }, supersede: { body: 'z'.repeat(150) } }],
    }
    const estimate = estimateModelTokens(plan)
    assert.equal(estimate.chars, 300)
    assert.equal(estimate.tokens, 200)
  })

  it('renderPlan 的成本说明明确写"0 token"（默认机械路径）', () => {
    const config = resolveConfig({})
    const plan = buildPlan({ entries: [entry('f1', '嗯')], files: [{ rel: 'MEMORY.md' }], config, now: Date.now(), memoryDir })
    const text = renderPlan(plan)
    assert.match(text, /模型成本/)
    assert.match(text, /0 token/)
  })
})