//! Asset Model Definitions
//!
//! Defines the Asset struct and related types for managing media assets.
//! All types are exported to TypeScript via tauri-specta.

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::warn;

use crate::core::{AssetId, Ratio};

/// Asset type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    Subtitle,
    Font,
    EffectPreset,
    MemePack,
}

/// Proxy video generation status
///
/// Tracks the lifecycle of proxy video generation for preview playback.
/// Videos larger than 720p automatically trigger proxy generation on import.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProxyStatus {
    /// No proxy needed (video <= 720p or non-video asset)
    #[default]
    NotNeeded,
    /// Proxy generation is queued/pending
    Pending,
    /// Proxy is currently being generated
    Generating,
    /// Proxy generation completed successfully
    Ready,
    /// Proxy generation failed
    Failed,
}

/// Minimum video height that requires proxy generation
pub const PROXY_THRESHOLD_HEIGHT: u32 = 720;

/// Check if an asset requires proxy generation
///
/// Returns true if the asset is a video with height > 720p
pub fn requires_proxy(kind: &AssetKind, video_info: Option<&VideoInfo>) -> bool {
    match kind {
        AssetKind::Video => {
            if let Some(info) = video_info {
                info.height > PROXY_THRESHOLD_HEIGHT
            } else {
                false
            }
        }
        _ => false,
    }
}

/// Video-specific metadata
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// Width in pixels
    pub width: u32,
    /// Height in pixels
    pub height: u32,
    /// Frame rate
    pub fps: Ratio,
    /// Video codec (e.g., "h264", "hevc")
    pub codec: String,
    /// Bitrate in bps (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
    /// Whether the video has alpha channel
    pub has_alpha: bool,
}

impl Default for VideoInfo {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: Ratio::new(30, 1),
            codec: "h264".to_string(),
            bitrate: None,
            has_alpha: false,
        }
    }
}

/// Audio-specific metadata
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    /// Sample rate in Hz
    pub sample_rate: u32,
    /// Number of audio channels
    pub channels: u8,
    /// Audio codec (e.g., "aac", "mp3")
    pub codec: String,
    /// Bitrate in bps (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
}

impl Default for AudioInfo {
    fn default() -> Self {
        Self {
            sample_rate: 48000,
            channels: 2,
            codec: "aac".to_string(),
            bitrate: None,
        }
    }
}

/// License source type
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LicenseSource {
    User,
    StockProvider,
    Generated,
    Plugin,
}

/// License type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LicenseType {
    RoyaltyFree,
    Cc0,
    CcBy,
    CcBySa,
    Editorial,
    Custom,
    Unknown,
}

/// License information for an asset
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    /// Source of the asset
    pub source: LicenseSource,
    /// Provider name (e.g., "Pexels", "Pixabay")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Type of license
    pub license_type: LicenseType,
    /// Path to license proof file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_path: Option<String>,
    /// Allowed uses (e.g., ["commercial", "personal"])
    pub allowed_use: Vec<String>,
    /// License expiration date (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl Default for LicenseInfo {
    fn default() -> Self {
        Self {
            source: LicenseSource::User,
            provider: None,
            license_type: LicenseType::Unknown,
            proof_path: None,
            allowed_use: vec![],
            expires_at: None,
        }
    }
}

/// Main Asset structure
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    /// Unique identifier (ULID)
    pub id: AssetId,
    /// Type of asset
    pub kind: AssetKind,
    /// Display name
    pub name: String,
    /// File path or URI
    pub uri: String,
    /// SHA256 hash of file content
    pub hash: String,
    /// Duration in seconds (for video/audio)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    /// File size in bytes
    pub file_size: u64,
    /// Import timestamp (ISO 8601)
    pub imported_at: String,
    /// Video-specific metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoInfo>,
    /// Audio-specific metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioInfo>,
    /// License information
    pub license: LicenseInfo,
    /// User-defined tags
    pub tags: Vec<String>,
    /// Thumbnail URL (via Tauri asset protocol)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    /// Proxy video generation status
    #[serde(default)]
    pub proxy_status: ProxyStatus,
    /// Proxy video URL for preview playback (via Tauri asset protocol)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    /// Bin (folder) ID for organizing the asset
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bin_id: Option<String>,

    /// Relative path within project folder (for workspace-discovered files).
    /// When set, this is the canonical reference. `uri` becomes a resolved cache.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,

    /// Whether this asset was auto-discovered from workspace scan
    #[serde(default)]
    pub workspace_managed: bool,
}

impl Asset {
    /// Creates a new video asset with generated ULID
    ///
    /// Automatically determines proxy_status based on video dimensions:
    /// - Videos > 720p height: ProxyStatus::NotNeeded (will be set to Pending when job is queued)
    /// - Videos <= 720p height: ProxyStatus::NotNeeded
    pub fn new_video(name: &str, uri: &str, mut video_info: VideoInfo) -> Self {
        // Validate video info
        if video_info.width == 0 || video_info.height == 0 {
            warn!(
                "Video asset '{}' created with invalid dimensions {}x{}. Defaulting to 1920x1080",
                name, video_info.width, video_info.height
            );
            video_info.width = 1920;
            video_info.height = 1080;
        }

        if video_info.fps.den == 0 {
            warn!(
                "Video asset '{}' has invalid FPS ratio, defaulting to 30/1",
                name
            );
            video_info.fps = Ratio::new(30, 1);
        }

        Self {
            id: ulid::Ulid::new().to_string(),
            kind: AssetKind::Video,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: String::new(),
            duration_sec: None,
            file_size: 0,
            imported_at: chrono::Utc::now().to_rfc3339(),
            video: Some(video_info),
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
        }
    }

    /// Creates a new audio asset with generated ULID
    pub fn new_audio(name: &str, uri: &str, audio_info: AudioInfo) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            kind: AssetKind::Audio,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: String::new(),
            duration_sec: None,
            file_size: 0,
            imported_at: chrono::Utc::now().to_rfc3339(),
            video: None,
            audio: Some(audio_info),
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
        }
    }

    /// Creates a new image asset with generated ULID
    pub fn new_image(name: &str, uri: &str, mut width: u32, mut height: u32) -> Self {
        if width == 0 || height == 0 {
            warn!(
                "Image asset '{}' created with invalid dimensions {}x{}. Defaulting to 1920x1080",
                name, width, height
            );
            width = 1920;
            height = 1080;
        }

        Self {
            id: ulid::Ulid::new().to_string(),
            kind: AssetKind::Image,
            name: name.to_string(),
            uri: uri.to_string(),
            hash: String::new(),
            duration_sec: None,
            file_size: 0,
            imported_at: chrono::Utc::now().to_rfc3339(),
            video: Some(VideoInfo {
                width,
                height,
                fps: Ratio::new(1, 1),
                codec: String::new(),
                bitrate: None,
                has_alpha: false,
            }),
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
        }
    }

    /// Sets the file hash
    pub fn with_hash(mut self, hash: &str) -> Self {
        self.hash = hash.to_string();
        self
    }

    /// Sets the duration
    pub fn with_duration(mut self, duration_sec: f64) -> Self {
        self.duration_sec = Some(duration_sec);
        self
    }

    /// Sets the file size
    pub fn with_file_size(mut self, file_size: u64) -> Self {
        self.file_size = file_size;
        self
    }

    /// Adds a tag
    pub fn with_tag(mut self, tag: &str) -> Self {
        self.tags.push(tag.to_string());
        self
    }

    /// Sets the license info
    pub fn with_license(mut self, license: LicenseInfo) -> Self {
        self.license = license;
        self
    }

    /// Sets the thumbnail URL
    pub fn with_thumbnail_url(mut self, url: &str) -> Self {
        self.thumbnail_url = Some(url.to_string());
        self
    }

    /// Sets the thumbnail URL from an Option
    pub fn set_thumbnail_url(&mut self, url: Option<String>) {
        self.thumbnail_url = url;
    }

    /// Sets the proxy URL using builder pattern
    pub fn with_proxy_url(mut self, url: &str) -> Self {
        self.proxy_url = Some(url.to_string());
        self
    }

    /// Sets the proxy URL from an Option
    pub fn set_proxy_url(&mut self, url: Option<String>) {
        self.proxy_url = url;
    }

    /// Sets the proxy generation status
    pub fn set_proxy_status(&mut self, status: ProxyStatus) {
        self.proxy_status = status;
    }

    /// Checks if this asset requires proxy generation
    ///
    /// Returns true for video assets with height > 720p
    pub fn needs_proxy(&self) -> bool {
        requires_proxy(&self.kind, self.video.as_ref())
    }

    /// Marks the asset as pending proxy generation
    pub fn mark_proxy_pending(&mut self) {
        if self.needs_proxy() {
            self.proxy_status = ProxyStatus::Pending;
        }
    }

    /// Marks the asset as currently generating proxy
    pub fn mark_proxy_generating(&mut self) {
        self.proxy_status = ProxyStatus::Generating;
    }

    /// Marks the proxy as ready with the given URL
    pub fn mark_proxy_ready(&mut self, proxy_url: String) {
        self.proxy_status = ProxyStatus::Ready;
        self.proxy_url = Some(proxy_url);
    }

    /// Marks the proxy generation as failed
    pub fn mark_proxy_failed(&mut self) {
        self.proxy_status = ProxyStatus::Failed;
    }

    /// Sets the video info (builder pattern)
    pub fn with_video_info(mut self, video_info: VideoInfo) -> Self {
        self.video = Some(video_info);
        self
    }

    /// Sets the audio info (builder pattern)
    pub fn with_audio_info(mut self, audio_info: AudioInfo) -> Self {
        self.audio = Some(audio_info);
        self
    }

    /// Sets the relative path within the project workspace
    pub fn with_relative_path(mut self, path: &str) -> Self {
        self.relative_path = Some(path.to_string());
        self
    }

    /// Marks this asset as workspace-managed
    pub fn as_workspace_managed(mut self) -> Self {
        self.workspace_managed = true;
        self
    }

    /// Resolves the actual file path, preferring relative_path over uri
    pub fn resolved_path(&self, project_root: &std::path::Path) -> std::path::PathBuf {
        if let Some(rel) = &self.relative_path {
            project_root.join(rel)
        } else {
            std::path::PathBuf::from(&self.uri)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==========================================================================
    // ProxyStatus Tests
    // ==========================================================================

    #[test]
    fn test_proxy_status_default_is_not_needed() {
        let status = ProxyStatus::default();
        assert_eq!(status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_proxy_status_serialization() {
        // Verify camelCase serialization for TypeScript
        let cases = vec![
            (ProxyStatus::NotNeeded, "\"notNeeded\""),
            (ProxyStatus::Pending, "\"pending\""),
            (ProxyStatus::Generating, "\"generating\""),
            (ProxyStatus::Ready, "\"ready\""),
            (ProxyStatus::Failed, "\"failed\""),
        ];

        for (status, expected) in cases {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(json, expected, "ProxyStatus::{:?} serialization", status);
        }
    }

    #[test]
    fn test_proxy_status_deserialization() {
        let ready: ProxyStatus = serde_json::from_str("\"ready\"").unwrap();
        assert_eq!(ready, ProxyStatus::Ready);

        let pending: ProxyStatus = serde_json::from_str("\"pending\"").unwrap();
        assert_eq!(pending, ProxyStatus::Pending);
    }

    // ==========================================================================
    // requires_proxy Tests
    // ==========================================================================

    #[test]
    fn test_video_above_720p_requires_proxy() {
        let video_info = VideoInfo {
            width: 1920,
            height: 1080, // > 720
            ..Default::default()
        };
        assert!(requires_proxy(&AssetKind::Video, Some(&video_info)));
    }

    #[test]
    fn test_video_4k_requires_proxy() {
        let video_info = VideoInfo {
            width: 3840,
            height: 2160, // 4K
            ..Default::default()
        };
        assert!(requires_proxy(&AssetKind::Video, Some(&video_info)));
    }

    #[test]
    fn test_video_720p_does_not_require_proxy() {
        let video_info = VideoInfo {
            width: 1280,
            height: 720, // == 720
            ..Default::default()
        };
        assert!(!requires_proxy(&AssetKind::Video, Some(&video_info)));
    }

    #[test]
    fn test_video_below_720p_does_not_require_proxy() {
        let video_info = VideoInfo {
            width: 854,
            height: 480, // 480p
            ..Default::default()
        };
        assert!(!requires_proxy(&AssetKind::Video, Some(&video_info)));
    }

    #[test]
    fn test_audio_asset_does_not_require_proxy() {
        assert!(!requires_proxy(&AssetKind::Audio, None));
    }

    #[test]
    fn test_image_asset_does_not_require_proxy() {
        let video_info = VideoInfo {
            width: 3840,
            height: 2160, // 4K but image
            ..Default::default()
        };
        assert!(!requires_proxy(&AssetKind::Image, Some(&video_info)));
    }

    // ==========================================================================
    // Asset Proxy Methods Tests
    // ==========================================================================

    #[test]
    fn test_new_video_asset_has_not_needed_proxy_status() {
        let asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_asset_needs_proxy_1080p() {
        let video_info = VideoInfo {
            width: 1920,
            height: 1080,
            ..Default::default()
        };
        let asset = Asset::new_video("test.mp4", "/test.mp4", video_info);
        assert!(asset.needs_proxy());
    }

    #[test]
    fn test_asset_needs_proxy_720p() {
        let video_info = VideoInfo {
            width: 1280,
            height: 720,
            ..Default::default()
        };
        let asset = Asset::new_video("test.mp4", "/test.mp4", video_info);
        assert!(!asset.needs_proxy());
    }

    #[test]
    fn test_asset_set_proxy_status() {
        let mut asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        asset.set_proxy_status(ProxyStatus::Generating);
        assert_eq!(asset.proxy_status, ProxyStatus::Generating);
    }

    #[test]
    fn test_asset_mark_proxy_pending() {
        let video_info = VideoInfo {
            width: 1920,
            height: 1080,
            ..Default::default()
        };
        let mut asset = Asset::new_video("test.mp4", "/test.mp4", video_info);
        asset.mark_proxy_pending();
        assert_eq!(asset.proxy_status, ProxyStatus::Pending);
    }

    #[test]
    fn test_asset_mark_proxy_pending_skipped_for_720p() {
        let video_info = VideoInfo {
            width: 1280,
            height: 720,
            ..Default::default()
        };
        let mut asset = Asset::new_video("test.mp4", "/test.mp4", video_info);
        asset.mark_proxy_pending();
        // Should remain NotNeeded since 720p doesn't need proxy
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_asset_mark_proxy_ready() {
        let mut asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        asset.mark_proxy_ready("asset://cache/proxy.mp4".to_string());

        assert_eq!(asset.proxy_status, ProxyStatus::Ready);
        assert_eq!(asset.proxy_url, Some("asset://cache/proxy.mp4".to_string()));
    }

    #[test]
    fn test_asset_mark_proxy_failed() {
        let mut asset = Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default());
        asset.mark_proxy_failed();
        assert_eq!(asset.proxy_status, ProxyStatus::Failed);
    }

    // ==========================================================================
    // Asset Creation Tests
    // ==========================================================================

    #[test]
    fn test_asset_creation_video() {
        let asset = Asset::new_video("test.mp4", "/path/to/test.mp4", VideoInfo::default());

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Video);
        assert_eq!(asset.name, "test.mp4");
        assert!(asset.video.is_some());
        assert!(asset.audio.is_none());
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_asset_creation_audio() {
        let asset = Asset::new_audio("music.mp3", "/path/to/music.mp3", AudioInfo::default());

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Audio);
        assert!(asset.video.is_none());
        assert!(asset.audio.is_some());
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_asset_creation_image() {
        let asset = Asset::new_image("photo.jpg", "/path/to/photo.jpg", 1920, 1080);

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Image);
        let video = asset.video.as_ref().unwrap();
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(asset.proxy_status, ProxyStatus::NotNeeded);
    }

    #[test]
    fn test_asset_builder_pattern() {
        let asset = Asset::new_video("test.mp4", "/path/test.mp4", VideoInfo::default())
            .with_hash("abc123")
            .with_duration(120.5)
            .with_file_size(1024 * 1024)
            .with_tag("interview");

        assert_eq!(asset.hash, "abc123");
        assert_eq!(asset.duration_sec, Some(120.5));
        assert_eq!(asset.file_size, 1024 * 1024);
        assert!(asset.tags.contains(&"interview".to_string()));
    }

    #[test]
    fn test_asset_serialization_with_proxy_status() {
        let mut asset = Asset::new_video("test.mp4", "/path/test.mp4", VideoInfo::default());
        asset.proxy_status = ProxyStatus::Ready;
        asset.proxy_url = Some("asset://proxy.mp4".to_string());

        let json = serde_json::to_string(&asset).unwrap();
        let parsed: Asset = serde_json::from_str(&json).unwrap();

        assert_eq!(asset.id, parsed.id);
        assert_eq!(asset.kind, parsed.kind);
        assert_eq!(asset.name, parsed.name);
        assert_eq!(parsed.proxy_status, ProxyStatus::Ready);
        assert_eq!(parsed.proxy_url, Some("asset://proxy.mp4".to_string()));
    }

    #[test]
    fn test_video_info_default() {
        let info = VideoInfo::default();

        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert_eq!(info.fps.as_f64(), 30.0);
        assert!(!info.has_alpha);
    }

    #[test]
    fn test_license_info_default() {
        let license = LicenseInfo::default();

        assert_eq!(license.source, LicenseSource::User);
        assert_eq!(license.license_type, LicenseType::Unknown);
        assert!(license.allowed_use.is_empty());
    }

    #[test]
    fn test_asset_kind_serialization() {
        let kinds = vec![
            (AssetKind::Video, "\"video\""),
            (AssetKind::Audio, "\"audio\""),
            (AssetKind::Image, "\"image\""),
        ];

        for (kind, expected) in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn test_unique_ids() {
        let asset1 = Asset::new_video("a.mp4", "/a.mp4", VideoInfo::default());
        let asset2 = Asset::new_video("b.mp4", "/b.mp4", VideoInfo::default());

        assert_ne!(asset1.id, asset2.id);
    }
}
