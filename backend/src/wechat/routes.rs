//! 微信 JS-SDK 路由（M5）
//!
//! - `GET /api/wechat/status`：可用性探测（无需会话），前端据此决定是否展示微信内扫码入口
//! - `GET /api/wechat/jssdk-signature?url=`：签名（需本站会话），供前端 `wx.config` 后
//!   `wx.scanQRCode`；未配置公众号凭证返回 40307（前端自动降级为相机扫码）

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::routes::{AppState, extract_sid};
use crate::auth::token;
use crate::error::AppError;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/wechat/status", get(wechat_status))
        .route("/api/wechat/jssdk-signature", get(jssdk_signature))
        .with_state(state)
}

/// 可用性探测：只暴露「是否已配置」，不含任何凭证信息；前端据此决定是否渲染微信内扫码入口
async fn wechat_status(State(st): State<Arc<AppState>>) -> Response {
    let available = st.wechat.configured();
    let reason = if available {
        None
    } else {
        Some("未配置 WECHAT_APP_ID / WECHAT_APP_SECRET")
    };
    Json(json!({
        "code": 0, "msg": "ok",
        "data": { "available": available, "reason": reason }
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct SignatureQuery {
    pub url: String,
}

async fn jssdk_signature(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<SignatureQuery>,
) -> Result<Response, AppError> {
    // 本站会话（微信内同为本站页面，cookie 随同源请求携带）
    let sid = extract_sid(&headers).ok_or(AppError::Unauthorized)?;
    token::verify(&sid, now_unix(), &st.config.server_secret)
        .map_err(|_| AppError::Unauthorized)?;

    let url = q.url.trim();
    if url.is_empty() {
        return Err(AppError::BadInput("缺少 url 参数"));
    }

    let signature = st.wechat.jssdk_signature(url).await?;
    Ok(Json(json!({ "code": 0, "msg": "ok", "data": signature })).into_response())
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
    use sha1::{Digest, Sha1};
    use tower::ServiceExt;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::auth::yk_client::YkClient;
    use crate::config::Config;
    use crate::wechat::client::WechatClient;

    const SECRET: &str = "test-secret";

    fn app_with(base: &str, configured: bool) -> Router {
        let cfg = if configured {
            Config::from_pairs(&[
                ("SERVER_SECRET", SECRET),
                ("WECHAT_APP_ID", "wxapp"),
                ("WECHAT_APP_SECRET", "wxsec"),
            ])
        } else {
            Config::from_pairs(&[("SERVER_SECRET", SECRET)])
        };
        let mut st = AppState::new(cfg, YkClient::new("https://www.yuketang.cn"));
        st.wechat = WechatClient::with_base(
            st.config.wechat_app_id.clone(),
            st.config.wechat_app_secret.clone(),
            base,
        );
        router(Arc::new(st))
    }

    fn sid_cookie() -> String {
        format!("sid={}", token::issue(42, now_unix() + 3_600, SECRET))
    }

    async fn get(app: Router, uri: &str, cookie: Option<&str>) -> Response {
        let mut b = Request::builder().uri(uri);
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

    fn sha1_hex_of(plain: &str) -> String {
        let mut h = Sha1::new();
        h.update(plain.as_bytes());
        hex::encode(h.finalize())
    }

    async fn mount_wechat(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/cgi-bin/token"))
            .and(query_param("grant_type", "client_credential"))
            .and(query_param("appid", "wxapp"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"access_token": "AT", "expires_in": 7200})),
            )
            .mount(server)
            .await;
        Mock::given(method("GET"))
            .and(path("/cgi-bin/ticket/getticket"))
            .and(query_param("type", "jsapi"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errcode": 0, "errmsg": "ok", "ticket": "TICKET", "expires_in": 7200
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn status_reports_available_when_configured() {
        // status 不访问上游，用固定 base 即可
        let resp = get(
            app_with("https://api.weixin.qq.com", true),
            "/api/wechat/status",
            None,
        )
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["available"], true);
        assert_eq!(v["data"]["reason"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn status_reports_reason_when_unconfigured() {
        let resp = get(
            app_with("https://api.weixin.qq.com", false),
            "/api/wechat/status",
            None,
        )
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        assert_eq!(v["data"]["available"], false);
        assert!(
            v["data"]["reason"]
                .as_str()
                .unwrap()
                .contains("未配置 WECHAT_APP_ID")
        );
    }

    #[tokio::test]
    async fn without_site_cookie_is_unauthorized() {
        let server = MockServer::start().await;
        let resp = get(
            app_with(&server.uri(), true),
            "/api/wechat/jssdk-signature?url=https%3A%2F%2Fa.cn%2Fr%2F12",
            None,
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 40101);
    }

    #[tokio::test]
    async fn missing_url_is_bad_request() {
        let server = MockServer::start().await;
        let resp = get(
            app_with(&server.uri(), true),
            "/api/wechat/jssdk-signature?url=",
            Some(&sid_cookie()),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 40306);
    }

    #[tokio::test]
    async fn unconfigured_credentials_return_40307() {
        let server = MockServer::start().await;
        let resp = get(
            app_with(&server.uri(), false),
            "/api/wechat/jssdk-signature?url=https%3A%2F%2Fa.cn%2Fr%2F12",
            Some(&sid_cookie()),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 40307);
    }

    #[tokio::test]
    async fn signature_matches_documented_sha1_string() {
        let server = MockServer::start().await;
        mount_wechat(&server).await;

        let resp = get(
            app_with(&server.uri(), true),
            "/api/wechat/jssdk-signature?url=https%3A%2F%2Fexample.com%2Fr%2F12",
            Some(&sid_cookie()),
        )
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["code"], 0);
        let data = &v["data"];
        assert_eq!(data["appId"], "wxapp");
        let expected = sha1_hex_of(&format!(
            "jsapi_ticket=TICKET&noncestr={}&timestamp={}&url=https://example.com/r/12",
            data["nonceStr"].as_str().unwrap(),
            data["timestamp"].as_u64().unwrap()
        ));
        assert_eq!(data["signature"], expected);
    }

    #[tokio::test]
    async fn fragment_is_stripped_before_signing() {
        let server = MockServer::start().await;
        mount_wechat(&server).await;

        let resp = get(
            app_with(&server.uri(), true),
            "/api/wechat/jssdk-signature?url=https%3A%2F%2Fexample.com%2Fr%2F12%23%2Ffoo",
            Some(&sid_cookie()),
        )
        .await;
        let v = body_json(resp).await;
        let data = &v["data"];
        let expected = sha1_hex_of(&format!(
            "jsapi_ticket=TICKET&noncestr={}&timestamp={}&url=https://example.com/r/12",
            data["nonceStr"].as_str().unwrap(),
            data["timestamp"].as_u64().unwrap()
        ));
        assert_eq!(data["signature"], expected);
    }

    #[tokio::test]
    async fn token_and_ticket_are_cached_across_calls() {
        let server = MockServer::start().await;
        // 各只允许命中一次：第二次调用必须走内存缓存
        Mock::given(method("GET"))
            .and(path("/cgi-bin/token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"access_token": "AT", "expires_in": 7200})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/cgi-bin/ticket/getticket"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errcode": 0, "errmsg": "ok", "ticket": "TICKET", "expires_in": 7200
            })))
            .expect(1)
            .mount(&server)
            .await;

        let app = app_with(&server.uri(), true);
        let cookie = sid_cookie();
        let uri = "/api/wechat/jssdk-signature?url=https%3A%2F%2Fa.cn%2Fr%2F12";
        let first = body_json(get(app.clone(), uri, Some(&cookie)).await).await;
        let second = body_json(get(app, uri, Some(&cookie)).await).await;
        assert_eq!(first["code"], 0);
        assert_eq!(second["code"], 0);
        server.verify().await;
    }

    #[tokio::test]
    async fn upstream_errcode_propagates_as_5xxxx() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/cgi-bin/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errcode": 40013, "errmsg": "invalid appid"
            })))
            .mount(&server)
            .await;

        let resp = get(
            app_with(&server.uri(), true),
            "/api/wechat/jssdk-signature?url=https%3A%2F%2Fa.cn%2Fr%2F12",
            Some(&sid_cookie()),
        )
        .await;
        assert_eq!(body_json(resp).await["code"], 90013); // 50000 + 40013
    }
}
