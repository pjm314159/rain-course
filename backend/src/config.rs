//! 配置：.env / 环境变量加载（docs/DESIGN.md §6）
//!
//! 变量（见仓库根 .env.example）：
//! - PORT                 监听端口（默认 3000）
//! - SERVER_SECRET        签名 cookie 的 HMAC 密钥（必改！）
//! - COOKIE_TTL_SECS      本站会话有效期（默认 1209600 = 14 天，对齐雨课堂 sessionid）
//! - YK_CAPTCHA_APP_ID    腾讯验证码 AppId（默认 2091064951，雨课堂同款）
//! - YK_BASE_URL          雨课堂基地址
//! - YK_ALLOWED_HOSTS     雨课堂域名白名单（逗号分隔）
//! - RUST_LOG             日志级别（tracing EnvFilter）

#[derive(Debug, Clone)]
pub struct Config {
    pub server_secret: String,
    pub port: u16,
    /// 本站会话有效期（秒）
    pub cookie_ttl_secs: u64,
    pub captcha_app_id: String,
    pub yk_base_url: String,
    pub yk_allowed_hosts: Vec<String>,
    /// 日志文件目录（按天滚动）
    pub log_dir: String,
}

impl Config {
    /// 从进程环境读取（main 里已先用 dotenvy 加载 .env）
    pub fn from_env() -> Self {
        Self::from_lookup(|key: &str| std::env::var(key).ok())
    }

    /// 可注入的环境查找（测试用）
    pub fn from_lookup<F: Fn(&str) -> Option<String>>(lookup: F) -> Self {
        Self {
            server_secret: lookup("SERVER_SECRET").unwrap_or_else(|| "dev-secret".into()),
            port: lookup("PORT").and_then(|v| v.parse().ok()).unwrap_or(3000),
            cookie_ttl_secs: lookup("COOKIE_TTL_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(14 * 24 * 60 * 60),
            captcha_app_id: lookup("YK_CAPTCHA_APP_ID").unwrap_or_else(|| "2091064951".into()),
            yk_base_url: lookup("YK_BASE_URL").unwrap_or_else(|| "https://www.yuketang.cn".into()),
            yk_allowed_hosts: parse_hosts(&lookup("YK_ALLOWED_HOSTS").unwrap_or_else(|| {
                "www.yuketang.cn,pro.yuketang.cn,changjiang.yuketang.cn,huanghe.yuketang.cn".into()
            })),
            log_dir: lookup("LOG_DIR").unwrap_or_else(|| "logs".into()),
        }
    }

    /// 便利构造：从键值对（测试用）
    #[cfg(test)]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        use std::collections::HashMap;
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Self::from_lookup(&move |k: &str| map.get(k).cloned())
    }
}

/// 解析逗号分隔的域名列表：去空白、去空项、统一小写
pub fn parse_hosts(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_no_env() {
        let c = Config::from_lookup(|_: &str| None);
        assert_eq!(c.server_secret, "dev-secret");
        assert_eq!(c.port, 3000);
        assert_eq!(c.cookie_ttl_secs, 14 * 24 * 60 * 60);
        assert_eq!(c.captcha_app_id, "2091064951");
        assert_eq!(
            c.yk_allowed_hosts,
            vec![
                "www.yuketang.cn",
                "pro.yuketang.cn",
                "changjiang.yuketang.cn",
                "huanghe.yuketang.cn"
            ]
        );
    }

    #[test]
    fn overrides_take_effect() {
        let c = Config::from_pairs(&[
            ("SERVER_SECRET", "abc"),
            ("PORT", "8080"),
            ("COOKIE_TTL_SECS", "3600"),
            ("YK_CAPTCHA_APP_ID", "9999"),
            ("YK_BASE_URL", "https://pro.yuketang.cn"),
            ("YK_ALLOWED_HOSTS", "Pro.Yuketang.cn, other.cn"),
        ]);
        assert_eq!(c.server_secret, "abc");
        assert_eq!(c.port, 8080);
        assert_eq!(c.cookie_ttl_secs, 3600);
        assert_eq!(c.captcha_app_id, "9999");
        assert_eq!(c.yk_base_url, "https://pro.yuketang.cn");
        assert_eq!(c.yk_allowed_hosts, vec!["pro.yuketang.cn", "other.cn"]);
    }

    #[test]
    fn invalid_port_falls_back_to_default() {
        let c = Config::from_pairs(&[("PORT", "not-a-number")]);
        assert_eq!(c.port, 3000);
    }

    #[test]
    fn parses_trimmed_lowercase_hosts() {
        assert_eq!(
            parse_hosts(" A.Yuketang.cn , pro.yuketang.cn ,, "),
            vec!["a.yuketang.cn", "pro.yuketang.cn"]
        );
    }

    #[test]
    fn empty_input_yields_no_hosts() {
        assert!(parse_hosts("").is_empty());
        assert!(parse_hosts(" , ,").is_empty());
    }
}
