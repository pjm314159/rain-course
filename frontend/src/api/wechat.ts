import { api } from './client'

/** 后端 /api/wechat/jssdk-signature 返回的签名参数（camelCase 直给 wx.config） */
export interface JssdkSignature {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
}

/** 取 JS-SDK 签名；url 必须是当前页面完整地址（# 之后部分由后端去除） */
export async function fetchJssdkSignature(url: string): Promise<JssdkSignature> {
  return api.get<JssdkSignature>(`/api/wechat/jssdk-signature?url=${encodeURIComponent(url)}`)
}