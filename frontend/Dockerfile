# ============================================================
# rain-course 前端镜像（docs/DESIGN.md §8）
# 多阶段：node 构建 → nginx 静态托管 + 反代
# ============================================================

# ---- 构建阶段 ----
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# 与本地 / CI 保持同一 pnpm 大版本（lockfileVersion 9.0）
RUN npm install -g pnpm@12

# 先装依赖，改源码时依赖层仍可复用
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# 构建期变量经 docker-compose 的 build.args 注入（值来自根 .env，不提交仓库）
ARG VITE_API_BASE_URL=""
ARG VITE_CAPTCHA_APP_ID=""
ARG VITE_ICP_BEIAN=""
ARG VITE_WX_DEBUG=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CAPTCHA_APP_ID=${VITE_CAPTCHA_APP_ID} \
    VITE_ICP_BEIAN=${VITE_ICP_BEIAN} \
    VITE_WX_DEBUG=${VITE_WX_DEBUG}

RUN pnpm build

# ---- 运行阶段 ----
FROM nginx:stable-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80