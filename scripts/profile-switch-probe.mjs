/**
 * scripts/profile-switch-probe.mjs — 「禁用旧记忆插件 + 启用新插件」的启动安全验证。
 *
 * 为什么需要它：VanWork 有一套**托管升级系统**（`managed-upgrades/active-release.json`
 * 的 release manifest + revision）在管 profile。所以"禁用"要解决的真正问题是：
 *   ① 用哪种手段禁用，才不会被开机时的清单校验冲掉？
 *   ② 禁用之后启动会不会报错 / 留一个没有后端的 UI 半身？
 *
 * 本探针把**真实 profile 的副本**放进临时 DSH home（package.json + cordis.patch.yml +
 * 对真实 node_modules 的目录联接），跑**真实的 `dsh --dump-config`**，对比两个变体：
 *   baseline  —— 原样（旧插件启用）
 *   switched  —— cordis.patch.yml 顶层加 `- id: dsh-memory-evolve / disabled: true`，
 *                并把新插件加进 bundles
 *
 * 断言：两个变体都组合成功；switched 变体里旧插件行带 `disabled: true`、新插件行存在；
 * 且**没有任何 skipped bundle 告警**（说明"bundle 仍装着但行被禁用"是受支持的组合，
 * 不会触发清单校验失败）。
 *
 * 全程只读真实 profile、只写系统临时目录。用法：
 *   node scripts/profile-switch-probe.mjs [DSH home 路径] [运行时 app 路径]
 * 保留临时目录：KEEP_PROBE=1
 */

import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const NEW_PLUGIN = 'vanwork-memory-core'
const OLD_PLUGIN = 'dsh-memory-evolve'
const PROFILE = 'web'

function resolveRuntimeApp() {
  const candidates = [
    process.argv[3],
    process.env.DSH_RUNTIME_APP,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'VanWork', 'resources', 'runtime', 'app') : null,
    '/Applications/VanWork.app/Contents/Resources/runtime/app',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const directory = resolve(candidate)
    if (existsSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return directory
  }
  throw new Error('找不到 DSH 运行时 app 目录（需要其 node_modules/@deepseek-ai/dsh/lib/bin.js）；用第三个参数或 DSH_RUNTIME_APP 指定。')
}

function resolveRealDshHome() {
  const candidates = [
    process.argv[2],
    process.env.DSH_HOME,
    process.env.APPDATA
      ? null // 账号目录带随机 id，不猜；要求显式传入或走 $DSH_HOME
      : null,
    '/Applications/VanWork.app/Contents/Resources/runtime/app/../../../dsh-home',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const home = resolve(candidate)
    const profileDir = join(home, 'profiles', PROFILE)
    if (existsSync(join(profileDir, 'package.json'))) return home
  }
  throw new Error(`找不到真实 DSH home（需要 <home>/profiles/${PROFILE}/package.json）；请把 home 路径作为第一个参数或设置 $DSH_HOME。`)
}

const RUNTIME_APP = resolveRuntimeApp()
const DSH_BIN = join(RUNTIME_APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const REAL_HOME = resolveRealDshHome()
const REAL_PROFILE = join(REAL_HOME, 'profiles', PROFILE)
const REAL_MODULES = join(REAL_PROFILE, 'node_modules')

console.log(`运行时: ${RUNTIME_APP}`)
console.log(`真实 home（只读）: ${REAL_HOME}`)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-switch-'))

/** 造一个临时 profile：复制真实配置 + 对真实 node_modules 做目录联接（不复制大包）。 */
function makeVariant(name, { addDisable, addBundles }) {
  const home = join(sandbox, `home-${name}`)
  const profileDir = join(home, 'profiles', PROFILE)
  const modulesDir = join(profileDir, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })

  // 配置层：原样复制真实 profile 的用户层与根配置
  for (const file of ['cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const source = join(REAL_PROFILE, file)
    if (existsSync(source)) copyFileSync(source, join(profileDir, file))
  }

  // package.json：只保留能解析的 bundle。
  // 为什么只留 base + 旧记忆插件（+ 新插件）：本机沙箱**禁止目录联接指向
  // 允许根之外的目标**（symlinkSync → EPERM），所以无法把 %APPDATA% 下的
  // 第三方包"链接"进临时 profile。改为**只复制 --dump-config 真正需要的两个
  // 文件**（package.json + cordis.patch.yml）——bundle 解析与 patch 解析都只读
  // 这两样，`lib/` 在这里用不上。其余插件不进 bundles，因此不会产生 skip 噪声。
  const manifest = JSON.parse(readFileSync(join(REAL_PROFILE, 'package.json'), 'utf8'))
  const bundles = ['@deepseek-ai/dsh-base', OLD_PLUGIN]
  if (addBundles) bundles.push(NEW_PLUGIN)
  manifest.dependencies = {
    [OLD_PLUGIN]: 'file:./vendor/dsh-memory-evolve',
    ...(addBundles ? { [NEW_PLUGIN]: `file:${PLUGIN_DIR.replace(/\\/g, '/')}` } : {}),
  }
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8' })

  // 夹具自检：bundle 解析走 `createRequire(<profileDir>/package.json).resolve.paths(pkg)`
  // → `join(searchPath, pkg)/package.json` 必须真实存在。夹具没搭好就会让
  // 所有 bundle 被 skip，从而验不出任何东西（第一版探针正是栽在这里）。
  const broken = []
  const oldDir = join(modulesDir, OLD_PLUGIN)
  mkdirSync(oldDir, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) {
    const source = join(REAL_MODULES, OLD_PLUGIN, file)
    if (!existsSync(source)) { broken.push(`${OLD_PLUGIN}/${file} 在真实安装里不存在`); continue }
    copyFileSync(source, join(oldDir, file))
  }
  if (!existsSync(join(oldDir, 'package.json'))) broken.push(`${OLD_PLUGIN} 的 package.json 未就位`)

  // 新插件在本工作区内，联接是允许的（也可直接复制，体积很小）
  if (addBundles) {
    const newLink = join(modulesDir, NEW_PLUGIN)
    if (!existsSync(newLink)) {
      mkdirSync(dirname(newLink), { recursive: true })
      try {
        symlinkSync(PLUGIN_DIR, newLink, 'junction')
      } catch (error) {
        broken.push(`${NEW_PLUGIN} 联接失败：${error.code ?? error.message}`)
      }
    }
    if (!existsSync(join(newLink, 'package.json'))) broken.push(`${NEW_PLUGIN} 的 package.json 未就位`)
  }

  // 用户层覆盖：禁用旧插件
  if (addDisable) {
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const base = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    writeFileSync(
      patchPath,
      `${base}\n# 禁用旧的记忆插件（宿主重建 profile 时会带上这个用户层文件，所以这一行能存活）\n- id: ${OLD_PLUGIN}\n  disabled: true\n`,
      { encoding: 'utf8' },
    )
  }
  return { home, broken }
}

/** 跑真实 dsh --dump-config；子进程输出走文件描述符（本机沙箱禁止管道）。 */
function dumpConfig(home) {
  const capturePath = join(sandbox, `dump-${Date.now()}.txt`)
  const fd = openSync(capturePath, 'w')
  let code = 0
  try {
    execFileSync(process.execPath, [DSH_BIN, '--profile', PROFILE, '--dump-config'], {
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', fd, fd],
    })
  } catch (error) {
    code = error.status ?? 1
  } finally {
    closeSync(fd)
  }
  return { code, output: existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '' }
}

/** 从组合树里取出某个条目所在的行块（到下一个顶层 `- ` 为止）。 */
function rowBlock(output, id) {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => line === `- id: ${id}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('- '))
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

/** 诊断输出：bundle 层头 + 任何 skip / 告警行。组合失败时用来定位原因。 */
function diagnostics(output, label) {
  const headers = output.split('\n').filter((line) => line.startsWith('# == '))
  const warnings = output.split('\n').filter((line) => /\bskip|not found|does not exist|warn|unknown default|error/i.test(line))
  console.log(`   [${label}] bundle 层: ${headers.join(' | ') || '（无）'}`)
  if (warnings.length > 0) console.log(`   [${label}] 告警/诊断: ${warnings.slice(0, 6).join(' ⏎ ')}`)
}

try {
  // ── baseline：旧插件启用、新插件未装 ─────────────────────────────────
  const baselineVariant = makeVariant('baseline', { addDisable: false, addBundles: false })
  check('夹具自检：临时 profile 的 bundle 可解析', baselineVariant.broken.length === 0, baselineVariant.broken.join(' / '))
  const baseline = dumpConfig(baselineVariant.home)
  console.log('\n── baseline（原样：旧插件启用）──')
  diagnostics(baseline.output, 'baseline')
  check('组合成功（exit 0）', baseline.code === 0, baseline.code === 0 ? '' : baseline.output.split('\n').slice(0, 3).join(' ⏎ '))
  const baselineOld = rowBlock(baseline.output, OLD_PLUGIN)
  check('旧插件行存在', baselineOld !== null)
  check('旧插件默认未禁用', baselineOld !== null && !/disabled: true/.test(baselineOld))
  check('无 skipped bundle 告警', !/skip|not found|unknown default|does not exist/i.test(baseline.output))

  // ── switched：禁用旧插件 + 启用新插件 ────────────────────────────────
  const switchedVariant = makeVariant('switched', { addDisable: true, addBundles: true })
  check('夹具自检：旧+新插件均可解析', switchedVariant.broken.length === 0, switchedVariant.broken.join(' / '))
  const switched = dumpConfig(switchedVariant.home)
  console.log('\n── switched（禁用旧插件 + 启用新插件）──')
  diagnostics(switched.output, 'switched')
  check('组合成功（exit 0）', switched.code === 0, switched.code === 0 ? '' : switched.output.split('\n').slice(0, 3).join(' ⏎ '))

  const switchedOld = rowBlock(switched.output, OLD_PLUGIN)
  check('旧插件行仍存在（bundle 未卸载 → 宿主清单校验不会认为插件丢失）', switchedOld !== null)
  check('旧插件被禁用（disabled: true）', switchedOld !== null && /disabled: true/.test(switchedOld),
    switchedOld ? switchedOld.split('\n').filter((l) => l.includes('disabled')).join(' ') : '')
  const switchedNew = rowBlock(switched.output, NEW_PLUGIN)
  check('新插件行出现', switchedNew !== null, switchedNew ? switchedNew.replace(/\n/g, ' ') : '')
  check('无 skipped bundle / 解析告警（bundle 在册但行被禁用是受支持的组合）',
    !/skip|not found|unknown default|does not exist/i.test(switched.output))

  console.log('\n── switched 的关键片段 ──')
  console.log(switchedOld ?? '（未找到旧插件行）')
  console.log(switchedNew ?? '（未找到新插件行）')

  console.log(`\n说明：真实 profile 只被读取，未做任何修改；临时目录 = ${sandbox}`)
} finally {
  if (process.env.KEEP_PROBE === '1') console.log(`（KEEP_PROBE=1，保留：${sandbox}）`)
  else rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 2)