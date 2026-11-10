/**
 * scripts/calibrate-search.mjs — 用**真实账本**给检索门槛（searchMinScore）找依据。
 *
 * ## 为什么需要它
 *
 * 百炼 SearchMemory 给 `min_score` 的默认值是 0.3、建议区间 0.5–0.7。这个数字
 * **不能照抄**：本插件的 `finalScore = rrf × (0.6 + 0.4 × importance)`，RRF 的
 * 绝对值随融合路数漂移（开向量后整体上移），换一台机器、换一个记忆集就不可比。
 *
 * 所以门槛只能从**本机自己的分布**里读出来：
 *
 * ```
 * 正确结果的最高分通常落在哪一段？  ← 门槛不能高于它（否则砍掉正确答案）
 * 空查时最高分通常落在哪一段？      ← 门槛不能低于它（否则没起到过滤作用）
 * ```
 *
 * 本脚本只读账本（append-only、不写任何东西），输出：
 *   ① 近 N 天检索概况（命中率 / 空查簇）；
 *   ② 命中组与空查组的最高分分位对照；
 *   ③ 每个候选门槛值会砍掉多少（命中率与误杀率）；
 *   ④ 一句结论 + 建议的 `searchMinScore` 写法。
 *
 * ## 用法
 *
 * ```powershell
 * node scripts/calibrate-search.mjs                     # 默认 30 天
 * node scripts/calibrate-search.mjs --days 90
 * node scripts/calibrate-search.mjs --home <dshHome>    # 显式指定记忆根
 * node scripts/calibrate-search.mjs --json              # 机器可读
 * ```
 *
 * 退出码：0 = 正常；2 = 样本不足（**这不是失败**，是"再攒几天"）。
 *
 * @module scripts/calibrate-search
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Ledger } from '../lib/ledger.js'
import { tokenize } from '../lib/scanner.js'
import { renderSummaryLines, summarizeSearchEvents } from '../lib/querylog.js'

/** 样本下限：低于它任何分位都不可信（20 次只是"能看一眼"的门槛）。 */
const MIN_SAMPLES = 20
/** 空查组下限：空查样本太少时无法给出"下限"建议。 */
const MIN_EMPTY_SAMPLES = 5

/** 解析命令行（零依赖：不引第三方位移解析器）。 */
function parseArgs(argv) {
  const out = { days: 30, home: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--days') out.days = Number(argv[i += 1])
    else if (arg === '--home') out.home = argv[i += 1]
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

/** dshHome 解析顺序与插件一致：显式参数 > $DSH_HOME > ~/.dsh。 */
function resolveHome(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME.trim()
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return join(home, '.dsh')
}

/** 升序数组的分位数（线性插值，与 retrieve.quantile 同口径）。 */
function q(sorted, p) {
  if (sorted.length === 0) return null
  const pos = Math.min(1, Math.max(0, p)) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * 从账本事件里分出"命中组""空查组"的最高分样本。
 *
 * 只认**带 top 字段**的记录：0.4.5 之前的事件没有这个字段（当时只在命中时
 * 记账，且没记分数），把它们算进来会把分布整体拉低。
 *
 * @param {object[]} events - 账本记录。
 * @param {number} sinceMs - 时间窗下界。
 * @returns {{hit: number[], miss: number[], legacy: number}}
 */
export function splitTopScores(events, sinceMs) {
  const hit = []
  const miss = []
  let legacy = 0
  for (const event of events) {
    if (event?.k !== 'search') continue
    const at = Date.parse(String(event.t ?? ''))
    if (Number.isFinite(at) && at < sinceMs) continue
    const top = Number(event.top)
    if (event.top === null || event.top === undefined || !Number.isFinite(top)) { legacy += 1; continue }
    if (Number(event.hits) > 0) hit.push(top)
    else miss.push(top)
  }
  hit.sort((a, b) => a - b)
  miss.sort((a, b) => a - b)
  return { hit, miss, legacy }
}

/**
 * 评估一个门槛值：保留多少命中、砍掉多少空查。
 *
 * @param {number[]} hit - 命中组最高分（升序）。
 * @param {number[]} miss - 空查组最高分（升序）。
 * @param {number} threshold - 门槛。
 * @returns {{threshold:number, hitKept:number, hitDropped:number, missFiltered:number, missKept:number}}
 */
export function evaluateThreshold(hit, miss, threshold) {
  const hitKept = hit.filter((v) => v + 1e-9 >= threshold).length
  const missKept = miss.filter((v) => v + 1e-9 >= threshold).length
  return {
    threshold: Number(threshold.toFixed(4)),
    hitKept,
    hitDropped: hit.length - hitKept,
    missFiltered: miss.length - missKept,
    missKept,
  }
}

/**
 * 主入口：读账本 → 出报告。
 *
 * @param {{days?: number, home?: string}} opts - 参数。
 * @param {Date} [now] - 当前时间（测试注入用）。
 * @returns {{code: number, report: object, lines: string[]}}
 */
export function calibrate(opts = {}, now = new Date()) {
  const days = Number(opts.days ?? 30)
  const home = resolveHome(opts.home)
  const coreDir = join(home, 'memory-core')
  const ledgerFile = join(coreDir, 'ledger.jsonl')
  const lines = []

  if (!existsSync(ledgerFile)) {
    lines.push(`没有找到审计账本：${ledgerFile}`)
    lines.push('（说明：这个 dshHome 下要么没装 vanwork-memory-core，要么账本被关掉了。用 --home 指定正确的记忆根。）')
    return { code: 2, report: { ledgerFile, exists: false }, lines }
  }

  const events = new Ledger(coreDir).tail({ limit: 50_000 })
  const sinceMs = now.getTime() - days * 86_400_000
  const summary = summarizeSearchEvents(events, { now: now.getTime(), windowDays: days, tokenize })
  const { hit, miss, legacy } = splitTopScores(events, sinceMs)

  lines.push('# 检索门槛标定')
  lines.push(`账本 ${ledgerFile}`)
  lines.push(...renderSummaryLines(summary, {}))
  if (legacy > 0) {
    lines.push(`（另有 ${legacy} 条 0.4.5 之前的 search 记录没有分数——它们不计入分布，但要注意：那时的账本**只记命中**，所以历史命中率偏乐观。）`)
  }

  const report = {
    ledgerFile,
    exists: true,
    days,
    searchEvents: events.filter((e) => e?.k === 'search').length,
    valid: hit.length + miss.length,
    legacy,
    hit: { n: hit.length, p25: q(hit, 0.25), p50: q(hit, 0.5), p75: q(hit, 0.75), min: hit[0] ?? null, max: hit.at(-1) ?? null },
    miss: { n: miss.length, p25: q(miss, 0.25), p50: q(miss, 0.5), p75: q(miss, 0.75), min: miss[0] ?? null, max: miss.at(-1) ?? null },
    thresholds: [],
    recommendation: null,
  }

  lines.push('')
  lines.push('## 最高分分布')
  lines.push(`命中组 n=${hit.length}${hit.length
    ? ` · 最低 ${report.hit.min.toFixed(4)} · p25 ${report.hit.p25.toFixed(4)} · p50 ${report.hit.p50.toFixed(4)} · p75 ${report.hit.p75.toFixed(4)} · 最高 ${report.hit.max.toFixed(4)}`
    : '（还没有带分数的命中记录）'}`)
  lines.push(`空查组 n=${miss.length}${miss.length
    ? ` · 最低 ${report.miss.min.toFixed(4)} · p25 ${report.miss.p25.toFixed(4)} · p50 ${report.miss.p50.toFixed(4)} · p75 ${report.miss.p75.toFixed(4)} · 最高 ${report.miss.max.toFixed(4)}`
    : '（没有带分数的空查）'}`)

  if (hit.length + miss.length < MIN_SAMPLES) {
    lines.push('')
    lines.push(`⏳ 样本 ${hit.length + miss.length} 条，不足 ${MIN_SAMPLES} 条：分位没有代表性，**先别设门槛**。`)
    lines.push(`   做法：保持 searchMinScore=0（默认），继续正常使用；攒够样本后再跑一次本脚本。`)
    return { code: 2, report, lines }
  }

  // 候选门槛：覆盖空查组与命中组的交接区间
  const candidates = new Set()
  for (const value of [...miss, ...hit]) candidates.add(value)
  candidates.add(q(hit, 0.05))
  candidates.add(q(hit, 0.25))
  candidates.add(q(miss, 0.5))
  candidates.add(q(miss, 0.75))
  const ordered = [...candidates].filter((v) => Number.isFinite(v)).sort((a, b) => a - b)

  lines.push('')
  lines.push('## 每个候选门槛会付出什么')
  lines.push('| 门槛 | 保留命中 | 误杀命中 | 砍掉空查 | 残留空查 |')
  lines.push('|---|---|---|---|---|')
  for (const threshold of ordered) {
    const row = evaluateThreshold(hit, miss, threshold)
    report.thresholds.push(row)
    lines.push(`| ${row.threshold.toFixed(4)} | ${row.hitKept}/${hit.length} | ${row.hitDropped} | ${row.missFiltered}/${miss.length} | ${row.missKept} |`)
  }

  // 推荐：误杀率为 0 的最高门槛（这是"不为过滤牺牲召回"的保守解）
  const safe = report.thresholds.filter((row) => row.hitDropped === 0 && row.missFiltered > 0)
  const best = safe.at(-1) ?? null
  lines.push('')
  lines.push('## 结论')
  if (best === null) {
    if (miss.length < MIN_EMPTY_SAMPLES) {
      lines.push(`空查样本 ${miss.length} 条（< ${MIN_EMPTY_SAMPLES}）：还看不出"弱结果"长什么样，保持 searchMinScore=0，继续攒。`)
    } else {
      lines.push('空查组的最高分**不低于**命中组的最低分：两组当前无法用分数分开。')
      lines.push('  读法：问题不在门槛，而在召回本身——空查时它总能"捞到点东西"，说明词面匹配被宽松 OR 放大了（见技术文档 §6.2）。')
      lines.push('  此时设任何门槛都会误杀正确答案：保持 searchMinScore=0。')
    }
    report.recommendation = null
  } else {
    const ratio = best.threshold / (hit.at(-1) || 1)
    lines.push(`建议门槛 **${best.threshold.toFixed(4)}**（绝对分）：命中一条不误杀，同时砍掉 ${best.missFiltered}/${miss.length} 次空查。`)
    lines.push(`建议写法（本机实测，不要复制到别的机器）：`)
    lines.push('')
    lines.push('```yaml')
    lines.push('- id: vanwork-memory-core')
    lines.push('  config:')
    lines.push(`    searchMinScore: ${best.threshold.toFixed(4)}`)
    lines.push('    searchMinScoreMode: absolute')
    lines.push('```')
    lines.push('')
    lines.push(`相对分位读法：这个门槛 ≈ 命中组最高分的 ${Math.round(ratio * 100)}%。若嫌"绝对分不可移植"，可改用`)
    lines.push(`  \`searchMinScoreMode: percentile\` + \`searchMinScore: 0.75\`（丢掉本批候选里低于 p75 的）——它自动随记忆集漂移，代价是不可跨机比较。`)
    report.recommendation = { threshold: best.threshold, mode: 'absolute', hitDropped: best.hitDropped, missFiltered: best.missFiltered }
  }
  return { code: 0, report, lines }
}

/** CLI 入口。 */
function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('用法：node scripts/calibrate-search.mjs [--days 30] [--home <dshHome>] [--json]')
    return 0
  }
  const { code, report, lines } = calibrate({ days: Number.isFinite(args.days) ? args.days : 30, home: args.home })
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return code
  }
  console.log(lines.join('\n'))
  return code
}

// 直接运行时才执行（被 import 时不跑 main、不调 process.exit——与项目里其它脚本同一纪律）
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}