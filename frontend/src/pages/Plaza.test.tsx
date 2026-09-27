import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { fetchPlaza } from '../api/room'
import { getWs } from '../ws/client'
import { useRoom } from '../stores/room'
import Plaza from './Plaza'

vi.mock('../api/room', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPlaza: vi.fn(),
}))

vi.mock('../ws/client', () => {
  const handle = { send: vi.fn(), ensureConnected: vi.fn(), stop: vi.fn() }
  return { getWs: () => handle }
})

const mockedFetchPlaza = vi.mocked(fetchPlaza)

const ROOMS = [
  { room_id: 123456, name: '周一高数课', members: 3, created_at: 0 },
  { room_id: 654321, name: '英语角', members: 5, created_at: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  useRoom.setState({ plaza: [], room: null, needPassword: false, lastError: null })
  mockedFetchPlaza.mockResolvedValue({ rooms: ROOMS })
})

afterEach(cleanup)

function renderPlaza() {
  return render(
    <MemoryRouter>
      <Plaza />
    </MemoryRouter>,
  )
}

describe('Plaza 广场页', () => {
  it('渲染广场房间卡片', async () => {
    renderPlaza()
    expect(await screen.findByText('周一高数课')).toBeTruthy()
    expect(screen.getByText('英语角')).toBeTruthy()
    expect(screen.getByText('3 人在线')).toBeTruthy()
    expect(screen.getByText('房间 123456')).toBeTruthy()
  })

  it('搜索框按房间名过滤', async () => {
    renderPlaza()
    await screen.findByText('周一高数课')
    await userEvent.type(screen.getByPlaceholderText('搜索房间名…'), '高数')
    expect(screen.getByText('周一高数课')).toBeTruthy()
    expect(screen.queryByText('英语角')).toBeNull()
  })

  it('点击卡片打开详情对话框且只有一个「扫描二维码」按钮', async () => {
    renderPlaza()
    await screen.findByText('周一高数课')
    await userEvent.click(screen.getByText('周一高数课'))
    expect(await screen.findByText('扫描二维码')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '扫描二维码' })).toHaveLength(1)
    // 仅打开对话框不发起加入
    expect(getWs().send).not.toHaveBeenCalled()
  })

  it('详情对话框点击「扫描二维码」发送 join', async () => {
    renderPlaza()
    await screen.findByText('周一高数课')
    await userEvent.click(screen.getByText('周一高数课'))
    await userEvent.click(await screen.findByRole('button', { name: '扫描二维码' }))
    await waitFor(() =>
      expect(getWs().send).toHaveBeenCalledWith({ type: 'join', room: 123456 }),
    )
  })
})
