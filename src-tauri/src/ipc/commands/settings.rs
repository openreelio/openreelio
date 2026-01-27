//! Settings Commands
//!
//! Tauri commands for managing application settings.
//! Settings are persisted to the user's app data directory.

use crate::core::settings::{AppSettings, SettingsManager};
use crate::ipc::dto::AppSettingsDto;

/// Gets the application data directory path.
fn get_app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

/// Gets application settings
#[tauri::command]
#[specta::specta]
pub async fn get_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.load();
    Ok(settings.into())
}

/// Saves application settings
#[tauri::command]
#[specta::specta]
pub async fn set_settings(app: tauri::AppHandle, settings: AppSettingsDto) -> Result<(), String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let app_settings: AppSettings = settings.into();
    manager.save(&app_settings).map(|_| ())
}

/// Updates a partial section of settings (merge with existing)
#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    app: tauri::AppHandle,
    partial: serde_json::Value,
) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);

    // Load current settings
    let current = manager.load();
    let mut current_json = serde_json::to_value(&current)
        .map_err(|e| format!("Failed to serialize current settings: {}", e))?;

    // Deep merge the partial update
    merge_json(&mut current_json, partial);

    // Deserialize back to AppSettings
    let updated: AppSettings = serde_json::from_value(current_json)
        .map_err(|e| format!("Failed to apply settings update: {}", e))?;

    // Save and return
    let saved = manager.save(&updated)?;
    Ok(saved.into())
}

/// Resets settings to defaults
#[tauri::command]
#[specta::specta]
pub async fn reset_settings(app: tauri::AppHandle) -> Result<AppSettingsDto, String> {
    let app_data_dir = get_app_data_dir(&app)?;
    let manager = SettingsManager::new(app_data_dir);
    let settings = manager.reset()?;
    Ok(settings.into())
}

/// Deep merge JSON objects (used for partial settings updates)
fn merge_json(base: &mut serde_json::Value, patch: serde_json::Value) {
    use serde_json::Value;
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                let base_value = base_map.entry(key).or_insert(Value::Null);
                merge_json(base_value, patch_value);
            }
        }
        (base, patch) => {
            *base = patch;
        }
    }
}
