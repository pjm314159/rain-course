import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimSignOnce } from './sign-once'

/** 与实现一致的台账键名与保留时长（2 小时） */
const KEY = 'rain-course.signed'
const TTL_MS = 2 * 60 * 60 * 1000

const RAW_A = 'https://www.yuketang.cn/lesson/fullscreen/v3/a?lessonid=1'
const RAW_B = 'https://www.yuketang.cn/lesson/fullscreen/v3/b?lessonid=2'

beforeEach(() => {
  localStorage.clear()
})

describe('claimSignOnce 跨标签页签到台账', () => {
  it('同账号同一内容只认领一次', () => {
    expect(claimSignOnce(RAW_A, 42)).toBe(true)
    expect(claimSignOnce(RAW_A, 42)).toBe(false)
  })

  it('不同内容、不同账号互不影响', () => {
    expect(claimSignOnce(RAW_A, 42)).toBe(true)
    expect(claimSignOnce(RAW_B, 42)).toBe(true)
    // 同一浏览器换账号登录后，上一个账号的台账不应挡住新账号
    expect(claimSignOnce(RAW_A, 43)).toBe(true)
  })

  it('台账持久化在 localStorage，新开的标签页能读到', () => {
    expect(claimSignOnce(RAW_A, 42)).toBe(true)
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    expect(Object.keys(stored)).toEqual([`42:${RAW_A}`])
  })

  it('超过保留时长后条目淘汰，可以重新认领', () => {
    const now = 1_700_000_000_000
    expect(claimSignOnce(RAW_A, 42, now)).toBe(true)
    expect(claimSignOnce(RAW_A, 42, now + TTL_MS - 1)).toBe(false)
    expect(claimSignOnce(RAW_A, 42, now + TTL_MS)).toBe(true)
  })

  it('localStorage 不可写（隐私模式/配额）时不抛错，退化为不跨标签页去重', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      expect(claimSignOnce(RAW_A, 42)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('localStorage 内容损坏时按空台账处理，不抛错', () => {
    localStorage.setItem(KEY, 'not json')
    expect(claimSignOnce(RAW_A, 42)).toBe(true)
  })
})