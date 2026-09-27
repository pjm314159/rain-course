//! WS 房间 Hub（docs/DESIGN.md §4、§6）
//!
//! 全部方法为同步快速操作（`std::sync::Mutex` 不跨 await），广播经
//! `tokio::sync::broadcast` 有界通道；时间由调用方注入 [`Now`]，便于测试。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{broadcast, mpsc};

use crate::config::Limits;
use crate::ws::models::{PlazaRoom, QrMsgOut, RoomId, RoomMeta, ServerMsg, UserId, error_code};

/// 每房间广播通道容量（有界，满则丢弃最旧）
const ROOM_CHANNEL_CAP: usize = 64;
/// lobby 广播通道容量
const LOBBY_CHANNEL_CAP: usize = 64;

/// close code：心跳假死 / lobby 空闲回收
pub const CLOSE_IDLE: u16 = 4000;
/// close code：单连接消息频率超限
pub const CLOSE_RATE: u16 = 4008;
/// close code：被同账号新连接替代（单用户单连接）
pub const CLOSE_REPLACED: u16 = 4009;

/// 注入的时间点（单调钟 + unix 毫秒），测试可控
#[derive(Clone, Copy, Debug)]
pub struct Now {
    pub instant: Instant,
    pub unix_ms: u64,
}

impl Now {
    pub fn real() -> Self {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            instant: Instant::now(),
            unix_ms,
        }
    }

    #[cfg(test)]
    pub fn at(instant: Instant, unix_ms: u64) -> Self {
        Self { instant, unix_ms }
    }
}

/// 连接出站指令：直发消息 / 订阅切换 / 关闭
#[derive(Debug)]
pub enum Outbound {
    Subscribe(broadcast::Receiver<ServerMsg>),
    Unsubscribe,
}

struct Conn {
    user_id: UserId,
    /// 当前所在房间；None = lobby
    room: Option<RoomId>,
    last_seen: Instant,
    /// 60s 滑动窗口内收到的消息时刻（频率限速）
    recent: VecDeque<Instant>,
    outbox: mpsc::UnboundedSender<Outbound>,
    /// 服务端主动断开时写入 close code（可克隆：连接任务自身也持有发送端）
    close: mpsc::UnboundedSender<u16>,
}

struct QrMsg {
    raw: String,
    by: UserId,
    /// 内部比较用单调钟
    expire_at: Instant,
    /// 下发给前端的过期时间（unix 毫秒，供倒计时）
    expire_unix_ms: u64,
}

struct Room {
    id: RoomId,
    name: Option<String>,
    owner: UserId,
    /// 明文 + 常量时间比较 + 失败限速；仅内存，不落日志
    password: Option<String>,
    meta: Option<RoomMeta>,
    /// 单条消息生命周期（钳制 (0, 3600s]）
    qr_ttl: Duration,
    /// FIFO ≤ limits.max_msgs_per_room；入队时惰性淘汰队头过期项
    messages: VecDeque<QrMsg>,
    /// 最后一条消息时间，用于 14 天无消息自动删除
    last_activity: Instant,
    members: HashMap<UserId, ConnId>,
    tx: broadcast::Sender<ServerMsg>,
    created_unix_ms: u64,
    /// 房主自定义生命周期终点；None = 永久（仍受 14 天无消息约束）
    expires_at: Option<Instant>,
}

impl Room {
    /// 入队：惰性淘汰队头过期消息（队头必最旧，均摊 O(1)），再按容量淘汰最旧
    fn push_msg(&mut self, msg: QrMsg, max: usize, now: Now) {
        while self
            .messages
            .front()
            .is_some_and(|m| m.expire_at <= now.instant)
        {
            self.messages.pop_front();
        }
        while self.messages.len() >= max {
            self.messages.pop_front();
        }
        self.messages.push_back(msg);
    }
}

#[derive(Default)]
struct HubInner {
    rooms: HashMap<RoomId, Room>,
    conns: HashMap<ConnId, Conn>,
    /// (room, user) → 60s 窗口内的密码错误尝试
    pw_attempts: HashMap<(RoomId, UserId), VecDeque<Instant>>,
}

pub type ConnId = u64;

/// 建房请求（REST /api/rooms 已做基础校验，Hub 内再钳制兜底）
#[derive(Debug, Default, Clone)]
pub struct CreateRoomSpec {
    pub name: Option<String>,
    pub password: Option<String>,
    pub qr_ttl_secs: Option<u64>,
    /// 自定义生命周期（分钟，≥1）；与 `permanent` 均缺省 → 默认 4 小时
    pub lifetime_mins: Option<u64>,
    /// 永久房间（仍受 14 天无消息约束）
    pub permanent: bool,
    pub meta: Option<RoomMeta>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateRoomError {
    TotalLimit,
    PerUserLimit,
    BadInput(&'static str),
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseRoomError {
    NotFound,
    NotOwner,
}

/// join 结果
#[derive(Debug)]
pub enum JoinResult {
    /// 成功回执（同时已通过 outbox 发送 Subscribe 指令）
    Joined(Box<ServerMsg>),
    /// 房间有密码且未带密码
    NeedPassword,
    /// 失败（房间不存在 / 密码错误 / 满员…）
    Failed(WsError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsError {
    pub code: i64,
    pub msg: String,
}

impl WsError {
    fn new(code: i64, msg: &str) -> Self {
        Self {
            code,
            msg: msg.to_string(),
        }
    }
}

/// sweep 产出：待关闭连接与被回收房间
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SweepOutcome {
    pub closed_conns: Vec<(ConnId, u16)>,
    pub removed_rooms: Vec<RoomId>,
}

/// 房间管理核心。所有方法同步、不阻塞；时间由调用方注入。
pub struct Hub {
    limits: Limits,
    inner: Mutex<HubInner>,
    /// plaza_update 广播（lobby 连接订阅）
    lobby_tx: broadcast::Sender<ServerMsg>,
    next_conn: AtomicU64,
}

impl Hub {
    pub fn new(limits: Limits) -> Self {
        let (lobby_tx, _) = broadcast::channel(LOBBY_CHANNEL_CAP);
        Self {
            limits,
            inner: Mutex::new(HubInner::default()),
            lobby_tx,
            next_conn: AtomicU64::new(1),
        }
    }

    pub fn conn_count(&self) -> usize {
        self.inner.lock().expect("hub lock").conns.len()
    }

    // ---- 连接生命周期 ----

    /// 注册连接；同账号已有连接时向旧连接发 close 4009（单用户单连接）。
    pub fn register(
        &self,
        user_id: UserId,
        outbox: mpsc::UnboundedSender<Outbound>,
        close: mpsc::UnboundedSender<u16>,
        now: Now,
    ) -> ConnId {
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let mut g = self.inner.lock().expect("hub lock");
        if let Some(old) = g.conns.values().find(|c| c.user_id == user_id) {
            // 旧连接的成员清理由其任务退出后的 unregister 完成
            let _ = old.close.send(CLOSE_REPLACED);
        }
        g.conns.insert(
            conn_id,
            Conn {
                user_id,
                room: None,
                last_seen: now.instant,
                recent: VecDeque::new(),
                outbox,
                close,
            },
        );
        conn_id
    }

    /// 连接结束：移出房间（广播 member_leave）、更新广场
    pub fn unregister(&self, conn_id: ConnId) {
        let mut g = self.inner.lock().expect("hub lock");
        self.do_leave(&mut g, conn_id);
        g.conns.remove(&conn_id);
        drop(g);
        self.broadcast_plaza();
    }

    // ---- 房间管理（REST）----

    pub fn create_room(
        &self,
        owner: UserId,
        spec: CreateRoomSpec,
        now: Now,
    ) -> Result<RoomId, CreateRoomError> {
        let name = clean_field(spec.name.as_deref(), 32, "房间名过长（>32）")?;
        let password = match spec.password.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(p) if p.len() > 64 => return Err(CreateRoomError::BadInput("密码过长（>64）")),
            Some(p) => Some(p.to_string()),
        };
        let meta = match spec.meta {
            None => None,
            Some(m) => Some(RoomMeta {
                course_name: clean_field(m.course_name.as_deref(), 64, "课程名过长（>64）")?,
                location: clean_field(m.location.as_deref(), 64, "地点过长（>64）")?,
                teacher: clean_field(m.teacher.as_deref(), 64, "教师过长（>64）")?,
                time: clean_field(m.time.as_deref(), 64, "时间过长（>64）")?,
                class_name: clean_field(m.class_name.as_deref(), 64, "班级过长（>64）")?,
            })
            .filter(|m: &RoomMeta| *m != RoomMeta::default()),
        };
        let qr_ttl = Duration::from_secs(
            spec.qr_ttl_secs
                .unwrap_or(self.limits.qr_ttl_max_secs)
                .clamp(1, self.limits.qr_ttl_max_secs),
        );
        let expires_at = if spec.permanent {
            None
        } else {
            let secs = spec
                .lifetime_mins
                .filter(|m| *m >= 1)
                .map(|m| m * 60)
                .unwrap_or(self.limits.room_default_lifetime_secs);
            Some(now.instant + Duration::from_secs(secs))
        };

        let mut g = self.inner.lock().expect("hub lock");
        if g.rooms.len() >= self.limits.max_rooms_total {
            return Err(CreateRoomError::TotalLimit);
        }
        if g.rooms.values().filter(|r| r.owner == owner).count() >= self.limits.max_rooms_per_user {
            return Err(CreateRoomError::PerUserLimit);
        }
        let id = self.gen_room_id(&g);
        let (tx, _) = broadcast::channel(ROOM_CHANNEL_CAP);
        g.rooms.insert(
            id,
            Room {
                id,
                name,
                owner,
                password,
                meta,
                qr_ttl,
                messages: VecDeque::new(),
                last_activity: now.instant,
                members: HashMap::new(),
                tx,
                created_unix_ms: now.unix_ms,
                expires_at,
            },
        );
        drop(g);
        self.broadcast_plaza();
        Ok(id)
    }

    /// 房主关闭房间：向成员广播 error(40404) 后回收
    pub fn close_room(&self, actor: UserId, room_id: RoomId) -> Result<(), CloseRoomError> {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(room) = g.rooms.get(&room_id) else {
            return Err(CloseRoomError::NotFound);
        };
        if room.owner != actor {
            return Err(CloseRoomError::NotOwner);
        }
        let _ = room.tx.send(ServerMsg::Error {
            room: Some(room_id),
            code: error_code::ROOM_NOT_FOUND,
            msg: "房间已由房主关闭".into(),
        });
        let room = g.rooms.remove(&room_id).expect("room just checked");
        for conn in g.conns.values_mut() {
            if conn.room == Some(room_id) {
                conn.room = None;
                let _ = conn.outbox.send(Outbound::Unsubscribe);
            }
        }
        drop(room);
        drop(g);
        self.broadcast_plaza();
        Ok(())
    }

    /// 广场列表：仅无密码房间（docs/DESIGN.md §4.3，密码房间任何接口不可枚举）
    pub fn plaza(&self) -> Vec<PlazaRoom> {
        let g = self.inner.lock().expect("hub lock");
        let mut list: Vec<PlazaRoom> = g
            .rooms
            .values()
            .filter(|r| r.password.is_none())
            .map(|r| PlazaRoom {
                room_id: r.id,
                name: r.name.clone(),
                members: r.members.len(),
                created_at: r.created_unix_ms,
                meta: r.meta.clone(),
            })
            .collect();
        list.sort_unstable_by_key(|r| r.room_id);
        list
    }

    /// 向 lobby 连接广播广场全量列表
    pub fn broadcast_plaza(&self) {
        let msg = ServerMsg::PlazaUpdate {
            rooms: self.plaza(),
        };
        let _ = self.lobby_tx.send(msg);
    }

    pub fn subscribe_lobby(&self) -> broadcast::Receiver<ServerMsg> {
        self.lobby_tx.subscribe()
    }

    /// 测试/调试辅助：订阅房间广播
    #[cfg(test)]
    pub fn subscribe_room(&self, room_id: RoomId) -> Option<broadcast::Receiver<ServerMsg>> {
        self.inner
            .lock()
            .expect("hub lock")
            .rooms
            .get(&room_id)
            .map(|r| r.tx.subscribe())
    }

    // ---- WS 消息处理 ----

    /// 加入房间（含密码流程，docs/DESIGN.md §4.1）
    pub fn join(
        &self,
        conn_id: ConnId,
        room_id: RoomId,
        password: Option<&str>,
        now: Now,
    ) -> JoinResult {
        let mut g = self.inner.lock().expect("hub lock");
        let user_id = match g.conns.get(&conn_id) {
            Some(c) => c.user_id,
            None => return JoinResult::Failed(WsError::new(error_code::BAD_REQUEST, "连接不存在")),
        };
        let Some(room) = g.rooms.get(&room_id) else {
            return JoinResult::Failed(WsError::new(
                error_code::ROOM_NOT_FOUND,
                "房间不存在或已关闭",
            ));
        };
        let already = room.members.contains_key(&user_id);
        let stored_pw = room.password.clone();
        if !already && room.members.len() >= self.limits.max_members_per_room {
            return JoinResult::Failed(WsError::new(error_code::ROOM_FULL, "房间人数已满"));
        }

        // 幂等：已在同房间（重连后重复 join）→ 直接全量补齐，不重复广播
        if g.conns.get(&conn_id).and_then(|c| c.room) == Some(room_id) {
            return JoinResult::Joined(Box::new(Self::build_joined(room, now)));
        }

        // 密码校验（已在本房间的不重复校验）
        if let Some(stored) = stored_pw.filter(|_| !already) {
            let Some(p) = password else {
                return JoinResult::NeedPassword;
            };
            if !Self::pw_attempt_allowed(
                &mut g,
                room_id,
                user_id,
                now,
                self.limits.pw_attempts_per_min,
            ) {
                return JoinResult::Failed(WsError::new(
                    error_code::PASSWORD_RATE_LIMITED,
                    "密码错误次数过多，请稍后再试",
                ));
            }
            if !constant_time_eq(p.as_bytes(), stored.as_bytes()) {
                Self::pw_record_failure(&mut g, room_id, user_id, now);
                return JoinResult::Failed(WsError::new(
                    error_code::WRONG_PASSWORD,
                    "房间密码错误",
                ));
            }
        }

        // 单连接同时只在一个房间：自动离开当前房间
        if g.conns.get(&conn_id).and_then(|c| c.room).is_some() {
            self.do_leave(&mut g, conn_id);
        }

        let rx = {
            let room = g.rooms.get_mut(&room_id).expect("room checked above");
            room.members.insert(user_id, conn_id);
            let members = member_list(room);
            let rx = room.tx.subscribe();
            let _ = room.tx.send(ServerMsg::MemberJoin {
                room: room_id,
                owner: room.owner,
                members,
            });
            rx
        };
        if let Some(conn) = g.conns.get_mut(&conn_id) {
            conn.room = Some(room_id);
            let _ = conn.outbox.send(Outbound::Subscribe(rx));
        }
        let joined = Self::build_joined(g.rooms.get(&room_id).expect("room kept"), now);
        drop(g);
        self.broadcast_plaza();
        JoinResult::Joined(Box::new(joined))
    }

    /// 主动离开当前房间回 lobby（docs/DESIGN.md §4.2 leave）
    pub fn leave(&self, conn_id: ConnId) {
        let mut g = self.inner.lock().expect("hub lock");
        self.do_leave(&mut g, conn_id);
        drop(g);
        self.broadcast_plaza();
    }

    /// 扫码者推送二维码（docs/DESIGN.md §4.2 share_qr）。
    /// 内容合法性（白名单 URL）由路由层先行校验，Hub 仅做成员与长度检查。
    pub fn share_qr(&self, conn_id: ConnId, raw: &str, now: Now) -> Result<ServerMsg, WsError> {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(conn) = g.conns.get(&conn_id) else {
            return Err(WsError::new(error_code::BAD_REQUEST, "连接不存在"));
        };
        let Some(room_id) = conn.room else {
            return Err(WsError::new(error_code::NOT_IN_ROOM, "尚未加入房间"));
        };
        let user_id = conn.user_id;
        if raw.len() > self.limits.max_msg_bytes {
            return Err(WsError::new(error_code::MSG_TOO_LARGE, "消息内容超长"));
        }
        let room = g
            .rooms
            .get_mut(&room_id)
            .expect("conn.room points to live room");
        let expire_unix_ms = now.unix_ms + room.qr_ttl.as_millis() as u64;
        room.push_msg(
            QrMsg {
                raw: raw.to_string(),
                by: user_id,
                expire_at: now.instant + room.qr_ttl,
                expire_unix_ms,
            },
            self.limits.max_msgs_per_room,
            now,
        );
        room.last_activity = now.instant;
        let msg = ServerMsg::QrUpdate {
            room: room_id,
            raw: raw.to_string(),
            by: user_id,
            expire_at: expire_unix_ms,
        };
        let _ = room.tx.send(msg.clone());
        Ok(msg)
    }

    /// 成员签到回执（docs/DESIGN.md §4.2 sign_result），广播给全房间
    pub fn sign_result(
        &self,
        conn_id: ConnId,
        ok: bool,
        reason: Option<String>,
    ) -> Result<(), WsError> {
        let g = self.inner.lock().expect("hub lock");
        let Some(conn) = g.conns.get(&conn_id) else {
            return Err(WsError::new(error_code::BAD_REQUEST, "连接不存在"));
        };
        let Some(room_id) = conn.room else {
            return Err(WsError::new(error_code::NOT_IN_ROOM, "尚未加入房间"));
        };
        let room = g
            .rooms
            .get(&room_id)
            .expect("conn.room points to live room");
        let _ = room.tx.send(ServerMsg::SignResult {
            room: room_id,
            by: conn.user_id,
            ok,
            reason,
        });
        Ok(())
    }

    /// 应用层心跳 pong：刷新活跃时间（假死判定依据）
    pub fn touch(&self, conn_id: ConnId, now: Now) {
        if let Some(c) = self.inner.lock().expect("hub lock").conns.get_mut(&conn_id) {
            c.last_seen = now.instant;
        }
    }

    /// 单连接消息频率限速（docs/SPEC.md §3.3.3：超 30 条/分钟 close 4008）。
    /// 返回 false 表示超限，调用方必须断开连接。
    pub fn admit(&self, conn_id: ConnId, now: Now) -> bool {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(c) = g.conns.get_mut(&conn_id) else {
            return false;
        };
        c.last_seen = now.instant;
        let window = Duration::from_secs(60);
        while c
            .recent
            .front()
            .is_some_and(|t| now.instant.saturating_duration_since(*t) > window)
        {
            c.recent.pop_front();
        }
        if c.recent.len() as u32 >= self.limits.msgs_per_min {
            return false;
        }
        c.recent.push_back(now.instant);
        true
    }

    /// 周期巡检：心跳假死判死、lobby 空闲回收、房间到期/14 天无消息回收。
    /// 生产循环传入 `Now::real()`；测试注入虚拟时间。
    pub fn sweep(&self, now: Now) -> SweepOutcome {
        let mut out = SweepOutcome::default();
        let mut g = self.inner.lock().expect("hub lock");

        // ① 连接判死：心跳超时（全连接）或 lobby 空闲超时
        let dead_after = Duration::from_secs(self.limits.heartbeat_dead_after_secs);
        let lobby_idle = Duration::from_secs(self.limits.lobby_idle_secs);
        let dead: Vec<(ConnId, u16)> = g
            .conns
            .iter()
            .filter_map(|(id, c)| {
                let idle = now.instant.saturating_duration_since(c.last_seen);
                if idle > dead_after || (c.room.is_none() && idle > lobby_idle) {
                    Some((*id, CLOSE_IDLE))
                } else {
                    None
                }
            })
            .collect();
        for (id, code) in &dead {
            if let Some(c) = g.conns.get(id) {
                let _ = c.close.send(*code);
            }
            self.do_leave(&mut g, *id);
            g.conns.remove(id);
        }
        if !dead.is_empty() {
            out.closed_conns = dead;
        }

        // ② 房间回收：min(自定义生命周期, 最后一条消息 + 14 天)；永久房间仅受 14 天约束
        let inactivity = self.limits.room_inactivity_ttl;
        let expired: Vec<RoomId> = g
            .rooms
            .values()
            .filter(|r| {
                let deadline = r
                    .expires_at
                    .map(|e| e.min(r.last_activity + inactivity))
                    .unwrap_or(r.last_activity + inactivity);
                now.instant >= deadline
            })
            .map(|r| r.id)
            .collect();
        for id in expired {
            if let Some(room) = g.rooms.remove(&id) {
                let _ = room.tx.send(ServerMsg::Error {
                    room: Some(id),
                    code: error_code::ROOM_NOT_FOUND,
                    msg: "房间已过期关闭".into(),
                });
                for conn in g.conns.values_mut() {
                    if conn.room == Some(id) {
                        conn.room = None;
                        let _ = conn.outbox.send(Outbound::Unsubscribe);
                    }
                }
                out.removed_rooms.push(id);
            }
        }

        // ③ 密码尝试窗口惰性清理
        let win = Duration::from_secs(60);
        g.pw_attempts.retain(|_, v| {
            v.back()
                .is_some_and(|t| now.instant.saturating_duration_since(*t) <= win)
        });

        drop(g);
        if !out.closed_conns.is_empty() || !out.removed_rooms.is_empty() {
            self.broadcast_plaza();
        }
        out
    }

    // ---- 内部 ----

    /// 离开房间：移除成员、广播 member_leave、退订。
    /// 只做状态变更（不重新加锁、不广播广场）——由调用方在释放锁后统一广播。
    fn do_leave(&self, g: &mut HubInner, conn_id: ConnId) {
        let Some(conn) = g.conns.get(&conn_id) else {
            return;
        };
        let Some(room_id) = conn.room else { return };
        let user_id = conn.user_id;
        if let Some(room) = g.rooms.get_mut(&room_id)
            && room.members.remove(&user_id).is_some()
        {
            let members = member_list(room);
            let _ = room.tx.send(ServerMsg::MemberLeave {
                room: room_id,
                owner: room.owner,
                members,
            });
        }
        if let Some(conn) = g.conns.get_mut(&conn_id) {
            conn.room = None;
            let _ = conn.outbox.send(Outbound::Unsubscribe);
        }
    }

    fn build_joined(room: &Room, now: Now) -> ServerMsg {
        ServerMsg::Joined {
            room: room.id,
            owner: room.owner,
            members: member_list(room),
            messages: room
                .messages
                .iter()
                .filter(|m| m.expire_at > now.instant)
                .map(|m| QrMsgOut {
                    raw: m.raw.clone(),
                    by: m.by,
                    expire_at: m.expire_unix_ms,
                })
                .collect(),
            meta: room.meta.clone(),
        }
    }

    fn pw_attempt_allowed(
        g: &mut HubInner,
        room_id: RoomId,
        user_id: UserId,
        now: Now,
        max: u32,
    ) -> bool {
        let win = Duration::from_secs(60);
        let q = g.pw_attempts.entry((room_id, user_id)).or_default();
        while q
            .front()
            .is_some_and(|t| now.instant.saturating_duration_since(*t) > win)
        {
            q.pop_front();
        }
        (q.len() as u32) < max
    }

    fn pw_record_failure(g: &mut HubInner, room_id: RoomId, user_id: UserId, now: Now) {
        g.pw_attempts
            .entry((room_id, user_id))
            .or_default()
            .push_back(now.instant);
    }

    /// 6 位数字房间号（"数字暗号"），冲突重试；熵源 = 时间纳秒 + 连接计数
    fn gen_room_id(&self, g: &HubInner) -> RoomId {
        for salt in 0..64u32 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
                .unwrap_or(0);
            let mut x = nanos
                ^ (self.next_conn.load(Ordering::Relaxed) << 20)
                ^ (salt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
            x ^= x >> 33;
            x = x.wrapping_mul(0xD1B5_4A32_D192_ED03);
            x ^= x >> 29;
            let id = 100_000 + (x % 900_000) as RoomId;
            if !g.rooms.contains_key(&id) {
                return id;
            }
        }
        // 极端情况下退化：上限 100 房间，线性探测必有空位
        (100_000..1_000_000)
            .find(|id| !g.rooms.contains_key(id))
            .expect("room id space larger than max_rooms_total")
    }
}

/// 成员列表输出（排序保证稳定）
fn member_list(room: &Room) -> Vec<UserId> {
    let mut v: Vec<UserId> = room.members.keys().copied().collect();
    v.sort_unstable();
    v
}

/// 常量时间字节比较（密码防时序侧信道）
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 清洗可选文本字段：trim、空转 None、超长拒绝
fn clean_field(
    raw: Option<&str>,
    max: usize,
    err: &'static str,
) -> Result<Option<String>, CreateRoomError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if s.len() > max => Err(CreateRoomError::BadInput(err)),
        Some(s) => Ok(Some(s.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ws::models::QrMsgOut;
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

    const SECRET_PW: &str = "1234";
    const URL: &str = "https://www.yuketang.cn/c/abc";

    fn base() -> (Instant, u64) {
        (Instant::now(), 1_730_000_000_000)
    }

    fn now_at(t: Instant, ms: u64) -> Now {
        Now::at(t, ms)
    }

    struct TestConn {
        id: ConnId,
        _outbox: UnboundedReceiver<Outbound>,
        close_rx: UnboundedReceiver<u16>,
        _close_tx: UnboundedSender<u16>,
    }

    fn mk_conn(hub: &Hub, user: UserId, t: Instant, ms: u64) -> TestConn {
        let (tx, rx) = mpsc::unbounded_channel();
        let (ctx, crx) = mpsc::unbounded_channel::<u16>();
        let id = hub.register(user, tx, ctx.clone(), now_at(t, ms));
        TestConn {
            id,
            _outbox: rx,
            close_rx: crx,
            _close_tx: ctx,
        }
    }

    fn joined_payload(msg: &ServerMsg) -> (RoomId, UserId, Vec<UserId>, Vec<QrMsgOut>) {
        match msg {
            ServerMsg::Joined {
                room,
                owner,
                members,
                messages,
                ..
            } => (*room, *owner, members.clone(), messages.clone()),
            other => panic!("expected Joined, got {other:?}"),
        }
    }

    // ---- 建房 ----

    #[test]
    fn create_room_defaults_and_joinable() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let owner = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(
                1,
                CreateRoomSpec {
                    name: Some(" 一节课 ".into()),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        assert_ne!(id, 0);
        assert!((100_000..1_000_000).contains(&id));
        // 默认 4h 生命周期内可加入
        let r = hub.join(owner.id, id, None, now_at(t, ms));
        match r {
            JoinResult::Joined(msg) => {
                let (_, o, members, _) = joined_payload(&msg);
                assert_eq!(o, 1);
                assert_eq!(members, vec![1]);
            }
            other => panic!("join failed: {other:?}"),
        }
        // 广场含该房间，名字已 trim
        let plaza = hub.plaza();
        assert_eq!(plaza.len(), 1);
        assert_eq!(plaza[0].name.as_deref(), Some("一节课"));
    }

    #[test]
    fn create_room_enforces_total_and_per_user_limits() {
        let limits = Limits {
            max_rooms_total: 2,
            max_rooms_per_user: 1,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let ok1 = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        assert!(
            hub.create_room(1, CreateRoomSpec::default(), now_at(t, ms))
                .is_err()
        );
        // 第二个用户可建第二间（全局 2 上限内）
        let ok2 = hub
            .create_room(2, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        assert_eq!(
            hub.create_room(3, CreateRoomSpec::default(), now_at(t, ms)),
            Err(CreateRoomError::TotalLimit)
        );
        assert_eq!(hub.close_room(1, ok1), Ok(()));
        assert!(
            hub.create_room(3, CreateRoomSpec::default(), now_at(t, ms))
                .is_ok()
        );
        let _ = ok2;
    }

    #[test]
    fn qr_ttl_clamped_into_range() {
        let limits = Limits {
            qr_ttl_max_secs: 3600,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id_big = hub
            .create_room(
                1,
                CreateRoomSpec {
                    qr_ttl_secs: Some(99_999),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        let id_zero = hub
            .create_room(
                1,
                CreateRoomSpec {
                    qr_ttl_secs: Some(0),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        // 上限：3600s 后过期；下限：1s 后过期
        hub.join(a.id, id_big, None, now_at(t, ms));
        let msg = hub.share_qr(a.id, URL, now_at(t, ms)).unwrap();
        match msg {
            ServerMsg::QrUpdate { expire_at, .. } => {
                assert_eq!(expire_at, ms + 3_600_000)
            }
            other => panic!("{other:?}"),
        }
        hub.join(a.id, id_zero, None, now_at(t, ms));
        let msg = hub.share_qr(a.id, URL, now_at(t, ms)).unwrap();
        match msg {
            ServerMsg::QrUpdate { expire_at, .. } => assert_eq!(expire_at, ms + 1_000),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn lifetime_and_permanent_options() {
        let limits = Limits {
            room_default_lifetime_secs: 4 * 60 * 60,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let custom = hub
            .create_room(
                1,
                CreateRoomSpec {
                    lifetime_mins: Some(30),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        let permanent = hub
            .create_room(
                1,
                CreateRoomSpec {
                    permanent: true,
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        // 30 分钟后：自定义房过期、永久房仍在
        let later = now_at(t + Duration::from_secs(30 * 60 + 1), ms + 30 * 60 * 1000);
        let out = hub.sweep(later);
        assert!(out.removed_rooms.contains(&custom));
        assert!(!out.removed_rooms.contains(&permanent));
        // 永久房在 14 天无消息后回收
        let far = now_at(t + Duration::from_secs(14 * 24 * 3600 + 1), ms);
        let out = hub.sweep(far);
        assert!(out.removed_rooms.contains(&permanent));
    }

    #[test]
    fn meta_fields_cleaned_and_rejected() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let bad = hub.create_room(
            1,
            CreateRoomSpec {
                meta: Some(RoomMeta {
                    course_name: Some("x".repeat(65)),
                    ..Default::default()
                }),
                ..Default::default()
            },
            now_at(t, ms),
        );
        assert_eq!(bad, Err(CreateRoomError::BadInput("课程名过长（>64）")));
    }

    // ---- 加入 ----

    #[test]
    fn join_missing_room_is_40404() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        match hub.join(a.id, 999_999, None, now_at(t, ms)) {
            JoinResult::Failed(e) => assert_eq!(e.code, error_code::ROOM_NOT_FOUND),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn join_full_room_is_rejected() {
        let limits = Limits {
            max_members_per_room: 1,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        assert!(matches!(
            hub.join(a.id, id, None, now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        match hub.join(b.id, id, None, now_at(t, ms)) {
            JoinResult::Failed(e) => assert_eq!(e.code, error_code::ROOM_FULL),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn password_flow_need_wrong_then_right() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let owner = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(
                1,
                CreateRoomSpec {
                    password: Some(SECRET_PW.into()),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        // 密码房间不进广场
        assert!(hub.plaza().is_empty());
        // 房主持密码先加入
        assert!(matches!(
            hub.join(owner.id, id, Some(SECRET_PW), now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        // 无密码 → NeedPassword
        assert!(matches!(
            hub.join(b.id, id, None, now_at(t, ms)),
            JoinResult::NeedPassword
        ));
        // 错密码
        match hub.join(b.id, id, Some("0000"), now_at(t, ms)) {
            JoinResult::Failed(e) => assert_eq!(e.code, error_code::WRONG_PASSWORD),
            other => panic!("{other:?}"),
        }
        // 对密码
        match hub.join(b.id, id, Some(SECRET_PW), now_at(t, ms)) {
            JoinResult::Joined(msg) => {
                let (_, _, members, _) = joined_payload(&msg);
                assert_eq!(members, vec![1, 2]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn password_attempts_rate_limited() {
        let limits = Limits {
            pw_attempts_per_min: 3,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let owner = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(
                1,
                CreateRoomSpec {
                    password: Some(SECRET_PW.into()),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        assert!(matches!(
            hub.join(owner.id, id, Some(SECRET_PW), now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        for _ in 0..3 {
            assert!(matches!(
                hub.join(b.id, id, Some("bad"), now_at(t, ms)),
                JoinResult::Failed(e) if e.code == error_code::WRONG_PASSWORD
            ));
        }
        // 即使密码正确也被限速
        match hub.join(b.id, id, Some(SECRET_PW), now_at(t, ms)) {
            JoinResult::Failed(e) => assert_eq!(e.code, error_code::PASSWORD_RATE_LIMITED),
            other => panic!("{other:?}"),
        }
        // 60s 窗口滑出后恢复；房主仍在房间内可正常使用
        let later = now_at(t + Duration::from_secs(61), ms + 61_000);
        assert!(matches!(
            hub.join(b.id, id, Some(SECRET_PW), later),
            JoinResult::Joined(_)
        ));
    }

    #[test]
    fn join_broadcasts_member_join_and_updates_plaza() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let owner = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        assert!(matches!(
            hub.join(owner.id, id, None, now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        let mut room_rx = hub.subscribe_room(id).unwrap();
        assert!(matches!(
            hub.join(b.id, id, None, now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        match room_rx.try_recv().unwrap() {
            ServerMsg::MemberJoin { members, .. } => assert_eq!(members, vec![1, 2]),
            other => panic!("{other:?}"),
        }
        // lobby 广播收到 plaza_update（人数变化）
        let mut lobby_rx = hub.subscribe_lobby();
        hub.broadcast_plaza();
        match lobby_rx.try_recv().unwrap() {
            ServerMsg::PlazaUpdate { rooms } => assert_eq!(rooms[0].members, 2),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn join_switches_room_and_rejoin_is_idempotent() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let r1 = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        let r2 = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        let mut room1_rx = hub.subscribe_room(r1).unwrap();
        hub.join(a.id, r1, None, now_at(t, ms));
        hub.join(b.id, r1, None, now_at(t, ms));
        hub.join(b.id, r2, None, now_at(t, ms));
        // 房 1 收到 b 离开
        let mut saw_leave = false;
        while let Ok(m) = room1_rx.try_recv() {
            if let ServerMsg::MemberLeave { members, .. } = m {
                assert_eq!(members, vec![1]);
                saw_leave = true;
            }
        }
        assert!(saw_leave);
        // 重复 join 同房间：Joined 幂等，不产生新的 MemberJoin
        let mut room2_rx = hub.subscribe_room(r2).unwrap();
        while room2_rx.try_recv().is_ok() {}
        assert!(matches!(
            hub.join(b.id, r2, None, now_at(t, ms)),
            JoinResult::Joined(_)
        ));
        assert!(room2_rx.try_recv().is_err());
    }

    // ---- 分享 ----

    #[test]
    fn share_qr_broadcasts_and_replays_history() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        let mut room_rx = hub.subscribe_room(id).unwrap();
        let msg = hub.share_qr(a.id, URL, now_at(t, ms)).unwrap();
        match msg {
            ServerMsg::QrUpdate {
                room,
                raw,
                by,
                expire_at,
            } => {
                assert_eq!((room, raw.as_str(), by), (id, URL, 1));
                assert_eq!(expire_at, ms + 3_600_000);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            room_rx.try_recv().unwrap(),
            ServerMsg::QrUpdate { .. }
        ));

        // 新成员加入收到未过期历史消息
        let b = mk_conn(&hub, 2, t, ms);
        match hub.join(
            b.id,
            id,
            None,
            now_at(t + Duration::from_secs(10), ms + 10_000),
        ) {
            JoinResult::Joined(m) => {
                let (_, _, _, msgs) = joined_payload(&m);
                assert_eq!(msgs.len(), 1);
                assert_eq!(msgs[0].raw, URL);
                assert_eq!(msgs[0].by, 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn expired_messages_hidden_and_evicted_lazily() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        hub.share_qr(a.id, "https://www.yuketang.cn/c/old", now_at(t, ms))
            .unwrap();
        // 2h 后消息早已过期（qr_ttl 1h）：新成员 joined.messages 为空
        let b = mk_conn(&hub, 2, t, ms);
        let later = now_at(t + Duration::from_secs(2 * 3600), ms + 2 * 3_600_000);
        match hub.join(b.id, id, None, later) {
            JoinResult::Joined(m) => {
                let (_, _, _, msgs) = joined_payload(&m);
                assert!(msgs.is_empty());
            }
            other => panic!("{other:?}"),
        }
        // 过期项在下次入队时被惰性清除
        hub.join(a.id, id, None, later);
        hub.share_qr(a.id, URL, later).unwrap();
        // 建第二间房验证 FIFO 容量淘汰
        let limits = Limits {
            max_msgs_per_room: 3,
            ..Default::default()
        };
        let hub2 = Hub::new(limits);
        let a2 = mk_conn(&hub2, 1, t, ms);
        let id2 = hub2
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub2.join(a2.id, id2, None, now_at(t, ms));
        for i in 0..5u32 {
            let url = format!("https://www.yuketang.cn/c/{i}");
            hub2.share_qr(a2.id, &url, now_at(t + Duration::from_secs(i as u64), ms))
                .unwrap();
        }
        let c2 = mk_conn(&hub2, 2, t, ms);
        match hub2.join(c2.id, id2, None, now_at(t, ms)) {
            JoinResult::Joined(m) => {
                let (_, _, _, msgs) = joined_payload(&m);
                let raws: Vec<&str> = msgs.iter().map(|m| m.raw.as_str()).collect();
                assert_eq!(
                    raws,
                    [
                        "https://www.yuketang.cn/c/2",
                        "https://www.yuketang.cn/c/3",
                        "https://www.yuketang.cn/c/4"
                    ]
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn share_qr_requires_membership_and_size_limit() {
        let limits = Limits {
            max_msg_bytes: 32,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        // 未加入房间
        match hub.share_qr(a.id, URL, now_at(t, ms)) {
            Err(e) => assert_eq!(e.code, error_code::NOT_IN_ROOM),
            Ok(m) => panic!("{m:?}"),
        }
        hub.join(a.id, id, None, now_at(t, ms));
        // 超长
        match hub.share_qr(a.id, &"x".repeat(33), now_at(t, ms)) {
            Err(e) => assert_eq!(e.code, error_code::MSG_TOO_LARGE),
            Ok(m) => panic!("{m:?}"),
        }
    }

    #[test]
    fn sign_result_broadcasts_to_room() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        let mut room_rx = hub.subscribe_room(id).unwrap();
        hub.sign_result(a.id, true, None).unwrap();
        match room_rx.try_recv().unwrap() {
            ServerMsg::SignResult { by, ok, .. } => {
                assert_eq!((by, ok), (1, true));
            }
            other => panic!("{other:?}"),
        }
        // lobby 中无法上报回执
        let b = mk_conn(&hub, 2, t, ms);
        assert!(hub.sign_result(b.id, true, None).is_err());
    }

    // ---- 离开 / 断线 / 替代 ----

    #[test]
    fn leave_removes_member_and_broadcasts() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        hub.join(b.id, id, None, now_at(t, ms));
        let mut room_rx = hub.subscribe_room(id).unwrap();
        hub.leave(b.id);
        let mut saw_leave = false;
        while let Ok(m) = room_rx.try_recv() {
            if let ServerMsg::MemberLeave { members, .. } = m {
                assert_eq!(members, vec![1]);
                saw_leave = true;
            }
        }
        assert!(saw_leave);
        let plaza = hub.plaza();
        assert_eq!(plaza[0].members, 1);
    }

    #[test]
    fn unregister_keeps_room_alive_without_owner_wechat_style() {
        // 房主断线不解散房间（docs/DESIGN.md §4.4 类微信策略）
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        hub.unregister(a.id);
        assert_eq!(hub.plaza().len(), 1); // 房间仍在（空置）
        let b = mk_conn(&hub, 2, t, ms);
        match hub.join(b.id, id, None, now_at(t, ms)) {
            JoinResult::Joined(m) => {
                let (_, owner, members, _) = joined_payload(&m);
                assert_eq!(owner, 1); // 房主身份保留
                assert_eq!(members, vec![2]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn register_replaces_previous_connection_with_4009() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let mut first = mk_conn(&hub, 1, t, ms);
        let _second = mk_conn(&hub, 1, t, ms);
        // 旧连接收到 close 4009
        let code = first
            .close_rx
            .try_recv()
            .expect("close code sent to old conn");
        assert_eq!(code, CLOSE_REPLACED);
        assert_eq!(hub.conn_count(), 2); // 旧连接待其任务退出后 unregister
    }

    #[test]
    fn close_room_owner_only_and_members_notified() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        hub.join(b.id, id, None, now_at(t, ms));
        // 非房主
        assert_eq!(hub.close_room(2, id), Err(CloseRoomError::NotOwner));
        let mut room_rx = hub.subscribe_room(id).unwrap();
        assert_eq!(hub.close_room(1, id), Ok(()));
        match room_rx.try_recv().unwrap() {
            ServerMsg::Error { code, .. } => assert_eq!(code, error_code::ROOM_NOT_FOUND),
            other => panic!("{other:?}"),
        }
        assert!(hub.plaza().is_empty());
        assert!(matches!(
            hub.join(b.id, id, None, now_at(t, ms)),
            JoinResult::Failed(_)
        ));
    }

    // ---- 限速 ----

    #[test]
    fn admit_rate_limit_sliding_window() {
        let limits = Limits {
            msgs_per_min: 3,
            ..Default::default()
        };
        let hub = Hub::new(limits);
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        for i in 0..3u64 {
            assert!(
                hub.admit(a.id, now_at(t + Duration::from_secs(i), ms)),
                "msg {i}"
            );
        }
        assert!(!hub.admit(a.id, now_at(t + Duration::from_secs(3), ms)));
        // 窗口滑出后恢复
        assert!(hub.admit(a.id, now_at(t + Duration::from_secs(61), ms + 61_000)));
        // 未注册连接一律拒绝
        assert!(!hub.admit(999_999, now_at(t, ms)));
    }

    // ---- sweep ----

    #[test]
    fn sweep_detects_dead_connection_and_removes_member() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let mut b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(1, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        hub.join(b.id, id, None, now_at(t, ms));
        // b 心跳续活，a 假死
        let later = now_at(t + Duration::from_secs(61), ms + 61_000);
        hub.touch(b.id, later);
        let out = hub.sweep(later);
        assert_eq!(out.closed_conns, vec![(a.id, CLOSE_IDLE)]);
        assert!(b.close_rx.try_recv().is_err()); // 活连接不受影响
        let plaza = hub.plaza();
        assert_eq!(plaza[0].members, 1);
    }

    #[test]
    fn sweep_recycles_idle_lobby_connection() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        // lobby 空闲 10min+1s → close 4000
        let later = now_at(t + Duration::from_secs(601), ms + 601_000);
        let out = hub.sweep(later);
        assert_eq!(out.closed_conns, vec![(a.id, CLOSE_IDLE)]);
        // 房间内连接不受 lobby idle 约束
        let b = mk_conn(&hub, 2, t, ms);
        let id = hub
            .create_room(2, CreateRoomSpec::default(), now_at(t, ms))
            .unwrap();
        hub.join(b.id, id, None, now_at(t, ms));
        let later2 = now_at(t + Duration::from_secs(601), ms + 601_000);
        hub.touch(b.id, now_at(t + Duration::from_secs(600), ms)); // 心跳续活
        let out = hub.sweep(later2);
        assert!(out.closed_conns.is_empty());
    }

    #[test]
    fn sweep_removes_rooms_after_14d_inactivity_even_if_lifetime_unexpired() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        // 自定义生命周期 7 天，但 14 天无消息同样回收
        let id = hub
            .create_room(
                1,
                CreateRoomSpec {
                    lifetime_mins: Some(7 * 24 * 60),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        let far = now_at(t + Duration::from_secs(14 * 24 * 3600 + 1), ms);
        let out = hub.sweep(far);
        assert_eq!(out.removed_rooms, vec![id]);
        // 空闲 14 天的连接早被 sweep 判死移除（heartbeat_dead_after=60s）
        assert_eq!(hub.conn_count(), 0);
        assert!(hub.plaza().is_empty());
    }

    #[test]
    fn sweep_active_permanent_room_survives() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let a = mk_conn(&hub, 1, t, ms);
        let id = hub
            .create_room(
                1,
                CreateRoomSpec {
                    permanent: true,
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        hub.join(a.id, id, None, now_at(t, ms));
        // 每天活跃一次，13 天后房间仍在
        for day in 1..=13u64 {
            let at = now_at(t + Duration::from_secs(day * 24 * 3600), ms);
            hub.touch(a.id, at);
            hub.leave(a.id);
            hub.join(a.id, id, None, at);
            hub.share_qr(a.id, URL, at).unwrap();
        }
        let out = hub.sweep(now_at(t + Duration::from_secs(13 * 24 * 3600 + 1), ms));
        assert!(out.removed_rooms.is_empty());
        assert_eq!(hub.plaza().len(), 1);
    }

    #[test]
    fn plaza_excludes_password_rooms_always() {
        let hub = Hub::new(Limits::default());
        let (t, ms) = base();
        let _pub = hub
            .create_room(
                1,
                CreateRoomSpec {
                    name: Some("公开".into()),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        let _priv = hub
            .create_room(
                1,
                CreateRoomSpec {
                    password: Some("pw".into()),
                    ..Default::default()
                },
                now_at(t, ms),
            )
            .unwrap();
        let list = hub.plaza();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name.as_deref(), Some("公开"));
    }

    // ---- 工具 ----

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
    }
}
