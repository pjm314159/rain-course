// 房间页自动签到逻辑回归测试（docs/SPEC.md §3.2.3 重复签到幂等）
// 覆盖三个已确认的缺陷：①只签最新一条、不补签进房历史；②同一二维码重复投递（多标签页/自身回显）只提交一次；
// ③扫码者推送后自己也立即签到，且回显不会让它再签一次。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { submitSign } from '../api/sign'
import { startQrScan } from '../lib/qr-scan'
import { useAuth } from '../stores/auth'
import { useRoom, type RoomState } from '../stores/room'
import { getWs } from '../ws/client'
import Room from './Room'

vi.mock('../api/sign', () => ({ submitSign: vi.fn() }))

vi.mock('../lib/qr-scan', () => ({ startQrScan: vi.fn(), decodeQrFromImage: vi.fn() }))

vi.mock('../ws/client', () => {
  const handle = { send: vi.fn(), ensureConnected: vi.fn(), stop: vi.fn() }
  return { getWs: () => handle }
})

const mockedSubmitSign = vi.mocked(submitSign)
const mockedStartQrScan = vi.mocked(startQrScan)

const RAW_A = 'https://www.yuketang.cn/lesson/fullscreen/v3/a?lessonid=1'
const RAW_B = 'https://www.yuketang.cn/lesson/fullscreen/v3/b?lessonid=2'

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/r/123456']}>
      <Routes>
        <Route path="/r/:roomId" element={<Room />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** 造一条未过期（默认 60s 后过期）的签到码消息 */
function qr(raw: string, expireInMs = 60_000) {
  return { raw, by: 7, expire_at: Date.now() + expireInMs }
}

/** 推送服务端帧到 store，并等 React 处理完订阅回调 */
async function pushFrame(update: Partial<RoomState>) {
  await act(async () => {
    useRoom.setState(update)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  // jsdom 未实现 scrollIntoView（消息流自动滚动用），补一个空实现
  Element.prototype.scrollIntoView = vi.fn()
  useAuth.setState({ userId: 42, probing: false })
  useRoom.setState({
    room: 123456,
    name: '测试房',
    owner: 42,
    members: [],
    messages: [],
    signFeed: [],
    lastError: null,
    needPassword: false,
  })
  mockedSubmitSign.mockResolvedValue({ status: 'success', lesson_id: 1 })
})

afterEach(cleanup)

describe('房间页自动签到', () => {
  it('默认开启：进房历史有两条未过期码时，只签最新的一条', async () => {
    renderRoom()
    await pushFrame({ messages: [qr(RAW_A), qr(RAW_B)] })
    await waitFor(() => expect(mockedSubmitSign).toHaveBeenCalledTimes(1))
    expect(mockedSubmitSign).toHaveBeenCalledWith(RAW_B)
  })

  it('同一二维码重复投递（多标签页/自身回显）只提交一次', async () => {
    renderRoom()
    await pushFrame({ messages: [qr(RAW_A)] })
    await waitFor(() => expect(mockedSubmitSign).toHaveBeenCalledTimes(1))
    // 回显的同一内容（expire_at 可能不同）不应再触发一次提交
    await pushFrame({ messages: [qr(RAW_A, 90_000)] })
    expect(mockedSubmitSign).toHaveBeenCalledTimes(1)
  })

  it('最新一条已过期时不签到', async () => {
    renderRoom()
    await pushFrame({ messages: [qr(RAW_A, -1000)] })
    await act(async () => {})
    expect(mockedSubmitSign).not.toHaveBeenCalled()
  })

  it('开关曾被显式关掉（localStorage=0）时不自动签到', async () => {
    localStorage.setItem('rain-course.auto_sign', '0')
    renderRoom()
    await pushFrame({ messages: [qr(RAW_A)] })
    await act(async () => {})
    expect(mockedSubmitSign).not.toHaveBeenCalled()
  })

  it('扫码者推送二维码后自己也立即签到，回显不会再签一次', async () => {
    // 捕获组件传给扫码引擎的识别回调，用它模拟「相机识别到内容」
    const captured: { detect?: (text: string) => boolean } = {}
    mockedStartQrScan.mockImplementation((_video, onDetect) => {
      captured.detect = onDetect
      return Promise.resolve({ stop: vi.fn() })
    })

    renderRoom()
    await userEvent.click(screen.getByRole('button', { name: '扫码分享' }))
    await waitFor(() => expect(mockedStartQrScan).toHaveBeenCalled())

    let proceed: boolean | undefined
    await act(async () => {
      proceed = captured.detect?.(RAW_A)
    })
    expect(proceed).toBe(true) // 有效签到码：推送并停止扫描
    expect(getWs().send).toHaveBeenCalledWith({ type: 'share_qr', room: 123456, raw: RAW_A })
    await waitFor(() => expect(mockedSubmitSign).toHaveBeenCalledWith(RAW_A))

    // 服务端把同一内容广播回自己：台账已认领，不再重复提交
    await pushFrame({ messages: [qr(RAW_A)] })
    expect(mockedSubmitSign).toHaveBeenCalledTimes(1)
  })
})