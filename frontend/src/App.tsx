import { useEffect } from 'react'
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './stores/auth'
import Login from './pages/Login'
import Scan from './pages/Scan'

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
      <Scan />
      <button
        className="nav-logout"
        onClick={() => {
          void useAuth
            .getState()
            .logout()
            .then(() => navigate('/login', { replace: true }))
        }}
      >
        退出登录
      </button>
    </>
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
