import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { useAuth } from '../stores/auth'
import Scan from './Scan'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { get: vi.fn(), post: vi.fn() },
}))

vi.mock('../lib/qr-scan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decodeQrFromImage: vi.fn(),
}))

import { api } from '../api/client'
import { decodeQrFromImage } from '../lib/qr-scan'

const mockedPost = vi.mocked(api.post)
const mockedDecode = vi.mocked(decodeQrFromImage)

const VALID_URL = 'https://www.yuketang.cn/c/abc123'

beforeEach(() => {
  vi.clearAllMocks()
  useAuth.setState({ userId: 42 })
})

afterEach(cleanup)

async function submitManual(url: string) {
  render(<Scan />)
  await userEvent.type(screen.getByPlaceholderText('粘贴二维码内容 / 签到链接'), url)
  await userEvent.click(screen.getByRole('button', { name: '签到' }))
}

describe('Scan 手动签到', () => {
  it('成功时展示签到成功', async () => {
    mockedPost.mockResolvedValueOnce({ status: 'success', lesson_id: 123 })
    await submitManual(VALID_URL)
    expect(mockedPost).toHaveBeenCalledWith('/api/sign/submit', { url: VALID_URL })
    await screen.findByText('签到成功')
  })

  it('40301 展示无效签到码提示', async () => {
    mockedPost.mockRejectedValueOnce(new ApiError(40301, '不是有效的雨课堂签到码', false))
    await submitManual('https://evil.com/c')
    await screen.findByText('不是有效的雨课堂签到码')
  })

  it('51203 展示过期提示', async () => {
    mockedPost.mockRejectedValueOnce(new ApiError(51203, '动态二维码已过期，请获取最新签到码', false))
    await submitManual(VALID_URL)
    await screen.findByText(/动态二维码已过期/)
  })

  it('网络错误有兜底文案', async () => {
    mockedPost.mockRejectedValueOnce(new TypeError('fetch failed'))
    await submitManual(VALID_URL)
    await screen.findByText('网络错误，请重试')
  })

  it('会话过期（40101）清空登录态触发跳登录', async () => {
    mockedPost.mockRejectedValueOnce(new ApiError(40101, '未登录或会话已过期', true))
    await submitManual(VALID_URL)
    await waitFor(() => expect(useAuth.getState().userId).toBeNull())
  })

  it('空输入不可提交', async () => {
    render(<Scan />)
    const btn = screen.getByRole('button', { name: '签到' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(mockedPost).not.toHaveBeenCalled()
  })
})

describe('Scan 上传图片识别', () => {
  it('识别出二维码后自动提交签到', async () => {
    mockedDecode.mockResolvedValueOnce(VALID_URL)
    mockedPost.mockResolvedValueOnce({ status: 'success', lesson_id: 123 })
    render(<Scan />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['fake-png'], 'qr.png', { type: 'image/png' }))
    await screen.findByText('签到成功')
    expect(mockedDecode).toHaveBeenCalledOnce()
    expect(mockedPost).toHaveBeenCalledWith('/api/sign/submit', { url: VALID_URL })
  })

  it('图片中无二维码时提示识别失败', async () => {
    mockedDecode.mockRejectedValueOnce(new Error('未能从图片中识别出二维码'))
    render(<Scan />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['x'], 'a.png', { type: 'image/png' }))
    await screen.findByText('未能从图片中识别出二维码')
    expect(mockedPost).not.toHaveBeenCalled()
  })

  it('超限图片直接拒绝且不发起签到', async () => {
    mockedDecode.mockRejectedValueOnce(new Error('图片超过 5MB，请压缩后重试'))
    render(<Scan />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['x'], 'big.png', { type: 'image/png' }))
    await screen.findByText('图片超过 5MB，请压缩后重试')
    expect(mockedPost).not.toHaveBeenCalled()
  })
})
