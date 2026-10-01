// 房间页（路由 /r/{房间号}，ChannelPage 式全屏布局，参照 qrcode_share，docs/DESIGN.md §4、§7）
// 已在目标房间 → 直接渲染房间页；否则先申请加入（密码房弹密码框，joined 后切到房间页）——刷新不会丢房间
// 顶栏：左返回 / 正中房间名（大字）+ 房号（小字）/ 右设置
// 中间：接收的签到码消息流（默认点击 URL 框才签到）
// 底栏：扫码分享（微信内优先「微信扫一扫」，非微信/失败用全屏相机，左下角相册可本地识别图片）+ 分享房间
// 设置抽屉：房间信息、成员、「收到消息立即签到」开关、离开/关闭房间

import { memo, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { closeRoom } from '../api/room'
import { submitSign } from '../api/sign'
import { fetchJssdkSignature, fetchWechatStatus } from '../api/wechat'
import { decodeQrFromImage, startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { inviteLink } from '../lib/room-link'
import { claimSignOnce } from '../lib/sign-once'
import { isYuketangSignUrl } from '../lib/sign-url'
import { isWechatBrowser, wechatScanQrCode } from '../lib/wechat'
import { useNow } from '../lib/use-now'
import { useAuth } from '../stores/auth'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'
import type { QrMsg } from '../ws/protocol'

// 视觉样式常量（延续 qrcode_share 设计令牌）
const cardCls = 'rounded-lg border border-hairline bg-canvas p-4'

function formatCountdown(remainMs: number): string {
  const total = Math.max(0, Math.ceil(remainMs / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

function qrKey(m: QrMsg): string {
  return `${m.raw}-${m.expire_at}`
}

/** 申请加入：打开 /r/{房间号} 挂载即发一次 join（密码房补齐密码），joined 帧到达后由 Room 切到房间页 */
function JoinView({ id }: { id: number }) {
  const needPassword = useRoom((s) => s.needPassword)
  const lastError = useRoom((s) => s.lastError)
  const [password, setPassword] = useState('')
  const requestedRef = useRef(false)

  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    getWs().send({ type: 'join', room: id })
  }, [id])

  function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    getWs().send({ type: 'join', room: id, password: password.trim() || undefined })
  }

  const errText = lastError?.msg ?? null

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {needPassword ? (
          <form
            className="space-y-3 rounded-lg border border-hairline bg-canvas p-6 shadow-sm"
            onSubmit={submitPassword}
          >
            <h2 className="text-lg font-semibold text-ink">该房间需要密码</h2>
            {errText && <p className="text-sm text-error">{errText}</p>}
            <input
              className="w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入房间密码"
              autoFocus
            />
            <button
              type="submit"
              className="w-full rounded-md bg-ink px-4 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
            >
              加入房间
            </button>
          </form>
        ) : (
          <div className="rounded-lg border border-hairline bg-canvas p-8 text-center">
            {errText ? (
              <>
                <p className="text-lg font-medium text-error">{errText}</p>
                <button
                  type="button"
                  onClick={() => {
                    requestedRef.current = false
                    getWs().send({ type: 'join', room: id })
                  }}
                  className="mt-4 w-full rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
                >
                  重试
                </button>
              </>
            ) : (
              <p className="text-sm text-muted">正在加入房间 {id}…</p>
            )}
            <Link to="/" className="mt-4 block text-sm font-medium text-brand-pink hover:underline">
              去广场
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

/** 「收到消息立即签到」开关（localStorage 持久化，默认开：收到即签，关闭后点击 URL 框才签到） */
const AUTO_SIGN_KEY = 'rain-course.auto_sign'

function useAutoSign(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      // 默认开：只有显式关过（'0'）才算关
      return localStorage.getItem(AUTO_SIGN_KEY) !== '0'
    } catch {
      return true
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

/** 单条签到码卡片。memo：父级消息流每秒重渲时不重复渲染（倒计时由卡片自身 tick） */
const QrCard = memo(function QrCard({
  raw,
  by,
  expireAt,
}: {
  raw: string
  by: number
  expireAt: number
}) {
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
})

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
          <p className="mt-1 text-xs text-muted">等成员扫码分享，收到后点击内容框即可签到</p>
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
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : ''
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
  // 逐字段订阅：设置面板只依赖房间元信息，消息流/签到回执变化不应重渲抽屉
  const room = useRoom((s) => s.room)
  const name = useRoom((s) => s.name)
  const owner = useRoom((s) => s.owner)
  const members = useRoom((s) => s.members)
  const meta = useRoom((s) => s.meta)
  const userId = useAuth((s) => s.userId)
  const clearRoom = useRoom((s) => s.clearRoom)
  const navigate = useNavigate()
  const [closeErr, setCloseErr] = useState<string | null>(null)

  async function handleClose() {
    if (room === null) return
    try {
      await closeRoom(room)
      clearRoom()
      // 房间页路由带房号：离开后必须回广场，否则会立刻重新申请加入
      void navigate('/')
    } catch (e) {
      setCloseErr(e instanceof ApiError ? e.message : '关闭失败')
    }
  }

  function leave() {
    if (room === null) return
    getWs().send({ type: 'leave', room })
    clearRoom()
    void navigate('/')
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
              <div className="rounded-md bg-surface-soft p-3">
                <p className="text-xs text-muted">邀请链接</p>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="truncate font-mono text-xs text-body">{inviteLink(room)}</p>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(inviteLink(room))}
                    className="shrink-0 rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-surface-card hover:text-ink"
                  >
                    复制
                  </button>
                </div>
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

/** 把二维码内容推送给全房间（相机扫码、相册识别、微信扫一扫共用）；扫码者本人也立即签到 */
function pushQr(raw: string) {
  const room = useRoom.getState().room
  if (room === null) return
  getWs().send({ type: 'share_qr', room, raw })
  // 自己扫的码自己也要签（不看开关）；先认领台账，回显触发的自动签到就不会再签一次
  if (claimSignOnce(raw, useAuth.getState().userId ?? 0)) void signAndBroadcast(raw)
}

/** 识别到的内容推送到房间前的预校验提示（与后端 share_qr 拒绝文案一致） */
const INVALID_QR_TEXT = '不是有效的雨课堂签到码'

/** 全屏扫码分享：取景铺满，左上角关闭、左下角相册（本地识别图片，不上传服务器） */
function ScanOverlay({ onClose, onPushed }: { onClose: () => void; onPushed: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [decoding, setDecoding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 相机取景：识别到内容先本地预校验——有效则推送全房间并关闭（返回 true 停扫）；
  // 无效则提示并继续扫描（返回 false），绝不把非签到码推给全房间
  useEffect(() => {
    if (!videoRef.current) return
    let cancelled = false
    let handle: ScannerHandle | null = null
    startQrScan(videoRef.current, (text) => {
      const raw = text.trim()
      if (raw === '') return false
      if (!isYuketangSignUrl(raw)) {
        setError(INVALID_QR_TEXT)
        return false
      }
      pushQr(raw)
      onPushed()
      onClose()
      return true
    })
      .then((h) => {
        if (cancelled) h.stop()
        else handle = h
      })
      .catch(() => {
        if (!cancelled) setError('相机不可用，可从左下角相册选择二维码图片')
      })
    return () => {
      cancelled = true
      handle?.stop()
    }
  }, [onClose, onPushed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 相册：选图后本地解码 + 预校验，有效即推送（图片不离开浏览器） */
  async function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file || decoding) return
    setDecoding(true)
    setError(null)
    try {
      const text = await decodeQrFromImage(file)
      if (!isYuketangSignUrl(text)) {
        setError(INVALID_QR_TEXT)
        return
      }
      pushQr(text)
      onPushed()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片识别失败')
    } finally {
      setDecoding(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="相机取景"
        className="h-full w-full object-cover"
      />

      {/* 左上：关闭 */}
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭扫码"
        className="absolute top-4 left-4 rounded-full bg-ink/60 p-2 text-on-primary backdrop-blur-sm transition-colors hover:bg-ink/80"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* 左下：相册（上传图片本地识别） */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={decoding}
        aria-label="从相册选择二维码图片"
        className="absolute bottom-8 left-4 rounded-full bg-ink/60 p-3 text-on-primary backdrop-blur-sm transition-colors hover:bg-ink/80 disabled:opacity-60"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        aria-label="选择二维码图片"
        onChange={(e) => void pickImage(e)}
      />

      <p
        className={`absolute inset-x-0 bottom-28 px-8 text-center text-sm ${
          error ? 'text-error' : 'text-on-primary/80'
        }`}
      >
        {error ?? (decoding ? '识别中…' : '对准雨课堂签到二维码，识别后自动推送给全房间')}
      </p>
    </div>
  )
}

function InRoomView() {
  const room = useRoom((s) => s.room)
  const name = useRoom((s) => s.name)
  const navigate = useNavigate()
  const [autoSign, setAutoSign] = useAutoSign()
  const [showSettings, setShowSettings] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [wxScanning, setWxScanning] = useState(false)
  const [wxAvailable, setWxAvailable] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  /** 微信内才展示「微信扫一扫」主按钮（非微信环境保持相机扫码） */
  const inWechat = isWechatBrowser()

  // 环境预检查：仅当后端确实配置了公众号时才展示微信内扫码入口，避免点了才报错
  useEffect(() => {
    if (!inWechat) return
    fetchWechatStatus()
      .then((s) => setWxAvailable(s.available))
      .catch(() => setWxAvailable(false))
  }, [inWechat])

  // 自动签到（默认开）：只签「最新一条未过期」的码，不对进房时的历史消息逐条补签；
  // 台账（localStorage，同源标签页共享）保证多标签页、重进房、自身回显都不会重复提交
  const autoSignRef = useRef(autoSign)
  useEffect(() => {
    autoSignRef.current = autoSign
  }, [autoSign])
  useEffect(() => {
    return useRoom.subscribe((s) => {
      if (!autoSignRef.current) return
      const latest = s.messages.at(-1)
      if (latest === undefined || latest.expire_at <= Date.now()) return
      if (!claimSignOnce(latest.raw, useAuth.getState().userId ?? 0)) return
      void signAndBroadcast(latest.raw)
    })
  }, [])

  // 提示 2 秒后自动消失
  useEffect(() => {
    if (toast === null) return
    const t = setTimeout(() => setToast(null), 2000)
    return () => clearTimeout(t)
  }, [toast])

  // 服务端错误帧兜底提示（如分享内容被安全校验拒绝、频率超限）——双保险：正常路径已被本地预校验拦截
  useEffect(() => {
    return useRoom.subscribe((s, prev) => {
      if (s.lastError !== null && s.lastError !== prev.lastError) setToast(s.lastError.msg)
    })
  }, [])

  /** 分享房间：优先系统分享面板，不支持或失败则复制邀请短链 */
  async function shareRoom() {
    const link = inviteLink(room)
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: name ?? '雨课堂签到房间',
          text: `加入我的签到房间 ${room}`,
          url: link,
        })
        return
      } catch (e) {
        // 用户主动取消分享（AbortError）不再复制；其它异常回退到复制
        if (e instanceof DOMException && e.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(link)
      setToast('邀请链接已复制')
    } catch {
      setToast(link)
    }
  }

  /** 微信内「扫一扫」：签名 → wx.config → scanQRCode，结果与相机扫码同路径推送全房间 */
  async function wechatScan() {
    if (wxScanning) return
    setWxScanning(true)
    setToast(null)
    try {
      const signature = await fetchJssdkSignature(globalThis.location.href)
      const raw = (await wechatScanQrCode(signature))?.trim()
      if (!raw) return // 用户取消
      if (!isYuketangSignUrl(raw)) {
        setToast(INVALID_QR_TEXT)
        return
      }
      pushQr(raw)
      setToast('已推送到房间')
    } catch (e) {
      // 后端未配置公众号（40307）或微信侧校验失败 → 提示改用相机扫码
      setToast(e instanceof ApiError ? e.message : '微信扫一扫不可用，请改用相机扫码')
    } finally {
      setWxScanning(false)
    }
  }

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

      {/* 底栏：微信内「微信扫一扫」主位 + 相机扫码 + 分享房间 */}
      <div className="border-t border-hairline bg-canvas px-4 py-3">
        {inWechat && wxAvailable && (
          <button
            type="button"
            onClick={() => void wechatScan()}
            disabled={wxScanning}
            className="mx-auto mb-2 flex w-full max-w-2xl items-center justify-center gap-2 rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-brand-teal/90 disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            {wxScanning ? '正在调用微信扫一扫…' : '微信扫一扫'}
          </button>
        )}
        <div className="mx-auto flex max-w-2xl gap-2">
          <button
            type="button"
            onClick={() => setScanning(true)}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-pink/40 bg-brand-pink/5 px-4 py-3 text-sm font-medium text-brand-pink transition-all hover:border-brand-pink/60 hover:bg-brand-pink/10 active:scale-[0.98]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
            扫码分享
          </button>
          <button
            type="button"
            onClick={() => void shareRoom()}
            aria-label="分享房间"
            title="分享房间"
            className="flex w-14 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-brand-teal/40 bg-brand-teal/5 text-brand-teal transition-all hover:border-brand-teal/60 hover:bg-brand-teal/10 active:scale-[0.98]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <path d="m16 6-4-4-4 4" />
              <path d="M12 2v13" />
            </svg>
          </button>
        </div>
      </div>

      {toast !== null && (
        <div className="fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
          <p className="max-w-full truncate rounded-full bg-ink px-4 py-2 text-sm text-on-primary shadow-lg">
            {toast}
          </p>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          autoSign={autoSign}
          setAutoSign={setAutoSign}
          onClose={() => setShowSettings(false)}
        />
      )}
      {scanning && (
        <ScanOverlay onClose={() => setScanning(false)} onPushed={() => setToast('已推送到房间')} />
      )}
    </>
  )
}

/** 路由 /r/{房间号}：已在目标房间 → 房间页；否则申请加入；房号非法兜底 */
export default function Room() {
  const { roomId } = useParams<{ roomId: string }>()
  const id = Number(roomId)
  const valid = Number.isInteger(id) && id > 0
  const room = useRoom((s) => s.room)

  useEffect(() => {
    getWs().ensureConnected()
  }, [])

  return (
    <div className="flex h-screen flex-col bg-canvas">
      {!valid ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-sm rounded-lg bg-surface-card p-8 text-center">
            <p className="text-lg font-medium text-ink">邀请链接无效</p>
            <Link
              to="/"
              className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
            >
              去广场
            </Link>
          </div>
        </div>
      ) : room === id ? (
        <InRoomView />
      ) : (
        <JoinView id={id} />
      )}
    </div>
  )
}
