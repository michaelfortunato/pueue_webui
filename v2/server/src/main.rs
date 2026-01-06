use std::fs::File;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use daemonize::Daemonize;
use env_logger::Env;

use pueue_webui_v2_server::create_app;
use pueue_webui_v2_server::pueue_backend::RealBackend;

fn main() -> Result<()> {
    let args = Args::from_env();
    if args.daemonize {
        let pid_path = args
            .pid_file
            .clone()
            .unwrap_or_else(|| PathBuf::from("/tmp/pueue-webui.pid"));
        let stdout = File::create("/tmp/pueue-webui.out")?;
        let stderr = File::create("/tmp/pueue-webui.err")?;
        let daemon = Daemonize::new()
            .pid_file(pid_path)
            .stdout(stdout)
            .stderr(stderr);
        daemon.start()?;
    }

    env_logger::Builder::from_env(Env::default().default_filter_or("info")).init();

    let backend = Arc::new(RealBackend::new()?);
    let app = create_app(backend);

    let host = args
        .host
        .or_else(|| std::env::var("PUEUE_WEBUI_HOST").ok())
        .unwrap_or_else(|| "127.0.0.1:9093".to_string());
    async_std::task::block_on(async {
        app.listen(host).await
    })?;
    Ok(())
}

#[derive(Default)]
struct Args {
    daemonize: bool,
    host: Option<String>,
    pid_file: Option<PathBuf>,
}

impl Args {
    fn from_env() -> Self {
        let mut args = Args::default();
        let mut iter = std::env::args().skip(1);
        while let Some(arg) = iter.next() {
            match arg.as_str() {
                "--daemonize" => args.daemonize = true,
                "--host" => {
                    if let Some(value) = iter.next() {
                        args.host = Some(value);
                    }
                }
                "--pid-file" => {
                    if let Some(value) = iter.next() {
                        args.pid_file = Some(PathBuf::from(value));
                    }
                }
                _ => {}
            }
        }
        args
    }
}
