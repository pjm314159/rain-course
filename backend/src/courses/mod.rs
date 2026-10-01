//! 当前课程模块（F5）：`on-lesson` ∩ `learning_list` 实时透传（本站不落库）
//!
//! 对齐 course_helper `RCCourseApi.getCoursesList()`（course_helper/lib/api/course.dart）：
//! - `GET /v/course_meta/learning_list/` → `data` 为课程全集列表，每项含
//!   `course_id` / `classroom_id` / `classroom_name` / `course_name` / `teacher{name,avatar}`
//! - `GET /api/v3/classroom/on-lesson` → `data.onLessonClassrooms[{courseId, lessonId}]`
//! - 取二者交集：仅保留“正在上课”的课程，并把 `lessonId` 注入课程对象

pub mod routes;

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::auth::yk_client::{YkClient, map_envelope};
use crate::error::AppError;

impl YkClient {
    /// 正在上课的课程列表（已归一化为前端契约结构）
    pub async fn on_lesson_courses(&self, cookie_header: &str) -> Result<Vec<Value>, AppError> {
        let (learning, on_lesson) = tokio::try_join!(
            self.learning_list(cookie_header),
            self.on_lesson(cookie_header)
        )?;
        Ok(merge_on_lesson(&learning, &on_lesson))
    }

    /// 学习中的课程全集：`/v/course_meta/learning_list/` 的 `data` 列表
    ///
    /// 实测（2026-09-27）：`/v/course_meta/*` 成功响应无 `code` 字段（与 `user_info` 同源），
    /// 失败时才是标准信封——不能直接走 `map_envelope`
    async fn learning_list(&self, cookie_header: &str) -> Result<Vec<Value>, AppError> {
        let resp = self
            .http
            .get(format!("{}/v/course_meta/learning_list/", self.base))
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let body = parse_upstream_json(resp, "learning_list").await?;
        fail_on_error_envelope(&body)?;
        Ok(body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// 正在上课的课堂：`/api/v3/classroom/on-lesson` 的 `data.onLessonClassrooms`
    async fn on_lesson(&self, cookie_header: &str) -> Result<Vec<Value>, AppError> {
        let resp = self
            .http
            .get(format!("{}/api/v3/classroom/on-lesson", self.base))
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope = parse_upstream_json(resp, "on-lesson").await?;
        let data = map_envelope(envelope)?;
        Ok(data
            .get("onLessonClassrooms")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
}

/// 解析上游 JSON 响应：非 2xx 或解析失败时把 HTTP 状态与响应体片段写入日志，
/// 否则上游的真实返回（如被重定向到登录页的 HTML）会丢失，只看到一句「内部错误」。
/// 只记响应体（上游返回，不含凭证），绝不记录请求侧 cookie。
async fn parse_upstream_json(resp: reqwest::Response, endpoint: &str) -> Result<Value, AppError> {
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    if !status.is_success() {
        tracing::warn!(endpoint = %endpoint, status = %status, body = %body_snippet(&text), "上游返回非 2xx");
    }
    serde_json::from_str(&text).map_err(|e| {
        tracing::warn!(endpoint = %endpoint, status = %status, body = %body_snippet(&text), "上游响应不是 JSON");
        AppError::Internal(e.into())
    })
}

/// 日志用响应体片段：截断到 500 字符，避免刷爆日志
fn body_snippet(text: &str) -> String {
    if text.chars().count() <= 500 {
        text.to_string()
    } else {
        let mut s: String = text.chars().take(500).collect();
        s.push_str("…(截断)");
        s
    }
}

/// `/v/course_meta/*` 成功响应无 `code` 字段；仅当带 `code` 且非 0 时判错
fn fail_on_error_envelope(body: &Value) -> Result<(), AppError> {
    match body.get("code").and_then(Value::as_i64) {
        Some(0) | None => Ok(()),
        Some(code) => Err(AppError::Upstream {
            upstream_code: code,
            message: body
                .get("msg")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("上游未知错误")
                .to_string(),
        }),
    }
}

/// 取交集并归一化：`course_id` 为键，`onLessonClassrooms` 顺序即展示顺序
fn merge_on_lesson(learning: &[Value], on_lesson: &[Value]) -> Vec<Value> {
    let mut by_course_id: HashMap<String, &Value> = HashMap::new();
    for course in learning {
        if let Some(id) = id_text(course.get("course_id")) {
            by_course_id.insert(id, course);
        }
    }
    let mut out = Vec::new();
    for lesson in on_lesson {
        let Some(course_id) = id_text(lesson.get("courseId")) else {
            continue;
        };
        let Some(course) = by_course_id.get(&course_id) else {
            continue;
        };
        out.push(normalize(course, lesson.get("lessonId")));
    }
    out
}

/// 归一化为前端契约：课程名 / 教师 / 课堂名（班级）/ 课程头像
fn normalize(course: &Value, lesson_id: Option<&Value>) -> Value {
    json!({
        "course_id": course.get("course_id").cloned().unwrap_or(Value::Null),
        "classroom_id": course.get("classroom_id").cloned().unwrap_or(Value::Null),
        "lesson_id": lesson_id.cloned().unwrap_or(Value::Null),
        "course_name": text(course.get("course_name")),
        "classroom_name": text(course.get("classroom_name")),
        "teacher_name": text(course.pointer("/teacher/name")),
        "teacher_avatar": text(course.pointer("/teacher/avatar")),
    })
}

/// 数字/字符串统一为字符串键（上游 `course_id` 为数字、`courseId` 为字符串，类型不一致）
fn id_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 字符串字段宽松取值（数字也转字符串，缺失返回空串）
fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn learning(course_id: Value, name: &str) -> Value {
        json!({
            "course_id": course_id,
            "classroom_id": 88,
            "course_name": name,
            "classroom_name": "2023级1班",
            "teacher": {"name": "张三", "avatar": "https://x/a.png"},
        })
    }

    #[test]
    fn intersects_and_injects_lesson_id() {
        let learning = vec![
            learning(json!(1001), "高等数学"),
            learning(json!(1002), "大学英语"),
        ];
        let on_lesson = vec![
            json!({"courseId": "1001", "lessonId": 777}),
            json!({"courseId": "9999", "lessonId": 888}),
        ];
        let out = merge_on_lesson(&learning, &on_lesson);
        assert_eq!(out.len(), 1);
        let c = &out[0];
        assert_eq!(c["course_id"], 1001);
        assert_eq!(c["lesson_id"], 777);
        assert_eq!(c["course_name"], "高等数学");
        assert_eq!(c["classroom_name"], "2023级1班");
        assert_eq!(c["teacher_name"], "张三");
        assert_eq!(c["teacher_avatar"], "https://x/a.png");
    }

    #[test]
    fn empty_when_no_on_lesson() {
        let learning = vec![learning(json!(1001), "高等数学")];
        assert!(merge_on_lesson(&learning, &[]).is_empty());
    }

    #[test]
    fn missing_fields_fall_back_to_empty_strings() {
        let learning = vec![json!({"course_id": 5})];
        let on_lesson = vec![json!({"courseId": 5, "lessonId": 9})];
        let out = merge_on_lesson(&learning, &on_lesson);
        assert_eq!(out[0]["course_name"], "");
        assert_eq!(out[0]["teacher_name"], "");
    }

    #[test]
    fn learning_list_without_code_is_ok() {
        // 实测：成功响应无 code 字段（{msg,data,success} 结构）
        assert!(
            fail_on_error_envelope(&json!({"msg": "0.0.1", "data": [], "success": true})).is_ok()
        );
        assert!(fail_on_error_envelope(&json!({"code": 0, "data": []})).is_ok());
    }

    #[test]
    fn learning_list_error_envelope_is_upstream_error() {
        let err = fail_on_error_envelope(&json!({"code": 50000, "msg": "未登录"})).unwrap_err();
        match err {
            AppError::Upstream { upstream_code, .. } => assert_eq!(upstream_code, 50000),
            other => panic!("expected Upstream, got {other:?}"),
        }
    }
}
