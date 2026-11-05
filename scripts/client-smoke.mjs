/**
 * scripts/client-smoke.mjs — Client 半的渲染冒烟（规范《TGZ 打包要求》第 7 节第 6 条）。
 *
 * 平台依赖全部用桩替换：`window.__ModuleLoader__`（装载器）、`require('react')`、
 * `fetch` / `AbortSignal`（面板只在 useEffect 里联网，冒烟时不会真的请求）。
 *
 * 覆盖：
 *   ① 装载器能拿到 `{id, factory}`，factory 能返回 `{inject, apply}`；
 *   ② apply 真的注册到 `settings.section`，且 id / order / label 符合契约；
 *   ③ 组件能渲染出首屏（载入中…），无运行时报错；
 *   ④ package.json 的 `dsh.client.inject` / `platform` 与实现一致。
 *
 * 用法：
 *   node scripts/client-smoke.mjs
 * 退出码 0 = 全过。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failed = 0
const check = (title, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${title}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed += 1
}

// ── 桩：React（只实现 client.js 用到的四个 API）───────────────────────────────
const reactStub = {
  createElement(type, props, ...children) {
    return { $$el: true, type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useEffect() {},
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useCallback(fn) {
    return fn
  },
}

// ── 桩：装载器与宿主环境 ─────────────────────────────────────────────────────
const sandbox = {
  console,
  require(name) {
    if (name === 'react') return reactStub
    throw new Error(`client.js 引用了未声明的依赖：${name}`)
  },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, text: '', slots: 0, chars: 0 }) }),
  AbortSignal: { timeout: () => undefined },
  window: {},
}
let loaded = null
sandbox.window.__ModuleLoader__ = {
  load(spec) {
    loaded = spec
  },
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })

check('loader 收到了 {id, factory}', Boolean(loaded) && loaded.id === 'vanwork-memory-core' && typeof loaded.factory === 'function',
  loaded ? `id=${loaded.id}` : '没有调用 __ModuleLoader__.load()')

const module_ = loaded.factory(sandbox.require)
check('factory 返回 {inject, apply}', Array.isArray(module_.inject) && typeof module_.apply === 'function',
  `inject=${JSON.stringify(module_.inject)}`)
check('inject 声明了 slots 服务', module_.inject.includes('slots'))

// ── 桩：cordis 上下文，抓住注册动作 ───────────────────────────────────────────
let slotName = null
let registered = null
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  slots: {
    inject(name, fn) {
      slotName = name
      return fn()
    },
    register(spec, component) {
      registered = { spec, component }
      return () => {}
    },
  },
}

let thrown = null
try {
  module_.apply(ctx)
} catch (error) {
  thrown = error
}
check('apply 不抛异常', thrown === null, thrown ? String(thrown?.message ?? thrown) : '')
check('注册到 settings.section', slotName === 'settings.section', `插槽=${slotName}`)

const spec = registered?.spec ?? {}
check('section id 为 vanwork-memory-core', spec.id === 'vanwork-memory-core', `id=${spec.id}`)
check('section order 为 35', spec.order === 35, `order=${spec.order}`)
check('label() 返回「记忆管理」', typeof spec.label === 'function' && spec.label() === '记忆管理', `label=${typeof spec.label === 'function' ? spec.label() : '（缺）'}`)
check('注册了组件', typeof registered?.component === 'function')

// ── 首屏渲染（hooks 用静态桩：data=null → 「载入中…」）────────────────────────
let tree = null
let renderError = null
try {
  tree = registered.component()
} catch (error) {
  renderError = error
}
check('首屏渲染不抛异常', renderError === null, renderError ? String(renderError?.message ?? renderError) : '')

const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (node.$$el) {
    for (const child of node.children) flatten(child, out)
    return out
  }
  return out
}
const text = flatten(tree).join(' ')
check('渲染出首屏文案（载入中）', text.includes('载入中'), text.slice(0, 60))
check('首屏包含「修改记忆」入口', text.includes('修改记忆'), '')

// ── package.json 声明与实现一致 ───────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const injectList = pkg?.dsh?.client?.inject ?? []
check('package.json 声明了 client.inject', Array.isArray(injectList) && injectList.length > 0, JSON.stringify(injectList))
check('client.platform 为 web', pkg?.dsh?.client?.platform === 'web', `platform=${pkg?.dsh?.client?.platform}`)
check('exports 含 ./client', pkg?.exports?.['./client'] === './lib/client.js', `exports["./client"]=${pkg?.exports?.['./client']}`)

console.log('')
if (failed === 0) {
  console.log('结果：Client 冒烟全部通过')
  process.exit(0)
}
console.log(`结果：${failed} 项失败`)
process.exit(1)