/**
 * lib/global.js — 全局记忆（**槽位模型**）。
 *
 * ## 它和"概览"的区别
 * 概览（v0.3.7）是**挑选**：从几十条记忆里挑 36 条、截断、列出来——体量 4600 字符，
 * 读起来仍是一份清单。这一版换成**槽位**：一份几百字的短文档，每个槽一句话，
 * 一屏看完、裸眼能判断"它记错了没有"。
 *
 * ## 为什么是槽，而不是"往末尾追加"
 * 用户提的"叠加更新"方向对，但叠在**段落**上会膨胀、会让新旧结论共存
 * （"空仓 1 万"和"已建仓 3 万"同时在文里）。叠在**槽**上两个毛病都没了：
 *   - 槽间叠加：改一个槽不影响别的槽 → 没有"每次重写导致措辞漂移"；
 *   - 槽内重写：一个槽永远只有一个当前值 → 没有矛盾共存；
 *   - 槽数封顶（8 个）→ 不会逐月膨胀。
 *
 * 这就是注入分槽用过的同一个思路（World State：结构稳定、值可变），
 * 只是从"索引进哪几条"换到"这段内容该归到哪个槽"。
 *
 * ## 文件形态（`GLOBAL.md`，人可读、可手改）
 * ```md
 * # 记忆
 *
 * ## 身份
 * 蔡润泽，深圳，185cm/77.5kg，简体中文。
 *
 * ## 投资风格
 * A股基本面+催化剂；逆向抄底、分批建仓、四层信号矩阵。
 * ```
 *
 * @module vanwork-memory-core/lib/global
 */

/** 全局记忆文件名（记忆根下）。 */
export const GLOBAL_REL = 'GLOBAL.md'

/** 槽数上限（封顶才不膨胀）。 */
export const MAX_SLOTS = 8
/** 单槽字符上限（一句话，不写小作文）。 */
export const MAX_SLOT_CHARS = 80

/** 建议的槽名（模型可以新开，但优先复用这些，避免同义槽分裂）。 */
export const SUGGESTED_SLOTS = [
  '身份', '投资风格', '当前持仓', '输出偏好', '工作方向', '设备与工具', '近期计划', '进行中项目',
]

/** 文件头（告诉手改的人这份东西是什么）。 */
const HEADER = [
  '# 记忆',
  '',
  '<!-- 由记忆插件维护：每个 ## 是一个槽，一槽一句话。',
  '     改这里只改这一份，不会改动原始记忆；也不需要手写"重新生成"。 -->',
  '',
]

/** 把文本切成槽：`## 名字` 起头，正文到下一个 `##`。 */
export function parseSlots(text = '') {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const slots = []
  let current = null
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (current && current.value !== '') slots.push(current)
      current = { name: match[1].trim(), value: '' }
      continue
    }
    if (current === null) continue
    if (/^<!--/.test(line.trim())) continue
    current.value = current.value === '' ? line.trim() : `${current.value} ${line.trim()}`.trim()
  }
  if (current && current.value !== '') slots.push(current)
  return slots
}

/** 渲染回 Markdown（槽顺序 = 数组顺序，稳定输出便于 diff）。 */
export function renderSlots(slots = [], { stamp = null } = {}) {
  const lines = [...HEADER]
  for (const slot of slots) lines.push(`## ${slot.name}`, slot.value, '')
  if (stamp) lines.push(`<!-- 更新于 ${stamp} -->`, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** 压成一句话：压平空白 + 截断到槽上限。 */
export function clipValue(value) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_SLOT_CHARS ? `${flat.slice(0, MAX_SLOT_CHARS - 1)}…` : flat
}

/**
 * 应用一组槽操作（合并的核心）。
 *
 * `ops` 只允许三种：
 *   `{ op: 'set', name, value }` —— 新增或改写（同一件事：一个槽只有一个当前值）
 *   `{ op: 'del', name }`        —— 删除（比如"当前持仓"变成空仓后不该留着旧仓位）
 *
 * 拒绝规则（都会原样报回来，不静默吞掉）：
 *   - 超出 `MAX_SLOTS` → `full`
 *   - 名字为空 → `no-name`
 *   - 删除不存在的槽 → `not-found`（不算错误，只是没东西可删）
 *
 * @param {object[]} slots - 现有槽。
 * @param {object[]} ops - 操作。
 * @returns {{slots: object[], changes: object[], rejected: object[]}}
 */
export function applyOps(slots = [], ops = []) {
  const next = slots.map((slot) => ({ ...slot }))
  const changes = []
  const rejected = []

  for (const op of ops) {
    const name = String(op?.name ?? '').trim()
    if (name === '') { rejected.push({ name, reason: 'no-name' }); continue }
    const at = next.findIndex((slot) => slot.name === name)

    if (op.op === 'del') {
      if (at === -1) { rejected.push({ name, reason: 'not-found' }); continue }
      changes.push({ op: 'del', name, from: next[at].value, to: null })
      next.splice(at, 1)
      continue
    }

    // set（含 add）：槽存在就改写，不存在就新增——但对"新增"要守住上限
    const value = clipValue(op.value)
    if (value === '') { rejected.push({ name, reason: 'empty' }); continue }
    if (at === -1) {
      if (next.length >= MAX_SLOTS) { rejected.push({ name, reason: 'full' }); continue }
      next.push({ name, value })
      changes.push({ op: 'add', name, from: null, to: value })
    } else if (next[at].value !== value) {
      changes.push({ op: 'set', name, from: next[at].value, to: value })
      next[at] = { name, value }
    }
  }

  return { slots: next, changes, rejected }
}

/**
 * 算"槽位层面的差异"（给方案/审计用）。
 * @param {object[]} before - 旧槽。
 * @param {object[]} after - 新槽。
 * @returns {{added: string[], changed: object[], removed: string[]}}
 */
export function diffSlots(before = [], after = []) {
  const oldMap = new Map(before.map((slot) => [slot.name, slot.value]))
  const newMap = new Map(after.map((slot) => [slot.name, slot.value]))
  const added = [...newMap.keys()].filter((name) => !oldMap.has(name))
  const removed = [...oldMap.keys()].filter((name) => !newMap.has(name))
  const changed = []
  for (const [name, value] of newMap) {
    if (oldMap.has(name) && oldMap.get(name) !== value) changed.push({ name, from: oldMap.get(name), to: value })
  }
  return { added, changed, removed }
}

/**
 * 把"差异"渲染成一句人话（面板与工具输出共用）。
 * @param {object} diff - `diffSlots` 的返回。
 * @returns {string}
 */
export function describeDiff(diff) {
  const parts = []
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.length} 槽（${diff.added.join('、')}）`)
  if (diff.changed.length > 0) parts.push(`改写 ${diff.changed.length} 槽（${diff.changed.map((item) => item.name).join('、')}）`)
  if (diff.removed.length > 0) parts.push(`删除 ${diff.removed.length} 槽（${diff.removed.join('、')}）`)
  return parts.length === 0 ? '没有任何变化' : parts.join(' · ')
}

/** 粗略体量：字符数（面板显示"一屏装不装得下"）。 */
export function slotsChars(slots = []) {
  return slots.reduce((sum, slot) => sum + slot.name.length + slot.value.length + 2, 0)
}