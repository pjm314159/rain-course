//! 雨课堂签到助手后端入口

// LINTER.md 政策：业务代码禁止 unwrap；测试代码允许（LINTer §1）
#![cfg_attr(test, allow(clippy::unwrap_used))]

mod auth;
mod config;
mod error;

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
    let state = Arc::new(auth::routes::AppState {
        config: Config::clone(&cfg),
        yk: auth::yk_client::YkClient::new(&cfg.yk_base_url),
        sessions: std::sync::RwLock::new(std::collections::HashMap::new()),
    });
    let health = Router::new()
        .route("/api/health", get(health))
        .with_state(cfg);
    auth::routes::router(state).merge(health)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let cfg = Arc::new(Config::from_env());
    let port = cfg.port;
    tracing::info!(
        yk_base_url = %cfg.yk_base_url,
        allowed_hosts = ?cfg.yk_allowed_hosts,
        captcha_app_id = %cfg.captcha_app_id,
        "configuration loaded"
    );
    let app = build_app(cfg);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind port");
    tracing::info!("listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await.expect("server error");
}
