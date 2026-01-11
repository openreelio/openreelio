//! Plugin Manifest System
//!
//! Defines plugin metadata, capabilities, and required permissions.
//! Manifests are loaded from plugin.json files bundled with WASM plugins.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::core::{CoreError, CoreResult};

/// Plugin manifest defining metadata and capabilities
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    /// Unique plugin identifier (e.g., "com.example.meme-pack")
    pub id: String,

    /// Display name
    pub name: String,

    /// Semantic version (e.g., "1.0.0")
    pub version: String,

    /// Plugin description
    pub description: Option<String>,

    /// Author information
    pub author: Option<String>,

    /// Homepage or repository URL
    pub homepage: Option<String>,

    /// WASM entry point file (relative to manifest)
    pub entry: String,

    /// Required permissions
    pub permissions: PluginPermissions,

    /// Plugin capabilities
    pub capabilities: Vec<PluginCapability>,

    /// Plugin configuration schema (optional)
    pub config_schema: Option<serde_json::Value>,

    /// Minimum OpenReelio version required
    pub min_app_version: Option<String>,
}

/// Permission requirements for a plugin
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PluginPermissions {
    /// Filesystem access patterns (e.g., ["project:assets/downloaded", "read:temp/*"])
    #[serde(default)]
    pub fs: Vec<String>,

    /// Network access patterns (e.g., ["https://api.example.com/*"])
    #[serde(default)]
    pub net: Vec<String>,

    /// AI model access (e.g., ["textEmbedding", "imageGeneration"])
    #[serde(default)]
    pub models: Vec<String>,

    /// Additional custom permissions
    #[serde(default)]
    pub custom: HashMap<String, serde_json::Value>,
}

/// Plugin capability defining what interfaces it implements
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum PluginCapability {
    /// Provides assets (images, videos, audio)
    AssetProvider,

    /// Provides edit suggestions/automation
    EditAssistant,

    /// Provides effect presets
    EffectPresetProvider,

    /// Provides caption styles
    CaptionStyleProvider,

    /// Provides templates
    TemplateProvider,

    /// Custom capability
    #[serde(untagged)]
    Custom(String),
}

impl PluginManifest {
    /// Loads a manifest from a JSON file
    pub fn load_from_file(path: &Path) -> CoreResult<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read manifest file: {}", e))
        })?;

        Self::parse(&content)
    }

    /// Parses a manifest from JSON string
    pub fn parse(json: &str) -> CoreResult<Self> {
        let manifest: Self = serde_json::from_str(json).map_err(|e| {
            CoreError::PluginError(format!("Invalid manifest JSON: {}", e))
        })?;

        manifest.validate()?;
        Ok(manifest)
    }

    /// Validates manifest fields
    pub fn validate(&self) -> CoreResult<()> {
        // ID must not be empty
        if self.id.trim().is_empty() {
            return Err(CoreError::PluginError(
                "Plugin ID cannot be empty".to_string(),
            ));
        }

        // Name must not be empty
        if self.name.trim().is_empty() {
            return Err(CoreError::PluginError(
                "Plugin name cannot be empty".to_string(),
            ));
        }

        // Version must be valid semver format
        if !Self::is_valid_semver(&self.version) {
            return Err(CoreError::PluginError(format!(
                "Invalid version format: {}. Expected semver (e.g., 1.0.0)",
                self.version
            )));
        }

        // Entry must not be empty
        if self.entry.trim().is_empty() {
            return Err(CoreError::PluginError(
                "Plugin entry point cannot be empty".to_string(),
            ));
        }

        // Must have at least one capability
        if self.capabilities.is_empty() {
            return Err(CoreError::PluginError(
                "Plugin must declare at least one capability".to_string(),
            ));
        }

        // Validate filesystem permission patterns
        for pattern in &self.permissions.fs {
            Self::validate_fs_pattern(pattern)?;
        }

        // Validate network permission patterns
        for pattern in &self.permissions.net {
            Self::validate_net_pattern(pattern)?;
        }

        Ok(())
    }

    /// Checks if capability is declared
    pub fn has_capability(&self, capability: &PluginCapability) -> bool {
        self.capabilities.contains(capability)
    }

    /// Checks if all required capabilities are present
    pub fn has_all_capabilities(&self, required: &[PluginCapability]) -> bool {
        required.iter().all(|c| self.has_capability(c))
    }

    /// Validates semver format (basic check)
    fn is_valid_semver(version: &str) -> bool {
        let parts: Vec<&str> = version.split('.').collect();
        if parts.len() != 3 {
            return false;
        }

        parts.iter().all(|part| part.parse::<u32>().is_ok())
    }

    /// Validates filesystem permission pattern
    fn validate_fs_pattern(pattern: &str) -> CoreResult<()> {
        // Pattern format: "scope:path" where scope is project/read/write/temp
        let parts: Vec<&str> = pattern.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err(CoreError::PluginError(format!(
                "Invalid fs permission pattern '{}': expected 'scope:path' format",
                pattern
            )));
        }

        let scope = parts[0];
        let valid_scopes = ["project", "read", "write", "temp"];
        if !valid_scopes.contains(&scope) {
            return Err(CoreError::PluginError(format!(
                "Invalid fs permission scope '{}': valid scopes are {:?}",
                scope, valid_scopes
            )));
        }

        Ok(())
    }

    /// Validates network permission pattern
    fn validate_net_pattern(pattern: &str) -> CoreResult<()> {
        // Must start with https:// or http://
        if !pattern.starts_with("https://") && !pattern.starts_with("http://") {
            return Err(CoreError::PluginError(format!(
                "Invalid net permission pattern '{}': must start with http:// or https://",
                pattern
            )));
        }

        Ok(())
    }
}

impl PluginPermissions {
    /// Creates empty permissions
    pub fn new() -> Self {
        Self::default()
    }

    /// Checks if any permissions are requested
    pub fn is_empty(&self) -> bool {
        self.fs.is_empty()
            && self.net.is_empty()
            && self.models.is_empty()
            && self.custom.is_empty()
    }

    /// Gets total permission count
    pub fn count(&self) -> usize {
        self.fs.len() + self.net.len() + self.models.len() + self.custom.len()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Valid manifest JSON for testing
    fn valid_manifest_json() -> &'static str {
        r#"{
            "id": "com.example.meme-pack",
            "name": "Meme Pack",
            "version": "1.0.0",
            "description": "A collection of popular memes",
            "author": "Example Author",
            "homepage": "https://example.com",
            "entry": "plugin.wasm",
            "permissions": {
                "fs": ["project:assets/downloaded"],
                "net": ["https://api.example.com/*"],
                "models": ["textEmbedding"]
            },
            "capabilities": ["AssetProvider", "EffectPresetProvider"]
        }"#
    }

    // ========================================================================
    // PluginManifest::parse Tests
    // ========================================================================

    #[test]
    fn test_parse_valid_manifest() {
        let manifest = PluginManifest::parse(valid_manifest_json()).unwrap();

        assert_eq!(manifest.id, "com.example.meme-pack");
        assert_eq!(manifest.name, "Meme Pack");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.description, Some("A collection of popular memes".to_string()));
        assert_eq!(manifest.author, Some("Example Author".to_string()));
        assert_eq!(manifest.entry, "plugin.wasm");
        assert_eq!(manifest.capabilities.len(), 2);
    }

    #[test]
    fn test_parse_minimal_manifest() {
        let json = r#"{
            "id": "minimal",
            "name": "Minimal Plugin",
            "version": "0.1.0",
            "entry": "main.wasm",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;

        let manifest = PluginManifest::parse(json).unwrap();
        assert_eq!(manifest.id, "minimal");
        assert!(manifest.description.is_none());
        assert!(manifest.permissions.is_empty());
    }

    #[test]
    fn test_parse_invalid_json() {
        let result = PluginManifest::parse("not valid json");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid manifest JSON"));
    }

    #[test]
    fn test_parse_empty_id_fails() {
        let json = r#"{
            "id": "",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("ID cannot be empty"));
    }

    #[test]
    fn test_parse_empty_name_fails() {
        let json = r#"{
            "id": "test",
            "name": "  ",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_invalid_version_fails() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid version format"));
    }

    #[test]
    fn test_parse_no_capabilities_fails() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": []
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("at least one capability"));
    }

    #[test]
    fn test_parse_empty_entry_fails() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "",
            "permissions": {},
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("entry point cannot be empty"));
    }

    // ========================================================================
    // Permission Pattern Validation Tests
    // ========================================================================

    #[test]
    fn test_valid_fs_patterns() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {
                "fs": ["project:assets/*", "read:data/config.json", "write:output/*", "temp:cache/*"]
            },
            "capabilities": ["AssetProvider"]
        }"#;

        assert!(PluginManifest::parse(json).is_ok());
    }

    #[test]
    fn test_invalid_fs_pattern_missing_scope() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {
                "fs": ["assets/*"]
            },
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("scope:path"));
    }

    #[test]
    fn test_invalid_fs_pattern_wrong_scope() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {
                "fs": ["invalid:path/*"]
            },
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Invalid fs permission scope"));
    }

    #[test]
    fn test_valid_net_patterns() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {
                "net": ["https://api.example.com/*", "http://localhost:8080/*"]
            },
            "capabilities": ["AssetProvider"]
        }"#;

        assert!(PluginManifest::parse(json).is_ok());
    }

    #[test]
    fn test_invalid_net_pattern_no_protocol() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {
                "net": ["api.example.com/*"]
            },
            "capabilities": ["AssetProvider"]
        }"#;

        let result = PluginManifest::parse(json);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("must start with http://"));
    }

    // ========================================================================
    // Capability Tests
    // ========================================================================

    #[test]
    fn test_has_capability() {
        let manifest = PluginManifest::parse(valid_manifest_json()).unwrap();

        assert!(manifest.has_capability(&PluginCapability::AssetProvider));
        assert!(manifest.has_capability(&PluginCapability::EffectPresetProvider));
        assert!(!manifest.has_capability(&PluginCapability::EditAssistant));
    }

    #[test]
    fn test_has_all_capabilities() {
        let manifest = PluginManifest::parse(valid_manifest_json()).unwrap();

        assert!(manifest.has_all_capabilities(&[PluginCapability::AssetProvider]));
        assert!(manifest.has_all_capabilities(&[
            PluginCapability::AssetProvider,
            PluginCapability::EffectPresetProvider
        ]));
        assert!(!manifest.has_all_capabilities(&[
            PluginCapability::AssetProvider,
            PluginCapability::EditAssistant
        ]));
    }

    // ========================================================================
    // PluginPermissions Tests
    // ========================================================================

    #[test]
    fn test_permissions_is_empty() {
        let empty = PluginPermissions::new();
        assert!(empty.is_empty());
        assert_eq!(empty.count(), 0);
    }

    #[test]
    fn test_permissions_count() {
        let manifest = PluginManifest::parse(valid_manifest_json()).unwrap();
        assert_eq!(manifest.permissions.count(), 3); // 1 fs + 1 net + 1 models
        assert!(!manifest.permissions.is_empty());
    }

    // ========================================================================
    // Semver Validation Tests
    // ========================================================================

    #[test]
    fn test_valid_semver() {
        assert!(PluginManifest::is_valid_semver("1.0.0"));
        assert!(PluginManifest::is_valid_semver("0.1.0"));
        assert!(PluginManifest::is_valid_semver("10.20.30"));
    }

    #[test]
    fn test_invalid_semver() {
        assert!(!PluginManifest::is_valid_semver("1.0"));
        assert!(!PluginManifest::is_valid_semver("1"));
        assert!(!PluginManifest::is_valid_semver("1.0.0.0"));
        assert!(!PluginManifest::is_valid_semver("1.0.a"));
        assert!(!PluginManifest::is_valid_semver("v1.0.0"));
    }

    // ========================================================================
    // Custom Capability Tests
    // ========================================================================

    #[test]
    fn test_custom_capability() {
        let json = r#"{
            "id": "test",
            "name": "Test",
            "version": "1.0.0",
            "entry": "plugin.wasm",
            "permissions": {},
            "capabilities": ["CustomCapability"]
        }"#;

        let manifest = PluginManifest::parse(json).unwrap();
        assert!(manifest.has_capability(&PluginCapability::Custom("CustomCapability".to_string())));
    }
}
