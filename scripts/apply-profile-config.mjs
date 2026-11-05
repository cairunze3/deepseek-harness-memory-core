/**
 * scripts/apply-profile-config.mjs — 把推荐配置写进 profile 的 cordis.patch.yml。
 *
 * 为什么要有这个脚本（而不是让用户手改 YAML）：
 *  1. 这次要改的是**用户机器上正在用的 profile**（`<dshHome>/profiles/web/cordis.patch.yml`），
 *     手改容易把 `insert:` 的缩进和 `file:///` 那条写坏，一坏就是整个 profile 起不来；
 *  2. 所以做法固定为：**先读 → 生成 diff → 备份 → 原子写（tmp + rename）**，
 *     并且把备份路径打印出来，回滚就是一行 copy。
 *
 * 改什么（只在 `id: vanwork-memory-core` 那个 insert 条目的 config 段里加/改键）：
 *  - `injectExclude`     与 dsh-memory-evolve 做注入分工（三条重叠轨让给它）
 *  - `exclusiveWritePath` 声明"只用 mem_* 写记忆" → mem_audit 的写入编排判定转为「是」
 *  - `indexTopN`          36（实测：默认 40 会溢出 8000 字符预算，36 刚好不溢）
 *
 * 用法：
 *   node scripts/apply-profile-config.mjs --dry-run     # 只打印 diff，不写任何文件（默认）
 *   node scripts/apply-profile-config.mjs --apply       # 备份 + 原子写入
 *   node scripts/apply-profile-config.mjs --apply --dsh-home "<路径>"   # 指定 dsh home
 *
 * 设计纪律：**幂等**（已经是目标值就什么都不做）、**可回滚**（备份路径打印 + 写入
 * rollback 脚本）、**只碰这一个条目**（其余内容逐字节不动）。
 *
 * @module vanwork-memory-core/scripts/apply-profile-config
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 要写入的目标配置（值来源见文件头注释）。 */
export const DESIRED_CONFIG = {
  // 2026-10-28：旧插件（dsh-memory-evolve）已被内置更新从活动 profile 移除，
  // 所以清空排除表——三条轨（全局 MEMORY.md / USER.md / 项目 KEY.md）从今往后
  // **由新插件自己注入**，不再让给别人。
  injectExclude: '[]',
  exclusiveWritePath: 'true',
  // 2026-10-28 用户拍板：降条数 + 抬字符预算，给"条目增长"留余量。
  indexTopN: '32',
  indexMaxChars: '10000',
}

const PLUGIN_ID = 'vanwork-memory-core'

function parseArgs(argv) {
  const out = { apply: false, dshHome: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true
    else if (argv[i] === '--dry-run') out.apply = false
    else if (argv[i] === '--dsh-home') out.dshHome = argv[i + 1]
  }
  return out
}

function resolvePatchPath(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'profiles', 'web', 'cordis.patch.yml'))
}

/**
 * 在文本里定位 `- insert:` 下 `id: vanwork-memory-core` 那一条的 config 段，
 * 并返回改写后的文本。
 *
 * 刻意用**行级**处理而不是引 YAML 库：本插件零依赖（profile 的 node_modules
 * 解析不到 runtime app 的包），而且这里只需要动"一个条目下的 config 键"——
 * 引一个 YAML 库去重排整份文件，反而会把用户手写的注释与顺序弄丢。
 *
 * @param {string} text - 原始 YAML 文本。
 * @param {object} desired - 目标键值（值按 YAML 字面量原样写）。
 * @returns {{ok: boolean, text?: string, changes?: string[], reason?: string}}
 */
export function patchProfileYaml(text, desired = DESIRED_CONFIG) {
  const lines = String(text).split(/\r?\n/)
  const idIndex = lines.findIndex((line) => new RegExp(`^\\s*-?\\s*id:\\s*${PLUGIN_ID}\\s*$`).test(line))
  if (idIndex === -1) return { ok: false, reason: `没找到 id: ${PLUGIN_ID} 的条目` }

  const idIndent = lines[idIndex].match(/^\s*/)[0].length
  // 该条目的范围：从 id 行到"下一个同级或更浅缩进的 `- ` 行"之前。
  let end = lines.length
  for (let i = idIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= idIndent && /^\s*-/.test(line)) { end = i; break }
  }

  const configIndex = (() => {
    for (let i = idIndex + 1; i < end; i += 1) {
      if (/^\s*config:\s*$/.test(lines[i])) return i
    }
    return -1
  })()

  const changes = []
  const next = [...lines]
  if (configIndex === -1) {
    // 没有 config 段 → 在条目末尾补一个（缩进沿用 id 行的缩进 + 2）
    const keyIndent = ' '.repeat(idIndent + 2)
    const inserted = [`${keyIndent}config:`]
    for (const [key, value] of Object.entries(desired)) {
      inserted.push(`${keyIndent}  ${key}: ${value}`)
      changes.push(`+ ${key}: ${value}`)
    }
    next.splice(end, 0, ...inserted)
    return { ok: true, text: next.join('\n'), changes }
  }

  // config 段的范围：从 config: 到下一个缩进 <= config 缩进的非空行
  const configIndent = lines[configIndex].match(/^\s*/)[0].length
  let configEnd = end
  for (let i = configIndex + 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= configIndent) { configEnd = i; break }
  }

  const keyIndent = ' '.repeat(configIndent + 2)
  for (const [key, value] of Object.entries(desired)) {
    const keyRe = new RegExp(`^\\s*${key}:`)
    const at = (() => {
      for (let i = configIndex + 1; i < configEnd; i += 1) if (keyRe.test(lines[i])) return i
      return -1
    })()
    const wanted = `${keyIndent}${key}: ${value}`
    if (at === -1) {
      next.splice(configEnd, 0, wanted)
      configEnd += 1
      changes.push(`+ ${key}: ${value}`)
    } else if (lines[at].trim() !== `${key}: ${value}`) {
      changes.push(`~ ${lines[at].trim()}  →  ${key}: ${value}`)
      next[at] = wanted
    }
  }
  return { ok: true, text: next.join('\n'), changes }
}

/**
 * 主流程。**只有直接运行本脚本时才执行**——被 `import` 时（单测会 import
 * `patchProfileYaml`）绝不能跑副作用，否则 `process.exit()` 会把测试进程带走。
 *
 * @param {string[]} argv - 命令行参数（不含 node 与脚本路径）。
 * @param {{log?: Function, error?: Function, stamp?: string}} [io] - 便于测试注入输出与固定时间戳。
 * @returns {number} 退出码。
 */
export function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((...args) => console.log(...args))
  const error = io.error ?? ((...args) => console.error(...args))

  const args = parseArgs(argv)
  const patchPath = resolvePatchPath(args.dshHome)

  if (!existsSync(patchPath)) {
    error(`✗ 没找到 profile patch：${patchPath}`)
    error('  用 --dsh-home "<dsh home 路径>" 指定，或设置 DSH_HOME。')
    return 2
  }

  const original = readFileSync(patchPath, 'utf8')
  const outcome = patchProfileYaml(original, DESIRED_CONFIG)

  if (!outcome.ok) {
    error(`✗ 无法定位配置段：${outcome.reason}`)
    error('  说明：本脚本只会改 `id: vanwork-memory-core` 那个条目的 config 段；')
    error('  如果条目结构变了（例如改成了独立 bundle 安装），请手工在 config: 下加这几行。')
    return 2
  }

  if (outcome.changes.length === 0) {
    log(`✓ 已经是目标配置，无需改动：${patchPath}`)
    return 0
  }

  log(`目标文件：${patchPath}`)
  log('将要做的改动：')
  for (const change of outcome.changes) log(`  ${change}`)
  log('\n--- 改动后的该条目（预览）---')
  {
    const lines = outcome.text.split('\n')
    const idIndex = lines.findIndex((l) => new RegExp(`^\\s*-?\\s*id:\\s*${PLUGIN_ID}\\s*$`).test(l))
    for (let i = Math.max(0, idIndex - 1); i < Math.min(lines.length, idIndex + 11); i += 1) log(`  ${lines[i]}`)
  }

  if (!args.apply) {
    log('\n（dry-run：没有写任何文件。确认无误后加 --apply 执行。）')
    return 0
  }

  const stamp = (io.stamp ?? new Date().toISOString()).replace(/[:.]/g, '-')
  const backupPath = `${patchPath}.bak-${stamp}`
  const tmpPath = `${patchPath}.tmp-${process.pid}`
  const rollbackPath = join(dirname(patchPath), 'rollback-memory-core-config.ps1')

  // 写备份的顺序很关键（本轮实测踩到过）：
  // 先 `copyFileSync` 再写新内容的写法，如果脚本在"还没写新内容"时被打断/被杀，
  // 会留下一个**0 字节的备份**——看起来有备份、实际回滚不了。
  // 所以改成：**把已经读进内存的 original 直接写进备份**（写入完成后校验字节数），
  // 这样备份要么是完整的改前内容、要么根本没生成。
  try {
    writeFileSync(backupPath, original, 'utf8')
    const backupSize = readFileSync(backupPath, 'utf8').length
    if (backupSize !== original.length) {
      error(`✗ 备份校验失败（写入 ${backupSize} 字节，期望 ${original.length}）——已中止，原文件未改。`)
      return 2
    }
    writeFileSync(tmpPath, outcome.text, 'utf8')
    renameSync(tmpPath, patchPath)
    writeFileSync(rollbackPath, [
      '# 回滚 vanwork-memory-core 的 profile 配置改动（由 scripts/apply-profile-config.mjs 生成）',
      `# 备份是"改动前"的完整内容（已按字节校验），直接覆盖回去即可。`,
      `Copy-Item -LiteralPath "${backupPath}" -Destination "${patchPath}" -Force`,
      `Write-Host "已回滚到：${backupPath}"`,
      '',
    ].join('\n'), 'utf8')
  } catch (err) {
    error(`✗ 写入失败：${err?.message ?? err}`)
    error(`  原文件未改；备份：${backupPath}`)
    return 2
  }

  log('\n✓ 已写入（备份先落盘并校验 → 原子 tmp + rename）')
  log(`  备份：${backupPath}（${original.length} 字节，改前内容）`)
  log(`  回滚：powershell -ExecutionPolicy Bypass -File "${rollbackPath}"`)
  log('  生效：重启 VanWork（或重开会话）后，用 mem_audit 看「写入编排归新插件」与 inject.self 的 injectExclude。')
  return 0
}

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined
      && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    return false
  }
})()

if (isDirectRun) {
  process.exit(main(process.argv.slice(2)))
}