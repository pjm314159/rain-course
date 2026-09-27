// 房间页：创建/加入（含密码）→ 成员列表 + 二维码分享/倒计时 + 签到回执
// docs/DESIGN.md §4、§7；验收标准 docs/SPEC.md §3.3.4

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { closeRoom, createRoom } from '../api/room'
import { submitSign } from '../api/sign'
import { startQrScan, type ScannerHandle } from '../lib/qr-scan'
import { useNow } from '../lib/use-now'
import { useAuth } from '../stores/auth'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'
import type { RoomMeta } from '../ws/protocol'

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
    <li className="qr-card">
      <code className="qr-raw">{raw}</code>
      <div className="qr-ops">
        <span className="muted">
          来自成员 {by} · 剩余 {formatCountdown(remain)}
        </span>
        <button type="button" onClick={() => void navigator.clipboard.writeText(raw)}>
          复制
        </button>
        <button type="button" onClick={() => void sign()} disabled={signing}>
          {signing ? '签到中…' : '去签到'}
        </button>
      </div>
      {result && <p className={result === '签到成功' ? 'success' : 'error'}>{result}</p>}
    </li>
  )
}

function CreateForm() {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [ttlMins, setTtlMins] = useState(60)
  const [permanent, setPermanent] = useState(false)
  const [lifetimeMins, setLifetimeMins] = useState(240)
  const [advanced, setAdvanced] = useState(false)
  const [meta, setMeta] = useState<RoomMeta>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const { room_id } = await createRoom({
        name: name.trim() || undefined,
        password: password.trim() || undefined,
        qr_ttl_secs: Math.min(3600, Math.max(1, Math.floor(ttlMins * 60))),
        permanent,
        lifetime_mins: permanent ? undefined : Math.max(1, lifetimeMins),
        meta: Object.values(meta).some((v) => v?.trim()) ? meta : undefined,
      })
      getWs().send({ type: 'join', room: room_id, password: password.trim() || undefined })
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : '创建失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const metaField = (key: keyof RoomMeta, label: string) => (
    <label>
      {label}
      <input
        value={meta[key] ?? ''}
        onChange={(e) => setMeta({ ...meta, [key]: e.target.value })}
      />
    </label>
  )

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <h2>创建房间</h2>
      <label>
        房间名（可选）
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
      </label>
      <label>
        房间密码（可选）
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={64}
        />
      </label>
      <label>
        消息有效期（分钟，≤60）
        <input
          type="number"
          min={1}
          max={60}
          value={ttlMins}
          onChange={(e) => setTtlMins(Number(e.target.value) || 60)}
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
        永久房间（14 天无消息仍会被回收）
      </label>
      {!permanent && (
        <label>
          生命周期（分钟，默认 240 = 4 小时）
          <input
            type="number"
            min={1}
            value={lifetimeMins}
            onChange={(e) => setLifetimeMins(Number(e.target.value) || 240)}
          />
        </label>
      )}
      <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
        {advanced ? '收起课程信息' : '填写课程信息（可选）'}
      </button>
      {advanced && (
        <div className="grid">
          {metaField('course_name', '课程名称')}
          {metaField('location', '上课地点')}
          {metaField('teacher', '教师')}
          {metaField('time', '上课时间')}
          {metaField('class_name', '班级')}
        </div>
      )}
      {err && <p className="error">{err}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '创建中…' : '创建房间'}
      </button>
    </form>
  )
}

function JoinForm() {
  const needPassword = useRoom((s) => s.needPassword)
  const lastError = useRoom((s) => s.lastError)
  const [room, setRoom] = useState('')
  const [password, setPassword] = useState('')
  const roomId = Number(room)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!Number.isInteger(roomId) || roomId <= 0) return
    getWs().send({ type: 'join', room: roomId, password: password.trim() || undefined })
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>加入房间</h2>
      <label>
        房间号
        <input
          inputMode="numeric"
          value={room}
          onChange={(e) => setRoom(e.target.value.replace(/\D/g, ''))}
          placeholder="6 位数字房间号"
        />
      </label>
      {(needPassword || password) && (
        <label>
          房间密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus={needPassword}
          />
        </label>
      )}
      {lastError && <p className="error">{lastError.msg}</p>}
      <button type="submit" disabled={!roomId}>
        加入房间
      </button>
    </form>
  )
}

function InRoomView() {
  const { room, owner, members, messages, meta, signFeed } = useRoom()
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
    <div className="room-view">
      <div className="panel room-head">
        <div>
          <h2>房间 {room}</h2>
          {meta && (
            <p className="muted">
              {[meta.course_name, meta.teacher, meta.location, meta.time, meta.class_name]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="room-ops">
          {owner === userId && (
            <button type="button" className="danger" onClick={() => void handleClose()}>
              关闭房间
            </button>
          )}
          <button type="button" onClick={leave}>
            离开房间
          </button>
        </div>
      </div>
      {closeErr && <p className="error">{closeErr}</p>}

      <div className="panel">
        <h3>成员（{members.length}）</h3>
        <ul className="members">
          {members.map((m) => (
            <li key={m}>
              成员 {m}
              {m === owner && <span className="tag">房主</span>}
              {m === userId && <span className="tag">我</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="panel">
        <h3>分享签到码</h3>
        {scanning ? (
          <div className="camera">
            <video ref={videoRef} muted playsInline aria-label="相机取景" />
            <button type="button" onClick={() => setScanning(false)}>
              停止扫码
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setScanning(true)}>
            打开相机扫码分享
          </button>
        )}
        <form
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
          />
          <button type="submit" disabled={!raw.trim()}>
            推送给全房间
          </button>
        </form>
      </div>

      <div className="panel">
        <h3>签到码（{messages.length}）</h3>
        {messages.length === 0 && <p className="muted">暂无，等待成员分享</p>}
        <ul className="qr-list">
          {messages.map((m) => (
            <QrCard key={`${m.raw}-${m.expire_at}`} raw={m.raw} by={m.by} expireAt={m.expire_at} />
          ))}
        </ul>
      </div>

      {signFeed.length > 0 && (
        <div className="panel">
          <h3>签到回执</h3>
          <ul className="sign-feed">
            {signFeed.map((f, i) => (
              <li key={i} className={f.ok ? 'success' : 'error'}>
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
    <main className="page room">
      <h1>分享房间</h1>
      <p>
        状态：{status}
        {room === null && (
          <>
            {' · '}
            <Link to="/plaza">去广场看看</Link>
          </>
        )}
      </p>
      {room === null ? (
        <div className="two-col">
          <CreateForm />
          <JoinForm />
        </div>
      ) : (
        <InRoomView />
      )}
    </main>
  )
}
