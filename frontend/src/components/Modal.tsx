// 通用对话框：遮罩点击 / Esc 关闭（遮罩与卡片样式参照 qrcode_share 的 PasswordModal）
// 由父组件条件渲染控制开合，卸载时自动清理 Esc 监听

import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  onClose: () => void
  title: string
  children: ReactNode
}

export default function Modal({ onClose, title, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-sm rounded-lg bg-canvas p-6 shadow-xl animate-slide-up-sm">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}
