//! Effect Preset Storage
//!
//! Provides CRUD operations for saving and loading effect presets.
//! Presets are stored as individual JSON files in `{app_data}/presets/effects/`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::models::{EffectCategory, EffectType, Keyframe, ParamValue};

// =============================================================================
// Preset Model
// =============================================================================

/// A saved effect preset containing parameters and metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPreset {
    /// Unique preset identifier
    pub id: String,
    /// User-assigned name
    pub name: String,
    /// Optional description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The effect type this preset applies to
    pub effect_type: EffectType,
    /// Effect category (derived from effect_type, stored for fast filtering)
    pub category: EffectCategory,
    /// Saved parameter values
    pub params: HashMap<String, ParamValue>,
    /// Saved keyframe animations (optional)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub keyframes: HashMap<String, Vec<Keyframe>>,
    /// ISO 8601 timestamp
    pub created_at: String,
    /// ISO 8601 timestamp
    pub updated_at: String,
}

/// Lightweight summary for listing presets without full parameter data
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPresetSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub effect_type: EffectType,
    pub category: EffectCategory,
    pub created_at: String,
    pub updated_at: String,
}

impl From<&EffectPreset> for EffectPresetSummary {
    fn from(preset: &EffectPreset) -> Self {
        Self {
            id: preset.id.clone(),
            name: preset.name.clone(),
            description: preset.description.clone(),
            effect_type: preset.effect_type.clone(),
            category: preset.category.clone(),
            created_at: preset.created_at.clone(),
            updated_at: preset.updated_at.clone(),
        }
    }
}

// =============================================================================
// Storage Helpers
// =============================================================================

/// Returns the presets directory path: `{app_data}/presets/effects/`
pub fn get_presets_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("presets").join("effects")
}

/// Validates that a preset ID contains only safe characters (alphanumeric, hyphens, underscores).
/// Prevents path traversal attacks via crafted IDs.
fn validate_preset_id(preset_id: &str) -> Result<(), String> {
    if preset_id.is_empty() {
        return Err("Preset ID is empty".to_string());
    }
    if preset_id.contains('/')
        || preset_id.contains('\\')
        || preset_id.contains("..")
        || preset_id.contains('\0')
    {
        return Err(format!("Invalid preset ID: {}", preset_id));
    }
    Ok(())
}

/// Returns the file path for a specific preset
fn preset_file_path(presets_dir: &Path, preset_id: &str) -> Result<PathBuf, String> {
    validate_preset_id(preset_id)?;
    Ok(presets_dir.join(format!("{}.json", preset_id)))
}

/// Ensures the presets directory exists
fn ensure_presets_dir(presets_dir: &Path) -> Result<(), String> {
    if !presets_dir.exists() {
        std::fs::create_dir_all(presets_dir)
            .map_err(|e| format!("Failed to create presets directory: {}", e))?;
    }
    Ok(())
}

/// Returns the current UTC time as ISO 8601 string
fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// =============================================================================
// CRUD Operations
// =============================================================================

/// Saves an effect preset to disk.
///
/// Creates a new preset with a generated ULID and writes it as JSON.
/// Returns the saved preset including the generated ID and timestamps.
pub fn save_effect_preset(
    app_data_dir: &Path,
    name: String,
    description: Option<String>,
    effect_type: EffectType,
    params: HashMap<String, ParamValue>,
    keyframes: HashMap<String, Vec<Keyframe>>,
) -> Result<EffectPreset, String> {
    let name_trimmed = name.trim().to_string();
    if name_trimmed.is_empty() {
        return Err("Preset name cannot be empty".to_string());
    }

    let presets_dir = get_presets_dir(app_data_dir);
    ensure_presets_dir(&presets_dir)?;

    let now = now_iso8601();
    let category = effect_type.category();
    let preset = EffectPreset {
        id: ulid::Ulid::new().to_string(),
        name: name_trimmed,
        description,
        effect_type,
        category,
        params,
        keyframes,
        created_at: now.clone(),
        updated_at: now,
    };

    let file_path = preset_file_path(&presets_dir, &preset.id)?;
    let json = serde_json::to_string_pretty(&preset)
        .map_err(|e| format!("Failed to serialize preset: {}", e))?;
    std::fs::write(&file_path, json).map_err(|e| format!("Failed to write preset file: {}", e))?;

    tracing::info!(preset_id = %preset.id, name = %preset.name, "Saved effect preset");
    Ok(preset)
}

/// Loads a single effect preset by ID.
pub fn load_effect_preset(app_data_dir: &Path, preset_id: &str) -> Result<EffectPreset, String> {
    let presets_dir = get_presets_dir(app_data_dir);
    let file_path = preset_file_path(&presets_dir, preset_id)?;

    if !file_path.exists() {
        return Err(format!("Effect preset not found: {}", preset_id));
    }

    let json = std::fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read preset file: {}", e))?;
    let preset: EffectPreset =
        serde_json::from_str(&json).map_err(|e| format!("Failed to parse preset file: {}", e))?;

    Ok(preset)
}

/// Lists all saved effect presets as summaries (sorted by name).
pub fn list_effect_presets(app_data_dir: &Path) -> Result<Vec<EffectPresetSummary>, String> {
    let presets_dir = get_presets_dir(app_data_dir);

    if !presets_dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries = std::fs::read_dir(&presets_dir)
        .map_err(|e| format!("Failed to read presets directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        match std::fs::read_to_string(&path) {
            Ok(json) => match serde_json::from_str::<EffectPreset>(&json) {
                Ok(preset) => summaries.push(EffectPresetSummary::from(&preset)),
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Skipping malformed preset file");
                }
            },
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "Skipping unreadable preset file");
            }
        }
    }

    summaries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(summaries)
}

/// Deletes an effect preset by ID.
pub fn delete_effect_preset(app_data_dir: &Path, preset_id: &str) -> Result<(), String> {
    let presets_dir = get_presets_dir(app_data_dir);
    let file_path = preset_file_path(&presets_dir, preset_id)?;

    if !file_path.exists() {
        return Err(format!("Effect preset not found: {}", preset_id));
    }

    std::fs::remove_file(&file_path).map_err(|e| format!("Failed to delete preset file: {}", e))?;

    tracing::info!(preset_id = %preset_id, "Deleted effect preset");
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        tempfile::tempdir().expect("Failed to create temp dir")
    }

    fn sample_params() -> HashMap<String, ParamValue> {
        let mut params = HashMap::new();
        params.insert("radius".to_string(), ParamValue::Float(12.0));
        params.insert("enabled".to_string(), ParamValue::Bool(true));
        params
    }

    #[test]
    fn should_save_preset_and_return_with_generated_id() {
        // Given no presets exist
        let tmp = setup();
        let params = sample_params();

        // When saving a new preset
        let result = save_effect_preset(
            tmp.path(),
            "My Blur".to_string(),
            Some("A custom blur".to_string()),
            EffectType::GaussianBlur,
            params.clone(),
            HashMap::new(),
        );

        // Then it succeeds with a valid preset
        let preset = result.expect("save should succeed");
        assert!(!preset.id.is_empty(), "ID should be generated");
        assert_eq!(preset.name, "My Blur");
        assert_eq!(preset.description.as_deref(), Some("A custom blur"));
        assert_eq!(preset.effect_type, EffectType::GaussianBlur);
        assert_eq!(preset.category, EffectCategory::BlurSharpen);
        assert_eq!(preset.params.len(), 2);
        assert!(!preset.created_at.is_empty());

        // And the file exists on disk
        let file = get_presets_dir(tmp.path()).join(format!("{}.json", preset.id));
        assert!(file.exists(), "Preset file should exist on disk");
    }

    #[test]
    fn should_load_preset_by_id() {
        // Given a saved preset
        let tmp = setup();
        let saved = save_effect_preset(
            tmp.path(),
            "Warm Glow".to_string(),
            None,
            EffectType::Brightness,
            sample_params(),
            HashMap::new(),
        )
        .unwrap();

        // When loading by ID
        let loaded = load_effect_preset(tmp.path(), &saved.id);

        // Then it returns the same preset
        let loaded = loaded.expect("load should succeed");
        assert_eq!(loaded.id, saved.id);
        assert_eq!(loaded.name, "Warm Glow");
        assert_eq!(loaded.params.len(), 2);
    }

    #[test]
    fn should_return_error_when_loading_nonexistent_preset() {
        // Given no presets exist
        let tmp = setup();

        // When loading a non-existent ID
        let result = load_effect_preset(tmp.path(), "nonexistent-id");

        // Then it returns an error
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn should_list_all_presets_sorted_by_name() {
        // Given three saved presets
        let tmp = setup();
        save_effect_preset(
            tmp.path(),
            "Zebra Filter".to_string(),
            None,
            EffectType::Contrast,
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        save_effect_preset(
            tmp.path(),
            "Alpha Blur".to_string(),
            None,
            EffectType::GaussianBlur,
            sample_params(),
            HashMap::new(),
        )
        .unwrap();
        save_effect_preset(
            tmp.path(),
            "Medium Glow".to_string(),
            None,
            EffectType::Brightness,
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();

        // When listing presets
        let list = list_effect_presets(tmp.path()).expect("list should succeed");

        // Then all 3 are returned sorted by name
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "Alpha Blur");
        assert_eq!(list[1].name, "Medium Glow");
        assert_eq!(list[2].name, "Zebra Filter");
    }

    #[test]
    fn should_return_empty_list_when_no_presets_exist() {
        // Given a fresh directory with no presets
        let tmp = setup();

        // When listing presets
        let list = list_effect_presets(tmp.path()).expect("list should succeed");

        // Then the list is empty
        assert!(list.is_empty());
    }

    #[test]
    fn should_delete_preset_and_remove_from_disk() {
        // Given a saved preset
        let tmp = setup();
        let saved = save_effect_preset(
            tmp.path(),
            "To Delete".to_string(),
            None,
            EffectType::Saturation,
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();
        let file = get_presets_dir(tmp.path()).join(format!("{}.json", saved.id));
        assert!(file.exists());

        // When deleting the preset
        let result = delete_effect_preset(tmp.path(), &saved.id);

        // Then deletion succeeds and file is removed
        assert!(result.is_ok());
        assert!(!file.exists(), "File should be removed from disk");

        // And loading it returns an error
        assert!(load_effect_preset(tmp.path(), &saved.id).is_err());
    }

    #[test]
    fn should_return_error_when_deleting_nonexistent_preset() {
        // Given no presets exist
        let tmp = setup();

        // When deleting a non-existent ID
        let result = delete_effect_preset(tmp.path(), "nonexistent-id");

        // Then it returns an error
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn should_persist_keyframes_in_preset() {
        // Given an effect with keyframes
        let tmp = setup();
        let mut keyframes = HashMap::new();
        keyframes.insert(
            "radius".to_string(),
            vec![
                Keyframe::new(0.0, ParamValue::Float(5.0)),
                Keyframe::new(1.0, ParamValue::Float(20.0)),
            ],
        );

        // When saving with keyframes
        let saved = save_effect_preset(
            tmp.path(),
            "Animated Blur".to_string(),
            None,
            EffectType::GaussianBlur,
            sample_params(),
            keyframes,
        )
        .unwrap();

        // Then loading preserves keyframes
        let loaded = load_effect_preset(tmp.path(), &saved.id).unwrap();
        assert_eq!(loaded.keyframes.len(), 1);
        let kfs = loaded.keyframes.get("radius").unwrap();
        assert_eq!(kfs.len(), 2);
    }

    #[test]
    fn should_reject_path_traversal_in_preset_id() {
        // Given a fresh directory
        let tmp = setup();

        // When loading with a path traversal ID
        let result = load_effect_preset(tmp.path(), "../../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid preset ID"));

        // And deleting with a path traversal ID
        let result = delete_effect_preset(tmp.path(), "../secrets");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid preset ID"));
    }

    #[test]
    fn should_reject_empty_preset_name() {
        // Given a fresh directory
        let tmp = setup();

        // When saving with an empty name
        let result = save_effect_preset(
            tmp.path(),
            "   ".to_string(),
            None,
            EffectType::Brightness,
            HashMap::new(),
            HashMap::new(),
        );

        // Then it returns an error
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn should_skip_malformed_files_when_listing() {
        // Given a valid preset and a malformed file
        let tmp = setup();
        save_effect_preset(
            tmp.path(),
            "Valid Preset".to_string(),
            None,
            EffectType::Brightness,
            HashMap::new(),
            HashMap::new(),
        )
        .unwrap();

        let presets_dir = get_presets_dir(tmp.path());
        std::fs::write(presets_dir.join("broken.json"), "{ invalid json }")
            .expect("write broken file");

        // When listing presets
        let list = list_effect_presets(tmp.path()).expect("list should succeed");

        // Then only valid presets are returned
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Valid Preset");
    }
}
