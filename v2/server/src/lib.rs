use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tide::http::mime;
use tide::{Request, Response, StatusCode};

pub mod pueue_backend;
use pueue_lib::settings::Settings;

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
    app.at("/config/callback")
        .get(callback_get_handler)
        .post(callback_update_handler);
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
                        "digest": entry.digest.clone(),
                    }),
                );
            }
        }
    }

    match req.state().backend.status().await {
        Ok(status) => {
            let (stats, digest) = compute_group_stats(&status);
            if let Ok(mut cache) = req.state().status_cache.lock() {
                cache.value = Some(StatusCacheEntry {
                    at: Instant::now(),
                    payload: status.clone(),
                    stats: stats.clone(),
                    digest: digest.clone(),
                });
            }
            json_response(
                StatusCode::Ok,
                json!({
                    "ok": true,
                    "status": status,
                    "stats": stats,
                    "digest": digest,
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
struct CallbackConfigRequest {
    callback: Option<String>,
    callback_log_lines: Option<usize>,
}

async fn callback_get_handler(_: Request<AppState>) -> tide::Result {
    let config_path = config_path_override();
    let (settings, found) = Settings::read(&config_path)
        .map_err(|err| tide::Error::from_str(StatusCode::InternalServerError, err.to_string()))?;

    json_response(
        StatusCode::Ok,
        json!({
            "ok": true,
            "config": {
                "callback": settings.daemon.callback,
                "callback_log_lines": settings.daemon.callback_log_lines,
                "found": found,
                "config_path": config_path.as_ref().map(|path| path.display().to_string()),
            }
        }),
    )
}

async fn callback_update_handler(mut req: Request<AppState>) -> tide::Result {
    let config_path = config_path_override();
    let body: CallbackConfigRequest = req.body_json().await.map_err(|_| {
        tide::Error::from_str(StatusCode::BadRequest, "Invalid JSON body")
    })?;

    let (mut settings, _found) = Settings::read(&config_path)
        .map_err(|err| tide::Error::from_str(StatusCode::InternalServerError, err.to_string()))?;

    if let Some(callback) = body.callback {
        let trimmed = callback.trim().to_string();
        if trimmed.is_empty() {
            settings.daemon.callback = None;
        } else {
            settings.daemon.callback = Some(trimmed);
        }
    }

    if let Some(lines) = body.callback_log_lines {
        settings.daemon.callback_log_lines = lines;
    }

    settings
        .save(&config_path)
        .map_err(|err| tide::Error::from_str(StatusCode::InternalServerError, err.to_string()))?;

    json_response(
        StatusCode::Ok,
        json!({
            "ok": true,
            "config": {
                "callback": settings.daemon.callback,
                "callback_log_lines": settings.daemon.callback_log_lines,
                "config_path": config_path.as_ref().map(|path| path.display().to_string()),
            }
        }),
    )
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

fn config_path_override() -> Option<PathBuf> {
    std::env::var("PUEUE_CONFIG").ok().map(PathBuf::from)
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

fn compute_group_stats(status: &serde_json::Value) -> (serde_json::Value, String) {
    #[derive(Default)]
    struct GroupStats {
        total: u64,
        running: u64,
        queued: u64,
        paused: u64,
        done: u64,
        success: u64,
        failed: u64,
        durations: Vec<f64>,
        failed_ids: Vec<String>,
    }

    let mut stats: HashMap<String, GroupStats> = HashMap::new();
    if let Some(groups) = status.get("groups").and_then(|v| v.as_object()) {
        for name in groups.keys() {
            stats.entry(name.clone()).or_default();
        }
    }
    let empty_tasks = serde_json::Map::new();
    let tasks = status
        .get("tasks")
        .and_then(|value| value.as_object())
        .unwrap_or(&empty_tasks);
    let mut task_keys: Vec<&String> = tasks.keys().collect();
    task_keys.sort();

    let mut hash: u64 = 5381;
    let mut task_count: u64 = 0;

    for id in task_keys {
        let Some(task) = tasks.get(id) else { continue };
        task_count += 1;
        hash_str(&mut hash, id);
        let group = task.get("group").and_then(|v| v.as_str()).unwrap_or("default");
        let entry = stats.entry(group.to_string()).or_default();
        entry.total += 1;

        if let Some(command) = task.get("command") {
            match command {
                serde_json::Value::String(text) => hash_str(&mut hash, text),
                serde_json::Value::Array(items) => {
                    for item in items {
                        if let Some(text) = item.as_str() {
                            hash_str(&mut hash, text);
                            hash_str(&mut hash, "|");
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(label) = task.get("label").and_then(|v| v.as_str()) {
            hash_str(&mut hash, label);
        }
        if let Some(path) = task.get("path").and_then(|v| v.as_str()) {
            hash_str(&mut hash, path);
        }
        if let Some(priority) = task.get("priority") {
            hash_str(&mut hash, &priority.to_string());
        }
        if let Some(group_name) = task.get("group").and_then(|v| v.as_str()) {
            hash_str(&mut hash, group_name);
        }

        if let Some(status_obj) = task.get("status").and_then(|v| v.as_object()) {
            if let Some((key, detail)) = status_obj.iter().next() {
                hash_str(&mut hash, key);
                if let Some(detail_obj) = detail.as_object() {
                    for field in ["start", "end", "enqueued_at", "result"] {
                        if let Some(text) = detail_obj.get(field).and_then(|v| v.as_str()) {
                            hash_str(&mut hash, text);
                        }
                    }
                }
                match key.as_str() {
                    "Running" => {
                        entry.running += 1;
                    }
                    "Queued" => {
                        entry.queued += 1;
                    }
                    "Paused" => {
                        entry.paused += 1;
                    }
                    "Done" => {
                        entry.done += 1;
                        let result = detail.get("result").and_then(|v| v.as_str()).unwrap_or("Unknown");
                        if result == "Success" {
                            entry.success += 1;
                        } else {
                            entry.failed += 1;
                            entry.failed_ids.push(id.clone());
                        }
                        let start = detail.get("start").and_then(|v| v.as_str());
                        let end = detail.get("end").and_then(|v| v.as_str());
                        if let (Some(start), Some(end)) = (start, end) {
                            if let (Ok(start_ms), Ok(end_ms)) = (
                                chrono::DateTime::parse_from_rfc3339(start),
                                chrono::DateTime::parse_from_rfc3339(end),
                            ) {
                                let duration = (end_ms.timestamp_millis() - start_ms.timestamp_millis()) as f64;
                                entry.durations.push(duration);
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
        let nums = &entry.durations;
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
        let parallel = status
            .get("groups")
            .and_then(|v| v.as_object())
            .and_then(|g| g.get(&group))
            .and_then(|v| v.get("parallel_tasks"))
            .and_then(|v| v.as_u64());
        final_stats.insert(
            group,
            json!({
                "total": entry.total,
                "running": entry.running,
                "queued": entry.queued,
                "paused": entry.paused,
                "done": entry.done,
                "success": entry.success,
                "failed": entry.failed,
                "failed_ids": entry.failed_ids,
                "avg_ms": avg,
                "stddev_ms": stddev,
                "parallel": parallel,
            }),
        );
    }

    if let Some(groups) = status.get("groups").and_then(|v| v.as_object()) {
        let mut group_keys: Vec<&String> = groups.keys().collect();
        group_keys.sort();
        for name in group_keys {
            if let Some(group) = groups.get(name).and_then(|v| v.as_object()) {
                hash_str(&mut hash, name);
                if let Some(parallel) = group.get("parallel_tasks") {
                    hash_str(&mut hash, &parallel.to_string());
                }
                if let Some(state) = group.get("status").and_then(|v| v.as_str()) {
                    hash_str(&mut hash, state);
                }
            }
        }
    }

    (json!({ "groups": final_stats }), format!("{}:{}", hash, task_count))
}

fn hash_str(hash: &mut u64, value: &str) {
    for byte in value.as_bytes() {
        *hash = hash.wrapping_mul(33) ^ (u64::from(*byte));
    }
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
    digest: String,
}
