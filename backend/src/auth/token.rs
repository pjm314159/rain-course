//! 签名会话 token：`user_id.exp.hmac_hex`
//!
//! 行为约定（docs/SPEC.md §3.1.2）：
//! - 14 天滑动续期（续期在路由层做，本模块只管签发与校验）
//! - HMAC-SHA256 防篡改，校验只验签名，无服务端存储

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// 签发 token。
///
/// 返回 `user_id.expiry_unix_sec.hmac_hex`；hmac 对 `user_id.expiry_unix_sec` 计算。
pub fn issue(user_id: i64, expiry_unix_sec: u64, secret: &str) -> String {
    let payload = format!("{user_id}.{expiry_unix_sec}");
    let sig = sign(&payload, secret);
    format!("{payload}.{sig}")
}

/// 校验 token。
///
/// - 格式非法 / 签名不符 → `Err(TokenError::Invalid)`
/// - 已过期（expiry < now_unix_sec）→ `Err(TokenError::Expired)`
pub fn verify(token: &str, now_unix_sec: u64, secret: &str) -> Result<i64, TokenError> {
    let mut parts = token.split('.');
    let user_id = parts.next().ok_or(TokenError::Invalid)?;
    let expiry = parts.next().ok_or(TokenError::Invalid)?;
    let sig = parts.next().ok_or(TokenError::Invalid)?;
    if parts.next().is_some() {
        return Err(TokenError::Invalid);
    }

    let user_id: i64 = user_id.parse().map_err(|_| TokenError::Invalid)?;
    let expiry: u64 = expiry.parse().map_err(|_| TokenError::Invalid)?;

    // 用重新拼接的 payload 验签，防止分隔符注入
    let payload = format!("{user_id}.{expiry}");
    let expected = sign(&payload, secret);
    if !constant_time_eq(sig.as_bytes(), expected.as_bytes()) {
        return Err(TokenError::Invalid);
    }

    if expiry < now_unix_sec {
        return Err(TokenError::Expired);
    }
    Ok(user_id)
}

fn sign(payload: &str, secret: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error("invalid token")]
    Invalid,
    #[error("expired token")]
    Expired,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "test-secret";

    fn far_future() -> u64 {
        4_102_444_800 // 2100-01-01，测试用固定远期时间
    }

    #[test]
    fn roundtrip_returns_user_id() {
        let token = issue(42, far_future(), SECRET);
        assert_eq!(verify(&token, 0, SECRET), Ok(42));
    }

    #[test]
    fn tampered_payload_is_invalid() {
        let token = issue(42, far_future(), SECRET);
        // 把 user_id 改成 43，签名必然对不上
        let tampered = token.replacen("42.", "43.", 1);
        assert_eq!(verify(&tampered, 0, SECRET), Err(TokenError::Invalid));
    }

    #[test]
    fn wrong_secret_is_invalid() {
        let token = issue(42, far_future(), SECRET);
        assert_eq!(verify(&token, 0, "other-secret"), Err(TokenError::Invalid));
    }

    #[test]
    fn expired_token_is_rejected() {
        let token = issue(42, 1_000, SECRET); // 1970-01-01 00:16:40
        assert_eq!(verify(&token, 2_000, SECRET), Err(TokenError::Expired));
    }

    #[test]
    fn garbage_is_invalid() {
        assert_eq!(verify("not-a-token", 0, SECRET), Err(TokenError::Invalid));
        assert_eq!(verify("a.b.c", 0, SECRET), Err(TokenError::Invalid));
        assert_eq!(verify("", 0, SECRET), Err(TokenError::Invalid));
    }

    #[test]
    fn same_input_same_output() {
        assert_eq!(
            issue(7, far_future(), SECRET),
            issue(7, far_future(), SECRET)
        );
    }

    #[test]
    fn different_expiry_different_token() {
        assert_ne!(issue(7, 100, SECRET), issue(7, 200, SECRET));
    }
}
