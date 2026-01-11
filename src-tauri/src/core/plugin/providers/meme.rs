//! Meme Pack Provider
//!
//! Built-in provider for local meme assets.
//! Manages a library of memes with tag-based search.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::core::assets::{LicenseInfo, LicenseSource, LicenseType};
use crate::core::plugin::api::{
    AssetProviderPlugin, PluginAssetRef, PluginAssetType, PluginFetchedAsset, PluginSearchQuery,
};
use crate::core::{CoreError, CoreResult};

/// Meme metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemeEntry {
    /// Unique meme ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Relative path within meme pack
    pub path: String,
    /// Asset type
    pub asset_type: PluginAssetType,
    /// Tags for search
    pub tags: Vec<String>,
    /// Category
    pub category: String,
    /// Source/attribution
    pub source: Option<String>,
}

/// Meme pack manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemePackManifest {
    /// Pack name
    pub name: String,
    /// Pack version
    pub version: String,
    /// Pack description
    pub description: Option<String>,
    /// Meme entries
    pub memes: Vec<MemeEntry>,
}

/// Built-in meme pack provider
#[derive(Debug)]
pub struct MemePackProvider {
    /// Provider name
    name: String,
    /// Base directory containing meme packs
    base_dir: PathBuf,
    /// Loaded meme packs
    packs: Arc<RwLock<HashMap<String, MemePackManifest>>>,
    /// Meme index (id -> (pack_id, entry))
    index: Arc<RwLock<HashMap<String, (String, MemeEntry)>>>,
    /// Whether the provider is initialized
    initialized: Arc<RwLock<bool>>,
}

impl MemePackProvider {
    /// Creates a new meme pack provider
    pub fn new(name: &str, base_dir: PathBuf) -> Self {
        Self {
            name: name.to_string(),
            base_dir,
            packs: Arc::new(RwLock::new(HashMap::new())),
            index: Arc::new(RwLock::new(HashMap::new())),
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    /// Initializes the provider by loading all meme packs
    pub async fn initialize(&self) -> CoreResult<()> {
        let mut initialized = self.initialized.write().await;
        if *initialized {
            return Ok(());
        }

        // Create base directory if it doesn't exist
        if !self.base_dir.exists() {
            std::fs::create_dir_all(&self.base_dir).map_err(|e| {
                CoreError::PluginError(format!("Failed to create meme directory: {}", e))
            })?;
        }

        // Load all meme pack manifests
        self.load_packs().await?;

        *initialized = true;
        Ok(())
    }

    /// Loads all meme packs from the base directory
    async fn load_packs(&self) -> CoreResult<()> {
        let entries = std::fs::read_dir(&self.base_dir).map_err(|e| {
            CoreError::PluginError(format!("Failed to read meme directory: {}", e))
        })?;

        let mut packs = self.packs.write().await;
        let mut index = self.index.write().await;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let manifest_path = path.join("manifest.json");
                if manifest_path.exists() {
                    match self.load_pack_manifest(&manifest_path) {
                        Ok(manifest) => {
                            let pack_id = path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("unknown")
                                .to_string();

                            // Index all memes
                            for meme in &manifest.memes {
                                index.insert(
                                    meme.id.clone(),
                                    (pack_id.clone(), meme.clone()),
                                );
                            }

                            packs.insert(pack_id, manifest);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to load meme pack at {:?}: {}", path, e);
                        }
                    }
                }
            }
        }

        tracing::info!("Loaded {} meme packs with {} total memes", packs.len(), index.len());

        Ok(())
    }

    /// Loads a single pack manifest
    fn load_pack_manifest(&self, path: &Path) -> CoreResult<MemePackManifest> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read manifest: {}", e))
        })?;

        serde_json::from_str(&content).map_err(|e| {
            CoreError::PluginError(format!("Failed to parse manifest: {}", e))
        })
    }

    /// Gets the full path to a meme file
    fn get_meme_path(&self, pack_id: &str, meme_path: &str) -> PathBuf {
        self.base_dir.join(pack_id).join(meme_path)
    }

    /// Gets all available categories
    pub async fn get_categories(&self) -> Vec<String> {
        let index = self.index.read().await;
        let mut categories: Vec<String> = index
            .values()
            .map(|(_, entry)| entry.category.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        categories.sort();
        categories
    }

    /// Gets memes by category
    pub async fn get_by_category(&self, category: &str) -> Vec<PluginAssetRef> {
        let index = self.index.read().await;
        index
            .iter()
            .filter(|(_, (_, entry))| entry.category.eq_ignore_ascii_case(category))
            .map(|(_, (_, entry))| self.entry_to_asset_ref(entry))
            .collect()
    }

    /// Converts a meme entry to plugin asset ref
    fn entry_to_asset_ref(&self, entry: &MemeEntry) -> PluginAssetRef {
        PluginAssetRef {
            id: entry.id.clone(),
            name: entry.name.clone(),
            asset_type: entry.asset_type,
            thumbnail: None, // TODO: Generate thumbnails
            duration_sec: None,
            size_bytes: None,
            tags: entry.tags.clone(),
            metadata: serde_json::json!({
                "category": entry.category,
                "source": entry.source,
            }),
        }
    }
}

#[async_trait]
impl AssetProviderPlugin for MemePackProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Local meme pack library for video editing"
    }

    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>> {
        let index = self.index.read().await;

        let mut results: Vec<PluginAssetRef> = index
            .iter()
            .filter(|(_, (_, entry))| {
                // Filter by asset type
                if let Some(asset_type) = query.asset_type {
                    if entry.asset_type != asset_type {
                        return false;
                    }
                }

                // Filter by text query
                if let Some(ref text) = query.text {
                    let text_lower = text.to_lowercase();
                    let matches_name = entry.name.to_lowercase().contains(&text_lower);
                    let matches_tags = entry.tags.iter().any(|t| t.to_lowercase().contains(&text_lower));
                    let matches_category = entry.category.to_lowercase().contains(&text_lower);
                    if !matches_name && !matches_tags && !matches_category {
                        return false;
                    }
                }

                // Filter by tags
                if !query.tags.is_empty() {
                    let has_all_tags = query.tags.iter().all(|qt| {
                        entry.tags.iter().any(|et| et.eq_ignore_ascii_case(qt))
                    });
                    if !has_all_tags {
                        return false;
                    }
                }

                true
            })
            .map(|(_, (_, entry))| self.entry_to_asset_ref(entry))
            .collect();

        // Apply pagination
        let start = query.offset.min(results.len());
        let end = (start + query.limit).min(results.len());
        results = results[start..end].to_vec();

        Ok(results)
    }

    async fn fetch(&self, asset_ref: &str) -> CoreResult<PluginFetchedAsset> {
        let index = self.index.read().await;

        let (pack_id, entry) = index.get(asset_ref).ok_or_else(|| {
            CoreError::NotFound(format!("Meme not found: {}", asset_ref))
        })?;

        let path = self.get_meme_path(pack_id, &entry.path);
        let data = std::fs::read(&path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read meme file: {}", e))
        })?;

        // Determine MIME type based on extension
        let mime_type = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("mp4") => "video/mp4",
            Some("webm") => "video/webm",
            _ => "application/octet-stream",
        }
        .to_string();

        Ok(PluginFetchedAsset {
            data,
            mime_type,
            license: LicenseInfo {
                source: LicenseSource::Plugin,
                provider: Some("MemePackProvider".to_string()),
                license_type: LicenseType::Custom,
                proof_path: None,
                allowed_use: vec!["personal".to_string(), "commercial".to_string()],
                expires_at: None,
            },
            filename: Some(entry.name.clone()),
        })
    }

    async fn categories(&self) -> CoreResult<Vec<String>> {
        Ok(self.get_categories().await)
    }

    fn is_available(&self) -> bool {
        self.base_dir.exists()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_provider(temp_dir: &TempDir) -> MemePackProvider {
        MemePackProvider::new("test-meme-provider", temp_dir.path().to_path_buf())
    }

    fn create_test_meme_pack(temp_dir: &TempDir, pack_name: &str) {
        let pack_dir = temp_dir.path().join(pack_name);
        std::fs::create_dir_all(&pack_dir).unwrap();

        let manifest = MemePackManifest {
            name: pack_name.to_string(),
            version: "1.0.0".to_string(),
            description: Some("Test meme pack".to_string()),
            memes: vec![
                MemeEntry {
                    id: "meme-001".to_string(),
                    name: "Surprised Pikachu".to_string(),
                    path: "surprised_pikachu.png".to_string(),
                    asset_type: PluginAssetType::Image,
                    tags: vec!["pokemon".to_string(), "surprised".to_string(), "reaction".to_string()],
                    category: "Reactions".to_string(),
                    source: Some("Pokemon".to_string()),
                },
                MemeEntry {
                    id: "meme-002".to_string(),
                    name: "Drake Hotline Bling".to_string(),
                    path: "drake.png".to_string(),
                    asset_type: PluginAssetType::Image,
                    tags: vec!["drake".to_string(), "comparison".to_string()],
                    category: "Comparisons".to_string(),
                    source: None,
                },
            ],
        };

        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        std::fs::write(pack_dir.join("manifest.json"), manifest_json).unwrap();

        // Create dummy image files
        std::fs::write(pack_dir.join("surprised_pikachu.png"), b"fake png data").unwrap();
        std::fs::write(pack_dir.join("drake.png"), b"fake png data").unwrap();
    }

    #[test]
    fn test_create_provider() {
        let temp_dir = TempDir::new().unwrap();
        let provider = create_test_provider(&temp_dir);

        assert_eq!(provider.name(), "test-meme-provider");
        assert!(!provider.is_available()); // Directory doesn't exist yet
    }

    #[tokio::test]
    async fn test_initialize_provider() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        assert!(provider.is_available());
    }

    #[tokio::test]
    async fn test_search_all() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let results = provider.search(&PluginSearchQuery::default()).await.unwrap();
        assert_eq!(results.len(), 2);
    }

    #[tokio::test]
    async fn test_search_by_text() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            text: Some("pikachu".to_string()),
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Surprised Pikachu");
    }

    #[tokio::test]
    async fn test_search_by_tags() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            tags: vec!["reaction".to_string()],
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].tags.contains(&"reaction".to_string()));
    }

    #[tokio::test]
    async fn test_fetch_meme() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let asset = provider.fetch("meme-001").await.unwrap();

        assert_eq!(asset.mime_type, "image/png");
        assert_eq!(asset.data, b"fake png data");
        assert_eq!(asset.license.source, LicenseSource::Plugin);
    }

    #[tokio::test]
    async fn test_fetch_not_found() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let result = provider.fetch("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_categories() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let categories = provider.categories().await.unwrap();

        assert_eq!(categories.len(), 2);
        assert!(categories.contains(&"Reactions".to_string()));
        assert!(categories.contains(&"Comparisons".to_string()));
    }

    #[tokio::test]
    async fn test_search_pagination() {
        let temp_dir = TempDir::new().unwrap();
        create_test_meme_pack(&temp_dir, "test-pack");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            limit: 1,
            offset: 0,
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();
        assert_eq!(results.len(), 1);

        let query = PluginSearchQuery {
            limit: 1,
            offset: 1,
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_meme_pack_manifest_serialization() {
        let manifest = MemePackManifest {
            name: "Test Pack".to_string(),
            version: "1.0.0".to_string(),
            description: Some("A test pack".to_string()),
            memes: vec![],
        };

        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: MemePackManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, manifest.name);
        assert_eq!(parsed.version, manifest.version);
    }
}
