//! Settings Persistence System
//!
//! Provides persistent application settings with:
//! - Atomic file writes (temp file + rename)
//! - Schema validation with defaults
//! - Migration support for schema changes
//!
//! Storage location: {app_data_dir}/settings.json

use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use tracing::{info, warn};

/// Settings schema version for migration support
pub const SETTINGS_VERSION: u32 = 1;

/// Settings file name
pub const SETTINGS_FILE: &str = "settings.json";

/// Lock file name (advisory lock to prevent concurrent writers)
pub const SETTINGS_LOCK_FILE: &str = "settings.json.lock";

/// Application settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Schema version for migrations
    #[serde(default = "default_version")]
    pub version: u32,

    /// General settings
    #[serde(default)]
    pub general: GeneralSettings,

    /// Editor settings
    #[serde(default)]
    pub editor: EditorSettings,

    /// Playback settings
    #[serde(default)]
    pub playback: PlaybackSettings,

    /// Export settings
    #[serde(default)]
    pub export: ExportSettings,

    /// Appearance settings
    #[serde(default)]
    pub appearance: AppearanceSettings,

    /// Keyboard shortcuts
    #[serde(default)]
    pub shortcuts: ShortcutSettings,

    /// Auto-save settings
    #[serde(default)]
    pub auto_save: AutoSaveSettings,

    /// Performance settings
    #[serde(default)]
    pub performance: PerformanceSettings,
}

fn default_version() -> u32 {
    SETTINGS_VERSION
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            general: GeneralSettings::default(),
            editor: EditorSettings::default(),
            playback: PlaybackSettings::default(),
            export: ExportSettings::default(),
            appearance: AppearanceSettings::default(),
            shortcuts: ShortcutSettings::default(),
            auto_save: AutoSaveSettings::default(),
            performance: PerformanceSettings::default(),
        }
    }
}

impl AppSettings {
    /// Normalizes and clamps settings so persisted state is always valid.
    ///
    /// This is intentionally tolerant: it corrects bad values instead of failing,
    /// so corrupted/old configs don't brick the app.
    fn normalize(&mut self) {
        self.version = SETTINGS_VERSION;

        self.general.recent_projects_limit = self.general.recent_projects_limit.clamp(1, 50);

        self.editor.default_timeline_zoom = clamp_f64(self.editor.default_timeline_zoom, 0.1, 10.0);
        self.editor.snap_tolerance = self.editor.snap_tolerance.clamp(0, 200);

        self.playback.default_volume = clamp_f64(self.playback.default_volume, 0.0, 1.0);
        self.playback.preview_quality = normalize_enum(
            &self.playback.preview_quality,
            &["auto", "full", "half", "quarter"],
            default_preview_quality(),
        );

        self.export.default_format = normalize_enum(
            &self.export.default_format,
            &["mp4", "webm", "mov", "gif"],
            default_export_format(),
        );
        self.export.default_video_codec = normalize_enum(
            &self.export.default_video_codec,
            &["h264", "h265", "vp9", "prores"],
            default_video_codec(),
        );
        self.export.default_audio_codec = normalize_enum(
            &self.export.default_audio_codec,
            &["aac", "mp3", "opus"],
            default_audio_codec(),
        );

        self.appearance.theme = normalize_enum(
            &self.appearance.theme,
            &["light", "dark", "system"],
            default_theme(),
        );
        self.appearance.ui_scale = clamp_f64(self.appearance.ui_scale, 0.8, 1.5);
        if !is_hex_color(&self.appearance.accent_color) {
            self.appearance.accent_color = default_accent_color();
        }

        self.auto_save.interval_seconds = self.auto_save.interval_seconds.clamp(30, 3600);
        self.auto_save.backup_count = self.auto_save.backup_count.clamp(1, 20);

        self.performance.proxy_resolution = normalize_enum(
            &self.performance.proxy_resolution,
            &["720p", "480p", "360p"],
            default_proxy_resolution(),
        );
        self.performance.max_concurrent_jobs = self.performance.max_concurrent_jobs.clamp(1, 32);
        // 0 means "auto".
        if self.performance.memory_limit_mb != 0 {
            self.performance.memory_limit_mb = self.performance.memory_limit_mb.clamp(256, 65_536);
        }
        self.performance.cache_size_mb = self.performance.cache_size_mb.clamp(128, 16_384);
    }
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max)
}

fn normalize_enum(value: &str, allowed: &[&str], fallback: String) -> String {
    if allowed.iter().any(|v| v.eq_ignore_ascii_case(value)) {
        value.to_ascii_lowercase()
    } else {
        fallback
    }
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 7 || bytes[0] != b'#' {
        return false;
    }
    bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

/// General application settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    /// Language code (e.g., "en", "ko", "ja")
    #[serde(default = "default_language")]
    pub language: String,

    /// Show welcome screen on startup
    #[serde(default = "default_true")]
    pub show_welcome_on_startup: bool,

    /// Recent projects limit
    #[serde(default = "default_recent_limit")]
    pub recent_projects_limit: u32,

    /// Check for updates on startup
    #[serde(default = "default_true")]
    pub check_updates_on_startup: bool,

    /// Default project location
    #[serde(default)]
    pub default_project_location: Option<String>,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: default_language(),
            show_welcome_on_startup: true,
            recent_projects_limit: default_recent_limit(),
            check_updates_on_startup: true,
            default_project_location: None,
        }
    }
}

fn default_language() -> String {
    "en".to_string()
}

fn default_recent_limit() -> u32 {
    10
}

fn default_true() -> bool {
    true
}

/// Editor settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    /// Default timeline zoom level (1.0 = 100%)
    #[serde(default = "default_zoom")]
    pub default_timeline_zoom: f64,

    /// Snap to grid enabled
    #[serde(default = "default_true")]
    pub snap_to_grid: bool,

    /// Snap tolerance in pixels
    #[serde(default = "default_snap_tolerance")]
    pub snap_tolerance: u32,

    /// Show clip thumbnails in timeline
    #[serde(default = "default_true")]
    pub show_clip_thumbnails: bool,

    /// Show audio waveforms in timeline
    #[serde(default = "default_true")]
    pub show_audio_waveforms: bool,

    /// Ripple edit by default
    #[serde(default)]
    pub ripple_edit_default: bool,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            default_timeline_zoom: default_zoom(),
            snap_to_grid: true,
            snap_tolerance: default_snap_tolerance(),
            show_clip_thumbnails: true,
            show_audio_waveforms: true,
            ripple_edit_default: false,
        }
    }
}

fn default_zoom() -> f64 {
    1.0
}

fn default_snap_tolerance() -> u32 {
    10
}

/// Playback settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSettings {
    /// Default volume (0.0 - 1.0)
    #[serde(default = "default_volume")]
    pub default_volume: f64,

    /// Loop playback
    #[serde(default)]
    pub loop_playback: bool,

    /// Preview quality: "auto", "full", "half", "quarter"
    #[serde(default = "default_preview_quality")]
    pub preview_quality: String,

    /// Audio scrubbing enabled
    #[serde(default = "default_true")]
    pub audio_scrubbing: bool,
}

impl Default for PlaybackSettings {
    fn default() -> Self {
        Self {
            default_volume: default_volume(),
            loop_playback: false,
            preview_quality: default_preview_quality(),
            audio_scrubbing: true,
        }
    }
}

fn default_volume() -> f64 {
    0.8
}

fn default_preview_quality() -> String {
    "auto".to_string()
}

/// Export settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    /// Default export format: "mp4", "webm", "mov", "gif"
    #[serde(default = "default_export_format")]
    pub default_format: String,

    /// Default video codec: "h264", "h265", "vp9", "prores"
    #[serde(default = "default_video_codec")]
    pub default_video_codec: String,

    /// Default audio codec: "aac", "mp3", "opus"
    #[serde(default = "default_audio_codec")]
    pub default_audio_codec: String,

    /// Default export location
    #[serde(default)]
    pub default_export_location: Option<String>,

    /// Open folder after export
    #[serde(default = "default_true")]
    pub open_folder_after_export: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            default_format: default_export_format(),
            default_video_codec: default_video_codec(),
            default_audio_codec: default_audio_codec(),
            default_export_location: None,
            open_folder_after_export: true,
        }
    }
}

fn default_export_format() -> String {
    "mp4".to_string()
}

fn default_video_codec() -> String {
    "h264".to_string()
}

fn default_audio_codec() -> String {
    "aac".to_string()
}

/// Appearance settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// Theme: "light", "dark", "system"
    #[serde(default = "default_theme")]
    pub theme: String,

    /// Accent color (hex string, e.g., "#3b82f6")
    #[serde(default = "default_accent_color")]
    pub accent_color: String,

    /// UI scale factor (0.8 - 1.5)
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f64,

    /// Show status bar
    #[serde(default = "default_true")]
    pub show_status_bar: bool,

    /// Compact mode
    #[serde(default)]
    pub compact_mode: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            accent_color: default_accent_color(),
            ui_scale: default_ui_scale(),
            show_status_bar: true,
            compact_mode: false,
        }
    }
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_accent_color() -> String {
    "#3b82f6".to_string()
}

fn default_ui_scale() -> f64 {
    1.0
}

/// Keyboard shortcut settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    /// Custom shortcut overrides (action -> shortcut)
    #[serde(default)]
    pub custom_shortcuts: std::collections::HashMap<String, String>,
}

/// Auto-save settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveSettings {
    /// Enable auto-save
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Auto-save interval in seconds
    #[serde(default = "default_auto_save_interval")]
    pub interval_seconds: u32,

    /// Keep backup count
    #[serde(default = "default_backup_count")]
    pub backup_count: u32,
}

impl Default for AutoSaveSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_seconds: default_auto_save_interval(),
            backup_count: default_backup_count(),
        }
    }
}

fn default_auto_save_interval() -> u32 {
    300 // 5 minutes
}

fn default_backup_count() -> u32 {
    3
}

/// Performance settings
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSettings {
    /// Hardware acceleration enabled
    #[serde(default = "default_true")]
    pub hardware_acceleration: bool,

    /// Proxy generation enabled
    #[serde(default = "default_true")]
    pub proxy_generation: bool,

    /// Proxy resolution: "720p", "480p", "360p"
    #[serde(default = "default_proxy_resolution")]
    pub proxy_resolution: String,

    /// Maximum concurrent jobs
    #[serde(default = "default_max_jobs")]
    pub max_concurrent_jobs: u32,

    /// Memory limit in MB (0 = auto)
    #[serde(default)]
    pub memory_limit_mb: u32,

    /// Cache size in MB
    #[serde(default = "default_cache_size")]
    pub cache_size_mb: u32,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            hardware_acceleration: true,
            proxy_generation: true,
            proxy_resolution: default_proxy_resolution(),
            max_concurrent_jobs: default_max_jobs(),
            memory_limit_mb: 0,
            cache_size_mb: default_cache_size(),
        }
    }
}

fn default_proxy_resolution() -> String {
    "720p".to_string()
}

fn default_max_jobs() -> u32 {
    4
}

fn default_cache_size() -> u32 {
    1024 // 1GB
}

/// Settings manager for loading, saving, and resetting settings
pub struct SettingsManager {
    settings_path: PathBuf,
}

impl SettingsManager {
    /// Create a new settings manager with the given app data directory
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            settings_path: app_data_dir.join(SETTINGS_FILE),
        }
    }

    fn lock_path(&self) -> PathBuf {
        self.settings_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(SETTINGS_LOCK_FILE)
    }

    fn with_lock<T>(
        &self,
        exclusive: bool,
        op: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        // Ensure parent directory exists so the lock file can be created.
        if let Some(parent) = self.settings_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create settings directory: {}", e))?;
        }

        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(self.lock_path())
            .map_err(|e| format!("Failed to open settings lock file: {}", e))?;

        if exclusive {
            fs2::FileExt::lock_exclusive(&lock_file)
                .map_err(|e| format!("Failed to lock settings file (exclusive): {}", e))?;
        } else {
            fs2::FileExt::lock_shared(&lock_file)
                .map_err(|e| format!("Failed to lock settings file (shared): {}", e))?;
        }

        let result = op();

        if let Err(e) = fs2::FileExt::unlock(&lock_file) {
            warn!("Failed to unlock settings lock file: {}", e);
        }

        result
    }

    /// Get the settings file path
    pub fn settings_path(&self) -> &PathBuf {
        &self.settings_path
    }

    /// Load settings from disk, returning defaults if file doesn't exist
    pub fn load(&self) -> AppSettings {
        let result = self.with_lock(false, || {
            if !self.settings_path.exists() {
                info!("Settings file not found, using defaults");
                return Ok(AppSettings::default());
            }

            let content = fs::read_to_string(&self.settings_path)
                .map_err(|e| format!("Failed to read settings file: {}", e))?;

            let mut settings = serde_json::from_str::<AppSettings>(&content)
                .map_err(|e| format!("Failed to parse settings file: {}", e))?;

            // Run migrations if needed
            if settings.version < SETTINGS_VERSION {
                info!(
                    "Migrating settings from version {} to {}",
                    settings.version, SETTINGS_VERSION
                );
                settings = self.migrate(settings);
            }

            settings.normalize();
            Ok(settings)
        });

        match result {
            Ok(settings) => settings,
            Err(e) => {
                warn!("Failed to load settings, using defaults: {}", e);
                AppSettings::default()
            }
        }
    }

    /// Save settings to disk using atomic write (temp file + rename)
    pub fn save(&self, settings: &AppSettings) -> Result<AppSettings, String> {
        self.with_lock(true, || {
            // Normalize before persisting.
            let mut normalized = settings.clone();
            normalized.normalize();

            // Serialize settings
            let content = serde_json::to_string_pretty(&normalized)
                .map_err(|e| format!("Failed to serialize settings: {}", e))?;

            // Atomic write: write to temp file, then rename.
            // Note: std::fs::rename does not overwrite on Windows.
            let temp_path = self.settings_path.with_extension("json.tmp");
            if temp_path.exists() {
                let _ = fs::remove_file(&temp_path);
            }

            // Write to temp file
            let mut file = fs::File::create(&temp_path)
                .map_err(|e| format!("Failed to create temp settings file: {}", e))?;
            file.write_all(content.as_bytes())
                .map_err(|e| format!("Failed to write settings: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to sync settings file: {}", e))?;

            if cfg!(windows) {
                // Windows: rename does not overwrite, so we use a backup-then-swap.
                let backup_path = self.settings_path.with_extension("json.bak");
                if backup_path.exists() {
                    let _ = fs::remove_file(&backup_path);
                }

                if self.settings_path.exists() {
                    fs::rename(&self.settings_path, &backup_path)
                        .map_err(|e| format!("Failed to backup existing settings file: {}", e))?;
                }

                match fs::rename(&temp_path, &self.settings_path) {
                    Ok(()) => {
                        if backup_path.exists() {
                            let _ = fs::remove_file(&backup_path);
                        }
                    }
                    Err(e) => {
                        // Best-effort restore.
                        if backup_path.exists() {
                            let _ = fs::rename(&backup_path, &self.settings_path);
                        }
                        return Err(format!("Failed to finalize settings file: {}", e));
                    }
                }
            } else {
                fs::rename(&temp_path, &self.settings_path)
                    .map_err(|e| format!("Failed to finalize settings file: {}", e))?;
            }

            info!("Settings saved to {:?}", self.settings_path);
            Ok(normalized)
        })
    }

    /// Reset settings to defaults and delete the settings file
    pub fn reset(&self) -> Result<AppSettings, String> {
        self.with_lock(true, || {
            if self.settings_path.exists() {
                fs::remove_file(&self.settings_path)
                    .map_err(|e| format!("Failed to delete settings file: {}", e))?;
                info!("Settings file deleted");
            }
            Ok(AppSettings::default())
        })
    }

    /// Migrate settings from older version
    fn migrate(&self, mut settings: AppSettings) -> AppSettings {
        // Future migrations would go here
        // Example:
        // if settings.version < 2 {
        //     // Migrate from v1 to v2
        //     settings.new_field = old_field_migration();
        // }

        settings.version = SETTINGS_VERSION;
        settings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_default_settings() {
        let settings = AppSettings::default();
        assert_eq!(settings.version, SETTINGS_VERSION);
        assert_eq!(settings.general.language, "en");
        assert!(settings.general.show_welcome_on_startup);
        assert_eq!(settings.appearance.theme, "dark");
    }

    #[test]
    fn test_settings_serialization() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings, deserialized);
    }

    #[test]
    fn test_load_nonexistent_returns_defaults() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let settings = manager.load();
        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn test_save_and_load() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let mut settings = AppSettings::default();
        settings.general.language = "ko".to_string();
        settings.appearance.theme = "light".to_string();

        manager.save(&settings).unwrap();
        let loaded = manager.load();

        assert_eq!(loaded.general.language, "ko");
        assert_eq!(loaded.appearance.theme, "light");
    }

    #[test]
    fn test_reset_deletes_file() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let settings = AppSettings::default();
        manager.save(&settings).unwrap();
        assert!(manager.settings_path().exists());

        let reset_settings = manager.reset().unwrap();
        assert!(!manager.settings_path().exists());
        assert_eq!(reset_settings, AppSettings::default());
    }

    #[test]
    fn test_invalid_json_returns_defaults() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join(SETTINGS_FILE);
        fs::write(&settings_path, "invalid json {{{").unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        assert_eq!(settings, AppSettings::default());
    }

    #[test]
    fn test_partial_json_uses_defaults_for_missing() {
        let temp_dir = TempDir::new().unwrap();
        let settings_path = temp_dir.path().join(SETTINGS_FILE);
        fs::write(
            &settings_path,
            r#"{"version": 1, "general": {"language": "ja"}}"#,
        )
        .unwrap();

        let manager = SettingsManager::new(temp_dir.path().to_path_buf());
        let settings = manager.load();

        // Custom value preserved
        assert_eq!(settings.general.language, "ja");
        // Defaults for missing fields
        assert!(settings.general.show_welcome_on_startup);
        assert_eq!(settings.appearance.theme, "dark");
    }

    #[test]
    fn test_atomic_write() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let settings = AppSettings::default();
        manager.save(&settings).unwrap();

        // Temp file should not exist after successful write
        let temp_path = manager.settings_path().with_extension("json.tmp");
        assert!(!temp_path.exists());

        // Settings file should exist
        assert!(manager.settings_path().exists());
    }

    #[test]
    fn test_save_twice_overwrites_successfully() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let mut first = AppSettings::default();
        first.general.language = "en".to_string();
        manager.save(&first).unwrap();

        let mut second = AppSettings::default();
        second.general.language = "ko".to_string();
        manager.save(&second).unwrap();

        let loaded = manager.load();
        assert_eq!(loaded.general.language, "ko");
    }

    #[test]
    fn test_normalization_clamps_values() {
        let temp_dir = TempDir::new().unwrap();
        let manager = SettingsManager::new(temp_dir.path().to_path_buf());

        let mut settings = AppSettings::default();
        settings.playback.default_volume = 99.0;
        settings.appearance.accent_color = "not-a-color".to_string();
        settings.editor.default_timeline_zoom = -123.0;
        settings.performance.cache_size_mb = 1;

        manager.save(&settings).unwrap();
        let loaded = manager.load();

        assert_eq!(loaded.playback.default_volume, 1.0);
        assert_eq!(loaded.appearance.accent_color, default_accent_color());
        assert_eq!(loaded.editor.default_timeline_zoom, 0.1);
        assert_eq!(loaded.performance.cache_size_mb, 128);
    }
}
