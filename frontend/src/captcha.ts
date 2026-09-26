// 腾讯验证码 Web JS SDK 封装（动态加载，AppId 来自后端 /api/health）
// 文档：https://cloud.tencent.com/document/product/1110/36841

interface CaptchaResult {
  ret: number
  ticket: string
  randstr: string
  errorCode?: number
  errorMessage?: string
}

interface TencentCaptchaInstance {
  show(): void
}

declare global {
  interface Window {
    TencentCaptcha?: new (
      appId: string,
      callback: (res: CaptchaResult) => void,
      options?: { bizState?: string },
    ) => TencentCaptchaInstance
  }
}

const SDK_URL = 'https://turing.captcha.qcloud.com/TJCaptcha.js'
const FALLBACK_APP_ID = '2091064951' // 雨课堂 AppId（实测不限域名）

let appId: string | null = null

/** 从后端健康检查接口获取 CaptchaAppId（一次） */
export async function loadCaptchaAppId(): Promise<string> {
  if (appId) return appId
  try {
    const resp = await fetch('/api/health')
    const body = (await resp.json()) as { data?: { captcha_app_id?: string } }
    appId = body.data?.captcha_app_id ?? FALLBACK_APP_ID
  } catch {
    appId = FALLBACK_APP_ID
  }
  return appId
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.TencentCaptcha) return resolve()
    const s = document.createElement('script')
    s.src = SDK_URL
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('验证码组件加载失败，请检查网络'))
    document.head.appendChild(s)
  })
}

/** 弹出验证码，用户通过挑战后 resolve {ticket, randstr}；取消则 reject */
export function showCaptcha(): Promise<{ ticket: string; randstr: string }> {
  return new Promise((resolve, reject) => {
    void loadCaptchaAppId()
      .then(loadScript)
      .then(() => {
        if (!window.TencentCaptcha) {
          reject(new Error('验证码组件不可用'))
          return
        }
        const captcha = new window.TencentCaptcha(appId ?? FALLBACK_APP_ID, (res) => {
          if (res.ret === 0 && res.ticket) {
            resolve({ ticket: res.ticket, randstr: res.randstr })
          } else {
            reject(new Error('验证未完成'))
          }
        })
        captcha.show()
      })
      .catch(reject)
  })
}
