// 房间页：ChannelPage 式全屏布局（参照 qrcode_share，docs/DESIGN.md §4、§7）
// 顶栏：左返回 / 正中房间名（大字）+ 房号（小字）/ 右设置
// 中间：接收的签到码消息流（默认点击 URL 框才签到）
// 底栏：扫码分享 + 粘贴推送；设置抽屉：房间信息、成员、「收到消息立即签到」开关、离开/关闭房间

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { closeRoom } from '../api/room'
import { submitSign } from '../api/sign'
import { startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { useNow } from '../lib/use-now'
import { useAuth } from '../stores/auth'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'
import Modal from '../components/Modal'
import type { QrMsg } from '../ws/protocol'

// 视觉样式常量（延续 qrcode_share 设计令牌）
const cardCls = 'rounded-lg border border-hairline bg-canvas p-4'
const inputCls =
  'mt-1 w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink transition-colors duration-150 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20'

function formatCountdown(remainMs: number): string {
  const total = Math.max(0, Math.ceil(remainMs / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

function qrKey(m: QrMsg): string {
  return `${m.raw}-${m.expire_at}`
}

/** 「收到消息立即签到」开关（localStorage 持久化，默认关：点击 URL 框才签到） */
const AUTO_SIGN_KEY = 'rain-course.auto_sign'

function useAutoSign(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_SIGN_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = (v: boolean) => {
    setOn(v)
    try {
      localStorage.setItem(AUTO_SIGN_KEY, v ? '1' : '0')
    } catch {
      // 忽略存储异常
    }
  }
  return [on, set]
}

/** 签到并广播回执（手动点击与自动签到共用） */
async function signAndBroadcast(raw: string): Promise<string> {
  try {
    await submitSign(raw)
    getWs().send({ type: 'sign_result', room: useRoom.getState().room ?? 0, ok: true })
    return '签到成功'
  } catch (e) {
    const reason = e instanceof ApiError ? e.message : '网络错误'
    getWs().send({
      type: 'sign_result',
      room: useRoom.getState().room ?? 0,
      ok: false,
      reason,
    })
    return reason
  }
}

function QrCard({ raw, by, expireAt }: { raw: string; by: number; expireAt: number }) {
  const now = useNow(1000)
  const [signing, setSigning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const remain = expireAt - now
  if (remain <= 0) return null // 过期即消失（与后端删除语义一致）

  async function sign() {
    if (signing) return
    setSigning(true)
    setResult(null)
    setResult(await signAndBroadcast(raw))
    setSigning(false)
  }

  const ok = result === '签到成功'
  return (
    <li className="animate-fade-in rounded-lg border border-hairline bg-canvas p-3">
      {/* URL 框：默认签到方式就是点击这个框 */}
      <button
        type="button"
        onClick={() => void sign()}
        disabled={signing}
        title="点击签到"
        className="block w-full truncate rounded bg-surface-soft px-3 py-2.5 text-left font-mono text-xs text-body transition-colors hover:bg-surface-card focus:outline-none focus:ring-2 focus:ring-brand-teal/40 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {raw}
      </button>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">
          成员 {by} · 剩余 {formatCountdown(remain)}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {result && (
            <span className={ok ? 'font-medium text-success' : 'font-medium text-error'}>
              {result}
            </span>
          )}
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(raw)}
            className="rounded px-1.5 py-0.5 transition-colors hover:bg-surface-soft hover:text-ink"
          >
            复制
          </button>
        </span>
      </div>
    </li>
  )
}

/** 中间消息流：签到码卡片（最新在底部，自动滚动）+ 签到回执 */
function MessageStream() {
  const messages = useRoom((s) => s.messages)
  const signFeed = useRoom((s) => s.signFeed)
  const now = useNow(1000)
  const endRef = useRef<HTMLDivElement>(null)

  const live = messages.filter((m) => m.expire_at > now)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, signFeed.length])

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3 px-4 py-4">
      {live.length === 0 && (
        <div className="rounded-lg border border-dashed border-hairline bg-canvas p-8 text-center">
          <p className="text-sm font-medium text-ink">暂无签到码</p>
          <p className="mt-1 text-xs text-muted">等成员扫码或粘贴推送，收到后点击内容框即可签到</p>
        </div>
      )}
      <ul className="space-y-3">
        {live.map((m) => (
          <QrCard key={qrKey(m)} raw={m.raw} by={m.by} expireAt={m.expire_at} />
        ))}
      </ul>
      {signFeed.length > 0 && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-ink">签到回执</h3>
          <ul className="mt-2 space-y-1.5">
            {signFeed.map((f, i) => (
              <li
                key={i}
                className={
                  f.ok
                    ? 'rounded-md bg-success/10 px-3 py-1.5 text-xs text-success'
                    : 'rounded-md bg-error/10 px-3 py-1.5 text-xs text-error'
                }
              >
                成员 {f.by} {f.ok ? '签到成功' : `签到失败：${f.reason ?? '未知原因'}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-brand-teal' : 'bg-ink/20'
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

/** 设置抽屉：房间信息 + 成员 + 自动签到开关 + 离开/关闭房间 */
function SettingsPanel({
  autoSign,
  setAutoSign,
  onClose,
}: {
  autoSign: boolean
  setAutoSign: (v: boolean) => void
  onClose: () => void
}) {
  const { room, name, owner, members, meta } = useRoom()
  const userId = useAuth((s) => s.userId)
  const clearRoom = useRoom((s) => s.clearRoom)
  const [closeErr, setCloseErr] = useState<string | null>(null)

  async function handleClose() {
    if (room === null) return
    try {
      await closeRoom(room)
      clearRoom()
    } catch (e) {
      setCloseErr(e instanceof ApiError ? e.message : '关闭失败')
    }
  }

  function leave() {
    if (room === null) return
    getWs().send({ type: 'leave', room })
    clearRoom()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="h-full w-full max-w-sm animate-slide-up overflow-y-auto bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <h3 className="text-lg font-semibold text-ink">设置</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="rounded-full p-1 text-muted transition-colors hover:bg-surface-soft hover:text-ink"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-6 p-5">
          {/* 房间信息 */}
          <div>
            <h4 className="text-xs font-semibold tracking-wider text-muted uppercase">房间信息</h4>
            <div className="mt-3 space-y-2">
              <div className="rounded-md bg-surface-soft p-3">
                <p className="text-xs text-muted">房间号</p>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="font-mono text-lg font-bold tracking-[0.15em] text-ink">{room}</p>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(String(room))}
                    className="rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-card hover:text-ink"
                  >
                    复制
                  </button>
                </div>
              </div>
              <div className="rounded-md bg-surface-soft p-3">
                <p className="text-xs text-muted">房间名</p>
                <p className="mt-0.5 text-sm text-ink">{name ?? '未命名房间'}</p>
              </div>
              {meta && (
                <div className="rounded-md bg-surface-soft p-3">
                  <p className="text-xs text-muted">课程信息</p>
                  <p className="mt-0.5 text-sm text-body">
                    {[meta.course_name, meta.teacher, meta.location, meta.time, meta.class_name]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* 签到偏好 */}
          <div>
            <h4 className="text-xs font-semibold tracking-wider text-muted uppercase">签到偏好</h4>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-surface-soft p-3">
              <div>
                <p className="text-sm font-medium text-ink">收到消息立即签到</p>
                <p className="mt-0.5 text-xs text-muted">
                  开启后收到新签到码自动提交；默认关闭，需点击消息内容框才签到
                </p>
              </div>
              <Toggle checked={autoSign} onChange={setAutoSign} />
            </div>
          </div>

          {/* 成员 */}
          <div>
            <h4 className="text-xs font-semibold tracking-wider text-muted uppercase">
              成员（{members.length}）
            </h4>
            <ul className="mt-3 flex flex-wrap gap-2">
              {members.map((m) => (
                <li
                  key={m}
                  className="inline-flex items-center gap-1.5 rounded-full bg-surface-card px-3 py-1 text-sm text-ink"
                >
                  成员 {m}
                  {m === owner && (
                    <span className="rounded-full bg-brand-ochre/20 px-2 py-0.5 text-xs font-medium text-brand-ochre">
                      房主
                    </span>
                  )}
                  {m === userId && (
                    <span className="rounded-full bg-brand-mint/30 px-2 py-0.5 text-xs font-medium text-brand-teal">
                      我
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {closeErr && <p className="text-sm text-error">{closeErr}</p>}

          {/* 房间操作 */}
          <div className="space-y-2 border-t border-hairline pt-4">
            <button
              type="button"
              onClick={leave}
              className="w-full rounded-md border border-hairline px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-soft"
            >
              离开房间
            </button>
            {owner === userId && (
              <button
                type="button"
                onClick={() => void handleClose()}
                className="w-full rounded-md bg-error px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-error/90"
              >
                关闭房间
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 底栏弹出的分享编辑器：扫码（自动开相机）或粘贴 */
function ShareDialog({ mode, onClose }: { mode: 'scan' | 'paste'; onClose: () => void }) {
  const room = useRoom((s) => s.room)
  const [raw, setRaw] = useState('')
  const [scanErr, setScanErr] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scanning = mode === 'scan'

  // 扫码分享：识别即推送房间
  useEffect(() => {
    if (!scanning || !videoRef.current) return
    let cancelled = false
    let handle: ScannerHandle | null = null
    startQrScan(videoRef.current, (text) => {
      const trimmed = text.trim()
      if (!trimmed || room === null) return
      getWs().send({ type: 'share_qr', room, raw: trimmed })
      onClose()
    })
      .then((h) => {
        if (cancelled) h.stop()
        else handle = h
      })
      .catch(() => {
        if (!cancelled) setScanErr('相机不可用，请使用粘贴推送')
      })
    return () => {
      cancelled = true
      handle?.stop()
    }
  }, [scanning, room, onClose])

  return (
    <Modal onClose={onClose} title={scanning ? '扫码分享' : '粘贴推送'}>
      {scanning ? (
        <div className="mt-3">
          {scanErr ? (
            <p className="rounded-md bg-error/10 p-3 text-sm text-error">{scanErr}</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-hairline">
              <video
                ref={videoRef}
                muted
                playsInline
                aria-label="相机取景"
                className="aspect-[4/3] w-full bg-black object-cover"
              />
            </div>
          )}
          <p className="mt-2 text-xs text-muted">对准雨课堂签到二维码，识别后自动推送全房间</p>
        </div>
      ) : (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const v = raw.trim()
            if (!v || room === null) return
            getWs().send({ type: 'share_qr', room, raw: v })
            onClose()
          }}
        >
          <textarea
            rows={3}
            autoFocus
            placeholder="粘贴雨课堂签到码内容"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className={inputCls}
          />
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!raw.trim()}
          >
            推送给全房间
          </button>
        </form>
      )}
    </Modal>
  )
}

function InRoomView() {
  const room = useRoom((s) => s.room)
  const name = useRoom((s) => s.name)
  const navigate = useNavigate()
  const [autoSign, setAutoSign] = useAutoSign()
  const [showSettings, setShowSettings] = useState(false)
  const [shareMode, setShareMode] = useState<'scan' | 'paste' | null>(null)

  // 自动签到：监听 qr_update 新消息，开启时立即提交（去重，只签一次）
  const signedRef = useRef(new Set<string>())
  const autoSignRef = useRef(autoSign)
  useEffect(() => {
    autoSignRef.current = autoSign
  }, [autoSign])
  useEffect(() => {
    return useRoom.subscribe((s, prev) => {
      if (!autoSignRef.current || s.messages === prev.messages) return
      const prevKeys = new Set(prev.messages.map(qrKey))
      for (const m of s.messages) {
        const key = qrKey(m)
        if (prevKeys.has(key) || signedRef.current.has(key)) continue
        signedRef.current.add(key)
        void signAndBroadcast(m.raw)
      }
    })
  }, [])

  return (
    <>
      {/* 顶栏：左返回 / 中房间名（大字）+ 房号（小字）/ 右设置 */}
      <header className="flex items-center justify-between border-b border-hairline bg-canvas px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          aria-label="返回广场"
          className="rounded-md p-2 text-muted transition-colors hover:bg-surface-soft hover:text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="min-w-0 text-center">
          <h1 className="truncate text-lg font-bold text-ink">{name ?? '分享房间'}</h1>
          <p className="font-mono text-xs tracking-[0.2em] text-muted">{room}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label="设置"
          className="rounded-md p-2 text-muted transition-colors hover:bg-surface-soft hover:text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      {/* 中间：消息流 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessageStream />
      </div>

      {/* 底栏：扫码 + 粘贴 */}
      <div className="border-t border-hairline bg-canvas px-4 py-3">
        <div className="mx-auto flex max-w-2xl gap-2">
          <button
            type="button"
            onClick={() => setShareMode('scan')}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-pink/40 bg-brand-pink/5 px-4 py-3 text-sm font-medium text-brand-pink transition-all hover:border-brand-pink/60 hover:bg-brand-pink/10 active:scale-[0.98]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            扫码分享
          </button>
          <button
            type="button"
            onClick={() => setShareMode('paste')}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-teal/40 bg-brand-teal/5 px-4 py-3 text-sm font-medium text-brand-teal transition-all hover:border-brand-teal/60 hover:bg-brand-teal/10 active:scale-[0.98]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="8" height="4" x="8" y="2" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            </svg>
            粘贴推送
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsPanel
          autoSign={autoSign}
          setAutoSign={setAutoSign}
          onClose={() => setShowSettings(false)}
        />
      )}
      {shareMode !== null && <ShareDialog mode={shareMode} onClose={() => setShareMode(null)} />}
    </>
  )
}

export default function Room() {
  const room = useRoom((s) => s.room)

  useEffect(() => {
    getWs().ensureConnected()
  }, [])

  return (
    <div className="flex h-screen flex-col bg-canvas">
      {room === null ? (
        // 直接访问 /room 未加入任何房间 → 空态引导回广场
        <>
          <header className="flex items-center justify-between border-b border-hairline bg-canvas px-4 py-3">
            <h1 className="text-lg font-bold text-ink">分享房间</h1>
          </header>
          <div className="flex flex-1 items-center justify-center px-4">
            <div className="w-full max-w-sm rounded-lg bg-surface-card p-8 text-center">
              <p className="text-lg font-medium text-ink">尚未加入房间</p>
              <p className="mt-1 text-sm text-muted">到广场加入一个公开房间，或创建自己的房间</p>
              <Link
                to="/"
                className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
              >
                去广场
              </Link>
            </div>
          </div>
        </>
      ) : (
        <InRoomView />
      )}
    </div>
  )
}
