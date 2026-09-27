// applyFrameToState 纯 reducer 单测：服务端帧 → 房间/广场状态转移（docs/DESIGN.md §4）

import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '../ws/protocol'
import { applyFrameToState, useRoom, type RoomState } from './room'

const fr = (msg: Record<string, unknown>) => ({ ...msg, seq: 1, ts: 1 }) as ServerFrame

// reducer 只读取数据字段，动作方法以 noop 补齐以满足 RoomState
function baseState(): RoomState {
  return {
    status: 'lobby',
    room: 7,
    name: '测试房',
    owner: 1,
    members: [1],
    messages: [],
    meta: null,
    needPassword: false,
    lastError: null,
    signFeed: [],
    plaza: [],
    applyFrame: () => {},
    setStatus: () => {},
    setPlaza: () => {},
    clearRoom: () => {},
  }
}

describe('applyFrameToState', () => {
  it('joined 全量补齐并清空密码/错误态', () => {
    const st: RoomState = { ...baseState(), needPassword: true, lastError: { code: 40302, msg: 'x' } }
    const out = applyFrameToState(st, fr({
      type: 'joined',
      room: 7,
      name: '周一高数课',
      owner: 1,
      members: [1, 2],
      messages: [{ raw: 'r', by: 2, expire_at: 5 }],
      meta: { teacher: 'T' },
    }))
    expect(out).toEqual({
      room: 7,
      name: '周一高数课',
      owner: 1,
      members: [1, 2],
      messages: [{ raw: 'r', by: 2, expire_at: 5 }],
      meta: { teacher: 'T' },
      needPassword: false,
      lastError: null,
    })
  })

  it('join_need_password 置位密码提示', () => {
    expect(applyFrameToState(baseState(), fr({ type: 'join_need_password', room: 7 }))).toEqual({ needPassword: true })
  })

  it('member_join/member_leave 仅对当前房间生效', () => {
    const st = baseState()
    expect(applyFrameToState(st, fr({ type: 'member_join', room: 99, owner: 1, members: [1, 2] }))).toEqual({})
    expect(applyFrameToState(st, fr({ type: 'member_join', room: 7, owner: 1, members: [1, 2] })).members).toEqual([1, 2])
    expect(applyFrameToState(st, fr({ type: 'member_leave', room: 7, owner: 1, members: [1] })).members).toEqual([1])
  })

  it('qr_update 追加新消息并对相同内容去重', () => {
    const st = baseState()
    const f = fr({ type: 'qr_update', room: 7, raw: 'r1', by: 2, expire_at: 100 })
    expect(applyFrameToState(st, f, 0).messages).toEqual([{ raw: 'r1', by: 2, expire_at: 100 }])

    const withOne: RoomState = { ...st, messages: [{ raw: 'r1', by: 2, expire_at: 100 }] }
    // 重复回显且无过期项 → 空补丁（messages 引用不变，避免无谓重渲）
    expect(applyFrameToState(withOne, f, 0)).toEqual({})
    expect(applyFrameToState(withOne, fr({ type: 'qr_update', room: 7, raw: 'r2', by: 2, expire_at: 100 }), 0).messages).toHaveLength(2)
  })

  it('qr_update 入队时惰性裁剪已过期消息', () => {
    const st: RoomState = {
      ...baseState(),
      messages: [
        { raw: 'old', by: 1, expire_at: 50 },
        { raw: 'live', by: 2, expire_at: 500 },
      ],
    }
    const out = applyFrameToState(st, fr({ type: 'qr_update', room: 7, raw: 'new', by: 3, expire_at: 900 }), 100)
    expect(out.messages).toEqual([
      { raw: 'live', by: 2, expire_at: 500 },
      { raw: 'new', by: 3, expire_at: 900 },
    ])
  })

  it('sign_result 前插并保留最近 20 条', () => {
    let st = baseState()
    for (let i = 0; i < 25; i++) {
      st = { ...st, ...applyFrameToState(st, fr({ type: 'sign_result', room: 7, by: i, ok: true, ts: i })) }
    }
    expect(st.signFeed).toHaveLength(20)
    expect(st.signFeed[0]?.by).toBe(24)
    expect(st.signFeed[19]?.by).toBe(5)
  })

  it('plaza_update 全量覆盖广场列表', () => {
    const rooms = [{ room_id: 1, members: 2, created_at: 9 }]
    expect(applyFrameToState(baseState(), fr({ type: 'plaza_update', rooms })).plaza).toEqual(rooms)
  })

  it('error 40404 清空房间状态；其他错误记录 lastError', () => {
    const st: RoomState = { ...baseState(), messages: [{ raw: 'r', by: 1, expire_at: 1 }] }
    const cleared = applyFrameToState(st, fr({ type: 'error', code: 40404, msg: '房间已关闭' }))
    expect(cleared.room).toBeNull()
    expect(cleared.name).toBeNull()
    expect(cleared.messages).toEqual([])
    expect(cleared.needPassword).toBe(false)

    const other = applyFrameToState(baseState(), fr({ type: 'error', room: 7, code: 40302, msg: '密码错误' }))
    expect(other.lastError).toEqual({ code: 40302, msg: '密码错误', room: 7 })
  })

  it('heartbeat 不改变状态', () => {
    expect(applyFrameToState(baseState(), fr({ type: 'heartbeat' }))).toEqual({})
  })
})

describe('useRoom store', () => {
  it('applyFrame 更新全局状态，clearRoom 清理房间数据', () => {
    useRoom.getState().applyFrame(fr({
      type: 'joined',
      room: 3,
      owner: 9,
      members: [9],
      messages: [],
      meta: { course_name: '高等数学' },
    }))
    expect(useRoom.getState().room).toBe(3)
    expect(useRoom.getState().owner).toBe(9)
    expect(useRoom.getState().meta?.course_name).toBe('高等数学')

    useRoom.getState().clearRoom()
    expect(useRoom.getState().room).toBeNull()
    expect(useRoom.getState().meta).toBeNull()
    expect(useRoom.getState().members).toEqual([])
  })
})
