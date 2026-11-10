/* 记忆管理面板 —— 只展示「记忆」本身，加改与更新两个动作。
 *
 * 用户 2026-10-28 的要求（照做，不要再往回加）：
 *   - 只展示这一份记忆，条目列表/筛选/统计/体检/修订记录**都不显示**（后端接口还在，需要时再加）；
 *   - 不出现"全局概览"这类字眼，直接就是内容；
 *   - 可编辑：按钮叫「修改记忆」；改完保存：按钮叫「更新记忆」；
 *   - **不要**「重新生成」「重新载入」——因为不存在"从头再来"，只有增量合并。
 *
 * 数据：宿主 `/api/memory-core/global`
 *   GET  → { text, slots, exists, chars, updatedAt }
 *   POST → { base, content }（手改）或 { base, ops }（模型合并）
 *
 * 2026-11-02 加：顶部「启用记忆」总开关（`/api/memory-core/switch`）——
 * 停用 = 不注入索引、mem_* 工具不读写；文件保留，勾选即恢复。详见 README 8.10。
 *
 * 2026-11-04 加：「开发者模式」开关（`/api/memory-core/dev`）——打开后列出记忆根下
 * **全部 .md**，每个文件带一句"它是干什么的"，点开即整份查看/编辑
 * （`/api/memory-core/devfile`）。默认关闭，关闭时后端一律 403。
 */
window.__ModuleLoader__.load({ id: 'vanwork-memory-core', factory: require => {
  const { createElement: h, useEffect, useState, useCallback } = require('react')

  const api = async (path, init) => {
    const response = await fetch('/api/memory-core' + path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(15000),
      ...init,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`)
      error.status = response.status
      throw error
    }
    return payload
  }

  const btn = { padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-color, #ccc)', background: 'var(--button-bg, #fff)', cursor: 'pointer' }
  const muted = { color: 'var(--text-secondary, #666)', fontSize: 13 }
  const tiny = { color: 'var(--text-secondary, #666)', fontSize: 12, lineHeight: 1.55 }
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13 }
  const rowBox = { padding: '10px 12px', border: '1px solid var(--border-color, #e5e5e5)', borderRadius: 8, marginBottom: 8 }

  /** 文件行：路径 + 信号灯 + 一句话功能。点一下进编辑（未创建的点了即新建）。 */
  function FileRow({ row, onOpen }) {
    const state = row.missing
      ? (row.reason === 'derived' ? '未创建 · 派生物，首次生成时出现' : '未创建 · 点一下即创建')
      : (row.empty ? '空文件' : `${row.bytes} 字节`)
    return h('div', {
      style: { ...rowBox, cursor: 'pointer', ...(row.missing ? { borderStyle: 'dashed', opacity: 0.75 } : {}) },
      onClick: onOpen, role: 'button', tabIndex: 0,
      onKeyDown: (e) => { if (e.key === 'Enter') onOpen() },
    },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
      h('span', { style: { ...mono, fontWeight: 600 } }, row.rel),
      h('span', { style: { ...tiny, color: 'var(--text-secondary, #888)' } }, `${row.dot} ${row.injectLabel} · ${state}`)),
    h('div', { style: { ...tiny, marginTop: 4, color: 'var(--text-primary, #333)' } },
      h('strong', null, `${row.title}：`), row.what))
  }

  /** 开发者模式的编辑器：说明块 + 整份 textarea + 保存/取消。 */
  function DevEditor({ file, onDone, onError }) {
    const [draft, setDraft] = useState(file.text)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const dirty = draft !== file.text

    async function save() {
      setBusy(true); setNotice('')
      try {
        await api('/devfile', { method: 'POST', body: JSON.stringify({ rel: file.rel, base: file.text, content: draft }) })
        setNotice('已保存')
        onDone()
      } catch (e) {
        if (e.status === 409) setNotice('这个文件在你编辑期间被改过了。请返回列表重新打开。')
        else onError(e.message)
      } finally { setBusy(false) }
    }

    return h('div', null,
      h('div', { style: { ...rowBox, background: 'var(--surface-secondary, #fafafa)' } },
        h('div', { style: { ...mono, fontWeight: 600, marginBottom: 4 } },
          file.rel, file.exists === false ? h('span', { style: { ...tiny, marginLeft: 8 } }, '（未创建 · 保存即创建）') : null),
        h('div', { style: { ...tiny, color: 'var(--text-primary, #333)' } },
          h('strong', null, `${file.doc.title}（${file.doc.injectLabel}）：`), file.doc.what),
        h('div', { style: { ...tiny, marginTop: 4 } }, `⚠️ ${file.doc.note}`)),
      notice ? h('p', { role: 'status', style: { color: '#0a6', fontSize: 13 } }, notice) : null,
      h('textarea', {
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        spellCheck: false,
        style: { width: '100%', minHeight: 360, padding: 10, lineHeight: 1.6, ...mono },
      }),
      h('p', { style: { ...tiny, margin: '6px 0 10px' } },
        '保存 = 整份替换该文件（改前自动备份到 memory-core/backups，并记一条修订）。'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { style: { ...btn, fontWeight: 600 }, disabled: busy || !dirty, onClick: () => { void save() } },
          busy ? '保存中…' : '保存文件'),
        h('button', { style: btn, disabled: busy, onClick: onDone }, '取消')))
  }

  /** 文件列表：按目录分组（根 → daily/ → projects/<id>/），组内已按角色排序。 */
  function FileList({ rows, onOpen }) {
    const groups = []
    for (const row of rows) {
      const last = groups[groups.length - 1]
      if (last && last.name === row.group) last.rows.push(row)
      else groups.push({ name: row.group, rows: [row] })
    }
    if (rows.length === 0) return h('p', { style: muted }, '记忆根下还没有任何 .md 文件。')
    return h('div', null, groups.map((group) => h('div', { key: group.name, style: { marginBottom: 14 } },
      h('div', { style: { ...tiny, fontWeight: 600, marginBottom: 6, letterSpacing: 0.3 } }, group.name),
      group.rows.map((row) => h(FileRow, { key: row.rel, row, onOpen: () => onOpen(row.rel) })))))
  }

  /** 把 GLOBAL.md 文本渲染成只读视图：每个 `## 槽` 变成一段小标题 + 内容。 */
  function ReadView({ text }) {
    const blocks = []
    let current = null
    for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim()
      if (line.startsWith('<!--') || line.startsWith('# ')) continue
      const slot = /^##\s+(.+)$/.exec(line)
      if (slot) { current = { name: slot[1].trim(), lines: [] }; blocks.push(current); continue }
      if (current && line !== '') current.lines.push(line)
    }
    if (blocks.length === 0) return h('p', { style: muted }, '还没有内容。点「修改记忆」写下第一段。')
    return h('div', null, blocks.map((block) => h('div', { key: block.name, style: { marginBottom: 14 } },
      h('div', { style: { fontWeight: 600, marginBottom: 4 } }, block.name),
      h('div', { style: { lineHeight: 1.6 } }, block.lines.join(' ')))))
  }

  function Panel() {
    const [data, setData] = useState(null)
    const [draft, setDraft] = useState('')
    const [editing, setEditing] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [sw, setSw] = useState(null) // { enabled }；null = 还没取到
    const [dev, setDev] = useState(null) // { enabled, files, count, memoryDir }；null = 宿主不支持
    const [file, setFile] = useState(null) // 开发者模式下正在编辑的文件

    const load = useCallback(async () => {
      try {
        const result = await api('/global')
        setData(result)
        setDraft(result.text)
        setError('')
      } catch (e) { setError(e.message) }
    }, [])

    const loadSwitch = useCallback(async () => {
      try { setSw(await api('/switch')) } catch { /* 开关接口失败不打断记忆展示（旧版宿主半） */ }
    }, [])

    const loadDev = useCallback(async () => {
      try { setDev(await api('/dev')) } catch { /* 旧宿主没有 /dev → 整段不显示 */ }
    }, [])

    useEffect(() => { void load(); void loadSwitch(); void loadDev() }, [load, loadSwitch, loadDev])

    async function toggle() {
      if (sw === null) return
      setBusy(true); setNotice('')
      try {
        const result = await api('/switch', { method: 'POST', body: JSON.stringify({ enabled: !sw.enabled }) })
        setSw(result)
        setNotice(result.enabled
          ? '记忆已启用：索引恢复注入，mem_* 工具恢复读写。'
          : '记忆已停用：不再向对话注入记忆索引，mem_* 工具不再读写。记忆文件原样保留。')
      } catch (e) { setError(e.message) } finally { setBusy(false) }
    }

    async function toggleDev() {
      if (dev === null) return
      setBusy(true); setNotice('')
      try {
        const result = await api('/dev', { method: 'POST', body: JSON.stringify({ enabled: !dev.enabled }) })
        setFile(null)
        setDev({ ...dev, enabled: result.enabled })
        await loadDev()
        setNotice(result.enabled
          ? `开发者模式已开启：记忆根下 ${dev.count} 个 .md 全部可看可改（写入前自动备份）。`
          : '开发者模式已关闭：恢复为只读总览，全部 .md 接口已拒绝访问。')
      } catch (e) { setError(e.message) } finally { setBusy(false) }
    }

    async function openFile(rel) {
      setBusy(true); setNotice('')
      try { setFile(await api(`/devfile?rel=${encodeURIComponent(rel)}`)) } catch (e) { setError(e.message) } finally { setBusy(false) }
    }

    async function update() {
      setBusy(true); setNotice('')
      try {
        const result = await api('/global', { method: 'POST', body: JSON.stringify({ base: data?.text ?? '', content: draft }) })
        setNotice(`已更新（${result.slots} 段 · ${result.chars} 字符）`)
        setEditing(false)
        await load()
      } catch (e) {
        if (e.status === 409) setNotice('这份记忆在你编辑期间被改过了（或在别处更新过）。请重新打开面板再改。')
        else setError(e.message)
      } finally { setBusy(false) }
    }

    const dirty = editing && data !== null && draft !== data.text
    const devOn = dev !== null && dev.enabled === true

    return h('section', { style: { padding: 20, maxWidth: 760, overflowWrap: 'anywhere' } },
      error ? h('p', { role: 'alert', style: { color: '#b00' } }, error) : null,
      notice ? h('p', { role: 'status', style: { color: '#0a6' } }, notice) : null,

      // 总开关：停用 = 不注入索引 + mem_* 工具拒绝读写（文件不动，勾选即恢复）
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-color, #eee)' } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' } },
          h('input', {
            type: 'checkbox',
            checked: sw === null ? true : sw.enabled,
            disabled: busy || sw === null,
            onChange: () => { void toggle() },
          }),
          h('span', { style: { fontWeight: 600 } }, '启用记忆')),
        sw !== null && !sw.enabled
          ? h('span', { style: muted }, '已停用：不注入索引、mem_* 工具不读写；文件保留，勾选即恢复')
          : null),

      // 开发者模式：开启后才把「记忆根下全部 md」摆出来
      dev === null ? null : h('div', { style: { marginBottom: 16 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' } },
            h('input', {
              type: 'checkbox',
              checked: dev.enabled,
              disabled: busy,
              onChange: () => { void toggleDev() },
            }),
            h('span', { style: { fontWeight: 600 } }, '开发者模式')),
          h('span', { style: muted },
            dev.enabled
              ? `已开启：${dev.count} 个 .md 可看可改（直接读写磁盘，不经过 mem_* 门槛）`
              : `关闭中：${dev.count} 个 .md 仅后端可见`),
          dev.memoryDir ? h('span', { style: { ...mono, fontSize: 11, color: 'var(--text-secondary, #999)' } }, dev.memoryDir) : null)),

      // 编辑某个文件时，正文区让位给编辑器（返回即回到总览）
      file !== null
        ? h('div', null,
          h('button', { style: { ...btn, marginBottom: 10, fontSize: 13 }, onClick: () => { setFile(null); setNotice('') } }, '← 返回'),
          h(DevEditor, {
            file,
            onDone: () => { setFile(null); void load(); void loadDev() },
            onError: setError,
          }))
        : h('div', null,
          editing
            ? h('div', null,
              h('textarea', {
                value: draft,
                onChange: (e) => setDraft(e.target.value),
                spellCheck: false,
                style: { width: '100%', minHeight: 320, padding: 10, lineHeight: 1.6, ...mono },
              }),
              h('p', { style: { ...muted, margin: '6px 0 10px' } },
                '每个 `## 名字` 是一段；一段只写一句话（≤80 字）。改完点下面的按钮。'),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { style: { ...btn, fontWeight: 600 }, disabled: busy || !dirty, onClick: () => { void update() } },
                  busy ? '更新中…' : '更新记忆'),
                h('button', { style: btn, disabled: busy, onClick: () => { setDraft(data?.text ?? ''); setEditing(false); setNotice('') } }, '取消')))
            : h('div', null,
              h('div', { style: { minHeight: 120 } },
                data === null ? h('p', { style: muted }, '载入中…') : h(ReadView, { text: data.text })),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' } },
                h('button', { style: btn, onClick: () => { setEditing(true); setNotice('') } }, '修改记忆'),
                data?.updatedAt ? h('span', { style: muted }, `上次更新 ${data.updatedAt}`) : null)),

          // 开发者模式开启：列出全部 .md（含每个文件是干什么的）
          devOn
            ? h('div', { style: { marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border-color, #eee)' } },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '全部记忆文件'),
              h('p', { style: { ...tiny, margin: '0 0 12px' } },
                '点任意一行整份查看并编辑。🟢 每轮常驻注入 · 🔵 按需检索 · ⚪ 仅留档 · 🟡 派生物（改它不改原文）· 🟠 待确认候选（不进注入）。虚线框是"应该有但还没创建"的文件，点一下即可新建。'),
              h(FileList, { rows: dev.files, onOpen: (rel) => { void openFile(rel) } }))
            : null))
  }

  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'vanwork-memory-core',
        order: 35,
        label: () => '记忆管理',
        inject: () => ({}),
      }, Panel)), 'memory-core: settings section')
    },
  }
} })