/**
 * scripts/eval-memory.mjs — 记忆质量冒烟评测（0.8.1）。
 *
 * 这不是 LongMemEval / LoCoMo 那种大基准，而是一条**可复现的本地冒烟线**：
 * 造一小份真实形态的记忆（MEMORY/USER/KEY），用固定查询集量三件事：
 *   1. 检索 recall@1 / recall@3；
 *   2. pointer 模式的核心预取是否把 USER / 当前项目 KEY 带上；
 *   3. 队列转正的证据门槛（1 次命中不转、2 次才转）。
 *
 * 目的不是给插件打分，而是让“这篇改动有没有把召回弄坏”有一个退出码。
 * 样本很小，结果只用于回归，不用于对外宣称质量。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveConfig } from '../lib/config.js'
import { scanRoot } from '../lib/scanner.js'
import { openIndex } from '../lib/indexdb.js'
import { hybridSearch } from '../lib/retrieve.js'
import { renderPointerBlock } from '../lib/inject.js'
import { promoteQueueHits } from '../lib/queue-promote.js'

const CASES = [
  { query: 'Aster 项目编号', expect: 'AST-7742', label: '项目编号' },
  { query: '盐田港 发货', expect: '盐田港', label: '港口' },
  { query: '客户 回访', expect: '客户回访', label: '客户' },
  { query: 'API 约定', expect: 'API 约定', label: '项目约定' },
]

function seed(root) {
  mkdirSync(join(root, 'projects', 'abc'), { recursive: true })
  writeFileSync(join(root, 'USER.md'), [
    '[2026-11-01 09:00] [summary:输出偏好] 用户偏好结论先行 + 表格。',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'MEMORY.md'), [
    '[2026-11-02 10:00] [summary:Aster 项目编号] Aster 项目编号是 AST-7742，报价单必须带这个编号。',
    '[2026-11-03 10:00] [summary:港口] 货物从盐田港发出，船期每周三。',
    '[2026-11-04 10:00] [summary:客户回访] 客户回访安排在十一月第二周。',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'projects', 'abc', 'KEY.md'), [
    '[2026-11-05 10:00] [summary:API 约定] API 约定：所有写接口必须带 base 做乐观并发。',
  ].join('\n'), 'utf8')
}

/**
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, recallAt1:number, recallAt3:number, pointerCore:boolean, queueGate:boolean, cases:object[], notes:string[]}>}
 */
export async function runEvaluation({ keep = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memcore-eval-'))
  const indexDir = mkdtempSync(join(tmpdir(), 'memcore-eval-index-'))
  const notes = []
  try {
    seed(root)
    const scanned = scanRoot(root, { now: Date.now() })
    const config = resolveConfig({ memoryDir: root, coreDir: indexDir, searchMode: 'bm25' })
    const index = openIndex({ dir: indexDir, backend: 'json' })
    index.sync(scanned.entries, scanned.files)

    const results = []
    let hit1 = 0
    let hit3 = 0
    for (const item of CASES) {
      const result = await hybridSearch({
        index, query: item.query, config, logger: console,
        opts: { limit: 5 },
      })
      const rank = result.hits.findIndex((hit) => String(hit.entry.body).includes(item.expect))
      const at1 = rank === 0
      const at3 = rank >= 0 && rank < 3
      if (at1) hit1 += 1
      if (at3) hit3 += 1
      results.push({ ...item, rank: rank >= 0 ? rank + 1 : null, at1, at3, candidates: result.candidates, mode: result.mode })
    }

    const pointerText = renderPointerBlock({
      entries: scanned.entries,
      config: { ...config, pointerRecallTopN: 2 },
      projectId: 'abc',
      projectLabel: 'abc',
    })
    const pointerCore = pointerText.includes('USER.md#0') && pointerText.includes('projects/abc/KEY.md#0')

    // 队列证据门槛：同一个候选 1 次命中不转，2 次才转。
    const queueBody = '[queue:track=key scope=project id=abc] 项目决定：发布前必须跑 eval-memory。'
    writeFileSync(join(root, 'QUEUE.md'), queueBody + '\n', 'utf8')
    const queueEntry = {
      entryId: 'q-eval', rel: 'QUEUE.md', track: 'queue', body: queueBody,
      summary: '发布前跑 eval-memory', scope: 'project', projectId: 'abc',
    }
    const before = promoteQueueHits({
      entries: [queueEntry], accessCounts: new Map([['q-eval', { count: 1 }]]),
      coreDir: indexDir, memoryDir: root, minHits: 2, backupDir: null,
    })
    const after = promoteQueueHits({
      entries: [queueEntry], accessCounts: new Map([['q-eval', { count: 2 }]]),
      coreDir: indexDir, memoryDir: root, minHits: 2, backupDir: null,
    })
    const queueGate = before.promoted.length === 0 && after.promoted.length === 1

    const recallAt1 = hit1 / CASES.length
    const recallAt3 = hit3 / CASES.length
    const ok = recallAt1 >= 0.5 && recallAt3 >= 0.75 && pointerCore && queueGate
    if (CASES.length < 20) notes.push('样本 4 条：只用于回归，不代表真实记忆质量')
    if (!pointerCore) notes.push('pointer 预取没有同时带上 USER 与当前项目 KEY')
    if (!queueGate) notes.push('队列证据门槛失效（1 次命中不应转正）')
    return { ok, recallAt1, recallAt3, pointerCore, queueGate, cases: results, notes }
  } finally {
    if (!keep) {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
      try { rmSync(indexDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runEvaluation()
  console.log('# 记忆质量冒烟评测（0.8.1）')
  console.log(`recall@1 ${(report.recallAt1 * 100).toFixed(0)}% · recall@3 ${(report.recallAt3 * 100).toFixed(0)}% · pointer 核心预取 ${report.pointerCore ? '✓' : '✗'} · 队列门槛 ${report.queueGate ? '✓' : '✗'}`)
  console.log('')
  for (const item of report.cases) console.log(`- [${item.at3 ? '✓' : '✗'}] ${item.label} · rank=${item.rank ?? '—'} · 「${item.query}」`)
  for (const note of report.notes) console.log(`note: ${note}`)
  process.exitCode = report.ok ? 0 : 1
}