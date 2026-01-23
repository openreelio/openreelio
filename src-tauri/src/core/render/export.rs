//! Export Engine Module
//!
//! Handles final video export using FFmpeg.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::Sender;

use crate::core::{
    assets::Asset,
    effects::{Effect, FilterGraph},
    ffmpeg::FFmpegRunner,
    process::configure_tokio_command,
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

    /// Create preview render settings optimized for fast playback preview.
    ///
    /// Preview renders use lower quality settings for quick feedback:
    /// - 720p resolution (downscaled from source)
    /// - Lower bitrate for faster encoding
    /// - Faster encoding preset
    /// - H.264 for broad compatibility
    ///
    /// # Arguments
    ///
    /// * `output_path` - Path where the preview video will be saved
    /// * `start_time` - Optional start time in seconds for range preview
    /// * `end_time` - Optional end time in seconds for range preview
    pub fn preview(output_path: PathBuf, start_time: Option<f64>, end_time: Option<f64>) -> Self {
        Self {
            preset: ExportPreset::Custom,
            output_path,
            video_codec: VideoCodec::H264,
            audio_codec: AudioCodec::Aac,
            width: Some(1280),
            height: Some(720),
            video_bitrate: Some("2M".to_string()),
            audio_bitrate: Some("128k".to_string()),
            fps: Some(30.0),
            crf: Some(28), // Higher CRF = lower quality but faster
            two_pass: false,
            start_time,
            end_time,
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
// Audio Stream Detection
// =============================================================================

/// Information about whether an asset has an audio stream.
///
/// This is used to determine whether to include audio filters in the export
/// filter graph. Assets without audio (like screen recordings without sound,
/// or image sequences) should not have audio filters applied.
#[derive(Debug, Clone, Default)]
pub struct AssetAudioInfo {
    /// Whether the asset has an audio stream
    pub has_audio: bool,
}

impl AssetAudioInfo {
    /// Create from FFprobe MediaInfo result
    pub fn from_media_info(media_info: &crate::core::ffmpeg::MediaInfo) -> Self {
        Self {
            has_audio: media_info.audio.is_some(),
        }
    }

    /// Create from Asset metadata (fallback when MediaInfo is not available)
    ///
    /// Uses presence of audio info as heuristic for audio presence.
    pub fn from_asset(asset: &Asset) -> Self {
        Self {
            has_audio: asset.audio.is_some(),
        }
    }
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

    /// Probe all unique assets in a sequence to determine audio stream availability
    ///
    /// This method uses FFprobe to examine each unique media file referenced by
    /// clips in the sequence, returning a map of asset ID to audio info.
    ///
    /// # Arguments
    ///
    /// * `sequence` - The sequence containing clips to probe
    /// * `assets` - Map of asset ID to Asset
    ///
    /// # Returns
    ///
    /// A map of asset ID to `AssetAudioInfo` indicating whether each asset has audio
    pub async fn probe_assets_for_audio(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
    ) -> std::collections::HashMap<String, AssetAudioInfo> {
        let mut audio_info_map = std::collections::HashMap::new();

        // Collect unique asset IDs from all clips
        let mut unique_asset_ids = std::collections::HashSet::new();
        for track in &sequence.tracks {
            for clip in &track.clips {
                unique_asset_ids.insert(clip.asset_id.clone());
            }
        }

        // Probe each unique asset
        for asset_id in unique_asset_ids {
            if let Some(asset) = assets.get(&asset_id) {
                // Try to probe the media file
                match self.ffmpeg.probe(Path::new(&asset.uri)).await {
                    Ok(media_info) => {
                        audio_info_map
                            .insert(asset_id, AssetAudioInfo::from_media_info(&media_info));
                    }
                    Err(e) => {
                        // Probe failed - fall back to asset metadata
                        tracing::warn!(
                            "Failed to probe asset '{}' for audio info: {}. Using asset metadata as fallback.",
                            asset_id,
                            e
                        );
                        audio_info_map.insert(asset_id, AssetAudioInfo::from_asset(asset));
                    }
                }
            }
        }

        audio_info_map
    }

    /// Build FFmpeg arguments for simple single-clip export
    fn build_simple_export_args(
        &self,
        input_path: &Path,
        settings: &ExportSettings,
    ) -> Vec<String> {
        let video_codec = match settings.video_codec {
            VideoCodec::H264 => "libx264",
            VideoCodec::H265 => "libx265",
            VideoCodec::Vp9 => "libvpx-vp9",
            VideoCodec::ProRes => "prores_ks",
            VideoCodec::Copy => "copy",
        };

        let audio_codec = match settings.audio_codec {
            AudioCodec::Aac => "aac",
            AudioCodec::Mp3 => "libmp3lame",
            AudioCodec::Opus => "libopus",
            AudioCodec::Pcm => "pcm_s16le",
            AudioCodec::Copy => "copy",
        };

        let mut args = vec![
            "-i".to_string(),
            input_path.to_string_lossy().to_string(),
            "-c:v".to_string(),
            video_codec.to_string(),
            "-c:a".to_string(),
            audio_codec.to_string(),
        ];

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

    /// Build FilterGraph for a clip's effects
    fn build_clip_filter_graph(
        &self,
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
    ) -> FilterGraph {
        let mut graph = FilterGraph::new();

        // Look up each effect ID and add to graph
        for effect_id in &clip.effects {
            if let Some(effect) = effects.get(effect_id) {
                graph.add_effect(effect.clone());
            }
        }

        // Sort effects by order
        graph.sort_by_order();

        graph
    }

    /// Build FFmpeg complex filter with audio stream awareness
    ///
    /// This method properly handles clips without audio streams by:
    /// 1. Checking audio availability for each asset via the audio_info map
    /// 2. Skipping audio filters for assets without audio
    /// 3. Generating appropriate concat filters based on actual stream availability
    ///
    /// # Arguments
    ///
    /// * `sequence` - The sequence to export
    /// * `assets` - Map of asset ID to Asset
    /// * `effects` - Map of effect ID to Effect
    /// * `audio_info` - Map of asset ID to audio stream availability info
    /// * `settings` - Export settings
    pub fn build_complex_filter_args_with_audio_info(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        audio_info: &std::collections::HashMap<String, AssetAudioInfo>,
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

            // Check if this asset has audio
            let clip_has_audio = audio_info
                .get(&clip.asset_id)
                .map(|info| info.has_audio)
                .unwrap_or_else(|| {
                    // Fallback: check asset metadata
                    AssetAudioInfo::from_asset(asset).has_audio
                });

            // Add input
            args.push("-i".to_string());
            args.push(asset.uri.clone());

            // Build FilterGraph for this clip's effects
            let clip_filter_graph = self.build_clip_filter_graph(clip, effects);

            // Build filters based on track type
            match track.kind {
                TrackKind::Video => {
                    // Video processing: trim -> effects -> output
                    let trim_label = format!("trim{}", input_index);
                    let video_out_label = format!("v{}", input_index);

                    // Step 1: Trim filter
                    let trim_filter = format!(
                        "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS[{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        trim_label
                    );
                    filter_complex.push_str(&trim_filter);
                    filter_complex.push(';');

                    // Step 2: Apply video effects if any
                    if clip_filter_graph.has_video_effects() {
                        let effects_filter = clip_filter_graph
                            .to_video_filter_complex(&trim_label, &video_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        // No effects - pass through with null filter
                        filter_complex
                            .push_str(&format!("[{}]null[{}];", trim_label, video_out_label));
                    }

                    video_streams.push(format!("[{}]", video_out_label));

                    // Audio processing: ONLY if this asset has audio
                    if clip_has_audio {
                        let audio_trim_label = format!("atrim{}", input_index);
                        let audio_out_label = format!("a{}", input_index);

                        // Audio trim filter
                        let audio_trim = format!(
                            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
                            input_index,
                            clip.range.source_in_sec,
                            clip.range.source_out_sec,
                            audio_trim_label
                        );
                        filter_complex.push_str(&audio_trim);
                        filter_complex.push(';');

                        // Apply audio effects if any
                        if clip_filter_graph.has_audio_effects() {
                            let effects_filter = clip_filter_graph
                                .to_audio_filter_complex(&audio_trim_label, &audio_out_label);
                            filter_complex.push_str(&effects_filter);
                            filter_complex.push(';');
                        } else {
                            // No effects - pass through with anull filter
                            filter_complex.push_str(&format!(
                                "[{}]anull[{}];",
                                audio_trim_label, audio_out_label
                            ));
                        }

                        audio_streams.push(format!("[{}]", audio_out_label));
                    }
                    // If no audio, simply skip audio filter generation for this clip
                }
                TrackKind::Audio => {
                    // Audio-only track processing - only if has audio
                    if clip_has_audio {
                        let audio_trim_label = format!("atrim{}", input_index);
                        let audio_out_label = format!("a{}", input_index);

                        let audio_trim = format!(
                            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
                            input_index,
                            clip.range.source_in_sec,
                            clip.range.source_out_sec,
                            audio_trim_label
                        );
                        filter_complex.push_str(&audio_trim);
                        filter_complex.push(';');

                        // Apply audio effects if any
                        if clip_filter_graph.has_audio_effects() {
                            let effects_filter = clip_filter_graph
                                .to_audio_filter_complex(&audio_trim_label, &audio_out_label);
                            filter_complex.push_str(&effects_filter);
                            filter_complex.push(';');
                        } else {
                            filter_complex.push_str(&format!(
                                "[{}]anull[{}];",
                                audio_trim_label, audio_out_label
                            ));
                        }

                        audio_streams.push(format!("[{}]", audio_out_label));
                    }
                    // Skip audio-only clips that somehow have no audio
                }
                _ => {
                    // Skip non-video/audio tracks (caption, overlay)
                }
            }

            input_index += 1;
        }

        // Remove trailing semicolon if present
        if filter_complex.ends_with(';') {
            filter_complex.pop();
        }
        filter_complex.push(';');

        // Concat all video streams
        if video_streams.len() == 1 {
            // Single clip - just use the processed stream
            filter_complex.push_str(&format!("{}null[outv]", video_streams[0]));
        } else {
            // Multiple clips - concat
            filter_complex.push_str(&video_streams.join(""));
            filter_complex.push_str(&format!("concat=n={}:v=1:a=0[outv]", video_streams.len()));
        }

        // Concat audio streams ONLY if we have any
        if !audio_streams.is_empty() {
            filter_complex.push(';');
            if audio_streams.len() == 1 {
                filter_complex.push_str(&format!("{}anull[outa]", audio_streams[0]));
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

        // Map audio output ONLY if we have audio streams
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

        // Audio codec ONLY if we have audio
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

        // Audio bitrate ONLY if we have audio
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
    ///
    /// Supports real-time progress reporting via the progress channel.
    /// Progress updates are sent as FFmpeg processes frames.
    pub async fn export_sequence(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
    ) -> Result<ExportResult, ExportError> {
        self.export_sequence_with_effects(
            sequence,
            assets,
            &std::collections::HashMap::new(),
            settings,
            progress_tx,
        )
        .await
    }

    /// Export a sequence to a video file with effects support
    ///
    /// This is the full-featured export method that includes effects processing.
    /// Each clip's effects are converted to FFmpeg filters and applied during export.
    ///
    /// # Arguments
    ///
    /// * `sequence` - The sequence to export
    /// * `assets` - Map of asset ID to Asset
    /// * `effects` - Map of effect ID to Effect (for looking up clip effects)
    /// * `settings` - Export settings
    /// * `progress_tx` - Optional channel for progress updates
    pub async fn export_sequence_with_effects(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
    ) -> Result<ExportResult, ExportError> {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let start_time = std::time::Instant::now();

        // Probe all assets to determine audio stream availability
        // This prevents FFmpeg from failing when clips don't have audio
        let audio_info = self.probe_assets_for_audio(sequence, assets).await;

        // Build FFmpeg arguments with effects and audio info
        let mut args = self.build_complex_filter_args_with_audio_info(
            sequence,
            assets,
            effects,
            &audio_info,
            settings,
        )?;

        // Calculate total duration based on the last clip end time on timeline
        let total_duration: f64 = sequence.duration();
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (total_duration * fps) as u64;

        // Add progress output to stdout for real-time tracking
        // Insert before output path (last argument)
        let output_path_arg = args.pop().ok_or_else(|| {
            ExportError::InvalidSettings("No output path in FFmpeg arguments".to_string())
        })?;
        args.push("-progress".to_string());
        args.push("pipe:1".to_string());
        args.push(output_path_arg);

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

        // Spawn FFmpeg process with piped stdout for progress
        let mut cmd = tokio::process::Command::new(self.ffmpeg.info().ffmpeg_path.as_path());
        configure_tokio_command(&mut cmd);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

        // Take stderr immediately and spawn a task to drain it concurrently.
        // This prevents deadlock when FFmpeg fills the stderr pipe buffer.
        let stderr_handle = child.stderr.take().map(|stderr| {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let mut stderr = stderr;
                let _ = stderr.read_to_end(&mut buf).await;
                String::from_utf8_lossy(&buf).to_string()
            })
        });

        // Handle progress if channel provided
        if let Some(tx) = progress_tx {
            if let Some(stdout) = child.stdout.take() {
                let total_dur = total_duration;
                let total_frm = total_frames;

                // Spawn progress parsing task
                tokio::spawn(async move {
                    let reader = BufReader::new(stdout);
                    let mut lines = reader.lines();
                    let mut progress_data = FFmpegProgressData::default();

                    while let Ok(Some(line)) = lines.next_line().await {
                        let is_progress_line =
                            parse_ffmpeg_progress_line(&line, &mut progress_data);

                        // Send update on progress= lines (block boundary)
                        if is_progress_line && line.starts_with("progress=") {
                            let progress =
                                calculate_export_progress(&progress_data, total_dur, total_frm);

                            if tx.send(progress).await.is_err() {
                                // Channel closed, stop parsing
                                break;
                            }
                        }
                    }

                    // Send final progress
                    let _ = tx
                        .send(ExportProgress {
                            frame: total_frm,
                            total_frames: total_frm,
                            percent: 100.0,
                            fps: 0.0,
                            eta_seconds: 0,
                            message: "Export complete!".to_string(),
                        })
                        .await;
                });
            }
        }

        // Wait for FFmpeg to complete
        let status = child
            .wait()
            .await
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to wait for FFmpeg: {}", e)))?;

        if !status.success() {
            // Get stderr from the drain task
            let stderr_msg = if let Some(handle) = stderr_handle {
                handle
                    .await
                    .unwrap_or_else(|_| "Failed to read stderr".to_string())
            } else {
                format!("FFmpeg exited with status: {}", status)
            };
            return Err(ExportError::FFmpegFailed(stderr_msg));
        }

        // Get file info
        let file_size = std::fs::metadata(&settings.output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok(ExportResult {
            output_path: settings.output_path.clone(),
            duration_sec: total_duration,
            file_size,
            encoding_time_sec: start_time.elapsed().as_secs_f64(),
        })
    }

    /// Export a single asset (simple transcode)
    ///
    /// Supports real-time progress reporting via the progress channel.
    pub async fn export_asset(
        &self,
        asset: &Asset,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
    ) -> Result<ExportResult, ExportError> {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        let start_time = std::time::Instant::now();

        let input_path = Path::new(&asset.uri);
        let mut args = self.build_simple_export_args(input_path, settings);

        // Calculate total frames
        let duration = asset.duration_sec.unwrap_or(0.0);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (duration * fps) as u64;

        // Add progress output to stdout for real-time tracking
        // Insert before output path (last argument)
        let output_path_arg = args.pop().ok_or_else(|| {
            ExportError::InvalidSettings("No output path in FFmpeg arguments".to_string())
        })?;
        args.push("-progress".to_string());
        args.push("pipe:1".to_string());
        args.push(output_path_arg);

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

        // Spawn FFmpeg process with piped stdout for progress
        let mut cmd = tokio::process::Command::new(self.ffmpeg.info().ffmpeg_path.as_path());
        configure_tokio_command(&mut cmd);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

        // Take stderr immediately and spawn a task to drain it concurrently.
        // This prevents deadlock when FFmpeg fills the stderr pipe buffer.
        let stderr_handle = child.stderr.take().map(|stderr| {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let mut stderr = stderr;
                let _ = stderr.read_to_end(&mut buf).await;
                String::from_utf8_lossy(&buf).to_string()
            })
        });

        // Handle progress if channel provided
        if let Some(tx) = progress_tx {
            if let Some(stdout) = child.stdout.take() {
                let total_dur = duration;
                let total_frm = total_frames;

                // Spawn progress parsing task
                tokio::spawn(async move {
                    let reader = BufReader::new(stdout);
                    let mut lines = reader.lines();
                    let mut progress_data = FFmpegProgressData::default();

                    while let Ok(Some(line)) = lines.next_line().await {
                        let is_progress_line =
                            parse_ffmpeg_progress_line(&line, &mut progress_data);

                        // Send update on progress= lines (block boundary)
                        if is_progress_line && line.starts_with("progress=") {
                            let progress =
                                calculate_export_progress(&progress_data, total_dur, total_frm);

                            if tx.send(progress).await.is_err() {
                                break;
                            }
                        }
                    }

                    // Send final progress
                    let _ = tx
                        .send(ExportProgress {
                            frame: total_frm,
                            total_frames: total_frm,
                            percent: 100.0,
                            fps: 0.0,
                            eta_seconds: 0,
                            message: "Export complete!".to_string(),
                        })
                        .await;
                });
            }
        }

        // Wait for FFmpeg to complete
        let status = child
            .wait()
            .await
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to wait for FFmpeg: {}", e)))?;

        if !status.success() {
            // Get stderr from the drain task
            let stderr_msg = if let Some(handle) = stderr_handle {
                handle
                    .await
                    .unwrap_or_else(|_| "Failed to read stderr".to_string())
            } else {
                format!("FFmpeg exited with status: {}", status)
            };
            return Err(ExportError::FFmpegFailed(stderr_msg));
        }

        // Get file info
        let file_size = std::fs::metadata(&settings.output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        Ok(ExportResult {
            output_path: settings.output_path.clone(),
            duration_sec: duration,
            file_size,
            encoding_time_sec: start_time.elapsed().as_secs_f64(),
        })
    }
}

// =============================================================================
// Progress Parsing
// =============================================================================

/// Parsed FFmpeg progress line data
#[derive(Debug, Clone, Default)]
pub struct FFmpegProgressData {
    /// Current frame number
    pub frame: u64,
    /// Current FPS
    pub fps: f32,
    /// Current time in seconds
    pub time_sec: f64,
    /// Bitrate in kbps
    pub bitrate_kbps: Option<f32>,
    /// Speed multiplier (e.g., 2.5x)
    pub speed: Option<f32>,
}

/// Parse FFmpeg progress output line
///
/// FFmpeg progress output format (when using -progress pipe:1):
/// ```text
/// frame=100
/// fps=30.0
/// out_time_ms=3333333
/// bitrate=1234.5kbits/s
/// speed=2.5x
/// progress=continue
/// ```
pub fn parse_ffmpeg_progress_line(line: &str, data: &mut FFmpegProgressData) -> bool {
    let line = line.trim();

    if let Some(value) = line.strip_prefix("frame=") {
        data.frame = value.trim().parse().unwrap_or(data.frame);
        return true;
    }

    if let Some(value) = line.strip_prefix("fps=") {
        data.fps = value.trim().parse().unwrap_or(data.fps);
        return true;
    }

    if let Some(value) = line.strip_prefix("out_time_ms=") {
        // out_time_ms is in microseconds despite the name
        let microseconds: u64 = value.trim().parse().unwrap_or(0);
        data.time_sec = microseconds as f64 / 1_000_000.0;
        return true;
    }

    if let Some(value) = line.strip_prefix("bitrate=") {
        // Format: "1234.5kbits/s" or "N/A"
        if let Some(num_str) = value.strip_suffix("kbits/s") {
            data.bitrate_kbps = num_str.trim().parse().ok();
        }
        return true;
    }

    if let Some(value) = line.strip_prefix("speed=") {
        // Format: "2.5x" or "N/A"
        if let Some(num_str) = value.strip_suffix('x') {
            data.speed = num_str.trim().parse().ok();
        }
        return true;
    }

    // Return true for "progress=" lines to indicate a progress block boundary
    line.starts_with("progress=")
}

/// Calculate export progress from parsed data
pub fn calculate_export_progress(
    data: &FFmpegProgressData,
    total_duration_sec: f64,
    total_frames: u64,
) -> ExportProgress {
    let percent = if total_duration_sec > 0.0 {
        ((data.time_sec / total_duration_sec) * 100.0).min(100.0) as f32
    } else if total_frames > 0 {
        ((data.frame as f64 / total_frames as f64) * 100.0).min(100.0) as f32
    } else {
        0.0
    };

    let eta_seconds = if data.fps > 0.0 && total_duration_sec > 0.0 {
        let remaining_time = total_duration_sec - data.time_sec;
        let remaining_frames = (remaining_time * data.fps as f64) as u64;
        if data.fps > 0.0 {
            (remaining_frames as f32 / data.fps) as u64
        } else {
            0
        }
    } else if let Some(speed) = data.speed {
        if speed > 0.0 && total_duration_sec > 0.0 {
            let remaining_time = total_duration_sec - data.time_sec;
            (remaining_time / speed as f64) as u64
        } else {
            0
        }
    } else {
        0
    };

    let message = format!("Encoding frame {} ({:.1} fps)", data.frame, data.fps);

    ExportProgress {
        frame: data.frame,
        total_frames,
        percent,
        fps: data.fps,
        eta_seconds,
        message,
    }
}

// =============================================================================
// Export Validation
// =============================================================================

/// Validation result for export settings
#[derive(Debug, Clone)]
pub struct ExportValidation {
    /// Whether the export can proceed
    pub is_valid: bool,
    /// List of validation errors
    pub errors: Vec<String>,
    /// List of warnings (non-blocking)
    pub warnings: Vec<String>,
}

impl ExportValidation {
    /// Create a valid result
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// Create an invalid result with errors
    pub fn invalid(errors: Vec<String>) -> Self {
        Self {
            is_valid: false,
            errors,
            warnings: Vec::new(),
        }
    }

    /// Add an error
    pub fn add_error(&mut self, error: impl Into<String>) {
        self.errors.push(error.into());
        self.is_valid = false;
    }

    /// Add a warning
    pub fn add_warning(&mut self, warning: impl Into<String>) {
        self.warnings.push(warning.into());
    }
}

/// Validate export settings before starting export
pub fn validate_export_settings(
    sequence: &Sequence,
    assets: &std::collections::HashMap<String, Asset>,
    settings: &ExportSettings,
) -> ExportValidation {
    let mut validation = ExportValidation::valid();

    // Check for empty sequence
    let total_clips: usize = sequence.tracks.iter().map(|t| t.clips.len()).sum();
    if total_clips == 0 {
        validation.add_error("Sequence has no clips to export");
        return validation;
    }

    // Check all clip assets exist
    for track in &sequence.tracks {
        for clip in &track.clips {
            if !assets.contains_key(&clip.asset_id) {
                validation.add_error(format!(
                    "Asset '{}' not found for clip '{}'",
                    clip.asset_id, clip.id
                ));
            }
        }
    }

    // Check output directory exists
    if let Some(parent) = settings.output_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            validation.add_error(format!(
                "Output directory does not exist: {}",
                parent.display()
            ));
        }
    }

    // Check for timeline gaps (warning, not error)
    let gaps = detect_timeline_gaps(sequence);
    if !gaps.is_empty() {
        validation.add_warning(format!(
            "Timeline has {} gap(s). Black frames will be inserted.",
            gaps.len()
        ));
    }

    validation
}

/// Timeline gap information
#[derive(Debug, Clone)]
pub struct TimelineGap {
    /// Start time of the gap in seconds
    pub start_sec: f64,
    /// End time of the gap in seconds
    pub end_sec: f64,
    /// Duration of the gap
    pub duration_sec: f64,
}

/// Build FFmpeg complex filter arguments with audio stream awareness.
///
/// This is a standalone function that can be used without an ExportEngine instance.
/// It handles assets that may or may not have audio streams.
///
/// # Arguments
///
/// * `sequence` - The sequence to export
/// * `assets` - Map of asset ID to Asset
/// * `effects` - Map of effect ID to Effect
/// * `audio_info` - Map of asset ID to audio availability info
/// * `settings` - Export settings
pub fn build_complex_filter_args_with_audio_info(
    sequence: &Sequence,
    assets: &std::collections::HashMap<String, Asset>,
    effects: &std::collections::HashMap<String, Effect>,
    audio_info: &std::collections::HashMap<String, AssetAudioInfo>,
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

    // Build FilterGraph helper (inline version without engine)
    fn build_clip_filter_graph_standalone(
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
    ) -> FilterGraph {
        let mut graph = FilterGraph::new();
        for effect_id in &clip.effects {
            if let Some(effect) = effects.get(effect_id) {
                graph.add_effect(effect.clone());
            }
        }
        graph.sort_by_order();
        graph
    }

    // Add inputs and build filter graph
    for (clip, track) in &all_clips {
        let asset = assets.get(&clip.asset_id).ok_or_else(|| {
            ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
        })?;

        // Check if this asset has audio
        let clip_has_audio = audio_info
            .get(&clip.asset_id)
            .map(|info| info.has_audio)
            .unwrap_or_else(|| AssetAudioInfo::from_asset(asset).has_audio);

        // Add input
        args.push("-i".to_string());
        args.push(asset.uri.clone());

        // Build FilterGraph for this clip's effects
        let clip_filter_graph = build_clip_filter_graph_standalone(clip, effects);

        // Build filters based on track type
        match track.kind {
            TrackKind::Video => {
                // Video processing
                let trim_label = format!("trim{}", input_index);
                let video_out_label = format!("v{}", input_index);

                let trim_filter = format!(
                    "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS[{}]",
                    input_index, clip.range.source_in_sec, clip.range.source_out_sec, trim_label
                );
                filter_complex.push_str(&trim_filter);
                filter_complex.push(';');

                if clip_filter_graph.has_video_effects() {
                    let effects_filter =
                        clip_filter_graph.to_video_filter_complex(&trim_label, &video_out_label);
                    filter_complex.push_str(&effects_filter);
                    filter_complex.push(';');
                } else {
                    filter_complex.push_str(&format!("[{}]null[{}];", trim_label, video_out_label));
                }

                video_streams.push(format!("[{}]", video_out_label));

                // Audio processing: ONLY if this asset has audio
                if clip_has_audio {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_trim = format!(
                        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        audio_trim_label
                    );
                    filter_complex.push_str(&audio_trim);
                    filter_complex.push(';');

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_trim_label, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_trim_label, audio_out_label
                        ));
                    }

                    audio_streams.push(format!("[{}]", audio_out_label));
                }
            }
            TrackKind::Audio => {
                if clip_has_audio {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_trim = format!(
                        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
                        input_index,
                        clip.range.source_in_sec,
                        clip.range.source_out_sec,
                        audio_trim_label
                    );
                    filter_complex.push_str(&audio_trim);
                    filter_complex.push(';');

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_trim_label, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_trim_label, audio_out_label
                        ));
                    }

                    audio_streams.push(format!("[{}]", audio_out_label));
                }
            }
            _ => {}
        }

        input_index += 1;
    }

    // Remove trailing semicolon if present
    if filter_complex.ends_with(';') {
        filter_complex.pop();
    }
    filter_complex.push(';');

    // Concat video streams
    if video_streams.len() == 1 {
        filter_complex.push_str(&format!("{}null[outv]", video_streams[0]));
    } else {
        filter_complex.push_str(&video_streams.join(""));
        filter_complex.push_str(&format!("concat=n={}:v=1:a=0[outv]", video_streams.len()));
    }

    // Concat audio streams ONLY if we have any
    if !audio_streams.is_empty() {
        filter_complex.push(';');
        if audio_streams.len() == 1 {
            filter_complex.push_str(&format!("{}anull[outa]", audio_streams[0]));
        } else {
            filter_complex.push_str(&audio_streams.join(""));
            filter_complex.push_str(&format!("concat=n={}:v=0:a=1[outa]", audio_streams.len()));
        }
    }

    // Build FFmpeg arguments
    args.push("-filter_complex".to_string());
    args.push(filter_complex);

    args.push("-map".to_string());
    args.push("[outv]".to_string());

    if !audio_streams.is_empty() {
        args.push("-map".to_string());
        args.push("[outa]".to_string());
    }

    args.push("-c:v".to_string());
    args.push(match settings.video_codec {
        VideoCodec::H264 => "libx264".to_string(),
        VideoCodec::H265 => "libx265".to_string(),
        VideoCodec::Vp9 => "libvpx-vp9".to_string(),
        VideoCodec::ProRes => "prores_ks".to_string(),
        VideoCodec::Copy => "copy".to_string(),
    });

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

    args.push("-y".to_string());
    args.push(settings.output_path.to_string_lossy().to_string());

    Ok(args)
}

/// Detect gaps in the timeline between clips
pub fn detect_timeline_gaps(sequence: &Sequence) -> Vec<TimelineGap> {
    let mut gaps = Vec::new();

    // Collect all video clip intervals sorted by start time
    let mut intervals: Vec<(f64, f64)> = Vec::new();

    for track in &sequence.tracks {
        if track.kind != TrackKind::Video {
            continue;
        }

        for clip in &track.clips {
            let start = clip.place.timeline_in_sec;
            let end = clip.place.timeline_out_sec();
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return gaps;
    }

    // Sort by start time
    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Merge overlapping intervals and detect gaps
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in intervals {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 + 0.001 {
                // Overlapping or adjacent (with small tolerance)
                last.1 = last.1.max(end);
            } else {
                // Gap detected
                gaps.push(TimelineGap {
                    start_sec: last.1,
                    end_sec: start,
                    duration_sec: start - last.1,
                });
                merged.push((start, end));
            }
        } else {
            // First interval - check for gap at the beginning
            if start > 0.001 {
                gaps.push(TimelineGap {
                    start_sec: 0.0,
                    end_sec: start,
                    duration_sec: start,
                });
            }
            merged.push((start, end));
        }
    }

    gaps
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Progress Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_ffmpeg_progress_frame() {
        let mut data = FFmpegProgressData::default();

        assert!(parse_ffmpeg_progress_line("frame=100", &mut data));
        assert_eq!(data.frame, 100);

        assert!(parse_ffmpeg_progress_line("frame=999999", &mut data));
        assert_eq!(data.frame, 999999);
    }

    #[test]
    fn test_parse_ffmpeg_progress_fps() {
        let mut data = FFmpegProgressData::default();

        assert!(parse_ffmpeg_progress_line("fps=30.5", &mut data));
        assert!((data.fps - 30.5).abs() < 0.01);

        assert!(parse_ffmpeg_progress_line("fps=60", &mut data));
        assert!((data.fps - 60.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffmpeg_progress_time() {
        let mut data = FFmpegProgressData::default();

        // out_time_ms is in microseconds (FFmpeg quirk)
        assert!(parse_ffmpeg_progress_line("out_time_ms=5000000", &mut data));
        assert!((data.time_sec - 5.0).abs() < 0.001);

        assert!(parse_ffmpeg_progress_line(
            "out_time_ms=30500000",
            &mut data
        ));
        assert!((data.time_sec - 30.5).abs() < 0.001);
    }

    #[test]
    fn test_parse_ffmpeg_progress_bitrate() {
        let mut data = FFmpegProgressData::default();

        assert!(parse_ffmpeg_progress_line(
            "bitrate=8500.5kbits/s",
            &mut data
        ));
        assert!((data.bitrate_kbps.unwrap() - 8500.5).abs() < 0.1);

        // N/A case
        assert!(parse_ffmpeg_progress_line("bitrate=N/A", &mut data));
    }

    #[test]
    fn test_parse_ffmpeg_progress_speed() {
        let mut data = FFmpegProgressData::default();

        assert!(parse_ffmpeg_progress_line("speed=2.5x", &mut data));
        assert!((data.speed.unwrap() - 2.5).abs() < 0.01);

        assert!(parse_ffmpeg_progress_line("speed=0.95x", &mut data));
        assert!((data.speed.unwrap() - 0.95).abs() < 0.01);
    }

    #[test]
    fn test_parse_ffmpeg_progress_complete_block() {
        let mut data = FFmpegProgressData::default();

        let lines = [
            "frame=150",
            "fps=29.97",
            "out_time_ms=5005005",
            "bitrate=8000kbits/s",
            "speed=1.5x",
            "progress=continue",
        ];

        for line in lines {
            parse_ffmpeg_progress_line(line, &mut data);
        }

        assert_eq!(data.frame, 150);
        assert!((data.fps - 29.97).abs() < 0.01);
        assert!((data.time_sec - 5.005005).abs() < 0.001);
        assert!((data.bitrate_kbps.unwrap() - 8000.0).abs() < 0.1);
        assert!((data.speed.unwrap() - 1.5).abs() < 0.01);
    }

    #[test]
    fn test_calculate_export_progress_by_duration() {
        let data = FFmpegProgressData {
            frame: 150,
            fps: 30.0,
            time_sec: 5.0,
            bitrate_kbps: Some(8000.0),
            speed: Some(2.0),
        };

        let progress = calculate_export_progress(&data, 10.0, 300);

        assert_eq!(progress.frame, 150);
        assert!((progress.percent - 50.0).abs() < 0.1);
        assert!(progress.fps > 0.0);
    }

    #[test]
    fn test_calculate_export_progress_by_frames() {
        let data = FFmpegProgressData {
            frame: 250,
            fps: 30.0,
            time_sec: 0.0, // No time info
            bitrate_kbps: None,
            speed: None,
        };

        let progress = calculate_export_progress(&data, 0.0, 1000);

        assert_eq!(progress.frame, 250);
        assert!((progress.percent - 25.0).abs() < 0.1);
    }

    // -------------------------------------------------------------------------
    // Validation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_validation_empty_sequence() {
        use crate::core::timeline::SequenceFormat;

        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let assets = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &settings);

        assert!(!validation.is_valid);
        assert!(validation.errors.iter().any(|e| e.contains("no clips")));
    }

    #[test]
    fn test_validation_missing_asset() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip = Clip::new("missing_asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        track.add_clip(clip);
        sequence.add_track(track);

        let assets = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &settings);

        assert!(!validation.is_valid);
        assert!(validation.errors.iter().any(|e| e.contains("not found")));
    }

    // -------------------------------------------------------------------------
    // Timeline Gap Detection Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_detect_timeline_gaps_no_gaps() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip1 = Clip::new("asset1")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        let clip2 = Clip::new("asset2")
            .with_source_range(0.0, 5.0)
            .place_at(5.0);

        track.add_clip(clip1);
        track.add_clip(clip2);
        sequence.add_track(track);

        let gaps = detect_timeline_gaps(&sequence);
        assert!(gaps.is_empty());
    }

    #[test]
    fn test_detect_timeline_gaps_with_gap() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip1 = Clip::new("asset1")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        let clip2 = Clip::new("asset2")
            .with_source_range(0.0, 5.0)
            .place_at(8.0); // Gap of 3 seconds

        track.add_clip(clip1);
        track.add_clip(clip2);
        sequence.add_track(track);

        let gaps = detect_timeline_gaps(&sequence);

        assert_eq!(gaps.len(), 1);
        assert!((gaps[0].start_sec - 5.0).abs() < 0.001);
        assert!((gaps[0].end_sec - 8.0).abs() < 0.001);
        assert!((gaps[0].duration_sec - 3.0).abs() < 0.001);
    }

    #[test]
    fn test_detect_timeline_gaps_at_beginning() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip = Clip::new("asset1")
            .with_source_range(0.0, 5.0)
            .place_at(2.0); // Starts at 2 seconds

        track.add_clip(clip);
        sequence.add_track(track);

        let gaps = detect_timeline_gaps(&sequence);

        assert_eq!(gaps.len(), 1);
        assert!((gaps[0].start_sec - 0.0).abs() < 0.001);
        assert!((gaps[0].end_sec - 2.0).abs() < 0.001);
    }

    // -------------------------------------------------------------------------
    // Preset Tests
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // FilterGraph Integration Tests
    // -------------------------------------------------------------------------

    /// Helper function to build FilterGraph for a clip (mirrors ExportEngine::build_clip_filter_graph)
    fn build_test_filter_graph(
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
    ) -> FilterGraph {
        let mut graph = FilterGraph::new();

        for effect_id in &clip.effects {
            if let Some(effect) = effects.get(effect_id) {
                graph.add_effect(effect.clone());
            }
        }

        graph.sort_by_order();
        graph
    }

    #[test]
    fn test_build_clip_filter_graph_no_effects() {
        use crate::core::timeline::Clip;

        let clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        let effects: std::collections::HashMap<String, Effect> = std::collections::HashMap::new();

        let graph = build_test_filter_graph(&clip, &effects);

        assert!(!graph.has_video_effects());
        assert!(!graph.has_audio_effects());
    }

    #[test]
    fn test_build_clip_filter_graph_with_effects() {
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::Clip;

        // Create effect
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        let effect_id = blur_effect.id.clone();

        // Create clip with effect reference
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.effects.push(effect_id.clone());

        // Create effects map
        let mut effects: std::collections::HashMap<String, Effect> =
            std::collections::HashMap::new();
        effects.insert(effect_id, blur_effect);

        let graph = build_test_filter_graph(&clip, &effects);

        assert!(graph.has_video_effects());
        assert!(!graph.has_audio_effects());

        // Verify the filter string contains expected FFmpeg filter
        let filter_str = graph.to_video_filter_complex("0:v", "vout");
        assert!(filter_str.contains("gblur"));
    }

    #[test]
    fn test_build_clip_filter_graph_with_audio_effect() {
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::Clip;

        // Create volume effect
        let mut volume_effect = Effect::new(EffectType::Volume);
        volume_effect.set_param("level", ParamValue::Float(0.5));
        let effect_id = volume_effect.id.clone();

        // Create clip with effect reference
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.effects.push(effect_id.clone());

        // Create effects map
        let mut effects: std::collections::HashMap<String, Effect> =
            std::collections::HashMap::new();
        effects.insert(effect_id, volume_effect);

        let graph = build_test_filter_graph(&clip, &effects);

        assert!(!graph.has_video_effects());
        assert!(graph.has_audio_effects());

        // Verify the filter string contains expected FFmpeg filter
        let filter_str = graph.to_audio_filter_complex("0:a", "aout");
        assert!(filter_str.contains("volume=0.5"));
    }

    #[test]
    fn test_build_clip_filter_graph_with_multiple_effects() {
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::Clip;

        // Create multiple effects
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        blur_effect.order = 1;
        let blur_id = blur_effect.id.clone();

        let mut brightness_effect = Effect::new(EffectType::Brightness);
        brightness_effect.set_param("value", ParamValue::Float(0.2));
        brightness_effect.order = 0;
        let brightness_id = brightness_effect.id.clone();

        let mut volume_effect = Effect::new(EffectType::Volume);
        volume_effect.set_param("level", ParamValue::Float(0.8));
        let volume_id = volume_effect.id.clone();

        // Create clip with effect references
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.effects.push(blur_id.clone());
        clip.effects.push(brightness_id.clone());
        clip.effects.push(volume_id.clone());

        // Create effects map
        let mut effects: std::collections::HashMap<String, Effect> =
            std::collections::HashMap::new();
        effects.insert(blur_id, blur_effect);
        effects.insert(brightness_id, brightness_effect);
        effects.insert(volume_id, volume_effect);

        let graph = build_test_filter_graph(&clip, &effects);

        assert!(graph.has_video_effects());
        assert!(graph.has_audio_effects());

        // Verify video filter chain (should be sorted by order: brightness first, then blur)
        let video_filter_str = graph.to_video_filter_complex("0:v", "vout");
        assert!(video_filter_str.contains("eq=brightness"));
        assert!(video_filter_str.contains("gblur"));
    }

    #[test]
    fn test_build_clip_filter_graph_missing_effect() {
        use crate::core::timeline::Clip;

        // Create clip with non-existent effect reference
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.effects.push("non_existent_effect".to_string());

        // Empty effects map
        let effects: std::collections::HashMap<String, Effect> = std::collections::HashMap::new();

        // Should not panic, just skip the missing effect
        let graph = build_test_filter_graph(&clip, &effects);

        assert!(!graph.has_video_effects());
        assert!(!graph.has_audio_effects());
    }

    #[test]
    fn test_filter_graph_disabled_effect() {
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::Clip;

        // Create disabled effect
        let mut blur_effect = Effect::new(EffectType::GaussianBlur);
        blur_effect.set_param("radius", ParamValue::Float(5.0));
        blur_effect.enabled = false;
        let effect_id = blur_effect.id.clone();

        // Create clip with effect reference
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.effects.push(effect_id.clone());

        // Create effects map
        let mut effects: std::collections::HashMap<String, Effect> =
            std::collections::HashMap::new();
        effects.insert(effect_id, blur_effect);

        let graph = build_test_filter_graph(&clip, &effects);

        // Disabled effects should not be added to the graph
        assert!(!graph.has_video_effects());
    }

    // -------------------------------------------------------------------------
    // Silent Video Export Tests (Audio Stream Handling)
    // -------------------------------------------------------------------------

    #[test]
    fn test_asset_audio_info_from_media_info_with_audio() {
        use crate::core::ffmpeg::{AudioStreamInfo, MediaInfo, VideoStreamInfo};

        let media_info = MediaInfo {
            duration_sec: 10.0,
            video: Some(VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 30.0,
                codec: "h264".to_string(),
                pixel_format: "yuv420p".to_string(),
                bitrate: Some(8_000_000),
            }),
            audio: Some(AudioStreamInfo {
                sample_rate: 48000,
                channels: 2,
                codec: "aac".to_string(),
                bitrate: Some(192_000),
            }),
            format: "mp4".to_string(),
            size_bytes: 10_000_000,
        };

        let audio_info = AssetAudioInfo::from_media_info(&media_info);
        assert!(audio_info.has_audio);
    }

    #[test]
    fn test_asset_audio_info_from_media_info_without_audio() {
        use crate::core::ffmpeg::{MediaInfo, VideoStreamInfo};

        let media_info = MediaInfo {
            duration_sec: 10.0,
            video: Some(VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 30.0,
                codec: "h264".to_string(),
                pixel_format: "yuv420p".to_string(),
                bitrate: Some(8_000_000),
            }),
            audio: None, // No audio stream
            format: "mp4".to_string(),
            size_bytes: 10_000_000,
        };

        let audio_info = AssetAudioInfo::from_media_info(&media_info);
        assert!(!audio_info.has_audio);
    }

    #[test]
    fn test_build_filter_does_not_include_audio_for_silent_clip() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with one video clip
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip = Clip::new("silent_asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        track.add_clip(clip);
        sequence.add_track(track);

        // Create asset WITHOUT audio (silent video)
        let mut silent_asset = Asset::new_video(
            "silent_video.mp4",
            "/path/to/silent_video.mp4",
            VideoInfo::default(),
        )
        .with_duration(10.0)
        .with_file_size(10_000_000);
        // Override the generated ID with our test ID
        silent_asset.id = "silent_asset".to_string();
        // Ensure no audio
        silent_asset.audio = None;

        let mut assets = std::collections::HashMap::new();
        assets.insert("silent_asset".to_string(), silent_asset);

        // Create audio info map marking this asset as having NO audio
        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "silent_asset".to_string(),
            AssetAudioInfo { has_audio: false },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args with audio info
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(result.is_ok());
        let args = result.unwrap();

        // Convert args to single string for inspection
        let args_str = args.join(" ");

        // Should NOT contain audio trim filter [X:a]
        assert!(
            !args_str.contains(":a]atrim"),
            "Filter should not include audio trim for silent video. Got: {}",
            args_str
        );

        // Should NOT map audio output
        assert!(
            !args_str.contains("[outa]"),
            "Filter should not map audio output for silent video. Got: {}",
            args_str
        );

        // Should NOT include audio codec
        assert!(
            !args_str.contains("-c:a"),
            "Args should not include audio codec for silent video. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_build_filter_includes_audio_for_clip_with_audio() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with one video clip
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let clip = Clip::new("normal_asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        track.add_clip(clip);
        sequence.add_track(track);

        // Create asset WITH audio
        let mut normal_asset = Asset::new_video(
            "normal_video.mp4",
            "/path/to/normal_video.mp4",
            VideoInfo::default(),
        )
        .with_duration(10.0)
        .with_file_size(10_000_000);
        // Override the generated ID with our test ID
        normal_asset.id = "normal_asset".to_string();
        // Add audio info
        normal_asset.audio = Some(AudioInfo::default());

        let mut assets = std::collections::HashMap::new();
        assets.insert("normal_asset".to_string(), normal_asset);

        // Create audio info map marking this asset as HAVING audio
        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "normal_asset".to_string(),
            AssetAudioInfo { has_audio: true },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args with audio info
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(result.is_ok());
        let args = result.unwrap();

        // Convert args to single string for inspection
        let args_str = args.join(" ");

        // SHOULD contain audio trim filter
        assert!(
            args_str.contains(":a]atrim") || args_str.contains("[outa]"),
            "Filter should include audio processing for video with audio. Got: {}",
            args_str
        );

        // SHOULD include audio codec
        assert!(
            args_str.contains("-c:a"),
            "Args should include audio codec for video with audio. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_build_filter_mixed_clips_some_with_audio() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with two video clips
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        // First clip: has audio
        let clip1 = Clip::new("with_audio")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        track.add_clip(clip1);

        // Second clip: NO audio
        let clip2 = Clip::new("without_audio")
            .with_source_range(0.0, 5.0)
            .place_at(5.0);
        track.add_clip(clip2);

        sequence.add_track(track);

        // Create asset WITH audio
        let mut with_audio_asset = Asset::new_video(
            "with_audio.mp4",
            "/path/to/with_audio.mp4",
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        with_audio_asset.id = "with_audio".to_string();
        with_audio_asset.audio = Some(AudioInfo::default());

        // Create asset WITHOUT audio
        let mut without_audio_asset = Asset::new_video(
            "without_audio.mp4",
            "/path/to/without_audio.mp4",
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        without_audio_asset.id = "without_audio".to_string();
        without_audio_asset.audio = None;

        let mut assets = std::collections::HashMap::new();
        assets.insert("with_audio".to_string(), with_audio_asset);
        assets.insert("without_audio".to_string(), without_audio_asset);

        // Create audio info map
        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert("with_audio".to_string(), AssetAudioInfo { has_audio: true });
        audio_info_map.insert(
            "without_audio".to_string(),
            AssetAudioInfo { has_audio: false },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args with audio info
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(result.is_ok());
        let args = result.unwrap();
        let args_str = args.join(" ");

        // Should have at least one audio stream (from the clip with audio)
        // The audio concat should only include clips that have audio
        assert!(
            args_str.contains("[outa]") || args_str.contains("-c:a"),
            "Export should include audio from clips that have it. Got: {}",
            args_str
        );
    }
}
