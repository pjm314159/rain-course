import { create } from 'zustand'
import { api } from '../api/client'

interface AuthState {
  userId: number | null
  /** 启动探测进行中（期间不能判为未登录，避免刷新闪跳登录页） */
  probing: boolean
  /** 启动时探测登录态 */
  probe: () => Promise<void>
  /** 登录成功后由调用方设置 */
  setUserId: (id: number) => void
  /** 会话过期（40101）时清空登录态 */
  clear: () => void
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  userId: null,
  probing: true,
  probe: async () => {
    set({ probing: true })
    try {
      const data = await api.get<{ user_id: number }>('/api/auth/me')
      set({ userId: data.user_id, probing: false })
    } catch {
      set({ userId: null, probing: false })
    }
  },
  setUserId: (id) => set({ userId: id }),
  clear: () => set({ userId: null }),
  logout: async () => {
    await api.post('/api/auth/logout')
    set({ userId: null })
  },
}))
