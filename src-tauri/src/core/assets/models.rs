//! Asset Model Definitions
//!
//! Defines the Asset struct and related types for managing media assets.

use serde::{Deserialize, Serialize};

use crate::core::{AssetId, Ratio};

/// Asset type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

/// Video-specific metadata
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LicenseSource {
    User,
    StockProvider,
    Generated,
    Plugin,
}

/// License type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
}

impl Asset {
    /// Creates a new video asset with generated ULID
    pub fn new_video(name: &str, uri: &str, video_info: VideoInfo) -> Self {
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
        }
    }

    /// Creates a new image asset with generated ULID
    pub fn new_image(name: &str, uri: &str, width: u32, height: u32) -> Self {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_asset_creation_video() {
        let asset = Asset::new_video("test.mp4", "/path/to/test.mp4", VideoInfo::default());

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Video);
        assert_eq!(asset.name, "test.mp4");
        assert!(asset.video.is_some());
        assert!(asset.audio.is_none());
    }

    #[test]
    fn test_asset_creation_audio() {
        let asset = Asset::new_audio("music.mp3", "/path/to/music.mp3", AudioInfo::default());

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Audio);
        assert!(asset.video.is_none());
        assert!(asset.audio.is_some());
    }

    #[test]
    fn test_asset_creation_image() {
        let asset = Asset::new_image("photo.jpg", "/path/to/photo.jpg", 1920, 1080);

        assert!(!asset.id.is_empty());
        assert_eq!(asset.kind, AssetKind::Image);
        let video = asset.video.as_ref().unwrap();
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
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
    fn test_asset_serialization() {
        let asset = Asset::new_video("test.mp4", "/path/test.mp4", VideoInfo::default());

        let json = serde_json::to_string(&asset).unwrap();
        let parsed: Asset = serde_json::from_str(&json).unwrap();

        assert_eq!(asset.id, parsed.id);
        assert_eq!(asset.kind, parsed.kind);
        assert_eq!(asset.name, parsed.name);
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
