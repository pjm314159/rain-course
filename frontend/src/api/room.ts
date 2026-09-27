// 房间 REST API：POST /api/rooms、DELETE /api/rooms/{id}、GET /api/plaza

import { api } from './client'
import type { PlazaRoom, RoomMeta } from '../ws/protocol'

export interface CreateRoomBody {
  name?: string
  password?: string
  /** 单条消息有效期（秒，服务端钳制 (0,3600]） */
  qr_ttl_secs?: number
  /** 自定义生命周期（分钟，≥1） */
  lifetime_mins?: number
  permanent?: boolean
  meta?: RoomMeta
}

export interface CreateRoomResult {
  room_id: number
}

export function createRoom(body: CreateRoomBody): Promise<CreateRoomResult> {
  return api.post<CreateRoomResult>('/api/rooms', body)
}

export function closeRoom(roomId: number): Promise<null> {
  return api.delete<null>(`/api/rooms/${roomId}`)
}

export function fetchPlaza(): Promise<{ rooms: PlazaRoom[] }> {
  return api.get<{ rooms: PlazaRoom[] }>('/api/plaza')
}
