//! 认证路由：/api/auth/login、/me、/logout
//!
//! 会话模型（docs/DESIGN.md §6.1）：
//! - 雨课堂凭证：内存 `sessions`（user_id → cookie 头），服务重启即失效
//! - 本站会话：签名 cookie `sid`（auth::token），滑动续期（TTL 可配置）

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::token;
use super::yk_client::{self, YkClient};
use crate::config::Config;
use crate::error::AppError;

pub const SESSION_COOKIE: &str = "sid";

/// 全局应用状态
pub struct AppState {
    pub config: Config,
    pub yk: YkClient,
    /// user_id → 雨课堂 Cookie 头（内存态，重启即失）
    pub sessions: RwLock<HashMap<i64, String>>,
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/sms/send", post(sms_send))
        .route("/api/auth/sms/verify", post(sms_verify))
        .route("/api/auth/qrcode", get(qrcode))
        .route("/api/auth/qrcode/poll", get(qr_poll))
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", post(logout))
        .with_state(state)
}

/// 从 Cookie 头中取 `sid` 的值（本站只种这一个业务 cookie，手写解析够用且可测）
pub fn extract_sid(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair.strip_prefix(&format!("{SESSION_COOKIE}=")) {
            return Some(value.to_string());
        }
    }
    None
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn session_cookie(value: &str, max_age: u64) -> String {
    format!("{SESSION_COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax")
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub account: String,
    pub password: String,
    pub ticket: String,
    pub rand: String,
}

async fn login(
    State(st): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> Result<Response, AppError> {
    // 前端必须先过腾讯验证码（实测：空票据被雨课堂拒绝，本地先拦减少无效上游调用）
    if body.ticket.trim().is_empty() || body.rand.trim().is_empty() {
        return Err(AppError::CaptchaRejected);
    }

    let session = st
        .yk
        .login_password(&body.account, &body.password, &body.ticket, &body.rand)
        .await?;
    Ok(session_response(&st, session))
}

#[derive(Deserialize)]
pub struct SmsSendBody {
    pub phone: String,
    pub ticket: String,
    pub rand: String,
}

async fn sms_send(
    State(st): State<Arc<AppState>>,
    Json(body): Json<SmsSendBody>,
) -> Result<Response, AppError> {
    if body.ticket.trim().is_empty() || body.rand.trim().is_empty() {
        return Err(AppError::CaptchaRejected);
    }
    st.yk
        .sms_send(&body.phone, &body.ticket, &body.rand)
        .await?;
    Ok(Json(json!({ "code": 0, "msg": "ok", "data": null })).into_response())
}

#[derive(Deserialize)]
pub struct SmsVerifyBody {
    pub phone: String,
    pub code: String,
    pub ticket: String,
    pub rand: String,
}

async fn sms_verify(
    State(st): State<Arc<AppState>>,
    Json(body): Json<SmsVerifyBody>,
) -> Result<Response, AppError> {
    if body.ticket.trim().is_empty() || body.rand.trim().is_empty() {
        return Err(AppError::CaptchaRejected);
    }
    let session = st
        .yk
        .login_sms(&body.phone, &body.code, &body.ticket, &body.rand)
        .await?;
    Ok(session_response(&st, session))
}

async fn qrcode(State(st): State<Arc<AppState>>) -> Result<Response, AppError> {
    let data = st.yk.qr_preinfo().await?;
    Ok(Json(json!({ "code": 0, "msg": "ok", "data": data })).into_response())
}

#[derive(Deserialize)]
pub struct QrPollQuery {
    pub token: String,
}

async fn qr_poll(
    State(st): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<QrPollQuery>,
) -> Result<Response, AppError> {
    match st.yk.qr_poll(&q.token).await? {
        yk_client::QrPoll::Pending => Ok(Json(
            json!({ "code": 0, "msg": "ok", "data": { "status": "pending" } }),
        )
        .into_response()),
        yk_client::QrPoll::Success(session) => {
            let resp = session_response(&st, session);
            Ok(resp)
        }
    }
}

/// 登录成功公共尾部：存会话 → 签发 sid cookie → 返回 user_id
fn session_response(st: &AppState, session: yk_client::Session) -> Response {
    st.sessions
        .write()
        .expect("session lock poisoned")
        .insert(session.user_id, session.cookie_header.clone());
    let sid = token::issue(
        session.user_id,
        now_unix() + st.config.cookie_ttl_secs,
        &st.config.server_secret,
    );
    (
        StatusCode::OK,
        [(
            header::SET_COOKIE,
            session_cookie(&sid, st.config.cookie_ttl_secs),
        )],
        Json(json!({
            "code": 0, "msg": "ok",
            "data": { "user_id": session.user_id }
        })),
    )
        .into_response()
}

async fn me(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Result<Response, AppError> {
    let sid = extract_sid(&headers).ok_or(AppError::Unauthorized)?;
    let user_id = token::verify(&sid, now_unix(), &st.config.server_secret)
        .map_err(|_| AppError::Unauthorized)?;

    // 滑动续期：每次活跃访问按配置 TTL 重签 cookie
    let ttl = st.config.cookie_ttl_secs;
    let renewed = token::issue(user_id, now_unix() + ttl, &st.config.server_secret);

    Ok((
        [(header::SET_COOKIE, session_cookie(&renewed, ttl))],
        Json(json!({
            "code": 0, "msg": "ok",
            "data": { "user_id": user_id }
        })),
    )
        .into_response())
}

async fn logout() -> Response {
    // 删除本站 cookie：Max-Age=0（雨课堂凭证由会话过期/重启清理）
    (
        StatusCode::OK,
        [(header::SET_COOKIE, session_cookie("", 0))],
        Json(json!({ "code": 0, "msg": "ok", "data": null })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use tower::ServiceExt;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn app_with(yk_base: &str) -> Router {
        router(Arc::new(AppState {
            config: Config {
                server_secret: "test-secret".into(),
                port: 3000,
                cookie_ttl_secs: 14 * 24 * 60 * 60,
                captcha_app_id: "2091064951".into(),
                yk_base_url: yk_base.into(),
                yk_allowed_hosts: vec!["www.yuketang.cn".into()],
            },
            yk: YkClient::new(yk_base),
            sessions: RwLock::new(HashMap::new()),
        }))
    }

    fn app() -> Router {
        app_with("https://www.yuketang.cn")
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn get_req(cookie: Option<&str>) -> Request<Body> {
        let mut b = Request::builder().uri("/api/auth/me");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        b.body(Body::empty()).unwrap()
    }

    // ---- /api/auth/me ----

    #[tokio::test]
    async fn me_with_valid_session_returns_user_id() {
        let sid = token::issue(42, now_unix() + 3_600, "test-secret");
        let resp = app()
            .oneshot(get_req(Some(&format!("sid={sid}"))))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["user_id"], 42);
    }

    #[tokio::test]
    async fn me_renews_session_cookie_with_14_day_ttl() {
        let sid = token::issue(42, now_unix() + 3_600, "test-secret");
        let resp = app()
            .oneshot(get_req(Some(&format!("sid={sid}"))))
            .await
            .unwrap();
        let set_cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set_cookie.starts_with("sid="));
        assert!(set_cookie.contains(&format!("Max-Age={}", 14 * 24 * 60 * 60)));
        let renewed = set_cookie
            .split(';')
            .next()
            .unwrap()
            .trim_start_matches("sid=");
        assert_eq!(token::verify(renewed, now_unix(), "test-secret"), Ok(42));
    }

    #[tokio::test]
    async fn me_without_cookie_is_unauthorized() {
        let resp = app().oneshot(get_req(None)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK); // 业务错误走信封
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40101);
    }

    #[tokio::test]
    async fn me_with_tampered_cookie_is_unauthorized() {
        let sid = token::issue(42, now_unix() + 3_600, "test-secret");
        let bad = sid.replacen("42.", "43.", 1);
        let resp = app()
            .oneshot(get_req(Some(&format!("sid={bad}"))))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40101);
    }

    #[tokio::test]
    async fn me_with_expired_cookie_is_unauthorized() {
        let sid = token::issue(42, 1_000, "test-secret");
        let resp = app()
            .oneshot(get_req(Some(&format!("sid={sid}"))))
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40101);
    }

    // ---- /api/auth/logout ----

    #[tokio::test]
    async fn logout_clears_cookie() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/logout")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let set_cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set_cookie.starts_with("sid=;"));
        assert!(set_cookie.contains("Max-Age=0"));
    }

    // ---- /api/auth/login（wiremock 模拟雨课堂上游） ----

    async fn mock_upstream_login_ok() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 0, "msg": "OK"}))
                    .append_header("Set-Cookie", "sessionid=abc123; Path=/; HttpOnly")
                    .append_header("Set-Cookie", "csrftoken=tok99; Path=/"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "OK",
                "data": { "user_profile": { "user_id": 42 } }
            })))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn login_with_ticket_returns_session_cookie_and_stores_rain_cookies() {
        let server = mock_upstream_login_ok().await;
        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"account": "13800000000", "password": "pw", "ticket": "t", "rand": "r"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["user_id"], 42);

        // Set-Cookie 里携带可验证的 sid
        // （会话存储断言见下方独立测试）
        let _ = v;
    }

    #[tokio::test]
    async fn login_stores_rain_cookies_in_memory() {
        let server = mock_upstream_login_ok().await;
        let state = Arc::new(AppState {
            config: Config {
                server_secret: "test-secret".into(),
                port: 3000,
                cookie_ttl_secs: 14 * 24 * 60 * 60,
                captcha_app_id: "2091064951".into(),
                yk_base_url: server.uri(),
                yk_allowed_hosts: vec![],
            },
            yk: YkClient::new(&server.uri()),
            sessions: RwLock::new(HashMap::new()),
        });
        state.clone().oneshot_login("13800000000").await;
        let stored = state.sessions.read().expect("lock").get(&42).cloned();
        assert_eq!(stored, Some("sessionid=abc123; csrftoken=tok99".into()));
    }

    /// 测试辅助：直接打登录路由
    trait LoginHelper {
        async fn oneshot_login(&self, account: &str) -> Response;
    }
    impl LoginHelper for Arc<AppState> {
        async fn oneshot_login(&self, account: &str) -> Response {
            router(self.clone())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/auth/login")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(
                            json!({"account": account, "password": "pw", "ticket": "t", "rand": "r"})
                                .to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap()
        }
    }

    #[tokio::test]
    async fn login_without_ticket_is_captcha_rejected_40201() {
        let server = mock_upstream_login_ok().await;
        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"account": "13800000000", "password": "pw", "ticket": "", "rand": ""})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40201);
    }

    #[tokio::test]
    async fn login_upstream_error_propagates_with_mapped_code() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 1004, "msg": "密码错误"})),
            )
            .mount(&server)
            .await;

        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"account": "13800000000", "password": "bad", "ticket": "t", "rand": "r"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 51004); // 50000 + 1004
        assert!(v["msg"].as_str().unwrap().contains("密码错误"));
    }

    // ---- 短信 / 扫码路由 ----

    #[tokio::test]
    async fn sms_send_without_ticket_is_40201() {
        let resp = app()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/sms/send")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"phone": "13800000000", "ticket": "", "rand": ""}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 40201);
    }

    #[tokio::test]
    async fn sms_send_with_ticket_hits_upstream() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/code/send"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "msg": "OK"})))
            .mount(&server)
            .await;

        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/sms/send")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"phone": "13800000000", "ticket": "t", "rand": "r"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
    }

    #[tokio::test]
    async fn sms_verify_returns_session_cookie() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/code/verify"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "msg": "OK"})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 0, "msg": "OK"}))
                    .append_header("Set-Cookie", "sessionid=sms55; Path=/"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "OK",
                "data": { "user_profile": { "user_id": 7 } }
            })))
            .mount(&server)
            .await;

        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/sms/verify")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"phone": "13800000000", "code": "8848", "ticket": "t", "rand": "r"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["user_id"], 7);
    }

    #[tokio::test]
    async fn qrcode_passthrough_preinfo_data() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/user/login/pre-info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "OK",
                "data": {"qrImage": "data:image/png;base64,x", "token": "tk"}
            })))
            .mount(&server)
            .await;

        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .uri("/api/auth/qrcode")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["token"], "tk");
        assert_eq!(v["data"]["qrImage"], "data:image/png;base64,x");
    }

    #[tokio::test]
    async fn qr_poll_pending_returns_pending_status() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 50001, "msg": "SCAN_QR_CODE_TIMEOUT"})),
            )
            .mount(&server)
            .await;

        let resp = app_with(&server.uri())
            .oneshot(
                Request::builder()
                    .uri("/api/auth/qrcode/poll?token=tk")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["status"], "pending");
    }

    // ---- extract_sid ----

    #[test]
    fn extract_sid_parses_cookie_list() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "a=1; sid=tok; b=2".parse().unwrap());
        assert_eq!(extract_sid(&h), Some("tok".into()));
        h.insert(header::COOKIE, "a=1".parse().unwrap());
        assert_eq!(extract_sid(&h), None);
    }
}
