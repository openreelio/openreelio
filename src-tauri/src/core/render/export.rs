//! Export Engine Module
//!
//! Handles final video export using FFmpeg.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Sender;

use crate::core::{
    assets::Asset,
    ffmpeg::FFmpegRunner,
    timeline::{Clip, Sequence, Track, TrackKind},
};

// =============================================================================
// Types
// =============================================================================

/// Export preset type
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportPreset {
    /// YouTube 1080p (H.264, AAC)
    Youtube1080p,
    /// YouTube 4K (H.264, AAC)
    Youtube4k,
    /// YouTube Shorts (Vertical 1080x1920)
    YoutubeShorts,
    /// Twitter (H.264, low bitrate)
    Twitter,
    /// Instagram (Square 1080x1080)
    Instagram,
    /// WebM (VP9, Opus)
    WebmVp9,
    /// ProRes (macOS only)
    ProRes,
    /// Custom settings
    Custom,
}

/// Video codec selection
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
    H265,
    Vp9,
    ProRes,
    Copy,
}

/// Audio codec selection
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioCodec {
    Aac,
    Mp3,
    Opus,
    Pcm,
    Copy,
}

/// Export settings
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    /// Export preset
    pub preset: ExportPreset,
    /// Output file path
    pub output_path: PathBuf,
    /// Video codec
    pub video_codec: VideoCodec,
    /// Audio codec
    pub audio_codec: AudioCodec,
    /// Output width (None = same as sequence)
    pub width: Option<u32>,
    /// Output height (None = same as sequence)
    pub height: Option<u32>,
    /// Video bitrate (e.g., "8M", "20M")
    pub video_bitrate: Option<String>,
    /// Audio bitrate (e.g., "192k", "320k")
    pub audio_bitrate: Option<String>,
    /// Frame rate (None = same as sequence)
    pub fps: Option<f64>,
    /// CRF value for quality-based encoding (lower = better quality)
    pub crf: Option<u8>,
    /// Two-pass encoding
    pub two_pass: bool,
    /// Start time in seconds (for partial export)
    pub start_time: Option<f64>,
    /// End time in seconds (for partial export)
    pub end_time: Option<f64>,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            preset: ExportPreset::Youtube1080p,
            output_path: PathBuf::from("output.mp4"),
            video_codec: VideoCodec::H264,
            audio_codec: AudioCodec::Aac,
            width: Some(1920),
            height: Some(1080),
            video_bitrate: Some("8M".to_string()),
            audio_bitrate: Some("192k".to_string()),
            fps: Some(30.0),
            crf: Some(23),
            two_pass: false,
            start_time: None,
            end_time: None,
        }
    }
}

impl ExportSettings {
    /// Create settings from a preset
    pub fn from_preset(preset: ExportPreset, output_path: PathBuf) -> Self {
        match preset {
            ExportPreset::Youtube1080p => Self {
                preset: ExportPreset::Youtube1080p,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1920),
                height: Some(1080),
                video_bitrate: Some("8M".to_string()),
                audio_bitrate: Some("192k".to_string()),
                fps: Some(30.0),
                crf: Some(23),
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::Youtube4k => Self {
                preset: ExportPreset::Youtube4k,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(3840),
                height: Some(2160),
                video_bitrate: Some("35M".to_string()),
                audio_bitrate: Some("320k".to_string()),
                fps: Some(30.0),
                crf: Some(18),
                two_pass: true,
                start_time: None,
                end_time: None,
            },
            ExportPreset::YoutubeShorts => Self {
                preset: ExportPreset::YoutubeShorts,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1080),
                height: Some(1920),
                video_bitrate: Some("8M".to_string()),
                audio_bitrate: Some("192k".to_string()),
                fps: Some(30.0),
                crf: Some(23),
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::Twitter => Self {
                preset: ExportPreset::Twitter,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1280),
                height: Some(720),
                video_bitrate: Some("5M".to_string()),
                audio_bitrate: Some("128k".to_string()),
                fps: Some(30.0),
                crf: Some(23),
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::Instagram => Self {
                preset: ExportPreset::Instagram,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1080),
                height: Some(1080),
                video_bitrate: Some("6M".to_string()),
                audio_bitrate: Some("128k".to_string()),
                fps: Some(30.0),
                crf: Some(23),
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::WebmVp9 => Self {
                preset: ExportPreset::WebmVp9,
                output_path,
                video_codec: VideoCodec::Vp9,
                audio_codec: AudioCodec::Opus,
                width: Some(1920),
                height: Some(1080),
                video_bitrate: Some("6M".to_string()),
                audio_bitrate: Some("128k".to_string()),
                fps: Some(30.0),
                crf: Some(31),
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::ProRes => Self {
                preset: ExportPreset::ProRes,
                output_path,
                video_codec: VideoCodec::ProRes,
                audio_codec: AudioCodec::Pcm,
                width: Some(1920),
                height: Some(1080),
                video_bitrate: None,
                audio_bitrate: None,
                fps: Some(30.0),
                crf: None,
                two_pass: false,
                start_time: None,
                end_time: None,
            },
            ExportPreset::Custom => Self {
                preset: ExportPreset::Custom,
                output_path,
                ..Default::default()
            },
        }
    }
}

/// Export progress update
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// Current frame number
    pub frame: u64,
    /// Total frames
    pub total_frames: u64,
    /// Progress percentage (0-100)
    pub percent: f32,
    /// Current encoding FPS
    pub fps: f32,
    /// Estimated time remaining in seconds
    pub eta_seconds: u64,
    /// Current status message
    pub message: String,
}

/// Export result
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Output file path
    pub output_path: PathBuf,
    /// Duration in seconds
    pub duration_sec: f64,
    /// File size in bytes
    pub file_size: u64,
    /// Total encoding time in seconds
    pub encoding_time_sec: f64,
}

/// Export error
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("No clips to export")]
    NoClips,
    #[error("FFmpeg not available")]
    FFmpegNotAvailable,
    #[error("FFmpeg execution failed: {0}")]
    FFmpegFailed(String),
    #[error("Invalid settings: {0}")]
    InvalidSettings(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Export cancelled")]
    Cancelled,
}

// =============================================================================
// Export Engine
// =============================================================================

/// Export engine for rendering sequences to video files
pub struct ExportEngine {
    ffmpeg: FFmpegRunner,
}

impl ExportEngine {
    /// Create a new export engine
    pub fn new(ffmpeg: FFmpegRunner) -> Self {
        Self { ffmpeg }
    }

    /// Build FFmpeg arguments for simple single-clip export
    fn build_simple_export_args(
        &self,
        input_path: &Path,
        settings: &ExportSettings,
    ) -> Vec<String> {
        let mut args = Vec::new();

        // Input
        args.push("-i".to_string());
        args.push(input_path.to_string_lossy().to_string());

        // Video codec
        args.push("-c:v".to_string());
        args.push(match settings.video_codec {
            VideoCodec::H264 => "libx264".to_string(),
            VideoCodec::H265 => "libx265".to_string(),
            VideoCodec::Vp9 => "libvpx-vp9".to_string(),
            VideoCodec::ProRes => "prores_ks".to_string(),
            VideoCodec::Copy => "copy".to_string(),
        });

        // Audio codec
        args.push("-c:a".to_string());
        args.push(match settings.audio_codec {
            AudioCodec::Aac => "aac".to_string(),
            AudioCodec::Mp3 => "libmp3lame".to_string(),
            AudioCodec::Opus => "libopus".to_string(),
            AudioCodec::Pcm => "pcm_s16le".to_string(),
            AudioCodec::Copy => "copy".to_string(),
        });

        // Resolution
        if let (Some(w), Some(h)) = (settings.width, settings.height) {
            args.push("-vf".to_string());
            args.push(format!("scale={}:{}", w, h));
        }

        // Video bitrate
        if let Some(ref bitrate) = settings.video_bitrate {
            args.push("-b:v".to_string());
            args.push(bitrate.clone());
        }

        // Audio bitrate
        if let Some(ref bitrate) = settings.audio_bitrate {
            args.push("-b:a".to_string());
            args.push(bitrate.clone());
        }

        // CRF
        if let Some(crf) = settings.crf {
            if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
                args.push("-crf".to_string());
                args.push(crf.to_string());
            }
        }

        // Frame rate
        if let Some(fps) = settings.fps {
            args.push("-r".to_string());
            args.push(fps.to_string());
        }

        // Start time
        if let Some(start) = settings.start_time {
            args.push("-ss".to_string());
            args.push(start.to_string());
        }

        // End time / duration
        if let Some(end) = settings.end_time {
            if let Some(start) = settings.start_time {
                args.push("-t".to_string());
                args.push((end - start).to_string());
            } else {
                args.push("-t".to_string());
                args.push(end.to_string());
            }
        }

        // Overwrite output
        args.push("-y".to_string());

        // Output
        args.push(settings.output_path.to_string_lossy().to_string());

        args
    }

    /// Build FFmpeg complex filter for multi-clip export
    ///
    /// NOTE: Current implementation assumes clips are contiguous on timeline.
    /// TODO: Handle timeline gaps by generating black frames or adjusting timestamps.
    fn build_complex_filter_args(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        settings: &ExportSettings,
    ) -> Result<Vec<String>, ExportError> {
        let mut args = Vec::new();
        let mut input_index = 0;
        let mut filter_complex = String::new();
        let mut video_streams = Vec::new();
        let mut audio_streams = Vec::new();

        // Collect all clips sorted by timeline position
        let mut all_clips: Vec<(&Clip, &Track)> = Vec::new();
        for track in &sequence.tracks {
            for clip in &track.clips {
                all_clips.push((clip, track));
            }
        }
        all_clips.sort_by(|a, b| {
            a.0.place
                .timeline_in_sec
                .partial_cmp(&b.0.place.timeline_in_sec)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if all_clips.is_empty() {
            return Err(ExportError::NoClips);
        }

        // Add inputs and build filter graph
        for (clip, track) in &all_clips {
            let asset = assets.get(&clip.asset_id).ok_or_else(|| {
                ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
            })?;

            // Add input
            args.push("-i".to_string());
            args.push(asset.uri.clone());

            // Build filters based on track type
            match track.kind {
                TrackKind::Video => {
                    // Video trim filter
                    let trim_filter = format!(
                        "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS[v{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        input_index
                    );
                    filter_complex.push_str(&trim_filter);
                    filter_complex.push(';');
                    video_streams.push(format!("[v{}]", input_index));

                    // Also extract audio from video track
                    // Note: FFmpeg will fail if the input has no audio stream.
                    // For MVP, we assume video clips have audio. TODO: probe media first.
                    let audio_trim = format!(
                        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        input_index
                    );
                    filter_complex.push_str(&audio_trim);
                    filter_complex.push(';');
                    audio_streams.push(format!("[a{}]", input_index));
                }
                TrackKind::Audio => {
                    // Audio-only track - only process audio stream
                    let audio_trim = format!(
                        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        input_index
                    );
                    filter_complex.push_str(&audio_trim);
                    filter_complex.push(';');
                    audio_streams.push(format!("[a{}]", input_index));
                }
                _ => {
                    // Skip non-video/audio tracks (caption, overlay)
                    // These require special handling not implemented in MVP
                }
            }

            input_index += 1;
        }

        // Concat all streams
        if video_streams.len() == 1 {
            // Single clip - just use the trimmed stream
            filter_complex.push_str(&format!("{}[outv]", video_streams[0]));
        } else {
            // Multiple clips - concat
            filter_complex.push_str(&video_streams.join(""));
            filter_complex.push_str(&format!("concat=n={}:v=1:a=0[outv]", video_streams.len()));
        }

        if !audio_streams.is_empty() {
            filter_complex.push(';');
            if audio_streams.len() == 1 {
                filter_complex.push_str(&format!("{}[outa]", audio_streams[0]));
            } else {
                filter_complex.push_str(&audio_streams.join(""));
                filter_complex.push_str(&format!("concat=n={}:v=0:a=1[outa]", audio_streams.len()));
            }
        }

        // Add filter complex
        args.push("-filter_complex".to_string());
        args.push(filter_complex);

        // Map outputs
        args.push("-map".to_string());
        args.push("[outv]".to_string());
        if !audio_streams.is_empty() {
            args.push("-map".to_string());
            args.push("[outa]".to_string());
        }

        // Video codec
        args.push("-c:v".to_string());
        args.push(match settings.video_codec {
            VideoCodec::H264 => "libx264".to_string(),
            VideoCodec::H265 => "libx265".to_string(),
            VideoCodec::Vp9 => "libvpx-vp9".to_string(),
            VideoCodec::ProRes => "prores_ks".to_string(),
            VideoCodec::Copy => "copy".to_string(),
        });

        // Audio codec
        if !audio_streams.is_empty() {
            args.push("-c:a".to_string());
            args.push(match settings.audio_codec {
                AudioCodec::Aac => "aac".to_string(),
                AudioCodec::Mp3 => "libmp3lame".to_string(),
                AudioCodec::Opus => "libopus".to_string(),
                AudioCodec::Pcm => "pcm_s16le".to_string(),
                AudioCodec::Copy => "copy".to_string(),
            });
        }

        // Quality settings
        if let Some(ref bitrate) = settings.video_bitrate {
            args.push("-b:v".to_string());
            args.push(bitrate.clone());
        }

        if let Some(ref bitrate) = settings.audio_bitrate {
            if !audio_streams.is_empty() {
                args.push("-b:a".to_string());
                args.push(bitrate.clone());
            }
        }

        if let Some(crf) = settings.crf {
            if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
                args.push("-crf".to_string());
                args.push(crf.to_string());
            }
        }

        // Overwrite
        args.push("-y".to_string());

        // Output
        args.push(settings.output_path.to_string_lossy().to_string());

        Ok(args)
    }

    /// Export a sequence to a video file
    pub async fn export_sequence(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
    ) -> Result<ExportResult, ExportError> {
        let start_time = std::time::Instant::now();

        // Build FFmpeg arguments
        let args = self.build_complex_filter_args(sequence, assets, settings)?;

        // Calculate total duration based on the last clip end time on timeline
        let total_duration: f64 = sequence
            .tracks
            .iter()
            .flat_map(|t| &t.clips)
            .map(|c| {
                let clip_duration =
                    (c.range.source_out_sec - c.range.source_in_sec) / c.speed as f64;
                c.place.timeline_in_sec + clip_duration
            })
            .fold(0.0, f64::max);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (total_duration * fps) as u64;

        // Send initial progress
        if let Some(ref tx) = progress_tx {
            let _ = tx
                .send(ExportProgress {
                    frame: 0,
                    total_frames,
                    percent: 0.0,
                    fps: 0.0,
                    eta_seconds: 0,
                    message: "Starting export...".to_string(),
                })
                .await;
        }

        // Run FFmpeg
        let output = tokio::process::Command::new(self.ffmpeg.info().ffmpeg_path.as_path())
            .args(&args)
            .output()
            .await
            .map_err(|e| ExportError::FFmpegFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ExportError::FFmpegFailed(stderr.to_string()));
        }

        // Get file info
        let file_size = std::fs::metadata(&settings.output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // Send completion progress
        if let Some(ref tx) = progress_tx {
            let _ = tx
                .send(ExportProgress {
                    frame: total_frames,
                    total_frames,
                    percent: 100.0,
                    fps: 0.0,
                    eta_seconds: 0,
                    message: "Export complete!".to_string(),
                })
                .await;
        }

        Ok(ExportResult {
            output_path: settings.output_path.clone(),
            duration_sec: total_duration,
            file_size,
            encoding_time_sec: start_time.elapsed().as_secs_f64(),
        })
    }

    /// Export a single asset (simple transcode)
    pub async fn export_asset(
        &self,
        asset: &Asset,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
    ) -> Result<ExportResult, ExportError> {
        let start_time = std::time::Instant::now();

        let input_path = Path::new(&asset.uri);
        let args = self.build_simple_export_args(input_path, settings);

        // Calculate total frames
        let duration = asset.duration_sec.unwrap_or(0.0);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (duration * fps) as u64;

        // Send initial progress
        if let Some(ref tx) = progress_tx {
            let _ = tx
                .send(ExportProgress {
                    frame: 0,
                    total_frames,
                    percent: 0.0,
                    fps: 0.0,
                    eta_seconds: 0,
                    message: "Starting export...".to_string(),
                })
                .await;
        }

        // Run FFmpeg
        let output = tokio::process::Command::new(self.ffmpeg.info().ffmpeg_path.as_path())
            .args(&args)
            .output()
            .await
            .map_err(|e| ExportError::FFmpegFailed(e.to_string()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ExportError::FFmpegFailed(stderr.to_string()));
        }

        // Get file info
        let file_size = std::fs::metadata(&settings.output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // Send completion progress
        if let Some(ref tx) = progress_tx {
            let _ = tx
                .send(ExportProgress {
                    frame: total_frames,
                    total_frames,
                    percent: 100.0,
                    fps: 0.0,
                    eta_seconds: 0,
                    message: "Export complete!".to_string(),
                })
                .await;
        }

        Ok(ExportResult {
            output_path: settings.output_path.clone(),
            duration_sec: duration,
            file_size,
            encoding_time_sec: start_time.elapsed().as_secs_f64(),
        })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_preset_youtube_1080p() {
        let settings =
            ExportSettings::from_preset(ExportPreset::Youtube1080p, PathBuf::from("output.mp4"));

        assert_eq!(settings.width, Some(1920));
        assert_eq!(settings.height, Some(1080));
        assert_eq!(settings.video_codec, VideoCodec::H264);
        assert_eq!(settings.audio_codec, AudioCodec::Aac);
    }

    #[test]
    fn test_export_preset_youtube_shorts() {
        let settings =
            ExportSettings::from_preset(ExportPreset::YoutubeShorts, PathBuf::from("shorts.mp4"));

        // Vertical format
        assert_eq!(settings.width, Some(1080));
        assert_eq!(settings.height, Some(1920));
    }

    #[test]
    fn test_export_preset_webm_vp9() {
        let settings =
            ExportSettings::from_preset(ExportPreset::WebmVp9, PathBuf::from("output.webm"));

        assert_eq!(settings.video_codec, VideoCodec::Vp9);
        assert_eq!(settings.audio_codec, AudioCodec::Opus);
    }

    #[test]
    fn test_export_settings_default() {
        let settings = ExportSettings::default();

        assert_eq!(settings.preset, ExportPreset::Youtube1080p);
        assert_eq!(settings.crf, Some(23));
        assert!(!settings.two_pass);
    }

    #[test]
    fn test_export_progress_serialization() {
        let progress = ExportProgress {
            frame: 100,
            total_frames: 1000,
            percent: 10.0,
            fps: 60.0,
            eta_seconds: 15,
            message: "Encoding...".to_string(),
        };

        let json = serde_json::to_string(&progress).unwrap();
        assert!(json.contains("\"frame\":100"));
        assert!(json.contains("\"totalFrames\":1000"));
    }
}
