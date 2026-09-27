// 单条 WebSocket 的生命周期管理（docs/DESIGN.md §4.4）
// - 心跳 pong：收到服务端 heartbeat 立即回 pong
// - 指数退避重连 1s→2s→4s…上限 30s（仅意外断开；4000/4008/4009 不重连）
// - 重连成功后自动重新 join 当前房间，服务端回 joined 全量补齐

import { encodeClientMsg, parseServerFrame, type ClientMsg, type ServerFrame } from './protocol'

export type WsStatus =
  | 'idle' // 未连接（未登录 / 被 lobby 空闲回收后待按需重连）
  | 'connecting' // 首次连接中
  | 'lobby' // 已连接，未加入房间
  | 'reconnecting' // 断线重连中 / 已连上正在恢复房间
  | 'in_room' // 已加入房间
  | 'closed' // 主动关闭或被替代，不再自动重连

/** 服务端主动关闭码（docs/DESIGN.md §4.4） */
export const CLOSE_IDLE = 4000
export const CLOSE_RATE = 4008
export const CLOSE_REPLACED = 4009

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

/** 最小 socket 接口（便于测试注入假实现） */
export interface WsSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number }) => void) | null
  onerror: (() => void) | null
}

export type SocketFactory = (url: string) => WsSocketLike

export interface WsConnectionCallbacks {
  onFrame: (frame: ServerFrame) => void
  onStatus: (status: WsStatus) => void
}

export interface WsConnectionOptions {
  url: string
  /** 缺省为浏览器 WebSocket */
  factory?: SocketFactory
  maxBackoffMs?: number
  /** 测试注入定时器：返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void
}

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WsSocketLike

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = window.setTimeout(fn, ms)
  return () => window.clearTimeout(t)
}

export class WsConnection {
  private readonly opts: WsConnectionOptions
  private readonly cb: WsConnectionCallbacks
  private sock: WsSocketLike | null = null
  private status: WsStatus = 'idle'
  private attempts = 0
  private cancelTimer: (() => void) | null = null
  private closedByUs = false
  /** 当前房间（重连后自动重新 join） */
  private currentRoom: { room: number; password?: string } | null = null

  constructor(opts: WsConnectionOptions, cb: WsConnectionCallbacks) {
    this.opts = opts
    this.cb = cb
  }

  getStatus(): WsStatus {
    return this.status
  }

  private setStatus(s: WsStatus) {
    if (this.status === s) return
    this.status = s
    this.cb.onStatus(s)
  }

  /** 建立连接（idle/closed 状态下按需调用） */
  start(): void {
    if (this.sock || this.status === 'connecting' || this.status === 'reconnecting') return
    this.closedByUs = false
    this.setStatus('connecting')
    this.open()
  }

  private open(): void {
    const factory = this.opts.factory ?? defaultFactory
    const sock = factory(this.opts.url)
    this.sock = sock
    sock.onopen = () => {
      this.attempts = 0
      if (this.currentRoom) {
        // 重连恢复：重新 join，joined 全量补齐
        this.setStatus('reconnecting')
        this.sendRaw(
          encodeClientMsg({
            type: 'join',
            room: this.currentRoom.room,
            password: this.currentRoom.password,
          }),
        )
      } else {
        this.setStatus('lobby')
      }
    }
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      const frame = parseServerFrame(ev.data)
      if (!frame) return
      if (frame.type === 'heartbeat') {
        // 客户端 pong（docs/DESIGN.md §4.4）
        this.sendRaw(encodeClientMsg({ type: 'heartbeat' }))
        return
      }
      this.onFrame(frame)
      this.cb.onFrame(frame)
    }
    sock.onclose = (ev) => {
      this.sock = null
      this.handleClose(ev.code)
    }
    sock.onerror = () => {
      // onclose 会跟着触发，这里不重复处理
    }
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'joined':
        this.setStatus('in_room')
        break
      case 'error':
        // 房间不存在/已关闭：退出重连恢复，回到 lobby 等待用户操作
        if (frame.code === 40404) {
          this.currentRoom = null
          if (this.status === 'reconnecting') this.setStatus('lobby')
        }
        break
      default:
        break
    }
  }

  private handleClose(code: number | undefined): void {
    if (this.closedByUs) {
      this.setStatus('closed')
      return
    }
    // 服务端主动关闭：不自动重连（lobby 空闲回收 / 限速 / 被新连接替代）
    if (code === CLOSE_IDLE || code === CLOSE_RATE || code === CLOSE_REPLACED) {
      this.setStatus(code === CLOSE_IDLE ? 'idle' : 'closed')
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.attempts += 1
    const max = this.opts.maxBackoffMs ?? MAX_BACKOFF_MS
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (this.attempts - 1), max)
    this.setStatus('reconnecting')
    this.cancelTimer?.()
    const schedule = this.opts.schedule ?? defaultSchedule
    this.cancelTimer = schedule(() => {
      this.cancelTimer = null
      this.open()
    }, delay)
  }

  private sendRaw(data: string): void {
    if (this.sock && this.status !== 'closed' && this.status !== 'idle') {
      try {
        this.sock.send(data)
      } catch {
        // 发送失败等待 onclose 走重连
      }
    }
  }

  /** 发送业务消息；join/leave 同步维护重连恢复所需的房间记忆 */
  send(msg: ClientMsg): void {
    switch (msg.type) {
      case 'join':
        this.currentRoom = { room: msg.room, password: msg.password }
        break
      case 'leave':
        this.currentRoom = null
        this.setStatus('lobby')
        break
      default:
        break
    }
    this.sendRaw(encodeClientMsg(msg))
  }

  /** 主动断开（登出），不再重连 */
  stop(): void {
    this.closedByUs = true
    this.cancelTimer?.()
    this.cancelTimer = null
    this.currentRoom = null
    if (this.sock) {
      const sock = this.sock
      this.sock = null
      sock.close(1000, 'client logout')
    }
    this.setStatus('closed')
  }
}
