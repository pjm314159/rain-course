/// 统一响应信封解析：{code, msg, data}
/// - code=0 → {ok:true, data}
/// - 40101 → {ok:false, needsLogin:true}（触发跳登录）
/// - 其他  → {ok:false, code, msg}
export interface EnvelopeOk<T> {
  ok: true
  data: T
}

export interface EnvelopeErr {
  ok: false
  code: number
  msg: string
  needsLogin: boolean
}

export type Envelope<T> = EnvelopeOk<T> | EnvelopeErr

export function parseEnvelope<T = unknown>(body: unknown): Envelope<T> {
  const { code, msg, data = null } = body as { code: number; msg: string; data?: T }
  if (code === 0) return { ok: true, data: data as T }
  return { ok: false, code, msg, needsLogin: code === 40101 }
}

export function getCookie(name: string): string | null {
  for (const pair of document.cookie.split(';')) {
    const [k, ...rest] = pair.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** 业务错误（信封 code!=0）抛 ApiError，网络错误原样抛出 */
export class ApiError extends Error {
  code: number
  needsLogin: boolean

  constructor(code: number, msg: string, needsLogin: boolean) {
    super(msg)
    this.code = code
    this.needsLogin = needsLogin
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: body === undefined ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const parsed = parseEnvelope<T>(await resp.json())
  if (parsed.ok) return parsed.data
  throw new ApiError(parsed.code, parsed.msg, parsed.needsLogin)
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
}
