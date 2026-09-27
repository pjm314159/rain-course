//! 签到二维码内容安全校验（docs/DESIGN.md §5，重点防线）
//!
//! 流程固定：① 长度/字符过滤 → ② URL 解析（https + 域名白名单 + 禁 IP/userinfo/端口）。
//! 任何未通过校验的内容直接拒绝，绝不向其发起请求（防 SSRF / 钓鱼转发）。

use url::Url;

/// 二维码内容最大长度（字节）
pub const MAX_QR_BYTES: usize = 2048;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ValidateError {
    #[error("内容为空或超长")]
    BadLength,
    #[error("内容不是合法 URL")]
    BadUrl,
    #[error("必须使用 HTTPS")]
    BadScheme,
    #[error("URL 不允许携带用户信息")]
    HasUserinfo,
    #[error("不允许 IP 地址或非白名单端口")]
    BadHostOrPort,
    #[error("域名不在雨课堂白名单")]
    HostNotAllowed,
}

/// 校验二维码原始内容是否为白名单雨课堂签到 URL。
///
/// 白名单为精确主机匹配（大小写不敏感）：`evil-yuketang.cn`、`www.yuketang.cn.evil.com`
/// 均不命中；裸域 `yuketang.cn` 也不命中（如需支持由配置显式加入）。
/// 端口仅允许缺省（443）；IP 字面量与 userinfo 一律拒绝。
pub fn validate_qr_url(raw: &str, allowed_hosts: &[String]) -> Result<Url, ValidateError> {
    if raw.is_empty() || raw.len() > MAX_QR_BYTES {
        return Err(ValidateError::BadLength);
    }
    let parsed = Url::parse(raw).map_err(|_| ValidateError::BadUrl)?;
    if parsed.scheme() != "https" {
        return Err(ValidateError::BadScheme);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ValidateError::HasUserinfo);
    }
    // IP 字面量（Ipv4/Ipv6）拒绝；仅接受域名
    if !matches!(parsed.host(), Some(url::Host::Domain(_))) {
        return Err(ValidateError::BadHostOrPort);
    }
    match parsed.port() {
        None | Some(443) => {}
        Some(_) => return Err(ValidateError::BadHostOrPort),
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if !allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) {
        return Err(ValidateError::HostNotAllowed);
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        [
            "www.yuketang.cn",
            "pro.yuketang.cn",
            "changjiang.yuketang.cn",
            "huanghe.yuketang.cn",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn accepts_whitelisted_https_hosts() {
        for url in [
            "https://www.yuketang.cn/c/abc?x=1",
            "https://pro.yuketang.cn/",
            "https://changjiang.yuketang.cn/v/lesson/1",
            "https://huanghe.yuketang.cn",
            "https://WWW.YUKETANG.CN/c/abc", // host 大小写不敏感
        ] {
            let parsed = validate_qr_url(url, &hosts()).unwrap_or_else(|e| panic!("{url}: {e}"));
            assert_eq!(parsed.scheme(), "https");
        }
    }

    #[test]
    fn rejects_empty_and_oversize() {
        assert_eq!(validate_qr_url("", &hosts()), Err(ValidateError::BadLength));
        let big = format!("https://www.yuketang.cn/{}", "a".repeat(MAX_QR_BYTES));
        assert_eq!(
            validate_qr_url(&big, &hosts()),
            Err(ValidateError::BadLength)
        );
    }

    #[test]
    fn rejects_non_url_garbage() {
        assert_eq!(
            validate_qr_url("not a url at all", &hosts()),
            Err(ValidateError::BadUrl)
        );
        assert_eq!(
            validate_qr_url("随机中文串xyz", &hosts()),
            Err(ValidateError::BadUrl)
        );
    }

    #[test]
    fn rejects_non_https_schemes() {
        for url in [
            "http://www.yuketang.cn/c/abc",
            "ftp://www.yuketang.cn/c/abc",
            "javascript:alert(1)",
            "data:text/html,evil",
        ] {
            assert_eq!(
                validate_qr_url(url, &hosts()),
                Err(ValidateError::BadScheme),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_userinfo() {
        assert_eq!(
            validate_qr_url("https://user@www.yuketang.cn/c", &hosts()),
            Err(ValidateError::HasUserinfo)
        );
        assert_eq!(
            validate_qr_url("https://u:p@www.yuketang.cn/c", &hosts()),
            Err(ValidateError::HasUserinfo)
        );
    }

    #[test]
    fn rejects_ip_literals_and_ports() {
        assert_eq!(
            validate_qr_url("https://1.2.3.4/c", &hosts()),
            Err(ValidateError::BadHostOrPort)
        );
        assert_eq!(
            validate_qr_url("https://[::1]/c", &hosts()),
            Err(ValidateError::BadHostOrPort)
        );
        assert_eq!(
            validate_qr_url("https://www.yuketang.cn:8080/c", &hosts()),
            Err(ValidateError::BadHostOrPort)
        );
        // 显式 443 与缺省等价，放行
        assert!(validate_qr_url("https://www.yuketang.cn:443/c", &hosts()).is_ok());
    }

    #[test]
    fn rejects_hosts_outside_whitelist() {
        // 仿冒域、子域拼接、裸域、完全无关域
        for url in [
            "https://evil-yuketang.cn/c",
            "https://www.yuketang.cn.evil.com/c",
            "https://yuketang.cn/c",
            "https://evil.com/c",
            "https://www.yuketang.cn.attacker.io/c",
        ] {
            assert_eq!(
                validate_qr_url(url, &hosts()),
                Err(ValidateError::HostNotAllowed),
                "{url}"
            );
        }
    }

    #[test]
    fn empty_whitelist_rejects_everything() {
        assert_eq!(
            validate_qr_url("https://www.yuketang.cn/c", &[]),
            Err(ValidateError::HostNotAllowed)
        );
    }
}
