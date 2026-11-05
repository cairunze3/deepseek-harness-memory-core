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
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 13 }

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

    const load = useCallback(async () => {
      try {
        const result = await api('/global')
        setData(result)
        setDraft(result.text)
        setError('')
      } catch (e) { setError(e.message) }
    }, [])

    useEffect(() => { void load() }, [load])

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

    return h('section', { style: { padding: 20, maxWidth: 760, overflowWrap: 'anywhere' } },
      error ? h('p', { role: 'alert', style: { color: '#b00' } }, error) : null,
      notice ? h('p', { role: 'status', style: { color: '#0a6' } }, notice) : null,

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
            data?.updatedAt ? h('span', { style: muted }, `上次更新 ${data.updatedAt}`) : null)))
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