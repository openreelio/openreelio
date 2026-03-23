//! Effect Preset IPC Commands
//!
//! Provides IPC handlers for effect preset CRUD operations.
//! Presets are stored in {app_data}/presets/effects/ as JSON files.
//!
//! Returns `serde_json::Value` to avoid requiring specta::Type derives
//! on the nested effect model types (same pattern as copy_clip_effects).

use std::collections::HashMap;

use tauri::Manager;

use crate::core::effects::presets;
use crate::core::effects::{EffectType, Keyframe, ParamValue};

fn parse_effect_type_value(effect_type: serde_json::Value) -> Result<EffectType, String> {
    serde_json::from_value(effect_type).map_err(|e| format!("Invalid effect type: {}", e))
}

/// Saves an effect's parameters as a reusable preset.
///
/// Returns the full saved preset including generated ID and timestamps.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(name = %name))]
pub async fn save_effect_preset(
    name: String,
    description: Option<String>,
    effect_type: serde_json::Value,
    params: serde_json::Value,
    keyframes: Option<serde_json::Value>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let effect_type = parse_effect_type_value(effect_type)?;

    let params: HashMap<String, ParamValue> =
        serde_json::from_value(params).map_err(|e| format!("Invalid params: {}", e))?;

    let keyframes: HashMap<String, Vec<Keyframe>> = keyframes
        .map(|v| serde_json::from_value(v).map_err(|e| format!("Invalid keyframes: {}", e)))
        .transpose()?
        .unwrap_or_default();

    let preset = presets::save_effect_preset(
        &app_data_dir,
        name,
        description,
        effect_type,
        params,
        keyframes,
    )?;

    serde_json::to_value(preset).map_err(|e| format!("Failed to serialize preset: {}", e))
}

/// Loads a single effect preset by ID.
///
/// Returns the full preset including parameters and keyframes.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(preset_id = %preset_id))]
pub async fn load_effect_preset(
    preset_id: String,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let preset = presets::load_effect_preset(&app_data_dir, &preset_id)?;

    serde_json::to_value(preset).map_err(|e| format!("Failed to serialize preset: {}", e))
}

/// Lists all saved effect presets as lightweight summaries.
///
/// Returns presets sorted alphabetically by name.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app))]
pub async fn list_effect_presets(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let summaries = presets::list_effect_presets(&app_data_dir)?;

    serde_json::to_value(summaries).map_err(|e| format!("Failed to serialize presets: {}", e))
}

/// Deletes an effect preset by ID.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(app), fields(preset_id = %preset_id))]
pub async fn delete_effect_preset(preset_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    presets::delete_effect_preset(&app_data_dir, &preset_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_parse_builtin_effect_type_from_string_json() {
        let parsed = parse_effect_type_value(serde_json::json!("gaussian_blur")).unwrap();
        assert_eq!(parsed, EffectType::GaussianBlur);
    }

    #[test]
    fn should_parse_custom_effect_type_from_object_json() {
        let parsed =
            parse_effect_type_value(serde_json::json!({ "custom": "third_party_fx" })).unwrap();
        assert_eq!(parsed, EffectType::Custom("third_party_fx".to_string()));
    }
}
