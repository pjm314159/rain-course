# CHANGELOG

本项目的所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。

## [Unreleased]

### Added
- 分享房间模块（F3，M3）后端 `backend/src/ws/`：`Hub` 内存态房间管理（创建/加入/密码校验+限速/成员列表/历史消息 FIFO≤100 条+有效期淘汰/自定义生命周期）；`GET /ws` 握手校验本站会话、单用户单连接（旧连接 close 4009）；`POST /api/rooms`、`DELETE /api/rooms/{id}`、`GET /api/plaza`；后台 sweep 任务（心跳假死判死、lobby 空闲 10 分钟回收 close 4000、消息频率超限 close 4008、房间到期/14 天无消息回收）
- 分享房间前端 WS 客户端 `frontend/src/ws/`：协议类型与后端 `models.rs` 对齐（信封 `{type,seq,...}`、error 码表）；单连接状态机 idle/connecting/lobby/reconnecting/in_room/closed——心跳自动 pong、意外断开指数退避重连 1s→30s、重连自动 rejoin（joined 全量补齐）、4000/4008/4009 与 error 40404 不重连；SharedWorker 多标签页单连接复用，降级 BroadcastChannel + localStorage 选主（TTL 4s，leader 直驱连接规避不回显问题）
- 分享房间前端页面：房间页（创建/加入/密码、成员列表、二维码分享与 expire_at 倒计时、签到回执 feed、粘贴推送、离开/关闭房间）与广场页（REST 首次拉取 + WS `plaza_update` 实时覆盖，公开房间点击即加入）
- `.env.example`：补全 `WS_*` 房间资源上限配置项（房间数/人数/消息大小/频率/存量/心跳/空闲回收/密码限速等，全部可调）
- 需求规格 `docs/SPEC.md`：登录（密码/短信/微信扫码三种方式，均必做）、扫码签到（微信 JS-SDK 优先、浏览器相机降级、手动输入兜底）、WebSocket 分享房间（房间密码、房间关联课程信息）、广场（公开房间发现）、查看当前课程（F5）
- 技术设计 `docs/DESIGN.md`：axum + Vite/React + Nginx + Docker Compose 架构；REST/WS 协议设计；扫码内容域名白名单校验（防 SSRF）；雨课堂真实接口细节（源自 `course_helper` 源码分析）；资源上限设计（房间数/人数/消息大小/频率/存量有界）
- `docs/LINTER.md`：代码风格与静态检查规范，含双分支 Git 工作流、PR 规范、测试要求
- `.github/pull_request_template.md`：PR 模板（含自查清单）
- `.github/workflows/ci.yml`：CI 流程（后端 fmt/clippy/test，前端 lint/typecheck/test/build）
- 房间生命周期：可自定义（精确到分钟）、允许永久；任何房间 14 天无消息自动删除
- 房间消息全保留（存量上限 200 条/房间），以有效期控制可见性
- Git 主分支使用 `main`，集成分支使用 `dev`；远程仓库 `github.com/pjm314159/rain-course`（origin）
- 前端包管理器使用 pnpm（CI 同步使用 `pnpm install --frozen-lockfile`）
- 前端脚手架（Vite + React 19 + TS + React Compiler + oxlint），已清除模板代码并填入项目信息（name/author/描述），新增 `typecheck`/`test` 脚本
- 扫码页支持上传二维码图片识别签到：浏览器本地解码（`BarcodeDetector` 优先、`@zxing/browser` 降级），图片不上传服务器；单图 ≤ 5MB，识别失败明确提示
- 后端 `Cargo.toml`：填入项目信息（`rain-course-backend` 0.1.0 / author / 描述），配置 `[lints]`（forbid unsafe、deny unwrap_used 等）与 release 最优 profile（lto=fat、codegen-units=1、panic=abort、strip）；后端暂不引入框架依赖
- 许可证：全项目使用 GPL-3.0-or-later（LICENSE 为官方全文），`rust-version` 对齐本机 rustc 1.98；创建根 README.md

### Changed
- 视觉样式复刻 `qrcode_share` 项目：前端引入 Tailwind CSS v4（`@theme` 设计令牌：奶油画布/墨色文字/品牌色板/Inter 字体），重刷导航与登录/扫码/房间/广场全部页面；房间内头部大号展示数字房间号（一键复制）
- 房间名改为**必填**（后端空名校验 40306 + 前端必填标记）；`joined` 帧下发房间名，加入者可见
- WS 连接 open 前到达的消息排队、open 后按序补发（与自动 rejoin 去重），修复"创建房间后偶发未自动进入房间"的竞态
- 本站会话对齐雨课堂 `sessionid` 有效期：**14 天滑动续期**（已抓包确认 `sessionid` 14 天、`csrftoken` 1 年），签名 cookie 校验，无服务端会话存储
- 会话方案从 tower-sessions → 签名 cookie（`axum-extra` `PrivateCookieJar`）
- 存储决策：不引入数据库与 Redis，全部状态内存态；雨课堂凭证内存保存，服务重启需重新登录
- 登录方式：短信验证码登录与微信扫码登录从"预留"改为**必做**；微信扫码登录直接复用雨课堂 `pre-info` 返回的二维码图片（无需本站公众号）；**实测确认**短信/密码登录必须携带腾讯验证码票据（空票据被拒），前端接入 TJCaptcha.js（AppId 复用雨课堂 `2091064951`，本站仅透传票据）
- `scripts/test_yk_login.py`：雨课堂登录接口实测脚本（短信/密码/扫码、cookie 过期时间打印）；`scripts/captcha.html`：本地获取验证码票据的 demo 页
- 实测确认验证码 AppId `2091064951` **不限域名**——任意域名/本地开发均可弹验证码，登录模块零外部资质依赖
- 分享房间资源上限：全局房间 ≤ 100、每用户建房 ≤ **5**、单房间 ≤ 50 人、消息 ≤ 2KB、≤ 30 条/分钟、历史消息 ≤ **100 条/天/频道**、广播 channel 有界
- 房主策略改为**类微信**：房主退出/断线不解散房间，身份保留，重连自动恢复
- 客户端连接模型：单客户端单 WebSocket（SharedWorker 多标签页复用，BroadcastChannel 分发），心跳改为**客户端 30s pong** 保活
- 历史消息：每频道 FIFO 队列上限 100 条（淘汰最旧），消息过期**直接删除**（入队时惰性淘汰，不引入定时清理任务——内存上界已由队列上限确定，最坏 ≈ 5MB）

### Removed
- 旧版 `docs/需求文档.md`（拆分为 SPEC.md 与 DESIGN.md）

### Security
- 扫码内容严格校验：HTTPS scheme + 雨课堂域名白名单（`serverBaseUrlMap`），未通过绝不发起出站请求（防 SSRF/钓鱼转发）
- 房间密码：服务端常量时间比较 + 失败限速；密码与成员列表不落日志
