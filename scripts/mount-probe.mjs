/**
 * scripts/mount-probe.mjs — 真实 cordis 装载探针。
 *
 * 为什么需要它：`scripts/verify.mjs` 用的是**忠实的 ctx 替身**，能证明逻辑正确，
 * 但证明不了"装进 DSH 之后真的能跑"。本探针把 DSH 自己的两个服务
 * （`@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools`）挂进一棵真实
 * cordis 树，再 `ctx.plugin()` 挂本插件 —— 于是 `apply()` 拿到的是真服务。
 *
 * 它验证 6 件事：
 *   1. 真实 cordis 树下 apply() 成功（fiber 达到 active）；
 *   2. 真实 `systemPrompt` / `tools` 服务可用；
 *   3. 全部 `mem_*` 工具进了**真实 ToolRuntime 注册表**；
 *   4. 真实 `systemPrompt.assemble()` 的 contexts 里出现 `memory-core:index`
 *      并且渲染出真实记忆条目（注入链路端到端成立）；
 *   5. 工具**经真实注册表**执行能改到真实文件（真服务、真文件、真索引）；
 *   6. 全程只写临时目录，不触碰任何 `$DSH_HOME/profiles`。
 *
 * 不写用户 profile、不启服务、不联网。
 *
 * 用法：
 *   node scripts/mount-probe.mjs [DSH 运行时 app 目录]
 * 缺省 app 目录按 VanWork 默认安装位置推断；也可用环境变量 DSH_RUNTIME_APP 指定。
 * 保留探针临时目录以便排查：KEEP_MOUNT=1 node scripts/mount-probe.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')

/**
 * 期望注册的全部工具名（顺序与 lib/tools.js 的 buildTools 一致）。
 * 放在这里当**单一事实源**：加工具时只改这一处，探针的 7/7 断言自动跟上
 * （早先硬编码 6 的行为在加 mem_audit 时静默变成了假绿）。
 */
const CORE_TOOLS = ['mem_search', 'mem_read', 'mem_write', 'mem_health', 'mem_audit', 'mem_consolidate', 'mem_reindex']

/** 推断 DSH 运行时 app 目录（含 node_modules/@deepseek-ai/* 的那一层）。 */
function resolveRuntimeApp() {
  const candidates = [
    process.argv[2],
    process.env.DSH_RUNTIME_APP,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'VanWork', 'resources', 'runtime', 'app') : null,
    '/Applications/VanWork.app/Contents/Resources/runtime/app',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const directory = resolve(candidate)
    if (existsSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'))) return directory
  }
  throw new Error(
    '找不到 DSH 运行时 app 目录（需要其 node_modules/@deepseek-ai/dsh-app-boot）。\n' +
    '请显式传入：node scripts/mount-probe.mjs "<...>/resources/runtime/app"，或设置 DSH_RUNTIME_APP。',
  )
}

const RUNTIME_APP = resolveRuntimeApp()
const APP = join(RUNTIME_APP, 'node_modules', '@deepseek-ai').replace(/\\/g, '/')
const mod = (name) => pathToFileURL(join(APP, name, 'lib', 'index.js')).href

const appBoot = await import(mod('dsh-app-boot'))
const systemPromptModule = await import(mod('dsh-system-prompt'))
const toolsModule = await import(mod('dsh-tools'))
const pluginModule = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href)

// 探针目录放在系统临时区（不污染工作区，也不碰 profile）
const sandbox = mkdtempSync(join(tmpdir(), 'memcore-mount-'))
const memoryDir = join(sandbox, 'memories')
const coreDir = join(sandbox, 'memory-core')
mkdirSync(join(memoryDir, 'daily'), { recursive: true })
mkdirSync(join(memoryDir, 'projects', 'p1'), { recursive: true })
writeFileSync(join(memoryDir, 'USER.md'), '[2026-01-01 09:00] 真实装载探针：用户偏好结论先行。\n', 'utf8')
writeFileSync(join(memoryDir, 'projects', 'p1', 'KEY.md'),
  '[2026-01-02 09:00] 项目约定：索引是派生物，可整份重建。\n', 'utf8')

const rootConfig = join(sandbox, 'cordis.yml')
writeFileSync(rootConfig, '[]\n', 'utf8')

/**
 * 场景二：**通过 patch 插入**（而不是 `ctx.plugin` 直接挂）——这决定"启用"该怎么写。
 *
 * 为什么要单独验：要启用一个不在托管发布清单里的插件，最耐久的方式是在
 * `cordis.patch.yml` 里直接 insert 一行（VanWork 自己的 `workbuddy-migrate`
 * 就是这么装的，而且随 profile 重建被带了过去）。那一行的 `name` 写什么形式有讲究：
 * 裸 Windows 绝对路径（`C:/…`）会被 Node 的 ESM 加载器拒绝（实测
 * `Only URLs with a scheme in: file, data, and node are supported …`），
 * 而 `file:///C:/…` 在两条路径上（有/无内部加载器）都成立。
 *
 * 本场景复现真实启动路径：`boot(bin, cfg, patches, prepare)` **只传 4 个参数**
 * （与 `runProfile` 一致，此时走普通 Include），并在 prepare 里提供
 * `profileContext`（真实启动会提供，从而使 preflight 生效）。
 */
async function scenarioPatchInsert() {
  console.log('\n═══ 场景二：通过 patch insert 启用（真实启动路径）═══')
  const dir = join(sandbox, 'patch-profile')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'cordis.yml')
  writeFileSync(configPath, '[]\n', 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe-profile', private: true }), 'utf8')

  const asUrl = (p) => pathToFileURL(p).href
  const asWindowsBare = (p) => p.replace(/\\/g, '/')
  // 注意形状：`patches` 是**扁平的 patch 操作列表**（`[{ insert: [...] }]`），
// 不是列表的列表——多套一层会被 applyEntryPatches 静默忽略（探针踩过）。
  const buildPatches = (pluginName) => [{
    insert: [
      { id: 'system-prompt', name: asUrl(join(APP, 'dsh-system-prompt', 'lib', 'index.js')) },
      { id: 'tools', name: asUrl(join(APP, 'dsh-tools', 'lib', 'index.js')) },
      { id: 'vanwork-memory-core', name: pluginName, config: { memoryDir, coreDir } },
    ],
  }]
  const profileContext = {
    name: 'probe',
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(RUNTIME_APP, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    startedBundles: [],
    cwd: process.cwd(),
    home: join(sandbox, 'home'),
    overlays: [],
    telemetryDisabledEnv: undefined,
  }

  const variants = [
    { label: 'file:// URL（推荐写法）', name: asUrl(join(PLUGIN_DIR, 'lib', 'index.js')), expectOk: true },
    { label: '裸 Windows 绝对路径（对照）', name: asWindowsBare(join(PLUGIN_DIR, 'lib', 'index.js')), expectOk: false },
  ]
  for (const variant of variants) {
    let ctx2 = null
    try {
      ctx2 = await appBoot.boot('memcore-insert-probe', configPath, buildPatches(variant.name), async (hostCtx) => {
        hostCtx.provide('profileContext', profileContext)
      })
      const names = CORE_TOOLS
      const registered = names.filter((name) => Boolean(ctx2.get('tools')?.get?.(name)))
      const detail = `${registered.length}/${CORE_TOOLS.length} 工具`
      if (variant.expectOk) check(`patch insert（${variant.label}）→ 装载成功`, registered.length === CORE_TOOLS.length, detail)
      else console.log(`ℹ️  patch insert（${variant.label}）：${detail}（本轮走普通 Include；宿主实机走 HostResolved 时才成立 → 所以推荐 file:// ）`)
    } catch (error) {
      const first = String(error?.message ?? error).split('\n')[0].slice(0, 140)
      if (variant.expectOk) check(`patch insert（${variant.label}）`, false, first)
      else console.log(`ℹ️  patch insert（${variant.label}）：抛错 —— ${first}`)
    } finally {
      await ctx2?.fiber?.dispose?.()
    }
  }
}

console.log(`运行时: ${RUNTIME_APP}`)
console.log(`探针目录: ${sandbox}`)
console.log(`插件导出: ${Object.keys(pluginModule).sort().join(', ')}`)

let ctx
try {
  ctx = await appBoot.boot('memcore-mount-probe', rootConfig, [], async (hostCtx) => {
    await hostCtx.plugin(systemPromptModule.default, {})
    await hostCtx.plugin(toolsModule.default, {})
    await hostCtx.plugin(pluginModule, { memoryDir, coreDir, dshHome: join(sandbox, 'home') })
  })
} catch (error) {
  console.error('装载失败:', error?.message ?? error)
  throw error
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  check(`cordis 树挂载成功（fiber state=${ctx.fiber.state}）`, ctx.fiber.state === 2)

  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  check('真实 tools 服务挂载（@deepseek-ai/dsh-tools）', Boolean(tools) && typeof tools.register === 'function')
  check('真实 systemPrompt 服务挂载（@deepseek-ai/dsh-system-prompt）',
    Boolean(systemPrompt) && typeof systemPrompt.assemble === 'function')

  const expected = CORE_TOOLS
  const registered = expected.filter((name) => Boolean(tools?.get?.(name)))
  check(`${CORE_TOOLS.length} 个 mem_* 工具进了真实 ToolRuntime（${registered.length}/${CORE_TOOLS.length}）`, registered.length === CORE_TOOLS.length, registered.join(', '))

  const assembly = await systemPrompt.assemble({})
  const contextNames = (assembly.contexts ?? []).map((entry) => entry.name)
  check('真实 assemble().contexts 含 memory-core:index', contextNames.includes('memory-core:index'), contextNames.join(', '))
  const rendered = (assembly.contexts ?? []).find((entry) => entry.name === 'memory-core:index')?.text ?? ''
  check('索引块渲染出真实记忆条目', rendered.includes('结论先行') || rendered.includes('USER.md#0'), `${rendered.length} 字符`)
  console.log('   渲染片段:', rendered.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 200))

  const reindex = tools?.get?.('mem_reindex')
  check('tools.get 返回可执行定义', Boolean(reindex) && typeof reindex.execute === 'function',
    reindex ? Object.keys(reindex).join(',') : '')
  if (reindex?.execute) {
    const firstLine = String(await reindex.execute({ force: true }, {}) ?? '').split('\n')[0]
    check('经真实注册表执行 mem_reindex', firstLine.includes('索引已刷新'), firstLine)
    check('索引落在探针 coreDir（未污染任何 profile）',
      existsSync(join(coreDir, 'memory-index.db')) || existsSync(join(coreDir, 'memory-index.json')))
  }
  const search = tools?.get?.('mem_search')
  if (search?.execute) {
    const out = String(await search.execute({ query: '索引 派生物', limit: 3 }, {}) ?? '')
    check('经真实注册表执行 mem_search 并命中', /命中 \d+ 条/.test(out), out.split('\n')[0])
    check('检索结果指针可用（不是 #undefined）', !out.includes('#undefined'))
  }
  const health = tools?.get?.('mem_health')
  if (health?.execute) {
    const out = String(await health.execute({ cloud: true }, {}) ?? '')
    check('mem_health 在真实树下可运行并输出云端分层', out.includes('云端分层'))
  }

  // 场景二必须在 sandbox 清理前跑（它复用同一个临时目录）
  await scenarioPatchInsert()
} finally {
  await ctx?.fiber?.dispose?.()
  if (process.env.KEEP_MOUNT === '1') console.log(`（KEEP_MOUNT=1，保留探针目录：${sandbox}）`)
  else rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 2)