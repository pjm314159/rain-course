// WsConnection 状态机单测：假 socket + 手动定时器，覆盖
// 连接/心跳 pong/重连退避/服务端关闭码/房间恢复/主动关闭（docs/DESIGN.md §4.4）

import { describe, expect, it } from 'vitest'
import {
  CLOSE_IDLE,
  CLOSE_RATE,
  CLOSE_REPLACED,
  WsConnection,
  type SocketFactory,
  type WsSocketLike,
} from './connection'

class FakeSocket implements WsSocketLike {
  open = false
  sent: string[] = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number }) => void) | null = null
  onerror: (() => void) | null = null

  send(data: string): void {
    // 对齐浏览器行为：open 前 send 抛 InvalidStateError
    if (!this.open) throw new Error('WebSocket is not open yet')
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason }
  }
}

interface Timer {
  fn: () => void
  ms: number
  cancelled: boolean
}

function makeHarness(maxBackoffMs?: number) {
  const sockets: FakeSocket[] = []
  const factory: SocketFactory = () => {
    const s = new FakeSocket()
    sockets.push(s)
    return s
  }
  const timers: Timer[] = []
  const schedule = (fn: () => void, ms: number) => {
    const t: Timer = { fn, ms, cancelled: false }
    timers.push(t)
    return () => {
      t.cancelled = true
    }
  }
  const statuses: string[] = []
  const conn = new WsConnection(
    { url: 'ws://test/ws', factory, schedule, maxBackoffMs },
    { onFrame: () => {}, onStatus: (s) => statuses.push(s) },
  )
  return {
    conn,
    sockets,
    timers,
    statuses,
    /** 将第 i 个 socket 置为 open 并触发 onopen */
    openSocket(i: number) {
      const s = sockets[i]
      if (!s) throw new Error(`no socket ${i}`)
      s.open = true
      s.onopen?.()
    },
    fireNextTimer() {
      const t = timers.find((x) => !x.cancelled)
      if (!t) throw new Error('no pending timer')
      t.cancelled = true
      t.fn()
    },
    pendingCount() {
      return timers.filter((t) => !t.cancelled).length
    },
  }
}

type Harness = ReturnType<typeof makeHarness>

/** start + onopen，进入 lobby */
function connectLobby(h: Harness): void {
  h.conn.start()
  h.openSocket(0)
}

/** 加入房间并收到 joined（进入 in_room） */
function joinRoom(h: Harness, room = 7): void {
  h.conn.send({ type: 'join', room })
  h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'joined', room, owner: 1, members: [1], messages: [], seq: 1, ts: 1 }) })
}

const sentTypes = (s: FakeSocket) => s.sent.map((t) => (JSON.parse(t) as { type: string }).type)

describe('WsConnection', () => {
  it('start → connecting，open 后进入 lobby', () => {
    const h = makeHarness()
    h.conn.start()
    expect(h.conn.getStatus()).toBe('connecting')
    h.openSocket(0)
    expect(h.conn.getStatus()).toBe('lobby')
    expect(h.statuses).toEqual(['connecting', 'lobby'])
  })

  it('start 幂等：重复调用不新建连接', () => {
    const h = makeHarness()
    h.conn.start()
    h.conn.start()
    expect(h.sockets).toHaveLength(1)
  })

  it('收到 heartbeat 自动回 pong', () => {
    const h = makeHarness()
    connectLobby(h)
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'heartbeat', seq: 1, ts: 1 }) })
    expect(sentTypes(h.sockets[0]!)).toEqual(['heartbeat'])
  })

  it('join → joined 进入 in_room；非法帧被忽略', () => {
    const h = makeHarness()
    connectLobby(h)
    h.sockets[0]!.onmessage!({ data: 'garbage' })
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'join_need_password', room: 7 }) })
    joinRoom(h)
    expect(h.conn.getStatus()).toBe('in_room')
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ type: 'join', room: 7 })
  })

  it('意外断开：1s 后重连并自动重新 join', () => {
    const h = makeHarness()
    connectLobby(h)
    joinRoom(h)
    expect(h.conn.getStatus()).toBe('in_room')

    h.sockets[0]!.onclose!({ code: 1006 })
    expect(h.conn.getStatus()).toBe('reconnecting')
    expect(h.pendingCount()).toBe(1)
    expect(h.timers[0]!.ms).toBe(1000)

    h.fireNextTimer()
    expect(h.sockets).toHaveLength(2)
    h.openSocket(1)
    // 恢复中：重发 join，等 joined 确认
    expect(sentTypes(h.sockets[1]!)).toEqual(['join'])
    expect(JSON.parse(h.sockets[1]!.sent[0]!)).toEqual({ type: 'join', room: 7 })
    expect(h.conn.getStatus()).toBe('reconnecting')

    h.sockets[1]!.onmessage!({ data: JSON.stringify({ type: 'joined', room: 7, owner: 1, members: [1], messages: [], seq: 2, ts: 2 }) })
    expect(h.conn.getStatus()).toBe('in_room')
  })

  it('退避翻倍 1s→2s→4s，并受 maxBackoffMs 封顶', () => {
    const h = makeHarness(2500)
    connectLobby(h)

    h.sockets[0]!.onclose!({ code: 1006 })
    expect(h.timers[0]!.ms).toBe(1000)
    h.fireNextTimer()

    h.sockets[1]!.onclose!({ code: 1006 })
    expect(h.timers[1]!.ms).toBe(2000)
    h.fireNextTimer()

    h.sockets[2]!.onclose!({ code: 1006 })
    expect(h.timers[2]!.ms).toBe(2500) // 4000 被封顶为 2500
  })

  it(`服务端 close ${CLOSE_IDLE}（lobby 空闲）→ idle，不重连`, () => {
    const h = makeHarness()
    connectLobby(h)
    h.sockets[0]!.onclose!({ code: CLOSE_IDLE })
    expect(h.conn.getStatus()).toBe('idle')
    expect(h.pendingCount()).toBe(0)
    // idle 下发送被忽略且不抛错
    expect(() => h.conn.send({ type: 'heartbeat' })).not.toThrow()
    expect(h.sockets[0]!.sent).toHaveLength(0)
  })

  it(`close ${CLOSE_RATE} / ${CLOSE_REPLACED} → closed，不重连`, () => {
    for (const code of [CLOSE_RATE, CLOSE_REPLACED]) {
      const h = makeHarness()
      connectLobby(h)
      h.sockets[0]!.onclose!({ code })
      expect(h.conn.getStatus()).toBe('closed')
      expect(h.pendingCount()).toBe(0)
    }
  })

  it('重连恢复中收到 error 40404 → 放弃恢复，open 后回 lobby 不重发 join', () => {
    const h = makeHarness()
    connectLobby(h)
    h.conn.send({ type: 'join', room: 5 })
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'error', room: 5, code: 40404, msg: '房间不存在', seq: 1, ts: 1 }) })

    h.sockets[0]!.onclose!({ code: 1006 })
    h.fireNextTimer()
    h.openSocket(1)
    expect(h.conn.getStatus()).toBe('lobby')
    expect(h.sockets[1]!.sent).toHaveLength(0)
  })

  it('leave → 回 lobby，重连后不再 join', () => {
    const h = makeHarness()
    connectLobby(h)
    joinRoom(h)
    h.conn.send({ type: 'leave', room: 7 })
    expect(h.conn.getStatus()).toBe('lobby')

    h.sockets[0]!.onclose!({ code: 1006 })
    h.fireNextTimer()
    h.openSocket(1)
    expect(h.conn.getStatus()).toBe('lobby')
    expect(h.sockets[1]!.sent).toHaveLength(0)
  })

  it('connecting 期间发送的消息在 open 后补发', () => {
    const h = makeHarness()
    h.conn.start()
    h.conn.send({ type: 'share_qr', room: 3, raw: 'r' })
    expect(h.sockets[0]!.sent).toHaveLength(0) // 尚未 open，已排队
    h.openSocket(0)
    expect(sentTypes(h.sockets[0]!)).toEqual(['share_qr'])
  })

  it('连接建立前 join：open 后仅自动 rejoin 一次，不重复发送', () => {
    const h = makeHarness()
    h.conn.start()
    h.conn.send({ type: 'join', room: 7 })
    h.openSocket(0)
    expect(sentTypes(h.sockets[0]!)).toEqual(['join'])
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toMatchObject({ type: 'join', room: 7 })
  })

  it('stop() → close(1000)、状态 closed，之后发送被忽略', () => {
    const h = makeHarness()
    connectLobby(h)
    h.conn.stop()
    expect(h.sockets[0]!.closedWith?.code).toBe(1000)
    expect(h.conn.getStatus()).toBe('closed')
    expect(h.pendingCount()).toBe(0)
    h.conn.send({ type: 'heartbeat' })
    expect(h.sockets[0]!.sent).toHaveLength(0)
  })
})
