import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes, useNavigate } from 'react-router-dom'
import { bindWsToStore } from './stores/room'
import { useAuth } from './stores/auth'
import { getWs } from './ws/client'
import Login from './pages/Login'
import Scan from './pages/Scan'
import Room from './pages/Room'
import Plaza from './pages/Plaza'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const userId = useAuth((s) => s.userId)
  const navigate = useNavigate()
  useEffect(() => {
    if (userId === null) void navigate('/login', { replace: true })
  }, [userId, navigate])
  if (userId === null) return null
  return <>{children}</>
}

function HomeWithNav() {
  const navigate = useNavigate()
  return (
    <>
      <nav className="nav">
        <Link to="/">扫码签到</Link>
        <Link to="/room">分享房间</Link>
        <Link to="/plaza">广场</Link>
        <button
          type="button"
          className="nav-logout"
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
      </nav>
      <Routes>
        <Route path="/" element={<Scan />} />
        <Route path="/room" element={<Room />} />
        <Route path="/plaza" element={<Plaza />} />
      </Routes>
    </>
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
