//! Plugin Permission Manager
//!
//! Manages plugin permissions with granular access control.
//! Ensures plugins can only access resources they have been granted.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::manifest::{PluginManifest, PluginPermissions};
use crate::core::{CoreError, CoreResult};

/// Permission scope defining the type of access
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PermissionScope {
    /// Read-only access to project files
    ProjectRead,
    /// Write access to project files
    ProjectWrite,
    /// Read access to specific paths
    FileRead,
    /// Write access to specific paths
    FileWrite,
    /// Access to temporary directory
    TempAccess,
    /// Network access to specific domains
    Network,
    /// AI model access
    Model,
    /// Custom permission
    Custom(String),
}

/// A single permission grant
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Permission {
    /// Permission scope
    pub scope: PermissionScope,
    /// Pattern for matching (e.g., "assets/*", "https://api.example.com/*")
    pub pattern: String,
    /// Whether this permission is currently active
    pub active: bool,
}

/// Permission status for checking
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionStatus {
    /// Permission granted
    Granted,
    /// Permission denied
    Denied,
    /// Permission not requested (implicit deny)
    NotRequested,
}

/// Manages permissions for all loaded plugins
#[derive(Debug)]
pub struct PermissionManager {
    /// Permissions per plugin (plugin_id -> permissions)
    permissions: Arc<RwLock<HashMap<String, Vec<Permission>>>>,
    /// Revoked permissions (plugin_id -> revoked patterns)
    revoked: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    /// Project root path for resolving project: patterns
    project_root: Arc<RwLock<Option<String>>>,
}

impl Permission {
    /// Creates a new permission
    pub fn new(scope: PermissionScope, pattern: String) -> Self {
        Self {
            scope,
            pattern,
            active: true,
        }
    }

    /// Checks if this permission matches the given request
    pub fn matches(&self, scope: &PermissionScope, resource: &str) -> bool {
        if !self.active {
            return false;
        }

        if &self.scope != scope {
            return false;
        }

        Self::pattern_matches(&self.pattern, resource)
    }

    /// Glob-like pattern matching
    fn pattern_matches(pattern: &str, resource: &str) -> bool {
        // Handle exact match
        if pattern == resource {
            return true;
        }

        // Handle wildcard patterns
        if let Some(prefix) = pattern.strip_suffix("/*") {
            return resource.starts_with(prefix);
        }

        if let Some(prefix) = pattern.strip_suffix('*') {
            return resource.starts_with(prefix);
        }

        // Handle directory prefix matching
        if pattern.ends_with('/') {
            return resource.starts_with(pattern);
        }

        false
    }
}

impl PermissionManager {
    /// Creates a new permission manager
    pub fn new() -> Self {
        Self {
            permissions: Arc::new(RwLock::new(HashMap::new())),
            revoked: Arc::new(RwLock::new(HashMap::new())),
            project_root: Arc::new(RwLock::new(None)),
        }
    }

    /// Sets the project root path
    pub async fn set_project_root(&self, path: String) {
        let mut root = self.project_root.write().await;
        *root = Some(path);
    }

    /// Registers permissions for a plugin from its manifest
    pub async fn register_plugin(&self, manifest: &PluginManifest) -> CoreResult<()> {
        let permissions = Self::parse_permissions(&manifest.permissions)?;

        let mut perms = self.permissions.write().await;
        perms.insert(manifest.id.clone(), permissions);

        Ok(())
    }

    /// Unregisters a plugin and removes all its permissions
    pub async fn unregister_plugin(&self, plugin_id: &str) {
        let mut perms = self.permissions.write().await;
        perms.remove(plugin_id);

        let mut revoked = self.revoked.write().await;
        revoked.remove(plugin_id);
    }

    /// Checks if a plugin has permission for a resource
    pub async fn check(
        &self,
        plugin_id: &str,
        scope: &PermissionScope,
        resource: &str,
    ) -> PermissionStatus {
        // Check if revoked
        let revoked = self.revoked.read().await;
        if let Some(revoked_patterns) = revoked.get(plugin_id) {
            if revoked_patterns.contains(resource) {
                return PermissionStatus::Denied;
            }
        }
        drop(revoked);

        // Check permissions
        let perms = self.permissions.read().await;
        let plugin_perms = match perms.get(plugin_id) {
            Some(p) => p,
            None => return PermissionStatus::NotRequested,
        };

        for perm in plugin_perms {
            if perm.matches(scope, resource) {
                return PermissionStatus::Granted;
            }
        }

        PermissionStatus::NotRequested
    }

    /// Checks permission and returns an error if denied
    pub async fn require(
        &self,
        plugin_id: &str,
        scope: &PermissionScope,
        resource: &str,
    ) -> CoreResult<()> {
        match self.check(plugin_id, scope, resource).await {
            PermissionStatus::Granted => Ok(()),
            PermissionStatus::Denied => Err(CoreError::PermissionDenied(format!(
                "Permission denied for plugin '{}': {:?} access to '{}'",
                plugin_id, scope, resource
            ))),
            PermissionStatus::NotRequested => Err(CoreError::PermissionDenied(format!(
                "Permission not requested by plugin '{}': {:?} access to '{}'",
                plugin_id, scope, resource
            ))),
        }
    }

    /// Revokes a specific permission for a plugin
    pub async fn revoke(&self, plugin_id: &str, resource: &str) {
        let mut revoked = self.revoked.write().await;
        revoked
            .entry(plugin_id.to_string())
            .or_insert_with(HashSet::new)
            .insert(resource.to_string());
    }

    /// Restores a revoked permission
    pub async fn restore(&self, plugin_id: &str, resource: &str) {
        let mut revoked = self.revoked.write().await;
        if let Some(set) = revoked.get_mut(plugin_id) {
            set.remove(resource);
        }
    }

    /// Gets all permissions for a plugin
    pub async fn get_permissions(&self, plugin_id: &str) -> Vec<Permission> {
        let perms = self.permissions.read().await;
        perms.get(plugin_id).cloned().unwrap_or_default()
    }

    /// Gets all revoked patterns for a plugin
    pub async fn get_revoked(&self, plugin_id: &str) -> HashSet<String> {
        let revoked = self.revoked.read().await;
        revoked.get(plugin_id).cloned().unwrap_or_default()
    }

    /// Validates file path against plugin permissions
    pub async fn validate_file_access(
        &self,
        plugin_id: &str,
        path: &Path,
        write: bool,
    ) -> CoreResult<()> {
        let scope = if write {
            PermissionScope::FileWrite
        } else {
            PermissionScope::FileRead
        };

        let path_str = path.to_string_lossy();
        self.require(plugin_id, &scope, &path_str).await
    }

    /// Validates network access against plugin permissions
    pub async fn validate_network_access(&self, plugin_id: &str, url: &str) -> CoreResult<()> {
        self.require(plugin_id, &PermissionScope::Network, url)
            .await
    }

    /// Validates model access against plugin permissions
    pub async fn validate_model_access(&self, plugin_id: &str, model: &str) -> CoreResult<()> {
        self.require(plugin_id, &PermissionScope::Model, model)
            .await
    }

    /// Parses manifest permissions into Permission structs
    fn parse_permissions(manifest_perms: &PluginPermissions) -> CoreResult<Vec<Permission>> {
        let mut permissions = Vec::new();

        // Parse filesystem permissions
        for fs_pattern in &manifest_perms.fs {
            let parts: Vec<&str> = fs_pattern.splitn(2, ':').collect();
            if parts.len() != 2 {
                continue;
            }

            let (scope, pattern) = match parts[0] {
                "project" => (PermissionScope::ProjectWrite, parts[1].to_string()),
                "read" => (PermissionScope::FileRead, parts[1].to_string()),
                "write" => (PermissionScope::FileWrite, parts[1].to_string()),
                "temp" => (PermissionScope::TempAccess, parts[1].to_string()),
                _ => continue,
            };

            permissions.push(Permission::new(scope, pattern));
        }

        // Parse network permissions
        for net_pattern in &manifest_perms.net {
            permissions.push(Permission::new(
                PermissionScope::Network,
                net_pattern.clone(),
            ));
        }

        // Parse model permissions
        for model in &manifest_perms.models {
            permissions.push(Permission::new(PermissionScope::Model, model.clone()));
        }

        Ok(permissions)
    }
}

impl Default for PermissionManager {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_manifest(
        id: &str,
        fs: Vec<&str>,
        net: Vec<&str>,
        models: Vec<&str>,
    ) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: "Test Plugin".to_string(),
            version: "1.0.0".to_string(),
            description: None,
            author: None,
            homepage: None,
            entry: "plugin.wasm".to_string(),
            permissions: PluginPermissions {
                fs: fs.iter().map(|s| s.to_string()).collect(),
                net: net.iter().map(|s| s.to_string()).collect(),
                models: models.iter().map(|s| s.to_string()).collect(),
                custom: HashMap::new(),
            },
            capabilities: vec![super::super::manifest::PluginCapability::AssetProvider],
            config_schema: None,
            min_app_version: None,
        }
    }

    // ========================================================================
    // Permission Pattern Matching Tests
    // ========================================================================

    #[test]
    fn test_permission_exact_match() {
        let perm = Permission::new(PermissionScope::FileRead, "data/config.json".to_string());

        assert!(perm.matches(&PermissionScope::FileRead, "data/config.json"));
        assert!(!perm.matches(&PermissionScope::FileRead, "data/other.json"));
        assert!(!perm.matches(&PermissionScope::FileWrite, "data/config.json"));
    }

    #[test]
    fn test_permission_wildcard_suffix() {
        let perm = Permission::new(PermissionScope::FileRead, "assets/*".to_string());

        assert!(perm.matches(&PermissionScope::FileRead, "assets/image.png"));
        assert!(perm.matches(&PermissionScope::FileRead, "assets/sub/file.txt"));
        assert!(!perm.matches(&PermissionScope::FileRead, "other/file.txt"));
    }

    #[test]
    fn test_permission_wildcard_star() {
        let perm = Permission::new(
            PermissionScope::Network,
            "https://api.example.com*".to_string(),
        );

        assert!(perm.matches(&PermissionScope::Network, "https://api.example.com"));
        assert!(perm.matches(&PermissionScope::Network, "https://api.example.com/v1"));
        assert!(perm.matches(
            &PermissionScope::Network,
            "https://api.example.com/v1/users"
        ));
    }

    #[test]
    fn test_permission_directory_prefix() {
        let perm = Permission::new(PermissionScope::FileRead, "data/".to_string());

        assert!(perm.matches(&PermissionScope::FileRead, "data/file.txt"));
        assert!(perm.matches(&PermissionScope::FileRead, "data/sub/file.txt"));
        assert!(!perm.matches(&PermissionScope::FileRead, "other/file.txt"));
    }

    #[test]
    fn test_inactive_permission() {
        let mut perm = Permission::new(PermissionScope::FileRead, "data/*".to_string());
        perm.active = false;

        assert!(!perm.matches(&PermissionScope::FileRead, "data/file.txt"));
    }

    // ========================================================================
    // PermissionManager Register/Unregister Tests
    // ========================================================================

    #[tokio::test]
    async fn test_register_plugin() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest(
            "test-plugin",
            vec!["project:assets/*", "read:data/*"],
            vec!["https://api.example.com/*"],
            vec!["textEmbedding"],
        );

        manager.register_plugin(&manifest).await.unwrap();

        let perms = manager.get_permissions("test-plugin").await;
        assert_eq!(perms.len(), 4);
    }

    #[tokio::test]
    async fn test_unregister_plugin() {
        let manager = PermissionManager::new();
        let manifest =
            create_test_manifest("test-plugin", vec!["project:assets/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();
        assert!(!manager.get_permissions("test-plugin").await.is_empty());

        manager.unregister_plugin("test-plugin").await;
        assert!(manager.get_permissions("test-plugin").await.is_empty());
    }

    // ========================================================================
    // Permission Check Tests
    // ========================================================================

    #[tokio::test]
    async fn test_check_granted() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/file.txt")
            .await;
        assert_eq!(status, PermissionStatus::Granted);
    }

    #[tokio::test]
    async fn test_check_not_requested() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "other/file.txt")
            .await;
        assert_eq!(status, PermissionStatus::NotRequested);
    }

    #[tokio::test]
    async fn test_check_unknown_plugin() {
        let manager = PermissionManager::new();

        let status = manager
            .check("unknown", &PermissionScope::FileRead, "data/file.txt")
            .await;
        assert_eq!(status, PermissionStatus::NotRequested);
    }

    #[tokio::test]
    async fn test_check_network_permission() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest(
            "test-plugin",
            vec![],
            vec!["https://api.example.com/*"],
            vec![],
        );

        manager.register_plugin(&manifest).await.unwrap();

        let granted = manager
            .check(
                "test-plugin",
                &PermissionScope::Network,
                "https://api.example.com/v1/data",
            )
            .await;
        assert_eq!(granted, PermissionStatus::Granted);

        let denied = manager
            .check(
                "test-plugin",
                &PermissionScope::Network,
                "https://other.com/api",
            )
            .await;
        assert_eq!(denied, PermissionStatus::NotRequested);
    }

    #[tokio::test]
    async fn test_check_model_permission() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec![], vec![], vec!["textEmbedding"]);

        manager.register_plugin(&manifest).await.unwrap();

        let granted = manager
            .check("test-plugin", &PermissionScope::Model, "textEmbedding")
            .await;
        assert_eq!(granted, PermissionStatus::Granted);

        let denied = manager
            .check("test-plugin", &PermissionScope::Model, "imageGeneration")
            .await;
        assert_eq!(denied, PermissionStatus::NotRequested);
    }

    // ========================================================================
    // Require Permission Tests
    // ========================================================================

    #[tokio::test]
    async fn test_require_granted() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .require("test-plugin", &PermissionScope::FileRead, "data/file.txt")
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_require_not_requested() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .require("test-plugin", &PermissionScope::FileRead, "other/file.txt")
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not requested"));
    }

    // ========================================================================
    // Revoke/Restore Tests
    // ========================================================================

    #[tokio::test]
    async fn test_revoke_permission() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        // Initially granted
        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/secret.txt")
            .await;
        assert_eq!(status, PermissionStatus::Granted);

        // Revoke specific resource
        manager.revoke("test-plugin", "data/secret.txt").await;

        // Now denied
        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/secret.txt")
            .await;
        assert_eq!(status, PermissionStatus::Denied);

        // Other resources still granted
        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/other.txt")
            .await;
        assert_eq!(status, PermissionStatus::Granted);
    }

    #[tokio::test]
    async fn test_restore_permission() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();
        manager.revoke("test-plugin", "data/secret.txt").await;

        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/secret.txt")
            .await;
        assert_eq!(status, PermissionStatus::Denied);

        // Restore
        manager.restore("test-plugin", "data/secret.txt").await;

        let status = manager
            .check("test-plugin", &PermissionScope::FileRead, "data/secret.txt")
            .await;
        assert_eq!(status, PermissionStatus::Granted);
    }

    #[tokio::test]
    async fn test_get_revoked() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();
        manager.revoke("test-plugin", "data/file1.txt").await;
        manager.revoke("test-plugin", "data/file2.txt").await;

        let revoked = manager.get_revoked("test-plugin").await;
        assert_eq!(revoked.len(), 2);
        assert!(revoked.contains("data/file1.txt"));
        assert!(revoked.contains("data/file2.txt"));
    }

    // ========================================================================
    // Validation Helper Tests
    // ========================================================================

    #[tokio::test]
    async fn test_validate_file_access_read() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["read:data/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .validate_file_access("test-plugin", Path::new("data/file.txt"), false)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_validate_file_access_write() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec!["write:output/*"], vec![], vec![]);

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .validate_file_access("test-plugin", Path::new("output/result.txt"), true)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_validate_network_access() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest(
            "test-plugin",
            vec![],
            vec!["https://api.example.com/*"],
            vec![],
        );

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .validate_network_access("test-plugin", "https://api.example.com/v1")
            .await;
        assert!(result.is_ok());

        let result = manager
            .validate_network_access("test-plugin", "https://malicious.com")
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_validate_model_access() {
        let manager = PermissionManager::new();
        let manifest = create_test_manifest("test-plugin", vec![], vec![], vec!["textEmbedding"]);

        manager.register_plugin(&manifest).await.unwrap();

        let result = manager
            .validate_model_access("test-plugin", "textEmbedding")
            .await;
        assert!(result.is_ok());

        let result = manager
            .validate_model_access("test-plugin", "imageGeneration")
            .await;
        assert!(result.is_err());
    }
}
