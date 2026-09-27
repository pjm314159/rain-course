# rain-course

雨课堂签到助手 Web 版

- 作者：pjm314159
- 许可证：GPL-3.0-or-later

## 文档

- [需求规格（SPEC）](docs/SPEC.md)
- [技术设计（DESIGN）](docs/DESIGN.md)
- [变更记录](docs/CHANGELOG.md)
- [代码规范与工作流](docs/LINTER.md)

## 技术栈

Rust (axum) · Vite + React · Nginx · Docker Compose

## 开发

```bash
# 后端
cd backend && cargo build

# 前端（pnpm）
cd frontend && pnpm install && pnpm dev
```

## 部署（Docker Compose）

前置：安装 Docker 与 Docker Compose v2，服务器放开 80 端口。

```bash
cp .env.example .env      # 改 SERVER_SECRET（openssl rand -hex 32）；可选填 WECHAT_* / VITE_ICP_BEIAN
docker compose up -d --build
```

- 对外只暴露 **80**，**TLS 由前置反代终结**（宝塔 / 云负载均衡 / 外层 nginx、容器内终结 TLS 见 [frontend/nginx.conf](frontend/nginx.conf) 末尾注释模板）；
- 后端 3000 端口不映射到宿主机，仅在容器网络内被 nginx 反代（`/api`、`/ws`）；
- 日志按天滚动写入命名卷 `logs`，`docker compose logs -f backend` 可看实时输出；
- 改 `.env` 中的后端变量：`docker compose up -d --force-recreate`；改 `VITE_*`（打进前端产物）：`docker compose up -d --build frontend`。

### 2G 内存机器建议

`docker-compose.yml` 已限制 `backend ≤ 512m`、`frontend ≤ 128m`，建议宿主再开 swap 兜底：

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 升级

```bash
git pull
docker compose up -d --build
```
