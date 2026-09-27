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
    <main className="page plaza">
      <h1>广场</h1>
      <p>公开房间实时列表，点击加入后即可接收成员分享的签到码</p>
      {err && <p className="error">{err}</p>}
      {loading && <p className="muted">加载中…</p>}
      {!loading && plaza.length === 0 && <p className="muted">暂无公开房间，可以到房间页创建一个</p>}
      <ul className="plaza-list">
        {plaza.map((r) => (
          <li key={r.room_id} className="panel">
            <div>
              <strong>{r.name ?? `房间 ${r.room_id}`}</strong>
              <span className="tag">{r.members} 人在线</span>
              {r.meta && (
                <p className="muted">
                  {[r.meta.course_name, r.meta.teacher, r.meta.location, r.meta.time, r.meta.class_name]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            <button type="button" onClick={() => join(r.room_id)}>
              加入
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
