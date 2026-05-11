//! External agent IPC commands.

use crate::core::external_agent::{
    build_external_agent_setup_info,
    configure_codex_agent_runtime as configure_codex_agent_runtime_core,
    start_codex_login as start_codex_login_core, CodexAgentLoginResult,
    ConfigureCodexAgentRuntimeInput, ConfigureCodexAgentRuntimeResult,
    ConsumeExternalAgentApprovalTokenInput, CreateExternalAgentApprovalTokenInput,
    ExternalAgentApprovalTokenGrant, ExternalAgentApprovalTokenValidation, ExternalAgentSetupInfo,
    ExternalAgentSetupInfoInput, RevokeExternalAgentApprovalTokenInput,
    RevokeExternalAgentApprovalTokenResult,
};
use crate::AppState;
use tauri::State;

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
