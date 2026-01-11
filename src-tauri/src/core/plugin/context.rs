//! Plugin Context
//!
//! Provides the runtime context for executing plugins.
//! Manages state, permissions, and host function callbacks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use super::permission::{PermissionManager, PermissionScope};
use crate::core::{CoreError, CoreResult};

/// Plugin execution context
#[derive(Debug)]
pub struct PluginContext {
    /// Plugin ID this context belongs to
    plugin_id: String,
    /// Permission manager reference
    permission_manager: Arc<PermissionManager>,
    /// Plugin data directory
    data_dir: PathBuf,
    /// Temporary directory for this plugin
    temp_dir: PathBuf,
    /// Plugin configuration
    config: Arc<RwLock<serde_json::Value>>,
    /// Plugin-specific key-value storage
    storage: Arc<RwLock<HashMap<String, serde_json::Value>>>,
    /// HTTP client configuration
    http_config: HttpConfig,
    /// Logging configuration
    log_config: LogConfig,
}

/// HTTP client configuration for plugins
#[derive(Debug, Clone)]
pub struct HttpConfig {
    /// Request timeout in seconds
    pub timeout_sec: u64,
    /// Maximum response size in bytes
    pub max_response_size: usize,
    /// User agent string
    pub user_agent: String,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            timeout_sec: 30,
            max_response_size: 50 * 1024 * 1024, // 50MB
            user_agent: format!("OpenReelio-Plugin/1.0"),
        }
    }
}

/// Logging configuration for plugins
#[derive(Debug, Clone)]
pub struct LogConfig {
    /// Maximum log entries to keep
    pub max_entries: usize,
    /// Whether to forward logs to main application
    pub forward_to_app: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            max_entries: 1000,
            forward_to_app: true,
        }
    }
}

/// Log entry from plugin
#[derive(Debug, Clone)]
pub struct PluginLogEntry {
    /// Timestamp
    pub timestamp: u64,
    /// Log level
    pub level: LogLevel,
    /// Message
    pub message: String,
    /// Additional data
    pub data: Option<serde_json::Value>,
}

/// Log level
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl PluginContext {
    /// Creates a new plugin context
    pub fn new(
        plugin_id: String,
        permission_manager: Arc<PermissionManager>,
        base_data_dir: &Path,
    ) -> CoreResult<Self> {
        let data_dir = base_data_dir.join("plugins").join(&plugin_id);
        let temp_dir = base_data_dir.join("temp").join(&plugin_id);

        // Create directories if they don't exist
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            CoreError::PluginError(format!("Failed to create plugin data directory: {}", e))
        })?;
        std::fs::create_dir_all(&temp_dir).map_err(|e| {
            CoreError::PluginError(format!("Failed to create plugin temp directory: {}", e))
        })?;

        Ok(Self {
            plugin_id,
            permission_manager,
            data_dir,
            temp_dir,
            config: Arc::new(RwLock::new(serde_json::Value::Null)),
            storage: Arc::new(RwLock::new(HashMap::new())),
            http_config: HttpConfig::default(),
            log_config: LogConfig::default(),
        })
    }

    /// Gets the plugin ID
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Gets the plugin data directory
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Gets the plugin temp directory
    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }

    // ========================================================================
    // File System Operations
    // ========================================================================

    /// Reads a file from the plugin's data directory
    pub async fn read_file(&self, relative_path: &str) -> CoreResult<Vec<u8>> {
        let full_path = self.data_dir.join(relative_path);

        // Validate path is within data directory
        self.validate_path_in_data_dir(&full_path)?;

        // Check permission
        self.permission_manager
            .require(&self.plugin_id, &PermissionScope::FileRead, relative_path)
            .await?;

        std::fs::read(&full_path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read file '{}': {}", relative_path, e))
        })
    }

    /// Writes a file to the plugin's data directory
    pub async fn write_file(&self, relative_path: &str, data: &[u8]) -> CoreResult<()> {
        let full_path = self.data_dir.join(relative_path);

        // Validate path is within data directory
        self.validate_path_in_data_dir(&full_path)?;

        // Check permission
        self.permission_manager
            .require(&self.plugin_id, &PermissionScope::FileWrite, relative_path)
            .await?;

        // Create parent directories if needed
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CoreError::PluginError(format!("Failed to create directory: {}", e))
            })?;
        }

        std::fs::write(&full_path, data).map_err(|e| {
            CoreError::PluginError(format!("Failed to write file '{}': {}", relative_path, e))
        })
    }

    /// Deletes a file from the plugin's data directory
    pub async fn delete_file(&self, relative_path: &str) -> CoreResult<()> {
        let full_path = self.data_dir.join(relative_path);

        // Validate path is within data directory
        self.validate_path_in_data_dir(&full_path)?;

        // Check permission
        self.permission_manager
            .require(&self.plugin_id, &PermissionScope::FileWrite, relative_path)
            .await?;

        std::fs::remove_file(&full_path).map_err(|e| {
            CoreError::PluginError(format!("Failed to delete file '{}': {}", relative_path, e))
        })
    }

    /// Lists files in a directory within the plugin's data directory
    pub async fn list_files(&self, relative_dir: &str) -> CoreResult<Vec<String>> {
        let full_path = self.data_dir.join(relative_dir);

        // Validate path is within data directory
        self.validate_path_in_data_dir(&full_path)?;

        // Check permission
        self.permission_manager
            .require(&self.plugin_id, &PermissionScope::FileRead, relative_dir)
            .await?;

        let entries = std::fs::read_dir(&full_path).map_err(|e| {
            CoreError::PluginError(format!("Failed to list directory '{}': {}", relative_dir, e))
        })?;

        let mut files = Vec::new();
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }

        Ok(files)
    }

    /// Writes a file to the plugin's temp directory
    pub async fn write_temp_file(&self, relative_path: &str, data: &[u8]) -> CoreResult<PathBuf> {
        let full_path = self.temp_dir.join(relative_path);

        // Validate path is within temp directory
        self.validate_path_in_temp_dir(&full_path)?;

        // Create parent directories if needed
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                CoreError::PluginError(format!("Failed to create temp directory: {}", e))
            })?;
        }

        std::fs::write(&full_path, data).map_err(|e| {
            CoreError::PluginError(format!("Failed to write temp file '{}': {}", relative_path, e))
        })?;

        Ok(full_path)
    }

    /// Cleans up the plugin's temp directory
    pub async fn cleanup_temp(&self) -> CoreResult<()> {
        if self.temp_dir.exists() {
            std::fs::remove_dir_all(&self.temp_dir).map_err(|e| {
                CoreError::PluginError(format!("Failed to cleanup temp directory: {}", e))
            })?;
            std::fs::create_dir_all(&self.temp_dir).map_err(|e| {
                CoreError::PluginError(format!("Failed to recreate temp directory: {}", e))
            })?;
        }
        Ok(())
    }

    // ========================================================================
    // Key-Value Storage
    // ========================================================================

    /// Gets a value from plugin storage
    pub async fn storage_get(&self, key: &str) -> Option<serde_json::Value> {
        let storage = self.storage.read().await;
        storage.get(key).cloned()
    }

    /// Sets a value in plugin storage
    pub async fn storage_set(&self, key: &str, value: serde_json::Value) {
        let mut storage = self.storage.write().await;
        storage.insert(key.to_string(), value);
    }

    /// Removes a value from plugin storage
    pub async fn storage_remove(&self, key: &str) -> Option<serde_json::Value> {
        let mut storage = self.storage.write().await;
        storage.remove(key)
    }

    /// Gets all storage keys
    pub async fn storage_keys(&self) -> Vec<String> {
        let storage = self.storage.read().await;
        storage.keys().cloned().collect()
    }

    /// Clears all storage
    pub async fn storage_clear(&self) {
        let mut storage = self.storage.write().await;
        storage.clear();
    }

    // ========================================================================
    // Configuration
    // ========================================================================

    /// Gets the plugin configuration
    pub async fn get_config(&self) -> serde_json::Value {
        self.config.read().await.clone()
    }

    /// Sets the plugin configuration
    pub async fn set_config(&self, config: serde_json::Value) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    /// Gets a configuration value by path (e.g., "api.key")
    pub async fn get_config_value(&self, path: &str) -> Option<serde_json::Value> {
        let config = self.config.read().await;
        let parts: Vec<&str> = path.split('.').collect();

        let mut current = &*config;
        for part in parts {
            current = current.get(part)?;
        }

        Some(current.clone())
    }

    // ========================================================================
    // HTTP Configuration
    // ========================================================================

    /// Sets HTTP configuration
    pub fn set_http_config(&mut self, config: HttpConfig) {
        self.http_config = config;
    }

    /// Gets HTTP configuration
    pub fn http_config(&self) -> &HttpConfig {
        &self.http_config
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /// Validates that a path is within the data directory
    fn validate_path_in_data_dir(&self, path: &Path) -> CoreResult<()> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let data_canonical = self.data_dir.canonicalize().unwrap_or_else(|_| self.data_dir.clone());

        if !canonical.starts_with(&data_canonical) {
            return Err(CoreError::PermissionDenied(format!(
                "Path '{}' is outside plugin data directory",
                path.display()
            )));
        }

        Ok(())
    }

    /// Validates that a path is within the temp directory
    fn validate_path_in_temp_dir(&self, path: &Path) -> CoreResult<()> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let temp_canonical = self.temp_dir.canonicalize().unwrap_or_else(|_| self.temp_dir.clone());

        if !canonical.starts_with(&temp_canonical) {
            return Err(CoreError::PermissionDenied(format!(
                "Path '{}' is outside plugin temp directory",
                path.display()
            )));
        }

        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn create_test_context() -> (PluginContext, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let permission_manager = Arc::new(PermissionManager::new());

        let context = PluginContext::new(
            "test-plugin".to_string(),
            permission_manager,
            temp_dir.path(),
        )
        .unwrap();

        (context, temp_dir)
    }

    // ========================================================================
    // Context Creation Tests
    // ========================================================================

    #[tokio::test]
    async fn test_create_context() {
        let (context, _temp) = create_test_context().await;

        assert_eq!(context.plugin_id(), "test-plugin");
        assert!(context.data_dir().exists());
        assert!(context.temp_dir().exists());
    }

    #[tokio::test]
    async fn test_context_directories_created() {
        let temp_dir = TempDir::new().unwrap();
        let permission_manager = Arc::new(PermissionManager::new());

        let context = PluginContext::new(
            "new-plugin".to_string(),
            permission_manager,
            temp_dir.path(),
        )
        .unwrap();

        assert!(context.data_dir().exists());
        assert!(context.temp_dir().exists());
        assert!(context.data_dir().ends_with("new-plugin"));
    }

    // ========================================================================
    // Storage Tests
    // ========================================================================

    #[tokio::test]
    async fn test_storage_set_get() {
        let (context, _temp) = create_test_context().await;

        context
            .storage_set("key1", serde_json::json!("value1"))
            .await;
        context
            .storage_set("key2", serde_json::json!(42))
            .await;

        let value1 = context.storage_get("key1").await;
        let value2 = context.storage_get("key2").await;

        assert_eq!(value1, Some(serde_json::json!("value1")));
        assert_eq!(value2, Some(serde_json::json!(42)));
    }

    #[tokio::test]
    async fn test_storage_get_nonexistent() {
        let (context, _temp) = create_test_context().await;

        let value = context.storage_get("nonexistent").await;
        assert!(value.is_none());
    }

    #[tokio::test]
    async fn test_storage_remove() {
        let (context, _temp) = create_test_context().await;

        context.storage_set("key", serde_json::json!("value")).await;
        let removed = context.storage_remove("key").await;

        assert_eq!(removed, Some(serde_json::json!("value")));
        assert!(context.storage_get("key").await.is_none());
    }

    #[tokio::test]
    async fn test_storage_keys() {
        let (context, _temp) = create_test_context().await;

        context.storage_set("a", serde_json::json!(1)).await;
        context.storage_set("b", serde_json::json!(2)).await;
        context.storage_set("c", serde_json::json!(3)).await;

        let keys = context.storage_keys().await;
        assert_eq!(keys.len(), 3);
        assert!(keys.contains(&"a".to_string()));
        assert!(keys.contains(&"b".to_string()));
        assert!(keys.contains(&"c".to_string()));
    }

    #[tokio::test]
    async fn test_storage_clear() {
        let (context, _temp) = create_test_context().await;

        context.storage_set("a", serde_json::json!(1)).await;
        context.storage_set("b", serde_json::json!(2)).await;
        context.storage_clear().await;

        assert!(context.storage_keys().await.is_empty());
    }

    // ========================================================================
    // Configuration Tests
    // ========================================================================

    #[tokio::test]
    async fn test_config_set_get() {
        let (context, _temp) = create_test_context().await;

        let config = serde_json::json!({
            "api": {
                "key": "secret123",
                "endpoint": "https://api.example.com"
            },
            "enabled": true
        });

        context.set_config(config.clone()).await;
        let retrieved = context.get_config().await;

        assert_eq!(retrieved, config);
    }

    #[tokio::test]
    async fn test_config_get_value_by_path() {
        let (context, _temp) = create_test_context().await;

        let config = serde_json::json!({
            "api": {
                "key": "secret123",
                "settings": {
                    "timeout": 30
                }
            }
        });

        context.set_config(config).await;

        let api_key = context.get_config_value("api.key").await;
        assert_eq!(api_key, Some(serde_json::json!("secret123")));

        let timeout = context.get_config_value("api.settings.timeout").await;
        assert_eq!(timeout, Some(serde_json::json!(30)));

        let nonexistent = context.get_config_value("api.nonexistent").await;
        assert!(nonexistent.is_none());
    }

    // ========================================================================
    // Temp File Tests
    // ========================================================================

    #[tokio::test]
    async fn test_write_temp_file() {
        let (context, _temp) = create_test_context().await;

        let data = b"test content";
        let path = context.write_temp_file("test.txt", data).await.unwrap();

        assert!(path.exists());
        let content = std::fs::read(&path).unwrap();
        assert_eq!(content, data);
    }

    #[tokio::test]
    async fn test_write_temp_file_with_subdirectory() {
        let (context, _temp) = create_test_context().await;

        let data = b"nested content";
        let path = context
            .write_temp_file("subdir/nested.txt", data)
            .await
            .unwrap();

        assert!(path.exists());
        assert!(path.to_string_lossy().contains("subdir"));
    }

    #[tokio::test]
    async fn test_cleanup_temp() {
        let (context, _temp) = create_test_context().await;

        // Create some temp files
        context.write_temp_file("file1.txt", b"data1").await.unwrap();
        context.write_temp_file("file2.txt", b"data2").await.unwrap();

        // Cleanup
        context.cleanup_temp().await.unwrap();

        // Temp directory should be empty
        let entries: Vec<_> = std::fs::read_dir(context.temp_dir()).unwrap().collect();
        assert!(entries.is_empty());
    }

    // ========================================================================
    // HTTP Config Tests
    // ========================================================================

    #[test]
    fn test_http_config_default() {
        let config = HttpConfig::default();

        assert_eq!(config.timeout_sec, 30);
        assert_eq!(config.max_response_size, 50 * 1024 * 1024);
        assert!(config.user_agent.contains("OpenReelio"));
    }

    // ========================================================================
    // Log Config Tests
    // ========================================================================

    #[test]
    fn test_log_config_default() {
        let config = LogConfig::default();

        assert_eq!(config.max_entries, 1000);
        assert!(config.forward_to_app);
    }

    // ========================================================================
    // Path Validation Tests
    // ========================================================================

    #[tokio::test]
    async fn test_validate_path_in_data_dir() {
        let (context, _temp) = create_test_context().await;

        // Valid path
        let valid = context.data_dir().join("file.txt");
        assert!(context.validate_path_in_data_dir(&valid).is_ok());
    }
}
