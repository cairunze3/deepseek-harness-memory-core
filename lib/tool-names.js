/**
 * lib/tool-names.js — 工具名的单一事实来源。
 *
 * 为什么单独抽出来：0.7.0 实际注册 10 个工具，README 仍写 9 个，
 * mem_audit 的 tools.self 还硬编码 7 个旧名字。工具面是模型与文档共同的
 * 契约，不能再靠三处手写名单维护。
 *
 * @module vanwork-memory-core/lib/tool-names
 */

export const TOOL_NAMES = [
  'mem_search',
  'mem_read',
  'mem_write',
  'mem_extract',
  'mem_health',
  'mem_query_log',
  'mem_global',
  'mem_audit',
  'mem_consolidate',
  'mem_reindex',
]