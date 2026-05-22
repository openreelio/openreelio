//! Codex app-server process transport IPC commands.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use crate::core::codex_app_server::{
    codex_app_server_event_name, decode_json_rpc_line, encode_json_rpc_line,
    normalize_codex_app_server_id, CodexAppServerSessionInput, CodexAppServerStartResult,
    CodexAppServerStreamEvent, CodexAppServerWriteInput, StartCodexAppServerInput,
};
use crate::AppState;

const CODEX_APP_SERVER_MODEL_ENV_VAR: &str = "OPENREELIO_CODEX_APP_SERVER_MODEL";
const CODEX_APP_SERVER_REASONING_EFFORT_ENV_VAR: &str =
    "OPENREELIO_CODEX_APP_SERVER_REASONING_EFFORT";

pub struct CodexAppServerProcessHandle {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
}

impl CodexAppServerProcessHandle {
    fn new(stdin: ChildStdin, child: Child) -> Self {
        Self {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
        }
    }

    async fn write_message(&self, input: &CodexAppServerWriteInput) -> Result<(), String> {
        let line = encode_json_rpc_line(&input.message)?;
        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| "Codex app-server stdin is closed".to_string())?;
        stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("Failed to write Codex app-server message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush Codex app-server stdin: {error}"))
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
            .map_err(|error| format!("Failed to inspect Codex app-server: {error}"))?
            .is_none();
        if still_running {
            child
                .kill()
                .await
                .map_err(|error| format!("Failed to stop Codex app-server: {error}"))?;
        }
        let _ = child.wait().await;
        child_guard.take();
        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn start_codex_app_server(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    input: StartCodexAppServerInput,
) -> Result<CodexAppServerStartResult, String> {
    let server_id = normalize_codex_app_server_id(input.server_id)?;
    let event_name = codex_app_server_event_name(&server_id);
    let project_path = resolve_codex_app_server_project_path(input.project_path, &state).await?;
    let bridge_cwd = resolve_codex_app_server_bridge_cwd(&app)?;

    let mut sessions = state.codex_app_server_sessions.lock().await;
    if sessions.contains_key(&server_id) {
        return Err(format!("Codex app-server {server_id} is already running"));
    }

    let codex_command = crate::core::codex::codex_command_label();
    let codex_model = crate::core::codex::normalize_codex_model_for_installed_cli(
        resolve_codex_app_server_model(input.model),
    )
    .await;
    let codex_reasoning_effort = resolve_codex_app_server_reasoning_effort(input.reasoning_effort);
    let codex_log_dir = resolve_codex_app_server_log_dir(&app)?;
    let history_persistence_arg = "history.persistence=\"none\"".to_string();
    let log_dir_arg = format!(
        "log_dir={}",
        quote_toml_string(&codex_log_dir.display().to_string())
    );
    let mcp_servers_arg = "mcp_servers={}".to_string();
    let hooks_feature_arg = "features.hooks=false".to_string();
    let notify_arg = "notify=[]".to_string();
    let sandbox_mode_arg = "sandbox_mode=\"read-only\"".to_string();
    let approval_policy_arg = "approval_policy=\"on-request\"".to_string();
    let mut command = crate::core::codex::create_codex_command()?;
    command
        .arg("app-server")
        .arg("-c")
        .arg(format!("model={}", quote_toml_string(&codex_model)))
        .arg("-c")
        .arg(format!(
            "model_reasoning_effort={}",
            quote_toml_string(&codex_reasoning_effort)
        ))
        .arg("-c")
        .arg(&history_persistence_arg)
        .arg("-c")
        .arg(&log_dir_arg)
        .arg("-c")
        .arg(&mcp_servers_arg)
        .arg("-c")
        .arg(&hooks_feature_arg)
        .arg("-c")
        .arg(&notify_arg)
        .arg("-c")
        .arg(&sandbox_mode_arg)
        .arg("-c")
        .arg(&approval_policy_arg)
        .current_dir(&bridge_cwd)
        .env(
            "OPENREELIO_PROJECT_PATH",
            project_path.display().to_string(),
        )
        .env("OPENREELIO_APP_SURFACE", "tauri-desktop")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(path) = build_codex_app_server_path() {
        command.env("PATH", path);
    }

    let mut child = command.spawn().map_err(|error| {
        crate::core::codex::format_codex_io_error("Failed to start codex app-server", &error)
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open Codex app-server stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open Codex app-server stdout".to_string())?;
    let stderr = child.stderr.take();

    let handle = Arc::new(CodexAppServerProcessHandle::new(stdin, child));
    sessions.insert(server_id.clone(), handle.clone());
    drop(sessions);

    spawn_stdout_reader(
        app.clone(),
        server_id.clone(),
        event_name.clone(),
        stdout,
        handle,
    );
    if let Some(stderr) = stderr {
        spawn_stderr_reader(app, event_name.clone(), stderr);
    }

    Ok(CodexAppServerStartResult {
        server_id,
        event_name,
        command: codex_command,
        args: vec![
            "app-server".to_string(),
            "-c".to_string(),
            format!("model={}", quote_toml_string(&codex_model)),
            "-c".to_string(),
            format!(
                "model_reasoning_effort={}",
                quote_toml_string(&codex_reasoning_effort)
            ),
            "-c".to_string(),
            history_persistence_arg,
            "-c".to_string(),
            log_dir_arg,
            "-c".to_string(),
            mcp_servers_arg,
            "-c".to_string(),
            hooks_feature_arg,
            "-c".to_string(),
            notify_arg,
            "-c".to_string(),
            sandbox_mode_arg,
            "-c".to_string(),
            approval_policy_arg,
        ],
        bridge_cwd: bridge_cwd.display().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn write_codex_app_server_message(
    state: State<'_, AppState>,
    input: CodexAppServerWriteInput,
) -> Result<(), String> {
    let handle = {
        let sessions = state.codex_app_server_sessions.lock().await;
        sessions
            .get(&input.server_id)
            .cloned()
            .ok_or_else(|| format!("Codex app-server {} is not running", input.server_id))?
    };

    handle.write_message(&input).await
}

#[tauri::command]
#[specta::specta]
pub async fn stop_codex_app_server(
    state: State<'_, AppState>,
    input: CodexAppServerSessionInput,
) -> Result<(), String> {
    let handle = {
        let mut sessions = state.codex_app_server_sessions.lock().await;
        sessions.remove(&input.server_id)
    };

    if let Some(handle) = handle {
        handle.stop().await?;
    }

    Ok(())
}

pub async fn shutdown_all_codex_app_servers(state: &AppState) {
    let handles: Vec<Arc<CodexAppServerProcessHandle>> = {
        let mut sessions = state.codex_app_server_sessions.lock().await;
        sessions.drain().map(|(_, handle)| handle).collect()
    };

    for handle in handles {
        if let Err(error) = handle.stop().await {
            tracing::warn!("Failed to stop Codex app-server during cleanup: {error}");
        }
    }
}

async fn resolve_codex_app_server_project_path(
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
            "Codex app-server project path does not exist: {}",
            requested_path.display()
        ));
    }
    if !requested_path.is_dir() {
        return Err(format!(
            "Codex app-server project path is not a directory: {}",
            requested_path.display()
        ));
    }

    let canonical_requested_path = requested_path.canonicalize().map_err(|error| {
        format!("Failed to canonicalize Codex app-server project path: {error}")
    })?;

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
                "Codex app-server project path must stay inside the active project: {}",
                canonical_requested_path.display()
            ));
        }
    }

    Ok(canonical_requested_path)
}

fn resolve_codex_app_server_bridge_cwd(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bridge_cwd = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve OpenReelio app data directory: {error}"))?
        .join("codex")
        .join("bridge");
    std::fs::create_dir_all(&bridge_cwd)
        .map_err(|error| format!("Failed to create Codex app-server bridge directory: {error}"))?;
    Ok(bridge_cwd)
}

fn spawn_stdout_reader(
    app: tauri::AppHandle,
    server_id: String,
    event_name: String,
    stdout: tokio::process::ChildStdout,
    handle: Arc<CodexAppServerProcessHandle>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let event = match decode_json_rpc_line(&line) {
                        Ok(message) => CodexAppServerStreamEvent::Message { message },
                        Err(message) => CodexAppServerStreamEvent::Error { message },
                    };
                    let _ = app.emit(&event_name, event);
                }
                Ok(None) => {
                    remove_codex_app_server_session_if_current(&app, &server_id, &handle).await;
                    let _ = app.emit(
                        &event_name,
                        CodexAppServerStreamEvent::Exit { exit_code: None },
                    );
                    break;
                }
                Err(error) => {
                    remove_codex_app_server_session_if_current(&app, &server_id, &handle).await;
                    let _ = app.emit(
                        &event_name,
                        CodexAppServerStreamEvent::Error {
                            message: format!("Failed to read Codex app-server stdout: {error}"),
                        },
                    );
                    break;
                }
            }
        }

        tracing::debug!("Codex app-server stdout reader ended for {}", server_id);
    });
}

async fn remove_codex_app_server_session_if_current(
    app: &tauri::AppHandle,
    server_id: &str,
    handle: &Arc<CodexAppServerProcessHandle>,
) {
    let state = app.state::<AppState>();
    let mut sessions = state.codex_app_server_sessions.lock().await;
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
                CodexAppServerStreamEvent::Stderr { text: line },
            );
        }
    });
}

fn build_codex_app_server_path() -> Option<std::ffi::OsString> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
    let mut tool_dirs = crate::core::external_agent::bundled_tool_directories();
    tool_dirs.extend([
        repo_root.join("target").join("release"),
        repo_root.join("target").join("debug"),
    ]);
    tool_dirs.retain(|dir| dir.is_dir());

    if tool_dirs.is_empty() {
        return None;
    }

    let current_path = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(
        tool_dirs
            .into_iter()
            .chain(std::env::split_paths(&current_path)),
    )
    .ok()
}

fn resolve_codex_app_server_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve OpenReelio app data directory: {error}"))?
        .join("codex")
        .join("logs");
    std::fs::create_dir_all(&log_dir)
        .map_err(|error| format!("Failed to create Codex app-server log directory: {error}"))?;
    Ok(log_dir)
}

fn resolve_codex_app_server_model(requested_model: Option<String>) -> String {
    requested_model
        .or_else(|| std::env::var(CODEX_APP_SERVER_MODEL_ENV_VAR).ok())
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| crate::core::codex::DEFAULT_CODEX_MODEL.to_string())
}

fn resolve_codex_app_server_reasoning_effort(requested_effort: Option<String>) -> String {
    requested_effort
        .or_else(|| std::env::var(CODEX_APP_SERVER_REASONING_EFFORT_ENV_VAR).ok())
        .map(|effort| effort.trim().to_string())
        .filter(|effort| !effort.is_empty())
        .unwrap_or_else(|| crate::core::codex::DEFAULT_CODEX_REASONING_EFFORT.to_string())
}

fn quote_toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
