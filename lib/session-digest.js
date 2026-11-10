/**
 * lib/session-digest.js — 会话边界抽取（0.5.0）。
 *
 * ## 为什么需要这一层
 *
 * 0.4.6 ~ 0.4.9 三轮都在做同一件事：**劝模型在当轮写记忆**。S5 实测（DEFECTS.md D-003）
 * 的结果是：判据写得再准，也只是把单轮写入概率从 ~80% 抬到 ~100%，n=5 内无显著差异；
 * 而漏写的那一轮，模型会转而去讲业务知识，下一轮老实回答"记忆库是空的"。
 * 结论：靠"模型自觉"是概率，长会话里必然漏，必须有一个**与模型意愿无关**的兜底。
 *
 * ## 兜底为什么放在"会话边界"
 *
 * 会话内本来就有上下文，当轮不落盘不会立刻损失什么；真正损失发生在**会话关掉那一刻**
 * ——上下文没了，而记忆里什么都没有。所以抽取的最佳时机不是每轮，而是"新会话开张时，
 * 回头看一眼上个会话还剩什么"。频率从"每轮"降到"每会话一次"，输入还能一次看全整段对话。
 *
 * ## 为什么不让插件自己抽（不内置 LLM 调用）
 *
 * 纯规则抽取的实测精度是 31%（D-002：`不用给排查步骤` 被抽成 `排斥=给排查步骤`）。
 * 这类"误报"不是错的事实，而是**根本不是事实**，进了队列也只能人工逐条辨认，
 * 等于把"AI 记不住"换成"人每天清队列"。而本插件拿不到 llm 服务（inject 只有
 * systemPrompt / tools），自己发请求就要密钥与计费链路。所以第一版把这件事
 * **交回给正在这个会话里、且已经读完原文的模型**：插件负责"把原文端到它面前 + 落盘"，
 * 模型负责语义。代价是它可能不照做——所以有 offered 计数可观测。
 *
 * ## 写入落点：只进 QUEUE.md，永不进正轨
 *
 * 抽取结果一律走待巩固队列（[queue:track=.. scope=.. id=..] 头标签，队列不进常驻索引），
 * 由 mem_consolidate 提议晋升、用户确认后才进正轨。这是把"审查机制"放在
 * 抽取之后、正轨之前：精度不够时污染的是队列，不是记忆本体。
 *
 * @module vanwork-memory-core/lib/session-digest
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { readJson, writeFileAtomic, ensureDir } from './fsutil.js'
import { resolveDshHome } from './paths.js'

/** zstd 帧魔数（会话文件是**多帧**追加写的，整份解压只出第一帧）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 抽取状态文件名（放在 memory-core 里，可随时删除重建）。 */
export const STATE_FILE_NAME = 'session-extract.json'

function isFrameAt(buf, i) {
  return buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
    && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]
}

/**
 * 解压多帧 zstd。Node 22.15+ 才有 zstdDecompressSync；更老的版本直接返回 null，
 * 由调用方降级（抽取是增强能力，不能因为它把记忆注入整个打挂）。
 */
export function decompressFrames(buf) {
  const fn = typeof zstdDecompressSync === 'function' ? zstdDecompressSync : null
  if (fn === null) return null
  const starts = []
  for (let i = 0; i + 3 < buf.length; i++) if (isFrameAt(buf, i)) starts.push(i)
  if (starts.length === 0) return null
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out.push(fn(buf.subarray(starts[k], end)).toString('utf8')) } catch { /* 末帧可能还在写 */ }
  }
  return out.join('')
}

/** 只找前两个帧起点（第一帧装会话头，读头不必解整份）。 */
function frameStarts(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length && starts.length < 2; i++) {
    if (isFrameAt(buf, i)) starts.push(i)
  }
  return starts
}

/**
 * 列出所有会话文件（按 mtime 倒序）。
 *
 * 布局：sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd（挂在 dshHome 下）。
 * 只读 session.v4.*：v3 及更早的格式事件字段不同，解析出来会是错的而不是空的。
 */
export function listSessionFiles(dshHome) {
  const root = join(resolveDshHome(dshHome), 'sessions')
  if (!existsSync(root)) return []
  const files = []
  let slugs = []
  try { slugs = readdirSync(root) } catch { return [] }
  for (const slug of slugs) {
    const dir = join(root, slug)
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      // 不能按目录名前缀过滤（0.5.0 真机实测补）：真实环境里同时存在两种命名
      //   sessions/<slug>/session-<uuid>/session.v4.jsonl.zstd   ← 新会话
      //   sessions/<slug>/<uuid>/session.v4.jsonl.zstd           ← 旧会话（18/45 个）
      // 原来 `startsWith('session-')` 直接把旧的那批漏掉，75 个会话只看得到 52 个。
      // 改为「目录里有没有 v4 归档」为准——文件名本身就是最可靠的判据。
      const file = join(dir, name, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        files.push({ file, sessionId: name, mtimeMs: st.mtimeMs, size: st.size })
      } catch { /* 该会话没有 v4 归档 */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files
}

/** 解析一段 jsonl 文本为事件数组（坏行跳过，不抛）。 */
export function parseEvents(text) {
  const out = []
  for (const line of String(text === null || text === undefined ? '' : text).split('\n')) {
    const s = line.trim()
    if (s === '' || s[0] !== '{') continue
    try { out.push(JSON.parse(s)) } catch { /* 忽略半行 */ }
  }
  return out
}

/**
 * 只读会话头（第一帧就够）：id / cwd / createdAt。
 *
 * 为什么单独做：抽错会话的代价是**跨项目串味**。会话目录按 cwd 分组，
 * 在项目 B 开新会话时若不过滤，端出来的可能是项目 A 的对话，抽出来的候选
 * 会被打上 B 的项目 id，变成"内容属于 A、归属属于 B"的记忆。
 */
export function readSessionMeta(file) {
  let buf
  try { buf = readFileSync(file) } catch { return null }
  const starts = frameStarts(buf)
  if (starts.length === 0) return null
  const end = starts.length > 1 ? starts[1] : buf.length
  let text = null
  try { text = zstdDecompressSync(buf.subarray(starts[0], end)).toString('utf8') } catch {
    text = decompressFrames(buf)
  }
  if (text === null) return null
  for (const e of parseEvents(text)) {
    if (e && e.type === 'session') {
      return {
        id: typeof e.id === 'string' ? e.id : null,
        cwd: typeof e.cwd === 'string' ? e.cwd : null,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : null,
      }
    }
  }
  return null
}

/** cwd 归一化比较（Windows 不分大小写，尾部分隔符不算差异）。 */
function sameCwd(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const norm = (p) => p.split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 会话 id 的规范化比较。
 *
 * 真实环境的会话目录有两代命名（`session-<uuid>` 与裸 `<uuid>`），
 * 而运行时 `agent.session.id` 一律是带前缀的形态。比较前统一去掉前缀，
 * 否则旧格式目录永远匹配不上"当前会话"，会出现「新会话把自己端给自己抽」。
 */
function sameSessionId(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  return sessionKey(a) === sessionKey(b)
}

/**
 * 会话在状态文件里的键。
 *
 * 为什么必须统一（真机实测补）：`pickPendingSession` 拿到的 id 是**目录名**，
 * 而 `mem_extract` 收到的 id 是**注入块里的事件 id**（带 `session-` 前缀）。
 * 两者在旧格式目录上不一致，结果同一个会话会同时存在 `abc` 和 `session-abc`
 * 两个键 —— 抽取完了下次还认不出来，同一段对话能被反复抽取。
 */
export function sessionKey(id) {
  if (typeof id !== 'string') return ''
  return (id.startsWith('session-') ? id.slice('session-'.length) : id).toLowerCase()
}

/** 从 message 事件里取纯文本（content 是块数组，只取 type=text）。 */
function textOf(message) {
  const content = message ? message.content : null
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 压平空白并截断（抽取输入不需要排版，只需要信息）。 */
function clip(text, max) {
  const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max) + '\u2026'
}

/**
 * 从事件流里取出"值得抽取"的对话内容。
 *
 * 只认 source.kind 为 user 的用户消息：同一个事件类型里还混着
 * agent-instructions / runtime-context / skill-catalog / time-context / tool-jobs
 * 五类系统注入（实测 8 个会话里 user 只有 9 条，其余 48 条都是这些）。
 * 不过滤的话，抽出来的候选会全是系统提示词碎片。
 */
export function extractTurns(events, { maxTurns = 12, perTurnChars = 320, assistantChars = 600 } = {}) {
  const userTurns = []
  let assistantTail = ''
  let sessionId = null
  let createdAt = null
  for (const e of events) {
    if (!e || typeof e.type !== 'string') continue
    if (e.type === 'session') {
      sessionId = typeof e.id === 'string' ? e.id : sessionId
      createdAt = typeof e.createdAt === 'number' ? e.createdAt : createdAt
      continue
    }
    if (e.type === 'user/message') {
      const kind = e.data && e.data.source ? e.data.source.kind : null
      if (kind !== 'user') continue
      const text = clip(textOf(e.data), perTurnChars)
      if (text !== '') userTurns.push(text)
      continue
    }
    if (e.type === 'assistant/message') {
      const text = clip(textOf(e.data), assistantChars)
      if (text !== '') assistantTail = text
    }
  }
  return {
    sessionId,
    createdAt,
    userTurns: userTurns.slice(-maxTurns),
    userTurnCount: userTurns.length,
    assistantTail,
  }
}

/** 读一个会话文件并抽出对话（失败返回 null，调用方跳过）。 */
export function readSessionDigest(file, opts = {}) {
  let buf
  try { buf = readFileSync(file) } catch { return null }
  const text = decompressFrames(buf)
  if (text === null) return null
  const events = parseEvents(text)
  if (events.length === 0) return null
  const turns = extractTurns(events, opts)
  if (turns.userTurns.length === 0) return null
  return turns
}

/** 读状态（缺失/损坏都返回空壳，绝不因为状态文件坏了就中断注入）。 */
export function loadState(stateFile) {
  const raw = readJson(stateFile, null)
  if (!raw || typeof raw !== 'object') return { version: 1, extracted: {}, offered: {}, abandoned: {}, unreadable: {} }
  return {
    version: 1,
    extracted: raw.extracted && typeof raw.extracted === 'object' ? raw.extracted : {},
    offered: raw.offered && typeof raw.offered === 'object' ? raw.offered : {},
    abandoned: raw.abandoned && typeof raw.abandoned === 'object' ? raw.abandoned : {},
    // 解不出用户发言的会话：记一次就够了，别每次开新会话都重新解压一遍大文件
    unreadable: raw.unreadable && typeof raw.unreadable === 'object' ? raw.unreadable : {},
  }
}

/** 写状态（原子写，失败静默——状态丢了最多重抽一次）。 */
export function saveState(stateFile, state) {
  try {
    ensureDir(stateFile.replace(/[\\/][^\\/]+$/, ''))
    writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + '\n')
    return true
  } catch { return false }
}

/**
 * 挑出"最该被抽取"的上一个会话。
 *
 * 规则：mtime 在 minAgeMs 之前（当前会话还在写，不能抽自己）、不是当前会话、
 * 不在 extracted 里、没超出回溯期限、cwd 一致、且还没被放弃（offered 未达上限）。
 *
 * ## 挑选策略：新鲜的先抽，旧的清账（2026-11-03 真机第三版）
 *
 * 这条规则被实测推翻过两次，两次的失败方向正好相反：
 *
 * 1. 最初取「mtime 最新的未抽取会话」。S6 暴露它不收敛：模型在第 2 轮没搭理，
 *    第 3 轮"最近的未抽取"就变成了第 2 轮那个闲聊会话，第 1 轮的真实内容永远沉底。
 * 2. 于是改成「永远最老优先」。真机又推到另一个极端：7 天积压 27 个，
 *    用户刚说完的 gatekeeper 事实排在队尾，要开 20 多次新会话才轮得到 ——
 *    "不漏"变成了"用不上"，等于机制没有。
 *
 * 现在的规则分两层：
 * - **先看 `recentMs`（默认 24 小时）内关掉的会话**，有就抽其中**最新**的那个。
 *   用户刚说完、刚关窗口，下一次开会话就该被记住 —— 这是最符合直觉的场景，
 *   也是这套机制唯一有希望被用户感知到的场景。
 * - 24 小时内没有新会话，才按 mtime **升序清旧账**，保证没有哪一段永远轮不到。
 *
 * 为什么不干脆"最新优先到底"：那样漏写的旧会话会永远沉底（第 1 版就是死在这里）。
 * 两层结构把"当下有用"和"历史不漏"分开，各自都能收敛。
 *
 * @returns {{session: object|null, reason: string, abandoned: string[], unreadable: string[], backlog: number}}
 */
export function pickPendingSession({
  dshHome, currentSessionId, state, cwd = null, minAgeMs = 3000, maxOffers = 2,
  horizonDays = 7, maxInspect = 10, recentMs = 24 * 60 * 60 * 1000, now = Date.now(),
  validate = true, digestOpts = {}, exclude = null,
}) {
  const files = listSessionFiles(dshHome)
  if (files.length === 0) return { session: null, reason: 'no-sessions', abandoned: [], unreadable: [], backlog: 0 }
  const horizonMs = Math.max(1, horizonDays) * 24 * 60 * 60 * 1000
  const abandoned = []
  const unreadable = []
  // 第一遍只做「不读文件」的过滤，攒出候选池。真机 75 个会话里通常只剩两三个，
  // 这一遍不打任何磁盘 I/O（读会话头/解压都留到真正要端的时候）。
  const candidates = []
  for (const f of files) {
    // 状态键统一走 sessionKey：目录名可能是裸 uuid，也可能是 `session-<uuid>`，
    // 而抽取回执用的是事件 id（带前缀）。不归一会让同一会话存成两个键、被反复抽。
    const key = sessionKey(f.sessionId)
    // 调用方已经选过的会话（一次端多段时用）：跳过，别把同一段端两遍。
    if (exclude && exclude.has(key)) continue
    // 同一性用规范化后的 id 比：目录名有两种形态（`session-<uuid>` / `<uuid>`），
    // 而运行时给的 `agent.session.id` 是 `session-<uuid>`。直接字符串比会让
    // 「跳过自己」在旧格式目录上失效 —— 新会话首轮就可能把自己半截对话当成历史端出来。
    if (currentSessionId && sameSessionId(f.sessionId, currentSessionId)) continue
    if (now - f.mtimeMs < minAgeMs) continue
    // 超出回溯期限的静默跳过，**不记 abandoned**：
    // 这个字段的语义是"端到模型面前却没被抽"，用来回答"为什么这段对话没进记忆"。
    // 而 horizon 外的会话从来没被端过，记进去只会让状态文件堆满几十条噪声
    // （真机首次干跑：75 个会话里 50 个在 7 天外，全记上就没法看了）。
    if (now - f.mtimeMs > horizonMs) continue
    if (state && state.extracted && state.extracted[key]) continue
    if (state && state.unreadable && state.unreadable[key]) continue
    const offers = (state && state.offered && state.offered[key]) || 0
    if (offers >= maxOffers) { abandoned.push(key); continue }
    candidates.push(f)
  }
  const backlog = candidates.length
  // files 本身是 mtime 降序（新→旧）。candidates 沿用这个顺序。
  // 新鲜的排前面（最新优先），其余按旧→新清账跟在后面。
  // 为什么不是只试新鲜的：那一批可能读不出内容（空会话/坏帧），
  // 只试一个就放弃会让整次抽取空转 —— 真机测试里正是这么挂的。
  const fresh = candidates.filter((f) => now - f.mtimeMs <= recentMs)
  const stale = candidates.filter((f) => now - f.mtimeMs > recentMs).reverse()
  const ordered = fresh.length > 0 ? [...fresh, ...stale] : stale
  let inspected = 0
  for (const f of ordered) {
    const key = sessionKey(f.sessionId)
    // 跨项目过滤：会话头里的 cwd 必须一致。头读不出来时放行——
    // 宁可偶尔串一次，也不要因为解析失败把兜底整个关掉。
    if (cwd && inspected < maxInspect) {
      inspected += 1
      const meta = readSessionMeta(f.file)
      if (meta && meta.cwd && !sameCwd(meta.cwd, cwd)) continue
    }
    // 可抽性校验（真机实测补）：真实环境里有解不出任何用户发言的会话（空会话、
    // 只有系统注入、坏帧）。不做这一步的话，它会**卡在队首永远被挑中**——
    // 因为 readSessionDigest 失败时不消耗 offered，下一次挑选还是它，后面的正常会话
    // 一辈子轮不到。所以校验失败要记进 unreadable 并继续往下走。
    let digest = null
    if (validate) {
      digest = readSessionDigest(f.file, digestOpts)
      if (!digest) { unreadable.push(key); continue }
    }
    return { session: f, digest, reason: 'ok', abandoned, unreadable, backlog }
  }
  return {
    session: null,
    reason: abandoned.length > 0 || unreadable.length > 0 ? 'all-abandoned' : 'nothing-pending',
    abandoned,
    unreadable,
    backlog,
  }
}

/**
 * 摘要块里的时间戳：优先"最后活动时间"，退化到创建时间。
 *
 * 为什么不用 createdAt（真机修正）：会话可以创建很久以后继续用。实测 2cd07288
 * 创建于 10-16、11-03 才真正对话，按 createdAt 渲染会写成"10-16 的对话"，
 * 模型一看就觉得是陈年旧事、参考价值低。
 */
function formatDigestTime(digest) {
  const at = digest?.at || digest?.createdAt
  if (!at) return 'unknown'
  // 用本地时区渲染（0.5.3 真机修正）：原来走 toISOString() 是 UTC，15:06 的对话
  // 被写成 "07:06"，模型一看"今早七点"就跟用户说的"今早"错开了 8 小时——
  // 判断"这是不是今天的会话"时会失真。sv-SE 的格式恰好是 `YYYY-MM-DD HH:mm`。
  try {
    // sv-SE 给的是 `YYYY-MM-DD HH:mm:ss`，截到分钟即可（秒只会让块变长）
    return new Date(at).toLocaleString('sv-SE').slice(0, 16)
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * 渲染注入块。刻意把"抽取规则"和"落点"都写在里面：
 * 模型拿到的是一次性任务，不能指望它还去翻工具说明。
 */
export function renderDigestBlock(digest, { maxChars = 2600 } = {}) {
  // 用**最后活动时间**而不是 createdAt（真机修正）：会话可以创建很久以后继续用。
  // 实测 2cd07288 创建于 10-16、今天 11-03 才真正对话，按 createdAt 渲染会写成
  // "10-16 的对话"，模型一看就觉得是陈年旧事、参考价值低。
  const when = formatDigestTime(digest)
  const sid = digest.sessionId
  const head = 'mem_extract(sessionId="' + sid + '", candidates=[{text:"一句话", track:"key", scope:"project"}])'
  const empty = 'mem_extract(sessionId="' + sid + '", candidates=[])'
  const lines = []
  lines.push('<session_digest source="上一会话 ' + sid + '" turns="' + digest.userTurnCount + '" time="' + when + '">')
  // 措辞用命令式 + 明确先后顺序（真机修正）：原来写成「上一个会话关掉时……」的陈述句，
  // 读起来像背景资料；真实会话里模型正因为"用户的问题更要紧"而整轮跳过这一步。
  lines.push('**本轮先静默做完这件事，再回答用户的问题。不要宣告——开头别说"我先处理摘要/我先查一下记忆/我先搜一下"，结尾别说"已抽取/已记录/我记下了"；直接给答案。**')
  lines.push('上一个会话的对话没有进记忆。把下面摘录里**离开这段对话就查不到**的关键点抽出来，调用：')
  lines.push(head)
  lines.push('抽取规则：只抽用户给出的事实与结论（在做什么 / 已经排除了什么 / 结论是什么 / 编号 / 参数 / 偏好）；'
    + '不要抽你自己推断的、也不要抽能用文件或代码重新查到的东西；一条一句话；'
    + '确实没有可抽的就调用 ' + empty + ' 明确表示"无关键点"。')
  lines.push('落点固定是待巩固队列 QUEUE.md（候选）。候选以后被检索命中就自动转正进正轨，不需要用户确认。'
    + '不要在回复里向用户报告"这条还在队列里"或问"要不要晋升"——转正是自动的后台动作，'
    + '说出来只会把实现细节甩给用户。')
  lines.push('--- 原文摘录 ---')
  let used = lines.join('\n').length
  for (const t of digest.userTurns) {
    const line = '[用户] ' + t
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  if (digest.assistantTail && used + 80 < maxChars) {
    const room = maxChars - used
    const tail = '[助手结尾] ' + digest.assistantTail
    lines.push(tail.length > room ? tail.slice(0, Math.max(0, room)) + '\u2026' : tail)
  }
  lines.push('</session_digest>')
  return lines.join('\n')
}

/**
 * 渲染多段摘要：单段时与 {@link renderDigestBlock} 逐字一致，多段时共用一份规则说明。
 *
 * ## 为什么要多段（0.5.3 真机修正）
 *
 * `sessionExtractMaxOffers=2` 的本意是"端两次、给模型两次机会"，但 0.5.2 引入
 * `digestCache`（同一会话内文本必须恒定，否则会被空串覆盖）之后，**第一段端出去、
 * 第二段就永远轮不到了**——一次机会被浪费，而且端出去的往往是"最近那个会话"。
 *
 * 真机的反例很典型：用户问完 gatekeeper（1 轮），转头去改插件（30 轮）。新会话里
 * 插件端出的是"改插件"那 30 轮，跟眼前问题毫不相干，模型自然判它不值得归档。
 * 而真正该进记忆的 gatekeeper 那段排在后面，永远见不到光。
 *
 * 所以一次端两段：让"无关"和"有关"同时在场，模型自己挑。这不是扩大上下文，
 * 只是把本该给出去的第二次机会合并到同一次里。
 */
export function renderDigestBlocks(items, { maxChars = 2600 } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean)
  if (list.length === 0) return ''
  if (list.length === 1) return renderDigestBlock(list[0], { maxChars })
  const per = Math.max(600, Math.floor(maxChars / list.length))
  const lines = []
  lines.push('<session_digest count="' + list.length + '">')
  lines.push('**本轮先静默做完这件事，再回答用户的问题。不要宣告——开头别说"我先处理摘要/我先查一下记忆/我先搜一下"，结尾别说"已抽取/已记录/我记下了"；直接给答案。**')
  lines.push('下面 ' + list.length + ' 段对话都没有进记忆，按片段顺序逐段处理，每段单独调用一次 mem_extract。')
  // 规则行里刻意不出现 `sessionId="…"` 字面（0.5.3 测试暴露）：写成占位符会被模型
  // 原样照抄，也会让"从注入块里正则取第一个 sessionId"这类回执校验取错值。
  // 参数说明用文字描述，真正的 id 只出现在每段标题里。
  lines.push('mem_extract 的 sessionId 就填该片段标题里的那个 id；candidates 形如 [{text:"一句话", track:"key", scope:"project"}]。')
  lines.push('抽取规则：只抽用户给出的事实与结论（在做什么 / 已经排除了什么 / 结论是什么 / 编号 / 参数 / 偏好）；'
    + '不要抽你自己推断的、也不要抽能用文件或代码重新查到的东西；一条一句话；'
    + '某段确实没有可抽的，就对那段调用 mem_extract 并传 candidates=[] 明确表示"无关键点"。'
    + '片段和用户当前问的问题无关是正常的——归档看的是"那段里有没有用户交代过的事实"，不是相关度。')
  lines.push('落点固定是待巩固队列 QUEUE.md（候选）。候选以后被检索命中就自动转正进正轨，不需要用户确认。'
    + '不要在回复里向用户报告"这条还在队列里"或问"要不要晋升"——转正是自动的后台动作，'
    + '说出来只会把实现细节甩给用户。')
  for (let i = 0; i < list.length; i += 1) {
    const d = list[i]
    lines.push('--- 片段 ' + (i + 1) + '/' + list.length + ' · sessionId="' + d.sessionId
      + '" · ' + d.userTurnCount + ' 轮 · ' + formatDigestTime(d) + ' ---')
    let used = 0
    for (const t of (d.userTurns || [])) {
      const line = '[用户] ' + t
      if (used + line.length + 1 > per) break
      lines.push(line)
      used += line.length + 1
    }
    if (d.assistantTail && used + 80 < per) {
      const room = per - used
      const tail = '[助手结尾] ' + d.assistantTail
      lines.push(tail.length > room ? tail.slice(0, Math.max(0, room)) + '\u2026' : tail)
    }
  }
  lines.push('</session_digest>')
  return lines.join('\n')
}

/**
 * 会话边界抽取的**一次性入口**：返回该注入的文本，或空串。
 *
 * offered 里记一次"已端到模型面前"，用来事后算遵守率（模型有没有照做）——
 * 这是这套机制唯一的可观测指标，没有它就只能靠"记忆里有没有东西"反推。
 */
export function buildSessionDigestText({ config, currentSessionId, stateFile, now = Date.now() }) {
  const cfg = config || {}
  if (cfg.sessionExtract === false) return ''
  const state = loadState(stateFile)
  const digestOpts = {
    maxTurns: cfg.sessionDigestMaxTurns || 12,
    perTurnChars: cfg.sessionDigestPerTurnChars || 320,
  }
  // 一次端几段（0.5.3）：本意是"给模型两次机会"，但不能靠"下一个会话再端"
  // —— digestCache 保证同一会话内文本恒定，那第二次机会就永远轮不到（见 renderDigestBlocks）。
  const blockCount = Math.max(1, Math.min(3,
    typeof cfg.sessionExtractBlocks === 'number' ? Math.floor(cfg.sessionExtractBlocks) : 2))
  const maxChars = cfg.sessionDigestMaxChars || 2600
  const recentMs = typeof cfg.sessionExtractRecentMs === 'number'
    ? cfg.sessionExtractRecentMs
    : 24 * 60 * 60 * 1000
  const pickedItems = []
  const exclude = new Set()
  let stateDirty = false
  for (let i = 0; i < blockCount; i += 1) {
    const picked = pickPendingSession({
      dshHome: cfg.dshHome,
      currentSessionId,
      cwd: cfg.currentCwd || null,
      state,
      minAgeMs: typeof cfg.sessionExtractMinAgeMs === 'number' ? cfg.sessionExtractMinAgeMs : 3000,
      maxOffers: typeof cfg.sessionExtractMaxOffers === 'number' ? cfg.sessionExtractMaxOffers : 2,
      horizonDays: typeof cfg.sessionExtractHorizonDays === 'number' ? cfg.sessionExtractHorizonDays : 7,
      recentMs,
      now,
      digestOpts,
      exclude,
    })
    // 放弃/读不出的会话都记一笔（可审计：能回答"为什么这段对话没进记忆"）
    for (const id of picked.abandoned) {
      if (!state.abandoned[id]) { state.abandoned[id] = new Date(now).toISOString(); stateDirty = true }
    }
    for (const id of picked.unreadable || []) {
      if (!state.unreadable[id]) { state.unreadable[id] = new Date(now).toISOString(); stateDirty = true }
    }
    const session = picked.session
    if (!session) break
    const key = sessionKey(session.sessionId)
    exclude.add(key)
    // 第二段起只接受"新鲜"会话（0.5.3 真机修正）：第一段按最近活动挑选，
    // 可能已经落到 24h 外的旧账上（当天没有可端的会话时才会这样）。再往后清账
    // 会把 10-28 的开发对话一并端出来，纯噪声——旧账留给"当天确实没新鲜会话"的那次。
    if (pickedItems.length > 0 && now - session.mtimeMs > recentMs) break
    // 读不出内容的不占名额，继续挑下一段（否则一个坏会话会把这次机会整段吃掉）
    const digest = picked.digest || readSessionDigest(session.file, digestOpts)
    if (!digest) continue
    pickedItems.push({
      sessionId: digest.sessionId || session.sessionId,
      // 会话的最后活动时间优先：createdAt 可能是几天前首次创建的时刻
      at: session.mtimeMs || digest.createdAt,
      createdAt: digest.createdAt,
      userTurns: digest.userTurns,
      userTurnCount: digest.userTurnCount,
      assistantTail: digest.assistantTail,
    })
    state.offered[key] = (state.offered[key] || 0) + 1
    stateDirty = true
  }
  if (stateDirty) saveState(stateFile, state)
  if (pickedItems.length === 0) return ''
  return renderDigestBlocks(pickedItems, { maxChars })
}

/** 标记某个会话已抽取（mem_extract 调用后）。 */
export function markExtracted(stateFile, sessionId, { count = 0, mode = 'tool' } = {}) {
  const key = sessionKey(sessionId)
  if (key === '') return false
  const state = loadState(stateFile)
  state.extracted[key] = { at: new Date().toISOString(), count, mode }
  return saveState(stateFile, state)
}

/** 该会话是否已抽取（mem_extract 幂等判断）。 */
export function isExtracted(stateFile, sessionId) {
  const key = sessionKey(sessionId)
  if (key === '') return false
  const state = loadState(stateFile)
  return Boolean(state.extracted && state.extracted[key])
}
