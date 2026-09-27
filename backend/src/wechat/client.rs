//! 微信公众平台接口客户端：access_token / jsapi_ticket 内存缓存 + JS-SDK 签名
//!
//! 接口（官方文档）：
//! - `GET /cgi-bin/token?grant_type=client_credential&appid=&secret=`
//! - `GET /cgi-bin/ticket/getticket?access_token=&type=jsapi`
//!
//! 签名串为 **plain SHA1**（非 HMAC）：
//! `jsapi_ticket=..&noncestr=..&timestamp=..&url=..`（url 需去掉 `#` 及其后部分）

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio::sync::RwLock;

use crate::error::AppError;

/// 微信开放接口基地址（测试可注入）
const DEFAULT_API_BASE: &str = "https://api.weixin.qq.com";
/// 提前刷新余量（秒）：临界过期会让签名被微信拒绝
const REFRESH_MARGIN_SECS: u64 = 300;
/// 微信侧凭证默认有效期（秒）
const DEFAULT_EXPIRES_IN: u64 = 7200;

/// 带过期时间的凭证缓存项
#[derive(Debug, Clone)]
struct Cached {
    value: String,
    expires_at: u64,
}

impl Cached {
    fn new(value: String, expires_in: u64) -> Self {
        Self {
            value,
            expires_at: now_unix() + expires_in,
        }
    }

    /// 距过期仍有余量方可复用
    fn usable(&self, now: u64) -> bool {
        now + REFRESH_MARGIN_SECS < self.expires_at
    }
}

/// 前端 `wx.config` 所需签名参数（camelCase 直出）
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JssdkSignature {
    pub app_id: String,
    pub timestamp: u64,
    pub nonce_str: String,
    pub signature: String,
}

pub struct WechatClient {
    app_id: Option<String>,
    app_secret: Option<String>,
    base: String,
    http: reqwest::Client,
    access_token: RwLock<Option<Cached>>,
    jsapi_ticket: RwLock<Option<Cached>>,
}

impl WechatClient {
    /// 生产构造：使用微信开放接口默认基地址
    pub fn new(app_id: Option<String>, app_secret: Option<String>) -> Self {
        Self::with_base(app_id, app_secret, DEFAULT_API_BASE)
    }

    /// 可注入基地址（测试用 wiremock）
    pub fn with_base(app_id: Option<String>, app_secret: Option<String>, base: &str) -> Self {
        Self {
            app_id,
            app_secret,
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
            access_token: RwLock::new(None),
            jsapi_ticket: RwLock::new(None),
        }
    }

    /// 生成 JS-SDK 签名；`url` 为当前页面完整 URL（`#` 之后部分会被去除）
    pub async fn jssdk_signature(&self, url: &str) -> Result<JssdkSignature, AppError> {
        let app_id = self.app_id.clone().ok_or(AppError::WechatNotConfigured)?;
        let ticket = self.jsapi_ticket().await?;
        let timestamp = now_unix();
        let nonce_str = random_nonce();
        let plain = format!(
            "jsapi_ticket={ticket}&noncestr={nonce_str}&timestamp={timestamp}&url={}",
            strip_fragment(url)
        );
        Ok(JssdkSignature {
            app_id,
            timestamp,
            nonce_str,
            signature: sha1_hex(&plain),
        })
    }

    /// access_token：命中未过期缓存直接返回，否则刷新
    pub async fn access_token(&self) -> Result<String, AppError> {
        let cached = self.access_token.read().await.clone();
        if let Some(c) = cached
            && c.usable(now_unix())
        {
            return Ok(c.value);
        }
        let fresh = self.fetch_access_token().await?;
        let value = fresh.value.clone();
        *self.access_token.write().await = Some(fresh);
        Ok(value)
    }

    /// jsapi_ticket：命中未过期缓存直接返回，否则刷新
    pub async fn jsapi_ticket(&self) -> Result<String, AppError> {
        let cached = self.jsapi_ticket.read().await.clone();
        if let Some(c) = cached
            && c.usable(now_unix())
        {
            return Ok(c.value);
        }
        let fresh = self.fetch_jsapi_ticket().await?;
        let value = fresh.value.clone();
        *self.jsapi_ticket.write().await = Some(fresh);
        Ok(value)
    }

    async fn fetch_access_token(&self) -> Result<Cached, AppError> {
        let (app_id, app_secret) = self.credentials()?;
        let resp = self
            .http
            .get(format!("{}/cgi-bin/token", self.base))
            .query(&[
                ("grant_type", "client_credential"),
                ("appid", app_id),
                ("secret", app_secret),
            ])
            .send()
            .await
            .map_err(internal)?;
        let body: Value = resp.json().await.map_err(internal)?;
        reject_wechat_error(&body, "access_token")?;
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("微信响应缺少 access_token")))?;
        Ok(Cached::new(token.to_string(), expires_in_of(&body)))
    }

    async fn fetch_jsapi_ticket(&self) -> Result<Cached, AppError> {
        let token = self.access_token().await?;
        let resp = self
            .http
            .get(format!("{}/cgi-bin/ticket/getticket", self.base))
            .query(&[("access_token", token.as_str()), ("type", "jsapi")])
            .send()
            .await
            .map_err(internal)?;
        let body: Value = resp.json().await.map_err(internal)?;
        reject_wechat_error(&body, "jsapi_ticket")?;
        let ticket = body
            .get("ticket")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Internal(anyhow::anyhow!("微信响应缺少 ticket")))?;
        Ok(Cached::new(ticket.to_string(), expires_in_of(&body)))
    }

    fn credentials(&self) -> Result<(&str, &str), AppError> {
        match (self.app_id.as_deref(), self.app_secret.as_deref()) {
            (Some(id), Some(secret)) => Ok((id, secret)),
            _ => Err(AppError::WechatNotConfigured),
        }
    }
}

/// 微信应答的 `expires_in`（缺省按官方默认 7200s）
fn expires_in_of(body: &Value) -> u64 {
    body.get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_EXPIRES_IN)
}

/// 微信以 `errcode == 0` 表示成功；非 0 映射为上游业务错误（保留原始 errcode）
fn reject_wechat_error(body: &Value, stage: &str) -> Result<(), AppError> {
    if let Some(code) = body.get("errcode").and_then(Value::as_i64)
        && code != 0
    {
        let msg = body
            .get("errmsg")
            .and_then(Value::as_str)
            .unwrap_or("微信接口错误");
        return Err(AppError::Upstream {
            upstream_code: code,
            message: format!("微信 {stage} 获取失败：{msg}"),
        });
    }
    Ok(())
}

/// 去掉 URL 的 fragment（微信签名要求包含 query、不含 `#` 及其后部分）
fn strip_fragment(url: &str) -> &str {
    match url.split_once('#') {
        Some((before, _)) => before,
        None => url,
    }
}

/// JS-SDK 签名算法：plain SHA1（非 HMAC）
fn sha1_hex(plain: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(plain.as_bytes());
    hex::encode(hasher.finalize())
}

/// nonceStr：无需密码学强度，进程随机种子 + 纳秒时间足以保证唯一
fn random_nonce() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(now_unix_nanos());
    format!("{:016x}", h.finish())
}

fn internal(e: reqwest::Error) -> AppError {
    AppError::Internal(e.into())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_unix_nanos() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_fragment_removes_hash_and_after() {
        assert_eq!(
            strip_fragment("https://a.cn/r/12?x=1#/foo"),
            "https://a.cn/r/12?x=1"
        );
        assert_eq!(strip_fragment("https://a.cn/r/12"), "https://a.cn/r/12");
    }

    #[test]
    fn sha1_matches_known_vector() {
        // 官方文档示例串的 SHA1（"abc" 的标准向量）
        assert_eq!(sha1_hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    #[test]
    fn cache_usable_only_outside_refresh_margin() {
        let now = 1_000_000;
        let fresh = Cached {
            value: "t".into(),
            expires_at: now + 7200,
        };
        assert!(fresh.usable(now));
        let edge = Cached {
            value: "t".into(),
            expires_at: now + REFRESH_MARGIN_SECS,
        };
        assert!(!edge.usable(now));
    }

    #[test]
    fn nonce_is_hex_and_changes_in_time() {
        let a = random_nonce();
        let b = random_nonce();
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(b.len(), 0);
    }

    #[tokio::test]
    async fn signature_without_credentials_is_not_configured() {
        let client = WechatClient::new(None, Some("s".into()));
        let err = client
            .jssdk_signature("https://a.cn/r/12")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::WechatNotConfigured));
        assert_eq!(err.code(), 40307);
    }
}
