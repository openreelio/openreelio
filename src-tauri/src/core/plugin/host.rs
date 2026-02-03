//! WASM Plugin Host
//!
//! Manages the WASM runtime and loaded plugins using wasmtime.
//! Provides sandboxed execution with controlled access to host resources.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use wasmtime::*;

use super::context::PluginContext;
use super::manifest::{PluginCapability, PluginManifest};
use super::permission::PermissionManager;
use crate::core::{CoreError, CoreResult};

/// Plugin host managing WASM runtime and loaded plugins
pub struct PluginHost {
    /// Wasmtime engine (shared across all plugins)
    engine: Engine,
    /// Loaded plugins
    plugins: Arc<RwLock<HashMap<String, LoadedPlugin>>>,
    /// Permission manager
    permission_manager: Arc<PermissionManager>,
    /// Plugin data directory
    data_dir: PathBuf,
    /// Plugin configuration
    config: PluginHostConfig,
}

/// Configuration for the plugin host
#[derive(Debug, Clone)]
pub struct PluginHostConfig {
    /// Maximum memory per plugin (bytes)
    pub max_memory_bytes: usize,
    /// Maximum execution time (milliseconds)
    pub max_execution_time_ms: u64,
    /// Enable fuel metering
    pub fuel_enabled: bool,
    /// Initial fuel amount
    pub initial_fuel: u64,
    /// Enable WASI support
    pub wasi_enabled: bool,
}

impl Default for PluginHostConfig {
    fn default() -> Self {
        Self {
            max_memory_bytes: 256 * 1024 * 1024, // 256MB
            max_execution_time_ms: 30000,        // 30 seconds
            fuel_enabled: true,
            initial_fuel: 1_000_000_000, // 1 billion fuel units
            wasi_enabled: true,
        }
    }
}

/// A loaded plugin instance
#[derive(Debug)]
pub struct LoadedPlugin {
    /// Plugin manifest
    pub manifest: PluginManifest,
    /// Plugin context
    pub context: Arc<PluginContext>,
    /// WASM module (compiled)
    module: Module,
    /// Plugin state
    pub state: PluginState,
    /// Load timestamp
    pub loaded_at: u64,
}

/// Plugin runtime state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginState {
    /// Plugin is loaded and ready
    Ready,
    /// Plugin is currently executing
    Running,
    /// Plugin execution was paused
    Paused,
    /// Plugin encountered an error
    Error(String),
    /// Plugin has been stopped
    Stopped,
}

/// Plugin execution result
#[derive(Debug)]
pub struct PluginExecutionResult {
    /// Return value (JSON)
    pub result: serde_json::Value,
    /// Fuel consumed
    pub fuel_consumed: u64,
    /// Execution time (ms)
    pub execution_time_ms: u64,
}

/// Plugin store state for wasmtime
#[derive(Debug)]
pub struct PluginStoreState {
    /// Plugin ID
    pub plugin_id: String,
    /// Plugin context reference
    pub context: Arc<PluginContext>,
    /// Permission manager reference
    pub permission_manager: Arc<PermissionManager>,
}

impl PluginHost {
    /// Creates a new plugin host
    pub fn new(data_dir: PathBuf, config: PluginHostConfig) -> CoreResult<Self> {
        // Create wasmtime configuration
        let mut wasmtime_config = Config::new();
        wasmtime_config.wasm_multi_memory(true);
        wasmtime_config.wasm_reference_types(true);

        if config.fuel_enabled {
            wasmtime_config.consume_fuel(true);
        }

        // Create engine
        let engine = Engine::new(&wasmtime_config)
            .map_err(|e| CoreError::PluginError(format!("Failed to create WASM engine: {}", e)))?;

        // Create data directory
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            CoreError::PluginError(format!("Failed to create plugin data directory: {}", e))
        })?;

        Ok(Self {
            engine,
            plugins: Arc::new(RwLock::new(HashMap::new())),
            permission_manager: Arc::new(PermissionManager::new()),
            data_dir,
            config,
        })
    }

    /// Loads a plugin from a directory containing manifest and WASM file
    pub async fn load_plugin(&self, plugin_dir: &Path) -> CoreResult<String> {
        // Load manifest
        let manifest_path = plugin_dir.join("plugin.json");
        let manifest = PluginManifest::load_from_file(&manifest_path)?;

        // Check if plugin is already loaded
        {
            let plugins = self.plugins.read().await;
            if plugins.contains_key(&manifest.id) {
                return Err(CoreError::PluginError(format!(
                    "Plugin '{}' is already loaded",
                    manifest.id
                )));
            }
        }

        // Register permissions
        self.permission_manager.register_plugin(&manifest).await?;

        // Load WASM module
        let wasm_path = plugin_dir.join(&manifest.entry);
        let wasm_bytes = std::fs::read(&wasm_path)
            .map_err(|e| CoreError::PluginError(format!("Failed to read WASM file: {}", e)))?;

        let module = Module::new(&self.engine, &wasm_bytes)
            .map_err(|e| CoreError::PluginError(format!("Failed to compile WASM module: {}", e)))?;

        // Create plugin context
        let context = Arc::new(PluginContext::new(
            manifest.id.clone(),
            Arc::clone(&self.permission_manager),
            &self.data_dir,
        )?);

        // Create loaded plugin
        let loaded = LoadedPlugin {
            manifest: manifest.clone(),
            context,
            module,
            state: PluginState::Ready,
            loaded_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
        };

        // Store plugin
        let plugin_id = manifest.id.clone();
        {
            let mut plugins = self.plugins.write().await;
            plugins.insert(plugin_id.clone(), loaded);
        }

        tracing::info!("Loaded plugin: {} v{}", manifest.name, manifest.version);

        Ok(plugin_id)
    }

    /// Unloads a plugin
    pub async fn unload_plugin(&self, plugin_id: &str) -> CoreResult<()> {
        let mut plugins = self.plugins.write().await;

        let plugin = plugins
            .remove(plugin_id)
            .ok_or_else(|| CoreError::PluginError(format!("Plugin '{}' not found", plugin_id)))?;

        // Cleanup context
        plugin.context.cleanup_temp().await?;

        // Unregister permissions
        self.permission_manager.unregister_plugin(plugin_id).await;

        tracing::info!("Unloaded plugin: {}", plugin_id);

        Ok(())
    }

    /// Gets a loaded plugin by ID
    pub async fn get_plugin(&self, plugin_id: &str) -> Option<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins.get(plugin_id).map(|p| PluginInfo {
            id: p.manifest.id.clone(),
            name: p.manifest.name.clone(),
            version: p.manifest.version.clone(),
            description: p.manifest.description.clone(),
            capabilities: p.manifest.capabilities.clone(),
            state: p.state.clone(),
            loaded_at: p.loaded_at,
        })
    }

    /// Lists all loaded plugins
    pub async fn list_plugins(&self) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins
            .values()
            .map(|p| PluginInfo {
                id: p.manifest.id.clone(),
                name: p.manifest.name.clone(),
                version: p.manifest.version.clone(),
                description: p.manifest.description.clone(),
                capabilities: p.manifest.capabilities.clone(),
                state: p.state.clone(),
                loaded_at: p.loaded_at,
            })
            .collect()
    }

    /// Gets plugins by capability
    pub async fn get_plugins_by_capability(
        &self,
        capability: &PluginCapability,
    ) -> Vec<PluginInfo> {
        let plugins = self.plugins.read().await;
        plugins
            .values()
            .filter(|p| p.manifest.has_capability(capability))
            .map(|p| PluginInfo {
                id: p.manifest.id.clone(),
                name: p.manifest.name.clone(),
                version: p.manifest.version.clone(),
                description: p.manifest.description.clone(),
                capabilities: p.manifest.capabilities.clone(),
                state: p.state.clone(),
                loaded_at: p.loaded_at,
            })
            .collect()
    }

    /// Creates a store for plugin execution
    pub fn create_store(
        &self,
        plugin_id: &str,
        context: Arc<PluginContext>,
    ) -> CoreResult<Store<PluginStoreState>> {
        let state = PluginStoreState {
            plugin_id: plugin_id.to_string(),
            context,
            permission_manager: Arc::clone(&self.permission_manager),
        };

        let mut store = Store::new(&self.engine, state);

        if self.config.fuel_enabled {
            store
                .set_fuel(self.config.initial_fuel)
                .map_err(|e| CoreError::PluginError(format!("Failed to set fuel: {}", e)))?;
        }

        Ok(store)
    }

    /// Instantiates a plugin module
    pub async fn instantiate_plugin(
        &self,
        plugin_id: &str,
    ) -> CoreResult<(Instance, Store<PluginStoreState>)> {
        let plugins = self.plugins.read().await;
        let plugin = plugins
            .get(plugin_id)
            .ok_or_else(|| CoreError::PluginError(format!("Plugin '{}' not found", plugin_id)))?;

        let context = Arc::clone(&plugin.context);
        let module = &plugin.module;

        let mut store = self.create_store(plugin_id, context)?;

        // Create linker and add host functions
        let mut linker = Linker::new(&self.engine);
        Self::add_host_functions(&mut linker)?;

        // Instantiate
        let instance = linker
            .instantiate(&mut store, module)
            .map_err(|e| CoreError::PluginError(format!("Failed to instantiate plugin: {}", e)))?;

        Ok((instance, store))
    }

    /// Adds host functions to the linker
    fn add_host_functions(linker: &mut Linker<PluginStoreState>) -> CoreResult<()> {
        // Log function
        linker
            .func_wrap(
                "env",
                "host_log",
                |mut caller: Caller<'_, PluginStoreState>, level: i32, ptr: i32, len: i32| {
                    let mem = caller.get_export("memory").and_then(|e| e.into_memory());

                    if let Some(memory) = mem {
                        let data = memory.data(&caller);
                        if let Some(slice) = data.get(ptr as usize..(ptr + len) as usize) {
                            if let Ok(message) = std::str::from_utf8(slice) {
                                let plugin_id = &caller.data().plugin_id;
                                match level {
                                    0 => tracing::debug!("[plugin:{}] {}", plugin_id, message),
                                    1 => tracing::info!("[plugin:{}] {}", plugin_id, message),
                                    2 => tracing::warn!("[plugin:{}] {}", plugin_id, message),
                                    _ => tracing::error!("[plugin:{}] {}", plugin_id, message),
                                }
                            }
                        }
                    }
                },
            )
            .map_err(|e| CoreError::PluginError(format!("Failed to add host_log: {}", e)))?;

        // Get current time
        linker
            .func_wrap("env", "host_time_now", || -> i64 {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0)
            })
            .map_err(|e| CoreError::PluginError(format!("Failed to add host_time_now: {}", e)))?;

        Ok(())
    }

    /// Gets the plugin state
    pub async fn get_plugin_state(&self, plugin_id: &str) -> Option<PluginState> {
        let plugins = self.plugins.read().await;
        plugins.get(plugin_id).map(|p| p.state.clone())
    }

    /// Sets the plugin state
    pub async fn set_plugin_state(&self, plugin_id: &str, state: PluginState) -> CoreResult<()> {
        let mut plugins = self.plugins.write().await;
        let plugin = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| CoreError::PluginError(format!("Plugin '{}' not found", plugin_id)))?;
        plugin.state = state;
        Ok(())
    }

    /// Gets the permission manager
    pub fn permission_manager(&self) -> &Arc<PermissionManager> {
        &self.permission_manager
    }

    /// Gets the data directory
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Gets the configuration
    pub fn config(&self) -> &PluginHostConfig {
        &self.config
    }

    /// Gets the wasmtime engine
    pub fn engine(&self) -> &Engine {
        &self.engine
    }
}

/// Plugin information for external queries
#[derive(Debug, Clone)]
pub struct PluginInfo {
    /// Plugin ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Version
    pub version: String,
    /// Description
    pub description: Option<String>,
    /// Capabilities
    pub capabilities: Vec<PluginCapability>,
    /// Current state
    pub state: PluginState,
    /// Load timestamp
    pub loaded_at: u64,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_host() -> (PluginHost, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let config = PluginHostConfig::default();
        let host = PluginHost::new(temp_dir.path().to_path_buf(), config).unwrap();
        (host, temp_dir)
    }

    fn create_minimal_wasm() -> Vec<u8> {
        // Minimal valid WASM module
        // (module)
        vec![
            0x00, 0x61, 0x73, 0x6d, // WASM magic number
            0x01, 0x00, 0x00, 0x00, // Version 1
        ]
    }

    fn create_test_plugin_dir(temp_dir: &TempDir) -> PathBuf {
        let plugin_dir = temp_dir.path().join("test-plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();

        // Create manifest
        let manifest = r#"{
            "id": "test.plugin",
            "name": "Test Plugin",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();

        // Create minimal WASM
        std::fs::write(plugin_dir.join("plugin.wasm"), create_minimal_wasm()).unwrap();

        plugin_dir
    }

    // ========================================================================
    // PluginHost Creation Tests
    // ========================================================================

    #[test]
    fn test_create_host() {
        let (host, _temp) = create_test_host();
        assert!(host.data_dir().exists());
    }

    #[test]
    fn test_host_config_default() {
        let config = PluginHostConfig::default();
        assert_eq!(config.max_memory_bytes, 256 * 1024 * 1024);
        assert_eq!(config.max_execution_time_ms, 30000);
        assert!(config.fuel_enabled);
        assert!(config.wasi_enabled);
    }

    // ========================================================================
    // Plugin Loading Tests
    // ========================================================================

    #[tokio::test]
    async fn test_load_plugin() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        let plugin_id = host.load_plugin(&plugin_dir).await.unwrap();

        assert_eq!(plugin_id, "test.plugin");
    }

    #[tokio::test]
    async fn test_load_plugin_missing_manifest() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let empty_dir = temp_dir.path().join("empty");
        std::fs::create_dir_all(&empty_dir).unwrap();

        let result = host.load_plugin(&empty_dir).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_load_plugin_duplicate() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        // Try to load again
        let result = host.load_plugin(&plugin_dir).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("already loaded"));
    }

    // ========================================================================
    // Plugin Info Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_plugin() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        let info = host.get_plugin("test.plugin").await.unwrap();
        assert_eq!(info.id, "test.plugin");
        assert_eq!(info.name, "Test Plugin");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.state, PluginState::Ready);
    }

    #[tokio::test]
    async fn test_get_plugin_not_found() {
        let (host, _temp) = create_test_host();
        let info = host.get_plugin("nonexistent").await;
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_list_plugins() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        // Initially empty
        assert!(host.list_plugins().await.is_empty());

        // Load a plugin
        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        let plugins = host.list_plugins().await;
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].id, "test.plugin");
    }

    // ========================================================================
    // Plugin Capability Tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_plugins_by_capability() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        // Has AssetProvider capability
        let asset_providers = host
            .get_plugins_by_capability(&PluginCapability::AssetProvider)
            .await;
        assert_eq!(asset_providers.len(), 1);

        // Does not have EditAssistant capability
        let edit_assistants = host
            .get_plugins_by_capability(&PluginCapability::EditAssistant)
            .await;
        assert!(edit_assistants.is_empty());
    }

    // ========================================================================
    // Plugin Unload Tests
    // ========================================================================

    #[tokio::test]
    async fn test_unload_plugin() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        assert!(host.get_plugin("test.plugin").await.is_some());

        host.unload_plugin("test.plugin").await.unwrap();

        assert!(host.get_plugin("test.plugin").await.is_none());
    }

    #[tokio::test]
    async fn test_unload_plugin_not_found() {
        let (host, _temp) = create_test_host();
        let result = host.unload_plugin("nonexistent").await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Plugin State Tests
    // ========================================================================

    #[tokio::test]
    async fn test_plugin_state_transitions() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        // Initial state
        let state = host.get_plugin_state("test.plugin").await.unwrap();
        assert_eq!(state, PluginState::Ready);

        // Change state
        host.set_plugin_state("test.plugin", PluginState::Running)
            .await
            .unwrap();
        let state = host.get_plugin_state("test.plugin").await.unwrap();
        assert_eq!(state, PluginState::Running);

        // Set error state
        host.set_plugin_state("test.plugin", PluginState::Error("Test error".to_string()))
            .await
            .unwrap();
        let state = host.get_plugin_state("test.plugin").await.unwrap();
        assert_eq!(state, PluginState::Error("Test error".to_string()));
    }

    // ========================================================================
    // Store Creation Tests
    // ========================================================================

    #[tokio::test]
    async fn test_create_store() {
        let temp_dir = TempDir::new().unwrap();
        let host =
            PluginHost::new(temp_dir.path().to_path_buf(), PluginHostConfig::default()).unwrap();

        let plugin_dir = create_test_plugin_dir(&temp_dir);
        host.load_plugin(&plugin_dir).await.unwrap();

        let context = Arc::new(
            PluginContext::new(
                "test.plugin".to_string(),
                host.permission_manager().clone(),
                host.data_dir(),
            )
            .unwrap(),
        );

        let store = host.create_store("test.plugin", context).unwrap();
        assert_eq!(store.data().plugin_id, "test.plugin");
    }

    // ========================================================================
    // PluginInfo Tests
    // ========================================================================

    #[test]
    fn test_plugin_info_clone() {
        let info = PluginInfo {
            id: "test".to_string(),
            name: "Test".to_string(),
            version: "1.0.0".to_string(),
            description: Some("Description".to_string()),
            capabilities: vec![PluginCapability::AssetProvider],
            state: PluginState::Ready,
            loaded_at: 12345,
        };

        let cloned = info.clone();
        assert_eq!(cloned.id, info.id);
        assert_eq!(cloned.name, info.name);
    }

    // ========================================================================
    // PluginState Tests
    // ========================================================================

    #[test]
    fn test_plugin_state_equality() {
        assert_eq!(PluginState::Ready, PluginState::Ready);
        assert_eq!(PluginState::Running, PluginState::Running);
        assert_eq!(
            PluginState::Error("test".to_string()),
            PluginState::Error("test".to_string())
        );
        assert_ne!(
            PluginState::Error("a".to_string()),
            PluginState::Error("b".to_string())
        );
        assert_ne!(PluginState::Ready, PluginState::Running);
    }
}
