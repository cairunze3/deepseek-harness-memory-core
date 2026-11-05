/**
 * scripts/verify-slots.mjs — 重启后的一条命令验收（只读，不写任何记忆或槽位）。
 *
 * 覆盖三件事：
 *   ① 新代码有没有加载（v0.3.2 的模块能否 import、默认值是否符合预期）；
 *   ② 分槽有没有真的生效（槽位文件、统计行位置、两次渲染的前缀稳定性）；
 *   ③ 原有判定有没有被改坏（注入预算、条目数、页脚结构）。
 *
 * 用法（PowerShell）：
 *   $node = "$env:LOCALAPPDATA\Programs\VanWork\resources\runtime\node.exe"
 *   & $node scripts/verify-slots.mjs
 *   # 或显式指定：& $node scripts/verify-slots.mjs --dsh-home "<dsh home>"
 *
 * 判定口径（与 tests/slots.test.js 一致）：
 *   - 槽位文件 `<coreDir>/index-slots.json` 存在且键数 > 0；
 *   - 统计行（`条目 N · 本次注入 M`）出现在**条目区之后**（页脚区）；
 *   - 用同一批条目 + 文件里的槽位连渲两次，**逐字节一致**；
 *   - 模拟"新增一条"后，**旧条目的行逐字节不变**（这才是缓存的收益）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '../lib/runtime.js'
import { renderIndexSnapshot } from '../lib/inject.js'
import { stablePrefix } from '../lib/slots.js'
import { resolveDshHome } from '../lib/paths.js'

const check = []
const add = (title, ok, detail = '') => {
  check.push({ title, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${title}${detail ? ` — ${detail}` : ''}`)
}

const argv = process.argv.slice(2)
const dshHomeArg = (() => {
  const at = argv.indexOf('--dsh-home')
  return at >= 0 ? argv[at + 1] : null
})()
const dshHome = resolveDshHome(dshHomeArg, process.env)

/**
 * 从真实 profile 里读本插件的 config（否则验的是"默认值"，不是"你实际在跑的配置"）。
 * 只要四个键：indexTopN / indexMaxChars / injectExclude / exclusiveWritePath。
 */
function readProfileConfig(home) {
  const file = join(home, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(file)) return { file, values: {}, exists: false }
  const text = readFileSync(file, 'utf8')
  const pick = (key) => {
    const match = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm').exec(text)
    return match ? match[1].trim() : null
  }
  const values = {}
  const topN = pick('indexTopN')
  if (topN && Number.isFinite(Number(topN))) values.indexTopN = Number(topN)
  const maxChars = pick('indexMaxChars')
  if (maxChars && Number.isFinite(Number(maxChars))) values.indexMaxChars = Number(maxChars)
  const exclude = pick('injectExclude')
  if (exclude) values.injectExclude = exclude.replace(/[[\]']/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  if (pick('exclusiveWritePath') === 'true') values.exclusiveWritePath = true
  return { file, values, exists: true }
}

const profile = readProfileConfig(dshHome)
const config = { dshHome, ...profile.values }
if (dshHomeArg) config.coreDir = join(dshHomeArg, 'memory-core')

const rt = createRuntime({
  config,
  logger: { info() {}, warn() {} },
})

const coreDir = rt.coreDir
const memoryDir = rt.memoryDir
console.log(`记忆根：${memoryDir}`)
console.log(`派生物：${coreDir}`)
console.log(`插件版本：${readVersion()}`)
if (profile.exists) {
  const shown = Object.entries(profile.values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' · ')
  console.log(`profile 配置：${shown === '' ? '（未写本插件的 config）' : shown}`)
} else {
  console.log(`profile 配置：未找到 ${profile.file}（按默认值验收）`)
}
console.log('')

// ── ① 代码是否是新版 ──────────────────────────────────────────────────────────
add('新代码已加载（slots 模块可 import）', typeof stablePrefix === 'function')
add('分槽默认开启（indexStableSlots）', rt.config.indexStableSlots !== false, `indexStableSlots=${rt.config.indexStableSlots}`)
add('重排周期可读（indexResortEveryHours）', typeof rt.config.indexResortEveryHours === 'number', `${rt.config.indexResortEveryHours} 小时`)
add('可疑标记功能在位（参数存在）', 'suspectEnabled' in rt.config, `suspectEnabled=${rt.config.suspectEnabled}`)

// ── ② 分槽是否生效 ────────────────────────────────────────────────────────────
const slotsFile = join(coreDir, 'index-slots.json')
const hasSlotsFile = existsSync(slotsFile)
add('槽位文件已生成（<coreDir>/index-slots.json）', hasSlotsFile, hasSlotsFile ? slotsFile : '还没有：说明重启后尚未渲染过一次注入（开个新会话即可）')

let persisted = []
if (hasSlotsFile) {
  try {
    const parsed = JSON.parse(readFileSync(slotsFile, 'utf8'))
    persisted = Array.isArray(parsed?.slots) ? parsed.slots : []
    const ageMin = parsed?.updatedAt ? Math.round((Date.now() - parsed.updatedAt) / 60_000) : null
    add('槽位数量合理（> 0 且 ≤ indexTopN）', persisted.length > 0 && persisted.length <= (rt.config.indexTopN ?? 40), `${persisted.length} 个槽 · 更新于 ${ageMin === null ? '未知' : `${ageMin} 分钟前`}`)
  } catch (error) {
    add('槽位文件可解析', false, error instanceof Error ? error.message : String(error))
  }
}

const snap = rt.getSnapshot({ cwd: process.cwd(), force: true })
if (snap.entries.length === 0) {
  console.log('\n（记忆里还没有条目，跳过渲染相关检查）')
} else {
  const render = (entries, previousSlots) => renderIndexSnapshot({
    entries,
    stats: snap.stats,
    config: rt.config,
    now: Date.now(),
    projectId: snap.projectId,
    projectLabel: snap.projectLabel,
    session: { id: 'verify-slots', turnsSinceWrite: 0 },
    // 与真实渲染路径（lib/index.js#renderSnapshotFor）一致：把整合提示也带上。
    // 不带的话页脚预留偏小，测出的"注入字符数"会比真机乐观（实测差 ~500 字符）。
    extras: { consolidationHint: rt.consolidationHint() },
    previousSlots,
  })

  const first = render(snap.entries, persisted.length > 0 ? persisted : null)
  const again = render(snap.entries, first.slots)

  add('同一批条目连渲两次逐字节一致', first.text === again.text, `${first.lines} 行 / ${first.chars} 字符`)
  const prefix = stablePrefix({ previous: first.text, next: again.text })
  add('稳定前缀 100%（相同输入）', prefix.startsWith === prefix.previousLines, `${prefix.startsWith}/${prefix.previousLines} 行`)

  // 统计行必须落在条目区之后（页脚）
  const lines = first.text.split('\n')
  const statAt = lines.findIndex((line) => line.startsWith('条目 '))
  const firstEntryAt = lines.findIndex((line) => line.startsWith('- ['))
  add('统计行在条目区之后（不再每轮改前缀）', statAt > firstEntryAt, `第 ${statAt + 1} 行（共 ${lines.length} 行，条目从第 ${firstEntryAt + 1} 行开始）`)

  // 注入预算与条目数
  add('注入未超预算', !first.overflow, `注入 ${first.included} 条 · ${first.chars}/${rt.config.indexMaxChars} 字符 · 未选中 ${first.omitted}`)
  console.log('   ℹ️ 本脚本按"本轮没有写入提醒"渲染；真机在你连续多轮没写记忆时会多一行提醒，')
  console.log('      预算随之少一行——那时真机可能比这里少注入 1 条，属正常，不是失效。')

  // 模拟"新增一条"：旧条目的行必须逐字节不变
  const injectedLines = lines.filter((line) => line.startsWith('- ['))
  const newcomer = {
    ...snap.entries[0],
    entryId: 'verify-slots-newcomer',
    ordinal: 999,
    rel: 'VERIFY.md',
    path: join(memoryDir, 'VERIFY.md'),
    body: '验收用：这是一条模拟新增的条目，用来确认旧条目位置不动。',
    summary: '验收用：模拟新增条目',
    chars: 30,
    bytes: 90,
    mtime: Date.now() + 1000,
    contentHash: 'verify-newcomer',
    suspect: null,
    supersededBy: null,
  }
  const afterAppend = render([...snap.entries, newcomer], first.slots)
  const afterLines = new Set(afterAppend.text.split('\n'))
  const keptIntact = injectedLines.filter((line) => afterLines.has(line)).length
  add('新增一条后，旧条目的行逐字节不变', keptIntact === injectedLines.length, `${keptIntact}/${injectedLines.length} 行保留`)

  // 顺序不是"按日期"排序的证据：槽位顺序与文件顺序不同也算正常，这里只报形态
  console.log('')
  console.log(`ℹ️ 注入行示例（前 2 行，用来肉眼确认顺序不是按日期排的）：`)
  for (const line of injectedLines.slice(0, 2)) console.log(`   ${line.slice(0, 110)}`)
}

console.log('')
const failed = check.filter((item) => !item.ok)
if (failed.length === 0) {
  console.log(`结果：全部通过（${check.length} 项）`)
  process.exit(0)
}
console.log(`结果：${failed.length} 项待确认`)
for (const item of failed) console.log(`  - ${item.title}${item.detail ? `（${item.detail}）` : ''}`)
process.exit(1)

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.version
  } catch {
    return '未知'
  }
}