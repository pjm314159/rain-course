import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCourses } from '../api/course'
import Courses from './Courses'

vi.mock('../api/course', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCourses: vi.fn(),
}))

const mockedFetchCourses = vi.mocked(fetchCourses)

const COURSES = [
  {
    course_id: 1001,
    lesson_id: 777,
    course_name: '高等数学',
    classroom_name: '2023级1班',
    teacher_name: '张三',
    teacher_avatar: 'https://x/a.png',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockedFetchCourses.mockResolvedValue({ courses: COURSES })
})

afterEach(cleanup)

describe('Courses 当前课程页', () => {
  it('渲染课程名/教师/课堂名与课程头像', async () => {
    render(<Courses />)
    expect(await screen.findByText('高等数学')).toBeTruthy()
    expect(screen.getByText('张三')).toBeTruthy()
    expect(screen.getByText('2023级1班')).toBeTruthy()
    expect(document.querySelector('img')?.getAttribute('src')).toBe('https://x/a.png')
    expect(screen.getByText('共 1 门正在上课')).toBeTruthy()
  })

  it('无正在上课课程时展示空态', async () => {
    mockedFetchCourses.mockResolvedValue({ courses: [] })
    render(<Courses />)
    expect(await screen.findByText('当前没有正在上课的课程')).toBeTruthy()
  })

  it('点击「刷新」重新拉取课程', async () => {
    render(<Courses />)
    await screen.findByText('高等数学')
    expect(mockedFetchCourses).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(mockedFetchCourses).toHaveBeenCalledTimes(2))
  })

  it('请求失败时展示错误提示', async () => {
    mockedFetchCourses.mockRejectedValue(new Error('boom'))
    render(<Courses />)
    expect(await screen.findByText('加载失败，请重试')).toBeTruthy()
  })
})