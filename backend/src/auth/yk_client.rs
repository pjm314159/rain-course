//! 雨课堂 HTTP 客户端（auth 部分）
//!
//! 请求头/报文对齐 course_helper（.temp/scripts/test_yk_login.py 已实测验证）：
//! - 登录：POST /api/v3/user/login/app（type: 1=手机+密码, 2=邮箱+密码, 3=验证码）
//! - 短信：POST /api/v3/user/code/send → /api/v3/user/code/verify
//! - 扫码：GET /api/v3/user/login/pre-info → POST /api/v3/user/login（30s 长轮询，50001=超时）
//! - 会话探测：GET /v/course_meta/user_info → data.user_profile.user_id
//! - 统一信封 {code, msg, data}，code!=0 为上游业务错误

use serde_json::{Value, json};

use crate::error::AppError;

/// 解析雨课堂统一信封 `{code, msg, data}`：
/// - code == 0        → `Ok(data)`
/// - 其他             → `Err(AppError::Upstream)`（保留原始 code/msg）
pub fn map_envelope(envelope: Value) -> Result<Value, AppError> {
    match envelope.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(envelope.get("data").cloned().unwrap_or(Value::Null)),
        Some(upstream_code) => {
            let message = envelope
                .get("msg")
                .or_else(|| envelope.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("上游未知错误")
                .to_string();
            Err(AppError::Upstream {
                upstream_code,
                message,
            })
        }
        None => Err(AppError::Upstream {
            upstream_code: -1,
            message: "响应缺少 code 字段".into(),
        }),
    }
}

/// 一次成功登录后的会话：user_id + 原始 Cookie 头（csrftoken/sessionid 等）
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub user_id: i64,
    pub cookie_header: String,
}

/// 扫码长轮询结果
#[derive(Debug, PartialEq)]
pub enum QrPoll {
    /// 50001：未扫码/未确认，继续轮询
    Pending,
    /// 扫码确认成功
    Success(Session),
}

pub struct YkClient {
    /// 雨课堂基地址（signin 模块的扩展方法也复用）
    pub(crate) base: String,
    pub(crate) http: reqwest::Client,
}

impl YkClient {
    /// 构造客户端；请求头对齐 course_helper HeadersManager._rcHeaders
    pub fn new(base: &str) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        for (k, v) in [
            ("user-agent", "Android"),
            ("brand", "google Pixel 9 Pro"),
            ("uuid", ""),
            ("buildnumber", "1610"),
            ("xtua", "client=app&tag=1.3.3&platform=Android"),
            ("systemversion", "16"),
            ("incremental", "14624737"),
            ("accept", "application/json"),
            ("isphysicaldevice", "true"),
            ("xtbz", "ykt"),
            ("x-client", "app"),
        ] {
            let name =
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).expect("static header name");
            headers.insert(
                name,
                reqwest::header::HeaderValue::from_str(v).expect("static header"),
            );
        }
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .expect("reqwest client");
        Self {
            base: base.to_string(),
            http,
        }
    }

    /// 手机号/邮箱 + 密码登录。成功返回 Session（user_id + cookie 头）。
    pub async fn login_password(
        &self,
        account: &str,
        password: &str,
        ticket: &str,
        rand: &str,
    ) -> Result<Session, AppError> {
        // 对齐 course_helper RCLoginApi.login：邮箱→type=2，手机→type=1
        let (login_type, phone, email) = if account.contains('@') {
            (2, "", account)
        } else {
            (1, account, "")
        };
        let body = json!({
            "type": login_type,
            "phoneNumber": phone,
            "password": password,
            "email": email,
            "code": "",
            "pushDeviceId": "rain-course-web",
            "ticket": ticket,
            "rand": rand,
        });
        self.finish_login(body).await
    }

    /// 短信验证码登录：先 verify 短信码，再 type=3 登录。
    pub async fn login_sms(
        &self,
        phone: &str,
        code: &str,
        ticket: &str,
        rand: &str,
    ) -> Result<Session, AppError> {
        let verify_body = json!({"phoneNumber": phone, "email": "", "code": code});
        let resp = self
            .http
            .post(format!("{}/api/v3/user/code/verify", self.base))
            .json(&verify_body)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        map_envelope(envelope)?;

        let body = json!({
            "type": 3,
            "phoneNumber": phone,
            "password": "",
            "email": "",
            "code": code,
            "pushDeviceId": "rain-course-web",
            "ticket": ticket,
            "rand": rand,
        });
        self.finish_login(body).await
    }

    /// 发送短信验证码（ticket/rand 来自前端腾讯验证码组件）
    pub async fn sms_send(&self, phone: &str, ticket: &str, rand: &str) -> Result<(), AppError> {
        let resp = self
            .http
            .post(format!("{}/api/v3/user/code/send", self.base))
            .json(&json!({"phoneNumber": phone, "email": "", "ticket": ticket, "rand": rand}))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        map_envelope(envelope)?;
        Ok(())
    }

    /// 获取扫码登录二维码：返回上游 data（含 qrImage / token）
    pub async fn qr_preinfo(&self) -> Result<Value, AppError> {
        let resp = self
            .http
            .get(format!("{}/api/v3/user/login/pre-info", self.base))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        map_envelope(envelope)
    }

    /// 扫码登录 30s 长轮询。成功时捕获 Set-Cookie 并补全 user_id。
    pub async fn qr_poll(&self, token_str: &str) -> Result<QrPoll, AppError> {
        let resp = self
            .http
            .post(format!("{}/api/v3/user/login", self.base))
            .json(&json!({"token": token_str}))
            .timeout(std::time::Duration::from_secs(35))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;

        let cookies = collect_cookies(resp.headers());
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        // 实测（2026-09-26）：扫码确认后 data 直接携带用户信息 {"id":"96796676",...}
        match map_envelope(envelope) {
            Ok(data) => {
                if let Some(user_id) = parse_user_id(&data) {
                    return Ok(QrPoll::Success(Session {
                        user_id,
                        cookie_header: cookies,
                    }));
                }
                // 兜底：data 无 id 时用 user_info 探测
                let user_id = self.whoami(&cookies).await?;
                Ok(QrPoll::Success(Session {
                    user_id,
                    cookie_header: cookies,
                }))
            }
            Err(AppError::Upstream {
                upstream_code: 50001,
                ..
            }) => Ok(QrPoll::Pending),
            Err(e) => Err(e),
        }
    }

    /// 用已有 cookie 探测会话归属（qr_poll/finish_login 的兜底）
    /// 实测（2026-09-27）：user_info 成功响应无 code 字段，为
    /// `{msg, data: {user_profile: {user_id}}, success: true}`；失败时才是信封 `{code: 50000, ...}`
    pub async fn whoami(&self, cookie_header: &str) -> Result<i64, AppError> {
        let resp = self
            .http
            .get(format!("{}/v/course_meta/user_info", self.base))
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        // 失败路径是标准信封（如会话失效 {"code":50000,...}）
        if let Some(c) = envelope.get("code").and_then(Value::as_i64)
            && c != 0
        {
            let message = envelope
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("上游未知错误")
                .to_string();
            return Err(AppError::Upstream {
                upstream_code: c,
                message,
            });
        }
        // 成功路径无 code，user_id 实测为数字（兼容字符串）
        match envelope.pointer("/data/user_profile/user_id") {
            Some(Value::Number(n)) => n.as_i64().ok_or_else(user_id_missing_error),
            Some(Value::String(s)) => s.parse().map_err(|_| user_id_missing_error()),
            _ => Err(user_id_missing_error()),
        }
    }

    /// 登录报文公共尾部：发请求 → 折叠 cookie → 校验信封 → 解析 user_id
    /// 实测（2026-09-27）：login/app 成功 data 直接携带 `{"id":"96796676",...}`，
    /// 与扫码 user/login 结构一致，正常路径免二次 user_info 探测
    async fn finish_login(&self, body: Value) -> Result<Session, AppError> {
        let resp = self
            .http
            .post(format!("{}/api/v3/user/login/app", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;

        let cookies = collect_cookies(resp.headers());
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let data = map_envelope(envelope)?;

        if let Some(user_id) = parse_user_id(&data) {
            return Ok(Session {
                user_id,
                cookie_header: cookies,
            });
        }
        // 兜底：data 无 id 时用 user_info 探测
        let user_id = self.whoami(&cookies).await?;
        Ok(Session {
            user_id,
            cookie_header: cookies,
        })
    }
}

/// 从响应 data 里解析 user_id（实测为字符串形式的数字，兼容数字）
fn parse_user_id(data: &Value) -> Option<i64> {
    match data.get("id") {
        Some(Value::String(s)) => s.parse().ok(),
        Some(Value::Number(n)) => n.as_i64(),
        _ => None,
    }
}

fn user_id_missing_error() -> AppError {
    AppError::Upstream {
        upstream_code: -1,
        message: "user_info 响应缺少 user_id".into(),
    }
}

/// 把上游 Set-Cookie 头折叠成请求用 Cookie 头（取每个 cookie 的 name=value 段，同名取最新）
fn collect_cookies(headers: &reqwest::header::HeaderMap) -> String {
    let mut seen: Vec<String> = Vec::new();
    for v in headers.get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = v.to_str()
            && let Some(kv) = s.split(';').next()
        {
            let kv = kv.trim();
            if !kv.is_empty()
                && !seen
                    .iter()
                    .any(|e| e.split('=').next() == kv.split('=').next())
            {
                seen.push(kv.to_string());
            }
        }
    }
    seen.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn upstream_login_ok() -> ResponseTemplate {
        ResponseTemplate::new(200)
            .set_body_json(json!({"code": 0, "msg": "OK"}))
            .append_header("Set-Cookie", "sessionid=abc123; Path=/; HttpOnly")
            .append_header("Set-Cookie", "csrftoken=tok99; Path=/")
    }

    fn upstream_user_info() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({
            "code": 0, "msg": "OK",
            "data": { "user_profile": { "user_id": 42, "name": "tester" } }
        }))
    }

    #[tokio::test]
    async fn login_password_returns_session_with_user_id_and_cookies() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .and(body_partial_json(
                json!({"type": 1, "phoneNumber": "13800000000", "ticket": "t", "rand": "r"}),
            ))
            .and(header("xtbz", "ykt"))
            .and(header("x-client", "app"))
            .respond_with(upstream_login_ok())
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .and(header("cookie", "sessionid=abc123; csrftoken=tok99"))
            .respond_with(upstream_user_info())
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let session = client
            .login_password("13800000000", "pw", "t", "r")
            .await
            .unwrap();
        assert_eq!(session.user_id, 42);
        assert_eq!(session.cookie_header, "sessionid=abc123; csrftoken=tok99");
    }

    #[tokio::test]
    async fn login_email_uses_type_2() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .and(body_partial_json(json!({"type": 2, "email": "a@b.c"})))
            .respond_with(upstream_login_ok())
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(upstream_user_info())
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let session = client
            .login_password("a@b.c", "pw", "t", "r")
            .await
            .unwrap();
        assert_eq!(session.user_id, 42);
    }

    #[tokio::test]
    async fn upstream_business_error_maps_to_upstream_apperror() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"code": 1004, "msg": "密码错误"})),
            )
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let err = client
            .login_password("13800000000", "bad", "t", "r")
            .await
            .unwrap_err();
        match err {
            AppError::Upstream {
                upstream_code,
                message,
            } => {
                assert_eq!(upstream_code, 1004);
                assert_eq!(message, "密码错误");
            }
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    // ---- 登录尾部：data.id 直读 + user_info 实测结构 ----

    #[tokio::test]
    async fn finish_login_prefers_data_id_and_skips_user_info() {
        // 实测（2026-09-27）：login/app 成功 data 直接携带 {"id":"96796676",...}
        // 正常路径不应再调 user_info（故意不挂该 mock，若被调用 wiremock 404 会致失败）
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({
                        "code": 0, "msg": "",
                        "data": {"id": "96796676", "name": "彭嘉铭"}
                    }))
                    .append_header("Set-Cookie", "sessionid=abc; Path=/"),
            )
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let session = client
            .login_password("13800000000", "pw", "t", "r")
            .await
            .unwrap();
        assert_eq!(session.user_id, 96796676);
        assert_eq!(session.cookie_header, "sessionid=abc");
    }

    #[tokio::test]
    async fn whoami_parses_real_user_info_without_code_field() {
        // 实测（2026-09-27）：user_info 成功响应无 code 字段
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "msg": "0.0.1",
                "data": { "user_profile": { "user_id": 96796676, "name": "彭嘉铭" } },
                "success": true
            })))
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let uid = client.whoami("sessionid=x").await.unwrap();
        assert_eq!(uid, 96796676);
    }

    #[tokio::test]
    async fn whoami_maps_upstream_error_envelope() {
        // 实测：user_info 失败时才是标准信封（无 cookie 时 {"code":50000,...}）
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 50000, "msg": "", "data": {}})),
            )
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let err = client.whoami("sessionid=x").await.unwrap_err();
        match err {
            AppError::Upstream { upstream_code, .. } => assert_eq!(upstream_code, 50000),
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    // ---- 短信 ----

    #[tokio::test]
    async fn sms_send_posts_phone_and_ticket() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/code/send"))
            .and(body_partial_json(
                json!({"phoneNumber": "13800000000", "ticket": "t", "rand": "r"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "msg": "OK"})))
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        client.sms_send("13800000000", "t", "r").await.unwrap();
    }

    #[tokio::test]
    async fn sms_login_verifies_code_then_logins_with_type_3() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/code/verify"))
            .and(body_partial_json(
                json!({"phoneNumber": "13800000000", "code": "8848"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "msg": "OK"})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login/app"))
            .and(body_partial_json(
                json!({"type": 3, "phoneNumber": "13800000000", "code": "8848"}),
            ))
            .respond_with(upstream_login_ok())
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .respond_with(upstream_user_info())
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let session = client
            .login_sms("13800000000", "8848", "t", "r")
            .await
            .unwrap();
        assert_eq!(session.user_id, 42);
        assert_eq!(session.cookie_header, "sessionid=abc123; csrftoken=tok99");
    }

    // ---- 扫码 ----

    #[tokio::test]
    async fn qr_preinfo_returns_data_passthrough() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/user/login/pre-info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0, "msg": "OK",
                "data": {"qrImage": "data:image/png;base64,xx", "token": "tok1", "qrContent": "c"}
            })))
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        let data = client.qr_preinfo().await.unwrap();
        assert_eq!(data["token"], "tok1");
        assert_eq!(data["qrImage"], "data:image/png;base64,xx");
    }

    #[tokio::test]
    async fn qr_poll_timeout_maps_to_pending() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 50001, "msg": "SCAN_QR_CODE_TIMEOUT"})),
            )
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        assert_eq!(client.qr_poll("tok1").await.unwrap(), QrPoll::Pending);
    }

    #[tokio::test]
    async fn qr_poll_success_parses_user_id_from_data_directly() {
        // 实测结构：data.id 为字符串数字，无需再调 user_info
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({
                        "code": 0, "msg": "OK",
                        "data": {"id": "96796676", "avatar": "", "name": "", "school": ""}
                    }))
                    .append_header("Set-Cookie", "sessionid=qr88; Path=/"),
            )
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        match client.qr_poll("tok1").await.unwrap() {
            QrPoll::Success(s) => {
                assert_eq!(s.user_id, 96796676);
                assert_eq!(s.cookie_header, "sessionid=qr88");
            }
            other => panic!("expected Success, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn qr_poll_success_without_id_falls_back_to_user_info() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/user/login"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"code": 0, "msg": "OK", "data": {"status": 1}}))
                    .append_header("Set-Cookie", "sessionid=qr77; Path=/"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v/course_meta/user_info"))
            .and(header("cookie", "sessionid=qr77"))
            .respond_with(upstream_user_info())
            .mount(&server)
            .await;

        let client = YkClient::new(&server.uri());
        match client.qr_poll("tok1").await.unwrap() {
            QrPoll::Success(s) => {
                assert_eq!(s.user_id, 42);
                assert_eq!(s.cookie_header, "sessionid=qr77");
            }
            other => panic!("expected Success, got {other:?}"),
        }
    }
}
