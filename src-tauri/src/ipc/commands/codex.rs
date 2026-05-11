//! Codex external agent status commands.

use crate::core::codex::{
    get_codex_model_catalog as get_codex_model_catalog_core, probe_codex_status,
    CodexModelCatalogResult, CodexStatusProbeResult,
};

#[tauri::command]
#[specta::specta]
pub async fn get_codex_status() -> Result<CodexStatusProbeResult, String> {
    Ok(probe_codex_status().await)
}

#[tauri::command]
#[specta::specta]
pub async fn get_codex_model_catalog() -> Result<CodexModelCatalogResult, String> {
    Ok(get_codex_model_catalog_core().await)
}
