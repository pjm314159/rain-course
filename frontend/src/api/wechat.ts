import { api } from './client'

/** 后端 /api/wechat/jssdk-signature 返回的签名参数（camelCase 直给 wx.config） */
export interface JssdkSignature {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
}

/** 后端微信能力探测结果（available=false 时前端不展示微信内扫码入口） */
export interface WechatStatus {
  available: boolean
  reason: string | null
}

/** 探测后端是否已配置公众号（免会话；只返回是否可用，不含凭证） */
export async function fetchWechatStatus(): Promise<WechatStatus> {
  return api.get<WechatStatus>('/api/wechat/status')
}

/** 取 JS-SDK 签名；url 必须是当前页面完整地址（# 之后部分由后端去除） */
export async function fetchJssdkSignature(url: string): Promise<JssdkSignature> {
  return api.get<JssdkSignature>(`/api/wechat/jssdk-signature?url=${encodeURIComponent(url)}`)
}