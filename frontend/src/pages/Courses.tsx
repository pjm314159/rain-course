// 当前课程页（F5）：GET /api/courses 实时透传「正在上课」的课程
// 展示课程名 / 教师 / 课堂名（班级）/ 课程头像；支持手动刷新；无课程时空态

import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { fetchCourses, type Course } from '../api/course'

const btnRefreshCls =
  'rounded-md border border-hairline px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'

/** 课程头像：无头像或加载失败时用课程名首字兜底 */
function Avatar({ course }: { course: Course }) {
  const [failed, setFailed] = useState(false)
  if (!course.teacher_avatar || failed) {
    return (
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-card text-lg font-semibold text-ink">
        {course.course_name.trim().charAt(0) || '课'}
      </span>
    )
  }
  return (
    <img
      src={course.teacher_avatar}
      alt=""
      onError={() => setFailed(true)}
      className="h-12 w-12 shrink-0 rounded-full object-cover"
    />
  )
}

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // setState 一律在 .then/.catch 回调内，effect 内不出现同步 setState
  const load = useCallback(
    () =>
      fetchCourses()
        .then((data) => {
          setCourses(data.courses)
          setErr(null)
        })
        .catch((e: unknown) =>
          setErr(e instanceof ApiError ? e.message : '加载失败，请重试'),
        ),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function refresh() {
    setBusy(true)
    await load()
    setBusy(false)
  }

  // 首次加载中：尚无数据也无错误
  const loading = courses === null && err === null

  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-8">
      {/* 头部横幅（延续广场页的渐变标题卡） */}
      <div className="relative overflow-hidden rounded-xl px-6 py-8">
        <div className="absolute inset-0 bg-gradient-to-b from-canvas to-brand-peach/10" />
        <div className="relative z-10">
          <h1 className="text-2xl font-bold text-ink">当前课程</h1>
          <div className="mt-1 h-0.5 w-10 rounded-full bg-brand-pink" />
          <p className="mt-3 text-sm text-muted">正在上课的课程，进入房间后即可分享签到码</p>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-muted">
          {courses === null ? '\u00a0' : `共 ${courses.length} 门正在上课`}
        </span>
        <button
          type="button"
          className={btnRefreshCls}
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      {err && <p className="mt-4 rounded-md bg-error/10 p-3 text-sm text-error">{err}</p>}
      {loading && <p className="mt-4 text-sm text-muted">加载中…</p>}
      {courses !== null && courses.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-lg font-medium text-ink">当前没有正在上课的课程</p>
          <p className="mt-1 text-sm text-muted">上课开始后点「刷新」即可看到</p>
        </div>
      )}
      {courses !== null && courses.length > 0 && (
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <li key={String(c.course_id)} className="animate-fade-in">
              <div className="flex items-start gap-3 rounded-lg border border-hairline bg-canvas p-4">
                <Avatar course={c} />
                <div className="min-w-0">
                  <strong className="block truncate text-base font-semibold text-ink">
                    {c.course_name || '未知课程'}
                  </strong>
                  <p className="mt-1 truncate text-sm text-body">{c.teacher_name || '未知教师'}</p>
                  {c.classroom_name && (
                    <p className="mt-1 truncate text-xs text-muted">{c.classroom_name}</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}