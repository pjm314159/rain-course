/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基地址：同源部署留空；分离部署填 https://api.example.com */
  readonly VITE_API_BASE_URL?: string
  /** 腾讯验证码 AppId 兜底值（正常情况由后端 /api/health 下发） */
  readonly VITE_CAPTCHA_APP_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
