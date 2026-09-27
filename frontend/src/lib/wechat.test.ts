import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JssdkSignature } from '../api/wechat'
import type { WechatJsSdk } from './wechat'

const SIGNATURE: JssdkSignature = {
  appId: 'wxapp',
  timestamp: 1700000000,
  nonceStr: 'abc123',
  signature: 'sig',
}

/** 精简版 wx 打桩：ready 同步回调，scanQRCode 按场景返回 */
function fakeWx(options: {
  ready?: boolean
  result?: string
  cancel?: boolean
  fail?: unknown
}): WechatJsSdk {
  const wx: WechatJsSdk = {
    config: vi.fn(),
    ready: vi.fn((cb: () => void) => {
      if (options.ready !== false) cb()
    }),
    error: vi.fn((cb: (res: unknown) => void) => {
      if (options.ready === false) cb({ errMsg: 'config:invalid signature' })
    }),
    scanQRCode: vi.fn((opts) => {
      if (options.cancel) opts.cancel?.({})
      else if (options.fail !== undefined) opts.fail?.(options.fail)
      else opts.success?.({ resultStr: options.result ?? '' })
    }),
  }
  return wx
}

function setWx(wx: WechatJsSdk | undefined) {
  ;(globalThis as { wx?: WechatJsSdk }).wx = wx
}

/** 取注入的 script（最后一个）并手动触发 onload（jsdom 不加载外链脚本） */
function latestScript(): HTMLScriptElement {
  const scripts = globalThis.document.head.querySelectorAll('script')
  const last = scripts[scripts.length - 1]
  if (!(last instanceof HTMLScriptElement)) throw new Error('未注入 script')
  return last
}

/** 每个用例重置模块内的 loading 缓存 */
async function freshModule() {
  vi.resetModules()
  return await import('./wechat')
}

beforeEach(() => {
  setWx(undefined)
  for (const s of Array.from(globalThis.document.head.querySelectorAll('script'))) s.remove()
})

afterEach(() => {
  setWx(undefined)
  vi.restoreAllMocks()
})

describe('isWechatBrowser', () => {
  it('识别 MicroMessenger UA（含企业微信 webview）', async () => {
    const { isWechatBrowser } = await freshModule()
    expect(
      isWechatBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0.49',
      ),
    ).toBe(true)
    expect(isWechatBrowser('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')).toBe(false)
  })
})

describe('loadJweixin', () => {
  it('已存在 globalThis.wx 时直接复用且不注入脚本', async () => {
    const { loadJweixin } = await freshModule()
    const wx = fakeWx({})
    setWx(wx)
    await expect(loadJweixin()).resolves.toBe(wx)
    expect(globalThis.document.head.querySelectorAll('script').length).toBe(0)
  })

  it('注入 jweixin 脚本，onload 后返回 wx', async () => {
    const { loadJweixin } = await freshModule()
    const pending = loadJweixin()
    const script = latestScript()
    expect(script.src).toContain('jweixin-1.6.0.js')

    const wx = fakeWx({})
    setWx(wx)
    script.dispatchEvent(new Event('load'))
    await expect(pending).resolves.toBe(wx)
  })

  it('并发调用只注入一个脚本', async () => {
    const { loadJweixin } = await freshModule()
    const a = loadJweixin()
    const b = loadJweixin()
    expect(globalThis.document.head.querySelectorAll('script').length).toBe(1)

    const wx = fakeWx({})
    setWx(wx)
    latestScript().dispatchEvent(new Event('load'))
    await expect(a).resolves.toBe(wx)
    await expect(b).resolves.toBe(wx)
  })

  it('脚本加载失败时 reject', async () => {
    const { loadJweixin } = await freshModule()
    const pending = loadJweixin()
    latestScript().dispatchEvent(new Event('error'))
    await expect(pending).rejects.toThrow('微信 JS-SDK 加载失败')
  })
})

describe('wechatScanQrCode', () => {
  it('config 走通后返回扫码结果', async () => {
    const { wechatScanQrCode, loadJweixin } = await freshModule()
    const wx = fakeWx({ result: 'https://www.yuketang.cn/c/abc' })
    setWx(wx)

    await expect(wechatScanQrCode(SIGNATURE)).resolves.toBe('https://www.yuketang.cn/c/abc')
    expect(wx.config).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'wxapp', nonceStr: 'abc123', jsApiList: ['scanQRCode'] }),
    )
    // 复用已注入的 wx，不重复加载
    await expect(loadJweixin()).resolves.toBe(wx)
  })

  it('用户取消返回 null', async () => {
    const { wechatScanQrCode } = await freshModule()
    setWx(fakeWx({ cancel: true }))
    await expect(wechatScanQrCode(SIGNATURE)).resolves.toBeNull()
  })

  it('结果为空白字符串时按取消处理', async () => {
    const { wechatScanQrCode } = await freshModule()
    setWx(fakeWx({ result: '   ' }))
    await expect(wechatScanQrCode(SIGNATURE)).resolves.toBeNull()
  })

  it('config 校验失败时 reject 并携带 errMsg', async () => {
    const { wechatScanQrCode } = await freshModule()
    setWx(fakeWx({ ready: false }))
    await expect(wechatScanQrCode(SIGNATURE)).rejects.toThrow('config:invalid signature')
  })

  it('fail 回调携带 cancel 时按取消处理（部分微信版本行为）', async () => {
    const { wechatScanQrCode } = await freshModule()
    setWx(fakeWx({ fail: { errMsg: 'scanQRCode:cancel' } }))
    await expect(wechatScanQrCode(SIGNATURE)).resolves.toBeNull()
  })

  it('scanQRCode 失败时 reject', async () => {
    const { wechatScanQrCode } = await freshModule()
    setWx(fakeWx({ fail: { errMsg: 'scanQRCode:fail permission denied' } }))
    await expect(wechatScanQrCode(SIGNATURE)).rejects.toThrow(
      'scanQRCode:fail permission denied',
    )
  })
})