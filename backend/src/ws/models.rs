//! WS 协议消息类型（docs/DESIGN.md §4）
//!
//! - 客户端 → 服务端：`join / leave / share_qr / sign_result / heartbeat`；
//! - 服务端 → 客户端：`joined / join_need_password / qr_update / member_join /
//!   member_leave / sign_result / plaza_update / error / heartbeat`；
//! - 信封：`{ "type": "...", "seq": <每连接单调递增>, "ts": <unix 毫秒>, ...payload }`。

use serde::{Deserialize, Serialize};

pub type RoomId = u32;
pub type UserId = i64;

/// WS `error` 消息业务码（与 REST 信封风格对齐）
pub mod error_code {
    /// 房间不存在或已关闭/已过期
    pub const ROOM_NOT_FOUND: i64 = 40404;
    /// 房间密码错误
    pub const WRONG_PASSWORD: i64 = 40302;
    /// 密码错误次数过多（限速冷却中）
    pub const PASSWORD_RATE_LIMITED: i64 = 40303;
    /// 仅房主可执行该操作
    pub const NOT_ROOM_OWNER: i64 = 40304;
    /// 房间人数已满
    pub const ROOM_FULL: i64 = 40901;
    /// 尚未加入房间
    pub const NOT_IN_ROOM: i64 = 40902;
    /// 消息内容超长
    pub const MSG_TOO_LARGE: i64 = 40305;
    /// 全局房间数已达上限
    pub const ROOMS_TOTAL_LIMIT: i64 = 40701;
    /// 每用户建房数已达上限
    pub const ROOMS_PER_USER_LIMIT: i64 = 40702;
    /// 非法入参（缺字段/超长等）
    pub const BAD_REQUEST: i64 = 40306;
}

/// 客户端 → 服务端消息（未知 type 解析失败 → 回 error）
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Join {
        room: RoomId,
        #[serde(default)]
        password: Option<String>,
    },
    Leave {
        room: RoomId,
    },
    ShareQr {
        room: RoomId,
        raw: String,
    },
    SignResult {
        room: RoomId,
        ok: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    /// 应用层心跳应答（服务端 30s 一次，客户端必须回 pong）
    Heartbeat,
}

/// 房间关联信息（全部可选，docs/DESIGN.md §6）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct RoomMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
}

/// 广场列表项（仅公开房间，docs/DESIGN.md §4.3）
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PlazaRoom {
    pub room_id: RoomId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub members: usize,
    /// 创建时间（unix 毫秒）
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<RoomMeta>,
}

/// 历史二维码消息（带过期时间供前端倒计时）
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct QrMsgOut {
    pub raw: String,
    pub by: UserId,
    /// 过期时间（unix 毫秒），到期前端自动隐藏
    pub expire_at: u64,
}

/// 服务端 → 客户端消息（序列化时 `type` 为平铺 tag）
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// 加入成功：全量成员 + 未过期历史消息 + 房间关联信息
    Joined {
        room: RoomId,
        owner: UserId,
        members: Vec<UserId>,
        messages: Vec<QrMsgOut>,
        #[serde(skip_serializing_if = "Option::is_none")]
        meta: Option<RoomMeta>,
    },
    /// 房间有密码且未带密码 → 前端弹密码输入
    JoinNeedPassword { room: RoomId },
    /// 二维码更新广播（expire_at = now + 房间 qr_ttl）
    QrUpdate {
        room: RoomId,
        raw: String,
        by: UserId,
        expire_at: u64,
    },
    /// 成员签到回执（广播给全房间）
    SignResult {
        room: RoomId,
        by: UserId,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// 全量成员列表同步
    MemberJoin {
        room: RoomId,
        owner: UserId,
        members: Vec<UserId>,
    },
    MemberLeave {
        room: RoomId,
        owner: UserId,
        members: Vec<UserId>,
    },
    /// 广场全量列表（仅 lobby 连接收）
    PlazaUpdate { rooms: Vec<PlazaRoom> },
    /// 业务错误（room 可缺省表示连接级错误）
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        room: Option<RoomId>,
        code: i64,
        msg: String,
    },
    /// 心跳，客户端必须回 pong
    Heartbeat,
}

/// 服务端下发信封：`{type, seq, ts, ...payload}`
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Envelope {
    #[serde(flatten)]
    pub msg: ServerMsg,
    /// 每连接单调递增序号
    pub seq: u64,
    /// 服务端发送时间（unix 毫秒）
    pub ts: u64,
}

impl Envelope {
    pub fn new(msg: ServerMsg, seq: u64, ts_ms: u64) -> Self {
        Self {
            msg,
            seq,
            ts: ts_ms,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            // ServerMsg 全部字段可序列化，此分支不可达；兜底为心跳帧避免中断连接
            r#"{"type":"heartbeat","seq":0,"ts":0}"#.to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_parses_all_types() {
        assert_eq!(
            serde_json::from_str::<ClientMsg>(r#"{"type":"join","room":123456}"#).unwrap(),
            ClientMsg::Join {
                room: 123456,
                password: None
            }
        );
        assert_eq!(
            serde_json::from_str::<ClientMsg>(r#"{"type":"join","room":1,"password":"pw"}"#)
                .unwrap(),
            ClientMsg::Join {
                room: 1,
                password: Some("pw".into())
            }
        );
        assert_eq!(
            serde_json::from_str::<ClientMsg>(r#"{"type":"leave","room":1}"#).unwrap(),
            ClientMsg::Leave { room: 1 }
        );
        assert_eq!(
            serde_json::from_str::<ClientMsg>(r#"{"type":"share_qr","room":1,"raw":"https://x"}"#)
                .unwrap(),
            ClientMsg::ShareQr {
                room: 1,
                raw: "https://x".into()
            }
        );
        assert_eq!(
            serde_json::from_str::<ClientMsg>(
                r#"{"type":"sign_result","room":1,"ok":false,"reason":"过期"}"#
            )
            .unwrap(),
            ClientMsg::SignResult {
                room: 1,
                ok: false,
                reason: Some("过期".into())
            }
        );
        assert_eq!(
            serde_json::from_str::<ClientMsg>(r#"{"type":"heartbeat"}"#).unwrap(),
            ClientMsg::Heartbeat
        );
    }

    #[test]
    fn client_msg_rejects_unknown_type_and_missing_fields() {
        assert!(serde_json::from_str::<ClientMsg>(r#"{"type":"evil"}"#).is_err());
        assert!(serde_json::from_str::<ClientMsg>(r#"{"type":"join"}"#).is_err());
        assert!(serde_json::from_str::<ClientMsg>(r#"{"type":"share_qr","room":1}"#).is_err());
        assert!(serde_json::from_str::<ClientMsg>(r#"garbage"#).is_err());
    }

    #[test]
    fn server_msg_serializes_snake_case_type_with_envelope() {
        let env = Envelope::new(
            ServerMsg::JoinNeedPassword { room: 123456 },
            7,
            1_730_000_000_000,
        );
        let v: serde_json::Value = serde_json::from_str(&env.to_json()).unwrap();
        assert_eq!(v["type"], "join_need_password");
        assert_eq!(v["seq"], 7);
        assert_eq!(v["ts"].as_u64(), Some(1_730_000_000_000));
        assert_eq!(v["room"], 123456);
    }

    #[test]
    fn qr_update_envelope_carries_payload() {
        let env = Envelope::new(
            ServerMsg::QrUpdate {
                room: 1,
                raw: "https://www.yuketang.cn/c/abc".into(),
                by: 42,
                expire_at: 999,
            },
            1,
            5,
        );
        let v: serde_json::Value = serde_json::from_str(&env.to_json()).unwrap();
        assert_eq!(v["type"], "qr_update");
        assert_eq!(v["by"], 42);
        assert_eq!(v["expire_at"], 999);
    }

    #[test]
    fn error_envelope_omits_absent_room() {
        let env = Envelope::new(
            ServerMsg::Error {
                room: None,
                code: error_code::BAD_REQUEST,
                msg: "bad".into(),
            },
            1,
            5,
        );
        let v: serde_json::Value = serde_json::from_str(&env.to_json()).unwrap();
        assert!(v.get("room").is_none());
        assert_eq!(v["code"], error_code::BAD_REQUEST);
    }

    #[test]
    fn room_meta_skips_none_fields() {
        let meta = RoomMeta {
            course_name: Some("高数".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["course_name"], "高数");
        assert!(v.get("location").is_none());
    }
}
