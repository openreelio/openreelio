//! Project Backup Module
//!
//! Provides automatic project backup functionality for data safety.
//!
//! Features:
//! - Configurable backup interval
//! - Rolling backups with max count
//! - Backup on project close
//! - Recovery/restore capability
//! - Backup cleanup after successful save

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::core::{CoreError, CoreResult};

use super::{ProjectState, Snapshot};

// =============================================================================
// Configuration
// =============================================================================

/// Backup configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    /// Enable automatic backups
    pub enabled: bool,
    /// Backup interval in seconds (default: 300 = 5 minutes)
    pub interval_secs: u64,
    /// Maximum number of backups to keep (rolling)
    pub max_backups: usize,
    /// Create backup on project close
    pub backup_on_close: bool,
    /// Backup directory name (relative to project)
    pub backup_dir: String,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 300, // 5 minutes
            max_backups: 10,
            backup_on_close: true,
            backup_dir: ".openreelio/backups".to_string(),
        }
    }
}

impl BackupConfig {
    /// Creates config with frequent backups (for testing or high-risk editing)
    pub fn frequent() -> Self {
        Self {
            interval_secs: 60, // 1 minute
            max_backups: 20,
            ..Default::default()
        }
    }

    /// Creates config with minimal backups
    pub fn minimal() -> Self {
        Self {
            interval_secs: 600, // 10 minutes
            max_backups: 5,
            ..Default::default()
        }
    }

    /// Disables automatic backups
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Default::default()
        }
    }
}

// =============================================================================
// Backup Info
// =============================================================================

/// Information about a backup file
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// Backup file path
    pub path: PathBuf,
    /// Backup timestamp (Unix epoch milliseconds)
    pub timestamp_ms: u64,
    /// Human-readable timestamp
    pub created_at: String,
    /// File size in bytes
    pub size_bytes: u64,
    /// Whether this is an auto-backup or manual
    pub is_auto: bool,
    /// Backup reason/trigger
    pub reason: String,
}

impl BackupInfo {
    /// Creates backup info from a file path
    pub fn from_path(path: PathBuf, is_auto: bool, reason: &str) -> CoreResult<Self> {
        let metadata = fs::metadata(&path)?;

        let timestamp_ms = metadata
            .modified()
            .unwrap_or(SystemTime::now())
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let created_at = chrono::DateTime::from_timestamp_millis(timestamp_ms as i64)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        Ok(Self {
            path,
            timestamp_ms,
            created_at,
            size_bytes: metadata.len(),
            is_auto,
            reason: reason.to_string(),
        })
    }
}

// =============================================================================
// Backup Manager
// =============================================================================

/// Manages project backups
pub struct BackupManager {
    config: BackupConfig,
    project_dir: PathBuf,
    last_backup_time: AtomicU64,
    backup_in_progress: AtomicBool,
}

impl BackupManager {
    /// Creates a new backup manager
    pub fn new(config: BackupConfig, project_dir: PathBuf) -> Self {
        Self {
            config,
            project_dir,
            last_backup_time: AtomicU64::new(0),
            backup_in_progress: AtomicBool::new(false),
        }
    }

    /// Creates with default config
    pub fn with_defaults(project_dir: PathBuf) -> Self {
        Self::new(BackupConfig::default(), project_dir)
    }

    /// Returns the backup directory path
    pub fn backup_dir(&self) -> PathBuf {
        self.project_dir.join(&self.config.backup_dir)
    }

    /// Ensures the backup directory exists
    fn ensure_backup_dir(&self) -> CoreResult<PathBuf> {
        let dir = self.backup_dir();
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }
        Ok(dir)
    }

    /// Generates a backup filename with timestamp
    fn generate_backup_filename(&self, reason: &str) -> String {
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        format!("backup_{}_{}.json", reason, timestamp)
    }

    /// Creates a backup of the current project state
    pub fn create_backup(
        &self,
        state: &ProjectState,
        last_op_id: Option<&str>,
        reason: &str,
        is_auto: bool,
    ) -> CoreResult<BackupInfo> {
        // Prevent concurrent backups
        if self.backup_in_progress.swap(true, Ordering::Acquire) {
            return Err(CoreError::Internal(
                "Backup already in progress".to_string(),
            ));
        }

        let result = self.create_backup_internal(state, last_op_id, reason, is_auto);

        self.backup_in_progress.store(false, Ordering::Release);

        result
    }

    fn create_backup_internal(
        &self,
        state: &ProjectState,
        last_op_id: Option<&str>,
        reason: &str,
        is_auto: bool,
    ) -> CoreResult<BackupInfo> {
        let backup_dir = self.ensure_backup_dir()?;
        let filename = self.generate_backup_filename(reason);
        let backup_path = backup_dir.join(&filename);

        // Save snapshot to backup location
        Snapshot::save(&backup_path, state, last_op_id)?;

        // Update last backup time
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.last_backup_time.store(now, Ordering::Relaxed);

        // Cleanup old backups
        if is_auto {
            self.cleanup_old_backups()?;
        }

        BackupInfo::from_path(backup_path, is_auto, reason)
    }

    /// Creates an auto-backup if interval has elapsed
    pub fn auto_backup_if_needed(
        &self,
        state: &ProjectState,
        last_op_id: Option<&str>,
    ) -> CoreResult<Option<BackupInfo>> {
        if !self.config.enabled {
            return Ok(None);
        }

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let last = self.last_backup_time.load(Ordering::Relaxed);
        let elapsed = now.saturating_sub(last);

        if elapsed >= self.config.interval_secs {
            let info = self.create_backup(state, last_op_id, "auto", true)?;
            Ok(Some(info))
        } else {
            Ok(None)
        }
    }

    /// Lists all available backups, sorted by timestamp (newest first)
    pub fn list_backups(&self) -> CoreResult<Vec<BackupInfo>> {
        let backup_dir = self.backup_dir();

        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();

        for entry in fs::read_dir(&backup_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.extension().is_some_and(|ext| ext == "json") {
                let filename = path.file_stem().unwrap_or_default().to_string_lossy();

                // Parse backup type from filename
                let is_auto = filename.contains("_auto_");
                let reason = if filename.contains("_auto_") {
                    "auto"
                } else if filename.contains("_close_") {
                    "close"
                } else if filename.contains("_manual_") {
                    "manual"
                } else {
                    "unknown"
                };

                if let Ok(info) = BackupInfo::from_path(path, is_auto, reason) {
                    backups.push(info);
                }
            }
        }

        // Sort by timestamp, newest first
        backups.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));

        Ok(backups)
    }

    /// Restores project state from a backup
    pub fn restore_backup(&self, backup_path: &Path) -> CoreResult<ProjectState> {
        if !backup_path.exists() {
            return Err(CoreError::NotFound(format!(
                "Backup not found: {}",
                backup_path.display()
            )));
        }

        let (state, _last_op_id) = Snapshot::load(backup_path)?;
        Ok(state)
    }

    /// Restores from the most recent backup
    pub fn restore_latest(&self) -> CoreResult<ProjectState> {
        let backups = self.list_backups()?;

        let latest = backups
            .first()
            .ok_or_else(|| CoreError::NotFound("No backups available".to_string()))?;

        self.restore_backup(&latest.path)
    }

    /// Deletes a specific backup
    pub fn delete_backup(&self, backup_path: &Path) -> CoreResult<()> {
        if backup_path.exists() {
            fs::remove_file(backup_path)?;
        }
        Ok(())
    }

    /// Cleans up old auto-backups, keeping only max_backups
    fn cleanup_old_backups(&self) -> CoreResult<()> {
        let backups = self.list_backups()?;

        // Filter to only auto-backups
        let auto_backups: Vec<_> = backups.into_iter().filter(|b| b.is_auto).collect();

        // Delete backups beyond max count
        if auto_backups.len() > self.config.max_backups {
            for backup in auto_backups.iter().skip(self.config.max_backups) {
                let _ = self.delete_backup(&backup.path);
            }
        }

        Ok(())
    }

    /// Clears all backups
    pub fn clear_all_backups(&self) -> CoreResult<usize> {
        let backups = self.list_backups()?;
        let count = backups.len();

        for backup in backups {
            let _ = self.delete_backup(&backup.path);
        }

        Ok(count)
    }

    /// Gets the time until next auto-backup in seconds
    pub fn time_until_next_backup(&self) -> u64 {
        if !self.config.enabled {
            return u64::MAX;
        }

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let last = self.last_backup_time.load(Ordering::Relaxed);
        let elapsed = now.saturating_sub(last);

        self.config.interval_secs.saturating_sub(elapsed)
    }

    /// Checks if a crash recovery backup exists
    pub fn has_crash_recovery(&self) -> bool {
        let backup_dir = self.backup_dir();
        let crash_file = backup_dir.join("crash_recovery.json");
        crash_file.exists()
    }

    /// Creates a crash recovery backup (called on unexpected shutdown)
    pub fn create_crash_recovery(
        &self,
        state: &ProjectState,
        last_op_id: Option<&str>,
    ) -> CoreResult<BackupInfo> {
        let backup_dir = self.ensure_backup_dir()?;
        let crash_path = backup_dir.join("crash_recovery.json");

        Snapshot::save(&crash_path, state, last_op_id)?;

        BackupInfo::from_path(crash_path, false, "crash_recovery")
    }

    /// Clears the crash recovery backup (called after successful recovery)
    pub fn clear_crash_recovery(&self) -> CoreResult<()> {
        let backup_dir = self.backup_dir();
        let crash_file = backup_dir.join("crash_recovery.json");

        if crash_file.exists() {
            fs::remove_file(crash_file)?;
        }

        Ok(())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn create_test_state() -> ProjectState {
        ProjectState {
            meta: super::super::ProjectMeta {
                id: "test-project".to_string(),
                name: "Test Project".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                modified_at: "2024-01-01T00:00:00Z".to_string(),
                version: "0.1.0".to_string(),
                description: None,
                author: None,
                format_version: 2,
            },
            assets: HashMap::new(),
            sequences: HashMap::new(),
            active_sequence_id: None,
            effects: HashMap::new(),
            last_op_id: None,
            op_count: 0,
            is_dirty: false,
        }
    }

    #[test]
    fn test_backup_config_default() {
        let config = BackupConfig::default();
        assert!(config.enabled);
        assert_eq!(config.interval_secs, 300);
        assert_eq!(config.max_backups, 10);
    }

    #[test]
    fn test_backup_config_frequent() {
        let config = BackupConfig::frequent();
        assert_eq!(config.interval_secs, 60);
        assert_eq!(config.max_backups, 20);
    }

    #[test]
    fn test_backup_config_disabled() {
        let config = BackupConfig::disabled();
        assert!(!config.enabled);
    }

    #[test]
    fn test_backup_manager_creation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());

        assert_eq!(
            manager.backup_dir(),
            temp_dir.path().join(".openreelio/backups")
        );
    }

    #[test]
    fn test_generate_backup_filename() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());

        let filename = manager.generate_backup_filename("auto");
        assert!(filename.starts_with("backup_auto_"));
        assert!(filename.ends_with(".json"));
    }

    #[test]
    fn test_create_and_list_backups() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        // Create a backup
        let result = manager.create_backup(&state, None, "manual", false);
        assert!(result.is_ok());

        let info = result.unwrap();
        assert!(info.path.exists());
        assert!(!info.is_auto);
        assert_eq!(info.reason, "manual");

        // List backups
        let backups = manager.list_backups().unwrap();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn test_restore_backup() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        // Create backup
        let info = manager
            .create_backup(&state, None, "manual", false)
            .unwrap();

        // Restore
        let restored = manager.restore_backup(&info.path).unwrap();
        assert_eq!(restored.meta.name, "Test Project");
    }

    #[test]
    fn test_restore_latest() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        // Create multiple backups
        manager.create_backup(&state, None, "auto", true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        manager.create_backup(&state, None, "auto", true).unwrap();

        // Restore latest
        let restored = manager.restore_latest().unwrap();
        assert_eq!(restored.meta.name, "Test Project");
    }

    #[test]
    fn test_cleanup_old_backups() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config = BackupConfig {
            max_backups: 2,
            ..Default::default()
        };

        let manager = BackupManager::new(config, temp_dir.path().to_path_buf());
        let state = create_test_state();

        // Create more backups than max
        for _ in 0..5 {
            manager.create_backup(&state, None, "auto", true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Should only have max_backups
        let backups = manager.list_backups().unwrap();
        let auto_count = backups.iter().filter(|b| b.is_auto).count();
        assert!(auto_count <= 2, "Should cleanup to max 2 auto-backups");
    }

    #[test]
    fn test_delete_backup() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        let info = manager
            .create_backup(&state, None, "manual", false)
            .unwrap();
        assert!(info.path.exists());

        manager.delete_backup(&info.path).unwrap();
        assert!(!info.path.exists());
    }

    #[test]
    fn test_clear_all_backups() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        // Create backups
        manager.create_backup(&state, None, "auto", true).unwrap();
        manager
            .create_backup(&state, None, "manual", false)
            .unwrap();

        let count = manager.clear_all_backups().unwrap();
        assert_eq!(count, 2);

        let backups = manager.list_backups().unwrap();
        assert!(backups.is_empty());
    }

    #[test]
    fn test_crash_recovery() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        // No crash recovery initially
        assert!(!manager.has_crash_recovery());

        // Create crash recovery
        manager.create_crash_recovery(&state, None).unwrap();
        assert!(manager.has_crash_recovery());

        // Clear crash recovery
        manager.clear_crash_recovery().unwrap();
        assert!(!manager.has_crash_recovery());
    }

    #[test]
    fn test_time_until_next_backup() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());

        // Initially should be ready for backup
        let time = manager.time_until_next_backup();
        assert!(time <= 300); // Within interval
    }

    #[test]
    fn test_auto_backup_disabled() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config = BackupConfig::disabled();
        let manager = BackupManager::new(config, temp_dir.path().to_path_buf());
        let state = create_test_state();

        let result = manager.auto_backup_if_needed(&state, None).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_backup_info_serialization() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = BackupManager::with_defaults(temp_dir.path().to_path_buf());
        let state = create_test_state();

        let info = manager
            .create_backup(&state, None, "manual", false)
            .unwrap();

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"reason\":\"manual\""));
        assert!(json.contains("\"isAuto\":false"));
    }
}
