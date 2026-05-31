//! External agent IPC commands.

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
use tauri::State;

use super::codex_app_server::shutdown_all_codex_app_servers;

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

#[tauri::command]
#[specta::specta]
pub async fn start_codex_login() -> Result<CodexAgentLoginResult, String> {
    Ok(start_codex_login_core().await)
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
pub async fn install_codex_cli() -> Result<CodexCliInstallResult, String> {
    Ok(install_codex_cli_core().await)
}

#[tauri::command]
#[specta::specta]
pub async fn update_codex_cli() -> Result<CodexCliUpdateResult, String> {
    Ok(update_codex_cli_core().await)
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
