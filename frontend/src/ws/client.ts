// 多标签页单连接入口（docs/DESIGN.md §4.4 单客户端单连接）
// - SharedWorker 可用：worker 持有连接，标签页经 port 收发
// - 不可用（Firefox/Safari/测试环境）：BroadcastChannel + localStorage 选举主标签页持有连接，
//   主标签页负责心跳重连，消息经 BroadcastChannel 分发给所有标签页

import { WsConnection, type SocketFactory, type WsStatus } from './connection'
import type { BusMsg } from './worker'
import { wsUrl, type ClientMsg, type ServerFrame } from './protocol'

export interface WsHandle {
  /** 发送客户端消息（自动经持有连接的一端转发） */
  send(msg: ClientMsg): void
  /** 订阅服务端消息帧，返回取消订阅函数 */
  subscribe(fn: (frame: ServerFrame) => void): () => void
  /** 订阅连接状态变化，返回取消订阅函数 */
  onStatus(fn: (s: WsStatus) => void): () => void
  getStatus(): WsStatus
  /** 按需建立连接（idle/closed 时调用） */
  ensureConnected(): void
  /** 主动断开（登出） */
  stop(): void
}

/** BroadcastChannel 的最小结构（便于测试注入） */
export interface BusLike {
  postMessage(m: BusMsg): void
  close(): void
  onmessage: ((ev: MessageEvent<BusMsg>) => void) | null
}

export interface WsHandleDeps {
  factory?: SocketFactory
  bcFactory?: (name: string) => BusLike
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  tabId?: string
}

const BC_NAME = 'rain-course-ws'
const LOCK_KEY = 'rain-course.ws.holder'
const LOCK_TTL_MS = 4000
const TICK_MS = 500

interface HolderLock {
  tab: string
  exp: number
}

function randomTabId(): string {
  return `t-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

/** 简单监听器集合 */
class Listeners<T> {
  private fns = new Set<(v: T) => void>()
  add(fn: (v: T) => void): () => void {
    this.fns.add(fn)
    return () => this.fns.delete(fn)
  }
  emit(v: T): void {
    for (const fn of this.fns) fn(v)
  }
}

/** 命令驱动连接：idle/closed 时先按需重连（start 幂等） */
function driveConn(conn: WsConnection, msg: ClientMsg): void {
  const s = conn.getStatus()
  if (s === 'idle' || s === 'closed') conn.start()
  conn.send(msg)
}

/**
 * 创建 WS 句柄。SharedWorker 存在时走 worker；否则降级为主标签页选举。
 * deps 可注入假实现供测试。
 */
export function createWsHandle(deps: WsHandleDeps = {}): WsHandle {
  const frames = new Listeners<ServerFrame>()
  const statuses = new Listeners<WsStatus>()
  let status: WsStatus = 'idle'
  const setStatus = (s: WsStatus) => {
    status = s
    statuses.emit(s)
  }

  // ---- SharedWorker 路径 ----
  if (typeof SharedWorker !== 'undefined' && !deps.factory && !deps.bcFactory) {
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'rain-course-ws',
    })
    const port = worker.port
    port.onmessage = (e: MessageEvent<BusMsg>) => {
      const data = e.data
      if (data.kind === 'frame') frames.emit(data.frame)
      else if (data.kind === 'status') setStatus(data.status)
    }
    port.start()
    return {
      send: (msg) => port.postMessage({ kind: 'cmd', msg } satisfies BusMsg),
      subscribe: frames.add.bind(frames),
      onStatus: statuses.add.bind(statuses),
      getStatus: () => status,
      ensureConnected: () => port.postMessage({ kind: 'cmd', msg: { type: 'heartbeat' } } satisfies BusMsg),
      stop: () => port.postMessage({ kind: 'stop' } satisfies BusMsg),
    }
  }

  // ---- 降级：BroadcastChannel + localStorage 主标签页选举 ----
  const bcFactory = deps.bcFactory ?? ((name: string) => new BroadcastChannel(name) as unknown as BusLike)
  const storage = deps.storage ?? window.localStorage
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const t = window.setTimeout(fn, ms)
      return () => window.clearTimeout(t)
    })
  const tabId = deps.tabId ?? randomTabId()
  const bc = bcFactory(BC_NAME)

  let conn: WsConnection | null = null
  let isLeader = false

  const readLock = (): HolderLock | null => {
    try {
      const raw = storage.getItem(LOCK_KEY)
      return raw ? (JSON.parse(raw) as HolderLock) : null
    } catch {
      return null
    }
  }

  const writeLock = (): void => {
    storage.setItem(LOCK_KEY, JSON.stringify({ tab: tabId, exp: now() + LOCK_TTL_MS } satisfies HolderLock))
  }

  const becomeLeader = (): void => {
    isLeader = true
    conn = new WsConnection(
      { url: wsUrl(), factory: deps.factory, schedule: deps.schedule },
      {
        onFrame: (frame) => {
          bc.postMessage({ kind: 'frame', frame })
          frames.emit(frame)
        },
        onStatus: (s) => {
          bc.postMessage({ kind: 'status', status: s })
          setStatus(s)
        },
      },
    )
    conn.start()
  }

  const resignLeader = (): void => {
    isLeader = false
    conn?.stop()
    conn = null
    try {
      const lock = readLock()
      if (lock?.tab === tabId) storage.removeItem(LOCK_KEY)
    } catch {
      // 忽略存储异常
    }
    setStatus('idle')
  }

  const tick = (): void => {
    const lock = readLock()
    if (isLeader) {
      // 锁被其他标签页接管（本页曾被挂起）→ 降级为跟随
      if (lock && lock.tab !== tabId) resignLeader()
      else writeLock() // 续租
      return
    }
    if (!lock || lock.exp <= now()) {
      // 无主或已过期：写后回读，写竞争天然只产生一个主
      writeLock()
      const mine = readLock()
      if (mine?.tab === tabId) becomeLeader()
    }
  }

  bc.onmessage = (e: MessageEvent<BusMsg>) => {
    const data = e.data
    if (isLeader) {
      if (data.kind === 'cmd' && conn) driveConn(conn, data.msg)
      else if (data.kind === 'stop') resignLeader()
      return
    }
    if (data.kind === 'frame') frames.emit(data.frame)
    else if (data.kind === 'status') setStatus(data.status)
  }

  schedule(function loop() {
    tick()
    schedule(loop, TICK_MS)
  }, 0)

  // 页面卸载：主标签页释放连接与锁，其他标签页在一个 tick 内接管
  window.addEventListener('pagehide', () => {
    if (isLeader) resignLeader()
  })

  return {
    send: (msg) => {
      if (isLeader && conn) {
        // BroadcastChannel 不回显给发送者：主标签页直驱连接
        driveConn(conn, msg)
      } else {
        bc.postMessage({ kind: 'cmd', msg })
      }
    },
    subscribe: frames.add.bind(frames),
    onStatus: statuses.add.bind(statuses),
    getStatus: () => status,
    ensureConnected: () => {
      if (isLeader) conn?.start()
      // 跟随页无需动作：下一个命令到达时主标签页按需重连
    },
    stop: () => {
      if (isLeader) resignLeader()
      else bc.postMessage({ kind: 'stop' })
    },
  }
}

/** 应用级单例（仅浏览器环境调用） */
let singleton: WsHandle | null = null

export function getWs(): WsHandle {
  singleton ??= createWsHandle()
  return singleton
}
