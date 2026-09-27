//! YkClient 签到扩展：`POST /api/v3/app/scan` → `POST /api/v3/lesson/checkin`
//!
//! 报文对齐 course_helper/lib/api/course.dart `scan()` / `checkIn()`：
//! - scan：body `{"url": <二维码URL>}`，code==0 时 `data.value` 即 lessonId
//! - checkin：body `{"source":21, "lessonId":..., "joinIfNotIn":true}`，code==0 即成功
//!   （成功响应头 set-auth 携带课堂 Bearer，仅课件交互使用，签到本身不需要，不保存）
//! - 雨课堂 51203 = 动态二维码过期 → `AppError::QrExpired`

use serde_json::{Value, json};

use crate::auth::yk_client::{YkClient, map_envelope};
use crate::error::AppError;

impl YkClient {
    /// 解析二维码 URL，返回 lessonId（`data.value`，对齐 course.dart，类型不假设）
    pub async fn scan(&self, cookie_header: &str, qr_url: &str) -> Result<Value, AppError> {
        let resp = self
            .http
            .post(format!("{}/api/v3/app/scan", self.base))
            .header(reqwest::header::COOKIE, cookie_header)
            .json(&json!({"url": qr_url}))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let data = map_envelope(envelope).map_err(signin_error)?;
        data.get("value")
            .cloned()
            .ok_or_else(|| AppError::Upstream {
                upstream_code: -1,
                message: "scan 响应缺少 data.value".into(),
            })
    }

    /// 完成签到（source=21 对齐旧项目；joinIfNotIn=true 未加入课堂则自动加入）
    pub async fn checkin(&self, cookie_header: &str, lesson_id: &Value) -> Result<(), AppError> {
        let resp = self
            .http
            .post(format!("{}/api/v3/lesson/checkin", self.base))
            .header(reqwest::header::COOKIE, cookie_header)
            .json(&json!({
                "source": 21,
                "lessonId": lesson_id,
                "joinIfNotIn": true,
            }))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        let envelope: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.into()))?;
        map_envelope(envelope).map_err(signin_error)?;
        Ok(())
    }
}

/// 签到链路错误语义化：51203 → QrExpired（前端引导获取最新码），其余透传
fn signin_error(e: AppError) -> AppError {
    match e {
        AppError::Upstream {
            upstream_code: 51203,
            ..
        } => AppError::QrExpired,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn respond(body: serde_json::Value) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/app/scan"))
            .and(header("cookie", "sessionid=s1"))
            .and(body_partial_json(
                json!({"url": "https://www.yuketang.cn/c/x"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v3/lesson/checkin"))
            .and(header("cookie", "sessionid=s1"))
            .and(body_partial_json(
                json!({"source": 21, "lessonId": 123456, "joinIfNotIn": true}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn scan_parses_lesson_id_from_data_value() {
        // 对齐 course.dart：code==0 时 data.value 即 lessonId
        let server = respond(json!({"code": 0, "msg": "", "data": {"value": 123456}})).await;
        let client = YkClient::new(&server.uri());
        let lesson = client
            .scan("sessionid=s1", "https://www.yuketang.cn/c/x")
            .await
            .unwrap();
        assert_eq!(lesson, json!(123456));
    }

    #[tokio::test]
    async fn scan_expired_maps_to_qr_expired() {
        let server = respond(json!({"code": 51203, "msg": "二维码已过期", "data": {}})).await;
        let client = YkClient::new(&server.uri());
        let err = client
            .scan("sessionid=s1", "https://www.yuketang.cn/c/x")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::QrExpired));
    }

    #[tokio::test]
    async fn scan_other_upstream_error_propagates() {
        let server = respond(json!({"code": 1004, "msg": "未知错误", "data": {}})).await;
        let client = YkClient::new(&server.uri());
        match client
            .scan("sessionid=s1", "https://www.yuketang.cn/c/x")
            .await
            .unwrap_err()
        {
            AppError::Upstream { upstream_code, .. } => assert_eq!(upstream_code, 1004),
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn checkin_success_returns_unit() {
        let server = respond(json!({
            "code": 0, "msg": "",
            "data": {"lessonToken": "tk", "className": "一班"}
        }))
        .await;
        let client = YkClient::new(&server.uri());
        client
            .checkin("sessionid=s1", &json!(123456))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn checkin_upstream_error_propagates() {
        let server = respond(json!({"code": 51203, "msg": "二维码已过期", "data": {}})).await;
        let client = YkClient::new(&server.uri());
        let err = client
            .checkin("sessionid=s1", &json!(123456))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::QrExpired));
    }
}
