/**
 * 预建记忆文件（v0.6.1，`precreateFiles` 默认开）的回归测试。
 *
 * 用户要求：**默认创建所有 md 的空文件，即使规则没触发**，且空文件里要带功能说明。
 *
 * 这组用例守的是"加说明"这件事不产生副作用——它的风险全在解析层：
 *  1. 带说明的空文件必须是 **0 条目**（说明不是记忆）；
 *  2. 说明必须**原样留在文件头**，不被 append/replace 当成"已有的一条"吃掉或覆盖；
 *  3. `# 记忆` 这种"只有标题的块"不算条目（存量 GLOBAL.md 的第 1 条就是它）；
 *  4. 预建**绝不覆盖已有内容**，且可整体关闭（`precreateFiles: false`）；
 *  5. 派生物（OVERVIEW / DIGEST / 归档）**不预建**——出现即代表"已生成"。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it } from 'node:test'

import { createRuntime } from '../lib/runtime.js'
import { appendEntry, readChunks, removeEntries, replaceEntry } from '../lib/memfile.js'
import { ensureRootLayout, scanRoot, splitHeaderComments, splitIntoEntries } from '../lib/scanner.js'
import { dateStamp } from '../lib/fsutil.js'
import { PRECREATE, describeFile, headerNote, initialContent } from '../lib/filedocs.js'
import { listDevFiles } from '../lib/devfiles.js'
import { buildRoutes } from '../lib/api.js'

const sandbox = mkdtempSync(join(tmpdir(), 'memcore-precreate-'))
after(() => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 尽力清理 */ } })

let memoryDir
let coreDir
beforeEach(() => {
  memoryDir = mkdtempSync(join(sandbox, 'mem-'))
  coreDir = mkdtempSync(join(sandbox, 'core-'))
})

const quiet = () => ({ info() {}, warn() {}, error() {} })
const today = () => dateStamp()

describe('启动即补齐应有文件', () => {
  it('空目录启动后，root 级的应有文件全部存在', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    for (const rel of PRECREATE.global) {
      const named = rel.replace('<today>', today())
      assert.ok(existsSync(join(memoryDir, named)), `应预建 ${named}`)
    }
  })

  it('每个预建文件都带功能说明（HTML 注释在文件最前）', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    for (const rel of PRECREATE.global) {
      const named = rel.replace('<today>', today())
      const text = readFileSync(join(memoryDir, named), 'utf8')
      assert.match(text, /^<!--/, `${named} 应以说明注释开头`)
      assert.match(text, /作用：/, `${named} 的说明应含"作用："`)
      assert.match(text, new RegExp(describeFile(named).title), `${named} 的说明应含角色名`)
    }
  })

  it('带说明的空文件仍是 0 条目（说明不是记忆）', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    const snap = scanRoot(memoryDir)
    assert.deepEqual(snap.entries.map((e) => e.rel), [], '预建的空文件不得产生任何条目')
    // 写入侧同样把它当空文件
    for (const rel of PRECREATE.global) {
      const named = rel.replace('<today>', today())
      assert.deepEqual(readChunks(join(memoryDir, named)).chunks, [], `${named} 写入侧也应是 0 条`)
    }
  })

  it('`# 记忆` 这种只有标题的块不算条目', () => {
    const entries = splitIntoEntries(`${headerNote('GLOBAL.md')}\n# 记忆\n`, 'GLOBAL.md')
    assert.deepEqual(entries, [], '文件标题不是记忆')
    // 有槽时槽才是条目
    const withSlot = splitIntoEntries(`${headerNote('GLOBAL.md')}\n# 记忆\n\n## 身份\n深圳。\n`, 'GLOBAL.md')
    assert.equal(withSlot.length, 1)
    assert.match(withSlot[0].body, /## 身份/)
  })

  it('预建绝不覆盖已有内容', () => {
    writeFileSync(join(memoryDir, 'MEMORY.md'), '[2026-11-04 09:00] 已有内容\n', 'utf8')
    const before = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    assert.equal(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8'), before, '已有文件一个字都不该变')
  })

  it('precreateFiles=false → 退回旧行为（只建 MEMORY/USER）', () => {
    createRuntime({ config: { memoryDir, coreDir, precreateFiles: false }, logger: quiet() })
    assert.ok(existsSync(join(memoryDir, 'MEMORY.md')))
    assert.ok(existsSync(join(memoryDir, 'USER.md')))
    assert.equal(existsSync(join(memoryDir, 'GLOBAL.md')), false)
    assert.equal(existsSync(join(memoryDir, 'QUEUE.md')), false)
    assert.equal(existsSync(join(memoryDir, 'daily', `${today()}.md`)), false)
  })

  it('项目目录已存在时才补齐项目级文件（不猜身份新建目录）', () => {
    const projectDir = join(memoryDir, 'projects', 'abc123def456')
    mkdirSync(projectDir, { recursive: true })
    const result = ensureRootLayout(memoryDir, { projectDirs: [projectDir] })
    for (const rel of PRECREATE.project) {
      const named = rel.replace('<today>', today())
      assert.ok(existsSync(join(projectDir, named)), `应预建 projects/.../${named}`)
    }
    assert.ok(result.created.length > 0)
    // 没给 projectDirs 时不新建任何项目目录
    const fresh = mkdtempSync(join(sandbox, 'fresh-'))
    ensureRootLayout(fresh)
    assert.equal(existsSync(join(fresh, 'projects', 'abc123def456')), false)
  })

  it('派生物不预建', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    for (const rel of ['OVERVIEW.md', 'DIGEST.md', 'MEMORY-archive.md']) {
      assert.equal(existsSync(join(memoryDir, rel)), false, `${rel} 是派生物，不该预建`)
    }
    const files = readdirSync(memoryDir)
    assert.ok(files.includes('GLOBAL.md') && !files.includes('OVERVIEW.md'))
  })
})

describe('说明注释与写入互不干扰', () => {
  it('append 后说明仍在最前，且只多一条真实条目', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    const file = join(memoryDir, 'MEMORY.md')
    appendEntry(file, '[2026-11-04 10:00] 第一条真实记忆', {})

    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^<!--/, '说明注释必须留在文件头')
    const { header, rest } = splitHeaderComments(raw)
    assert.match(header, /记忆文件说明/)
    assert.doesNotMatch(rest, /记忆文件说明/, '正文里不该再出现说明（说明不被复制）')
    assert.deepEqual(readChunks(file).chunks, ['[2026-11-04 10:00] 第一条真实记忆'])
  })

  it('replace 不把说明当成"已有的一条"', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    const file = join(memoryDir, 'MEMORY.md')
    appendEntry(file, '[2026-11-04 10:00] 旧结论', {})
    const outcome = replaceEntry(file, '[2026-11-04 10:00] 旧结论', '[2026-11-04 10:05] 新结论', {})
    assert.equal(outcome.replaced, 1)
    const raw = readFileSync(file, 'utf8')
    assert.match(raw, /^<!--/)
    assert.deepEqual(readChunks(file).chunks, ['[2026-11-04 10:05] 新结论'])
    // 说明只出现一次（没被复制/累加）
    assert.equal((raw.match(/记忆文件说明/g) ?? []).length, 1)
  })

  it('remove 掉所有条目后说明仍保留（不会把文件写成空）', () => {
    createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    const file = join(memoryDir, 'QUEUE.md')
    const entry = '[2026-11-04 10:00] [queue:key|project|x] 候选'
    appendEntry(file, entry, {})
    const outcome = removeEntries(file, [entry], {})
    assert.equal(outcome.removed, 1)
    assert.deepEqual(readChunks(file).chunks, [])
    assert.match(readFileSync(file, 'utf8'), /^<!--/, '条目清空后说明仍在')
  })

  it('兼容旧格式：`# 记忆` 在前、注释紧随其后（存量文件一个字节都不用改）', () => {
    const legacy = '# 记忆\n\n<!-- 由记忆插件维护：每个 ## 是一个槽，一槽一句话。\n     改这里只改这一份。 -->\n\n## 身份\n蔡润泽，深圳。\n'
    const { header, rest } = splitHeaderComments(legacy)
    assert.match(header, /# 记忆/, '标题应被认成页眉')
    assert.match(header, /由记忆插件维护/, '注释应被认成页眉')
    assert.doesNotMatch(rest, /# 记忆/)
    const entries = splitIntoEntries(legacy, 'GLOBAL.md')
    assert.equal(entries.length, 1, '只有槽算条目（修复前这里会多出一条 body 为 `# 记忆` 的垃圾条目）')
    assert.match(entries[0].body, /## 身份/)
    // 写入侧同样不把标题当条目
    const tmp = join(memoryDir, 'GLOBAL.md')
    writeFileSync(tmp, legacy, 'utf8')
    assert.equal(readChunks(tmp).chunks.length, 1)
    assert.match(readChunks(tmp).header, /# 记忆/)
  })

  it('没有注释的文件：开头的一级标题仍是内容（不擅自当页眉）', () => {
    const text = '# 我的笔记\n第一条内容\n'
    const { header, rest } = splitHeaderComments(text)
    assert.equal(header, '', '没有注释就不该吃掉标题')
    assert.equal(rest, text)
  })

  it('initialContent 的形态：GLOBAL 带标题，其它不带', () => {
    assert.match(initialContent('GLOBAL.md'), /# 记忆\s*$/)
    assert.doesNotMatch(initialContent('USER.md'), /# 记忆/)
    assert.match(initialContent('USER.md'), /^<!--/)
  })

  it('说明里的角色名与开发者模式列表一致（同一份文案）', () => {
    for (const rel of ['GLOBAL.md', 'USER.md', 'MEMORY.md', 'QUEUE.md', 'daily/2026-11-04.md', 'projects/x/KEY.md']) {
      const doc = describeFile(rel)
      assert.ok(headerNote(rel).includes(doc.title), `${rel}：文件头说明应含列表里的角色名`)
      assert.ok(headerNote(rel).includes(doc.injectLabel), `${rel}：文件头说明应含注入方式`)
    }
  })
})

describe('开发者模式能看到"应有但还没有"的文件', () => {
  it('清单里带 missing 行，派生物标 derived', async () => {
    const rt = createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    rt.setDevMode(true)
    const routes = buildRoutes(rt)
    const state = routes.find((r) => r.path === '/api/memory-core/dev' && r.method === 'GET').handler()
    const rels = state.files.map((row) => row.rel)
    assert.ok(rels.includes('GLOBAL.md'))
    assert.ok(rels.includes('OVERVIEW.md'), '派生物也应出现在清单里')
    const overview = state.files.find((row) => row.rel === 'OVERVIEW.md')
    assert.equal(overview.missing, true)
    assert.equal(overview.reason, 'derived')
    assert.equal(overview.inject, 'derived')
    // 已存在的预建文件不是 missing
    assert.equal(state.files.find((row) => row.rel === 'GLOBAL.md').missing, false)
  })

  it('打开开发者模式会补齐当天的 daily（跨天后点开即完整）', async () => {
    const rt = createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    const todayFile = join(memoryDir, 'daily', `${today()}.md`)
    rmSync(todayFile, { force: true }) // 模拟"过了零点、进程还没重启"
    assert.equal(existsSync(todayFile), false)

    rt.setDevMode(true)
    const routes = buildRoutes(rt)
    routes.find((r) => r.path === '/api/memory-core/dev' && r.method === 'GET').handler()
    assert.ok(existsSync(todayFile), '打开面板应补齐当天的 daily')
  })

  it('precreateFiles=false 时，打开面板也不建文件（尊重显式关闭）', () => {
    const rt = createRuntime({ config: { memoryDir, coreDir, precreateFiles: false }, logger: quiet() })
    rt.setDevMode(true)
    const routes = buildRoutes(rt)
    routes.find((r) => r.path === '/api/memory-core/dev' && r.method === 'GET').handler()
    assert.equal(existsSync(join(memoryDir, 'GLOBAL.md')), false, '用户显式关掉了预建，面板不该偷偷建')
  })

  it('关闭开发者模式时不动盘（不产生文件）', () => {
    const rt = createRuntime({ config: { memoryDir, coreDir, precreateFiles: false }, logger: quiet() })
    const routes = buildRoutes(rt)
    routes.find((r) => r.path === '/api/memory-core/dev' && r.method === 'GET').handler()
    assert.equal(existsSync(join(memoryDir, 'GLOBAL.md')), false, '开关关着就不该有副作用')
  })

  it('未创建的文件可以直接新建（base 传空串）', async () => {
    const rt = createRuntime({ config: { memoryDir, coreDir }, logger: quiet() })
    rt.setDevMode(true)
    const routes = buildRoutes(rt)
    const post = routes.find((r) => r.path === '/api/memory-core/devfile' && r.method === 'POST')
    const result = await post.handler(fakeReq({ rel: 'DIGEST.md', base: '', content: '手写的月摘要\n' }))
    assert.equal(result.status, 200)
    assert.equal(readFileSync(join(memoryDir, 'DIGEST.md'), 'utf8'), '手写的月摘要\n')
  })

  it('listDevFiles 会把"应有"的文件都覆盖到（不依赖磁盘）', () => {
    const rows = listDevFiles(memoryDir)
    const rels = new Set(rows.map((row) => row.rel))
    assert.ok(rels.has('GLOBAL.md'))
    assert.ok(rels.has('QUEUE.md'))
    assert.ok(rels.has(`daily/${today()}.md`))
    assert.ok(rows.every((row) => row.title && row.what && row.injectLabel))
  })
})

/** 假请求对象（只提供 readJsonBody 需要的事件流）。 */
function fakeReq(payload) {
  const body = JSON.stringify(payload)
  const req = {
    method: 'POST',
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(body, 'utf8'))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  return req
}
