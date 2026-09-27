# ============================================================
# rain-course 后端镜像（docs/DESIGN.md §8）
# 多阶段：rust 编译 → debian:bookworm-slim 运行
# ============================================================

# ---- 构建阶段 ----
FROM rust:1-bookworm AS builder
WORKDIR /app

# 1) 先只放清单，用假入口把依赖编出来：之后改源码不会触发 reqwest/tokio 重编
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# 2) 复制真实源码重建（只有本项目 crate 需要重编）
#    touch 保证 mtime 新于假入口，cargo 必定重编而非复用旧指纹
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ---- 运行阶段 ----
FROM debian:bookworm-slim AS runtime

# curl：供 compose healthcheck 调用 /api/health
# ca-certificates：出站 HTTPS（雨课堂）用，避免证书链缺失
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# 非 root 运行；/app/logs 先建好并归属 app，命名卷才会继承该属主
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app/logs \
    && chown -R app:app /app
WORKDIR /app
ENV LOG_DIR=/app/logs

COPY --from=builder /app/target/release/rain-course-backend /app/rain-course-backend

USER app
EXPOSE 3000
CMD ["/app/rain-course-backend"]