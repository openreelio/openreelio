//! Export Engine Module
//!
//! Handles final video export using FFmpeg.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::mpsc::Sender;

use crate::core::{
    assets::{Asset, AssetKind},
    commands::TEXT_ASSET_PREFIX,
    effects::{Effect, EffectCategory, EffectType, FilterGraph, IntoFFmpegFilter, ParamValue},
    ffmpeg::FFmpegRunner,
    fs::validate_local_input_path,
    process::configure_tokio_command,
    render::hdr::{build_tonemap_filter, HdrMetadata, TonemapMode, TonemapParams},
    timeline::{BlendMode, Clip, Sequence, Track, TrackKind},
};

fn hdr_metadata_for_asset(asset: &Asset) -> HdrMetadata {
    let Some(video_info) = asset.video.as_ref() else {
        return HdrMetadata::sdr();
    };

    if !video_info.is_hdr {
        return HdrMetadata::sdr();
    }

    match video_info.color_transfer.as_deref() {
        Some("arib-std-b67") | Some("hlg") => HdrMetadata::hlg_default(),
        Some("smpte2084") | Some("pq") | None => HdrMetadata::hdr10_default(),
        Some(_) => HdrMetadata::hdr10_default(),
    }
}

fn effective_blend_mode_for_clip(clip: &Clip, track: &Track) -> BlendMode {
    if clip.blend_mode != BlendMode::Normal {
        return clip.blend_mode.clone();
    }

    track.blend_mode.clone()
}

fn uses_non_normal_blend_mode(clip: &Clip, track: &Track) -> bool {
    effective_blend_mode_for_clip(clip, track) != BlendMode::Normal
}

fn track_included_in_export(track: &Track) -> bool {
    match track.kind {
        TrackKind::Video | TrackKind::Overlay | TrackKind::Caption => track.visible && !track.muted,
        TrackKind::Audio => !track.muted,
    }
}

fn asset_has_playable_audio(
    asset: &Asset,
    track_kind: &TrackKind,
    audio_info: Option<&AssetAudioInfo>,
) -> bool {
    match asset.kind {
        AssetKind::Audio => true,
        AssetKind::Video => {
            if matches!(track_kind, TrackKind::Audio) {
                return true;
            }

            audio_info
                .map(|info| info.has_audio)
                .unwrap_or_else(|| AssetAudioInfo::from_asset(asset).has_audio)
        }
        _ => false,
    }
}

fn normalize_companion_key_value(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.6}")
    } else {
        "0".to_string()
    }
}

fn create_audio_companion_key(clip: &Clip) -> String {
    [
        clip.asset_id.clone(),
        normalize_companion_key_value(clip.place.timeline_in_sec),
        normalize_companion_key_value(clip.range.source_in_sec),
        normalize_companion_key_value(clip.range.source_out_sec),
        normalize_companion_key_value(clip.safe_speed()),
    ]
    .join("|")
}

fn collect_audio_companion_keys(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> HashSet<String> {
    let mut keys = HashSet::new();

    for track in &sequence.tracks {
        if track.kind != TrackKind::Audio {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            let Some(asset) = assets.get(&clip.asset_id) else {
                continue;
            };

            if !asset_has_playable_audio(asset, &track.kind, audio_info.get(&clip.asset_id)) {
                continue;
            }

            keys.insert(create_audio_companion_key(clip));
        }
    }

    keys
}

fn clip_audio_is_suppressed_by_companion(
    clip: &Clip,
    track: &Track,
    asset: &Asset,
    audio_companion_keys: &HashSet<String>,
) -> bool {
    track.kind != TrackKind::Audio
        && asset.kind == AssetKind::Video
        && audio_companion_keys.contains(&create_audio_companion_key(clip))
}

fn clip_has_identity_transform(clip: &Clip) -> bool {
    (clip.transform.position.x - 0.5).abs() < 0.0001
        && (clip.transform.position.y - 0.5).abs() < 0.0001
        && (clip.transform.scale.x - 1.0).abs() < 0.0001
        && (clip.transform.scale.y - 1.0).abs() < 0.0001
        && clip.transform.rotation_deg.abs() < 0.0001
        && (clip.transform.anchor.x - 0.5).abs() < 0.0001
        && (clip.transform.anchor.y - 0.5).abs() < 0.0001
}

fn clip_uses_unsupported_visual_composition(clip: &Clip) -> bool {
    !is_text_clip(clip)
        && !clip.is_adjustment_layer()
        && (!clip_has_identity_transform(clip) || (clip.opacity - 1.0).abs() > 0.0001)
}

fn has_layered_visual_overlap(sequence: &Sequence) -> bool {
    let mut intervals = Vec::new();

    for track in &sequence.tracks {
        if track.kind != TrackKind::Video || !track_included_in_export(track) {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled || clip.is_adjustment_layer() {
                continue;
            }

            intervals.push((clip.place.timeline_in_sec, clip.place.timeline_out_sec()));
        }
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut latest_end: Option<f64> = None;
    for (start, end) in intervals {
        if let Some(current_end) = latest_end {
            if start < current_end - 0.001 {
                return true;
            }
            latest_end = Some(current_end.max(end));
        } else {
            latest_end = Some(end);
        }
    }

    false
}

fn sequence_has_exportable_audio(
    sequence: &Sequence,
    assets: &HashMap<String, Asset>,
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> bool {
    let audio_companion_keys = collect_audio_companion_keys(sequence, assets, audio_info);

    sequence
        .tracks
        .iter()
        .filter(|track| !track.muted)
        .any(|track| {
            track.clips.iter().any(|clip| {
                if !clip.enabled || clip.freeze_frame || clip.audio.muted {
                    return false;
                }

                let Some(asset) = assets.get(&clip.asset_id) else {
                    return false;
                };

                asset_has_playable_audio(asset, &track.kind, audio_info.get(&clip.asset_id))
                    && !clip_audio_is_suppressed_by_companion(
                        clip,
                        track,
                        asset,
                        &audio_companion_keys,
                    )
            })
        })
}

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

/// HDR (High Dynamic Range) mode for export
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HdrMode {
    /// SDR (Standard Dynamic Range) - default
    #[default]
    Sdr,
    /// HDR10 with PQ (Perceptual Quantizer) transfer function
    /// Uses BT.2020 color primaries and 10-bit color depth
    Hdr10,
    /// HLG (Hybrid Log-Gamma) HDR format
    /// Compatible with both HDR and SDR displays
    Hlg,
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
    /// HDR mode (SDR, HDR10, or HLG)
    #[serde(default)]
    pub hdr_mode: HdrMode,
    /// Maximum Content Light Level in cd/m² (nits) for HDR10
    /// Typical values: 1000-4000 for consumer content, 10000 for reference
    pub max_cll: Option<u32>,
    /// Maximum Frame-Average Light Level in cd/m² for HDR10
    /// Should be <= max_cll
    pub max_fall: Option<u32>,
    /// Color bit depth (8, 10, or 12)
    pub bit_depth: Option<u8>,
    /// Tonemapping mode for HDR→SDR conversion (applied when source is HDR and output is SDR)
    #[serde(default)]
    pub tonemap_mode: Option<TonemapMode>,
    /// Hardware acceleration mode for encoding
    #[serde(default)]
    pub hardware_accel: super::hardware::HardwareAccelMode,
    /// Resolved FFmpeg encoder name (populated by IPC layer after hardware detection).
    /// When None, falls back to software encoder for the selected video codec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_encoder_name: Option<String>,
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
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
            tonemap_mode: None,
            hardware_accel: super::hardware::HardwareAccelMode::default(),
            resolved_encoder_name: None,
        }
    }
}

impl ExportSettings {
    /// Get the resolved video encoder name for FFmpeg.
    ///
    /// Returns the pre-resolved encoder name if set (by IPC layer after detection),
    /// otherwise falls back to software encoder for the selected video codec.
    pub fn video_encoder_name(&self) -> String {
        if let Some(ref name) = self.resolved_encoder_name {
            return name.clone();
        }
        super::hardware::software_encoder_name(&self.video_codec)
    }

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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
                hdr_mode: HdrMode::Sdr,
                max_cll: None,
                max_fall: None,
                bit_depth: None,
                tonemap_mode: None,
                hardware_accel: super::hardware::HardwareAccelMode::default(),
                resolved_encoder_name: None,
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
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
            tonemap_mode: None,
            hardware_accel: super::hardware::HardwareAccelMode::default(),
            resolved_encoder_name: None,
        }
    }

    /// Returns the FFmpeg arguments for HDR color metadata.
    ///
    /// **Important**: HDR export requires H.265 (HEVC) codec. Use `validate_hdr_settings()`
    /// to check compatibility before export.
    ///
    /// For HDR10:
    /// - BT.2020 color primaries
    /// - BT.2020 non-constant luminance colorspace
    /// - SMPTE ST 2084 (PQ) transfer characteristics
    /// - 10-bit pixel format
    /// - MaxCLL/MaxFALL metadata
    ///
    /// For HLG:
    /// - BT.2020 color primaries
    /// - BT.2020 non-constant luminance colorspace
    /// - ARIB STD-B67 (HLG) transfer characteristics
    /// - 10-bit pixel format
    pub fn hdr_args(&self) -> Vec<String> {
        match self.hdr_mode {
            HdrMode::Sdr => Vec::new(),
            HdrMode::Hdr10 => {
                let mut args = vec![
                    // Color primaries: BT.2020
                    "-color_primaries".to_string(),
                    "bt2020".to_string(),
                    // Color space: BT.2020 non-constant luminance
                    "-colorspace".to_string(),
                    "bt2020nc".to_string(),
                    // Transfer function: PQ (Perceptual Quantizer)
                    "-color_trc".to_string(),
                    "smpte2084".to_string(),
                    // 10-bit pixel format
                    "-pix_fmt".to_string(),
                    "yuv420p10le".to_string(),
                ];

                // Add HDR10 static metadata if provided (only valid for H.265)
                if let (Some(max_cll), Some(max_fall)) = (self.max_cll, self.max_fall) {
                    if matches!(self.video_codec, VideoCodec::H265) {
                        args.push("-x265-params".to_string());
                        args.push(format!(
                            "hdr-opt=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:max-cll={},{}",
                            max_cll, max_fall
                        ));
                    }
                }

                args
            }
            HdrMode::Hlg => {
                vec![
                    // Color primaries: BT.2020
                    "-color_primaries".to_string(),
                    "bt2020".to_string(),
                    // Color space: BT.2020 non-constant luminance
                    "-colorspace".to_string(),
                    "bt2020nc".to_string(),
                    // Transfer function: HLG (Hybrid Log-Gamma)
                    "-color_trc".to_string(),
                    "arib-std-b67".to_string(),
                    // 10-bit pixel format
                    "-pix_fmt".to_string(),
                    "yuv420p10le".to_string(),
                ]
            }
        }
    }

    /// Returns true if HDR mode is enabled
    pub fn is_hdr(&self) -> bool {
        !matches!(self.hdr_mode, HdrMode::Sdr)
    }

    /// Validates HDR settings and returns an error message if invalid.
    ///
    /// HDR export has the following requirements:
    /// - **Codec**: Must use H.265 (HEVC). H.264 does not support HDR metadata.
    /// - **MaxCLL/MaxFALL**: For HDR10, these should be set for proper display mapping.
    ///
    /// # Returns
    ///
    /// - `None` if settings are valid
    /// - `Some(error_message)` if there's a validation issue
    pub fn validate_hdr_settings(&self) -> Option<String> {
        if !self.is_hdr() {
            return None; // SDR mode, no validation needed
        }

        // HDR requires H.265 codec
        if !matches!(self.video_codec, VideoCodec::H265) {
            return Some(format!(
                "HDR export requires H.265 (HEVC) codec. Current codec: {:?}. \
                 H.264 does not support HDR metadata.",
                self.video_codec
            ));
        }

        // Warning for HDR10 without metadata (not an error, just a warning)
        if matches!(self.hdr_mode, HdrMode::Hdr10)
            && (self.max_cll.is_none() || self.max_fall.is_none())
        {
            // This is a warning, not an error - return None but log warning
            tracing::warn!(
                "HDR10 export without MaxCLL/MaxFALL metadata. \
                 Consider setting max_cll and max_fall for proper display mapping."
            );
        }

        None
    }

    /// Returns settings with HDR-compatible codec if HDR is enabled.
    ///
    /// Automatically switches to H.265 if HDR mode is enabled with an incompatible codec.
    pub fn with_hdr_compatible_codec(mut self) -> Self {
        if self.is_hdr() && !matches!(self.video_codec, VideoCodec::H265) {
            tracing::info!(
                "Switching from {:?} to H.265 for HDR export compatibility",
                self.video_codec
            );
            self.video_codec = VideoCodec::H265;
        }
        self
    }

    /// Builds the tonemapping FFmpeg video filter string for HDR→SDR conversion.
    ///
    /// Returns `Some(filter)` when a tonemap mode is configured and the source
    /// metadata indicates HDR content. Returns `None` if tonemapping is not needed.
    pub fn build_tonemap_video_filter(&self, source_metadata: &HdrMetadata) -> Option<String> {
        // Only tonemap if we have a mode set and the source is actually HDR
        let mode = self.tonemap_mode?;
        if !source_metadata.is_hdr() {
            return None;
        }

        let params = TonemapParams {
            mode,
            target_peak: 100.0,
            desat: 0.75,
            desat_exp: 1.5,
            gamut: "relative".to_string(),
        };

        let filter = build_tonemap_filter(&params, source_metadata);
        if filter.is_empty() {
            None
        } else {
            Some(filter)
        }
    }

    /// Constructs `HdrMetadata` from the export settings for HDR passthrough.
    pub fn to_hdr_metadata(&self) -> HdrMetadata {
        match self.hdr_mode {
            HdrMode::Sdr => HdrMetadata::sdr(),
            HdrMode::Hdr10 => {
                let mut meta = HdrMetadata::hdr10_default();
                if let Some(cll) = self.max_cll {
                    meta = meta.with_max_cll(cll);
                }
                if let Some(fall) = self.max_fall {
                    meta = meta.with_max_fall(fall);
                }
                meta
            }
            HdrMode::Hlg => HdrMetadata::hlg_default(),
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

// =============================================================================
// Batch & Range Render Types
// =============================================================================

/// A single item in a batch render queue.
///
/// Each item specifies a preset and output path. Optional `in_point`/`out_point`
/// restrict the render to a specific time range within the sequence.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenderItem {
    /// Export preset identifier (e.g., "youtube_1080p")
    pub preset: String,
    /// Output file path for this render
    pub output_path: String,
    /// Optional In point in seconds for range export
    pub in_point: Option<f64>,
    /// Optional Out point in seconds for range export
    pub out_point: Option<f64>,
}

/// Status of an individual render job within a batch
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderJobStatus {
    /// Waiting in queue
    Pending,
    /// Currently encoding
    Rendering,
    /// Finished successfully
    Completed,
    /// Encoding failed
    Failed,
    /// Cancelled by user
    Cancelled,
}

/// Result returned when a batch render is started
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenderResult {
    /// Unique identifier for the entire batch
    pub batch_id: String,
    /// Job IDs for each item (same order as input items)
    pub job_ids: Vec<String>,
    /// Total number of items in the batch
    pub total_items: u32,
    /// Initial status ("started")
    pub status: String,
}

/// Completion info for a single item within a batch
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemResult {
    /// Job ID of the completed item
    pub job_id: String,
    /// Output file path
    pub output_path: String,
    /// Render status
    pub status: RenderJobStatus,
    /// Duration in seconds (0 if failed/cancelled)
    pub duration_sec: f64,
    /// File size in bytes (0 if failed/cancelled)
    pub file_size: u64,
    /// Encoding time in seconds (0 if failed/cancelled)
    pub encoding_time_sec: f64,
    /// Error message (only if status == Failed)
    pub error: Option<String>,
}

// =============================================================================
// Still Image & Audio-Only Export Types
// =============================================================================

/// Image format for single-frame export
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    /// PNG (lossless, with alpha support)
    Png,
    /// JPEG (lossy, smaller file size)
    Jpeg,
    /// TIFF (lossless, professional format)
    Tiff,
}

impl ImageFormat {
    /// File extension for this format
    pub fn extension(&self) -> &str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Tiff => "tiff",
        }
    }

    /// FFmpeg pixel format appropriate for this image format
    pub fn pixel_format(&self) -> &str {
        match self {
            Self::Png => "rgba",
            Self::Jpeg => "yuvj420p",
            Self::Tiff => "rgb48le",
        }
    }
}

/// Settings for exporting a single frame from a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameExportSettings {
    /// Time position in seconds to capture the frame
    pub time_sec: f64,
    /// Output image format
    pub format: ImageFormat,
    /// Output file path
    pub output_path: PathBuf,
    /// Optional JPEG quality (1-31, lower = better; only used for JPEG)
    pub quality: Option<u8>,
}

impl FrameExportSettings {
    /// Validate frame export settings
    pub fn validate(&self) -> Result<(), ExportError> {
        if self.time_sec.is_nan() || self.time_sec.is_infinite() {
            return Err(ExportError::InvalidSettings(
                "Time position must be a finite number".to_string(),
            ));
        }
        if self.time_sec < 0.0 {
            return Err(ExportError::InvalidSettings(
                "Time position must be non-negative".to_string(),
            ));
        }

        if let Some(q) = self.quality {
            if q == 0 || q > 31 {
                return Err(ExportError::InvalidSettings(
                    "JPEG quality must be between 1 and 31".to_string(),
                ));
            }
        }

        Ok(())
    }
}

/// Result of a single-frame export
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameExportResult {
    /// Output file path
    pub output_path: PathBuf,
    /// File size in bytes
    pub file_size: u64,
    /// Image format used
    pub format: ImageFormat,
    /// Width of the exported image in pixels
    pub width: u32,
    /// Height of the exported image in pixels
    pub height: u32,
}

/// Audio export format
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioExportFormat {
    /// WAV (uncompressed PCM)
    Wav,
    /// MP3 (lossy, widely compatible)
    Mp3,
    /// FLAC (lossless compression)
    Flac,
}

impl AudioExportFormat {
    /// File extension for this format
    pub fn extension(&self) -> &str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
        }
    }

    /// FFmpeg audio codec name for this format
    pub fn codec(&self) -> &str {
        match self {
            Self::Wav => "pcm_s16le",
            Self::Mp3 => "libmp3lame",
            Self::Flac => "flac",
        }
    }

    /// Default bitrate for lossy formats (None for lossless)
    pub fn default_bitrate(&self) -> Option<&str> {
        match self {
            Self::Wav | Self::Flac => None,
            Self::Mp3 => Some("320k"),
        }
    }
}

/// Settings for exporting audio only from a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioExportSettings {
    /// Output audio format
    pub format: AudioExportFormat,
    /// Output file path
    pub output_path: PathBuf,
    /// Optional audio bitrate (e.g., "192k", "320k") — only for lossy formats
    pub bitrate: Option<String>,
    /// Optional sample rate in Hz (e.g., 44100, 48000)
    pub sample_rate: Option<u32>,
    /// Optional start time in seconds for range export
    pub start_time: Option<f64>,
    /// Optional end time in seconds for range export
    pub end_time: Option<f64>,
}

impl AudioExportSettings {
    /// Validate audio export settings
    pub fn validate(&self) -> Result<(), ExportError> {
        if let Some(t) = self.start_time {
            if t.is_nan() || t.is_infinite() {
                return Err(ExportError::InvalidSettings(
                    "Start time must be a finite number".to_string(),
                ));
            }
        }
        if let Some(t) = self.end_time {
            if t.is_nan() || t.is_infinite() {
                return Err(ExportError::InvalidSettings(
                    "End time must be a finite number".to_string(),
                ));
            }
        }
        if let (Some(start), Some(end)) = (self.start_time, self.end_time) {
            if end <= start {
                return Err(ExportError::InvalidSettings(
                    "End time must be greater than start time".to_string(),
                ));
            }
        }

        if let Some(sr) = self.sample_rate {
            if sr == 0 || sr > 192_000 {
                return Err(ExportError::InvalidSettings(
                    "Sample rate must be between 1 and 192000 Hz".to_string(),
                ));
            }
        }

        Ok(())
    }

    /// Convert to ExportSettings for reuse with the existing render pipeline
    pub fn to_export_settings(&self) -> ExportSettings {
        let bitrate = self
            .bitrate
            .clone()
            .or_else(|| self.format.default_bitrate().map(String::from));

        ExportSettings {
            preset: ExportPreset::Custom,
            output_path: self.output_path.clone(),
            video_codec: VideoCodec::Copy,
            // Note: audio_codec here is a placeholder for the ExportSettings struct.
            // export_audio_only() strips all -c:a args and replaces them using
            // AudioExportFormat::codec() which returns the correct codec name.
            audio_codec: match self.format {
                AudioExportFormat::Wav => AudioCodec::Pcm,
                AudioExportFormat::Mp3 => AudioCodec::Mp3,
                AudioExportFormat::Flac => AudioCodec::Copy,
            },
            width: None,
            height: None,
            video_bitrate: None,
            audio_bitrate: bitrate,
            fps: None,
            crf: None,
            two_pass: false,
            start_time: self.start_time,
            end_time: self.end_time,
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
            tonemap_mode: None,
            hardware_accel: super::hardware::HardwareAccelMode::Cpu,
            resolved_encoder_name: None,
        }
    }
}

/// Result of an audio-only export
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioExportResult {
    /// Output file path
    pub output_path: PathBuf,
    /// Duration in seconds
    pub duration_sec: f64,
    /// File size in bytes
    pub file_size: u64,
    /// Audio format used
    pub format: AudioExportFormat,
    /// Total encoding time in seconds
    pub encoding_time_sec: f64,
}

// =============================================================================
// Render Job Registry (Cancel Support)
// =============================================================================

use std::sync::LazyLock;
use tokio::sync::{oneshot, Mutex as TokioMutex};

/// Global registry of active render jobs for cancellation support.
///
/// Each entry maps a job ID to a oneshot sender that, when sent, signals
/// the render task to abort (kill the FFmpeg child process).
static RENDER_JOB_CANCEL_REGISTRY: LazyLock<TokioMutex<HashMap<String, oneshot::Sender<()>>>> =
    LazyLock::new(|| TokioMutex::new(HashMap::new()));

/// Register a render job's cancel sender in the global registry.
pub async fn register_render_job(job_id: &str, cancel_tx: oneshot::Sender<()>) {
    let mut guard = RENDER_JOB_CANCEL_REGISTRY.lock().await;
    guard.insert(job_id.to_string(), cancel_tx);
}

/// Cancel a render job by ID. Returns true if the job was found and cancelled.
pub async fn cancel_render_job(job_id: &str) -> bool {
    let mut guard = RENDER_JOB_CANCEL_REGISTRY.lock().await;
    if let Some(cancel_tx) = guard.remove(job_id) {
        let _ = cancel_tx.send(());
        true
    } else {
        false
    }
}

/// Remove a render job from the registry (called on completion).
pub async fn unregister_render_job(job_id: &str) {
    let mut guard = RENDER_JOB_CANCEL_REGISTRY.lock().await;
    guard.remove(job_id);
}

fn insert_output_option_args(
    args: &mut Vec<String>,
    output_options: impl IntoIterator<Item = String>,
) -> Result<(), ExportError> {
    let output_path = args.pop().ok_or_else(|| {
        ExportError::InvalidSettings("No output path in FFmpeg arguments".to_string())
    })?;

    args.extend(output_options);
    args.push(output_path);

    Ok(())
}

fn append_output_time_range_args(
    args: &mut Vec<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
) {
    if let Some(start) = start_time {
        args.push("-ss".to_string());
        args.push(start.to_string());
    }

    if let Some(end) = end_time {
        args.push("-t".to_string());
        args.push(match start_time {
            Some(start) => (end - start).to_string(),
            None => end.to_string(),
        });
    }
}

fn effective_export_duration(
    sequence: &Sequence,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> f64 {
    let full_duration = sequence
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .filter(|clip| clip.enabled)
        .map(|clip| clip.place.timeline_out_sec())
        .fold(0.0_f64, f64::max);

    let normalized_start = start_time.unwrap_or(0.0).max(0.0).min(full_duration);

    match end_time {
        Some(end) => (end.max(0.0).min(full_duration) - normalized_start).max(0.0),
        None => (full_duration - normalized_start).max(0.0),
    }
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
// Speed Filter Helpers
// =============================================================================

/// Build setpts expression for video speed adjustment.
///
/// For speed 1.0 (or very close), returns `"PTS-STARTPTS"` (no change).
/// For other speeds, returns `"(PTS-STARTPTS)/{speed}"` which scales
/// presentation timestamps to achieve the desired playback speed.
///
/// # Examples
///
/// - speed 2.0 → `"(PTS-STARTPTS)/2"` (plays twice as fast)
/// - speed 0.5 → `"(PTS-STARTPTS)/0.5"` (plays at half speed)
fn build_speed_setpts(speed: f64) -> String {
    if (speed - 1.0).abs() < 1e-6 {
        "PTS-STARTPTS".to_string()
    } else {
        // Format without unnecessary trailing zeros
        let speed_str = format_speed_number(speed);
        format!("(PTS-STARTPTS)/{}", speed_str)
    }
}

/// Build chained atempo filters for audio speed adjustment.
///
/// Returns `None` if speed is 1.0 (no change needed).
/// FFmpeg's atempo filter operates in the range \[0.5, 100.0\], but for
/// quality we chain multiple filters within \[0.5, 2.0\] to cover
/// extreme speed values.
///
/// # Examples
///
/// - speed 2.0 → `Some("atempo=2")`
/// - speed 4.0 → `Some("atempo=2,atempo=2")`
/// - speed 0.25 → `Some("atempo=0.5,atempo=0.5")`
fn build_atempo_chain(speed: f64) -> Option<String> {
    if (speed - 1.0).abs() < 1e-6 {
        return None;
    }

    let mut filters = Vec::new();
    let mut remaining = speed;

    // Chain atempo=2.0 for speeds above 2.0
    while remaining > 2.0 {
        filters.push("atempo=2".to_string());
        remaining /= 2.0;
    }
    // Chain atempo=0.5 for speeds below 0.5
    while remaining < 0.5 {
        filters.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }

    filters.push(format!("atempo={}", format_speed_number(remaining)));
    Some(filters.join(","))
}

/// Format a speed value without unnecessary trailing zeros.
fn format_speed_number(value: f64) -> String {
    let mut s = format!("{:.6}", value);
    let trimmed_len = s.trim_end_matches('0').trim_end_matches('.').len();
    s.truncate(trimmed_len);
    s
}

/// Build video trim filter with speed, reverse, freeze frame, and time remap support.
///
/// Generates the complete video filter chain from input to the trim output label:
/// - trim → setpts (speed/time_remap) → [reverse] → [freeze loop] → output
fn build_video_trim_filter(
    clip: &Clip,
    input_index: usize,
    trim_label: &str,
    filter_complex: &mut String,
) {
    if clip.freeze_frame {
        // Freeze frame: extract single frame, loop to fill duration
        let tpad_duration = format_speed_number(clip.place.duration_sec);
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={},trim=0:{},setpts=PTS-STARTPTS[{}]",
            input_index,
            clip.range.source_in_sec,
            clip.range.source_out_sec,
            tpad_duration,
            tpad_duration,
            trim_label
        );
        filter_complex.push_str(&filter);
    } else if clip.has_time_remap() {
        // Time remap: use piecewise setpts expression from keyframe curve
        let remap = clip.time_remap.as_ref().unwrap();
        let setpts = build_time_remap_setpts(remap);
        let (source_start, source_end) = remap.source_range();
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts={}[{}]",
            input_index,
            format_speed_number(source_start),
            format_speed_number(source_end),
            setpts,
            trim_label
        );
        filter_complex.push_str(&filter);
    } else if clip.reverse {
        // Reverse: apply reverse filter after trim, before speed
        let speed = clip.safe_speed();
        let setpts = build_speed_setpts(speed);
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS,reverse,setpts={}[{}]",
            input_index, clip.range.source_in_sec, clip.range.source_out_sec, setpts, trim_label
        );
        filter_complex.push_str(&filter);
    } else {
        // Normal: trim with constant speed adjustment
        let speed = clip.safe_speed();
        let setpts = build_speed_setpts(speed);
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts={}[{}]",
            input_index, clip.range.source_in_sec, clip.range.source_out_sec, setpts, trim_label
        );
        filter_complex.push_str(&filter);
    }
    filter_complex.push(';');
}

/// Build an FFmpeg `setpts` expression from a time remap curve.
///
/// Generates an inverse piecewise expression using nested `if()` calls.
/// Each segment maps input source PTS to output timeline PTS.
///
/// For example, a 2-keyframe curve (0→0, 2→4) produces:
/// `(PTS-STARTPTS)*0.5` (4s of source compressed into 2s of output)
///
/// A 3-keyframe curve (0→0, 1→1, 2→4) produces:
/// `if(lt(PTS-STARTPTS,1),(PTS-STARTPTS)*1,((PTS-STARTPTS)-1)*0.333333+1)`
fn build_time_remap_setpts(curve: &crate::core::timeline::TimeRemapCurve) -> String {
    use crate::core::timeline::KeyframeInterpolation;

    let kfs = &curve.keyframes;
    if kfs.len() < 2 {
        return "PTS-STARTPTS".to_string();
    }
    let source_origin = kfs[0].source_time;

    // For 2 keyframes with linear interpolation, simplify to constant speed
    if kfs.len() == 2 {
        let dt = kfs[1].timeline_time - kfs[0].timeline_time;
        let ds = kfs[1].source_time - kfs[0].source_time;
        if dt > 0.0 {
            match &kfs[0].interpolation {
                KeyframeInterpolation::Linear => {
                    if ds.abs() < 1e-6 {
                        return format_speed_number(kfs[0].timeline_time);
                    }

                    let time_scale = dt / ds;
                    let source_offset = kfs[0].source_time - source_origin;
                    let timeline_offset = kfs[0].timeline_time;
                    if source_offset.abs() < 1e-6 {
                        if timeline_offset.abs() < 1e-6 {
                            return format!("(PTS-STARTPTS)*{}", format_speed_number(time_scale));
                        }
                        return format!(
                            "(PTS-STARTPTS)*{}+{}",
                            format_speed_number(time_scale),
                            format_speed_number(timeline_offset)
                        );
                    }
                    return format!(
                        "((PTS-STARTPTS)-{})*{}+{}",
                        format_speed_number(source_offset),
                        format_speed_number(time_scale),
                        format_speed_number(timeline_offset)
                    );
                }
                KeyframeInterpolation::Hold => {
                    // Hold: show the same frame for the entire duration
                    return format_speed_number(kfs[0].source_time);
                }
                KeyframeInterpolation::Bezier { .. } => {
                    // Fall through to piecewise generation
                }
            }
        }
    }

    // Build piecewise inverse expression:
    // if(lt(S,s1), segment0, if(lt(S,s2), segment1, ...))
    // where S = PTS-STARTPTS (source time from trimmed segment start)
    let mut segments: Vec<String> = Vec::new();

    for i in 0..kfs.len() - 1 {
        let kf0 = &kfs[i];
        let kf1 = &kfs[i + 1];
        let dt = kf1.timeline_time - kf0.timeline_time;
        let ds = kf1.source_time - kf0.source_time;

        let segment_expr = match &kf0.interpolation {
            KeyframeInterpolation::Hold => format_speed_number(kf0.source_time),
            // Bezier curves cannot be perfectly expressed in FFmpeg setpts;
            // approximate with linear interpolation for render.
            KeyframeInterpolation::Linear | KeyframeInterpolation::Bezier { .. } => {
                if dt > 0.0 && ds.abs() > 1e-6 {
                    let time_scale = dt / ds;
                    let source_offset = kf0.source_time - source_origin;
                    format!(
                        "((PTS-STARTPTS)-{})*{}+{}",
                        format_speed_number(source_offset),
                        format_speed_number(time_scale),
                        format_speed_number(kf0.timeline_time)
                    )
                } else {
                    format_speed_number(kf0.timeline_time)
                }
            }
        };

        segments.push(segment_expr);
    }

    // Build nested if() expression
    if segments.len() == 1 {
        return segments[0].clone();
    }

    // Start from the last segment and wrap backwards
    let mut expr = segments[segments.len() - 1].clone();
    for i in (0..segments.len() - 1).rev() {
        let threshold = format_speed_number(kfs[i + 1].source_time - source_origin);
        expr = format!(
            "if(lt((PTS-STARTPTS),{}),{},{})",
            threshold, segments[i], expr
        );
    }

    expr
}

/// Build audio trim filter with speed, reverse, freeze frame, and volume keyframe support.
///
/// Generates the complete audio filter chain from input to the audio output label,
/// including atempo for speed, areverse for reverse playback, and volume automation
/// from audio keyframes.
/// Returns the label to use as input for subsequent audio effects.
fn build_audio_trim_filter(
    clip: &Clip,
    input_index: usize,
    audio_trim_label: &str,
    filter_complex: &mut String,
) -> String {
    debug_assert!(
        !clip.freeze_frame,
        "build_audio_trim_filter should not be called for freeze frame clips"
    );

    if clip.has_time_remap() {
        // Time remap: trim the full source range, then apply average speed via atempo
        let remap = clip.time_remap.as_ref().unwrap();
        let (source_start, source_end) = remap.source_range();

        let filter = format!(
            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
            input_index,
            format_speed_number(source_start),
            format_speed_number(source_end),
            audio_trim_label
        );
        filter_complex.push_str(&filter);
        filter_complex.push(';');

        let mut current_label = audio_trim_label.to_string();

        // Compute average speed from the curve: source_duration / timeline_duration
        let source_dur = remap.source_duration();
        let timeline_dur = remap.timeline_duration();
        let avg_speed = if timeline_dur > 0.0 {
            source_dur / timeline_dur
        } else {
            1.0
        };

        if let Some(atempo) = build_atempo_chain(avg_speed) {
            let speed_label = format!("aspd{}", input_index);
            filter_complex.push_str(&format!("[{}]{}[{}];", current_label, atempo, speed_label));
            current_label = speed_label;
        }

        // Apply volume keyframe automation
        current_label = apply_volume_keyframes(clip, input_index, &current_label, filter_complex);

        // Apply audio fades
        let clip_dur = clip.duration().max(0.0);
        current_label =
            apply_audio_fades(clip, input_index, &current_label, filter_complex, clip_dur);

        return current_label;
    }

    // Regular audio trim
    let filter = format!(
        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
        input_index, clip.range.source_in_sec, clip.range.source_out_sec, audio_trim_label
    );
    filter_complex.push_str(&filter);
    filter_complex.push(';');

    let mut current_label = audio_trim_label.to_string();

    // Apply reverse if needed
    if clip.reverse {
        let rev_label = format!("{}rev", audio_trim_label);
        filter_complex.push_str(&format!("[{}]areverse[{}];", current_label, rev_label));
        current_label = rev_label;
    }

    // Apply atempo for speed adjustment
    let speed = clip.safe_speed();
    if let Some(atempo) = build_atempo_chain(speed) {
        let speed_label = format!("aspd{}", input_index);
        filter_complex.push_str(&format!("[{}]{}[{}];", current_label, atempo, speed_label));
        current_label = speed_label;
    }

    // Apply volume keyframe automation
    current_label = apply_volume_keyframes(clip, input_index, &current_label, filter_complex);

    // Apply audio fades
    let clip_dur = clip.duration().max(0.0);
    current_label = apply_audio_fades(clip, input_index, &current_label, filter_complex, clip_dur);

    current_label
}

/// Applies volume keyframe automation as an FFmpeg volume filter if the clip
/// has active volume automation keyframes.
fn apply_volume_keyframes(
    clip: &Clip,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
) -> String {
    use crate::core::timeline::AudioKeyframe;

    if clip.audio.has_volume_automation() {
        if let Some(vol_expr) = AudioKeyframe::to_ffmpeg_volume_expr(&clip.audio.volume_keyframes) {
            let vol_label = format!("avol{}", input_index);
            // Volume filter does not modify PTS — no asetpts needed here.
            filter_complex.push_str(&format!("[{}]{}[{}];", current_label, vol_expr, vol_label));
            return vol_label;
        }
    }
    current_label.to_string()
}

/// Applies audio fade-in and fade-out as FFmpeg afade filters.
fn apply_audio_fades(
    clip: &Clip,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
    clip_duration: f64,
) -> String {
    let fade_in = clip.audio.fade_in_sec;
    let fade_out = clip.audio.fade_out_sec;

    if fade_in <= 0.0 && fade_out <= 0.0 {
        return current_label.to_string();
    }

    let mut label = current_label.to_string();

    if fade_in > 0.0 {
        let fade_type = clip.audio.fade_in_type.to_ffmpeg_type();
        let out_label = format!("afin{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=in:st=0:d={:.4}:curve={}[{}];",
            label, fade_in, fade_type, out_label
        ));
        label = out_label;
    }

    if fade_out > 0.0 {
        let fade_type = clip.audio.fade_out_type.to_ffmpeg_type();
        let start_time = (clip_duration - fade_out).max(0.0);
        let out_label = format!("afout{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=out:st={:.4}:d={:.4}:curve={}[{}];",
            label, start_time, fade_out, fade_type, out_label
        ));
        label = out_label;
    }

    label
}

fn volume_db_to_linear(volume_db: f32) -> f64 {
    if volume_db <= -60.0 {
        0.0
    } else {
        10.0_f64.powf(volume_db as f64 / 20.0)
    }
}

fn apply_audio_mix_settings(
    clip: &Clip,
    track: &Track,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
) -> String {
    let mut current_label = current_label.to_string();

    let clip_linear_gain = if clip.audio.has_volume_automation() {
        1.0
    } else {
        volume_db_to_linear(clip.audio.volume_db.clamp(-60.0, 6.0))
    };
    let track_linear_gain = track.volume.clamp(0.0, 2.0) as f64;
    let combined_gain = clip_linear_gain * track_linear_gain;

    if (combined_gain - 1.0).abs() >= 0.0001 {
        let gain_label = format!("again{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]volume={:.6}[{}];",
            current_label, combined_gain, gain_label
        ));
        current_label = gain_label;
    }

    let pan = clip.audio.pan.clamp(-1.0, 1.0) as f64;
    if pan.abs() >= 0.0001 {
        let pan_label = format!("apan{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]aformat=channel_layouts=stereo,stereotools=balance_in={:.4}:bmode_in=power[{}];",
            current_label, pan, pan_label
        ));
        current_label = pan_label;
    }

    let delay_ms = (clip.place.timeline_in_sec.max(0.0) * 1000.0).round() as u64;
    if delay_ms > 0 {
        let delay_label = format!("adel{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]adelay=delays={}:all=1[{}];",
            current_label, delay_ms, delay_label
        ));
        current_label = delay_label;
    }

    current_label
}

fn append_master_audio_output(
    filter_complex: &mut String,
    audio_streams: &[String],
    master_volume_db: f32,
) -> Option<String> {
    if audio_streams.is_empty() {
        return None;
    }

    const BASE_AUDIO_LABEL: &str = "[outa_base]";
    const FINAL_AUDIO_LABEL: &str = "[outa]";

    filter_complex.push(';');
    if audio_streams.len() == 1 {
        filter_complex.push_str(&format!("{}anull{}", audio_streams[0], BASE_AUDIO_LABEL));
    } else {
        filter_complex.push_str(&audio_streams.join(""));
        filter_complex.push_str(&format!(
            "amix=inputs={}:duration=longest:dropout_transition=0:normalize=0{}",
            audio_streams.len(),
            BASE_AUDIO_LABEL
        ));
    }

    let clamped_master_volume_db = master_volume_db.clamp(-60.0, 6.0);
    if clamped_master_volume_db.abs() < f32::EPSILON {
        return Some(BASE_AUDIO_LABEL.to_string());
    }

    filter_complex.push(';');
    filter_complex.push_str(&format!(
        "{}volume={:.6}{}",
        BASE_AUDIO_LABEL,
        volume_db_to_linear(clamped_master_volume_db),
        FINAL_AUDIO_LABEL
    ));

    Some(FINAL_AUDIO_LABEL.to_string())
}

// =============================================================================
// Text Clip Detection
// =============================================================================

/// Check if a clip is a text clip (virtual asset with __text__ prefix).
///
/// Text clips don't have file-based assets - they generate video from
/// text overlays using FFmpeg's drawtext filter.
pub fn is_text_clip(clip: &Clip) -> bool {
    clip.asset_id.starts_with(TEXT_ASSET_PREFIX)
}

/// Build FFmpeg filter for a text clip.
///
/// Text clips use a color source as input and apply the drawtext filter
/// from the TextOverlay effect to generate the video.
///
/// # Arguments
///
/// * `clip` - The text clip
/// * `effects` - Map of effect ID to Effect (for looking up TextOverlay effect)
/// * `width` - Output video width
/// * `height` - Output video height
///
/// # Returns
///
/// FFmpeg input arguments and filter string for the text clip
fn build_text_clip_filter(
    clip: &Clip,
    effects: &HashMap<String, Effect>,
    width: u32,
    height: u32,
) -> Option<(Vec<String>, String)> {
    // Find the TextOverlay effect
    let text_effect = clip.effects.iter().find_map(|effect_id| {
        effects
            .get(effect_id)
            .filter(|e| e.effect_type == EffectType::TextOverlay && e.enabled)
    })?;

    let mut resolved_text_effect = text_effect.clone();
    apply_text_transform_overrides(&mut resolved_text_effect, clip);

    // Calculate clip duration
    let duration = clip.range.source_out_sec - clip.range.source_in_sec;

    // Build color source input for transparent background
    // Using color=c=black for solid background (can be changed to color=c=black@0.0 for transparent)
    let input_args = vec![
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!("color=c=black:s={}x{}:d={}:r=30", width, height, duration),
    ];

    // Build drawtext filter from text effect parameters
    let drawtext_filter = resolved_text_effect.to_filter_body();

    Some((input_args, drawtext_filter))
}

fn apply_text_transform_overrides(effect: &mut Effect, clip: &Clip) {
    let x = if clip.transform.position.x.is_finite() {
        clip.transform.position.x.clamp(0.0, 1.0)
    } else {
        0.5
    };

    let y = if clip.transform.position.y.is_finite() {
        clip.transform.position.y.clamp(0.0, 1.0)
    } else {
        0.5
    };

    let rotation = if clip.transform.rotation_deg.is_finite() {
        clip.transform.rotation_deg
    } else {
        0.0
    };

    effect.set_param("x", ParamValue::Float(x));
    effect.set_param("y", ParamValue::Float(y));
    effect.set_param("rotation", ParamValue::Float(rotation));

    if let Some(font_size) = effect.get_float("font_size") {
        let raw_scale = (clip.transform.scale.x.abs() + clip.transform.scale.y.abs()) / 2.0;
        let normalized_scale = if raw_scale.is_finite() {
            raw_scale.clamp(0.01, 100.0)
        } else {
            1.0
        };

        let scaled_font_size = (font_size * normalized_scale).clamp(1.0, 500.0);
        effect.set_param("font_size", ParamValue::Float(scaled_font_size));
    }
}

fn get_json_field<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

fn parse_json_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn parse_json_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::String(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn normalize_caption_axis(raw: f64) -> f64 {
    if !raw.is_finite() {
        return 0.0;
    }

    let normalized = if raw.abs() > 1.0 { raw / 100.0 } else { raw };
    normalized.clamp(0.0, 1.0)
}

fn parse_hex_color(raw: &str) -> Option<(String, Option<f64>)> {
    let mut hex = raw.trim().trim_start_matches('#').to_string();
    if hex.is_empty() || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }

    if hex.len() == 3 || hex.len() == 4 {
        hex = hex.chars().flat_map(|ch| [ch, ch]).collect::<String>();
    }

    match hex.len() {
        6 => Some((format!("#{}", hex.to_ascii_uppercase()), None)),
        8 => {
            let rgb = &hex[0..6];
            let alpha_hex = &hex[6..8];
            let alpha_byte = u8::from_str_radix(alpha_hex, 16).ok()?;
            Some((
                format!("#{}", rgb.to_ascii_uppercase()),
                Some((alpha_byte as f64 / 255.0).clamp(0.0, 1.0)),
            ))
        }
        _ => None,
    }
}

fn parse_caption_color(value: &Value) -> Option<(String, Option<f64>)> {
    if let Some(text) = value.as_str() {
        return parse_hex_color(text);
    }

    let object = value.as_object()?;
    let red =
        parse_json_number(get_json_field(object, &["r", "red"])?).map(|v| v.clamp(0.0, 255.0));
    let green =
        parse_json_number(get_json_field(object, &["g", "green"])?).map(|v| v.clamp(0.0, 255.0));
    let blue =
        parse_json_number(get_json_field(object, &["b", "blue"])?).map(|v| v.clamp(0.0, 255.0));

    let (red, green, blue) = (red?, green?, blue?);
    let alpha = get_json_field(object, &["a", "alpha"])
        .and_then(parse_json_number)
        .map(|value| value.clamp(0.0, 255.0) / 255.0);

    Some((
        format!(
            "#{:02X}{:02X}{:02X}",
            red.round() as u8,
            green.round() as u8,
            blue.round() as u8
        ),
        alpha,
    ))
}

fn vertical_position_to_y(vertical: &str, margin_percent: f64) -> f64 {
    let margin = (if margin_percent.is_finite() {
        margin_percent
    } else {
        5.0
    })
    .clamp(0.0, 50.0)
        / 100.0;

    match vertical {
        "top" => margin,
        "center" | "middle" => 0.5,
        _ => 1.0 - margin,
    }
}

fn resolve_caption_anchor(position: Option<&Value>, style: Option<&Value>) -> (f64, f64) {
    let mut x = 0.5;
    let mut y = 0.9;

    if let Some(position_value) = position {
        if let Some(preset) = position_value.as_str() {
            y = vertical_position_to_y(preset, 5.0);
            return (x, y);
        }

        if let Some(position_object) = position_value.as_object() {
            let position_type = get_json_field(position_object, &["type"])
                .and_then(Value::as_str)
                .unwrap_or_default();

            if position_type.eq_ignore_ascii_case("preset") {
                let vertical = get_json_field(position_object, &["vertical"])
                    .and_then(Value::as_str)
                    .unwrap_or("bottom");
                let margin_percent =
                    get_json_field(position_object, &["marginPercent", "margin_percent"])
                        .and_then(parse_json_number)
                        .unwrap_or(5.0);
                return (x, vertical_position_to_y(vertical, margin_percent));
            }

            if let Some(custom_x) = get_json_field(position_object, &["xPercent", "x_percent", "x"])
                .and_then(parse_json_number)
            {
                x = normalize_caption_axis(custom_x);
            }
            if let Some(custom_y) = get_json_field(position_object, &["yPercent", "y_percent", "y"])
                .and_then(parse_json_number)
            {
                y = normalize_caption_axis(custom_y);
            }
        }
    }

    if let Some(style_object) = style.and_then(Value::as_object) {
        if let Some(vertical_align) =
            get_json_field(style_object, &["verticalAlign", "vertical_align"])
                .and_then(Value::as_str)
        {
            let mapped = match vertical_align {
                "top" => Some("top"),
                "middle" | "center" => Some("center"),
                "bottom" => Some("bottom"),
                _ => None,
            };

            if let Some(vertical) = mapped {
                y = vertical_position_to_y(vertical, 10.0);
            }
        }
    }

    (x, y)
}

fn find_transition_effect<'a>(
    clip: &Clip,
    effects: &'a HashMap<String, Effect>,
) -> Option<&'a Effect> {
    clip.effects
        .iter()
        .filter_map(|effect_id| effects.get(effect_id))
        .find(|effect| {
            effect.enabled && effect.effect_type.category() == EffectCategory::Transition
        })
}

fn build_caption_drawtext_with_enable(clip: &Clip) -> Option<String> {
    let text = clip.label.as_deref()?.trim();
    if text.is_empty() {
        return None;
    }

    let mut effect = Effect::new(EffectType::TextOverlay);
    effect.set_param("text", ParamValue::String(text.to_string()));

    let style_object = clip.caption_style.as_ref().and_then(Value::as_object);

    if let Some(style) = style_object {
        if let Some(font_family) = get_json_field(style, &["fontFamily", "font_family"])
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            effect.set_param("font_family", ParamValue::String(font_family.to_string()));
        }

        if let Some(font_size) =
            get_json_field(style, &["fontSize", "font_size"]).and_then(parse_json_number)
        {
            effect.set_param("font_size", ParamValue::Float(font_size.clamp(1.0, 500.0)));
        }

        let mut opacity_from_color: Option<f64> = None;
        if let Some(color_value) = get_json_field(style, &["color"]) {
            if let Some((hex, alpha)) = parse_caption_color(color_value) {
                effect.set_param("color", ParamValue::String(hex));
                opacity_from_color = alpha;
            }
        }

        if let Some(background_value) =
            get_json_field(style, &["backgroundColor", "background_color"])
        {
            if let Some((hex, _)) = parse_caption_color(background_value) {
                effect.set_param("background_color", ParamValue::String(hex));
            }
        }

        if let Some(shadow_value) = get_json_field(style, &["shadowColor", "shadow_color"]) {
            if let Some((hex, _)) = parse_caption_color(shadow_value) {
                effect.set_param("shadow_color", ParamValue::String(hex));
            }
        }

        if let Some(outline_value) = get_json_field(style, &["outlineColor", "outline_color"]) {
            if let Some((hex, _)) = parse_caption_color(outline_value) {
                effect.set_param("outline_color", ParamValue::String(hex));
            }
        }

        if let Some(shadow_offset) =
            get_json_field(style, &["shadowOffset", "shadow_offset"]).and_then(parse_json_number)
        {
            let clamped = shadow_offset.clamp(-500.0, 500.0).round() as i64;
            effect.set_param("shadow_x", ParamValue::Int(clamped));
            effect.set_param("shadow_y", ParamValue::Int(clamped));
        }

        if let Some(outline_width) =
            get_json_field(style, &["outlineWidth", "outline_width"]).and_then(parse_json_number)
        {
            effect.set_param(
                "outline_width",
                ParamValue::Int(outline_width.clamp(0.0, 100.0).round() as i64),
            );
        }

        if let Some(alignment) =
            get_json_field(style, &["alignment", "textAlign", "text_align"]).and_then(Value::as_str)
        {
            let normalized = alignment.to_ascii_lowercase();
            if matches!(normalized.as_str(), "left" | "center" | "right") {
                effect.set_param("alignment", ParamValue::String(normalized));
            }
        }

        if let Some(italic) = get_json_field(style, &["italic"]).and_then(parse_json_bool) {
            effect.set_param("italic", ParamValue::Bool(italic));
        }

        let bold = get_json_field(style, &["bold"])
            .and_then(parse_json_bool)
            .or_else(|| {
                get_json_field(style, &["fontWeight", "font_weight"]).and_then(|value| {
                    if let Some(raw) = value.as_str() {
                        let normalized = raw.to_ascii_lowercase();
                        Some(normalized == "bold" || normalized == "700" || normalized == "800")
                    } else {
                        parse_json_number(value).map(|weight| weight >= 600.0)
                    }
                })
            });
        if let Some(bold) = bold {
            effect.set_param("bold", ParamValue::Bool(bold));
        }

        if let Some(line_height) =
            get_json_field(style, &["lineHeight", "line_height"]).and_then(parse_json_number)
        {
            effect.set_param(
                "line_height",
                ParamValue::Float(line_height.clamp(0.5, 5.0)),
            );
        }

        if let Some(opacity) = get_json_field(style, &["opacity"]).and_then(parse_json_number) {
            effect.set_param("opacity", ParamValue::Float(opacity.clamp(0.0, 1.0)));
        } else if let Some(opacity) = opacity_from_color {
            effect.set_param("opacity", ParamValue::Float(opacity.clamp(0.0, 1.0)));
        }
    }

    let (x, y) =
        resolve_caption_anchor(clip.caption_position.as_ref(), clip.caption_style.as_ref());
    effect.set_param("x", ParamValue::Float(x));
    effect.set_param("y", ParamValue::Float(y));

    let start = clip.place.timeline_in_sec;
    let end = clip.place.timeline_out_sec();
    if !start.is_finite() || !end.is_finite() || end <= start {
        return None;
    }

    let filter_body = effect.to_filter_body();
    Some(format!(
        "{}:enable='between(t,{:.6},{:.6})'",
        filter_body,
        start.max(0.0),
        end.max(0.0)
    ))
}

fn collect_enabled_clips_sorted(sequence: &Sequence) -> Vec<(&Clip, &Track)> {
    let mut all_clips: Vec<(&Clip, &Track)> = Vec::new();

    for track in &sequence.tracks {
        if !track_included_in_export(track) {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            all_clips.push((clip, track));
        }
    }

    all_clips.sort_by(|a, b| {
        a.0.place
            .timeline_in_sec
            .partial_cmp(&b.0.place.timeline_in_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    all_clips
}

/// Builds drawtext filter strings for all caption clips in the input.
///
/// The caller is expected to pass only enabled clips (e.g. from
/// [`collect_enabled_clips_sorted`]), so no additional `clip.enabled`
/// check is performed here.
fn collect_caption_drawtext_filters(all_clips: &[(&Clip, &Track)]) -> Vec<String> {
    all_clips
        .iter()
        .filter_map(|(clip, track)| {
            if track.kind == TrackKind::Caption {
                build_caption_drawtext_with_enable(clip)
            } else {
                None
            }
        })
        .collect()
}

fn append_caption_overlays(
    filter_complex: &mut String,
    base_video_label: &str,
    caption_filters: &[String],
) -> String {
    let mut current_video_label = base_video_label.to_string();

    for (index, filter) in caption_filters.iter().enumerate() {
        let next_video_label = format!("[capv{}]", index);
        filter_complex.push(';');
        filter_complex.push_str(&format!(
            "{}{}{}",
            current_video_label, filter, next_video_label
        ));
        current_video_label = next_video_label;
    }

    current_video_label
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
            if matches!(track.kind, TrackKind::Caption | TrackKind::Overlay) {
                continue;
            }

            for clip in &track.clips {
                if !clip.enabled {
                    continue;
                }

                if is_text_clip(clip) {
                    continue;
                }

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
        let video_codec = settings.video_encoder_name();

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
            video_codec.clone(),
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

        // Quality settings (CRF for software, CQ/QP for hardware encoders)
        if let Some(crf) = settings.crf {
            if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
                args.extend(super::hardware::resolve_quality_args(&video_codec, crf));
            }
        }

        // HDR metadata
        args.extend(settings.hdr_args());

        // Frame rate
        if let Some(fps) = settings.fps {
            args.push("-r".to_string());
            args.push(fps.to_string());
        }

        append_output_time_range_args(&mut args, settings.start_time, settings.end_time);

        // Overwrite output
        args.push("-y".to_string());

        // Output
        args.push(settings.output_path.to_string_lossy().to_string());

        args
    }

    /// Build FilterGraph for a clip's effects
    ///
    /// If effects have keyframes, they are resolved at the midpoint of the clip
    /// duration since FFmpeg filters cannot animate parameters directly.
    fn build_clip_filter_graph(
        &self,
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
    ) -> FilterGraph {
        use crate::core::effects::EffectType;

        let mut graph = FilterGraph::new();

        // Calculate midpoint of clip for keyframe interpolation
        // FFmpeg filters use static values, so we use the midpoint as representative
        let clip_duration = clip.range.source_out_sec - clip.range.source_in_sec;
        let midpoint_time = clip_duration / 2.0;

        // When volume automation keyframes are active, skip Volume effects
        // to prevent double-application (keyframe filter + effect filter).
        let skip_volume_effects = clip.audio.has_volume_automation();

        // Look up each effect ID and add to graph
        for effect_id in &clip.effects {
            if let Some(effect) = effects.get(effect_id) {
                if skip_volume_effects && effect.effect_type == EffectType::Volume && effect.enabled
                {
                    continue;
                }

                // If effect has keyframes, resolve them at midpoint
                let resolved_effect = if effect.has_keyframes() {
                    effect.with_params_at_time(midpoint_time)
                } else {
                    effect.clone()
                };
                graph.add_effect(resolved_effect);
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
        let mut video_transitions: Vec<Option<&Effect>> = Vec::new();
        let audio_companion_keys = collect_audio_companion_keys(sequence, assets, audio_info);

        // Collect enabled clips sorted by timeline position.
        let all_clips = collect_enabled_clips_sorted(sequence);

        if all_clips.is_empty() {
            return Err(ExportError::NoClips);
        }

        let caption_filters = collect_caption_drawtext_filters(&all_clips);

        // Get output dimensions from settings or use defaults
        let output_width = settings.width.unwrap_or(1920);
        let output_height = settings.height.unwrap_or(1080);

        // Collect adjustment layer effects for post-processing.
        // These are applied to the composited output after the main concat,
        // time-scoped to the adjustment layer's timeline range.
        let mut adjustment_layer_effects: Vec<(FilterGraph, f64, f64)> = Vec::new();
        for (clip, _track) in &all_clips {
            if clip.is_adjustment_layer() && !clip.effects.is_empty() {
                let graph = self.build_clip_filter_graph(clip, effects);
                if graph.has_video_effects() {
                    let start = clip.place.timeline_in_sec;
                    let end = clip.place.timeline_out_sec();
                    adjustment_layer_effects.push((graph, start, end));
                }
            }
        }

        // Add inputs and build filter graph
        for (clip, track) in &all_clips {
            if matches!(track.kind, TrackKind::Caption | TrackKind::Overlay) {
                // Caption/overlay tracks are not rendered by the current export pipeline.
                // Skip them so virtual caption clips are not treated as file inputs.
                continue;
            }

            // Adjustment layers have no source media — their effects are applied as post-processing.
            if clip.is_adjustment_layer() {
                continue;
            }

            // Check if this is a text clip (virtual asset with __text__ prefix)
            if is_text_clip(clip) {
                // Text clips use a color source input with drawtext filter
                if let Some((input_args, drawtext_filter)) =
                    build_text_clip_filter(clip, effects, output_width, output_height)
                {
                    // Add color source input
                    args.extend(input_args);

                    let video_out_label = format!("v{}", input_index);

                    // Apply drawtext filter directly to color source
                    let text_filter = format!(
                        "[{}:v]{}[{}]",
                        input_index, drawtext_filter, video_out_label
                    );
                    filter_complex.push_str(&text_filter);
                    filter_complex.push(';');

                    video_streams.push(format!("[{}]", video_out_label));
                    video_transitions.push(find_transition_effect(clip, effects));

                    // Text clips have no audio
                    input_index += 1;
                    continue;
                } else {
                    return Err(ExportError::InvalidSettings(format!(
                        "Text clip '{}' is missing an enabled TextOverlay effect",
                        clip.id
                    )));
                }
            }

            // Regular clip - look up the asset
            let asset = assets.get(&clip.asset_id).ok_or_else(|| {
                ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
            })?;

            // Validate asset URI before passing to FFmpeg
            let validated_path = validate_local_input_path(&asset.uri, "Asset file")
                .map_err(ExportError::InvalidSettings)?;

            // Check if this asset has audio
            let clip_has_audio =
                asset_has_playable_audio(asset, &track.kind, audio_info.get(&clip.asset_id))
                    && !clip_audio_is_suppressed_by_companion(
                        clip,
                        track,
                        asset,
                        &audio_companion_keys,
                    );

            // Add input (using validated path)
            args.push("-i".to_string());
            args.push(validated_path.to_string_lossy().to_string());

            // Build FilterGraph for this clip's effects
            let clip_filter_graph = self.build_clip_filter_graph(clip, effects);

            // Build tonemapping filter if needed (HDR source → SDR output)
            let source_hdr_metadata = hdr_metadata_for_asset(asset);
            let tonemap_filter = settings.build_tonemap_video_filter(&source_hdr_metadata);

            // Build filters based on track type
            match track.kind {
                TrackKind::Video => {
                    // Video processing: trim → [reverse] → [speed] → effects → [tonemap] → output
                    let trim_label = format!("trim{}", input_index);
                    let video_out_label = format!("v{}", input_index);

                    let effects_out_label = if tonemap_filter.is_some() {
                        format!("vfx{}", input_index)
                    } else {
                        video_out_label.clone()
                    };

                    // Step 1: Video trim with speed/reverse/freeze support
                    build_video_trim_filter(clip, input_index, &trim_label, &mut filter_complex);

                    // Step 2: Apply video effects if any
                    if clip_filter_graph.has_video_effects() {
                        let effects_filter = clip_filter_graph
                            .to_video_filter_complex(&trim_label, &effects_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex
                            .push_str(&format!("[{}]null[{}];", trim_label, effects_out_label));
                    }

                    // Step 3: Apply tonemapping if needed (HDR → SDR)
                    if let Some(ref tm_filter) = tonemap_filter {
                        filter_complex.push_str(&format!(
                            "[{}]{}[{}];",
                            effects_out_label, tm_filter, video_out_label
                        ));
                    }

                    video_streams.push(format!("[{}]", video_out_label));
                    video_transitions.push(find_transition_effect(clip, effects));

                    // Audio processing: ONLY if this asset has audio
                    // Freeze frame clips have muted audio, so skip
                    if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                        let audio_trim_label = format!("atrim{}", input_index);
                        let audio_out_label = format!("a{}", input_index);

                        let audio_effects_input = build_audio_trim_filter(
                            clip,
                            input_index,
                            &audio_trim_label,
                            &mut filter_complex,
                        );

                        if clip_filter_graph.has_audio_effects() {
                            let effects_filter = clip_filter_graph
                                .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                            filter_complex.push_str(&effects_filter);
                            filter_complex.push(';');
                        } else {
                            filter_complex.push_str(&format!(
                                "[{}]anull[{}];",
                                audio_effects_input, audio_out_label
                            ));
                        }

                        let mixed_audio_label = apply_audio_mix_settings(
                            clip,
                            track,
                            input_index,
                            &audio_out_label,
                            &mut filter_complex,
                        );

                        audio_streams.push(format!("[{}]", mixed_audio_label));
                    }
                }
                TrackKind::Audio => {
                    // Audio-only track processing
                    if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                        let audio_trim_label = format!("atrim{}", input_index);
                        let audio_out_label = format!("a{}", input_index);

                        let audio_effects_input = build_audio_trim_filter(
                            clip,
                            input_index,
                            &audio_trim_label,
                            &mut filter_complex,
                        );

                        if clip_filter_graph.has_audio_effects() {
                            let effects_filter = clip_filter_graph
                                .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                            filter_complex.push_str(&effects_filter);
                            filter_complex.push(';');
                        } else {
                            filter_complex.push_str(&format!(
                                "[{}]anull[{}];",
                                audio_effects_input, audio_out_label
                            ));
                        }

                        let mixed_audio_label = apply_audio_mix_settings(
                            clip,
                            track,
                            input_index,
                            &audio_out_label,
                            &mut filter_complex,
                        );

                        audio_streams.push(format!("[{}]", mixed_audio_label));
                    }
                }
                _ => {
                    // Skip non-video/audio tracks (caption, overlay)
                }
            }

            input_index += 1;
        }

        if video_streams.is_empty() {
            return Err(ExportError::InvalidSettings(
                "Sequence has no visual clips to export".to_string(),
            ));
        }

        // Remove trailing semicolon if present
        if filter_complex.ends_with(';') {
            filter_complex.pop();
        }
        filter_complex.push(';');

        // Concat video streams with optional xfade transitions
        if video_streams.len() == 1 {
            // Single clip - just use the processed stream
            filter_complex.push_str(&format!("{}null[outv]", video_streams[0]));
        } else {
            // Multiple clips - check for transitions and apply xfade where needed
            let mut current_stream = video_streams[0].clone();

            for i in 0..video_streams.len() - 1 {
                let next_stream = &video_streams[i + 1];
                let output_label = if i == video_streams.len() - 2 {
                    "[outv]".to_string()
                } else {
                    format!("[xfade{}]", i)
                };

                // Check if current clip has a transition effect (applies to transition INTO next clip)
                if let Some(transition_effect) = video_transitions.get(i).and_then(|t| *t) {
                    // Build xfade filter using the transition effect parameters
                    let xfade_filter = transition_effect.to_filter_body();

                    // Apply xfade: [current][next]xfade=...[output]
                    filter_complex.push_str(&format!(
                        "{}{}{}{}",
                        current_stream, next_stream, xfade_filter, output_label
                    ));
                } else {
                    // No transition - use concat for these two clips
                    filter_complex.push_str(&format!(
                        "{}{}concat=n=2:v=1:a=0{}",
                        current_stream, next_stream, output_label
                    ));
                }

                if i < video_streams.len() - 2 {
                    filter_complex.push(';');
                    current_stream = output_label;
                }
            }
        }

        // Apply adjustment layer effects as post-processing on the composited output.
        // Each adjustment layer's effects are time-scoped to the layer's clip range
        // using FFmpeg's enable='between(t,start,end)' clause.
        let mut adj_video_label = "outv".to_string();
        for (i, (graph, start, end)) in adjustment_layer_effects.iter().enumerate() {
            let out_label = format!("adj{}", i);
            let adj_filter =
                graph.to_video_filter_complex_timed(&adj_video_label, &out_label, *start, *end);
            filter_complex.push(';');
            filter_complex.push_str(&adj_filter);
            adj_video_label = out_label;
        }

        // Rename the final adjustment output back to [outv] if we applied any
        if !adjustment_layer_effects.is_empty() {
            filter_complex.push(';');
            filter_complex.push_str(&format!("[{}]null[outv]", adj_video_label));
        }

        let final_video_label =
            append_caption_overlays(&mut filter_complex, "[outv]", &caption_filters);

        let final_audio_label = append_master_audio_output(
            &mut filter_complex,
            &audio_streams,
            sequence.master_volume_db,
        );

        // Add filter complex
        args.push("-filter_complex".to_string());
        args.push(filter_complex);

        // Map outputs
        args.push("-map".to_string());
        args.push(final_video_label);

        // Map audio output ONLY if we have audio streams
        if let Some(final_audio_label) = final_audio_label.as_deref() {
            args.push("-map".to_string());
            args.push(final_audio_label.to_string());
        }

        // Video codec (resolved: may use GPU encoder)
        let video_encoder = settings.video_encoder_name();
        args.push("-c:v".to_string());
        args.push(video_encoder.clone());

        // Audio codec ONLY if we have audio
        if final_audio_label.is_some() {
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
            if final_audio_label.is_some() {
                args.push("-b:a".to_string());
                args.push(bitrate.clone());
            }
        }

        // Quality args (CRF for software, CQ/QP for hardware encoders)
        if let Some(crf) = settings.crf {
            if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
                args.extend(super::hardware::resolve_quality_args(&video_encoder, crf));
            }
        }

        // HDR metadata (color primaries, transfer, colorspace, x265 params)
        args.extend(settings.hdr_args());

        append_output_time_range_args(&mut args, settings.start_time, settings.end_time);

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
            None,
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
    /// * `cancel_rx` - Optional oneshot receiver to cancel the export mid-encode
    pub async fn export_sequence_with_effects(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        settings: &ExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
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

        // Calculate total duration from enabled clips only so progress/ETA
        // are accurate when trailing clips are disabled.
        let total_duration =
            effective_export_duration(sequence, settings.start_time, settings.end_time);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (total_duration * fps) as u64;

        // Add progress output to stdout for real-time tracking.
        insert_output_option_args(&mut args, ["-progress".to_string(), "pipe:1".to_string()])?;

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

        // Wait for FFmpeg to complete, or cancel if requested
        let status = if let Some(cancel_rx) = cancel_rx {
            tokio::select! {
                result = child.wait() => {
                    result.map_err(|e| ExportError::FFmpegFailed(
                        format!("Failed to wait for FFmpeg: {}", e),
                    ))?
                }
                _ = cancel_rx => {
                    // Cancel signal received — kill the FFmpeg child process
                    let _ = child.kill().await;
                    // Clean up partial output file
                    let _ = tokio::fs::remove_file(&settings.output_path).await;
                    return Err(ExportError::Cancelled);
                }
            }
        } else {
            child.wait().await.map_err(|e| {
                ExportError::FFmpegFailed(format!("Failed to wait for FFmpeg: {}", e))
            })?
        };

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

    /// Export a single frame from a sequence at the given timestamp.
    ///
    /// Finds the topmost visible clip at `time_sec`, resolves its source asset,
    /// and extracts the corresponding frame via FFmpeg. The exported image
    /// respects the clip's source offset so the correct frame is captured.
    ///
    /// # Arguments
    ///
    /// * `sequence` - The sequence containing clips
    /// * `assets` - Map of asset ID to Asset
    /// * `settings` - Frame export settings (time, format, output path)
    pub async fn export_frame(
        &self,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        settings: &FrameExportSettings,
    ) -> Result<FrameExportResult, ExportError> {
        settings.validate()?;

        // Find the topmost visible video clip at the requested time
        let (clip, asset) = self
            .find_topmost_clip_at_time(sequence, assets, settings.time_sec)
            .ok_or_else(|| {
                ExportError::InvalidSettings(format!(
                    "No visible clip found at time {:.3}s",
                    settings.time_sec
                ))
            })?;

        // Calculate the source time within the asset, accounting for
        // the clip's timeline position and source offset.
        let clip_relative_time = settings.time_sec - clip.place.timeline_in_sec;
        let speed = clip.speed as f64;
        let source_time = clip.range.source_in_sec + (clip_relative_time * speed);

        // Resolve asset path
        let asset_path = Path::new(&asset.uri);
        if !asset_path.exists() {
            return Err(ExportError::InvalidSettings(format!(
                "Asset file not found: {}",
                asset.uri
            )));
        }

        // Build FFmpeg args for single-frame extraction
        let quality = settings.quality.unwrap_or(2);
        let time_str = format!("{:.3}", source_time);
        let output_str = settings.output_path.to_string_lossy().to_string();
        let input_str = asset_path.to_string_lossy().to_string();

        let mut args = vec![
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-nostdin".to_string(),
            "-ss".to_string(),
            time_str,
            "-i".to_string(),
            input_str,
            "-frames:v".to_string(),
            "1".to_string(),
        ];

        // Format-specific arguments
        match settings.format {
            ImageFormat::Png => {
                args.extend([
                    "-c:v".to_string(),
                    "png".to_string(),
                    "-pix_fmt".to_string(),
                    "rgba".to_string(),
                ]);
            }
            ImageFormat::Jpeg => {
                args.extend([
                    "-c:v".to_string(),
                    "mjpeg".to_string(),
                    "-q:v".to_string(),
                    quality.to_string(),
                ]);
            }
            ImageFormat::Tiff => {
                args.extend([
                    "-c:v".to_string(),
                    "tiff".to_string(),
                    "-pix_fmt".to_string(),
                    "rgb48le".to_string(),
                ]);
            }
        }

        args.extend(["-y".to_string(), output_str]);

        // Create output directory if needed
        if let Some(parent) = settings.output_path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }

        // Run FFmpeg
        let ffmpeg_path = &self.ffmpeg.info().ffmpeg_path;
        let mut cmd = tokio::process::Command::new(ffmpeg_path);
        configure_tokio_command(&mut cmd);
        let output = cmd
            .args(&args)
            .output()
            .await
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ExportError::FFmpegFailed(format!(
                "Frame export failed: {}",
                stderr
            )));
        }

        // Read output file metadata
        let metadata = tokio::fs::metadata(&settings.output_path).await?;
        let file_size = metadata.len();

        // The frame is extracted at the source asset's native resolution.
        // Use asset video dimensions if available, otherwise fall back to sequence canvas.
        let (width, height) = if let Some(ref video) = asset.video {
            (video.width, video.height)
        } else {
            (sequence.format.canvas.width, sequence.format.canvas.height)
        };

        Ok(FrameExportResult {
            output_path: settings.output_path.clone(),
            file_size,
            format: settings.format.clone(),
            width,
            height,
        })
    }

    /// Export audio only from a sequence (no video).
    ///
    /// Renders all audio tracks in the sequence to a single audio file,
    /// mixed down to stereo. Uses the existing complex filter graph for
    /// audio composition but strips all video processing.
    ///
    /// # Arguments
    ///
    /// * `sequence` - The sequence containing clips
    /// * `assets` - Map of asset ID to Asset
    /// * `effects` - Map of effect ID to Effect
    /// * `settings` - Audio export settings (format, output path, bitrate, etc.)
    /// * `progress_tx` - Optional channel for progress updates
    /// * `cancel_rx` - Optional oneshot receiver to cancel the export
    pub async fn export_audio_only(
        &self,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        settings: &AudioExportSettings,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<AudioExportResult, ExportError> {
        use std::process::Stdio;
        use tokio::io::{AsyncBufReadExt, BufReader};

        settings.validate()?;

        // Verify at least one clip has audio
        let audio_info = self.probe_assets_for_audio(sequence, assets).await;
        let has_any_audio = sequence_has_exportable_audio(sequence, assets, &audio_info);

        if !has_any_audio {
            return Err(ExportError::InvalidSettings(
                "No audio tracks found in sequence".to_string(),
            ));
        }

        let start_time = std::time::Instant::now();

        // Convert to video export settings, then build args using existing pipeline
        let export_settings = settings.to_export_settings();

        let mut args = self.build_complex_filter_args_with_audio_info(
            sequence,
            assets,
            effects,
            &audio_info,
            &export_settings,
        )?;

        // Replace video-related args: strip video, keep audio only
        // Remove any -c:v, -pix_fmt, -b:v, -crf, -r arguments
        let stripped_output_args = ["-c:v", "-pix_fmt", "-b:v", "-crf", "-r", "-c:a", "-b:a"];
        let mut i = 0;
        while i < args.len() {
            if stripped_output_args.iter().any(|prefix| args[i] == *prefix) {
                args.remove(i); // Remove the flag
                if i < args.len() {
                    args.remove(i); // Remove the value
                }
            } else {
                i += 1;
            }
        }

        let mut output_options = vec![
            "-vn".to_string(),
            "-c:a".to_string(),
            settings.format.codec().to_string(),
        ];

        if let Some(ref bitrate) = settings.bitrate {
            output_options.push("-b:a".to_string());
            output_options.push(bitrate.clone());
        } else if let Some(default_br) = settings.format.default_bitrate() {
            output_options.push("-b:a".to_string());
            output_options.push(default_br.to_string());
        }

        if let Some(sr) = settings.sample_rate {
            output_options.push("-ar".to_string());
            output_options.push(sr.to_string());
        }

        output_options.push("-progress".to_string());
        output_options.push("pipe:1".to_string());
        insert_output_option_args(&mut args, output_options)?;

        // Create output directory if needed
        if let Some(parent) = settings.output_path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }

        // Calculate total duration for progress
        let duration = effective_export_duration(sequence, settings.start_time, settings.end_time);
        let total_frames = (duration * sequence.format.fps.as_f64()).ceil() as u64;

        // Run FFmpeg with progress tracking
        let ffmpeg_path = &self.ffmpeg.info().ffmpeg_path;
        let mut cmd = tokio::process::Command::new(ffmpeg_path);
        configure_tokio_command(&mut cmd);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| ExportError::FFmpegFailed(format!("Failed to spawn FFmpeg: {}", e)))?;

        let stdout = child.stdout.take();
        let stderr_handle = child.stderr.take();

        // Progress tracking task
        let progress_handle = if let (Some(stdout), Some(tx)) = (stdout, progress_tx) {
            Some(tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                let mut progress_data = FFmpegProgressData::default();

                while let Ok(Some(line)) = lines.next_line().await {
                    if parse_ffmpeg_progress_line(&line, &mut progress_data) {
                        let progress =
                            calculate_export_progress(&progress_data, duration, total_frames);
                        let _ = tx.send(progress).await;
                    }
                }
            }))
        } else {
            None
        };

        // Wait for completion or cancellation
        let result = if let Some(cancel_rx) = cancel_rx {
            tokio::select! {
                status = child.wait() => {
                    status.map_err(|e| ExportError::FFmpegFailed(e.to_string()))
                }
                _ = cancel_rx => {
                    let _ = child.kill().await;
                    let _ = tokio::fs::remove_file(&settings.output_path).await;
                    return Err(ExportError::Cancelled);
                }
            }
        } else {
            child
                .wait()
                .await
                .map_err(|e| ExportError::FFmpegFailed(e.to_string()))
        };

        if let Some(handle) = progress_handle {
            let _ = handle.await;
        }

        let status = result?;
        if !status.success() {
            let stderr_content = if let Some(stderr) = stderr_handle {
                let mut buf = String::new();
                let mut reader = BufReader::new(stderr);
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut buf).await;
                buf
            } else {
                String::new()
            };
            return Err(ExportError::FFmpegFailed(format!(
                "Audio export failed: {}",
                stderr_content
            )));
        }

        let metadata = tokio::fs::metadata(&settings.output_path).await?;
        let file_size = metadata.len();

        Ok(AudioExportResult {
            output_path: settings.output_path.clone(),
            duration_sec: duration,
            file_size,
            format: settings.format.clone(),
            encoding_time_sec: start_time.elapsed().as_secs_f64(),
        })
    }

    /// Find the topmost visible video clip at a given time position.
    ///
    /// Iterates video tracks from top to bottom (highest index first) and
    /// returns the first enabled clip that covers the requested time.
    fn find_topmost_clip_at_time<'a>(
        &self,
        sequence: &'a Sequence,
        assets: &'a HashMap<String, Asset>,
        time_sec: f64,
    ) -> Option<(&'a Clip, &'a Asset)> {
        // Lower track indices render above higher indices in preview/export.
        for track in &sequence.tracks {
            if !track.is_video() || !track_included_in_export(track) {
                continue;
            }

            for clip in &track.clips {
                if !clip.enabled {
                    continue;
                }

                // Skip text clips — they have no file-backed asset
                if is_text_clip(clip) {
                    continue;
                }

                // Skip adjustment layers
                if clip.is_adjustment_layer() {
                    continue;
                }

                if clip.place.contains(time_sec) {
                    if let Some(asset) = assets.get(&clip.asset_id) {
                        return Some((clip, asset));
                    }
                }
            }
        }

        None
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
    effects: &std::collections::HashMap<String, Effect>,
    _settings: &ExportSettings,
) -> ExportValidation {
    let mut validation = ExportValidation::valid();

    // Check for empty sequence after applying clip-enabled state.
    let total_clips: usize = sequence
        .tracks
        .iter()
        .filter(|track| track_included_in_export(track))
        .map(|track| track.clips.iter().filter(|clip| clip.enabled).count())
        .sum();
    if total_clips == 0 {
        validation.add_error("Sequence has no clips to export");
        return validation;
    }

    let has_enabled_overlay_clips = sequence.tracks.iter().any(|track| {
        track.kind == TrackKind::Overlay
            && track_included_in_export(track)
            && track.clips.iter().any(|clip| clip.enabled)
    });
    if has_enabled_overlay_clips {
        validation.add_error("Overlay tracks are not supported in final render export yet");
    }

    let visual_clip_count: usize = sequence
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Video && track_included_in_export(track))
        .map(|track| {
            track
                .clips
                .iter()
                .filter(|clip| clip.enabled && !clip.is_adjustment_layer())
                .count()
        })
        .sum();
    if visual_clip_count == 0 {
        if !has_enabled_overlay_clips {
            validation.add_error("Sequence has no visual clips to export");
        }
        return validation;
    }

    // Check all clip assets exist (except virtual text clips) and are safe to read.
    for track in &sequence.tracks {
        if !track_included_in_export(track) {
            continue;
        }

        if matches!(track.kind, TrackKind::Caption | TrackKind::Overlay) {
            // Caption/overlay tracks are currently excluded from final render composition.
            // Skip file-based asset validation for these tracks.
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            if track.kind == TrackKind::Video && uses_non_normal_blend_mode(clip, track) {
                validation.add_error(format!(
                    "Blend mode export is not supported yet for clip '{}' on track '{}'",
                    clip.id, track.name
                ));
            }

            if track.kind == TrackKind::Video && clip_uses_unsupported_visual_composition(clip) {
                validation.add_error(format!(
                    "Clip '{}' uses transform or opacity settings that final render export does not support yet",
                    clip.id
                ));
            }

            if is_text_clip(clip) {
                // Ensure the clip has an enabled TextOverlay effect so rendering is deterministic.
                let has_text_overlay = clip.effects.iter().any(|effect_id| {
                    effects
                        .get(effect_id)
                        .is_some_and(|e| e.effect_type == EffectType::TextOverlay && e.enabled)
                });
                if !has_text_overlay {
                    validation.add_error(format!(
                        "Text clip '{}' is missing an enabled TextOverlay effect",
                        clip.id
                    ));
                }
                continue;
            }

            // Adjustment layers have no source media — skip file validation
            if clip.is_adjustment_layer() {
                continue;
            }

            let Some(asset) = assets.get(&clip.asset_id) else {
                validation.add_error(format!(
                    "Asset '{}' not found for clip '{}'",
                    clip.asset_id, clip.id
                ));
                continue;
            };

            // Defense-in-depth: validate local file path early to avoid starting an export
            // that will certainly fail (or could be abused if the state is compromised).
            if let Err(err) = validate_local_input_path(&asset.uri, "Asset file") {
                validation.add_error(format!(
                    "Invalid asset path for asset '{}': {}",
                    asset.id, err
                ));
            }
        }
    }

    // Check for timeline gaps (warning, not error)
    let gaps = detect_timeline_gaps(sequence);
    if !gaps.is_empty() {
        validation.add_warning(format!(
            "Timeline has {} gap(s). Final render does not preserve gaps yet; insert filler clips before export.",
            gaps.len()
        ));
    }

    if has_layered_visual_overlap(sequence) {
        validation.add_error(
            "Final render export does not support simultaneous layered video clips yet".to_string(),
        );
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
    let audio_companion_keys = collect_audio_companion_keys(sequence, assets, audio_info);

    // Collect enabled clips sorted by timeline position.
    let all_clips = collect_enabled_clips_sorted(sequence);

    if all_clips.is_empty() {
        return Err(ExportError::NoClips);
    }

    let caption_filters = collect_caption_drawtext_filters(&all_clips);

    // Build FilterGraph helper (inline version without engine)
    // If effects have keyframes, they are resolved at the midpoint of the clip
    fn build_clip_filter_graph_standalone(
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
    ) -> FilterGraph {
        let mut graph = FilterGraph::new();

        // Calculate midpoint for keyframe interpolation
        let clip_duration = clip.range.source_out_sec - clip.range.source_in_sec;
        let midpoint_time = clip_duration / 2.0;

        // When volume automation keyframes are active, skip Volume effects
        // to prevent double-application (keyframe filter + effect filter).
        let skip_volume_effects = clip.audio.has_volume_automation();

        for effect_id in &clip.effects {
            if let Some(effect) = effects.get(effect_id) {
                if skip_volume_effects && effect.effect_type == EffectType::Volume && effect.enabled
                {
                    continue;
                }

                // If effect has keyframes, resolve them at midpoint
                let resolved_effect = if effect.has_keyframes() {
                    effect.with_params_at_time(midpoint_time)
                } else {
                    effect.clone()
                };
                graph.add_effect(resolved_effect);
            }
        }
        graph.sort_by_order();
        graph
    }

    // Get output dimensions from settings or use defaults
    let output_width = settings.width.unwrap_or(1920);
    let output_height = settings.height.unwrap_or(1080);

    // Collect adjustment layer effects for post-processing, time-scoped to clip range
    let mut adjustment_layer_effects: Vec<(FilterGraph, f64, f64)> = Vec::new();
    for (clip, _track) in &all_clips {
        if clip.is_adjustment_layer() && !clip.effects.is_empty() {
            let graph = build_clip_filter_graph_standalone(clip, effects);
            if graph.has_video_effects() {
                let start = clip.place.timeline_in_sec;
                let end = clip.place.timeline_out_sec();
                adjustment_layer_effects.push((graph, start, end));
            }
        }
    }

    // Add inputs and build filter graph
    for (clip, track) in &all_clips {
        if matches!(track.kind, TrackKind::Caption | TrackKind::Overlay) {
            // Caption/overlay tracks are not rendered by the current export pipeline.
            // Skip them so virtual caption clips are not treated as file inputs.
            continue;
        }

        // Adjustment layers have no source media — their effects are applied as post-processing.
        if clip.is_adjustment_layer() {
            continue;
        }

        // Check if this is a text clip (virtual asset with __text__ prefix)
        if is_text_clip(clip) {
            // Text clips use a color source input with drawtext filter
            if let Some((input_args, drawtext_filter)) =
                build_text_clip_filter(clip, effects, output_width, output_height)
            {
                // Add color source input
                args.extend(input_args);

                let video_out_label = format!("v{}", input_index);

                // Apply drawtext filter directly to color source
                let text_filter = format!(
                    "[{}:v]{}[{}]",
                    input_index, drawtext_filter, video_out_label
                );
                filter_complex.push_str(&text_filter);
                filter_complex.push(';');

                video_streams.push(format!("[{}]", video_out_label));

                // Text clips have no audio
                input_index += 1;
                continue;
            } else {
                return Err(ExportError::InvalidSettings(format!(
                    "Text clip '{}' is missing an enabled TextOverlay effect",
                    clip.id
                )));
            }
        }

        // Regular clip - look up the asset
        let asset = assets.get(&clip.asset_id).ok_or_else(|| {
            ExportError::InvalidSettings(format!("Asset not found: {}", clip.asset_id))
        })?;

        // Check if this asset has audio
        let clip_has_audio =
            asset_has_playable_audio(asset, &track.kind, audio_info.get(&clip.asset_id))
                && !clip_audio_is_suppressed_by_companion(
                    clip,
                    track,
                    asset,
                    &audio_companion_keys,
                );

        // Validate asset URI before passing to FFmpeg
        let validated_path = validate_local_input_path(&asset.uri, "Asset file")
            .map_err(ExportError::InvalidSettings)?;

        // Add input (using validated path)
        args.push("-i".to_string());
        args.push(validated_path.to_string_lossy().to_string());

        // Build FilterGraph for this clip's effects
        let clip_filter_graph = build_clip_filter_graph_standalone(clip, effects);
        let source_hdr_metadata = hdr_metadata_for_asset(asset);
        let tonemap_filter = settings.build_tonemap_video_filter(&source_hdr_metadata);

        // Build filters based on track type
        match track.kind {
            TrackKind::Video => {
                let trim_label = format!("trim{}", input_index);
                let video_out_label = format!("v{}", input_index);
                let effects_out_label = if tonemap_filter.is_some() {
                    format!("vfx{}", input_index)
                } else {
                    video_out_label.clone()
                };

                build_video_trim_filter(clip, input_index, &trim_label, &mut filter_complex);

                if clip_filter_graph.has_video_effects() {
                    let effects_filter =
                        clip_filter_graph.to_video_filter_complex(&trim_label, &effects_out_label);
                    filter_complex.push_str(&effects_filter);
                    filter_complex.push(';');
                } else {
                    filter_complex
                        .push_str(&format!("[{}]null[{}];", trim_label, effects_out_label));
                }

                if let Some(ref tm_filter) = tonemap_filter {
                    filter_complex.push_str(&format!(
                        "[{}]{}[{}];",
                        effects_out_label, tm_filter, video_out_label
                    ));
                }

                video_streams.push(format!("[{}]", video_out_label));

                if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_effects_input = build_audio_trim_filter(
                        clip,
                        input_index,
                        &audio_trim_label,
                        &mut filter_complex,
                    );

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_effects_input, audio_out_label
                        ));
                    }

                    let mixed_audio_label = apply_audio_mix_settings(
                        clip,
                        track,
                        input_index,
                        &audio_out_label,
                        &mut filter_complex,
                    );

                    audio_streams.push(format!("[{}]", mixed_audio_label));
                }
            }
            TrackKind::Audio => {
                if clip_has_audio && !clip.freeze_frame && !clip.audio.muted {
                    let audio_trim_label = format!("atrim{}", input_index);
                    let audio_out_label = format!("a{}", input_index);

                    let audio_effects_input = build_audio_trim_filter(
                        clip,
                        input_index,
                        &audio_trim_label,
                        &mut filter_complex,
                    );

                    if clip_filter_graph.has_audio_effects() {
                        let effects_filter = clip_filter_graph
                            .to_audio_filter_complex(&audio_effects_input, &audio_out_label);
                        filter_complex.push_str(&effects_filter);
                        filter_complex.push(';');
                    } else {
                        filter_complex.push_str(&format!(
                            "[{}]anull[{}];",
                            audio_effects_input, audio_out_label
                        ));
                    }

                    let mixed_audio_label = apply_audio_mix_settings(
                        clip,
                        track,
                        input_index,
                        &audio_out_label,
                        &mut filter_complex,
                    );

                    audio_streams.push(format!("[{}]", mixed_audio_label));
                }
            }
            _ => {}
        }

        input_index += 1;
    }

    if video_streams.is_empty() {
        return Err(ExportError::InvalidSettings(
            "Sequence has no visual clips to export".to_string(),
        ));
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

    // Apply adjustment layer effects as post-processing, time-scoped via enable clause
    let mut adj_video_label = "outv".to_string();
    for (i, (graph, start, end)) in adjustment_layer_effects.iter().enumerate() {
        let out_label = format!("adj{}", i);
        let adj_filter =
            graph.to_video_filter_complex_timed(&adj_video_label, &out_label, *start, *end);
        filter_complex.push(';');
        filter_complex.push_str(&adj_filter);
        adj_video_label = out_label;
    }
    if !adjustment_layer_effects.is_empty() {
        filter_complex.push(';');
        filter_complex.push_str(&format!("[{}]null[outv]", adj_video_label));
    }

    let final_video_label =
        append_caption_overlays(&mut filter_complex, "[outv]", &caption_filters);

    let final_audio_label = append_master_audio_output(
        &mut filter_complex,
        &audio_streams,
        sequence.master_volume_db,
    );

    // Build FFmpeg arguments
    args.push("-filter_complex".to_string());
    args.push(filter_complex);

    args.push("-map".to_string());
    args.push(final_video_label);

    if let Some(final_audio_label) = final_audio_label.as_deref() {
        args.push("-map".to_string());
        args.push(final_audio_label.to_string());
    }

    // Video codec (resolved: may use GPU encoder)
    let video_encoder = settings.video_encoder_name();
    args.push("-c:v".to_string());
    args.push(video_encoder.clone());

    if final_audio_label.is_some() {
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

    // Quality args (CRF for software, CQ/QP for hardware encoders)
    if let Some(crf) = settings.crf {
        if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
            args.extend(super::hardware::resolve_quality_args(&video_encoder, crf));
        }
    }

    append_output_time_range_args(&mut args, settings.start_time, settings.end_time);

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
        if track.kind != TrackKind::Video || !track_included_in_export(track) {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }
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

    fn create_temp_media_file(filename: &str) -> String {
        let dir = std::env::temp_dir().join("openreelio-test-media");
        let _ = std::fs::create_dir_all(&dir);

        let unique = ulid::Ulid::new().to_string();
        let path = dir.join(format!("{unique}_{filename}"));
        std::fs::write(&path, b"").expect("create temp media file");
        path.to_string_lossy().to_string()
    }

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
        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);

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
        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);

        assert!(!validation.is_valid);
        assert!(validation.errors.iter().any(|e| e.contains("not found")));
    }

    #[test]
    fn test_validation_ignores_disabled_clips_with_missing_assets() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        track.add_clip(
            Clip::new("valid_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );

        let mut disabled_missing_clip = Clip::new("missing_asset")
            .with_source_range(0.0, 3.0)
            .place_at(3.0);
        disabled_missing_clip.enabled = false;
        track.add_clip(disabled_missing_clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_enabled_video.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut valid_asset = Asset::new_video(
            "validation_enabled_video.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        valid_asset.id = "valid_asset".to_string();
        assets.insert("valid_asset".to_string(), valid_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            validation.is_valid,
            "Expected disabled missing clip to be ignored. Got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_requires_visual_clips() {
        use crate::core::assets::AudioInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("audio_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);

        let audio_path = create_temp_media_file("validation_audio.mp3");
        let mut assets = std::collections::HashMap::new();
        let mut audio_asset =
            Asset::new_audio("validation_audio.mp3", &audio_path, AudioInfo::default())
                .with_duration(3.0)
                .with_file_size(1_000_000);
        audio_asset.id = "audio_asset".to_string();
        assets.insert("audio_asset".to_string(), audio_asset);

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|e| e.contains("no visual clips")));
    }

    #[test]
    fn test_validation_ignores_caption_track_virtual_assets() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut caption_track = Track::new_caption("Captions");
        caption_track.add_clip(
            Clip::new("caption")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("validation_video.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut video_asset =
            Asset::new_video("validation_video.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);

        assert!(
            validation.is_valid,
            "Expected caption track assets to be ignored. Got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_text_clip_requires_text_overlay_effect() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new(&format!("{}clip_1", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.effects = vec![]; // Missing TextOverlay effect
        track.add_clip(clip);
        sequence.add_track(track);

        let assets = std::collections::HashMap::new();
        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|e| e.to_lowercase().contains("textoverlay")));
    }

    #[test]
    fn test_validation_text_clip_does_not_require_asset_entry() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new(&format!("{}clip_1", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.0)
            .place_at(0.0);

        let effect = Effect::new(EffectType::TextOverlay);
        let effect_id = effect.id.clone();
        clip.effects = vec![effect_id.clone()];

        track.add_clip(clip);
        sequence.add_track(track);

        let assets = std::collections::HashMap::new(); // No asset for text clip
        let mut effects = std::collections::HashMap::new();
        effects.insert(effect_id, effect);
        let settings = ExportSettings::default();

        let validation = validate_export_settings(&sequence, &assets, &effects, &settings);
        assert!(
            validation.is_valid,
            "Expected valid export, got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_rejects_non_normal_clip_blend_modes() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{BlendMode, Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.blend_mode = BlendMode::Multiply;
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_blend_mode.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_blend_mode.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.to_lowercase().contains("blend mode export")));
    }

    #[test]
    fn test_validation_rejects_clip_transform_or_opacity_that_export_cannot_render() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.transform.position = Point2D::new(0.25, 0.75);
        clip.opacity = 0.8;
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_transform.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_transform.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            validation
                .errors
                .iter()
                .any(|error| error.to_lowercase().contains("transform or opacity")),
            "Expected unsupported transform/opacity validation error. Got: {:?}",
            validation.errors
        );
    }

    #[test]
    fn test_validation_rejects_overlay_tracks_for_final_render() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track, TrackKind};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut overlay_track = Track::new("Overlay 1", TrackKind::Overlay);
        overlay_track.add_clip(
            Clip::new("overlay_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(overlay_track);

        let overlay_path = create_temp_media_file("validation_overlay.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut overlay_asset = Asset::new_video(
            "validation_overlay.mp4",
            &overlay_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        overlay_asset.id = "overlay_asset".to_string();
        assets.insert("overlay_asset".to_string(), overlay_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.to_lowercase().contains("overlay tracks")));
    }

    #[test]
    fn test_validation_ignores_hidden_overlay_tracks() {
        use crate::core::timeline::{Clip, SequenceFormat, Track, TrackKind};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut overlay_track = Track::new("Overlay 1", TrackKind::Overlay);
        overlay_track.visible = false;
        overlay_track.add_clip(
            Clip::new("overlay_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(overlay_track);

        let validation = validate_export_settings(
            &sequence,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            !validation
                .errors
                .iter()
                .any(|error| error.to_lowercase().contains("overlay tracks")),
            "Hidden overlay tracks should not block export. Got: {:?}",
            validation.errors
        );
    }

    #[test]
    fn test_validation_rejects_simultaneous_layered_video_clips() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut top_track = Track::new_video("Video 1");
        top_track.add_clip(
            Clip::new("asset_top")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(top_track);

        let mut bottom_track = Track::new_video("Video 2");
        bottom_track.add_clip(
            Clip::new("asset_bottom")
                .with_source_range(0.0, 5.0)
                .place_at(2.0),
        );
        sequence.add_track(bottom_track);

        let top_path = create_temp_media_file("validation_layered_top.mp4");
        let mut top_asset = Asset::new_video(
            "validation_layered_top.mp4",
            &top_path,
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        top_asset.id = "asset_top".to_string();

        let bottom_path = create_temp_media_file("validation_layered_bottom.mp4");
        let mut bottom_asset = Asset::new_video(
            "validation_layered_bottom.mp4",
            &bottom_path,
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        bottom_asset.id = "asset_bottom".to_string();

        let mut assets = HashMap::new();
        assets.insert(top_asset.id.clone(), top_asset);
        assets.insert(bottom_asset.id.clone(), bottom_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            validation
                .errors
                .iter()
                .any(|error| error.to_lowercase().contains("simultaneous layered video")),
            "Expected layered video validation error. Got: {:?}",
            validation.errors
        );
    }

    #[test]
    fn test_validation_allows_missing_output_directory_when_export_can_create_it() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let temp_dir = tempfile::tempdir().unwrap();
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_create_dir.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_create_dir.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let mut settings = ExportSettings::default();
        settings.output_path = temp_dir.path().join("exports/final/out.mp4");

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &settings,
        );

        assert!(
            validation.is_valid,
            "Expected missing output directories to be allowed. Got: {validation:?}"
        );
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
                is_hdr: false,
                color_transfer: None,
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
                is_hdr: false,
                color_transfer: None,
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
        let silent_path = create_temp_media_file("silent_video.mp4");
        let mut silent_asset =
            Asset::new_video("silent_video.mp4", &silent_path, VideoInfo::default())
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
    fn test_build_filter_rejects_sequences_without_visual_streams() {
        use crate::core::assets::AudioInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("audio_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);

        let audio_path = create_temp_media_file("audio_only_filter.mp3");
        let mut audio_asset =
            Asset::new_audio("audio_only_filter.mp3", &audio_path, AudioInfo::default())
                .with_duration(3.0)
                .with_file_size(1_000_000);
        audio_asset.id = "audio_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("audio_asset".to_string(), audio_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "audio_asset".to_string(),
            AssetAudioInfo { has_audio: true },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let err = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        )
        .unwrap_err();

        match err {
            ExportError::InvalidSettings(message) => {
                assert!(message.contains("no visual clips"), "Got: {message}");
            }
            other => panic!("Expected InvalidSettings, got: {other:?}"),
        }
    }

    #[test]
    fn test_build_filter_ignores_caption_tracks_without_assets() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut caption_track = Track::new_caption("Captions");
        caption_track.add_clip(
            Clip::new("caption")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("video_with_caption_track.mp4");
        let mut video_asset = Asset::new_video(
            "video_with_caption_track.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo { has_audio: false },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(
            result.is_ok(),
            "Expected caption track to be ignored. Error: {:?}",
            result.err()
        );

        let args = result.unwrap();
        let input_count = args.iter().filter(|arg| arg.as_str() == "-i").count();
        assert_eq!(
            input_count, 1,
            "Expected only one file input for visual clip"
        );
    }

    #[test]
    fn test_build_filter_ignores_hidden_video_tracks() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut hidden_track = Track::new_video("Hidden Video");
        hidden_track.visible = false;
        hidden_track.add_clip(
            Clip::new("hidden_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(hidden_track);

        let mut visible_track = Track::new_video("Visible Video");
        visible_track.add_clip(
            Clip::new("visible_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(visible_track);

        let hidden_path = create_temp_media_file("hidden_track.mp4");
        let mut hidden_asset =
            Asset::new_video("hidden_track.mp4", &hidden_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        hidden_asset.id = "hidden_asset".to_string();

        let visible_path = create_temp_media_file("visible_track.mp4");
        let mut visible_asset =
            Asset::new_video("visible_track.mp4", &visible_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        visible_asset.id = "visible_asset".to_string();

        let mut assets = HashMap::new();
        assets.insert(hidden_asset.id.clone(), hidden_asset);
        assets.insert(visible_asset.id.clone(), visible_asset);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("hidden visual tracks should be ignored");

        let args_str = args.join(" ");
        assert!(
            !args_str.contains(&hidden_path),
            "Hidden track asset should not be exported. Got: {args_str}"
        );
        assert!(
            args_str.contains(&visible_path),
            "Visible track asset should be exported. Got: {args_str}"
        );
    }

    #[test]
    fn test_build_filter_burns_in_caption_track() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption")
            .with_source_range(0.0, 2.0)
            .place_at(0.5);
        caption_clip.label = Some("Hello from caption track".to_string());
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("video_caption_burnin.mp4");
        let mut video_asset = Asset::new_video(
            "video_caption_burnin.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo { has_audio: false },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(
            result.is_ok(),
            "Caption burn-in filter generation should succeed. Error: {:?}",
            result.err()
        );

        let args = result.unwrap();
        let args_str = args.join(" ");

        assert!(
            args_str.contains("drawtext="),
            "Expected drawtext overlay in filter graph. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("between(t,0.500000,2.500000)"),
            "Expected caption time window in drawtext enable expression. Got: {}",
            args_str
        );

        let input_count = args.iter().filter(|arg| arg.as_str() == "-i").count();
        assert_eq!(
            input_count, 1,
            "Caption burn-in should not add extra file inputs"
        );

        let first_map_index = args
            .iter()
            .position(|arg| arg.as_str() == "-map")
            .expect("Expected at least one -map argument");
        assert_eq!(
            args.get(first_map_index + 1).map(String::as_str),
            Some("[capv0]"),
            "Expected video map label to use caption-composited stream"
        );
    }

    #[test]
    fn test_build_filter_applies_sequence_master_volume_to_audio_output() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        sequence.master_volume_db = -6.0;

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let video_path = create_temp_media_file("video_master_gain.mp4");
        let mut video_asset =
            Asset::new_video("video_master_gain.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo { has_audio: true },
        );

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &audio_info_map,
            &ExportSettings::default(),
        )
        .unwrap();

        let filter_complex = args
            .windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .unwrap();

        assert!(
            filter_complex.contains("[outa_base]volume=0.501187[outa]"),
            "Expected master gain filter in audio output chain. Got: {}",
            filter_complex
        );
    }

    #[test]
    fn test_build_filter_uses_timeline_audio_mix_for_gaps() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("asset1")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        track.add_clip(
            Clip::new("asset2")
                .with_source_range(0.0, 5.0)
                .place_at(8.0),
        );
        sequence.add_track(track);

        let path1 = create_temp_media_file("gap_audio_1.mp4");
        let mut asset1 = Asset::new_video("gap_audio_1.mp4", &path1, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        asset1.id = "asset1".to_string();
        asset1.audio = Some(AudioInfo::default());

        let path2 = create_temp_media_file("gap_audio_2.mp4");
        let mut asset2 = Asset::new_video("gap_audio_2.mp4", &path2, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        asset2.id = "asset2".to_string();
        asset2.audio = Some(AudioInfo::default());

        let mut assets = HashMap::new();
        assets.insert(asset1.id.clone(), asset1);
        assets.insert(asset2.id.clone(), asset2);

        let mut audio_info = HashMap::new();
        audio_info.insert("asset1".to_string(), AssetAudioInfo { has_audio: true });
        audio_info.insert("asset2".to_string(), AssetAudioInfo { has_audio: true });

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("timeline audio mix should build");

        let filter_complex = args
            .windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .unwrap();

        assert!(
            filter_complex.contains("adelay=delays=8000:all=1"),
            "Expected delayed audio placement for downstream clip. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("amix=inputs=2"),
            "Expected audio timeline mix instead of concat. Got: {filter_complex}"
        );
    }

    #[test]
    fn test_build_filter_applies_clip_track_audio_gain_and_pan() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.volume = 0.5;

        let mut clip = Clip::new("asset1")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.audio.volume_db = -6.0;
        clip.audio.pan = 0.25;
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("audio_gain_pan.mp4");
        let mut asset = Asset::new_video("audio_gain_pan.mp4", &video_path, VideoInfo::default())
            .with_duration(3.0)
            .with_file_size(3_000_000);
        asset.id = "asset1".to_string();
        asset.audio = Some(AudioInfo::default());

        let mut assets = HashMap::new();
        assets.insert(asset.id.clone(), asset);

        let mut audio_info = HashMap::new();
        audio_info.insert("asset1".to_string(), AssetAudioInfo { has_audio: true });

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("audio gain/pan filters should build");

        let filter_complex = args
            .windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .unwrap();

        assert!(
            filter_complex.contains("volume=0.250594"),
            "Expected combined clip/track gain in audio filter. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("stereotools=balance_in=0.2500:bmode_in=power"),
            "Expected stereo pan filter in audio chain. Got: {filter_complex}"
        );
    }

    #[test]
    fn test_build_filter_suppresses_video_audio_when_audio_companion_exists_even_if_muted() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let video_clip = Clip::new("shared_asset")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(video_clip);
        sequence.add_track(video_track);

        let companion_clip = Clip::new("shared_asset")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.muted = true;
        audio_track.add_clip(companion_clip);
        sequence.add_track(audio_track);

        let video_path = create_temp_media_file("audio_companion.mp4");
        let mut asset = Asset::new_video("audio_companion.mp4", &video_path, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        asset.id = "shared_asset".to_string();
        asset.audio = Some(AudioInfo::default());

        let mut assets = HashMap::new();
        assets.insert(asset.id.clone(), asset);

        let mut audio_info = HashMap::new();
        audio_info.insert(
            "shared_asset".to_string(),
            AssetAudioInfo { has_audio: true },
        );

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("audio companion suppression should build");

        let args_str = args.join(" ");
        assert!(
            !args_str.contains("-c:a"),
            "Muted companion track should still suppress duplicated video audio. Got: {args_str}"
        );
        assert!(
            !args_str.contains("[outa]"),
            "Expected no mixed audio output when companion suppression removes the only audible stream. Got: {args_str}"
        );
    }

    #[test]
    fn test_build_filter_caption_style_maps_rgba_and_position() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption")
            .with_source_range(0.0, 2.0)
            .place_at(0.25);
        caption_clip.label = Some("Styled caption".to_string());
        caption_clip.caption_style = Some(serde_json::json!({
            "fontSize": 64,
            "alignment": "left",
            "color": { "r": 255, "g": 0, "b": 0, "a": 128 },
            "outlineColor": "#000000",
            "outlineWidth": 3
        }));
        caption_clip.caption_position = Some(serde_json::json!({
            "type": "preset",
            "vertical": "bottom",
            "marginPercent": 5
        }));
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("video_caption_style.mp4");
        let mut video_asset =
            Asset::new_video("video_caption_style.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo { has_audio: false },
        );

        let effects = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        )
        .expect("Caption style burn-in filter generation should succeed");
        let args_str = args.join(" ");

        assert!(
            args_str.contains("fontcolor=0xFF0000@0.50"),
            "Expected RGBA color to map to FFmpeg fontcolor with opacity. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("y=(h*0.9500)-(text_h/2)"),
            "Expected preset bottom position to map to y=0.95. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("x=(w*0.5000)"),
            "Expected left alignment x expression. Got: {}",
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
        let normal_path = create_temp_media_file("normal_video.mp4");
        let mut normal_asset =
            Asset::new_video("normal_video.mp4", &normal_path, VideoInfo::default())
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
        let with_audio_path = create_temp_media_file("with_audio.mp4");
        let mut with_audio_asset =
            Asset::new_video("with_audio.mp4", &with_audio_path, VideoInfo::default())
                .with_duration(5.0)
                .with_file_size(5_000_000);
        with_audio_asset.id = "with_audio".to_string();
        with_audio_asset.audio = Some(AudioInfo::default());

        // Create asset WITHOUT audio
        let without_audio_path = create_temp_media_file("without_audio.mp4");
        let mut without_audio_asset = Asset::new_video(
            "without_audio.mp4",
            &without_audio_path,
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

    // -------------------------------------------------------------------------
    // Transition Export Tests (E2E)
    // -------------------------------------------------------------------------

    #[test]
    fn test_export_with_transition_applies_xfade() {
        use crate::core::assets::VideoInfo;
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with two consecutive clips
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        // First clip: 0-5 seconds with a dissolve transition effect
        let mut clip1 = Clip::new("asset1")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        let transition_effect_id = "transition_effect_1".to_string();
        clip1.effects.push(transition_effect_id.clone());
        track.add_clip(clip1);

        // Second clip: 5-10 seconds
        let clip2 = Clip::new("asset2")
            .with_source_range(0.0, 5.0)
            .place_at(5.0);
        track.add_clip(clip2);

        sequence.add_track(track);

        // Create assets
        let video1_path = create_temp_media_file("video1.mp4");
        let mut asset1 = Asset::new_video("video1.mp4", &video1_path, VideoInfo::default())
            .with_duration(10.0)
            .with_file_size(10_000_000);
        asset1.id = "asset1".to_string();

        let video2_path = create_temp_media_file("video2.mp4");
        let mut asset2 = Asset::new_video("video2.mp4", &video2_path, VideoInfo::default())
            .with_duration(10.0)
            .with_file_size(10_000_000);
        asset2.id = "asset2".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("asset1".to_string(), asset1);
        assets.insert("asset2".to_string(), asset2);

        // Create dissolve transition effect
        let mut transition_effect = Effect::new(EffectType::CrossDissolve);
        transition_effect.id = transition_effect_id.clone();
        transition_effect
            .params
            .insert("duration".to_string(), ParamValue::Float(1.0));
        transition_effect
            .params
            .insert("offset".to_string(), ParamValue::Float(0.0));
        transition_effect.enabled = true;

        let mut effects = std::collections::HashMap::new();
        effects.insert(transition_effect_id, transition_effect);

        let audio_info_map = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(result.is_ok(), "Build should succeed");
        let args = result.unwrap();
        let args_str = args.join(" ");

        // Verify xfade filter is present (transition effect applied)
        assert!(
            args_str.contains("xfade"),
            "Export with transition should include xfade filter. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("dissolve"),
            "Dissolve transition should specify dissolve type. Got: {}",
            args_str
        );
    }

    // -------------------------------------------------------------------------
    // Keyframe Export Tests (E2E)
    // -------------------------------------------------------------------------

    #[test]
    fn test_export_with_keyframes_interpolates_params() {
        use crate::core::effects::{Easing, EffectType, Keyframe, ParamValue};

        // Create an effect with keyframes
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.id = "blur_effect".to_string();
        effect.enabled = true;

        // Add keyframes: sigma goes from 0.0 at t=0 to 10.0 at t=5
        let keyframes = vec![
            Keyframe {
                time_offset: 0.0,
                value: ParamValue::Float(0.0),
                easing: Easing::Linear,
            },
            Keyframe {
                time_offset: 5.0,
                value: ParamValue::Float(10.0),
                easing: Easing::Linear,
            },
        ];
        effect.keyframes.insert("sigma".to_string(), keyframes);

        // Verify has_keyframes returns true
        assert!(effect.has_keyframes(), "Effect should have keyframes");

        // Resolve parameters at midpoint (t=2.5)
        let resolved = effect.with_params_at_time(2.5);

        // Verify sigma is interpolated to ~5.0 (linear interpolation)
        let sigma = resolved
            .params
            .get("sigma")
            .and_then(|v| v.as_float())
            .unwrap_or(-1.0);

        assert!(
            (sigma - 5.0).abs() < 0.1,
            "Sigma should be interpolated to ~5.0 at midpoint. Got: {}",
            sigma
        );

        // Verify keyframes are cleared after resolution
        assert!(
            !resolved.has_keyframes(),
            "Resolved effect should not have keyframes"
        );
    }

    #[test]
    fn test_export_effect_with_keyframes_in_filter_graph() {
        use crate::core::effects::{Easing, EffectType, Keyframe, ParamValue};
        use crate::core::timeline::Clip;

        // Create clip with duration 4.0 seconds
        let mut clip = Clip::new("asset1")
            .with_source_range(0.0, 4.0)
            .place_at(0.0);
        let effect_id = "animated_blur".to_string();
        clip.effects.push(effect_id.clone());

        // Create effect with keyframes
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.id = effect_id.clone();
        effect.enabled = true;

        // Keyframes: sigma 2.0 at t=0, 8.0 at t=4
        let keyframes = vec![
            Keyframe {
                time_offset: 0.0,
                value: ParamValue::Float(2.0),
                easing: Easing::Linear,
            },
            Keyframe {
                time_offset: 4.0,
                value: ParamValue::Float(8.0),
                easing: Easing::Linear,
            },
        ];
        effect.keyframes.insert("sigma".to_string(), keyframes);

        let mut effects = std::collections::HashMap::new();
        effects.insert(effect_id, effect);

        // Build filter graph for clip (uses midpoint interpolation)
        // ExportEngine::build_clip_filter_graph is a method, so we test via a helper
        let graph = build_test_filter_graph(&clip, &effects);

        // Verify filter graph has video effects
        assert!(
            graph.has_video_effects(),
            "Filter graph should have video effects"
        );

        // Get the filter complex string
        let filter_str = graph.to_video_filter_complex("in", "out");

        // The filter should contain gblur
        assert!(
            filter_str.contains("gblur"),
            "Filter should contain gblur. Got: {}",
            filter_str
        );
    }

    // -------------------------------------------------------------------------
    // Text Clip Export Tests (E2E)
    // -------------------------------------------------------------------------

    #[test]
    fn test_is_text_clip_detection() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::timeline::Clip;

        // Text clip has virtual asset ID with __text__ prefix
        let text_clip = Clip::new(&format!("{}12345", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        assert!(
            is_text_clip(&text_clip),
            "Should detect text clip by asset_id prefix"
        );

        // Regular clip does not have the prefix
        let regular_clip = Clip::new("regular_asset")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        assert!(
            !is_text_clip(&regular_clip),
            "Should not detect regular clip as text clip"
        );
    }

    #[test]
    fn test_export_text_clip_missing_effect_is_error() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let text_clip = Clip::new(&format!("{}clip1", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        track.add_clip(text_clip);
        sequence.add_track(track);

        let assets = std::collections::HashMap::new();
        let effects = std::collections::HashMap::new();
        let audio_info = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let err = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &settings,
        )
        .unwrap_err();

        match err {
            ExportError::InvalidSettings(msg) => {
                assert!(msg.to_lowercase().contains("textoverlay"), "Got: {msg}");
            }
            other => panic!("Expected InvalidSettings error, got: {other:?}"),
        }
    }

    #[test]
    fn test_build_filter_ignores_disabled_clips_with_missing_assets() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        track.add_clip(
            Clip::new("valid_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );

        let mut disabled_missing_clip = Clip::new("missing_asset")
            .with_source_range(0.0, 5.0)
            .place_at(5.0);
        disabled_missing_clip.enabled = false;
        track.add_clip(disabled_missing_clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("enabled_only_video.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut valid_asset =
            Asset::new_video("enabled_only_video.mp4", &video_path, VideoInfo::default())
                .with_duration(5.0)
                .with_file_size(5_000_000);
        valid_asset.id = "valid_asset".to_string();
        assets.insert("valid_asset".to_string(), valid_asset);

        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            result.is_ok(),
            "Expected disabled missing clip to be ignored. Error: {:?}",
            result.err()
        );
    }

    #[test]
    fn test_export_text_clip_uses_color_source_input() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with a text clip
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        // Text clip: has __text__ prefix and TextOverlay effect
        let text_effect_id = "text_effect_1".to_string();
        let mut text_clip = Clip::new(&format!("{}clip1", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        text_clip.effects.push(text_effect_id.clone());
        track.add_clip(text_clip);
        sequence.add_track(track);

        // Create TextOverlay effect
        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.id = text_effect_id.clone();
        text_effect.set_param("text", ParamValue::String("Hello World".to_string()));
        text_effect.set_param("font_family", ParamValue::String("Arial".to_string()));
        text_effect.set_param("font_size", ParamValue::Float(48.0));
        text_effect.set_param("color", ParamValue::String("#FFFFFF".to_string()));
        text_effect.set_param("x", ParamValue::Float(0.5));
        text_effect.set_param("y", ParamValue::Float(0.5));
        text_effect.enabled = true;

        let mut effects = std::collections::HashMap::new();
        effects.insert(text_effect_id, text_effect);

        // No regular assets needed - text clips use virtual assets
        let assets = std::collections::HashMap::new();
        let audio_info_map = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(
            result.is_ok(),
            "Text clip export should succeed. Error: {:?}",
            result.err()
        );
        let args = result.unwrap();
        let args_str = args.join(" ");

        // Should use color source input for text clip (no file input)
        assert!(
            args_str.contains("color=c="),
            "Text clip should use color source input. Got: {}",
            args_str
        );

        // Should contain drawtext filter
        assert!(
            args_str.contains("drawtext"),
            "Text clip should include drawtext filter. Got: {}",
            args_str
        );

        // Should contain the text content
        assert!(
            args_str.contains("Hello World") || args_str.contains("Hello\\ World"),
            "Text clip filter should include text content. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_export_mixed_regular_and_text_clips() {
        use crate::core::assets::VideoInfo;
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with both regular and text clips
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        // Regular clip first: 0-5 seconds
        let clip1 = Clip::new("regular_asset")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        track.add_clip(clip1);

        // Text clip second: 5-10 seconds
        let text_effect_id = "text_effect_1".to_string();
        let mut text_clip = Clip::new(&format!("{}clip2", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 5.0)
            .place_at(5.0);
        text_clip.effects.push(text_effect_id.clone());
        track.add_clip(text_clip);

        sequence.add_track(track);

        // Create regular asset
        let regular_path = create_temp_media_file("video1.mp4");
        let mut regular_asset = Asset::new_video("video1.mp4", &regular_path, VideoInfo::default())
            .with_duration(10.0)
            .with_file_size(10_000_000);
        regular_asset.id = "regular_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("regular_asset".to_string(), regular_asset);

        // Create TextOverlay effect
        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.id = text_effect_id.clone();
        text_effect.set_param("text", ParamValue::String("Title".to_string()));
        text_effect.set_param("font_family", ParamValue::String("Arial".to_string()));
        text_effect.set_param("font_size", ParamValue::Float(72.0));
        text_effect.set_param("color", ParamValue::String("#FFFFFF".to_string()));
        text_effect.set_param("x", ParamValue::Float(0.5));
        text_effect.set_param("y", ParamValue::Float(0.5));
        text_effect.enabled = true;

        let mut effects = std::collections::HashMap::new();
        effects.insert(text_effect_id, text_effect);

        let audio_info_map = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        // Build args
        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(
            result.is_ok(),
            "Mixed clips export should succeed. Error: {:?}",
            result.err()
        );
        let args = result.unwrap();
        let args_str = args.join(" ");

        // Should have both file input and color source
        assert!(
            args_str.contains(&regular_path),
            "Should include file input for regular clip. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("color=c="),
            "Should include color source for text clip. Got: {}",
            args_str
        );

        // Should have concat for multiple clips
        assert!(
            args_str.contains("concat=n=2"),
            "Should concat two video streams. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_export_text_clip_with_styling() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Create sequence with styled text clip
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let text_effect_id = "styled_text".to_string();
        let mut text_clip = Clip::new(&format!("{}styled", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        text_clip.effects.push(text_effect_id.clone());
        track.add_clip(text_clip);
        sequence.add_track(track);

        // Create TextOverlay effect with full styling
        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.id = text_effect_id.clone();
        text_effect.set_param("text", ParamValue::String("Styled Text".to_string()));
        text_effect.set_param("font_family", ParamValue::String("Helvetica".to_string()));
        text_effect.set_param("font_size", ParamValue::Float(72.0));
        text_effect.set_param("color", ParamValue::String("#FF0000".to_string()));
        text_effect.set_param("x", ParamValue::Float(0.5));
        text_effect.set_param("y", ParamValue::Float(0.5));
        // Shadow
        text_effect.set_param("shadow_color", ParamValue::String("#000000".to_string()));
        text_effect.set_param("shadow_x", ParamValue::Int(2));
        text_effect.set_param("shadow_y", ParamValue::Int(2));
        // Outline
        text_effect.set_param("outline_color", ParamValue::String("#000000".to_string()));
        text_effect.set_param("outline_width", ParamValue::Int(2));
        text_effect.enabled = true;

        let mut effects = std::collections::HashMap::new();
        effects.insert(text_effect_id, text_effect);

        let assets = std::collections::HashMap::new();
        let audio_info_map = std::collections::HashMap::new();
        let settings = ExportSettings::default();

        let result = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        );

        assert!(
            result.is_ok(),
            "Styled text export should succeed. Error: {:?}",
            result.err()
        );
        let args = result.unwrap();
        let args_str = args.join(" ");

        // Verify styling is applied in drawtext filter
        assert!(
            args_str.contains("drawtext"),
            "Should include drawtext filter. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("fontsize=72"),
            "Should include font size. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("shadowx=2") && args_str.contains("shadowy=2"),
            "Should include shadow offset. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("borderw=2"),
            "Should include outline width. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_find_topmost_clip_at_time_prefers_lower_track_index_and_skips_hidden_tracks() {
        use crate::core::assets::VideoInfo;
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut hidden_top_track = Track::new_video("Hidden Top");
        hidden_top_track.visible = false;
        hidden_top_track.add_clip(
            Clip::new("hidden_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(hidden_top_track);

        let mut visible_top_track = Track::new_video("Visible Top");
        visible_top_track.add_clip(
            Clip::new("visible_top_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(visible_top_track);

        let mut back_track = Track::new_video("Back");
        back_track.add_clip(
            Clip::new("back_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(back_track);

        let hidden_path = create_temp_media_file("frame_hidden.mp4");
        let mut hidden_asset =
            Asset::new_video("frame_hidden.mp4", &hidden_path, VideoInfo::default())
                .with_duration(5.0)
                .with_file_size(5_000_000);
        hidden_asset.id = "hidden_asset".to_string();

        let visible_top_path = create_temp_media_file("frame_visible_top.mp4");
        let mut visible_top_asset = Asset::new_video(
            "frame_visible_top.mp4",
            &visible_top_path,
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        visible_top_asset.id = "visible_top_asset".to_string();

        let back_path = create_temp_media_file("frame_back.mp4");
        let mut back_asset = Asset::new_video("frame_back.mp4", &back_path, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        back_asset.id = "back_asset".to_string();

        let mut assets = HashMap::new();
        assets.insert(hidden_asset.id.clone(), hidden_asset);
        assets.insert(visible_top_asset.id.clone(), visible_top_asset);
        assets.insert(back_asset.id.clone(), back_asset);

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
        }));

        let (clip, asset) = engine
            .find_topmost_clip_at_time(&sequence, &assets, 1.0)
            .expect("expected a visible topmost clip");

        assert_eq!(clip.asset_id, "visible_top_asset");
        assert_eq!(asset.id, "visible_top_asset");
    }

    // =========================================================================
    // HDR Export Tests
    // =========================================================================

    #[test]
    fn test_hdr_mode_default_is_sdr() {
        let settings = ExportSettings::default();
        assert_eq!(settings.hdr_mode, HdrMode::Sdr);
        assert!(!settings.is_hdr());
    }

    #[test]
    fn test_sdr_mode_returns_empty_args() {
        let settings = ExportSettings::default();
        let args = settings.hdr_args();
        assert!(args.is_empty(), "SDR mode should return empty args");
    }

    #[test]
    fn test_hdr10_mode_args() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            ..Default::default()
        };

        let args = settings.hdr_args();
        assert!(settings.is_hdr());

        // Check for required HDR10 arguments
        assert!(args.contains(&"-color_primaries".to_string()));
        assert!(args.contains(&"bt2020".to_string()));
        assert!(args.contains(&"-colorspace".to_string()));
        assert!(args.contains(&"bt2020nc".to_string()));
        assert!(args.contains(&"-color_trc".to_string()));
        assert!(args.contains(&"smpte2084".to_string()));
        assert!(args.contains(&"-pix_fmt".to_string()));
        assert!(args.contains(&"yuv420p10le".to_string()));
    }

    #[test]
    fn test_hdr10_mode_with_metadata_and_h265() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H265, // HDR requires H.265
            max_cll: Some(1000),
            max_fall: Some(400),
            ..Default::default()
        };

        let args = settings.hdr_args();
        let args_str = args.join(" ");

        assert!(
            args_str.contains("-x265-params"),
            "Should include x265 params for HDR metadata with H.265 codec"
        );
        assert!(
            args_str.contains("max-cll=1000,400"),
            "Should include MaxCLL,MaxFALL. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_hdr10_mode_with_h264_no_x265_params() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H264, // H.264 doesn't support x265-params
            max_cll: Some(1000),
            max_fall: Some(400),
            ..Default::default()
        };

        let args = settings.hdr_args();
        let args_str = args.join(" ");

        // Should NOT include x265-params with H.264 codec
        assert!(
            !args_str.contains("-x265-params"),
            "Should not include x265 params with H.264 codec. Got: {}",
            args_str
        );
        // But should still have color metadata
        assert!(args_str.contains("bt2020"));
    }

    #[test]
    fn test_hdr_validation_sdr_always_valid() {
        let settings = ExportSettings::default(); // SDR with H.264
        assert!(settings.validate_hdr_settings().is_none());
    }

    #[test]
    fn test_hdr_validation_hdr_with_h264_fails() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H264,
            ..Default::default()
        };

        let result = settings.validate_hdr_settings();
        assert!(result.is_some(), "HDR with H.264 should fail validation");
        assert!(result.unwrap().contains("H.265"));
    }

    #[test]
    fn test_hdr_validation_hdr_with_h265_passes() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H265,
            max_cll: Some(1000),
            max_fall: Some(400),
            ..Default::default()
        };

        assert!(settings.validate_hdr_settings().is_none());
    }

    #[test]
    fn test_with_hdr_compatible_codec() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H264,
            ..Default::default()
        };

        // Should fail validation
        assert!(settings.validate_hdr_settings().is_some());

        // Apply HDR-compatible codec
        let fixed = settings.with_hdr_compatible_codec();
        assert_eq!(fixed.video_codec, VideoCodec::H265);
        assert!(fixed.validate_hdr_settings().is_none());
    }

    #[test]
    fn test_hlg_mode_args() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hlg,
            ..Default::default()
        };

        let args = settings.hdr_args();
        assert!(settings.is_hdr());

        // Check for required HLG arguments
        assert!(args.contains(&"-color_primaries".to_string()));
        assert!(args.contains(&"bt2020".to_string()));
        assert!(args.contains(&"-colorspace".to_string()));
        assert!(args.contains(&"bt2020nc".to_string()));
        assert!(args.contains(&"-color_trc".to_string()));
        assert!(args.contains(&"arib-std-b67".to_string()));
        assert!(args.contains(&"-pix_fmt".to_string()));
        assert!(args.contains(&"yuv420p10le".to_string()));
    }

    #[test]
    fn test_hdr_mode_serialization() {
        let hdr10 = HdrMode::Hdr10;
        let json = serde_json::to_string(&hdr10).unwrap();
        assert_eq!(json, "\"hdr10\"");

        let hlg = HdrMode::Hlg;
        let json = serde_json::to_string(&hlg).unwrap();
        assert_eq!(json, "\"hlg\"");

        let sdr = HdrMode::Sdr;
        let json = serde_json::to_string(&sdr).unwrap();
        assert_eq!(json, "\"sdr\"");
    }

    #[test]
    fn test_hdr_mode_deserialization() {
        let hdr10: HdrMode = serde_json::from_str("\"hdr10\"").unwrap();
        assert_eq!(hdr10, HdrMode::Hdr10);

        let hlg: HdrMode = serde_json::from_str("\"hlg\"").unwrap();
        assert_eq!(hlg, HdrMode::Hlg);

        let sdr: HdrMode = serde_json::from_str("\"sdr\"").unwrap();
        assert_eq!(sdr, HdrMode::Sdr);
    }

    #[test]
    fn test_export_settings_with_hdr_serialization() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            max_cll: Some(1000),
            max_fall: Some(400),
            bit_depth: Some(10),
            ..Default::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"hdrMode\":\"hdr10\""));
        assert!(json.contains("\"maxCll\":1000"));
        assert!(json.contains("\"maxFall\":400"));
        assert!(json.contains("\"bitDepth\":10"));

        // Deserialize and verify
        let parsed: ExportSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.hdr_mode, HdrMode::Hdr10);
        assert_eq!(parsed.max_cll, Some(1000));
        assert_eq!(parsed.max_fall, Some(400));
        assert_eq!(parsed.bit_depth, Some(10));
    }

    #[test]
    fn test_all_presets_default_to_sdr() {
        use std::path::PathBuf;

        let presets = vec![
            ExportPreset::Youtube1080p,
            ExportPreset::Youtube4k,
            ExportPreset::YoutubeShorts,
            ExportPreset::Twitter,
            ExportPreset::Instagram,
            ExportPreset::WebmVp9,
            ExportPreset::ProRes,
            ExportPreset::Custom,
        ];

        for preset in presets {
            let settings = ExportSettings::from_preset(preset.clone(), PathBuf::from("test.mp4"));
            assert_eq!(
                settings.hdr_mode,
                HdrMode::Sdr,
                "Preset {:?} should default to SDR",
                preset
            );
        }
    }

    // =========================================================================
    // Tonemapping Integration Tests
    // =========================================================================

    #[test]
    fn test_tonemap_mode_defaults_to_none() {
        let settings = ExportSettings::default();
        assert!(settings.tonemap_mode.is_none());
    }

    #[test]
    fn test_build_tonemap_filter_returns_none_for_sdr_source() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Reinhard),
            ..Default::default()
        };
        let sdr_meta = HdrMetadata::sdr();
        assert!(settings.build_tonemap_video_filter(&sdr_meta).is_none());
    }

    #[test]
    fn test_build_tonemap_filter_returns_none_when_mode_not_set() {
        let settings = ExportSettings::default();
        let hdr_meta = HdrMetadata::hdr10_default();
        assert!(settings.build_tonemap_video_filter(&hdr_meta).is_none());
    }

    #[test]
    fn test_build_tonemap_filter_reinhard_for_hdr_source() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Reinhard),
            ..Default::default()
        };
        let hdr_meta = HdrMetadata::hdr10_default();
        let filter = settings.build_tonemap_video_filter(&hdr_meta);

        assert!(filter.is_some());
        let f = filter.unwrap();
        assert!(
            f.contains("zscale=t=linear"),
            "should convert to linear light"
        );
        assert!(
            f.contains("tonemap=reinhard"),
            "should use reinhard tonemapping"
        );
        assert!(
            f.contains("zscale=p=bt709:t=bt709:m=bt709"),
            "should convert to BT.709"
        );
        assert!(f.contains("format=yuv420p"), "should convert to 8-bit");
    }

    #[test]
    fn test_build_tonemap_filter_hable_mode() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Hable),
            ..Default::default()
        };
        let hdr_meta = HdrMetadata::hdr10_default();
        let filter = settings.build_tonemap_video_filter(&hdr_meta).unwrap();
        assert!(filter.contains("tonemap=hable"));
    }

    #[test]
    fn test_build_tonemap_filter_bt2390_mode() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Bt2390),
            ..Default::default()
        };
        let hdr_meta = HdrMetadata::hdr10_default();
        let filter = settings.build_tonemap_video_filter(&hdr_meta).unwrap();
        assert!(filter.contains("tonemap=bt2390"));
    }

    #[test]
    fn test_build_tonemap_filter_mobius_mode() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Mobius),
            ..Default::default()
        };
        let hdr_meta = HdrMetadata::hdr10_default();
        let filter = settings.build_tonemap_video_filter(&hdr_meta).unwrap();
        assert!(filter.contains("tonemap=mobius"));
    }

    #[test]
    fn test_to_hdr_metadata_sdr() {
        let settings = ExportSettings::default();
        let meta = settings.to_hdr_metadata();
        assert!(!meta.is_hdr());
    }

    #[test]
    fn test_to_hdr_metadata_hdr10() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            max_cll: Some(2000),
            max_fall: Some(800),
            ..Default::default()
        };
        let meta = settings.to_hdr_metadata();
        assert!(meta.is_hdr());
        assert_eq!(meta.max_cll, Some(2000));
        assert_eq!(meta.max_fall, Some(800));
    }

    #[test]
    fn test_to_hdr_metadata_hlg() {
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hlg,
            ..Default::default()
        };
        let meta = settings.to_hdr_metadata();
        assert!(meta.is_hdr());
        assert!(meta.max_cll.is_none()); // HLG doesn't use static metadata
    }

    #[test]
    fn test_hdr_metadata_for_asset_returns_sdr_for_sdr_assets() {
        let asset = Asset::new_video(
            "clip.mp4",
            "/tmp/clip.mp4",
            crate::core::assets::VideoInfo {
                is_hdr: false,
                color_transfer: Some("bt709".to_string()),
                ..Default::default()
            },
        );

        assert!(!hdr_metadata_for_asset(&asset).is_hdr());
    }

    #[test]
    fn test_hdr_metadata_for_asset_preserves_hlg_assets() {
        let asset = Asset::new_video(
            "clip-hlg.mp4",
            "/tmp/clip-hlg.mp4",
            crate::core::assets::VideoInfo {
                is_hdr: true,
                color_transfer: Some("arib-std-b67".to_string()),
                ..Default::default()
            },
        );

        let metadata = hdr_metadata_for_asset(&asset);
        assert!(metadata.is_hdr());
        assert_eq!(metadata.color_space.transfer.ffmpeg_value(), "arib-std-b67");
    }

    #[test]
    fn test_build_filter_skips_tonemap_for_sdr_assets_even_when_enabled() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("sdr_tonemap.mp4");
        let mut assets = std::collections::HashMap::new();
        let mut asset = Asset::new_video(
            "sdr_tonemap.mp4",
            &video_path,
            VideoInfo {
                is_hdr: false,
                color_transfer: Some("bt709".to_string()),
                ..Default::default()
            },
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), asset);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &ExportSettings {
                tonemap_mode: Some(TonemapMode::Reinhard),
                ..Default::default()
            },
        )
        .unwrap();

        let filter_complex = args
            .windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .unwrap();

        assert!(!filter_complex.contains("tonemap="));
    }

    #[test]
    fn test_complex_export_includes_hdr_args() {
        // Verify that build_complex_filter_args_with_audio_info includes HDR metadata
        let settings = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H265,
            max_cll: Some(1000),
            max_fall: Some(400),
            ..Default::default()
        };
        let args = settings.hdr_args();
        assert!(args.contains(&"-color_primaries".to_string()));
        assert!(args.contains(&"bt2020".to_string()));
        assert!(args.contains(&"-color_trc".to_string()));
        assert!(args.contains(&"smpte2084".to_string()));
        assert!(args.contains(&"-x265-params".to_string()));
    }

    #[test]
    fn test_tonemap_mode_serialization() {
        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Hable),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"tonemapMode\":\"hable\""));

        let parsed: ExportSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tonemap_mode, Some(TonemapMode::Hable));
    }

    #[test]
    fn test_tonemap_mode_deserialization_null() {
        // tonemap_mode is optional, should deserialize None from missing field
        let json = r#"{"preset":"youtube1080p","outputPath":"out.mp4","videoCodec":"h264","audioCodec":"aac","twoPass":false,"hdrMode":"sdr"}"#;
        let parsed: ExportSettings = serde_json::from_str(json).unwrap();
        assert!(parsed.tonemap_mode.is_none());
    }

    // =========================================================================
    // Speed Filter Tests (BDD-style)
    // =========================================================================

    #[test]
    fn should_return_identity_setpts_when_speed_is_normal() {
        // Given a clip with speed 1.0
        let setpts = build_speed_setpts(1.0);
        // Then setpts should be the identity expression
        assert_eq!(setpts, "PTS-STARTPTS");
    }

    #[test]
    fn should_scale_setpts_when_speed_is_double() {
        // Given a clip with speed 2.0
        let setpts = build_speed_setpts(2.0);
        // Then setpts should divide timestamps by 2 (plays faster)
        assert_eq!(setpts, "(PTS-STARTPTS)/2");
    }

    #[test]
    fn should_scale_setpts_when_speed_is_half() {
        // Given a clip with speed 0.5
        let setpts = build_speed_setpts(0.5);
        // Then setpts should divide timestamps by 0.5 (plays slower)
        assert_eq!(setpts, "(PTS-STARTPTS)/0.5");
    }

    #[test]
    fn should_handle_fractional_speed_in_setpts() {
        // Given a clip with speed 1.5
        let setpts = build_speed_setpts(1.5);
        // Then setpts should use the fractional value
        assert_eq!(setpts, "(PTS-STARTPTS)/1.5");
    }

    #[test]
    fn should_return_none_atempo_when_speed_is_normal() {
        // Given a clip with speed 1.0
        let atempo = build_atempo_chain(1.0);
        // Then no atempo filter is needed
        assert!(atempo.is_none());
    }

    #[test]
    fn should_return_single_atempo_when_speed_within_range() {
        // Given a clip with speed 1.5 (within 0.5-2.0)
        let atempo = build_atempo_chain(1.5);
        // Then a single atempo filter is sufficient
        assert_eq!(atempo.unwrap(), "atempo=1.5");
    }

    #[test]
    fn should_chain_atempo_when_speed_exceeds_double() {
        // Given a clip with speed 4.0 (exceeds 2.0 limit per filter)
        let atempo = build_atempo_chain(4.0);
        // Then atempo filters are chained: 2.0 * 2.0 = 4.0
        assert_eq!(atempo.unwrap(), "atempo=2,atempo=2");
    }

    #[test]
    fn should_chain_atempo_when_speed_below_half() {
        // Given a clip with speed 0.25 (below 0.5 limit per filter)
        let atempo = build_atempo_chain(0.25);
        // Then atempo filters are chained: 0.5 * 0.5 = 0.25
        assert_eq!(atempo.unwrap(), "atempo=0.5,atempo=0.5");
    }

    #[test]
    fn should_chain_atempo_for_extreme_fast_speed() {
        // Given a clip with speed 8.0
        let atempo = build_atempo_chain(8.0);
        // Then three atempo=2 filters are chained: 2 * 2 * 2 = 8
        assert_eq!(atempo.unwrap(), "atempo=2,atempo=2,atempo=2");
    }

    #[test]
    fn should_chain_atempo_for_extreme_slow_speed() {
        // Given a clip with speed 0.125
        let atempo = build_atempo_chain(0.125);
        // Then three atempo=0.5 filters: 0.5 * 0.5 * 0.5 = 0.125
        assert_eq!(atempo.unwrap(), "atempo=0.5,atempo=0.5,atempo=0.5");
    }

    #[test]
    fn should_mix_chain_and_remainder_for_atempo() {
        // Given a clip with speed 3.0
        let atempo = build_atempo_chain(3.0);
        // Then one atempo=2 plus atempo=1.5: 2 * 1.5 = 3
        assert_eq!(atempo.unwrap(), "atempo=2,atempo=1.5");
    }

    #[test]
    fn should_format_speed_number_without_trailing_zeros() {
        assert_eq!(format_speed_number(2.0), "2");
        assert_eq!(format_speed_number(0.5), "0.5");
        assert_eq!(format_speed_number(1.5), "1.5");
        assert_eq!(format_speed_number(1.25), "1.25");
    }

    // =========================================================================
    // Video Trim Filter Tests (reverse & freeze frame)
    // =========================================================================

    #[test]
    fn should_include_reverse_filter_for_reversed_clip() {
        use crate::core::timeline::Clip;

        // Given a reversed clip
        let mut clip = Clip::new("asset_1").with_source_range(2.0, 8.0);
        clip.reverse = true;

        let mut filter = String::new();
        build_video_trim_filter(&clip, 0, "trim0", &mut filter);

        // Then filter includes the reverse filter
        assert!(
            filter.contains("reverse"),
            "should contain reverse filter: {filter}"
        );
        assert!(
            filter.contains("trim=start=2:end=8"),
            "should contain trim: {filter}"
        );
    }

    #[test]
    fn should_include_tpad_for_freeze_frame_clip() {
        use crate::core::timeline::Clip;

        // Given a freeze frame clip
        let mut clip = Clip::new("asset_1").with_source_range(5.0, 5.04);
        clip.freeze_frame = true;
        clip.place.duration_sec = 3.0;

        let mut filter = String::new();
        build_video_trim_filter(&clip, 0, "trim0", &mut filter);

        // Then filter includes tpad clone
        assert!(
            filter.contains("tpad=stop_mode=clone:stop_duration=3"),
            "should contain tpad: {filter}"
        );
    }

    #[test]
    fn should_include_areverse_for_reversed_clip_audio() {
        use crate::core::timeline::Clip;

        // Given a reversed clip
        let mut clip = Clip::new("asset_1").with_source_range(2.0, 8.0);
        clip.reverse = true;

        let mut filter = String::new();
        let result_label = build_audio_trim_filter(&clip, 0, "atrim0", &mut filter);

        // Then filter includes areverse and the label is the reversed label
        assert!(
            filter.contains("areverse"),
            "should contain areverse: {filter}"
        );
        assert_ne!(
            result_label, "atrim0",
            "label should be updated for reverse"
        );
    }

    #[test]
    fn should_combine_reverse_and_speed_in_audio() {
        use crate::core::timeline::Clip;

        // Given a reversed clip at 2x speed
        let mut clip = Clip::new("asset_1").with_source_range(0.0, 10.0);
        clip.reverse = true;
        clip.speed = 2.0;

        let mut filter = String::new();
        let result_label = build_audio_trim_filter(&clip, 0, "atrim0", &mut filter);

        // Then filter includes both areverse and atempo
        assert!(
            filter.contains("areverse"),
            "should contain areverse: {filter}"
        );
        assert!(
            filter.contains("atempo=2"),
            "should contain atempo: {filter}"
        );
        assert_eq!(result_label, "aspd0");
    }

    // =========================================================================
    // Time Remap Render Tests
    // =========================================================================

    #[test]
    fn test_time_remap_setpts_linear_2x() {
        use crate::core::timeline::{KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe};

        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        let expr = build_time_remap_setpts(&curve);
        assert_eq!(expr, "(PTS-STARTPTS)*0.5");
    }

    #[test]
    fn test_time_remap_setpts_hold() {
        use crate::core::timeline::{KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe};

        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 3.0,
                interpolation: KeyframeInterpolation::Hold,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 5.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        let expr = build_time_remap_setpts(&curve);
        // Hold: should show source_time 3 (freeze at source frame 3s)
        assert_eq!(expr, "3", "hold should produce constant: {expr}");
    }

    #[test]
    fn test_time_remap_setpts_multi_segment() {
        use crate::core::timeline::{KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe};

        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 1.0,
                source_time: 1.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 2.0,
                source_time: 4.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        let expr = build_time_remap_setpts(&curve);
        // Should contain if() for piecewise segments
        assert!(
            expr.contains("if("),
            "multi-segment should use if(): {expr}"
        );
        assert!(
            expr.contains("lt("),
            "should contain lt() comparison: {expr}"
        );
        assert!(
            expr.contains("0.333333"),
            "should use inverse slope for the 3x segment: {expr}"
        );
        assert!(
            expr.contains("lt((PTS-STARTPTS),1)"),
            "should branch on source-time thresholds: {expr}"
        );
    }

    #[test]
    fn test_time_remap_setpts_respects_non_zero_source_offsets() {
        use crate::core::timeline::{KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe};

        let curve = TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 2.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 4.0,
                source_time: 8.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]);

        let expr = build_time_remap_setpts(&curve);
        assert_eq!(expr, "(PTS-STARTPTS)*0.666667");
    }

    #[test]
    fn test_time_remap_video_filter() {
        use crate::core::timeline::{
            ClipPlace, ClipRange, KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe,
        };

        let mut clip = Clip::new("asset_1");
        clip.range = ClipRange::new(0.0, 10.0);
        clip.place = ClipPlace::new(0.0, 5.0);
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 5.0,
                source_time: 10.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));

        let mut filter = String::new();
        build_video_trim_filter(&clip, 0, "vtrim0", &mut filter);

        assert!(
            filter.contains("setpts="),
            "should contain setpts: {filter}"
        );
        assert!(
            filter.contains("[vtrim0]"),
            "should have output label: {filter}"
        );
        // Source range should cover 0 to 10
        assert!(
            filter.contains("trim=start=0:end=10"),
            "should trim full source range: {filter}"
        );
    }

    #[test]
    fn test_time_remap_audio_filter_avg_speed() {
        use crate::core::timeline::{
            ClipPlace, ClipRange, KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe,
        };

        let mut clip = Clip::new("asset_1");
        clip.range = ClipRange::new(0.0, 10.0);
        clip.place = ClipPlace::new(0.0, 5.0);
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 5.0,
                source_time: 10.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));

        let mut filter = String::new();
        let result_label = build_audio_trim_filter(&clip, 0, "atrim0", &mut filter);

        // Average speed = 10/5 = 2.0, so atempo=2
        assert!(
            filter.contains("atempo=2"),
            "should contain atempo for avg speed: {filter}"
        );
        assert_eq!(result_label, "aspd0");
    }

    // -------------------------------------------------------------------------
    // Batch & Range Render Types Tests (BDD)
    // -------------------------------------------------------------------------

    /// Feature: Batch Render Item
    /// Scenario: should serialize with camelCase field names for frontend
    #[test]
    fn batch_render_item_should_serialize_with_camel_case() {
        let item = BatchRenderItem {
            preset: "youtube_1080p".to_string(),
            output_path: "/tmp/output.mp4".to_string(),
            in_point: Some(1.5),
            out_point: Some(10.0),
        };

        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"inPoint\""), "should use camelCase: {json}");
        assert!(
            json.contains("\"outPoint\""),
            "should use camelCase: {json}"
        );
        assert!(
            json.contains("\"outputPath\""),
            "should use camelCase: {json}"
        );
    }

    /// Feature: Batch Render Item
    /// Scenario: should round-trip through JSON when range is omitted
    #[test]
    fn batch_render_item_should_round_trip_without_range() {
        let item = BatchRenderItem {
            preset: "prores".to_string(),
            output_path: "/export/final.mov".to_string(),
            in_point: None,
            out_point: None,
        };

        let json = serde_json::to_string(&item).unwrap();
        let deserialized: BatchRenderItem = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.preset, "prores");
        assert_eq!(deserialized.output_path, "/export/final.mov");
        assert!(deserialized.in_point.is_none());
        assert!(deserialized.out_point.is_none());
    }

    /// Feature: Batch Render Result
    /// Scenario: should serialize job IDs and total items for frontend consumption
    #[test]
    fn batch_render_result_should_serialize_job_ids() {
        let result = BatchRenderResult {
            batch_id: "batch_001".to_string(),
            job_ids: vec![
                "job_a".to_string(),
                "job_b".to_string(),
                "job_c".to_string(),
            ],
            total_items: 3,
            status: "started".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"batchId\""), "should use camelCase: {json}");
        assert!(json.contains("\"jobIds\""), "should use camelCase: {json}");
        assert!(
            json.contains("\"totalItems\":3"),
            "should include total: {json}"
        );
    }

    /// Feature: Render Job Status
    /// Scenario: should serialize as snake_case strings
    #[test]
    fn render_job_status_should_serialize_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&RenderJobStatus::Pending).unwrap(),
            "\"pending\""
        );
        assert_eq!(
            serde_json::to_string(&RenderJobStatus::Rendering).unwrap(),
            "\"rendering\""
        );
        assert_eq!(
            serde_json::to_string(&RenderJobStatus::Completed).unwrap(),
            "\"completed\""
        );
        assert_eq!(
            serde_json::to_string(&RenderJobStatus::Failed).unwrap(),
            "\"failed\""
        );
        assert_eq!(
            serde_json::to_string(&RenderJobStatus::Cancelled).unwrap(),
            "\"cancelled\""
        );
    }

    /// Feature: Cancel Render Job Registry
    /// Scenario: should register and cancel a render job
    #[tokio::test]
    async fn cancel_registry_should_register_and_cancel_job() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        register_render_job("test_job_cancel_1", tx).await;

        // Cancel should succeed
        assert!(cancel_render_job("test_job_cancel_1").await);

        // The receiver should be triggered
        assert!(rx.await.is_ok());

        // Second cancel should fail (already removed)
        assert!(!cancel_render_job("test_job_cancel_1").await);
    }

    /// Feature: Cancel Render Job Registry
    /// Scenario: should return false when cancelling non-existent job
    #[tokio::test]
    async fn cancel_registry_should_return_false_for_unknown_job() {
        assert!(!cancel_render_job("nonexistent_job_xyz").await);
    }

    /// Feature: Cancel Render Job Registry
    /// Scenario: should unregister job on completion without triggering cancel
    #[tokio::test]
    async fn cancel_registry_should_unregister_on_completion() {
        let (tx, _rx) = tokio::sync::oneshot::channel::<()>();
        register_render_job("test_job_complete_1", tx).await;

        // Unregister (simulating job completion)
        unregister_render_job("test_job_complete_1").await;

        // Cancel should now return false
        assert!(!cancel_render_job("test_job_complete_1").await);
    }

    /// Feature: Batch Item Result
    /// Scenario: should serialize completed item with file info
    #[test]
    fn batch_item_result_should_serialize_completed_item() {
        let item = BatchItemResult {
            job_id: "job_1".to_string(),
            output_path: "/tmp/out.mp4".to_string(),
            status: RenderJobStatus::Completed,
            duration_sec: 30.5,
            file_size: 1024 * 1024 * 50,
            encoding_time_sec: 12.3,
            error: None,
        };

        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"completed\""));
        assert!(json.contains("\"durationSec\":30.5"));
        assert!(json.contains("\"fileSize\":52428800"));
        assert!(!json.contains("\"error\":\""));
    }

    /// Feature: Batch Item Result
    /// Scenario: should serialize failed item with error message
    #[test]
    fn batch_item_result_should_serialize_failed_item() {
        let item = BatchItemResult {
            job_id: "job_2".to_string(),
            output_path: "/tmp/failed.mp4".to_string(),
            status: RenderJobStatus::Failed,
            duration_sec: 0.0,
            file_size: 0,
            encoding_time_sec: 0.0,
            error: Some("FFmpeg execution failed: codec error".to_string()),
        };

        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"failed\""));
        assert!(json.contains("codec error"));
    }

    /// Feature: Range Export via ExportSettings
    /// Scenario: should set start_time and end_time for partial export
    #[test]
    fn export_settings_should_support_range_via_start_end_time() {
        let mut settings = ExportSettings::from_preset(
            ExportPreset::Youtube1080p,
            std::path::PathBuf::from("/tmp/range.mp4"),
        );
        settings.start_time = Some(5.0);
        settings.end_time = Some(15.0);

        assert_eq!(settings.start_time, Some(5.0));
        assert_eq!(settings.end_time, Some(15.0));
        // The FFmpeg args builder uses these for -ss/-t parameters
    }

    /// Feature: Range Export
    /// Scenario: should include output range args in complex export builds
    #[test]
    fn complex_export_args_should_include_output_range_args() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("asset1")
                .with_source_range(0.0, 20.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("range_args.mp4");
        let mut asset = Asset::new_video("range_args.mp4", &video_path, VideoInfo::default())
            .with_duration(20.0)
            .with_file_size(10_000_000);
        asset.id = "asset1".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("asset1".to_string(), asset);

        let mut settings = ExportSettings::default();
        settings.output_path = std::path::PathBuf::from("/tmp/range.mp4");
        settings.start_time = Some(5.0);
        settings.end_time = Some(15.0);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &settings,
        )
        .expect("range export args should build");

        assert!(
            args.windows(2)
                .any(|window| window[0] == "-ss" && window[1] == "5"),
            "Expected output seek flag in args. Got: {:?}",
            args
        );
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-t" && window[1] == "10"),
            "Expected output duration flag in args. Got: {:?}",
            args
        );
    }

    /// Feature: Range Export Progress
    /// Scenario: should calculate export duration from the selected range
    #[test]
    fn effective_export_duration_should_respect_range_selection() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("asset1")
                .with_source_range(0.0, 20.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        assert!((effective_export_duration(&sequence, Some(5.0), Some(15.0)) - 10.0).abs() < 0.01);
        assert!((effective_export_duration(&sequence, Some(5.0), None) - 15.0).abs() < 0.01);
    }

    // =========================================================================
    // Still Image Export Tests
    // =========================================================================

    /// Feature: Image Format
    /// Scenario: should return correct extension for each format
    #[test]
    fn image_format_should_return_correct_extension() {
        assert_eq!(ImageFormat::Png.extension(), "png");
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
        assert_eq!(ImageFormat::Tiff.extension(), "tiff");
    }

    /// Feature: Image Format
    /// Scenario: should return correct pixel format for each format
    #[test]
    fn image_format_should_return_correct_pixel_format() {
        assert_eq!(ImageFormat::Png.pixel_format(), "rgba");
        assert_eq!(ImageFormat::Jpeg.pixel_format(), "yuvj420p");
        assert_eq!(ImageFormat::Tiff.pixel_format(), "rgb48le");
    }

    /// Feature: Image Format
    /// Scenario: should serialize/deserialize as snake_case
    #[test]
    fn image_format_should_roundtrip_json() {
        let formats = vec![ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Tiff];
        for fmt in &formats {
            let json = serde_json::to_string(fmt).unwrap();
            let deserialized: ImageFormat = serde_json::from_str(&json).unwrap();
            assert_eq!(&deserialized, fmt);
        }

        // Verify snake_case serialization
        assert_eq!(serde_json::to_string(&ImageFormat::Png).unwrap(), "\"png\"");
        assert_eq!(
            serde_json::to_string(&ImageFormat::Jpeg).unwrap(),
            "\"jpeg\""
        );
        assert_eq!(
            serde_json::to_string(&ImageFormat::Tiff).unwrap(),
            "\"tiff\""
        );
    }

    /// Feature: Frame Export Settings
    /// Scenario: should reject negative time position
    #[test]
    fn frame_export_settings_should_reject_negative_time() {
        let settings = FrameExportSettings {
            time_sec: -1.0,
            format: ImageFormat::Png,
            output_path: PathBuf::from("/tmp/frame.png"),
            quality: None,
        };
        let result = settings.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("non-negative"));
    }

    /// Feature: Frame Export Settings
    /// Scenario: should reject invalid JPEG quality
    #[test]
    fn frame_export_settings_should_reject_invalid_jpeg_quality() {
        let settings = FrameExportSettings {
            time_sec: 1.0,
            format: ImageFormat::Jpeg,
            output_path: PathBuf::from("/tmp/frame.jpg"),
            quality: Some(0),
        };
        assert!(settings.validate().is_err());

        let settings_too_high = FrameExportSettings {
            quality: Some(32),
            ..settings
        };
        assert!(settings_too_high.validate().is_err());
    }

    /// Feature: Frame Export Settings
    /// Scenario: should accept valid settings
    #[test]
    fn frame_export_settings_should_accept_valid_settings() {
        let settings = FrameExportSettings {
            time_sec: 5.5,
            format: ImageFormat::Png,
            output_path: std::env::temp_dir().join("frame.png"),
            quality: None,
        };
        assert!(settings.validate().is_ok());
    }

    /// Feature: Frame Export Settings
    /// Scenario: should allow creating a missing output directory
    #[test]
    fn frame_export_settings_should_allow_missing_output_directory() {
        let temp_dir = tempfile::tempdir().unwrap();
        let settings = FrameExportSettings {
            time_sec: 5.5,
            format: ImageFormat::Png,
            output_path: temp_dir.path().join("frames/stills/frame.png"),
            quality: None,
        };
        assert!(settings.validate().is_ok());
    }

    /// Feature: Frame Export Result
    /// Scenario: should serialize to camelCase JSON
    #[test]
    fn frame_export_result_should_serialize_to_camel_case() {
        let result = FrameExportResult {
            output_path: PathBuf::from("/tmp/frame.png"),
            file_size: 1024,
            format: ImageFormat::Png,
            width: 1920,
            height: 1080,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"outputPath\""));
        assert!(json.contains("\"fileSize\""));
        assert!(json.contains("\"width\""));
        assert!(json.contains("\"height\""));
    }

    // =========================================================================
    // Audio-Only Export Tests
    // =========================================================================

    /// Feature: Audio Export Format
    /// Scenario: should return correct extension for each format
    #[test]
    fn audio_export_format_should_return_correct_extension() {
        assert_eq!(AudioExportFormat::Wav.extension(), "wav");
        assert_eq!(AudioExportFormat::Mp3.extension(), "mp3");
        assert_eq!(AudioExportFormat::Flac.extension(), "flac");
    }

    /// Feature: Audio Export Format
    /// Scenario: should return correct FFmpeg codec for each format
    #[test]
    fn audio_export_format_should_return_correct_codec() {
        assert_eq!(AudioExportFormat::Wav.codec(), "pcm_s16le");
        assert_eq!(AudioExportFormat::Mp3.codec(), "libmp3lame");
        assert_eq!(AudioExportFormat::Flac.codec(), "flac");
    }

    /// Feature: Audio Export Format
    /// Scenario: should return default bitrate only for lossy formats
    #[test]
    fn audio_export_format_should_return_default_bitrate_only_for_lossy() {
        assert!(AudioExportFormat::Wav.default_bitrate().is_none());
        assert!(AudioExportFormat::Flac.default_bitrate().is_none());
        assert_eq!(AudioExportFormat::Mp3.default_bitrate(), Some("320k"));
    }

    /// Feature: Audio Export Format
    /// Scenario: should serialize/deserialize as snake_case
    #[test]
    fn audio_export_format_should_roundtrip_json() {
        let formats = vec![
            AudioExportFormat::Wav,
            AudioExportFormat::Mp3,
            AudioExportFormat::Flac,
        ];
        for fmt in &formats {
            let json = serde_json::to_string(fmt).unwrap();
            let deserialized: AudioExportFormat = serde_json::from_str(&json).unwrap();
            assert_eq!(&deserialized, fmt);
        }
    }

    /// Feature: Audio Export Settings
    /// Scenario: should reject end_time <= start_time
    #[test]
    fn audio_export_settings_should_reject_invalid_range() {
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: PathBuf::from("/tmp/audio.wav"),
            bitrate: None,
            sample_rate: None,
            start_time: Some(10.0),
            end_time: Some(5.0),
        };
        let result = settings.validate();
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("greater than start"));
    }

    /// Feature: Audio Export Settings
    /// Scenario: should reject invalid sample rate
    #[test]
    fn audio_export_settings_should_reject_invalid_sample_rate() {
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: std::env::temp_dir().join("audio.wav"),
            bitrate: None,
            sample_rate: Some(0),
            start_time: None,
            end_time: None,
        };
        assert!(settings.validate().is_err());

        let settings_too_high = AudioExportSettings {
            sample_rate: Some(200_000),
            ..settings
        };
        assert!(settings_too_high.validate().is_err());
    }

    /// Feature: Audio Export Settings
    /// Scenario: should convert to ExportSettings with correct audio codec
    #[test]
    fn audio_export_settings_should_convert_to_export_settings() {
        let settings = AudioExportSettings {
            format: AudioExportFormat::Mp3,
            output_path: PathBuf::from("/tmp/audio.mp3"),
            bitrate: Some("256k".to_string()),
            sample_rate: Some(44100),
            start_time: None,
            end_time: None,
        };
        let export = settings.to_export_settings();

        assert_eq!(export.audio_codec, AudioCodec::Mp3);
        assert_eq!(export.audio_bitrate, Some("256k".to_string()));
        assert_eq!(export.preset, ExportPreset::Custom);
        assert!(export.video_bitrate.is_none());
        assert!(export.fps.is_none());
    }

    /// Feature: Audio Export Settings
    /// Scenario: should use default bitrate when none specified
    #[test]
    fn audio_export_settings_should_use_default_bitrate_when_none() {
        let settings = AudioExportSettings {
            format: AudioExportFormat::Mp3,
            output_path: PathBuf::from("/tmp/audio.mp3"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        };
        let export = settings.to_export_settings();
        assert_eq!(export.audio_bitrate, Some("320k".to_string()));
    }

    /// Feature: Audio Export Settings
    /// Scenario: should accept valid WAV settings with no bitrate
    #[test]
    fn audio_export_settings_should_accept_valid_wav() {
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: std::env::temp_dir().join("audio.wav"),
            bitrate: None,
            sample_rate: Some(48000),
            start_time: None,
            end_time: None,
        };
        assert!(settings.validate().is_ok());

        let export = settings.to_export_settings();
        assert_eq!(export.audio_codec, AudioCodec::Pcm);
        assert!(export.audio_bitrate.is_none());
    }

    /// Feature: Audio Export Settings
    /// Scenario: should allow creating a missing output directory
    #[test]
    fn audio_export_settings_should_allow_missing_output_directory() {
        let temp_dir = tempfile::tempdir().unwrap();
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: temp_dir.path().join("audio/output/final.wav"),
            bitrate: None,
            sample_rate: Some(48000),
            start_time: None,
            end_time: None,
        };
        assert!(settings.validate().is_ok());
    }

    /// Feature: Audio Export Result
    /// Scenario: should serialize to camelCase JSON
    #[test]
    fn audio_export_result_should_serialize_to_camel_case() {
        let result = AudioExportResult {
            output_path: PathBuf::from("/tmp/audio.wav"),
            duration_sec: 120.5,
            file_size: 204800,
            format: AudioExportFormat::Wav,
            encoding_time_sec: 3.2,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"outputPath\""));
        assert!(json.contains("\"durationSec\""));
        assert!(json.contains("\"fileSize\""));
        assert!(json.contains("\"encodingTimeSec\""));

        // Round-trip
        let deserialized: AudioExportResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.file_size, 204800);
        assert!((deserialized.duration_sec - 120.5).abs() < 0.01);
    }
}
