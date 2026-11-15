mod log0;
mod stock;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use stock::{Line, ReserveError, Stock};
use tokio::sync::Mutex;

struct AppState {
    stock: Mutex<Stock>,
}

#[derive(Deserialize)]
struct ReserveRequest {
    #[serde(rename = "orderId")]
    order_id: String,
    lines: Vec<Line>,
}

#[derive(Deserialize)]
struct ReleaseRequest {
    #[serde(rename = "orderId")]
    order_id: String,
}

/// Append the reservation to the audit trail. Slow on purpose (a disk flush), so callers must not wait for
/// it while holding anything other requests need.
async fn write_audit(_order_id: &str, _lines: usize) {
    tokio::time::sleep(Duration::from_millis(40)).await;
}

async fn reserve(State(state): State<Arc<AppState>>, Json(req): Json<ReserveRequest>) -> (StatusCode, Json<Value>) {
    // fast path: a single-line order can be refused without building the general reservation
    if let [only] = req.lines.as_slice() {
        match state.stock.lock().await.available(&only.sku) {
            Some(have) if have < only.qty => {
                return (StatusCode::CONFLICT, Json(json!({"error": "out of stock", "sku": only.sku})));
            }
            None => {
                return (StatusCode::CONFLICT, Json(json!({"error": "out of stock", "sku": only.sku})));
            }
            _ => {}
        }
    }
    let result = {
        let mut stock = state.stock.lock().await;
        stock.reserve(&req.order_id, &req.lines)
    };
    match result {
        Ok(()) => {
            write_audit(&req.order_id, req.lines.len()).await;
            (StatusCode::OK, Json(json!({"reserved": true})))
        }
        Err(ReserveError::OutOfStock(sku)) => (StatusCode::CONFLICT, Json(json!({"error": "out of stock", "sku": sku}))),
    }
}

async fn release(State(state): State<Arc<AppState>>, Json(req): Json<ReleaseRequest>) -> Json<Value> {
    let released = state.stock.lock().await.release(&req.order_id);
    Json(json!({ "released": released }))
}

async fn stock_of(State(state): State<Arc<AppState>>, Path(sku): Path<String>) -> (StatusCode, Json<Value>) {
    match state.stock.lock().await.available(&sku) {
        Some(n) => (StatusCode::OK, Json(json!({"sku": sku, "available": n}))),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "unknown sku"}))),
    }
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/reserve", post(reserve))
        .route("/release", post(release))
        .route("/stock/{sku}", get(stock_of))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    log0::install_panic_hook();
    let port = std::env::var("PORT").unwrap_or_else(|_| "8091".to_string());
    let state = Arc::new(AppState { stock: Mutex::new(Stock::seeded()) });
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await.expect("bind the port");
    log0::info(&format!("inventory listening on {port}"));
    axum::serve(listener, router(state)).await.expect("serve");
}
