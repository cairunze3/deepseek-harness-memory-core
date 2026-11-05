/**
 * 索引层与检索层回归测试（两个后端跑同一组断言，保证降级路径不劣化）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { openIndex, INDEX_SCHEMA_VERSION } from '../lib/indexdb.js'
import { cosine, hybridSearch, importanceOf, duplicateSimilarity, containment, jaccard, noveltyOf, rrfFuse, tokenSetOf } from '../lib/retrieve.js'
import { resolveConfig } from '../lib/config.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-index-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

function entry(id, body, extra = {}) {
  return {
    entryId: id,
    path: `/mem/${extra.rel ?? 'x.md'}`,
    rel: extra.rel ?? 'x.md',
    root: '/mem',
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
    contentHash: 'hash-' + id,
    idTag: null,
    branchTag: null,
    dshOnly: false,
    indexedBody: body,
  }
}

const fileOf = (rel, entries, extra = {}) => ({
  path: `/mem/${rel}`,
  rel,
  root: '/mem',
  mtime: extra.mtime ?? Date.now(),
  size: 100,
  hash: extra.hash ?? `hash-${rel}-${extra.version ?? 1}`,
  entryCount: entries.length,
  scope: extra.scope ?? 'global',
  track: extra.track ?? 'memory',
  projectId: extra.projectId ?? null,
})

for (const backend of ['sqlite', 'json']) {
  describe(`indexdb · ${backend}`, () => {
    const dir = join(sandbox, backend)

    it('同步后可检索中文（bigram）与英文', () => {
      const index = openIndex({ dir, backend })
      assert.equal(index.kind, backend)
      const entries = [
        entry('e1', '架构决策：记忆正本继续用 Markdown，检索走 SQLite FTS5 BM25。', { track: 'key', ordinal: 0 }),
        entry('e2', '用户偏好：结论先行、表格化呈现，简体中文。', { track: 'user', ordinal: 1 }),
        entry('e3', 'unrelated note about vector databases and embeddings', { track: 'memory', ordinal: 2 }),
      ]
      const sync = index.sync(entries, [fileOf('x.md', entries)])
      assert.equal(sync.added, 3)

      const hits = index.search('架构决策', { limit: 5 })
      assert.ok(hits.length >= 1, '中文 bigram 检索应命中')
      assert.equal(hits[0].entry_id, 'e1')

      const en = index.search('embeddings', { limit: 5 })
      assert.equal(en[0].entry_id, 'e3')

      index.close()
    })

    it('检索结果带 ordinal（缺列会让指针退化成 #undefined）', () => {
      const index = openIndex({ dir, backend })
      const hits = index.search('架构决策', { limit: 1 })
      assert.equal(typeof hits[0].ordinal, 'number')
      index.close()
    })

    it('轨道 / 作用域过滤生效，且默认排除归档', () => {
      const index = openIndex({ dir, backend })
      assert.equal(index.search('架构决策', { tracks: ['user'], limit: 5 }).length, 0)
      assert.equal(index.search('架构决策', { scopes: ['project'], limit: 5 }).length, 0)
      const withArchive = index.search('架构决策', { tracks: ['key'], includeArchived: true, limit: 5 })
      assert.ok(withArchive.length >= 1)
      index.close()
    })

    it('增量同步：内容未变不重扫，内容变了重扫并替换条目', () => {
      const index = openIndex({ dir, backend })
      const before = index.stats()
      const same = index.sync([], [])  // 空文件集 → 全部视为已消失
      assert.equal(same.removed, before.entryCount)

      const v2 = [entry('e9', '新的架构决策：索引是派生物，可整份重建。', { ordinal: 0 })]
      index.sync(v2, [fileOf('x.md', v2, { version: 2 })])
      assert.ok(index.stats().entryCount >= 1)
      assert.ok(index.search('派生物', { limit: 5 }).some((hit) => hit.entry_id === 'e9'))

      // 同样的 hash → 不重扫
      const again = index.sync(v2, [fileOf('x.md', v2, { version: 2 })])
      assert.equal(again.filesIndexed, 0)
      index.close()
    })

    it('访问计数可累计，并参与统计', () => {
      const index = openIndex({ dir, backend })
      index.recordAccess(['e9'])
      index.recordAccess(['e9'])
      const counts = index.accessCounts(['e9'])
      assert.equal(counts.get('e9').count, 2)
      assert.equal(index.stats().schemaVersion, INDEX_SCHEMA_VERSION)
      index.close()
    })

    it('向量存取（后端无关）', () => {
      const index = openIndex({ dir, backend })
      index.putVectors([{ entryId: 'e9', model: 'test', vec: [0.1, 0.2, 0.3] }])
      const vectors = index.getVectors(['e9'])
      assert.deepEqual(vectors.get('e9').vec, [0.1, 0.2, 0.3])
      index.close()
    })
  })
}

describe('retrieve · 打分与融合', () => {
  it('rrfFuse 按排名融合，两路都命中的条目得分更高', () => {
    const fused = rrfFuse([
      { name: 'bm25', ids: ['a', 'b', 'c'] },
      { name: 'vector', ids: ['b', 'a'] },
    ], 60)
    assert.ok(fused.get('a').rrf > fused.get('c').rrf)
    assert.equal(fused.get('b').sources.vector, 1)
  })

  it('cosine 对长度不一致/零向量返回 0 而不是抛错', () => {
    assert.equal(cosine([1, 2], [1, 2, 3]), 0)
    assert.equal(cosine([0, 0], [1, 1]), 0)
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
  })

  it('duplicateSimilarity 用「包含度」抓住"同一条写得更啰嗦"的情形', () => {
    const short = tokenSetOf({ summary: '架构决策：检索走 BM25', body: '架构决策：检索走 BM25' })
    const long = tokenSetOf({ summary: '架构决策：检索走 BM25（重申，补充说明）', body: '架构决策：检索走 BM25（重申，补充说明）' })
    assert.ok(jaccard(short, long) < 0.9)
    assert.ok(containment(short, long) >= 0.8)
    assert.ok(duplicateSimilarity(short, long) >= 0.8)
  })

  it('importanceOf 新鲜/高权重轨得分更高，且落在 0..1', () => {
    const now = Date.parse('2026-03-01T00:00:00')
    const fresh = importanceOf({ track: 'user', date: '2026-02-28', mtime: now, chars: 50 }, { now })
    const old = importanceOf({ track: 'archive', date: '2024-01-01', mtime: now, chars: 50 }, { now })
    assert.ok(fresh > old)
    assert.ok(fresh <= 1 && old >= 0)
  })

  it('noveltyOf 对重复内容给出低分', () => {
    const a = { summary: '记忆正本继续用 Markdown', body: '记忆正本继续用 Markdown' }
    const b = { summary: '记忆正本继续用 Markdown', body: '记忆正本继续用 Markdown' }
    assert.ok(noveltyOf(b, [tokenSetOf(a)]) < 0.2)
  })

  it('hybridSearch 在无向量提供者时走纯 bm25；提供者抛错时降级而非失败', async () => {
    const index = openIndex({ dir: join(sandbox, 'hybrid'), backend: 'json' })
    const entries = [entry('h1', '记忆索引的常驻预算是硬约束。', { ordinal: 0 })]
    index.sync(entries, [fileOf('x.md', entries)])
    const config = resolveConfig({})

    const plain = await hybridSearch({ index, query: '常驻预算', config, provider: null })
    assert.equal(plain.mode, 'bm25')
    assert.equal(plain.hits.length, 1)

    const exploding = { model: 'x', dim: 2, embed: async () => { throw new Error('network down') } }
    const degraded = await hybridSearch({ index, query: '常驻预算', config, provider: exploding })
    assert.equal(degraded.mode, 'bm25')
    assert.match(degraded.vectorError, /network down/)
    assert.equal(degraded.hits.length, 1, '向量失败不应丢掉 BM25 的结果')
    index.close()
  })

  it('hybridSearch 在有向量时融合两路并标注模式', async () => {
    const index = openIndex({ dir: join(sandbox, 'hybrid2'), backend: 'json' })
    const entries = [
      entry('v1', '向量检索与语义召回的关系。', { ordinal: 0 }),
      entry('v2', 'BM25 关键词检索的局限。', { ordinal: 1 }),
    ]
    index.sync(entries, [fileOf('x.md', entries)])
    index.putVectors([
      { entryId: 'v1', model: 'test', vec: [1, 0] },
      { entryId: 'v2', model: 'test', vec: [0, 1] },
    ])
    const provider = { model: 'test', dim: 2, embed: async () => [[1, 0]] }
    const result = await hybridSearch({ index, query: '语义', config: resolveConfig({}), provider })
    assert.ok(result.mode.includes('vector'))
    assert.ok(result.hits.some((hit) => hit.sources.vector !== undefined))
    index.close()
  })
})