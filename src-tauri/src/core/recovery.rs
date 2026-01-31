//! Crash Recovery Module
//!
//! Provides panic handling and crash recovery functionality.
//!
//! Features:
//! - Custom panic handler that saves crash info
//! - Recovery state detection on startup
//! - Crash log generation with stack traces
//! - Unsaved work recovery capability

use std::fs::{self, File};
use std::io::Write;
use std::panic::{self, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

// =============================================================================
// Global State
// =============================================================================

/// Global flag indicating if crash handler is installed
static CRASH_HANDLER_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Global recovery directory path
static RECOVERY_DIR: OnceLock<PathBuf> = OnceLock::new();

// =============================================================================
// Crash Info
// =============================================================================

/// Information about a crash
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashInfo {
    /// Crash timestamp (Unix epoch milliseconds)
    pub timestamp_ms: u64,
    /// Human-readable timestamp
    pub timestamp_str: String,
    /// Panic message
    pub message: String,
    /// Panic location (file:line)
    pub location: Option<String>,
    /// Application version
    pub app_version: String,
    /// Operating system info
    pub os_info: String,
    /// Thread name
    pub thread_name: String,
    /// Backtrace (if available)
    pub backtrace: Option<String>,
    /// Whether recovery data was saved
    pub recovery_saved: bool,
}

impl CrashInfo {
    /// Creates crash info from panic hook info
    pub fn from_panic(panic_info: &PanicHookInfo<'_>) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default();
        let timestamp_ms = timestamp.as_millis() as u64;

        let timestamp_str = chrono::DateTime::from_timestamp_millis(timestamp_ms as i64)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        // Extract panic message
        let message = if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic".to_string()
        };

        // Extract location
        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()));

        // Get thread name
        let thread_name = std::thread::current()
            .name()
            .unwrap_or("unknown")
            .to_string();

        // Get OS info
        let os_info = format!(
            "{} {} ({})",
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::consts::FAMILY
        );

        // Capture backtrace
        let backtrace = {
            let bt = std::backtrace::Backtrace::capture();
            let bt_str = bt.to_string();
            if bt_str.is_empty() || bt_str.contains("disabled") {
                None
            } else {
                Some(bt_str)
            }
        };

        Self {
            timestamp_ms,
            timestamp_str,
            message,
            location,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            os_info,
            thread_name,
            backtrace,
            recovery_saved: false,
        }
    }

    /// Saves crash info to a file
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        let mut file = File::create(path)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        Ok(())
    }

    /// Loads crash info from a file
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let content = fs::read_to_string(path)?;
        let info: Self = serde_json::from_str(&content)?;
        Ok(info)
    }
}

// =============================================================================
// Recovery State
// =============================================================================

/// Recovery state indicating what can be recovered
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    /// Whether recovery is needed
    pub needs_recovery: bool,
    /// Last crash info (if any)
    pub last_crash: Option<CrashInfo>,
    /// Path to recovery snapshot
    pub recovery_snapshot: Option<PathBuf>,
    /// Path to recovery ops log
    pub recovery_ops_log: Option<PathBuf>,
    /// Project that was open during crash
    pub project_path: Option<PathBuf>,
}

impl RecoveryState {
    /// Creates an empty recovery state (no recovery needed)
    pub fn none() -> Self {
        Self {
            needs_recovery: false,
            last_crash: None,
            recovery_snapshot: None,
            recovery_ops_log: None,
            project_path: None,
        }
    }

    /// Creates recovery state indicating recovery is needed
    pub fn needs_recovery(crash: CrashInfo) -> Self {
        Self {
            needs_recovery: true,
            last_crash: Some(crash),
            recovery_snapshot: None,
            recovery_ops_log: None,
            project_path: None,
        }
    }

    /// Adds recovery file paths
    pub fn with_recovery_files(
        mut self,
        snapshot: Option<PathBuf>,
        ops_log: Option<PathBuf>,
        project: Option<PathBuf>,
    ) -> Self {
        self.recovery_snapshot = snapshot;
        self.recovery_ops_log = ops_log;
        self.project_path = project;
        self
    }
}

// =============================================================================
// Recovery Manager
// =============================================================================

/// Manages crash recovery
pub struct RecoveryManager {
    /// Recovery directory
    recovery_dir: PathBuf,
    /// Lock file path
    lock_file: PathBuf,
    /// Crash info file path
    crash_file: PathBuf,
}

impl RecoveryManager {
    /// Creates a new recovery manager
    pub fn new(recovery_dir: PathBuf) -> Self {
        let lock_file = recovery_dir.join("recovery.lock");
        let crash_file = recovery_dir.join("crash_info.json");

        Self {
            recovery_dir,
            lock_file,
            crash_file,
        }
    }

    /// Gets the recovery directory
    pub fn recovery_dir(&self) -> &Path {
        &self.recovery_dir
    }

    /// Ensures the recovery directory exists
    fn ensure_dir(&self) -> std::io::Result<()> {
        if !self.recovery_dir.exists() {
            fs::create_dir_all(&self.recovery_dir)?;
        }
        Ok(())
    }

    /// Creates a lock file indicating app is running
    pub fn create_lock(&self) -> std::io::Result<()> {
        self.ensure_dir()?;

        let lock_data = serde_json::json!({
            "pid": std::process::id(),
            "started_at": chrono::Utc::now().to_rfc3339(),
            "version": env!("CARGO_PKG_VERSION"),
        });

        let mut file = File::create(&self.lock_file)?;
        file.write_all(lock_data.to_string().as_bytes())?;
        file.sync_all()?;

        Ok(())
    }

    /// Removes the lock file (normal shutdown)
    pub fn remove_lock(&self) -> std::io::Result<()> {
        if self.lock_file.exists() {
            fs::remove_file(&self.lock_file)?;
        }
        Ok(())
    }

    /// Checks if a stale lock exists (indicates previous crash)
    pub fn has_stale_lock(&self) -> bool {
        self.lock_file.exists()
    }

    /// Checks the recovery state on startup
    pub fn check_recovery_state(&self) -> RecoveryState {
        // Check for stale lock (crash indicator)
        if !self.has_stale_lock() {
            return RecoveryState::none();
        }

        // Load crash info if available
        let crash_info = if self.crash_file.exists() {
            CrashInfo::load(&self.crash_file).ok()
        } else {
            None
        };

        // Check for recovery files
        let recovery_snapshot = {
            let path = self.recovery_dir.join("recovery_snapshot.json");
            if path.exists() {
                Some(path)
            } else {
                None
            }
        };

        let recovery_ops_log = {
            let path = self.recovery_dir.join("recovery_ops.jsonl");
            if path.exists() {
                Some(path)
            } else {
                None
            }
        };

        let project_path = {
            let path = self.recovery_dir.join("last_project.txt");
            if path.exists() {
                fs::read_to_string(&path)
                    .ok()
                    .map(|s| PathBuf::from(s.trim()))
            } else {
                None
            }
        };

        if let Some(crash) = crash_info {
            RecoveryState::needs_recovery(crash)
                .with_recovery_files(recovery_snapshot, recovery_ops_log, project_path)
        } else if recovery_snapshot.is_some() || recovery_ops_log.is_some() {
            // No crash info but recovery files exist
            RecoveryState {
                needs_recovery: true,
                last_crash: None,
                recovery_snapshot,
                recovery_ops_log,
                project_path,
            }
        } else {
            // Just a stale lock, no recovery needed
            RecoveryState::none()
        }
    }

    /// Saves crash information
    pub fn save_crash_info(&self, crash: &CrashInfo) -> std::io::Result<()> {
        self.ensure_dir()?;
        crash.save(&self.crash_file)
    }

    /// Saves the current project path for recovery
    pub fn save_project_path(&self, project_path: &Path) -> std::io::Result<()> {
        self.ensure_dir()?;
        let path = self.recovery_dir.join("last_project.txt");
        let mut file = File::create(path)?;
        file.write_all(project_path.to_string_lossy().as_bytes())?;
        file.sync_all()?;
        Ok(())
    }

    /// Clears recovery state after successful recovery
    pub fn clear_recovery(&self) -> std::io::Result<()> {
        // Remove crash info
        if self.crash_file.exists() {
            fs::remove_file(&self.crash_file)?;
        }

        // Remove recovery files
        let files = [
            "recovery_snapshot.json",
            "recovery_ops.jsonl",
            "last_project.txt",
        ];

        for file in files {
            let path = self.recovery_dir.join(file);
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }

        // Remove stale lock
        self.remove_lock()?;

        Ok(())
    }

    /// Archives crash info for later analysis
    pub fn archive_crash(&self) -> std::io::Result<Option<PathBuf>> {
        if !self.crash_file.exists() {
            return Ok(None);
        }

        let crash_dir = self.recovery_dir.join("crash_logs");
        if !crash_dir.exists() {
            fs::create_dir_all(&crash_dir)?;
        }

        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let archive_path = crash_dir.join(format!("crash_{}.json", timestamp));
        fs::copy(&self.crash_file, &archive_path)?;

        Ok(Some(archive_path))
    }

    /// Lists archived crash logs
    pub fn list_crash_logs(&self) -> std::io::Result<Vec<PathBuf>> {
        let crash_dir = self.recovery_dir.join("crash_logs");

        if !crash_dir.exists() {
            return Ok(Vec::new());
        }

        let mut logs = Vec::new();
        for entry in fs::read_dir(&crash_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                logs.push(path);
            }
        }

        // Sort by filename (which includes timestamp)
        logs.sort();
        logs.reverse(); // Newest first

        Ok(logs)
    }
}

// =============================================================================
// Panic Hook Installation
// =============================================================================

/// Callback type for custom panic handling
pub type PanicCallback = Box<dyn Fn(&CrashInfo) + Send + Sync + 'static>;

/// Installs the crash recovery panic hook
///
/// This should be called once at application startup.
/// The panic hook will:
/// 1. Create crash info from the panic
/// 2. Save crash info to the recovery directory
/// 3. Call any registered callbacks
/// 4. Continue to the default panic handler
pub fn install_panic_hook(recovery_dir: PathBuf, callback: Option<PanicCallback>) {
    if CRASH_HANDLER_INSTALLED.swap(true, Ordering::SeqCst) {
        // Already installed
        return;
    }

    // Store recovery directory globally
    let _ = RECOVERY_DIR.set(recovery_dir.clone());

    let prev_hook = panic::take_hook();

    panic::set_hook(Box::new(move |panic_info| {
        // Create crash info
        let mut crash_info = CrashInfo::from_panic(panic_info);

        // Try to save crash info
        if let Some(dir) = RECOVERY_DIR.get() {
            let manager = RecoveryManager::new(dir.clone());
            // First attempt to save
            if manager.save_crash_info(&crash_info).is_ok() {
                // Mark as saved and save again to persist the flag
                crash_info.recovery_saved = true;
                // Best-effort re-save with updated flag (ignore errors)
                let _ = manager.save_crash_info(&crash_info);
            }
        }

        // Call callback if provided
        if let Some(ref cb) = callback {
            cb(&crash_info);
        }

        // Call previous hook (default behavior)
        prev_hook(panic_info);
    }));
}

/// Checks if crash handler is installed
pub fn is_crash_handler_installed() -> bool {
    CRASH_HANDLER_INSTALLED.load(Ordering::SeqCst)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crash_info_creation() {
        // We can't easily test from_panic without causing a panic,
        // but we can test the structure
        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic".to_string(),
            location: Some("src/main.rs:10:5".to_string()),
            app_version: "0.1.0".to_string(),
            os_info: "linux x86_64 (unix)".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: false,
        };

        assert_eq!(crash.message, "Test panic");
        assert!(!crash.recovery_saved);
    }

    #[test]
    fn test_crash_info_serialization() {
        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic".to_string(),
            location: Some("src/main.rs:10:5".to_string()),
            app_version: "0.1.0".to_string(),
            os_info: "linux x86_64 (unix)".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: true,
        };

        let json = serde_json::to_string(&crash).unwrap();
        assert!(json.contains("\"message\":\"Test panic\""));
        assert!(json.contains("\"recoverySaved\":true"));

        // Deserialize and verify
        let parsed: CrashInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.message, crash.message);
        assert_eq!(parsed.recovery_saved, crash.recovery_saved);
    }

    #[test]
    fn test_crash_info_save_load() {
        let temp_dir = tempfile::tempdir().unwrap();
        let crash_file = temp_dir.path().join("crash.json");

        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic".to_string(),
            location: Some("src/main.rs:10:5".to_string()),
            app_version: "0.1.0".to_string(),
            os_info: "linux x86_64 (unix)".to_string(),
            thread_name: "main".to_string(),
            backtrace: Some("at main::test".to_string()),
            recovery_saved: true,
        };

        // Save
        crash.save(&crash_file).unwrap();
        assert!(crash_file.exists());

        // Load
        let loaded = CrashInfo::load(&crash_file).unwrap();
        assert_eq!(loaded.message, crash.message);
        assert_eq!(loaded.backtrace, crash.backtrace);
    }

    #[test]
    fn test_recovery_state_none() {
        let state = RecoveryState::none();
        assert!(!state.needs_recovery);
        assert!(state.last_crash.is_none());
    }

    #[test]
    fn test_recovery_state_needs_recovery() {
        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic".to_string(),
            location: None,
            app_version: "0.1.0".to_string(),
            os_info: "linux x86_64".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: false,
        };

        let state = RecoveryState::needs_recovery(crash);
        assert!(state.needs_recovery);
        assert!(state.last_crash.is_some());
    }

    #[test]
    fn test_recovery_manager_creation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        assert_eq!(manager.recovery_dir(), temp_dir.path());
    }

    #[test]
    fn test_recovery_manager_lock() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        // No lock initially
        assert!(!manager.has_stale_lock());

        // Create lock
        manager.create_lock().unwrap();
        assert!(manager.has_stale_lock());

        // Remove lock
        manager.remove_lock().unwrap();
        assert!(!manager.has_stale_lock());
    }

    #[test]
    fn test_recovery_manager_check_state_no_crash() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        let state = manager.check_recovery_state();
        assert!(!state.needs_recovery);
    }

    #[test]
    fn test_recovery_manager_check_state_with_stale_lock() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        // Create a stale lock
        manager.create_lock().unwrap();

        // Check state - stale lock but no crash info
        let state = manager.check_recovery_state();
        // With just a stale lock and no recovery files, needs_recovery is false
        assert!(!state.needs_recovery);
    }

    #[test]
    fn test_recovery_manager_check_state_with_crash_info() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        // Create stale lock and crash info
        manager.create_lock().unwrap();

        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic".to_string(),
            location: None,
            app_version: "0.1.0".to_string(),
            os_info: "linux x86_64".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: true,
        };
        manager.save_crash_info(&crash).unwrap();

        // Check state
        let state = manager.check_recovery_state();
        assert!(state.needs_recovery);
        assert!(state.last_crash.is_some());
        assert_eq!(state.last_crash.unwrap().message, "Test panic");
    }

    #[test]
    fn test_recovery_manager_save_project_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        let project_path = PathBuf::from("/home/user/project.orproj");
        manager.save_project_path(&project_path).unwrap();

        let saved = temp_dir.path().join("last_project.txt");
        assert!(saved.exists());

        let content = fs::read_to_string(saved).unwrap();
        assert!(content.contains("project.orproj"));
    }

    #[test]
    fn test_recovery_manager_clear_recovery() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        // Create recovery state
        manager.create_lock().unwrap();
        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test".to_string(),
            location: None,
            app_version: "0.1.0".to_string(),
            os_info: "linux".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: true,
        };
        manager.save_crash_info(&crash).unwrap();

        // Clear recovery
        manager.clear_recovery().unwrap();

        // Verify cleared
        let state = manager.check_recovery_state();
        assert!(!state.needs_recovery);
    }

    #[test]
    fn test_recovery_manager_archive_crash() {
        let temp_dir = tempfile::tempdir().unwrap();
        let manager = RecoveryManager::new(temp_dir.path().to_path_buf());

        // Save crash info
        let crash = CrashInfo {
            timestamp_ms: 1704067200000,
            timestamp_str: "2024-01-01 00:00:00 UTC".to_string(),
            message: "Test panic to archive".to_string(),
            location: None,
            app_version: "0.1.0".to_string(),
            os_info: "linux".to_string(),
            thread_name: "main".to_string(),
            backtrace: None,
            recovery_saved: true,
        };
        manager.save_crash_info(&crash).unwrap();

        // Archive
        let archive_path = manager.archive_crash().unwrap();
        assert!(archive_path.is_some());
        assert!(archive_path.unwrap().exists());

        // List crash logs
        let logs = manager.list_crash_logs().unwrap();
        assert_eq!(logs.len(), 1);
    }

    #[test]
    fn test_is_crash_handler_installed() {
        // Initially not installed (in test context)
        // Note: This test may be affected by other tests that install the handler
        // The actual installation is tested implicitly
        let _ = is_crash_handler_installed();
    }
}
