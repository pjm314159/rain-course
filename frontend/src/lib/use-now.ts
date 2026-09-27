import { useEffect, useState } from 'react'

/** 每隔 intervalMs 跳动的当前时间戳（毫秒），用于倒计时类展示 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
