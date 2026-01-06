use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tide::http::mime;
use tide::{Request, Response, StatusCode};

pub mod pueue_backend;

#[async_trait]
pub trait PueueBackend: Send + Sync {
    async fn status(&self) -> Result<serde_json::Value>;
    async fn logs(&self, task_id: usize, lines: Option<usize>) -> Result<serde_json::Value>;
    async fn action(&self, task_id: usize, action: &str) -> Result<serde_json::Value>;
    async fn add_task(&self, request: AddTaskRequest) -> Result<serde_json::Value>;
    async fn group_action(&self, request: GroupActionRequest) -> Result<serde_json::Value>;
}

#[derive(Clone)]
pub struct AppState {
    backend: Arc<dyn PueueBackend>,
    status_cache: Arc<Mutex<StatusCache>>,
}

pub fn create_app(backend: Arc<dyn PueueBackend>) -> tide::Server<AppState> {
    let mut app = tide::with_state(AppState {
        backend,
        status_cache: Arc::new(Mutex::new(StatusCache::default())),
    });
    app.at("/health").get(health_handler);
    app.at("/status").get(status_handler);
    app.at("/logs/:id").get(logs_handler);
    app.at("/tasks").post(add_task_handler);
    app.at("/groups").post(group_handler);
    app.at("/task/:id").post(task_action_handler);
    app
}

async fn health_handler(_: Request<AppState>) -> tide::Result {
    Ok(Response::new(StatusCode::Ok))
}

async fn status_handler(req: Request<AppState>) -> tide::Result {
    const CACHE_TTL: Duration = Duration::from_millis(500);
    {
        let cache = req.state().status_cache.lock().map_err(|_| {
            tide::Error::from_str(StatusCode::InternalServerError, "Status cache lock failed")
        })?;

        if let Some(entry) = cache.value.as_ref() {
            if entry.at.elapsed() <= CACHE_TTL {
                return json_response(
                    StatusCode::Ok,
                    json!({
                        "ok": true,
                        "status": entry.payload.clone(),
                        "cached": true,
                        "stats": entry.stats.clone(),
                    }),
                );
            }
        }
    }

    match req.state().backend.status().await {
        Ok(status) => {
            let stats = compute_group_stats(&status);
            if let Ok(mut cache) = req.state().status_cache.lock() {
                cache.value = Some(StatusCacheEntry {
                    at: Instant::now(),
                    payload: status.clone(),
                    stats: stats.clone(),
                });
            }
            json_response(
                StatusCode::Ok,
                json!({
                    "ok": true,
                    "status": status,
                    "stats": stats,
                }),
            )
        }
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

#[derive(Clone, Debug, Deserialize)]
pub struct AddTaskRequest {
    pub command: String,
    pub group: Option<String>,
    pub start_immediately: Option<bool>,
    pub stashed: Option<bool>,
    pub priority: Option<i32>,
    pub label: Option<String>,
    pub path: Option<String>,
}

async fn add_task_handler(mut req: Request<AppState>) -> tide::Result {
    let body: AddTaskRequest = req.body_json().await.map_err(|_| {
        tide::Error::from_str(StatusCode::BadRequest, "Invalid JSON body")
    })?;
    if body.command.trim().is_empty() {
        return Err(tide::Error::from_str(
            StatusCode::BadRequest,
            "Missing command",
        ));
    }

    match req.state().backend.add_task(body).await {
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

#[derive(Clone, Debug, Deserialize)]
pub struct GroupActionRequest {
    pub action: String,
    pub name: String,
    pub parallel_tasks: Option<usize>,
}

async fn group_handler(mut req: Request<AppState>) -> tide::Result {
    let body: GroupActionRequest = req.body_json().await.map_err(|_| {
        tide::Error::from_str(StatusCode::BadRequest, "Invalid JSON body")
    })?;

    match req.state().backend.group_action(body).await {
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

fn json_response(status: StatusCode, value: serde_json::Value) -> tide::Result<Response> {
    let mut response = Response::new(status);
    response.set_body(tide::Body::from_json(&value)?);
    response.set_content_type(mime::JSON);
    Ok(response)
}

fn compute_group_stats(status: &serde_json::Value) -> serde_json::Value {
    let mut stats = serde_json::Map::new();
    let tasks = status
        .get("tasks")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();

    for (id, task) in tasks {
        let group = task.get("group").and_then(|v| v.as_str()).unwrap_or("default");
        let entry = stats.entry(group.to_string()).or_insert_with(|| {
            json!({
                "total": 0u64,
                "running": 0u64,
                "queued": 0u64,
                "paused": 0u64,
                "done": 0u64,
                "success": 0u64,
                "failed": 0u64,
                "durations": Vec::<f64>::new(),
                "failed_ids": Vec::<String>::new(),
            })
        });

        let total = entry.get("total").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
        entry["total"] = json!(total);

        if let Some(status_obj) = task.get("status").and_then(|v| v.as_object()) {
            if let Some((key, detail)) = status_obj.iter().next() {
                match key.as_str() {
                    "Running" => {
                        entry["running"] = json!(entry.get("running").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                    }
                    "Queued" => {
                        entry["queued"] = json!(entry.get("queued").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                    }
                    "Paused" => {
                        entry["paused"] = json!(entry.get("paused").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                    }
                    "Done" => {
                        entry["done"] = json!(entry.get("done").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                        let result = detail.get("result").and_then(|v| v.as_str()).unwrap_or("Unknown");
                        if result == "Success" {
                            entry["success"] =
                                json!(entry.get("success").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                        } else {
                            entry["failed"] =
                                json!(entry.get("failed").and_then(|v| v.as_u64()).unwrap_or(0) + 1);
                            let mut failed_ids = entry
                                .get("failed_ids")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            failed_ids.push(json!(id.clone()));
                            entry["failed_ids"] = json!(failed_ids);
                        }
                        let start = detail.get("start").and_then(|v| v.as_str());
                        let end = detail.get("end").and_then(|v| v.as_str());
                        if let (Some(start), Some(end)) = (start, end) {
                            if let (Ok(start_ms), Ok(end_ms)) = (
                                chrono::DateTime::parse_from_rfc3339(start),
                                chrono::DateTime::parse_from_rfc3339(end),
                            ) {
                                let duration = (end_ms.timestamp_millis() - start_ms.timestamp_millis()) as f64;
                                let mut durations = entry
                                    .get("durations")
                                    .and_then(|v| v.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                durations.push(json!(duration));
                                entry["durations"] = json!(durations);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let mut final_stats = serde_json::Map::new();
    for (group, entry) in stats {
        let durations = entry
            .get("durations")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let nums: Vec<f64> = durations.iter().filter_map(|v| v.as_f64()).collect();
        let avg = if nums.is_empty() {
            None
        } else {
            Some(nums.iter().sum::<f64>() / nums.len() as f64)
        };
        let stddev = if nums.len() > 1 {
            let mean = avg.unwrap_or(0.0);
            let var = nums.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (nums.len() as f64 - 1.0);
            Some(var.sqrt())
        } else {
            None
        };
        final_stats.insert(
            group,
            json!({
                "total": entry.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
                "running": entry.get("running").and_then(|v| v.as_u64()).unwrap_or(0),
                "queued": entry.get("queued").and_then(|v| v.as_u64()).unwrap_or(0),
                "paused": entry.get("paused").and_then(|v| v.as_u64()).unwrap_or(0),
                "done": entry.get("done").and_then(|v| v.as_u64()).unwrap_or(0),
                "success": entry.get("success").and_then(|v| v.as_u64()).unwrap_or(0),
                "failed": entry.get("failed").and_then(|v| v.as_u64()).unwrap_or(0),
                "failed_ids": entry.get("failed_ids").cloned().unwrap_or(json!([])),
                "avg_ms": avg,
                "stddev_ms": stddev,
            }),
        );
    }

    json!({ "groups": final_stats })
}

#[derive(Default)]
struct StatusCache {
    value: Option<StatusCacheEntry>,
}

#[derive(Clone)]
struct StatusCacheEntry {
    at: Instant,
    payload: serde_json::Value,
    stats: serde_json::Value,
}
