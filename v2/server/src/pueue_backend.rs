use std::collections::BTreeMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use log::warn;
use serde_json::json;

use pueue_lib::message::{
    AddRequest, GroupRequest, KillRequest, LogRequest, PauseRequest, Request, Response,
    RestartRequest, StartRequest, TaskSelection, TaskToRestart,
};
use pueue_lib::network_blocking::socket::ConnectionSettings;
use pueue_lib::network_blocking::BlockingClient;
use pueue_lib::secret::read_shared_secret;
use pueue_lib::settings::Settings;
use pueue_lib::state::State;

use crate::{AddTaskRequest, GroupActionRequest, PueueBackend};

static CLI_FALLBACK_USED: AtomicBool = AtomicBool::new(false);

pub struct RealBackend {
    settings: Settings,
}

impl RealBackend {
    pub fn new() -> Result<Self> {
        let config_path = std::env::var("PUEUE_CONFIG")
            .ok()
            .map(std::path::PathBuf::from);
        let require_config = std::env::var("PUEUE_REQUIRE_CONFIG")
            .ok()
            .map(|value| value != "0")
            .unwrap_or(true);

        let (mut settings, found) = Settings::read(&config_path)
            .map_err(|err| anyhow!(err.to_string()))?;

        if require_config && !found {
            bail!("Couldn't find a configuration file. Did you start the daemon yet?");
        }

        apply_path_overrides(&mut settings);
        Ok(Self { settings })
    }

    async fn with_client<F, R>(&self, handler: F) -> Result<R>
    where
        F: FnOnce(&mut BlockingClient) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let settings = self.settings.clone();
        async_std::task::spawn_blocking(move || {
            let connection_settings = ConnectionSettings::try_from(settings.shared.clone())
                .map_err(|err| anyhow!(err.to_string()))?;
            let secret_path = settings.shared.shared_secret_path();
            let secret = read_shared_secret(secret_path.as_path())
                .map_err(|err| anyhow!(err.to_string()))?;
            let mut client = BlockingClient::new(connection_settings, &secret, true)
                .map_err(|err| anyhow!(err.to_string()))?;
            handler(&mut client)
        })
        .await
    }

    async fn get_state(&self) -> Result<State> {
        self.with_client(|client| {
            client.send_request(Request::Status)?;
            match client.receive_response()? {
                Response::Status(state) => Ok(*state),
                Response::Failure(text) => bail!(text),
                other => bail!("Unexpected response: {:?}", other),
            }
        })
        .await
    }

    async fn send_and_expect_success(&self, message: Request) -> Result<String> {
        self.with_client(|client| {
            client.send_request(message)?;
            match client.receive_response()? {
                Response::Success(text) => Ok(text),
                Response::Failure(text) => bail!(text),
                other => bail!("Unexpected response: {:?}", other),
            }
        })
        .await
    }

    fn map_action_request(
        &self,
        action: &str,
        task_id: usize,
        state: Option<&State>,
    ) -> Result<Request> {
        match action {
            "start" | "resume" => Ok(Request::Start(StartRequest {
                tasks: TaskSelection::TaskIds(vec![task_id]),
            })),
            "pause" => Ok(Request::Pause(PauseRequest {
                tasks: TaskSelection::TaskIds(vec![task_id]),
                wait: false,
            })),
            "kill" => Ok(Request::Kill(KillRequest {
                tasks: TaskSelection::TaskIds(vec![task_id]),
                signal: None,
            })),
            "remove" => Ok(Request::Remove(vec![task_id])),
            "restart" => {
                let state = state.context("Missing state for restart")?;
                let task = state.tasks.get(&task_id).context("Task not found")?;
                Ok(Request::Restart(RestartRequest {
                    tasks: vec![TaskToRestart {
                        task_id,
                        original_command: task.original_command.clone(),
                        path: task.path.clone(),
                        label: task.label.clone(),
                        priority: task.priority,
                    }],
                    start_immediately: true,
                    stashed: false,
                }))
            }
            _ => bail!("Unsupported action: {action}"),
        }
    }
}

#[async_trait]
impl PueueBackend for RealBackend {
    async fn status(&self) -> Result<serde_json::Value> {
        match self.get_state().await {
            Ok(state) => Ok(serde_json::to_value(state)?),
            Err(error) if cli_fallback_enabled() => {
                log_cli_fallback_once("status", &error.to_string());
                let cli_status = run_cli_json(&["status", "--json"])?;
                Ok(cli_status)
            }
            Err(error) => Err(error),
        }
    }

    async fn logs(&self, task_id: usize, lines: Option<usize>) -> Result<serde_json::Value> {
        let response = self
            .with_client(move |client| {
                client.send_request(Request::Log(LogRequest {
                    tasks: TaskSelection::TaskIds(vec![task_id]),
                    send_logs: true,
                    lines,
                }))?;
                match client.receive_response()? {
                    Response::Log(map) => Ok(log_map_to_json(map, task_id)),
                    Response::Failure(text) => bail!(text),
                    other => bail!("Unexpected response: {:?}", other),
                }
            })
            .await;

        match response {
            Ok(logs) => Ok(logs),
            Err(error) if cli_fallback_enabled() => {
                log_cli_fallback_once("logs", &error.to_string());
                run_cli_log(task_id, lines)
            }
            Err(error) => Err(error),
        }
    }

    async fn action(&self, task_id: usize, action: &str) -> Result<serde_json::Value> {
        let state = if action == "restart" {
            Some(self.get_state().await?)
        } else {
            None
        };

        match self.map_action_request(action, task_id, state.as_ref()) {
            Ok(message) => match self.send_and_expect_success(message).await {
                Ok(result) => Ok(json!({ "message": result })),
                Err(error) if cli_fallback_enabled() => {
                    log_cli_fallback_once("action", &error.to_string());
                    run_cli_action(task_id, action)
                }
                Err(error) => Err(error),
            },
            Err(error) if cli_fallback_enabled() => {
                log_cli_fallback_once("action", &error.to_string());
                run_cli_action(task_id, action)
            }
            Err(error) => Err(error),
        }
    }

    async fn add_task(&self, request: AddTaskRequest) -> Result<serde_json::Value> {
        let request_clone = request.clone();
        let command = request.command.clone();
        let group = request.group.clone().unwrap_or_else(|| "default".to_string());
        let stashed = request.stashed.unwrap_or(false);
        let start_immediately = request.start_immediately.unwrap_or(!stashed);
        let path = request
            .path
            .clone()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var("PUEUE_DEFAULT_TASK_PATH").ok().map(std::path::PathBuf::from))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| ".".into()));

        let add = AddRequest {
            command,
            path,
            envs: std::collections::HashMap::new(),
            start_immediately,
            stashed,
            group,
            enqueue_at: None,
            dependencies: Vec::new(),
            priority: request.priority,
            label: request.label.clone(),
        };

        let response = self
            .with_client(move |client| {
                client.send_request(Request::Add(add))?;
                match client.receive_response()? {
                    Response::AddedTask(added) => Ok(serde_json::to_value(added)?),
                    Response::Success(text) => Ok(json!({ "message": text })),
                    Response::Failure(text) => bail!(text),
                    other => bail!("Unexpected response: {:?}", other),
                }
            })
            .await;

        match response {
            Ok(result) => Ok(result),
            Err(error) if cli_fallback_enabled() => {
                log_cli_fallback_once("add", &error.to_string());
                run_cli_add_task(request_clone)
            }
            Err(error) => Err(error),
        }
    }

    async fn group_action(&self, request: GroupActionRequest) -> Result<serde_json::Value> {
        let name = request.name.trim().to_string();
        if name.is_empty() {
            bail!("Group name is required");
        }
        if name == "default" && request.action == "remove" {
            bail!("Default group cannot be removed");
        }

        let action = match request.action.as_str() {
            "add" => Request::Group(GroupRequest::Add {
                name,
                parallel_tasks: request.parallel_tasks,
            }),
            "remove" => Request::Group(GroupRequest::Remove(name)),
            "list" => Request::Group(GroupRequest::List),
            _ => bail!("Unsupported group action"),
        };

        match self.send_and_expect_success(action).await {
            Ok(result) => Ok(json!({ "message": result })),
            Err(error) if cli_fallback_enabled() => {
                log_cli_fallback_once("group", &error.to_string());
                run_cli_group(request)
            }
            Err(error) => Err(error),
        }
    }
}

fn log_map_to_json(
    map: BTreeMap<usize, pueue_lib::message::TaskLogResponse>,
    task_id: usize,
) -> serde_json::Value {
    let entry = map.get(&task_id);
    match entry {
        Some(log) => {
            let output = log.output.as_ref().map(decode_log_output);
            json!({
                "task": log.task,
                "output": output,
                "output_complete": log.output_complete,
            })
        }
        None => json!({}),
    }
}

fn apply_path_overrides(settings: &mut Settings) {
    if let Ok(dir) = std::env::var("PUEUE_DIRECTORY") {
        settings.shared.pueue_directory = Some(std::path::PathBuf::from(dir));
    }

    if let Ok(runtime) = std::env::var("PUEUE_RUNTIME_DIRECTORY") {
        settings.shared.runtime_directory = Some(std::path::PathBuf::from(runtime));
    }

    if let Ok(socket) = std::env::var("PUEUE_SOCKET_PATH") {
        #[cfg(not(target_os = "windows"))]
        {
            settings.shared.use_unix_socket = true;
            settings.shared.unix_socket_path = Some(std::path::PathBuf::from(socket));
        }
    }
}

fn cli_fallback_enabled() -> bool {
    std::env::var("PUEUE_CLI_FALLBACK")
        .ok()
        .map(|value| value != "0")
        .unwrap_or(true)
}

fn log_cli_fallback_once(context: &str, error: &str) {
    if CLI_FALLBACK_USED
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        warn!("CLI fallback used ({context}): {error}");
    }
}

fn pueue_bin() -> String {
    std::env::var("PUEUE_BIN").unwrap_or_else(|_| "pueue".to_string())
}

fn run_cli(args: &[&str]) -> Result<String> {
    let output = Command::new(pueue_bin()).args(args).output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        bail!(stderr.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_cli_json(args: &[&str]) -> Result<serde_json::Value> {
    let stdout = run_cli(args)?;
    let json: serde_json::Value = serde_json::from_str(&stdout)?;
    Ok(json)
}

fn run_cli_log(task_id: usize, lines: Option<usize>) -> Result<serde_json::Value> {
    let mut args = vec!["log".to_string(), "--json".to_string()];
    if let Some(lines) = lines {
        args.push("--lines".to_string());
        args.push(lines.to_string());
    }
    args.push(task_id.to_string());
    let refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    run_cli_json(&refs)
}

fn run_cli_action(task_id: usize, action: &str) -> Result<serde_json::Value> {
    let command = match action {
        "resume" => "start",
        other => other,
    };
    let id = task_id.to_string();
    let stdout = run_cli(&[command, &id])?;
    Ok(json!({ "message": stdout }))
}

fn run_cli_group(request: GroupActionRequest) -> Result<serde_json::Value> {
    let mut args = vec!["group".to_string()];
    match request.action.as_str() {
        "add" => {
            args.push("add".to_string());
            args.push(request.name);
            if let Some(parallel) = request.parallel_tasks {
                args.push("--parallel".to_string());
                args.push(parallel.to_string());
            }
        }
        "remove" => {
            args.push("remove".to_string());
            args.push(request.name);
        }
        "list" => {
            args.push("list".to_string());
        }
        _ => bail!("Unsupported group action"),
    }
    let refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    let stdout = run_cli(&refs)?;
    Ok(json!({ "message": stdout }))
}

fn run_cli_add_task(request: AddTaskRequest) -> Result<serde_json::Value> {
    let mut args = vec!["add".to_string(), request.command];
    if let Some(group) = request.group {
        args.push("--group".to_string());
        args.push(group);
    }
    if let Some(label) = request.label {
        args.push("--label".to_string());
        args.push(label);
    }
    if let Some(priority) = request.priority {
        args.push("--priority".to_string());
        args.push(priority.to_string());
    }
    if let Some(path) = request.path {
        args.push("--working-directory".to_string());
        args.push(path);
    }
    if request.stashed.unwrap_or(false) {
        args.push("--stashed".to_string());
    }
    if request.start_immediately == Some(false) {
        args.push("--start-immediately".to_string());
        args.push("false".to_string());
    }
    let refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
    let stdout = run_cli(&refs)?;
    Ok(json!({ "message": stdout }))
}

fn decode_log_output(bytes: &Vec<u8>) -> String {
    let mut decoder = snap::read::FrameDecoder::new(bytes.as_slice());
    let mut decoded = Vec::new();
    match std::io::Read::read_to_end(&mut decoder, &mut decoded) {
        Ok(_) => String::from_utf8_lossy(&decoded).to_string(),
        Err(_) => String::from_utf8_lossy(bytes).to_string(),
    }
}
