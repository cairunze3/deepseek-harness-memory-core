/**
 * 存储接管与注入归一化的回归测试。
 *
 * 这一组测试守的是"存储逻辑换新"这件事的**可验证判据**（见设计文档 §接管验收）：
 *  1. 写入原语真的在跨进程锁里做"锁内重读"（并发不丢条、取不到锁如实失败）；
 *  2. 与 dsh-memory-evolve 的目录锁互操作（它写的时候我们不写）；
 *  3. 每轮写入交接提醒按会话分段、写入即归零、且只输出阈值布尔；
 *  4. 会话身份行与对方的格式逐字一致（广播/协作流程读它）；
 *  5. 注入文本被净化（一条记忆不该有能力让整个会话起不来）；
 *  6. `mem_audit` 能回答"到底谁在管存储"，并对"两套注入同时在跑"如实报警。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { appendEntry, LEGACY_LOCK_NAME, removeEntries, replaceEntry, withFileWriteLock, WRITE_LOCK_TIMEOUT_MS } from '../lib/memfile.js'
import { buildAudit, renderAudit, PASS, WARN } from '../lib/audit.js'
import { renderIndexSnapshot, renderSessionLine, renderWriteHint, sanitizeIndexText, NEVER_INJECT } from '../lib/inject.js'
import { createRuntime } from '../lib/runtime.js'
import { apply, renderSnapshotFor } from '../lib/index.js'
import { patchProfileYaml, main as applyProfileConfig, DESIRED_CONFIG } from '../scripts/apply-profile-config.mjs'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-authority-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
// 单元测试不许碰本机真实宿主：不隔离 dshHome 时 sessionDigestOnce 会去读 ~/.dsh
// 里真实的历史会话，用例结果随机器上"有没有旧会话"漂移（449/450 那次失败就是证据）。
let dshHome
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
  dshHome = mkdtempSync(join(sandbox, 'dsh-'))
})

/** 造一个最简 agent（只有 cwd 与 session.id，够 runtime 用）。 */
function agent(id, cwd = null) {
  return { session: { id, header: cwd ? { cwd } : {} } }
}

/**
 * 造一个"确实能被端出摘要"的上一会话（多帧 zstd 的真实格式）。
 * 有了它，`emptyIndexHint=false` 的空串断言才有牙齿：否则本机恰好没有可抽会话时，
 * 缺陷代码也会返回空串，测试会假通过。
 */
function writePendingSession(id, text) {
  const dir = join(dshHome, 'sessions', '--C-demo-proj--', id)
  mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'session', id, createdAt: Date.now() },
    { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' } },
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')))
  const at = Date.now() - 60_000
  utimesSync(file, new Date(at), new Date(at))
  return file
}

function readEntries(file) {
  return readFileSync(file, 'utf8').split('\n§\n').map((chunk) => chunk.trim()).filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('写原语：跨进程锁与锁内重读', () => {
  it('取不到锁时如实失败，且一个字节都不改', () => {
    const file = join(memoryDir, 'MEMORY.md')
    writeFileSync(file, '[2026-01-01] 原有条目\n', 'utf8')
    const before = readFileSync(file, 'utf8')

    // 先把目标文件的锁占住（模拟另一个进程正在写）。
    const lockPath = join(memoryDir, '.MEMORY.md.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now() }), 'utf8')

    const outcome = withFileWriteLock(file, () => ({ ok: true }), { lockTimeoutMs: 50 })
    assert.equal(outcome.locked, false, '应当报告未取得锁')
    assert.match(outcome.reason, /未能取得文件锁/)
    assert.equal(readFileSync(file, 'utf8'), before, '未取得锁时不能改动文件')

    unlinkSync(lockPath)
  })

  it('锁不可重入：被自己占住时如实失败，且文件一个字节不改', () => {
    const file = join(memoryDir, 'MEMORY.md')
    writeFileSync(file, 'A\n§\nB\n', 'utf8')
    const before = readFileSync(file, 'utf8')
    const lockPath = join(memoryDir, '.MEMORY.md.lock')
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now(),
    }), 'utf8')
    try {
      // 锁被占住（这里用"自己写的锁文件"模拟任意持有者）：写入必须**快速、
      // 明确地失败**，而不是绕过锁继续写——绕过就是并发下静默丢数据。
      const started = Date.now()
      // staleMs 给大值：锁文件是"我们刚写的、进程活着"，不该被陈旧回收捡走——
      // 这条测的就是"老实等锁然后如实失败"。
      const outcome = appendEntry(file, 'C', { legacyDir: null, lockTimeoutMs: 120, staleMs: 600_000 })
      assert.equal(outcome.locked, false)
      assert.match(String(outcome.reason), /未能取得文件锁/)
      assert.ok(Date.now() - started < 3_000, '应当按配置的上限快速失败，而不是等默认的 4 秒')
      assert.equal(readFileSync(file, 'utf8'), before, '取不到锁时文件必须原封不动')
    } finally {
      unlinkSync(lockPath)
    }
  })

  it('与 dsh-memory-evolve 的目录锁互操作：它持锁时我们不写', () => {
    const file = join(memoryDir, 'MEMORY.md')
    writeFileSync(file, '原有\n', 'utf8')
    const legacyLock = join(memoryDir, LEGACY_LOCK_NAME)
    writeFileSync(legacyLock, JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME ?? 'local', startedAt: Date.now() }), 'utf8')
    try {
      const outcome = withFileWriteLock(file, () => ({ ok: true }), { legacyDir: memoryDir, legacyTimeoutMs: 30 })
      assert.equal(outcome.locked, false)
      assert.match(outcome.reason, /dsh-memory-evolve 的互操作锁/)
      assert.equal(readFileSync(file, 'utf8'), '原有\n')
    } finally {
      unlinkSync(legacyLock)
    }
  })

  it('自己的锁文件命名不带路径分隔符，且与目标文件一一对应', () => {
    const outcome = withFileWriteLock(join(memoryDir, 'KEY.md'), ({ lockPath }) => ({ lockPath }))
    assert.equal(outcome.locked, true)
    assert.equal(outcome.lockPath, join(memoryDir, '.KEY.md.lock'))
    assert.ok(WRITE_LOCK_TIMEOUT_MS >= 1000, '写操作要留出合理的等锁时间')
  })

  it('replaceEntry 在锁内按正文精确匹配，正文不匹配时报告 0 条', () => {
    const file = join(memoryDir, 'MEMORY.md')
    writeFileSync(file, '甲\n§\n乙\n', 'utf8')
    const miss = replaceEntry(file, '不存在', '新', {})
    assert.equal(miss.replaced, 0, '匹配不到就不该动文件')
    assert.deepEqual(readEntries(file), ['甲', '乙'])
    const hit = replaceEntry(file, '乙', '乙改', {})
    assert.equal(hit.replaced, 1)
    assert.deepEqual(readEntries(file), ['甲', '乙改'])
  })

  it('removeEntries 只删精确相等的条目', () => {
    const file = join(memoryDir, 'MEMORY.md')
    writeFileSync(file, '甲\n§\n乙\n', 'utf8')
    const outcome = removeEntries(file, ['乙'], {})
    assert.equal(outcome.removed, 1)
    assert.deepEqual(readEntries(file), ['甲'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('每轮写入交接（接管旧实现的看门狗）', () => {
  function runtimeOf(extra = {}) {
    return createRuntime({ config: { memoryDir, coreDir, dshHome, ...extra }, logger: { info() {}, warn() {} } })
  }

  it('轮次按会话分段，写入只归零本会话', () => {
    const rt = runtimeOf({ writeReminderAfter: 2 })
    const a = agent('sess-a')
    const b = agent('sess-b')
    rt.noteTurn(a)
    rt.noteTurn(a)
    rt.noteTurn(b)
    assert.equal(rt.turnsSinceWriteOf(a), 2)
    assert.equal(rt.turnsSinceWriteOf(b), 1)
    rt.noteWrite(a)
    assert.equal(rt.turnsSinceWriteOf(a), 0)
    assert.equal(rt.turnsSinceWriteOf(b), 1, '另一个会话的计数不受影响')
  })

  it('同一轮被渲染多次不重复计数（靠 noteTurn 的时间戳去重）', () => {
    const rt = runtimeOf()
    const a = agent('sess-dup')
    rt.noteTurn(a, { stamp: 'turn-1' })
    rt.noteTurn(a, { stamp: 'turn-1' })
    rt.noteTurn(a, { stamp: 'turn-2' })
    assert.equal(rt.turnsSinceWriteOf(a), 2)
  })

  it('提醒只出现阈值布尔，不把计数写进文本（缓存前缀友好）', () => {
    const config = { writeReminder: true, writeReminderAfter: 3, writeReminderText: '该写记忆了' }
    assert.equal(renderWriteHint({ turnsSinceWrite: 1 }, config), '')
    assert.equal(renderWriteHint({ turnsSinceWrite: 2 }, config), '')
    const on = renderWriteHint({ turnsSinceWrite: 3 }, config)
    assert.equal(on, '该写记忆了')
    assert.equal(renderWriteHint({ turnsSinceWrite: 99 }, config), on, '超过阈值后文本必须完全一致')
    assert.equal(renderWriteHint({ turnsSinceWrite: 9 }, { ...config, writeReminder: false }), '')
  })

  // 0.4.8：空库不再"一行都不注入"。旧契约（空串）导致第一轮模型连"有记忆工具"都不知道，
  // 实测三次都在首条种子句上丢事实。现在只注入几行提示，且仍然不记账。
  // 0.6.2：空库这一屏也要求"先流水后结论"（空库是模型最容易照着塑形的时刻）。
  it('记忆为空时注入"先写后答"提示（含先流水），但不记账', () => {
    const rt = runtimeOf({ indexMode: 'index' })
    const text = renderSnapshotFor(rt, { agent: agent('sess-empty') })
    assert.ok(text.includes('<memory_index>'), text)
    assert.ok(text.includes('track="daily"'), '空库提示没要求先追加 daily 流水')
    assert.ok(text.includes('mem_write(confirm=true'), text)
    assert.ok(text.includes('静默') && text.includes('不要播报'), '空库提示没要求静默执行、不播报')
    assert.equal(rt.turnsSinceWriteOf(agent('sess-empty')), 0, '空记忆集不该消耗轮次')
  })

  it('emptyIndexHint=false 时回到"什么都不注入"', () => {
    const rt = runtimeOf({ emptyIndexHint: false })
    assert.equal(renderSnapshotFor(rt, { agent: agent('sess-empty') }), '')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 0.6.2 解包自检 449/450 暴露的真缺陷：关掉空库提示后，会话边界摘要仍被
// withDigest 拼回注入文本，"什么都不注入"的旧契约从后门失效。
// 这组用例必须自己造出可抽会话，否则空串断言只是"碰巧没摘要"的假通过。
describe('emptyIndexHint=false：零注入是整条链路的契约', () => {
  function runtimeWithDigest(extra = {}) {
    writePendingSession('session-prev-hint', '上一个会话里定了项目代号 PX-17，并且排除了证书过期')
    return createRuntime({
      config: { memoryDir, coreDir, dshHome, sessionExtractMinAgeMs: 0, ...extra },
      logger: { info() {}, warn() {} },
    })
  }

  it('前提自检：不关开关时，空库确实会端出会话摘要（否则后面是假通过）', () => {
    const rt = runtimeWithDigest()
    const text = renderSnapshotFor(rt, { agent: agent('sess-hint-baseline') })
    assert.match(text, /<session_digest /, '环境没造出可抽会话，这组用例会失去牙齿')
    assert.match(text, /<memory_index/)
  })

  it('pointer 模式：关掉开关后一行都不注入（含会话摘要）', () => {
    const rt = runtimeWithDigest({ emptyIndexHint: false })
    assert.equal(renderSnapshotFor(rt, { agent: agent('sess-hint-pointer') }), '')
  })

  it('index 模式：同样一行都不注入（两条分支不许分叉）', () => {
    const rt = runtimeWithDigest({ emptyIndexHint: false, indexMode: 'index' })
    assert.equal(renderSnapshotFor(rt, { agent: agent('sess-hint-index') }), '')
  })

  it('记忆库非空时不受开关影响：摘要照常注入（不许误伤）', () => {
    const rt = runtimeWithDigest({ emptyIndexHint: false })
    const outcome = appendEntry(join(memoryDir, 'MEMORY.md'), '项目代号 PX-17', {
      backupDir: join(coreDir, 'backups'), stamp: '2026-01-01',
    })
    assert.equal(outcome.ok, true)
    rt.invalidate()
    const text = renderSnapshotFor(rt, { agent: agent('sess-hint-nonempty') })
    assert.match(text, /<session_digest /, '非空库时摘要不该被关掉')
    assert.match(text, /<memory_index/, '非空库时索引块不该被关掉')
    assert.match(text, /条目 1/, '这一条得真的是"记忆库非空"的场景')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('会话身份行（与 dsh-memory-evolve 逐字同款）', () => {
  it('无名称/别名时与对方的 sessionPlain 同款', () => {
    const line = renderSessionLine({ id: 'session-abc' })
    assert.match(line, /^会话 ID（记住它：/)
    assert.match(line, /session-abc$/)
  })

  it('有名称/别名时给出 名称 · 别名 · ID', () => {
    const line = renderSessionLine({ id: 'session-abc', title: '记忆插件图形交互', alias: '记忆' })
    assert.match(line, /^你的会话：名称：记忆插件图形交互 · 别名：记忆 · ID：session-abc$/)
  })

  it('没有会话视角（子代理）时不输出该行', () => {
    assert.equal(renderSessionLine(null), '')
    assert.equal(renderSessionLine({}), '')
  })

  it('注入渲染把身份行交给页脚（在 </memory_index> 之前）', () => {
    const rendered = renderIndexSnapshot({
      entries: [{
        entryId: 'e1', rel: 'MEMORY.md', ordinal: 0, scope: 'global', track: 'memory',
        date: '2026-01-01', time: null, summary: '一条事实', body: '一条事实', mtime: Date.now(), chars: 4,
      }],
      config: { indexMaxLines: 120, indexMaxChars: 8000, injectExclude: [] },
      session: { id: 'session-xyz', turnsSinceWrite: 0 },
    })
    assert.match(rendered.text, /会话 ID（记住它：/)
    assert.ok(rendered.text.indexOf('会话 ID（记住它：') < rendered.text.indexOf('</memory_index>'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('注入文本净化与永不注入轨', () => {
  it('{{…}} 被折成全角，避免模板求值把会话搞崩', () => {
    const dirty = '这一段含 {{danger}} 模板'
    const clean = sanitizeIndexText(dirty)
    assert.ok(!clean.includes('{{') && !clean.includes('}}'))
    assert.match(clean, /｛｛danger｝｝/)
  })

  it('队列 / 归档 / 审计轨永不进常驻索引', () => {
    assert.ok(NEVER_INJECT.has('queue'))
    assert.ok(NEVER_INJECT.has('archive'))
    assert.ok(NEVER_INJECT.has('ledger'))
    assert.ok(NEVER_INJECT.has('suggestions'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('mem_audit：谁在管存储', () => {
  it('记忆根不存在时如实报 unknown，不假称"已接管"', () => {
    const rt = { config: { dshHome: join(sandbox, 'no-such-home') }, memoryDir: join(sandbox, 'no-such-mem'), coreDir }
    const report = buildAudit({ rt, entries: [], files: [] })
    const canon = report.checks.find((check) => check.id === 'store.canon')
    assert.equal(canon.state, 'unknown')
    assert.equal(report.normalized.injection, true, '没有旧插件源码可探测时，按"只有一条来源"处理')
  })

  it('探测到旧插件仍在注入时，报 duplicate-injection 并给出修法', () => {
    const dshHome = join(sandbox, 'dsh-probe')
    const profile = join(dshHome, 'profiles', 'web')
    const evolveLib = join(profile, 'node_modules', 'dsh-memory-evolve', 'lib')
    mkdirSync(evolveLib, { recursive: true })
    writeFileSync(join(evolveLib, 'index.js'), 'ctx.systemPrompt.context({ name: "memory:snapshot" })\n', 'utf8')

    const rt = { config: { dshHome }, memoryDir, coreDir }
    const report = buildAudit({ rt, entries: [], files: [] })
    const legacy = report.checks.find((check) => check.id === 'inject.legacy')
    assert.equal(legacy.state, WARN)
    assert.ok(report.findings.some((finding) => finding.code === 'duplicate-injection'))
    assert.equal(report.normalized.injection, false)
    // 注入与写入是两条独立口径：这份探针里旧插件**没有**注册 memory 工具，
    // 所以写入编排仍应判定为归新插件（旧口径会把它错判成否）。
    assert.equal(report.normalized.writeOrchestration, true)
    assert.match(renderAudit(report), /duplicate-injection/)
  })

  it('探测到旧插件源码但已找不到它的注入注册时，不误报两套注入', () => {
    const dshHome = join(sandbox, 'dsh-clean')
    const evolveLib = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-memory-evolve', 'lib')
    mkdirSync(evolveLib, { recursive: true })
    writeFileSync(join(evolveLib, 'index.js'), 'export const name = "dsh-memory-evolve"\n', 'utf8')
    const rt = { config: { dshHome }, memoryDir, coreDir }
    const report = buildAudit({ rt, entries: [], files: [] })
    assert.equal(report.checks.find((check) => check.id === 'inject.legacy').state, PASS)
    assert.ok(!report.findings.some((finding) => finding.code === 'duplicate-injection'))
  })

  it('报告里带上注入开关与预算的实际值', () => {
    const rt = { config: { dshHome: sandbox, indexMaxLines: 80, indexMaxChars: 6000, injectExclude: ['global:memory'] }, memoryDir, coreDir }
    const report = buildAudit({ rt, entries: [], files: [] })
    const inject = report.checks.find((check) => check.id === 'inject.self')
    assert.match(inject.detail, /80 行 \/ 6000 字符/)
    assert.ok(inject.evidence.includes('injectExclude=[global:memory]'))
  })

  it('mem_audit 挂上了', () => {
    const state = { tools: [], contexts: [] }
    const ctx = {
      state,
      systemPrompt: { context(definition) { state.contexts.push(definition); return () => {} } },
      tools: { register(definition) { state.tools.push(definition); return () => {} } },
      effect(callback) { return callback() },
      on() { return () => {} },
      get() { return undefined },
    }
    apply(ctx, { memoryDir, coreDir })
    assert.ok(state.tools.some((tool) => tool.name === 'mem_audit'))
  })

  it('写入编排的口径：只看写入路径，不看旧插件的存在与否', () => {
    // 场景：旧插件源码在（写入面确实双份），用户是否声明"只用新插件写"决定判定。
    const dshHome = join(sandbox, 'dsh-exclusive')
    const evolveLib = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-memory-evolve', 'lib')
    mkdirSync(evolveLib, { recursive: true })
    writeFileSync(join(evolveLib, 'index.js'),
      'ctx.systemPrompt.context({ name: "memory:snapshot" })\nctx.tools.register(memoryTool(ctx, config))\n', 'utf8')

    const undeclared = buildAudit({ rt: { config: { dshHome }, memoryDir, coreDir }, entries: [], files: [] })
    assert.equal(undeclared.normalized.writeOrchestration, false, '没声明时不能自称归一')
    assert.ok(undeclared.findings.some((finding) => finding.code === 'dual-write-surface'))

    const declared = buildAudit({
      rt: { config: { dshHome, exclusiveWritePath: true }, memoryDir, coreDir }, entries: [], files: [],
    })
    assert.equal(declared.normalized.writeOrchestration, true, '声明"只用新插件写"后即为归新插件')
    assert.equal(declared.normalized.injection, false, '注入那一路与写入口径分开报')
  })

  it('探针查的是 memory 工具的无条件注册，而不是"插件在不在"', () => {
    const dshHome = join(sandbox, 'dsh-no-tool')
    const evolveLib = join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-memory-evolve', 'lib')
    mkdirSync(evolveLib, { recursive: true })
    writeFileSync(join(evolveLib, 'index.js'), 'export const name = "dsh-memory-evolve"\n', 'utf8')
    const report = buildAudit({ rt: { config: { dshHome }, memoryDir, coreDir }, entries: [], files: [] })
    assert.equal(report.checks.find((check) => check.id === 'tools.legacy').state, 'ok')
    assert.ok(!report.findings.some((finding) => finding.code === 'dual-write-surface'))
  })

  it('账本不可读时，写入路径的判据如实报 unknown（不假装已验证）', () => {
    const report = buildAudit({ rt: { config: { dshHome: sandbox }, memoryDir, coreDir }, entries: [], files: [] })
    assert.equal(report.checks.find((item) => item.id === 'write.path').state, 'unknown')
  })

  it('宿主透传工具清单时，如实报"会话里旧 memory 工具是否可见"（约定可验证）', () => {
    const rt = { config: { dshHome: sandbox }, memoryDir, coreDir }
    const withLegacy = buildAudit({
      rt, entries: [], files: [], toolNames: ['memory', 'mem_write', 'mem_audit', 'dtodo'],
    })
    const check = withLegacy.checks.find((item) => item.id === 'tools.session')
    assert.equal(check.state, WARN, '旧工具可见时必须报 warn')
    assert.match(check.detail, /只用/)
    assert.ok(check.evidence.some((line) => line.includes('mem_audit')))

    const memOnly = buildAudit({ rt, entries: [], files: [], toolNames: ['mem_write', 'mem_search'] })
    assert.equal(memOnly.checks.find((item) => item.id === 'tools.session').state, PASS)

    // 拿不到清单 → 不出这一项（不猜）
    const unknown = buildAudit({ rt, entries: [], files: [] })
    assert.equal(unknown.checks.find((item) => item.id === 'tools.session'), undefined)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('写入交接提醒：桥接"别的写者"', () => {
  it('外部写入（旧 memory 工具 / 记忆 Tab）之后，未写计数归零', () => {
    // 用**专用**记忆根：beforeEach 那个目录可能残留上一轮的测试文件（甚至被我
    // 自己改过 mtime 的未来时间戳），那会让"最新 mtime"的基线被污染。
    const bridgeMemory = mkdtempSync(join(sandbox, 'bridge-mem-'))
    // throttle=0：让桥接检查每次渲染都跑（默认 2s 节流会遮住这条断言）。
    const rt = createRuntime({
      config: { memoryDir: bridgeMemory, coreDir, externalWriteThrottleMs: 0 },
      logger: { info() {}, warn() {} },
    })
    const a = agent('sess-bridge')
    rt.noteTurn(a)
    rt.noteTurn(a)
    assert.equal(rt.turnsSinceWriteOf(a), 2)
    // 模拟旧插件的 memory 工具直接写正本（不经过本插件，也不会调 noteWrite）。
    mkdirSync(join(bridgeMemory, 'daily'), { recursive: true })
    const file = join(bridgeMemory, 'daily', '2026-01-01.md')
    writeFileSync(file, '[09:00] 旧写入器写的条目\n', 'utf8')
    rt.noteTurn(a)   // 第一次看到这个文件 → 建立基线（这一轮仍算"未写"）
    assert.equal(rt.turnsSinceWriteOf(a), 3)
    const future = new Date(Date.now() + 5_000)
    try { utimesSync(file, future, future) } catch { /* 时间戳改不动就跳过这条断言 */ }
    rt.noteTurn(a)
    assert.equal(rt.turnsSinceWriteOf(a), 0, '检测到外部写入后应当归零，且这一轮不再累加')
  })

  it('本插件自己写入后立即刷新基线，不会被自己的写入误判成外部写入', () => {
    const selfMemory = mkdtempSync(join(sandbox, 'self-mem-'))
    const rt = createRuntime({
      config: { memoryDir: selfMemory, coreDir, externalWriteThrottleMs: 0 },
      logger: { info() {}, warn() {} },
    })
    const a = agent('sess-self')
    rt.noteTurn(a)
    rt.noteTurn(a)
    assert.equal(rt.turnsSinceWriteOf(a), 2)
    const file = join(selfMemory, 'MEMORY.md')
    writeFileSync(file, '[2026-01-01] 自己写的\n', 'utf8')
    rt.noteWrite(a)              // 写入成功 → 归零 + 刷新 mtime 基线
    assert.equal(rt.turnsSinceWriteOf(a), 0)
    rt.noteTurn(a)               // 同一份文件、没有新写入 → 不该再被归零
    assert.equal(rt.turnsSinceWriteOf(a), 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('备份目录：锁内备份，且不吞异常', () => {
  it('传了 backupDir 时真的写出备份文件（旧实现此处有 ReferenceError）', () => {
    const file = join(memoryDir, 'MEMORY.md')
    const backupDir = join(coreDir, 'backups')
    writeFileSync(file, '旧\n', 'utf8')
    const outcome = appendEntry(file, '新', { backupDir, stamp: '2026-01-01' })
    assert.equal(outcome.ok, true)
    assert.ok(outcome.backup, '应当返回备份路径')
    assert.ok(existsSync(outcome.backup), '备份文件应当真的存在')
    assert.equal(readFileSync(outcome.backup, 'utf8'), '旧\n')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('profile 配置写入器（apply-profile-config 的纯函数部分）', () => {
  const sample = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: vanwork-platform',
    '',
    '# 启用新的记忆插件',
    '- insert:',
    '    - id: vanwork-memory-core',
    '      name: "file:///C:/Users/x/VanWork/plugins/vanwork-memory-core/lib/index.js"',
    '      config:',
    "        injectExclude: [ 'global:memory' ]",
    '',
  ].join('\n')

  it('在已有 config 段里补齐缺失键，并保留其它条目逐字不变', () => {
    const result = patchProfileYaml(sample, DESIRED_CONFIG)
    assert.equal(result.ok, true)
    // 断言"目标值都写进去了"而不是把字面量写死——否则每次调配置都要改测试，
    // 而测试要守的是"写入器把 DESIRED_CONFIG 如实落地"，不是具体那几个数字。
    for (const [key, value] of Object.entries(DESIRED_CONFIG)) {
      assert.ok(result.text.includes(`${key}: ${value}`), `应写入 ${key}: ${value}`)
    }
    // 其它条目原样保留
    assert.ok(result.text.includes('- id: agent-default-model'))
    assert.ok(result.text.includes('provider: vanwork-platform'))
    assert.ok(result.text.includes('file:///C:/Users/x/VanWork/plugins/vanwork-memory-core/lib/index.js'))
  })

  it('幂等：已经是目标值时报告零改动', () => {
    const once = patchProfileYaml(sample, DESIRED_CONFIG)
    const twice = patchProfileYaml(once.text, DESIRED_CONFIG)
    assert.equal(twice.ok, true)
    assert.deepEqual(twice.changes, [], '第二次不应再产生改动')
  })

  it('没有 config 段时补一个，并沿用条目缩进', () => {
    const bare = [
      '- insert:',
      '    - id: vanwork-memory-core',
      '      name: "file:///C:/x/lib/index.js"',
      '',
    ].join('\n')
    const result = patchProfileYaml(bare, DESIRED_CONFIG)
    assert.equal(result.ok, true)
    assert.match(result.text, /\n {6}config:\n {8}injectExclude:/)
    assert.ok(result.text.includes('exclusiveWritePath: true'))
  })

  it('找不到插件条目时如实失败（不猜、不新建条目）', () => {
    const result = patchProfileYaml('- id: something-else\n  config:\n    a: 1\n', DESIRED_CONFIG)
    assert.equal(result.ok, false)
    assert.match(result.reason, /vanwork-memory-core/)
  })

  it('不会误改同名的其它条目（只碰目标 id 那一条）', () => {
    const two = [
      '- insert:',
      '    - id: vanwork-memory-core',
      '      config:',
      '        injectExclude: []',
      '    - id: vanwork-memory-core-extra',
      '      config:',
      '        injectExclude: []',
      '',
    ].join('\n')
    const result = patchProfileYaml(two, DESIRED_CONFIG)
    assert.equal(result.ok, true)
    const lines = result.text.split('\n')
    const extraAt = lines.findIndex((line) => line.includes('vanwork-memory-core-extra'))
    const afterExtra = lines.slice(extraAt).join('\n')
    assert.ok(!afterExtra.includes('exclusiveWritePath'), '不应把配置写到相邻条目里')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('配置写入器的落盘路径（在临时 dsh-home 上端到端跑）', () => {
  function makeHome(seed) {
    const home = mkdtempSync(join(sandbox, 'dsh-home-'))
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), seed, 'utf8')
    return { home, patchPath: join(profileDir, 'cordis.patch.yml') }
  }
  const seedYaml = [
    '- insert:',
    '    - id: vanwork-memory-core',
    '      name: "file:///C:/x/lib/index.js"',
    '      config:',
    "        injectExclude: ['global:memory']",
    '',
  ].join('\n')

  it('--apply 把 DESIRED_CONFIG 全部落盘，备份是**改前**内容且非空，幂等复跑零改动', () => {
    const { home, patchPath } = makeHome(seedYaml)
    const silent = { log() {}, error() {}, stamp: '2026-01-01T00-00-00-000Z' }
    assert.equal(applyProfileConfig(['--apply', '--dsh-home', home], silent), 0)

    const patched = readFileSync(patchPath, 'utf8')
    for (const [key, value] of Object.entries(DESIRED_CONFIG)) {
      assert.ok(patched.includes(`${key}: ${value}`), `应写入 ${key}: ${value}`)
    }

    const backupPath = `${patchPath}.bak-2026-01-01T00-00-00-000Z`
    const backup = readFileSync(backupPath, 'utf8')
    assert.equal(backup.length, seedYaml.length, '备份必须是完整的改前内容（不能是 0 字节）')
    assert.equal(backup, seedYaml, '备份应逐字节等于改前内容')
    assert.ok(existsSync(join(home, 'profiles', 'web', 'rollback-memory-core-config.ps1')), '应生成回滚脚本')

    // 幂等：第二次跑不应再改文件
    const hashBefore = readFileSync(patchPath, 'utf8')
    assert.equal(applyProfileConfig(['--apply', '--dsh-home', home], silent), 0)
    assert.equal(readFileSync(patchPath, 'utf8'), hashBefore)
  })

  it('dry-run（不带 --apply）不改文件，但会打印将做的改动', () => {
    const { home, patchPath } = makeHome(seedYaml)
    const printed = []
    const code = applyProfileConfig(['--dsh-home', home], { log: (line) => printed.push(String(line)), error() {} })
    assert.equal(code, 0)
    assert.equal(readFileSync(patchPath, 'utf8'), seedYaml, 'dry-run 必须逐字节不动文件')
    assert.ok(printed.some((line) => line.includes('exclusiveWritePath')), '应当打印将做的改动')
    assert.ok(printed.some((line) => line.includes('dry-run')))
  })

  it('找不到插件条目时返回 2 且不改文件', () => {
    const { home, patchPath } = makeHome('- id: other\n  config:\n    a: 1\n')
    const errors = []
    const code = applyProfileConfig(['--apply', '--dsh-home', home], { log() {}, error: (line) => errors.push(String(line)) })
    assert.equal(code, 2)
    assert.equal(readFileSync(patchPath, 'utf8'), '- id: other\n  config:\n    a: 1\n')
    assert.ok(errors.some((line) => line.includes('无法定位配置段')))
  })

  it('目标 profile 不存在时返回 2（不新建文件）', () => {
    const home = mkdtempSync(join(sandbox, 'dsh-home-missing-'))
    const errors = []
    const code = applyProfileConfig(['--apply', '--dsh-home', home], { log() {}, error: (line) => errors.push(String(line)) })
    assert.equal(code, 2)
    assert.ok(errors.some((line) => line.includes('没找到 profile patch')))
  })
})