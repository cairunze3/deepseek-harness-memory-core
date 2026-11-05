/**
 * scripts/archive-contract.mjs — 跨插件「归档格式」契约探针。
 *
 * 证明的不是"文件写出来了"，而是**对方能读**：
 *   ① 用本插件的 appendEntry 往 `MEMORY-archive.md` 追加两条；
 *   ② 直接 import dsh-memory-evolve 的真 `lib/store.js`，用它的
 *      `ArchiveStore.entriesOf('memory')` 读回来 —— 必须是 **2 条**而不是 1 条。
 *
 * 为什么这条要单独验：对方的 `parseEntries` 只认 `\n§\n`。若归档按"时间戳行"
 * 追加，它的记忆 Tab 归档页会把两条并成一条，点「移回主记忆」时整块搬回主轨。
 * 单元测试只能证明"我写的文件里有 §"，只有把对方的代码跑起来才能证明"它看得懂"。
 *
 * 用法：node scripts/archive-contract.mjs [dsh-memory-evolve 包目录]
 * 找不到那个包时如实 SKIP（exit 0）——环境差异不该让验证脚本变红。
 */

import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendEntry, readChunks } from '../lib/memfile.js'
import { classifyFile } from '../lib/scanner.js'

const pkgDir = process.argv[2] ?? process.env.MEMORY_EVOLVE_DIR ?? discover()

function discover() {
  const base = join(process.env.APPDATA ?? '', 'VanWork', 'accounts')
  if (base === '' || !existsSync(base)) return null
  for (const account of safeReaddir(base)) {
    const candidate = join(base, account, 'dsh-home', 'profiles', 'web', 'node_modules', 'dsh-memory-evolve')
    if (existsSync(join(candidate, 'lib', 'store.js'))) return candidate
  }
  return null
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

if (!pkgDir) {
  console.log('SKIP：没找到 dsh-memory-evolve（传参或设 MEMORY_EVOLVE_DIR 可指定）。')
  process.exit(0)
}

const storeUrl = pathToFileURL(join(pkgDir, 'lib', 'store.js')).href
const { ArchiveStore } = await import(storeUrl)

const root = mkdtempSync(join(tmpdir(), 'memcore-archive-contract-'))
const file = join(root, 'MEMORY-archive.md')

try {
  appendEntry(file, '[2026-01-01 10:00] 第一条被归档的旧结论：检索走纯关键词。', {})
  appendEntry(file, '[2026-01-02 10:00] 第二条被归档的旧结论：索引是派生物。', {})

  const mine = readChunks(file)
  const theirs = new ArchiveStore(root).entriesOf('memory')
  const track = classifyFile('MEMORY-archive.md').track

  console.log(`记忆根：${root}`)
  console.log(`本插件读回：${mine.chunks.length} 条（形态 ${mine.mode}）`)
  console.log(`memory-evolve 读回：${theirs.length} 条`)
  console.log(`扫描判定：track=${track}（必须是 archive，否则会被当成普通记忆重新注入）`)

  const ok = theirs.length === 2 && mine.chunks.length === 2 && track === 'archive'
  console.log(ok
    ? '✅ 契约成立：对方能逐条读到本插件写入的归档，且归档轨不会被重新注入'
    : '❌ 契约破裂：对方读到的条数与写入不符，或归档轨判定错误')
  process.exitCode = ok ? 0 : 1
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
}