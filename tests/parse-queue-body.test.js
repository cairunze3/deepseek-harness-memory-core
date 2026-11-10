import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseQueueBody } from '../lib/consolidate.js'

describe('parseQueueBody - 新格式（带字段名）', () => {
  it('解析完整三段：track/scope/id', () => {
    const r = parseQueueBody('[queue:track=key scope=project id=2e242607bffb] 用户不碰 K8s')
    assert.deepEqual(
      { track: r.track, scope: r.scope, projectId: r.projectId, content: r.content },
      { track: 'key', scope: 'project', projectId: '2e242607bffb', content: '用户不碰 K8s' },
    )
  })

  it('解析两段：无 id', () => {
    const r = parseQueueBody('[queue:track=user scope=global] 会议纪要格式有约定')
    assert.deepEqual(
      { track: r.track, scope: r.scope, projectId: r.projectId },
      { track: 'user', scope: 'global', projectId: null },
    )
  })

  it('剥掉前置时间戳与 summary 标签后仍能解析', () => {
    const r = parseQueueBody('[2026-11-05 14:45] [summary:记忆插件机制] [queue:track=memory scope=project id=abc] 出讲解图')
    assert.equal(r.track, 'memory')
    assert.equal(r.scope, 'project')
    assert.equal(r.projectId, 'abc')
    assert.equal(r.content, '出讲解图')
  })
})

describe('parseQueueBody - 旧格式（位置式，向后兼容）', () => {
  it('解析旧三段 track|scope|id', () => {
    const r = parseQueueBody('[queue:key|project|2e242607bffb] 家里宽带联通 1000M')
    assert.deepEqual(
      { track: r.track, scope: r.scope, projectId: r.projectId },
      { track: 'key', scope: 'project', projectId: '2e242607bffb' },
    )
  })

  it('解析旧两段 track|scope', () => {
    const r = parseQueueBody('[queue:user|global] 通勤骑捷安特')
    assert.deepEqual(
      { track: r.track, scope: r.scope, projectId: r.projectId },
      { track: 'user', scope: 'global', projectId: null },
    )
  })
})

describe('parseQueueBody - project track 原样保留', () => {
  it('track=project 保留原样（新格式）', () => {
    const r = parseQueueBody('[queue:track=project scope=global] 通勤骑捷安特')
    assert.equal(r.track, 'project')
    assert.equal(r.scope, 'global')
  })

  it('track=project 保留原样（旧格式）', () => {
    const r = parseQueueBody('[queue:project|project|2e242607bffb] 青屿压测阈值')
    assert.equal(r.track, 'project')
    assert.equal(r.scope, 'project')
    assert.equal(r.projectId, '2e242607bffb')
  })
})

describe('parseQueueBody - 非法输入', () => {
  it('无 queue 标签返回 null', () => {
    assert.equal(parseQueueBody('这是一条普通记忆'), null)
  })
})
