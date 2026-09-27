// 房间/广场状态：服务端消息帧 → UI 状态的纯 reducer（便于单测）
// 二维码消息带 expire_at，展示层按当前时间过滤隐藏（与后端"消失"语义一致）

import { create } from 'zustand'
import type { WsStatus } from '../ws/connection'
import { WS_ERRORS, type PlazaRoom, type QrMsg, type RoomMeta, type ServerFrame } from '../ws/protocol'

export interface SignFeedItem {
  by: number
  ok: boolean
  reason?: string
  ts: number
}

export interface RoomState {
  status: WsStatus
  /** 当前所在房间；null = 未加入 */
  room: number | null
  /** 房间名（joined 帧下发） */
  name: string | null
  owner: number | null
  members: number[]
  /** 历史二维码消息（含已过期，展示层过滤） */
  messages: QrMsg[]
  meta: RoomMeta | null
  /** 服务端提示需要密码 */
  needPassword: boolean
  /** 最近一条 error（room 缺省为连接级） */
  lastError: { code: number; msg: string; room?: number } | null
  signFeed: SignFeedItem[]
  plaza: PlazaRoom[]

  applyFrame: (frame: ServerFrame) => void
  setStatus: (s: WsStatus) => void
  /** REST 拉取广场后写入（与 plaza_update 同源覆盖） */
  setPlaza: (rooms: PlazaRoom[]) => void
  /** 离开/被移出房间后的本地清理 */
  clearRoom: () => void
}

function withoutRoom(): Partial<RoomState> {
  return {
    room: null,
    name: null,
    owner: null,
    members: [],
    messages: [],
    meta: null,
    needPassword: false,
  }
}

/** 帧 → 状态补丁。now 用于惰性裁剪已过期二维码消息（默认取当前时间，测试可注入） */
export function applyFrameToState(
  state: RoomState,
  frame: ServerFrame,
  now: number = Date.now(),
): Partial<RoomState> {
  switch (frame.type) {
    case 'joined':
      return {
        room: frame.room,
        name: frame.name ?? null,
        owner: frame.owner,
        members: frame.members,
        messages: frame.messages,
        meta: frame.meta ?? null,
        needPassword: false,
        lastError: null,
      }
    case 'join_need_password':
      return { needPassword: true }
    case 'member_join':
    case 'member_leave':
      if (frame.room !== state.room) return {}
      return { owner: frame.owner, members: frame.members }
    case 'qr_update': {
      if (frame.room !== state.room) return {}
      // 发送者也会收到回显；按 raw+expire_at 去重，避免重复追加
      const duplicated = state.messages.some(
        (m) => m.raw === frame.raw && m.expire_at === frame.expire_at,
      )
      // 入队时惰性淘汰已过期消息，使数组有界（对齐后端 VecDeque 的惰性淘汰）
      const messages = state.messages.some((m) => m.expire_at <= now)
        ? state.messages.filter((m) => m.expire_at > now)
        : state.messages
      if (duplicated) return messages === state.messages ? {} : { messages }
      return { messages: [...messages, { raw: frame.raw, by: frame.by, expire_at: frame.expire_at }] }
    }
    case 'sign_result':
      if (frame.room !== state.room) return {}
      return {
        signFeed: [{ by: frame.by, ok: frame.ok, reason: frame.reason, ts: frame.ts }, ...state.signFeed].slice(0, 20),
      }
    case 'plaza_update':
      return { plaza: frame.rooms }
    case 'error':
      // 房间被关闭/过期/移除 → 本地同步清空
      if (frame.code === WS_ERRORS.ROOM_NOT_FOUND && state.room !== null) return withoutRoom()
      return { lastError: { code: frame.code, msg: frame.msg, room: frame.room } }
    case 'heartbeat':
      return {}
  }
}

export const useRoom = create<RoomState>((set) => ({
  status: 'idle',
  room: null,
  name: null,
  owner: null,
  members: [],
  messages: [],
  meta: null,
  needPassword: false,
  lastError: null,
  signFeed: [],
  plaza: [],
  applyFrame: (frame) => set((st) => applyFrameToState(st, frame)),
  setStatus: (status) => set({ status }),
  setPlaza: (plaza) => set({ plaza }),
  clearRoom: () => set(() => ({ ...withoutRoom(), signFeed: [] })),
}))

/** 将 WS 句柄接入 store（幂等；应用启动时调用一次） */
let bound = false

export function bindWsToStore(handle: {
  subscribe: (fn: (frame: ServerFrame) => void) => () => void
  onStatus: (fn: (s: WsStatus) => void) => () => void
}): void {
  if (bound) return
  bound = true
  handle.subscribe((frame) => useRoom.getState().applyFrame(frame))
  handle.onStatus((s) => useRoom.getState().setStatus(s))
}
