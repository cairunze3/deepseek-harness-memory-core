/**
 * lib/scanner.js — 记忆文件扫描与条目解析。
 *
 * **核心取舍：本插件不拥有记忆内容，只拥有「派生索引」。**
 * 记忆正本仍然是磁盘上的 Markdown（dsh-memory-evolve 的
 * `<dshHome>/memories/`，或本插件自建的 `<coreDir>/store/`）。这样做是为了
 * 避免出现两个"事实来源"——一旦双写，冲突与漂移的成本远高于收益。
 * 索引随时可整份删除重建。
 *
 * 兼容的磁盘布局（与 dsh-memory-evolve 一致，逐条对过它的 store.js）：
 * ```
 * <root>/MEMORY.md                 全局事实
 * <root>/USER.md                   用户档案
 * <root>/MEMORY-archive.md         全局事实归档（对方记忆 Tab 的归档页签）
 * <root>/USER-archive.md           用户档案归档（同上）
 * <root>/daily/YYYY-MM-DD.md      每日日志
 * <root>/SUGGESTIONS.jsonl        待确认队列（非 Markdown，跳过）
 * <root>/archive/*.md             归档（本插件早期私名，仍兼容）
 * <root>/projects/<projectId>/
 *     MEMORY.md                   项目记忆
 *     KEY.md                      项目关键记忆（注入 + 分支范围）
 *     KEY-archive.md              项目关键记忆归档（对方归档页签）
 *     daily/YYYY-MM-DD.md
 *     archive/*.md                归档
 * ```
 * 条目分隔符 `\n§\n`；条目可带 `[id:xxxx]`（跨设备合并锚点）、
 * `[summary:…]`（渐进式披露）、`[branch:…]`（分支范围）、`[dsh-only]` 标签。
 * 未知文件不会被丢弃——track 取文件名主干，照样进索引。
 *
 * @module vanwork-memory-core/lib/scanner
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { dateStamp, ensureDir, listFiles, relativePosix, sha1hex, writeFileAtomic } from './fsutil.js'
import { PRECREATE, initialContent } from './filedocs.js'

/** 条目分隔符（与 memory-evolve 的 ENTRY_DELIMITER 逐字节一致）。 */
export const ENTRY_DELIMITER = '\n§\n'

/** 单个记忆文件超过该字节数则跳过（防止误配根目录时把大文件读进内存）。 */
export const MAX_FILE_BYTES = 2_000_000

/** 条目正文进入索引的上限（超长正文只索引前 N 字符，避免索引膨胀）。 */
export const MAX_INDEX_BODY_CHARS = 20_000

/** 行首时间戳：`[2026-10-22 15:24]` 或 `[15:24]`。 */
export const STAMP_RE = /^\[(\d{4}-\d{2}-\d{2})?[ T]?(\d{2}:\d{2})?(?:\s+[^\]]*)?\]\s*/
/** 条目身份标签（同步锚点）。 */
const ID_RE = /\[id:([^\]]+)\]/
/** 渐进式披露摘要标签。 */
const SUMMARY_RE = /\[summary:([^\]]*)\]/
/** 分支范围标签。 */
const BRANCH_RE = /\[branch:([^\]]+)\]/
/** DSH 专用标记（不上云/不外显）。 */
const DSH_ONLY_RE = /\[dsh-only\]/
/**
 * 纯标签行：整行只由 `[tag:…]` / `[dsh-only]` 这类标签组成，**没有正文**。
 *
 * 为什么切块必须认识它：`buildBody()` 会把 `[summary:…]` 作为**独立一行**放在
 * 时间戳之前，于是条目的第一行往往不是时间戳而是标签行。切块时若把标签行当成
 * 一条新条目的起点，会同时产生两个坏结果（2026-11-02 记忆插件 A/B 测试实测踩到）：
 *
 *  1. **摘要被切成一条独立记忆**：索引里多出没有正文的条目，而且每写一次就多一条
 *     （`readChunks`/`splitIntoEntries` 重读时又把新标签行独立出去）；
 *  2. **上一条正文与下一条摘要粘进同一个 chunk**：模型按"索引给出的条目正文"去找
 *     匹配片段时，会命中**错的条目**，replace 一次就把结构写坏
 *     （实测：KEY.md 里 `[summary:A]` 变成孤立条目、`body1` 尾部粘着 `[summary:B]`）。
 *
 * 判定故意只认"整行都是标签"：`[2026-11-02 14:48] [summary:…]` 这种时间戳开头
 * 的行由 `STAMP_RE` 负责，不算标签行；正文里出现的 `[summary:…]` 也不算。
 */
export const TAG_ONLY_LINE_RE = /^(?:\[[a-z][a-z-]*(?::[^\]\n]*)?\]\s*)+$/i

/** 该行是否"只有标签、没有正文"（切块时不应作为条目边界）。 */
export function isTagOnlyLine(line) {
  const trimmed = String(line ?? '').trim()
  return trimmed !== '' && TAG_ONLY_LINE_RE.test(trimmed)
}

/**
 * 文件头注释：文件**最开头**连续的 HTML 注释块（块间允许空行）。
 *
 * 为什么需要这个概念（2026-11-04）：`filedocs.headerNote` 会把"这份文件是干什么的"
 * 写成注释放在文件最前面，好处是打开就看到、且不占正文。但只要解析器不认识它，
 * 它就会变成**一条假记忆**——实测存量 `GLOBAL.md` 的第一条就是
 * `# 记忆\n\n<!-- 由记忆插件维护… -->`（track=global，进常驻注入池，白占预算）。
 *
 * 所以约定：**文件头注释是"文件的页眉"，不是"记忆的条目"**。
 *  - 扫描侧：`splitIntoEntries` 先剥掉它 → 带说明的空文件是 0 条目；
 *  - 写入侧：`memfile.readChunks` 也剥、`joinChunks` 再原样拼回 → 不会把它
 *    当成"已有的一条"去 append/replace（8.12 的教训：两侧必须一致）。
 *
 * 只认**文件开头**：正文中间的 `<!-- -->` 是内容的一部分，不剥。
 */
const HEADER_COMMENT_RE = /^(?:[ \t]*\r?\n)*(?:[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$))+(?:[ \t]*\r?\n)*/

/**
 * 注释块之后紧跟的文件级标题（`# 记忆` 这种，只认一级标题）。
 *
 * 为什么要连标题一起算文件头：`GLOBAL.md` 的形态是"注释说明 + `# 记忆` + 槽"。
 * 标题本身没有内容，不该是条目；但如果只在读取侧丢弃、写入侧保留，`append` 就会
 * 把它当成"已有的一条"，拼出 `# 记忆\n§\n新条目` —— 下一次扫描（见到 `§` 走 delimiter
 * 分支）就又把它切成一个条目。所以它必须是**页眉的一部分**：读和写都原样带着它。
 */
const HEADER_TITLE_RE = /^(?:[ \t]*\r?\n)*#[ \t]+\S[^\n]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/

/**
 * 旧格式兼容：`# 记忆` 在前、说明注释紧随其后（v0.6.0 之前 `global.renderSlots`
 * 就是这么写的，存量文件全在这个形态）。
 *
 * 为什么靠解析兼容而不是改文件：改文件要写盘、要备份、要处理并发，而且用户
 * 可能正开着编辑器；而"把它认成页眉"只是一个正则的事，存量文件一个字节都不用动。
 * 两种形态都认，写入时原样拼回 => 谁也不会被悄悄改掉。
 */
const LEGACY_HEADER_RE = /^(?:[ \t]*\r?\n)*#[ \t]+\S[^\n]*\r?\n(?:[ \t]*\r?\n)*(?:[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$))+(?:[ \t]*\r?\n)*/

/**
 * 把文件头（说明注释 + 紧随其后的文件级标题）与正文分开。
 *
 * 只有"文件最开头就有注释"时才连标题一起吃：没有注释的文件保持原样，
 * 不去动它开头可能存在的 `# 标题`（那是内容，不是页眉）。
 *
 * @param {string} text - 文件全文。
 * @returns {{header: string, rest: string}} header 含其后的空行；无注释时 header 为 ''。
 */
export function splitHeaderComments(text) {
  const raw = String(text ?? '')
  // 两种形态：注释在前（新） / 标题在前 + 注释紧随（旧）。都没有 → 不是页眉。
  const match = HEADER_COMMENT_RE.exec(raw) ?? LEGACY_HEADER_RE.exec(raw)
  if (match === null) return { header: '', rest: raw }
  let header = match[0]
  let rest = raw.slice(header.length)
  const title = HEADER_TITLE_RE.exec(rest)
  if (title !== null) {
    header += title[0]
    rest = rest.slice(title[0].length)
  }
  return { header, rest }
}

/**
 * 该块是否"只有一级标题、没有正文"（`# 记忆` 这种文件标题不是记忆条目）。
 *
 * 不加这条判据时，`# 记忆` 会作为一个 body 为 `# 记忆` 的条目进索引——
 * 实测存量 GLOBAL.md 的第 1 条就是这样来的。
 *
 * **只认一级标题**（`# …`）：`## 待办` 这种二级标题是用户/模型写的分节，
 * 即使暂时没内容也是内容的一部分，绝不能因为"看起来像标题"就丢掉。
 * 导出给 `memfile.readChunks` 用——读写两侧必须同一判定（8.12 的教训）。
 */
export function isTitleOnlyBlock(body) {
  const lines = String(body).split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length > 0 && lines.every((line) => /^#\s+\S/.test(line))
}
/**
 * 取代标记（L2）：`[superseded-by:<id>]` 表示"这条是错的，正确结论在别处"。
 *
 * 这是把「修正」而不是「删除」做成常态的载体（用户 2026-10-26 拍板）：
 * 条目本身留档可回溯，但不再注入、默认不再被召回；`<id>` 指向取代它的那条，
 * 于是"我们曾经以为 X，后来发现 Y"这条演进链是可查的。
 */
export const SUPERSEDED_RE = /\[superseded-by:([^\]]+)\]/

/**
 * 按 `\n§\n` 切分原始文本，得到 trim 后的非空条目。
 * 与 memory-evolve 的 parseEntries 行为一致。
 */
export function parseEntries(text) {
  return String(text)
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** 剥离条目开头的身份/摘要/取代标签，返回纯正文（不改磁盘内容）。 */
export function stripTags(entry) {
  return String(entry)
    .replace(/^\s*\[id:[^\]]+\]\s*/, '')
    .replace(/^\s*\[summary:[^\]]*\]\s*/, '')
    .replace(/^\s*\[superseded-by:[^\]]+\]\s*/, '')
    .trim()
}

/** 取条目摘要：优先 `[summary:…]`，否则首行（**剥掉行首时间戳**），截断到 120 字符。 */
export function extractSummary(entry) {
  const tagged = SUMMARY_RE.exec(entry)
  if (tagged && tagged[1].trim() !== '') return clip(tagged[1].trim(), 120)
  // 摘要里再带一次 `[2026-10-18 10:00]` 是纯噪声：索引行与蒸馏文本都会在
  // 别处单独给出日期/时间，重复的时间戳只会浪费常驻预算。
  const body = stripTags(entry).replace(STAMP_RE, '')
  const firstLine = body.split('\n')[0]?.trim() ?? ''
  return clip(firstLine, 120)
}

/** 取条目日期：优先正文时间戳，其次文件名日期，最后 null。 */
export function entryDateOf(entry, fileDate = null) {
  const body = stripTags(entry)
  const match = STAMP_RE.exec(body)
  if (match && match[1]) return match[1]
  return fileDate ?? null
}

/** 取条目时间（HH:MM）或 null。 */
export function entryTimeOf(entry) {
  const body = stripTags(entry)
  const match = STAMP_RE.exec(body)
  return match && match[2] ? match[2] : null
}

/** 稳定的条目 id：同一文件同一序号同一内容 → 同一 id（跨扫描/跨设备稳定）。 */
export function stableEntryId(rel, ordinal, body) {
  return sha1hex(`${rel}#${ordinal}#${String(body).trim()}`, 20)
}

/**
 * 把一份记忆文件切成条目。
 *
 * 拆分优先级（先精确、后退让）：
 *  1. **含 `\n§\n` 分隔符** → 每个 § 块就是一条（这是 memory-evolve 的正式
 *     条目语义，多行正文属于同一条，不能再按行切碎）；
 *  2. 无分隔符但**行首有时间戳** → 按 `[时间戳]` 分行（容错：手工追加的
 *     条目常常忘了写 `§`）；
 *  3. 无分隔符但有 `#` 标题 → 按标题分节（普通 Markdown 笔记）；
 *  4. 其余 → 整文件一条。
 *
 * @param {string} text - 文件内容。
 * @param {string} rel - 相对路径（保留参数以便未来做按路径定制）。
 * @returns {Array<{ordinal: number, body: string, stamp: string|null}>}
 */
export function splitIntoEntries(text, rel) {
  // 文件头注释是"页眉"不是条目：先剥掉，再按 § / 时间戳 / 标题切。
  const raw = splitHeaderComments(text).rest
  const toEntry = (body, ordinal) => ({
    ordinal,
    body,
    stamp: STAMP_RE.exec(stripTags(body))?.[0]?.trim() ?? null,
  })

  // 1) 正式条目格式：§ 分隔
  if (/\n[ \t]*§[ \t]*\n/.test(raw)) {
    return raw
      .split(/\n[ \t]*§[ \t]*\n/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk !== '')
      .map((chunk, index) => toEntry(chunk, index))
  }

  // 2) 无 § 但行首有时间戳：按时间戳分行
  const lines = raw.split('\n')
  if (lines.some((line) => STAMP_RE.test(line.trim()))) {
    const out = []
    let buffer = []
    const push = (body) => {
      const trimmed = body.trim()
      if (trimmed !== '') out.push(toEntry(trimmed, out.length))
    }
    for (const line of lines) {
      if (STAMP_RE.test(line.trim())) {
        // 切分点不是"时间戳行"，而是"尾部标签行 + 时间戳行"：`[summary:…]`/`[id:…]`
        // 这类纯标签行是**本条目的前缀**（buildBody 就放在时间戳之前），所以要把
        // buffer 末尾连续的标签行留给下一条，只把前面的正文切出去。
        // 否则摘要会粘在上一条末尾（实测 KEY.md 就是这样把两条并成一条的）。
        let cut = buffer.length
        while (cut > 0 && isTagOnlyLine(buffer[cut - 1])) cut -= 1
        if (buffer.slice(0, cut).some((l) => l.trim() !== '')) {
          push(buffer.slice(0, cut).join('\n'))
          buffer = buffer.slice(cut)
        }
      }
      buffer.push(line)
    }
    push(buffer.join('\n'))
    return out
  }

  // 3) 标准 Markdown：按标题分节
  if (/^#{1,6}\s+\S/m.test(raw)) {
    const out = []
    let buffer = []
    const flush = () => {
      const body = buffer.join('\n').trim()
      buffer = []
      if (body !== '' && !isTitleOnlyBlock(body)) out.push(toEntry(body, out.length))
    }
    for (const line of lines) {
      if (/^#{1,6}\s+\S/.test(line) && buffer.some((l) => l.trim() !== '')) flush()
      buffer.push(line)
    }
    flush()
    return out
  }

  // 4) 整文件一条
  const whole = raw.trim()
  return whole === '' || isTitleOnlyBlock(whole) ? [] : [toEntry(whole, 0)]
}

/**
 * 相对路径 → 记忆语义（scope / track / 项目归属 / 日期）。
 * 未知文件名以主干作为 track，绝不丢数据。
 *
 * @param {string} rel - 相对记忆根的 POSIX 路径。
 * @returns {{scope: 'global'|'project', track: string, projectId: string|null, date: string|null}}
 */
export function classifyFile(rel) {
  const parts = String(rel).split('/').filter(Boolean)
  if (parts.length === 0) return { scope: 'global', track: 'unknown', projectId: null, date: null }
  const stem = basename(parts[parts.length - 1], extname(parts[parts.length - 1]))

  if (parts[0] === 'projects' && parts.length >= 3) {
    const projectId = parts[1]
    const tail = parts.slice(2)
    if (tail.length === 1) return { scope: 'project', track: trackForStem(stem), projectId, date: null }
    if (tail[0] === 'daily' && tail.length === 2) return { scope: 'project', track: 'daily', projectId, date: /^\d{4}-\d{2}-\d{2}$/.test(stem) ? stem : null }
    // 月度打包目录：`projects/<id>/daily/archive/YYYY-MM.md` 必须归入归档轨，
    // 否则它会落到"未知文件 → 以主干为 track"的兜底分支，**照样被常驻注入**，
    // 整个分层压缩就白做了（见 lib/pack.js）。
    if (tail[0] === 'daily' && tail[1] === 'archive') return { scope: 'project', track: 'archive', projectId, date: null }
    if (tail[0] === 'archive') return { scope: 'project', track: 'archive', projectId, date: null }
    return { scope: 'project', track: trackForStem(stem), projectId, date: null }
  }

  // 注意：以下分支必须显式带 projectId: null —— 漏掉会让 undefined 流进
  // SQLite 绑定参数并抛 "cannot be bound"，索引从此整条失效。
  if (parts.length === 1) return { scope: 'global', track: trackForStem(stem), projectId: null, date: null }
  if (parts[0] === 'daily' && parts.length === 2) {
    return { scope: 'global', track: 'daily', projectId: null, date: /^\d{4}-\d{2}-\d{2}$/.test(stem) ? stem : null }
  }
  // 同上：`daily/archive/YYYY-MM.md` → 归档轨（不再逐条进常驻索引）。
  if (parts[0] === 'daily' && parts[1] === 'archive') return { scope: 'global', track: 'archive', projectId: null, date: null }
  if (parts[0] === 'archive') return { scope: 'global', track: 'archive', projectId: null, date: null }
  return { scope: 'global', track: trackForStem(stem), projectId: null, date: null }
}

function trackForStem(stem) {
  const lower = String(stem).toLowerCase()
  if (lower === 'memory') return 'memory'
  if (lower === 'key') return 'key'
  if (lower === 'user') return 'user'
  if (lower === 'suggestions') return 'queue'
  // 待巩固队列（2026-10-30）：无 confirm 的 user/memory/key 写入落这里。
  // 与 SUGGESTIONS 同轨（都是候选），但用 Markdown §/时间戳分隔、可走同一套锁。
  if (lower === 'queue') return 'queue'
  // 月摘要轨（分层压缩的"温区"）：`DIGEST.md` / `projects/<id>/DIGEST.md`。
  // 它**要**进常驻索引（密度高、是线索），所以不能落进归档轨。
  if (lower === 'digest') return 'digest'
  // 全局概览（`OVERVIEW.md`）：一屏看完的摘要，是"该记住什么"的顶层线索。
  if (lower === 'overview') return 'overview'
  // 全局记忆（`GLOBAL.md`，槽位模型）：v0.4 起的主入口，一槽一句话、几百字。
  if (lower === 'global') return 'global'
  // 归档轨有**两种磁盘形态**，必须归入同一轨：
  //   ① 目录形态 `archive/*.md`（本插件早期的私名，见 classifyFile）；
  //   ② 文件名形态 `MEMORY-archive.md` / `USER-archive.md` / `KEY-archive.md`
  //      / `TODO-archive.md`（与 dsh-memory-evolve 的 ArchiveStore 同名约定）。
  // 漏掉 ② 的后果不是"看不见"，而是**归档条目被当成普通记忆重新注入**
  // （NEVER_INJECT 与 includeArchived 过滤都按 track==='archive' 判定）。
  if (lower === 'archive' || lower.endsWith('-archive')) return 'archive'
  return lower.replace(/[^a-z0-9_-]+/g, '-') || 'unknown'
}

/**
 * 扫描一个记忆根目录，返回全部条目与文件清单。
 *
 * @param {string} root - 记忆根目录绝对路径。
 * @param {object} [opts] - { maxFiles, maxDepth, now }。
 * @returns {{root: string, exists: boolean, entries: object[], files: object[], skipped: object[]}}
 */
export function scanRoot(root, opts = {}) {
  const now = opts.now ?? Date.now()
  const result = { root, exists: existsSync(root), entries: [], files: [], skipped: [] }
  if (!result.exists) return result

  const paths = listFiles(root, {
    maxFiles: opts.maxFiles ?? 5000,
    maxDepth: opts.maxDepth ?? 6,
    filter: (p) => extname(p).toLowerCase() === '.md',
  })

  for (const path of paths) {
    const rel = relativePosix(root, path)
    let stat
    try {
      stat = statSync(path)
    } catch {
      result.skipped.push({ rel, reason: 'stat-failed' })
      continue
    }
    if (stat.size > MAX_FILE_BYTES) {
      result.skipped.push({ rel, reason: 'too-large', bytes: stat.size })
      continue
    }

    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      result.skipped.push({ rel, reason: 'read-failed' })
      continue
    }

    const meta = classifyFile(rel)
    const chunks = splitIntoEntries(text, rel)
    const fileHash = sha1hex(text, 20)
    const fileEntries = []

    for (const chunk of chunks) {
      const body = chunk.body
      const date = entryDateOf(body, meta.date)
      const entry = {
        entryId: stableEntryId(rel, chunk.ordinal, body),
        scope: meta.scope,
        track: meta.track,
        projectId: meta.projectId,
        projectLabel: null,
        root,
        path,
        rel,
        ordinal: chunk.ordinal,
        stamp: chunk.stamp,
        date,
        time: entryTimeOf(body),
        /** 条目级新旧排序键（同一文件里所有条目的 mtime 相同，单靠 mtime 分不出先后）。 */
        recencyKey: `${date ?? ''}T${entryTimeOf(body) ?? '00:00'}`,
        summary: extractSummary(body),
        body,
        chars: body.length,
        bytes: Buffer.byteLength(body, 'utf8'),
        mtime: stat.mtimeMs,
        ageDays: date ? daysBetween(date, now) : null,
        contentHash: fileHash,
        idTag: ID_RE.exec(body)?.[1] ?? null,
        branchTag: BRANCH_RE.exec(body)?.[1] ?? null,
        supersededBy: SUPERSEDED_RE.exec(body)?.[1] ?? null,
        dshOnly: DSH_ONLY_RE.test(body),
        indexedBody: body.slice(0, MAX_INDEX_BODY_CHARS),
      }
      result.entries.push(entry)
      fileEntries.push(entry.entryId)
    }

    result.files.push({
      path,
      rel,
      root,
      mtime: stat.mtimeMs,
      size: stat.size,
      hash: fileHash,
      entryCount: fileEntries.length,
      scope: meta.scope,
      track: meta.track,
      projectId: meta.projectId,
    })
  }

  return result
}

/** 两个日期（YYYY-MM-DD 与毫秒时间戳）之间相差的天数，向下取整。 */
export function daysBetween(dateStamp, nowMs) {
  const parsed = Date.parse(`${dateStamp}T00:00:00`)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000))
}

/**
 * 检索/索引共用的分词器。
 *
 * 取舍：**不引入中文分词库**（结巴之类会带来词典体积与版本维护成本）。
 * 用「CJK bigram + ASCII 词」的方案——这是中文全文检索的经典做法，
 * 覆盖率高、零依赖、可解释；配合 FTS5 的 BM25 排序，效果足够且完全本地。
 * 短整段（≤6 字）额外整串入索引，提升短语精确命中。
 *
 * @param {string} text - 待分词文本。
 * @returns {string[]} 去重后的 token 列表。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = new Set()

  for (const match of s.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    const word = match[0].replace(/^[.-]+|[.-]+$/g, '')
    if (word.length >= 2) tokens.add(word)
  }

  const cjkRuns = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) { tokens.add(run); continue }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
    if (run.length <= 6) tokens.add(run)
  }

  return [...tokens]
}

/** 分词后拼成 FTS5 MATCH 表达式（每个 token 用 OR 连接）。 */
export function toMatchExpression(text) {
  const tokens = tokenize(text).slice(0, 40)
  if (tokens.length === 0) return ''
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

/**
 * 在没有 memory-evolve（或记忆根为空）时自建记忆布局。
 *
 * **2026-11-04 起默认补齐"全部应有文件"**（不只是 MEMORY/USER 两个空文件）：
 * 记忆根是用户能直接打开的目录，缺文件时"这套记忆到底有哪些轨、各管什么"只能
 * 靠文档猜；补齐后打开即见结构，且每个文件头部都有一句功能说明（`filedocs.headerNote`）。
 *
 * 三条纪律：
 *  1. **绝不覆盖已有文件**（只写"不存在"的路径），已有内容一个字都不动；
 *  2. **派生物不预建**（`OVERVIEW.md` / `DIGEST.md` / 归档）：预建会让"是否已生成"
 *     的判据失真，也违背"派生物只由生成流程产出"（见 `filedocs.PRECREATE` 的注释）；
 *  3. **项目目录只在已存在时补齐**：不凭 cwd 猜项目身份去新建目录（猜错就是垃圾目录）。
 *
 * @param {string} root - 记忆根目录。
 * @param {object} [opts] - { precreate=true, projectDirs=[], today='YYYY-MM-DD' }。
 * @returns {{created: string[]}} 新建的路径（目录与文件）。
 */
export function ensureRootLayout(root, opts = {}) {
  const created = []
  const precreate = opts.precreate !== false
  const today = opts.today ?? dateStamp()

  for (const dir of [root, join(root, 'daily'), join(root, 'projects')]) {
    if (!existsSync(dir)) { ensureDir(dir); created.push(dir) }
  }

  /** 写一个文件（不存在才写），created 里记的是绝对路径。 */
  const put = (dir, rel, contentRel = rel) => {
    const full = join(dir, rel)
    if (existsSync(full)) return
    try {
      ensureDir(dirname(full))
      writeFileAtomic(full, initialContent(contentRel), { mode: 0o600 })
      created.push(full)
    } catch { /* 建不出来不影响插件装载（降级为旧布局） */ }
  }

  const rootList = precreate ? PRECREATE.global : ['MEMORY.md', 'USER.md']
  for (const rel of rootList) put(root, rel.replace('<today>', today))

  if (precreate) {
    for (const dir of opts.projectDirs ?? []) {
      const id = basename(dir)
      for (const rel of PRECREATE.project) {
        const named = rel.replace('<today>', today)
        put(dir, named, `projects/${id}/${named}`)
      }
    }
  }

  return { created }
}

function clip(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}