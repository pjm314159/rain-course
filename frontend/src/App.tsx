import { useEffect } from 'react'
import { BrowserRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { bindWsToStore } from './stores/room'
import { useAuth } from './stores/auth'
import { getWs } from './ws/client'
import Login from './pages/Login'
import Room from './pages/Room'
import Plaza from './pages/Plaza'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const userId = useAuth((s) => s.userId)
  const probing = useAuth((s) => s.probing)
  const navigate = useNavigate()
  useEffect(() => {
    // 仅在探测结束后仍未登录才跳转；探测期间渲染空白等待结果
    if (userId === null && !probing) void navigate('/login', { replace: true })
  }, [userId, probing, navigate])
  if (userId === null) return null
  return <>{children}</>
}

function HomeWithNav() {
  const navigate = useNavigate()
  // 广场是默认落地页；扫码签到已并入房间内（分享签到码），不再有独立页
  const navLinkCls = (isActive: boolean) =>
    `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive ? 'text-ink' : 'text-muted hover:bg-surface-soft hover:text-ink'
    }`
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-hairline bg-canvas/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <nav className="flex items-center gap-1">
            <NavLink to="/" className={({ isActive }) => navLinkCls(isActive)}>
              广场
            </NavLink>
          </nav>
          <button
            type="button"
            className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-soft hover:text-ink"
            onClick={() => {
              getWs().stop()
              void useAuth
                .getState()
                .logout()
                .then(() => navigate('/login', { replace: true }))
            }}
          >
            退出登录
          </button>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Plaza />} />
      </Routes>
    </div>
  )
}

export default function App() {
  const probe = useAuth((s) => s.probe)
  useEffect(() => {
    void probe()
    // WS 句柄接入 store（幂等）；登录态生效后按需建立连接
    bindWsToStore(getWs())
    const unsub = useAuth.subscribe((s, prev) => {
      if (s.userId !== null && prev.userId === null) getWs().ensureConnected()
    })
    return unsub
  }, [probe])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* 房间页（ChannelPage 式全屏布局，不套全局导航栏）：URL 带房号，刷新不丢房间 */}
        <Route
          path="/r/:roomId"
          element={
            <RequireAuth>
              <Room />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <RequireAuth>
              <HomeWithNav />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
