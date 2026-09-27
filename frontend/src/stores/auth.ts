import { create } from 'zustand'
import { api } from '../api/client'

interface AuthState {
  userId: number | null
  /** 启动时探测登录态 */
  probe: () => Promise<void>
  /** 登录成功后由调用方设置 */
  setUserId: (id: number) => void
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  userId: null,
  probe: async () => {
    try {
      const data = await api.get<{ user_id: number }>('/api/auth/me')
      set({ userId: data.user_id })
    } catch {
      set({ userId: null })
    }
  },
  setUserId: (id) => set({ userId: id }),
  logout: async () => {
    await api.post('/api/auth/logout')
    set({ userId: null })
  },
}))
