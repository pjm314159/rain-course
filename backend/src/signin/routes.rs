//! 签到路由：POST /api/sign/submit
//!
//! 流程（docs/DESIGN.md §5）：本站会话 → 雨课堂会话 → 域名白名单校验 →
//! 上游 scan 取 lessonId → checkin 完成签到。
//! 校验未通过的内容直接拒绝，绝不发起任何出站请求（SSRF / 钓鱼转发防线）。

use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::routes::{AppState, extract_sid};
use crate::auth::token;
use crate::error::AppError;
use crate::signin::validate::validate_qr_url;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/sign/submit", post(submit))
        .with_state(state)
}

#[derive(Deserialize)]
pub struct SubmitBody {
    /// 扫码得到的原始二维码内容（雨课堂签到 URL）
    pub url: String,
}

async fn submit(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<SubmitBody>,
) -> Result<Response, AppError> {
    // ① 本站会话
    let sid = extract_sid(&headers).ok_or(AppError::Unauthorized)?;
    let user_id = token::verify(&sid, now_unix(), &st.config.server_secret)
        .map_err(|_| AppError::Unauthorized)?;

    // ② 雨课堂会话（重启后丢失 → 引导重新登录）
    let cookie = st
        .sessions
        .read()
        .expect("session lock poisoned")
        .get(&user_id)
        .cloned()
        .ok_or(AppError::Unauthorized)?;

    // ③ 内容安全校验：未通过绝不发起出站请求
    validate_qr_url(&body.url, &st.config.yk_allowed_hosts)
        .map_err(|_| AppError::InvalidQrContent)?;

    // ④ 上游 scan → lessonId → checkin
    let lesson_id = st.yk.scan(&cookie, &body.url).await?;
    st.yk.checkin(&cookie, &lesson_id).await?;

    Ok(Json(json!({
        "code": 0, "msg": "ok",
        "data": { "status": "success", "lesson_id": lesson_id }
    }))
    .into_response())
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
    use crate::config::Config;

    const VALID_URL: &str = "https://www.yuketang.cn/c/abc123";

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

    async fn post_submit(app: Router, cookie: Option<&str>, url: &str) -> Response {
        let mut b = Request::builder()
            .method("POST")
            .uri("/api/sign/submit")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        app.oneshot(
            b.body(Body::from(json!({ "url": url }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn mock_upstream() -> MockServer {
        MockServer::start().await
    }

    async fn mount_scan_checkin(server: &MockServer, scan_code: i64, checkin_code: i64) {
        Mock::given(method("POST"))
            .and(path("/api/v3/app/scan"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"code": scan_code, "msg": "", "data": {"value": 123456}}),
                ),
            )
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v3/lesson/checkin"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": checkin_code, "msg": "", "data": {"lessonToken": "tk"}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn without_site_cookie_is_unauthorized() {
        let server = mock_upstream().await;
        let resp = post_submit(app_with(&server.uri(), None), None, VALID_URL).await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40101);
    }

    #[tokio::test]
    async fn with_tampered_site_cookie_is_unauthorized() {
        let server = mock_upstream().await;
        let bad = format!("sid={}", token::issue(42, now_unix() + 3_600, "other"));
        let resp = post_submit(app_with(&server.uri(), None), Some(&bad), VALID_URL).await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn without_rain_session_is_unauthorized() {
        // 本站 sid 有效但服务重启丢了雨课堂 cookie → 引导重新登录
        let server = mock_upstream().await;
        let resp = post_submit(
            app_with(&server.uri(), None),
            Some(&sid_cookie(42)),
            VALID_URL,
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn invalid_content_rejected_without_any_outbound_request() {
        // SSRF 防线断言：非白名单内容被 40301 拒绝，上游 mock 未挂任何路由，
        // 若发起出站请求 wiremock 返回 404 → 解析失败 → 内部错误，断言即失败
        let server = mock_upstream().await;
        let app = app_with(&server.uri(), Some("sessionid=s1"));

        for evil in [
            "http://www.yuketang.cn/c",           // 非 HTTPS
            "https://evil.com/c",                 // 非白名单域
            "https://www.yuketang.cn.evil.com/c", // 仿冒拼接
            "https://1.2.3.4/c",                  // IP 字面量
            "not-a-url",                          // 垃圾串
        ] {
            let resp = post_submit(app.clone(), Some(&sid_cookie(42)), evil).await;
            let v = body_json(resp).await;
            assert_eq!(v["code"], 40301, "{evil}");
        }
    }

    #[tokio::test]
    async fn valid_url_signs_in_successfully() {
        let server = mock_upstream().await;
        mount_scan_checkin(&server, 0, 0).await;
        let app = app_with(&server.uri(), Some("sessionid=s1"));
        let resp = post_submit(app, Some(&sid_cookie(42)), VALID_URL).await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["status"], "success");
        assert_eq!(v["data"]["lesson_id"], 123456);
    }

    #[tokio::test]
    async fn upstream_expired_maps_to_51203() {
        let server = mock_upstream().await;
        mount_scan_checkin(&server, 51203, 0).await;
        let app = app_with(&server.uri(), Some("sessionid=s1"));
        let resp = post_submit(app, Some(&sid_cookie(42)), VALID_URL).await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 51203);
        assert!(v["msg"].as_str().unwrap().contains("过期"));
    }

    #[tokio::test]
    async fn checkin_upstream_error_propagates() {
        let server = mock_upstream().await;
        // scan 成功、checkin 失败（如已签到等其他上游错误）→ 透传
        mount_scan_checkin(&server, 0, 1004).await;
        let app = app_with(&server.uri(), Some("sessionid=s1"));
        let resp = post_submit(app, Some(&sid_cookie(42)), VALID_URL).await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 51004);
    }
}
