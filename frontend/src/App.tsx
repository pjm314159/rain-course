import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './stores/auth'
import Login from './pages/Login'

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
  return <HomeNav onLogout={() => void navigate('/login', { replace: true })} />
}

function HomeNav({ onLogout }: { onLogout: () => void }) {
  const logout = useAuth((s) => s.logout)
  const userId = useAuth((s) => s.userId)
  return (
    <main className="page">
      <h1>雨课堂签到助手</h1>
      <p>已登录（user_id: {userId}）——扫码签到开发中</p>
      <button
        onClick={() => {
          void logout().then(onLogout)
        }}
      >
        退出登录
      </button>
    </main>
  )
}

export default function App() {
  const probe = useAuth((s) => s.probe)
  useEffect(() => {
    void probe()
  }, [probe])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
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
