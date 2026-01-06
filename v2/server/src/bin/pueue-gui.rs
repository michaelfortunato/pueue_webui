use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

fn main() -> Result<()> {
    let mode = std::env::var("PUEUE_WEBUI_MODE").unwrap_or_else(|_| "dev".to_string());
    let host = std::env::var("PUEUE_WEBUI_HOST").unwrap_or_else(|_| "127.0.0.1:9093".to_string());
    let no_ui = std::env::var("PUEUE_WEBUI_NO_UI").ok().as_deref() == Some("1");
    let smoke = std::env::var("PUEUE_WEBUI_SMOKE").ok().as_deref() == Some("1");

    let v2_root = resolve_v2_root()?;
    let server_bin = resolve_server_bin()?;

    let mut server_cmd = Command::new(server_bin);
    server_cmd
        .arg("--host")
        .arg(&host)
        .env("PUEUE_WEBUI_HOST", &host)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if let Ok(config) = std::env::var("PUEUE_CONFIG") {
        server_cmd.env("PUEUE_CONFIG", config);
    }
    if let Ok(value) = std::env::var("PUEUE_CLI_FALLBACK") {
        server_cmd.env("PUEUE_CLI_FALLBACK", value);
    }

    let child = server_cmd.spawn().context("Failed to start backend")?;
    let child_handle = Arc::new(Mutex::new(Some(child)));

    let kill_handle = child_handle.clone();
    ctrlc::set_handler(move || {
        if let Ok(mut guard) = kill_handle.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    })
    .context("Failed to set Ctrl-C handler")?;

    if smoke {
        let status = wait_for_health(&host, Duration::from_secs(5))?;
        println!("health={status}");
        shutdown_child(child_handle);
        return Ok(());
    }

    if no_ui {
        wait_for_health(&host, Duration::from_secs(5))?;
        println!("Backend running at http://{host}");
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    let mut ui_cmd = Command::new("npm");
    ui_cmd
        .arg("run")
        .arg(match mode.as_str() {
            "start" => "start",
            _ => "dev",
        })
        .current_dir(v2_root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let ui_status = ui_cmd.status()?;
    shutdown_child(child_handle);

    if !ui_status.success() {
        bail!("UI process exited with failure.");
    }

    Ok(())
}

fn shutdown_child(handle: Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = handle.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_for_health(host: &str, timeout: Duration) -> Result<u16> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(status) = check_health(host) {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    bail!("Backend failed to start within timeout")
}

fn check_health(host: &str) -> Result<u16> {
    let addr = host
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| anyhow::anyhow!("Failed to resolve host"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(300))?;
    stream.set_read_timeout(Some(Duration::from_millis(300)))?;
    stream.set_write_timeout(Some(Duration::from_millis(300)))?;
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!("Invalid health response"))?;
    Ok(status)
}

fn resolve_v2_root() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let v2_root = exe
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .ok_or_else(|| anyhow::anyhow!("Failed to resolve v2 root"))?;
    Ok(v2_root.to_path_buf())
}

fn resolve_server_bin() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let server = exe
        .parent()
        .map(|dir| dir.join("pueue-webui-v2-server"))
        .ok_or_else(|| anyhow::anyhow!("Failed to resolve server binary"))?;
    Ok(server)
}
