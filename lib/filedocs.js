/**
 * lib/filedocs.js — 记忆根下每一类 Markdown 的「是什么 / 怎么注入 / 注意什么」。
 *
 * ## 为什么单独一个模块
 * 同一份文案现在有三个消费者：
 *  1. 开发者模式的文件列表（`devfiles.js`）——列表里那一行说明；
 *  2. 空文件的头部说明（`scanner.js` 的 `ensureRootLayout`）——写进文件本体；
 *  3. 预建清单——哪些文件"应该有"。
 * 三处各写一份必然漂移（改了一处忘了另一处，用户看到的列表说明与文件里的说明
 * 对不上），所以文案只在这里写，其它地方只引用。
 *
 * ## 说明为什么要写进文件本体
 * 记忆根是用户能直接打开的文件目录。没有说明时 `QUEUE.md` 和 `MEMORY.md` 长得
 * 一样"像记忆"，实际一个**不进注入**、一个进；`OVERVIEW.md` 更是改了也不生效。
 * 这类误判只能靠"打开就看到它是什么"来消除。
 *
 * 说明用 **HTML 注释**写，不占正文：`scanner.splitHeaderComments` 会把文件头的
 * 注释整块剥掉，所以带说明的空文件仍然是"空文件"（0 条目、0 注入），而写盘时
 * `memfile.joinChunks` 又会把它原样拼回去（不会被当成一条记忆、也不会被覆盖）。
 *
 * @module vanwork-memory-core/lib/filedocs
 */

import { GLOBAL_REL, MAX_SLOTS, MAX_SLOT_CHARS } from './global.js'
import { OVERVIEW_REL } from './overview.js'

/** 开发者模式下可读写的扩展名（只开放 Markdown，index.db / jsonl 不碰）。 */
export const DEV_EXTENSIONS = ['.md', '.markdown']

/**
 * 注入方式（界面上的信号灯）：
 *  - `always`  每轮常驻注入（花的是每一步的钱）
 *  - `retrieval` 只进索引，按需检索/命中后才出现
 *  - `archive` 永不注入，仅留档追溯（可被显式 includeArchived 召回）
 *  - `derived` 派生物，改它不改原文
 *  - `pending` 待确认候选（不进注入，等命中或人工晋升）
 */
export const INJECT_KINDS = {
  always: { label: '常驻注入', dot: '🟢' },
  retrieval: { label: '按需检索', dot: '🔵' },
  archive: { label: '仅留档', dot: '⚪' },
  derived: { label: '派生物', dot: '🟡' },
  pending: { label: '待确认候选', dot: '🟠' },
}

/**
 * 文件角色表。顺序即界面排序（越靠前越"该先看"）。
 * `match` 收 rel（POSIX 相对路径，如 `projects/abc123/KEY.md`）。
 * `derivedOnly` = 派生物，不预建（生成了才会出现）。
 */
const DOCS = [
  {
    match: (rel) => rel === GLOBAL_REL,
    title: '全局记忆（槽位）',
    inject: 'always',
    what: `每轮对话都会原样带给模型的短档案，是"AI 现在默认记得你什么"的正面清单。最多 ${MAX_SLOTS} 段，每段一句话（≤${MAX_SLOT_CHARS} 字），一个槽永远只有一个当前值。`,
    note: '手改这里等于直接改模型的默认认知，改完下一轮即生效。',
  },
  {
    match: (rel) => rel === 'USER.md',
    title: '用户档案',
    inject: 'always',
    what: '关于"你是谁"的稳定事实：身份、语言、设备、沟通偏好。所有项目共用，优先级最高。',
    note: '只写长期不变的东西；会过期的状态写进 daily。',
  },
  {
    match: (rel) => /^(?:projects\/[^/]+\/)?QUEUE\.md$/.test(rel),
    title: '待巩固队列',
    inject: 'pending',
    what: '模型写入时没带 confirm 的候选条目落在这里（写入门槛递增的中间态）。按设计**不进常驻注入**，被检索命中或人工确认后才晋升到正轨。',
    note: '删掉一条 = 放弃这条候选（不会自动补回）；想让它立刻生效，用 mem_write 带 confirm 重写进目标轨。',
  },
  {
    match: (rel) => rel === 'MEMORY.md',
    title: '全局事实',
    inject: 'retrieval',
    what: '跨项目通用的长期事实与约定（按 § 分条的条目流）。进索引，按相关度被检索或注入。',
    note: '与 GLOBAL.md 的区别：这里是"全量事实库"，GLOBAL 是"挑出来的那一屏"。',
  },
  {
    match: (rel) => /^(?:projects\/[^/]+\/)?KEY\.md$/.test(rel),
    title: '项目关键记忆',
    inject: 'always',
    what: '只在该项目生效、且"必须遵守"的约定（技术选型、禁改项、构建口径）。优先注入，并支持 [branch:…] 限定分支范围。',
    note: '这里的条目进常驻池，越短越好；背景资料写 MEMORY.md。',
  },
  {
    match: (rel) => /^(?:projects\/[^/]+\/)?DIGEST\.md$/.test(rel),
    title: '月摘要（分层压缩）',
    inject: 'retrieval',
    derivedOnly: true,
    what: '把多日 daily 压成结论的"温区"文档，用来替代逐条召回原始日志，降低常驻成本。',
    note: '由整合流程生成；手改会让摘要与原文出现偏差，改前先看一眼原文。',
  },
  {
    match: (rel) => rel === OVERVIEW_REL,
    title: '全局概览（派生物）',
    inject: 'derived',
    derivedOnly: true,
    what: '从各分片里挑条目 + 指针拼成的入口页，只为"一眼看全"。',
    note: '改它不会改原文，而且重新生成会整份覆盖——要改内容请改指针指向的那份文件。',
  },
  {
    match: (rel) => /^projects\/[^/]+\/MEMORY\.md$/.test(rel),
    title: '项目记忆',
    inject: 'retrieval',
    what: '只在这个工作区里成立的事实与决策（架构、踩过的坑、验证结果）。进索引，按需检索。',
    note: '项目身份由 git remote 归一化键决定，换目录/换 clone 方式不会丢。',
  },
  {
    match: (rel) => /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(rel),
    title: '每日日志',
    inject: 'retrieval',
    what: '当天每轮观测的原始流水，是摘要与蒸馏的原料。默认低优先，通常不常驻。',
    note: '写错这里只会影响追溯，不会直接改变模型的默认认知。',
  },
  {
    match: (rel) => /^projects\/[^/]+\/daily\/\d{4}-\d{2}-\d{2}\.md$/.test(rel),
    title: '项目日志',
    inject: 'retrieval',
    what: '某个项目当天的流水记录，只在该项目语境下参与检索。',
    note: '跨项目通用的结论请写到根目录的 daily 或 MEMORY.md。',
  },
  {
    match: (rel) => /^(?:projects\/[^/]+\/)?daily\/archive\//.test(rel),
    title: '日志月包（归档）',
    inject: 'archive',
    derivedOnly: true,
    what: '过期日志按月打包后的文件，不再逐条进常驻索引，只为压缩存储与追溯。',
    note: '改它基本不会影响模型记忆；要恢复某条，请写回 MEMORY.md 或 daily。',
  },
  {
    match: (rel) => /^(?:projects\/[^/]+\/)?archive\//.test(rel),
    title: '归档条目',
    inject: 'archive',
    derivedOnly: true,
    what: '被淘汰/被取代的条目留档（遗忘 = 归档，不是删除）。默认不注入、不参与召回。',
    note: '这是回溯用的历史层；想让它重新生效，请把内容写回正本并标注。',
  },
  {
    match: (rel) => /-archive\.md$/.test(rel),
    title: '归档轨',
    inject: 'archive',
    derivedOnly: true,
    what: 'MEMORY/USER/KEY 的归档页签（`*.md` → `*-archive.md`）。永不注入，仅供追溯。',
    note: '归档是可查的历史，不是当前事实——模型不会读它来回答现在的问题。',
  },
]

/** 兜底说明：真遇到没见过的文件也不藏。 */
const UNKNOWN_DOC = {
  title: '其他记忆文件',
  inject: 'retrieval',
  what: '没有匹配到已知形态的 Markdown。它照样会被扫描进索引（轨道取文件名主干），所以仍可能影响检索结果。',
  note: '可以原样查看与编辑；写入前建议确认它不是别人的派生物。',
}

/** 取该 rel 的说明条目（含内部字段）。 */
function docOf(rel) {
  const path = String(rel ?? '').replace(/\\/g, '/')
  return DOCS.find((candidate) => candidate.match(path)) ?? null
}

/** 排序权重（越靠前越"该先看"；未知文件排最后）。 */
export function rankOf(rel) {
  const index = DOCS.findIndex((doc) => doc.match(String(rel ?? '').replace(/\\/g, '/')))
  return index === -1 ? DOCS.length : index
}

/**
 * 描述一个记忆文件。
 * @param {string} rel - POSIX 相对路径。
 * @returns {{title: string, inject: string, injectLabel: string, dot: string, what: string, note: string, known: boolean, derivedOnly: boolean}}
 */
export function describeFile(rel) {
  const doc = docOf(rel) ?? UNKNOWN_DOC
  const kind = INJECT_KINDS[doc.inject] ?? INJECT_KINDS.retrieval
  return {
    title: doc.title,
    inject: doc.inject,
    injectLabel: kind.label,
    dot: kind.dot,
    what: doc.what,
    note: doc.note,
    known: doc !== UNKNOWN_DOC,
    derivedOnly: doc.derivedOnly === true,
  }
}

/**
 * 生成该文件的头部说明（HTML 注释，多行）。
 *
 * 刻意写成注释而不是正文：`splitHeaderComments` 会把它整块剥掉，所以带说明的
 * 空文件在扫描侧仍然是 0 条目（不产生假记忆、不占注入预算）。
 *
 * @param {string} rel - POSIX 相对路径。
 * @returns {string} 以 `<!--` 开头、`-->` 结尾、带尾换行的注释块。
 */
export function headerNote(rel) {
  const doc = describeFile(rel)
  const lines = [
    '<!-- 记忆文件说明（本注释不算记忆内容，可删；删了不影响功能）',
    `${rel} · ${doc.title} · ${doc.dot} ${doc.injectLabel}`,
    `作用：${doc.what}`,
    `注意：${doc.note}`,
    '-->',
  ]
  return `${lines.join('\n')}\n`
}

/**
 * 该文件的初始内容（预建空文件时写入）。
 *
 * `GLOBAL.md` 额外带 `# 记忆` 标题：槽位文档需要这个名字，而"只有标题没有正文"
 * 的块会被 `splitIntoEntries` 丢弃，所以它同样不产生条目。
 *
 * @param {string} rel - POSIX 相对路径。
 * @returns {string}
 */
export function initialContent(rel) {
  const note = headerNote(rel)
  return String(rel).replace(/\\/g, '/') === GLOBAL_REL ? `${note}\n# 记忆\n` : note
}

/**
 * 预建清单：启动时补齐的空文件（**派生物不在此列**——它们生成了才会出现）。
 *
 * 为什么不预建派生物：
 *  - `OVERVIEW.md` 预建后 `text !== ''`，概览面板会直接显示注释而不是自动生成；
 *  - `DIGEST.md` / `archive/*` 是分层压缩与归档的产物，空文件会让"有没有归档"
 *    这类判据失真。
 * 它们在开发者模式的列表里仍然会以「未创建」出现（可点开新建），只是不主动落盘。
 */
export const PRECREATE = {
  /** 根目录（与项目身份无关）。`<today>` 会被替换成当天日期。 */
  global: [GLOBAL_REL, 'USER.md', 'MEMORY.md', 'QUEUE.md', 'daily/<today>.md'],
  /** 项目目录内（只在项目目录已存在时补齐，不新建目录）。 */
  project: ['MEMORY.md', 'KEY.md', 'daily/<today>.md'],
}
