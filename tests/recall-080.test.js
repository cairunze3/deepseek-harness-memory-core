import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderPointerBlock } from '../lib/inject.js'
import { buildTools } from '../lib/tools.js'
import { TOOL_NAMES } from '../lib/tool-names.js'
import { resolveInjectionMode } from '../lib/index.js'

function entry(over = {}) {
  return {
    entryId: over.entryId ?? 'e1',
    rel: over.rel ?? 'GLOBAL.md',
    ordinal: over.ordinal ?? 0,
    track: over.track ?? 'global',
    scope: over.scope ?? 'global',
    projectId: over.projectId ?? null,
    summary: over.summary ?? '核心记忆',
    body: over.body ?? over.summary ?? '核心记忆',
    date: over.date ?? '2026-11-09',
    time: over.time ?? '10:00',
    mtime: over.mtime ?? Date.now(),
    chars: 20,
    ...over,
  }
}

describe('pointer 核心记忆预取（0.8.0）', () => {
  const entries = [
    entry({ entryId: 'g', summary: '身份：结论先行', rel: 'GLOBAL.md', ordinal: 0 }),
    entry({
      entryId: 'k1', track: 'key', scope: 'project', projectId: 'p1',
      rel: 'projects/p1/KEY.md', ordinal: 0, summary: '项目约定：锁内重读',
    }),
    entry({
      entryId: 'k2', track: 'key', scope: 'project', projectId: 'p2',
      rel: 'projects/p2/KEY.md', ordinal: 0, summary: '别的项目约定',
    }),
    entry({ entryId: 'd', track: 'daily', rel: 'daily/2026-11-09.md', ordinal: 0, summary: '今天的流水' }),
    entry({ entryId: 'q', track: 'queue', rel: 'QUEUE.md', ordinal: 0, summary: '待确认候选' }),
  ]

  it('默认自动预取 2 条核心记忆，只含 global/user/当前项目 key', () => {
    const text = renderPointerBlock({ entries, config: {}, projectId: 'p1' })
    assert.ok(text.includes('自动预取 2 条核心记忆'), text.slice(0, 200))
    assert.ok(text.includes('GLOBAL.md#0'))
    assert.ok(text.includes('projects/p1/KEY.md#0'))
    assert.ok(!text.includes('projects/p2/KEY.md#0'), '别的项目的 key 不该泄露')
    assert.ok(!text.includes('daily/2026-11-09.md#0'), 'daily 不该进核心预取')
    assert.ok(!text.includes('QUEUE.md#0'), 'queue 不该进核心预取')
  })

  it('pointerRecallTopN=0 回到“不预载任何条目”的旧契约', () => {
    const text = renderPointerBlock({ entries, config: { pointerRecallTopN: 0 }, projectId: 'p1' })
    assert.ok(text.includes('不预载任何记忆条目'))
    assert.ok(!text.includes('自动预取'))
    assert.ok(!text.includes('GLOBAL.md#0'))
  })

  it('预取条数受 pointerRecallTopN 限制', () => {
    const text = renderPointerBlock({ entries, config: { pointerRecallTopN: 1 }, projectId: 'p1' })
    assert.ok(text.includes('自动预取 1 条核心记忆'))
    const pointers = text.match(/::\s+\S+#\d+/g) ?? []
    assert.equal(pointers.length, 1)
  })

  it('projectId 未知时不预取项目 key（避免跨项目污染）', () => {
    const text = renderPointerBlock({ entries, config: {}, projectId: null })
    assert.ok(!text.includes('projects/p1/KEY.md#0'))
    assert.ok(!text.includes('projects/p2/KEY.md#0'))
  })
})

describe('auto 注入形态（0.8.0）', () => {
  it('小库走 index，大库走 pointer，空库走 pointer', () => {
    assert.equal(resolveInjectionMode([], { indexMode: 'auto' }), 'pointer')
    assert.equal(resolveInjectionMode([1, 2, 3], { indexMode: 'auto', autoIndexMaxEntries: 10 }), 'index')
    assert.equal(resolveInjectionMode(Array.from({ length: 11 }, (_, i) => i), { indexMode: 'auto', autoIndexMaxEntries: 10 }), 'pointer')
    assert.equal(resolveInjectionMode([1], { indexMode: 'pointer' }), 'pointer')
    assert.equal(resolveInjectionMode([1], { indexMode: 'index' }), 'index')
  })
})

describe('工具名单单一来源（0.8.0）', () => {
  it('buildTools 注册顺序与 TOOL_NAMES 完全一致（不再出现 docs 9 / audit 7）', () => {
    const tools = buildTools({})
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_NAMES)
    assert.equal(TOOL_NAMES.length, 10)
  })
})
describe('pointer 预取质量（0.8.1）', () => {
  function core(over = {}) {
    return {
      entryId: over.entryId ?? 'e', rel: over.rel ?? 'GLOBAL.md', ordinal: over.ordinal ?? 0,
      track: over.track ?? 'global', scope: over.scope ?? 'global', projectId: over.projectId ?? null,
      summary: over.summary ?? '## 槽', body: over.body ?? '## 槽\n值', date: over.date,
      time: over.time, mtime: Date.now(), chars: 20, ...over,
    }
  }

  it('GLOBAL 槽位显示槽值，不出现空日期分隔，且最多预取 1 个 global', () => {
    const entries = Array.from({ length: 8 }, (_, i) => core({
      entryId: `g${i}`, summary: `## 槽${i}`, body: `## 槽${i}\n值${i}`, rel: 'GLOBAL.md', ordinal: i,
    }))
    entries.push(core({
      entryId: 'k', track: 'key', scope: 'project', projectId: 'p1', rel: 'projects/p1/KEY.md',
      summary: '项目约定', body: '[2026-11-09 10:00] 项目约定：锁内重读', date: '2026-11-09',
    }))
    const text = renderPointerBlock({ entries, config: {}, projectId: 'p1' })
    assert.equal((text.match(/^- \[global\]/gm) ?? []).length, 1, 'GLOBAL 槽位挤占了项目 key')
    assert.ok(text.includes('projects/p1/KEY.md#0'), '项目 key 没有被预取')
    assert.ok(text.includes('值'), 'GLOBAL 槽值没有显示')
    assert.ok(!text.includes('—  ::'), '出现了空日期分隔')
  })

  it('口令/密钥类条目不自动预取（仍可显式 mem_read）', () => {
    const entries = [
      core({ entryId: 'g', summary: '## 身份', body: '## 身份\n普通用户', rel: 'GLOBAL.md' }),
      core({
        entryId: 'k', track: 'key', scope: 'project', projectId: 'p1', rel: 'projects/p1/KEY.md',
        summary: '回滚口令', body: '[2026-11-09 10:00] 回滚口令 rollback-evergreen-77', date: '2026-11-09',
      }),
    ]
    const text = renderPointerBlock({ entries, config: {}, projectId: 'p1' })
    assert.ok(!text.includes('rollback-evergreen-77'), '口令被自动注入了')
    assert.ok(text.includes('普通用户'), '普通核心记忆应保留预取')
  })
})