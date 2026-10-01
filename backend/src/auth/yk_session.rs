//! 雨课堂凭证的浏览器端持久化（HttpOnly cookie `yk_session`）
//!
//! 与雨课堂官网自身同策：登录后把凭证放进浏览器 HttpOnly cookie（官网存 `sessionid`，
//! 我们存其原始 Cookie 头的 base64url 编码）。后端 `sessions` 内存表重启即清空，
//! 凭证落在浏览器后重启不再丢；内存表仅兜底升级前已登录的旧会话。

use axum::http::{HeaderMap, header};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// 本站承载雨课堂凭证的 cookie 名（HttpOnly，页面 JS 不可读）
pub const YK_SESSION_COOKIE: &str = "yk_session";

const COOKIE_ATTRS: &str = "Path=/; HttpOnly; SameSite=Lax";

/// 把雨课堂原始 Cookie 头编码为本站 cookie 值。
/// base64url 无填充：值里不含 `;` / 空格 / `=`，不会被 cookie 语法截断。
pub fn encode(cookie_header: &str) -> String {
    URL_SAFE_NO_PAD.encode(cookie_header.as_bytes())
}

/// 解码浏览器 cookie 值回原始 Cookie 头；非法输入按无凭证处理（返回 None，不记日志避免落值）
pub fn decode(value: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    String::from_utf8(bytes)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// 登录成功时的 Set-Cookie 行：TTL 与雨课堂 sessionid 对齐（14 天固定，不随访问滑动）
pub fn set_cookie_header(cookie_header: &str, max_age: u64) -> String {
    format!(
        "{YK_SESSION_COOKIE}={}; {COOKIE_ATTRS}; Max-Age={max_age}",
        encode(cookie_header)
    )
}

/// 退出登录时清除该 cookie
pub fn clear_cookie_header() -> String {
    format!("{YK_SESSION_COOKIE}=; {COOKIE_ATTRS}; Max-Age=0")
}

/// 从请求 Cookie 头提取并解码 `yk_session`；缺失或解码失败统一按无凭证处理
pub fn extract(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{YK_SESSION_COOKIE}=");
    for pair in raw.split(';') {
        if let Some(value) = pair.trim().strip_prefix(prefix.as_str()) {
            return decode(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    const COOKIE_HEADER: &str = "sessionid=abc123; csrftoken=tok99";

    #[test]
    fn encode_decode_roundtrip() {
        let encoded = encode(COOKIE_HEADER);
        // base64url 无填充：不含 cookie 语法敏感字符
        assert!(!encoded.contains([';', '=', ' ', '+', '/']));
        assert_eq!(decode(&encoded).as_deref(), Some(COOKIE_HEADER));
    }

    #[test]
    fn decode_rejects_garbage() {
        assert_eq!(decode("not-base64!!"), None);
        assert_eq!(decode(""), None);
        // 合法 base64 但内容为空白：视为无凭证
        assert_eq!(decode(&encode("  ")), None);
    }

    #[test]
    fn set_cookie_line_has_secure_attrs_and_ttl() {
        let line = set_cookie_header(COOKIE_HEADER, 1209600);
        assert!(line.starts_with(&format!("{YK_SESSION_COOKIE}=")));
        assert!(line.contains("HttpOnly"));
        assert!(line.contains("SameSite=Lax"));
        assert!(line.contains("Max-Age=1209600"));
        // 编码值可从 Set-Cookie 行还原
        let value = line
            .split(';')
            .next()
            .unwrap()
            .trim_start_matches("yk_session=");
        assert_eq!(decode(value).as_deref(), Some(COOKIE_HEADER));
    }

    #[test]
    fn clear_cookie_sets_max_age_zero() {
        let line = clear_cookie_header();
        assert!(line.starts_with(&format!("{YK_SESSION_COOKIE}=;")));
        assert!(line.contains("Max-Age=0"));
        assert!(line.contains("HttpOnly"));
    }

    #[test]
    fn extract_parses_from_mixed_cookie_header() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            format!(
                "a=1; {}={}; sid=tok",
                YK_SESSION_COOKIE,
                encode(COOKIE_HEADER)
            )
            .parse()
            .unwrap(),
        );
        assert_eq!(extract(&h).as_deref(), Some(COOKIE_HEADER));
    }

    #[test]
    fn extract_missing_or_invalid_is_none() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "sid=tok; a=1".parse().unwrap());
        assert_eq!(extract(&h), None);
        assert_eq!(extract(&HeaderMap::new()), None);

        h.insert(
            header::COOKIE,
            format!("{}=!!bad!!", YK_SESSION_COOKIE).parse().unwrap(),
        );
        assert_eq!(extract(&h), None);
    }
}
