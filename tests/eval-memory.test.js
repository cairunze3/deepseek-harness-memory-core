import assert from 'node:assert/strict'
import test from 'node:test'
import { runEvaluation } from '../scripts/eval-memory.mjs'

test('记忆质量冒烟评测：检索、pointer 预取、队列证据门槛全部通过', async () => {
  const report = await runEvaluation()
  assert.equal(report.ok, true, JSON.stringify(report.notes))
  assert.ok(report.recallAt3 >= 0.75, `recall@3=${report.recallAt3}`)
  assert.ok(report.pointerCore, 'pointer 核心预取缺失')
  assert.ok(report.queueGate, '队列证据门槛失效')
})