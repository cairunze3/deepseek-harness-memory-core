/**
 * 扫描层回归测试。
 *
 * 其中 `扫描结果不含 undefined 字段` 是一条真实的教训固化的回归：开发时
 * `classifyFile` 漏返回 `projectId`，`undefined` 流进 SQLite 绑定参数后
 * 让**整个索引静默失效**（只剩一堆 "cannot be bound" 告警，检索永远 0 命中）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  classifyFile, daysBetween, entryDateOf, ensureRootLayout, entryTimeOf, extractSummary,
  parseEntries, scanRoot, splitIntoEntries, stableEntryId, stripTags, tokenize, toMatchExpression,
} from '../lib/scanner.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-scanner-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

describe('parseEntries', () => {
  it('按 \\n§\\n 切分并丢弃空块', () => {
    assert.deepEqual(parseEntries('A\n§\nB\n§\n\n§\nC'), ['A', 'B', 'C'])
  })

  it('行内的 § 不构成分隔（正文里的「§0」不会被误切）', () => {
    assert.deepEqual(parseEntries('补全 HANDOVER.md §0 与 §9 的说明'), ['补全 HANDOVER.md §0 与 §9 的说明'])
  })
})

describe('splitIntoEntries', () => {
  it('含分隔符时，多行正文属于同一条，不再按行切碎', () => {
    const entries = splitIntoEntries('[2026-01-01 10:00] 第一行\n第二行继续\n§\n[2026-01-02 10:00] 另一条', 'x.md')
    assert.equal(entries.length, 2)
    assert.match(entries[0].body, /第二行继续/)
  })

  it('无分隔符时按时间戳分行（容错手工追加）', () => {
    const entries = splitIntoEntries('[2026-01-01 10:00] A\n[2026-01-02 11:00] B', 'x.md')
    assert.equal(entries.length, 2)
    assert.equal(entries[1].ordinal, 1)
  })

  it('无分隔符无时间戳时按 Markdown 标题分节', () => {
    const entries = splitIntoEntries('# 一\n内容一\n## 二\n内容二', 'x.md')
    assert.equal(entries.length, 2)
    assert.match(entries[0].body, /^# 一/)
  })

  it('其余情况整文件一条；空文件零条', () => {
    assert.equal(splitIntoEntries('就是一段话', 'x.md').length, 1)
    assert.equal(splitIntoEntries('   \n  ', 'x.md').length, 0)
  })
})

describe('classifyFile', () => {
  const cases = [
    ['MEMORY.md', { scope: 'global', track: 'memory', projectId: null, date: null }],
    ['USER.md', { scope: 'global', track: 'user', projectId: null, date: null }],
    ['daily/2026-01-02.md', { scope: 'global', track: 'daily', projectId: null, date: '2026-01-02' }],
    ['archive/memory-2026-01-02.md', { scope: 'global', track: 'archive', projectId: null, date: null }],
    // memory-evolve 的归档页签文件（`*-archive.md`）必须归入同一归档轨：
    // 漏掉就会让归档条目被当成普通记忆重新注入（回归：2026-10-26）
    ['MEMORY-archive.md', { scope: 'global', track: 'archive', projectId: null, date: null }],
    ['USER-archive.md', { scope: 'global', track: 'archive', projectId: null, date: null }],
    ['TODO-archive.md', { scope: 'global', track: 'archive', projectId: null, date: null }],
    ['projects/abc123/KEY-archive.md', { scope: 'project', track: 'archive', projectId: 'abc123', date: null }],
    ['projects/abc123/KEY.md', { scope: 'project', track: 'key', projectId: 'abc123', date: null }],
    ['projects/abc123/MEMORY.md', { scope: 'project', track: 'memory', projectId: 'abc123', date: null }],
    ['projects/abc123/daily/2026-01-02.md', { scope: 'project', track: 'daily', projectId: 'abc123', date: '2026-01-02' }],
  ]
  for (const [rel, expected] of cases) {
    it(`${rel} → ${expected.scope}/${expected.track}`, () => {
      assert.deepEqual(classifyFile(rel), expected)
    })
  }

  it('未知文件名回退为文件名主干，不丢数据', () => {
    assert.equal(classifyFile('notes/my-notes.md').track, 'my-notes')
  })

  it('**每个分支都必须给出 projectId**（undefined 会打挂索引）', () => {
    for (const rel of ['MEMORY.md', 'daily/2026-01-02.md', 'archive/x.md', 'a/b/c.md', 'projects/p/KEY.md']) {
      assert.ok(Object.hasOwn(classifyFile(rel), 'projectId'), rel)
      assert.notEqual(classifyFile(rel).projectId, undefined, rel)
    }
  })
})

describe('条目字段解析', () => {
  it('extractSummary 剥掉行首时间戳，避免索引行出现两个时间', () => {
    assert.equal(extractSummary('[2026-01-02 10:00] 结论：先给答案'), '结论：先给答案')
  })

  it('extractSummary 优先 [summary:…]', () => {
    assert.equal(extractSummary('[summary:一句话]\n正文很长'), '一句话')
  })

  it('entryDateOf 优先正文时间戳，其次文件名日期', () => {
    assert.equal(entryDateOf('[2026-03-04 10:00] x', '2020-01-01'), '2026-03-04')
    assert.equal(entryDateOf('没有时间戳', '2020-01-01'), '2020-01-01')
    assert.equal(entryDateOf('没有时间戳', null), null)
  })

  it('entryTimeOf 取出 HH:MM', () => {
    assert.equal(entryTimeOf('[2026-03-04 07:09] x'), '07:09')
    assert.equal(entryTimeOf('无时间'), null)
  })

  it('stripTags 去掉 id/summary 前缀但保留正文', () => {
    assert.equal(stripTags('[id:abcd1234] [summary:s] 正文'), '正文')
  })
})

describe('tokenize', () => {
  it('中文切 bigram，英文按词', () => {
    const tokens = tokenize('记忆系统 memory core')
    assert.ok(tokens.includes('记忆'))
    assert.ok(tokens.includes('忆系'))
    assert.ok(tokens.includes('memory'))
    assert.ok(tokens.includes('core'))
  })

  it('短中文串整串额外入索引（提升短语精确命中）', () => {
    assert.ok(tokenize('架构决策').includes('架构决策'))
  })

  it('去重且单字中文保留', () => {
    const tokens = tokenize('人 人')
    assert.equal(tokens.filter((t) => t === '人').length, 1)
  })

  it('toMatchExpression 生成带引号的 OR 表达式', () => {
    const expr = toMatchExpression('记忆 系统')
    assert.match(expr, /OR/)
    assert.ok(expr.includes('"'))
  })
})

describe('stableEntryId / daysBetween', () => {
  it('同文件同序同内容 → 同 id（跨扫描稳定）', () => {
    assert.equal(stableEntryId('a.md', 0, '同样的正文'), stableEntryId('a.md', 0, '同样的正文'))
    assert.notEqual(stableEntryId('a.md', 0, 'A'), stableEntryId('a.md', 1, 'A'))
  })

  it('daysBetween 向下取整且不为负', () => {
    const now = Date.parse('2026-03-10T12:00:00')
    assert.equal(daysBetween('2026-03-05', now), 5)
    assert.equal(daysBetween('2026-04-01', now), 0)
  })
})

describe('scanRoot', () => {
  it('扫描真实目录结构，且**没有任何 undefined 字段**', () => {
    const root = join(sandbox, 'memories')
    mkdirSync(join(root, 'daily'), { recursive: true })
    mkdirSync(join(root, 'projects', 'p1'), { recursive: true })
    writeFileSync(join(root, 'MEMORY.md'), '[2026-01-01 09:00] 全局事实', 'utf8')
    writeFileSync(join(root, 'daily', '2026-01-01.md'), '[2026-01-01 09:10] 日志一\n§\n[2026-01-01 09:20] 日志二', 'utf8')
    writeFileSync(join(root, 'projects', 'p1', 'KEY.md'), '[2026-01-02 09:00] 项目约定', 'utf8')
    writeFileSync(join(root, 'SUGGESTIONS.jsonl'), '{"ignored":true}', 'utf8')

    const scan = scanRoot(root, { now: Date.parse('2026-03-01T00:00:00') })
    assert.equal(scan.exists, true)
    assert.equal(scan.files.length, 3, 'jsonl 不应被索引')
    assert.equal(scan.entries.length, 4)

    for (const entry of scan.entries) {
      for (const [key, value] of Object.entries(entry)) {
        assert.notEqual(value, undefined, `${entry.rel} 的 ${key} 是 undefined`)
      }
      assert.equal(typeof entry.entryId, 'string')
      assert.ok(entry.ordinal >= 0)
    }
    const daily = scan.entries.filter((e) => e.track === 'daily')
    assert.equal(daily.length, 2)
    assert.equal(daily[0].date, '2026-01-01')
    assert.equal(daily[0].time, '09:10')
  })

  it('不存在的根返回 exists:false 而不是抛错', () => {
    const scan = scanRoot(join(sandbox, 'nope'))
    assert.equal(scan.exists, false)
    assert.deepEqual(scan.entries, [])
  })

  it('ensureRootLayout 建立最小布局，空文件不产生假条目', () => {
    const root = join(sandbox, 'fresh')
    ensureRootLayout(root)
    const scan = scanRoot(root)
    assert.equal(scan.entries.length, 0)
    assert.ok(scan.files.length >= 2)
  })
})