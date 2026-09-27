# 雨课堂签到助手 技术设计（DESIGN）

> 版本：v0.1.0
> 日期：2026-09-27
> 对应需求：[SPEC.md](./SPEC.md)
> 接口细节来源：`course_helper/lib/api/`（源码分析确认）

---

## 1. 技术栈（已确定）

| 层 | 选型 |
|----|------|
| 后端 | Rust + `axum`（自带 WS）+ `tokio` |
| HTTP 客户端 | `reqwest`（`cookies` + `json`，管理雨课堂会话） |
| 中间件 | `tower-http`（CORS/Trace/Timeout） |
| 日志 | `tracing` + `tracing-subscriber` |
| 会话 | 签名 cookie（`axum-extra` `PrivateCookieJar`，HMAC 防篡改，14 天滑动续期；校验只验签名，无服务端状态） |
| 错误 | `thiserror` + `anyhow` |
| 前端 | Vite `react-ts` + `react-router` + `zustand` + TailwindCSS；包管理器 **pnpm** |
| 扫码 | 相机与图片统一：`BarcodeDetector` 特性检测 → 降级 `jsQR`（均在浏览器本地解码，图片不上传服务器）；微信内走 JS-SDK。（曾用 `@zxing/browser` 兜底，实测对整数倍缩放的二维码漏检，已移除） |
| WS 客户端 | 原生 WebSocket 封装（心跳、指数退避重连、房间状态机） |
| 部署 | Docker Compose：`nginx:stable-alpine`（静态 + 反代 + gzip）+ axum 多阶段构建镜像；对外只暴露 80，TLS 交前置反代终结 |
| 存储 | **无数据库、无 Redis**。站点登录态 = 签名 cookie（无服务端存储）；雨课堂凭证、房间、二维码内容、WS 状态全内存，服务重启需重新登录（已接受的取舍） |

本项目在 **2 核 2G** 的机器上开发与验证（该规格是开发环境，不是部署要求）：实测 Nginx ~10MB + axum ~50–80MB + WS 状态 <20MB，占用很低。

---

## 2. 总体架构

```
                ┌──────────────────────────────────────┐
  浏览器 ──HTTP──▶ Nginx (容器)                          │
                │   ├── /        → 前端静态资源          │
                │   ├── /api/*   → axum :3000 (REST)    │
                │   └── /ws      → axum :3000 (WS升级)  │
                └──────────────┬───────────────────────┘
                               ▼
                  Rust 后端 (axum, 容器)
                   ├── auth        登录代理、雨课堂会话管理
                   ├── courses     正在上课的课程（F5 透传）
                   ├── signin      二维码校验/解析 → 调雨课堂签到
                   ├── ws_hub      房间管理、广播、心跳
                   ├── plaza       公开房间的列表与事件推送
                   └── config      雨课堂域名白名单等
                         │
                         ▼
                    雨课堂服务端（外部接口）
```

- Nginx 提供前端静态资源与 `/api`、`/ws` 反代；对外只暴露 80，**TLS 由前置反代终结**；`/ws` 反代需透传 `Upgrade`/`Connection` 头并调大读超时；
- 后端按上述模块划分 crate 内 module，不拆 workspace（规模不需要）。

---

## 3. REST API 设计

统一响应信封：`{ "code": 0, "msg": "ok", "data": ... }`；非 0 为业务错误码（如 `40101` 会话过期 → 前端跳登录）。

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/health` | 健康检查（compose healthcheck 用） |
| POST | `/api/auth/login` | `{phone, password, ticket, rand}` → 代理雨课堂 `POST /api/v3/user/login/app (type=2)`，建立本站会话；ticket/rand 由前端腾讯验证码组件获取（AppId `2091064951`，已实测必需） |
| POST | `/api/auth/sms/send` | `{phone, ticket, rand}` → 透传雨课堂 `POST /api/v3/user/code/send`（已实测：空票据被拒，必须有效票据） |
| POST | `/api/auth/sms/verify` | `{phone, code}` → 透传 `POST /api/v3/user/code/verify` + 登录，建立本站会话 |
| GET | `/api/auth/qrcode` | 透传 `GET /api/v3/user/login/pre-info` → `{qr_image, token}`（qrImage 为雨课堂生成的二维码，前端直接展示） |
| GET | `/api/auth/qrcode/poll?token=` | 服务端透传 `POST /api/v3/user/login`（30s 长轮询），返回登录结果/待扫码/超时（50001 → 前端刷新二维码） |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前登录态/用户信息（透传 `GET /v/course_meta/user_info`） |
| GET | `/api/courses` | 正在上课的课程（F5，`on-lesson` ∩ `learning_list`） |
| POST | `/api/sign/submit` | 提交二维码 URL（校验 → `scan` → `checkin`，见 §5） |
| GET | `/api/wechat/status` | 微信公众号是否已配置（免会话）：`{available, reason}`，不含凭证；前端据此决定是否展示微信内扫码入口 |
| GET | `/api/wechat/jssdk-signature?url=` | JS-SDK 签名（M5） |
| POST | `/api/rooms` | 创建房间：`{name, password?, qr_ttl_secs?(≤3600), lifetime_mins?, permanent?, meta?{course_name?, location?, teacher?, time?, class_name?}}` → `{room_id}`；`name` 必填（空名 40306），`lifetime_mins` 与 `permanent` 均缺省时默认 4 小时 |
| DELETE | `/api/rooms/:id` | 房主关闭房间 |
| GET | `/api/plaza` | 广场列表：仅无密码房间 `{room_id, name, members, created_at, meta?}` |

鉴权：除 `/api/health`、`/api/wechat/status` 与登录流程本身的接口（`/api/auth/login`、`/api/auth/sms/send`、`/api/auth/sms/verify`、`/api/auth/qrcode`、`/api/auth/qrcode/poll`）外，均需本站会话（cookie）。

---

## 4. WebSocket 协议

连接：`ws://<host>/ws`（前置反代终结 TLS 后即为 `wss://`），**握手时必须携带本站会话 cookie**，服务端在 upgrade 前校验，未登录直接拒绝（HTTP 401）。

信封格式（JSON，UTF-8 文本帧）：

```json
{
  "type": "join | joined | join_need_password | leave | share_qr | qr_update | member_join | member_leave | sign_result | plaza_update | error | heartbeat",
  "room": "room_id",
  "seq": 12,
  "payload": {},
  "ts": 1730000000000
}
```

### 4.1 加入房间（含密码流程）

```
C→S join { room, password? }
S→C joined { room, members[], messages[], meta? }  # 成功：全量成员 + 未过期历史消息 + 房间关联信息
S→C join_need_password { room }                    # 房间有密码且未带密码
C→S join { room, password }                        # 重试
S→C error { code, msg }                            # 密码错误(限速)、房间不存在/已关闭等
```

- 密码校验在服务端：常量时间比较，失败按 `(room, user)` 限速（如 5 次/分钟），防爆破；
- 房间密码与成员列表仅存内存，不写日志。

### 4.2 扫码分享（含消息有效期）

```
C→S share_qr { room, raw }                 # 扫码者推送二维码 URL（服务端先校验，见 §5）
S→C qr_update { room, raw, by, expire_at } # 广播给房间内全部成员；expire_at = now + 房间 qr_ttl（默认 3600s）
C→S sign_result { room, ok, reason? }      # 成员签到回执
S→C member_join/member_leave { room, members[] }   # 全量成员列表同步（简单可靠）
```

- **消息队列**：每频道一个 FIFO 队列，上限 **100 条**（本质为 URL，内存可接受）：
  - **入队时惰性淘汰**：push 前先从队头弹出已过期消息（消息按时间入队天然有序，队头必最旧，均摊 O(1)），再检查容量，超过 100 条删除最旧；
  - **不引入定时清理任务**：100 条上限已给出确定内存上界，定时扫描只省几十 KB 却增加锁竞争与代码路径；
  - 新加入/重连成员收到的 `joined.messages` 仅含未过期消息（每条带 `expire_at` 供前端倒计时）；
- `qr_ttl_secs` 由房主创建时设定，服务端钳制在 `[1, 3600]` 秒；
- `qr_update` **也回显给发送者**（前端按 `raw + expire_at` 去重）：签到协作场景下发送者本人同样要在消息流里看到自己分享的码。

### 4.3 广场（F4）

- 未加入任何房间的 WS 连接处于 "lobby" 态；
- 服务端房间增删/人数变化时向 lobby 连接广播 `plaza_update { rooms[] }`（全量列表；公开房间数少，全量最简单且无一致性问题）；
- 前端广场页 = 首次 `GET /api/plaza` + WS `plaza_update` 覆盖（进入广场页时按需建连）；WS 未连上时仅展示 REST 结果，加入动作触发重连；
- 密码房间不进入 `plaza_update` 列表，任何接口不可枚举。

### 4.4 连接管理

- **心跳保活（客户端 30s pong）**：服务端每 30s 发 `heartbeat`，客户端必须回 pong；连续两次（60s）未应答判定假死，服务端剔除连接并更新房间成员列表；
- **单客户端单连接**：一个用户（浏览器）只维持一条 WebSocket：
  - 多标签页通过 `SharedWorker` 复用同一条连接（不支持时降级 `BroadcastChannel` + localStorage 选举主标签页持有连接）；
  - 服务端下发的消息由持有连接的一端分发给所有标签页（BroadcastChannel 转发）；
  - 重连统一由连接持有者负责（指数退避 1s→2s→4s…上限 30s），避免多标签页各自重连造成连接风暴；
  - 重连成功后重新 `join`，服务端回 `joined` 全量补齐（成员 + 未过期历史消息）；恢复期间收到 `error 40404`（房间已关闭/不存在）则放弃恢复、回到 lobby 等待用户操作；
- **空闲回收（防"空置"）**：
  - lobby（未加入任何房间）连接闲置 **10 分钟**由服务端主动断开（close code 4000 = idle），用户回到广场页时再重连；
  - 房间内连接随房间生命周期存活；
  - 全局连接数上限（如 500），超限拒绝新连接并提示；
- **房主策略（类微信）**：房主退出/断线**不解散房间**，房主身份保留，重连后自动恢复；房间关闭仅由房主主动 `DELETE /api/rooms/:id` 或生命周期到期触发；
- 房间生命周期：默认 4 小时；房主可自定义（精确到分钟）或设为永久；**任何房间连续 14 天无消息自动删除**（永久房间同样受约束），定时器扫描回收。

---

## 5. 扫码内容安全校验（重点设计）

旧项目已确认二维码内容是 **URL**。处理流程固定为：

```
raw 内容
  │
  ├─ ① 长度/字符过滤（≤ 2048 字节，仅允许 URL 安全字符）
  │
  ├─ ② 解析 URL：scheme 必须为 https；host 必须命中域名白名单（禁止 IP 字面量、
  │     user-info、白名单外端口）
  │
  ├─ ③ POST /api/v3/app/scan {"url": raw} → 取 data.value 即 lessonId
  │
  └─ ④ POST /api/v3/lesson/checkin {"source":21, "lessonId":..., "joinIfNotIn":true}
        错误码 51203 → "动态二维码过期"；成功时保存 set-auth 头的 bearerToken
```

- **域名白名单**：固化自 `course_helper/lib/api/api_service.dart` 的 `serverBaseUrlMap`（`www.yuketang.cn`、`pro.yuketang.cn`、`changjiang.yuketang.cn`、`huanghe.yuketang.cn` 等，实施时以源码为准逐一核对），配置化（环境变量/配置文件）；
- **任何未通过校验的内容：直接返回业务错误，绝不发起任何出站请求**（SSRF 与钓鱼转发防线）；
- 请求头按旧项目携带 `xtbz: ykt`、`x-client: app` 等；cookie 会话附 `x-csrftoken` / `x-uid` / `sessionid`（见 `api_service.dart`、`session/cookie.dart`）；
- 前端仅负责采集与展示，不自行请求二维码内的 URL。
- 图片上传识别：上传的二维码截图由前端本地解码（`BarcodeDetector` 优先、`jsQR` 降级，见 SPEC.md §3.2.2），图片不离开浏览器、不上传服务器（单图 ≤ 5MB；超大图先等比缩到 ≤ 2048px 再解码）；识别出的 URL 仍走本节统一校验与签到流程。

---

## 6. 后端模块与关键类型

```
backend/src/
├── main.rs           # 路由组装、日志双通道（stdout + 按天滚动文件）、启动
├── config.rs         # 环境变量、雨课堂域名白名单、会话 TTL、验证码 CaptchaAppId（2091064951）、Limits
├── error.rs          # AppError + 业务错误码（含雨课堂 51203 映射）
├── auth/             # routes（密码/短信/扫码登录 + me/logout）、token（签名 cookie）、yk_client（雨课堂客户端）
├── courses/          # F5：on-lesson ∩ learning_list 透传
├── signin/           # validate（二维码校验 §5）、client_ext、routes（scan+checkin 流程）
├── wechat/           # client（access_token/jsapi_ticket 缓存）、routes（status + jssdk-signature）
└── ws/               # hub（房间状态机）、routes（/ws + 房间/广场 REST）、models（Room/RoomMeta/消息类型）
```

关键类型（节选）：

```rust
struct RoomMeta {          // 房间关联信息（全部可选）
    course_name: Option<String>,
    location:    Option<String>,
    teacher:     Option<String>,
    time:        Option<String>,
    class_name:  Option<String>,
}

struct Room {
    id: RoomId,
    name: Option<String>,
    owner: UserId,
    password: Option<String>,   // 明文 + 常量时间比较 + 失败限速（内存态、短生命周期，不引入哈希库）
    meta: Option<RoomMeta>,
    qr_ttl: Duration,           // 单条消息生命周期，钳制 (0, 3600s]
    messages: VecDeque<QrMsg>,  // FIFO ≤ 100 条；入队时惰性淘汰队头过期项，每条含 expire_at
    last_activity: Instant,     // 最后一条消息时间，用于 14 天无消息自动删除
    members: HashMap<UserId, MemberHandle>,
    tx: broadcast::Sender<Msg>, // 房间广播通道
    created_at: Instant,
    custom_expires_at: Option<Instant>, // 房主自定义生命周期；None = 永久
    // 实际过期 = min(custom_expires_at, last_activity + 14 天)
}

struct YkSession {              // 每用户一份，仅内存
    cookies: CookieJar,         // csrftoken / sessionid / x-uid
    bearer: Option<String>,     // checkin 后的 set-auth token
    user_id: i64,
}
```

- 全局共享状态 `Arc<Hub>`；房间表/连接表用 `std::sync::Mutex` 保护（临界区内不跨 await）；每房间一个 `tokio::sync::broadcast` channel（**有界容量**，如 64，满则丢弃最旧）；
- **资源上限（防 OOM，全部来自 config，可调）**：

```rust
struct Limits {
    max_rooms_total:  usize,  // 全局房间数上限，默认 100
    max_rooms_per_user: usize, // 每用户同时建房数，默认 5
    max_members_per_room: usize, // 单房间人数上限，默认 50
    max_msg_bytes:    usize,  // 单条消息上限，默认 2048
    msgs_per_min:     u32,    // 单连接消息频率上限，默认 30，超限 close(4008)
    max_msgs_per_room: usize, // 每频道消息队列上限（FIFO），默认 100
    qr_ttl_max_secs:  u64,    // 单条消息有效期上限，默认 3600（配置只允许调小）
    room_inactivity_ttl: Duration, // 无消息自动删除阈值，默认 14 天
    max_connections:  usize,  // 全局 WS 连接上限，默认 500
    heartbeat_interval_secs: u64,    // 服务端心跳周期，默认 30
    heartbeat_dead_after_secs: u64,  // 超时未收到任何消息判死，默认 60
    lobby_idle_secs: u64,     // lobby 空闲回收，默认 600，close 4000
    room_default_lifetime_secs: u64, // 房间默认生命周期，默认 4h
    pw_attempts_per_min: u32, // 房间密码错误尝试上限，默认 5
}
```

- 建房/加房/收消息路径上逐项检查；历史消息全保留但有界（每频道 FIFO ≤ 100 条），广播 channel 有界 → 内存占用有确定上界：`100 房间 × 100 条 × ~0.5KB ≈ 5MB` 最坏情况，占用可忽略。
- 会话：签名 cookie（`user_id` + `exp` + HMAC），14 天滑动续期；登出即清除 cookie。

### 6.1 凭证与会话（无数据库）

- **本站登录态**：签名 cookie 携带 `user_id + exp`，HMAC（`SERVER_SECRET`）校验，**14 天滑动续期**（与雨课堂 `sessionid` 已确认的 14 天有效期对齐，登录期内两边凭证同时有效）；每次请求只验签名，零存储、零查询；服务重启登录态不丢；
- **雨课堂凭证**：`HashMap<UserId, YkSession>` 内存态（登录时写入），不落盘 → 服务重启后所有用户需重新完成雨课堂登录（已接受的取舍，换来零存储依赖）；
- **雨课堂会话过期**：惰性检测——请求失败/返回失效码 → 标记该用户 `YkSession` 失效 → 前端引导重新登录；
- 雨课堂 cookie 字段（源自 `session/cookie.dart`）：`csrftoken`（头 `x-csrftoken`）、`sessionid`（头 `sessionid`）、`x-uid`（头，userId）。**已抓包确认**：`sessionid` 有效期 14 天、`csrftoken` 1 年（Django 默认值）。

---

## 7. 前端结构

```
frontend/src/
├── api/          # fetch 封装（JSON 信封解析、needsLogin 拦截）、sign / room / auth REST
├── ws/
│   ├── protocol.ts    # 消息类型（与后端 models.rs 对齐）、WS error 码、帧解析
│   ├── connection.ts  # 单连接状态机 idle/connecting/lobby/reconnecting/in_room/closed：
│   │                  #   心跳自动 pong、指数退避重连 1s→30s、重连自动 rejoin、
│   │                  #   4000/4008/4009 不重连、error 40404 放弃恢复
│   ├── worker.ts      # SharedWorker 脚本：同源所有标签页共享一条连接
│   └── client.ts      # WsHandle：优先 SharedWorker，降级 BroadcastChannel + localStorage
│                      #   选主（TTL 4s）；leader 直驱连接（BC 不回显发送者）；getWs() 单例
├── lib/          # qr-scan（BarcodeDetector→jsQR）、sign-url 预校验（与后端白名单一致）、room-link 短链、use-now 倒计时、wechat（JS-SDK 封装，含 VITE_WX_DEBUG 开关）
├── pages/        # Login / Plaza（首页：搜索+房间卡片+创建/加入对话框）/ Room（路由 /r/{房间号}：全屏扫码分享、签到码列表）/ Courses（F5 当前课程）
├── components/   # Modal（对话框基础组件，遮罩/Esc 关闭）、IcpFooter（仅在配置 VITE_ICP_BEIAN 时渲染）
├── stores/       # zustand: auth store；room store（服务端帧 → UI 状态的纯 reducer，消息 expire_at 倒计时过滤）
├── captcha.ts    # 腾讯验证码弹窗（TJCaptcha，AppId 2091064951）
└── config.ts     # VITE_API_BASE_URL / VITE_CAPTCHA_APP_ID 兜底 / VITE_ICP_BEIAN
```

- 房间页二维码内容展示带 `expire_at` 倒计时，到期自动隐藏（与后端"消失"语义一致）；
- 建房表单包含：**必填房间名**、可选密码、可选消息有效期（≤1h，默认 1h）、可选生命周期（分钟/永久）、可选课程关联信息五字段；创建成功后自动 join 进入房间（连接未 open 时由客户端排队补发）；
- 房间内头部突出展示数字房间号（大号字体 + 一键复制），便于口头传播；
- 开发环境由 Vite proxy 转发 `/api` 与 `/ws`（`ws: true`）到后端 3000 端口。

---

## 8. 部署设计（Docker Compose）

仓库根 `docker-compose.yml`：

```yaml
services:
  backend:                        # 多阶段: rust:1-bookworm → debian:bookworm-slim
    build: ./backend
    env_file: [.env]
    expose: ["3000"]              # 仅容器网络内可达
    volumes: ["logs:/app/logs"]   # tracing 按天滚动日志持久化
    healthcheck: curl -fsS http://localhost:3000/api/health
    mem_limit: 512m
    restart: unless-stopped
  frontend:                       # 多阶段: node:24-bookworm-slim → nginx:stable-alpine
    build:
      context: ./frontend
      args: { VITE_API_BASE_URL, VITE_CAPTCHA_APP_ID, VITE_ICP_BEIAN, VITE_WX_DEBUG }
    ports: ["80:80"]
    depends_on: { backend: { condition: service_healthy } }
    mem_limit: 128m
    restart: unless-stopped
```

- **只暴露 80**：TLS 交给前置反代终结（`frontend/nginx.conf` 末尾保留「容器内终结 TLS」的注释模板，需要时打开端口与证书卷即可）；后端 3000 不映射宿主机；
- **构建期变量**（`VITE_*`）经 `build.args` 从根 `.env` 注入；仓库只留 `.env.example` 模板，具体值（含 `VITE_ICP_BEIAN`、`SERVER_SECRET`）只存在部署机 `.env`（gitignore），开源仓库零污染、可随时 `git pull`；
- **Nginx**（`frontend/nginx.conf`）要点：
  - `location /ws`：`proxy_http_version 1.1` + `Upgrade`/`Connection` 头透传、`proxy_read_timeout 300s`；
  - `location /api/`：读超时 120s，覆盖微信扫码登录的 30s 服务端长轮询；
  - gzip 显式声明 `gzip_types`（nginx 默认只压 `text/html`）+ `gzip_vary on`，并开 `gzip_static on`（构建期由 `vite-plugin-compression2` 生成 `.gz` 直出，省运行时 CPU）；
  - `/assets/` 长缓存 `public, max-age=31536000, immutable`，`index.html` 强制 `no-cache`（发版即生效）；
  - SPA `try_files $uri $uri/ /index.html`；
- **容器内存上限**：compose 限制 backend ≤ 512M / frontend ≤ 128M——该上限按我们开发验证所用的 2 核 2G 机器设定，只是防单容器耗尽宿主的安全护栏，可按宿主规格调整；内存偏小的机器可另开 swap 兜底（命令见 README 部署章节）；
- **运行时配置**：根 `.env` 一个文件同时承担 compose 变量插值（`build.args`）与 `backend` 容器环境变量注入（`env_file`）两个角色；缺 `.env` 时 compose 直接报错，避免静默回落到不安全的 `dev-secret`；
- 后端镜像**非 root 运行**（uid 10001），`LOG_DIR=/app/logs` 由命名卷挂载。

---

## 9. Git 分支规范

- 双分支模型：**`main`**（生产，受保护）+ **`dev`**（集成，受保护），两者均只允许 PR 合并、禁止直接 push；
- 开发一律从最新 `dev` 拉短分支（`feat/` `fix/` `docs/` `chore/` + 简短描述），提 PR **先合并回 `dev`**（squash）；准备发版时提 **PR `dev` → `main`**（merge commit），合并后删除短分支。详见 `docs/LINTER.md` §5。
