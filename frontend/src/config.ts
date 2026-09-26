// 前端运行配置：来自 Vite 环境变量（frontend/.env），均有安全默认值
export const config = {
  /** 后端 API 基地址：同源部署（nginx 反代）留空即可 */
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
  /** 腾讯验证码 AppId 兜底值（优先使用后端 /api/health 下发的值） */
  captchaAppIdFallback: import.meta.env.VITE_CAPTCHA_APP_ID ?? '2091064951',
} as const
