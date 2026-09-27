import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '../api/client'
import { showCaptcha } from '../captcha'
import { useAuth } from '../stores/auth'

type Tab = 'password' | 'sms' | 'qrcode'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'password', label: '密码登录' },
  { key: 'sms', label: '短信登录' },
  { key: 'qrcode', label: '扫码登录' },
]

// 视觉样式常量（参照 qrcode_share 的 Input/Button 设计令牌）
const inputCls =
  'w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink transition-colors duration-150 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20'
const btnPrimaryCls =
  'inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors duration-150 hover:bg-ink-active focus:outline-none focus:ring-2 focus:ring-ink/30 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export default function Login() {
  const navigate = useNavigate()
  const setUserId = useAuth((s) => s.setUserId)
  const [tab, setTab] = useState<Tab>('password')
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [qrImage, setQrImage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (countdown <= 0) return
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [countdown])

  // 扫码 Tab：拉二维码 + 30s 轮询（50001 由后端转为 pending）
  useEffect(() => {
    if (tab !== 'qrcode') return
    let stop = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const resp = await api.get<{ qrImage?: string; token: string }>('/api/auth/qrcode')
        if (stop) return
        setQrImage(resp.qrImage ?? null)
        const result = await api.get<{ status: string; user_id?: number }>(
          `/api/auth/qrcode/poll?token=${encodeURIComponent(resp.token)}`,
        )
        if (stop) return
        if (result.status === 'success' && result.user_id != null) {
          setUserId(result.user_id)
          navigate('/')
          return
        }
      } catch (e) {
        if (!stop) setError(e instanceof ApiError ? e.message : '网络错误')
      }
      if (!stop) timer = setTimeout(poll, 1000)
    }
    void poll()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [tab, navigate, setUserId])

  function onLoginSuccess(userId: number) {
    setUserId(userId)
    navigate('/')
  }

  async function handlePasswordLogin() {
    setBusy(true)
    setError(null)
    try {
      const { ticket, randstr } = await showCaptcha()
      const data = await api.post<{ user_id: number }>('/api/auth/login', {
        account,
        password,
        ticket,
        rand: randstr,
      })
      onLoginSuccess(data.user_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSendSms() {
    if (countdown > 0) return
    setBusy(true)
    setError(null)
    try {
      const { ticket, randstr } = await showCaptcha()
      await api.post('/api/auth/sms/send', { phone, ticket, rand: randstr })
      setCountdown(60)
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSmsLogin() {
    setBusy(true)
    setError(null)
    try {
      const { ticket, randstr } = await showCaptcha()
      const data = await api.post<{ user_id: number }>('/api/auth/sms/verify', {
        phone,
        code: smsCode,
        ticket,
        rand: randstr,
      })
      onLoginSuccess(data.user_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-center text-2xl font-bold text-ink">雨课堂签到助手</h1>
      <div className="mt-6 flex gap-1 rounded-full bg-surface-card p-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`flex-1 rounded-full px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-ink text-on-primary' : 'text-muted hover:text-ink'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="mt-4 rounded-md bg-error/10 p-3 text-sm text-error">{error}</p>}

      {tab === 'password' && (
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void handlePasswordLogin()
          }}
        >
          <input
            className={inputCls}
            placeholder="手机号或邮箱"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
          <input
            className={inputCls}
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={busy || !account || !password} className={btnPrimaryCls}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      )}

      {tab === 'sms' && (
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSmsLogin()
          }}
        >
          <input
            className={inputCls}
            placeholder="手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className={inputCls + ' min-w-0 flex-1'}
              placeholder="短信验证码"
              value={smsCode}
              inputMode="numeric"
              onChange={(e) => setSmsCode(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || countdown > 0 || !phone}
              onClick={() => void handleSendSms()}
              className="shrink-0 rounded-md border border-hairline bg-canvas px-4 py-3 text-sm font-medium text-ink transition-colors hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {countdown > 0 ? `${countdown}s` : '发送验证码'}
            </button>
          </div>
          <button type="submit" disabled={busy || !phone || !smsCode} className={btnPrimaryCls}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      )}

      {tab === 'qrcode' && (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-lg border border-hairline bg-canvas p-6">
          {qrImage ? (
            <img src={qrImage} alt="微信扫码登录二维码" width={220} className="rounded-lg" />
          ) : (
            <p className="text-sm text-muted">二维码加载中…</p>
          )}
          <p className="text-sm text-muted">请用微信扫码，二维码过期会自动刷新</p>
        </div>
      )}
    </main>
  )
}
