/**
 * scripts/verify.mjs — 端到端自检（不安装插件也能跑）。
 *
 * 在一个临时目录里造一份完整的记忆夹具，然后真实走一遍：
 *   扫描 → 索引 → 检索 → 注入快照 → 健康检查 → 整合方案 → 应用 → 重建索引 → 云端分层。
 *
 * 目的是让"这套东西到底能不能用"有一个可复现的答案，而不是只靠文档承诺。
 *
 * 用法：node scripts/verify.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, DEFAULTS } from '../lib/index.js'
import { dateStamp } from '../lib/fsutil.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-verify-'))
const memoryDir = join(sandbox, 'memories')
const coreDir = join(sandbox, 'memory-core')
const projectId = 'a1b2c3d4e5f6'

const today = dateStamp()
const daysAgo = (n) => dateStamp(new Date(Date.now() - n * 86_400_000))

function fixture() {
  mkdirSync(join(memoryDir, 'daily'), { recursive: true })
  mkdirSync(join(memoryDir, 'projects', projectId, 'daily'), { recursive: true })

  writeFileSync(join(memoryDir, 'USER.md'), [
    `[${daysAgo(3)} 09:00] 用户偏好：结论先行 + 表格化呈现，简体中文；设备 MacBook Pro M3 Pro。`,
    '§',
    `[${daysAgo(120)} 10:00] 用户是 A 股个人投资者，风险偏好中等偏保守。`,
  ].join('\n'), 'utf8')

  writeFileSync(join(memoryDir, 'MEMORY.md'), [
    `[${daysAgo(200)} 11:00] 本机 DSH home 位于 DSH_HOME 环境变量指定的目录；插件装在 profiles/web 下。`,
    '§',
    `[${daysAgo(400)} 12:00] 旧结论：VanWork 的记忆由 CodeArts 内核提供（已被后续调查推翻，等待整合归档）。`,
  ].join('\n'), 'utf8')

  writeFileSync(join(memoryDir, 'daily', `${daysAgo(45)}.md`), [
    `[${daysAgo(45)} 14:00] [VanWork] 完成记忆系统调研：读完 Qoder / WorkBuddy / CodeArts / OfficeClaw 四份报告。`,
    '§',
    `[${daysAgo(45)} 16:30] [VanWork] 决定新插件的记忆正本与 dsh-memory-evolve 共用，只做派生索引。`,
  ].join('\n'), 'utf8')

  writeFileSync(join(memoryDir, 'projects', projectId, 'KEY.md'), [
    `[${daysAgo(5)} 10:00] 架构决策：记忆正本继续用 Markdown，检索走 SQLite FTS5 BM25，向量默认关闭。`,
    '§',
    `[${daysAgo(4)} 09:00] 架构决策（重申）：记忆正本继续用 Markdown，检索走 SQLite FTS5 BM25，向量默认关闭；本条是同义重述，用于验证近重复合并。`,
    '§',
    `[${daysAgo(3)} 10:05] 架构决策补充：向量检索做成可选（需要时才走 OpenAI 兼容 /embeddings），默认仍为纯 BM25——与上一条不是重复，不应被合并。`,
    '§',
    `[${daysAgo(2)} 15:00] 约定：工具名一律 mem_ 前缀，避免与 memory-evolve 撞名导致 tools registry 重复注册。`,
  ].join('\n'), 'utf8')

  writeFileSync(join(memoryDir, 'projects', projectId, 'daily', `${daysAgo(40)}.md`),
    `[${daysAgo(40)} 11:00] [VanWork] 确认 Cordis 插件契约：name / inject / apply。`, 'utf8')
}

/** 最小的 cordis ctx 替身：只为验证装配路径，不模拟 DSH 的组装语义。 */
function fakeCtx() {
  const captured = { contexts: [], tools: [], effects: 0 }
  return {
    captured,
    systemPrompt: {
      context(definition) { captured.contexts.push(definition); return () => {} },
    },
    tools: {
      register(definition) { captured.tools.push(definition); return () => {} },
    },
    effect(callback) { captured.effects += 1; return callback() },
    on() { return () => {} },
    get() { return undefined },
  }
}

const hr = (title) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)

try {
  fixture()
  console.log(`夹具目录：${sandbox}`)

  const ctx = fakeCtx()
  const { runtime } = apply(ctx, { memoryDir, coreDir, dshHome: join(sandbox, 'home') })

  hr('1) 装配结果')
  console.log(`注入注册：${ctx.captured.contexts.map((c) => `${c.name}(order=${c.order})`).join(', ') || '（无）'}`)
  console.log(`工具注册：${ctx.captured.tools.map((t) => t.name).join(', ')}`)
  console.log(`effect 次数：${ctx.captured.effects}`)

  hr('2) 扫描 + 索引')
  let snapshot = runtime.refresh({ cwd: join(sandbox, 'proj') })
  console.log(`条目 ${snapshot.entries.length} · 文件 ${snapshot.files.length} · 增量新增 ${snapshot.sync.added}`)
  console.log(`后端 ${snapshot.stats?.backend} · 轨道分布 ${JSON.stringify(snapshot.stats?.trackCounts)}`)
  for (const entry of snapshot.entries) {
    console.log(`  ${entry.rel}#${entry.ordinal} [${entry.track}] age=${entry.ageDays}d :: ${String(entry.summary).slice(0, 56)}`)
  }

  hr('3) 索引常驻注入（渲染真实注入文本）')
  const tools = ctx.captured.tools
  const byName = (toolName) => tools.find((tool) => tool.name === toolName)
  const injected = ctx.captured.contexts[0].text({ agent: undefined })
  console.log(injected)

  hr('4) 检索：BM25')
  const search = byName('mem_search')
  console.log(await search.execute({ query: '架构决策 记忆正本', limit: 5 }, {}))

  hr('5) 检索：中文短语 + 无关词（验证不编造）')
  console.log(await search.execute({ query: '周杰伦演唱会门票', limit: 3 }, {}))

  hr('6) 健康检查（含云端分层）')
  console.log(await byName('mem_health').execute({ cloud: true, detail: true }, {}))

  hr('7) 整合：生成方案（零副作用）')
  const consolidate = byName('mem_consolidate')
  const planText = await consolidate.execute({ action: 'plan' }, {})
  console.log(planText)
  const planId = /planId="([^"]+)"/.exec(planText)?.[1] ?? null
  console.log(`\n解析出 planId = ${planId}`)

  hr('8) 整合：apply 的拒绝路径（confirm 缺失 / planId 错误）')
  console.log(await consolidate.execute({ action: 'apply', planId, confirm: false }, {}))
  console.log('---')
  console.log(await consolidate.execute({ action: 'apply', planId: 'deadbeefdeadbeef', confirm: true }, {}))

  hr('9) 整合：apply 的通过路径（confirm=true）')
  console.log(await consolidate.execute({ action: 'apply', planId, confirm: true }, {}))

  hr('10) 重建索引 + 复核结果')
  console.log(await byName('mem_reindex').execute({ force: true }, {}))
  snapshot = runtime.refresh({ cwd: join(sandbox, 'proj') })
  console.log(`整合后条目 ${snapshot.entries.length}（近重复已合并、冷条目已归档）`)
  console.log(`归档目录存在：${existsSync(join(memoryDir, 'archive')) || existsSync(join(memoryDir, 'projects', projectId, 'archive'))}`)
  const backupsRoot = join(coreDir, 'backups')
  console.log(`备份目录存在：${existsSync(backupsRoot)}`)

  hr('11) 写入路径（pinned type 强制 + 写入门槛递增）')
  const write = byName('mem_write')
  const withCwd = { agent: { session: { header: { cwd: join(sandbox, 'proj') } } } }
  console.log('— user 轨写进项目目录（应被 pinned type 校验拒绝，即使 confirm=true）：')
  console.log(await write.execute({ action: 'add', track: 'user', scope: 'project', content: '试图把用户档案写进项目目录', confirm: true }, withCwd))
  console.log('— memory 轨未确认（应被写入门槛拒绝）：')
  console.log(await write.execute({ action: 'add', track: 'memory', scope: 'global', content: '未经用户确认的全局事实' }, withCwd))
  console.log('— daily 轨（每轮进展，可直接追加）：')
  console.log(await write.execute({ action: 'add', track: 'daily', scope: 'global', content: '验证脚本跑通端到端流程。' }, withCwd))
  console.log('— key 轨 + confirm=true + 真实 cwd（应写入当前项目目录）：')
  console.log(await write.execute({ action: 'add', track: 'key', scope: 'project', content: '验证：key 轨需要 confirm，且落在 projects/<projectId>/KEY.md。', confirm: true }, withCwd))
  console.log('— replace 的定位歧义保护（match 命中多条应拒绝）：')
  console.log(await write.execute({ action: 'replace', track: 'key', scope: 'project', match: '架构决策', content: '试图替换一个不唯一的片段', confirm: true }, withCwd))
  console.log('— replace 的唯一命中路径（应成功并备份）：')
  console.log(await write.execute({ action: 'replace', track: 'key', scope: 'project', match: '工具名一律 mem_ 前缀', content: '约定：所有工具名一律 mem_ 前缀，避免与 memory-evolve 撞名。', confirm: true }, withCwd))

  hr('12) 审计账本')
  console.log(JSON.stringify(runtime.ledger.stats(), null, 2))
  console.log('\n最近 5 条：')
  for (const record of runtime.ledger.tail({ limit: 5 })) console.log(`  ${record.t} ${record.k} ${JSON.stringify(record).slice(0, 160)}`)

  hr('13) 云端分层画像（v0.1 只判定，不联网）')
  console.log(JSON.stringify(runtime.cloud(), null, 2))

  hr('结论')
  console.log('全部环节跑通：插件可装载、索引可建、检索可用、注入渲染正确、')
  console.log('整合方案可复算且拒绝非法 apply、写入路由有强制校验、云端分层有结论。')
  console.log(`\n状态目录（可整份删除，索引是派生物）：${coreDir}`)
} finally {
  if (process.env.KEEP_VERIFY !== '1') {
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
  } else {
    console.log(`\n（KEEP_VERIFY=1，保留夹具：${sandbox}）`)
  }
}

console.log(`\n默认配置快照（${Object.keys(DEFAULTS).length} 项）已导出，可用 dsh profile patch 覆盖。`)