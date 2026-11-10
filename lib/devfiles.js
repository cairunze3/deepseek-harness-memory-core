/**
 * lib/devfiles.js — 开发者模式的文件清点：磁盘上真有哪些 md + 还缺哪些。
 *
 * ## 两层输出
 *  1. **实际存在的**（来自 `listFiles`，不是从 schema 猜）：用户可能手工建了
 *     `projects/<id>/TODO.md`，它照样进索引、照样要能编辑；
 *  2. **应该有但还没有的**（`missing: true`）：按 `filedocs.PRECREATE` 与派生物清单
 *     补出来。这一层是"结构可见"的关键——不列出来时，用户只能靠文档知道
 *     "这套记忆本来还有 QUEUE.md / KEY.md"。
 *
 * 文案不在这里：标题、作用、注入方式、注意事项全部来自 `filedocs.js`（单一来源），
 * 这样"列表里那行说明"与"文件头的说明注释"永远一致。
 *
 * @module vanwork-memory-core/lib/devfiles
 */

import { join } from 'node:path'
import { dateStamp, listFiles, mtimeMs, relativePosix, sizeOf } from './fsutil.js'
import { MAX_FILE_BYTES } from './scanner.js'
import { listProjectDirs } from './paths.js'
import { OVERVIEW_REL } from './overview.js'
import { DEV_EXTENSIONS, PRECREATE, describeFile, rankOf } from './filedocs.js'

export { describeFile, DEV_EXTENSIONS }
export { INJECT_KINDS } from './filedocs.js'

/** 单文件读取上限（与扫描器一致，防误配根目录时把大文件读进内存）。 */
export const MAX_DEV_BYTES = MAX_FILE_BYTES

/**
 * 派生物：**不预建**，但要在清单里露头，让人知道"这套记忆理论上还有它"。
 * - 根目录：`OVERVIEW.md`（概览，全局只有一份）+ `DIGEST.md`（月摘要）；
 * - 项目内：只有 `DIGEST.md`——概览不分项目，不该出现 `projects/<id>/OVERVIEW.md`。
 */
const DERIVED_ROOT = [OVERVIEW_REL, 'DIGEST.md']
const DERIVED_PROJECT = ['DIGEST.md']

/** 分组排序权重（让同目录的文件聚在一起，界面不会出现两个同名分组标题）。 */
function groupRank(group) {
  if (group === '根目录') return 0
  if (group === 'daily/') return 1
  if (group.startsWith('projects/')) return 2
  return 3
}

/** 按目录分组：根 → daily/ → projects/<id>/ → 其他。 */
function groupOf(rel) {
  if (!rel.includes('/')) return '根目录'
  if (rel.startsWith('daily/')) return 'daily/'
  if (rel.startsWith('projects/')) {
    const parts = rel.split('/')
    return parts.length >= 3 ? `projects/${parts[1]}/` : 'projects/'
  }
  return '其他'
}

/** stat 时间（ms → 本地可读串）；失败返回 null。 */
export function mtimeOf(full) {
  const ms = mtimeMs(full)
  if (ms === null) return null
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 列出记忆根下全部可编辑的 Markdown（含"应该有但还没有"的占位行）。
 *
 * @param {string} memoryDir - 记忆根。
 * @param {object} [opts] - { today='YYYY-MM-DD' }。
 * @returns {Array<object>} 行（已排序：角色优先级 → 路径）。
 */
export function listDevFiles(memoryDir, opts = {}) {
  const today = opts.today ?? dateStamp()
  const files = listFiles(memoryDir, {
    maxFiles: 2000,
    maxDepth: 6,
    filter: (full) => DEV_EXTENSIONS.some((ext) => full.toLowerCase().endsWith(ext)),
  })

  const rows = []
  const seen = new Set()
  for (const full of files) {
    const rel = relativePosix(memoryDir, full)
    const bytes = sizeOf(full)
    if (bytes > MAX_DEV_BYTES) continue // 超限文件不列出来（界面上也读不了）
    seen.add(rel)
    rows.push({
      rel,
      group: groupOf(rel),
      bytes,
      mtime: mtimeOf(full),
      empty: bytes === 0,
      missing: false,
      ...describeFile(rel),
    })
  }

  /** 补一条"应该有但还没有"的占位行（reason: 'not-created' | 'derived'）。 */
  const addMissing = (rel, reason) => {
    const key = rel.replace('<today>', today)
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      rel: key,
      group: groupOf(key),
      bytes: 0,
      mtime: null,
      empty: true,
      missing: true,
      reason,
      ...describeFile(key),
    })
  }

  for (const rel of PRECREATE.global) addMissing(rel, 'not-created')
  for (const rel of DERIVED_ROOT) addMissing(rel, 'derived')
  for (const { id } of listProjectDirs(join(memoryDir, 'projects'))) {
    for (const rel of PRECREATE.project) addMissing(`projects/${id}/${rel}`, 'not-created')
    for (const rel of DERIVED_PROJECT) addMissing(`projects/${id}/${rel}`, 'derived')
  }

  // **先按目录分组、再按角色**：界面就是按这个顺序切分组标题的，
  // 若先按角色排，`projects/<id>/` 的文件会被别的组隔开 → 同名分组标题出现两次。
  rows.sort((a, b) => groupRank(a.group) - groupRank(b.group)
    || a.group.localeCompare(b.group)
    || rankOf(a.rel) - rankOf(b.rel)
    || a.rel.localeCompare(b.rel))
  return rows
}

/** rel 是否是可编辑的 Markdown（路由层的白名单）。 */
export function isDevEditable(rel) {
  const path = String(rel ?? '').toLowerCase()
  return DEV_EXTENSIONS.some((ext) => path.endsWith(ext))
}
