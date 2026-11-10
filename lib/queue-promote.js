/**
 * lib/queue-promote.js — 「命中即确认」：被检索召回过的队列候选自动转正。
 *
 * ## 为什么要有这个模块
 *
 * 待巩固队列 QUEUE.md 的原设计是：**候选不进常驻索引，晋升必须经用户确认**
 * （走 `mem_consolidate` 的 plan → 人确认 → apply）。这条闸门在纸面上很稳，
 * 真机一跑就露馅了：候选被 `mem_search` 召回、模型拿它回答了用户的问题，
 * 但因为它还在队列里，模型转头对说用户——
 *
 *   > "这条目前还躺在待巩固队列里……要不要我把这条从队列晋升为正式记忆？"
 *
 * 这就是把内部实现细节甩给了用户：用户明明**已经用过**这条记忆了（它正是
 * 靠这条记忆答出来的），却还要被问一句"要不要确认"。确认这件事事实上已经
 * 发生了——**召回并使用，就是确认**。
 *
 * 所以 0.5.4 把判据改成显式的：**候选被检索命中过（access ≥ 1）即视为确认**，
 * 当轮就把它从 QUEUE.md 移进目标轨，不需要用户点任何东西，也不打扰用户。
 *
 * ## 与 mem_consolidate 的分工
 *
 * - 这里只做**单条、证据明确**的转正（被命中过）。零交互、当轮生效。
 * - `mem_consolidate` 仍然处理需要人判断的批量动作（合并/归档/蒸馏/取代/
 *   槽位更新），那条链路照旧要 confirm——它动的是记忆正本的大结构。
 *
 * 两者共用同一把锁（`consolidate.lock`），不会并发写同一批文件。
 *
 * @module vanwork-memory-core/lib/queue-promote
 */

import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { withLock } from './lock.js'
import { appendEntry, removeEntries, stamped, targetRelFor } from './memfile.js'
import { parseQueueBody, LOCK_FILE } from './consolidate.js'
import { dateStamp, ensureDir, writeFileAtomic } from './fsutil.js'

/** 自动转正的状态文件（记"是否已做过历史回溯"，只做一次）。 */
export const PROMOTE_STATE_FILE = 'queue-promote.json'

/**
 * 把「被检索命中过」的队列候选移进目标轨。
 *
 * 是**移动**不是复制：目标轨追加成功后，原文从 QUEUE.md 移除，避免同一事实
 * 在队列和正轨各留一份（那样下次检索会命中两次，且队列永远清不空）。
 *
 * @param {object} p
 * @param {Array} p.entries - 候选条目（{ entryId, rel, track, body }）。
 * @param {Map} p.accessCounts - entryId → { count }，来自索引后端的召回计数。
 * @param {string} p.coreDir - 记忆核心目录（锁与状态文件放这里）。
 * @param {string} p.memoryDir - 记忆正本根目录（`entry.rel` 相对它）。
 * @param {number} [p.minHits=1] - 命中几次算确认（1 = 召回一次即转正）。
 * @param {Set|null} [p.onlyEntryIds=null] - 只处理这些条目（null = 全部够格的）。
 * @param {object|null} [p.ledger=null] - 账本，留痕用（不打扰用户，但可审计）。
 * @returns {{ promoted: Array, errors: Array }}
 */
export function promoteQueueHits({
  entries = [], accessCounts = new Map(), coreDir, memoryDir,
  now = Date.now(), backupDir = null, minHits = 1, onlyEntryIds = null,
  ledger = null,
} = {}) {
  const root = resolve(memoryDir)
  const guardPath = (rel) => {
    const full = resolve(root, rel)
    if (full !== root && !full.startsWith(root)) return null
    return full
  }

  const todo = []
  for (const entry of entries) {
    if (entry.track !== 'queue') continue
    if (onlyEntryIds !== null && !onlyEntryIds.has(entry.entryId)) continue
    if ((accessCounts.get(entry.entryId)?.count ?? 0) < minHits) continue
    const meta = parseQueueBody(entry.body)
    if (meta === null) continue
    // 与整合一致：`key` 轨必须能路由到项目目录，缺 projectId 的候选无法安全晋升。
    if (meta.track === 'key' && !meta.projectId) continue
    todo.push({ entry, meta })
  }
  if (todo.length === 0) return { promoted: [], errors: [], skipped: [] }

  const stamp = dateStamp(new Date(now))
  const time = new Date(now).toTimeString().slice(0, 5)
  const errors = []
  const skipped = []
  const locked = withLock(join(coreDir, LOCK_FILE), () => {
    const promoted = []
    for (const { entry, meta } of todo) {
      try {
        const source = guardPath(entry.rel)
        const targetRel = targetRelFor(
          { scope: meta.scope, track: meta.track, projectId: meta.projectId ?? null },
          { today: stamp },
        )
        const target = guardPath(targetRel)
        if (source === null || target === null) {
          errors.push({ entryId: entry.entryId, error: '路径越界' })
          continue
        }
        ensureDir(dirname(target))
        // 幂等闸门：**先确认候选还在 QUEUE.md 里，再追加到正轨**。
        // 快照可能比磁盘旧（当轮刚转过正、还没重扫），此时同一条会第二次进这里；
        // 少了这道检查就会往正轨里追加重复的同一句话——而队列里早已没有它可移除，
        // 于是"移动"退化成"复制"。宁可跳过（下次快照刷新后自然一致），不可重复写。
        const sourceText = existsSync(source) ? readFileSync(source, 'utf8') : ''
        if (!sourceText.includes(String(entry.body).trim())) {
          skipped.push({ entryId: entry.entryId, reason: '已不在队列中（可能刚转正）' })
          continue
        }
        const appended = appendEntry(target, stamped(meta.content, `${stamp} ${time}`), { backupDir, stamp })
        const removed = removeEntries(source, [entry.body], { backupDir, stamp })
        promoted.push({
          entryId: entry.entryId,
          from: entry.rel,
          to: targetRel,
          track: meta.track,
          scope: meta.scope,
          appended: appended.ok === true,
          removed: removed.removed ?? 0,
        })
      } catch (error) {
        errors.push({
          entryId: entry.entryId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return promoted
  }, { label: 'memory-core queue-promote', timeoutMs: 8_000, staleMs: 60_000 })

  if (!locked.ok) {
    // 拿不到锁就不写：宁可下次再转，也不要和整合抢同一批文件。
    return { promoted: [], errors: [{ error: locked.reason ?? '锁等待超时' }], locked: true }
  }

  const promoted = locked.value
  if (promoted.length > 0 && ledger) {
    ledger.append('queue-promote', {
      at: now,
      count: promoted.length,
      items: promoted.map((item) => ({ from: item.from, to: item.to, track: item.track })),
    })
  }
  return { promoted, errors, skipped }
}

/** 读自动转正的状态（不存在或损坏都当作空状态）。 */
export function readPromoteState(coreDir) {
  const file = join(coreDir, PROMOTE_STATE_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写自动转正的状态。 */
export function writePromoteState(coreDir, state) {
  writeFileAtomic(join(coreDir, PROMOTE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

/**
 * `mem_search` 命中之后的收尾：把够格的候选转正。
 *
 * 两路都走同一个规则：
 *  ① 本次命中的 queue 条目——当轮立刻转正；
 *  ② 升级后**首次**检索，顺手把历史上已被命中过的候选一并回溯转正
 *     （用户拍板：老队列不清空就永远堆着）。回溯只做一次，状态文件记账。
 *
 * @param {object} rt - 运行时。
 * @param {string[]} hitEntryIds - 本次命中的条目 id。
 * @returns {{ promoted: Array, errors: Array }}
 */
export function autoPromoteAfterSearch(rt, hitEntryIds = [], { cwd = null } = {}) {
  if (rt?.config?.queuePromoteOnRecall === false) return { promoted: [], errors: [], reason: 'disabled' }
  try {
    const snapshot = rt.getSnapshot({ cwd: cwd ?? null, force: false })
    const entries = snapshot?.entries ?? []
    const queueEntries = entries.filter((entry) => entry.track === 'queue')
    if (queueEntries.length === 0) return { promoted: [], errors: [] }

    const index = rt.ensureIndex()
    if (!index) return { promoted: [], errors: [] }
    const accessCounts = index.accessCounts(queueEntries.map((entry) => entry.entryId))

    const hitSet = new Set(hitEntryIds)
    const state = readPromoteState(rt.coreDir)
    const backfill = state.backfilledAt == null

    const targets = queueEntries.filter((entry) => (
      hitSet.has(entry.entryId)
      || (backfill && (accessCounts.get(entry.entryId)?.count ?? 0) > 0)
    ))

    const now = Date.now()
    let result = { promoted: [], errors: [] }
    if (targets.length > 0) {
      result = promoteQueueHits({
        entries: targets,
        accessCounts,
        coreDir: rt.coreDir,
        memoryDir: rt.memoryDir,
        now,
        backupDir: rt.config.backupBeforeWrite !== false ? join(rt.coreDir, 'backups') : null,
        minHits: rt.config.queuePromoteMinHits ?? 2,
        ledger: rt.ledger ?? null,
      })
      // 队列与正轨都变了：让下一次取快照重扫，别让模型读到刚被移走的条目。
      rt.invalidate?.()
    }
    // 回溯标记无论有没有转成都写：否则每条旧候选都会反复进 targets。
    if (backfill) {
      writePromoteState(rt.coreDir, {
        ...state,
        backfilledAt: now,
        backfillScanned: queueEntries.length,
        promotedTotal: (state.promotedTotal ?? 0) + (result.promoted?.length ?? 0),
      })
    }
    return result
  } catch (error) {
    return {
      promoted: [],
      errors: [{ error: error instanceof Error ? error.message : String(error) }],
    }
  }
}
