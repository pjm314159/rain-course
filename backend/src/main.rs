//! 雨课堂签到助手后端入口

// LINTER.md 政策：业务代码禁止 unwrap；测试代码允许（LINTer §1）
#![cfg_attr(test, allow(clippy::unwrap_used))]

mod auth;
mod config;
mod error;
mod signin;
mod ws;

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::config::Config;

async fn health(State(cfg): State<Arc<Config>>) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "code": 0, "msg": "ok",
            "data": { "status": "up", "captcha_app_id": cfg.captcha_app_id }
        })),
    )
        .into_response()
}

fn build_app(cfg: Arc<Config>) -> Router {
    let state = Arc::new(auth::routes::AppState::new(
        (*cfg).clone(),
        auth::yk_client::YkClient::new(&cfg.yk_base_url),
    ));
    // 后台巡检：心跳假死判死 / lobby 空闲回收（close 4000）/ 房间到期与 14 天无消息回收
    ws::routes::spawn_sweeper(state.hub.clone(), cfg.limits.clone());
    let health = Router::new()
        .route("/api/health", get(health))
        .with_state(cfg);
    auth::routes::router(state.clone())
        .merge(signin::routes::router(state.clone()))
        .merge(ws::routes::router(state))
        .merge(health)
}

#[tokio::main]
async fn main() {
    // 加载根目录 .env（存在时）
    dotenvy::dotenv().ok();

    let cfg = Arc::new(Config::from_env());

    // 双通道日志：stdout（开发）+ 按天滚动文件（持久化，logs/rain-course.YYYY-MM-DD）
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info,tower_http=info".into());
    let file_appender = tracing_appender::rolling::daily(&cfg.log_dir, "rain-course.log");
    let (file_writer, _log_guard) = tracing_appender::non_blocking(file_appender);
    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file_writer),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    tracing::info!(log_dir = %cfg.log_dir, "persistent logging initialized");

    let port = cfg.port;
    tracing::info!(
        yk_base_url = %cfg.yk_base_url,
        allowed_hosts = ?cfg.yk_allowed_hosts,
        captcha_app_id = %cfg.captcha_app_id,
        cookie_ttl_secs = cfg.cookie_ttl_secs,
        "configuration loaded"
    );
    let app = build_app(cfg);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind port");
    tracing::info!("listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await.expect("server error");
}
