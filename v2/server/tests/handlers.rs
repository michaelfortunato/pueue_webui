use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use tide::http::{Method, Request as HttpRequest, Url};

use pueue_webui_v2_server::{create_app, AddTaskRequest, PueueBackend};

#[derive(Default)]
struct FakeBackend {
    last_action: Mutex<Option<(usize, String)>>,
    last_add: Mutex<Option<AddTaskRequest>>,
}

#[async_trait]
impl PueueBackend for FakeBackend {
    async fn status(&self) -> anyhow::Result<serde_json::Value> {
        Ok(json!({"tasks": {"1": {"status": "Running", "command": "echo hi"}}}))
    }

    async fn logs(&self, task_id: usize, lines: Option<usize>) -> anyhow::Result<serde_json::Value> {
        Ok(json!({
            "task_id": task_id,
            "lines": lines,
            "stdout": "hello",
            "stderr": "",
        }))
    }

    async fn action(&self, task_id: usize, action: &str) -> anyhow::Result<serde_json::Value> {
        let mut guard = self.last_action.lock().unwrap();
        *guard = Some((task_id, action.to_string()));
        Ok(json!({"message": "ok"}))
    }

    async fn add_task(&self, request: AddTaskRequest) -> anyhow::Result<serde_json::Value> {
        let mut guard = self.last_add.lock().unwrap();
        *guard = Some(request);
        Ok(json!({"message": "added"}))
    }
}

#[async_std::test]
async fn status_endpoint_returns_payload() -> tide::Result<()> {
    let app = create_app(Arc::new(FakeBackend::default()));
    let req = HttpRequest::new(Method::Get, Url::parse("http://localhost/status")?);
    let mut res: tide::http::Response = app.respond(req).await?;
    let body: serde_json::Value = res.body_json().await?;

    assert!(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    assert!(body.get("status").is_some());
    Ok(())
}

#[async_std::test]
async fn logs_endpoint_accepts_query() -> tide::Result<()> {
    let app = create_app(Arc::new(FakeBackend::default()));
    let req = HttpRequest::new(Method::Get, Url::parse("http://localhost/logs/7?lines=25")?);
    let mut res: tide::http::Response = app.respond(req).await?;
    let body: serde_json::Value = res.body_json().await?;

    assert!(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    assert_eq!(body.pointer("/log/task_id").and_then(|v| v.as_u64()), Some(7));
    assert_eq!(body.pointer("/log/lines").and_then(|v| v.as_u64()), Some(25));
    Ok(())
}

#[async_std::test]
async fn task_action_records_action() -> tide::Result<()> {
    let backend = Arc::new(FakeBackend::default());
    let app = create_app(backend.clone());

    let mut req = HttpRequest::new(Method::Post, Url::parse("http://localhost/task/3")?);
    req.set_body(json!({"action": "pause"}).to_string());
    req.insert_header("Content-Type", "application/json");

    let mut res: tide::http::Response = app.respond(req).await?;
    let body: serde_json::Value = res.body_json().await?;

    assert!(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));

    let recorded = backend.last_action.lock().unwrap().clone();
    assert_eq!(recorded, Some((3, "pause".to_string())));
    Ok(())
}

#[async_std::test]
async fn add_task_records_request() -> tide::Result<()> {
    let backend = Arc::new(FakeBackend::default());
    let app = create_app(backend.clone());

    let mut req = HttpRequest::new(Method::Post, Url::parse("http://localhost/tasks")?);
    req.set_body(json!({"command": "echo hi", "group": "default"}).to_string());
    req.insert_header("Content-Type", "application/json");

    let mut res: tide::http::Response = app.respond(req).await?;
    let body: serde_json::Value = res.body_json().await?;

    assert!(body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    let recorded = backend.last_add.lock().unwrap().clone();
    assert!(recorded.is_some());
    Ok(())
}

#[async_std::test]
async fn health_endpoint_is_ok() -> tide::Result<()> {
    let app = create_app(Arc::new(FakeBackend::default()));
    let req = HttpRequest::new(Method::Get, Url::parse("http://localhost/health")?);
    let res: tide::http::Response = app.respond(req).await?;
    assert_eq!(res.status(), 200);
    Ok(())
}

#[async_std::test]
async fn task_action_requires_body() -> tide::Result<()> {
    let app = create_app(Arc::new(FakeBackend::default()));
    let req = HttpRequest::new(Method::Post, Url::parse("http://localhost/task/3")?);
    let res: tide::http::Response = app.respond(req).await?;
    assert_eq!(res.status(), 400);
    Ok(())
}

#[async_std::test]
async fn task_action_requires_numeric_id() -> tide::Result<()> {
    let app = create_app(Arc::new(FakeBackend::default()));
    let req = HttpRequest::new(Method::Post, Url::parse("http://localhost/task/abc")?);
    let res: tide::http::Response = app.respond(req).await?;
    assert_eq!(res.status(), 400);
    Ok(())
}
