// WS 协议类型（与后端 src/ws/models.rs 对齐，docs/DESIGN.md §4）
// 信封：{ "type": "...", "seq": <每连接单调递增>, "ts": <unix 毫秒>, ...payload }

import { config } from '../config'

export interface RoomMeta {
  course_name?: string
  location?: string
  teacher?: string
  time?: string
  class_name?: string
}

/** 历史二维码消息（expire_at 为 unix 毫秒，供倒计时） */
export interface QrMsg {
  raw: string
  by: number
  expire_at: number
}

/** 广场列表项（仅公开房间） */
export interface PlazaRoom {
  room_id: number
  name?: string
  members: number
  created_at: number
  meta?: RoomMeta
}

/** 客户端 → 服务端 */
export type ClientMsg =
  | { type: 'join'; room: number; password?: string }
  | { type: 'leave'; room: number }
  | { type: 'share_qr'; room: number; raw: string }
  | { type: 'sign_result'; room: number; ok: boolean; reason?: string }
  | { type: 'heartbeat' }

/** 服务端 → 客户端 */
export type ServerMsg =
  | {
      type: 'joined'
      room: number
      name?: string
      owner: number
      members: number[]
      messages: QrMsg[]
      meta?: RoomMeta
    }
  | { type: 'join_need_password'; room: number }
  | { type: 'qr_update'; room: number; raw: string; by: number; expire_at: number }
  | { type: 'sign_result'; room: number; by: number; ok: boolean; reason?: string }
  | { type: 'member_join'; room: number; owner: number; members: number[] }
  | { type: 'member_leave'; room: number; owner: number; members: number[] }
  | { type: 'plaza_update'; rooms: PlazaRoom[] }
  | { type: 'error'; room?: number; code: number; msg: string }
  | { type: 'heartbeat' }

export type ServerFrame = ServerMsg & { seq: number; ts: number }

/** WS error 业务码（与后端 models::error_code 对齐，用于 UI 区分提示） */
export const WS_ERRORS = {
  WRONG_PASSWORD: 40302,
  PASSWORD_RATE_LIMITED: 40303,
  ROOM_NOT_FOUND: 40404,
  ROOM_FULL: 40901,
  NOT_IN_ROOM: 40902,
  MSG_TOO_LARGE: 40305,
  ROOMS_TOTAL_LIMIT: 40701,
  ROOMS_PER_USER_LIMIT: 40702,
  BAD_REQUEST: 40306,
} as const

/** 解析服务端文本帧；非法帧返回 null（忽略，不打断连接） */
export function parseServerFrame(text: string): ServerFrame | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v === 'object' && v !== null && 'type' in v && 'seq' in v) {
    return v as ServerFrame
  }
  return null
}

export function encodeClientMsg(msg: ClientMsg): string {
  return JSON.stringify(msg)
}

/** ws(s)://<host>/ws：同源部署（nginx 反代）直接用 location。
 *  必须用 globalThis 而非 window——连接也活在 SharedWorker 里，那里没有 window */
export function wsUrl(): string {
  if (config.apiBaseUrl) {
    return `${config.apiBaseUrl.replace(/^http/, 'ws')}/ws`
  }
  const { protocol, host } = globalThis.location
  return `${protocol.replace(/^http/, 'ws')}//${host}/ws`
}
