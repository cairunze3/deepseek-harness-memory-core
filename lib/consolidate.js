/**
 * lib/consolidate.js — 记忆整合 / 反思 / 遗忘（dream）。
 *
 * 这是把四家做法拼成一条**低频、可确认、可回滚**流水线的地方：
 *  - Qoder：`dream` 的触发条件（最小间隔 + 最小新增量 + 节流）与"合并近重复
 *    而不是新建、相对日期转绝对日期、悬挂指针剔除"的整理契约；
 *  - WorkBuddy：**超过 30 天的每日日志按主题蒸馏进长期记忆**，然后才删原文件；
 *  - OfficeClaw：技能/记忆类改动的门槛最高（必须先确认）；
 *  - 文章 5.5：整合（把低层经历提炼成高层结论）+ 遗忘（TTL / 容量 / 重要性 /
 *    用户删除权）是两条独立链路，不能只做一条。
 *
 * **本模块最重要的设计约束：只提议，不擅自落刀。**
 * `plan` 是纯计算（零副作用）；`apply` 需要显式 confirm，且会校验 planId —
 * 计划生成之后记忆只要变过，planId 就对不上，apply 会拒绝执行。这样"看过的
 * 方案"和"执行的方案"永远是同一个。
 *
 * 整合产物**不是**新的记忆正本，而是对既有 Markdown 正本的编辑（合并/归档/
 * 追加蒸馏条目），全部经 memfile 的锁 + 备份 + 原子写。
 *
 * @module vanwork-memory-core/lib/consolidate
 */

import { existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dateStamp, ensureDir, readJson, sha1hex, writeFileAtomic } from './fsutil.js'
import { withLock } from './lock.js'
import { duplicateSimilarity, tokenSetOf } from './retrieve.js'
import { appendEntry, archiveRelFor, backupFile, removeEntries, stamped, supersededTag, targetRelFor } from './memfile.js'
import { bodyKey, isFragmentBody, isProtectedBody, markSuspect, pruneOrphans, readMarks, SUSPECT_REASON_TEXT } from './suspect.js'
import { applyPack, planPacks } from './pack.js'

/** 整合状态文件名。 */
export const STATE_FILE = 'consolidate-state.json'
/** 整合锁文件名。 */
export const LOCK_FILE = 'consolidate.lock'
/** 备份目录名。 */
export const BACKUP_DIR = 'backups'

/** 可以被自动归档的轨道（`user` 永不自动归档——它是跨项目的用户画像）。 */
const ARCHIVABLE_TRACKS = new Set(['memory', 'project', 'key'])

/** 近重复检测的单组上限（防止 O(n²) 在大记忆集上失控）。 */
const DUP_GROUP_CAP = 400
/** 蒸馏文本的单条上限。 */
const DISTILL_TEXT_CAP = 1200

/**
 * 修订标记词表：条目里出现这些词，说明它**在宣告某个变更**
 * （"改为 X"、"不再用 Y"、"Z 已废弃"）。
 *
 * 这是启发式而不是语义理解——但正因为如此它才可解释：每条取代提议都会
 * 附上命中的标记原词，人一眼能判断要不要采纳。见 §6.8 / §9.1。
 */
const REVISION_MARKERS = [
  '改为', '改成', '换成', '变更为', '变更', '不再', '已弃用', '已废弃', '废弃', '作废',
  '推翻', '已推翻', '取代', '替换为', '修正为', '更正为', '已失效', '失效', '取消', '撤销',
  '停止使用', '迁移到', '替代', '重命名为',
  'no longer', 'deprecated', 'superseded', 'replaced by', 'instead of', 'renamed to',
]

/** 可以做同主题矛盾检测的轨道（日志是编年史，不是知识库，不参与）。 */
const CONTRADICTION_TRACKS = new Set(['memory', 'user', 'key', 'project'])

/** 键值对抽取：`键: 值` / `键=值` / `键：值`（键含中英文，值不含空白与常见分隔符）。 */
const KEY_VALUE_RE = /([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z0-9_.-]{1,20})\s*[:=：]\s*([^\s，,。；;、|]{1,40})/g

/** 找出一条条目里命中的修订标记。 */
export function detectRevisionSignals(text) {
  const source = String(text ?? '').toLowerCase()
  if (source === '') return []
  return REVISION_MARKERS.filter((marker) => source.includes(marker.toLowerCase()))
}

/** 抽出一组 `键 → 值`（用于发现"同一个键被赋了不同的值"）。 */
export function valuePairs(text) {
  const pairs = new Map()
  const source = String(text ?? '')
  for (const match of source.matchAll(KEY_VALUE_RE)) {
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (value === '' || value.length > 40) continue
    if (!pairs.has(key)) pairs.set(key, new Set())
    pairs.get(key).add(value)
  }
  return pairs
}

/** 两条条目之间"同一个键、不同值"的冲突。 */
export function valueConflicts(a, b) {
  const left = valuePairs(`${a.summary ?? ''} ${a.body ?? ''}`)
  const right = valuePairs(`${b.summary ?? ''} ${b.body ?? ''}`)
  const conflicts = []
  for (const [key, leftValues] of left) {
    const rightValues = right.get(key)
    if (!rightValues) continue
    for (const lv of leftValues) {
      for (const rv of rightValues) {
        if (lv === rv) continue
        conflicts.push({ key, from: lv, to: rv })
      }
    }
  }
  return conflicts
}

/**
 * 同主题矛盾检测 → 取代（L2）提议。
 *
 * 判据 = **同主题**（相似度 ≥ `contradictionTopicThreshold`）**且至少一个信号**：
 *  - `revision-marker`：较新那条含"改为/不再/已废弃/推翻…"这类宣告；
 *  - `value-conflict`：两条给同一个键赋了不同的值（如 `端口: 8080` vs `端口: 9000`）。
 *
 * 方向固定为**较新的取代较旧的**（按条目自身时间戳，不是文件 mtime）。
 * 只提议、不落刀：结果进 `plan.contradictions`，`applyPlan` 默认不执行它们。
 *
 * @param {object[]} entries - 条目。
 * @param {object} p - { config, now }。
 * @returns {object[]} 提议数组。
 */
export function detectContradictions(entries, { config, now = Date.now() } = {}) {
  if (config?.supersedeEnabled === false) return []
  const threshold = config?.contradictionTopicThreshold ?? 0.55
  const maxProposals = config?.contradictionMaxProposals ?? 20

  const groups = new Map()
  for (const entry of entries) {
    if (!CONTRADICTION_TRACKS.has(entry.track)) continue
    if (entry.supersededBy) continue
    if (entry.dshOnly) continue
    const key = `${entry.scope}|${entry.projectId ?? '-'}`
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }

  const proposals = []
  for (const [groupKey, list] of groups) {
    const sorted = [...list].sort((a, b) => {
      const ra = a.recencyKey ?? ''
      const rb = b.recencyKey ?? ''
      if (ra !== rb) return rb.localeCompare(ra)
      return (b.mtime ?? 0) - (a.mtime ?? 0)
    })
    for (let i = 0; i < sorted.length; i += 1) {
      const newer = sorted[i]
      for (let j = i + 1; j < sorted.length; j += 1) {
        const older = sorted[j]
        const similarity = duplicateSimilarity(tokenSetOf(newer), tokenSetOf(older))
        if (similarity < threshold) continue
        const signals = []
        const markers = detectRevisionSignals(`${newer.summary ?? ''} ${newer.body ?? ''}`)
        if (markers.length > 0) signals.push(`revision-marker:${markers.slice(0, 3).join('/')}`)
        const conflicts = valueConflicts(newer, older)
        if (conflicts.length > 0) {
          signals.push(`value-conflict:${conflicts.slice(0, 2).map((c) => `${c.key} ${c.from}→${c.to}`).join(' / ')}`)
        }
        if (signals.length === 0) continue
        proposals.push({
          type: 'supersede',
          group: groupKey,
          scope: newer.scope,
          projectId: newer.projectId,
          track: newer.track,
          similarity: Number(similarity.toFixed(3)),
          signals,
          keep: { entryId: newer.entryId, rel: newer.rel, summary: newer.summary, date: newer.date, body: newer.body },
          supersede: {
            entryId: older.entryId, rel: older.rel, path: older.path, body: older.body,
            summary: older.summary, date: older.date, chars: older.chars,
            scope: older.scope, projectId: older.projectId, track: older.track,
          },
        })
        if (proposals.length >= maxProposals) return proposals
      }
    }
  }
  return proposals
}

/** 读取整合状态（缺失/损坏 → 全新状态）。 */
export function readState(coreDir) {
  const file = join(coreDir, STATE_FILE)
  const parsed = readJson(file, null)
  return {
    lastConsolidatedAt: Number(parsed?.lastConsolidatedAt ?? 0) || 0,
    lastPlanId: typeof parsed?.lastPlanId === 'string' ? parsed.lastPlanId : null,
    lastEntryCount: Number(parsed?.lastEntryCount ?? 0) || 0,
    appliedTotal: Number(parsed?.appliedTotal ?? 0) || 0,
    history: Array.isArray(parsed?.history) ? parsed.history.slice(-20) : [],
  }
}

/** 写入整合状态（原子）。 */
export function writeState(coreDir, state) {
  ensureDir(coreDir)
  writeFileAtomic(join(coreDir, STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 })
  return state
}

/**
 * 判断是否到了该整合的时候。
 *
 * 采纳 Qoder 的三重闸门：**距上次够久 + 新增够多 + 扫描节流**。
 * 这里的"新增"用条目数近似 Qoder 的 session 数——本插件没有会话概念，
 * 用条目增量是同构且更省事的代理指标。
 *
 * @param {object} p - { state, entryCount, lastEntryCount, config, now }。
 * @returns {{due: boolean, reasons: string[], nextCheckAt: number}}
 */
export function dueInfo({ state, entryCount = 0, config, now = Date.now() }) {
  const reasons = []
  const minHours = config?.consolidateMinHours ?? 24
  const minNew = config?.consolidateMinSessions ?? 5
  const throttle = config?.scanThrottleMs ?? 10_000

  if (config?.consolidateEnabled === false) return { due: false, reasons: ['整合功能已关闭'], nextCheckAt: now + throttle }
  if (entryCount === 0) return { due: false, reasons: ['记忆集为空，无需整合'], nextCheckAt: now + throttle }

  const lastAt = state?.lastConsolidatedAt ?? 0
  const hoursSince = lastAt > 0 ? (now - lastAt) / 3_600_000 : Number.POSITIVE_INFINITY
  if (lastAt > 0 && hoursSince < minHours) reasons.push(`距上次整合仅 ${hoursSince.toFixed(1)}h（下限 ${minHours}h）`)

  const newSince = Math.max(0, entryCount - (state?.lastEntryCount ?? 0))
  if (newSince < minNew) reasons.push(`新增条目 ${newSince} 条（下限 ${minNew} 条）`)

  return { due: reasons.length === 0, reasons, nextCheckAt: now + throttle, hoursSince, newSince }
}

/**
 * 生成整合方案（**纯计算，无任何副作用**）。
 *
 * @param {object} p - { entries, files, config, now, accessCounts, memoryDir }。
 * @returns {object} 方案（含 planId）。
 */
export function buildPlan({ entries = [], files = [], config, now = Date.now(), accessCounts = new Map(), memoryDir = '' }) {
  const actions = []
  const today = dateStamp(new Date(now))
  const retention = config?.dailyRetentionDays ?? 30
  const dupThreshold = config?.duplicateThreshold ?? 0.82
  const staleDays = config?.staleArchiveDays ?? 180
  const warnDays = config?.stalenessWarnDays ?? 90

  // ── 0) 同主题矛盾 → 取代提议（**必须先算**）────────────────────────────────
  // 它决定哪些条目对不能再做"近重复合并"：一对话义矛盾的条目往往相似度也很高
  // （新的那条通常是旧的超集），既像重复又像矛盾。两者都做会互相打架——
  // 实测踩到过：同一对被同时判为 merge 与 supersede，merge 先执行就把旧结论
  // **静默删掉了，修正痕迹随之消失**，而取代的全部价值恰恰是留下这条痕迹。
  // 所以这里定下优先级：**矛盾 > 重复**。
  const contradictions = detectContradictions(entries, { config, now })
  const pairKey = (a, b) => [a, b].sort().join('|')
  const contradictoryPairs = new Set(contradictions.map((item) => pairKey(item.keep.entryId, item.supersede.entryId)))

  // ── 1) 近重复合并（同 scope + 同项目 + 同轨内比对）───────────────────────
  const groups = new Map()
  for (const entry of entries) {
    if (entry.track === 'queue' || entry.track === 'archive') continue
    const key = `${entry.scope}|${entry.projectId ?? '-'}|${entry.track}`
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }
  for (const [key, list] of groups) {
    // 保留「更新的那条」= 按条目自身的时间戳排序（同一文件里的条目 mtime 相同，
    // 单看 mtime 会把"保留哪条"变成不确定行为）。
    const sorted = [...list]
      .sort((a, b) => {
        const ra = a.recencyKey ?? ''
        const rb = b.recencyKey ?? ''
        if (ra !== rb) return rb.localeCompare(ra)
        return (b.mtime ?? 0) - (a.mtime ?? 0)
      })
      .slice(0, DUP_GROUP_CAP)
    const dropped = new Set()
    const tokenCache = new Map()
    const tokensOf = (entry) => {
      let cached = tokenCache.get(entry.entryId)
      if (cached === undefined) { cached = tokenSetOf(entry); tokenCache.set(entry.entryId, cached) }
      return cached
    }
    for (let i = 0; i < sorted.length; i += 1) {
      const keep = sorted[i]
      if (dropped.has(keep.entryId)) continue
      const keepTokens = tokensOf(keep)
      for (let j = i + 1; j < sorted.length; j += 1) {
        const candidate = sorted[j]
        if (dropped.has(candidate.entryId)) continue
        if (contradictoryPairs.has(pairKey(keep.entryId, candidate.entryId))) continue
        const similarity = duplicateSimilarity(keepTokens, tokensOf(candidate))
        if (similarity < dupThreshold) continue
        dropped.add(candidate.entryId)
        actions.push({
          type: 'merge',
          group: key,
          similarity: Number(similarity.toFixed(3)),
          keep: { entryId: keep.entryId, rel: keep.rel, path: keep.path, summary: keep.summary, date: keep.date },
          drop: {
            entryId: candidate.entryId, rel: candidate.rel, path: candidate.path,
            body: candidate.body, summary: candidate.summary, date: candidate.date, chars: candidate.chars,
          },
        })
      }
    }
  }

  // ── 2) 每日日志：**打包优先于蒸馏**（v0.3.3）────────────────────────────────
  // 两者都在处理"超期 daily"，但打包保留原文 + 留下高密度月摘要（分层），
  // 蒸馏只留一份清单式摘要且默认不删源。同时开启会重复处理同一批条目，
  // 所以打包启用时**跳过蒸馏**（想回到旧行为：monthlyPackEnabled: false）。
  const packs = planPacks({ entries, config, now, memoryDir })
  actions.push(...packs)

  const cutoff = dateStamp(new Date(now - retention * 86_400_000))
  const dailyFiles = new Map()
  if (config?.monthlyPackEnabled === false) {
    for (const entry of entries) {
      if (entry.track !== 'daily' || !entry.date) continue
      if (entry.date >= cutoff) continue
      const key = `${entry.scope}|${entry.projectId ?? '-'}`
      const bucket = dailyFiles.get(key) ?? { scope: entry.scope, projectId: entry.projectId, dates: new Set(), entries: [] }
      bucket.dates.add(entry.date)
      bucket.entries.push(entry)
      dailyFiles.set(key, bucket)
    }
  }
  for (const bucket of dailyFiles.values()) {
    const sorted = [...bucket.entries].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const lines = sorted.map((entry) => `- ${entry.date}${entry.time ? ` ${entry.time}` : ''} ${entry.summary}`)
    const proposedText = `[${today}] 蒸馏自 ${bucket.dates.size} 天日志（${sorted.length} 条，截至 ${cutoff}）：\n${lines.join('\n')}`
    actions.push({
      type: 'distill',
      scope: bucket.scope,
      projectId: bucket.projectId,
      sourceCount: sorted.length,
      sourceDates: [...bucket.dates].sort(),
      // **源条目正文字符数**：这是"若让模型重写摘要，它得先读多少"的真实口径。
      // 不能拿 proposedText 的长度顶替——那段文字是本地机械拼出来的，
      // 用它当"送模型的量"会把默认路径（0 token）算成有成本（2026-10-28 修正）。
      sourceChars: sorted.reduce((sum, entry) => sum + (entry.chars ?? 0), 0),
      target: targetRelFor({ scope: bucket.scope, track: 'memory', projectId: bucket.projectId }, { today }),
      proposedText: proposedText.length > DISTILL_TEXT_CAP ? `${proposedText.slice(0, DISTILL_TEXT_CAP)}…` : proposedText,
      sourceEntries: sorted.map((entry) => ({ rel: entry.rel, path: entry.path, entryId: entry.entryId, date: entry.date, chars: entry.chars ?? 0 })),
    })
  }

  // ── 3) 冷条目归档（遗忘链：时间 + 从未被召回 + 轨道允许）──────────────────
  for (const entry of entries) {
    if (!ARCHIVABLE_TRACKS.has(entry.track)) continue
    // 已被取代的条目不再进冷归档：它已经带着取代标记留档了，再归档一次
    // 只会在归档里产生重复副本，让"演进链"变得难读。
    if (entry.supersededBy) continue
    if (entry.ageDays === null || entry.ageDays < staleDays) continue
    if ((accessCounts.get(entry.entryId)?.count ?? 0) > 0) continue
    // **保护性内容永不按"没人再提"归档**（用户 2026-10-27 拍板的约束）：
    // 过敏/禁忌/不可逆代价/合规红线这类信息，一辈子只说一次也至关重要。
    if (isProtectedBody(entry.body, config?.protectedKeywords ?? [])) continue
    actions.push({
      type: 'archive',
      entryId: entry.entryId,
      scope: entry.scope,
      projectId: entry.projectId,
      track: entry.track,
      ageDays: entry.ageDays,
      source: { rel: entry.rel, path: entry.path, body: entry.body, summary: entry.summary },
      target: archiveRelFor({ scope: entry.scope, track: entry.track, projectId: entry.projectId }, { today }),
    })
  }

  // ── 3.5) 可疑标记（静默标记 + 延迟裁决：只贴旗子，不动正文）──────────────
  // 判据只看证据：像碎片、或与既有条目冲突（同一对矛盾里给**较旧**的那条贴旗）。
  // 绝不看"是否与主流相悖"——那是思想审查，不是噪声过滤。
  const suspects = []
  if (config?.suspectEnabled !== false) {
    const already = new Set(
      entries.filter((entry) => entry.suspect).map((entry) => bodyKey(entry.body)),
    )
    for (const entry of entries) {
      if (entry.suspect) continue
      if (isProtectedBody(entry.body, config?.protectedKeywords ?? [])) continue
      if (!isFragmentBody(entry.body, { minChars: config?.suspectMinChars ?? 12 })) continue
      suspects.push({
        type: 'suspect',
        entryId: entry.entryId,
        rel: `${entry.rel}#${entry.ordinal}`,
        body: entry.body,
        key: bodyKey(entry.body),
        reason: 'fragment',
        reasonText: SUSPECT_REASON_TEXT.fragment,
        summary: entry.summary,
      })
    }
    // 矛盾组：默认"取代提议"要人点头，在那之前先给旧的一条贴个"存疑"旗
    // （可逆、零成本），这样模型在后续会话里至少不会不假思索地引用旧结论。
    const seenContested = new Set()
    for (const pair of contradictions.slice(0, config?.contradictionMaxProposals ?? 20)) {
      const older = [pair.a, pair.b].filter(Boolean).sort((x, y) => String(x.date ?? '').localeCompare(String(y.date ?? '')))[0]
      if (!older || older.suspect) continue
      if (isProtectedBody(older.body, config?.protectedKeywords ?? [])) continue
      const key = bodyKey(older.body)
      if (seenContested.has(key) || already.has(key)) continue
      seenContested.add(key)
      suspects.push({
        type: 'suspect',
        entryId: older.entryId,
        rel: `${older.rel}#${older.ordinal}`,
        body: older.body,
        key,
        reason: 'contested',
        reasonText: SUSPECT_REASON_TEXT.contested,
        summary: older.summary,
      })
    }
  }

  // ── 4) 人工复核项（只提示，不自动动刀）──────────────────────────────────
  const reviews = []
  for (const entry of entries) {
    if (entry.chars > 4000) {
      reviews.push({ kind: 'oversized', entryId: entry.entryId, rel: `${entry.rel}#${entry.ordinal}`, chars: entry.chars, hint: '超长条目：建议拆成多条主题条目，或下沉到独立文档后索引只留指针' })
    }
    if (entry.date && entry.ageDays !== null && entry.ageDays >= warnDays && ARCHIVABLE_TRACKS.has(entry.track)) {
      reviews.push({ kind: 'stale', entryId: entry.entryId, rel: `${entry.rel}#${entry.ordinal}`, ageDays: entry.ageDays, hint: '长期未复核：据此断言前先核对现状，或更新/归档' })
    }
  }
  const onDisk = new Set(files.map((file) => file.rel))
  const indexedRels = new Set(entries.map((entry) => entry.rel))
  for (const rel of indexedRels) {
    if (!onDisk.has(rel)) reviews.push({ kind: 'dangling', rel, hint: '索引里存在但磁盘上已无此文件：重新索引即可清除' })
  }

  const counts = {
    merge: actions.filter((a) => a.type === 'merge').length,
    pack: actions.filter((a) => a.type === 'pack').length,
    distill: actions.filter((a) => a.type === 'distill').length,
    archive: actions.filter((a) => a.type === 'archive').length,
    supersede: contradictions.length,
    suspect: suspects.length,
    review: reviews.length,
  }
  const plan = {
    createdAt: now,
    today,
    memoryDir,
    counts,
    actions,
    suspects,
    contradictions,
    reviews: reviews.slice(0, 200),
    notes: buildNotes(counts, config),
  }
  return { ...plan, planId: planIdOf(plan) }
}

function buildNotes(counts, config) {
  const notes = []
  if (counts.merge > 0) notes.push(`合并 ${counts.merge} 条近重复（保留时间较新的那条，被合并的那条移出文件；原文件已备份）`)
  if (counts.distill > 0) notes.push(`把 ${counts.distill} 组超期每日日志蒸馏成长期记忆条目（默认**不删除**原日志，需显式 deleteSource=true 才删）`)
  if (counts.pack > 0) notes.push(`把 ${counts.pack} 个月的每日日志**按月打包**到 \`daily/archive/YYYY-MM.md\` 并在 \`DIGEST.md\` 里各留一条月摘要（要点带指针）：原文不删、仍可检索；这是"分层"而不是"压缩"`)
  if (counts.archive > 0) notes.push(`归档 ${counts.archive} 条冷条目（超过 ${config?.staleArchiveDays ?? 180} 天且从未被检索命中；是移动不是删除）`)
  if (counts.supersede > 0) notes.push(`${counts.supersede} 组同主题矛盾 → **提议取代**（把旧的标记为 [superseded-by] 并留档归档；默认只提议，要落地须在 apply 时显式传 supersede=true）`)
  if (counts.suspect > 0) notes.push(`${counts.suspect} 条被判定为**可能不可靠** → 贴静默标记（不动正文、不打扰用户；判据是"像碎片/与既有条目冲突"，**不看是否与主流相悖**）。标记后索引行带 ⚠?，核实可用 mem_write(action="verify") 清除`)
  if (counts.review > 0) notes.push(`${counts.review} 项需人工判断（超长/过期/悬挂索引），本方案不会自动处理`)
  if (notes.length === 0) notes.push('没有需要整合的内容')
  return notes
}

/** 由方案内容计算 planId（内容指纹）。 */
export function planIdOf(plan) {
  const canonical = JSON.stringify({
    today: plan.today,
    actions: (plan.actions ?? []).map((action) => {
      if (action.type === 'merge') return ['merge', action.keep.entryId, action.drop.entryId]
      if (action.type === 'distill') return ['distill', action.target, action.sourceDates, action.sourceCount]
      if (action.type === 'pack') return ['pack', action.month, action.target, action.count]
      if (action.type === 'archive') return ['archive', action.entryId, action.target]
      return [action.type, action.entryId ?? action.rel ?? null]
    }),
    // 取代提议也进指纹：否则"看过矛盾组"这件事无法与"方案没变"绑定，
    // 记忆一变就可能执行一份与所见不符的取代。
    contradictions: (plan.contradictions ?? []).map((item) => ['supersede', item.keep.entryId, item.supersede.entryId]),
    // 可疑标记也进指纹：标记虽不动正文，但"给哪几条贴旗"是方案的一部分，
    // 记忆一变（条目被改写/新增）就该重新评估，而不是照着旧名单贴。
    suspects: (plan.suspects ?? []).map((item) => ['suspect', item.key, item.reason]),
  })
  return sha1hex(canonical, 16)
}

/**
 * 应用整合方案。
 *
 * 三道闸门，缺一不可：
 *  1. `confirm === true`（并遵守 `consolidateApplyRequiresConfirm`）；
 *  2. `planId` 与"当前记忆状态重算出的方案"一致——记忆变过就拒绝，
 *     保证执行的一定是刚看过的那一份；
 *  3. 所有目标文件必须落在 `memoryDir` 内（路径越界直接拒绝）。
 *
 * @param {object} p - { plan, planId, config, coreDir, memoryDir, ledger, accessCounts, entries, files, confirm, deleteSource, distilledText, now }。
 * @returns {{ok: boolean, reason?: string, applied: object[], skipped: object[], errors: object[], backupDir: string|null, planId: string}}
 */
export function applyPlan({
  plan, planId, config, coreDir, memoryDir, ledger = null, accessCounts = new Map(),
  entries = [], files = [], confirm = false, deleteSource = false, distilledText = null,
  supersede = false, model = null, now = Date.now(),
}) {
  const stamp = dateStamp(new Date(now))
  // 备份可被配置关掉（backupBeforeWrite=false），但默认开——整合会改动记忆
  // 正本，没有备份就等于把回滚能力换成了几 KB 磁盘空间。
  const backupDir = config?.backupBeforeWrite !== false ? join(coreDir, BACKUP_DIR) : null
  const base = { applied: [], skipped: [], errors: [], backupDir, planId: planId ?? plan?.planId ?? null }

  if (!plan) return { ok: false, reason: '缺少整合方案', ...base }
  if (config?.consolidateApplyRequiresConfirm !== false && confirm !== true) {
    return { ok: false, reason: '整合会改动记忆正本：必须显式传 confirm=true（用户已确认该方案）', ...base }
  }

  // 闸门 2：方案指纹必须匹配"现在"重算出来的方案
  const fresh = buildPlan({ entries, files, config, now, accessCounts, memoryDir })
  if (fresh.planId !== plan.planId) {
    return {
      ok: false,
      reason: `方案已过期（planId ${plan.planId} ≠ 当前 ${fresh.planId}）：记忆在这期间发生了变化，请重新生成方案`,
      ...base,
    }
  }
  if (planId !== undefined && planId !== null && planId !== fresh.planId) {
    return { ok: false, reason: `planId 不匹配（传入 ${planId}，当前 ${fresh.planId}）`, ...base }
  }

  // 取代（L2）是"默认只提议"的：方案里的 contradictions 不会自动执行，
  // 必须在 apply 时额外显式传 supersede=true。理由见 §6.8——记忆的修正
  // 比记忆的收集更需要人定夺，所以多要一次授权。
  const planned = [...fresh.actions]
  // 可疑标记**不需要额外授权**：它不动正文、可逆、零成本，是三类动作里最轻的
  // （取代要额外 supersede=true，归档/合并/蒸馏改正文要 confirm）。这正是
  // "写入不打断、噪声静默标"的设计落点。
  planned.push(...(fresh.suspects ?? []))
  if (supersede === true) planned.push(...(fresh.contradictions ?? []))
  if (planned.length === 0) {
    const hint = (fresh.contradictions ?? []).length > 0
      ? `方案里只有 ${fresh.contradictions.length} 组同主题矛盾（取代提议）：要落地请在 apply 时显式传 supersede=true`
      : '方案为空，无需改动'
    return { ok: true, reason: hint, ...base }
  }

  const root = resolve(memoryDir)
  const guardPath = (rel) => {
    const full = resolve(root, rel)
    if (full !== root && !full.startsWith(root)) return null
    return full
  }

  const locked = withLock(join(coreDir, LOCK_FILE), () => {
    const result = { applied: [], skipped: [], errors: [] }
    const order = { pack: 0, archive: 1, supersede: 2, merge: 3, distill: 4, suspect: 5 }
    const actions = [...planned].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))

    for (const action of actions) {
      try {
        if (action.type === 'pack') {
          // 分层压缩：移入月文件 → 写月摘要 → 清空日文件（见 lib/pack.js）
          const packed = applyPack({
            action, config, coreDir, memoryDir, backupDir, stamp, now,
          })
          if (packed.ok) {
            result.applied.push({
              type: 'pack',
              month: action.month,
              to: action.target,
              digest: packed.digest,
              moved: packed.moved,
              files: packed.removedFiles.length,
              entries: action.count,
            })
          } else {
            result.errors.push({ action: 'pack', month: action.month, error: packed.errors.join('；') || '未知错误' })
          }
          continue
        }

        if (action.type === 'suspect') {
          // 只贴旗子：不改正本、不加文件锁（suspect.json 是派生物目录里的观测数据）。
          const marked = markSuspect({ coreDir, body: action.body, reason: action.reason, source: 'consolidate', now })
          result.applied.push({ type: 'suspect', rel: action.rel, reason: action.reason, key: marked.key, created: marked.created })
          continue
        }

        if (action.type === 'merge') {
          const file = guardPath(action.drop.rel)
          if (file === null) { result.errors.push({ action: 'merge', rel: action.drop.rel, error: '路径越界' }); continue }
          const outcome = removeEntries(file, [action.drop.body], { backupDir, stamp })
          if (outcome.removed > 0) {
            result.applied.push({ type: 'merge', keep: action.keep.rel, removed: action.drop.rel, removedEntries: outcome.removed, backup: outcome.backup, chars: action.drop.chars })
          } else {
            result.skipped.push({ type: 'merge', rel: action.drop.rel, reason: '文件中未找到该条目的精确正文（可能已被外部修改）' })
          }
          continue
        }

        if (action.type === 'archive') {
          const source = guardPath(action.source.rel)
          const target = guardPath(action.target)
          if (source === null || target === null) { result.errors.push({ action: 'archive', rel: action.source.rel, error: '路径越界' }); continue }
          const appended = appendEntry(target, stamped(action.source.body, `${stamp} ${new Date(now).toTimeString().slice(0, 5)}`), { backupDir, stamp })
          const removed = removeEntries(source, [action.source.body], { backupDir, stamp })
          result.applied.push({ type: 'archive', from: action.source.rel, to: action.target, moved: removed.removed, appended: appended.ok })
          continue
        }

        if (action.type === 'supersede') {
          const source = guardPath(action.supersede.rel)
          const archiveRel = archiveRelFor(
            { scope: action.supersede.scope, track: action.supersede.track, projectId: action.supersede.projectId },
            { today: stamp },
          )
          const target = guardPath(archiveRel)
          if (source === null || target === null) {
            result.errors.push({ action: 'supersede', rel: action.supersede.rel, error: '路径越界' })
            continue
          }
          const markedBody = `${supersededTag(action.keep.entryId)} ${action.supersede.body}`
          const appended = appendEntry(target, stamped(markedBody, `${stamp} ${new Date(now).toTimeString().slice(0, 5)}`), { backupDir, stamp })
          const removed = removeEntries(source, [action.supersede.body], { backupDir, stamp })
          result.applied.push({
            type: 'supersede',
            superseded: action.supersede.rel,
            by: action.keep.entryId,
            keptIn: action.keep.rel,
            archivedTo: archiveRel,
            marked: appended.ok,
            removedFromSource: removed.removed,
            signals: action.signals,
          })
          continue
        }

        if (action.type === 'distill') {
          const target = guardPath(action.target)
          if (target === null) { result.errors.push({ action: 'distill', rel: action.target, error: '路径越界' }); continue }
          const override = distilledText?.[action.target] ?? distilledText?.[action.sourceDates?.join(',')] ?? null
          const text = typeof override === 'string' && override.trim() !== '' ? override.trim() : action.proposedText
          const appended = appendEntry(target, text, { backupDir, stamp })
          const sources = deleteSource
            ? (action.sourceEntries ?? []).map((item) => {
              const file = guardPath(item.rel)
              if (file === null || !existsSync(file)) return { rel: item.rel, deleted: false }
              try {
                if (backupDir) backupFile(file, backupDir, stamp)
                unlinkSync(file)
                return { rel: item.rel, deleted: true }
              } catch (error) {
                return { rel: item.rel, deleted: false, error: String(error?.message ?? error) }
              }
            })
            : []
          result.applied.push({ type: 'distill', to: action.target, sources: action.sourceCount, deletedSources: sources.filter((s) => s.deleted).length, text: text.slice(0, 300) })
          continue
        }

        result.skipped.push({ type: action.type, reason: '无对应的自动动作（仅提示项）' })
      } catch (error) {
        result.errors.push({ action: action.type, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return result
  }, { label: 'memory-core consolidate', timeoutMs: 15_000, staleMs: 120_000 })

  if (!locked.ok) return { ok: false, reason: locked.reason, ...base, holder: locked.holder }

  const outcome = locked.value
  const state = readState(coreDir)
  const total = outcome.applied.length
  writeState(coreDir, {
    ...state,
    lastConsolidatedAt: now,
    lastPlanId: fresh.planId,
    lastEntryCount: entries.length,
    appliedTotal: (state.appliedTotal ?? 0) + total,
    history: [...(state.history ?? []), { at: now, planId: fresh.planId, applied: total, errors: outcome.errors.length }].slice(-20),
  })
  if (ledger) {
    ledger.append('consolidate', {
      planId: fresh.planId,
      applied: total,
      errors: outcome.errors.length,
      merges: outcome.applied.filter((a) => a.type === 'merge').length,
      archives: outcome.applied.filter((a) => a.type === 'archive').length,
      distills: outcome.applied.filter((a) => a.type === 'distill').length,
      supersedes: outcome.applied.filter((a) => a.type === 'supersede').length,
      suspects: outcome.applied.filter((a) => a.type === 'suspect').length,
      deleteSource: deleteSource === true,
      supersedeRequested: supersede === true,
      // 语义动作的模型名：机械整理为 null。有了它，"哪条蒸馏是哪个模型写的"
      // 才可追溯——否则"不同会话挑不同模型"会让整理质量变成黑盒。
      model: model ?? null,
      distilled: distilledText !== null,
    })
  }
  // 顺手清理孤儿标记（正文已变的标记自动失效）——这是标记的"到期机制"，
  // 只在 apply 这条写路径上做，渲染路径保持只读。
  const pruned = config?.suspectEnabled === false ? { removed: 0, remaining: 0 } : pruneOrphans({ coreDir, entries })

  return {
    ok: outcome.errors.length === 0, ...base,
    applied: outcome.applied, skipped: outcome.skipped, errors: outcome.errors,
    suspectMarksPruned: pruned.removed, suspectMarksRemaining: pruned.remaining,
  }
}

/** 状态行的可读渲染（给 `mem_health` / `mem_consolidate` 用）。 */
export function renderPlan(plan, limit = 40) {
  const lines = []
  lines.push(`方案 ${plan.planId}（${plan.today}）`)
  lines.push(`合并 ${plan.counts.merge} · 打包 ${plan.counts.pack ?? 0} · 蒸馏 ${plan.counts.distill} · 归档 ${plan.counts.archive} · 取代提议 ${plan.counts.supersede ?? 0} · 可疑标记 ${plan.counts.suspect ?? 0} · 需人工 ${plan.counts.review}`)
  for (const note of plan.notes) lines.push(`· ${note}`)
  if (plan.actions.length > 0) {
    lines.push('')
    lines.push('待执行动作（apply 时执行）：')
    for (const action of plan.actions.slice(0, limit)) {
      if (action.type === 'merge') lines.push(`  [merge ${action.similarity}] 保留 ${action.keep.rel} ← 移除 ${action.drop.rel}（${String(action.drop.summary).slice(0, 60)}）`)
      else if (action.type === 'archive') lines.push(`  [archive ${action.ageDays}d] ${action.source.rel} → ${action.target}（${String(action.source.summary).slice(0, 60)}）`)
      else if (action.type === 'distill') lines.push(`  [distill] ${action.sourceCount} 条 → ${action.target}（${action.sourceDates?.slice(0, 6).join('、')}…）`)
      else if (action.type === 'pack') lines.push(`  [pack ${action.month}] ${action.count} 条 → ${action.target} + 月摘要 → ${action.digestTarget}${action.protectedKept > 0 ? `（${action.protectedKept} 条保护性内容留在热区）` : ''}`)
    }
    if (plan.actions.length > limit) lines.push(`  …另有 ${plan.actions.length - limit} 条`)
  }
  const contradictions = plan.contradictions ?? []
  if (contradictions.length > 0) {
    lines.push('')
    lines.push('取代提议（**默认不执行**；要落地须 apply 时显式传 supersede=true）：')
    for (const item of contradictions.slice(0, limit)) {
      lines.push(`  [supersede ${item.similarity}] ${item.supersede.rel} “${String(item.supersede.summary).slice(0, 46)}”`)
      lines.push(`      ← 被 ${item.keep.rel} “${String(item.keep.summary).slice(0, 46)}” 取代`)
      lines.push(`      判据：${(item.signals ?? []).join(' + ')}`)
    }
    if (contradictions.length > limit) lines.push(`  …另有 ${contradictions.length - limit} 组`)
  }
  if (plan.reviews.length > 0) {
    lines.push('')
    lines.push('需人工判断（不会自动处理）：')
    for (const review of plan.reviews.slice(0, 12)) lines.push(`  [${review.kind}] ${review.rel} — ${review.hint}`)
    if (plan.reviews.length > 12) lines.push(`  …另有 ${plan.reviews.length - 12} 项`)
  }
  const suspects = plan.suspects ?? []
  if (suspects.length > 0) {
    lines.push('')
    lines.push('可疑标记（**静默**：不动正文、不打扰用户；apply 时随方案一起贴上）：')
    for (const item of suspects.slice(0, limit)) {
      lines.push(`  [${item.reason}] ${item.rel} — ${String(item.summary ?? '').slice(0, 60)}`)
    }
    if (suspects.length > limit) lines.push(`  …另有 ${suspects.length - limit} 条`)
    lines.push('  （判据只看"缺证据/像碎片/与既有条目冲突"，**不看是否与主流相悖**；核实后用 mem_write(action="verify") 清除）')
  }
  lines.push('')
  lines.push(renderTokenEstimate(plan))
  return lines.join('\n')
}

/**
 * 估算"这次整理要是交给模型做，大约要花多少 token"。
 *
 * 为什么需要它：整理动作里只有一部分真正需要模型——
 *  - **纯机械动作**（merge 的近重复判定、archive、suspect 贴旗）在本地算完，
 *    **零 token**；
 *  - 只有 **distill**（把日志压成长期条目）与 **supersede**（判断哪条是修正后的结论）
 *    值得交给模型，因为那两件事需要语义理解。
 * 所以这里只累加那两类的正文规模，并给出一个**保守换算**：中文 1 token ≈ 1.5 字符
 * （英文约 1 token ≈ 4 字符；按更贵的中文估，宁可高估）。
 *
 * @param {object} plan - 方案。
 * @returns {string} 一行估算说明。
 */
export function estimateModelTokens(plan) {
  // 口径（2026-10-28 修正）：蒸馏**默认是本地机械拼接**（日期 + 各条摘要），
  // 一个 token 都不用；只有调用方主动传 `distilledText` 让模型重写摘要时，
  // 才需要把**源条目正文**送进模型。所以这里累加 `sourceChars`（源正文），
  // 而不是 `proposedText`（那已经是本地生成的草案）。
  let chars = 0
  const parts = []
  for (const action of plan?.actions ?? []) {
    if (action.type !== 'distill') continue
    const sourceChars = Number(action.sourceChars ?? 0)
    if (sourceChars <= 0) continue
    chars += sourceChars
    parts.push('distill')
  }
  for (const item of plan?.contradictions ?? []) {
    chars += String(item.keep?.body ?? '').length + String(item.supersede?.body ?? '').length
    parts.push('supersede')
  }
  return {
    chars,
    tokens: Math.ceil(chars / 1.5),
    parts,
  }
}

/** 把 token 估算渲染成一行（供 renderPlan / mem_health 用）。 */
export function renderTokenEstimate(plan) {
  const estimate = typeof plan === 'object' && plan !== null && 'chars' in plan ? plan : estimateModelTokens(plan)
  if (estimate.chars === 0) {
    return '模型成本：**0 token**——蒸馏是本地机械拼接（日期 + 各条摘要），合并/归档/可疑标记也都是确定性判定。'
      + ' 只有你想让模型重写摘要（apply 时传 distilledText）或裁定矛盾（supersede=true）时才会用到模型。'
  }
  const kinds = estimate.parts.length > 0 ? `（${[...new Set(estimate.parts)].join('/')}）` : ''
  return `模型成本：**默认 0 token**（机械拼接）。若改为让模型重写摘要/裁定矛盾${kinds}，`
    + `需要读约 ${estimate.chars} 字符 ≈ **${estimate.tokens} tokens**（中文 1 token ≈ 1.5 字符保守估）+ 输出不超过 ${DISTILL_TEXT_CAP} 字符/组。`
}