import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { submitSign } from '../api/sign'
import { startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { useAuth } from '../stores/auth'

type Outcome = { kind: 'success'; text: string } | { kind: 'error'; text: string } | null

export default function Scan() {
  const clear = useAuth((s) => s.clear)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const handleRef = useRef<ScannerHandle | null>(null)

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

  function stopCamera() {
    handleRef.current?.stop()
    handleRef.current = null
    setScanning(false)
  }

  return (
    <main className="page scan">
      <h1>扫码签到</h1>
      <p>扫描课堂动态二维码，或手动粘贴签到链接</p>

      {outcome && <p className={outcome.kind === 'success' ? 'success' : 'error'}>{outcome.text}</p>}

      {scanning ? (
        <div className="camera">
          <video ref={videoRef} muted playsInline aria-label="相机取景" />
          <button type="button" onClick={stopCamera}>
            停止扫码
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setScanning(true)}>
          打开相机扫码
        </button>
      )}

      <div className="divider">或手动输入</div>

      <form
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
        />
        <button type="submit" disabled={busy || !manual.trim()}>
          {busy ? '签到中…' : '签到'}
        </button>
      </form>
    </main>
  )
}
