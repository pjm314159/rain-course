// 广场页：首次 GET /api/plaza + WS plaza_update 实时覆盖（docs/DESIGN.md §4.3）

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { fetchPlaza } from '../api/room'
import { useRoom } from '../stores/room'
import { getWs } from '../ws/client'

export default function Plaza() {
  const plaza = useRoom((s) => s.plaza)
  const navigate = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getWs().ensureConnected()
    fetchPlaza()
      .then((r) => useRoom.getState().setPlaza(r.rooms))
      .catch((e) => setErr(e instanceof ApiError ? e.message : '加载失败，请重试'))
      .finally(() => setLoading(false))
  }, [])

  function join(roomId: number) {
    getWs().send({ type: 'join', room: roomId })
    navigate('/room')
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-ink">广场</h1>
      <p className="mt-1 text-sm text-muted">
        公开房间实时列表，点击加入后即可接收成员分享的签到码
      </p>
      {err && <p className="mt-4 rounded-md bg-error/10 p-3 text-sm text-error">{err}</p>}
      {loading && <p className="mt-4 text-sm text-muted">加载中…</p>}
      {!loading && plaza.length === 0 && (
        <p className="py-12 text-center text-sm text-muted">暂无公开房间，可以到房间页创建一个</p>
      )}
      <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plaza.map((r) => (
          <li
            key={r.room_id}
            className="animate-fade-in flex flex-col justify-between gap-3 rounded-lg border border-hairline bg-canvas p-4"
          >
            <div>
              <div className="flex items-start justify-between gap-2">
                <strong className="truncate text-lg font-semibold text-ink">
                  {r.name ?? `房间 ${r.room_id}`}
                </strong>
                <span className="inline-flex shrink-0 items-center rounded-full bg-surface-card px-2 py-0.5 text-xs font-medium text-ink">
                  {r.members} 人在线
                </span>
              </div>
              {r.meta && (
                <p className="mt-2 text-sm text-body">
                  {[r.meta.course_name, r.meta.teacher, r.meta.location, r.meta.time, r.meta.class_name]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => join(r.room_id)}
              className="w-full rounded-md bg-ink px-4 py-2.5 text-sm font-semibold text-on-primary transition-colors hover:bg-ink-active"
            >
              加入
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
