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
  return { room: null, owner: null, members: [], messages: [], meta: null, needPassword: false }
}

export function applyFrameToState(state: RoomState, frame: ServerFrame): Partial<RoomState> {
  switch (frame.type) {
    case 'joined':
      return {
        room: frame.room,
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
    case 'qr_update':
      if (frame.room !== state.room) return {}
      // 服务端不回显发送者；本地也不重复追加
      return {
        messages: state.messages.some((m) => m.raw === frame.raw && m.expire_at === frame.expire_at)
          ? state.messages
          : [...state.messages, { raw: frame.raw, by: frame.by, expire_at: frame.expire_at }],
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
