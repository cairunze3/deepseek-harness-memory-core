/**
 * lib/cloud.js — 云端分层策略与上云前脱敏。
 *
 * **v0.1 只做判定，不发起任何网络请求。** 这里回答用户的第二个问题
 * 「哪部分记忆适合放云端、要怎么维护」：先把每一块记忆按两条独立轴打分，
 * 再给出可执行的脱敏函数——具体走哪条通道（私有 Git 记忆仓库 / Dify 知识库 /
 * 自建服务）是待讨论项，见 docs/记忆插件设计方案.md 第 6 章。
 *
 * 两条轴刻意分开，因为"云端"其实是两件事：
 *   - `offsite`：**离机副本**是否可接受（例如私有 Git 记忆仓库、私有网盘）。
 *     风险主要是泄露面扩大（仓库权限、协作方、备份策略）。
 *   - `thirdParty`：是否允许送进**第三方服务**（托管嵌入模型、托管 RAG、
 *     云端画像）。风险是《个人信息保护法》意义上的"向第三方提供个人信息"，
 *     需要单独告知与授权。
 * 把两者混为一谈，就会得出"能同步到私有仓库 = 能丢给云端做嵌入"的错误结论。
 *
 * @module vanwork-memory-core/lib/cloud
 */

/**
 * 敏感性规则表。
 * `severity`：`secret` 一旦命中，该条目**任何**离机副本都被拒绝；
 * `pii` 需要脱敏后才能离机；`path` 只做脱敏（本地路径是环境指纹，非身份信息）。
 */
export const SENSITIVITY_RULES = [
  { kind: 'private-key', severity: 'secret', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'openai-key', severity: 'secret', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github-token', severity: 'secret', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'aws-key', severity: 'secret', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'bearer-token', severity: 'secret', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'assigned-secret', severity: 'secret', re: /\b(?:api[_-]?key|secret|passwd|password|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;]{8,}/gi },
  { kind: 'cn-id-card', severity: 'pii', re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g },
  { kind: 'cn-mobile', severity: 'pii', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: 'email', severity: 'pii', re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g },
  { kind: 'bank-card', severity: 'pii', re: /(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g },
  { kind: 'win-abs-path', severity: 'path', re: /\b[A-Za-z]:[\\/](?:[^\s"'|<>*?]|[\\/])+/g },
  { kind: 'home-path', severity: 'path', re: /(?:~[\\/]|\/(?:Users|home|Volumes|tmp|var|mnt|opt|srv)\/)(?:[^\s"'|<>*?]|[\\/])+/g },
]

/**
 * 各轨的云端分层基线（未命中敏感性规则时的默认结论）。
 *
 * 这张表在 2026-10-26 按用户拍板的四条决策重写过，两条轴的含义因此收窄：
 *
 * **离机副本（offsite）——只允许 `user` 一轨。**
 * 用户的决策是「多设备只需共用和个人身份习惯相关的，本地会话相关记忆不必共享」。
 * 顺着这条决策往下推，`memory`（全局事实：环境/工具/惯例）**也不该离机**——
 * 它的内容本质上是"这台机器的属性"（DSH home 路径、装了什么、本机惯例）。
 * 把它同步到另一台机器不是隐私问题，而是**制造错误记忆**：那边会拿到一条
 * 在本机永远不成立的"事实"。这恰好呼应"错误记忆比缺失记忆更危险"。
 *
 * **第三方服务（thirdParty）——用户已批准"脱敏片段"级别的使用。**
 * 因此知识性轨道（user/memory/key/project）放行 `redacted-snippets-only`，
 * 而原始流水（daily/archive）与未经确认的候选（queue）、审计账本（ledger）
 * 仍然禁止外发：数据最小化原则下，这些没有外发的必要。
 */
export const TRACK_CLOUD_BASELINE = {
  /** 用户档案：唯一允许跨设备的一轨（身份、习惯、偏好）。 */
  user: {
    offsite: 'yes',
    thirdParty: 'redacted-snippets-only',
    reason: '多设备只共用身份/习惯类记忆——唯一需要跟随用户走的一轨',
  },
  /** 全局事实：**机器属性**，离机即变成错误记忆；但脱敏片段可作云端检索知识。 */
  memory: {
    offsite: 'no',
    thirdParty: 'redacted-snippets-only',
    reason: '环境/工具/惯例是"这台机器的属性"，同步到别处会变成错误记忆',
  },
  /** 项目关键记忆：项目私有，且用户明确不需要跨设备共享。 */
  key: {
    offsite: 'no',
    thirdParty: 'redacted-snippets-only',
    reason: '项目决策属项目私有；跨设备共享不在需求内',
  },
  /** 项目记忆：同上。 */
  project: {
    offsite: 'no',
    thirdParty: 'redacted-snippets-only',
    reason: '项目私有上下文；跨设备共享不在需求内',
  },
  /** 每日日志：会话流水，用户明确不需要跨设备；原始流水不外发。 */
  daily: {
    offsite: 'no',
    thirdParty: 'no',
    reason: '会话流水按用户决策不共享；原始记录数据最小化下不外发',
  },
  /** 归档：低频历史留档，同样本机化。 */
  archive: {
    offsite: 'no',
    thirdParty: 'no',
    reason: '历史留档，仅本机可读',
  },
  /** 待确认队列：尚未确认的内容可能本身就是噪声或错误信息。 */
  queue: { offsite: 'no', thirdParty: 'no', reason: '未经用户确认的候选，不应扩散' },
  /** 审计账本：本地可观测性资产。 */
  ledger: { offsite: 'no', thirdParty: 'no', reason: '本地审计凭据' },
}

/** 默认结论（未知轨道）。 */
const DEFAULT_BASELINE = { offsite: 'no', thirdParty: 'no', reason: '未分类轨道：保守处理，两者皆禁' }

/** 允许离机（跨设备副本）的轨道集合——当前只有用户档案轨。 */
export function offsiteTracks() {
  return Object.entries(TRACK_CLOUD_BASELINE)
    .filter(([, policy]) => policy.offsite !== 'no')
    .map(([track]) => track)
}

/**
 * 检测文本中的敏感内容。
 * @param {string} text - 待检测文本。
 * @returns {Array<{kind: string, severity: string, count: number, sample: string}>}
 */
export function detectSensitivity(text) {
  const source = String(text ?? '')
  if (source === '') return []
  const findings = []
  for (const rule of SENSITIVITY_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    const matches = source.match(re)
    if (!matches || matches.length === 0) continue
    findings.push({
      kind: rule.kind,
      severity: rule.severity,
      count: matches.length,
      sample: redactSample(matches[0]),
    })
  }
  return findings
}

/**
 * 上云前脱敏：把路径与 PII/密钥替换为占位符。
 * 采纳 WorkBuddy 的 `sanitizeMemoryBlock` 思路（绝对路径 → `[path omitted]`），
 * 并把范围扩到密钥与个人信息——因为那份源码只处理路径，密钥会原样上云。
 *
 * @param {string} text - 原文。
 * @param {object} [opts] - { redactPaths=true, redactPii=true, redactSecrets=true }。
 * @returns {{text: string, removed: number, kinds: Record<string, number>}}
 */
export function redactForCloud(text, opts = {}) {
  const allowPaths = opts.redactPaths !== false
  const allowPii = opts.redactPii !== false
  const allowSecrets = opts.redactSecrets !== false
  let output = String(text ?? '')
  let removed = 0
  const kinds = {}

  for (const rule of SENSITIVITY_RULES) {
    if (rule.severity === 'path' && !allowPaths) continue
    if (rule.severity === 'pii' && !allowPii) continue
    if (rule.severity === 'secret' && !allowSecrets) continue
    const placeholder = rule.severity === 'path' ? '[path omitted]' : rule.severity === 'pii' ? '[pii omitted]' : '[secret omitted]'
    const re = new RegExp(rule.re.source, rule.re.flags)
    output = output.replace(re, () => {
      removed += 1
      kinds[rule.kind] = (kinds[rule.kind] ?? 0) + 1
      return placeholder
    })
  }

  return { text: output, removed, kinds }
}

/**
 * 对单条记忆给出云端分层结论。
 *
 * @param {object} entry - 记忆条目（来自 scanner）。
 * @param {object} [config] - 插件配置（读 cloudTierOverrides / cloudRedactPaths）。
 * @returns {{offsite: string, thirdParty: string, reasons: string[], sensitivity: object[], track: string}}
 */
export function classifyEntry(entry, config = {}) {
  const track = String(entry?.track ?? 'unknown')
  const override = config?.cloudTierOverrides?.[track]
  const baseline = override
    ? { offsite: override.offsite ?? DEFAULT_BASELINE.offsite, thirdParty: override.thirdParty ?? DEFAULT_BASELINE.thirdParty, reason: '配置覆盖' }
    : (TRACK_CLOUD_BASELINE[track] ?? DEFAULT_BASELINE)

  const sensitivity = detectSensitivity(`${entry?.summary ?? ''}\n${entry?.body ?? ''}`)
  const secrets = sensitivity.filter((f) => f.severity === 'secret')
  const pii = sensitivity.filter((f) => f.severity === 'pii')
  const reasons = [baseline.reason]

  let offsite = baseline.offsite
  let thirdParty = baseline.thirdParty

  if (secrets.length > 0) {
    offsite = 'no'
    thirdParty = 'no'
    reasons.push(`命中 ${secrets.map((f) => f.kind).join('/')}：任何离机副本都被拒绝，需先在本地清理`)
  }
  if (pii.length > 0) {
    if (offsite === 'yes') offsite = 'redact-then-sync'
    if (thirdParty !== 'no') thirdParty = 'no'
    reasons.push(`命中 ${pii.map((f) => f.kind).join('/')}：属个人信息，离机前必须脱敏`)
  }
  if (entry?.dshOnly === true) {
    offsite = 'no'
    thirdParty = 'no'
    reasons.push('条目带 [dsh-only] 标记')
  }
  return { offsite, thirdParty, reasons, sensitivity, track }
}

/**
 * 汇总一份记忆集的云端分层画像（供 `mem_health` 与设计文档使用）。
 *
 * @param {object[]} entries - 条目数组。
 * @param {object} [config] - 插件配置。
 * @returns {object} 分层统计与建议。
 */
export function cloudPlan(entries, config = {}) {
  const list = Array.isArray(entries) ? entries : []
  const offsite = { yes: 0, 'redact-then-sync': 0, no: 0 }
  const thirdParty = {}
  const byTrack = {}
  const findingTotals = {}
  let chars = 0

  for (const entry of list) {
    const verdict = classifyEntry(entry, config)
    offsite[verdict.offsite] = (offsite[verdict.offsite] ?? 0) + 1
    thirdParty[verdict.thirdParty] = (thirdParty[verdict.thirdParty] ?? 0) + 1
    const bucket = byTrack[verdict.track] ?? { count: 0, chars: 0, offsite: verdict.offsite, thirdParty: verdict.thirdParty }
    bucket.count += 1
    bucket.chars += entry?.chars ?? 0
    byTrack[verdict.track] = bucket
    chars += entry?.chars ?? 0
    for (const finding of verdict.sensitivity) findingTotals[finding.kind] = (findingTotals[finding.kind] ?? 0) + finding.count
  }

  const recommendations = []
  const syncEntries = list.filter((entry) => classifyEntry(entry, config).offsite !== 'no').length
  if (offsite.no > 0) {
    recommendations.push(`${offsite.no} 条不进任何离机副本：其中含轨道基线禁止的（本地会话类）与命中密钥/[dsh-only] 的（后者必须先清理）`)
  }
  if (offsite['redact-then-sync'] > 0) recommendations.push(`${offsite['redact-then-sync']} 条命中个人信息，离机前必须先脱敏：调用 redactForCloud 处理`)
  if ((thirdParty['redacted-snippets-only'] ?? 0) > 0) recommendations.push(`${thirdParty['redacted-snippets-only']} 条仅供"脱敏片段"级别的第三方使用（如云端嵌入/检索），不得整段外发`)
  if (Object.keys(findingTotals).length > 0) recommendations.push(`敏感命中分布：${Object.entries(findingTotals).map(([k, n]) => `${k}×${n}`).join('、')}`)
  recommendations.push(`当前跨设备范围：${offsiteTracks().join('/')} 轨，共 ${syncEntries} 条会离机；其余 ${list.length - syncEntries} 条保持本机`)

  return {
    totals: { entries: list.length, chars },
    offsite,
    thirdParty,
    byTrack,
    syncScope: { tracks: offsiteTracks(), entries: syncEntries, localEntries: list.length - syncEntries },
    sensitiveFindings: findingTotals,
    recommendations,
  }
}

/**
 * 生成一条记忆的"可离机文本"。命中密钥时返回 `null`（拒绝离机），
 * 其余情况返回脱敏后的正文 —— 调用方必须用返回值，不得回退到原文。
 *
 * @param {object} entry - 记忆条目。
 * @param {object} [config] - 插件配置。
 * @returns {{text: string, removed: number, kinds: Record<string, number>}|null}
 */
export function sanitizeForCloud(entry, config = {}) {
  const verdict = classifyEntry(entry, config)
  if (verdict.offsite === 'no') return null
  return redactForCloud(`${entry?.summary ?? ''}\n\n${entry?.body ?? ''}`, {
    redactPaths: config.cloudRedactPaths !== false,
  })
}

/** 让敏感样本本身不泄露（只留首尾各 2 字符）。 */
function redactSample(sample) {
  const s = String(sample)
  if (s.length <= 8) return `${s.slice(0, 2)}…`
  return `${s.slice(0, 4)}…${s.slice(-2)}`
}