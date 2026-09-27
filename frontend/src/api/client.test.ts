import { describe, expect, it } from 'vitest'
import { getCookie, parseEnvelope } from './client'

describe('parseEnvelope', () => {
  it('code=0 时返回 data', () => {
    expect(parseEnvelope({ code: 0, msg: 'ok', data: { user_id: 42 } })).toEqual({
      ok: true,
      data: { user_id: 42 },
    })
  })

  it('data 缺失时为 null', () => {
    expect(parseEnvelope({ code: 0, msg: 'ok' })).toEqual({ ok: true, data: null })
  })

  it('40101 标记 needsLogin', () => {
    const r = parseEnvelope({ code: 40101, msg: '未登录', data: null })
    expect(r).toMatchObject({ ok: false, code: 40101, needsLogin: true })
  })

  it('其他业务错误原样透出 code/msg', () => {
    const r = parseEnvelope({ code: 40201, msg: '验证码校验失败', data: null })
    expect(r).toMatchObject({ ok: false, code: 40201, msg: '验证码校验失败', needsLogin: false })
  })
})

describe('cookie helper', () => {
  it('从 document.cookie 取 sid', () => {
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: 'a=1; sid=tok; b=2',
    })
    expect(getCookie('sid')).toBe('tok')
  })

  it('不存在时返回 null', () => {
    Object.defineProperty(document, 'cookie', { writable: true, value: 'a=1' })
    expect(getCookie('sid')).toBeNull()
  })
})
