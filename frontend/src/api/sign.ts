import { api } from './client'

export interface SignSuccess {
  status: string
  lesson_id: unknown
}

/** 签到业务错误码 → 用户可读文案（后端契约见 backend/src/error.rs） */
export function describeSignError(code: number, msg: string): string {
  if (code === 40301) return '不是有效的雨课堂签到码'
  if (code === 51203) return '动态二维码已过期，请获取最新签到码'
  return msg || '签到失败'
}

export async function submitSign(url: string): Promise<SignSuccess> {
  return api.post<SignSuccess>('/api/sign/submit', { url })
}
