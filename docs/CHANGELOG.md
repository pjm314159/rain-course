# CHANGELOG

本项目的所有显著变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本（SemVer）。

## [Unreleased]

### Fixed
- 扫码识别后无任何成功/失败提示：识别到非雨课堂二维码时静默推送（后端拒绝也不提示）、有效二维码推送后无任何反馈。现在识别内容先经 `sign-url.ts` 预校验（与后端白名单一致），无效内容提示"不是有效的雨课堂签到码"并继续扫描；有效内容推送后 toast"已推送到房间"并关闭扫码页；服务端兜底错误帧也会以 toast 呈现
- 设置页「收到消息立即签到」开关旋钮方向错误：开启时旋钮反而在左侧、关闭时偏右，原因是 `Toggle` 的滑块 `span` 缺少 `left-0.5` 定位导致脱离基准点
- 相机扫码与图片解码实际效果不稳定：`@zxing/browser` 静态图解码对整数倍缩放的二维码必失败，视频流路径也未经验证。统一改为 `jsQR`（纯 JS、对缩放/旋转/亮度/模糊稳健），移除 zxing 依赖（477KB chunk 消除，构建体积从 ~793KB 降至 ~445KB）
- 创建房间对话框数值输入框无法删空重输：原 `Number(e.target.value) || 默认值` 使清空（空串 → 0 → falsy）立即回弹为默认值；改为字符串态保存、输入期间不校验不回弹，仅在提交时统一校验

### Changed
- 房间页底栏：微信内置浏览器下于相机扫码按钮上方新增「微信扫一扫」主按钮（`docs/SPEC.md` §3.2.2 首选方案），结果与相机扫码同路径（本地预校验 → `share_qr` 推送全房间）；该入口仅在 `GET /api/wechat/status` 判定后端已配置公众号时展示，非微信环境保持相机扫码，签名失败/未注入 wx 时提示回退相机扫码
- 微信 `wx.scanQRCode` 参数对齐参考实现 `qrcode_share`：`scanType` 由 `['qrCode','barCode']` 收紧为 `['qrCode']`；`fail` 回调 `errMsg` 含 `cancel` 时按用户取消处理（部分微信版本取消走 `fail` 而非 `cancel`），返回 `null` 而非报错
- `.env.example`：新增 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 占位（M5 微信内扫码；留空则微信内自动降级为相机扫码）
- `startQrScan` 的 `onDetected` 回调返回值改为 `boolean`：`true` 表示接受结果并停止扫描，`false` 表示内容无效、继续扫描——调用方（`ScanOverlay`）在返回 `false` 时展示错误提示而不中断扫码
- 广场点击房间卡片「扫描二维码」/「加入房间」对话框提交后不进入房间页：三个加入入口统一等待 `joined` 帧后跳转（此前仅创建路径标记了加入意图）；若目标房间已在房间内则直接进入；取消对话框即清除意图
- SharedWorker 内引用 `window` 导致静默崩溃、WS 从未建立（页面永远无法进入房间）：`wsUrl()` 与默认定时器改用 `globalThis`（worker 环境无 `window`）；注意 worker 代码更新后需关闭所有引用标签页才会重载
- 创建房间对话框默认展示「消息有效期」（分钟，默认 60）与「房间寿命」（小时，默认 4，即原 240 分钟），此前二者位于「填写课程信息」折叠区内需手动展开；提交时按小时 → 分钟换算（消息有效期限 1–60 整数分钟，房间寿命需 > 0 小时），勾选「永久房间」则不发送寿命
- 通用对话框卡片限高 `85vh` 且内容区内部滚动（`overscroll-contain`），避免小屏或展开课程信息后弹窗超出屏幕
- 广场房间卡片详情对话框的主按钮由「扫描二维码」改为「加入房间」，与底部操作条语义一致（加入后进入房间页，在房间内扫码分享）
- 创建房间对话框「填写课程信息（可选）」折叠开关增加展开箭头：折叠时箭头周期性轻微下沉（`animate-hint-bounce`）提示可展开，展开后旋转 180°
- 性能优化（不改变对外行为）：
  - 房间页消息流：签到码卡片 `QrCard` 加 `memo`（父级每秒重渲时不再整列重渲，倒计时仍由各卡片自身 tick）；设置抽屉改为逐字段订阅 store（消息流/签到回执变化不再连带重渲抽屉）；自动签到只处理消息尾部增量（原先每次消息事件都重建全量 `Set`）
  - 扫码相机 `BarcodeDetector` 原生路径按 `FRAME_INTERVAL_MS`（300ms）节流，此前走 `requestAnimationFrame` 每帧都执行 `detect`，白耗 CPU/GPU（jsQR 路径原本已节流）
  - 房间消息 store 在入队时惰性裁剪已过期二维码消息，使数组有界（对齐后端 `VecDeque` 的惰性淘汰），长会话不再无界增长
  - 后端 WS：连接进房后退订 lobby 广播、回广场时重新订阅，使广场全量 `plaza_update` 只发给广场页连接；`broadcast_plaza` 在无 lobby 订阅者时提前返回；`share_qr` 内容分配由 3 次降为 2 次
- 房间邀请短链：设置面板生成 `{origin}/r/{房间号}` 一键复制；新增 `/r/:roomId` 落地路由（打开即申请加入，密码房弹密码框，joined 后自动进房间页）；广场「加入房间」对话框同时接受纯数字房间号或粘贴的短链 URL
- 房间页改为 `qrcode_share` ChannelPage 式全屏布局：顶栏左「返回」、正中房间名（大字）+ 房号（小字）、右「设置」；中间为接收的签到码消息流（自动滚动）；底栏「扫码分享」（主位）+「分享房间」图标按钮；房间页路由统一为 `/r/{房间号}`（`/room` 已移除，刷新不丢房间）
- 房间页扫码改为**全屏取景**：左上角关闭、左下角相册（选图后浏览器本地 `jsQR` 识别，识别成功即推送全房间并关闭）；底栏原「粘贴推送」按钮移除，改为右侧「分享房间」——优先 `navigator.share` 系统分享，不支持或失败则复制邀请短链并 toast 提示
- 设置抽屉（房间页右上角）：房间信息（房号/房间名/课程信息 + 一键复制）、成员列表、「收到消息立即签到」开关（localStorage 持久化，**默认关**——关闭时点击消息内容框才签到）、离开房间/关闭房间（房主）
- `qr_update` 改为**也回显给发送者**（前端按 raw+expire_at 去重）：签到协作场景下发送者本人同样要在消息流里看到自己分享的码
- 视觉样式复刻 `qrcode_share` 项目：前端引入 Tailwind CSS v4（`@theme` 设计令牌：奶油画布/墨色文字/品牌色板/Inter 字体），重刷导航与登录/扫码/房间/广场全部页面；房间内头部大号展示数字房间号（一键复制）
- 房间名改为**必填**（后端空名校验 40306 + 前端必填标记）；`joined` 帧下发房间名，加入者可见
- WS 连接 open 前到达的消息排队、open 后按序补发（与自动 rejoin 去重），修复"创建房间后偶发未自动进入房间"的竞态
- 本站会话对齐雨课堂 `sessionid` 有效期：**14 天滑动续期**（已抓包确认 `sessionid` 14 天、`csrftoken` 1 年），签名 cookie 校验，无服务端会话存储
- 会话方案从 tower-sessions → 签名 cookie（`axum-extra` `PrivateCookieJar`）
- 存储决策：不引入数据库与 Redis，全部状态内存态；雨课堂凭证内存保存，服务重启需重新登录
- 登录方式：短信验证码登录与微信扫码登录从"预留"改为**必做**；微信扫码登录直接复用雨课堂 `pre-info` 返回的二维码图片（无需本站公众号）；**实测确认**短信/密码登录必须携带腾讯验证码票据（空票据被拒），前端接入 TJCaptcha.js（AppId 复用雨课堂 `2091064951`，本站仅透传票据）
- `scripts/test_yk_login.py`：雨课堂登录接口实测脚本（短信/密码/扫码、cookie 过期时间打印）；`scripts/captcha.html`：本地获取验证码票据的 demo 页
- 实测确认验证码 AppId `2091064951` **不限域名**——任意域名/本地开发均可弹验证码，登录模块零外部资质依赖
- 分享房间资源上限：全局房间 ≤ 100、每用户建房 ≤ **5**、单房间 ≤ 50 人、消息 ≤ 2KB、≤ 30 条/分钟、历史消息 ≤ **100 条/频道**、广播 channel 有界
- 房主策略改为**类微信**：房主退出/断线不解散房间，身份保留，重连自动恢复
- 客户端连接模型：单客户端单 WebSocket（SharedWorker 多标签页复用，BroadcastChannel 分发），心跳改为**客户端 30s pong** 保活
- 历史消息：每频道 FIFO 队列上限 100 条（淘汰最旧），消息过期**直接删除**（入队时惰性淘汰，不引入定时清理任务——内存上界已由队列上限确定，最坏 ≈ 5MB）

### Added
- Docker Compose 一键部署（M6，见 `docs/DESIGN.md` §8）：`backend/Dockerfile`（多阶段 `rust:1-bookworm` → `debian:bookworm-slim`，先用假入口把依赖编出来以复用层缓存、非 root uid 10001 运行、装 `curl` 供 healthcheck）、`frontend/Dockerfile`（多阶段 `node:24-bookworm-slim` → `nginx:stable-alpine`，`VITE_*` 经 `build.args` 注入）、根 `docker-compose.yml`（只对外暴露 80、TLS 交前置反代；backend 不映射端口且 frontend 以 `service_healthy` 依赖它；`mem_limit` 512m/128m 按开发验证所用的 2 核 2G 机器设定，仅作防单容器耗尽宿主的安全护栏；日志命名卷 `logs` 持久化）与两端 `.dockerignore`
- 前端网关 `frontend/nginx.conf`：`/api` 反代读超时 120s（覆盖微信扫码登录的 30s 服务端长轮询）、`/ws` 透传 `Upgrade`/`Connection` 且读超时 300s、显式 `gzip_types` + `gzip_vary` + `gzip_static`、`/assets/` 长缓存 `immutable` 而 `index.html` 强制 `no-cache`、SPA `try_files ... /index.html`；末尾附「容器内终结 TLS」注释模板
- 前端构建期 gzip 预压缩：接入 `vite-plugin-compression2`，构建产出 `.gz`（index.js 325KB → 101KB、css 31KB → 6KB）配合 nginx `gzip_static` 直出，省去运行时压缩 CPU
- 根 `.env.example` 补充 Docker 部署用法说明与前端构建期变量（`VITE_*`）——compose 部署下该文件同时承担容器环境变量注入与 `build.args` 取值两个角色；`README.md` 重写为**用户侧文档**（功能一览、使用流程、Docker Compose 部署、配置项速查、已知限制；2 核 2G 只表述为我们的开发验证环境，不作为部署基线）
- 微信 JS-SDK 可用性预检查（M5）：后端 `GET /api/wechat/status`（免会话）返回 `{available, reason}`，只暴露「是否已配置」不含凭证；前端房间页仅在「微信内 且 后端判定可用」时才渲染「微信扫一扫」入口，未配置时完全不显示（避免点击后才报 40307）
- 微信真机调试开关（M5）：`frontend/.env` 设 `VITE_WX_DEBUG=true` 时 `wx.config({debug:true})`，在微信真机上以 alert 弹窗输出签名校验细节，便于定位 `invalid signature`（默认关闭，上线留空）
- 微信 JS-SDK 扫码签到（M5）后端 `backend/src/wechat/`：`GET /api/wechat/jssdk-signature?url=` 返回 `{appId,timestamp,nonceStr,signature}`；`WechatClient` 内存缓存 `access_token` / `jsapi_ticket`（默认 7200s，提前 300s 刷新；`tokio::sync::RwLock` 保证不跨 `await` 持锁），签名串 `jsapi_ticket=..&noncestr=..&timestamp=..&url=..` 取 **plain SHA1**（新增 `sha1` 依赖），`url` 自动去除 `#` 及其后部分；公众号凭证经 `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 注入，未配置时返回 40307（不 panic）
- 微信 JS-SDK 扫码签到（M5）前端：`frontend/src/lib/wechat.ts`（`MicroMessenger` UA 检测、jweixin 1.6.0 动态注入且幂等复用、`wx.config` → `wx.scanQRCode` 封装，用户取消返回 `null`）与 `frontend/src/api/wechat.ts`（签名获取）
- 可选 ICP 备案号页脚（`frontend/src/components/IcpFooter.tsx`）：仅当部署方配置 `VITE_ICP_BEIAN` 时渲染（链接工信部 `beian.miit.gov.cn`），未配置时零 DOM 痕迹；页脚挂在登录页，号码只写在部署机 `frontend/.env.local`（已 gitignore），仓库与开源发布不含任何具体号码，保证可随时 `git pull` 更新
- 查看当前课程（F5，M4）后端 `backend/src/courses/`：`GET /api/courses` 实时透传雨课堂「正在上课」课程（`/api/v3/classroom/on-lesson` ∩ `/v/course_meta/learning_list/`，对齐 `course_helper` 的 `getCoursesList()`），本站不落库；上游会话失效（50000）映射为 40101 统一登录引导
- 查看当前课程前端页面 `frontend/src/pages/Courses.tsx`：展示课程名 / 教师 / 课堂名（班级）/ 课程头像（无头像时以课程名首字兜底），支持手动刷新、加载/错误提示与无课程空态；导航栏新增「当前课程」入口（`/courses`）
- 分享房间模块（F3，M3）后端 `backend/src/ws/`：`Hub` 内存态房间管理（创建/加入/密码校验+限速/成员列表/历史消息 FIFO≤100 条+有效期淘汰/自定义生命周期）；`GET /ws` 握手校验本站会话、单用户单连接（旧连接 close 4009）；`POST /api/rooms`、`DELETE /api/rooms/{id}`、`GET /api/plaza`；后台 sweep 任务（心跳假死判死、lobby 空闲 10 分钟回收 close 4000、消息频率超限 close 4008、房间到期/14 天无消息回收）
- 分享房间前端 WS 客户端 `frontend/src/ws/`：协议类型与后端 `models.rs` 对齐（信封 `{type,seq,...}`、error 码表）；单连接状态机 idle/connecting/lobby/reconnecting/in_room/closed——心跳自动 pong、意外断开指数退避重连 1s→30s、重连自动 rejoin（joined 全量补齐）、4000/4008/4009 与 error 40404 不重连；SharedWorker 多标签页单连接复用，降级 BroadcastChannel + localStorage 选主（TTL 4s，leader 直驱连接规避不回显问题）
- 分享房间前端页面：房间页（创建/加入/密码、成员列表、二维码分享与 expire_at 倒计时、签到回执 feed、离开/关闭房间）与广场页（REST 首次拉取 + WS `plaza_update` 实时覆盖，公开房间点击即加入）
- `.env.example`：补全 `WS_*` 房间资源上限配置项（房间数/人数/消息大小/频率/存量/心跳/空闲回收/密码限速等，全部可调）
- 需求规格 `docs/SPEC.md`：登录（密码/短信/微信扫码三种方式，均必做）、扫码签到（微信 JS-SDK 优先、浏览器相机降级、手动输入兜底）、WebSocket 分享房间（房间密码、房间关联课程信息）、广场（公开房间发现）、查看当前课程（F5）
- 技术设计 `docs/DESIGN.md`：axum + Vite/React + Nginx + Docker Compose 架构；REST/WS 协议设计；扫码内容域名白名单校验（防 SSRF）；雨课堂真实接口细节（源自 `course_helper` 源码分析）；资源上限设计（房间数/人数/消息大小/频率/存量有界）
- `docs/LINTER.md`：代码风格与静态检查规范，含双分支 Git 工作流、PR 规范、测试要求
- `.github/pull_request_template.md`：PR 模板（含自查清单）
- `.github/workflows/ci.yml`：CI 流程（后端 fmt/clippy/test，前端 lint/typecheck/test/build）
- 房间生命周期：可自定义（精确到分钟）、允许永久；任何房间 14 天无消息自动删除
- 房间消息全保留（存量上限 100 条/房间，与后端配置一致），以有效期控制可见性
- Git 主分支使用 `main`，集成分支使用 `dev`；远程仓库 `github.com/pjm314159/rain-course`（origin）
- 前端包管理器使用 pnpm（CI 同步使用 `pnpm install --frozen-lockfile`）
- 前端脚手架（Vite + React 19 + TS + React Compiler + oxlint），已清除模板代码并填入项目信息（name/author/描述），新增 `typecheck`/`test` 脚本
- 扫码页支持上传二维码图片识别签到：浏览器本地解码（`BarcodeDetector` 优先、`jsQR` 降级），图片不上传服务器；单图 ≤ 5MB，识别失败明确提示
- 后端 `Cargo.toml`：填入项目信息（`rain-course-backend` 0.1.0 / author / 描述），配置 `[lints]`（forbid unsafe、deny unwrap_used 等）与 release 最优 profile（lto=fat、codegen-units=1、panic=abort、strip）；后端暂不引入框架依赖
- 许可证：全项目使用 GPL-3.0-or-later（LICENSE 为官方全文），`rust-version` 对齐本机 rustc 1.98；创建根 README.md

### Removed
- 旧版 `docs/需求文档.md`（拆分为 SPEC.md 与 DESIGN.md）

### Security
- 扫码内容严格校验：HTTPS scheme + 雨课堂域名白名单（`serverBaseUrlMap`），未通过绝不发起出站请求（防 SSRF/钓鱼转发）
- 房间密码：服务端常量时间比较 + 失败限速；密码与成员列表不落日志
