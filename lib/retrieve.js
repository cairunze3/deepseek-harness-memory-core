/**
 * lib/retrieve.js — 混合检索（BM25 + 向量 + RRF）与注入排序。
 *
 * 三条链路的取舍（对应文章 5.2 与 6 章）：
 *  1. **稠密向量负责语义，稀疏关键词负责字面**：本机没有嵌入服务，所以
 *     向量一路**默认关闭**；打开时走 OpenAI 兼容 `/embeddings`，失败一律
 *     降级为纯 BM25（不假装有语义检索，也不让检索因为网络而失败）。
 *  2. **RRF 融合**：按排名而非分数融合，免去跨路分数归一化——这是文章
 *     点名推荐的省事且稳健的做法。
 *  3. **精排只作用于 Top-K**：「召回候选 → 轻量精排」把成本锁在常数级；
 *     这里不引入 rerank 模型（本机没有），改用「时效性 + 命中频次 + 轨权重」
 *     的可解释打分。
 *
 * @module vanwork-memory-core/lib/retrieve
 */

import { STAMP_RE, tokenize } from './scanner.js'

/** 各轨的基础权重（重要程度先验；数字是可调的取舍，不是真理）。 */
export const TRACK_WEIGHT = {
  // 全局记忆（`GLOBAL.md`，槽位模型）：一槽一句话、几百字——**最高优先级**。
  // 它一条就概括了"我是谁 / 要什么"，比任何单条记忆都值得先看到。
  global: 1.00,
  user: 1.00,
  key: 1.00,
  // 全局概览（`OVERVIEW.md`）：一屏看完的摘要，"该记住什么"的顶层线索。
  // 给 0.98：预算紧张时它几乎总能进（一条抵十条），但不压过用户档案本身。
  overview: 0.98,
  memory: 0.90,
  // 月摘要（分层压缩的温区）：它是"线索"，密度高、跨越整月，权重介于 memory 与 daily 之间。
  // 给太低会让它被流水挤掉，给太高又会压过具体结论——0.80 是刻意的折中。
  digest: 0.80,
  project: 0.70,
  daily: 0.55,
  queue: 0.20,
  archive: 0.15,
}

/** 时效半衰期（天）：越旧的信息权重按指数衰减。 */
export const RECENCY_HALF_LIFE_DAYS = 45

/**
 * Reciprocal Rank Fusion：按排名融合多路结果。
 *
 * @param {Array<{name: string, ids: string[]}>} rankLists - 各路有序 id 列表。
 * @param {number} [k=60] - RRF 常数。
 * @returns {Map<string, {rrf: number, sources: Record<string, number>}>}
 */
export function rrfFuse(rankLists, k = 60) {
  const fused = new Map()
  for (const list of rankLists) {
    list.ids.forEach((id, index) => {
      const prior = fused.get(id) ?? { rrf: 0, sources: {} }
      prior.rrf += 1 / (k + index + 1)
      prior.sources[list.name] = index + 1
      fused.set(id, prior)
    })
  }
  return fused
}

/** 余弦相似度（两向量长度不一致时返回 0，不做静默补齐）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 构建向量提供者。**未启用 / 缺配置 / 缺密钥一律返回 null**，
 * 调用方据此走纯 BM25（而不是抛错）。
 *
 * @param {object} config - 插件配置。
 * @param {object} [logger] - 日志。
 * @returns {{model: string, dim: number, embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>}|null}
 */
export function buildEmbeddingProvider(config, logger = console) {
  const settings = config?.embedding
  if (!settings?.enabled) return null
  if (!settings.endpoint || !settings.model) {
    logger?.warn?.('[memory-core] embedding.enabled=true 但 endpoint/model 缺失，已按纯 BM25 运行')
    return null
  }
  const apiKey = process.env?.[settings.apiKeyEnv] ?? ''
  const url = settings.endpoint.replace(/\/+$/, '').endsWith('/embeddings')
    ? settings.endpoint
    : `${settings.endpoint.replace(/\/+$/, '')}/embeddings`

  return {
    model: settings.model,
    dim: settings.dim,
    async embed(texts, signal) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener?.('abort', onAbort)
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model: settings.model, input: texts }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`)
        const payload = await response.json()
        const rows = Array.isArray(payload?.data) ? payload.data : []
        if (rows.length !== texts.length) throw new Error('embeddings 返回数量与请求不一致')
        return rows.map((row) => row.embedding)
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
      }
    },
  }
}

/**
 * 混合检索：BM25 为主，向量可选，RRF 融合，最后按可解释规则精排。
 *
 * @param {object} p - { index, query, config, logger, provider, opts, signal }。
 * @returns {Promise<{hits: object[], mode: string, vectorError: string|null, candidates: number}>}
 */
export async function hybridSearch({ index, query, config, logger = console, provider = null, opts = {}, signal }) {
  const limit = Math.min(opts.limit ?? config.searchDefaultLimit, config.searchMaxLimit)
  const candidateLimit = Math.max(limit * (config.searchCandidates ?? 4), limit)
  const mode = config.searchMode ?? 'auto'

  const bm25Rows = index.search(query, { ...opts, limit: candidateLimit })
  const rankLists = [{ name: 'bm25', ids: bm25Rows.map((row) => row.entry_id ?? row.entryId) }]
  let vectorError = null
  let usedVector = false

  if (provider && mode !== 'bm25') {
    try {
      const [queryVec] = await provider.embed([query], signal)
      const candidates = bm25Rows.length > 0 ? bm25Rows : index.allEntries({ ...opts, limit: candidateLimit })
      const ids = candidates.map((row) => row.entry_id ?? row.entryId)
      const vectors = index.getVectors(ids)
      const scored = []
      for (const [id, record] of vectors) {
        const sim = cosine(queryVec, record.vec)
        if (sim > 0) scored.push({ id, sim })
      }
      scored.sort((a, b) => b.sim - a.sim)
      if (scored.length > 0) {
        rankLists.push({ name: 'vector', ids: scored.slice(0, candidateLimit).map((item) => item.id) })
        usedVector = true
      }
    } catch (error) {
      vectorError = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`[memory-core] 向量检索失败，已降级为纯 BM25：${vectorError}`)
    }
  }

  const fused = rrfFuse(rankLists, config.rrfK)
  const byId = new Map(bm25Rows.map((row) => [row.entry_id ?? row.entryId, row]))
  const missing = [...fused.keys()].filter((id) => !byId.has(id))
  for (const row of index.getByIds(missing)) byId.set(row.entry_id ?? row.entryId, row)

  const access = index.accessCounts([...byId.keys()])
  const hits = [...fused.entries()]
    .map(([id, value]) => {
      const row = byId.get(id)
      if (!row) return null
      const entry = normalizeRow(row)
      const importance = importanceOf(entry, { now: Date.now(), access: access.get(id), config })
      return {
        entry,
        rrf: value.rrf,
        sources: value.sources,
        importance,
        finalScore: value.rrf * (0.6 + 0.4 * importance),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, limit)

  return {
    hits,
    mode: usedVector ? (mode === 'hybrid' ? 'hybrid' : 'auto+vector') : 'bm25',
    vectorError,
    candidates: fused.size,
  }
}

/** 把索引行（snake_case 或对象）统一成条目形状。 */
export function normalizeRow(row) {
  if (row === null || row === undefined) return null
  if (row.entryId) return row
  return {
    entryId: row.entry_id,
    path: row.path,
    rel: row.rel,
    root: row.root,
    ordinal: row.ordinal ?? 0,
    scope: row.scope,
    track: row.track,
    projectId: row.project_id,
    projectLabel: row.project_label,
    date: row.date,
    time: row.time,
    stamp: row.stamp,
    summary: row.summary,
    body: row.body,
    chars: row.chars,
    bytes: row.bytes,
    mtime: row.mtime,
    ageDays: row.age_days,
    idTag: row.id_tag,
    branchTag: row.branch_tag,
    supersededBy: row.superseded_by ?? null,
    dshOnly: row.dsh_only === 1 || row.dsh_only === true,
    indexedBody: row.body,
    contentHash: row.file_hash,
  }
}

/**
 * 可解释的重要性打分（0..1），用于注入排序与整合优先级。
 * 采纳 Generative Agents 的「相关性 + 新颖性 + 重要性」思路，
 * 但把不可解释的 LLM 打分换成三个可复算的因子。
 *
 * @param {object} entry - 条目。
 * @param {object} p - { now, access, config }。
 * @returns {number} 0..1
 */
export function importanceOf(entry, { now = Date.now(), access = null, config = null } = {}) {
  const trackWeight = TRACK_WEIGHT[entry.track] ?? 0.4
  const referenceMs = entry.date ? Date.parse(`${entry.date}T12:00:00`) : (entry.mtime ?? now)
  const ageDays = Number.isFinite(referenceMs) ? Math.max(0, (now - referenceMs) / 86_400_000) : 0
  const recency = Math.pow(0.5, ageDays / (config?.recencyHalfLifeDays ?? RECENCY_HALF_LIFE_DAYS))
  const accessBoost = Math.min(1, Math.log1p(access?.count ?? 0) / Math.log(10))
  const lengthFactor = entry.chars > 0 && entry.chars < 40 ? 0.85 : 1
  const score = (0.5 * trackWeight + 0.35 * recency + 0.15 * accessBoost) * lengthFactor
  return Math.max(0, Math.min(1, Number(score.toFixed(4))))
}

/**
 * 条目 → token 集合（新颖性比较与近重复判定共用同一口径）。
 *
 * **必须先剥掉行首时间戳**：`[2026-10-18 10:00]` 会产生 2026/10/18 这类
 * 数字 token，让"同一条事实在不同日期各写了一遍"被算成不同内容——
 * 近重复检测会因此系统性漏判（开发时实测：两条几乎相同的条目相似度
 * 被时间戳拉低到 0.818，恰好落在 0.82 阈值之下而漏掉）。
 */
export function tokenSetOf(entry, cap = 320) {
  const body = String(entry?.body ?? '').replace(STAMP_RE, '')
  return new Set(tokenize(`${entry?.summary ?? ''} ${body}`).slice(0, cap))
}

/** 供注入快照使用的关键词重叠度（新颖性代理：与已注入头部条目的重复度越低越新颖）。 */
export function noveltyOf(entry, seenTokenSets) {
  const tokens = tokenSetOf(entry)
  if (tokens.size === 0) return 1
  let maxOverlap = 0
  for (const seen of seenTokenSets) {
    let overlap = 0
    for (const token of tokens) if (seen.has(token)) overlap += 1
    maxOverlap = Math.max(maxOverlap, overlap / tokens.size)
  }
  return Math.max(0, 1 - maxOverlap)
}

/** Jaccard 相似度（对称：两边都变多时降低）。 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 包含度（非对称：短的那个被长的完全覆盖时接近 1）。
 *
 * 为什么两个都要：记忆里的近重复最常见形态是「同一条事实，第二次写得更啰嗦」
 * ——一个是另一个的超集。这种情形 Jaccard 会被长度差拉低（分母涨了），
 * 而包含度正确给出接近 1 的分数。只用 Jaccard 会漏掉最该合并的那批。
 */
export function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / small.size
}

/** 近重复判定的综合相似度：取 Jaccard 与包含度的较大者。 */
export function duplicateSimilarity(a, b) {
  return Math.max(jaccard(a, b), containment(a, b))
}

/** 摘要裁剪（检索结果注入时的长度闸门）。 */
export function snippetOf(entry, maxChars) {
  const body = String(entry.body ?? '')
  if (body.length <= maxChars) return body
  return `${body.slice(0, maxChars)}…`
}