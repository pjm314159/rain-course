//! 配置：环境变量加载（docs/DESIGN.md §6）
//!
//! 变量：SERVER_SECRET、PORT、YK_CAPTCHA_APP_ID、YK_BASE_URL、YK_ALLOWED_HOSTS（逗号分隔）

#[derive(Debug, Clone)]
pub struct Config {
    /// 签名 cookie 的 HMAC 密钥
    pub server_secret: String,
    /// 监听端口
    pub port: u16,
    /// 腾讯验证码 AppId（透传给前端，雨课堂同款）
    pub captcha_app_id: String,
    /// 雨课堂服务端基地址
    pub yk_base_url: String,
    /// 雨课堂域名白名单（§5 安全校验用，M2 生效）
    pub yk_allowed_hosts: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            server_secret: std::env::var("SERVER_SECRET").unwrap_or_else(|_| "dev-secret".into()),
            port: std::env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3000),
            captcha_app_id: std::env::var("YK_CAPTCHA_APP_ID")
                .unwrap_or_else(|_| "2091064951".into()),
            yk_base_url: std::env::var("YK_BASE_URL")
                .unwrap_or_else(|_| "https://www.yuketang.cn".into()),
            yk_allowed_hosts: parse_hosts(
                &std::env::var("YK_ALLOWED_HOSTS")
                    .unwrap_or_else(|_| "www.yuketang.cn,pro.yuketang.cn".into()),
            ),
        }
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

    #[test]
    fn single_host_without_comma() {
        assert_eq!(parse_hosts("www.yuketang.cn"), vec!["www.yuketang.cn"]);
    }
}
