/**
 * 整合（dream）与安全写入原语的回归测试。
 *
 * 这里守的是**不可逆方向**的约束：删除/覆盖必须被三道闸门挡住。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { applyPlan, buildPlan, dueInfo, planIdOf, readState, writeState } from '../lib/consolidate.js'
import { appendEntry, readChunks, removeEntries, replaceEntry, targetRelFor, validateScopeRouting, archiveRelFor } from '../lib/memfile.js'
import { withLock, readLockInfo } from '../lib/lock.js'
import { resolveConfig, DEFAULTS } from '../lib/config.js'
import { dateStamp } from '../lib/fsutil.js'
import { scanRoot, ENTRY_DELIMITER } from '../lib/scanner.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-consolidate-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

const today = dateStamp()
const daysAgo = (n) => dateStamp(new Date(Date.now() - n * 86_400_000))

let root
let core
beforeEach(() => {
  root = mkdtempSync(join(sandbox, 'mem-'))
  core = mkdtempSync(join(sandbox, 'core-'))
})

function write(rel, text) {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

describe('config', () => {
  it('未知键保留，已知键钳制与枚举校验', () => {
    const config = resolveConfig({
      indexMaxLines: 99_999,
      overflowPolicy: 'nonsense',
      futureKey: 'keep-me',
      memoryDir: '~/somewhere',
    })
    assert.equal(config.indexMaxLines, 1000)
    assert.equal(config.overflowPolicy, DEFAULTS.overflowPolicy)
    assert.equal(config.futureKey, 'keep-me')
    assert.ok(config.memoryDir.includes('somewhere'))
  })

  it('stalenessWarnDays 不会低于 stalenessDays', () => {
    assert.equal(resolveConfig({ stalenessDays: 100, stalenessWarnDays: 10 }).stalenessWarnDays, 100)
  })
})

describe('memfile · 安全写入', () => {
  it('追加保持既有分隔符形态', () => {
    const file = join(root, 'MEMORY.md')
    writeFileSync(file, `A${ENTRY_DELIMITER}B\n`, 'utf8')
    appendEntry(file, 'C', {})
    const { chunks, mode } = readChunks(file)
    assert.equal(mode, 'delimiter')
    assert.deepEqual(chunks, ['A', 'B', 'C'])
  })

  it('原来用时间戳行的文件不会被改成 § 格式', () => {
    const file = join(root, 'plain.md')
    writeFileSync(file, '[2026-01-01 09:00] A\n', 'utf8')
    appendEntry(file, '[2026-01-02 09:00] B', {})
    const text = readFileSync(file, 'utf8')
    assert.ok(!text.includes('§'), '不得引入原文件没有的分隔符')
    assert.equal(readChunks(file).chunks.length, 2)
  })

  it('removeEntries 只做精确匹配，不做相似删除', () => {
    const file = join(root, 'r.md')
    writeFileSync(file, `完全一致的内容${ENTRY_DELIMITER}完全一致的内容（多了一句）\n`, 'utf8')
    const outcome = removeEntries(file, ['完全一致的内容'], {})
    assert.equal(outcome.removed, 1)
    assert.equal(readChunks(file).chunks.length, 1)
  })

  it('replaceEntry 精确替换并返回计数', () => {
    const file = join(root, 'p.md')
    writeFileSync(file, `旧内容${ENTRY_DELIMITER}其他\n`, 'utf8')
    assert.equal(replaceEntry(file, '旧内容', '新内容', {}).replaced, 1)
    assert.deepEqual(readChunks(file).chunks, ['新内容', '其他'])
  })

  // 回归（2026-11-02）：写入侧切块必须与 scanner 一致，否则"按索引匹配到 A、
  // 却在文件里改写 B"。标签行（`[summary:…]`）是下一条目的前缀，不能独立成块。
  it('标签行不独立成块，replace 只替换目标条目', () => {
    const file = join(root, 'key.md')
    writeFileSync(file, [
      '[summary:A 的摘要]',
      '[2026-11-02 10:00] A 的正文',
      '[summary:B 的摘要]',
      '[2026-11-02 11:00] B 的正文',
    ].join('\n') + '\n', 'utf8')

    const { chunks, mode } = readChunks(file)
    assert.equal(mode, 'stamp')
    assert.equal(chunks.length, 2)
    assert.ok(!chunks[0].includes('B 的摘要'))

    const outcome = replaceEntry(file, chunks[0], '[2026-11-02 10:00] A 的新正文', {})
    assert.equal(outcome.replaced, 1)
    const after = readFileSync(file, 'utf8')
    assert.match(after, /A 的新正文/)
    assert.match(after, /\[summary:B 的摘要\]/, 'B 的摘要必须还在，且未被粘到 A 条目上')
    assert.equal(readChunks(file).chunks.length, 2)
  })

  it('pinned type 校验：user 不许进项目、key 不许进根、scope 与目录必须一致', () => {
    assert.equal(validateScopeRouting({ scope: 'project', track: 'user' }, 'projects/p/USER.md').ok, false)
    assert.equal(validateScopeRouting({ scope: 'project', track: 'key' }, 'KEY.md').ok, false)
    assert.equal(validateScopeRouting({ scope: 'global', track: 'memory' }, 'projects/p/MEMORY.md').ok, false)
    assert.equal(validateScopeRouting({ scope: 'project', track: 'key' }, 'projects/p/KEY.md').ok, true)
    assert.equal(validateScopeRouting({ scope: 'global', track: 'user' }, 'USER.md').ok, true)
  })

  it('targetRelFor / archiveRelFor 给出稳定路径', () => {
    assert.equal(targetRelFor({ scope: 'global', track: 'user' }, { today }), 'USER.md')
    assert.equal(targetRelFor({ scope: 'global', track: 'daily', date: '2026-01-01' }, { today }), 'daily/2026-01-01.md')
    assert.equal(targetRelFor({ scope: 'project', track: 'key', projectId: 'p1' }, { today }), 'projects/p1/KEY.md')
    // 归档命名与 dsh-memory-evolve 的 ArchiveStore.fileOf 逐字对齐——不对齐
    // 时归档内容在对方的记忆 Tab 归档页里看不见（回归：2026-10-26）
    assert.equal(archiveRelFor({ scope: 'global', track: 'memory' }, { today }), 'MEMORY-archive.md')
    assert.equal(archiveRelFor({ scope: 'global', track: 'user' }, { today }), 'USER-archive.md')
    assert.equal(archiveRelFor({ scope: 'project', track: 'key', projectId: 'p1' }, { today }), 'projects/p1/KEY-archive.md')
    // 对方没有对应页签的轨保持私名（按日分文件，含义可辨）
    assert.equal(archiveRelFor({ scope: 'global', track: 'daily' }, { today }), `archive/daily-${today}.md`)
    assert.equal(archiveRelFor({ scope: 'project', track: 'project', projectId: 'p1' }, { today }), `projects/p1/archive/project-${today}.md`)
    // 缺 projectId 时不许拼出 projects/undefined/… 这种越界路径
    assert.equal(archiveRelFor({ scope: 'global', track: 'key' }, { today }), `archive/key-${today}.md`)
  })
})

describe('lock', () => {
  it('临界区执行并释放锁', () => {
    const lockPath = join(core, 'x.lock')
    const outcome = withLock(lockPath, () => 42)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value, 42)
    assert.equal(existsSync(lockPath), false)
  })

  it('持锁方进程已消失时回收陈旧锁', () => {
    const lockPath = join(core, 'stale.lock')
    // 伪造一个"已死进程"持有的锁
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'local', startedAt: Date.now() }), 'utf8')
    const outcome = withLock(lockPath, () => 'recovered', { timeoutMs: 2000 })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value, 'recovered')
  })

  it('异常时也释放锁（不留下死锁）', () => {
    const lockPath = join(core, 'throw.lock')
    assert.throws(() => withLock(lockPath, () => { throw new Error('boom') }))
    assert.equal(existsSync(lockPath), false)
  })
})

describe('consolidate · 计划', () => {
  function fixture() {
    write('MEMORY.md', [
      `[${daysAgo(400)} 10:00] 旧结论：已被推翻的历史判断。`,
      ENTRY_DELIMITER,
      `[${daysAgo(2)} 10:00] 现行结论：记忆索引是派生物，可整份重建。`,
    ].join('') + '\n')
    write(join('daily', `${daysAgo(60)}.md`), `[${daysAgo(60)} 11:00] 很久以前的日志。\n`)
    write(join('projects', 'p1', 'KEY.md'), [
      `[${daysAgo(5)} 10:00] 架构决策：检索走 BM25。`,
      ENTRY_DELIMITER,
      `[${daysAgo(4)} 09:00] 架构决策：检索走 BM25（重申，补充说明）。`,
    ].join('') + '\n')
  }

  it('识别近重复 / 蒸馏 / 冷归档 / 复核项（蒸馏模式：monthlyPackEnabled=false）', () => {
    fixture()
    const scan = scanRoot(root, {})
    // 分层压缩默认开，会接管"超期 daily"（打包而不是蒸馏）；
    // 这条用例专门验蒸馏机制，所以显式关掉打包。
    const config = resolveConfig({ monthlyPackEnabled: false })
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryRoot: root, memoryDir: root })
    assert.equal(plan.counts.merge, 1, '超集式重复应被识别')
    assert.equal(plan.counts.distill, 1)
    assert.ok(plan.counts.archive >= 1, '400 天且从未命中的条目应进入归档候选')
    assert.equal(plan.counts.review, 1, '400 天的条目同时是一条人工复核项')
    assert.ok(plan.planId.length >= 8)
  })

  it('planId 随内容变化而定（保证"看过的那份"才可执行）', () => {
    fixture()
    const scan = scanRoot(root, {})
    const config = resolveConfig({})
    const a = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    const b = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    assert.equal(a.planId, b.planId, '同输入同时间应稳定')
    const c = buildPlan({ entries: scan.entries.slice(1), files: scan.files, config, now: Date.now(), memoryDir: root })
    assert.notEqual(a.planId, c.planId)
  })

  it('被检索命中过的条目不再进入归档候选（遗忘链尊重访问频次）', () => {
    fixture()
    const scan = scanRoot(root, {})
    const todays = scan.entries.filter((e) => String(e.summary).includes('旧结论'))
    const accessCounts = new Map(todays.map((e) => [e.entryId, { count: 3, last_access: Date.now() }]))
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config: resolveConfig({}), now: Date.now(), accessCounts, memoryDir: root })
    assert.equal(plan.counts.archive, 0)
  })

  it('dueInfo 三重闸门：关掉就不到期；新增不足不到期', () => {
    const config = resolveConfig({ consolidateMinHours: 24, consolidateMinSessions: 5 })
    assert.equal(dueInfo({ state: { lastConsolidatedAt: Date.now() - 1000, lastEntryCount: 0 }, entryCount: 10, config }).due, false)
    assert.equal(dueInfo({ state: { lastConsolidatedAt: Date.now() - 48 * 3600_000, lastEntryCount: 9 }, entryCount: 10, config }).due, false)
    assert.equal(dueInfo({ state: { lastConsolidatedAt: 0, lastEntryCount: 0 }, entryCount: 10, config }).due, true)
    assert.equal(dueInfo({ state: {}, entryCount: 0, config }).due, false)
  })

  it('readState / writeState 往返（含 lastEntryCount）', () => {
    writeState(core, { lastConsolidatedAt: 123, lastPlanId: 'abc', lastEntryCount: 7, appliedTotal: 2, history: [] })
    const state = readState(core)
    assert.equal(state.lastEntryCount, 7)
    assert.equal(state.lastPlanId, 'abc')
  })
})

describe('consolidate · 应用（三道闸门）', () => {
  function applyFixture() {
    write('MEMORY.md', [
      `[${daysAgo(400)} 10:00] 旧结论：已被推翻的历史判断。`,
      ENTRY_DELIMITER,
      `[${daysAgo(2)} 10:00] 现行结论：索引是派生物。`,
    ].join('') + '\n')
    write(join('projects', 'p1', 'KEY.md'), [
      `[${daysAgo(5)} 10:00] 架构决策：检索走 BM25。`,
      ENTRY_DELIMITER,
      `[${daysAgo(4)} 09:00] 架构决策：检索走 BM25（重申，补充说明）。`,
    ].join('') + '\n')
    return scanRoot(root, {})
  }

  function base(scan) {
    const config = resolveConfig({})
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    return { config, plan, args: { plan, planId: plan.planId, config, coreDir: core, memoryDir: root, entries: scan.entries, files: scan.files } }
  }

  it('没有 confirm 一律拒绝', () => {
    const scan = applyFixture()
    const { args } = base(scan)
    const outcome = applyPlan({ ...args, confirm: false })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /confirm/)
    assert.equal(outcome.applied.length, 0)
  })

  it('planId 不匹配一律拒绝（记忆已变过）', () => {
    const scan = applyFixture()
    const { args } = base(scan)
    const outcome = applyPlan({ ...args, planId: 'deadbeef', confirm: true })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /planId|已过期/)
  })

  it('记忆在计划之后变化 → 方案指纹失配 → 拒绝执行', () => {
    const scan = applyFixture()
    const { args } = base(scan)
    const mutated = [...scan.entries, { ...scan.entries[0], entryId: 'newone', rel: 'NEW.md', body: '新增条目', ordinal: 0 }]
    const outcome = applyPlan({ ...args, entries: mutated, confirm: true })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /方案已过期/)
  })

  it('confirm 通过时执行合并与归档：合并只移除重复、归档是移动不是删除、原文件有备份', () => {
    const scan = applyFixture()
    const { args } = base(scan)
    const outcome = applyPlan({ ...args, confirm: true })
    assert.equal(outcome.ok, true, JSON.stringify(outcome.errors))
    assert.ok(outcome.applied.some((a) => a.type === 'merge'))
    assert.ok(outcome.applied.some((a) => a.type === 'archive'))

    const key = readFileSync(join(root, 'projects', 'p1', 'KEY.md'), 'utf8')
    // 保留的是**更新的那条**（同义重述）；merge 现在把被合并那条的原文**并入**保留条目
    // （零信息丢失），所以它的文字仍在同一块里，但不再有独立的第二条。
    assert.ok(key.includes('重申，补充说明'), '保留更新的一条')
    assert.ok(key.includes('检索走 BM25。'), '被合并条目的原文并入保留条目（不丢信息）')
    assert.ok(key.includes('合并补充'), '并入处带"合并补充"标记')
    assert.equal(readChunks(join(root, 'projects', 'p1', 'KEY.md')).chunks.length, 1, '合并后只剩一条')

    const archiveFile = join(root, 'MEMORY-archive.md')
    assert.ok(existsSync(archiveFile), '归档落到 memory-evolve 的归档页签文件上')
    const archived = readFileSync(archiveFile, 'utf8')
    assert.ok(archived.includes('已被推翻的历史判断'), '归档内容保留而不是删除')
    // 单条归档时文件里本就没有分隔符（对方的 serializeEntries 同样如此）；
    // 「多条必须 § 分隔」由下面的跨插件契约用例钉住。
    assert.equal(readChunks(archiveFile).chunks.length, 1, '归档文件可被读回为一条')

    const memory = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    assert.ok(!memory.includes('已被推翻的历史判断'), '主轨里的冷条目已移出')
    assert.ok(existsSync(join(core, 'backups')), '备份目录已建')
    assert.ok(readState(core).lastConsolidatedAt > 0, '状态已更新')
  })

  it('采纳模型撰写的蒸馏文本（质量来自模型，机制来自代码）', () => {
    write(join('daily', `${daysAgo(60)}.md`), `[${daysAgo(60)} 11:00] 很久以前的日志。\n`)
    const scan = scanRoot(root, {})
    // 蒸馏路径：显式关掉分层压缩（它默认开，会把这批超期日志打包而不是蒸馏）
    const config = resolveConfig({ monthlyPackEnabled: false })
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    assert.equal(plan.counts.distill, 1)
    const target = plan.actions.find((a) => a.type === 'distill').target
    const outcome = applyPlan({
      plan, planId: plan.planId, config, coreDir: core, memoryDir: root,
      entries: scan.entries, files: scan.files, confirm: true,
      distilledText: { [target]: '模型撰写的蒸馏结论：历史日志已收敛为一条结论。' },
    })
    assert.equal(outcome.ok, true)
    assert.ok(readFileSync(join(root, target), 'utf8').includes('模型撰写的蒸馏结论'))
  })

  it('默认不删除原始日志；deleteSource=true 才删', () => {
    write(join('daily', `${daysAgo(60)}.md`), `[${daysAgo(60)} 11:00] 很久以前的日志。\n`)
    const scan = scanRoot(root, {})
    const config = resolveConfig({})
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root })
    applyPlan({ plan, planId: plan.planId, config, coreDir: core, memoryDir: root, entries: scan.entries, files: scan.files, confirm: true })
    assert.ok(existsSync(join(root, 'daily', `${daysAgo(60)}.md`)), '默认保留源日志')
  })
})

/**
 * 与 dsh-memory-evolve 的**跨插件契约**（2026-10-26 用户拍板对齐归档命名）。
 *
 * 对方读归档用 `parseEntries`（= `split('\n§\n')`），只认 §；而本插件的
 * `appendEntry` 在别的文件上是"保留既有形态"的。若归档文件也按时间戳行写，
 * 对方界面上两条会并成一条（点"移回主记忆"时整块搬回主轨）——所以这里既
 * 钉住格式，也钉住"归档轨不会被当成普通记忆重新注入"。
 */
describe('归档文件与 memory-evolve 的格式契约', () => {
  it('同名的 *-archive.md 一律按 § 落盘，对方能解析成多条', () => {
    const file = join(root, 'MEMORY-archive.md')
    appendEntry(file, '[2026-01-01 10:00] 第一条被归档的旧结论。', {})
    appendEntry(file, '[2026-01-02 10:00] 第二条被归档的旧结论。', {})

    assert.equal(readChunks(file).mode, 'delimiter')
    const raw = readFileSync(file, 'utf8')
    assert.ok(raw.includes(ENTRY_DELIMITER), '条目之间必须有 § 分隔符')
    assert.equal(raw.split(ENTRY_DELIMITER).map((s) => s.trim()).filter((s) => s !== '').length, 2)
  })

  it('非归档文件仍严格保留既有形态（时间戳行不会被打成 §）', () => {
    mkdirSync(join(root, 'daily'), { recursive: true })
    const file = join(root, 'daily', '2026-01-01.md')
    writeFileSync(file, '[2026-01-01 09:00] 一条\n', 'utf8')
    appendEntry(file, '[2026-01-01 10:00] 又一条', {})
    assert.equal(readChunks(file).mode, 'stamp')
    assert.ok(!readFileSync(file, 'utf8').includes(ENTRY_DELIMITER))
  })

  it('归档文件在扫描里是 archive 轨（默认不召回、不会重新注入）', () => {
    appendEntry(join(root, 'MEMORY-archive.md'), '[2026-01-01 10:00] 冷条目：已被推翻的判断。', {})
    const scan = scanRoot(root, {})
    assert.equal(scan.entries.filter((e) => e.track === 'archive').length, 1)
    assert.equal(scan.entries.filter((e) => e.track === 'memory').length, 0, '归档不许被当成 MEMORY 轨')
  })

  it('名称相近的普通文件不误判为归档（只有 *-archive 后缀算）', () => {
    assert.notEqual(scanTrack('archive-notes.md'), 'archive')
    assert.notEqual(scanTrack('my-archive-old.md'), 'archive')
  })
})

/** 造一个单文件记忆根并取它的 track（只用于上面那条边界断言）。 */
function scanTrack(rel) {
  const dir = mkdtempSync(join(sandbox, 'one-'))
  writeFileSync(join(dir, rel), '[2026-01-01 10:00] x\n', 'utf8')
  return scanRoot(dir, {}).entries[0]?.track
}