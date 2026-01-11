//! Audio Library Provider
//!
//! Built-in provider for BGM (Background Music) and SFX (Sound Effects).
//! Manages a local library of royalty-free audio assets.

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

/// Audio asset category
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCategory {
    /// Background music
    Bgm,
    /// Sound effects
    Sfx,
    /// Ambient sounds
    Ambient,
    /// Voice-over
    Voice,
}

impl std::fmt::Display for AudioCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudioCategory::Bgm => write!(f, "BGM"),
            AudioCategory::Sfx => write!(f, "SFX"),
            AudioCategory::Ambient => write!(f, "Ambient"),
            AudioCategory::Voice => write!(f, "Voice"),
        }
    }
}

/// Audio entry metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioEntry {
    /// Unique ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Relative file path
    pub path: String,
    /// Category
    pub category: AudioCategory,
    /// Genre/mood tags
    pub tags: Vec<String>,
    /// Duration in seconds
    pub duration_sec: f64,
    /// BPM (for music)
    pub bpm: Option<u32>,
    /// Key (for music, e.g., "C Major")
    pub key: Option<String>,
    /// Description
    pub description: Option<String>,
    /// Source/attribution
    pub source: Option<String>,
    /// License type
    pub license: LicenseType,
}

/// Audio library manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioLibraryManifest {
    /// Library name
    pub name: String,
    /// Library version
    pub version: String,
    /// Description
    pub description: Option<String>,
    /// Audio entries
    pub entries: Vec<AudioEntry>,
}

/// Built-in audio library provider
#[derive(Debug)]
pub struct AudioLibraryProvider {
    /// Provider name
    name: String,
    /// Base directory
    base_dir: PathBuf,
    /// Loaded libraries
    libraries: Arc<RwLock<HashMap<String, AudioLibraryManifest>>>,
    /// Audio index (id -> (library_id, entry))
    index: Arc<RwLock<HashMap<String, (String, AudioEntry)>>>,
    /// Tag index for fast search
    tag_index: Arc<RwLock<HashMap<String, Vec<String>>>>,
    /// Initialized flag
    initialized: Arc<RwLock<bool>>,
}

impl AudioLibraryProvider {
    /// Creates a new audio library provider
    pub fn new(name: &str, base_dir: PathBuf) -> Self {
        Self {
            name: name.to_string(),
            base_dir,
            libraries: Arc::new(RwLock::new(HashMap::new())),
            index: Arc::new(RwLock::new(HashMap::new())),
            tag_index: Arc::new(RwLock::new(HashMap::new())),
            initialized: Arc::new(RwLock::new(false)),
        }
    }

    /// Initializes the provider by loading all libraries
    pub async fn initialize(&self) -> CoreResult<()> {
        let mut initialized = self.initialized.write().await;
        if *initialized {
            return Ok(());
        }

        // Create base directory if needed
        if !self.base_dir.exists() {
            std::fs::create_dir_all(&self.base_dir).map_err(|e| {
                CoreError::PluginError(format!("Failed to create audio directory: {}", e))
            })?;
        }

        // Load all libraries
        self.load_libraries().await?;

        // Build tag index
        self.build_tag_index().await;

        *initialized = true;
        Ok(())
    }

    /// Loads all audio libraries
    async fn load_libraries(&self) -> CoreResult<()> {
        let entries = std::fs::read_dir(&self.base_dir).map_err(|e| {
            CoreError::PluginError(format!("Failed to read audio directory: {}", e))
        })?;

        let mut libraries = self.libraries.write().await;
        let mut index = self.index.write().await;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let manifest_path = path.join("manifest.json");
                if manifest_path.exists() {
                    match self.load_library_manifest(&manifest_path) {
                        Ok(manifest) => {
                            let lib_id = path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("unknown")
                                .to_string();

                            // Index all entries
                            for audio in &manifest.entries {
                                index.insert(
                                    audio.id.clone(),
                                    (lib_id.clone(), audio.clone()),
                                );
                            }

                            libraries.insert(lib_id, manifest);
                        }
                        Err(e) => {
                            tracing::warn!("Failed to load audio library at {:?}: {}", path, e);
                        }
                    }
                }
            }
        }

        tracing::info!(
            "Loaded {} audio libraries with {} total entries",
            libraries.len(),
            index.len()
        );

        Ok(())
    }

    /// Loads a library manifest
    fn load_library_manifest(&self, path: &Path) -> CoreResult<AudioLibraryManifest> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read manifest: {}", e))
        })?;

        serde_json::from_str(&content).map_err(|e| {
            CoreError::PluginError(format!("Failed to parse manifest: {}", e))
        })
    }

    /// Builds the tag index for fast searching
    async fn build_tag_index(&self) {
        let index = self.index.read().await;
        let mut tag_index = self.tag_index.write().await;

        for (id, (_, entry)) in index.iter() {
            for tag in &entry.tags {
                tag_index
                    .entry(tag.to_lowercase())
                    .or_insert_with(Vec::new)
                    .push(id.clone());
            }

            // Also index category as a tag
            tag_index
                .entry(entry.category.to_string().to_lowercase())
                .or_insert_with(Vec::new)
                .push(id.clone());
        }
    }

    /// Gets full path to audio file
    fn get_audio_path(&self, lib_id: &str, audio_path: &str) -> PathBuf {
        self.base_dir.join(lib_id).join(audio_path)
    }

    /// Converts audio entry to asset ref
    fn entry_to_asset_ref(&self, entry: &AudioEntry) -> PluginAssetRef {
        PluginAssetRef {
            id: entry.id.clone(),
            name: entry.name.clone(),
            asset_type: PluginAssetType::Audio,
            thumbnail: None,
            duration_sec: Some(entry.duration_sec),
            size_bytes: None,
            tags: entry.tags.clone(),
            metadata: serde_json::json!({
                "category": entry.category,
                "bpm": entry.bpm,
                "key": entry.key,
                "description": entry.description,
                "source": entry.source,
                "license": entry.license,
            }),
        }
    }

    /// Gets audio by category
    pub async fn get_by_category(&self, category: AudioCategory) -> Vec<PluginAssetRef> {
        let index = self.index.read().await;
        index
            .iter()
            .filter(|(_, (_, entry))| entry.category == category)
            .map(|(_, (_, entry))| self.entry_to_asset_ref(entry))
            .collect()
    }

    /// Gets audio by BPM range
    pub async fn get_by_bpm_range(&self, min_bpm: u32, max_bpm: u32) -> Vec<PluginAssetRef> {
        let index = self.index.read().await;
        index
            .iter()
            .filter(|(_, (_, entry))| {
                if let Some(bpm) = entry.bpm {
                    bpm >= min_bpm && bpm <= max_bpm
                } else {
                    false
                }
            })
            .map(|(_, (_, entry))| self.entry_to_asset_ref(entry))
            .collect()
    }

    /// Gets audio by duration range
    pub async fn get_by_duration_range(&self, min_sec: f64, max_sec: f64) -> Vec<PluginAssetRef> {
        let index = self.index.read().await;
        index
            .iter()
            .filter(|(_, (_, entry))| {
                entry.duration_sec >= min_sec && entry.duration_sec <= max_sec
            })
            .map(|(_, (_, entry))| self.entry_to_asset_ref(entry))
            .collect()
    }
}

#[async_trait]
impl AssetProviderPlugin for AudioLibraryProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Local audio library for BGM and sound effects"
    }

    async fn search(&self, query: &PluginSearchQuery) -> CoreResult<Vec<PluginAssetRef>> {
        let index = self.index.read().await;
        let tag_index = self.tag_index.read().await;

        // If searching by tags, use tag index for efficiency
        let candidate_ids: Option<Vec<String>> = if !query.tags.is_empty() {
            let mut ids: Option<Vec<String>> = None;
            for tag in &query.tags {
                let tag_lower = tag.to_lowercase();
                if let Some(tag_ids) = tag_index.get(&tag_lower) {
                    match &mut ids {
                        None => ids = Some(tag_ids.clone()),
                        Some(existing) => {
                            existing.retain(|id| tag_ids.contains(id));
                        }
                    }
                } else {
                    // Tag not found, no results
                    return Ok(Vec::new());
                }
            }
            ids
        } else {
            None
        };

        let mut results: Vec<PluginAssetRef> = index
            .iter()
            .filter(|(id, (_, entry))| {
                // Check if in candidate IDs
                if let Some(ref candidates) = candidate_ids {
                    if !candidates.contains(id) {
                        return false;
                    }
                }

                // Filter by asset type (audio only for this provider)
                if let Some(asset_type) = query.asset_type {
                    if asset_type != PluginAssetType::Audio {
                        return false;
                    }
                }

                // Filter by text query
                if let Some(ref text) = query.text {
                    let text_lower = text.to_lowercase();
                    let matches_name = entry.name.to_lowercase().contains(&text_lower);
                    let matches_tags = entry.tags.iter().any(|t| t.to_lowercase().contains(&text_lower));
                    let matches_desc = entry.description.as_ref()
                        .map(|d| d.to_lowercase().contains(&text_lower))
                        .unwrap_or(false);
                    if !matches_name && !matches_tags && !matches_desc {
                        return false;
                    }
                }

                // Filter by duration range
                if let Some((min, max)) = query.duration_range {
                    if entry.duration_sec < min || entry.duration_sec > max {
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

        let (lib_id, entry) = index.get(asset_ref).ok_or_else(|| {
            CoreError::NotFound(format!("Audio not found: {}", asset_ref))
        })?;

        let path = self.get_audio_path(lib_id, &entry.path);
        let data = std::fs::read(&path).map_err(|e| {
            CoreError::PluginError(format!("Failed to read audio file: {}", e))
        })?;

        // Determine MIME type
        let mime_type = match path.extension().and_then(|e| e.to_str()) {
            Some("mp3") => "audio/mpeg",
            Some("wav") => "audio/wav",
            Some("ogg") => "audio/ogg",
            Some("flac") => "audio/flac",
            Some("m4a") | Some("aac") => "audio/aac",
            _ => "audio/mpeg",
        }
        .to_string();

        Ok(PluginFetchedAsset {
            data,
            mime_type,
            license: LicenseInfo {
                source: LicenseSource::Plugin,
                provider: Some("AudioLibraryProvider".to_string()),
                license_type: entry.license.clone(),
                proof_path: None,
                allowed_use: vec!["personal".to_string(), "commercial".to_string()],
                expires_at: None,
            },
            filename: Some(entry.name.clone()),
        })
    }

    async fn categories(&self) -> CoreResult<Vec<String>> {
        Ok(vec![
            "BGM".to_string(),
            "SFX".to_string(),
            "Ambient".to_string(),
            "Voice".to_string(),
        ])
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

    fn create_test_provider(temp_dir: &TempDir) -> AudioLibraryProvider {
        AudioLibraryProvider::new("test-audio-provider", temp_dir.path().to_path_buf())
    }

    fn create_test_audio_library(temp_dir: &TempDir, lib_name: &str) {
        let lib_dir = temp_dir.path().join(lib_name);
        std::fs::create_dir_all(&lib_dir).unwrap();

        let manifest = AudioLibraryManifest {
            name: lib_name.to_string(),
            version: "1.0.0".to_string(),
            description: Some("Test audio library".to_string()),
            entries: vec![
                AudioEntry {
                    id: "bgm-001".to_string(),
                    name: "Epic Adventure".to_string(),
                    path: "epic_adventure.mp3".to_string(),
                    category: AudioCategory::Bgm,
                    tags: vec!["epic".to_string(), "adventure".to_string(), "cinematic".to_string()],
                    duration_sec: 180.0,
                    bpm: Some(120),
                    key: Some("C Major".to_string()),
                    description: Some("Epic orchestral music for adventure scenes".to_string()),
                    source: None,
                    license: LicenseType::RoyaltyFree,
                },
                AudioEntry {
                    id: "sfx-001".to_string(),
                    name: "Whoosh".to_string(),
                    path: "whoosh.wav".to_string(),
                    category: AudioCategory::Sfx,
                    tags: vec!["whoosh".to_string(), "transition".to_string()],
                    duration_sec: 0.5,
                    bpm: None,
                    key: None,
                    description: Some("Quick whoosh sound effect".to_string()),
                    source: None,
                    license: LicenseType::Cc0,
                },
                AudioEntry {
                    id: "ambient-001".to_string(),
                    name: "Forest Ambience".to_string(),
                    path: "forest.ogg".to_string(),
                    category: AudioCategory::Ambient,
                    tags: vec!["forest".to_string(), "nature".to_string(), "birds".to_string()],
                    duration_sec: 60.0,
                    bpm: None,
                    key: None,
                    description: None,
                    source: Some("Field recording".to_string()),
                    license: LicenseType::CcBy,
                },
            ],
        };

        let manifest_json = serde_json::to_string_pretty(&manifest).unwrap();
        std::fs::write(lib_dir.join("manifest.json"), manifest_json).unwrap();

        // Create dummy audio files
        std::fs::write(lib_dir.join("epic_adventure.mp3"), b"fake mp3 data").unwrap();
        std::fs::write(lib_dir.join("whoosh.wav"), b"fake wav data").unwrap();
        std::fs::write(lib_dir.join("forest.ogg"), b"fake ogg data").unwrap();
    }

    #[test]
    fn test_create_provider() {
        let temp_dir = TempDir::new().unwrap();
        let provider = create_test_provider(&temp_dir);

        assert_eq!(provider.name(), "test-audio-provider");
    }

    #[tokio::test]
    async fn test_initialize() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        assert!(provider.is_available());
    }

    #[tokio::test]
    async fn test_search_all() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let results = provider.search(&PluginSearchQuery::default()).await.unwrap();
        assert_eq!(results.len(), 3);
    }

    #[tokio::test]
    async fn test_search_by_text() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            text: Some("epic".to_string()),
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Epic Adventure");
    }

    #[tokio::test]
    async fn test_search_by_tags() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            tags: vec!["transition".to_string()],
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Whoosh");
    }

    #[tokio::test]
    async fn test_search_by_duration() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let query = PluginSearchQuery {
            duration_range: Some((0.0, 1.0)),
            ..Default::default()
        };
        let results = provider.search(&query).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Whoosh");
    }

    #[tokio::test]
    async fn test_get_by_category() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let bgm = provider.get_by_category(AudioCategory::Bgm).await;
        assert_eq!(bgm.len(), 1);
        assert_eq!(bgm[0].name, "Epic Adventure");

        let sfx = provider.get_by_category(AudioCategory::Sfx).await;
        assert_eq!(sfx.len(), 1);
    }

    #[tokio::test]
    async fn test_get_by_bpm_range() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let results = provider.get_by_bpm_range(100, 140).await;
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Epic Adventure");
    }

    #[tokio::test]
    async fn test_fetch_audio() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let asset = provider.fetch("sfx-001").await.unwrap();
        assert_eq!(asset.mime_type, "audio/wav");
        assert_eq!(asset.data, b"fake wav data");
    }

    #[tokio::test]
    async fn test_fetch_not_found() {
        let temp_dir = TempDir::new().unwrap();
        create_test_audio_library(&temp_dir, "test-lib");

        let provider = create_test_provider(&temp_dir);
        provider.initialize().await.unwrap();

        let result = provider.fetch("nonexistent").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_categories() {
        let temp_dir = TempDir::new().unwrap();
        let provider = create_test_provider(&temp_dir);

        let categories = provider.categories().await.unwrap();
        assert!(categories.contains(&"BGM".to_string()));
        assert!(categories.contains(&"SFX".to_string()));
    }

    #[test]
    fn test_audio_category_display() {
        assert_eq!(AudioCategory::Bgm.to_string(), "BGM");
        assert_eq!(AudioCategory::Sfx.to_string(), "SFX");
        assert_eq!(AudioCategory::Ambient.to_string(), "Ambient");
    }

    #[test]
    fn test_audio_entry_serialization() {
        let entry = AudioEntry {
            id: "test".to_string(),
            name: "Test Audio".to_string(),
            path: "test.mp3".to_string(),
            category: AudioCategory::Bgm,
            tags: vec!["test".to_string()],
            duration_sec: 60.0,
            bpm: Some(120),
            key: Some("A Minor".to_string()),
            description: None,
            source: None,
            license: LicenseType::RoyaltyFree,
        };

        let json = serde_json::to_string(&entry).unwrap();
        let parsed: AudioEntry = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, entry.id);
        assert_eq!(parsed.bpm, Some(120));
    }
}
