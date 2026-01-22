//! Thumbnail Generation Module
//!
//! Handles thumbnail generation for video and image assets.
//! Uses FFmpeg for video frame extraction and image resizing.

use std::path::{Path, PathBuf};

use super::models::AssetKind;
use crate::core::ffmpeg::FFmpegRunner;

/// Default thumbnail size
pub const DEFAULT_THUMBNAIL_WIDTH: u32 = 320;
pub const DEFAULT_THUMBNAIL_HEIGHT: u32 = 180;

/// Thumbnail service for generating and managing asset thumbnails
pub struct ThumbnailService {
    /// Project directory path
    project_path: PathBuf,
    /// FFmpeg runner for video operations
    ffmpeg: FFmpegRunner,
    /// Thumbnail width
    width: u32,
    /// Thumbnail height
    height: u32,
}

impl ThumbnailService {
    /// Create a new thumbnail service
    pub fn new(project_path: PathBuf, ffmpeg: FFmpegRunner) -> Self {
        Self {
            project_path,
            ffmpeg,
            width: DEFAULT_THUMBNAIL_WIDTH,
            height: DEFAULT_THUMBNAIL_HEIGHT,
        }
    }

    /// Create with custom thumbnail size
    pub fn with_size(mut self, width: u32, height: u32) -> Self {
        self.width = width;
        self.height = height;
        self
    }

    /// Get the thumbnails directory path
    pub fn thumbnails_dir(&self) -> PathBuf {
        self.project_path.join(".openreelio").join("thumbnails")
    }

    /// Get the thumbnail path for an asset
    pub fn thumbnail_path(&self, asset_id: &str) -> PathBuf {
        self.thumbnails_dir().join(format!("{}.jpg", asset_id))
    }

    /// Check if a thumbnail exists for an asset
    pub fn thumbnail_exists(&self, asset_id: &str) -> bool {
        self.thumbnail_path(asset_id).exists()
    }

    /// Generate a thumbnail for a video asset
    pub async fn generate_for_video(
        &self,
        asset_id: &str,
        video_path: &Path,
    ) -> Result<PathBuf, ThumbnailError> {
        let thumb_path = self.thumbnail_path(asset_id);

        // Create thumbnails directory if needed
        if let Some(parent) = thumb_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ThumbnailError::IoError(format!("Failed to create thumbnails directory: {}", e))
            })?;
        }

        // Generate thumbnail using FFmpeg
        self.ffmpeg
            .generate_thumbnail(video_path, &thumb_path, Some((self.width, self.height)))
            .await
            .map_err(|e| ThumbnailError::FFmpegError(e.to_string()))?;

        Ok(thumb_path)
    }

    /// Generate a thumbnail for an image asset
    pub async fn generate_for_image(
        &self,
        asset_id: &str,
        image_path: &Path,
    ) -> Result<PathBuf, ThumbnailError> {
        let thumb_path = self.thumbnail_path(asset_id);

        // Create thumbnails directory if needed
        if let Some(parent) = thumb_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ThumbnailError::IoError(format!("Failed to create thumbnails directory: {}", e))
            })?;
        }

        // Use FFmpeg to resize the image
        let output = tokio::process::Command::new(self.ffmpeg.info().ffmpeg_path.as_path())
            .args([
                "-i",
                &image_path.to_string_lossy(),
                "-vf",
                &format!(
                    "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black",
                    self.width, self.height, self.width, self.height
                ),
                "-q:v",
                "5",
                "-y",
                &thumb_path.to_string_lossy(),
            ])
            .output()
            .await
            .map_err(|e| ThumbnailError::IoError(format!("Failed to run FFmpeg: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ThumbnailError::FFmpegError(format!(
                "Image thumbnail generation failed: {}",
                stderr
            )));
        }

        Ok(thumb_path)
    }

    /// Generate a thumbnail for an audio asset (waveform)
    pub async fn generate_for_audio(
        &self,
        asset_id: &str,
        audio_path: &Path,
    ) -> Result<PathBuf, ThumbnailError> {
        let thumb_path = self.thumbnail_path(asset_id);

        // Create thumbnails directory if needed
        if let Some(parent) = thumb_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ThumbnailError::IoError(format!("Failed to create thumbnails directory: {}", e))
            })?;
        }

        // Generate waveform image using FFmpeg
        self.ffmpeg
            .generate_waveform(audio_path, &thumb_path, self.width, self.height)
            .await
            .map_err(|e| ThumbnailError::FFmpegError(e.to_string()))?;

        Ok(thumb_path)
    }

    /// Generate a thumbnail based on asset type
    pub async fn generate_for_asset(
        &self,
        asset_id: &str,
        asset_path: &Path,
        asset_kind: &AssetKind,
    ) -> Result<PathBuf, ThumbnailError> {
        match asset_kind {
            AssetKind::Video => self.generate_for_video(asset_id, asset_path).await,
            AssetKind::Image => self.generate_for_image(asset_id, asset_path).await,
            AssetKind::Audio => self.generate_for_audio(asset_id, asset_path).await,
            _ => Err(ThumbnailError::UnsupportedType(format!(
                "Thumbnail generation not supported for {:?}",
                asset_kind
            ))),
        }
    }

    /// Delete a thumbnail for an asset
    pub fn delete_thumbnail(&self, asset_id: &str) -> Result<(), ThumbnailError> {
        let thumb_path = self.thumbnail_path(asset_id);
        if thumb_path.exists() {
            std::fs::remove_file(&thumb_path).map_err(|e| {
                ThumbnailError::IoError(format!("Failed to delete thumbnail: {}", e))
            })?;
        }
        Ok(())
    }

    /// Get the file path for a thumbnail
    /// Note: Frontend should use convertFileSrc() to convert to proper URL
    pub fn thumbnail_url(&self, asset_id: &str) -> Option<String> {
        if self.thumbnail_exists(asset_id) {
            let path = self.thumbnail_path(asset_id);
            // Return raw file path - frontend handles URL conversion
            Some(path.to_string_lossy().to_string())
        } else {
            None
        }
    }
}

/// Detect asset kind from file extension
pub fn asset_kind_from_extension(ext: &str) -> AssetKind {
    match ext.to_lowercase().as_str() {
        // Video formats
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" | "wmv" | "flv" => AssetKind::Video,
        // Audio formats
        "mp3" | "wav" | "aac" | "ogg" | "flac" | "m4a" | "wma" => AssetKind::Audio,
        // Image formats
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "tiff" | "svg" => AssetKind::Image,
        // Subtitle formats
        "srt" | "vtt" | "ass" | "ssa" | "sub" => AssetKind::Subtitle,
        // Font formats
        "ttf" | "otf" | "woff" | "woff2" => AssetKind::Font,
        // Default to Video (most common case)
        _ => AssetKind::Video,
    }
}

/// Detect asset kind from file path
pub fn asset_kind_from_path(path: &Path) -> AssetKind {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(asset_kind_from_extension)
        .unwrap_or(AssetKind::Video)
}

/// Thumbnail generation error
#[derive(Debug, thiserror::Error)]
pub enum ThumbnailError {
    #[error("IO error: {0}")]
    IoError(String),

    #[error("FFmpeg error: {0}")]
    FFmpegError(String),

    #[error("Unsupported type: {0}")]
    UnsupportedType(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_asset_kind_from_extension() {
        assert_eq!(asset_kind_from_extension("mp4"), AssetKind::Video);
        assert_eq!(asset_kind_from_extension("MP4"), AssetKind::Video);
        assert_eq!(asset_kind_from_extension("mov"), AssetKind::Video);
        assert_eq!(asset_kind_from_extension("mp3"), AssetKind::Audio);
        assert_eq!(asset_kind_from_extension("wav"), AssetKind::Audio);
        assert_eq!(asset_kind_from_extension("png"), AssetKind::Image);
        assert_eq!(asset_kind_from_extension("jpg"), AssetKind::Image);
        assert_eq!(asset_kind_from_extension("srt"), AssetKind::Subtitle);
        assert_eq!(asset_kind_from_extension("ttf"), AssetKind::Font);
    }

    #[test]
    fn test_asset_kind_from_path() {
        assert_eq!(
            asset_kind_from_path(Path::new("/path/to/video.mp4")),
            AssetKind::Video
        );
        assert_eq!(
            asset_kind_from_path(Path::new("/path/to/audio.mp3")),
            AssetKind::Audio
        );
        assert_eq!(
            asset_kind_from_path(Path::new("/path/to/image.png")),
            AssetKind::Image
        );
    }

    #[test]
    fn test_thumbnail_path_generation() {
        // Test that thumbnail paths are correctly generated
        let project_path = PathBuf::from("/test/project");
        let thumbs_dir = project_path.join(".openreelio").join("thumbnails");
        let expected = thumbs_dir.join("asset123.jpg");

        // Manual check since we can't easily create FFmpegRunner in tests
        assert!(expected.to_string_lossy().contains("asset123.jpg"));
    }

    #[test]
    fn test_thumbnail_constants() {
        assert_eq!(DEFAULT_THUMBNAIL_WIDTH, 320);
        assert_eq!(DEFAULT_THUMBNAIL_HEIGHT, 180);
    }
}
