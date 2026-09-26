//! 雨课堂 HTTP 客户端（auth 部分）
//!
//! 请求头/报文对齐 course_helper（.temp/scripts/test_yk_login.py 已实测验证）：
//! - 登录：POST /api/v3/user/login/app（type: 1=手机+密码, 2=邮箱+密码, 3=验证码）
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

pub struct YkClient {
    base: String,
    http: reqwest::Client,
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
        map_envelope(envelope)?;

        let user_id = self.whoami(&cookies).await?;
        Ok(Session {
            user_id,
            cookie_header: cookies,
        })
    }

    /// 用已有 cookie 探测会话归属；雨课堂会话失效时返回 Unauthorized
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
        let data = map_envelope(envelope)?;
        data.pointer("/user_profile/user_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::Upstream {
                upstream_code: -1,
                message: "user_info 响应缺少 user_id".into(),
            })
    }
}

/// 把上游 Set-Cookie 头折叠成请求用 Cookie 头（取每个 cookie 的 name=value 段）
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
}
