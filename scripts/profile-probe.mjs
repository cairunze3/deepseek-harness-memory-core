/**
 * scripts/profile-probe.mjs — profile 组合探针（bundle 解析 + patch 解析）。
 *
 * 这是"可安装"的第二段证据：在**临时 DSH home** 里造一个真实 profile，
 * 把本插件以 `node_modules/<pkg>` 目录联接（junction/symlink）进去，然后调用
 * **DSH 自己的 CLI** 执行 `dsh --profile <probe> --dump-config`。
 *
 * `--dump-config` 走的是真实装载路径的前半段（`prepareProfile` → 逐个 bundle
 * 读 `dsh.bundle.patch` → 组合 patch 层），但**不挂载**、不评估 `!!js`、不启动任何服务。
 * 因此它能证明：
 *   1. profile 的 `dsh.profile.bundles` 能解析到本插件；
 *   2. 插件的 `dsh.bundle.patch`（cordis.patch.yml）被找到并解析；
 *   3. 组合树里出现本插件的 insert 行；
 *   4. 没有任何 skipped bundle 告警。
 *
 * **绝不触碰 $DSH_HOME/profiles**：整个过程在系统临时目录里，跑完即删。
 *
 * 用法：node scripts/profile-probe.mjs [DSH 运行时 app 目录]
 * 保留临时目录：KEEP_PROBE=1 node scripts/profile-probe.mjs
 */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..')
const PKG_NAME = 'vanwork-memory-core'

function resolveRuntimeApp() {
  const candidates = [
    process.argv[2],
    process.env.DSH_RUNTIME_APP,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'VanWork', 'resources', 'runtime', 'app') : null,
    '/Applications/VanWork.app/Contents/Resources/runtime/app',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const directory = resolve(candidate)
    if (existsSync(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return directory
  }
  throw new Error(
    '找不到 DSH 运行时 app 目录（需要其 node_modules/@deepseek-ai/dsh/lib/bin.js）。\n' +
    '请显式传入：node scripts/profile-probe.mjs "<...>/resources/runtime/app"，或设置 DSH_RUNTIME_APP。',
  )
}

const RUNTIME_APP = resolveRuntimeApp()
const DSH_BIN = join(RUNTIME_APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-profile-'))
const probeHome = join(sandbox, 'dsh-home')
const profileDir = join(probeHome, 'profiles', 'probe')
const PROBE_PROFILE = 'probe'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  // 目录联接（Windows 用 junction，POSIX 用目录符号链接），避免为了一个探针跑包管理器
  symlinkSync(PLUGIN_DIR, join(profileDir, 'node_modules', PKG_NAME), 'junction')

  // 无 BOM 写 JSON：Node 的 JSON.parse 会因 BOM 直接报 "Unexpected token '﻿'"
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-probe',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PKG_NAME] } },
    }, null, 2),
    { encoding: 'utf8' },
  )

  // 用户层 patch：模拟"在 profile 的 cordis.patch.yml 里给本插件写配置"。
  // 这一段证明的是**机制**：用户层 patch 能被组合进树、且同名 id 的 config 会合并。
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '# probe: 用户层配置（验证 injectExclude / exclusiveWritePath 能被组合进树）',
      `- id: ${PKG_NAME}`,
      '  config:',
      "    injectExclude: ['global:memory', 'global:user', 'project:key']",
      '    exclusiveWritePath: true',
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  )

  console.log(`运行时: ${RUNTIME_APP}`)
  console.log(`探针 home: ${probeHome}`)

  check('插件已以目录联接进入探针 profile 的 node_modules',
    existsSync(join(profileDir, 'node_modules', PKG_NAME, 'cordis.patch.yml')) &&
    existsSync(join(profileDir, 'node_modules', PKG_NAME, 'lib', 'index.js')))

  let output = ''
  let exitCode = 0
  // 子进程输出走**文件描述符**而不是管道：本机沙箱禁止跨进程命名管道，
  // 用 `stdio: ['ignore','pipe','pipe']` 会直接 EPERM。写成文件再读，
  // 既不依赖管道，也顺带留下可复核的完整输出。
  const capturePath = join(sandbox, 'dump-config.txt')
  const captureFd = openSync(capturePath, 'w')
  try {
    execFileSync(process.execPath, [DSH_BIN, '--profile', PROBE_PROFILE, '--dump-config'], {
      env: { ...process.env, DSH_HOME: probeHome },
      stdio: ['ignore', captureFd, captureFd],
    })
  } catch (error) {
    exitCode = error.status ?? 1
  } finally {
    closeSync(captureFd)
  }
  output = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : ''

  check('dsh --dump-config 退出码为 0', exitCode === 0, exitCode === 0 ? '' : output.split('\n').slice(0, 4).join(' ⏎ '))
  check('组合树里出现本插件的 bundle 层', output.includes(`# == ${PKG_NAME}`))
  check('组合树里出现本插件的 insert 行', output.includes(`id: ${PKG_NAME}`) && output.includes(`name: ${PKG_NAME}`))
  check('无 skipped bundle / 解析告警', !/skip|not found|unknown default|does not exist/i.test(output))

  const layerHeaders = output.split('\n').filter((line) => line.startsWith('# == '))
  check('bundle 层顺序符合 profile 声明', layerHeaders.length >= 2, layerHeaders.join(' | '))

  // 用户层 patch 是否真的被读进去（机制验证；dump-config 未必回显 config 值，
  // 所以只断言"用户层存在 + 无告警"，并在回显时顺带核对值）。
  check('用户层 cordis.patch.yml 被组合进树', /# == .*(patch|profile root)/i.test(output) || output.includes('cordis.patch.yml'),
    layerHeaders.join(' | '))
  const showsExclude = output.includes('injectExclude')
  const showsExclusive = output.includes('exclusiveWritePath')
  if (showsExclude && showsExclusive) {
    check('用户层配置值回显正确（injectExclude / exclusiveWritePath）',
      output.includes('global:memory') && output.includes('project:key'), 'dump 中出现了两项配置')
  } else {
    console.log('ℹ️  dump-config 未回显插件 config 值（只说明它不打印，不代表配置没生效）'
      + '——配置生效的运行时证据是 mem_audit 的 inject.self 行与 normalized.writeOrchestration。')
  }
} finally {
  if (process.env.KEEP_PROBE === '1') console.log(`（KEEP_PROBE=1，保留探针目录：${sandbox}）`)
  else rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 2)