/**
 * lib/querylog.js — 检索观测：把"查了没中"从丢失变成可度量。
 *
 * ## 为什么单独一个模块
 *
 * 账本（ledger.js）是**写入审计**：它记的是"谁在什么时候改了什么"。
 * 这里要回答的是另一个问题——**"记忆到底有没有被用上"**。两者共用同一条
 * append-only 账本文件，但口径完全不同：
 *
 *  - 审计关心"完整性"（一条都不能丢）；
 *  - 观测关心"比率"（分子分母必须同源，否则比率没有意义）。
 *
 * ## 采纳自阿里云百炼「观测与审计」（2026-11-02 对照）
 *
 * 百炼把「记忆观测」和「记忆审计」拆成两个页面：审计按记忆 ID 追变更链，
 * 观测把**会话**与**本次产生的记忆变更**并排对照。它给出的最有价值的一条
 * 判据是："助手说的话**没有**变成记忆"——检索空手而归时最该怀疑的不是
 * 排序算法，而是**这条信息根本没被写下来**。
 *
 * 本插件原来有一个对应缺陷（v0.4.4 及以前）：`mem_search` 只在**命中时**
 * 写账本，`hits === 0` 直接 return。于是账本里的 search 记录**全是中了的**
 * ——任何"命中率"都恒为 100%，而真相可能完全相反。这正是"幸存者偏差"的
 * 教科书形态，且它发生在**度量层**，让后续所有关于"要不要改检索"的判断
 * 都失去依据。
 *
 * 本模块因此把"一次检索查到什么"提炼成一个纯函数 `summarizeSearchEvents()`：
 * 输入账本里的事件（在内存里，不读盘），输出可直接给人看的口径。
 * 读盘只发生在 `mem_query_log` / `mem_health` 的人工路径上。
 *
 * @module vanwork-memory-core/lib/querylog
 */

/** 账本里与检索观测相关的事件类型。 */
export const SEARCH_KIND = 'search'
export const READ_KIND = 'read'

/** 默认观察窗口（天）。 */
export const DEFAULT_WINDOW_DAYS = 30

/**
 * 空查簇的展示词数：把查询切成 token 后取前 N 个词作为簇键。
 *
 * 为什么不用整句：**两次一字不差的查询几乎不会出现**，整句聚类的簇全是 1。
 * 而模型在同一个主题上反复换措辞问同一件事，正是"缺记忆"最典型的信号
 * （百炼的观测页也是按**会话 + 语义主题**看待这个问题，而不是按字符串）。
 *
 * 为什么也不能"排序后拼接 key"：中文切的是 bigram，语序一变 token 集合就变了
 * （`记忆插件打包` → 记忆/忆插/插件/件打/打包；`打包记忆插件` → 打包/包记/记忆/忆插/插件），
 * 只"重叠一大半"。所以这里是**重叠度聚类**（与整合里近重复判定同一口径：Jaccard）。
 */
export const CLUSTER_TOKENS = 8

/** 两簇是否同一主题（Jaccard 下限；与 duplicateThreshold=0.82 相比刻意更松——簇是提示，不是判决）。 */
export const CLUSTER_SIMILARITY = 0.5

/**
 * 一次检索的记账字段（写进账本的那一条）。
 *
 * @param {object} p - { query, mode, candidates, hits, topScore, tracks, projectId, error }
 * @returns {object} 可直接交给 `ledger.append('search', …)` 的对象。
 */
export function searchEvent({
  query, mode, candidates, hits, topScore, tracks = null, projectId = null, error = null, filteredByScore = 0,
} = {}) {
  return {
    query: String(query ?? '').slice(0, 120),
    mode: mode ?? 'bm25',
    candidates: Number(candidates ?? 0),
    hits: Number(hits ?? 0),
    // ok 是**派生字段**而不是输入：命中数决定它。把它写进账本是为了让
    // "分母"不需要靠 infer（例如 `hits` 缺失的老记录就不会被误算成空查）。
    ok: Number(hits ?? 0) > 0,
    top: Number.isFinite(topScore) ? Number(topScore) : null,
    filteredByScore: Number(filteredByScore ?? 0),
    tracks: Array.isArray(tracks) ? tracks : null,
    projectId: projectId ?? null,
    error: error ?? null,
  }
}

/** 事件是否可参与比率计算（老记录可能缺字段）。 */
function isCountable(event) {
  return event && typeof event.k === 'string' && Number.isFinite(Number(event.hits)) && event.hits !== null
}

/** 从 ISO 时间戳取本地日期键 YYYY-MM-DD（服务端账本用 toISOString，所以按 UTC 切）。 */
function dayOf(iso) {
  const text = String(iso ?? '')
  return text.length >= 10 ? text.slice(0, 10) : ''
}

/**
 * 查询 → token 集合（供聚类用：取前 CLUSTER_TOKENS 个 token）。
 *
 * @param {string} query - 原始查询。
 * @param {(text: string) => string[]} tokenize - 切词器（scanner.tokenize）。
 * @returns {Set<string>} token 集合（空查询返回空集）。
 */
export function queryTokens(query, tokenize) {
  const tokens = typeof tokenize === 'function' ? tokenize(String(query ?? '')) : []
  return new Set(tokens.slice(0, CLUSTER_TOKENS))
}

/**
 * 查询 → 簇键（排序后拼接）。**只用于展示与去重**：语序一变这条键就会变，
 * 所以真正的"同一主题"判定走 `jaccard(queryTokens(a), queryTokens(b))`。
 *
 * @param {string} query - 原始查询。
 * @param {(text: string) => string[]} tokenize - 切词器。
 * @returns {string} 簇键（空查询返回 ''）。
 */
export function clusterKey(query, tokenize) {
  return [...queryTokens(query, tokenize)].sort().join('\u0001')
}

/** token 集合的 Jaccard 相似度（空集返回 0，不把"空"判成"相同"）。 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 汇总一批账本事件 → 检索质量口径（**纯函数**：不读盘、不写盘、不抛）。
 *
 * @param {object[]} events - 账本记录（`ledger.tail({ limit: n })` 的返回）。
 * @param {object} [opts] - { now, windowDays, tokenize, lowScore, topN }。
 * @returns {{
 *   total: number, hits: number, empty: number, hitRate: number|null,
 *   errors: number, lowScore: number, avgTop: number|null,
 *   since: string|null, until: string|null,
 *   emptyClusters: Array<{key:string, count:number, sample:string}>,
 *   recent: object[], unscored: number
 * }}
 */
export function summarizeSearchEvents(events, opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const windowDays = Number(opts.windowDays ?? DEFAULT_WINDOW_DAYS)
  const lowScore = Number.isFinite(Number(opts.lowScore)) && Number(opts.lowScore) > 0 ? Number(opts.lowScore) : 0
  const topN = Math.max(1, Number(opts.topN ?? 5))
  const tokenize = opts.tokenize
  const sinceMs = now - Math.max(0, windowDays) * 86_400_000

  const list = Array.isArray(events) ? events : []
  let total = 0
  let hits = 0
  let errors = 0
  let lowScoreCount = 0
  let unscored = 0
  let topSum = 0
  let topCount = 0
  let since = null
  let until = null
  const clusters = new Map()

  for (const event of list) {
    if (!isCountable(event) || event.k !== SEARCH_KIND) continue
    const at = Date.parse(String(event.t ?? ''))
    if (Number.isFinite(at) && at < sinceMs) continue
    total += 1
    const day = dayOf(event.t)
    if (day !== '') {
      if (since === null || day < since) since = day
      if (until === null || day > until) until = day
    }
    if (event.error) errors += 1
    const n = Number(event.hits)
    const top = Number(event.top)
    if (Number.isFinite(top) && event.top !== null) {
      topSum += top
      topCount += 1
      if (lowScore > 0 && top < lowScore) lowScoreCount += 1
    } else {
      unscored += 1
    }

    if (n > 0) {
      hits += 1
      continue
    }
    // 空查：按语义簇聚合（重叠度聚类，不是字符串相等——见 CLUSTER_TOKENS 的注释）
    const tokens = queryTokens(event.query, tokenize)
    if (tokens.size === 0) continue
    let bucket = null
    for (const candidate of clusters.values()) {
      if (jaccard(tokens, candidate.tokens) >= CLUSTER_SIMILARITY) { bucket = candidate; break }
    }
    if (bucket === null) {
      bucket = { key: clusterKey(event.query, tokenize), count: 0, sample: String(event.query ?? ''), tokens }
      clusters.set(bucket.key, bucket)
    }
    bucket.count += 1
  }

  const empty = total - hits
  const emptyClusters = [...clusters.values()]
    .sort((a, b) => b.count - a.count || a.sample.localeCompare(b.sample))
    .slice(0, topN)
    // 内部用的 token 集合不外泄（它是实现细节，不该出现在任何渲染/序列化里）
    .map(({ key, count, sample }) => ({ key, count, sample }))

  return {
    total,
    hits,
    empty,
    // 命中率：没有样本时给 null 而不是 0 或 100——"没查过"与"全没中"是两件事。
    hitRate: total > 0 ? hits / total : null,
    errors,
    lowScore: lowScoreCount,
    avgTop: topCount > 0 ? Number((topSum / topCount).toFixed(4)) : null,
    since,
    until,
    emptyClusters,
    recent: list.filter((event) => event?.k === SEARCH_KIND).slice(-10),
    unscored,
  }
}

/**
 * 把一笔 search 事件的摘要渲染成一行人话（`mem_query_log` 用）。
 *
 * @param {object} event - 账本事件。
 * @returns {string} 一行文本。
 */
export function renderSearchEvent(event) {
  const at = String(event?.t ?? '').replace('T', ' ').slice(0, 19)
  const hits = Number(event?.hits ?? 0)
  const top = Number(event?.top)
  const score = event?.top !== null && Number.isFinite(top) ? top.toFixed(4) : '—'
  const flag = event?.error ? ` ⚠向量降级：${event.error}` : ''
  return `${at} · hits=${hits} · top=${score} · mode=${event?.mode ?? '?'} · 「${String(event?.query ?? '').slice(0, 60)}」${flag}`
}

/**
 * 把口径渲染成多行文本（`mem_health` 的一节 + `mem_query_log` 的头部共用）。
 *
 * @param {object} summary - `summarizeSearchEvents` 的返回。
 * @param {object} [opts] - { windowDays, lowScore }。
 * @returns {string[]} 文本行。
 */
export function renderSummaryLines(summary, opts = {}) {
  const windowDays = Number(opts.windowDays ?? DEFAULT_WINDOW_DAYS)
  const lowScore = Number(opts.lowScore ?? 0)
  const lines = []
  if (summary.total === 0) {
    lines.push(`近 ${windowDays} 天没有检索记录（检索观测依赖 mem_search 的调用；查过才有分母）。`)
    return lines
  }
  const rate = summary.hitRate === null ? '—' : `${Math.round(summary.hitRate * 100)}%`
  lines.push(`近 ${windowDays} 天：检索 ${summary.total} 次 · 命中 ${summary.hits} 次（${rate}）· 空查 ${summary.empty} 次`
    + `${summary.errors > 0 ? ` · 向量降级 ${summary.errors} 次` : ''}`)
  if (summary.avgTop !== null) {
    lines.push(`平均最高分 ${summary.avgTop}${lowScore > 0 ? ` · 最高分低于阈值 ${lowScore} 的 ${summary.lowScore} 次` : ''}`
      + `${summary.unscored > 0 ? ` · ${summary.unscored} 条老记录没有分数（升级前的账本）` : ''}`)
  }
  if (summary.since !== null) lines.push(`样本区间 ${summary.since} → ${summary.until}`)
  if (summary.empty > 0) {
    const ratio = summary.empty / summary.total
    // 口径纪律：空查率高**不等于**检索算法差。它首先说明"该写的东西没写下来"，
    // 或者"查询式不自足"（代词/指代让它检索不到）。这条判读写进输出，免得
    // 以后看到数字就先去调 BM25 参数——那是最容易、也最没用的一条路。
    if (ratio >= 0.5) {
      lines.push(`⛔ 空查占 ${Math.round(ratio * 100)}%（≥50%）：**先别调检索参数**。这通常意味着①该记的事实没被写下来，`
        + '或②查询式不自足（用了"这个/那个/刚才那个"这类代词）。对照空查簇决定是补写记忆还是改查询式。')
    }
  }
  if (summary.emptyClusters.length > 0) {
    lines.push('空查簇（同主题反复问却没命中）：')
    for (const cluster of summary.emptyClusters) lines.push(`  ×${cluster.count} 「${cluster.sample.slice(0, 70)}」`)
  } else if (summary.empty === 0) {
    lines.push('没有空查：所有检索都命中了至少一条（注意这只说明"有东西返回"，不代表返回得对）。')
  }
  return lines
}