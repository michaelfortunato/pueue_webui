# Pueue WebUI v2 (Next.js + Rust)

This version uses a Rust backend (powered by `pueue-lib`) and a Next.js UI. The Rust backend talks to the daemon via protocol first and only falls back to the CLI if that fails (and it logs once when it does).

## Quick start

Terminal 1 (Rust backend):
```bash
cd v2/server
PUEUE_CONFIG="/Users/michaelfortunato/Library/Application Support/pueue/pueue.yml" cargo run
```

Terminal 2 (Next.js UI):
```bash
cd v2
npm install
npm run dev
```

Open http://localhost:3000

## Single-command launcher
One-time setup (installs Next.js deps):
```bash
cd v2
npm install
```

Build the Rust backend once, then run:
```bash
cd v2/server
cargo build
./target/debug/pueue-gui
```

This starts the backend as a child process and runs the Next.js UI in the current terminal.
When you quit the UI (Ctrl-C), the backend is automatically stopped.

### Optional zsh helper
Add this to your `~/.zshrc`:
```zsh
pueue-gui () {
  (
    local repo="$HOME/projects/pueue_webui"
    cd "$repo/v2" || exit 1
    if [ ! -d node_modules ]; then
      npm install || exit 1
    fi
    cd "$repo/v2/server" || exit 1
    cargo build || exit 1
    ./target/debug/pueue-gui
  )
}
```

## Environment
- `PUEUE_WEBUI_HOST` (server, optional): host:port for Rust service (default `127.0.0.1:9093`)
- `PUEUE_V2_BACKEND_URL` (Next.js, optional): base URL for Rust service (default `http://127.0.0.1:9093`)
- `PUEUE_CONFIG` (server, optional): path to `pueue.yml` if not in the default location
- `PUEUE_REQUIRE_CONFIG` (server, optional): set to `0` to allow default settings without a config file
- `PUEUE_DIRECTORY` (server, optional): override pueue data directory (used for socket/secret/certs)
- `PUEUE_RUNTIME_DIRECTORY` (server, optional): override runtime dir (socket/pid)
- `PUEUE_SOCKET_PATH` (server, optional): override unix socket path directly
- `PUEUE_CLI_FALLBACK` (server, optional): set to `0` to disable CLI fallback if protocol fails
- `PUEUE_BIN` (server, optional): path to the `pueue` binary for CLI fallback
- `PUEUE_WEBUI_NO_UI` (pueue-gui, optional): set to `1` to skip launching the UI
- `PUEUE_WEBUI_SMOKE` (pueue-gui, optional): set to `1` to start backend, health-check, then exit

## Why this stack
- Accurate data: uses `pueue-lib` protocol instead of CLI parsing.
- Faster UI: lightweight API layer and polling.
- Extensible: add SSE log streaming, filters, and task details.

## UI features (v2)
- Search, filter, and sort tasks.
- Batch actions (start/pause/resume/restart/kill/remove).
- Backend offline banner with retry.

## Data exposure
The `/status` payload includes each task's environment variables as returned by the daemon. This is safe for local-only use, but do not expose the backend to untrusted networks.
