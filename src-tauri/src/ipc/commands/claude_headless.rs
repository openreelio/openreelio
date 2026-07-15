//! Claude Code headless (`claude -p`) process transport IPC commands.
//!
//! Mirrors [`crate::ipc::commands::codex_app_server`] for the Claude CLI. A
//! session spawns `claude -p` with the streaming JSON protocol, bridges its
//! stdout/stderr to a per-session Tauri event, and exposes stdin for follow-up
//! user turns. Built-in tools are disabled (`--tools ""`); the only tools Claude
//! can call are the OpenReelio MCP tools served by the loopback MCP server, which
//! are auto-permitted via `--allowedTools "mcp__openreelio__*"` (real approval
//! still happens inside the WebView domain executor).

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::core::claude_code::{
    normalize_claude_effort, normalize_claude_model, stored_anthropic_api_key,
    stored_claude_oauth_token, CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR,
};
use crate::core::claude_headless::{
    build_claude_headless_args, classify_headless_stdout_line, claude_headless_event_name,
    generate_mcp_bearer_token, normalize_claude_headless_id, sanitize_bridge_dir_name,
    write_mcp_config_file, ClaudeHeadlessSessionInput, ClaudeHeadlessStartResult,
    ClaudeHeadlessStreamEvent, ClaudeHeadlessWriteInput, StartClaudeHeadlessInput,
};
use crate::core::codex_app_server::encode_json_rpc_line;
use crate::ipc::openreelio_mcp::ensure_openreelio_mcp_server;
use crate::AppState;

/// Owns the child process, its stdin, and the MCP bearer token for a session.
pub struct ClaudeHeadlessProcessHandle {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    /// Bearer token registered with the loopback MCP server for this session.
    token: String,
    /// On-disk MCP config file (holds the bearer token) to clean up on teardown.
    mcp_config_path: PathBuf,
}

impl ClaudeHeadlessProcessHandle {
    fn new(stdin: ChildStdin, child: Child, token: String, mcp_config_path: PathBuf) -> Self {
        Self {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            token,
            mcp_config_path,
        }
    }

    /// Best-effort removal of the on-disk MCP config file (contains the token).
    fn cleanup_mcp_config(&self) {
        let _ = std::fs::remove_file(&self.mcp_config_path);
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let line = encode_json_rpc_line(message)?;
        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| "Claude headless stdin is closed".to_string())?;
        stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("Failed to write Claude headless message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush Claude headless stdin: {error}"))
    }

    async fn stop(&self) -> Result<(), String> {
        {
            let mut stdin_guard = self.stdin.lock().await;
            stdin_guard.take();
        }

        let mut child_guard = self.child.lock().await;
        let Some(child) = child_guard.as_mut() else {
            return Ok(());
        };

        let still_running = child
            .try_wait()
            .map_err(|error| format!("Failed to inspect Claude headless process: {error}"))?
            .is_none();
        if still_running {
            child
                .kill()
                .await
                .map_err(|error| format!("Failed to stop Claude headless process: {error}"))?;
        }
        let _ = child.wait().await;
        child_guard.take();
        self.cleanup_mcp_config();
        Ok(())
    }
}

/// Spawns a `claude -p` headless session and bridges its stream to the WebView.
///
/// Registers a loopback MCP session, writes its config (with the bearer token)
/// to a per-session file, and starts the process. The first user turn is sent by
/// the frontend afterwards via [`write_claude_headless_message`].
#[tauri::command]
#[specta::specta]
pub async fn start_claude_headless(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: StartClaudeHeadlessInput,
) -> Result<ClaudeHeadlessStartResult, String> {
    let server_id = normalize_claude_headless_id(input.server_id)?;
    let event_name = claude_headless_event_name(&server_id);
    let project_path = resolve_headless_project_path(input.project_path, &state).await?;
    let bridge_cwd = resolve_headless_bridge_cwd(&app, &server_id)?;

    {
        let sessions = state.claude_headless_sessions.lock().await;
        if sessions.contains_key(&server_id) {
            return Err(format!(
                "Claude headless session {server_id} is already running"
            ));
        }
    }

    let auth_mode = input.auth_mode.trim().to_ascii_lowercase();
    let is_api_key_mode = matches!(auth_mode.as_str(), "api-key" | "api_key" | "apikey");
    let api_key = if is_api_key_mode {
        // Resolve the key the same way the readiness probe counts it: an inline
        // key or a deliberately stored key. The process-env `ANTHROPIC_API_KEY`
        // is intentionally NOT a fallback — inheriting it would silently bill the
        // user's personal/global key and break managed-profile isolation.
        let key = input
            .api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .or_else(stored_anthropic_api_key);
        match key {
            Some(key) => Some(key),
            None => {
                return Err(
                    "api-key auth requires an Anthropic API key. Provide one inline or store it in \
                     Settings; the process environment is not used."
                        .to_string(),
                );
            }
        }
    } else {
        None
    };

    let model = normalize_claude_model(input.model);
    let effort = normalize_claude_effort(input.effort);
    let session_id = Uuid::new_v4().to_string();

    // Ensure the loopback MCP server is running and register this session.
    let mcp_server = ensure_openreelio_mcp_server(&app, &state).await?;
    let token = generate_mcp_bearer_token();
    let mcp_url = mcp_server.mcp_url();
    mcp_server
        .register_session(
            token.clone(),
            server_id.clone(),
            session_id.clone(),
            input.tools,
        )
        .await;

    // Write the MCP config (which embeds the bearer token) to a per-session file
    // and pass its path to `--mcp-config`. Passing the JSON inline would break on
    // Windows: when `claude` resolves to the npm shim `claude.cmd`, Rust >= 1.77.2
    // refuses to spawn a `.cmd`/`.bat` with any argument containing a double
    // quote (CVE-2024-24576). Writing to a file also keeps the token out of the
    // process argument list visible in system process listings.
    let mcp_config_path = bridge_cwd.join(format!(
        "mcp-config-{}.json",
        sanitize_bridge_dir_name(&server_id)
    ));
    if let Err(error) = write_mcp_config_file(&mcp_config_path, &mcp_url, &token) {
        mcp_server.deregister_token(&token).await;
        return Err(error);
    }
    let mcp_config_arg = mcp_config_path.display().to_string();
    let resume_session_id = input
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let args = build_claude_headless_args(
        &model,
        &effort,
        &mcp_config_arg,
        &session_id,
        resume_session_id,
    );

    let command_label = crate::core::claude_code::claude_command_label();
    let mut command = match crate::core::claude_code::create_claude_command() {
        Ok(command) => command,
        Err(error) => {
            mcp_server.deregister_token(&token).await;
            let _ = std::fs::remove_file(&mcp_config_path);
            return Err(error);
        }
    };
    command
        .args(&args)
        .current_dir(&bridge_cwd)
        .env(
            "OPENREELIO_PROJECT_PATH",
            project_path.display().to_string(),
        )
        .env("OPENREELIO_APP_SURFACE", "tauri-desktop")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Control auth env explicitly per mode so an api-key session always has a key
    // (and no subscription token) and a subscription session carries its stored
    // OAuth token (and never a leaked api key).
    match &api_key {
        Some(key) => {
            command.env("ANTHROPIC_API_KEY", key);
            command.env_remove(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR);
        }
        None => {
            command.env_remove("ANTHROPIC_API_KEY");
            if let Some(oauth_token) = stored_claude_oauth_token() {
                command.env(CLAUDE_CODE_OAUTH_TOKEN_ENV_VAR, oauth_token);
            }
        }
    }

    let (stdout, stderr, handle) = {
        let mut sessions = state.claude_headless_sessions.lock().await;
        if sessions.contains_key(&server_id) {
            mcp_server.deregister_token(&token).await;
            let _ = std::fs::remove_file(&mcp_config_path);
            return Err(format!(
                "Claude headless session {server_id} is already running"
            ));
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                mcp_server.deregister_token(&token).await;
                let _ = std::fs::remove_file(&mcp_config_path);
                return Err(crate::core::claude_code::format_claude_io_error(
                    "Failed to start claude headless process",
                    &error,
                ));
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open Claude headless stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open Claude headless stdout".to_string())?;
        let stderr = child.stderr.take();

        let handle = Arc::new(ClaudeHeadlessProcessHandle::new(
            stdin,
            child,
            token.clone(),
            mcp_config_path.clone(),
        ));
        sessions.insert(server_id.clone(), handle.clone());
        (stdout, stderr, handle)
    };

    spawn_stdout_reader(
        app.clone(),
        server_id.clone(),
        event_name.clone(),
        stdout,
        handle.clone(),
    );
    if let Some(stderr) = stderr {
        spawn_stderr_reader(app.clone(), event_name.clone(), stderr);
    }

    // The frontend sends the first user turn itself (via
    // `write_claude_headless_message`) once it has registered the MCP bridge, so
    // there is no post-spawn stdin write here. Seeding a prompt from the backend
    // would race the frontend's bridge registration.

    Ok(ClaudeHeadlessStartResult {
        server_id,
        event_name,
        command: command_label,
        args,
        bridge_cwd: bridge_cwd.display().to_string(),
        mcp_url,
    })
}

/// Writes one NDJSON message to a running headless session's stdin (a user turn).
#[tauri::command]
#[specta::specta]
pub async fn write_claude_headless_message(
    state: State<'_, AppState>,
    input: ClaudeHeadlessWriteInput,
) -> Result<(), String> {
    let handle = {
        let sessions = state.claude_headless_sessions.lock().await;
        sessions
            .get(&input.server_id)
            .cloned()
            .ok_or_else(|| format!("Claude headless session {} is not running", input.server_id))?
    };

    handle.write_message(&input.message).await
}

/// Stops a running headless session and cleans up its MCP registration/config.
#[tauri::command]
#[specta::specta]
pub async fn stop_claude_headless(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: ClaudeHeadlessSessionInput,
) -> Result<(), String> {
    let handle = {
        let mut sessions = state.claude_headless_sessions.lock().await;
        sessions.remove(&input.server_id)
    };

    if let Some(handle) = handle {
        deregister_headless_token(&app, &handle.token).await;
        handle.stop().await?;
    }

    Ok(())
}

/// Stops all Claude headless sessions (used during app/runtime shutdown).
pub async fn shutdown_all_claude_headless_sessions(state: &AppState) {
    let handles: Vec<Arc<ClaudeHeadlessProcessHandle>> = {
        let mut sessions = state.claude_headless_sessions.lock().await;
        sessions.drain().map(|(_, handle)| handle).collect()
    };

    let mcp_server = {
        let guard = state.openreelio_mcp.lock().await;
        guard.clone()
    };

    for handle in handles {
        if let Some(server) = mcp_server.as_ref() {
            server.deregister_token(&handle.token).await;
        }
        if let Err(error) = handle.stop().await {
            tracing::warn!("Failed to stop Claude headless session during cleanup: {error}");
        }
    }
}

async fn deregister_headless_token(app: &tauri::AppHandle, token: &str) {
    let state = app.state::<AppState>();
    let mcp_server = {
        let guard = state.openreelio_mcp.lock().await;
        guard.clone()
    };
    if let Some(server) = mcp_server {
        server.deregister_token(token).await;
    }
}

async fn resolve_headless_project_path(
    requested_project_path: Option<String>,
    state: &State<'_, AppState>,
) -> Result<PathBuf, String> {
    let requested_path = match requested_project_path {
        Some(path) => {
            let path = PathBuf::from(path);
            if path.is_absolute() {
                path
            } else {
                let guard = state.project.lock().await;
                let project = guard
                    .as_ref()
                    .ok_or_else(|| "Relative project path requires an open project".to_string())?;
                project.path.join(path)
            }
        }
        None => {
            let guard = state.project.lock().await;
            if let Some(project) = guard.as_ref() {
                project.path.clone()
            } else {
                std::env::current_dir()
                    .map_err(|error| format!("Failed to resolve current directory: {error}"))?
            }
        }
    };

    if !requested_path.exists() {
        return Err(format!(
            "Claude headless project path does not exist: {}",
            requested_path.display()
        ));
    }
    if !requested_path.is_dir() {
        return Err(format!(
            "Claude headless project path is not a directory: {}",
            requested_path.display()
        ));
    }

    let canonical_requested_path = requested_path
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize Claude headless project path: {error}"))?;

    let project_path = {
        let guard = state.project.lock().await;
        guard.as_ref().map(|project| project.path.clone())
    };

    if let Some(project_path) = project_path {
        let canonical_project = project_path
            .canonicalize()
            .map_err(|error| format!("Failed to canonicalize project directory: {error}"))?;
        if !canonical_requested_path.starts_with(&canonical_project) {
            return Err(format!(
                "Claude headless project path must stay inside the active project: {}",
                canonical_requested_path.display()
            ));
        }
    }

    Ok(canonical_requested_path)
}

fn resolve_headless_bridge_cwd(app: &tauri::AppHandle, server_id: &str) -> Result<PathBuf, String> {
    let bridge_cwd = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve OpenReelio app data directory: {error}"))?
        .join("claude")
        .join("bridge")
        .join(sanitize_bridge_dir_name(server_id));
    std::fs::create_dir_all(&bridge_cwd)
        .map_err(|error| format!("Failed to create Claude headless bridge directory: {error}"))?;
    Ok(bridge_cwd)
}

fn spawn_stdout_reader(
    app: tauri::AppHandle,
    server_id: String,
    event_name: String,
    stdout: tokio::process::ChildStdout,
    handle: Arc<ClaudeHeadlessProcessHandle>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    // A non-JSON stdout line is a benign diagnostic/warning from
                    // `claude -p --verbose`, not a transport failure; the
                    // classifier routes it to the Stderr (context-only) channel so
                    // it never kills a healthy session. `Error` below stays
                    // reserved for genuine reader I/O failures.
                    let event = classify_headless_stdout_line(&line);
                    let _ = app.emit(&event_name, event);
                }
                Ok(None) => {
                    finalize_headless_session(&app, &server_id, &handle).await;
                    let _ = app.emit(
                        &event_name,
                        ClaudeHeadlessStreamEvent::Exit { exit_code: None },
                    );
                    break;
                }
                Err(error) => {
                    finalize_headless_session(&app, &server_id, &handle).await;
                    let _ = app.emit(
                        &event_name,
                        ClaudeHeadlessStreamEvent::Error {
                            message: format!("Failed to read Claude headless stdout: {error}"),
                        },
                    );
                    break;
                }
            }
        }

        tracing::debug!("Claude headless stdout reader ended for {}", server_id);
    });
}

async fn finalize_headless_session(
    app: &tauri::AppHandle,
    server_id: &str,
    handle: &Arc<ClaudeHeadlessProcessHandle>,
) {
    deregister_headless_token(app, &handle.token).await;
    // Remove the on-disk MCP config (holds the bearer token) once the process
    // has exited on its own; `stop()` covers the explicit-teardown path.
    handle.cleanup_mcp_config();

    let state = app.state::<AppState>();
    let mut sessions = state.claude_headless_sessions.lock().await;
    let should_remove = sessions
        .get(server_id)
        .map(|current| Arc::ptr_eq(current, handle))
        .unwrap_or(false);
    if should_remove {
        sessions.remove(server_id);
    }
}

fn spawn_stderr_reader(
    app: tauri::AppHandle,
    event_name: String,
    stderr: tokio::process::ChildStderr,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit(
                &event_name,
                ClaudeHeadlessStreamEvent::Stderr { text: line },
            );
        }
    });
}

// Pure helpers (arg-vector builder, MCP config writer, bridge-dir sanitizer,
// stdout classifier) and their unit tests live in `core::claude_headless` where
// they compile under #[cfg(test)] (this commands module is #[cfg(not(test))]).
