import { describe, expect, it } from 'vitest'
import { encodeClientMsg, parseServerFrame, wsUrl } from './protocol'

describe('parseServerFrame', () => {
  it('解析完整信封', () => {
    const f = parseServerFrame('{"type":"qr_update","room":1,"raw":"r","by":2,"expire_at":99,"seq":3,"ts":4}')
    expect(f).toEqual({
      type: 'qr_update',
      room: 1,
      raw: 'r',
      by: 2,
      expire_at: 99,
      seq: 3,
      ts: 4,
    })
  })

  it('非 JSON / 缺 type / 缺 seq 返回 null', () => {
    expect(parseServerFrame('garbage')).toBeNull()
    expect(parseServerFrame('{"room":1}')).toBeNull()
    expect(parseServerFrame('{"type":"heartbeat"}')).toBeNull()
    expect(parseServerFrame('null')).toBeNull()
  })
})

describe('encodeClientMsg', () => {
  it('密码可省略字段', () => {
    expect(JSON.parse(encodeClientMsg({ type: 'join', room: 42 }))).toEqual({ type: 'join', room: 42 })
    expect(JSON.parse(encodeClientMsg({ type: 'join', room: 1, password: 'pw' }))).toEqual({
      type: 'join',
      room: 1,
      password: 'pw',
    })
  })
})

describe('wsUrl', () => {
  it('同源时基于 location 生成 ws 地址', () => {
    const url = wsUrl()
    expect(url).toMatch(/^wss?:\/\//)
    expect(url.endsWith('/ws')).toBe(true)
  })
})
