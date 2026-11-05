/**
 * scripts/test-inproc.mjs — 同进程测试跑法（DSH 沙箱里的**推荐姿势**）。
 *
 * 用法（两种 shell 都成立，见 README 的"沙箱里的测试怎么跑"）：
 * ```
 * # PowerShell
 * node --input-type=module -e "import('file:///C:/.../scripts/test-inproc.mjs')"
 * # bash / zsh（把源码喂进 stdin）
 * cat scripts/test-inproc.mjs | node --input-type=module -
 * ```
 *
 * 为什么需要它：`node --test tests/` 会为每个测试文件 spawn 子进程并用管道
 * 捕获输出，而 DSH 沙箱明确阻止后者（`spawn EPERM`）。本脚本把全部测试文件
 * import 进**当前进程**注册用例，再用 programmatic `run()` 执行。
 *
 * 退出码语义（很重要，别把它当"总是 0"）：
 *  - 0 = 全部通过（`node:test` 的 run() 在有用例失败时会置 process.exitCode=1）；
 *  - 非 0 = 有用例失败，或加载阶段抛错。
 * 计数：Node 22 的 programmatic 事件流不吐 pass/fail，所以这里**不报数字**，
 * 只报"执行完成 / 有失败信号"，避免编造统计。要看明细请在允许管道输出的环境
 * 跑 `npm test`（TAP 明细会更完整）。
 *
 * @module vanwork-memory-core/scripts/test-inproc
 */

import { run } from 'node:test'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 定位 tests/：本文件可能被 import（有 file:// URL），也可能被喂进 stdin。 */
function testsDirOf() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    if (here && here !== '.' && here !== '/') return join(here, '..', 'tests')
  } catch { /* stdin 方式下 import.meta.url 不可用 */ }
  return join(process.cwd(), 'tests')
}

const testsDir = testsDirOf()
const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.js')).sort()
if (files.length === 0) {
  console.error('[test-inproc] 没有找到测试文件（tests/*.test.js）')
  process.exit(1)
}

let loaded = 0
for (const file of files) {
  try {
    await import(pathToFileURL(join(testsDir, file)).href)
    loaded += 1
  } catch (error) {
    console.error(`[test-inproc] 加载 ${file} 失败：${error?.message ?? error}`)
    process.exit(1)
  }
}

// 消费事件流即执行；不传 files 参数（传了会让 node:test 去 spawn 子进程）。
const stream = run({ files: [] })
for await (const _event of stream) { /* 结果由 node:test 汇总到 process.exitCode */ }

const failed = process.exitCode !== undefined && process.exitCode !== 0
console.log(`[test-inproc] 已执行 ${loaded} 个测试文件：${failed ? '**有失败**' : '无失败信号'}`
  + '（本沙箱下 TAP 明细取不到，故不报通过数；明细请用允许管道输出的环境跑 npm test）。')