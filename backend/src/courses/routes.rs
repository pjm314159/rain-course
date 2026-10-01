//! 当前课程路由：`GET /api/courses`（F5）
//!
//! 流程：本站会话 → 雨课堂会话 → `on-lesson` ∩ `learning_list` 实时透传（不落库）。

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::auth::routes::{AppState, extract_sid, resolve_yk_cookie};
use crate::auth::token;
use crate::error::AppError;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/courses", get(courses))
        .with_state(state)
}

async fn courses(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    // ① 本站会话（三条路都汇成 40101，必须靠日志区分：sid 缺失 / sid 校验失败 / 内存无雨课堂会话 / 上游 50000）
    let Some(sid) = extract_sid(&headers) else {
        tracing::warn!("courses: 请求未携带 sid cookie");
        return Err(AppError::Unauthorized);
    };
    let user_id = match token::verify(&sid, now_unix(), &st.config.server_secret) {
        Ok(id) => id,
        Err(e) => {
            // 只记 invalid/expired 原因，绝不记录 sid 本身
            tracing::warn!(reason = %e, "courses: sid 校验未通过");
            return Err(AppError::Unauthorized);
        }
    };

    // ② 雨课堂凭证：浏览器 HttpOnly cookie（重启不丢）优先，内存表兜底；两者皆无 → 引导重新登录
    let Some(cookie) = resolve_yk_cookie(&st, &headers, user_id) else {
        tracing::warn!(user_id, "courses: 无雨课堂凭证（需重新登录）");
        return Err(AppError::Unauthorized);
    };

    // ③ on-lesson ∩ learning_list 实时透传
    let courses = st.yk.on_lesson_courses(&cookie).await.map_err(|e| {
        match &e {
            AppError::Upstream {
                upstream_code,
                message,
            } => tracing::warn!(
                user_id,
                upstream_code,
                message = %message,
                "courses: 上游拒绝（雨课堂会话可能已失效）"
            ),
            other => tracing::error!(user_id, error = %other, "courses: 上游调用失败"),
        }
        map_session_error(e)
    })?;

    Ok(Json(json!({
        "code": 0, "msg": "ok",
        "data": { "courses": courses }
    }))
    .into_response())
}

/// 雨课堂侧 50000 = 未登录/会话失效 → 映射为本站统一登录引导（40101）
fn map_session_error(e: AppError) -> AppError {
    match e {
        AppError::Upstream {
            upstream_code: 50000,
            ..
        } => AppError::Unauthorized,
        other => other,
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::header;
    use tower::ServiceExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::auth::yk_client::YkClient;
    use crate::auth::yk_session;
    use crate::config::Config;

    fn app_with(yk_base: &str, rain_cookie: Option<&str>) -> Router {
        let state = Arc::new(AppState::new(
            Config {
                server_secret: "test-secret".into(),
                port: 3000,
                cookie_ttl_secs: 14 * 24 * 60 * 60,
                captcha_app_id: "2091064951".into(),
                yk_base_url: yk_base.into(),
                yk_allowed_hosts: vec!["www.yuketang.cn".into()],
                limits: Default::default(),
                log_dir: "logs".into(),
                wechat_app_id: None,
                wechat_app_secret: None,
            },
            YkClient::new(yk_base),
        ));
        if let Some(c) = rain_cookie {
            state
                .sessions
                .write()
                .expect("lock")
                .insert(42, c.to_string());
        }
        router(state)
    }

    fn sid_cookie(user_id: i64) -> String {
        format!(
            "sid={}",
            token::issue(user_id, now_unix() + 3_600, "test-secret")
        )
    }

    async fn get_courses(app: Router, cookie: Option<&str>) -> Response {
        let mut b = Request::builder().uri("/api/courses");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        app.oneshot(b.body(Body::empty()).unwrap()).await.unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// 上游两条链路：learning_list（课程全集）+ on-lesson（正在上课）
    async fn mount_upstream(
        server: &MockServer,
        learning: serde_json::Value,
        on_lesson: serde_json::Value,
    ) {
        Mock::given(method("GET"))
            .and(path("/v/course_meta/learning_list/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(learning))
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v3/classroom/on-lesson"))
            .respond_with(ResponseTemplate::new(200).set_body_json(on_lesson))
            .mount(server)
            .await;
    }

    fn learning_ok() -> serde_json::Value {
        json!({
            "msg": "0.0.1",
            "data": [
                {"course_id": 1001, "classroom_id": 88, "course_name": "高等数学",
                 "classroom_name": "2023级1班", "teacher": {"name": "张三", "avatar": "https://x/a.png"}},
                {"course_id": 1002, "classroom_id": 99, "course_name": "大学英语",
                 "classroom_name": "2023级2班", "teacher": {"name": "李四", "avatar": ""}}
            ],
            "success": true
        })
    }

    #[tokio::test]
    async fn without_site_cookie_is_unauthorized() {
        let server = MockServer::start().await;
        let resp = get_courses(app_with(&server.uri(), None), None).await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn without_rain_session_is_unauthorized() {
        // 本站 sid 有效、浏览器也没带 yk_session、内存表为空 → 引导重新登录
        let server = MockServer::start().await;
        let resp = get_courses(app_with(&server.uri(), None), Some(&sid_cookie(42))).await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn yk_session_cookie_survives_backend_restart() {
        // 核心回归：后端重启清空内存表，但浏览器仍持有 yk_session cookie → 课程照常
        let server = MockServer::start().await;
        mount_upstream(
            &server,
            learning_ok(),
            json!({"code": 0, "msg": "", "data": {"onLessonClassrooms": [
                {"courseId": "1001", "lessonId": 777}
            ]}}),
        )
        .await;

        let cookie = format!(
            "{}; yk_session={}",
            sid_cookie(42),
            yk_session::encode("sessionid=held-by-browser")
        );
        let resp = get_courses(app_with(&server.uri(), None), Some(&cookie)).await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["courses"][0]["course_id"], 1001);
    }

    #[tokio::test]
    async fn yk_session_cookie_takes_precedence_over_stale_memory() {
        // cookie 优先：浏览器持有效凭证时，即使内存表有旧值也用 cookie 里的
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/learning_list/"))
            .and(wiremock::matchers::header(
                "cookie",
                "sessionid=from-browser",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(learning_ok()))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v3/classroom/on-lesson"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"code": 0, "msg": "", "data": {"onLessonClassrooms": []}}),
                ),
            )
            .mount(&server)
            .await;

        let cookie = format!(
            "{}; yk_session={}",
            sid_cookie(42),
            yk_session::encode("sessionid=from-browser")
        );
        let resp = get_courses(
            app_with(&server.uri(), Some("sessionid=from-memory")),
            Some(&cookie),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 0);
    }

    #[tokio::test]
    async fn returns_intersection_with_normalized_fields() {
        let server = MockServer::start().await;
        mount_upstream(
            &server,
            learning_ok(),
            json!({"code": 0, "msg": "", "data": {"onLessonClassrooms": [
                {"courseId": "1001", "lessonId": 777},
                {"courseId": "9999", "lessonId": 888}
            ]}}),
        )
        .await;

        let resp = get_courses(
            app_with(&server.uri(), Some("sessionid=s1")),
            Some(&sid_cookie(42)),
        )
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        let courses = v["data"]["courses"].as_array().unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0]["course_id"], 1001);
        assert_eq!(courses[0]["lesson_id"], 777);
        assert_eq!(courses[0]["course_name"], "高等数学");
        assert_eq!(courses[0]["classroom_name"], "2023级1班");
        assert_eq!(courses[0]["teacher_name"], "张三");
    }

    #[tokio::test]
    async fn empty_when_no_lesson_in_progress() {
        let server = MockServer::start().await;
        mount_upstream(
            &server,
            learning_ok(),
            json!({"code": 0, "msg": "", "data": {"onLessonClassrooms": []}}),
        )
        .await;

        let resp = get_courses(
            app_with(&server.uri(), Some("sessionid=s1")),
            Some(&sid_cookie(42)),
        )
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["courses"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn rain_session_expired_maps_to_login_guide() {
        // 上游 50000（未登录）→ 40101，前端走统一登录引导
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/learning_list/"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 50000, "msg": "未登录"})),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v3/classroom/on-lesson"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 50000, "msg": "", "data": {}})),
            )
            .mount(&server)
            .await;

        let resp = get_courses(
            app_with(&server.uri(), Some("sessionid=stale")),
            Some(&sid_cookie(42)),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn on_lesson_upstream_error_propagates() {
        let server = MockServer::start().await;
        mount_upstream(
            &server,
            learning_ok(),
            json!({"code": 5100, "msg": "服务异常", "data": {}}),
        )
        .await;

        let resp = get_courses(
            app_with(&server.uri(), Some("sessionid=s1")),
            Some(&sid_cookie(42)),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 55100);
    }
}
