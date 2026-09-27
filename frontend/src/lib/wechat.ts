// 微信内 JS-SDK：UA 检测 + jweixin 动态注入 + 扫一扫（docs/SPEC.md §3.2.2 首选方案）
// 非微信环境、未配置公众号（后端 40307）或注入失败时抛错，调用方降级为相机扫码/相册识别。
// 该模块可能运行在 Worker 环境（历史坑），统一用 globalThis 访问全局对象。

import type { JssdkSignature } from '../api/wechat'

/** 官方 CDN 版 jweixin（1.6.0 为当前稳定版） */
const JWEIXIN_SRC = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js'

export interface WxConfigOptions {
  debug: boolean
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
  jsApiList: string[]
}

export interface WxScanQrCodeOptions {
  needResult: 0 | 1
  scanType?: string[]
  success?: (res: { resultStr: string }) => void
  fail?: (res: unknown) => void
  cancel?: (res: unknown) => void
}

export interface WechatJsSdk {
  config(options: WxConfigOptions): void
  ready(callback: () => void): void
  error(callback: (res: unknown) => void): void
  scanQRCode(options: WxScanQrCodeOptions): void
}

/** globalThis.wx（避免 window 以兼容 Worker/非浏览器环境） */
function getWx(): WechatJsSdk | undefined {
  return (globalThis as { wx?: WechatJsSdk }).wx
}

/** 是否微信内置浏览器（企业微信/公众号 webview 都带 MicroMessenger 标识） */
export function isWechatBrowser(ua: string = globalThis.navigator.userAgent): boolean {
  return /micromessenger/i.test(ua)
}

let loading: Promise<WechatJsSdk> | null = null

/** 动态注入 jweixin（幂等：已注入或已在加载中直接复用） */
export function loadJweixin(): Promise<WechatJsSdk> {
  const existing = getWx()
  if (existing) return Promise.resolve(existing)
  if (loading) return loading

  const promise = new Promise<WechatJsSdk>((resolve, reject) => {
    const fail = (msg: string) => {
      loading = null // 允许后续重试
      reject(new Error(msg))
    }
    const script = globalThis.document.createElement('script')
    script.src = JWEIXIN_SRC
    script.async = true
    script.onload = () => {
      const wx = getWx()
      if (wx) resolve(wx)
      else fail('微信 JS-SDK 加载失败')
    }
    script.onerror = () => fail('微信 JS-SDK 加载失败')
    globalThis.document.head.appendChild(script)
  })
  loading = promise
  return promise
}

/** 微信「扫一扫」：config → ready 后调用 scanQRCode；用户取消返回 null */
export async function wechatScanQrCode(signature: JssdkSignature): Promise<string | null> {
  const wx = await loadJweixin()

  await new Promise<void>((resolve, reject) => {
    wx.config({
      debug: false,
      appId: signature.appId,
      timestamp: signature.timestamp,
      nonceStr: signature.nonceStr,
      signature: signature.signature,
      jsApiList: ['scanQRCode'],
    })
    wx.ready(() => resolve())
    wx.error((res) => reject(new Error(describeWxError(res))))
  })

  return new Promise<string | null>((resolve, reject) => {
    wx.scanQRCode({
      needResult: 1,
      // 雨课堂签到码为二维码，限定 qrCode 可避免误扫条形码
      scanType: ['qrCode'],
      success: (res) => resolve(res.resultStr.trim() === '' ? null : res.resultStr),
      cancel: () => resolve(null),
      fail: (res) => {
        // 部分微信版本用户取消时走 fail（errMsg 形如 "scanQRCode:cancel"）
        const msg = describeWxError(res)
        if (msg.includes('cancel')) resolve(null)
        else reject(new Error(msg))
      },
    })
  })
}

/** 从 wx 回调结果里取可读错误（errMsg 形如 "scanQRCode:fail xxx"） */
function describeWxError(res: unknown): string {
  const msg = (res as { errMsg?: unknown } | null)?.errMsg
  return typeof msg === 'string' && msg !== '' ? msg : '微信接口调用失败'
}