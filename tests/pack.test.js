/**
 * 「分层压缩：按月打包 + 月摘要」的回归测试（v0.3.3）。
 *
 * 守的性质：
 *  1. **只打包整月都已过热点期的月份**（半月打包会让指针与幂等性变复杂）；
 *  2. **保护性内容永不打包**（过敏/禁忌/合规…留在热区）；
 *  3. **原文不删**：从日文件移到月文件；只有"移完变空"的日文件才删；
 *  4. **月摘要带指针**，序号按打包后的位置算，`mem_read` 能命中；
 *  5. **幂等**：同一月份不会被打包两次；
 *  6. **归档轨不被注入**、**月摘要轨要被注入**（track 判定是这套分层的地基）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import {
  DIGEST_TEXT_CAP, applyPack, digestRelFor, monthOf, packRelFor, planPacks, renderDigest,
} from '../lib/pack.js'
import { scanRoot } from '../lib/scanner.js'
import { buildPlan, applyPlan } from '../lib/consolidate.js'
import { resolveConfig } from '../lib/config.js'
import { NEVER_INJECT, renderIndexSnapshot } from '../lib/inject.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-pack-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let root
let core
beforeEach(() => {
  root = mkdtempSync(join(sandbox, 'mem-'))
  core = mkdtempSync(join(sandbox, 'core-'))
})

function write(rel, text) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/** 造一个"整月都已过热点期"的 daily 月份（默认上上个月，确保整月都老）。 */
function seedOldMonth({ month = '2025-03', count = 4, extra = '' } = {}) {
  const days = Array.from({ length: count }, (_, i) => `${month}-${String(i + 2).padStart(2, '0')}`)
  for (const [i, day] of days.entries()) {
    write(join('daily', `${day}.md`), `[${day} 10:0${i % 10}] 第 ${i + 1} 条历史流水，内容是某次开发进展。${extra}\n`)
  }
  return days
}

// ─────────────────────────────────────────────────────────────────────────────
describe('路径与月份工具', () => {
  it('monthOf 只认 YYYY-MM-DD 形态的日期', () => {
    assert.equal(monthOf('2025-03-14'), '2025-03')
    assert.equal(monthOf('2025-3-4'), null)
    assert.equal(monthOf(null), null)
  })

  it('打包与摘要路径（global / project 两套）', () => {
    assert.equal(packRelFor({ scope: 'global', projectId: null }, '2025-03'), 'daily/archive/2025-03.md')
    assert.equal(packRelFor({ scope: 'project', projectId: 'abc' }, '2025-03'), 'projects/abc/daily/archive/2025-03.md')
    assert.equal(digestRelFor({ scope: 'global', projectId: null }), 'DIGEST.md')
    assert.equal(digestRelFor({ scope: 'project', projectId: 'abc' }), 'projects/abc/DIGEST.md')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('轨道判定：分层的地基', () => {
  it('打包后的月文件归入归档轨 → 不进常驻注入', () => {
    write('daily/archive/2025-03.md', '[2025-03-02 10:00] 已打包的一条历史流水。\n')
    const scan = scanRoot(root, {})
    const packed = scan.entries.find((entry) => entry.rel === 'daily/archive/2025-03.md')
    assert.ok(packed, '应按条目扫出来（仍可检索）')
    assert.equal(packed.track, 'archive', '必须归归档轨，否则分层压缩白做')
    assert.ok(NEVER_INJECT.has('archive'))
    const rendered = renderIndexSnapshot({ entries: scan.entries, config: resolveConfig({}), now: Date.now() })
    assert.ok(!rendered.text.includes('已打包的一条历史流水'), '归档条目不得进常驻索引')
  })

  it('月摘要归入 digest 轨 → 要被常驻注入', () => {
    write('DIGEST.md', `[2025-03-31 23:59] 月摘要 2025-03：4 条流水已打包到 daily/archive/2025-03.md。\n- 02日 某次开发进展 :: daily/archive/2025-03.md#0\n`)
    const scan = scanRoot(root, {})
    const digest = scan.entries.find((entry) => entry.rel === 'DIGEST.md')
    assert.equal(digest.track, 'digest')
    const rendered = renderIndexSnapshot({ entries: scan.entries, config: resolveConfig({}), now: Date.now() })
    assert.ok(rendered.text.includes('月摘要 2025-03'), '月摘要应进常驻索引（它是温区线索）')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('生成方案：只打包"整月都已过热点期"的月份', () => {
  it('整月都老 → 出一个 pack 动作，含摘要与指针', () => {
    seedOldMonth({ month: '2025-03', count: 4 })
    const scan = scanRoot(root, {})
    const config = resolveConfig({})
    const actions = planPacks({ entries: scan.entries, config, now: Date.now(), memoryDir: root })
    assert.equal(actions.length, 1)
    const action = actions[0]
    assert.equal(action.month, '2025-03')
    assert.equal(action.count, 4)
    assert.equal(action.target, 'daily/archive/2025-03.md')
    assert.equal(action.digestTarget, 'DIGEST.md')
    assert.match(action.digestText, /月摘要 2025-03/)
    assert.match(action.digestText, /daily\/archive\/2025-03\.md#0/)
    assert.match(action.digestText, /daily\/archive\/2025-03\.md#3/)
  })

  it('当月还热 → 不打包（半月打包会让指针与幂等变复杂）', () => {
    const today = new Date().toISOString().slice(0, 10)
    write(join('daily', `${today}.md`), `[${today} 10:00] 今天的流水。\n`)
    const scan = scanRoot(root, {})
    const actions = planPacks({ entries: scan.entries, config: resolveConfig({}), now: Date.now(), memoryDir: root })
    assert.equal(actions.length, 0)
  })

  it('月份里混着"仍热"的条目 → 整月都不打包', () => {
    // 造一个月：一半很老、一半是今天（模拟跨月边界的真实情况）
    const today = new Date().toISOString().slice(0, 10)
    const month = today.slice(0, 7)
    write(join('daily', `${month}-01.md`), `[${month}-01 10:00] 月初的旧流水。\n`)
    write(join('daily', `${today}.md`), `[${today} 10:00] 今天的流水。\n`)
    const scan = scanRoot(root, {})
    const actions = planPacks({ entries: scan.entries, config: resolveConfig({ dailyHotDays: 30 }), now: Date.now(), memoryDir: root })
    assert.equal(actions.filter((a) => a.month === month).length, 0, '同月里有热条目时整月跳过')
  })

  it('条目太少（低于 monthlyPackMinEntries）→ 不成包', () => {
    seedOldMonth({ month: '2025-03', count: 2 })
    const scan = scanRoot(root, {})
    const actions = planPacks({ entries: scan.entries, config: resolveConfig({ monthlyPackMinEntries: 3 }), now: Date.now(), memoryDir: root })
    assert.equal(actions.length, 0)
  })

  it('保护性内容不打包（留在热区），并在动作里如实计数', () => {
    write('daily/2025-03-02.md', '[2025-03-02 10:00] 用户对青霉素过敏，这条必须一直留在热区。\n')
    write('daily/2025-03-03.md', '[2025-03-03 10:00] 普通流水一。\n')
    write('daily/2025-03-04.md', '[2025-03-04 10:00] 普通流水二。\n')
    const scan = scanRoot(root, {})
    const actions = planPacks({ entries: scan.entries, config: resolveConfig({ monthlyPackMinEntries: 2 }), now: Date.now(), memoryDir: root })
    assert.equal(actions.length, 1)
    assert.equal(actions[0].count, 2, '只打包非保护的两条')
    assert.equal(actions[0].protectedKept, 1)
    assert.ok(!actions[0].digestText.includes('青霉素'), '摘要里不得出现保护性内容')
  })

  it('幂等：同一月份不会被打包两次', () => {
    seedOldMonth({ month: '2025-03', count: 4 })
    // 模拟"上次已经打包过"：目标文件里已有该月摘要
    write('daily/archive/2025-03.md', '[2025-03-31 23:59] 月摘要 2025-03：4 条流水已打包到 daily/archive/2025-03.md。\n')
    const scan = scanRoot(root, {})
    const actions = planPacks({ entries: scan.entries, config: resolveConfig({}), now: Date.now(), memoryDir: root })
    assert.equal(actions.filter((a) => a.month === '2025-03').length, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('月摘要文本', () => {
  it('按日期排序、序号从 startOrdinal 起、超上限截断', () => {
    const entries = [
      { date: '2025-03-05', summary: '丙', body: '丙' },
      { date: '2025-03-02', summary: '甲', body: '甲' },
      { date: '2025-03-04', summary: '乙', body: '乙' },
    ]
    const text = renderDigest({ month: '2025-03', entries, packRel: 'daily/archive/2025-03.md', startOrdinal: 7, maxBullets: 10 })
    const bullets = text.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(bullets.length, 3)
    assert.match(bullets[0], /^\- 02日 甲 :: daily\/archive\/2025-03\.md#7$/)
    assert.match(bullets[2], /#9$/)
  })

  it('条目数超上限时给出"另有 N 条"并受字符上限约束', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ date: `2025-03-${String((i % 28) + 1).padStart(2, '0')}`, summary: `条目${i}`, body: 'x' }))
    const text = renderDigest({ month: '2025-03', entries, packRel: 'daily/archive/2025-03.md', maxBullets: 5 })
    assert.match(text, /另有 35 条/)
    assert.ok(text.length <= DIGEST_TEXT_CAP + 1, '摘要不能超过字符上限（它进常驻索引）')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('执行打包', () => {
  it('移到月文件、日文件清空后删除、月摘要写入 DIGEST.md', () => {
    const days = seedOldMonth({ month: '2025-03', count: 3 })
    const scan = scanRoot(root, {})
    const config = resolveConfig({})
    const [action] = planPacks({ entries: scan.entries, config, now: Date.now(), memoryDir: root })
    const outcome = applyPack({ action, config, coreDir: core, memoryDir: root, backupDir: join(core, 'backups'), stamp: '2025-04-01' })
    assert.equal(outcome.ok, true, `打包应成功：${outcome.errors.join('；')}`)
    assert.equal(outcome.moved, 3)
    assert.equal(outcome.appended, 3)

    const packed = readFileSync(join(root, 'daily/archive/2025-03.md'), 'utf8')
    assert.equal(packed.split('\n§\n').length, 3, '三条原文都在月文件里')
    for (const day of days) assert.ok(!existsSync(join(root, 'daily', `${day}.md`)), `空日文件应被删除：${day}`)

    const digest = readFileSync(join(root, 'DIGEST.md'), 'utf8')
    assert.match(digest, /月摘要 2025-03/)
    assert.match(digest, /#0/)

    // 再扫一次：热区里不该再有这三天；月文件在归档轨
    const after = scanRoot(root, {})
    for (const day of days) assert.ok(!after.entries.some((e) => e.rel === `daily/${day}.md`))
    assert.ok(after.entries.some((e) => e.rel === 'daily/archive/2025-03.md' && e.track === 'archive'))
    assert.ok(after.entries.some((e) => e.rel === 'DIGEST.md' && e.track === 'digest'))
  })

  it('部分文件仍有条目时不删文件（只删空的）', () => {
    write('daily/2025-03-02.md', '[2025-03-02 10:00] 会被打包的一条。\n§\n[2025-03-02 11:00] 同一天稍后的另一条，也老但先看会不会被一起打包。\n')
    const scan = scanRoot(root, {})
    const config = resolveConfig({ monthlyPackMinEntries: 1 })
    const [action] = planPacks({ entries: scan.entries, config, now: Date.now(), memoryDir: root })
    // 只打包第一条（模拟"只把部分条目纳入本方案"）
    const partial = { ...action, entries: [action.entries[0]], count: 1, sourceFiles: [action.entries[0].rel] }
    const outcome = applyPack({ action: partial, config, coreDir: core, memoryDir: root, stamp: '2025-04-01' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.removedFiles.length, 0, '文件里还有条目，不能删')
    const left = readFileSync(join(root, 'daily/2025-03-02.md'), 'utf8')
    assert.match(left, /同一天稍后的另一条/)
    assert.ok(!left.includes('会被打包的一条'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('与整合方案的集成', () => {
  it('月打包开时：方案里是 pack，不是 distill（不重复处理同一批）', () => {
    seedOldMonth({ month: '2025-03', count: 4 })
    const scan = scanRoot(root, {})
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config: resolveConfig({}), now: Date.now(), memoryDir: root })
    assert.equal(plan.counts.pack, 1)
    assert.equal(plan.counts.distill, 0, '打包已接管超期 daily，不该再蒸馏一次')
    assert.ok(plan.notes.some((note) => note.includes('按月打包')))
  })

  it('planId 随月份内容变化（保证执行的一定是看过的那份）', () => {
    seedOldMonth({ month: '2025-03', count: 4 })
    const config = resolveConfig({})
    const a = buildPlan({ entries: scanRoot(root, {}).entries, files: [], config, now: Date.now(), memoryDir: root })
    write('daily/2025-03-09.md', '[2025-03-09 10:00] 又多了一条历史流水。\n')
    const b = buildPlan({ entries: scanRoot(root, {}).entries, files: [], config, now: Date.now(), memoryDir: root })
    assert.notEqual(a.planId, b.planId)
  })

  it('apply 走三道闸门后真的落地（pack 动作被执行）', () => {
    seedOldMonth({ month: '2025-03', count: 4 })
    const scan = scanRoot(root, {})
    const config = resolveConfig({})
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    const outcome = applyPlan({
      plan, config, coreDir: core, memoryDir: root, entries: scan.entries, files: scan.files,
      confirm: true, backupDir: join(core, 'backups'),
    })
    assert.equal(outcome.ok, true, JSON.stringify(outcome.errors))
    assert.ok(outcome.applied.some((item) => item.type === 'pack' && item.month === '2025-03'))
    assert.ok(existsSync(join(root, 'DIGEST.md')))
    assert.ok(existsSync(join(root, 'daily/archive/2025-03.md')))
  })
})