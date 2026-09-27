# rain-course

雨课堂签到助手（Web 版）——在浏览器里完成雨课堂动态二维码签到，并支持「一人扫码、全房间同步签到」。

> 思路复刻自 Flutter 项目 `course_helper`，只围绕「签到」这一个场景，不含课件、答题、管理后台等功能。

## 功能

| 模块 | 说明 |
|------|------|
| 登录 | 直接用雨课堂账号：手机号 + 密码 / 短信验证码 / 微信扫码三种方式，登录态保持 14 天 |
| 扫码签到 | 微信内调起「微信扫一扫」；普通浏览器用相机扫码，也可上传二维码截图；二维码只在浏览器本地解码，不上传服务器 |
| 分享房间 | 一人扫到签到码，房间内所有成员实时收到并一键签到；用房间号或邀请短链加入，可设房间密码 |
| 广场 | 公开（无密码）房间列表，人数实时更新，点一下即可加入 |
| 当前课程 | 展示雨课堂「正在上课」的课程，方便快速定位课堂 |

## 使用流程

1. 打开站点，用雨课堂账号登录；
2. 创建房间（房间名必填，可设密码、消息有效期、房间寿命、课程信息），把房间号或邀请短链发给同学；也可以在「广场」里直接加入一个公开房间；
3. 拿到签到二维码的人点底栏「扫码分享」（微信内为「微信扫一扫」），二维码会实时出现在房间内所有人的消息流里；
4. 房间内成员点击消息即可签到，签到结果实时回显。

规则：消息默认 1 小时后过期（期间可反复签到），房间默认 4 小时后关闭（也可自定义时长或设为永久）；任何房间连续 14 天无消息都会被自动回收。

## 部署（Docker Compose）

### 准备

- 一台能装 Docker 的 Linux 服务器，对外开放 **80** 端口（如需 HTTPS，在它前面加一层反向代理）；
- Docker Engine 20.10+ 与 Docker Compose v2。

CPU / 内存没有硬性基线——本项目在 **2 核 2G** 的机器上开发与验证，小规模日常使用够用；`docker-compose.yml` 里为每个容器设了内存上限，只是防止单容器耗尽宿主内存，可按自己机器的规格调整。

### 开始部署

```bash
git clone https://github.com/pjm314159/rain-course.git
cd rain-course
cp .env.example .env
# 必改：SERVER_SECRET 换成一串随机值，生成示例：openssl rand -hex 32
# 可选：WECHAT_APP_ID / WECHAT_APP_SECRET（微信内扫码签到）
# 可选：VITE_ICP_BEIAN（ICP 备案号，填了才在登录页页脚展示）
docker compose up -d --build
```

访问 `http://<服务器 IP>/` 即可。健康检查：`curl http://<服务器 IP>/api/health`。

### HTTPS 与微信内扫码

- 对外只暴露 **80**，**TLS 由前置反代终结**（宝塔面板 / 云负载均衡 / 外层 nginx 都可以）；如果确实要在容器内终结 TLS，[frontend/nginx.conf](frontend/nginx.conf) 末尾留了可直接启用的注释模板；
- 微信内置浏览器里的「微信扫一扫」需要**已认证的公众号**并配置 JS 安全域名（必须和实际访问域名一致）。未配置时该按钮自动隐藏，仍可用相机扫码，功能不受影响；
- 微信要求页面走 HTTPS，所以通常要先把前置反代配好再验证这一项。

### 修改配置

| 改了什么 | 生效命令 |
|----------|----------|
| 后端变量（`.env` 里的 `SERVER_SECRET` / `YK_*` / `WECHAT_*` / `WS_*` 等） | `docker compose up -d --force-recreate` |
| 前端构建期变量（`VITE_*`，会打进产物） | `docker compose up -d --build frontend` |

### 日志、升级与卸载

```bash
docker compose logs -f backend                 # 实时日志（同时按天滚动写入 logs 卷）
git pull && docker compose up -d --build       # 升级到最新版本
docker compose down -v                         # 停止并删除容器与日志卷
```

内存偏小的机器可以另开一块 swap 兜底（完全可选）：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 配置项速查

完整清单与注释见 [.env.example](.env.example)。常用项：

| 变量 | 默认 | 说明 |
|------|------|------|
| `SERVER_SECRET` | — | **必改**，签名 cookie 的 HMAC 密钥 |
| `PORT` | `3000` | 后端监听端口（容器网络内） |
| `COOKIE_TTL_SECS` | `1209600` | 本站登录态有效期，14 天（对齐雨课堂 `sessionid`） |
| `RUST_LOG` | `info` | 日志级别 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 空 | 公众号凭证；留空则微信内自动降级为相机扫码 |
| `YK_ALLOWED_HOSTS` | 雨课堂域名 | 二维码内容域名白名单，非白名单内容一律拒绝 |
| `WS_*` | 见模板 | 房间数 / 人数 / 消息大小 / 频率 / 存量等资源上限，全部可调 |
| `VITE_API_BASE_URL` | 空 | 前端 API 基地址；同源部署（nginx 反代 `/api`、`/ws`）留空即可 |
| `VITE_ICP_BEIAN` | 空 | ICP 备案号，留空则页脚零痕迹 |

## 本地开发

```bash
# 后端（Rust 1.98+）：默认监听 3000
cd backend && cp .env.example .env && cargo run

# 前端（Node 20+ / pnpm）
cd frontend && cp .env.example .env && pnpm install && pnpm dev
```

前端的 dev server 会把 `/api` 与 `/ws` 代理到本地 3000 端口，所以本地只需要跑后端。构建与检查命令（`cargo fmt`/`clippy`/`test`、`pnpm lint`/`typecheck`/`test`/`build`）以及分支与提交规范见 [docs/LINTER.md](docs/LINTER.md)。

## 已知限制

- 后端不持久化雨课堂凭证与房间数据（刻意不引入数据库和 Redis）：**服务重启后需要重新登录雨课堂**，本站登录态（签名 cookie）仍有效；
- 房间全内存态，单实例部署，不可横向扩容到多副本；
- 请仅用于本人已到场的课堂签到，不要用来代替他人签到；
- 本项目与雨课堂官方无关，使用产生的一切后果由使用者自行承担。

## 文档

- 需求规格：[docs/SPEC.md](docs/SPEC.md)
- 技术设计：[docs/DESIGN.md](docs/DESIGN.md)
- 变更记录：[docs/CHANGELOG.md](docs/CHANGELOG.md)
- 代码规范与工作流：[docs/LINTER.md](docs/LINTER.md)

## 许可证

GPL-3.0-or-later © pjm314159