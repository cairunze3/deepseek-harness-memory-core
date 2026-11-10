/**
 * lib/config.js — 插件配置默认值与解析。
 *
 * 为什么不用 `export const Config = z.object(...)`：schemastery 属于
 * `@deepseek-ai/*`，而 profile 的 node_modules 解析不到 runtime app 的包
 * （dsh-memory-evolve 同样选择零依赖）。因此这里自备一份带默认值、类型
 * 归一与边界钳制的解析器。
 *
 * **默认值是这份插件最主要的「取舍」产物**——每一项都在注释里写明它采纳
 * 了哪一家的做法、放弃了什么。详见 docs/记忆插件设计方案.md 的取舍矩阵。
 *
 * @module vanwork-memory-core/lib/config
 */

import { expandHome } from './paths.js'

/** 插件默认配置。 */
export const DEFAULTS = {
  // ── 存储位置 ────────────────────────────────────────────────────────────
  /** null → $DSH_HOME / ~/.dsh（与 @deepseek-ai/dsh-home-paths 同规则）。 */
  dshHome: null,
  /**
   * null → `<dshHome>/memories`。
   * **刻意与 dsh-memory-evolve 同根**：两家共用一份记忆正本，本插件只做
   * 「派生索引 + 整合 + 检索」，不产生第二份存储（避免双写不一致）。
   */
  memoryDir: null,
  /** null → `<dshHome>/memory-core`：索引 DB、账本、整合状态——全部可重建/可删。 */
  coreDir: null,
  /** 记忆根不存在时自建 `<coreDir>/store`，让插件在没有 memory-evolve 时也能独立工作。 */
  standaloneStore: true,
  /**
   * 预建记忆文件（2026-11-04 用户要求：**默认创建所有 md 的空文件，即使规则没触发**）。
   *
   * 打开 `~/.dsh/memories/` 时应该能直接看到"这套记忆有哪些轨"，而不是等用得
   * 多了才逐个长出来。开启后会幂等补齐（只写不存在的路径，绝不覆盖）：
   *  - 根目录：`GLOBAL.md` / `USER.md` / `MEMORY.md` / `QUEUE.md` / `daily/<今天>`；
   *  - 已存在的项目目录：`MEMORY.md` / `KEY.md` / `daily/<今天>`。
   *
   * **派生物不预建**（`OVERVIEW.md` / `DIGEST.md` / `archive/*`）：它们出现即代表
   * "已生成"，预建空文件会让这类判据失真（概览面板会不再自动生成）。
   * 每个预建文件的头部带一句功能说明（HTML 注释，不算记忆条目）。
   */
  precreateFiles: true,
  /** 相对记忆根的最大扫描深度 / 最多文件数（防止误配根目录时把整盘扫进来）。 */
  scanMaxFiles: 5000,
  scanMaxDepth: 6,

  // ── 索引常驻注入（采纳 Qoder 的「索引先行 + 硬预算」）────────────────────
  injectIndex: true,
  /**
   * 注入形态（2026-11-03 用户拍板）：
   *  - `'pointer'`（默认）：**按需检索**。只注入"怎么检索 + 写入纪律"（恒定几百
   *    字符），条目一律不进输入，需要时 `mem_search` 现取。成本与记忆库规模无关。
   *  - `'index'`：旧行为。把条目索引行常驻进 systemPrompt（最多 `indexTopN` 条）。
   *    适合记忆很少、或希望模型"随时看得见目录"的场景。
   *
   * 为什么默认改成 pointer：104 条记忆实测精简模式就要 641 token，全量展开上限
   * 8000 字符（约 4700 token），而且**每多记一条就多占一点**——把存货清单常驻进
   * 每轮输入，等于让记忆库越大、对话越贵。检索本来就该在"需要时"发生。
   *
   * `injectIndex: false` 仍然表示"一块都不注入"（pointer 也不注入）。
   */
  indexMode: 'pointer',
  /** pointer 模式每轮自动预取的核心记忆条数（0 = 关闭；默认 2，只取 global/user/当前项目 key）。 */
  pointerRecallTopN: 2,
  /** auto 模式：条目数不超过该值时走 index，超过则走 pointer（默认 40）。 */
  autoIndexMaxEntries: 40,
  /** 注入排序位（与 memory-evolve 的 snapshotOrder=500 相邻但不同名，互不覆盖）。 */
  indexOrder: 520,
  /** 硬预算：行数上限（Qoder 值 200，这里收紧到 120——常驻成本要更省）。 */
  indexMaxLines: 120,
  /** 硬预算：字符上限（Qoder 值 25KB，这里收紧到 8KB）。 */
  indexMaxChars: 8000,
  /** 注入条目数上限（按 重要性 × 新鲜度 排序取头部）。 */
  indexTopN: 40,
  /**
   * **注入排除表**：让本插件与 dsh-memory-evolve 分工，避免同一内容注入两遍。
   *
   * 元素写法：`"scope:track"`（如 `"global:memory"`、`"project:key"`）精确匹配，
   * 或只写 `"track"`（如 `"daily"`）匹配该轨的所有 scope。
   *
   * 为什么需要它：两个插件都会注入记忆。memory-evolve 注入的是
   * **global MEMORY.md + global USER.md + project KEY.md**，而它的「每轮写入提示」
   * 挂在**同一块快照**里（`injectMemory` 一关，提示一起没），所以不能靠关它的注入
   * 来省成本；反过来由本插件让出重叠轨才是对的。
   *
   * 推荐共存配置（本插件只注入 memory-evolve 不管的轨）：
   * `['global:memory', 'global:user', 'project:key']`
   * —— memory-evolve 负责"重要小集合"，本插件负责**每日日志与项目笔记**
   * （这两类它完全不注入，跨会话时无从得知近期进展）。
   *
   * 想彻底不注入（注入完全交给 memory-evolve，本插件只做检索/整合/审计/云判定），
   * 用 `injectIndex: false` 比把这里填满更直接。
   */
  injectExclude: [],
  /**
   * 懒加载注入（双段式，2026-10-30 用户拍板「方案 b」）：
   *
   * 会话初期只注入**核心段**——GLOBAL 槽位 + 当前项目的 key 条目（几百字符）；
   * 满足任一条件后展开**全量目录**：
   *  1. 本会话调用过任一 mem_* 工具（说明确实在用记忆）；
   *  2. 会话轮次达到 `lazyWakeTurns`（闲聊通常两三轮就结束）。
   *
   * 展开是一次性跳变（与「分槽重排只丢一次缓存」同款取舍）。
   * 条目总数 ≤ `lazyMinEntries` 时直接全量——本来就不贵，省一次跳变。
   * 手写测试 config（不经 resolveConfig）不含该键 → 保持旧行为。
   */
  lazyIndex: true,
  /** 核心段持续多少轮后展开全量目录（0 = 只靠工具调用唤醒）。 */
  lazyWakeTurns: 3,
  /** 条目总数不多于该值时不走懒加载。 */
  lazyMinEntries: 24,
  /** 核心段的注入条数上限。 */
  lazyTopN: 16,
  /**
   * 超预算时的策略：
   *  - `self-repair`（默认）：采纳 WorkBuddy 的做法——把「先压缩记忆」写成
   *    Agent 的前置必做任务，让记忆系统自我修复，而不是静默丢弃；
   *  - `silent-trim`：仅截断并附一行提示（Qoder 的做法，报告点名它是缺陷）。
   */
  overflowPolicy: 'self-repair',

  // ── 每轮写入交接（接管 memory-evolve 的"未写看门狗"职责）──────────────────
  /**
   * 注入一行「本轮还没写记忆」的交接提醒：接管存储之后，**"该记就记"这件事
   * 必须由本插件自己提醒**，不能指望旧实现在旁边继续喊（它的看门狗与它的
   * 快照注入绑在同一段里，注入一停提醒就一起没了）。
   *
   * 计数挂在 `runtime.noteTurn()` 上，逐 agent 维持；`mem_write` 成功后归零。
   * 提醒文本由**计数阈值**决定（不含"现在几点"），因此同一计数下渲染稳定，
   * 不会把 prompt 缓存前缀打掉。
   */
  writeReminder: false,
  /** 连续多少轮没写记忆才提醒（writeReminder=true 时生效）。 */
  writeReminderAfter: 5,
  /**
   * 说明性文案（窗口用）：写的是本插件的工具名，便于模型照着做。
   *
   * 2026-10-30 默认改为 false：无 confirm 的 user/memory/key 写入已改为
   * 进待巩固队列（见 writeQueueEnabled），"该记就记"不再需要看门狗催促；
   * 队列候选的巩固由 mem_consolidate 的晋升提议驱动（复述/被召回才转正）。
   * 想恢复旧行为：writeReminder: true。
   */
  writeReminderText: '记忆交接提醒：最近若干轮没有写入记忆。若本轮有实质进展：先补一条 daily 流水（track="daily"，免确认），稳定事实（用户画像/全局事实/项目结论）再写 user/memory/key，不带 confirm 会先进待巩固队列，被检索命中后自动转正进正轨。',
  /**
   * 写者让位声明：**只使用新插件的写入路径**。
   *
   * 为什么需要它：旧实现的 `memory` 工具无条件注册、关不掉（摘掉插件行会连坐
   * 它的记忆 Tab / dtodo / 同步）。于是"写入编排是否归新插件"里有一半是**约定**
   * 而不是代码能证明的——把它写成显式声明，`mem_audit` 的判定就不再靠猜。
   * 默认 false（未声明）；设 true = 你确认"只用 mem_* 写记忆"。
   */
  exclusiveWritePath: false,
  /**
   * 「别的写者是否写了记忆」的采样节流（毫秒，默认 2000）。
   * 设 0 = 每次渲染都检查（每次最多 60 个 stat；测试与写入很频繁的部署可用）。
   */
  externalWriteThrottleMs: 2_000,

  // ── 会话身份段 ──────────────────────────────────────────────────────────
  /**
   * 会话别名表（dsh-memory-evolve 的 `aliases.json`，`{ "<sessionId>": "别名" }`）。
   *
   * null → `<记忆目录>/aliases.json`，即**读对方那份**（用户手设的别名在那边，
   * 重写一份只会让"同一个别名叫出两个名字"）。
   * 注入的会话身份行与对方的 `snap.sessionPlain/Named` 逐字同款，所以读同一份
   * 别名表是保持契约的最省做法。
   */
  aliasesFile: null,

  // ── 陈旧性防幻觉（采纳 Qoder 的读时 mtime 提醒）──────────────────────────
  /** 条目日期超过该天数 → 注入时标 `(Nd)`。 */
  stalenessDays: 30,
  /** 超过该天数 → 标 `⚠Nd`，并在提示里要求「先核对现状再断言」。 */
  stalenessWarnDays: 90,

  // ── 检索（采纳 OfficeClaw 的 BM25 + 语义 + 混合，与文章里的 RRF）─────────
  /** 注册检索工具 `mem_search`。 */
  searchEnabled: true,
  searchDefaultLimit: 8,
  searchMaxLimit: 25,
  /** `auto`：有向量提供者才走混合，否则纯 BM25（不假装有语义检索）。 */
  searchMode: 'auto',
  /** RRF 融合常数（文章：RRF 按排名融合，无需归一化分数）。 */
  rrfK: 60,
  /** 取得多少条候选再排序（检索链路的成本闸门）。 */
  searchCandidates: 4,
  /** 单条结果返回的正文字符上限。 */
  searchSnippetChars: 360,
  /**
   * 分数门槛（采纳百炼 SearchMemory 的 `min_score`，2026-11-02 对照）。
   * **0 = 关闭**（默认）：本插件的 `finalScore` 依赖 RRF 绝对值，而 RRF 会随
   * 融合路数整体漂移，绝对值门槛不可移植——所以先观测、后定阈值。
   * 打开后按 `searchMinScoreMode` 解释这个数：
   *  - `percentile`（推荐）：0.75 表示"低于本批候选第 75 百分位的丢掉"；
   *  - `absolute`：低于这个分数丢掉（只有在你自己的机器上用真实分布标定过才用）。
   */
  searchMinScore: 0,
  searchMinScoreMode: 'percentile',
  /**
   * importance 里"时效性"的半衰期（天）。
   * 这一项曾经只在 retrieve.js 里被读取、DEFAULTS 里却没有——等于调了没反应
   * （技术文档 §12.9 已列为已知不一致）；0.4.5 补登记。
   */
  recencyHalfLifeDays: 45,
  /** 检索观测的默认观察窗口（天）与"低分"提示阈值（0 = 不提示）。 */
  queryLogWindowDays: 30,
  queryLogLowScore: 0,
  /**
   * 向量提供者。**默认关闭**——本机没有可用的嵌入服务，默认联网等于给
   * 每次检索加一笔不可见的成本与一次隐私外发。打开后走 OpenAI 兼容
   * `/embeddings`，且失败一律降级为纯 BM25。
   */
  embedding: {
    enabled: false,
    endpoint: '',
    model: '',
    apiKeyEnv: 'DSH_MEMORY_EMBEDDING_KEY',
    timeoutMs: 10_000,
    batchSize: 32,
    dim: 0,
  },

  // ── 写入门槛（采纳 OfficeClaw 的「写入门槛递增」）───────────────────────
  /** `mem_write` 只有在用户显式要求时才直写；其余场景用 suggest 进待确认队列。 */
  writeRequiresConfirmation: true,
  /**
   * 待巩固队列（2026-10-30 用户拍板）：user/memory/key **不带 confirm** 的写入
   * 不再直接拒绝，而是进待巩固队列 `QUEUE.md`（候选，不进常驻索引）。
   *
   * 这是「人类记忆」的模型——先随手记，复述/巩固才转长期：
   *  ① 用户明确说"记住"（confirm=true）→ 直写正轨，并自动移除队列里的同款候选；
   *  ② 同一事实在队列里再次出现（近重复）或被检索命中 → 走两条转正路径：
   *     - `mem_search` 召回过：当轮自动移进正轨（命中即确认，见
   *       queuePromoteOnRecall），不需要人确认；
   *     - 只满足"近重复"：仍由 mem_consolidate 提议，apply 确认后落刀。
   *
   * false = 旧行为（无 confirm 直接拒绝）。
   */
  writeQueueEnabled: true,
  /** 整合时提议晋升队列候选（判据：被检索命中过，或与另一条队列候选近重复）。 */
  queuePromoteEnabled: true,
  /**
   * 待巩固队列候选的超期归档天数（2026-11-06 用户拍板，默认 90）。
   *
   * 背景：QUEUE.md 之前**没有任何时效清理**——晋升只有"被检索命中 / 近重复"
   * 两条路，一条从不被召回的候选会无限期堆在队列里，队列越大、每次扫描和
   * 晋升的近重复比对就越慢。90 天是"保留时间长"与"效率"的折中：足够覆盖
   * 低频但重要的信息，又不会无限堆积。
   *
   * 命中该天数的候选在整合时产生 `queue-expire` 提议：默认**归档**（不是删除），
   * 移到 `QUEUE-archive.md`，仍可被 `mem_search(includeArchived=true)` 召回。
   * 0 = 关闭时效清理（回到旧行为，候选永不超期）。
   */
  queueStaleDays: 90,
  /**
   * 「命中即确认」（2026-11-03 用户拍板，默认开）：队列候选被 `mem_search`
   * 召回过一次就当轮自动移进正轨，不再等用户确认。
   *
   * 为什么改：真机跑通后模型转头问用户"要不要我把这条从队列晋升为正式记忆"——
   * 可它明明刚靠这条记忆答完问题。召回并使用**就是确认**，再问一句是把内部
   * 实现细节甩给用户。关掉它 = 回到"必须 mem_consolidate 人肉确认"的旧行为。
   */
  queuePromoteOnRecall: true,
  /** 队列候选被召回几次才自动转正（默认 2；1 = 旧行为，召回一次即确认）。 */
  queuePromoteMinHits: 2,
  /**
   * 注入页脚常驻的「写入纪律」（2026-11-02 实测后新增，默认开）。
   *
   * 为什么需要：S1 首轮 0.4.5 在真实 headless 会话里，模型对第一条种子陈述只回了
   * "记下了…要不要我记到项目记忆里"，**一次 mem_write 都没调**，于是后续 6 道
   * 回忆题里 2 道直接答"没有这条记录"。而后续那几步虽然调了工具，却因为不带
   * confirm 全部落进 QUEUE.md 候选（按设计不进常驻索引），等于"记了但用不上"。
   * 根因不是检索，是**没有告诉模型"陈述事实就该落盘、并且用户陈述的可以直接
   * confirm"**。writeReminder 是"连续 N 轮没写"的滞后提醒（默认 even 关闭），
   * 覆盖不到第一轮，所以这里补一条常驻纪律。
   *
   * 措辞刻意区分两类来源，避免模型把**自己推断**的内容也 confirm 进正轨
   * （那会绕过待巩固队列，等于把设计里唯一的"防污染"闸门关掉）。
   *
   * 0.4.9 判据重写（2026-11-03）：上面这条 0.4.6 的措辞在 Gatekeeper 场景实测仍零写入。
   * 复盘的结论是判据选错了维度——"用户明确陈述的可复用事实"要求模型先给用户的句子
   * 分类（是"陈述事实"还是"交代背景"），而它稳定地把后者归到"任务上下文"。
   * 改成**回答依赖**：让模型回看自己的答案，"哪些前提只有用户能给、会话结束就没了"，
   * 这是对自身输出的自检，不需要判断用户的句子属于哪一类，因此可机械执行。
   * 同时补了"记忆里搜不到 ≠ 没发生过"，堵住漏写之后转译成"信息不在这台机器上"的二次错误。
   */
  writeDiscipline: true,
  /**
   * 「先流水、后结论」两段式写入（2026-11-04 用户拍板，默认开）。
   *
   * 为什么加：v0.5.x 的写入纪律只说"落正轨"，而"正轨"在模型眼里就是 KEY/MEMORY
   * 这类结论轨——于是**流水轨被整条跳过**。真实账本（本机 11-03~11-04）：
   *
   * ```
   * extract → queue   ×8   （会话边界抽取，按设计只进 QUEUE.md）
   * add     → key     ×1   （直接写项目结论）
   * add     → daily   ×0   ← 一次都没有
   * ```
   *
   * 结果：根 `daily/` 从 10-29 起断档 7 天，根 `MEMORY.md` 从未建立。表现是
   * "结论都在、但'当时怎么想的、试过什么、排除了什么'全丢了"——事后没法复盘，
   * 也没法从流水里重新蒸馏出结论。
   *
   * 所以纪律改成**两段**：有实质进展的轮次先追加一条 daily 流水（免 confirm，
   * 直接追加到 `daily/<今天>.md`），有了结论再写 KEY/MEMORY/USER。
   * daily 与 project 两轨本来就免确认（`NEEDS_CONFIRM` 只含 user/memory/key），
   * 所以这一步没有任何"用户要不要同意"的摩擦，纯靠提示词就能落地。
   *
   * 关掉 = 回退到只讲"落正轨"的 v0.5.x 措辞（结论照写，流水随缘）。
   */
  dailyFirstWrite: true,
  /**
   * 会话边界抽取（0.5.0，默认开）。
   *
   * 解决的问题：0.4.6 ~ 0.4.9 三轮都在"劝模型当轮写"，S5 实测（DEFECTS.md D-003）
   * 只有 4/5 → 5/5，判定为**概率问题而非判据问题**。漏写的那一轮，模型会去讲业务知识，
   * 下一轮老实回答"记忆库是空的"。所以补一条与模型意愿无关的兜底：新会话开张时，
   * 插件把上一个会话的原文摘录端到模型面前，让它调用 mem_extract 把关键点写进
   * QUEUE.md 候选（不进常驻索引，被检索命中后自动转正）。
   *
   * 关掉 = 回到 0.4.9 行为（只有写入纪律，没有边界抽取）。
   */
  sessionExtract: true,
  /**
   * 会话被抽取前的最小静置时间。
   *
   * 为什么不设大（原来写 20s）：最主要的场景就是"刚关掉上一个会话、马上开新的"，
   * 这时候上一个会话的 mtime 只有几秒。设 20s 等于把主场景整个跳过去。
   * 取 3s 只是给末帧写入留一点落盘时间。代价是"另一个窗口里正在进行的会话"
   * 可能被提前抽一次——影响有界（只进队列、且该会话立刻被标记为已抽取，不会重复）。
   */
  sessionExtractMinAgeMs: 3_000,
  /**
   * 一个会话最多被"端到模型面前"几次。超过就放弃并记进 `abandoned`。
   * 为什么不是 1：模型第一次很可能不搭理（实测 S6 首轮就是），而"不搭理"正是要兜底的情形。
   * 为什么不是无限：一直端着一个旧会话会挤掉更新的会话，且模型反复拒绝说明它认为无可抽。
   */
  sessionExtractMaxOffers: 2,
  /**
   * 一次注入里最多端几段摘要（0.5.3，默认 2）。
   *
   * 为什么不是 1（真机修正）：`maxOffers` 本意是"端两次给两次机会"，但 0.5.2 的
   * digestCache 让同一会话内文本恒定 —— 第一次端出去之后，第二次机会永远轮不到。
   * 而第一次端出去的往往是"最近那个会话"，未必有归档价值：用户问完 gatekeeper（1 轮）
   * 转头改插件（30 轮），新会话就只会看到"改插件"那 30 轮，模型判它无关、不写，
   * 真正该进记忆的那段却排在后面。
   *
   * 一次端两段：让"无关"和"有关"同时在场，模型自己挑。总预算不变（见 sessionDigestMaxChars），
   * 只是把本该给出去的第二次机会合并到同一次里。
   */
  sessionExtractBlocks: 2,
  /**
   * "新鲜"窗口（毫秒）：这个时间内关掉的会话算新鲜，优先抽其中最新的一个。
   *
   * 为什么不是"永远最老优先"（0.5.2 真机修正）：7 天积压 27 个，用户当天刚说完的事实
   * 排在队尾，要开 20 多次新会话才轮得到 —— "不漏"变成了"用不上"。
   * 24 小时覆盖"今天说过的话"，也覆盖"隔夜回来接着问"。
   */
  sessionExtractRecentMs: 24 * 60 * 60 * 1000,
  /** 回溯期限（天）：超过这个时长的历史会话不再抽取（首次安装可能有几十个旧会话）。 */
  sessionExtractHorizonDays: 7,
  /** 抽取候选与正轨条目的去重阈值（实测校准见 tools.js 的 mem_extract 注释）。 */
  extractDedupeThreshold: 0.55,
  /** 摘要块的总字符预算（只花在新会话首轮）。 */
  sessionDigestMaxChars: 2600,
  /** 最多回看多少轮用户消息（越早的轮次信息密度越低）。 */
  sessionDigestMaxTurns: 12,
  /**
   * 空记忆库时注入一行"先写后答"（默认开）。
   * 关掉 = 回到旧行为（空库时一行都不注入，模型不知道有记忆工具）。
   */
  emptyIndexHint: true,
  /** 允许写全局 user 轨（用户档案）。 */
  allowUserScopeWrite: true,
  /**
   * 采纳 Qoder 的 pinned type 强制：`type: user` 的条目禁写进项目目录、
   * 项目条目禁写进全局目录——写错 scope 直接拒绝，而不是靠模型自觉。
   */
  pinnedTypeEnforcement: true,
  /** 写入前备份原文件（可回滚）。 */
  backupBeforeWrite: true,
  /**
   * 改前备份的保留天数：`mem_reindex` / 整合后会清理 `backups/<更早整天>/`。
   * 0 = 不按天清理（只受按文件保留数约束）。默认 60 天——备份是审计物，
   * 太长会无限增长，太短又失去"事后回滚"的价值，60 天是个折中。
   */
  backupRetentionDays: 60,
  /**
   * 同一份原始文件的改前备份最多保留几份（按天去重后，跨天再封顶）。
   * 0 = 不按文件清理。默认 5 份。
   */
  backupKeepPerFile: 5,
  /**
   * **与 dsh-memory-evolve 的锁互操作**（默认开）。
   *
   * 事实（源码取证）：对方所有主轨写入都在 `<记忆目录>/.memory.lock` 里进行
   * （5s 超时 / 10s 陈旧），而本插件的写原语用自己的 `.<文件名>.lock`。两把
   * 锁互不认识 → 只要对方还有写入路径（它的 memory 工具、它的记忆 Tab 上
   * 的编辑按钮），双方就可能"各自的锁内重读+整体重写"而互相覆盖丢条目。
   *
   * 打开后本插件在写记忆文件时**额外**去抢对方的目录锁（尽力而为、短超时、
   * 绝不删别人的锁文件），于是两边对同一份文件互相串行化。
   * 注意方向性：这只保护"本插件写、对方也写"的竞态；对方写时不会来抢我们的锁。
   */
  legacyLockCompat: true,
  /** 抢对方目录锁的等待上限（比本插件自己的锁短：拿不到就如实失败）。 */
  legacyLockTimeoutMs: 1_500,
  /**
   * 本插件自己的文件锁等待上限（毫秒）。
   * 0 → 用代码里的默认值（memfile.js 的 `WRITE_LOCK_TIMEOUT_MS`，4 秒）。
   * 调小它的用途：锁被占住时快速失败（测试、或想让写入失败得干脆的部署）。
   */
  writeLockTimeoutMs: 0,

  // ── 整合 / 遗忘（Qoder 的 dream + WorkBuddy 的 30 天蒸馏 + 文章的遗忘链）──
  consolidateEnabled: true,
  /** 每日日志超过该天数 → 提议蒸馏进长期记忆（WorkBuddy 值 30）。 */
  dailyRetentionDays: 30,
  /** 近重复判定的 token Jaccard 阈值。 */
  duplicateThreshold: 0.82,
  /** 超过该天数且从未被检索命中的条目 → 提议归档（不是删除）。 */
  staleArchiveDays: 180,
  /** dream 触发下限：距上次整合不足该小时数 → 不触发（Qoder 值 24）。 */
  consolidateMinHours: 24,
  /** dream 触发下限：新增条目不足该数 → 不触发（Qoder 值 5 session，这里按条目计）。 */
  consolidateMinSessions: 5,
  /** 扫描节流（毫秒）。 */
  scanThrottleMs: 10_000,
  /** 应用整合方案必须显式 confirm。 */
  consolidateApplyRequiresConfirm: true,

  // ── 取代（L2）：把「修正」而不是「删除」做成常态 ─────────────────────────
  /**
   * 整合时**检测同主题矛盾并提议取代**（2026-10-26 用户拍板：默认开）。
   *
   * 注意语义边界：这里的"提议"是真的只提议——矛盾组只出现在方案的
   * `contradictions` 里，`applyPlan` **不会**执行它们；要让它们落地必须
   * 在 apply 时额外显式传 `supersede: true`。原因是"记忆的修正"比
   * "记忆的收集"更需要人定夺（见设计文档 §6.8 / §9.1）。
   */
  supersedeEnabled: true,
  /**
   * 整合时提议 GLOBAL 槽位更新（2026-10-30 用户拍板「global 触发 a」）：
   * 近 `globalSlotScanDays` 天的 user/memory 条目若提到某个现有槽位的名字、
   * 且其摘要比槽值新 → 方案里出现 global-slot 提议（set 该槽）。
   * apply 确认后生效——槽位是"用户画像"，改它必须经人确认的方案。
   */
  globalSlotProposals: true,
  /** 槽位建议的扫描窗口（天）。 */
  globalSlotScanDays: 30,
  /**
   * 「同主题」判定阈值（比近重复阈值宽：这里要的是同一话题，不是同一句话）。
   * 用 max(Jaccard, 包含度)，与去重同一口径，只换阈值。
   */
  contradictionTopicThreshold: 0.55,
  /** 单次方案里最多给出多少条取代提议（防止噪声淹没方案）。 */
  contradictionMaxProposals: 20,

  // ── 可疑记忆：静默标记 + 延迟裁决（2026-10-27 与用户讨论后拍板）────────────
  /**
   * 总开关。关闭后：不再打标记、不再在注入里提示可疑——但已有的 `suspect.json`
   * 不会被删除（重新打开即恢复），因为它是观测数据而不是配置。
   */
  suspectEnabled: true,
  /**
   * 可疑条目在常驻索引里的处置：
   *  - `flag`（默认）：照常进索引，但带 `⚠?` 与理由——**模型看得见**，否则标记就是装饰；
   *  - `hide`：不进常驻索引（省预算），但仍可被 mem_search 召回并带警示；
   *  - `off`：与常驻索引无关（等同不标记，仅保留体检里的可见性）。
   */
  suspectInIndex: 'flag',
  /** 「碎片」判据：规范化正文短于该长度即视为碎片（误触发的典型形态）。 */
  suspectMinChars: 12,
  /**
   * **保护性关键词**：命中的条目不参与"按命中率下沉/归档"，也永不被标为可疑。
   *
   * 理由：一辈子只说一次却至关重要的信息（过敏、禁忌、不可逆代价、合规红线），
   * 若按"没人再提就忽略"处理是灾难。这是"重要性先验"对"频率"的兜底。
   */
  protectedKeywords: [
    '过敏', '禁忌', '不可逆', '合规', '红线', '法务', '凭证', '密钥', '密码', 'token',
    'allergy', 'contraindicated', 'irreversible', 'compliance', 'credential', 'secret',
  ],

  // ── 索引分槽：让注入文本在两次渲染之间保持位置稳定（2026-10-28）─────────────
  /**
   * 分槽（stable slots）。开启后：条目一旦进入常驻索引，**位置固定**；
   * 新条目只追加到末尾；超容量从尾部淘汰。
   *
   * 为什么：注入块在系统提示里，它一变，后面的整段对话历史都无法命中 prefix
   * 缓存（实测：写 1 条新记忆 → 注入文本几乎整块错位）。分槽把"每轮失效"
   * 变成"每 N 小时失效一次"。代价：新条目要等尾部腾位，不能立刻挤掉中间
   * 的弱条目（没进索引的仍可用 mem_search 召回，且重排周期会给它机会）。
   */
  indexStableSlots: true,
  /**
   * 每隔多少小时允许一次**全量重排**（排名决定顺序）。
   * 重排会丢一次 prefix 缓存，之后重新稳定。设为 0 = 只在首次或显式失效时重排。
   */
  indexResortEveryHours: 6,

  // ── 分层压缩：按月打包 + 月摘要（v0.3.3）─────────────────────────────────
  /**
   * 开启后：超过 `dailyHotDays` 的**整月**每日日志会被打包进
   * `daily/archive/YYYY-MM.md`（归档轨，不进常驻索引，仍可检索），
   * 同时在 `DIGEST.md` 里留一条月摘要（要点 + 指针）。
   * 原文不删、指针可回溯——这是"分层"，不是"压缩丢内容"。
   *
   * 打开时会**自动跳过旧的"每日日志蒸馏"**（两者都处理超期 daily，会重复）。
   */
  monthlyPackEnabled: true,
  /** 热区保留多少天：比它更老的**整月**才可打包（半月打包会让指针与幂等变复杂）。 */
  dailyHotDays: 30,
  /** 一个月至少多少条才值得单独成包（太少就留在热区）。 */
  monthlyPackMinEntries: 3,
  /** 月摘要最多列多少条要点（它进常驻索引，必须短）。 */
  monthlyDigestMaxBullets: 24,

  // ── 管理界面（v0.3.5）──────────────────────────────────────────────────
  /**
   * 注册 `/api/memory-core/*`（给设置页里的「记忆管理」面板用）。
   * 关掉它不影响记忆与工具，只是没有界面；宿主没有 webServer 服务时也会自动跳过。
   */
  uiEnabled: true,

  // ── 审计（采纳 CodeArts 的 append-only + 稀疏索引）──────────────────────
  ledgerEnabled: true,
  /** 账本超过该字节数则轮转（保留 .1 备份）。 */
  ledgerMaxBytes: 2_000_000,

  // ── 云端分层（采纳 WorkBuddy 的脱敏 + 文章里的合规要求）──────────────────
  /**
   * v0.1 **只做分类与脱敏，不发起任何网络请求**。云端真正落地的方式
   * （Git 记忆仓库 / Dify 知识库 / 自建服务）是待讨论项，见设计文档第 6 章。
   */
  cloudEnabled: false,
  /** 按轨覆盖分层结论，如 `{ daily: 'local-only' }`。 */
  cloudTierOverrides: {},
  /** 上云前把绝对路径替换为 `[path omitted]`。 */
  cloudRedactPaths: true,
}

const BOOLEAN_KEYS = new Set([
  'standaloneStore', 'precreateFiles', 'injectIndex', 'searchEnabled', 'writeRequiresConfirmation',
  'allowUserScopeWrite', 'pinnedTypeEnforcement', 'backupBeforeWrite',
  'consolidateEnabled', 'consolidateApplyRequiresConfirm', 'ledgerEnabled',
  'cloudEnabled', 'cloudRedactPaths', 'supersedeEnabled',
  'writeReminder', 'legacyLockCompat', 'exclusiveWritePath', 'suspectEnabled', 'monthlyPackEnabled', 'uiEnabled',
  'lazyIndex', 'writeQueueEnabled', 'queuePromoteEnabled', 'globalSlotProposals',
  'dailyFirstWrite',
])

const NUMBER_BOUNDS = {
  scanMaxFiles: [1, 200_000],
  scanMaxDepth: [0, 20],
  indexOrder: [-100_000, 100_000],
  indexMaxLines: [5, 1000],
  indexMaxChars: [500, 200_000],
  indexTopN: [1, 500],
  pointerRecallTopN: [0, 20],
  autoIndexMaxEntries: [1, 100000],
  queuePromoteMinHits: [1, 20],
  stalenessDays: [1, 3650],
  stalenessWarnDays: [1, 3650],
  searchDefaultLimit: [1, 100],
  searchMaxLimit: [1, 200],
  rrfK: [1, 1000],
  searchCandidates: [1, 20],
  searchSnippetChars: [40, 20_000],
  searchMinScore: [0, 1],
  recencyHalfLifeDays: [1, 3650],
  queryLogWindowDays: [1, 3650],
  queryLogLowScore: [0, 1],
  dailyRetentionDays: [1, 3650],
  duplicateThreshold: [0.5, 0.99],
  contradictionTopicThreshold: [0.3, 0.99],
  contradictionMaxProposals: [1, 200],
  staleArchiveDays: [7, 3650],
  queueStaleDays: [0, 3650],
  consolidateMinHours: [0, 8760],
  consolidateMinSessions: [0, 10_000],
  scanThrottleMs: [0, 3_600_000],
  ledgerMaxBytes: [10_000, 1_000_000_000],
  writeReminderAfter: [1, 1000],
  externalWriteThrottleMs: [0, 600_000],
  suspectMinChars: [1, 500],
  dailyHotDays: [1, 3650],
  monthlyPackMinEntries: [1, 500],
  monthlyDigestMaxBullets: [1, 200],
  legacyLockTimeoutMs: [0, 60_000],
  writeLockTimeoutMs: [0, 60_000],
  backupRetentionDays: [0, 3650],
  backupKeepPerFile: [0, 1000],
  lazyWakeTurns: [0, 1000],
  lazyMinEntries: [0, 100_000],
  lazyTopN: [1, 500],
  globalSlotScanDays: [1, 3650],
}

const ENUMS = {
  overflowPolicy: ['self-repair', 'silent-trim'],
  searchMode: ['auto', 'bm25', 'hybrid'],
  searchMinScoreMode: ['percentile', 'absolute'],
  indexMode: ['pointer', 'index', 'auto'],
  suspectInIndex: ['flag', 'hide', 'off'],
}

function clampNumber(value, fallback, [min, max]) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizePathish(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  return expandHome(value.trim())
}

/**
 * 把原始（来自 profile patch / 运行时面板的）配置解析成完整配置。
 * 未知键原样保留（向前兼容），已知键做类型归一、枚举校验与边界钳制。
 *
 * @param {object} [raw] - 原始配置。
 * @returns {object} 解析后的配置。
 */
export function resolveConfig(raw = {}) {
  const out = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return finish(out)

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) { out[key] = value; continue }
    if (key === 'embedding') {
      out.embedding = { ...DEFAULTS.embedding }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (!(k in out.embedding)) continue
          if (k === 'enabled') out.embedding.enabled = v === true
          else if (k === 'timeoutMs' || k === 'batchSize' || k === 'dim') out.embedding[k] = clampNumber(v, out.embedding[k], [0, 10_000_000])
          else out.embedding[k] = typeof v === 'string' ? v : out.embedding[k]
        }
      }
      continue
    }
    if (BOOLEAN_KEYS.has(key)) { out[key] = value === true; continue }
    if (key in NUMBER_BOUNDS) { out[key] = clampNumber(value, DEFAULTS[key], NUMBER_BOUNDS[key]); continue }
    if (key in ENUMS) { out[key] = ENUMS[key].includes(value) ? value : DEFAULTS[key]; continue }
    if (key === 'dshHome' || key === 'memoryDir' || key === 'coreDir' || key === 'aliasesFile') { out[key] = normalizePathish(value); continue }
    if (key === 'cloudTierOverrides') {
      out[key] = (value && typeof value === 'object' && !Array.isArray(value)) ? { ...value } : {}
      continue
    }
    if (key === 'injectExclude') {
      // 只接受字符串数组；非字符串元素丢弃（配置写错不该让加载失败）
      out[key] = Array.isArray(value)
        ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : []
      continue
    }
    if (key === 'protectedKeywords') {
      // 同上：只收非空字符串；空数组是**合法**值（等于关掉保护），所以不回落默认值
      out[key] = Array.isArray(value)
        ? value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : [...DEFAULTS.protectedKeywords]
      continue
    }
    out[key] = value
  }
  return finish(out)
}

function finish(config) {
  // 边界自洽：警告阈值不能低于提示阈值
  if (config.stalenessWarnDays < config.stalenessDays) config.stalenessWarnDays = config.stalenessDays
  if (config.searchMaxLimit < config.searchDefaultLimit) config.searchMaxLimit = config.searchDefaultLimit
  return config
}