//! 微信 JS-SDK（M5）：微信内扫码签到
//!
//! 公众号凭证经环境变量注入（`WECHAT_APP_ID` / `WECHAT_APP_SECRET`），
//! 未配置时不 panic：签名接口返回明确业务错误，前端自动降级为相机扫码。

pub mod client;
pub mod routes;
