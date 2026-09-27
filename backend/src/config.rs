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
//! - WECHAT_APP_ID        微信公众号 AppID（M5 微信内扫码；不填则微信内扫码不可用）
//! - WECHAT_APP_SECRET    微信公众号 AppSecret（同上，不入库）
//! - WS_*                 房间资源上限（见 [`Limits`]，防 OOM，全部可调）

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub server_secret: String,
    pub port: u16,
    /// 本站会话有效期（秒）
    pub cookie_ttl_secs: u64,
    pub captcha_app_id: String,
    pub yk_base_url: String,
    pub yk_allowed_hosts: Vec<String>,
    /// WS 房间资源上限（docs/DESIGN.md §6）
    pub limits: Limits,
    /// 日志文件目录（按天滚动）
    pub log_dir: String,
    /// 微信公众号 AppID（未配置 = 微信内扫码不可用，前端降级相机）
    pub wechat_app_id: Option<String>,
    /// 微信公众号 AppSecret（未配置同上；不入库）
    pub wechat_app_secret: Option<String>,
}

/// WS 房间资源上限（docs/SPEC.md §3.3.3，全部硬性要求，可经环境变量调整）
#[derive(Debug, Clone)]
pub struct Limits {
    /// 全局同时存在的房间数
    pub max_rooms_total: usize,
    /// 每用户同时建房数
    pub max_rooms_per_user: usize,
    /// 单房间人数上限
    pub max_members_per_room: usize,
    /// 单条消息（含二维码内容）字节数上限
    pub max_msg_bytes: usize,
    /// 单连接消息频率上限（条/分钟），超限 close 4008
    pub msgs_per_min: u32,
    /// 每频道消息队列（FIFO）上限
    pub max_msgs_per_room: usize,
    /// 单条消息有效期上限（秒），qr_ttl 钳制 (0, qr_ttl_max_secs]
    pub qr_ttl_max_secs: u64,
    /// 无消息自动删除阈值（含永久房间）
    pub room_inactivity_ttl: Duration,
    /// 全局 WS 连接上限
    pub max_connections: usize,
    /// 服务端心跳间隔（秒）
    pub heartbeat_interval_secs: u64,
    /// 超过该秒数未收到客户端任何消息判定假死
    pub heartbeat_dead_after_secs: u64,
    /// lobby（未加入房间）连接闲置回收秒数，close 4000
    pub lobby_idle_secs: u64,
    /// 房间默认生命周期（秒），房主未自定义时
    pub room_default_lifetime_secs: u64,
    /// 房间密码错误尝试上限（次/分钟），防爆破
    pub pw_attempts_per_min: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_rooms_total: 100,
            max_rooms_per_user: 5,
            max_members_per_room: 50,
            max_msg_bytes: 2048,
            msgs_per_min: 30,
            max_msgs_per_room: 100,
            qr_ttl_max_secs: 3600,
            room_inactivity_ttl: Duration::from_secs(14 * 24 * 60 * 60),
            max_connections: 500,
            heartbeat_interval_secs: 30,
            heartbeat_dead_after_secs: 60,
            lobby_idle_secs: 10 * 60,
            room_default_lifetime_secs: 4 * 60 * 60,
            pw_attempts_per_min: 5,
        }
    }
}

impl Limits {
    /// 可注入的环境查找（测试用），缺省回落 [`Limits::default`]
    pub fn from_lookup<F: Fn(&str) -> Option<String>>(lookup: F) -> Self {
        let d = Self::default();
        let mut l = Self {
            max_rooms_total: lookup("WS_MAX_ROOMS_TOTAL")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_rooms_total),
            max_rooms_per_user: lookup("WS_MAX_ROOMS_PER_USER")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_rooms_per_user),
            max_members_per_room: lookup("WS_MAX_MEMBERS_PER_ROOM")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_members_per_room),
            max_msg_bytes: lookup("WS_MAX_MSG_BYTES")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_msg_bytes),
            msgs_per_min: lookup("WS_MSGS_PER_MIN")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.msgs_per_min),
            max_msgs_per_room: lookup("WS_MAX_MSGS_PER_ROOM")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_msgs_per_room),
            qr_ttl_max_secs: lookup("WS_QR_TTL_MAX_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.qr_ttl_max_secs),
            room_inactivity_ttl: lookup("WS_ROOM_INACTIVITY_TTL_SECS")
                .and_then(|v| v.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(d.room_inactivity_ttl),
            max_connections: lookup("WS_MAX_CONNECTIONS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.max_connections),
            heartbeat_interval_secs: lookup("WS_HEARTBEAT_INTERVAL_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.heartbeat_interval_secs),
            heartbeat_dead_after_secs: lookup("WS_HEARTBEAT_DEAD_AFTER_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.heartbeat_dead_after_secs),
            lobby_idle_secs: lookup("WS_LOBBY_IDLE_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.lobby_idle_secs),
            room_default_lifetime_secs: lookup("WS_ROOM_DEFAULT_LIFETIME_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.room_default_lifetime_secs),
            pw_attempts_per_min: lookup("WS_PW_ATTEMPTS_PER_MIN")
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.pw_attempts_per_min),
        };
        // 消息有效期上限 1h 是 SPEC 硬性要求：配置只允许调小，不允许调大
        l.qr_ttl_max_secs = l.qr_ttl_max_secs.clamp(1, 3600);
        l
    }
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
            limits: Limits::from_lookup(&lookup),
            log_dir: lookup("LOG_DIR").unwrap_or_else(|| "logs".into()),
            wechat_app_id: optional_env(&lookup, "WECHAT_APP_ID"),
            wechat_app_secret: optional_env(&lookup, "WECHAT_APP_SECRET"),
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

/// 可选凭证读取：去空白，空串视作未配置
fn optional_env<F: Fn(&str) -> Option<String>>(lookup: &F, key: &str) -> Option<String> {
    lookup(key)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
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
        assert_eq!(c.wechat_app_id, None);
        assert_eq!(c.wechat_app_secret, None);
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
            ("WECHAT_APP_ID", " wx12345 "),
            ("WECHAT_APP_SECRET", "s3cr3t"),
        ]);
        assert_eq!(c.server_secret, "abc");
        assert_eq!(c.port, 8080);
        assert_eq!(c.cookie_ttl_secs, 3600);
        assert_eq!(c.captcha_app_id, "9999");
        assert_eq!(c.yk_base_url, "https://pro.yuketang.cn");
        assert_eq!(c.yk_allowed_hosts, vec!["pro.yuketang.cn", "other.cn"]);
        assert_eq!(c.wechat_app_id.as_deref(), Some("wx12345"));
        assert_eq!(c.wechat_app_secret.as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn blank_wechat_credentials_treated_as_unset() {
        let c = Config::from_pairs(&[("WECHAT_APP_ID", "  "), ("WECHAT_APP_SECRET", "")]);
        assert_eq!(c.wechat_app_id, None);
        assert_eq!(c.wechat_app_secret, None);
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
