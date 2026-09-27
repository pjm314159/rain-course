// 广场页：首次 GET /api/plaza + WS plaza_update 实时覆盖（docs/DESIGN.md §4.3）
// 交互流：搜索过滤 → 点卡片弹详情 →「扫描二维码」申请加入（needPassword 时补密码）→ joined 后进入房间页
// 创建/加入房间通过底部操作条弹窗完成（弹窗样式参照 qrcode_share 的 PasswordModal）

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { createRoom, fetchPlaza } from '../api/room'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'
import { parseRoomInput } from '../lib/room-link'
import { WS_ERRORS, type PlazaRoom, type RoomMeta } from '../ws/protocol'
import Modal from '../components/Modal'

// 视觉样式常量（延续 qrcode_share 设计令牌）
const labelCls = 'block text-sm font-medium text-ink'
const inputCls =
  'mt-1 w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink transition-colors duration-150 focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20'
const btnPrimaryCls =
  'inline-flex w-full items-center justify-center rounded-md bg-ink px-5 py-3 text-sm font-semibold text-on-primary transition-colors duration-150 hover:bg-ink-active focus:outline-none focus:ring-2 focus:ring-ink/30 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
// 底部操作条按钮（参照 ChannelPage 的虚线品牌按钮）
const btnCreateCls =
  'flex-1 rounded-xl border-2 border-dashed border-brand-pink/40 bg-brand-pink/5 px-4 py-3 text-sm font-medium text-brand-pink transition-all hover:border-brand-pink/60 hover:bg-brand-pink/10 active:scale-[0.98]'
const btnJoinCls =
  'flex-1 rounded-xl border-2 border-dashed border-brand-teal/40 bg-brand-teal/5 px-4 py-3 text-sm font-medium text-brand-teal transition-all hover:border-brand-teal/60 hover:bg-brand-teal/10 active:scale-[0.98]'

/** 房间卡片内课程信息的拼接展示 */
function metaLine(meta: RoomMeta | undefined): string | null {
  if (!meta) return null
  const line = [meta.course_name, meta.teacher, meta.location, meta.time, meta.class_name]
    .filter(Boolean)
    .join(' · ')
  return line || null
}

/** 详情对话框：房间信息 + 唯一主按钮「扫描二维码」申请加入（needPassword 时改出密码框） */
function DetailDialog({
  room,
  error,
  onJoinIntent,
  onClose,
}: {
  room: PlazaRoom
  error: string | null
  /** 发起加入即标记，joined 帧到达后由父组件统一跳转 */
  onJoinIntent: () => void
  onClose: () => void
}) {
  const needPassword = useRoom((s) => s.needPassword)
  const [password, setPassword] = useState('')

  function requestJoin() {
    onJoinIntent()
    getWs().send({ type: 'join', room: room.room_id })
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    onJoinIntent()
    getWs().send({ type: 'join', room: room.room_id, password: password.trim() || undefined })
  }

  return (
    <Modal onClose={onClose} title={room.name ?? `房间 ${room.room_id}`}>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-muted">房间号</span>
        <strong className="text-3xl font-bold tabular-nums tracking-[0.2em] text-ink">
          {room.room_id}
        </strong>
        <span className="inline-flex items-center rounded-full bg-surface-card px-2 py-0.5 text-xs font-medium text-ink">
          {room.members} 人在线
        </span>
      </div>
      {metaLine(room.meta) && <p className="mt-2 text-sm text-body">{metaLine(room.meta)}</p>}
      <p className="mt-3 text-xs text-muted-soft">加入房间后即可在房间内扫码分享雨课堂签到码</p>
      {needPassword ? (
        <form className="mt-4 space-y-3" onSubmit={submitPassword}>
          <label className={labelCls}>
            房间密码
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          {error && <p className="text-sm text-error">{error}</p>}
          <button type="submit" className={btnPrimaryCls}>
            确认加入
          </button>
        </form>
      ) : (
        <>
          {error && <p className="mt-3 text-sm text-error">{error}</p>}
          <button type="button" className={btnPrimaryCls + ' mt-4'} onClick={requestJoin}>
            扫描二维码
          </button>
        </>
      )}
    </Modal>
  )
}

/** 创建对话框：CreateForm 逻辑原样迁入（REST 建房 + join 消息） */
function CreateDialog({
  onClose,
  onProceed,
}: {
  onClose: () => void
  onProceed: () => void
}) {
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
    const trimmed = name.trim()
    if (!trimmed) {
      setErr('请填写房间名')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const { room_id } = await createRoom({
        name: trimmed,
        password: password.trim() || undefined,
        qr_ttl_secs: Math.min(3600, Math.max(1, Math.floor(ttlMins * 60))),
        permanent,
        lifetime_mins: permanent ? undefined : Math.max(1, lifetimeMins),
        meta: Object.values(meta).some((v) => v?.trim()) ? meta : undefined,
      })
      // 创建成功即自动加入房间；WS 未 open 时由连接层排队补发
      getWs().send({ type: 'join', room: room_id, password: password.trim() || undefined })
      onProceed() // 父组件记录加入意图并关闭对话框，等待 joined 帧后跳转
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : '创建失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const metaField = (key: keyof RoomMeta, label: string) => (
    <label className={labelCls}>
      {label}
      <input
        className={inputCls}
        value={meta[key] ?? ''}
        onChange={(e) => setMeta({ ...meta, [key]: e.target.value })}
      />
    </label>
  )

  return (
    <Modal onClose={onClose} title="创建房间">
      <form className="mt-4 space-y-4" onSubmit={(e) => void submit(e)}>
        <label className={labelCls}>
          房间名<span className="text-brand-pink"> *</span>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            required
            placeholder="例如：周一高数课"
          />
        </label>
        <label className={labelCls}>
          房间密码（可选）
          <input
            className={inputCls}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={64}
          />
        </label>
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-muted transition-colors hover:text-ink"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced ? '收起课程信息' : '填写课程信息（可选）'}
        </button>
        {advanced && (
          <div className="grid grid-cols-2 gap-3 animate-slide-down">
            <label className={labelCls}>
              消息有效期（分钟，≤60）
              <input
                className={inputCls}
                type="number"
                min={1}
                max={60}
                value={ttlMins}
                onChange={(e) => setTtlMins(Number(e.target.value) || 60)}
              />
            </label>
            {!permanent && (
              <label className={labelCls}>
                生命周期（分钟，默认 240 = 4 小时）
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  value={lifetimeMins}
                  onChange={(e) => setLifetimeMins(Number(e.target.value) || 240)}
                />
              </label>
            )}
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink">
              <input
                className="h-4 w-4 accent-ink"
                type="checkbox"
                checked={permanent}
                onChange={(e) => setPermanent(e.target.checked)}
              />
              永久房间（14 天无消息仍会被回收）
            </label>
            {metaField('course_name', '课程名称')}
            {metaField('location', '上课地点')}
            {metaField('teacher', '教师')}
            {metaField('time', '上课时间')}
            {metaField('class_name', '班级')}
          </div>
        )}
        {err && <p className="text-sm text-error">{err}</p>}
        <button type="submit" className={btnPrimaryCls} disabled={busy}>
          {busy ? '创建中…' : '创建房间'}
        </button>
      </form>
    </Modal>
  )
}

/** 加入对话框：JoinForm 逻辑迁入（房间号 / 邀请短链 + needPassword 时密码框） */
function JoinDialog({
  error,
  onJoinIntent,
  onClose,
}: {
  error: string | null
  /** 发起加入即标记（带解析出的房间号），joined 帧到达后由父组件统一跳转 */
  onJoinIntent: (target: number) => void
  onClose: () => void
}) {
  const needPassword = useRoom((s) => s.needPassword)
  const [room, setRoom] = useState('')
  const [password, setPassword] = useState('')
  // 支持纯数字房间号或邀请短链（…/r/{房间号}）
  const roomId = parseRoomInput(room)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (roomId === null) return
    onJoinIntent(roomId)
    getWs().send({ type: 'join', room: roomId, password: password.trim() || undefined })
  }

  return (
    <Modal onClose={onClose} title="加入房间">
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <label className={labelCls}>
          房间号或邀请链接
          <input
            className={inputCls}
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="6 位数字房间号，或粘贴邀请链接"
          />
        </label>
        {(needPassword || password) && (
          <label className={labelCls}>
            房间密码
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={needPassword}
            />
          </label>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
        <button type="submit" className={btnPrimaryCls} disabled={!roomId}>
          确认加入
        </button>
      </form>
    </Modal>
  )
}

export default function Plaza() {
  const plaza = useRoom((s) => s.plaza)
  const room = useRoom((s) => s.room)
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [detailRoom, setDetailRoom] = useState<PlazaRoom | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)
  const joinPendingRef = useRef(false)

  useEffect(() => {
    getWs().ensureConnected()
    fetchPlaza()
      .then((r) => useRoom.getState().setPlaza(r.rooms))
      .catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败，请重试'))
      .finally(() => setLoading(false))
  }, [])

  // 加入意图已发起：joined 帧写入 room 后跳转房间页
  useEffect(() => {
    if (room !== null && joinPendingRef.current) {
      joinPendingRef.current = false
      navigate('/room')
    }
  }, [room, navigate])

  // 挂载时已存在的 lastError（如历史被踢出房间的残留）不触发 UI 反应（按引用区分新旧）
  const [baselineError] = useState(() => useRoom.getState().lastError)
  const lastError = useRoom((s) => s.lastError)
  const freshError = lastError !== baselineError ? lastError : null
  // 服务端 40404：提示房间已关闭并收起所有对话框（渲染期派生，副作用只留事件处）
  const roomClosed = freshError?.code === WS_ERRORS.ROOM_NOT_FOUND
  // 其余错误在详情/加入对话框内展示
  const dialogError =
    freshError && freshError.code !== WS_ERRORS.ROOM_NOT_FOUND && (detailRoom !== null || showJoin)
      ? freshError.msg
      : null

  // 按房间名不区分大小写过滤（后端返回全量公开房间，前端过滤）
  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase()
    if (!kw) return plaza
    return plaza.filter((r) => (r.name ?? `房间 ${r.room_id}`).toLowerCase().includes(kw))
  }, [plaza, search])

  function openDetail(r: PlazaRoom) {
    setDetailRoom(r)
    getWs().ensureConnected()
  }

  function openCreate() {
    setShowCreate(true)
    getWs().ensureConnected()
  }

  function openJoin() {
    setShowJoin(true)
    getWs().ensureConnected()
  }

  /** 创建成功后由对话框回调：标记加入意图并关闭，等待 joined 帧后跳转 */
  function markJoinPending() {
    joinPendingRef.current = true
    setShowCreate(false)
  }

  /** 详情/加入对话框发起加入：仅标记（对话框保持打开展示密码框/错误）；若已在该房间内则直接进入 */
  function joinIntent(target?: number) {
    if (target !== undefined && useRoom.getState().room === target) {
      navigate('/room')
      return
    }
    joinPendingRef.current = true
  }

  function closeDetail() {
    joinPendingRef.current = false
    setDetailRoom(null)
  }

  function closeJoin() {
    joinPendingRef.current = false
    setShowJoin(false)
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-8">
      {/* 头部横幅（参照 ChannelListPage 的渐变标题卡） */}
      <div className="relative overflow-hidden rounded-xl px-6 py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-canvas to-brand-peach/10" />
        <div className="relative z-10">
          <h1 className="text-2xl font-bold text-ink">广场</h1>
          <div className="mt-1 h-0.5 w-10 rounded-full bg-brand-pink" />
          <p className="mt-3 text-sm text-muted">
            公开房间实时列表，点击加入后即可接收成员分享的签到码
          </p>
        </div>
      </div>

      {roomClosed && (
        <p className="mt-4 rounded-md bg-error/10 p-3 text-sm text-error">房间已关闭或不存在</p>
      )}
      {err && <p className="mt-4 rounded-md bg-error/10 p-3 text-sm text-error">{err}</p>}
      {loading && <p className="mt-4 text-sm text-muted">加载中…</p>}

      {/* 搜索框（参照 ChannelList 的搜索输入） */}
      <div className="mt-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索房间名…"
          aria-label="搜索房间名"
          className="w-full rounded-md border border-hairline bg-canvas px-4 py-3 text-sm text-ink focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/20"
        />
      </div>

      {/* 房间卡片网格（ChannelCard 式：名称 + 人数 tag + 房间号 + 课程信息） */}
      {plaza.length === 0 && !loading && (
        <p className="py-12 text-center text-sm text-muted">暂无公开房间，可以创建一个</p>
      )}
      {plaza.length > 0 && filtered.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-lg font-medium text-ink">未找到匹配的房间</p>
          <p className="mt-1 text-sm text-muted">换个关键词试试</p>
        </div>
      )}
      {filtered.length > 0 && (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((r) => (
            <li key={r.room_id} className="animate-fade-in">
              <button
                type="button"
                onClick={() => openDetail(r)}
                className="w-full cursor-pointer rounded-lg border border-hairline bg-canvas p-4 text-left transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <strong className="truncate text-lg font-semibold text-ink">
                    {r.name ?? `房间 ${r.room_id}`}
                  </strong>
                  <span className="inline-flex shrink-0 items-center rounded-full bg-surface-card px-2 py-0.5 text-xs font-medium text-ink">
                    {r.members} 人在线
                  </span>
                </div>
                <p className="mt-2 font-mono text-sm tabular-nums text-muted">
                  房间 {r.room_id}
                </p>
                {metaLine(r.meta) && <p className="mt-2 text-sm text-body">{metaLine(r.meta)}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 底部固定操作条（参照 ChannelPage 的底部按钮区） */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-canvas/90 px-4 py-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl gap-2">
          <button type="button" onClick={openCreate} className={btnCreateCls}>
            创建房间
          </button>
          <button type="button" onClick={openJoin} className={btnJoinCls}>
            加入房间
          </button>
        </div>
      </div>

      {/* 对话框（条件渲染，卸载即清理；40404 时统一收起） */}
      {detailRoom !== null && !roomClosed && (
        <DetailDialog
          room={detailRoom}
          error={dialogError}
          onJoinIntent={() => joinIntent(detailRoom.room_id)}
          onClose={closeDetail}
        />
      )}
      {showCreate && !roomClosed && (
        <CreateDialog onClose={() => setShowCreate(false)} onProceed={markJoinPending} />
      )}
      {showJoin && !roomClosed && (
        <JoinDialog error={dialogError} onJoinIntent={joinIntent} onClose={closeJoin} />
      )}
    </main>
  )
}
