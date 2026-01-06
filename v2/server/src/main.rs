use std::sync::Arc;

use anyhow::Result;
use env_logger::Env;

use pueue_webui_v2_server::create_app;
use pueue_webui_v2_server::pueue_backend::RealBackend;

#[async_std::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(Env::default().default_filter_or("info")).init();

    let backend = Arc::new(RealBackend::new()?);
    let app = create_app(backend);

    let host = std::env::var("PUEUE_WEBUI_HOST").unwrap_or_else(|_| "127.0.0.1:9093".to_string());
    app.listen(host).await?;
    Ok(())
}
