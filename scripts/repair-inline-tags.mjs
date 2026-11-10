/**
 * scripts/repair-inline-tags.mjs — 清理"行内标签 / 重复摘要行"这类结构损坏。
 *
 * 背景（2026-11-02 记忆插件 A/B 测试实测）：stamp 模式文件里，条目正文与下一条目的
 * `[summary:…]` 会被粘成一行（`…信息）[summary:X]`），并在条目开头堆出多条重复的
 * 摘要行。切块缺陷已在 `lib/scanner.js` / `lib/memfile.js` 修掉（不会再产生新的），
 * 但**已经写坏的文件不会自己恢复**——这个脚本就是那次清理。
 *
 * 两步，都是"可证明安全"的局部操作：
 *   1. **拆行**：把行内出现的 `[summary:` / `[id:` / `[superseded-by:` 前面补一个换行，
 *      让标签回到行首（正常写法本来就在行首，所以这一步不生产任何新语义）；
 *   2. **去重**：相邻且内容完全相同的纯标签行只保留一条（重复摘要是同一事实被反复
 *      追加的产物，删掉多余的不丢信息）。
 *
 * 安全约束：
 *  - 默认 **dry-run**，只打印将要做的改动，必须显式 `--apply` 才落盘；
 *  - 改前先跑 `validateMemoryText`，改完再跑一次；只要**没有变好**就放弃写这份文件；
 *  - 落盘走 `writeFileAtomic`（临时文件 → rename），并在 `<coreDir>/backups/` 留一份原文件；
 *  - 只碰 `memories/` 下的 `.md`，不碰索引库、不碰 `memory-core/`。
 *
 * 用法：
 *   node scripts/repair-inline-tags.mjs --memories <记忆根> --core <memory-core 目录>            # 预演
 *   node scripts/repair-inline-tags.mjs --memories <记忆根> --core <memory-core 目录> --apply    # 落盘
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { backupFile, readChunks } from '../lib/memfile.js'
import { isTagOnlyLine, splitIntoEntries } from '../lib/scanner.js'
import { validateMemoryText } from '../lib/validate.js'
import { dateStamp, writeFileAtomic } from '../lib/fsutil.js'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const memoriesDir = arg('memories')
const coreDir = arg('core')
const apply = has('apply')

if (!memoriesDir || !coreDir) {
  console.error('用法: node scripts/repair-inline-tags.mjs --memories <记忆根> --core <memory-core> [--apply]')
  process.exit(2)
}
if (!existsSync(memoriesDir)) {
  console.error(`记忆根不存在：${memoriesDir}`)
  process.exit(2)
}

/**
 * 行内标签：标签不在行首（`…）[summary:X]`）。与 lib/tools.js 的护栏同一口径。
 *
 * 关键细节：看**前一个非空白字符**，它不能是 `]`。`[2026-11-02 14:48] [summary:…]` 是合法
 * 写法（时间戳与标签同行），把它也拆开是纯破坏——第一版脚本就是这么错的，实测把
 * MEMORY.md 多拆出一行。真正的粘连特征是"标签前面是**正文**"，如 `…信息）[summary:X]`。
 * （用 `[^\]\s]` 而非 `[^\]\n\r]`：后者会让空格自身被当成前一个字符，同行标签依然被拆。）
 */
const INLINE_TAG = /([^\]\s])[ \t]*(\[(?:summary|superseded-by|id):[^\]\n]*\])/g

/** 收集记忆根下的 Markdown 文件（跳过 index/backup 之类的非正本目录）。 */
function collectMarkdown(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'backups' || name === 'node_modules') continue
      collectMarkdown(full, acc)
    } else if (name.toLowerCase().endsWith('.md') && st.size <= 2_000_000) {
      acc.push(full)
    }
  }
  return acc
}

/** 第一步：把行内标签拆到行首。 */
function splitInlineTags(raw) {
  let changed = 0
  const out = raw.replace(INLINE_TAG, (_m, before, tag) => {
    changed += 1
    return `${before}\n${tag}`
  })
  return { text: out, changed }
}

/** 第二步：相邻且内容完全相同的纯标签行去重（保留第一条）。 */
function dedupeTagLines(raw) {
  const lines = raw.split('\n')
  const kept = []
  let removed = 0
  for (const line of lines) {
    const prev = kept[kept.length - 1]
    if (prev !== undefined && isTagOnlyLine(line) && prev.trim() === line.trim()) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

const files = collectMarkdown(memoriesDir)
console.log(`扫描 ${files.length} 个 Markdown 文件${apply ? '' : '（预演，未落盘）'}\n`)

const stamp = dateStamp()
let touched = 0
let skipped = 0

for (const full of files) {
  const rel = relative(memoriesDir, full).replace(/\\/g, '/')
  const raw = readFileSync(full, 'utf8')
  const { mode } = readChunks(full)

  // 只处理 stamp 形态：§ 形态与整文件形态没有"按行分条"的切块，不会出现这类粘连。
  if (mode !== 'stamp') { skipped += 1; continue }

  const before = validateMemoryText(raw, rel)
  const step1 = splitInlineTags(raw)
  const step2 = dedupeTagLines(step1.text)
  if (step1.changed === 0 && step2.removed === 0) { skipped += 1; continue }

  const after = validateMemoryText(step2.text, rel)
  const errsBefore = before.issues.filter((i) => i.level === 'error').length
  const errsAfter = after.issues.filter((i) => i.level === 'error').length

  // 只接受"确实变好"的结果：错误数必须下降，且不能引入新的错误类型。
  const improved = errsAfter < errsBefore
  const sameErrs = errsAfter === errsBefore

  const chunksBefore = readChunks(full).chunks.length
  // 用纯文本切分复核条目数（与索引侧同一实现），不落任何临时文件。
  const chunksAfter = splitIntoEntries(step2.text, rel).length

  console.log(`─ ${rel}`)
  console.log(`   切块形态 ${mode} · 拆行 ${step1.changed} 处 · 去重 ${step2.removed} 行`)
  console.log(`   validate: error ${errsBefore} → ${errsAfter} · 条目数 ${chunksBefore} → ${chunksAfter}`)

  if (!improved && !(sameErrs && chunksAfter !== chunksBefore && errsAfter === 0)) {
    console.log('   ⏭ 跳过：没有变好（或结果不确定），不做改动\n')
    skipped += 1
    continue
  }

  if (!apply) {
    console.log('   ✓ 可修复（加 --apply 落盘）\n')
    touched += 1
    continue
  }

  const backup = backupFile(full, join(coreDir, 'backups'), stamp)
  writeFileAtomic(full, step2.text, { mode: 0o600 })
  console.log(`   ✓ 已修复（备份：${backup ?? '未创建'}）\n`)
  touched += 1
}

console.log(`完成：${touched} 个文件${apply ? '已修复' : '可修复'}，${skipped} 个跳过。`)
if (!apply && touched > 0) console.log('确认无误后加 --apply 落盘。')
