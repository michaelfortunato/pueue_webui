use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tide::http::mime;
use tide::{Request, Response, StatusCode};

pub mod pueue_backend;

#[async_trait]
pub trait PueueBackend: Send + Sync {
    async fn status(&self) -> Result<serde_json::Value>;
    async fn logs(&self, task_id: usize, lines: Option<usize>) -> Result<serde_json::Value>;
    async fn action(&self, task_id: usize, action: &str) -> Result<serde_json::Value>;
}

#[derive(Clone)]
pub struct AppState {
    backend: Arc<dyn PueueBackend>,
}

pub fn create_app(backend: Arc<dyn PueueBackend>) -> tide::Server<AppState> {
    let mut app = tide::with_state(AppState { backend });
    app.at("/health").get(health_handler);
    app.at("/status").get(status_handler);
    app.at("/logs/:id").get(logs_handler);
    app.at("/task/:id").post(task_action_handler);
    app
}

async fn health_handler(_: Request<AppState>) -> tide::Result {
    Ok(Response::new(StatusCode::Ok))
}

async fn status_handler(req: Request<AppState>) -> tide::Result {
    match req.state().backend.status().await {
        Ok(status) => json_response(
            StatusCode::Ok,
            json!({
                "ok": true,
                "status": status,
            }),
        ),
        Err(error) => json_response(
            StatusCode::InternalServerError,
            json!({
                "ok": false,
                "error": error.to_string(),
            }),
        ),
    }
}

#[derive(Deserialize)]
struct TaskActionRequest {
    action: String,
}

async fn task_action_handler(mut req: Request<AppState>) -> tide::Result {
    let task_id = parse_task_id(&req)?;
    let body: TaskActionRequest = req.body_json().await.map_err(|_| {
        tide::Error::from_str(StatusCode::BadRequest, "Invalid JSON body")
    })?;

    match req.state().backend.action(task_id, &body.action).await {
        Ok(result) => json_response(
            StatusCode::Ok,
            json!({
                "ok": true,
                "result": result,
            }),
        ),
        Err(error) => json_response(
            StatusCode::InternalServerError,
            json!({
                "ok": false,
                "error": error.to_string(),
            }),
        ),
    }
}

async fn logs_handler(req: Request<AppState>) -> tide::Result {
    let task_id = parse_task_id(&req)?;
    let lines = req
        .url()
        .query_pairs()
        .find(|(key, _)| key == "lines")
        .and_then(|(_, value)| value.parse::<usize>().ok());

    match req.state().backend.logs(task_id, lines).await {
        Ok(logs) => json_response(
            StatusCode::Ok,
            json!({
                "ok": true,
                "log": logs,
            }),
        ),
        Err(error) => json_response(
            StatusCode::InternalServerError,
            json!({
                "ok": false,
                "error": error.to_string(),
            }),
        ),
    }
}

fn parse_task_id(req: &Request<AppState>) -> tide::Result<usize> {
    let id: String = req.param("id")?.to_string();
    id.parse::<usize>().map_err(|_| {
        tide::Error::from_str(StatusCode::BadRequest, "Invalid task id")
    })
}

fn json_response(status: StatusCode, value: serde_json::Value) -> tide::Result<Response> {
    let mut response = Response::new(status);
    response.set_body(tide::Body::from_json(&value)?);
    response.set_content_type(mime::JSON);
    Ok(response)
}
