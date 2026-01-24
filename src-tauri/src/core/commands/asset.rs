//! Asset Commands Module
//!
//! Implements all asset-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    assets::{Asset, AudioInfo, LicenseInfo, ProxyStatus, VideoInfo},
    commands::{Command, CommandResult, StateChange},
    fs::validate_local_input_path,
    project::ProjectState,
    AssetId, CoreError, CoreResult,
};

// =============================================================================
// ImportAssetCommand
// =============================================================================

/// Command to import a new asset
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAssetCommand {
    /// The asset to import
    pub asset: Asset,
}

impl ImportAssetCommand {
    /// Creates a new import asset command (infers type from extension)
    pub fn new(name: &str, uri: &str) -> Self {
        let uri = uri.trim();
        // Infer asset type from extension
        let extension = std::path::Path::new(uri)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        let asset = match extension.as_str() {
            "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a" => {
                Asset::new_audio(name, uri, AudioInfo::default())
            }
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" => {
                Asset::new_image(name, uri, 1920, 1080) // Default size, will be updated
            }
            _ => Asset::new_video(name, uri, VideoInfo::default()),
        };

        Self { asset }
    }

    /// Returns the asset ID for external reference
    pub fn asset_id(&self) -> &str {
        &self.asset.id
    }

    /// Creates a new import asset command for a video
    pub fn video(name: &str, uri: &str, video_info: VideoInfo) -> Self {
        Self {
            asset: Asset::new_video(name, uri, video_info),
        }
    }

    /// Creates a new import asset command for audio
    pub fn audio(name: &str, uri: &str, audio_info: AudioInfo) -> Self {
        Self {
            asset: Asset::new_audio(name, uri, audio_info),
        }
    }

    /// Creates a new import asset command for an image
    pub fn image(name: &str, uri: &str, width: u32, height: u32) -> Self {
        Self {
            asset: Asset::new_image(name, uri, width, height),
        }
    }

    /// Creates a new import asset command from an existing asset
    pub fn from_asset(asset: Asset) -> Self {
        Self { asset }
    }

    /// Sets the duration
    pub fn with_duration(mut self, duration_sec: f64) -> Self {
        self.asset = self.asset.with_duration(duration_sec);
        self
    }

    /// Sets the file size
    pub fn with_file_size(mut self, file_size: u64) -> Self {
        self.asset = self.asset.with_file_size(file_size);
        self
    }

    /// Sets the hash
    pub fn with_hash(mut self, hash: &str) -> Self {
        self.asset = self.asset.with_hash(hash);
        self
    }

    /// Adds a tag
    pub fn with_tag(mut self, tag: &str) -> Self {
        self.asset = self.asset.with_tag(tag);
        self
    }

    /// Sets the license info
    pub fn with_license(mut self, license: LicenseInfo) -> Self {
        self.asset = self.asset.with_license(license);
        self
    }
}

impl Command for ImportAssetCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // This is a security boundary: UI/AI can attempt to import a URL or an invalid path.
        // We validate at the command level so all call sites (IPC, AI, plugins) are protected.
        let validated_path = validate_local_input_path(&self.asset.uri, "asset.uri")
            .map_err(CoreError::ValidationError)?;
        // Normalize to a trimmed absolute path string.
        self.asset.uri = validated_path.to_string_lossy().to_string();

        let asset_id = self.asset.id.clone();

        tracing::debug!(
            asset_id = %asset_id,
            asset_name = %self.asset.name,
            asset_uri = %self.asset.uri,
            "Importing asset"
        );

        state.assets.insert(asset_id.clone(), self.asset.clone());

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::AssetAdded {
                asset_id: asset_id.clone(),
            })
            .with_created_id(&asset_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        state.assets.remove(&self.asset.id);
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ImportAsset"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.asset).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// RemoveAssetCommand
// =============================================================================

/// Command to remove an asset
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAssetCommand {
    /// Asset ID to remove
    pub asset_id: AssetId,
    /// Removed asset data (for undo)
    #[serde(skip)]
    removed_asset: Option<Asset>,
}

impl RemoveAssetCommand {
    /// Creates a new remove asset command
    pub fn new(asset_id: &str) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            removed_asset: None,
        }
    }
}

impl Command for RemoveAssetCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Check if asset is in use
        for sequence in state.sequences.values() {
            for track in &sequence.tracks {
                for clip in &track.clips {
                    if clip.asset_id == self.asset_id {
                        return Err(CoreError::AssetInUse(self.asset_id.clone()));
                    }
                }
            }
        }

        // Store asset before removal for undo
        self.removed_asset = state.assets.get(&self.asset_id).cloned();

        state
            .assets
            .remove(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::AssetRemoved {
                asset_id: self.asset_id.clone(),
            })
            .with_deleted_id(&self.asset_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(asset) = &self.removed_asset {
            state.assets.insert(asset.id.clone(), asset.clone());
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveAsset"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "assetId": self.asset_id })
    }
}

// =============================================================================
// UpdateAssetCommand
// =============================================================================

/// Command to update asset metadata
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetCommand {
    /// Asset ID to update
    pub asset_id: AssetId,
    /// New name (optional)
    pub new_name: Option<String>,
    /// New tags (optional)
    pub new_tags: Option<Vec<String>>,
    /// New license info (optional)
    pub new_license: Option<LicenseInfo>,
    /// New thumbnail URL (optional). `Some(None)` clears the thumbnail.
    pub thumbnail_url: Option<Option<String>>,
    /// New proxy status (optional)
    pub proxy_status: Option<ProxyStatus>,
    /// New proxy URL (optional). `Some(None)` clears the proxy URL.
    pub proxy_url: Option<Option<String>>,
    /// Original values (for undo)
    #[serde(skip)]
    original_name: Option<String>,
    #[serde(skip)]
    original_tags: Option<Vec<String>>,
    #[serde(skip)]
    original_license: Option<LicenseInfo>,
    #[serde(skip)]
    original_thumbnail_url: Option<Option<String>>,
    #[serde(skip)]
    original_proxy_status: Option<ProxyStatus>,
    #[serde(skip)]
    original_proxy_url: Option<Option<String>>,
}

impl UpdateAssetCommand {
    /// Creates a new update asset command
    pub fn new(asset_id: &str) -> Self {
        Self {
            asset_id: asset_id.to_string(),
            new_name: None,
            new_tags: None,
            new_license: None,
            thumbnail_url: None,
            proxy_status: None,
            proxy_url: None,
            original_name: None,
            original_tags: None,
            original_license: None,
            original_thumbnail_url: None,
            original_proxy_status: None,
            original_proxy_url: None,
        }
    }

    /// Sets the new name
    pub fn with_name(mut self, name: &str) -> Self {
        self.new_name = Some(name.to_string());
        self
    }

    /// Sets the new tags
    pub fn with_tags(mut self, tags: Vec<String>) -> Self {
        self.new_tags = Some(tags);
        self
    }

    /// Sets the new license
    pub fn with_license(mut self, license: LicenseInfo) -> Self {
        self.new_license = Some(license);
        self
    }

    /// Sets the thumbnail URL. Use `None` to clear.
    pub fn with_thumbnail_url(mut self, url: Option<String>) -> Self {
        self.thumbnail_url = Some(url);
        self
    }

    /// Sets the proxy status.
    pub fn with_proxy_status(mut self, status: ProxyStatus) -> Self {
        self.proxy_status = Some(status);
        self
    }

    /// Sets the proxy URL. Use `None` to clear.
    pub fn with_proxy_url(mut self, url: Option<String>) -> Self {
        self.proxy_url = Some(url);
        self
    }
}

impl Command for UpdateAssetCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let asset = state
            .assets
            .get_mut(&self.asset_id)
            .ok_or_else(|| CoreError::AssetNotFound(self.asset_id.clone()))?;

        // Store original values before modification for undo
        self.original_name = Some(asset.name.clone());
        self.original_tags = Some(asset.tags.clone());
        self.original_license = Some(asset.license.clone());
        self.original_thumbnail_url = Some(asset.thumbnail_url.clone());
        self.original_proxy_status = Some(asset.proxy_status.clone());
        self.original_proxy_url = Some(asset.proxy_url.clone());

        // Apply new values
        if let Some(name) = &self.new_name {
            asset.name = name.clone();
        }
        if let Some(tags) = &self.new_tags {
            asset.tags = tags.clone();
        }
        if let Some(license) = &self.new_license {
            asset.license = license.clone();
        }
        if let Some(thumbnail_url) = &self.thumbnail_url {
            asset.thumbnail_url = thumbnail_url.clone();
        }
        if let Some(proxy_status) = &self.proxy_status {
            asset.proxy_status = proxy_status.clone();
        }
        if let Some(proxy_url) = &self.proxy_url {
            asset.proxy_url = proxy_url.clone();
        }

        let op_id = ulid::Ulid::new().to_string();

        Ok(
            CommandResult::new(&op_id).with_change(StateChange::AssetModified {
                asset_id: self.asset_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(asset) = state.assets.get_mut(&self.asset_id) {
            if let Some(name) = &self.original_name {
                asset.name = name.clone();
            }
            if let Some(tags) = &self.original_tags {
                asset.tags = tags.clone();
            }
            if let Some(license) = &self.original_license {
                asset.license = license.clone();
            }
            if let Some(thumbnail_url) = &self.original_thumbnail_url {
                asset.thumbnail_url = thumbnail_url.clone();
            }
            if let Some(proxy_status) = &self.original_proxy_status {
                asset.proxy_status = proxy_status.clone();
            }
            if let Some(proxy_url) = &self.original_proxy_url {
                asset.proxy_url = proxy_url.clone();
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateAsset"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind};

    fn create_test_state() -> ProjectState {
        ProjectState::new("Test Project")
    }

    fn create_temp_asset_file(file_name: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join(file_name);
        std::fs::write(&path, b"test").unwrap();
        (dir, path.to_string_lossy().to_string())
    }

    #[test]
    fn test_import_asset_video() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        let mut cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default())
            .with_duration(120.0)
            .with_file_size(1024 * 1024);

        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.assets.len(), 1);

        let asset = state.assets.values().next().unwrap();
        assert_eq!(asset.name, "video.mp4");
        assert_eq!(asset.duration_sec, Some(120.0));
    }

    #[test]
    fn test_import_asset_audio() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("music.mp3");

        let mut cmd = ImportAssetCommand::audio("music.mp3", &uri, AudioInfo::default());
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.assets.len(), 1);
    }

    #[test]
    fn test_import_asset_image() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("photo.jpg");

        let mut cmd = ImportAssetCommand::image("photo.jpg", &uri, 1920, 1080);
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.assets.len(), 1);
    }

    #[test]
    fn test_remove_asset() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        // Import asset
        let mut import_cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default());
        let result = import_cmd.execute(&mut state).unwrap();
        let asset_id = &result.created_ids[0];

        // Remove asset
        let mut remove_cmd = RemoveAssetCommand::new(asset_id);
        remove_cmd.execute(&mut state).unwrap();

        assert!(state.assets.is_empty());
    }

    #[test]
    fn test_remove_asset_in_use() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        // Import asset
        let mut import_cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default());
        let result = import_cmd.execute(&mut state).unwrap();
        let asset_id = result.created_ids[0].clone();

        // Create sequence with clip using the asset
        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let mut track = Track::new("Video 1", TrackKind::Video);
        track.clips.push(Clip::new(&asset_id));
        sequence.tracks.push(track);
        state.sequences.insert(sequence.id.clone(), sequence);

        // Try to remove asset
        let mut remove_cmd = RemoveAssetCommand::new(&asset_id);
        let result = remove_cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::AssetInUse(_))));
    }

    #[test]
    fn test_remove_nonexistent_asset() {
        let mut state = create_test_state();

        let mut cmd = RemoveAssetCommand::new("nonexistent_asset");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::AssetNotFound(_))));
    }

    #[test]
    fn test_update_asset() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        // Import asset
        let mut import_cmd = ImportAssetCommand::video("old_name.mp4", &uri, VideoInfo::default());
        let result = import_cmd.execute(&mut state).unwrap();
        let asset_id = &result.created_ids[0];

        // Update asset
        let mut update_cmd = UpdateAssetCommand::new(asset_id)
            .with_name("new_name.mp4")
            .with_tags(vec!["interview".to_string(), "raw".to_string()]);

        update_cmd.execute(&mut state).unwrap();

        let asset = state.assets.get(asset_id).unwrap();
        assert_eq!(asset.name, "new_name.mp4");
        assert_eq!(asset.tags.len(), 2);
        assert!(asset.tags.contains(&"interview".to_string()));
    }

    #[test]
    fn test_update_asset_proxy_and_thumbnail_fields_and_undo() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        // Import asset
        let mut import_cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default());
        let result = import_cmd.execute(&mut state).unwrap();
        let asset_id = &result.created_ids[0];

        let mut update_cmd = UpdateAssetCommand::new(asset_id)
            .with_proxy_status(ProxyStatus::Pending)
            .with_proxy_url(Some("file://proxy.mp4".to_string()))
            .with_thumbnail_url(Some("file://thumb.jpg".to_string()));

        update_cmd.execute(&mut state).unwrap();

        let asset = state.assets.get(asset_id).unwrap();
        assert_eq!(asset.proxy_status, ProxyStatus::Pending);
        assert_eq!(asset.proxy_url.as_deref(), Some("file://proxy.mp4"));
        assert_eq!(asset.thumbnail_url.as_deref(), Some("file://thumb.jpg"));

        update_cmd.undo(&mut state).unwrap();

        let asset = state.assets.get(asset_id).unwrap();
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
        assert_eq!(asset.proxy_url, None);
        assert_eq!(asset.thumbnail_url, None);
    }

    #[test]
    fn test_import_with_tags() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        let mut cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default())
            .with_tag("raw")
            .with_tag("4k");

        cmd.execute(&mut state).unwrap();

        let asset = state.assets.values().next().unwrap();
        assert_eq!(asset.tags.len(), 2);
    }

    #[test]
    fn test_import_undo() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        let mut cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default());
        cmd.execute(&mut state).unwrap();

        assert_eq!(state.assets.len(), 1);

        cmd.undo(&mut state).unwrap();

        assert!(state.assets.is_empty());
    }

    #[test]
    fn test_import_asset_rejects_url_uri() {
        let mut state = create_test_state();

        let mut cmd = ImportAssetCommand::video(
            "video.mp4",
            "https://example.com/video.mp4",
            VideoInfo::default(),
        );
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }

    #[test]
    fn test_import_asset_rejects_missing_file() {
        let mut state = create_test_state();
        let dir = tempfile::TempDir::new().unwrap();
        let missing_path = dir.path().join("missing.mp4");

        let mut cmd = ImportAssetCommand::video(
            "missing.mp4",
            &missing_path.to_string_lossy(),
            VideoInfo::default(),
        );
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }
}
