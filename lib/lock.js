/**
 * lib/lock.js — 跨进程文件锁。
 *
 * 取舍说明：Qoder 的 dream 用 `.consolidate-lock`（内容 = PID）判断所有权，
 * 报告点名它在跨机器/容器共享目录下不可靠。这里把它做成**本地进程锁**：
 *   - 锁文件写 pid + 启动时间（不依赖 PID 存活判断作为唯一依据）；
 *   - 双重陈旧判定：mtime 超龄 **或** 持有者进程已消失 → 回收锁；
 *   - 自旋等待有上限，超时**如实报错**而不是静默继续（避免两个进程同时整合）。
 *
 * 局限（写进 README，不假装没有）：这是单机锁。跨设备并发由 Git 侧解决
 * （memory-evolve 的同步用三方合并 + 条目身份证），本锁不承担跨机互斥。
 *
 * @module vanwork-memory-core/lib/lock
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir, sleepSync } from './fsutil.js'

/** 默认：超过该时长的锁视为被遗弃。 */
export const STALE_LOCK_MS = 60_000
/** 默认：等锁上限（超过则如实失败）。 */
export const LOCK_TIMEOUT_MS = 5_000
/** 自旋间隔。 */
export const LOCK_RETRY_MS = 25

/** 判断 pid 是否仍存活（Windows 上 EPERM 也表示存活）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 读锁文件信息（不存在/损坏返回 null）。 */
export function readLockInfo(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim()
    const parsed = JSON.parse(raw)
    return {
      pid: Number(parsed?.pid ?? 0),
      host: String(parsed?.host ?? ''),
      startedAt: Number(parsed?.startedAt ?? 0),
      mtimeMs: statSync(lockPath).mtimeMs,
    }
  } catch {
    return null
  }
}

/**
 * 在锁保护下同步执行 `fn`。
 *
 * @param {string} lockPath - 锁文件路径。
 * @param {() => any} fn - 临界区。
 * @param {object} [opts] - { timeoutMs, staleMs, retryMs, label }。
 * @returns {{ok: true, value: any} | {ok: false, reason: string, holder: object|null}}
 */
export function withLock(lockPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = opts.staleMs ?? STALE_LOCK_MS
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS
  ensureDir(dirname(lockPath))
  const deadline = Date.now() + timeoutMs
  let lastHolder = null

  for (;;) {
    if (tryAcquire(lockPath)) {
      try {
        return { ok: true, value: fn() }
      } finally {
        release(lockPath)
      }
    }
    lastHolder = readLockInfo(lockPath)
    // 陈旧回收：mtime 超龄，或持锁进程已消失（同一台机器上）
    const age = lastHolder ? Date.now() - lastHolder.mtimeMs : Number.POSITIVE_INFINITY
    const holderGone = lastHolder?.host === hostName() && !isPidAlive(lastHolder.pid)
    if (lastHolder && (age > staleMs || holderGone)) {
      try { unlinkSync(lockPath) } catch { /* 竞争者已回收 */ }
      continue
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        reason: opts.label ? `lock timeout: ${opts.label}` : 'lock timeout',
        holder: lastHolder,
      }
    }
    sleepSync(retryMs)
  }
}

function tryAcquire(lockPath) {
  let fd = null
  try {
    fd = openSync(lockPath, 'wx', 0o600)
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostName(), startedAt: Date.now() }))
    closeSync(fd)
    return true
  } catch (error) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关闭 */ } }
    return false
  }
}

function release(lockPath) {
  try { unlinkSync(lockPath) } catch { /* 已被回收 */ }
}

function hostName() {
  try {
    return String(process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'local')
  } catch {
    return 'local'
  }
}