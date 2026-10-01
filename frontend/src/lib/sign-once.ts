/// 跨标签页「同一二维码只签到一次」台账（docs/SPEC.md §3.2.3：重复签到幂等）
/// 共享 Worker 让同一浏览器只持一条 WS，但每个标签页都会收到同一份帧，
/// 各标签页各自跑自动签到就会重复打上游（同一成员出现多条「签到成功」回执）。
/// 台账落在 localStorage：同源标签页天然共享，重进房/刷新也不会重复提交。

/** localStorage 键名 */
const KEY = 'rain-course.signed'

/** 条目保留时长：2 倍二维码上限（1 小时），避免台账无界增长 */
const TTL_MS = 2 * 60 * 60 * 1000

/**
 * 认领一次签到：返回 true 表示当前账号在本浏览器还没签过这个内容，可以提交。
 * 读与写在同一次同步调用内完成（中间无 await），多标签页几乎同时收到同一帧时只有一个能认领。
 * 键含 user_id：同一浏览器换账号登录后不会被上一个账号的台账挡住。
 */
export function claimSignOnce(raw: string, userId: number, now: number = Date.now()): boolean {
  const key = `${userId}:${raw}`
  const ledger = readLedger(now)
  if (ledger[key] !== undefined) return false
  ledger[key] = now
  writeLedger(ledger)
  return true
}

/** 读取台账并顺手淘汰过期条目（localStorage 不可用时退化为空台账） */
function readLedger(now: number): Record<string, number> {
  let parsed: unknown
  try {
    const stored = localStorage.getItem(KEY)
    parsed = stored === null ? null : JSON.parse(stored)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number' && now - v < TTL_MS) out[k] = v
  }
  return out
}

function writeLedger(ledger: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ledger))
  } catch {
    // 隐私模式/配额异常：退化为不跨标签页去重，不阻塞签到
  }
}