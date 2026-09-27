// 当前课程 REST API：GET /api/courses（F5：on-lesson ∩ learning_list 实时透传）
// 字段与后端 courses 模块归一化结果对齐

import { api } from './client'

export interface Course {
  course_id: number | string
  classroom_id?: number | string | null
  /** 正在上课的 lessonId（暂无前端动作，供后续扩展） */
  lesson_id?: number | string | null
  course_name: string
  /** 课堂名（班级） */
  classroom_name: string
  teacher_name: string
  /** 课程头像（教师头像） */
  teacher_avatar: string
}

export function fetchCourses(): Promise<{ courses: Course[] }> {
  return api.get<{ courses: Course[] }>('/api/courses')
}