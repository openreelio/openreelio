//! Claude Code external-agent status and lifecycle IPC commands.

use std::sync::Arc;

use crate::core::claude_agent::{
    configure_claude_agent_runtime as configure_claude_agent_runtime_core,
    install_claude_cli as install_claude_cli_core,
    logout_claude_agent_runtime as logout_claude_agent_runtime_core, manual_setup_token_command,
    start_claude_login as start_claude_login_core, update_claude_cli as update_claude_cli_core,
    ClaudeAgentLogoutResult, ClaudeCliInstallResult, ClaudeCliUpdateResult,
    ConfigureClaudeAgentRuntimeInput, ConfigureClaudeAgentRuntimeResult, GetClaudeStatusInput,
    StartClaudeLoginInput, StartClaudeLoginResult,
};
use crate::core::claude_code::{
    claude_login_pty_env, managed_claude_config_dir, probe_claude_status_with_auth_mode,
    resolve_native_claude_executable, ClaudeStatusProbeResult,
};
use crate::core::claude_login_pty::{
    claude_login_event_name, open_login_pty, start_login_reader, ClaudeLoginSessionHandle,
    ClaudeLoginSessionStartResult,
};
use crate::AppState;
use tauri::{Manager, State};
use uuid::Uuid;

use super::claude_headless::shutdown_all_claude_headless_sessions;
use super::external_agent::{runtime_install_progress_emitter, RuntimeInstallGuard};

/// Probes the local Claude Code CLI for install and authentication state.
///
/// `input.authMode`, when supplied, overrides the persisted global auth mode for
/// this probe so a status check issued right after a UI subscription↔api-key
/// switch is evaluated against the mode the user just selected (not the stale
/// debounced-save global). The argument is optional for wire compatibility.
#[tauri::command]
#[specta::specta]
pub async fn get_claude_status(
    input: Option<GetClaudeStatusInput>,
) -> Result<ClaudeStatusProbeResult, String> {
    let auth_mode = input.and_then(|input| input.auth_mode);
    Ok(probe_claude_status_with_auth_mode(auth_mode.as_deref()).await)
}

/// Reports Claude Code runtime readiness (installed + authenticated).
#[tauri::command]
#[specta::specta]
pub async fn configure_claude_agent_runtime(
    input: ConfigureClaudeAgentRuntimeInput,
) -> Result<ConfigureClaudeAgentRuntimeResult, String> {
    Ok(configure_claude_agent_runtime_core(input).await)
}

/// Starts a Claude Code login flow (`api-key`, `subscription`, or `oauth-token`).
#[tauri::command]
#[specta::specta]
pub async fn start_claude_login(
    input: StartClaudeLoginInput,
) -> Result<StartClaudeLoginResult, String> {
    Ok(start_claude_login_core(input).await)
}

/// Signs out of the managed Claude profile and clears stored credentials.
///
/// Also tears down any running headless sessions first so no child keeps using
/// the credentials that are about to be cleared.
#[tauri::command]
#[specta::specta]
pub async fn logout_claude_agent_runtime(
    state: State<'_, AppState>,
) -> Result<ClaudeAgentLogoutResult, String> {
    shutdown_all_claude_headless_sessions(&state).await;
    Ok(logout_claude_agent_runtime_core().await)
}

/// Installs the OpenReelio-managed Claude Code CLI as a pinned native binary.
///
/// Tears down any running headless sessions first so no child keeps the old
/// binary open while it is replaced.
#[tauri::command]
#[specta::specta]
pub async fn install_claude_cli(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaudeCliInstallResult, String> {
    let _install_guard = RuntimeInstallGuard::acquire(&state, "claude")?;
    shutdown_all_claude_headless_sessions(&state).await;
    Ok(install_claude_cli_core(runtime_install_progress_emitter(app)).await)
}

/// Updates the OpenReelio-managed Claude Code CLI to the latest native binary.
#[tauri::command]
#[specta::specta]
pub async fn update_claude_cli(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaudeCliUpdateResult, String> {
    let _install_guard = RuntimeInstallGuard::acquire(&state, "claude")?;
    shutdown_all_claude_headless_sessions(&state).await;
    Ok(update_claude_cli_core(runtime_install_progress_emitter(app)).await)
}

/// Normalizes an optional caller-provided login session id, generating a UUID
/// when absent so the client can predict the stream event name and subscribe
/// before the process emits.
fn normalize_login_session_id(session_id: Option<String>) -> String {
    session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// Starts a fully in-app Claude subscription sign-in.
///
/// Spawns `claude setup-token` under a pseudo-terminal (ConPTY on Windows, which
/// creates no visible window) so the Ink UI renders and opens the browser
/// itself. Login progress — browser opening, a fallback URL, the paste-code
/// prompt, and completion — is streamed on `claude:login:{sessionId}`. The
/// resulting OAuth token is captured and persisted server-side; it never travels
/// over the event channel.
///
/// On ConPTY spawn failure the error message includes the exact manual
/// `setup-token` command so the user can fall back to the paste-a-token path.
#[tauri::command]
#[specta::specta]
pub async fn start_claude_login_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<ClaudeLoginSessionStartResult, String> {
    let session_id = normalize_login_session_id(session_id);
    let event_name = claude_login_event_name(&session_id);

    {
        let sessions = state.claude_login_sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Err(format!(
                "Claude login session {session_id} is already running"
            ));
        }
    }

    let config_display = managed_claude_config_dir().display().to_string();

    let Some(executable) = resolve_native_claude_executable() else {
        let manual = manual_setup_token_command(&config_display, "claude");
        return Err(format!(
            "Claude Code was not found, so in-app sign-in could not start. Install Claude Code, \
             or run this command manually and paste the printed token:\n{manual}"
        ));
    };

    let env = claude_login_pty_env()?;

    let (handle, reader) = match open_login_pty(executable.clone(), env) {
        Ok(pair) => pair,
        Err(error) => {
            let manual =
                manual_setup_token_command(&config_display, &executable.display().to_string());
            return Err(format!(
                "{error}\n\nIf this keeps happening, run this command manually and paste the \
                 printed token:\n{manual}"
            ));
        }
    };

    {
        let mut sessions = state.claude_login_sessions.lock().await;
        // Guard against a race that inserted a session between the checks above.
        if sessions.contains_key(&session_id) {
            drop(sessions);
            let _ = handle.terminate();
            return Err(format!(
                "Claude login session {session_id} is already running"
            ));
        }
        sessions.insert(session_id.clone(), Arc::clone(&handle));
    }

    // Drop the session from the map when the reader thread ends (natural exit,
    // token capture, or error). Defined here so the AppState reference stays out
    // of the Tauri-free core module.
    let finalize_app = app.clone();
    let finalize_id = session_id.clone();
    let on_finished = move || {
        tauri::async_runtime::block_on(async move {
            let state = finalize_app.state::<AppState>();
            state
                .claude_login_sessions
                .lock()
                .await
                .remove(&finalize_id);
        });
    };

    if let Err(error) = start_login_reader(
        app.clone(),
        session_id.clone(),
        event_name.clone(),
        Arc::clone(&handle),
        reader,
        on_finished,
    ) {
        state.claude_login_sessions.lock().await.remove(&session_id);
        let _ = handle.terminate();
        return Err(error);
    }

    Ok(ClaudeLoginSessionStartResult {
        session_id,
        event_name,
    })
}

/// Submits the authorization code pasted by the user to a running login session.
#[tauri::command]
#[specta::specta]
pub async fn submit_claude_login_code(
    state: State<'_, AppState>,
    session_id: String,
    code: String,
) -> Result<(), String> {
    let handle = {
        let sessions = state.claude_login_sessions.lock().await;
        sessions
            .get(session_id.trim())
            .cloned()
            .ok_or_else(|| format!("Claude login session {session_id} is not running"))?
    };

    tokio::task::spawn_blocking(move || handle.submit_code(&code))
        .await
        .map_err(|error| format!("Claude login code task failed: {error}"))?
}

/// Cancels a running login session, killing its child process.
#[tauri::command]
#[specta::specta]
pub async fn cancel_claude_login_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let mut sessions = state.claude_login_sessions.lock().await;
        sessions.remove(session_id.trim())
    };

    if let Some(handle) = handle {
        tokio::task::spawn_blocking(move || handle.terminate())
            .await
            .map_err(|error| format!("Claude login cancel task failed: {error}"))??;
    }

    Ok(())
}

/// Terminates all in-app Claude login sessions (used during app shutdown).
pub async fn shutdown_all_claude_login_sessions(state: &AppState) {
    let handles: Vec<Arc<ClaudeLoginSessionHandle>> = {
        let mut sessions = state.claude_login_sessions.lock().await;
        sessions.drain().map(|(_, handle)| handle).collect()
    };

    for handle in handles {
        if let Err(error) = handle.terminate() {
            tracing::warn!("Failed to terminate Claude login session during cleanup: {error}");
        }
    }
}
