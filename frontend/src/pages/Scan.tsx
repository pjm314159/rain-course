import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { submitSign } from '../api/sign'
import { decodeQrFromImage, startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { useAuth } from '../stores/auth'

type Outcome = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null

// 视觉样式常量（参照 qrcode_share 的 Input/Button 设计令牌）
const inputCls =
  'w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink transition-colors duration-150 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20'
const btnPrimaryCls =
  'inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors duration-150 hover:bg-ink-active focus:outline-none focus:ring-2 focus:ring-ink/30 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const btnSecondaryCls =
  'rounded-md border border-hairline bg-canvas px-5 py-3 text-sm font-medium text-ink transition-colors duration-150 hover:bg-surface-soft active:bg-surface-card focus:outline-none focus:ring-2 focus:ring-ink/30 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
// 参照 ChannelPage 的 Scan & Share 虚线品牌按钮
const btnScanCls =
  'flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-pink/40 bg-brand-pink/5 px-4 py-3 text-sm font-medium text-brand-pink transition-all hover:border-brand-pink/60 hover:bg-brand-pink/10 active:scale-[0.98]'

export default function Scan() {
  const clear = useAuth((s) => s.clear)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const handleRef = useRef<ScannerHandle | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [decoding, setDecoding] = useState(false)

  // 卸载时确保相机与解码器停止
  useEffect(() => () => handleRef.current?.stop(), [])

  async function handleUrl(raw: string) {
    const url = raw.trim()
    if (!url || busy) return
    setBusy(true)
    setOutcome(null)
    try {
      await submitSign(url)
      setOutcome({ kind: 'success', text: '签到成功' })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.needsLogin) {
          clear() // RequireAuth 自动跳登录页
          return
        }
        setOutcome({ kind: 'error', text: e.message })
      } else {
        setOutcome({ kind: 'error', text: '网络错误，请重试' })
      }
    } finally {
      setBusy(false)
      setScanning(false)
    }
  }

  // 扫码状态驱动相机生命周期；检到码 → 提交 → 自动停止
  useEffect(() => {
    if (!scanning || !videoRef.current) return
    let cancelled = false
    let handle: ScannerHandle | null = null
    startQrScan(videoRef.current, (text) => {
      void handleUrl(text)
    })
      .then((h) => {
        if (cancelled) h.stop()
        else {
          handle = h
          handleRef.current = h
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setScanning(false)
        setOutcome({
          kind: 'error',
          text: e instanceof Error ? e.message : '相机启动失败，请使用手动输入',
        })
      })
    return () => {
      cancelled = true
      handle?.stop()
      handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  /** 上传图片本地识别二维码 → 识别即签到（图片不上传服务器） */
  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file || busy || decoding) return
    setDecoding(true)
    setOutcome(null)
    try {
      await handleUrl(await decodeQrFromImage(file))
    } catch (err) {
      setOutcome({ kind: 'error', text: err instanceof Error ? err.message : '图片识别失败' })
    } finally {
      setDecoding(false)
    }
  }

  function stopCamera() {
    handleRef.current?.stop()
    handleRef.current = null
    setScanning(false)
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="text-2xl font-bold text-ink">扫码签到</h1>
      <p className="mt-1 text-sm text-muted">扫描课堂动态二维码，或手动粘贴签到链接</p>

      {outcome && (
        <p
          className={`mt-4 rounded-md p-3 text-sm ${
            outcome.kind === 'success' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
          }`}
        >
          {outcome.text}
        </p>
      )}

      {scanning ? (
        <div className="mt-6 overflow-hidden rounded-xl border border-hairline">
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="相机取景"
            className="aspect-[4/3] w-full bg-black object-cover"
          />
          <button
            type="button"
            onClick={stopCamera}
            className="w-full bg-canvas py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-soft"
          >
            停止扫码
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setScanning(true)} className={btnScanCls + ' mt-6'}>
          打开相机扫码
        </button>
      )}

      <div className="my-5 text-center text-xs text-muted-soft">或上传图片识别</div>

      <div className="flex justify-center">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || decoding} className={btnSecondaryCls}>
          {decoding ? '识别中…' : '上传二维码图片'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          aria-label="选择二维码图片"
          onChange={(e) => void handleImageUpload(e)}
        />
      </div>

      <div className="my-5 text-center text-xs text-muted-soft">或手动输入</div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void handleUrl(manual)
        }}
      >
        <textarea
          placeholder="粘贴二维码内容 / 签到链接"
          value={manual}
          rows={3}
          onChange={(e) => setManual(e.target.value)}
          className={inputCls}
        />
        <button type="submit" disabled={busy || !manual.trim()} className={btnPrimaryCls}>
          {busy ? '签到中…' : '签到'}
        </button>
      </form>
    </main>
  )
}
