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
    <main className="page login">
      <h1>雨课堂签到助手</h1>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {tab === 'password' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handlePasswordLogin()
          }}
        >
          <input
            placeholder="手机号或邮箱"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={busy || !account || !password}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      )}

      {tab === 'sms' && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSmsLogin()
          }}
        >
          <input placeholder="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <div className="row">
            <input
              placeholder="短信验证码"
              value={smsCode}
              inputMode="numeric"
              onChange={(e) => setSmsCode(e.target.value)}
            />
            <button type="button" disabled={busy || countdown > 0 || !phone} onClick={() => void handleSendSms()}>
              {countdown > 0 ? `${countdown}s` : '发送验证码'}
            </button>
          </div>
          <button type="submit" disabled={busy || !phone || !smsCode}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      )}

      {tab === 'qrcode' && (
        <div className="qrcode">
          {qrImage ? (
            <img src={qrImage} alt="微信扫码登录二维码" width={220} />
          ) : (
            <p>二维码加载中…</p>
          )}
          <p>请用微信扫码，二维码过期会自动刷新</p>
        </div>
      )}
    </main>
  )
}
