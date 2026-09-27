import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { fetchPlaza, createRoom } from '../api/room'
import { getWs } from '../ws/client'
import { useRoom } from '../stores/room'
import Plaza from './Plaza'

vi.mock('../api/room', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPlaza: vi.fn(),
  createRoom: vi.fn(),
}))

vi.mock('../ws/client', () => {
  const handle = { send: vi.fn(), ensureConnected: vi.fn(), stop: vi.fn() }
  return { getWs: () => handle }
})

const mockedFetchPlaza = vi.mocked(fetchPlaza)
const mockedCreateRoom = vi.mocked(createRoom)

const ROOMS = [
  { room_id: 123456, name: '周一高数课', members: 3, created_at: 0 },
  { room_id: 654321, name: '英语角', members: 5, created_at: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  useRoom.setState({ plaza: [], room: null, needPassword: false, lastError: null })
  mockedFetchPlaza.mockResolvedValue({ rooms: ROOMS })
  mockedCreateRoom.mockResolvedValue({ room_id: 999999 })
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

  it('点击卡片打开详情对话框，主按钮为「加入房间」', async () => {
    renderPlaza()
    await screen.findByText('周一高数课')
    await userEvent.click(screen.getByText('周一高数课'))
    // 底部操作条与详情对话框各有一个「加入房间」（对话框按钮在 DOM 中靠后）
    expect(await screen.findAllByRole('button', { name: '加入房间' })).toHaveLength(2)
    // 仅打开对话框不发起加入
    expect(getWs().send).not.toHaveBeenCalled()
  })

  it('详情对话框点击「加入房间」发送 join', async () => {
    renderPlaza()
    await screen.findByText('周一高数课')
    await userEvent.click(screen.getByText('周一高数课'))
    const joinButtons = await screen.findAllByRole('button', { name: '加入房间' })
    await userEvent.click(joinButtons[1])
    await waitFor(() =>
      expect(getWs().send).toHaveBeenCalledWith({ type: 'join', room: 123456 }),
    )
  })
})

describe('Plaza 创建房间对话框', () => {
  /** 打开创建对话框（底部操作条的按钮此时唯一） */
  async function openCreate() {
    renderPlaza()
    await userEvent.click(screen.getByRole('button', { name: '创建房间' }))
    await screen.findByLabelText('消息有效期')
  }
  /** 弹窗内的提交按钮（DOM 中位于底部操作条之后） */
  function submitButton() {
    return screen.getAllByRole('button', { name: '创建房间' })[1]
  }

  it('默认展示消息有效期与房间寿命，且数值输入框可删空重输', async () => {
    await openCreate()
    const ttl = screen.getByLabelText('消息有效期') as HTMLInputElement
    const life = screen.getByLabelText('房间寿命') as HTMLInputElement
    expect(ttl.value).toBe('60')
    expect(life.value).toBe('4') // 默认 240 分钟按小时显示为 4
    // 删空过程中不回弹（此前 onChange 用 `|| 默认值` 导致清空即被重置）
    await userEvent.clear(life)
    expect(life.value).toBe('')
    await userEvent.type(life, '2')
    expect(life.value).toBe('2')
  })

  it('提交时把小时换算为分钟并发送建房请求', async () => {
    await openCreate()
    await userEvent.type(screen.getByLabelText('房间名'), '测试房')
    await userEvent.clear(screen.getByLabelText('房间寿命'))
    await userEvent.type(screen.getByLabelText('房间寿命'), '2')
    await userEvent.click(submitButton())
    await waitFor(() =>
      expect(mockedCreateRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '测试房',
          qr_ttl_secs: 3600,
          permanent: false,
          lifetime_mins: 120,
        }),
      ),
    )
  })

  it('数值不合规时提交才报错且不发请求', async () => {
    await openCreate()
    await userEvent.type(screen.getByLabelText('房间名'), '测试房')
    await userEvent.clear(screen.getByLabelText('消息有效期'))
    await userEvent.type(screen.getByLabelText('消息有效期'), '90')
    // 输入过程中不报错，只在点创建时校验
    expect(screen.queryByText('消息有效期需为 1–60 的整数分钟')).toBeNull()
    await userEvent.click(submitButton())
    expect(await screen.findByText('消息有效期需为 1–60 的整数分钟')).toBeTruthy()
    expect(mockedCreateRoom).not.toHaveBeenCalled()
  })

  it('勾选永久房间后隐藏房间寿命且不发送 lifetime_mins', async () => {
    await openCreate()
    await userEvent.type(screen.getByLabelText('房间名'), '长期房')
    await userEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByLabelText('房间寿命')).toBeNull()
    await userEvent.click(submitButton())
    await waitFor(() =>
      expect(mockedCreateRoom).toHaveBeenCalledWith(
        expect.objectContaining({ name: '长期房', permanent: true, lifetime_mins: undefined }),
      ),
    )
  })
})
