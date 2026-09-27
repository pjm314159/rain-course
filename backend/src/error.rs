//! 统一业务错误：`{ "code": <非0>, "msg": <人类可读> }`
//!
//! 错误码约定（docs/DESIGN.md §3）：
//! - 40101 本站会话过期/未登录 → 前端跳登录
//! - 40201 验证码票据无效
//! - 50001 起：透传/映射自雨课堂的错误

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::ws::models::error_code;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 未登录或本站会话过期
    #[error("未登录或会话已过期")]
    Unauthorized,
    /// 验证码票据无效（雨课堂侧拒绝）
    #[error("验证码校验失败，请重新完成验证")]
    CaptchaRejected,
    /// 二维码内容非法（非 HTTPS / 非白名单域名 / 非 URL），docs/SPEC.md §3.2.4
    #[error("不是有效的雨课堂签到码")]
    InvalidQrContent,
    /// 雨课堂动态二维码过期（上游 51203）
    #[error("动态二维码已过期，请获取最新签到码")]
    QrExpired,
    /// 上游雨课堂返回的业务错误（携带其原始 code 与 msg）
    #[error("雨课堂错误 {upstream_code}: {message}")]
    Upstream { upstream_code: i64, message: String },
    /// 全局房间数已达上限（docs/SPEC.md §3.3.3）
    #[error("站点房间数已达上限，请稍后再试")]
    RoomLimitReached,
    /// 每用户建房数已达上限
    #[error("你创建的房间数已达上限")]
    RoomPerUserLimitReached,
    /// 房间不存在或已关闭/过期
    #[error("房间不存在或已关闭")]
    RoomNotFound,
    /// 非房主执行房主操作
    #[error("仅房主可执行该操作")]
    NotRoomOwner,
    /// 房间入参非法（字段超长等）
    #[error("{0}")]
    BadRoomInput(&'static str),
    /// 请求参数非法（缺字段等）
    #[error("{0}")]
    BadInput(&'static str),
    /// 微信 JS-SDK 未配置（缺少 WECHAT_APP_ID / WECHAT_APP_SECRET）
    #[error("微信扫码未配置，请联系管理员")]
    WechatNotConfigured,
    /// 其他内部错误
    #[error("内部错误")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    /// 业务错误码，写入响应信封的 `code` 字段
    pub fn code(&self) -> i64 {
        match self {
            AppError::Unauthorized => 40101,
            AppError::CaptchaRejected => 40201,
            AppError::InvalidQrContent => 40301,
            AppError::QrExpired => 51203,
            AppError::Upstream { upstream_code, .. } => 50000 + upstream_code.unsigned_abs() as i64,
            AppError::RoomLimitReached => error_code::ROOMS_TOTAL_LIMIT,
            AppError::RoomPerUserLimitReached => error_code::ROOMS_PER_USER_LIMIT,
            AppError::RoomNotFound => error_code::ROOM_NOT_FOUND,
            AppError::NotRoomOwner => error_code::NOT_ROOM_OWNER,
            AppError::BadRoomInput(_) => error_code::BAD_REQUEST,
            AppError::BadInput(_) => error_code::BAD_REQUEST,
            AppError::WechatNotConfigured => 40307,
            AppError::Internal(_) => 50000,
        }
    }

    /// HTTP 状态码：业务错误一律 200（信封 code 区分），仅内部错误 500
    pub fn http_status(&self) -> StatusCode {
        match self {
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::OK,
        }
    }

    /// 信封的 `msg` 字段
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.http_status();
        let body = json!({ "code": self.code(), "msg": self.message(), "data": null });
        (status, axum::Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use tower::ServiceExt;

    async fn probe() -> Result<&'static str, AppError> {
        Err(AppError::Unauthorized)
    }

    #[tokio::test]
    async fn unauthorized_maps_to_40101_envelope() {
        let app = Router::new().route("/probe", get(probe));
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/probe")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["code"], 40101);
        assert!(v["msg"].as_str().unwrap().contains("未登录"));
    }

    #[test]
    fn upstream_error_prefixes_50000() {
        let e = AppError::Upstream {
            upstream_code: 51203,
            message: "动态二维码过期".into(),
        };
        assert_eq!(e.code(), 101203); // 50000 + 51203
        assert_eq!(e.http_status(), StatusCode::OK);
        assert!(e.message().contains("动态二维码过期"));
    }

    #[test]
    fn captcha_rejected_maps_to_40201() {
        assert_eq!(AppError::CaptchaRejected.code(), 40201);
    }

    #[test]
    fn internal_maps_to_50000_and_500() {
        let e = AppError::Internal(anyhow::anyhow!("boom"));
        assert_eq!(e.code(), 50000);
        assert_eq!(e.http_status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
