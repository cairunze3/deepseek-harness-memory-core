/**
 * 云端分层与注入渲染的回归测试。
 *
 * 这两块是"取舍"最集中的地方：云端分层决定了什么允许离机，
 * 注入渲染决定了每个模型步的常驻成本——都值得被断言钉住。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyEntry, cloudPlan, detectSensitivity, offsiteTracks, redactForCloud, sanitizeForCloud, SENSITIVITY_RULES, TRACK_CLOUD_BASELINE } from '../lib/cloud.js'
import { renderIndexSnapshot, selectForIndex, NEVER_INJECT } from '../lib/inject.js'
import { resolveConfig } from '../lib/config.js'

const config = resolveConfig({})

function entry(overrides = {}) {
  return {
    entryId: overrides.entryId ?? 'id-1',
    rel: overrides.rel ?? 'MEMORY.md',
    ordinal: overrides.ordinal ?? 0,
    scope: overrides.scope ?? 'global',
    track: overrides.track ?? 'memory',
    projectId: overrides.projectId ?? null,
    projectLabel: null,
    date: overrides.date ?? '2026-01-01',
    time: null,
    summary: overrides.summary ?? '一条记忆',
    body: overrides.body ?? '一条记忆的正文',
    chars: (overrides.body ?? '一条记忆的正文').length,
    mtime: overrides.mtime ?? Date.now(),
    ageDays: overrides.ageDays ?? 1,
    dshOnly: overrides.dshOnly ?? false,
    recencyKey: `${overrides.date ?? '2026-01-01'}T00:00`,
  }
}

describe('cloud · 敏感性检测', () => {
  it('命中密钥 / 个人信息 / 路径三类，且严重度分级正确', () => {
    const findings = detectSensitivity([
      'token: sk-abcdefghijklmnopqrstuvwxyz012345',
      '联系邮箱 someone@example.com',
      '手机 13800138000',
      '配置在 /Users/cai/config 与 C:\\Users\\cai\\app',
    ].join('\n'))
    const kinds = findings.map((f) => f.kind)
    assert.ok(kinds.includes('openai-key'))
    assert.ok(kinds.includes('email'))
    assert.ok(kinds.includes('cn-mobile'))
    assert.ok(kinds.some((k) => k.includes('path')))
    assert.equal(findings.find((f) => f.kind === 'openai-key').severity, 'secret')
    assert.equal(findings.find((f) => f.kind === 'email').severity, 'pii')
  })

  it('检测结果里的样本本身不泄露原文', () => {
    const [finding] = detectSensitivity('sk-abcdefghijklmnopqrstuvwxyz012345')
    assert.ok(finding.sample.includes('…'))
    assert.ok(!finding.sample.includes('abcdefghij'))
  })

  it('规则表覆盖私钥与常见云凭证', () => {
    const kinds = SENSITIVITY_RULES.map((r) => r.kind)
    for (const kind of ['private-key', 'github-token', 'aws-key', 'bearer-token', 'assigned-secret']) {
      assert.ok(kinds.includes(kind), kind)
    }
  })
})

describe('cloud · 脱敏', () => {
  it('路径换成 [path omitted]，个人信息换成 [pii omitted]', () => {
    const outcome = redactForCloud('路径 /home/cai/work 与邮箱 a@b.com')
    assert.ok(outcome.text.includes('[path omitted]'))
    assert.ok(outcome.text.includes('[pii omitted]'))
    assert.equal(outcome.removed, 2)
    assert.ok(!outcome.text.includes('a@b.com'))
  })

  it('可以让某类脱敏失效（配置 runtime 上的开关）', () => {
    const outcome = redactForCloud('路径 /home/cai/work', { redactPaths: false })
    assert.ok(outcome.text.includes('/home/cai/work'))
    assert.equal(outcome.removed, 0)
  })
})

describe('cloud · 分层判定', () => {
  it('各轨基线：user 可离机但不给第三方；daily 不进第三方；queue 完全禁止', () => {
    assert.equal(classifyEntry(entry({ track: 'user' }), config).offsite, 'yes')
    assert.equal(classifyEntry(entry({ track: 'user' }), config).thirdParty, 'redacted-snippets-only')
    assert.equal(classifyEntry(entry({ track: 'daily' }), config).thirdParty, 'no')
    assert.equal(classifyEntry(entry({ track: 'queue' }), config).offsite, 'no')
  })

  it('按用户决策：跨设备只允许 user 一轨，会话类与项目类全部本机化', () => {
    // 用户 2026-10-26 拍板：多设备只共用身份/习惯类记忆，本地会话相关不共享。
    // 推论：memory（机器属性）也不该离机——同步过去等于制造错误记忆。
    for (const track of ['memory', 'key', 'project', 'daily', 'archive', 'queue', 'ledger']) {
      assert.equal(classifyEntry(entry({ track }), config).offsite, 'no', `${track} 不应离机`)
    }
    assert.deepEqual(offsiteTracks(), ['user'])
  })

  it('命中密钥 → 任何离机副本都被拒（连私有仓库也不行）', () => {
    const verdict = classifyEntry(entry({ track: 'user', body: 'api_key: sk-abcdefghijklmnopqrstuvwx' }), config)
    assert.equal(verdict.offsite, 'no')
    assert.equal(verdict.thirdParty, 'no')
    assert.match(verdict.reasons.join(' '), /离机副本都被拒绝/)
  })

  it('命中个人信息 → 需要脱敏才能离机（user 轨唯一会被降级的一轨）', () => {
    const verdict = classifyEntry(entry({ track: 'user', body: '邮箱 someone@example.com' }), config)
    assert.equal(verdict.offsite, 'redact-then-sync')
    // memory 轨本来就是 no，PII 不会把它"降级"（它已经在最严一级）
    assert.equal(classifyEntry(entry({ track: 'memory', body: '邮箱 someone@example.com' }), config).offsite, 'no')
  })

  it('[dsh-only] 标记的条目禁止离机', () => {
    const verdict = classifyEntry(entry({ track: 'key', dshOnly: true }), config)
    assert.equal(verdict.offsite, 'no')
    assert.match(verdict.reasons.join(' '), /dsh-only/)
  })

  it('配置覆盖生效', () => {
    const verdict = classifyEntry(entry({ track: 'daily' }), resolveConfig({ cloudTierOverrides: { daily: { offsite: 'no' } } }))
    assert.equal(verdict.offsite, 'no')
    // 反向覆盖也生效：允许某轨离机
    const opened = classifyEntry(entry({ track: 'key' }), resolveConfig({ cloudTierOverrides: { key: { offsite: 'yes' } } }))
    assert.equal(opened.offsite, 'yes')
  })

  it('cloudPlan 汇总两条轴的分布、给出跨设备范围并给建议', () => {
    const plan = cloudPlan([
      entry({ entryId: 'a', track: 'user' }),
      entry({ entryId: 'b', track: 'memory', body: '路径 /Users/cai/x' }),
      entry({ entryId: 'c', track: 'queue' }),
    ], config)
    assert.equal(plan.totals.entries, 3)
    assert.equal(plan.offsite.yes, 1, '只有 user 轨可离机')
    assert.equal(plan.offsite.no, 2)
    assert.deepEqual(plan.syncScope.tracks, ['user'])
    assert.equal(plan.syncScope.entries, 1)
    assert.equal(plan.syncScope.localEntries, 2)
    assert.ok(plan.recommendations.some((line) => line.includes('跨设备范围')))
    assert.ok(Object.keys(plan.byTrack).length >= 3)
  })

  it('sanitizeForCloud 对禁止离机的条目返回 null（调用方无法回退到原文）', () => {
    assert.equal(sanitizeForCloud(entry({ track: 'queue' }), config), null)
    assert.equal(sanitizeForCloud(entry({ track: 'memory' }), config), null, '机器属性轨不产可离机文本')
    const safe = sanitizeForCloud(entry({ track: 'user', body: '路径 /Users/cai/x' }), config)
    assert.ok(safe !== null, 'user 轨可脱敏后离机')
    assert.ok(safe.text.includes('[path omitted]'))
  })

  it('基线表覆盖所有已知轨道（新增轨道必须有明确结论）', () => {
    for (const track of ['user', 'memory', 'key', 'project', 'daily', 'archive', 'queue', 'ledger']) {
      assert.ok(TRACK_CLOUD_BASELINE[track], track)
    }
  })

  it('未知轨道保守处理：两者皆禁', () => {
    const verdict = classifyEntry(entry({ track: 'brand-new-track' }), config)
    assert.equal(verdict.offsite, 'no')
    assert.equal(verdict.thirdParty, 'no')
  })
})

describe('inject · 选择与预算', () => {
  it('队列 / 归档 / dsh-only 永不注入', () => {
    const entries = [
      entry({ entryId: '1', track: 'memory' }),
      entry({ entryId: '2', track: 'queue' }),
      entry({ entryId: '3', track: 'archive' }),
      entry({ entryId: '4', track: 'key', dshOnly: true, scope: 'project', projectId: 'p' }),
    ]
    const { selected } = selectForIndex(entries, { config, now: Date.now(), projectId: 'p' })
    assert.deepEqual(selected.map((e) => e.entryId), ['1'])
    assert.ok(NEVER_INJECT.has('queue') && NEVER_INJECT.has('ledger'))
  })

  it('项目记忆只注入当前项目的（其他项目的条目对本次会话不可见）', () => {
    const entries = [
      entry({ entryId: 'mine', scope: 'project', projectId: 'p1', track: 'key' }),
      entry({ entryId: 'other', scope: 'project', projectId: 'p2', track: 'key' }),
    ]
    const { selected } = selectForIndex(entries, { config, now: Date.now(), projectId: 'p1' })
    assert.deepEqual(selected.map((e) => e.entryId), ['mine'])
  })

  it('injectExclude：让出 memory-evolve 负责注入的轨，避免同一内容注入两遍', () => {
    // 共存分工配置：它注入 global memory/user + project key，本插件注入其余轨
    const coexist = resolveConfig({ injectExclude: ['global:memory', 'global:user', 'project:key'] })
    const entries = [
      entry({ entryId: 'g-memory', scope: 'global', track: 'memory' }),
      entry({ entryId: 'g-user', scope: 'global', track: 'user' }),
      entry({ entryId: 'p-key', scope: 'project', track: 'key', projectId: 'p1' }),
      entry({ entryId: 'p-memory', scope: 'project', track: 'memory', projectId: 'p1' }),
      entry({ entryId: 'g-daily', scope: 'global', track: 'daily' }),
    ]
    const { selected } = selectForIndex(entries, { config: coexist, now: Date.now(), projectId: 'p1' })
    const ids = selected.map((e) => e.entryId).sort()
    assert.deepEqual(ids, ['g-daily', 'p-memory'], `实际注入 ${ids.join(',')}`)
    // 注意 `project:memory`（项目笔记）不被排除：memory-evolve 只注入 project 的 KEY，
    // 项目 MEMORY.md 它从不注入——若一并排除，那一类就没人注入了。
  })

  it('injectExclude 支持只写 track（匹配该轨所有 scope）', () => {
    const onlyDaily = resolveConfig({ injectExclude: ['daily'] })
    const entries = [
      entry({ entryId: 'g-daily', scope: 'global', track: 'daily' }),
      entry({ entryId: 'p-daily', scope: 'project', track: 'daily', projectId: 'p1' }),
      entry({ entryId: 'keep', scope: 'global', track: 'memory' }),
    ]
    const { selected } = selectForIndex(entries, { config: onlyDaily, now: Date.now(), projectId: 'p1' })
    assert.deepEqual(selected.map((e) => e.entryId), ['keep'])
  })

  it('injectExclude 非字符串元素被丢弃而不是让加载失败', () => {
    assert.deepEqual(resolveConfig({ injectExclude: ['daily', 42, null, '', '  memory  '] }).injectExclude, ['daily', 'memory'])
    assert.deepEqual(resolveConfig({ injectExclude: 'not-an-array' }).injectExclude, [])
  })

  it('贪心多样化真的生效：同主题重复条目不会占满注入头部', () => {
    // 两条内容高度重复（重要性相同）与一条内容不同（重要性略低）。
    // 若 novelty 是"对空集合算一遍"（曾经的 bug），第二条会仍然选重复条目；
    // 正确实现下，第二条应让位给内容不同的那条。
    const body = '架构决策：记忆正本继续用 Markdown，检索走 BM25，向量默认关闭。'
    const entries = [
      entry({ entryId: 'dupA', body, summary: body, mtime: Date.now(), recencyKey: '2026-01-01T09:00' }),
      entry({ entryId: 'dupB', body, summary: body, mtime: Date.now() - 1000, recencyKey: '2026-01-01T08:00' }),
      entry({ entryId: 'distinct', body: '用户偏好：结论先行、表格化呈现，简体中文。', summary: '用户偏好：结论先行、表格化呈现，简体中文。', mtime: Date.now() - 2000, recencyKey: '2026-01-01T07:00' }),
    ]
    const { selected } = selectForIndex(entries, { config: resolveConfig({ indexTopN: 2 }), now: Date.now() })
    const ids = selected.map((e) => e.entryId)
    assert.equal(ids.length, 2)
    assert.equal(ids.filter((id) => id.startsWith('dup')).length, 1, `重复条目应只进一条，实际 ${ids.join(',')}`)
    assert.ok(ids.includes('distinct'))
  })

  it('未被选中的条目不算"溢出"（口径修正：设计 ≠ 预算装不下）', () => {
    // 40 条、预算宽松：预算一条都不挤掉，但 indexTopN=10 会让 30 条"未被选中"。
    const many = Array.from({ length: 40 }, (_, i) => entry({
      entryId: `o${i}`,
      summary: `第 ${i} 条摘要`,
      body: `第 ${i} 条摘要`,
      mtime: Date.now() - i * 1000,
    }))
    const rendered = renderIndexSnapshot({
      entries: many,
      config: resolveConfig({ indexMaxLines: 120, indexMaxChars: 8000, indexTopN: 10 }),
      now: Date.now(),
    })
    assert.equal(rendered.overflow, false, '有条目未入选 ≠ 溢出')
    assert.ok(rendered.omitted > 0, '未入选条数仍应如实统计')
    assert.equal(rendered.droppedByBudget, 0)
    assert.ok(!rendered.text.includes('ACTION REQUIRED'), '不该为"未入选"要求模型做记忆整理')
    assert.ok(rendered.text.includes(`未注入 ${rendered.omitted}`), '未入选数量仍出现在统计行里')
  })

  it('渲染遵守行数与字符双预算，并报告溢出', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry({
      entryId: `e${i}`,
      summary: `第 ${i} 条记忆摘要内容比较长一些用来占位`,
      body: `第 ${i} 条记忆摘要内容比较长一些用来占位`,
      mtime: Date.now() - i * 1000,
      recencyKey: `2026-01-01T00:${String(i % 60).padStart(2, '0')}`,
    }))
    const tight = resolveConfig({ indexMaxLines: 20, indexTopN: 60 })
    const rendered = renderIndexSnapshot({ entries: many, config: tight, now: Date.now() })
    assert.ok(rendered.lines <= 20, `行数应受控，实际 ${rendered.lines}`)
    assert.equal(rendered.overflow, true)
    assert.ok(rendered.text.includes('ACTION REQUIRED'), '默认 self-repair 应给出前置任务')
    assert.ok(rendered.included < 60)
  })

  it('silent-trim 策略下不输出自修复指令（对照 Qoder 的做法）', () => {
    const many = Array.from({ length: 40 }, (_, i) => entry({ entryId: `s${i}`, summary: `条目 ${i}`, body: `条目 ${i}` }))
    const rendered = renderIndexSnapshot({ entries: many, config: resolveConfig({ indexMaxLines: 12, indexTopN: 40, overflowPolicy: 'silent-trim' }), now: Date.now() })
    assert.equal(rendered.overflow, true)
    assert.ok(!rendered.text.includes('ACTION REQUIRED'))
    assert.ok(rendered.text.includes('mem_consolidate'))
  })

  it('条目总数以扫描结果为准（索引统计为 0 时不得对模型撒谎）', () => {
    const rendered = renderIndexSnapshot({ entries: [entry({})], stats: { entryCount: 0 }, config, now: Date.now() })
    assert.ok(rendered.text.includes('条目 1'))
  })

  it('陈旧徽标分级：超过 30 天标 (Nd)，超过 90 天标 ⚠Nd', () => {
    const now = Date.now()
    const entries = [
      entry({ entryId: 'fresh', date: new Date(now).toISOString().slice(0, 10), body: '新条目' }),
      entry({ entryId: 'aging', date: new Date(now - 45 * 86_400_000).toISOString().slice(0, 10), body: '四十五天前的条目' }),
      entry({ entryId: 'stale', date: new Date(now - 200 * 86_400_000).toISOString().slice(0, 10), body: '两百天前的条目' }),
    ]
    const rendered = renderIndexSnapshot({ entries, config, now })
    assert.ok(rendered.text.includes('(45d)'))
    assert.ok(rendered.text.includes('⚠200d'))
    assert.ok(rendered.text.includes('先核对现状') || rendered.text.includes('核对现状'))
  })

  it('空记忆集渲染出仍合法的骨架（调用方按条数决定是否注入）', () => {
    const rendered = renderIndexSnapshot({ entries: [], config, now: Date.now() })
    assert.equal(rendered.included, 0)
    assert.ok(rendered.text.includes('</memory_index>'))
  })
})