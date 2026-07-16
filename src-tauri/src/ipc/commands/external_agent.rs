//! External agent IPC commands.

use std::sync::Arc;

use crate::core::codex_login::{
    codex_login_event_name, spawn_codex_login_process, start_codex_login_reader,
    CodexLoginSessionHandle, CodexLoginSessionStartResult,
};
use crate::core::external_agent::{
    build_external_agent_setup_info,
    configure_codex_agent_runtime as configure_codex_agent_runtime_core,
    install_codex_cli as install_codex_cli_core,
    logout_codex_agent_runtime as logout_codex_agent_runtime_core,
    start_codex_login as start_codex_login_core, update_codex_cli as update_codex_cli_core,
    CodexAgentLoginResult, CodexAgentLogoutResult, CodexCliInstallResult, CodexCliUpdateResult,
    ConfigureCodexAgentRuntimeInput, ConfigureCodexAgentRuntimeResult,
    ConsumeExternalAgentApprovalTokenInput, CreateExternalAgentApprovalTokenInput,
    ExternalAgentApprovalTokenGrant, ExternalAgentApprovalTokenValidation, ExternalAgentSetupInfo,
    ExternalAgentSetupInfoInput, RevokeExternalAgentApprovalTokenInput,
    RevokeExternalAgentApprovalTokenResult,
};
use crate::AppState;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use super::codex_app_server::shutdown_all_codex_app_servers;

/// Tauri event name for managed external-runtime install progress.
pub(super) const RUNTIME_INSTALL_PROGRESS_EVENT: &str = "external-runtime:install-progress";

/// Progress payload emitted while a managed runtime (codex/claude) installs.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeInstallProgressPayload {
    /// Runtime id (`"codex"` / `"claude"`).
    pub runtime_id: String,
    /// Bytes downloaded so far.
    pub downloaded_bytes: u64,
    /// Total bytes, when known.
    pub total_bytes: Option<u64>,
    /// Download completion percentage in `[0, 100]`, when known.
    pub percent: Option<f64>,
    /// Install stage (`preparing|downloading|verifying|installing|complete`).
    pub stage: String,
}

/// RAII guard ensuring only one install/update runs per managed runtime id.
///
/// Acquisition inserts the runtime id into [`AppState::runtime_install_locks`];
/// `Drop` removes it on every exit path (success, error, or early return). A
/// second concurrent install/update of the SAME runtime is rejected, while
/// different runtimes (codex vs claude) may install in parallel.
pub(super) struct RuntimeInstallGuard<'a> {
    state: &'a AppState,
    runtime_id: &'static str,
}

impl<'a> RuntimeInstallGuard<'a> {
    /// Acquires the install lock for `runtime_id`, or errors if already held.
    pub(super) fn acquire(state: &'a AppState, runtime_id: &'static str) -> Result<Self, String> {
        let mut locks = state
            .runtime_install_locks
            .lock()
            .map_err(|_| "Runtime install lock is poisoned".to_string())?;
        if !locks.insert(runtime_id) {
            return Err(format!(
                "A {runtime_id} install or update is already in progress. \
                 Wait for it to finish before starting another."
            ));
        }
        Ok(Self { state, runtime_id })
    }
}

impl Drop for RuntimeInstallGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut locks) = self.state.runtime_install_locks.lock() {
            locks.remove(self.runtime_id);
        }
    }
}

/// Builds a progress callback that emits [`RUNTIME_INSTALL_PROGRESS_EVENT`].
pub(super) fn runtime_install_progress_emitter(
    app: tauri::AppHandle,
) -> impl Fn(crate::core::managed_runtime::InstallProgress) + Send + 'static {
    move |progress| {
        let payload = RuntimeInstallProgressPayload {
            runtime_id: progress.runtime_id.to_string(),
            downloaded_bytes: progress.downloaded_bytes,
            total_bytes: progress.total_bytes,
            percent: progress.percent(),
            stage: progress.stage.as_str().to_string(),
        };
        if let Err(error) = app.emit(RUNTIME_INSTALL_PROGRESS_EVENT, payload) {
            tracing::debug!("Failed to emit runtime install progress: {error}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create_external_agent_approval_token(
    state: State<'_, AppState>,
    input: CreateExternalAgentApprovalTokenInput,
) -> Result<ExternalAgentApprovalTokenGrant, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut token_store = state.external_agent_approval_tokens.lock().await;
    token_store.issue(input, now_ms)
}

#[tauri::command]
#[specta::specta]
pub async fn get_external_agent_setup_info(
    input: ExternalAgentSetupInfoInput,
) -> Result<ExternalAgentSetupInfo, String> {
    Ok(build_external_agent_setup_info(input))
}

#[tauri::command]
#[specta::specta]
pub async fn configure_codex_agent_runtime(
    input: ConfigureCodexAgentRuntimeInput,
) -> Result<ConfigureCodexAgentRuntimeResult, String> {
    Ok(configure_codex_agent_runtime_core(input).await)
}

/// Legacy blocking Codex sign-in.
///
/// Retained as a non-streamed fallback: it runs `codex login` to completion and
/// only reports the outcome afterward. The visible, streamed flow is
/// [`start_codex_login_session`]; the UI uses that path.
#[tauri::command]
#[specta::specta]
pub async fn start_codex_login() -> Result<CodexAgentLoginResult, String> {
    Ok(start_codex_login_core().await)
}

/// Normalizes an optional caller-provided login session id, generating a UUID
/// when absent so the client can predict the stream event name and subscribe
/// before the process emits.
fn normalize_codex_login_session_id(session_id: Option<String>) -> String {
    session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// Starts a streamed, visible Codex sign-in.
///
/// Spawns `codex login` under the managed `CODEX_HOME` with piped stdout/stderr
/// (no PTY: the Codex CLI is pipe-friendly). Login progress — the sign-in URL,
/// the browser opening, and completion — is streamed on `codex:login:{sessionId}`.
/// The reader parses the OAuth URL, opens it with the full URL, and detects
/// completion by the process exiting followed by a re-probe of the managed
/// profile. Credentials are written into `CODEX_HOME` by the CLI and never travel
/// over the event channel.
///
/// If Codex is not installed the command errors with actionable text.
#[tauri::command]
#[specta::specta]
pub async fn start_codex_login_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<CodexLoginSessionStartResult, String> {
    let session_id = normalize_codex_login_session_id(session_id);
    let event_name = codex_login_event_name(&session_id);

    {
        let sessions = state.codex_login_sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Err(format!(
                "Codex login session {session_id} is already running"
            ));
        }
    }

    // Build the managed-CODEX_HOME `codex login` command. This resolves the
    // managed native binary, injects CODEX_HOME plus the update-disabled env, and
    // returns actionable text if Codex is not installed.
    let mut command = crate::core::codex::create_codex_command()?;
    command.arg("login");

    let (handle, stdout, stderr) = spawn_codex_login_process(command)?;

    {
        let mut sessions = state.codex_login_sessions.lock().await;
        // Guard against a race that inserted a session between the checks above.
        if sessions.contains_key(&session_id) {
            drop(sessions);
            let _ = handle.terminate().await;
            return Err(format!(
                "Codex login session {session_id} is already running"
            ));
        }
        sessions.insert(session_id.clone(), Arc::clone(&handle));
    }

    // Drop the session from the map when the reader task ends (natural exit,
    // completion, timeout, or error). Async because the removal awaits the lock.
    // Remove only OUR handle (ptr_eq): a same-id session started after a cancel
    // must not be evicted by the old reader's late finalizer.
    let finalize_app = app.clone();
    let finalize_id = session_id.clone();
    let finalize_handle = Arc::clone(&handle);
    let on_finished = move || async move {
        let state = finalize_app.state::<AppState>();
        let mut sessions = state.codex_login_sessions.lock().await;
        let is_current = sessions
            .get(&finalize_id)
            .map(|current| Arc::ptr_eq(current, &finalize_handle))
            .unwrap_or(false);
        if is_current {
            sessions.remove(&finalize_id);
        }
    };

    start_codex_login_reader(
        app.clone(),
        event_name.clone(),
        Arc::clone(&handle),
        stdout,
        stderr,
        on_finished,
    );

    Ok(CodexLoginSessionStartResult {
        session_id,
        event_name,
    })
}

/// Cancels a running streamed Codex login session, killing its child process.
#[tauri::command]
#[specta::specta]
pub async fn cancel_codex_login_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let mut sessions = state.codex_login_sessions.lock().await;
        sessions.remove(session_id.trim())
    };

    if let Some(handle) = handle {
        handle.terminate().await?;
    }

    Ok(())
}

/// Terminates all streamed Codex login sessions (used during app shutdown).
pub async fn shutdown_all_codex_login_sessions(state: &AppState) {
    let handles: Vec<Arc<CodexLoginSessionHandle>> = {
        let mut sessions = state.codex_login_sessions.lock().await;
        sessions.drain().map(|(_, handle)| handle).collect()
    };

    for handle in handles {
        if let Err(error) = handle.terminate().await {
            tracing::warn!("Failed to terminate Codex login session during cleanup: {error}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn logout_codex_agent_runtime(
    state: State<'_, AppState>,
) -> Result<CodexAgentLogoutResult, String> {
    shutdown_all_codex_app_servers(&state).await;
    Ok(logout_codex_agent_runtime_core().await)
}

#[tauri::command]
#[specta::specta]
pub async fn install_codex_cli(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<CodexCliInstallResult, String> {
    let _install_guard = RuntimeInstallGuard::acquire(&state, "codex")?;
    // Tear down any running Codex app-servers before replacing the binary.
    shutdown_all_codex_app_servers(&state).await;
    Ok(install_codex_cli_core(runtime_install_progress_emitter(app)).await)
}

#[tauri::command]
#[specta::specta]
pub async fn update_codex_cli(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<CodexCliUpdateResult, String> {
    let _install_guard = RuntimeInstallGuard::acquire(&state, "codex")?;
    shutdown_all_codex_app_servers(&state).await;
    Ok(update_codex_cli_core(runtime_install_progress_emitter(app)).await)
}

#[tauri::command]
#[specta::specta]
pub async fn consume_external_agent_approval_token(
    state: State<'_, AppState>,
    input: ConsumeExternalAgentApprovalTokenInput,
) -> Result<ExternalAgentApprovalTokenValidation, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut token_store = state.external_agent_approval_tokens.lock().await;
    Ok(token_store.consume(input, now_ms))
}

#[tauri::command]
#[specta::specta]
pub async fn revoke_external_agent_approval_token(
    state: State<'_, AppState>,
    input: RevokeExternalAgentApprovalTokenInput,
) -> Result<RevokeExternalAgentApprovalTokenResult, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut token_store = state.external_agent_approval_tokens.lock().await;
    Ok(RevokeExternalAgentApprovalTokenResult {
        revoked: token_store.revoke(&input.token, now_ms),
    })
}
