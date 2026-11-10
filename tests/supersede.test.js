/**
 * L2「取代」语义回归测试 —— 记忆的常态操作是修正，不是删除。
 *
 * 用户 2026-10-26 的判断：「只需要对可能存在的错误记忆进行更新、修正，
 * 记忆如果允许删除不太符合记忆的定位」。据此 L2 `supersede` 被设计为主角：
 * 旧条目打 `[superseded-by:<id>]` 留档、不再注入、默认不召回，但演进链可查。
 *
 * 本文件锁定四条不变量：
 *   ① 取代是**移动 + 留档**，不是删除（旧文本仍在归档里）；
 *   ② 被取代的条目**不进常驻索引、默认不被召回**（不再误导）；
 *   ③ 矛盾检测是**只提议**的——apply 不带 supersede=true 时不动任何文件；
 *   ④ 提议必须给出可解释判据（命中的修订标记 / 键值冲突），而不是黑盒结论。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { detectContradictions, detectRevisionSignals, valueConflicts, valuePairs, applyPlan, buildPlan, planIdOf } from '../lib/consolidate.js'
import { markSuperseded, supersededTag } from '../lib/memfile.js'
import { entrySlotKey } from '../lib/slots.js'
import { renderIndexSnapshot } from '../lib/inject.js'
import { resolveConfig } from '../lib/config.js'
import { dateStamp } from '../lib/fsutil.js'
import { ENTRY_DELIMITER, scanRoot, SUPERSEDED_RE, stripTags } from '../lib/scanner.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-supersede-'))
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

describe('取代标记的解析', () => {
  it('scanner 识别 [superseded-by:<id>] 并把它从摘要里剥掉', () => {
    const entries = scanRoot(root, {}) // 空目录先探一下不报错
    assert.deepEqual(entries.entries, [])
    write('MEMORY.md', `[superseded-by:abc123] ${'[2026-01-01 09:00]'} 旧结论：端口是 8080。\n`)
    const [entry] = scanRoot(root, {}).entries
    assert.equal(entry.supersededBy, 'abc123')
    assert.equal(entry.summary, '旧结论：端口是 8080。', '标记不该混进摘要')
    assert.ok(SUPERSEDED_RE.test(entry.body))
    assert.equal(stripTags(entry.body), `[2026-01-01 09:00] 旧结论：端口是 8080。`)
  })

  it('markSuperseded 打标记是幂等的（重复调用不再叠加）', () => {
    const file = join(root, 'MEMORY.md')
    writeFileSync(file, `[2026-01-01 09:00] 端口是 8080。\n`, 'utf8')
    assert.equal(markSuperseded(file, '[2026-01-01 09:00] 端口是 8080。', 'newid').marked, 1)
    assert.equal(markSuperseded(file, '[2026-01-01 09:00] 端口是 8080。', 'newid').marked, 0, '已标记应跳过')
    const text = readFileSync(file, 'utf8')
    assert.equal(text.match(/\[superseded-by:/g).length, 1)
    assert.equal(supersededTag('x'), '[superseded-by:x]')
  })
})

describe('被取代的条目不再误导', () => {
  it('不进常驻索引', () => {
    write('MEMORY.md', [
      `[${daysAgo(1)} 09:00] 端口是 8090（现行）。`,
      ENTRY_DELIMITER,
      `[superseded-by:keepid] [${daysAgo(99)} 09:00] 端口是 8080（旧结论）。`,
    ].join('') + '\n')
    const scan = scanRoot(root, {})
    assert.equal(scan.entries.length, 2)
    const rendered = renderIndexSnapshot({ entries: scan.entries, config: resolveConfig({}), now: Date.now() })
    assert.ok(rendered.text.includes('端口是 8090'))
    assert.ok(!rendered.text.includes('端口是 8080'), '被取代的旧结论不该出现在常驻索引里')
  })
})

describe('矛盾检测', () => {
  it('修订标记与键值冲突都能被识别，且给出可解释判据', () => {
    assert.ok(detectRevisionSignals('端口改为 9000').includes('改为'))
    assert.ok(detectRevisionSignals('这条已废弃').includes('已废弃'))
    assert.deepEqual(detectRevisionSignals('端口是 8080'), [])
    assert.equal(valuePairs('端口: 8080').get('端口').has('8080'), true)
    const conflicts = valueConflicts(
      { summary: '端口改为 9000', body: '端口: 9000' },
      { summary: '端口是 8080', body: '端口: 8080' },
    )
    assert.equal(conflicts.length, 1)
    assert.deepEqual(conflicts[0], { key: '端口', from: '9000', to: '8080' })
  })

  it('矛盾优先于重复：一对话义矛盾的条目不会被当成近重复合并掉', () => {
    // 这是实测踩过的坑：新结论常是旧结论的超集，相似度高到同时命中"近重复"。
    // 若 merge 先跑，旧结论被静默删除、修正痕迹随之消失——而取代的全部价值就是留痕。
    write('MEMORY.md', [
      `[${daysAgo(30)} 10:00] 架构决策：记忆检索走 SQLite FTS5 BM25 关键词检索。`,
      ENTRY_DELIMITER,
      `[${daysAgo(1)} 10:00] 架构决策：记忆检索改为 SQLite FTS5 BM25 关键词检索 + 可选向量融合。`,
    ].join('') + '\n')
    const scan = scanRoot(root, {})
    const plan = buildPlan({ entries: scan.entries, files: scan.files, config: resolveConfig({}), now: Date.now(), memoryDir: root })
    assert.equal(plan.counts.supersede, 1)
    assert.equal(plan.counts.merge, 0, '矛盾对不得进入合并')
  })

  it('同主题 + 修订标记 → 提议；方向是较新的取代较旧的', () => {
    write('MEMORY.md', [
      `[${daysAgo(30)} 10:00] 架构决策：记忆检索走 SQLite FTS5 BM25 关键词检索。`,
      ENTRY_DELIMITER,
      `[${daysAgo(1)} 10:00] 架构决策：记忆检索改为 SQLite FTS5 BM25 关键词检索 + 可选向量融合。`,
    ].join('') + '\n')
    const scan = scanRoot(root, {})
    const proposals = detectContradictions(scan.entries, { config: resolveConfig({}) })
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0].type, 'supersede')
    assert.ok(proposals[0].signals.some((s) => s.startsWith('revision-marker:')), proposals[0].signals.join(','))
    assert.match(proposals[0].keep.body, /改为/, '较新的那条是取代者')
    assert.match(proposals[0].supersede.body, /走 SQLite FTS5 BM25 关键词检索。$/)
  })

  it('同主题但没有修订信号 → 不提议（避免把"补充说明"误判为矛盾）', () => {
    write('MEMORY.md', [
      `[${daysAgo(30)} 10:00] 架构决策：记忆检索走 SQLite FTS5 BM25 关键词检索。`,
      ENTRY_DELIMITER,
      `[${daysAgo(1)} 10:00] 架构决策：记忆检索走 SQLite FTS5 BM25 关键词检索，另外检索结果要标注来源。`,
    ].join('') + '\n')
    const proposals = detectContradictions(scanRoot(root, {}).entries, { config: resolveConfig({}) })
    assert.equal(proposals.length, 0)
  })

  it('日志轨不参与矛盾检测（日志是编年史，不是知识库）', () => {
    write(join('daily', `${daysAgo(30)}.md`), `[${daysAgo(30)} 10:00] 端口是 8080。\n`)
    write(join('daily', `${daysAgo(1)}.md`), `[${daysAgo(1)} 10:00] 端口改为 9000。\n`)
    const proposals = detectContradictions(scanRoot(root, {}).entries, { config: resolveConfig({}) })
    assert.equal(proposals.length, 0)
  })

  it('supersedeEnabled=false 时完全关闭检测', () => {
    write('MEMORY.md', [
      `[${daysAgo(30)} 10:00] 端口是 8080。`,
      ENTRY_DELIMITER,
      `[${daysAgo(1)} 10:00] 端口改为 9000。`,
    ].join('') + '\n')
    const entries = scanRoot(root, {}).entries
    assert.equal(detectContradictions(entries, { config: resolveConfig({ supersedeEnabled: false }) }).length, 0)
  })
})

describe('apply 的授权边界', () => {
  function fixture() {
    write('MEMORY.md', [
      `[${daysAgo(3)} 10:00] 现行结论：端口是 9000。`,
      ENTRY_DELIMITER,
      `[superseded-by:keep] [${daysAgo(400)} 10:00] 旧结论：端口是 8080。`,
    ].join('') + '\n')
    write(join('projects', 'p1', 'KEY.md'), [
      `[${daysAgo(30)} 10:00] 架构决策：记忆检索走 SQLite FTS5 BM25 关键词检索。`,
      ENTRY_DELIMITER,
      `[${daysAgo(1)} 10:00] 架构决策：记忆检索改为 SQLite FTS5 BM25 关键词检索 + 可选向量融合。`,
    ].join('') + '\n')
    return scanRoot(root, {})
  }

  function plan(scan) {
    const config = resolveConfig({})
    return { config, plan: buildPlan({ entries: scan.entries, files: scan.files, config, now: Date.now(), memoryDir: root }) }
  }

  it('取代提议在方案里可见，但 apply 不带 supersede=true 时一个记忆文件都不动', () => {
    const scan = fixture()
    const { config, plan: built } = plan(scan)
    assert.equal(built.counts.supersede, 1)

    const keyPath = join(root, 'projects', 'p1', 'KEY.md')
    const before = readFileSync(keyPath, 'utf8')
    const outcome = applyPlan({
      plan: built, planId: built.planId, config, coreDir: core, memoryDir: root,
      entries: scan.entries, files: scan.files, confirm: true,
    })
    assert.equal(outcome.ok, true)
    // 未授权时不执行任何"改记忆正本"的动作；只允许贴不动正文、可逆的可疑标记。
    assert.ok(outcome.applied.every((a) => a.type === 'suspect'), '只可贴可疑标记，不可合并/取代/归档')
    assert.equal(outcome.applied.filter((a) => a.type !== 'suspect').length, 0, '默认不执行取代')
    assert.match(outcome.reason, /supersede=true/)
    assert.equal(readFileSync(keyPath, 'utf8'), before, '文件必须原样')
  })

  it('supersede=true 时执行：旧条目留档归档并打标记，源位置清理，原文件有备份', () => {
    const scan = fixture()
    const { config, plan: built } = plan(scan)
    const outcome = applyPlan({
      plan: built, planId: built.planId, config, coreDir: core, memoryDir: root,
      entries: scan.entries, files: scan.files, confirm: true, supersede: true,
    })
    assert.equal(outcome.ok, true, JSON.stringify(outcome.errors))
    assert.equal(outcome.applied.filter((a) => a.type === 'supersede').length, 1)

    const key = readFileSync(join(root, 'projects', 'p1', 'KEY.md'), 'utf8')
    assert.ok(!key.includes('走 SQLite FTS5 BM25 关键词检索。'), '旧结论已从原位置移出')
    assert.ok(key.includes('改为'), '新结论仍在原位置')

    // 项目 key 轨的归档与 memory-evolve 的 ArchiveStore 同名（记忆 Tab 归档页签可见）
    const archived = readFileSync(join(root, 'projects', 'p1', 'KEY-archive.md'), 'utf8')
    assert.ok(archived.includes('走 SQLite FTS5 BM25 关键词检索。'), '旧结论**留档**而不是被抹掉')
    assert.ok(/\[superseded-by:[0-9a-f]{16}\]/.test(archived), '带取代标记与取代者的内容寻址键')
    assert.ok(existsSync(join(core, 'backups')), '原文件已备份')

    // 取代指针用"较新那条"的内容寻址键（正文 hash），而非位置敏感的 entryId
    const newer = scan.entries.find((entry) => entry.body.includes('改为'))
    assert.ok(archived.includes(`[superseded-by:${entrySlotKey(newer)}]`))
  })

  it('方案指纹包含取代提议：方案内容一变，看过的那份就不能执行', () => {
    const scan = fixture()
    const { config, plan: built } = plan(scan)
    // 去掉矛盾对里的旧条目 → 方案内容确实变了（不再有取代提议）
    const mutated = scan.entries.filter((entry) => !entry.body.includes('走 SQLite'))
    const outcome = applyPlan({
      plan: built, planId: built.planId, config, coreDir: core, memoryDir: root,
      entries: mutated, files: scan.files, confirm: true, supersede: true,
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /方案已过期/)
  })

  it('planIdOf 对同一组取代提议给出同一指纹，换了取代对象就变', () => {
    const scan = fixture()
    const { config, plan: built } = plan(scan)
    assert.equal(planIdOf(built), built.planId)
    const tampered = { ...built, contradictions: [{ ...built.contradictions[0], keep: { ...built.contradictions[0].keep, entryId: 'other' } }] }
    assert.notEqual(planIdOf(tampered), built.planId)
  })
})