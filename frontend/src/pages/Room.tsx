// 房间页：房间内视图（成员 + 二维码分享/倒计时 + 签到回执）
// 加入入口在广场页（点卡片详情「扫描二维码」）；docs/DESIGN.md §4、§7

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { closeRoom } from '../api/room'
import { submitSign } from '../api/sign'
import { startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { useNow } from '../lib/use-now'
import { useAuth } from '../stores/auth'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'

// 视觉样式常量（延续 qrcode_share 设计令牌）
const cardCls = 'rounded-lg border border-hairline bg-canvas p-4'
const inputCls =
  'mt-1 w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink transition-colors duration-150 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20'
const btnPrimaryCls =
  'inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors duration-150 hover:bg-ink-active focus:outline-none focus:ring-2 focus:ring-ink/30 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

function formatCountdown(remainMs: number): string {
  const total = Math.max(0, Math.ceil(remainMs / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
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
    try {
      await submitSign(raw)
      setResult('签到成功')
      getWs().send({ type: 'sign_result', room: useRoom.getState().room ?? 0, ok: true })
    } catch (e) {
      const reason = e instanceof ApiError ? e.message : '网络错误'
      setResult(reason)
      getWs().send({ type: 'sign_result', room: useRoom.getState().room ?? 0, ok: false, reason })
    } finally {
      setSigning(false)
    }
  }

  return (
    <li className="animate-fade-in rounded-lg border border-hairline bg-canvas p-4">
      <code className="block truncate rounded bg-surface-soft px-2 py-1 font-mono text-xs text-body">
        {raw}
      </code>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          来自成员 {by} · 剩余 {formatCountdown(remain)}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(raw)}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-soft hover:text-ink"
          >
            复制
          </button>
          <button
            type="button"
            onClick={() => void sign()}
            disabled={signing}
            className="rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-ink-active disabled:cursor-not-allowed disabled:opacity-50"
          >
            {signing ? '签到中…' : '去签到'}
          </button>
        </div>
      </div>
      {result && (
        <p className={result === '签到成功' ? 'mt-2 text-xs text-success' : 'mt-2 text-xs text-error'}>
          {result}
        </p>
      )}
    </li>
  )
}

function InRoomView() {
  const { room, name, owner, members, messages, meta, signFeed } = useRoom()
  const userId = useAuth((s) => s.userId)
  const clearRoom = useRoom((s) => s.clearRoom)
  const [raw, setRaw] = useState('')
  const [scanning, setScanning] = useState(false)
  const [closeErr, setCloseErr] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  // 扫码分享：识别即推送房间
  useEffect(() => {
    if (!scanning || !videoRef.current) return
    let cancelled = false
    let handle: ScannerHandle | null = null
    startQrScan(videoRef.current, (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      getWs().send({ type: 'share_qr', room: room ?? 0, raw: trimmed })
      setScanning(false)
    })
      .then((h) => {
        if (cancelled) h.stop()
        else handle = h
      })
      .catch(() => {
        if (!cancelled) setScanning(false)
      })
    return () => {
      cancelled = true
      handle?.stop()
    }
  }, [scanning, room])

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
    <div className="mt-6 space-y-6">
      {/* 房间头部：深色品牌卡，房间号放大便于口头转述 */}
      <div className="relative overflow-hidden rounded-xl bg-brand-teal p-6 text-on-dark md:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-brand-pink opacity-20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-brand-mint opacity-10 blur-3xl"
        />
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold md:text-2xl">{name ?? '未命名房间'}</h2>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm text-on-dark-soft">房间号</span>
              <strong className="room-id text-4xl font-bold tabular-nums tracking-[0.2em] text-brand-ochre md:text-5xl">
                {room}
              </strong>
              <button
                type="button"
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-on-dark-soft transition-colors hover:bg-white/10 hover:text-on-dark"
                onClick={() => void navigator.clipboard.writeText(String(room))}
              >
                复制
              </button>
            </div>
            <p className="mt-3 text-sm text-on-dark-soft">
              告诉同学房间号即可加入；公开房间也会出现在广场
            </p>
            {meta && (
              <p className="mt-1 text-sm text-on-dark-soft">
                {[meta.course_name, meta.teacher, meta.location, meta.time, meta.class_name]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {owner === userId && (
              <button
                type="button"
                className="rounded-md bg-error px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-error/90"
                onClick={() => void handleClose()}
              >
                关闭房间
              </button>
            )}
            <button
              type="button"
              onClick={leave}
              className="rounded-md border border-white/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-white/10"
            >
              离开房间
            </button>
          </div>
        </div>
      </div>
      {closeErr && <p className="text-sm text-error">{closeErr}</p>}

      <div className={cardCls}>
        <h3 className="text-lg font-semibold text-ink">成员（{members.length}）</h3>
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

      <div className={cardCls}>
        <h3 className="text-lg font-semibold text-ink">分享签到码</h3>
        {scanning ? (
          <div className="mt-3 overflow-hidden rounded-xl border border-hairline">
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label="相机取景"
              className="aspect-[4/3] w-full bg-black object-cover"
            />
            <button
              type="button"
              onClick={() => setScanning(false)}
              className="w-full bg-canvas py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-soft"
            >
              停止扫码
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setScanning(true)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-pink/40 bg-brand-pink/5 px-4 py-3 text-sm font-medium text-brand-pink transition-all hover:border-brand-pink/60 hover:bg-brand-pink/10 active:scale-[0.98]"
          >
            打开相机扫码分享
          </button>
        )}
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            const v = raw.trim()
            if (!v || room === null) return
            getWs().send({ type: 'share_qr', room, raw: v })
            setRaw('')
          }}
        >
          <textarea
            rows={2}
            placeholder="或粘贴签到码内容"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className={inputCls}
          />
          <button type="submit" className={btnPrimaryCls} disabled={!raw.trim()}>
            推送给全房间
          </button>
        </form>
      </div>

      <div className={cardCls}>
        <h3 className="text-lg font-semibold text-ink">签到码（{messages.length}）</h3>
        {messages.length === 0 && <p className="mt-2 text-sm text-muted">暂无，等待成员分享</p>}
        <ul className="mt-3 space-y-3">
          {messages.map((m) => (
            <QrCard key={`${m.raw}-${m.expire_at}`} raw={m.raw} by={m.by} expireAt={m.expire_at} />
          ))}
        </ul>
      </div>

      {signFeed.length > 0 && (
        <div className={cardCls}>
          <h3 className="text-lg font-semibold text-ink">签到回执</h3>
          <ul className="mt-3 space-y-2">
            {signFeed.map((f, i) => (
              <li
                key={i}
                className={
                  f.ok
                    ? 'rounded-md bg-success/10 px-3 py-2 text-sm text-success'
                    : 'rounded-md bg-error/10 px-3 py-2 text-sm text-error'
                }
              >
                成员 {f.by} {f.ok ? '签到成功' : `签到失败：${f.reason ?? '未知原因'}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function Room() {
  const room = useRoom((s) => s.room)
  const status = useRoom((s) => s.status)

  useEffect(() => {
    getWs().ensureConnected()
  }, [])

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-ink">分享房间</h1>
      <p className="mt-1 text-sm text-muted">
        状态：{status}
        {room === null && (
          <>
            {' · '}
            <Link to="/" className="font-medium text-brand-pink hover:underline">
              去广场
            </Link>
          </>
        )}
      </p>
      {room === null ? (
        // 直接访问 /room 未加入任何房间 → 空态引导回广场
        <div className="mt-6 rounded-lg bg-surface-card p-8 text-center">
          <p className="text-lg font-medium text-ink">尚未加入房间</p>
          <p className="mt-1 text-sm text-muted">到广场加入一个公开房间，或创建自己的房间</p>
          <Link
            to="/"
            className="mt-4 inline-flex items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
          >
            去广场
          </Link>
        </div>
      ) : (
        <InRoomView />
      )}
    </main>
  )
}
