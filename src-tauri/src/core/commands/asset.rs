//! Asset Commands Module
//!
//! Implements all asset-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    assets::{
        media_kind_from_extension, Asset, AssetKind, AudioInfo, LicenseInfo, MetadataExtractor,
        ProxyStatus, VideoInfo,
    },
    commands::{Command, CommandResult, StateChange},
    fs::validate_local_input_path,
    project::ProjectState,
    workspace::path_resolver,
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
    /// Project root for resolving relative paths (set by IPC layer, not serialized)
    #[serde(skip)]
    pub project_root: Option<std::path::PathBuf>,
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

        let inferred_kind = if extension == "ogg" {
            validate_local_input_path(uri, "asset.uri")
                .ok()
                .and_then(|validated_uri| MetadataExtractor::extract(validated_uri).ok())
                .and_then(|metadata| {
                    if metadata.video.is_some() {
                        Some(AssetKind::Video)
                    } else if metadata.audio.is_some() {
                        Some(AssetKind::Audio)
                    } else {
                        None
                    }
                })
        } else {
            None
        };

        let asset = match inferred_kind.or_else(|| media_kind_from_extension(&extension)) {
            Some(AssetKind::Audio) => Asset::new_audio(name, uri, AudioInfo::default()),
            Some(AssetKind::Image) => {
                Asset::new_image(name, uri, 1920, 1080) // Default size, will be updated
            }
            _ => Asset::new_video(name, uri, VideoInfo::default()),
        };

        Self {
            asset,
            project_root: None,
        }
    }

    /// Returns the asset ID for external reference
    pub fn asset_id(&self) -> &str {
        &self.asset.id
    }

    /// Creates a new import asset command for a video
    pub fn video(name: &str, uri: &str, video_info: VideoInfo) -> Self {
        Self {
            asset: Asset::new_video(name, uri, video_info),
            project_root: None,
        }
    }

    /// Creates a new import asset command for audio
    pub fn audio(name: &str, uri: &str, audio_info: AudioInfo) -> Self {
        Self {
            asset: Asset::new_audio(name, uri, audio_info),
            project_root: None,
        }
    }

    /// Creates a new import asset command for an image
    pub fn image(name: &str, uri: &str, width: u32, height: u32) -> Self {
        Self {
            asset: Asset::new_image(name, uri, width, height),
            project_root: None,
        }
    }

    /// Creates a new import asset command from an existing asset
    pub fn from_asset(asset: Asset) -> Self {
        Self {
            asset,
            project_root: None,
        }
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

    /// Sets the video info (replaces default VideoInfo)
    pub fn with_video_info(mut self, video_info: VideoInfo) -> Self {
        self.asset = self.asset.with_video_info(video_info);
        self
    }

    /// Sets the audio info
    pub fn with_audio_info(mut self, audio_info: AudioInfo) -> Self {
        self.asset = self.asset.with_audio_info(audio_info);
        self
    }

    /// Sets the project root for resolving relative paths
    pub fn with_project_root(mut self, root: std::path::PathBuf) -> Self {
        self.project_root = Some(root);
        self
    }
}

impl Command for ImportAssetCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Security boundary: UI/AI can attempt to import a URL or an invalid path.
        // We validate at the command level so all call sites (IPC, AI, plugins) are protected.
        if let Some(rel_path) = &self.asset.relative_path {
            // Workspace file: resolve relative to project root
            let project_root = self.project_root.as_ref().ok_or_else(|| {
                CoreError::ValidationError(
                    "project_root required for workspace-relative imports".to_string(),
                )
            })?;
            let abs_path = project_root.join(rel_path);
            let validated = validate_local_input_path(&abs_path.to_string_lossy(), "asset.uri")
                .map_err(CoreError::ValidationError)?;

            if !path_resolver::is_inside_project(project_root, &validated) {
                return Err(CoreError::ValidationError(format!(
                    "workspace-relative asset resolves outside project root: {}",
                    validated.display()
                )));
            }

            self.asset.uri = validated.to_string_lossy().to_string();
        } else {
            // External file: existing behavior (absolute path validation)
            let validated_path = validate_local_input_path(&self.asset.uri, "asset.uri")
                .map_err(CoreError::ValidationError)?;
            self.asset.uri = validated_path.to_string_lossy().to_string();
        }

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
    /// New URI (optional)
    pub uri: Option<String>,
    /// New duration (optional). `Some(None)` clears duration.
    pub duration_sec: Option<Option<f64>>,
    /// New file size (optional)
    pub file_size: Option<u64>,
    /// New video metadata (optional). `Some(None)` clears video metadata.
    pub video: Option<Option<VideoInfo>>,
    /// New audio metadata (optional). `Some(None)` clears audio metadata.
    pub audio: Option<Option<AudioInfo>>,
    /// New relative workspace path (optional). `Some(None)` clears workspace path.
    pub relative_path: Option<Option<String>>,
    /// Whether the asset is workspace managed (optional)
    pub workspace_managed: Option<bool>,
    /// Whether the asset file is missing (optional)
    pub missing: Option<bool>,
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
    #[serde(skip)]
    original_uri: Option<String>,
    #[serde(skip)]
    original_duration_sec: Option<Option<f64>>,
    #[serde(skip)]
    original_file_size: Option<u64>,
    #[serde(skip)]
    original_video: Option<Option<VideoInfo>>,
    #[serde(skip)]
    original_audio: Option<Option<AudioInfo>>,
    #[serde(skip)]
    original_relative_path: Option<Option<String>>,
    #[serde(skip)]
    original_workspace_managed: Option<bool>,
    #[serde(skip)]
    original_missing: Option<bool>,
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
            uri: None,
            duration_sec: None,
            file_size: None,
            video: None,
            audio: None,
            relative_path: None,
            workspace_managed: None,
            missing: None,
            original_name: None,
            original_tags: None,
            original_license: None,
            original_thumbnail_url: None,
            original_proxy_status: None,
            original_proxy_url: None,
            original_uri: None,
            original_duration_sec: None,
            original_file_size: None,
            original_video: None,
            original_audio: None,
            original_relative_path: None,
            original_workspace_managed: None,
            original_missing: None,
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

    /// Sets the asset URI.
    pub fn with_uri(mut self, uri: &str) -> Self {
        self.uri = Some(uri.to_string());
        self
    }

    /// Sets the duration. Use `None` to clear.
    pub fn with_duration_sec(mut self, duration_sec: Option<f64>) -> Self {
        self.duration_sec = Some(duration_sec);
        self
    }

    /// Sets the file size.
    pub fn with_file_size(mut self, file_size: u64) -> Self {
        self.file_size = Some(file_size);
        self
    }

    /// Sets video metadata. Use `None` to clear.
    pub fn with_video(mut self, video: Option<VideoInfo>) -> Self {
        self.video = Some(video);
        self
    }

    /// Sets audio metadata. Use `None` to clear.
    pub fn with_audio(mut self, audio: Option<AudioInfo>) -> Self {
        self.audio = Some(audio);
        self
    }

    /// Sets the relative workspace path. Use `None` to clear.
    pub fn with_relative_path(mut self, relative_path: Option<String>) -> Self {
        self.relative_path = Some(relative_path);
        self
    }

    /// Sets whether the asset is workspace managed.
    pub fn with_workspace_managed(mut self, workspace_managed: bool) -> Self {
        self.workspace_managed = Some(workspace_managed);
        self
    }

    /// Sets whether the backing file is missing.
    pub fn with_missing(mut self, missing: bool) -> Self {
        self.missing = Some(missing);
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
        self.original_uri = Some(asset.uri.clone());
        self.original_duration_sec = Some(asset.duration_sec);
        self.original_file_size = Some(asset.file_size);
        self.original_video = Some(asset.video.clone());
        self.original_audio = Some(asset.audio.clone());
        self.original_relative_path = Some(asset.relative_path.clone());
        self.original_workspace_managed = Some(asset.workspace_managed);
        self.original_missing = Some(asset.missing);

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
        if let Some(uri) = &self.uri {
            asset.uri = uri.clone();
        }
        if let Some(duration_sec) = self.duration_sec {
            asset.duration_sec = duration_sec;
        }
        if let Some(file_size) = self.file_size {
            asset.file_size = file_size;
        }
        if let Some(video) = &self.video {
            asset.video = video.clone();
        }
        if let Some(audio) = &self.audio {
            asset.audio = audio.clone();
        }
        if let Some(relative_path) = &self.relative_path {
            asset.relative_path = relative_path.clone();
        }
        if let Some(workspace_managed) = self.workspace_managed {
            asset.workspace_managed = workspace_managed;
        }
        if let Some(missing) = self.missing {
            asset.missing = missing;
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
            if let Some(uri) = &self.original_uri {
                asset.uri = uri.clone();
            }
            if let Some(duration_sec) = self.original_duration_sec {
                asset.duration_sec = duration_sec;
            }
            if let Some(file_size) = self.original_file_size {
                asset.file_size = file_size;
            }
            if let Some(video) = &self.original_video {
                asset.video = video.clone();
            }
            if let Some(audio) = &self.original_audio {
                asset.audio = audio.clone();
            }
            if let Some(relative_path) = &self.original_relative_path {
                asset.relative_path = relative_path.clone();
            }
            if let Some(workspace_managed) = self.original_workspace_managed {
                asset.workspace_managed = workspace_managed;
            }
            if let Some(missing) = self.original_missing {
                asset.missing = missing;
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
    fn test_import_asset_new_recognizes_common_audio_extensions() {
        let command = ImportAssetCommand::new("voice.opus", "/tmp/voice.opus");
        assert_eq!(command.asset.kind, crate::core::assets::AssetKind::Audio);

        let command = ImportAssetCommand::new("ambience.oga", "/tmp/ambience.oga");
        assert_eq!(command.asset.kind, crate::core::assets::AssetKind::Audio);

        let command = ImportAssetCommand::new("podcast.weba", "/tmp/podcast.weba");
        assert_eq!(command.asset.kind, crate::core::assets::AssetKind::Audio);
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
    fn test_update_asset_source_fields_and_undo() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");
        let (_replacement_dir, replacement_uri) = create_temp_asset_file("replacement.mp4");

        let mut import_cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default())
            .with_duration(10.0)
            .with_file_size(100);
        let result = import_cmd.execute(&mut state).unwrap();
        let asset_id = &result.created_ids[0];

        let replacement_video = VideoInfo {
            width: 3840,
            height: 2160,
            ..Default::default()
        };

        let mut update_cmd = UpdateAssetCommand::new(asset_id)
            .with_uri(&replacement_uri)
            .with_duration_sec(Some(42.0))
            .with_file_size(2048)
            .with_video(Some(replacement_video))
            .with_audio(Some(AudioInfo::default()))
            .with_relative_path(Some("media/replacement.mp4".to_string()))
            .with_workspace_managed(true)
            .with_missing(false)
            .with_proxy_status(ProxyStatus::NotNeeded)
            .with_proxy_url(None);

        update_cmd.execute(&mut state).unwrap();

        let asset = state.assets.get(asset_id).unwrap();
        assert_eq!(asset.uri, replacement_uri);
        assert_eq!(asset.duration_sec, Some(42.0));
        assert_eq!(asset.file_size, 2048);
        assert_eq!(asset.video.as_ref().unwrap().width, 3840);
        assert!(asset.audio.is_some());
        assert_eq!(
            asset.relative_path.as_deref(),
            Some("media/replacement.mp4")
        );
        assert!(asset.workspace_managed);
        assert!(!asset.missing);

        update_cmd.undo(&mut state).unwrap();

        let asset = state.assets.get(asset_id).unwrap();
        assert_eq!(asset.uri, uri);
        assert_eq!(asset.duration_sec, Some(10.0));
        assert_eq!(asset.file_size, 100);
        assert_eq!(
            asset.video.as_ref().unwrap().width,
            VideoInfo::default().width
        );
        assert!(asset.audio.is_none());
        assert_eq!(asset.relative_path, None);
        assert!(!asset.workspace_managed);
        assert!(!asset.missing);
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

    // =========================================================================
    // Workspace-Relative Path Tests
    // =========================================================================

    #[test]
    fn test_import_with_relative_path() {
        let mut state = create_test_state();
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("footage")).unwrap();
        let file_path = dir.path().join("footage/clip.mp4");
        std::fs::write(&file_path, b"video data").unwrap();

        let asset = Asset::new_video("clip.mp4", "", VideoInfo::default())
            .with_relative_path("footage/clip.mp4")
            .as_workspace_managed();

        let mut cmd =
            ImportAssetCommand::from_asset(asset).with_project_root(dir.path().to_path_buf());

        let result = cmd.execute(&mut state).unwrap();
        assert_eq!(result.created_ids.len(), 1);

        let imported = state.assets.values().next().unwrap();
        assert_eq!(imported.relative_path, Some("footage/clip.mp4".to_string()));
        assert!(imported.workspace_managed);
        // URI should be resolved to absolute path
        assert!(imported.uri.contains("footage"));
    }

    #[test]
    fn test_import_with_relative_path_missing_project_root() {
        let mut state = create_test_state();

        let asset = Asset::new_video("clip.mp4", "", VideoInfo::default())
            .with_relative_path("footage/clip.mp4");

        let mut cmd = ImportAssetCommand::from_asset(asset);
        // No project_root set
        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }

    #[cfg(unix)]
    #[test]
    fn test_import_with_relative_path_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let mut state = create_test_state();
        let project_dir = tempfile::TempDir::new().unwrap();
        let external_dir = tempfile::TempDir::new().unwrap();

        let external_file = external_dir.path().join("outside.mp4");
        std::fs::write(&external_file, b"external data").unwrap();

        let linked_file = project_dir.path().join("linked.mp4");
        symlink(&external_file, &linked_file).unwrap();

        let asset = Asset::new_video("linked.mp4", "", VideoInfo::default())
            .with_relative_path("linked.mp4")
            .as_workspace_managed();

        let mut cmd = ImportAssetCommand::from_asset(asset)
            .with_project_root(project_dir.path().to_path_buf());

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));

        if let CoreError::ValidationError(message) = err {
            assert!(message.contains("outside project root"));
        }
    }

    #[test]
    fn test_import_without_relative_path_backward_compat() {
        let mut state = create_test_state();
        let (_dir, uri) = create_temp_asset_file("video.mp4");

        // Classic import without relative_path — should work as before
        let mut cmd = ImportAssetCommand::video("video.mp4", &uri, VideoInfo::default());
        let result = cmd.execute(&mut state).unwrap();

        let imported = state.assets.get(&result.created_ids[0]).unwrap();
        assert!(imported.relative_path.is_none());
        assert!(!imported.workspace_managed);
    }

    #[test]
    fn test_asset_serialization_with_new_fields() {
        let asset = Asset::new_video("clip.mp4", "/path/clip.mp4", VideoInfo::default())
            .with_relative_path("footage/clip.mp4")
            .as_workspace_managed();

        let json = serde_json::to_string(&asset).unwrap();
        let parsed: Asset = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.relative_path, Some("footage/clip.mp4".to_string()));
        assert!(parsed.workspace_managed);
    }

    #[test]
    fn test_asset_deserialization_backward_compat() {
        // Simulate old JSON without the new fields
        let old_json = r#"{
            "id": "01ABC",
            "kind": "video",
            "name": "old.mp4",
            "uri": "/path/old.mp4",
            "hash": "",
            "fileSize": 0,
            "importedAt": "2024-01-01T00:00:00Z",
            "license": { "source": "user", "licenseType": "unknown", "allowedUse": [] },
            "tags": [],
            "proxyStatus": "notNeeded"
        }"#;

        let asset: Asset = serde_json::from_str(old_json).unwrap();
        assert!(asset.relative_path.is_none());
        assert!(!asset.workspace_managed);
    }

    #[test]
    fn test_asset_resolved_path_with_relative() {
        let asset = Asset::new_video("clip.mp4", "/abs/path/clip.mp4", VideoInfo::default())
            .with_relative_path("footage/clip.mp4");

        let resolved = asset.resolved_path(std::path::Path::new("/project"));
        assert_eq!(
            resolved,
            std::path::PathBuf::from("/project/footage/clip.mp4")
        );
    }

    #[test]
    fn test_asset_resolved_path_without_relative() {
        let asset = Asset::new_video("clip.mp4", "/abs/path/clip.mp4", VideoInfo::default());

        let resolved = asset.resolved_path(std::path::Path::new("/project"));
        assert_eq!(resolved, std::path::PathBuf::from("/abs/path/clip.mp4"));
    }
}
