/**
 * 装配与工具面的端到端回归测试（含项目身份解析）。
 *
 * 用最小的 cordis ctx 替身验证真实装配路径：DSH 只保证
 * `systemPrompt.context` / `tools.register` / `effect` 这几个接缝，
 * 所以测试也只依赖它们。
 */

import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { apply, name, inject, renderSnapshotFor } from '../lib/index.js'
import { normalizeRemoteUrl, projectHash, projectLabel, resolveProjectId, resolveProjectDir, memoryRoot, coreRoot, resolveDshHome } from '../lib/paths.js'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-plugin-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
let projectCwd
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
  projectCwd = mkdtempSync(join(sandbox, 'proj-'))
})

function fakeCtx() {
  const state = { contexts: [], tools: [], effects: 0 }
  return {
    state,
    systemPrompt: { context(definition) { state.contexts.push(definition); return () => {} } },
    tools: { register(definition) { if (state.tools.some((t) => t.name === definition.name)) throw new Error(`tool ${definition.name} already registered`); state.tools.push(definition); return () => {} } },
    effect(callback) { state.effects += 1; return callback() },
    on() { return () => {} },
    get() { return undefined },
  }
}

function seed() {
  mkdirSync(join(memoryDir, 'projects', 'p1'), { recursive: true })
  writeFileSync(join(memoryDir, 'USER.md'), '[2026-01-01 09:00] 用户偏好：结论先行。\n', 'utf8')
  writeFileSync(join(memoryDir, 'projects', 'p1', 'KEY.md'), '[2026-01-02 09:00] 项目约定：索引是派生物。\n', 'utf8')
}

describe('插件契约', () => {
  it('导出 name / inject / apply（cordis 装载器要求）', () => {
    assert.equal(name, 'vanwork-memory-core')
    // 只声明**必需**的两个服务。webServer（管理界面）故意不写进来：
    // 声明成必需会让"没有 web 服务的上下文"整个不装载（实测 mount-probe 7/7 → 0/7），
    // 而 `{ required, optional }` 对象形式本版 cordis 不认。所以运行期安全读取。
    assert.deepEqual(inject, ['systemPrompt', 'tools'])
    assert.equal(typeof apply, 'function')
  })

  it('装配注册一个注入块与八个 mem_ 工具', () => {
    seed()
    const ctx = fakeCtx()
    apply(ctx, { memoryDir, coreDir })
    assert.equal(ctx.state.contexts.length, 1)
    assert.equal(ctx.state.contexts[0].name, 'memory-core:index')
    assert.deepEqual(
      ctx.state.tools.map((t) => t.name),
      ['mem_search', 'mem_read', 'mem_write', 'mem_health', 'mem_global', 'mem_audit', 'mem_consolidate', 'mem_reindex'],
    )
  })

  it('工具名不与 dsh-memory-evolve 的命名空间重叠', () => {
    seed()
    const ctx = fakeCtx()
    apply(ctx, { memoryDir, coreDir })
    const occupied = new Set(['memory', 'memory_suggest', 'dtodo', 'skill_manage', 'memory_evolve_search_local_files'])
    for (const tool of ctx.state.tools) assert.ok(!occupied.has(tool.name), `${tool.name} 撞名`)
  })

  it('第二次装配命中 already registered 时跳过而不是让 apply 失败', () => {
    seed()
    const ctx = fakeCtx()
    ctx.systemPrompt.context = () => { throw new Error('prompt context "memory-core:index" is already registered') }
    assert.doesNotThrow(() => apply(ctx, { memoryDir, coreDir }))
    assert.equal(ctx.state.tools.length, 8, '注入注册失败不应连带工具注册失败')
  })

  it('injectIndex=false 时不注册注入；searchEnabled=false 时不注册工具', () => {
    seed()
    const ctx = fakeCtx()
    apply(ctx, { memoryDir, coreDir, injectIndex: false, searchEnabled: false })
    assert.equal(ctx.state.contexts.length, 0)
    assert.equal(ctx.state.tools.length, 0)
  })
})

describe('注入渲染', () => {
  it('空记忆集返回空串（不占用任何常驻预算）', () => {
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir })
    assert.equal(renderSnapshotFor(runtime, {}), '')
  })

  it('有记忆时渲染出索引块，且包含当前项目条目', () => {
    seed()
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir })
    const text = renderSnapshotFor(runtime, { agent: { session: { header: { cwd: projectCwd } } } })
    assert.ok(text.includes('<memory_index>'))
    assert.ok(text.includes('用户偏好：结论先行'))
    assert.ok(text.includes('</memory_index>'))
  })

  it('渲染是状态的确定函数（同一状态两次渲染文本一致，保护 prompt 缓存前缀）', () => {
    seed()
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir })
    const agent = { session: { header: { cwd: projectCwd } } }
    const first = renderSnapshotFor(runtime, { agent })
    const second = renderSnapshotFor(runtime, { agent })
    assert.equal(first, second)
  })

  it('内部异常降级为 degraded 提示，绝不抛进组装链路', () => {
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir })
    runtime.getSnapshot = () => { throw new Error('boom') }
    const text = renderSnapshotFor(runtime, {})
    assert.match(text, /status="degraded"/)
  })
})

describe('工具行为', () => {
  function setup() {
    seed()
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir })
    const byName = (toolName) => ctx.state.tools.find((t) => t.name === toolName)
    const exec = { agent: { session: { header: { cwd: projectCwd } } } }
    return { runtime, byName, exec }
  }

  it('mem_search 命中后给出可用的指针（不是 #undefined）', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_search').execute({ query: '索引 派生物', limit: 5 }, exec)
    assert.match(out, /命中 \d+ 条/)
    assert.ok(!out.includes('#undefined'), out)
    assert.match(out, /projects\/p1\/KEY\.md#0/)
  })

  it('mem_search 无命中时明确说"可能确实没有"，不编造', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_search').execute({ query: '量子计算机 低温制冷机 型号', limit: 5 }, exec)
    assert.match(out, /未命中/)
    assert.match(out, /不要据此编造/)
  })

  it('mem_read 能按指针读到完整正文并给出云端分层结论', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_read').execute({ pointer: 'USER.md#0' }, exec)
    assert.match(out, /记忆正文/)
    assert.match(out, /云端分层：离机=yes/)
    assert.match(out, /结论先行/)
  })

  it('mem_read 对越界序号给出可诊断的提示', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_read').execute({ pointer: 'USER.md#9' }, exec)
    assert.match(out, /只有 1 条/)
  })

  it('mem_write：pinned type 与写入门槛都强制生效', async () => {
    const { byName, exec } = setup()
    assert.match(await byName('mem_write').execute({ action: 'add', track: 'user', scope: 'project', content: 'x', confirm: true }, exec), /pinned type/)
    assert.match(await byName('mem_write').execute({ action: 'add', track: 'memory', scope: 'global', content: 'x' }, exec), /confirm=true/)
    const ok = await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '本轮进展。' }, exec)
    assert.match(ok, /已写入 daily\//)
    assert.ok(existsSync(join(memoryDir, 'daily')))
  })

  it('mem_write 追加到既有文件时保留原有条目', async () => {
    const { byName, exec } = setup()
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '第一条。' }, exec)
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '第二条。' }, exec)
    const today = new Date()
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const text = readFileSync(join(memoryDir, 'daily', `${stamp}.md`), 'utf8')
    assert.ok(text.includes('第一条。') && text.includes('第二条。'))
  })

  it('mem_health 给出预算 / 陈旧 / 整合 / 云端 / 审计五段', async () => {
    const { byName, exec } = setup()
    const out = await byName('mem_health').execute({ cloud: true }, exec)
    for (const section of ['常驻索引预算', '陈旧性', '整合（dream）', '云端分层', '审计账本']) {
      assert.ok(out.includes(section), `缺少 ${section}`)
    }
  })

  it('mem_consolidate 的自我修复流程：plan → apply → reindex', async () => {
    const { byName, exec } = setup()
    mkdirSync(join(memoryDir, 'daily'), { recursive: true })
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    writeFileSync(join(memoryDir, 'daily', `${old}.md`), `[${old} 10:00] 很久以前的一条日志。\n`, 'utf8')

    const status = await byName('mem_consolidate').execute({ action: 'status' }, exec)
    assert.match(status, /候选规模/)
    const plan = await byName('mem_consolidate').execute({ action: 'plan' }, exec)
    const planId = /planId="([^"]+)"/.exec(plan)?.[1]
    assert.ok(planId, plan)
    assert.match(await byName('mem_consolidate').execute({ action: 'apply', planId, confirm: false }, exec), /confirm=true/)
    const applied = await byName('mem_consolidate').execute({ action: 'apply', planId, confirm: true }, exec)
    assert.match(applied, /整合完成/)
    assert.match(await byName('mem_reindex').execute({ force: true }, exec), /索引已刷新/)
  })

  it('mem_write：supersede 无 confirm 被拒；有 confirm 则新结论生效、旧结论留档', async () => {
    const { byName, exec } = setup()
    const write = byName('mem_write')
    await write.execute({ action: 'add', track: 'key', scope: 'project', content: '架构决策：检索走 BM25。', confirm: true }, exec)
    // project 轨不在"需要 confirm"名单里，所以它能走到 supersede 自己的闸门
    await write.execute({ action: 'add', track: 'project', scope: 'project', content: '项目约定：验证用条目。' }, exec)

    // ① 授权闸门：key 轨先被"写入门槛"拦下；project 轨则由 supersede 自己的闸门拦下
    const refusedKey = await write.execute({ action: 'supersede', track: 'key', scope: 'project', match: '检索走 BM25。', content: '架构决策：检索走 BM25 + 可选向量融合。' }, exec)
    assert.match(refusedKey, /confirm=true/)
    const refusedProject = await write.execute({ action: 'supersede', track: 'project', scope: 'project', match: '验证用条目', content: 'x' }, exec)
    assert.match(refusedProject, /拒绝 supersede/)

    // ② 正常路径
    const out = await write.execute({
      action: 'supersede', track: 'key', scope: 'project',
      match: '架构决策：检索走 BM25。',
      content: '架构决策：检索走 BM25 + 可选向量融合。',
      confirm: true,
    }, exec)
    assert.match(out, /已取代/)
    assert.match(out, /旧结论/)
    assert.match(out, /新结论已写入/)

    const keyFile = join(memoryDir, 'projects', 'p1', 'KEY.md')
    const key = readFileSync(keyFile, 'utf8')
    assert.ok(!key.includes('架构决策：检索走 BM25。'), '旧结论已从本位移出')
    assert.ok(key.includes('可选向量融合'), '新结论已生效')

    // ③ 旧结论留档在归档轨，且带取代标记 + 取代者 id
    //    （路径与 dsh-memory-evolve 的 ArchiveStore 同名 → 记忆 Tab 归档页可见）
    const archiveFile = join(memoryDir, 'projects', 'p1', 'KEY-archive.md')
    assert.ok(existsSync(archiveFile), '归档文件已建')
    const archived = readFileSync(archiveFile, 'utf8')
    assert.ok(archived.includes('架构决策：检索走 BM25。'), '旧结论**留档**而不是被抹掉')
    assert.match(archived, /\[superseded-by:[0-9a-f]{20}\]/)

    // ④ 留档的旧结论不再进常驻索引（不再误导）
    const injected = renderSnapshotFor(
      apply(fakeCtx(), { memoryDir, coreDir }).runtime,
      { agent: { session: { header: { cwd: projectCwd } } } },
    )
    assert.ok(!injected.includes('检索走 BM25。'), '被取代的结论不该出现在注入索引里')
  })

  it('mem_write：supersede 支持用已有条目取代（replacement）', async () => {
    const { byName, exec } = setup()
    const write = byName('mem_write')
    await write.execute({ action: 'add', track: 'key', scope: 'project', content: '结论 A：端口是 8080。', confirm: true }, exec)
    await write.execute({ action: 'add', track: 'key', scope: 'project', content: '结论 B：端口是 9000。', confirm: true }, exec)
    const search = String(await byName('mem_search').execute({ query: '结论 B', limit: 3 }, exec) ?? '')
    const pointer = /指针：(\S+)/.exec(search)?.[1]
    assert.ok(pointer, search)
    const out = await write.execute({ action: 'supersede', track: 'key', scope: 'project', match: '结论 A：端口是 8080。', replacement: pointer, confirm: true }, exec)
    assert.match(out, /已取代/)
    assert.match(out, /已有条目/)
  })

  it('每次检索/写入都落审计账本（可观测性）', async () => {
    const { runtime, byName, exec } = setup()
    await byName('mem_search').execute({ query: '索引', limit: 3 }, exec)
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '审计测试。' }, exec)
    const kinds = runtime.ledger.tail({ limit: 20 }).map((record) => record.k)
    assert.ok(kinds.includes('search'))
    assert.ok(kinds.includes('write'))
  })
})

describe('配置项真的生效（不留"装饰性配置"）', () => {
  function setup(config) {
    seed()
    const ctx = fakeCtx()
    const { runtime } = apply(ctx, { memoryDir, coreDir, ...config })
    const byName = (toolName) => ctx.state.tools.find((t) => t.name === toolName)
    const exec = { agent: { session: { header: { cwd: projectCwd } } } }
    return { runtime, byName, exec, ctx }
  }

  it('ledgerEnabled=false → 账本整体关闭，工具不会因为账本为 null 而报错', async () => {
    const { runtime, byName, exec } = setup({ ledgerEnabled: false })
    assert.equal(runtime.ledger, null)
    const out = await byName('mem_search').execute({ query: '索引', limit: 3 }, exec)
    assert.match(out, /命中|未命中/)
    assert.match(await byName('mem_health').execute({}, exec), /账本未启用/)
  })

  it('pinnedTypeEnforcement=false → 允许把 user 写进项目目录（明确放弃那道防线）', async () => {
    const strict = setup({})
    assert.match(await strict.byName('mem_write').execute({ action: 'add', track: 'user', scope: 'project', content: 'x', confirm: true }, strict.exec), /pinned type/)
    const loose = setup({ pinnedTypeEnforcement: false })
    const out = await loose.byName('mem_write').execute({ action: 'add', track: 'user', scope: 'project', content: 'x', confirm: true }, loose.exec)
    assert.match(out, /已写入 projects\//)
  })

  it('allowUserScopeWrite=false → user 轨整体禁写', async () => {
    const { byName, exec } = setup({ allowUserScopeWrite: false })
    assert.match(await byName('mem_write').execute({ action: 'add', track: 'user', scope: 'global', content: 'x', confirm: true }, exec), /allowUserScopeWrite/)
  })

  it('backupBeforeWrite=false → 不生成备份（换取磁盘空间，放弃回滚）', async () => {
    const { byName, exec } = setup({ backupBeforeWrite: false })
    await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '第一条。' }, exec)
    const out = await byName('mem_write').execute({ action: 'add', track: 'daily', scope: 'global', content: '第二条。' }, exec)
    assert.match(out, /已写入/)
    assert.ok(!existsSync(join(coreDir, 'backups')), '关闭备份后不应创建备份目录')
  })

  it('writeRequiresConfirmation=false → memory 轨可直接写入（自动模式）', async () => {
    const { byName, exec } = setup({ writeRequiresConfirmation: false })
    assert.match(await byName('mem_write').execute({ action: 'add', track: 'memory', scope: 'global', content: '自动模式的全局事实。' }, exec), /已写入 MEMORY\.md/)
  })
})

describe('paths · 项目身份', () => {
  it('normalizeRemoteUrl 让 https 与 ssh 收敛到同一身份键', () => {
    const https = normalizeRemoteUrl('https://github.com/user/repo.git')
    const ssh = normalizeRemoteUrl('git@github.com:user/repo.git')
    const sshUrl = normalizeRemoteUrl('ssh://git@github.com/user/repo')
    assert.equal(https, 'github.com/user/repo')
    assert.equal(ssh, https)
    assert.equal(sshUrl, https)
  })

  it('不可共享形态返回 undefined（file:// 与本地路径）', () => {
    assert.equal(normalizeRemoteUrl('file:///Users/cai/repo'), undefined)
    assert.equal(normalizeRemoteUrl('C:\\Users\\cai\\repo'), undefined)
    assert.equal(normalizeRemoteUrl('/Users/cai/repo'), undefined)
  })

  it('无 git 仓库时回退 sha1(cwd) 前 12 位（与 memory-evolve 兼容）', () => {
    const identity = resolveProjectId(projectCwd)
    assert.equal(identity.kind, 'fallback')
    assert.equal(identity.id, projectHash(projectCwd))
    assert.match(identity.id, /^[0-9a-f]{12}$/)
  })

  it('projectLabel 对过短/纯数字末段取末两段', () => {
    assert.equal(projectLabel('/data/260805/1'), '260805/1')
    assert.equal(projectLabel('/Users/cai/VanWork'), 'VanWork')
  })

  it('只有一个项目目录时写入回退到它（务实回退，可关）', () => {
    mkdirSync(join(memoryDir, 'projects', 'onlyone'), { recursive: true })
    const resolved = resolveProjectDir(memoryDir, projectCwd)
    assert.equal(resolved.id, 'onlyone')
    assert.equal(resolved.viaFallback, true)
    const strict = resolveProjectDir(memoryDir, projectCwd, { allowSingleProjectFallback: false })
    assert.equal(strict.viaFallback, false)
    assert.equal(strict.existed, false)
  })

  it('DSH home 解析优先级：显式配置 > $DSH_HOME > ~/.dsh', () => {
    const explicit = resolveDshHome('/tmp/explicit', { DSH_HOME: '/tmp/env' })
    assert.ok(explicit.includes('explicit'))
    const fromEnv = resolveDshHome(null, { DSH_HOME: '/tmp/env' })
    assert.ok(fromEnv.includes('env'))
    const blank = resolveDshHome(null, { DSH_HOME: '   ' })
    assert.ok(blank.includes('.dsh'), '空白 DSH_HOME 视为未设置')
  })

  it('memoryRoot / coreRoot 默认落在 DSH home 下且互不覆盖', () => {
    const config = { dshHome: sandbox }
    assert.ok(memoryRoot(config).endsWith('memories'))
    assert.ok(coreRoot(config).endsWith('memory-core'))
    assert.notEqual(memoryRoot(config), coreRoot(config))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('包文件完整性：BOM 会让整个插件被静默禁用', () => {
  // 实测事故（2026-10-27）：用 PowerShell 的 `Set-Content -Encoding UTF8` 改版本号
  // 会写入 UTF-8 BOM。宿主读取 package.json 做 peer deps 校验时直接抛
  //   Unexpected token '﻿', "﻿{"name"... is not valid JSON
  // 于是 "disabling profile plugin row \"vanwork-memory-core\""——**插件整体不装载**。
  // 而 210 个单测全绿（它们 import 源码，不经过宿主装载路径），只有 mount-probe /
  // profile-probe 会暴露。所以这里钉两颗钉子。
  it('package.json 无 BOM 且是合法 JSON', () => {
    const raw = readFileSync(join(pluginRoot, 'package.json'), 'utf8')
    assert.ok(!raw.startsWith('\uFEFF'), 'package.json 不能有 UTF-8 BOM')
    assert.equal(raw.charCodeAt(0), 123, 'package.json 必须以 { 开头')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.name, 'vanwork-memory-core')
    assert.match(parsed.version, /^\d+\.\d+\.\d+$/)
  })

  it('lib/ 下的源码无 BOM', () => {
    const files = readdirSync(join(pluginRoot, 'lib'))
    assert.ok(files.length > 0)
    for (const file of files) {
      const raw = readFileSync(join(pluginRoot, 'lib', file), 'utf8')
      assert.ok(!raw.startsWith('\uFEFF'), `lib/${file} 不能有 BOM`)
    }
  })
})