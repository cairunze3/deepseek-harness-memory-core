/**
 * lib/paths.js — 记忆根目录与「跨设备稳定的项目身份」解析。
 *
 * 本模块刻意与 dsh-memory-evolve 的 `lib/sync/identity.js` **算法兼容**：
 * 项目身份 = 主仓库 git remote 归一化键的 sha1 前 12 位；无 remote 或不可
 * 共享形态（file://、本地路径）回退 `sha1(cwd)` 前 12 位。兼容的意义是
 * **两个插件指向同一个 `projects/<projectId>/` 目录**，不会把同一个项目
 * 拆成两份记忆。
 *
 * 这里修正了 Qoder 报告点名的一个缺陷：Qoder 用「工作区绝对路径 slug」
 * 命名记忆目录，重命名/移动工作区即静默丢失记忆。git remote 身份对
 * clone 方式、协议、盘符、目录名都不敏感。
 *
 * @module vanwork-memory-core/lib/paths
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { sha1hex } from './fsutil.js'

/** 默认 DSH home 目录名（与 @deepseek-ai/dsh-home-paths 保持一致）。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/** 默认记忆目录名（memory-evolve 用的 `<dshHome>/memories`）。 */
export const DEFAULT_MEMORY_DIR_NAME = 'memories'

/** 本插件自有状态目录名（索引 DB、账本、整合状态——全部可重建）。 */
export const CORE_DIR_NAME = 'memory-core'

/**
 * 解析 DSH home。优先级：显式配置 > `$DSH_HOME` > `~/.dsh`。
 * 空白字符串视为未设置（避免把 home 解析成当前目录）。
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.DSH_HOME
  const picked = (typeof configured === 'string' && configured.trim() !== '')
    ? configured
    : (typeof fromEnv === 'string' && fromEnv.trim() !== '')
      ? fromEnv
      : join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(expandHome(picked))
}

/** 展开 `~` / `~/` 前缀。 */
export function expandHome(path) {
  const p = String(path)
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** 记忆根目录：`<dshHome>/memories`（可配置）。 */
export function memoryRoot(config = {}) {
  const configured = config.memoryDir
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHome(configured))
  return join(resolveDshHome(config.dshHome), DEFAULT_MEMORY_DIR_NAME)
}

/** 插件自有状态目录：`<dshHome>/memory-core`（可配置）。 */
export function coreRoot(config = {}) {
  const configured = config.coreDir
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHome(configured))
  return join(resolveDshHome(config.dshHome), CORE_DIR_NAME)
}

/** 稳定 12-hex 项目键（与 memory-evolve 的 projectHash 逐字节一致）。 */
export function projectHash(cwd) {
  return sha1hex(cwd, 12)
}

/**
 * 短项目标签：取路径末段；末段过短或纯数字时取末两段
 * （`/data/260805/1` → `260805/1`）。与 memory-evolve 的 projectLabel 一致。
 */
export function projectLabel(cwd) {
  if (!cwd) return undefined
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  const base = parts[parts.length - 1]
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base
  }
  return base
}

/** 执行本地 git 命令；失败返回 undefined（毫秒级，绝不联网）。 */
function runGit(args, cwd) {
  try {
    const result = spawnSync('git', args, {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return undefined
    const out = String(result.stdout ?? '').trim()
    return out === '' ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * 归一化远端 URL → 跨协议身份键 `host[:port]/path`。
 * 去协议、去凭证、去 `.git`、去尾斜杠、host 小写、默认端口省略；
 * https 与 ssh 形态收敛到同一键（双设备 clone 方式不同也能认亲）。
 * 不可共享形态（file://、盘符、Unix 绝对路径）返回 undefined。
 */
export function normalizeRemoteUrl(url) {
  if (typeof url !== 'string') return undefined
  const trimmed = url.trim()
  if (trimmed === '') return undefined

  // SCP 式 SSH：git@github.com:user/repo.git（冒号前不是 Windows 盘符）
  const isScpLike = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    && !/^[a-zA-Z]:[\\/]/.test(trimmed)
    && /^[^@\s]+@[^:/\s]+:/.test(trimmed)
  if (isScpLike) {
    const host = trimmed.slice(trimmed.indexOf('@') + 1, trimmed.indexOf(':'))
    const path = trimmed.slice(trimmed.indexOf(':') + 1)
    return normalizeUrlCore(`ssh://${host}/${path}`)
  }

  if (/^file:\/\//.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return undefined
  return normalizeUrlCore(trimmed)
}

function normalizeUrlCore(input) {
  let parsed
  try {
    parsed = new URL(input)
  } catch {
    return undefined
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined
  if (!parsed.hostname) return undefined
  let path = parsed.pathname.replace(/\/+$/, '')
  if (path === '') return undefined
  path = path.replace(/\.git$/, '')
  if (path === '') return undefined
  const defaultPort = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git:': '9418' }[parsed.protocol]
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : ''
  return `${parsed.hostname.toLowerCase()}${port}${path}`
}

/** 主仓库 remote（origin 优先，其次第一个 remote）。 */
export function resolveMainRemote(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null
  const names = runGit(['remote'], cwd)?.split('\n').map((s) => s.trim()).filter(Boolean) ?? []
  const order = names.includes('origin') ? ['origin', ...names.filter((n) => n !== 'origin')] : names
  for (const name of order) {
    const url = runGit(['remote', 'get-url', name], cwd) ?? runGit(['config', '--get', `remote.${name}.url`], cwd)
    if (url) return { name, url, root: runGit(['rev-parse', '--show-toplevel'], cwd) ?? null }
  }
  return null
}

/**
 * 解析一个工作目录的项目身份。
 * @returns {{id: string, kind: 'remote'|'fallback', identityKey: string|null, displayName: string, remoteUrl: string|null}}
 */
export function resolveProjectId(cwd) {
  const remote = resolveMainRemote(cwd)
  const key = remote ? normalizeRemoteUrl(remote.url) : undefined
  if (key) {
    return {
      id: sha1hex(key, 12),
      kind: 'remote',
      identityKey: key,
      displayName: remote.root ? (projectLabel(remote.root) ?? key) : key,
      remoteUrl: remote.url,
    }
  }
  return {
    id: projectHash(cwd),
    kind: 'fallback',
    identityKey: null,
    displayName: projectLabel(cwd) ?? String(cwd ?? ''),
    remoteUrl: null,
  }
}

/**
 * 定位某个 cwd 在记忆根目录下的项目目录。
 *
 * 解析顺序（对实际磁盘状态友好，不迷信算出来的 id）：
 *   1. `projects/<resolveProjectId(cwd).id>` 已存在 → 直接用；
 *   2. 根目录下只有一个项目目录 → 用它（唯一项目场景的务实回退，可关）；
 *   3. 否则给出新目录路径（写入时创建）。
 *
 * @returns {{dir: string, id: string, kind: string, displayName: string, existed: boolean, viaFallback: boolean}}
 */
export function resolveProjectDir(memoryDir, cwd, opts = {}) {
  const allowSingle = opts.allowSingleProjectFallback !== false
  const identity = resolveProjectId(cwd)
  const projectsDir = join(memoryDir, 'projects')
  const primary = join(projectsDir, identity.id)
  if (existsSync(primary)) {
    return { dir: primary, id: identity.id, kind: identity.kind, displayName: identity.displayName, existed: true, viaFallback: false }
  }
  if (allowSingle) {
    const siblings = listProjectDirs(projectsDir)
    if (siblings.length === 1) {
      return { dir: siblings[0].dir, id: siblings[0].id, kind: 'single', displayName: identity.displayName, existed: true, viaFallback: true }
    }
  }
  return { dir: primary, id: identity.id, kind: identity.kind, displayName: identity.displayName, existed: false, viaFallback: false }
}

/** 列出 `projects/` 下的项目目录（确定性排序）。 */
export function listProjectDirs(projectsDir) {
  if (!existsSync(projectsDir)) return []
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({ id: e.name, dir: join(projectsDir, e.name) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}