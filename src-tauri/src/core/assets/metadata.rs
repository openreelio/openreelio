//! FFprobe Metadata Extraction Module
//!
//! Extracts video, audio, and image metadata using FFprobe.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use crate::core::{AudioInfo, CoreError, CoreResult, Ratio, VideoInfo};

// =============================================================================
// Types
// =============================================================================

/// Extracted media metadata
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    /// Duration in seconds
    pub duration_sec: f64,
    /// File size in bytes
    pub file_size: u64,
    /// Video stream info (if present)
    pub video: Option<VideoInfo>,
    /// Audio stream info (if present)
    pub audio: Option<AudioInfo>,
    /// Format name (e.g., "mov,mp4,m4a,3gp,3g2,mj2")
    pub format: String,
}

impl Default for MediaMetadata {
    fn default() -> Self {
        Self {
            duration_sec: 0.0,
            file_size: 0,
            video: None,
            audio: None,
            format: String::new(),
        }
    }
}

// =============================================================================
// FFprobe JSON Response Types
// =============================================================================

#[derive(Debug, Deserialize)]
struct FFprobeOutput {
    streams: Option<Vec<FFprobeStream>>,
    format: Option<FFprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FFprobeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u8>,
    bit_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FFprobeFormat {
    duration: Option<String>,
    size: Option<String>,
    format_name: Option<String>,
    #[allow(dead_code)]
    bit_rate: Option<String>,
}

// =============================================================================
// Metadata Extractor
// =============================================================================

/// Metadata extractor using FFprobe
pub struct MetadataExtractor;

impl MetadataExtractor {
    /// Extract metadata from a media file using FFprobe
    pub fn extract<P: AsRef<Path>>(path: P) -> CoreResult<MediaMetadata> {
        let path = path.as_ref();

        // Check if file exists
        if !path.exists() {
            return Err(CoreError::FileNotFound(
                path.to_string_lossy().to_string(),
            ));
        }

        // Run FFprobe
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_streams",
                "-show_format",
            ])
            .arg(path)
            .output()
            .map_err(|e| CoreError::FFprobeError(format!("Failed to run ffprobe: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(CoreError::FFprobeError(format!(
                "FFprobe failed: {}",
                stderr
            )));
        }

        let json_str = String::from_utf8_lossy(&output.stdout);
        Self::parse_ffprobe_output(&json_str)
    }

    /// Parse FFprobe JSON output into MediaMetadata
    fn parse_ffprobe_output(json: &str) -> CoreResult<MediaMetadata> {
        let output: FFprobeOutput = serde_json::from_str(json)
            .map_err(|e| CoreError::FFprobeError(format!("Failed to parse ffprobe output: {}", e)))?;

        let mut metadata = MediaMetadata::default();

        // Parse format info
        if let Some(format) = output.format {
            if let Some(duration_str) = format.duration {
                metadata.duration_sec = duration_str.parse().unwrap_or(0.0);
            }
            if let Some(size_str) = format.size {
                metadata.file_size = size_str.parse().unwrap_or(0);
            }
            metadata.format = format.format_name.unwrap_or_default();
        }

        // Parse streams (only take first video and audio stream)
        if let Some(streams) = output.streams {
            for stream in streams {
                match stream.codec_type.as_str() {
                    "video" if metadata.video.is_none() => {
                        metadata.video = Some(Self::parse_video_stream(&stream));
                    }
                    "audio" if metadata.audio.is_none() => {
                        metadata.audio = Some(Self::parse_audio_stream(&stream));
                    }
                    _ => {}
                }
            }
        }

        Ok(metadata)
    }

    /// Parse video stream info
    fn parse_video_stream(stream: &FFprobeStream) -> VideoInfo {
        let fps = stream
            .r_frame_rate
            .as_ref()
            .map(|s| Self::parse_frame_rate(s))
            .unwrap_or_else(|| Ratio::new(30, 1));

        let bitrate = stream
            .bit_rate
            .as_ref()
            .and_then(|s| s.parse().ok());

        VideoInfo {
            width: stream.width.unwrap_or(1920),
            height: stream.height.unwrap_or(1080),
            fps,
            codec: stream.codec_name.clone().unwrap_or_else(|| "unknown".to_string()),
            bitrate,
            has_alpha: false, // FFprobe doesn't easily expose this
        }
    }

    /// Parse audio stream info
    fn parse_audio_stream(stream: &FFprobeStream) -> AudioInfo {
        let sample_rate = stream
            .sample_rate
            .as_ref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(48000);

        let bitrate = stream
            .bit_rate
            .as_ref()
            .and_then(|s| s.parse().ok());

        AudioInfo {
            sample_rate,
            channels: stream.channels.unwrap_or(2),
            codec: stream.codec_name.clone().unwrap_or_else(|| "unknown".to_string()),
            bitrate,
        }
    }

    /// Parse frame rate string (e.g., "30/1" or "24000/1001")
    fn parse_frame_rate(fps_str: &str) -> Ratio {
        let parts: Vec<&str> = fps_str.split('/').collect();
        if parts.len() == 2 {
            let num: i32 = parts[0].parse().unwrap_or(30);
            let den: i32 = parts[1].parse().unwrap_or(1);
            if den > 0 {
                return Ratio::new(num, den);
            }
        }
        Ratio::new(30, 1)
    }

    /// Check if FFprobe is available on the system
    pub fn is_available() -> bool {
        Command::new("ffprobe")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // FFprobe Availability Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_ffprobe_availability_check() {
        // This just tests that the function runs without panicking
        let _is_available = MetadataExtractor::is_available();
    }

    // -------------------------------------------------------------------------
    // Frame Rate Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_frame_rate_30fps() {
        let fps = MetadataExtractor::parse_frame_rate("30/1");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_24fps() {
        let fps = MetadataExtractor::parse_frame_rate("24/1");
        assert_eq!(fps.num, 24);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_ntsc() {
        // 29.97 fps (NTSC)
        let fps = MetadataExtractor::parse_frame_rate("30000/1001");
        assert_eq!(fps.num, 30000);
        assert_eq!(fps.den, 1001);
    }

    #[test]
    fn test_parse_frame_rate_film_ntsc() {
        // 23.976 fps
        let fps = MetadataExtractor::parse_frame_rate("24000/1001");
        assert_eq!(fps.num, 24000);
        assert_eq!(fps.den, 1001);
    }

    #[test]
    fn test_parse_frame_rate_invalid_returns_default() {
        let fps = MetadataExtractor::parse_frame_rate("invalid");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    #[test]
    fn test_parse_frame_rate_zero_denominator() {
        let fps = MetadataExtractor::parse_frame_rate("30/0");
        assert_eq!(fps.num, 30);
        assert_eq!(fps.den, 1);
    }

    // -------------------------------------------------------------------------
    // FFprobe JSON Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_video_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "30/1",
                    "bit_rate": "5000000"
                }
            ],
            "format": {
                "duration": "120.5",
                "size": "75000000",
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert_eq!(metadata.duration_sec, 120.5);
        assert_eq!(metadata.file_size, 75000000);
        assert!(metadata.video.is_some());

        let video = metadata.video.unwrap();
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert_eq!(video.fps.den, 1);
        assert_eq!(video.codec, "h264");
        assert_eq!(video.bitrate, Some(5000000));
    }

    #[test]
    fn test_parse_audio_only_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "audio",
                    "codec_name": "mp3",
                    "sample_rate": "44100",
                    "channels": 2,
                    "bit_rate": "320000"
                }
            ],
            "format": {
                "duration": "180.0",
                "size": "7200000",
                "format_name": "mp3"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert_eq!(metadata.duration_sec, 180.0);
        assert!(metadata.video.is_none());
        assert!(metadata.audio.is_some());

        let audio = metadata.audio.unwrap();
        assert_eq!(audio.sample_rate, 44100);
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.codec, "mp3");
        assert_eq!(audio.bitrate, Some(320000));
    }

    #[test]
    fn test_parse_video_with_audio_metadata() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "width": 3840,
                    "height": 2160,
                    "r_frame_rate": "60/1"
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 6
                }
            ],
            "format": {
                "duration": "600.0",
                "size": "1200000000",
                "format_name": "matroska,webm"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_some());
        assert!(metadata.audio.is_some());

        let video = metadata.video.unwrap();
        assert_eq!(video.width, 3840);
        assert_eq!(video.height, 2160);
        assert_eq!(video.codec, "hevc");

        let audio = metadata.audio.unwrap();
        assert_eq!(audio.sample_rate, 48000);
        assert_eq!(audio.channels, 6);
        assert_eq!(audio.codec, "aac");
    }

    #[test]
    fn test_parse_empty_streams() {
        let json = r#"{
            "streams": [],
            "format": {
                "duration": "10.0",
                "size": "1000",
                "format_name": "unknown"
            }
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_none());
        assert!(metadata.audio.is_none());
        assert_eq!(metadata.duration_sec, 10.0);
    }

    #[test]
    fn test_parse_missing_optional_fields() {
        let json = r#"{
            "streams": [
                {
                    "codec_type": "video"
                }
            ],
            "format": {}
        }"#;

        let metadata = MetadataExtractor::parse_ffprobe_output(json).unwrap();

        assert!(metadata.video.is_some());

        let video = metadata.video.unwrap();
        // Default values should be used
        assert_eq!(video.width, 1920);
        assert_eq!(video.height, 1080);
        assert_eq!(video.fps.num, 30);
        assert_eq!(video.codec, "unknown");
    }

    #[test]
    fn test_parse_invalid_json() {
        let json = "invalid json";
        let result = MetadataExtractor::parse_ffprobe_output(json);
        assert!(result.is_err());
    }

    // -------------------------------------------------------------------------
    // File Not Found Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_extract_file_not_found() {
        let result = MetadataExtractor::extract("/nonexistent/path/to/file.mp4");
        assert!(matches!(result, Err(CoreError::FileNotFound(_))));
    }

    // -------------------------------------------------------------------------
    // Integration Tests (require FFprobe)
    // -------------------------------------------------------------------------

    #[test]
    #[ignore] // Run with: cargo test -- --ignored
    fn test_extract_real_video_file() {
        // This test requires a real video file and FFprobe installed
        // Place a test video at this path to run:
        // let path = "test_assets/sample_1080p.mp4";
        // let metadata = MetadataExtractor::extract(path).unwrap();
        // assert!(metadata.video.is_some());
        // assert!(metadata.duration_sec > 0.0);
    }
}
