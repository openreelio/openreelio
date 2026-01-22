//! Meilisearch Sidecar Process Management
//!
//! Manages the lifecycle of an embedded Meilisearch instance running as a sidecar
//! process. This module handles starting, stopping, and health checking the
//! Meilisearch server.

use std::path::PathBuf;
use thiserror::Error;

use uuid::Uuid;

#[cfg(feature = "meilisearch")]
use std::time::Duration;
#[cfg(feature = "meilisearch")]
use tokio::process::{Child, Command};

// =============================================================================
// Error Types
// =============================================================================

/// Errors that can occur during Meilisearch sidecar operations
#[derive(Error, Debug)]
pub enum SidecarError {
    /// Meilisearch binary not found
    #[error("Meilisearch binary not found at: {0}")]
    BinaryNotFound(String),

    /// Failed to start the Meilisearch process
    #[error("Failed to start Meilisearch: {0}")]
    StartFailed(String),

    /// Meilisearch process exited unexpectedly
    #[error("Meilisearch process exited unexpectedly")]
    ProcessExited,

    /// Health check failed
    #[error("Health check failed: {0}")]
    HealthCheckFailed(String),

    /// Meilisearch feature not enabled
    #[error("Meilisearch feature not enabled. Rebuild with --features meilisearch")]
    FeatureNotEnabled,

    /// IO error
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for sidecar operations
pub type SidecarResult<T> = Result<T, SidecarError>;

// =============================================================================
// Sidecar Configuration
// =============================================================================

/// Configuration for the Meilisearch sidecar
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    /// Path to the Meilisearch binary
    pub binary_path: PathBuf,
    /// Directory for Meilisearch data storage
    pub data_dir: PathBuf,
    /// HTTP address to bind to
    pub http_addr: String,
    /// Master key for authentication
    pub master_key: String,
    /// Maximum database size in bytes
    pub max_db_size: Option<u64>,
    /// Enable analytics (default: false)
    pub analytics: bool,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        let data_dir = default_data_dir();
        Self {
            binary_path: PathBuf::from("meilisearch"),
            master_key: load_or_create_master_key(&data_dir),
            data_dir,
            http_addr: "127.0.0.1:7700".to_string(),
            max_db_size: Some(1024 * 1024 * 1024), // 1GB default
            analytics: false,
        }
    }
}

impl SidecarConfig {
    /// Creates a new configuration with a custom data directory
    pub fn with_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            ..Default::default()
        }
    }

    /// Sets the HTTP address
    pub fn with_http_addr(mut self, addr: impl Into<String>) -> Self {
        self.http_addr = addr.into();
        self
    }

    /// Sets the master key
    pub fn with_master_key(mut self, key: impl Into<String>) -> Self {
        self.master_key = key.into();
        self
    }

    /// Sets the binary path
    pub fn with_binary_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary_path = path.into();
        self
    }

    /// Returns the URL for client connections
    pub fn client_url(&self) -> String {
        format!("http://{}", self.http_addr)
    }
}

/// Returns the default data directory for Meilisearch
pub fn default_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("openreelio")
        .join("search")
}

fn load_or_create_master_key(data_dir: &PathBuf) -> String {
    // A stable secret key is required so the sidecar and indexer can reconnect.
    // We store it in the data directory. This is local-only (127.0.0.1) but
    // still should not be a hardcoded constant.
    let key_path = data_dir.join("master.key");

    if let Ok(key) = std::fs::read_to_string(&key_path) {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let key = format!("openreelio-{}", Uuid::new_v4());
    if let Err(e) = std::fs::create_dir_all(data_dir) {
        tracing::warn!(
            "Failed to create search data dir {}: {}",
            data_dir.display(),
            e
        );
        return key;
    }

    if let Err(e) = std::fs::write(&key_path, &key) {
        tracing::warn!(
            "Failed to persist Meilisearch master key to {}: {}",
            key_path.display(),
            e
        );
    }

    key
}

// =============================================================================
// Sidecar Manager - Feature-gated Implementation
// =============================================================================

#[cfg(feature = "meilisearch")]
mod manager_impl {
    use super::*;

    /// Manages the Meilisearch sidecar process
    pub struct MeilisearchSidecar {
        config: SidecarConfig,
        process: Option<Child>,
    }

    impl MeilisearchSidecar {
        /// Creates a new sidecar manager with the given configuration
        pub fn new(config: SidecarConfig) -> Self {
            Self {
                config,
                process: None,
            }
        }

        /// Starts the Meilisearch sidecar process
        pub async fn start(&mut self) -> SidecarResult<()> {
            // Verify binary exists
            if !self.config.binary_path.exists() {
                // Try to find bundled binary
                let bundled_path = find_bundled_binary();
                if let Some(path) = bundled_path {
                    self.config.binary_path = path.clone();
                    tracing::info!("Using bundled Meilisearch at: {}", path.display());
                } else {
                    return Err(SidecarError::BinaryNotFound(
                        self.config.binary_path.to_string_lossy().to_string(),
                    ));
                }
            }

            // Ensure data directory exists
            std::fs::create_dir_all(&self.config.data_dir)?;

            let db_path = self.config.data_dir.to_str().ok_or_else(|| {
                SidecarError::StartFailed(format!(
                    "Meilisearch data_dir must be valid UTF-8: {}",
                    self.config.data_dir.display()
                ))
            })?;

            // Build command arguments
            let mut cmd = Command::new(&self.config.binary_path);
            cmd.args([
                "--db-path",
                db_path,
                "--http-addr",
                &self.config.http_addr,
                "--master-key",
                &self.config.master_key,
            ]);

            if !self.config.analytics {
                cmd.arg("--no-analytics");
            }

            if let Some(max_size) = self.config.max_db_size {
                cmd.args(["--max-indexing-memory", &format!("{}", max_size)]);
            }

            // Start process
            let process = cmd
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| SidecarError::StartFailed(e.to_string()))?;

            tracing::info!(
                "Started Meilisearch sidecar on {} (PID: {:?})",
                self.config.http_addr,
                process.id()
            );

            self.process = Some(process);

            // Wait for server to be ready
            self.wait_for_ready(Duration::from_secs(30)).await?;

            Ok(())
        }

        /// Stops the Meilisearch sidecar process
        pub async fn stop(&mut self) -> SidecarResult<()> {
            if let Some(mut process) = self.process.take() {
                tracing::info!("Stopping Meilisearch sidecar...");
                process.kill().await?;
                tracing::info!("Meilisearch sidecar stopped");
            }
            Ok(())
        }

        /// Checks if the sidecar is running
        pub fn is_running(&mut self) -> bool {
            if let Some(ref mut process) = self.process {
                match process.try_wait() {
                    Ok(None) => true,     // Still running
                    Ok(Some(_)) => false, // Exited
                    Err(_) => false,
                }
            } else {
                false
            }
        }

        /// Waits for the Meilisearch server to be ready
        async fn wait_for_ready(&self, timeout: Duration) -> SidecarResult<()> {
            let start = std::time::Instant::now();
            let client = reqwest::Client::new();
            let health_url = format!("{}/health", self.config.client_url());

            while start.elapsed() < timeout {
                match client.get(&health_url).send().await {
                    Ok(response) if response.status().is_success() => {
                        tracing::info!("Meilisearch is ready");
                        return Ok(());
                    }
                    _ => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }

            Err(SidecarError::HealthCheckFailed(
                "Timed out waiting for Meilisearch to start".to_string(),
            ))
        }

        /// Returns the configuration
        pub fn config(&self) -> &SidecarConfig {
            &self.config
        }
    }

    impl Drop for MeilisearchSidecar {
        fn drop(&mut self) {
            // Kill process on drop (kill_on_drop already set, but be explicit)
            if let Some(mut process) = self.process.take() {
                let _ = process.start_kill();
            }
        }
    }

    /// Finds the bundled Meilisearch binary
    fn find_bundled_binary() -> Option<PathBuf> {
        // Check in same directory as executable
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                #[cfg(target_os = "windows")]
                let binary_name = "meilisearch.exe";
                #[cfg(not(target_os = "windows"))]
                let binary_name = "meilisearch";

                let bundled = exe_dir.join(binary_name);
                if bundled.exists() {
                    return Some(bundled);
                }

                // Check in resources directory (Tauri bundled)
                let resources = exe_dir.join("resources").join(binary_name);
                if resources.exists() {
                    return Some(resources);
                }
            }
        }

        None
    }
}

#[cfg(feature = "meilisearch")]
pub use manager_impl::MeilisearchSidecar;

// =============================================================================
// Stub Implementation (when meilisearch feature is disabled)
// =============================================================================

#[cfg(not(feature = "meilisearch"))]
#[derive(Debug)]
pub struct MeilisearchSidecar {
    config: SidecarConfig,
}

#[cfg(not(feature = "meilisearch"))]
impl MeilisearchSidecar {
    /// Creates a new sidecar manager (stub)
    pub fn new(config: SidecarConfig) -> Self {
        Self { config }
    }

    /// Starts the Meilisearch sidecar process (stub - returns error)
    pub async fn start(&mut self) -> SidecarResult<()> {
        Err(SidecarError::FeatureNotEnabled)
    }

    /// Stops the Meilisearch sidecar process (stub)
    pub async fn stop(&mut self) -> SidecarResult<()> {
        Err(SidecarError::FeatureNotEnabled)
    }

    /// Checks if the sidecar is running (stub - always false)
    pub fn is_running(&mut self) -> bool {
        false
    }

    /// Returns the configuration
    pub fn config(&self) -> &SidecarConfig {
        &self.config
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Checks if Meilisearch is available
pub fn is_meilisearch_available() -> bool {
    cfg!(feature = "meilisearch")
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sidecar_config_default() {
        let config = SidecarConfig::default();

        assert_eq!(config.http_addr, "127.0.0.1:7700");
        assert!(!config.master_key.trim().is_empty());
        assert!(!config.analytics);
        assert!(config.max_db_size.is_some());
    }

    #[test]
    fn test_sidecar_config_builder() {
        let config = SidecarConfig::with_data_dir("/custom/path")
            .with_http_addr("127.0.0.1:7701")
            .with_master_key("custom-key");

        assert_eq!(config.data_dir, PathBuf::from("/custom/path"));
        assert_eq!(config.http_addr, "127.0.0.1:7701");
        assert_eq!(config.master_key, "custom-key");
    }

    #[test]
    fn test_sidecar_config_client_url() {
        let config = SidecarConfig::default();
        assert_eq!(config.client_url(), "http://127.0.0.1:7700");

        let custom = SidecarConfig::default().with_http_addr("localhost:8080");
        assert_eq!(custom.client_url(), "http://localhost:8080");
    }

    #[test]
    fn test_default_data_dir() {
        let dir = default_data_dir();
        assert!(dir.to_string_lossy().contains("search"));
    }

    #[test]
    fn test_is_meilisearch_available() {
        let available = is_meilisearch_available();
        #[cfg(feature = "meilisearch")]
        assert!(available);
        #[cfg(not(feature = "meilisearch"))]
        assert!(!available);
    }

    #[cfg(not(feature = "meilisearch"))]
    #[test]
    fn test_stub_returns_error() {
        let mut sidecar = MeilisearchSidecar::new(SidecarConfig::default());
        assert!(!sidecar.is_running());
    }
}
