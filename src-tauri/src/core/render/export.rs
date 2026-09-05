//! Export Engine Module
//!
//! Handles final video export using FFmpeg.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;
use tokio::sync::mpsc::Sender;

use crate::core::{
    assets::{Asset, AssetKind},
    captions::{
        CAPTION_CUSTOM_DEFAULT_Y_PERCENT, CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT,
        CAPTION_SIDE_MARGIN_PERCENT,
    },
    commands::TEXT_ASSET_PREFIX,
    effects::{
        effect_capability, effect_type_label, effect_type_supports_timeline_enable, Effect,
        EffectType, FilterGraph, IntoFFmpegFilter, ParamValue, BRANCH_OFFSET_PARAM,
    },
    ffmpeg::FFmpegRunner,
    fs::validate_local_input_path,
    render::hdr::{build_tonemap_filter, HdrMetadata, TonemapMode, TonemapParams},
    render::render_window::RenderWindow,
    render::transform_layout::{
        clip_motion_renders_animated, opacity_needs_alpha_filter, ClipMotionTrack,
        ClipTransformLayout, MotionKeyframeLayout,
    },
    render::transition_stitch::{
        plan_sequence_transitions, ClipHandles, EngineAudioFades, TransitionPlan,
    },
    render::{
        build_ffmpeg_invocation_for_render_plan, build_ffmpeg_invocation_from_args,
        execute_ffmpeg_invocation, execute_ffmpeg_output, RenderPlan,
    },
    timeline::{
        BlendMode, Canvas, Clip, Sequence, SlowMotionInterpolation, TimelineClock, Track,
        TrackKind, Transform,
    },
};

pub(super) fn hdr_metadata_for_asset(asset: &Asset) -> HdrMetadata {
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

pub(super) fn effective_blend_mode_for_clip(clip: &Clip, track: &Track) -> BlendMode {
    if clip.blend_mode != BlendMode::Normal {
        return clip.blend_mode.clone();
    }

    track.blend_mode.clone()
}

/// Whether a track's contents reach the exported file at all.
///
/// A hidden or muted track is dropped before the argument builders ever see it,
/// so nothing on it is in the picture. Shared with the frame probe, whose
/// fast-mode warning describes what the composited still would have held: a
/// warning scan over a wider set of tracks than the renderer draws would name
/// content that is not in either picture.
pub fn track_included_in_export(track: &Track) -> bool {
    match track.kind {
        TrackKind::Video | TrackKind::Overlay | TrackKind::Caption => track.visible && !track.muted,
        TrackKind::Audio => !track.muted,
    }
}

/// Tracks whose clips are collected into the FFmpeg argument builders.
///
/// Delegates to [`Track::contributes_to_output`] so this filter and
/// [`Sequence::output_duration`] — the length the builders pad the output to —
/// always describe the same set of clips.
fn track_included_in_media_collection(track: &Track) -> bool {
    track.contributes_to_output()
}

pub(super) fn asset_has_playable_audio(
    asset: &Asset,
    track_kind: &TrackKind,
    audio_info: Option<&AssetAudioInfo>,
) -> bool {
    match asset.kind {
        AssetKind::Audio => true,
        AssetKind::Video => {
            if matches!(track_kind, TrackKind::Audio) {
                return audio_info.map(|info| info.has_audio).unwrap_or(true);
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

pub(super) fn collect_audio_companion_keys(
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

pub(super) fn clip_audio_is_suppressed_by_companion(
    clip: &Clip,
    track: &Track,
    asset: &Asset,
    audio_companion_keys: &HashSet<String>,
) -> bool {
    track.kind != TrackKind::Audio
        && asset.kind == AssetKind::Video
        && audio_companion_keys.contains(&create_audio_companion_key(clip))
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

/// Accepted values for [`ExportSettings::encoder_speed`], ordered fastest to slowest.
///
/// These are the x264/x265 `-preset` names. Faster values encode quicker at the cost
/// of compression efficiency, which is the trade-off proxy and preview renders want.
pub const ENCODER_SPEED_VALUES: &[&str] = &[
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
    "placebo",
];

/// Returns true when `value` is a supported software encoder speed preset.
///
/// Matching is case-insensitive and ignores surrounding whitespace so CLI and IPC
/// callers do not have to normalize input themselves.
pub fn is_valid_encoder_speed(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    ENCODER_SPEED_VALUES.contains(&normalized.as_str())
}

/// Export preset type
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportPreset {
    /// YouTube 1080p (H.264, AAC)
    Youtube1080p,
    /// Draft MP4 (H.264, AAC, 720p)
    Mp4Draft,
    /// High quality MP4 (H.264, AAC, 1080p)
    Mp4High,
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
    /// ProRes
    ProRes,
    /// Custom settings
    Custom,
}

impl ExportPreset {
    /// Parse a legacy preset identifier.
    pub fn from_legacy_id(preset: &str) -> Result<Self, ExportError> {
        let normalized = preset.trim().to_ascii_lowercase().replace(['-', ' '], "_");

        match normalized.as_str() {
            "youtube_1080p" | "youtube1080p" | "youtube_1080" | "mp4_h264_1080p" => {
                Ok(Self::Youtube1080p)
            }
            "mp4_draft" | "mp4_h264_720p" | "mp4_h264_draft" => Ok(Self::Mp4Draft),
            "mp4_high" | "mp4_h264_high" | "mp4_h264_1080p_high" => Ok(Self::Mp4High),
            "youtube_4k" | "youtube4k" | "youtube_2160p" | "mp4_h264_4k" | "mp4_h264_2160p" => {
                Ok(Self::Youtube4k)
            }
            "youtube_shorts" | "youtubeshorts" | "shorts_reels" => Ok(Self::YoutubeShorts),
            "twitter" => Ok(Self::Twitter),
            "instagram" => Ok(Self::Instagram),
            "webm" | "webm_vp9" | "webm_vp9_1080p" | "webm_vp9_720p" => Ok(Self::WebmVp9),
            "prores" | "prores_422" => Ok(Self::ProRes),
            other => Err(ExportError::InvalidSettings(format!(
                "Unknown export preset: {other}"
            ))),
        }
    }
}

/// Video codec selection
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
    H265,
    #[serde(rename = "vp9")]
    Vp9,
    #[serde(rename = "prores")]
    ProRes,
    // Ut Video: mathematically lossless, intra-frame, `gbrp`. Records the
    // compositor's own planes verbatim — no colorspace conversion, no chroma
    // subsampling, no quantization — and has no quality knob (no CRF). See
    // `ExportSettings::preview_cache`, its only caller.
    #[serde(rename = "utvideo")]
    UtVideo,
    Copy,
}

/// Audio codec selection
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AudioCodec {
    Aac,
    #[serde(rename = "mp3")]
    Mp3,
    Opus,
    Pcm,
    Copy,
}

/// HDR (High Dynamic Range) mode for export
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
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

/// Output media container.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ContainerFormat {
    /// MPEG-4 container, typically H.264/H.265 + AAC.
    #[default]
    #[serde(rename = "mp4")]
    Mp4,
    /// QuickTime container for ProRes/H.264/H.265 delivery and masters.
    Mov,
    /// WebM container for VP9/Opus delivery.
    Webm,
}

impl ContainerFormat {
    pub fn extension(&self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Webm => "webm",
        }
    }
}

/// User-facing quality tier that maps to concrete encoder settings.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportQualityTier {
    /// Fast, lower-bitrate review export.
    Draft,
    /// Balanced default delivery.
    #[default]
    Standard,
    /// Higher-quality web delivery.
    High,
    /// Editing/mastering-oriented output.
    Master,
    /// Caller supplied explicit bitrate/CRF settings.
    Custom,
}

/// Structured video export request used by UI and agent-driven export paths.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoExportRequest {
    pub container: ContainerFormat,
    pub video_codec: VideoCodec,
    pub audio_codec: AudioCodec,
    pub quality_tier: ExportQualityTier,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_bitrate: Option<String>,
    pub audio_bitrate: Option<String>,
    pub crf: Option<u8>,
    #[serde(default)]
    pub two_pass: bool,
    #[serde(default)]
    pub hdr_mode: HdrMode,
    pub max_cll: Option<u32>,
    pub max_fall: Option<u32>,
    pub bit_depth: Option<u8>,
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
    /// Encoder speed/compression trade-off for software x264/x265 encoding.
    ///
    /// Maps directly to FFmpeg's `-preset` argument. Accepted values are listed in
    /// [`ENCODER_SPEED_VALUES`] (`ultrafast` … `placebo`). When `None` no `-preset`
    /// argument is emitted and FFmpeg's own default applies. Silently ignored for
    /// hardware encoders and for codecs that do not accept `-preset` (VP9, ProRes),
    /// which carry their own tuning parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoder_speed: Option<String>,
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
            encoder_speed: None,
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

    /// Build the `-preset` arguments for the resolved encoder, if any.
    ///
    /// Only software x264/x265 accept the `ultrafast … placebo` preset ladder.
    /// Hardware encoders use their own preset namespace (handled by
    /// [`resolve_quality_args`](super::hardware::resolve_quality_args)) and VP9/ProRes
    /// have no equivalent, so this returns an empty vector for them rather than
    /// emitting an argument FFmpeg would reject.
    pub fn encoder_speed_args(&self, encoder_name: &str) -> Vec<String> {
        let Some(speed) = self.encoder_speed.as_deref() else {
            return Vec::new();
        };
        if !matches!(encoder_name, "libx264" | "libx265") {
            return Vec::new();
        }
        let normalized = speed.trim().to_ascii_lowercase();
        if !is_valid_encoder_speed(&normalized) {
            return Vec::new();
        }
        vec!["-preset".to_string(), normalized]
    }

    /// Get the resolved audio encoder name for FFmpeg.
    pub fn audio_encoder_name(&self) -> &'static str {
        match self.audio_codec {
            AudioCodec::Aac => "aac",
            AudioCodec::Mp3 => "libmp3lame",
            AudioCodec::Opus => "libopus",
            AudioCodec::Pcm => "pcm_s16le",
            AudioCodec::Copy => "copy",
        }
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
                encoder_speed: None,
            },
            ExportPreset::Mp4Draft => Self {
                preset: ExportPreset::Mp4Draft,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1280),
                height: Some(720),
                video_bitrate: Some("3M".to_string()),
                audio_bitrate: Some("128k".to_string()),
                fps: Some(30.0),
                crf: Some(28),
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
                encoder_speed: None,
            },
            ExportPreset::Mp4High => Self {
                preset: ExportPreset::Mp4High,
                output_path,
                video_codec: VideoCodec::H264,
                audio_codec: AudioCodec::Aac,
                width: Some(1920),
                height: Some(1080),
                video_bitrate: Some("15M".to_string()),
                audio_bitrate: Some("320k".to_string()),
                fps: Some(30.0),
                crf: Some(18),
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
                encoder_speed: None,
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
                encoder_speed: None,
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
                encoder_speed: None,
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
                encoder_speed: None,
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
                encoder_speed: None,
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
                encoder_speed: None,
            },
            ExportPreset::ProRes => Self {
                preset: ExportPreset::ProRes,
                output_path,
                video_codec: VideoCodec::ProRes,
                audio_codec: AudioCodec::Pcm,
                width: None,
                height: None,
                video_bitrate: None,
                audio_bitrate: None,
                fps: None,
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
                encoder_speed: None,
            },
            ExportPreset::Custom => Self {
                preset: ExportPreset::Custom,
                output_path,
                ..Default::default()
            },
        }
    }

    /// Create settings from a structured video export request.
    pub fn from_video_request(
        request: &VideoExportRequest,
        output_path: PathBuf,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> Result<Self, ExportError> {
        validate_video_export_request(request, &output_path)?;

        Ok(Self {
            preset: ExportPreset::Custom,
            output_path,
            video_codec: request.video_codec.clone(),
            audio_codec: request.audio_codec.clone(),
            width: request.width,
            height: request.height,
            video_bitrate: request.video_bitrate.clone(),
            audio_bitrate: request.audio_bitrate.clone(),
            fps: request.fps,
            crf: request.crf,
            two_pass: request.two_pass,
            start_time,
            end_time,
            hdr_mode: request.hdr_mode.clone(),
            max_cll: request.max_cll,
            max_fall: request.max_fall,
            bit_depth: request.bit_depth,
            tonemap_mode: None,
            hardware_accel: super::hardware::HardwareAccelMode::default(),
            resolved_encoder_name: None,
            encoder_speed: None,
        })
    }

    /// Create a structured request from a legacy preset.
    pub fn request_from_preset(preset: ExportPreset) -> VideoExportRequest {
        let settings = Self::from_preset(
            preset.clone(),
            PathBuf::from(format!(
                "output.{}",
                preset_default_container(&preset).extension()
            )),
        );

        VideoExportRequest {
            container: preset_default_container(&preset),
            video_codec: settings.video_codec,
            audio_codec: settings.audio_codec,
            quality_tier: preset_default_quality_tier(&preset),
            width: settings.width,
            height: settings.height,
            fps: settings.fps,
            video_bitrate: settings.video_bitrate,
            audio_bitrate: settings.audio_bitrate,
            crf: settings.crf,
            two_pass: settings.two_pass,
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
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
            encoder_speed: None,
        }
    }

    /// Create render-cache settings: the profile the preview render cache
    /// pre-renders timeline segments with.
    ///
    /// The render cache exists to be a pixel-accurate stand-in for the export,
    /// so this profile deliberately keeps the sequence's own frame:
    /// - **full sequence resolution** (`canvas.width` x `canvas.height`), *not*
    ///   the 480p-class [`proxy_frame_dimensions`] downscale. A downscaled
    ///   preview diverges from the export because font sizes, blur radii and
    ///   stroke widths are absolute pixels and do not scale with the frame — the
    ///   cached picture would no longer be what export produces. Rendering at the
    ///   canvas also means a 1080x1920 vertical sequence is never pillarboxed
    ///   into a landscape frame, which a fixed 1280x720 profile guarantees.
    /// - **frame rate follows the sequence** (`fps: None`), so cached segments
    ///   carry the sequence's own cadence rather than a fixed 30 fps.
    /// - **no target bitrate and no CRF** — the codec below is lossless, so
    ///   there is no quality knob to set. `crf` must stay `None`:
    ///   [`validate_video_export_request`] rejects a CRF on a codec with no CRF
    ///   range, and the cache fill validates every segment before rendering it.
    /// - **`encoder_speed: None`** — the x264 preset ladder does not apply to
    ///   this encoder, and a value here would only bake a dead string into the
    ///   profile hash.
    ///
    /// # Fidelity
    ///
    /// The picture is encoded with **Ut Video ([`VideoCodec::UtVideo`]) in a
    /// `.mov`, pixel format `gbrp`** — mathematically lossless. The compositor
    /// works in `gbrap`; here the alpha plane (opaque everywhere, since every
    /// layer is overlaid onto an opaque black backdrop) is dropped to `gbrp` and
    /// the remaining planes are recorded verbatim — no colorspace conversion, no
    /// chroma subsampling and no quantization — so a decoded cache frame is
    /// **byte-identical** to the export composite (0/255 error, infinite PSNR). That matters because an agent judges these frames: the
    /// H.264 4:2:0 profile this replaced measured up to 9/255 error on
    /// gradients and 155/255 on hard chroma edges such as text and UI, which is
    /// the difference between reviewing the edit and reviewing the codec. Every
    /// frame is a keyframe, so any frame is a seek target.
    ///
    /// ## Where the byte-identical property comes from — and what would break it
    ///
    /// Lossless encoding removes the codec from the equation; the other half of
    /// the property is that a *windowed* segment render runs the same filter
    /// graph over the same frames as the full export. That holds today because
    /// windowed renders fold in absolute time and decode whole inputs — nothing
    /// is seek-pruned — so even a temporal filter (one that consumes multiple
    /// source frames per output frame; currently only `vidstabtransform` via
    /// `EffectType::Stabilize`) sees identical context in both paths. Two future
    /// changes would silently break this and must add lead-in handles (render
    /// extra frames before the window and discard them) for segments containing
    /// temporal filters: input-side seek pruning of windowed renders, or a new
    /// effect mapping to a temporal ffmpeg filter. A tripwire test in
    /// `core::effects::capabilities` pins the temporal-filter set so the second
    /// change cannot land unnoticed.
    ///
    /// The cost is size: roughly 45x an H.264 draft encode, about 77.5 MB per
    /// second of 1080p timeline. The default cache budget is sized for that
    /// (see `PerformanceSettings::cache_size_mb`).
    ///
    /// This is distinct from [`ExportSettings::preview`], which stays a fixed
    /// 720p30 profile for the one-off preview render job and the CLI's frame
    /// extraction.
    ///
    /// # Arguments
    ///
    /// * `output_path` - Path where the cached segment will be written
    /// * `canvas` - The sequence canvas the segment is rendered at
    /// * `start_time` - Optional start time in seconds for the segment window
    /// * `end_time` - Optional end time in seconds for the segment window
    pub fn preview_cache(
        output_path: PathBuf,
        canvas: &Canvas,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> Self {
        Self {
            preset: ExportPreset::Custom,
            output_path,
            video_codec: VideoCodec::UtVideo,
            audio_codec: AudioCodec::Aac,
            width: Some(canvas.width),
            height: Some(canvas.height),
            video_bitrate: None,
            audio_bitrate: Some("128k".to_string()),
            fps: None,
            crf: None,
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
            encoder_speed: None,
        }
    }

    /// Builds settings from a preset identifier, the proxy profile included.
    ///
    /// [`ExportPreset::from_legacy_id`] answers for the fixed-frame presets
    /// only. The proxy is not one of them — it is fitted to the sequence canvas
    /// rather than to a frame the enum could name — so it is routed first, and
    /// routing it *here* rather than at each call site is what stops a surface
    /// from advertising `proxy_480p` and then rejecting it as unknown.
    ///
    /// `canvas` is only read for the proxy profile; every other preset carries
    /// its own frame.
    pub fn from_preset_id(
        preset: &str,
        output_path: PathBuf,
        canvas: &Canvas,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> Result<Self, ExportError> {
        if is_proxy_preset_id(preset) {
            return Ok(Self::proxy(output_path, canvas, start_time, end_time));
        }

        let mut settings = Self::from_preset(ExportPreset::from_legacy_id(preset)?, output_path);
        settings.start_time = start_time;
        settings.end_time = end_time;
        Ok(settings)
    }

    /// Create proxy render settings optimized for machine inspection and fast turnaround.
    ///
    /// Proxy renders exist so an agent (or a human) can look at what the timeline
    /// currently produces without paying for a full-quality encode:
    /// - a 480p-class frame that follows the sequence aspect ratio (see
    ///   [`proxy_frame_dimensions`]) — enough detail for visual QC, cheap to decode
    /// - CRF 30 with no target bitrate — quality-driven, small files
    /// - 96 kbps AAC — intelligible speech, negligible cost
    /// - `ultrafast` x264 preset — encode speed over compression efficiency
    /// - Frame rate follows the sequence (`fps: None`)
    ///
    /// The canvas is a parameter because a fixed 854x480 frame pillarboxes every
    /// sequence that is not 16:9 — a 1080x1920 vertical edit would arrive with
    /// 270 px of usable picture inside a landscape frame.
    ///
    /// # Arguments
    ///
    /// * `output_path` - Path where the proxy video will be saved
    /// * `canvas` - The sequence canvas the proxy frame is fitted to
    /// * `start_time` - Optional start time in seconds for a partial render
    /// * `end_time` - Optional end time in seconds for a partial render
    pub fn proxy(
        output_path: PathBuf,
        canvas: &Canvas,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> Self {
        let (width, height) = proxy_frame_dimensions(canvas.width, canvas.height);

        Self {
            preset: ExportPreset::Custom,
            output_path,
            video_codec: VideoCodec::H264,
            audio_codec: AudioCodec::Aac,
            width: Some(width),
            height: Some(height),
            video_bitrate: None,
            audio_bitrate: Some("96k".to_string()),
            fps: None,
            crf: Some(30),
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
            encoder_speed: Some("ultrafast".to_string()),
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

fn preset_default_container(preset: &ExportPreset) -> ContainerFormat {
    match preset {
        ExportPreset::WebmVp9 => ContainerFormat::Webm,
        ExportPreset::ProRes => ContainerFormat::Mov,
        ExportPreset::Youtube1080p
        | ExportPreset::Mp4Draft
        | ExportPreset::Mp4High
        | ExportPreset::Youtube4k
        | ExportPreset::YoutubeShorts
        | ExportPreset::Twitter
        | ExportPreset::Instagram
        | ExportPreset::Custom => ContainerFormat::Mp4,
    }
}

fn preset_default_quality_tier(preset: &ExportPreset) -> ExportQualityTier {
    match preset {
        ExportPreset::Mp4Draft | ExportPreset::Twitter => ExportQualityTier::Draft,
        ExportPreset::Mp4High | ExportPreset::Youtube4k | ExportPreset::WebmVp9 => {
            ExportQualityTier::High
        }
        ExportPreset::ProRes => ExportQualityTier::Master,
        ExportPreset::Youtube1080p | ExportPreset::YoutubeShorts | ExportPreset::Instagram => {
            ExportQualityTier::Standard
        }
        ExportPreset::Custom => ExportQualityTier::Custom,
    }
}

fn output_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.trim_start_matches('.').to_ascii_lowercase())
}

fn bitrate_is_valid(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }

    let split_at = value
        .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
        .unwrap_or(value.len());
    let (number, suffix) = value.split_at(split_at);

    if number.is_empty() || number == "." {
        return false;
    }

    let Ok(parsed) = number.parse::<f64>() else {
        return false;
    };

    parsed.is_finite()
        && parsed > 0.0
        && matches!(
            suffix.to_ascii_lowercase().as_str(),
            "" | "k" | "m" | "g" | "kbps" | "mbps"
        )
}

fn crf_range_for_codec(codec: &VideoCodec) -> Option<std::ops::RangeInclusive<u8>> {
    match codec {
        VideoCodec::H264 | VideoCodec::H265 => Some(0..=51),
        VideoCodec::Vp9 => Some(0..=63),
        VideoCodec::ProRes | VideoCodec::UtVideo | VideoCodec::Copy => None,
    }
}

fn container_supports_video_codec(container: &ContainerFormat, codec: &VideoCodec) -> bool {
    matches!(
        (container, codec),
        (ContainerFormat::Mp4, VideoCodec::H264 | VideoCodec::H265)
            | (
                ContainerFormat::Mov,
                VideoCodec::H264 | VideoCodec::H265 | VideoCodec::ProRes | VideoCodec::UtVideo
            )
            | (ContainerFormat::Webm, VideoCodec::Vp9)
    )
}

fn container_supports_audio_codec(container: &ContainerFormat, codec: &AudioCodec) -> bool {
    matches!(
        (container, codec),
        (ContainerFormat::Mp4, AudioCodec::Aac | AudioCodec::Mp3)
            | (
                ContainerFormat::Mov,
                AudioCodec::Aac | AudioCodec::Mp3 | AudioCodec::Pcm
            )
            | (ContainerFormat::Webm, AudioCodec::Opus)
    )
}

fn container_supports_extension(container: &ContainerFormat, extension: &str) -> bool {
    matches!(
        (container, extension),
        (ContainerFormat::Mp4, "mp4" | "m4v")
            | (ContainerFormat::Mov, "mov")
            | (ContainerFormat::Webm, "webm")
    )
}

/// Validate a structured video export request before render setup.
pub fn validate_video_export_request(
    request: &VideoExportRequest,
    output_path: &Path,
) -> Result<(), ExportError> {
    let expected_ext = request.container.extension();
    let actual_ext = output_extension(output_path).ok_or_else(|| {
        ExportError::InvalidSettings("Output path must include a file extension".to_string())
    })?;
    if !container_supports_extension(&request.container, &actual_ext) {
        return Err(ExportError::InvalidSettings(format!(
            "Output extension '.{}' does not match selected container '{}'",
            actual_ext, expected_ext
        )));
    }

    if !container_supports_video_codec(&request.container, &request.video_codec) {
        return Err(ExportError::InvalidSettings(format!(
            "Container {:?} does not support video codec {:?}",
            request.container, request.video_codec
        )));
    }

    if !container_supports_audio_codec(&request.container, &request.audio_codec) {
        return Err(ExportError::InvalidSettings(format!(
            "Container {:?} does not support audio codec {:?}",
            request.container, request.audio_codec
        )));
    }

    match (request.width, request.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {}
        (None, None) => {}
        _ => {
            return Err(ExportError::InvalidSettings(
                "Export resolution must provide both width and height, or neither".to_string(),
            ));
        }
    }

    if let Some(fps) = request.fps {
        if !fps.is_finite() || fps <= 0.0 || fps > 240.0 {
            return Err(ExportError::InvalidSettings(
                "Frame rate must be greater than 0 and no more than 240 fps".to_string(),
            ));
        }
    }

    if let Some(ref bitrate) = request.video_bitrate {
        if !bitrate_is_valid(bitrate) {
            return Err(ExportError::InvalidSettings(format!(
                "Invalid video bitrate: {bitrate}"
            )));
        }
    }

    if let Some(ref bitrate) = request.audio_bitrate {
        if !bitrate_is_valid(bitrate) {
            return Err(ExportError::InvalidSettings(format!(
                "Invalid audio bitrate: {bitrate}"
            )));
        }
    }

    if let Some(crf) = request.crf {
        let Some(range) = crf_range_for_codec(&request.video_codec) else {
            return Err(ExportError::InvalidSettings(format!(
                "Codec {:?} does not support CRF/CQ quality control",
                request.video_codec
            )));
        };
        if !range.contains(&crf) {
            return Err(ExportError::InvalidSettings(format!(
                "CRF/CQ value {} is outside the supported range for {:?}",
                crf, request.video_codec
            )));
        }
    }

    if request.two_pass {
        return Err(ExportError::InvalidSettings(
            "Two-pass export is not exposed until pass-one/pass-two execution is implemented"
                .to_string(),
        ));
    }

    if !matches!(request.hdr_mode, HdrMode::Sdr) {
        if !matches!(request.video_codec, VideoCodec::H265) {
            return Err(ExportError::InvalidSettings(format!(
                "HDR export requires H.265 (HEVC) codec. Current codec: {:?}. H.264 does not support HDR metadata.",
                request.video_codec
            )));
        }

        if request.bit_depth.unwrap_or(8) < 10 {
            return Err(ExportError::InvalidSettings(
                "HDR export requires 10-bit or higher color depth".to_string(),
            ));
        }

        if matches!(request.hdr_mode, HdrMode::Hdr10) {
            if let (Some(max_cll), Some(max_fall)) = (request.max_cll, request.max_fall) {
                if max_fall > max_cll {
                    return Err(ExportError::InvalidSettings(
                        "HDR10 MaxFALL must be less than or equal to MaxCLL".to_string(),
                    ));
                }
            }
        }
    }

    Ok(())
}

fn container_from_output_path(path: &Path) -> Result<ContainerFormat, ExportError> {
    match output_extension(path).as_deref() {
        Some("mp4") | Some("m4v") => Ok(ContainerFormat::Mp4),
        Some("mov") => Ok(ContainerFormat::Mov),
        Some("webm") => Ok(ContainerFormat::Webm),
        Some(ext) => Err(ExportError::InvalidSettings(format!(
            "Unsupported video output extension: .{ext}"
        ))),
        None => Err(ExportError::InvalidSettings(
            "Output path must include a file extension".to_string(),
        )),
    }
}

fn validate_export_settings_options(settings: &ExportSettings) -> Vec<String> {
    let mut errors = Vec::new();
    let container = match container_from_output_path(&settings.output_path) {
        Ok(container) => container,
        Err(error) => {
            errors.push(error.to_string());
            return errors;
        }
    };

    let request = VideoExportRequest {
        container,
        video_codec: settings.video_codec.clone(),
        audio_codec: settings.audio_codec.clone(),
        quality_tier: ExportQualityTier::Custom,
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        video_bitrate: settings.video_bitrate.clone(),
        audio_bitrate: settings.audio_bitrate.clone(),
        crf: settings.crf,
        two_pass: settings.two_pass,
        hdr_mode: settings.hdr_mode.clone(),
        max_cll: settings.max_cll,
        max_fall: settings.max_fall,
        bit_depth: settings.bit_depth,
    };

    if let Err(error) = validate_video_export_request(&request, &settings.output_path) {
        errors.push(error.to_string());
    }

    if let Some(error) = settings.validate_hdr_settings() {
        errors.push(error);
    }

    if let Some(ref speed) = settings.encoder_speed {
        if !is_valid_encoder_speed(speed) {
            errors.push(format!(
                "Invalid encoder speed '{}'. Supported values: {}",
                speed,
                ENCODER_SPEED_VALUES.join(", ")
            ));
        }
    }

    errors
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
    /// Optional structured export settings. When omitted, `preset` is used.
    #[serde(default)]
    pub settings: Option<VideoExportRequest>,
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Optional maximum output width in pixels.
    ///
    /// `None` exports at the source's native resolution. When set, the frame is
    /// downscaled to at most this width with the aspect ratio preserved;
    /// narrower sources are never upscaled.
    #[serde(default)]
    pub max_width: Option<u32>,
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

        if let Some(max_width) = self.max_width {
            if max_width == 0 {
                return Err(ExportError::InvalidSettings(
                    "Maximum width must be greater than zero".to_string(),
                ));
            }
        }

        Ok(())
    }
}

/// Computes the output dimensions of FFmpeg's `scale='min(max_width,iw)':-2`.
///
/// The width is clamped to `max_width` (never upscaled) and the height keeps
/// the source aspect ratio rounded to the nearest even number, mirroring how
/// FFmpeg resolves a `-2` dimension. `None` leaves the source size untouched.
pub fn scaled_frame_dimensions(
    src_width: u32,
    src_height: u32,
    max_width: Option<u32>,
) -> (u32, u32) {
    let Some(max_width) = max_width else {
        return (src_width, src_height);
    };
    if src_width == 0 || src_height == 0 || max_width == 0 {
        return (src_width, src_height);
    }

    let out_width = max_width.min(src_width);
    // FFmpeg computes `av_rescale(out_width, src_height, src_width * 2) * 2`,
    // i.e. a half-up rounded number of even steps.
    let numerator = out_width as u64 * src_height as u64;
    let denominator = src_width as u64 * 2;
    let even_steps = (numerator + denominator / 2) / denominator;
    let out_height = (even_steps * 2).max(2).min(u32::MAX as u64) as u32;

    (out_width, out_height)
}

/// Whether a preset identifier names the 480p proxy profile.
///
/// The proxy is deliberately not an [`ExportPreset`] variant: it is built from
/// the sequence canvas (see [`ExportSettings::proxy`]) rather than from a fixed
/// frame, so [`ExportSettings::from_preset`] cannot produce it and
/// [`ExportPreset::from_legacy_id`] rejects its id.
///
/// Every surface that accepts a preset id asks here rather than keeping its own
/// spelling list. Keeping two lists is how `proxy_480p` came to be a documented
/// preset the CLI served and the desktop render commands refused as unknown.
///
/// Matching follows `from_legacy_id`: case-insensitive, and hyphens and spaces
/// read as underscores.
pub fn is_proxy_preset_id(preset: &str) -> bool {
    matches!(
        preset
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_")
            .as_str(),
        "proxy" | "proxy_480p"
    )
}

/// Longest edge a 480p-class proxy frame may occupy, in pixels.
///
/// 854 is the conventional 16:9 partner of 480 (1920/1080 * 480, rounded up to
/// an even number).
const PROXY_MAX_LONG_EDGE: u32 = 854;

/// Shortest edge a 480p-class proxy frame may occupy, in pixels.
const PROXY_MAX_SHORT_EDGE: u32 = 480;

/// Fits a sequence canvas into the 480p proxy budget, preserving its aspect.
///
/// The frame is scaled so its long edge is at most [`PROXY_MAX_LONG_EDGE`] and
/// its short edge at most [`PROXY_MAX_SHORT_EDGE`], which keeps a proxy of any
/// aspect ratio roughly as expensive to decode as the classic 854x480 one.
/// Canvases already inside the budget are left alone — a proxy never upscales.
///
/// Both edges come back even, as H.264 with 4:2:0 chroma requires.
///
/// Worked examples: 1920x1080 → 854x480, 1080x1920 → 480x854, 1080x1080 →
/// 480x480, 1920x800 → 854x356, 640x360 → 640x360 (unchanged).
pub fn proxy_frame_dimensions(canvas_width: u32, canvas_height: u32) -> (u32, u32) {
    if canvas_width == 0 || canvas_height == 0 {
        return (PROXY_MAX_LONG_EDGE, PROXY_MAX_SHORT_EDGE);
    }

    // Fit the short edge first: that is the constraint 480p names. Extreme
    // aspect ratios can still blow past the long-edge budget afterwards
    // (2.39:1 at 480 tall is 1152 wide), so the result is re-fitted by the
    // long edge when it does.
    let (mut width, mut height) = fit_short_edge(canvas_width, canvas_height, PROXY_MAX_SHORT_EDGE);
    if width.max(height) > PROXY_MAX_LONG_EDGE {
        (width, height) = fit_long_edge(canvas_width, canvas_height, PROXY_MAX_LONG_EDGE);
    }

    (round_down_to_even(width), round_down_to_even(height))
}

/// Scales `(width, height)` so its shorter edge is at most `max_short_edge`.
fn fit_short_edge(width: u32, height: u32, max_short_edge: u32) -> (u32, u32) {
    if width >= height {
        // `scaled_frame_dimensions` constrains the first axis, so the swap
        // makes it constrain height instead of width.
        let (height, width) = scaled_frame_dimensions(height, width, Some(max_short_edge));
        (width, height)
    } else {
        scaled_frame_dimensions(width, height, Some(max_short_edge))
    }
}

/// Scales `(width, height)` so its longer edge is at most `max_long_edge`.
fn fit_long_edge(width: u32, height: u32, max_long_edge: u32) -> (u32, u32) {
    if width >= height {
        scaled_frame_dimensions(width, height, Some(max_long_edge))
    } else {
        let (height, width) = scaled_frame_dimensions(height, width, Some(max_long_edge));
        (width, height)
    }
}

/// Rounds a dimension down to the nearest even number, never below 2.
fn round_down_to_even(value: u32) -> u32 {
    (value & !1).max(2)
}

/// Reads the real pixel dimensions of a written image via FFprobe.
///
/// Returns `None` when probing fails or reports no usable video stream so
/// callers can fall back to computed dimensions.
pub async fn probed_image_dimensions(ffmpeg: &FFmpegRunner, path: &Path) -> Option<(u32, u32)> {
    ffmpeg
        .probe(path)
        .await
        .ok()
        .and_then(|info| info.video)
        .map(|video| (video.width, video.height))
        .filter(|(width, height)| *width > 0 && *height > 0)
}

/// Maps a timeline time to the corresponding source-media time inside `clip`.
///
/// Accounts for the clip's timeline placement, source in-point and speed.
pub fn clip_source_time_at(clip: &Clip, timeline_time_sec: f64) -> f64 {
    let clip_relative_time = timeline_time_sec - clip.place.timeline_in_sec;
    clip.range.source_in_sec + (clip_relative_time * clip.speed as f64)
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
    /// M4A (AAC in MP4 audio container)
    M4a,
    /// FLAC (lossless compression)
    Flac,
    /// OGG (Opus in Ogg container)
    Ogg,
}

impl AudioExportFormat {
    /// File extension for this format
    pub fn extension(&self) -> &str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
        }
    }

    /// FFmpeg audio codec name for this format
    pub fn codec(&self) -> &str {
        match self {
            Self::Wav => "pcm_s16le",
            Self::Mp3 => "libmp3lame",
            Self::M4a => "aac",
            Self::Flac => "flac",
            Self::Ogg => "libopus",
        }
    }

    /// Default bitrate for lossy formats (None for lossless)
    pub fn default_bitrate(&self) -> Option<&str> {
        match self {
            Self::Wav | Self::Flac => None,
            Self::Mp3 => Some("320k"),
            Self::M4a => Some("256k"),
            Self::Ogg => Some("192k"),
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
                AudioExportFormat::M4a => AudioCodec::Aac,
                AudioExportFormat::Flac => AudioCodec::Copy,
                AudioExportFormat::Ogg => AudioCodec::Opus,
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
            encoder_speed: None,
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

/// Caps a windowed timeline render at the length of its window.
///
/// The graph the timeline builders emit already *starts* at the window — every
/// anchor is rebased and the segment straddling the window's first frame has the
/// frames in front of it dropped — so the only thing left to say on the output
/// side is how long the file runs. There is deliberately no `-ss` here: an
/// output-side seek would ask FFmpeg to throw away the front of a graph that no
/// longer has one, which is how a range render used to land up to half a frame
/// out of phase with the same frames of a full render.
///
/// Emits nothing at all for a render with no range, so a full export keeps the
/// argument list it has always had.
pub(super) fn append_windowed_output_duration_arg(args: &mut Vec<String>, window: &RenderWindow) {
    if !window.is_ranged() {
        return;
    }

    args.push("-t".to_string());
    args.push(window.output_duration_arg());
}

/// Pins a windowed render's picture to exactly the window's frame count.
///
/// `-t` alone is not quite enough. It is a *duration*, and the duration of a
/// whole number of frames is not always representable in the six decimals the
/// argument is formatted to — the value can round up past the next frame's
/// presentation time and let one extra frame through. Counting frames here says
/// the same thing in the unit the window is really measured in, and leaves `-t`
/// to bound the sound.
///
/// Returns the label the output should map. Emits nothing for a render with no
/// range, so a full export keeps the filtergraph it has always had.
pub(super) fn append_window_frame_cap(
    filter_complex: &mut String,
    video_label: &str,
    window: &RenderWindow,
) -> String {
    if !window.is_ranged() {
        return video_label.to_string();
    }

    const WINDOWED_VIDEO_LABEL: &str = "[outvwin]";
    filter_complex.push(';');
    filter_complex.push_str(&format!(
        "{}trim=end_frame={}{}",
        video_label,
        window.len_frames().max(1),
        WINDOWED_VIDEO_LABEL
    ));
    WINDOWED_VIDEO_LABEL.to_string()
}

/// Emits a silent stereo branch the length of the render.
///
/// The master bus pads whatever it is handed out to the render's length, but it
/// has to be handed *something*: a window that falls between every audio branch
/// would otherwise produce a file with no audio stream at all, where the full
/// render of the same seconds produces silence.
pub(super) fn append_window_silence_audio(
    filter_complex: &mut String,
    output_label: &str,
    duration_sec: f64,
) {
    // The two callers reach this from different places in the graph — one with
    // a chain already written, one with nothing at all — so the separator is
    // decided here rather than at each call site.
    if !filter_complex.is_empty() && !filter_complex.ends_with(';') {
        filter_complex.push(';');
    }

    filter_complex.push_str(&format!(
        "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={},asetpts=PTS-STARTPTS[{}]",
        format_speed_number(duration_sec.max(TIMELINE_EPSILON_SEC)),
        output_label
    ));
}

/// Applies a range to a *pass-through* export, which has no graph to rebase.
///
/// Only [`ExportEngine::build_simple_export_args`] uses this: it hands one input
/// file straight to the encoder, so the range really is a seek into that file
/// and there is nothing to shape. Every timeline render goes through
/// [`append_windowed_output_duration_arg`] instead.
pub(super) fn append_output_time_range_args(
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

fn normalize_output_time_range(
    sequence: &Sequence,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> Result<(Option<f64>, Option<f64>), ExportError> {
    // Ranges are clamped to the length the export writes, so a range the caller
    // is allowed to ask for always lands inside the resulting file.
    let full_duration = sequence.output_duration();

    if full_duration <= 0.0 {
        return Err(ExportError::InvalidSettings(
            "Sequence has no exportable duration".to_string(),
        ));
    }

    let normalized_start = start_time.map(|time| time.max(0.0).min(full_duration));
    let normalized_end = end_time.map(|time| time.max(0.0).min(full_duration));

    if let Some(start) = normalized_start {
        if start >= full_duration {
            return Err(ExportError::InvalidSettings(
                "Start time is outside the sequence duration".to_string(),
            ));
        }
    }

    if let Some(end) = normalized_end {
        if end <= 0.0 {
            return Err(ExportError::InvalidSettings(
                "End time is outside the sequence duration".to_string(),
            ));
        }
    }

    if let (Some(start), Some(end)) = (normalized_start, normalized_end) {
        if end <= start {
            return Err(ExportError::InvalidSettings(
                "Selected export range is outside the sequence duration".to_string(),
            ));
        }
    }

    Ok((normalized_start, normalized_end))
}

/// Length of the file a render of `sequence` over this range writes.
///
/// Derived from [`Sequence::output_duration`] so the reported duration, the
/// progress total and the file itself all agree; a clip the export drops
/// (disabled, or on a muted track) shortens all three together.
fn effective_export_duration(
    sequence: &Sequence,
    start_time: Option<f64>,
    end_time: Option<f64>,
) -> f64 {
    let full_duration = sequence.output_duration();

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
    /// Pixel dimensions of the asset's video stream as the decoder emits them.
    ///
    /// The same probe that answers "does this have audio" already measured the
    /// picture, so carrying it here spares the filtergraph builder an FFprobe run
    /// per transformed asset. `None` means the probe found no video stream, or
    /// fell back to metadata that cannot vouch for a size.
    pub source_dimensions: Option<(u32, u32)>,
    /// How far the asset's *pictures* run, as the same probe measured them.
    ///
    /// This is what tells a transition whether a clip has unused media past its
    /// out point to blend into. `None` means nobody has measured the file, which
    /// the transition planner treats as "no handle" rather than guessing.
    ///
    /// Deliberately the video stream's length, not the container's: a container
    /// reports the longest stream it holds, so a file whose audio outlasts its
    /// video would advertise a handle made of frames that do not exist. `xfade`
    /// handed an offset past its input's real end answers by dropping the
    /// incoming clip and exiting successfully, so this must never be optimistic.
    /// Files with no video stream fall back to the container duration.
    pub source_duration_sec: Option<f64>,
}

impl AssetAudioInfo {
    /// Create from FFprobe MediaInfo result
    pub fn from_media_info(media_info: &crate::core::ffmpeg::MediaInfo) -> Self {
        Self {
            has_audio: media_info.audio.is_some(),
            source_dimensions: media_info
                .video
                .as_ref()
                .map(|video| {
                    crate::core::ffmpeg::display_dimensions(
                        video.width,
                        video.height,
                        video.rotation_deg,
                    )
                })
                .filter(|(width, height)| *width > 0 && *height > 0),
            source_duration_sec: media_info
                .video_duration_sec
                .filter(|duration| duration.is_finite() && *duration > 0.0)
                .or(Some(media_info.duration_sec))
                .filter(|duration| duration.is_finite() && *duration > 0.0),
        }
    }

    /// Create from Asset metadata (fallback when MediaInfo is not available)
    ///
    /// Uses presence of audio info as heuristic for audio presence.
    pub fn from_asset(asset: &Asset) -> Self {
        Self {
            has_audio: asset.audio.is_some(),
            source_dimensions: stored_asset_source_dimensions(asset),
            source_duration_sec: asset
                .duration_sec
                .filter(|duration| duration.is_finite() && *duration > 0.0),
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
pub(super) fn format_speed_number(value: f64) -> String {
    let mut s = format!("{:.6}", value);
    let trimmed_len = s.trim_end_matches('0').trim_end_matches('.').len();
    s.truncate(trimmed_len);
    s
}

fn time_remap_has_slow_segment(curve: &crate::core::timeline::TimeRemapCurve) -> bool {
    curve.keyframes.windows(2).any(|pair| {
        let start = &pair[0];
        let end = &pair[1];
        let timeline_delta = end.timeline_time - start.timeline_time;
        let source_delta = (end.source_time - start.source_time).abs();

        timeline_delta.is_finite()
            && timeline_delta > 1e-6
            && source_delta.is_finite()
            && source_delta / timeline_delta < 1.0 - 1e-6
    })
}

fn clip_uses_slow_motion(clip: &Clip) -> bool {
    if clip.freeze_frame {
        return false;
    }

    if let Some(ref remap) = clip.time_remap {
        if remap.is_valid() {
            return time_remap_has_slow_segment(remap);
        }
    }

    clip.safe_speed() < 1.0 - 1e-6
}

fn build_slow_motion_interpolation_filter(clip: &Clip) -> Option<&'static str> {
    if !clip_uses_slow_motion(clip) {
        return None;
    }

    match clip.slow_motion_interpolation {
        SlowMotionInterpolation::Nearest => None,
        SlowMotionInterpolation::FrameBlend => Some("minterpolate=mi_mode=blend"),
        SlowMotionInterpolation::MotionCompensated => {
            Some("minterpolate=mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1")
        }
    }
}

/// The source window a clip decodes, handles included.
///
/// Returns `(source_in, source_out)` in *source* seconds. A transition extends
/// the window into media the edit is not using, and a clip playing at 2x eats
/// two seconds of source per second of handle — hence the speed scaling.
///
/// The extension is deliberately render-graph-local: it is never written back
/// onto the [`Clip`], because the audio branch reads `clip.range` too and a
/// mutated clip would silently shift the sound as well as the picture.
fn handled_source_window(clip: &Clip, handles: ClipHandles) -> (f64, f64) {
    if handles.is_none() {
        return (clip.range.source_in_sec, clip.range.source_out_sec);
    }

    let speed = clip.safe_speed();
    (
        clip.range.source_in_sec - handles.head_sec * speed,
        clip.range.source_out_sec + handles.tail_sec * speed,
    )
}

/// How far past its media a clip may reach before the render calls it an
/// overrun.
///
/// A cut lands on the output frame grid, not on whatever fraction of a second
/// FFprobe rounded the container's duration to, so a clip that ends exactly at
/// the end of its media routinely reads as a hair past it. One 60fps frame is
/// the smallest slack that absorbs that rounding, and padding black for less
/// than a frame would be noise rather than a fix.
const SOURCE_OVERRUN_TOLERANCE_SEC: f64 = 1.0 / 60.0;

/// A clip's source window split into what its media can decode and what cannot.
///
/// A clip may name more source than the file holds — an insert made before the
/// asset was probed takes a default length regardless of the media, and a split
/// hands the tail half a range that starts past the end. FFmpeg answers such a
/// `trim` with fewer frames than the timeline slot asked for and exit code 0,
/// so the segment lands short, `concat` pulls every later clip forward, and in
/// the degenerate case the render writes a file with no video stream at all and
/// the user's only signal is raw FFmpeg stderr.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct BoundedSourceWindow {
    /// Source seconds the trim starts at.
    pub(super) source_in: f64,
    /// Source seconds the trim ends at, bounded by the media when it is known.
    pub(super) source_out: f64,
    /// Timeline seconds of black that stand in for the unreadable remainder.
    pub(super) black_pad_sec: f64,
}

/// Bounds a clip's source window by the media behind it.
///
/// `media_duration_sec` is what [`resolve_asset_source_duration`] measured;
/// `None` (an unmeasurable file) leaves the window exactly as the clip states
/// it, because guessing a bound would cut picture the file may well hold.
///
/// The pad is expressed in *timeline* seconds — the filter applies it after
/// `setpts`, where a 2x clip has already halved its own duration.
pub(super) fn bounded_source_window(
    clip: &Clip,
    handles: ClipHandles,
    media_duration_sec: Option<f64>,
) -> BoundedSourceWindow {
    let (source_in, source_out) = handled_source_window(clip, handles);
    let unbounded = BoundedSourceWindow {
        source_in,
        source_out,
        black_pad_sec: 0.0,
    };

    let Some(available) = media_duration_sec.filter(|value| value.is_finite() && *value > 0.0)
    else {
        return unbounded;
    };
    if source_out <= available + SOURCE_OVERRUN_TOLERANCE_SEC {
        return unbounded;
    }

    // A window that starts at or past the end decodes nothing whatever it is
    // trimmed to; validation refuses that clip up front. Keeping the trim
    // non-empty here only stops the filtergraph from being nonsense in the
    // meantime.
    let decodable_out = available
        .max(source_in + TIMELINE_EPSILON_SEC)
        .min(source_out);

    BoundedSourceWindow {
        source_in,
        source_out: decodable_out,
        black_pad_sec: (source_out - decodable_out) / clip.safe_speed(),
    }
}

/// Reports a clip whose source range reaches past the end of its media.
///
/// Always a *warning*, never an error, and that is deliberate: the render
/// bounds the decodable window and pads the rest with black, so even a clip
/// whose whole range sits past the end of its media still produces a file.
/// Filing the no-picture case as an error made one over-trimmed clip invalidate
/// the sequence, and the frame probe refuses to composite an invalid sequence —
/// so a single bad clip returned nothing at *every* timecode and an agent could
/// not so much as look at the rest of its own edit.
///
/// `None` for every clip the render does not bound this way: audio, stills
/// (which hold their slot whatever their window says), freeze frames (which
/// clone one picture) and time-remapped clips (whose window comes from the
/// curve, not from `clip.range`). `None` too when the media is unmeasurable,
/// because a bound nobody could measure is not a finding.
pub(super) fn source_overrun_finding(
    clip: &Clip,
    asset: &Asset,
    track: &crate::core::timeline::Track,
    source_durations: &mut SourceDurationCache,
) -> Option<String> {
    if track.kind != TrackKind::Video
        || asset.kind == AssetKind::Image
        || clip.freeze_frame
        || clip.has_time_remap()
    {
        return None;
    }

    let available = resolve_asset_source_duration(asset, source_durations)
        .filter(|value| value.is_finite() && *value > 0.0)?;
    if clip.range.source_out_sec <= available + SOURCE_OVERRUN_TOLERANCE_SEC {
        return None;
    }

    if clip.range.source_in_sec >= available {
        return Some(format!(
            "Clip '{}' on track '{}' starts {:.3}s into asset '{}', which holds only {:.3}s of \
             media, so it decodes no picture at all and renders as black for its whole length. \
             Trim the clip back inside its source, or remove it.",
            clip.id, track.name, clip.range.source_in_sec, asset.id, available
        ));
    }

    Some(format!(
        "Clip '{}' on track '{}' runs {:.3}s past the end of asset '{}', which holds only \
         {:.3}s of media; the overrun renders as black. Trim the clip to the media length.",
        clip.id,
        track.name,
        clip.range.source_out_sec - available,
        asset.id,
        available
    ))
}

/// What kind of picture the input of a video trim decodes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TrimSourceKind {
    /// A moving stream: the trim cuts a window out of it.
    Motion,
    /// A single still frame, which has to be held across the clip's slot.
    StillImage,
}

impl TrimSourceKind {
    /// Classifies a source by whether it decodes to one picture or to many.
    ///
    /// `probed_frame_count` is what the file actually holds, from
    /// [`resolve_trim_source_kind`]. The asset's *kind* cannot answer this on
    /// its own: `AssetKind::Image` is assigned from the file extension alone,
    /// and `gif`, `webp`, `avif` and `png` are all extensions an animation can
    /// wear. Treating every one of them as a still froze animated media to its
    /// first frame — the reaction GIFs the meme pack serves included.
    ///
    /// An unreadable count falls back to the still path for an image, which is
    /// what a photo — the overwhelmingly common case — needs, and is also the
    /// only reading under which a one-frame source fills its slot at all.
    pub(super) fn for_asset(asset: &Asset, probed_frame_count: Option<u64>) -> Self {
        if asset.kind != AssetKind::Image {
            return Self::Motion;
        }

        match probed_frame_count {
            Some(frames) if frames > 1 => Self::Motion,
            _ => Self::StillImage,
        }
    }
}

/// How many pictures each asset's stream holds, cached for one export run.
///
/// Keyed by asset id, with the same "a `None` entry means already looked at and
/// unmeasurable" contract as [`SourceDurationCache`], so an unreadable file is
/// probed once rather than once per clip that uses it.
pub(super) type SourceFrameCountCache = HashMap<String, Option<u64>>;

/// Decides which trim branch a clip's source needs, probing it if necessary.
///
/// Only an image is probed: every other kind is moving media by construction,
/// and paying an FFprobe per video asset to learn what the container already
/// says would be waste.
pub(super) fn resolve_trim_source_kind(
    asset: &Asset,
    cache: &mut SourceFrameCountCache,
) -> TrimSourceKind {
    if asset.kind != AssetKind::Image {
        return TrimSourceKind::Motion;
    }

    if let Some(cached) = cache.get(&asset.id) {
        return TrimSourceKind::for_asset(asset, *cached);
    }

    let frames = match crate::core::assets::MetadataExtractor::count_video_frames(&asset.uri) {
        Ok(frames) => frames,
        Err(error) => {
            tracing::warn!(
                asset_id = %asset.id,
                error = %error,
                "Could not probe image asset for its frame count; treating it as a still"
            );
            None
        }
    };

    cache.insert(asset.id.clone(), frames);
    TrimSourceKind::for_asset(asset, frames)
}

/// How long a still has to hold to fill its timeline slot, handles included.
///
/// Floored at [`TIMELINE_EPSILON_SEC`] so the `trim` this feeds can never be
/// asked for an empty window, which FFmpeg answers with a stream of no frames.
/// That floor is the timeline's own resolution, not a frame's: a slot shorter
/// than it is a slot the timeline cannot express in the first place.
fn still_image_slot_duration(clip: &Clip, handles: ClipHandles) -> f64 {
    (clip.place.duration_sec + handles.head_sec + handles.tail_sec).max(TIMELINE_EPSILON_SEC)
}

/// Build video trim filter with speed, reverse, freeze frame, and time remap support.
///
/// Generates the complete video filter chain from input to the trim output label:
/// - trim → setpts (speed/time_remap) → [reverse] → [freeze loop] → output
///
/// `handles` widen the source window for a clip that takes part in a
/// transition. Only the plain constant-speed branch can carry them: the
/// transition planner refuses frozen, reversed and time-remapped clips
/// precisely because their timeline-to-source mapping makes the extension
/// undefined.
///
/// `source` says whether the input decodes to moving pictures or to a single
/// still — see [`TrimSourceKind`].
///
/// `media_duration_sec` is how much media the file actually holds, from
/// [`resolve_asset_source_duration`]. Only the plain constant-speed branch is
/// bounded by it: a still already holds its slot whatever its window says, a
/// freeze frame clones one picture, and the reversed and time-remapped branches
/// map timeline to source in ways a tail pad would land in the wrong place.
/// Validation reports the overrun for every one of them regardless.
pub(super) fn build_video_trim_filter(
    clip: &Clip,
    input_index: usize,
    trim_label: &str,
    filter_complex: &mut String,
    handles: ClipHandles,
    source: TrimSourceKind,
    media_duration_sec: Option<f64>,
) {
    debug_assert!(
        handles.is_none() || (!clip.freeze_frame && !clip.has_time_remap() && !clip.reverse),
        "transition handles are only defined for constant-speed clips"
    );

    if source == TrimSourceKind::StillImage {
        // A still decodes to exactly one frame, so every other branch here — all
        // of which cut a *window* out of a moving stream — leaves the clip one
        // frame long however many seconds the timeline gave it. Cloning that
        // frame across the slot is what makes a photo a clip: without it a Ken
        // Burns move exports as a single-frame flash, and an unzoomed still does
        // the same. The source window is deliberately ignored, because a still
        // has nothing to seek into: trimming from a non-zero in point would find
        // no frame at all and render nothing.
        let slot = format_speed_number(still_image_slot_duration(clip, handles));
        let filter = format!(
            "[{}:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={},trim=0:{},setpts=PTS-STARTPTS[{}]",
            input_index, slot, slot, trim_label
        );
        filter_complex.push_str(&filter);
    } else if clip.freeze_frame {
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
        let interpolation = build_slow_motion_interpolation_filter(clip)
            .map(|filter| format!(",{}", filter))
            .unwrap_or_default();
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts={}{}[{}]",
            input_index,
            format_speed_number(source_start),
            format_speed_number(source_end),
            setpts,
            interpolation,
            trim_label
        );
        filter_complex.push_str(&filter);
    } else if clip.reverse {
        // Reverse: apply reverse filter after trim, before speed
        let speed = clip.safe_speed();
        let setpts = build_speed_setpts(speed);
        let interpolation = build_slow_motion_interpolation_filter(clip)
            .map(|filter| format!(",{}", filter))
            .unwrap_or_default();
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts=PTS-STARTPTS,reverse,setpts={}{}[{}]",
            input_index,
            clip.range.source_in_sec,
            clip.range.source_out_sec,
            setpts,
            interpolation,
            trim_label
        );
        filter_complex.push_str(&filter);
    } else {
        // Normal: trim with constant speed adjustment
        let speed = clip.safe_speed();
        let setpts = build_speed_setpts(speed);
        let interpolation = build_slow_motion_interpolation_filter(clip)
            .map(|filter| format!(",{}", filter))
            .unwrap_or_default();
        let window = bounded_source_window(clip, handles, media_duration_sec);
        // Black rather than a cloned last frame: a hold reads as a deliberate
        // freeze, while black reads as missing media, which is what it is.
        let black_pad = if window.black_pad_sec > 0.0 {
            format!(
                ",tpad=stop_mode=add:color=black:stop_duration={}",
                format_speed_number(window.black_pad_sec)
            )
        } else {
            String::new()
        };
        let filter = format!(
            "[{}:v]trim=start={}:end={},setpts={}{}{}[{}]",
            input_index,
            window.source_in,
            window.source_out,
            setpts,
            interpolation,
            black_pad,
            trim_label
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
///
/// `handles` widen the atrim window for a clip taking part in a transition, and
/// `engine_fades` are the constant-power fades that make the two branches sum to
/// a flat level across the blend. Both are zero for every clip the transition
/// engine did not touch, and the emitted graph is then byte-identical to the one
/// this builder has always produced.
pub(super) fn build_audio_trim_filter(
    clip: &Clip,
    input_index: usize,
    audio_trim_label: &str,
    filter_complex: &mut String,
    handles: ClipHandles,
    engine_fades: EngineAudioFades,
) -> String {
    debug_assert!(
        !clip.freeze_frame,
        "build_audio_trim_filter should not be called for freeze frame clips"
    );

    // The same guard the video side carries, naming the same three cases. The
    // planner refuses all three, so a handle reaching a frozen, reversed or
    // time-remapped clip means the plan and the builder have drifted apart.
    // (`freeze_frame` is already excluded above; it is restated so the two
    // assertions read as the one contract they are.)
    debug_assert!(
        (handles.is_none() && engine_fades.is_none())
            || (!clip.freeze_frame && !clip.has_time_remap() && !clip.reverse),
        "transition handles are only defined for constant-speed clips"
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

        // Apply volume keyframe automation. A time-remapped clip can never carry
        // transition handles, so its branch starts at the clip's in point.
        current_label =
            apply_volume_keyframes(clip, input_index, &current_label, filter_complex, 0.0);

        // Apply audio fades
        let clip_dur = clip.duration().max(0.0);
        current_label = apply_audio_fades(
            clip,
            input_index,
            &current_label,
            filter_complex,
            clip_dur,
            0.0,
        );

        return current_label;
    }

    // Regular audio trim
    let (source_in, source_out) = handled_source_window(clip, handles);
    let filter = format!(
        "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[{}]",
        input_index, source_in, source_out, audio_trim_label
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

    // Apply volume keyframe automation, anchored on the clip's own in point
    // rather than on the first sample of the branch.
    current_label = apply_volume_keyframes(
        clip,
        input_index,
        &current_label,
        filter_complex,
        handles.head_sec,
    );

    // Apply audio fades authored on the clip. They stay anchored on the clip's
    // own in and out points, which the head handle has pushed later in branch
    // time — a fade the editor asked for must not drift because the engine
    // reached further into the source.
    let clip_dur = clip.duration().max(0.0);
    current_label = apply_audio_fades(
        clip,
        input_index,
        &current_label,
        filter_complex,
        clip_dur,
        handles.head_sec,
    );

    // The engine's own fades ride on top of whatever the editor authored, so a
    // clip can carry both. They span the whole blend, not the clip, which is why
    // they are measured against the branch rather than the slot.
    let branch_duration = clip_dur + handles.head_sec + handles.tail_sec;
    apply_transition_audio_fades(
        input_index,
        &current_label,
        filter_complex,
        branch_duration,
        engine_fades,
    )
}

/// Applies the constant-power fades a transition needs on one clip's audio.
///
/// `qsin` is the shape whose squares sum to one, so the outgoing branch's
/// fade-out and the incoming branch's fade-in add up to a flat level through the
/// blend when the master mix sums them with `normalize=0`. The labels are
/// distinct from the ones [`apply_audio_fades`] emits so the two compose by
/// chaining rather than colliding.
fn apply_transition_audio_fades(
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
    branch_duration_sec: f64,
    fades: EngineAudioFades,
) -> String {
    let mut label = current_label.to_string();

    if fades.fade_in_sec > 0.0 {
        let out_label = format!("axfin{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=in:st=0:d={:.4}:curve=qsin[{}];",
            label, fades.fade_in_sec, out_label
        ));
        label = out_label;
    }

    if fades.fade_out_sec > 0.0 {
        let start_time = (branch_duration_sec - fades.fade_out_sec).max(0.0);
        let out_label = format!("axfout{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=out:st={:.4}:d={:.4}:curve=qsin[{}];",
            label, start_time, fades.fade_out_sec, out_label
        ));
        label = out_label;
    }

    label
}

/// Applies volume keyframe automation as an FFmpeg volume filter if the clip
/// has active volume automation keyframes.
///
/// `head_offset_sec` is how far into the branch the clip's own in point sits. A
/// transition starts the incoming clip's sound before that point, and the
/// keyframes are authored against the clip, so every breakpoint has to move
/// later by the same amount — otherwise the automation fires a whole half-blend
/// early on every incoming clip.
fn apply_volume_keyframes(
    clip: &Clip,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
    head_offset_sec: f64,
) -> String {
    use crate::core::timeline::AudioKeyframe;

    if clip.audio.has_volume_automation() {
        if let Some(vol_expr) =
            AudioKeyframe::to_ffmpeg_volume_expr(&clip.audio.volume_keyframes, head_offset_sec)
        {
            let vol_label = format!("avol{}", input_index);
            // Volume filter does not modify PTS — no asetpts needed here.
            filter_complex.push_str(&format!("[{}]{}[{}];", current_label, vol_expr, vol_label));
            return vol_label;
        }
    }
    current_label.to_string()
}

/// Applies audio fade-in and fade-out as FFmpeg afade filters.
///
/// `head_offset_sec` is how far into the branch the clip's own in point sits.
/// It is zero unless a transition extended the branch backwards into unused
/// source media, and the authored fades stay pinned to the clip's real in and
/// out points either way.
fn apply_audio_fades(
    clip: &Clip,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
    clip_duration: f64,
    head_offset_sec: f64,
) -> String {
    let fade_in = clip.audio.fade_in_sec;
    let fade_out = clip.audio.fade_out_sec;

    if fade_in <= 0.0 && fade_out <= 0.0 {
        return current_label.to_string();
    }

    let head_offset_sec = head_offset_sec.max(0.0);
    let mut label = current_label.to_string();

    if fade_in > 0.0 {
        let fade_type = clip.audio.fade_in_type.to_ffmpeg_type();
        let out_label = format!("afin{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=in:st={}:d={:.4}:curve={}[{}];",
            label,
            format_fade_start(head_offset_sec),
            fade_in,
            fade_type,
            out_label
        ));
        label = out_label;
    }

    if fade_out > 0.0 {
        let fade_type = clip.audio.fade_out_type.to_ffmpeg_type();
        let start_time = (head_offset_sec + clip_duration - fade_out).max(0.0);
        let out_label = format!("afout{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]afade=t=out:st={:.4}:d={:.4}:curve={}[{}];",
            label, start_time, fade_out, fade_type, out_label
        ));
        label = out_label;
    }

    label
}

/// Formats an `afade` start time, keeping the bare `0` the graph has always used.
fn format_fade_start(start_sec: f64) -> String {
    if start_sec <= 0.0 {
        "0".to_string()
    } else {
        format!("{:.4}", start_sec)
    }
}

fn volume_db_to_linear(volume_db: f32) -> f64 {
    if volume_db <= -60.0 {
        0.0
    } else {
        10.0_f64.powf(volume_db as f64 / 20.0)
    }
}

/// Applies gain, pan and timeline placement to one clip's audio branch.
///
/// `handles.head_sec` moves the branch's first sample earlier: a transition
/// starts the incoming clip's sound before its in point, so the delay that puts
/// the branch at its timeline position has to shrink by exactly that much.
///
/// `window` is the stretch of timeline this render writes. Placement is the only
/// stage that learns about it: the cut it makes is the last thing in the branch,
/// after the authored fades, the automation and the transition fades, so every
/// one of those stays anchored where the editor put it and nothing upstream has
/// to know the render starts late.
pub(super) fn apply_audio_mix_settings(
    clip: &Clip,
    track: &Track,
    input_index: usize,
    current_label: &str,
    filter_complex: &mut String,
    handles: ClipHandles,
    window: &RenderWindow,
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

    let branch_start_sec = (clip.place.timeline_in_sec - handles.head_sec.max(0.0)).max(0.0);
    // A branch that starts before the window is cut, not delayed: the samples in
    // front of the window's first frame have to leave the mix entirely, and
    // `adelay` can only ever push a branch later. `.max(0.0)` on the delay below
    // would otherwise stack the whole branch onto the window's first sample.
    let windowed_start_sec = window.rebase(branch_start_sec);
    if windowed_start_sec < 0.0 {
        let head_label = format!("awin{}", input_index);
        filter_complex.push_str(&format!(
            "[{}]atrim=start={},asetpts=PTS-STARTPTS[{}];",
            current_label,
            format_speed_number(-windowed_start_sec),
            head_label
        ));
        current_label = head_label;
    }

    let delay_ms = (windowed_start_sec.max(0.0) * 1000.0).round() as u64;
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

/// Tolerance for treating two timeline instants as the same one (1 millisecond).
///
/// Shared beyond the render module so the timeline's own "does a clip start
/// where this one ends" question is answered with the tolerance the stitcher
/// answers it with; a looser or tighter one there would report a blend the
/// renderer refuses, or hide one it places.
pub(crate) const TIMELINE_EPSILON_SEC: f64 = 0.001;

/// One stretch of picture on the timeline, ready to be concatenated.
///
/// Boundaries between segments are hard cuts by default. A boundary the
/// transition engine planned is folded into a single blended segment *before*
/// this list is stitched — see
/// [`stitch_transition_groups`](super::transition_stitch::stitch_transition_groups)
/// — so that a two-input transition never changes how long the picture is.
/// The blend is paid for out of unused source media on either side (handles),
/// not out of timeline time, which is what keeps the rendered file exactly
/// [`Sequence::output_duration`] long and keeps every clip's audio at its
/// absolute timeline position.
#[derive(Clone, Debug)]
pub(super) struct VideoTimelineSegment {
    pub stream_label: String,
    pub start_sec: f64,
    pub end_sec: f64,
    /// The clip this stretch of picture came from, when it came from one.
    ///
    /// The transition stitch needs it to recognise the two sides of a planned
    /// boundary. Black gap fillers and the blank canvas a text-only sequence
    /// draws on have no clip, and can never take part in a transition.
    pub clip_id: Option<String>,
    /// The composite this stretch of picture is one layer of, when it is one.
    ///
    /// Set by the builder from the plan
    /// [`plan_pip_groups`](super::pip_stitch::plan_pip_groups) produced before
    /// any chain was emitted, and read by
    /// [`fold_pip_groups`](super::pip_stitch::fold_pip_groups) to stack the
    /// layers. `None` for an ordinary clip that shares its seconds with nothing,
    /// for black gap fillers, and for the blank canvas a text-only sequence
    /// draws on.
    pub layer: Option<PipLayerInfo>,
}

/// Where one segment sits in a composite: which stack, and how deep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PipLayerInfo {
    /// Which composite this layer belongs to. Assigned once, by the plan.
    pub group_index: usize,
    /// The clip's track index, in which **0 is the topmost track**.
    ///
    /// The composite stacks the highest index first so that track 0 is drawn
    /// last and lands on top, which is the order the preview draws in.
    pub track_index: usize,
    /// The `blend` filter options this layer is composited through, if any.
    ///
    /// `None` is plain source-over, which `overlay` performs by itself. Resolved
    /// by the plan rather than carried as a blend mode so that the fold needs to
    /// know nothing about blending beyond where to put the string.
    pub blend_spec: Option<&'static str>,
}

impl VideoTimelineSegment {
    /// Builds a segment for one stretch of picture on the timeline.
    pub(super) fn new(stream_label: impl Into<String>, start_sec: f64, end_sec: f64) -> Self {
        Self {
            stream_label: stream_label.into(),
            start_sec,
            end_sec,
            clip_id: None,
            layer: None,
        }
    }

    /// Records which clip this stretch of picture came from.
    pub(super) fn with_clip(mut self, clip_id: impl Into<String>) -> Self {
        self.clip_id = Some(clip_id.into());
        self
    }

    /// Records the composite this stretch of picture is a layer of.
    pub(super) fn with_layer(mut self, layer: Option<PipLayerInfo>) -> Self {
        self.layer = layer;
        self
    }
}

#[derive(Clone, Debug)]
struct VideoConcatPart {
    stream_label: String,
}

pub(super) fn output_video_dimensions(
    sequence: &Sequence,
    settings: &ExportSettings,
) -> (u32, u32) {
    let width = settings
        .width
        .unwrap_or(sequence.format.canvas.width)
        .max(1);
    let height = settings
        .height
        .unwrap_or(sequence.format.canvas.height)
        .max(1);
    (width, height)
}

pub(crate) fn output_video_fps(sequence: &Sequence, settings: &ExportSettings) -> f64 {
    let fps = settings.fps.unwrap_or_else(|| sequence.format.fps.as_f64());

    if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        30.0
    }
}

pub(super) fn output_video_pixel_format(settings: &ExportSettings) -> &'static str {
    let use_10_bit = settings.is_hdr() || settings.bit_depth.unwrap_or(8) >= 10;

    match settings.video_codec {
        VideoCodec::ProRes => "yuv422p10le",
        // Lossless only holds if nothing converts the planes on the way out:
        // the compositor works in `gbrap`, and `gbrp` keeps its colour planes
        // verbatim (dropping only the opaque alpha), so no colorspace conversion
        // and no subsampling happens at all. Anything else here silently gives
        // back the error this codec was chosen to remove.
        VideoCodec::UtVideo => "gbrp",
        VideoCodec::H264 | VideoCodec::H265 | VideoCodec::Vp9 | VideoCodec::Copy => {
            if use_10_bit {
                "yuv420p10le"
            } else {
                "yuv420p"
            }
        }
    }
}

/// Fits one clip's picture to the output canvas.
///
/// `pinned_frames` makes the segment exactly that many frames long instead of
/// however many the source happens to yield. Only a segment taking part in a
/// transition asks for it, because `xfade`'s `offset` is a position in the
/// stream feeding it and a segment one frame off would move the blend.
///
/// The count is a *cap*, not a guarantee on its own: `trim=end_frame` cannot
/// invent frames a short source never produced, and `xfade` given an offset at
/// or past its first input's real length passes that input through and drops the
/// second one entirely — no blend, no error, exit 0. What makes the count safe
/// is three things together, and none of them alone:
///
/// 1. The planner refuses a transition it cannot prove has the source media for
///    (see [`plan_sequence_transitions`](super::transition_stitch::plan_sequence_transitions)),
/// 2. it demands `HANDLE_SLACK_FRAMES` beyond that so the render's probe and
///    validation's probe cannot disagree their way past the check, and
/// 3. `tpad` here clones the last frame far enough past the count to cover that
///    slack plus the PTS rounding at the tail (a source whose final frame lands
///    just short of a boundary otherwise comes up one frame low).
///
/// The frame-indexed `trim` then caps it — the same pairing
/// [`append_video_transform_composition`] uses, and for the same reason.
#[allow(clippy::too_many_arguments)]
pub(super) fn append_video_stream_normalization(
    filter_complex: &mut String,
    input_label: &str,
    output_label: &str,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
    pinned_frames: Option<u32>,
    transparent_canvas: bool,
) {
    let pin = match pinned_frames {
        Some(frames) if fps.is_finite() && fps > 0.0 => format!(
            ",tpad=stop_mode=clone:stop_duration={},trim=end_frame={},setpts=PTS-STARTPTS",
            format_speed_number(TPAD_CUSHION_FRAMES / fps),
            frames.max(1)
        ),
        _ => String::new(),
    };

    // A layer of a composite must letterbox into *transparency*, not into black.
    // The preview draws only the picture, so whatever sits under a layer shows
    // through its bars; baking opaque black there would hide it in the export
    // alone. The format conversion has to precede `pad` so that the pad colour
    // has an alpha channel to be transparent in.
    let (fit_format, pad_color, output_format) = if transparent_canvas {
        (",format=gbrap", ":color=black@0", COMPOSITE_LAYER_FORMAT)
    } else {
        ("", "", pixel_format)
    };

    filter_complex.push_str(&format!(
        "[{}]scale={}:{}:force_original_aspect_ratio=decrease{},pad={}:{}:(ow-iw)/2:(oh-ih)/2{},setsar=1,fps={},format={}{}[{}];",
        input_label,
        width,
        height,
        fit_format,
        width,
        height,
        pad_color,
        format_speed_number(fps),
        output_format,
        pin,
        output_label
    ));
}

/// The working format every layer of a composite is handed to the stack in.
///
/// Planar sRGB with straight alpha: gamma encoded, full chroma, and able to
/// carry the transparency that lets lower layers show through. Measured against
/// the alternative — staging in `yuva420p` and compositing in `yuv444` — which
/// came out 1-2 LSB off on flat regions with chroma fringing at every layer
/// edge, because each layer paid an RGB round trip and a 4:2:0 chroma pass.
pub(super) const COMPOSITE_LAYER_FORMAT: &str = "gbrap";

/// Frames of cloned tail `tpad` adds behind a pinned segment.
///
/// Covers the `HANDLE_SLACK_FRAMES` the planner allows the two duration probes
/// to disagree by, plus two frames of PTS rounding at the tail. Anything the
/// cushion adds beyond the pin is thrown away by `trim=end_frame`, so it costs
/// nothing to be generous; coming up short, on the other hand, hands `xfade` an
/// offset past its input's real end, and it answers by dropping the incoming
/// clip without a word.
const TPAD_CUSHION_FRAMES: f64 = super::transition_stitch::HANDLE_SLACK_FRAMES + 2.0;

/// Tolerance for treating a transform component as untouched.
const TRANSFORM_EPSILON: f64 = 0.0001;

/// Whether a clip is placed on the canvas untouched.
///
/// An identity clip is letterboxed into the canvas and nothing else, which is
/// exactly what [`append_video_stream_normalization`] already does, so it keeps
/// the cheaper graph and needs no source dimensions.
fn clip_has_identity_transform(clip: &Clip) -> bool {
    (clip.transform.position.x - 0.5).abs() < TRANSFORM_EPSILON
        && (clip.transform.position.y - 0.5).abs() < TRANSFORM_EPSILON
        && (clip.transform.scale.x - 1.0).abs() < TRANSFORM_EPSILON
        && (clip.transform.scale.y - 1.0).abs() < TRANSFORM_EPSILON
        && clip.transform.rotation_deg.abs() < TRANSFORM_EPSILON
        && (clip.transform.anchor.x - 0.5).abs() < TRANSFORM_EPSILON
        && (clip.transform.anchor.y - 0.5).abs() < TRANSFORM_EPSILON
}

/// Whether a clip has to be composited onto the canvas rather than simply fitted.
///
/// Text clips and adjustment layers carry a transform too, but they are drawn by
/// the ASS/drawtext overlay path and the grading path respectively, so neither
/// takes part in this composite.
pub fn clip_needs_transform_composition(clip: &Clip) -> bool {
    !is_text_clip(clip)
        && !clip.is_adjustment_layer()
        && (!clip_has_identity_transform(clip)
            || (f64::from(clip.opacity) - 1.0).abs() > TRANSFORM_EPSILON
            // Motion the render can animate needs the composite even when the
            // clip's own transform is the identity, because the picture the
            // keyframes describe is never the plain canvas fit.
            || clip_motion_renders_animated(clip))
}

/// Whether a clip is composited *only* because of its motion keyframes.
///
/// Compositing needs the source's real pixel size, and an asset whose size
/// cannot be measured fails that requirement. For a clip whose own transform
/// places it, that is a genuine error: there is no honest picture to draw.
///
/// A clip carrying nothing but motion is different. Before motion animated, such
/// a clip was fitted to the canvas like any other and the export succeeded — so
/// refusing it now would turn a working export into a blocked one over a feature
/// the user never asked for. These degrade back to that fit, with a warning, and
/// keep exporting.
pub(super) fn clip_composition_is_motion_only(clip: &Clip) -> bool {
    clip_has_identity_transform(clip)
        && (f64::from(clip.opacity) - 1.0).abs() <= TRANSFORM_EPSILON
        && clip_motion_renders_animated(clip)
}

/// The warning for a motion clip the render had to fall back to a canvas fit.
pub(super) fn unmeasurable_motion_message(clip_id: &str, track_name: &str, reason: &str) -> String {
    format!(
        "Motion keyframes on clip '{}' on track '{}' are not rendered because {}; \
         the clip renders fitted to the canvas",
        clip_id, track_name, reason
    )
}

/// Pixel dimensions of the media a clip decodes, cached for one export run.
///
/// Keyed by asset id. A `None` entry records that the asset was already looked at
/// and could not be measured, so a broken file is probed once rather than once
/// per clip that uses it.
pub(super) type SourceDimensionCache = HashMap<String, Option<(u32, u32)>>;

/// Source dimensions an earlier probe already measured, keyed by asset id.
///
/// Passing one of these into [`validate_export_settings_with_dimensions`] is what
/// keeps validation from spawning its own FFprobe per transformed asset.
pub type SourceDimensionMap = HashMap<String, (u32, u32)>;

/// Everything the export's asset probe learned about picture sizes.
pub fn source_dimensions_from_audio_info(
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> SourceDimensionMap {
    audio_info
        .iter()
        .filter_map(|(asset_id, info)| {
            info.source_dimensions
                .map(|dimensions| (asset_id.clone(), dimensions))
        })
        .collect()
}

/// Turns an already-measured dimension map into a cache the resolver can read.
///
/// Only measured assets are seeded. An asset the probe could not size is left
/// out entirely rather than seeded as `None`, so the resolver still gets its
/// chance to measure it before the export gives up on the clip.
pub(super) fn seed_source_dimension_cache(
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> SourceDimensionCache {
    audio_info
        .iter()
        .filter_map(|(asset_id, info)| {
            info.source_dimensions
                .map(|dimensions| (asset_id.clone(), Some(dimensions)))
        })
        .collect()
}

/// Source durations an earlier probe already measured, keyed by asset id.
///
/// Passing one of these into [`validate_export_settings_with_dimensions`] is
/// what keeps validation from spawning its own FFprobe per asset a transition
/// touches.
pub type SourceDurationMap = HashMap<String, f64>;

/// Everything the export's asset probe learned about media lengths.
pub fn source_durations_from_audio_info(
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> SourceDurationMap {
    audio_info
        .iter()
        .filter_map(|(asset_id, info)| {
            info.source_duration_sec
                .map(|duration| (asset_id.clone(), duration))
        })
        .collect()
}

/// How long each asset's media runs, cached for one export run.
///
/// Keyed by asset id, with the same "a `None` entry means already looked at and
/// unmeasurable" contract as [`SourceDimensionCache`], so a broken file is
/// probed once rather than once per clip that uses it.
pub(super) type SourceDurationCache = HashMap<String, Option<f64>>;

/// Turns an already-measured duration map into a cache the resolver can read.
///
/// Only measured assets are seeded, for the same reason the dimension cache
/// leaves unmeasurable ones out: the resolver still deserves its chance to
/// measure before a transition is refused for want of a handle.
pub(super) fn seed_source_duration_cache(
    audio_info: &HashMap<String, AssetAudioInfo>,
) -> SourceDurationCache {
    audio_info
        .iter()
        .filter_map(|(asset_id, info)| {
            info.source_duration_sec
                .map(|duration| (asset_id.clone(), Some(duration)))
        })
        .collect()
}

/// Measures how long an asset's media runs.
///
/// FFprobe first, for the same reason [`resolve_asset_source_dimensions`] probes
/// first: `Asset::duration_sec` is `None` for anything imported headlessly, and
/// a transition that trusted a missing length would reach past the end of the
/// file and blend into nothing.
pub(super) fn resolve_asset_source_duration(
    asset: &Asset,
    cache: &mut SourceDurationCache,
) -> Option<f64> {
    if let Some(cached) = cache.get(&asset.id) {
        return *cached;
    }

    let probed = match crate::core::assets::MetadataExtractor::extract(&asset.uri) {
        // The video stream's own length when the file has one, for the same
        // reason [`AssetAudioInfo::source_duration_sec`] carries it: a container
        // whose audio outlasts its video would advertise a handle made of frames
        // the decoder cannot produce.
        Ok(metadata) => metadata.video_duration_sec.or(Some(metadata.duration_sec)),
        Err(error) => {
            tracing::warn!(
                asset_id = %asset.id,
                error = %error,
                "Could not probe asset for its source duration"
            );
            None
        }
    };

    let resolved = probed
        .or(asset.duration_sec)
        .filter(|duration| duration.is_finite() && *duration > 0.0);

    cache.insert(asset.id.clone(), resolved);
    resolved
}

/// Whether a clip's motion keyframes would show anything the static render will not.
///
/// Motion is stored, round-trips through the project and animates in the
/// preview, but the export composites the clip once at its base transform. That
/// is only worth telling the caller about when the keyframes actually move the
/// clip: a lone keyframe, or a run of identical ones, describes exactly the
/// picture the export already produces, and warning about it trains callers to
/// ignore the warning that matters.
pub(super) fn clip_motion_differs_from_base_transform(clip: &Clip) -> bool {
    let mut keyframes = clip.motion_keyframes.iter();
    let Some(first) = keyframes.next() else {
        return false;
    };

    if !transforms_match(&first.transform, &clip.transform) {
        return true;
    }

    keyframes.any(|keyframe| !transforms_match(&keyframe.transform, &first.transform))
}

fn transforms_match(left: &Transform, right: &Transform) -> bool {
    (left.position.x - right.position.x).abs() < TRANSFORM_EPSILON
        && (left.position.y - right.position.y).abs() < TRANSFORM_EPSILON
        && (left.scale.x - right.scale.x).abs() < TRANSFORM_EPSILON
        && (left.scale.y - right.scale.y).abs() < TRANSFORM_EPSILON
        && (left.rotation_deg - right.rotation_deg).abs() < TRANSFORM_EPSILON
        && (left.anchor.x - right.anchor.x).abs() < TRANSFORM_EPSILON
        && (left.anchor.y - right.anchor.y).abs() < TRANSFORM_EPSILON
}

/// The error text for a clip whose effect chain resizes unpredictably.
pub(super) fn unmeasurable_effect_message(effect_label: &str, clip_id: &str) -> String {
    format!(
        "Effect '{}' on clip '{}' changes the picture size in a way the export cannot measure, \
         so the clip's transform cannot be placed",
        effect_label, clip_id
    )
}

/// The error text for an adjustment-layer effect the render cannot time-gate.
///
/// An adjustment layer applies only over the timeline it covers, which the render
/// expresses by gating each of its filters with `enable='between(t,…)'`. FFmpeg
/// refuses a filtergraph that puts `enable` on a filter without timeline support
/// and the whole export dies, quoting an FFmpeg filter name the editor never
/// chose. Naming the clip and the effect instead is the difference between a
/// fixable message and a crash.
pub(super) fn untimeable_adjustment_effect_message(
    effect_label: &str,
    clip_id: &str,
    track_name: &str,
) -> String {
    format!(
        "Effect '{}' is not supported on an adjustment layer (clip '{}' on track '{}'): \
         it cannot be limited to the layer's timeline range. Apply it to the clips \
         underneath instead",
        effect_label, clip_id, track_name
    )
}

/// Measures the media an asset points at.
///
/// FFprobe comes first because it reports what will actually be decoded. The
/// stored `Asset::video` metadata is only a fallback: `ImportAssetCommand::new`
/// files every video away as a placeholder `VideoInfo::default()` (1920x1080)
/// unless the caller enriched it, so trusting it first would silently letterbox
/// or stretch anything imported headlessly.
///
/// Returns `None` when neither source can name the dimensions.
pub(super) fn resolve_asset_source_dimensions(
    asset: &Asset,
    cache: &mut SourceDimensionCache,
) -> Option<(u32, u32)> {
    if let Some(cached) = cache.get(&asset.id) {
        return *cached;
    }

    let probed = match crate::core::assets::MetadataExtractor::extract(&asset.uri) {
        Ok(metadata) => metadata.video.as_ref().map(|video| {
            crate::core::ffmpeg::display_dimensions(
                video.width,
                video.height,
                metadata.rotation_deg,
            )
        }),
        Err(error) => {
            // Silently trusting the stored metadata here is what let a broken
            // file render at the 1920x1080 placeholder size, so the failure has
            // to be visible even when the fallback below rescues the export.
            tracing::warn!(
                asset_id = %asset.id,
                error = %error,
                "Could not probe asset for its source dimensions"
            );
            None
        }
    };

    let resolved = probed
        .or_else(|| stored_asset_source_dimensions(asset))
        .filter(|(width, height)| *width > 0 && *height > 0);

    cache.insert(asset.id.clone(), resolved);
    resolved
}

/// The dimensions an asset's *stored* metadata can vouch for.
///
/// `ImportAssetCommand::new` files unenriched video away as a whole
/// `VideoInfo::default()`, which is a non-zero 1920x1080 and therefore passes
/// every "did we get a size" check while meaning "nobody looked". Recognising
/// that exact placeholder shape is what turns a failed probe into the loud
/// "Could not determine source dimensions" error instead of a stretched render.
fn stored_asset_source_dimensions(asset: &Asset) -> Option<(u32, u32)> {
    let video = asset.video.as_ref()?;
    if *video == crate::core::assets::VideoInfo::default() {
        return None;
    }
    Some((video.width, video.height))
}

/// The picture size the transform stage actually receives.
///
/// The transform emits an absolute `scale=W:H`, so it has to be sized against
/// the frame that reaches it — not against the file on disk. A `Crop` earlier in
/// the clip's chain hands the transform a smaller picture, and `Zoom` hands it a
/// fixed 1280x720 (`zoompan`'s `s=hd720`); sizing off the probed dimensions in
/// either case stretches the clip, even when the only transform is opacity.
///
/// Returns the label of the offending effect when its output size cannot be read
/// off the filter it emits. Guessing there would render silently wrong, so the
/// caller turns it into a validation error naming the clip.
pub(super) fn effective_source_dimensions(
    probed_dimensions: (u32, u32),
    graph: &FilterGraph,
) -> Result<(u32, u32), String> {
    let mut dimensions = probed_dimensions;

    for effect in graph.video_effects() {
        // A masked effect is drawn back over the untouched frame by
        // `apply_effect_through_mask_group`, so the group outputs the size it
        // was handed no matter what the effect body does.
        if effect.masks.has_enabled_masks() {
            continue;
        }

        let body = effect.build_filter_params();
        for segment in split_filter_chain(&body) {
            match filter_segment_dimensions(segment) {
                SegmentDimensions::Unchanged => {}
                SegmentDimensions::Fixed(width, height) if width > 0 && height > 0 => {
                    dimensions = (width, height);
                }
                _ => return Err(effect_type_label(&effect.effect_type)),
            }
        }
    }

    Ok(dimensions)
}

/// How one FFmpeg filter changes the frame size flowing through it.
enum SegmentDimensions {
    /// The filter leaves the frame size alone.
    Unchanged,
    /// The filter outputs this size.
    Fixed(u32, u32),
    /// The filter resizes, but not to a size this can read off the string.
    Unknown,
}

/// Splits a filter chain body into its individual filters.
///
/// Commas separate filters, except inside the quoted expressions FFmpeg accepts
/// as parameter values — `crop=608:1080:'if(lt(t,1),0,120)':0` is one filter, not
/// three.
fn split_filter_chain(body: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut depth = 0_i32;

    for (index, character) in body.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth = depth.saturating_sub(1),
            ',' if !quoted && depth == 0 => {
                segments.push(body[start..index].trim());
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    segments.push(body[start..].trim());

    segments
        .into_iter()
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// Splits one filter's arguments on `:`, respecting quoted expressions.
fn split_filter_arguments(arguments: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut depth = 0_i32;

    for (index, character) in arguments.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '(' if !quoted => depth += 1,
            ')' if !quoted => depth = depth.saturating_sub(1),
            ':' if !quoted && depth == 0 => {
                parts.push(arguments[start..index].trim());
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(arguments[start..].trim());
    parts
}

/// Reads the output size of a single filter.
///
/// Every arm here was checked against `Effect::build_filter_params`: of the
/// filters that builder can emit, `crop` (`Crop`, `AutoReframe`), `zoompan` and
/// the `scale`/`pad` pair a `Zoom` fits its source to the canvas with are the
/// ones that resize. `transpose` never comes out of it today and is listed so a
/// future effect that emits one is caught loudly by
/// [`effective_source_dimensions`] rather than mis-sizing a transform.
fn filter_segment_dimensions(segment: &str) -> SegmentDimensions {
    let (name, arguments) = match segment.split_once('=') {
        Some((name, arguments)) => (name.trim(), arguments),
        None => (segment.trim(), ""),
    };

    let arguments = split_filter_arguments(arguments);

    match name {
        "crop" | "scale" | "pad" => {
            match sized_arguments(&arguments, ("w", "width"), ("h", "height")) {
                Some((width, height)) => SegmentDimensions::Fixed(width, height),
                None => SegmentDimensions::Unknown,
            }
        }
        "zoompan" => match named_argument(&arguments, "s") {
            // `zoompan` defaults to `hd720` when no size is given, which is what
            // the builder relies on when it does pass one.
            None => SegmentDimensions::Fixed(1280, 720),
            Some(size) => match parse_frame_size(size) {
                Some((width, height)) => SegmentDimensions::Fixed(width, height),
                None => SegmentDimensions::Unknown,
            },
        },
        "rotate" => {
            // `rotate` keeps the input size unless it is told otherwise.
            let output_width = named_argument(&arguments, "ow");
            let output_height = named_argument(&arguments, "oh");
            match (output_width, output_height) {
                (None, None) => SegmentDimensions::Unchanged,
                (Some(width), Some(height)) => {
                    match (width.parse::<u32>().ok(), height.parse::<u32>().ok()) {
                        (Some(width), Some(height)) => SegmentDimensions::Fixed(width, height),
                        _ => SegmentDimensions::Unknown,
                    }
                }
                _ => SegmentDimensions::Unknown,
            }
        }
        "scale2ref" | "tile" | "transpose" | "hstack" | "vstack" | "xstack" => {
            SegmentDimensions::Unknown
        }
        _ => SegmentDimensions::Unchanged,
    }
}

/// Reads a filter's width and height, whether they were given by name or position.
fn sized_arguments(
    arguments: &[&str],
    width_names: (&str, &str),
    height_names: (&str, &str),
) -> Option<(u32, u32)> {
    let width = named_argument(arguments, width_names.0)
        .or_else(|| named_argument(arguments, width_names.1))
        .or_else(|| positional_argument(arguments, 0));
    let height = named_argument(arguments, height_names.0)
        .or_else(|| named_argument(arguments, height_names.1))
        .or_else(|| positional_argument(arguments, 1));

    Some((width?.parse().ok()?, height?.parse().ok()?))
}

fn named_argument<'a>(arguments: &[&'a str], name: &str) -> Option<&'a str> {
    arguments.iter().find_map(|argument| {
        argument
            .split_once('=')
            .filter(|(key, _)| key.trim() == name)
            .map(|(_, value)| value.trim())
    })
}

fn positional_argument<'a>(arguments: &[&'a str], index: usize) -> Option<&'a str> {
    let argument = arguments.get(index)?.trim();
    if argument.contains('=') {
        return None;
    }
    Some(argument)
}

/// Parses an FFmpeg frame size, either `WxH` or one of the standard abbreviations.
fn parse_frame_size(size: &str) -> Option<(u32, u32)> {
    let size = size.trim().trim_matches('\'');
    if let Some((width, height)) = size.split_once('x') {
        return Some((width.trim().parse().ok()?, height.trim().parse().ok()?));
    }

    match size {
        "hd480" => Some((852, 480)),
        "hd720" => Some((1280, 720)),
        "hd1080" => Some((1920, 1080)),
        "2k" => Some((2048, 1080)),
        "4k" => Some((4096, 2160)),
        _ => None,
    }
}

/// Emits the filter chain that places one transformed clip on the output canvas.
///
/// The chain is `scale` -> optional `rotate` -> optional alpha -> `overlay` onto
/// a black canvas of the clip's own timeline duration. It ends in the same shape
/// [`append_video_stream_normalization`] produces — `setsar=1,fps=,format=` on a
/// full-canvas frame — so the downstream concat cannot tell the two apart.
#[allow(clippy::too_many_arguments)]
pub(super) fn append_video_transform_composition(
    filter_complex: &mut String,
    input_label: &str,
    output_label: &str,
    layout: &ClipTransformLayout,
    duration_sec: f64,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
    transparent_canvas: bool,
) {
    let staged_label = format!("{}_tx", output_label);
    let canvas_label = format!("{}_bg", output_label);
    let (alpha_format, overlay_format) = transform_composition_formats(pixel_format);
    // A layer of a composite works in `gbrap` throughout and hands the stack a
    // `gbrap` frame; `overlay` then negotiates `auto` down to a full-chroma mode
    // with alpha, because both of its inputs already carry one. In the ordinary
    // opaque path `auto` cannot be trusted — it resolves to the least
    // chroma-capable input, which loses odd overlay offsets — so that path names
    // its mode explicitly.
    let (alpha_format, overlay_format, output_format) = if transparent_canvas {
        (COMPOSITE_LAYER_FORMAT, "auto", COMPOSITE_LAYER_FORMAT)
    } else {
        (alpha_format, overlay_format, pixel_format)
    };

    filter_complex.push_str(&format!(
        "[{}]scale={}:{},setsar=1",
        input_label, layout.scaled_width, layout.scaled_height
    ));

    // A rotated frame needs somewhere transparent for its corners to land in, and
    // a translucent one needs an alpha channel to attenuate. Rotation has to fill
    // with a YUV-alpha format because `rotate` writes its `c=black@0` corners in
    // the working format; plain opacity is cheaper in RGBA, which is the format
    // `colorchannelmixer` works in natively — asking for `yuva` there makes
    // FFmpeg insert a yuva -> argb -> yuva round trip on every frame.
    //
    // A layer of a composite always needs one, whether or not it is rotated or
    // faded: it is drawn onto a transparent canvas, and everything outside its
    // own picture has to stay transparent for the layers beneath to show.
    let staged_alpha_format = if transparent_canvas || layout.is_rotated() {
        Some(alpha_format)
    } else if layout.is_translucent() {
        Some(opacity_only_alpha_format(alpha_format))
    } else {
        None
    };
    if let Some(staged_alpha_format) = staged_alpha_format {
        filter_complex.push_str(&format!(",format={}", staged_alpha_format));
    }

    if layout.is_rotated() {
        filter_complex.push_str(&format!(
            ",rotate={}:ow={}:oh={}:c=black@0",
            format_speed_number(layout.rotation_rad),
            layout.bounding_width,
            layout.bounding_height
        ));
    }

    if layout.is_translucent() {
        filter_complex.push_str(&format!(
            ",colorchannelmixer=aa={}",
            format_speed_number(layout.opacity)
        ));
    }

    filter_complex.push_str(&format!("[{}];", staged_label));

    // The canvas has to last at least one frame or the segment renders empty.
    let minimum_duration_sec = if fps.is_finite() && fps > 0.0 {
        1.0 / fps
    } else {
        TIMELINE_EPSILON_SEC
    };
    let slot_duration_sec = duration_sec.max(minimum_duration_sec);
    // Pad the canvas by one frame beyond the slot: `color` sources land the
    // final frame on a PTS boundary that older FFmpeg releases (6.x) round the
    // other way, coming up one frame short. The frame-indexed trim below caps
    // the segment at the exact count either way.
    append_composition_canvas(
        filter_complex,
        &canvas_label,
        slot_duration_sec + minimum_duration_sec,
        width,
        height,
        fps,
        pixel_format,
        transparent_canvas,
    );

    // No `shortest=1`: it ends the composite at whichever input runs out first,
    // which is the *overlay* whenever the clip's stream is shorter than its slot.
    // A 25 fps source in a 30 fps canvas loses the tail frames that way, and a
    // one-frame still produces no video stream at all. The canvas is the main
    // input and outlasts the slot, `eof_action` defaults to `repeat` so a short
    // overlay holds its last frame, and the frame-indexed `trim` afterwards pins
    // the segment to exactly the slot's frame count — `trim=duration=` sits on
    // the same version-dependent PTS rounding the canvas padding works around.
    let slot_frame_count = ((slot_duration_sec * fps).round() as i64).max(1);
    filter_complex.push_str(&format!(
        "[{}][{}]overlay=x={}:y={}:format={},setsar=1,fps={},trim=end_frame={},setpts=PTS-STARTPTS,format={}[{}];",
        canvas_label,
        staged_label,
        layout.overlay_x,
        layout.overlay_y,
        overlay_format,
        format_speed_number(fps),
        slot_frame_count,
        output_format,
        output_label
    ));
}

/// Emits the filter chain that animates one clip's motion across the canvas.
///
/// The animated twin of [`append_video_transform_composition`]. It ends in the
/// same shape — `setsar=1,fps=,trim=,format=` on a full-canvas frame — so the
/// downstream concat cannot tell an animated segment from a static one.
///
/// Four things differ from the static chain, and each is load-bearing:
///
/// 1. `scale` carries per-frame expressions under `eval=frame`. This is the only
///    stock filter that resizes per frame while keeping a usable output link.
/// 2. The staged clip is **always** given an alpha channel. `overlay` only
///    notices that its overlay input changed size when that input carries alpha;
///    handed an opaque `yuv420p` overlay it silently keeps compositing the first
///    frame's dimensions forever, with no warning. The planar `yuva*` format is
///    also mandatory here — `rgba` staging re-freezes the same way once
///    `overlay`'s own `format` is a `yuv420` mode, so the static path's cheaper
///    `rgba` shortcut for opacity-only clips cannot be reused.
/// 3. The animated `scale` is the **last** filter of the staged chain. Ordering
///    is a correctness constraint here, not a style choice — see the comment on
///    the emitted chain below.
/// 4. `overlay` positions by expression, likewise under `eval=frame`.
///
/// Rotation is absent by construction: the caller only routes a clip here when
/// its motion never turns the picture. `rotate` does not re-configure when its
/// input size changes, so an animated `scale` feeding it freezes the picture at
/// its first frame's size — a rotated motion clip keeps the static fallback.
#[allow(clippy::too_many_arguments)]
pub(super) fn append_animated_video_transform_composition(
    filter_complex: &mut String,
    input_label: &str,
    output_label: &str,
    track: &ClipMotionTrack,
    opacity: f64,
    duration_sec: f64,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
    transparent_canvas: bool,
) {
    let staged_label = format!("{}_tx", output_label);
    let canvas_label = format!("{}_bg", output_label);
    let (alpha_format, overlay_format) = transform_composition_formats(pixel_format);
    // See the static twin: a composite layer works in `gbrap` end to end, and
    // `overlay`'s `auto` is safe only because both its inputs carry alpha there.
    // Measured: a `gbrap`-staged animated layer keeps resizing per frame, so the
    // freeze this path guards against does not return with the format change.
    let (alpha_format, overlay_format, output_format) = if transparent_canvas {
        (COMPOSITE_LAYER_FORMAT, "auto", COMPOSITE_LAYER_FORMAT)
    } else {
        (alpha_format, overlay_format, pixel_format)
    };
    let keyframes = track.keyframes.as_slice();

    let width_expr =
        build_motion_lerp_expression(keyframes, |keyframe| f64::from(keyframe.scaled_width));
    let height_expr =
        build_motion_lerp_expression(keyframes, |keyframe| f64::from(keyframe.scaled_height));

    // Everything that converts pixel format runs *before* the animated `scale`,
    // and nothing runs after it. A filter placed downstream of `scale` that needs
    // a format conversion gets an auto-inserted converter, and that converter is
    // configured once — it keeps rescaling every later frame back to the first
    // frame's dimensions, so the picture pans but stops resizing.
    //
    // `colorchannelmixer` is the filter that trips this: it works in RGB, so in a
    // `yuva*` graph FFmpeg wraps it in a yuva -> argb -> yuva round trip. Left
    // after `scale` it froze a translucent clip's zoom outright (measured on
    // FFmpeg 9.0.1: a 0.4x -> 0.9x zoom held one single frame size for all 60
    // frames). Attenuating alpha does not depend on the frame's size, so hoisting
    // it above `scale` costs nothing and the animation survives.
    filter_complex.push_str(&format!("[{}]format={}", input_label, alpha_format));

    if opacity_needs_alpha_filter(opacity) {
        filter_complex.push_str(&format!(
            ",colorchannelmixer=aa={}",
            format_speed_number(opacity)
        ));
    }

    filter_complex.push_str(&format!(
        ",scale=w='{}':h='{}':eval=frame,setsar=1[{}];",
        width_expr, height_expr, staged_label
    ));

    // Canvas sizing, padding and frame pinning are the static path's, unchanged
    // — see `append_video_transform_composition` for why each is shaped this way.
    let minimum_duration_sec = if fps.is_finite() && fps > 0.0 {
        1.0 / fps
    } else {
        TIMELINE_EPSILON_SEC
    };
    let slot_duration_sec = duration_sec.max(minimum_duration_sec);
    append_composition_canvas(
        filter_complex,
        &canvas_label,
        slot_duration_sec + minimum_duration_sec,
        width,
        height,
        fps,
        pixel_format,
        transparent_canvas,
    );

    // With rotation ruled out, the static layout's placement collapses to
    // `position * canvas - anchor * scaled`, because the bounding box `overlay`
    // is given is exactly the scaled frame. Reading the frame's own size back out
    // of `overlay_w`/`overlay_h` rather than recomputing it keeps the placement
    // on the same clock as the size even when the clip's frame rate differs from
    // the canvas rate.
    let position_x_expr = build_motion_lerp_expression(keyframes, |keyframe| keyframe.position_x);
    let position_y_expr = build_motion_lerp_expression(keyframes, |keyframe| keyframe.position_y);
    let anchor_x_expr = build_motion_lerp_expression(keyframes, |keyframe| keyframe.anchor_x);
    let anchor_y_expr = build_motion_lerp_expression(keyframes, |keyframe| keyframe.anchor_y);

    let slot_frame_count = ((slot_duration_sec * fps).round() as i64).max(1);
    filter_complex.push_str(&format!(
        "[{}][{}]overlay=x='({})*{}-({})*overlay_w':y='({})*{}-({})*overlay_h':eval=frame:format={},setsar=1,fps={},trim=end_frame={},setpts=PTS-STARTPTS,format={}[{}];",
        canvas_label,
        staged_label,
        position_x_expr,
        width,
        anchor_x_expr,
        position_y_expr,
        height,
        anchor_y_expr,
        overlay_format,
        format_speed_number(fps),
        slot_frame_count,
        output_format,
        output_label
    ));
}

/// Builds a piecewise-linear FFmpeg expression in `t` through motion keyframes.
///
/// Produces the same nested-`if` shape the effect keyframe builder uses:
///
/// ```text
/// if(lt(t,T0),V0, if(lt(t,T1),V0+(V1-V0)*(t-T0)/(T1-T0), … , Vlast))
/// ```
///
/// The value is held constant before the first keyframe and after the last, and
/// a keyframe marked `hold` holds its own value for the whole segment that starts
/// at it. That is precisely what `getClipMotionTransformAtTime` does in
/// `src/utils/clipMotion.ts`, so the export samples the curve the preview drew.
///
/// The result is wrapped in `'…'` by the caller, so its commas are literal and no
/// backslash escaping is needed.
fn build_motion_lerp_expression(
    keyframes: &[MotionKeyframeLayout],
    value_of: impl Fn(&MotionKeyframeLayout) -> f64,
) -> String {
    let Some(first) = keyframes.first() else {
        return "0".to_string();
    };
    if keyframes.len() == 1 {
        return format_speed_number(value_of(first));
    }

    let mut expression = String::new();
    let mut depth = 0usize;

    for (index, pair) in keyframes.windows(2).enumerate() {
        let (start, end) = (&pair[0], &pair[1]);
        let start_value = value_of(start);
        let end_value = value_of(end);

        if index == 0 {
            expression.push_str(&format!(
                "if(lt(t,{}),{}",
                format_speed_number(start.time_sec),
                format_speed_number(start_value)
            ));
            depth += 1;
        }

        // The guard has to test the span FFmpeg will actually divide by, not the
        // one Rust computed. Times are emitted through `format_speed_number`, so
        // a span of, say, 1e-7 s survives `span > 0.0` here and then formats to a
        // literal `0` in the graph — a divide-by-zero FFmpeg would meet at run
        // time. Rounding first means the emitted denominator is the tested one.
        let span_text = format_speed_number(end.time_sec - start.time_sec);
        let span_is_usable = span_text
            .parse::<f64>()
            .is_ok_and(|span| span.is_finite() && span > 0.0);

        // A zero-length span is unreachable — the previous branch already
        // consumed every `t` below this one — but `hold` and a degenerate span
        // both resolve to the segment's *start* value, which is what the preview
        // returns when it divides by a zero duration.
        if start.hold || !span_is_usable {
            expression.push_str(&format!(
                ",if(lt(t,{}),{}",
                format_speed_number(end.time_sec),
                format_speed_number(start_value)
            ));
        } else {
            expression.push_str(&format!(
                ",if(lt(t,{}),{}{}{}*(t-{})/{}",
                format_speed_number(end.time_sec),
                format_speed_number(start_value),
                if end_value >= start_value { "+" } else { "-" },
                format_speed_number((end_value - start_value).abs()),
                format_speed_number(start.time_sec),
                span_text
            ));
        }
        depth += 1;
    }

    expression.push_str(&format!(
        ",{}",
        format_speed_number(value_of(&keyframes[keyframes.len() - 1]))
    ));
    for _ in 0..depth {
        expression.push(')');
    }
    expression
}

/// The alpha-carrying format to stage an opacity-only clip in.
///
/// `colorchannelmixer` works in RGB, so an 8-bit clip is cheaper to attenuate in
/// `rgba` than in `yuva420p` — the latter makes FFmpeg auto-insert a conversion
/// to `argb` and back. A 10-bit export has no 8-bit-free RGBA equivalent in the
/// graph's working depth, so it keeps its planar YUV-alpha format.
fn opacity_only_alpha_format(alpha_format: &'static str) -> &'static str {
    match alpha_format {
        "yuva420p" => "rgba",
        other => other,
    }
}

/// The working format and `overlay` mode that keep a composite at the output's
/// bit depth and on the pixel the layout asked for.
///
/// Two separate losses are being avoided here, and the `overlay` mode is what
/// avoids both:
///
/// 1. **Bit depth.** `overlay` defaults to 8-bit, so a 10-bit export whose clip
///    happened to be transformed would quietly lose two bits per channel on the
///    way through.
/// 2. **Placement.** `overlay` composites in whatever mode it is given, and a
///    chroma-subsampled mode cannot address an odd column or row: it rounds the
///    corner down to the nearest chroma sample. A clip the layout placed at an
///    odd `overlay_x`/`overlay_y` therefore rendered a whole pixel up and to the
///    left of where the preview drew it, and picked up chroma bleed along the
///    edge on the way. Measured against the bundled FFmpeg 8.0.1 with a clip
///    placed at (201, 101) on a 1280x720 canvas: `yuv420` landed the picture at
///    (200, 100), `yuv422p10` at (200, 101) — 4:2:2 subsamples horizontally
///    only, so it loses the column and keeps the row — and the 4:4:4 modes below
///    landed it at (201, 101) exactly. The static layout pre-rounds its corner
///    to an even pixel, so it is the *animated* path — whose corner is an
///    expression FFmpeg evaluates per frame, unrounded — that this silently
///    broke: a slow pan stalled every second frame.
///
/// The *staging* format stays chroma-subsampled: it describes a standalone frame
/// whose own origin is aligned, so `overlay` upsamples it to the 4:4:4 working
/// mode before placing it and the corner lands exactly. Staging in RGB instead
/// would add an RGB round trip that shifts the interior colour, which measured
/// as a 1-2 LSB change on flat regions; `yuv444` leaves the interior untouched.
fn transform_composition_formats(pixel_format: &str) -> (&'static str, &'static str) {
    match pixel_format {
        "yuv422p10le" => ("yuva422p10le", "yuv444p10"),
        "yuv420p10le" => ("yuva420p10le", "yuv444p10"),
        _ => ("yuva420p", "yuv444"),
    }
}

/// The canvas a transformed clip is drawn onto.
///
/// Opaque black for a clip that owns its seconds outright — which is what the
/// preview clears to. Transparent for a layer of a composite, because whatever
/// its picture does not cover has to let the layers beneath show through; an
/// opaque canvas there would black them out, and only in the export.
#[allow(clippy::too_many_arguments)]
fn append_composition_canvas(
    filter_complex: &mut String,
    output_label: &str,
    duration_sec: f64,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
    transparent: bool,
) {
    if !transparent {
        append_black_video_gap(
            filter_complex,
            output_label,
            duration_sec,
            width,
            height,
            fps,
            pixel_format,
        );
        return;
    }

    // `colorchannelmixer=aa=0` rather than `color=black@0`: the colour source
    // negotiates its own format, and an alpha given in the colour alone is lost
    // the moment that format has no alpha channel. Converting first and clearing
    // alpha afterwards cannot be negotiated away.
    filter_complex.push_str(&format!(
        "color=c=black:s={}x{}:r={}:d={},format={},colorchannelmixer=aa=0,setsar=1[{}];",
        width,
        height,
        format_speed_number(fps),
        format_speed_number(duration_sec),
        COMPOSITE_LAYER_FORMAT,
        output_label
    ));
}

pub(super) fn append_black_video_gap(
    filter_complex: &mut String,
    output_label: &str,
    duration_sec: f64,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
) {
    filter_complex.push_str(&format!(
        "color=c=black:s={}x{}:r={}:d={},format={}[{}];",
        width,
        height,
        format_speed_number(fps),
        format_speed_number(duration_sec),
        pixel_format,
        output_label
    ));
}

/// Re-expresses a folded segment list in window-local time.
///
/// Runs *after* the transition and composite folds, and that order is the whole
/// design. Both folds count frames off their inputs' absolute timeline spans, so
/// clamping a clip's span to the window before they run would move an `xfade`
/// offset or a composite's backdrop length and blend at the wrong frame. Folding
/// first means every stream reaching here is bit-for-bit the stream a full
/// render would build; all this pass does is decide where each one starts.
///
/// Three things happen to a segment:
///
/// 1. A segment sharing no frame with the window is sent to `nullsink`. It
///    cannot simply be dropped: a filtergraph with an unconnected output is a
///    hard error, and the builder emits chains for whole transition and
///    composite groups even when only part of a group is inside the window.
/// 2. A segment straddling the window's first frame has the frames in front of
///    it dropped with a frame-indexed `trim`. That count — window start frame
///    minus segment start frame — is exactly how many of that segment's frames
///    a full render would have written before the window began, which is what
///    makes the window a *slice* of the full render rather than a re-render.
///    Dropping frames here rather than re-anchoring each clip's filters is also
///    what keeps a Ken Burns move, an authored fade or an auto-reframe track
///    playing from the middle: their chains never learn the window exists.
/// 3. Every surviving span is rebased so the window's first frame is `t = 0`.
///
/// A window that ends up holding no picture at all — a range over the black tail
/// past the last clip — gets a black canvas the length of the window, which is
/// what the full render's tail padding would have put there.
#[allow(clippy::too_many_arguments)]
pub(super) fn shape_video_segments_to_window(
    filter_complex: &mut String,
    segments: Vec<VideoTimelineSegment>,
    window: &RenderWindow,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
) -> Vec<VideoTimelineSegment> {
    if !window.is_ranged() {
        return segments;
    }

    let mut shaped: Vec<VideoTimelineSegment> = Vec::with_capacity(segments.len());

    for (index, segment) in segments.into_iter().enumerate() {
        if !window.covers(segment.start_sec, segment.end_sec) {
            filter_complex.push_str(&format!("{}nullsink;", segment.stream_label));
            continue;
        }

        let segment_start_frame = window.frame_at(segment.start_sec);
        let dropped_frames = window.start_frame() - segment_start_frame;

        let (stream_label, start_sec) = if dropped_frames > 0 {
            let trimmed_label = format!("[vwin{}]", index);
            filter_complex.push_str(&format!(
                "{}trim=start_frame={},setpts=PTS-STARTPTS{};",
                segment.stream_label, dropped_frames, trimmed_label
            ));
            (trimmed_label, window.start_sec())
        } else {
            (segment.stream_label.clone(), segment.start_sec)
        };

        shaped.push(
            VideoTimelineSegment::new(
                stream_label,
                window.rebase(start_sec),
                window.rebase(segment.end_sec),
            )
            .with_layer(segment.layer),
        );
    }

    if shaped.is_empty() {
        let blank_label = "vwinblank";
        append_black_video_gap(
            filter_complex,
            blank_label,
            window.len_sec(),
            width,
            height,
            fps,
            pixel_format,
        );
        shaped.push(VideoTimelineSegment::new(
            format!("[{}]", blank_label),
            0.0,
            window.len_sec(),
        ));
    }

    shaped
}

pub(super) fn append_timeline_video_output(
    filter_complex: &mut String,
    segments: &[VideoTimelineSegment],
    timeline_end_sec: f64,
    width: u32,
    height: u32,
    fps: f64,
    pixel_format: &str,
) -> Result<(), ExportError> {
    let mut sorted_segments: Vec<&VideoTimelineSegment> = segments
        .iter()
        .filter(|segment| segment.end_sec > segment.start_sec + TIMELINE_EPSILON_SEC)
        .collect();

    if sorted_segments.is_empty() {
        return Err(ExportError::InvalidSettings(
            "Sequence has no visual clips to export".to_string(),
        ));
    }

    sorted_segments.sort_by(|a, b| {
        a.start_sec
            .partial_cmp(&b.start_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut parts: Vec<VideoConcatPart> = Vec::new();
    let mut cursor = 0.0_f64;
    let mut gap_index = 0_usize;

    for segment in sorted_segments {
        let start = segment.start_sec.max(0.0);
        let end = segment.end_sec.max(start);

        if start > cursor + TIMELINE_EPSILON_SEC {
            let gap_label = format!("vgap{}", gap_index);
            append_black_video_gap(
                filter_complex,
                &gap_label,
                start - cursor,
                width,
                height,
                fps,
                pixel_format,
            );
            parts.push(VideoConcatPart {
                stream_label: format!("[{}]", gap_label),
            });
            gap_index += 1;
            cursor = start;
        }

        parts.push(VideoConcatPart {
            stream_label: segment.stream_label.clone(),
        });
        cursor = cursor.max(end);
    }

    if timeline_end_sec.is_finite() && timeline_end_sec > cursor + TIMELINE_EPSILON_SEC {
        let gap_label = format!("vgap{}", gap_index);
        append_black_video_gap(
            filter_complex,
            &gap_label,
            timeline_end_sec - cursor,
            width,
            height,
            fps,
            pixel_format,
        );
        parts.push(VideoConcatPart {
            stream_label: format!("[{}]", gap_label),
        });
    }

    if parts.len() == 1 {
        filter_complex.push_str(&format!("{}null[outv]", parts[0].stream_label));
        return Ok(());
    }

    let mut current_stream = parts[0].stream_label.clone();

    for i in 0..parts.len() - 1 {
        let next_stream = &parts[i + 1].stream_label;
        let output_label = if i == parts.len() - 2 {
            "[outv]".to_string()
        } else {
            format!("[vseq{}]", i)
        };

        // Every boundary is a straight concat, so the finished video is exactly
        // as long as the timeline says it is.
        filter_complex.push_str(&format!(
            "{}{}concat=n=2:v=1:a=0{}",
            current_stream, next_stream, output_label
        ));

        if i < parts.len() - 2 {
            filter_complex.push(';');
            current_stream = output_label;
        }
    }

    Ok(())
}

pub(super) fn append_master_audio_output(
    filter_complex: &mut String,
    audio_streams: &[String],
    master_volume_db: f32,
    timeline_end_sec: f64,
) -> Option<String> {
    if audio_streams.is_empty() {
        return None;
    }

    const BASE_AUDIO_LABEL: &str = "[outa_base]";
    const FINAL_AUDIO_LABEL: &str = "[outa]";

    // Audio that runs out before the picture does leaves the muxer with a
    // stream shorter than the video, and an export range that starts after the
    // last audio clip receives no packets at all — which fails the whole
    // output. Silence fills the tail so every renderable range carries audio.
    let tail_padding = if timeline_end_sec.is_finite() && timeline_end_sec > 0.0 {
        format!(",apad=whole_dur={}", format_speed_number(timeline_end_sec))
    } else {
        String::new()
    };

    filter_complex.push(';');
    if audio_streams.len() == 1 {
        filter_complex.push_str(&format!(
            "{}anull{}{}",
            audio_streams[0], tail_padding, BASE_AUDIO_LABEL
        ));
    } else {
        filter_complex.push_str(&audio_streams.join(""));
        filter_complex.push_str(&format!(
            "amix=inputs={}:duration=longest:dropout_transition=0:normalize=0{}{}",
            audio_streams.len(),
            tail_padding,
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

fn effective_text_layer_opacity(text_opacity: f64, clip_opacity: f32) -> f64 {
    let clip_opacity = if clip_opacity.is_finite() {
        (clip_opacity as f64).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let text_opacity = text_opacity.clamp(0.0, 1.0);

    if (text_opacity - clip_opacity).abs() < 0.001 {
        text_opacity
    } else {
        text_opacity * clip_opacity
    }
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

    let text_opacity = effect.get_float("opacity").unwrap_or(1.0).clamp(0.0, 1.0);
    effect.set_param(
        "opacity",
        ParamValue::Float(effective_text_layer_opacity(text_opacity, clip.opacity)),
    );

    if let Some(font_size) = effect.get_float("font_size") {
        let scale_x = if clip.transform.scale.x.is_finite() {
            clip.transform.scale.x.abs().clamp(0.01, 100.0)
        } else {
            1.0
        };
        let scale_y = if clip.transform.scale.y.is_finite() {
            clip.transform.scale.y.abs().clamp(0.01, 100.0)
        } else {
            1.0
        };
        let normalized_scale = ((scale_x + scale_y) / 2.0).clamp(0.01, 100.0);

        let scaled_font_size = (font_size * normalized_scale).clamp(1.0, 500.0);
        effect.set_param("font_size", ParamValue::Float(scaled_font_size));
        effect.set_param(
            "scale_x_percent",
            ParamValue::Float((scale_x / normalized_scale) * 100.0),
        );
        effect.set_param(
            "scale_y_percent",
            ParamValue::Float((scale_y / normalized_scale) * 100.0),
        );
    }
}

fn get_json_field<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key))
}

/// Reads a caption's numeric field, refusing anything that is not a real number.
///
/// `f64::from_str` accepts `"NaN"`, `"inf"` and `"-Infinity"`, and every consumer
/// of this value goes on to `clamp` it — which returns NaN unchanged rather than
/// pulling it into range. A style blob carrying `{"fontSize": "NaN"}` therefore
/// used to reach `format!("{:.2}")` and put the literal text `NaN` in an ASS
/// style column, which libass reads as a parse failure for the whole line. A
/// non-finite field is treated as absent, so the caller's `unwrap_or` default
/// applies exactly as it would for a missing key.
fn parse_json_number(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        _ => None,
    };

    parsed.filter(|number| number.is_finite())
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

/// Vertical band a preset caption sits in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptionVertical {
    Top,
    Center,
    Bottom,
}

impl CaptionVertical {
    /// Anything unrecognized falls to the bottom, which is where an
    /// unannotated caption has always rendered.
    fn parse(raw: &str) -> Self {
        match raw {
            "top" => Self::Top,
            "center" | "middle" => Self::Center,
            _ => Self::Bottom,
        }
    }
}

fn normalized_caption_margin_percent(margin_percent: f64) -> f64 {
    (if margin_percent.is_finite() {
        margin_percent
    } else {
        CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT
    })
    .clamp(0.0, 50.0)
}

fn vertical_position_to_y(vertical: CaptionVertical, margin_percent: f64) -> f64 {
    let margin = normalized_caption_margin_percent(margin_percent) / 100.0;

    match vertical {
        CaptionVertical::Top => margin,
        CaptionVertical::Center => 0.5,
        CaptionVertical::Bottom => 1.0 - margin,
    }
}

/// How a caption clip is anchored on the canvas.
///
/// The distinction survives all the way into the ASS script: a preset anchor
/// becomes margins, which libass is free to wrap inside, while a custom anchor
/// becomes `\pos`, which disables margins entirely.
#[derive(Clone, Copy, Debug, PartialEq)]
enum CaptionAnchor {
    /// One of the vertical presets, held off its edge by a margin.
    Preset {
        vertical: CaptionVertical,
        margin_percent: f64,
    },
    /// An explicit point, as a fraction of the canvas.
    Custom { x: f64, y: f64 },
}

/// Horizontal anchor a preset caption uses for the given alignment.
///
/// Left-aligned text grows right from the left margin, right-aligned text grows
/// left from the right margin, and centered text straddles the middle.
///
/// Exposed to the crate so the curated caption pack contract tests assert
/// against this rule rather than against a copy of it.
pub(crate) fn caption_preset_anchor_x(alignment: &str) -> f64 {
    match alignment {
        "left" => CAPTION_SIDE_MARGIN_PERCENT / 100.0,
        "right" => 1.0 - CAPTION_SIDE_MARGIN_PERCENT / 100.0,
        _ => 0.5,
    }
}

fn resolve_caption_anchor(position: Option<&Value>, style: Option<&Value>) -> CaptionAnchor {
    // No stored position renders where a caption always has: along the bottom,
    // `CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT` of the canvas clear of the edge.
    // The preview draws a positionless caption from the same number, so the two
    // have to read it from one definition or a caption created without a
    // position sits at one height on screen and another in the file.
    let mut anchor = CaptionAnchor::Preset {
        vertical: CaptionVertical::Bottom,
        margin_percent: CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT,
    };

    if let Some(position_value) = position {
        if let Some(preset) = position_value.as_str() {
            return CaptionAnchor::Preset {
                vertical: CaptionVertical::parse(preset),
                margin_percent: CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT,
            };
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
                        .unwrap_or(CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT);
                return CaptionAnchor::Preset {
                    vertical: CaptionVertical::parse(vertical),
                    margin_percent,
                };
            }

            // A custom anchor has to name at least one coordinate. An empty
            // object, or a `type: "custom"` with nothing in it, is a caller
            // saying "no opinion" - and turning that into a point would cost
            // the caption everything the default gives it, since the burn-in
            // expresses a point as `\pos` and loses wrapping, margins and the
            // alignment-driven anchor along with it. `resolve_caption_position_
            // percent` in `graph.rs` reads it the same way.
            let custom_x = get_json_field(position_object, &["xPercent", "x_percent", "x"])
                .and_then(parse_json_number);
            let custom_y = get_json_field(position_object, &["yPercent", "y_percent", "y"])
                .and_then(parse_json_number);

            if custom_x.is_some() || custom_y.is_some() {
                anchor = CaptionAnchor::Custom {
                    x: custom_x.map(normalize_caption_axis).unwrap_or(0.5),
                    y: custom_y
                        .map(normalize_caption_axis)
                        .unwrap_or(CAPTION_CUSTOM_DEFAULT_Y_PERCENT / 100.0),
                };
            }
        }
    }

    if let Some(style_object) = style.and_then(Value::as_object) {
        if let Some(vertical_align) =
            get_json_field(style_object, &["verticalAlign", "vertical_align"])
                .and_then(Value::as_str)
        {
            let mapped = match vertical_align {
                "top" => Some(CaptionVertical::Top),
                "middle" | "center" => Some(CaptionVertical::Center),
                "bottom" => Some(CaptionVertical::Bottom),
                _ => None,
            };

            // The style's vertical alignment overrides only the vertical axis,
            // so a custom anchor keeps the x its author chose.
            if let Some(vertical) = mapped {
                anchor = match anchor {
                    CaptionAnchor::Custom { x, .. } => CaptionAnchor::Custom {
                        x,
                        y: vertical_position_to_y(vertical, 10.0),
                    },
                    CaptionAnchor::Preset { .. } => CaptionAnchor::Preset {
                        vertical,
                        margin_percent: 10.0,
                    },
                };
            }
        }
    }

    anchor
}

/// Resolves an anchor to the fractional canvas position the `drawtext`
/// fallback draws at.
fn caption_anchor_position(anchor: CaptionAnchor, alignment: &str) -> (f64, f64) {
    match anchor {
        CaptionAnchor::Preset {
            vertical,
            margin_percent,
        } => (
            caption_preset_anchor_x(alignment),
            vertical_position_to_y(vertical, margin_percent),
        ),
        CaptionAnchor::Custom { x, y } => (x, y),
    }
}

/// Which edge of the text block the resolved y names, for the `drawtext` path.
///
/// A preset margin is a gap to the block's near edge - "10% from the bottom"
/// means the bottom of the last line sits a tenth of the canvas above the
/// bottom edge, and the block grows toward the middle of the frame from there.
/// That is what libass does with the event margins the ASS path writes, and
/// what the preview draws, so the fallback has to say the same thing. A custom
/// position names a point the author picked and stays centered on it.
fn caption_vertical_anchor_edge(anchor: CaptionAnchor) -> &'static str {
    match anchor {
        CaptionAnchor::Preset { vertical, .. } => match vertical {
            CaptionVertical::Top => "top",
            CaptionVertical::Center => "center",
            CaptionVertical::Bottom => "bottom",
        },
        CaptionAnchor::Custom { .. } => "center",
    }
}

fn font_weight_implies_bold(value: &Value) -> Option<bool> {
    if let Some(raw) = value.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "bold" | "semibold" | "black" | "heavy") {
            return Some(true);
        }

        return normalized
            .parse::<f64>()
            .ok()
            .map(|weight| weight >= 600.0)
            .or(Some(false));
    }

    parse_json_number(value).map(|weight| weight >= 600.0)
}

/// Numeric CSS weight a caption style's `fontWeight` names, clamped to the
/// 100-900 range libass understands.
///
/// Accepts the keyword spellings the editor and imported projects both use, so
/// `"bold"` and `700` reach libass as the same `\b700`.
fn caption_font_weight(value: &Value) -> Option<i64> {
    let clamp = |weight: f64| (weight.round() as i64).clamp(100, 900);

    if let Some(raw) = value.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        return match normalized.as_str() {
            "thin" => Some(100),
            "extralight" | "ultralight" => Some(200),
            "light" => Some(300),
            "normal" | "regular" => Some(400),
            "medium" => Some(500),
            "semibold" | "demibold" => Some(600),
            "bold" => Some(700),
            "extrabold" | "ultrabold" => Some(800),
            "black" | "heavy" => Some(900),
            _ => normalized.parse::<f64>().ok().map(clamp),
        };
    }

    parse_json_number(value).map(clamp)
}

fn build_caption_text_effect(clip: &Clip) -> Option<Effect> {
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

        // Each decoration carries its own alpha. Dropping it collapsed every
        // translucent box or shadow to fully opaque, so a style that promised
        // to let the footage read through hid it instead.
        if let Some(background_value) =
            get_json_field(style, &["backgroundColor", "background_color"])
        {
            if let Some((hex, alpha)) = parse_caption_color(background_value) {
                effect.set_param("background_color", ParamValue::String(hex));
                if let Some(alpha) = alpha {
                    effect.set_param(
                        "background_opacity",
                        ParamValue::Float(alpha.clamp(0.0, 1.0)),
                    );
                }
            }
        }

        if let Some(background_padding) =
            get_json_field(style, &["backgroundPadding", "background_padding"])
                .and_then(parse_json_number)
        {
            effect.set_param(
                "background_padding",
                ParamValue::Int(background_padding.clamp(0.0, 500.0).round() as i64),
            );
        }

        if let Some(shadow_value) = get_json_field(style, &["shadowColor", "shadow_color"]) {
            if let Some((hex, alpha)) = parse_caption_color(shadow_value) {
                effect.set_param("shadow_color", ParamValue::String(hex));
                if let Some(alpha) = alpha {
                    effect.set_param("shadow_opacity", ParamValue::Float(alpha.clamp(0.0, 1.0)));
                }
            }
        }

        if let Some(outline_value) = get_json_field(style, &["outlineColor", "outline_color"]) {
            if let Some((hex, alpha)) = parse_caption_color(outline_value) {
                effect.set_param("outline_color", ParamValue::String(hex));
                if let Some(alpha) = alpha {
                    effect.set_param("outline_opacity", ParamValue::Float(alpha.clamp(0.0, 1.0)));
                }
            }
        }

        let shadow_offset =
            get_json_field(style, &["shadowOffset", "shadow_offset"]).and_then(parse_json_number);
        let shadow_offset_x = get_json_field(
            style,
            &["shadowOffsetX", "shadow_offset_x", "shadowX", "shadow_x"],
        )
        .and_then(parse_json_number)
        .or(shadow_offset);
        let shadow_offset_y = get_json_field(
            style,
            &["shadowOffsetY", "shadow_offset_y", "shadowY", "shadow_y"],
        )
        .and_then(parse_json_number)
        .or(shadow_offset);

        if let Some(shadow_offset_x) = shadow_offset_x {
            effect.set_param(
                "shadow_x",
                ParamValue::Int(shadow_offset_x.clamp(-500.0, 500.0).round() as i64),
            );
        }

        if let Some(shadow_offset_y) = shadow_offset_y {
            effect.set_param(
                "shadow_y",
                ParamValue::Int(shadow_offset_y.clamp(-500.0, 500.0).round() as i64),
            );
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

        // The ASS style carries Underline, Spacing and \blur, so a caption can
        // reach the same typography a text clip already does. `drawtext` has no
        // equivalent for any of the three and ignores these params, so the
        // fallback path is unchanged.
        if let Some(underline) = get_json_field(style, &["underline"]).and_then(parse_json_bool) {
            effect.set_param("underline", ParamValue::Bool(underline));
        }

        if let Some(letter_spacing) =
            get_json_field(style, &["letterSpacing", "letter_spacing"]).and_then(parse_json_number)
        {
            effect.set_param(
                "letter_spacing",
                ParamValue::Int(letter_spacing.clamp(-100.0, 200.0).round() as i64),
            );
        }

        if let Some(shadow_blur) =
            get_json_field(style, &["shadowBlur", "shadow_blur"]).and_then(parse_json_number)
        {
            effect.set_param(
                "shadow_blur",
                ParamValue::Int(shadow_blur.clamp(0.0, 500.0).round() as i64),
            );
        }

        let font_weight_field = get_json_field(style, &["fontWeight", "font_weight"]);
        let bold = get_json_field(style, &["bold"])
            .and_then(parse_json_bool)
            .or_else(|| font_weight_field.and_then(font_weight_implies_bold));
        if let Some(bold) = bold {
            effect.set_param("bold", ParamValue::Bool(bold));
        }

        // libass reads a literal `\b<weight>` as an absolute weight and lets it
        // beat the style's `Bold` column, so an event that always emitted
        // `\b400` cancelled its own `Bold: -1` and no caption ever came out
        // bold. Name the weight the style implies instead of leaving the
        // default in place. The `drawtext` fallback derives the same bold flag
        // from this param, so the two renderers stay in step.
        let font_weight = font_weight_field
            .and_then(caption_font_weight)
            .unwrap_or(if bold.unwrap_or(false) { 700 } else { 400 });
        effect.set_param("font_weight", ParamValue::Int(font_weight));

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

    let anchor =
        resolve_caption_anchor(clip.caption_position.as_ref(), clip.caption_style.as_ref());
    let (x, y) = caption_anchor_position(anchor, &caption_effect_alignment(&effect));
    effect.set_param("x", ParamValue::Float(x));
    effect.set_param("y", ParamValue::Float(y));
    effect.set_param(
        "vertical_anchor",
        ParamValue::String(caption_vertical_anchor_edge(anchor).to_string()),
    );
    let text_opacity = effect.get_float("opacity").unwrap_or(1.0);
    effect.set_param(
        "opacity",
        ParamValue::Float(effective_text_layer_opacity(text_opacity, clip.opacity)),
    );

    Some(effect)
}

/// Builds the time-gated `drawtext` filter a caption clip renders as.
///
/// Exposed to the crate so the curated caption pack contract tests can assert
/// against the real render seam instead of a re-implementation of it.
#[cfg(test)]
pub(crate) fn build_caption_drawtext_with_enable(clip: &Clip) -> Option<String> {
    build_caption_drawtext_in_window(clip, 0.0)
}

/// [`build_caption_drawtext_with_enable`], with the clip's timing rebased.
///
/// `window_start_sec` is where the render's own clock begins on the timeline, so
/// a caption already on screen when a ranged render opens gets a negative start
/// — which `.max(0.0)` below turns into "on from the first frame", exactly what
/// the full render draws there.
///
/// A caption that *ended* before the window opened must not be drawn at all: its
/// rebased end is negative, and `between` is inclusive, so clamping that end to
/// `0.0` would paint it onto the window's first frame (`t == 0`). The full render
/// draws nothing there, so a rebased end below zero drops the overlay. An end of
/// exactly `0.0` is kept — the full render's frame at `window_start` carries the
/// caption's last (inclusive) frame, so the window's first frame must too.
fn build_caption_drawtext_in_window(clip: &Clip, window_start_sec: f64) -> Option<String> {
    let effect = build_caption_text_effect(clip)?;

    let start = clip.place.timeline_in_sec;
    let end = clip.place.timeline_out_sec();
    if !start.is_finite() || !end.is_finite() || end <= start {
        return None;
    }

    let rebased_end = end - window_start_sec;
    if rebased_end < 0.0 {
        return None;
    }

    let filter_body = effect.to_filter_body();
    Some(format!(
        "{}:enable='between(t,{:.6},{:.6})'",
        filter_body,
        (start - window_start_sec).max(0.0),
        rebased_end
    ))
}

pub(super) fn collect_enabled_clips_sorted(sequence: &Sequence) -> Vec<(&Clip, &Track)> {
    let mut all_clips: Vec<(&Clip, &Track)> = Vec::new();

    for track in &sequence.tracks {
        if !track_included_in_media_collection(track) {
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

/// Label prefix for a stream a caption clip has been drawn onto.
const CAPTION_OVERLAY_LABEL_PREFIX: &str = "capv";
/// Label prefix for a stream a text clip has been drawn onto.
const TEXT_CLIP_OVERLAY_LABEL_PREFIX: &str = "txtv";

/// Returns true when the track paints into the output picture.
///
/// Audio tracks contribute sound only, so they take no position in the visual
/// stack even though [`track_included_in_media_collection`] keeps them.
fn track_draws_into_picture(track: &Track) -> bool {
    track_included_in_media_collection(track)
        && matches!(
            track.kind,
            TrackKind::Video | TrackKind::Overlay | TrackKind::Caption
        )
}

/// Maps each drawing track's id to its back-to-front position in the stack.
///
/// This mirrors [`crate::core::render::graph::build_render_graph`], which walks
/// `sequence.tracks` in reverse: the bottom-most drawing track is composited
/// first and track index 0 — the topmost track — is composited last, in front
/// of everything below it. Depth 0 is therefore the bottom-most drawing track
/// and the topmost track carries the highest depth.
///
/// Both burn-in paths order themselves by this one answer, so neither can
/// invent a stacking convention of its own.
fn visual_stack_depths(sequence: &Sequence) -> HashMap<&str, usize> {
    let drawing_tracks: Vec<&str> = sequence
        .tracks
        .iter()
        .filter(|track| track_draws_into_picture(track))
        .map(|track| track.id.as_str())
        .collect();

    let bottom_most = drawing_tracks.len().saturating_sub(1);
    drawing_tracks
        .into_iter()
        .enumerate()
        .map(|(position, track_id)| (track_id, bottom_most - position))
        .collect()
}

/// One time-gated `drawtext` filter plus where its track sits in the stack.
pub(super) struct DrawtextTextOverlay {
    /// Back-to-front position of the owning track (see [`visual_stack_depths`]).
    stack_depth: usize,
    /// Prefix the composited stream's label is built from.
    label_prefix: &'static str,
    filter: String,
}

/// Builds every `drawtext` overlay the fallback burn-in path draws, back to front.
///
/// The caller is expected to pass only enabled clips (e.g. from
/// [`collect_enabled_clips_sorted`]), so no additional `clip.enabled`
/// check is performed here.
///
/// Captions and text clips are collected together because they share one filter
/// chain: keeping them in separate chains would have made every caption draw
/// over every text clip regardless of which track was on top.
///
/// `window` is the stretch of timeline this render writes; every clip's `enable`
/// gate is expressed in the render's own clock, which starts at the window.
pub(super) fn collect_drawtext_text_overlays(
    sequence: &Sequence,
    all_clips: &[(&Clip, &Track)],
    effects: &HashMap<String, Effect>,
    window: &RenderWindow,
) -> Result<Vec<DrawtextTextOverlay>, ExportError> {
    let window_start_sec = window.start_sec();
    let stack_depths = visual_stack_depths(sequence);
    let mut overlays = Vec::new();

    for (clip, track) in all_clips {
        let stack_depth = stack_depths.get(track.id.as_str()).copied().unwrap_or(0);

        if track.kind == TrackKind::Caption {
            if let Some(filter) = build_caption_drawtext_in_window(clip, window_start_sec) {
                overlays.push(DrawtextTextOverlay {
                    stack_depth,
                    label_prefix: CAPTION_OVERLAY_LABEL_PREFIX,
                    filter,
                });
            }
        } else if matches!(track.kind, TrackKind::Video | TrackKind::Overlay) && is_text_clip(clip)
        {
            if let Some(filter) =
                build_text_clip_drawtext_in_window(clip, effects, window_start_sec)?
            {
                overlays.push(DrawtextTextOverlay {
                    stack_depth,
                    label_prefix: TEXT_CLIP_OVERLAY_LABEL_PREFIX,
                    filter,
                });
            }
        }
    }

    // A `drawtext` chain paints in order, so the last filter wins the pixel.
    // Ordering by ascending depth runs the chain back to front — bottom-most
    // track first, topmost track last — which is the order the compositor uses.
    // The sort is stable, so clips keep the timeline order `all_clips` has
    // inside a single track.
    overlays.sort_by_key(|overlay| overlay.stack_depth);

    Ok(overlays)
}

/// Chains the overlays onto `base_video_label`, in the order given.
pub(super) fn append_drawtext_text_overlays(
    filter_complex: &mut String,
    base_video_label: &str,
    overlays: &[DrawtextTextOverlay],
) -> String {
    let mut current_video_label = base_video_label.to_string();
    let mut caption_count = 0usize;
    let mut text_clip_count = 0usize;

    for overlay in overlays {
        let count = if overlay.label_prefix == CAPTION_OVERLAY_LABEL_PREFIX {
            &mut caption_count
        } else {
            &mut text_clip_count
        };
        let next_video_label = format!("[{}{}]", overlay.label_prefix, count);
        *count += 1;

        filter_complex.push(';');
        filter_complex.push_str(&format!(
            "{}{}{}",
            current_video_label, overlay.filter, next_video_label
        ));
        current_video_label = next_video_label;
    }

    current_video_label
}

/// Builds the time-gated `drawtext` filter a text overlay clip renders as.
///
/// Exposed to the crate so the curated text preset contract tests can assert a
/// preset's typography survives all the way to the filter string.
#[cfg(test)]
pub(crate) fn build_text_clip_drawtext_with_enable(
    clip: &Clip,
    effects: &HashMap<String, Effect>,
) -> Result<String, ExportError> {
    Ok(build_text_clip_drawtext_in_window(clip, effects, 0.0)?
        .expect("a valid text clip rebased against window start 0 always renders"))
}

/// [`build_text_clip_drawtext_with_enable`], with the clip's timing rebased.
///
/// See [`build_caption_drawtext_in_window`] for what `window_start_sec` means,
/// including why a clip that ended before the window (rebased end below zero)
/// renders nothing — here `Ok(None)` so the caller drops the overlay.
fn build_text_clip_drawtext_in_window(
    clip: &Clip,
    effects: &HashMap<String, Effect>,
    window_start_sec: f64,
) -> Result<Option<String>, ExportError> {
    let resolved_text_effect = build_text_clip_effect_with_transform(clip, effects)?;

    let start = clip.place.timeline_in_sec;
    let end = clip.place.timeline_out_sec();
    if !start.is_finite() || !end.is_finite() || end <= start {
        return Err(ExportError::InvalidSettings(format!(
            "Text clip '{}' has invalid timing",
            clip.id
        )));
    }

    let rebased_end = end - window_start_sec;
    if rebased_end < 0.0 {
        return Ok(None);
    }

    Ok(Some(format!(
        "{}:enable='between(t,{:.6},{:.6})'",
        resolved_text_effect.to_filter_body(),
        (start - window_start_sec).max(0.0),
        rebased_end
    )))
}

fn build_text_clip_effect_with_transform(
    clip: &Clip,
    effects: &HashMap<String, Effect>,
) -> Result<Effect, ExportError> {
    let text_effect = clip
        .effects
        .iter()
        .find_map(|effect_id| {
            effects
                .get(effect_id)
                .filter(|effect| effect.effect_type == EffectType::TextOverlay && effect.enabled)
        })
        .ok_or_else(|| {
            ExportError::InvalidSettings(format!(
                "Text clip '{}' is missing an enabled TextOverlay effect",
                clip.id
            ))
        })?;

    let mut resolved_text_effect = text_effect.clone();
    apply_text_transform_overrides(&mut resolved_text_effect, clip);
    Ok(resolved_text_effect)
}

pub(super) fn generated_text_visual_end_sec(all_clips: &[(&Clip, &Track)]) -> f64 {
    all_clips
        .iter()
        .filter(|(clip, track)| {
            track.kind == TrackKind::Caption
                || (matches!(track.kind, TrackKind::Video | TrackKind::Overlay)
                    && is_text_clip(clip))
        })
        .map(|(clip, _track)| clip.place.timeline_out_sec())
        .filter(|end| end.is_finite())
        .fold(0.0_f64, f64::max)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AssColor {
    red: u8,
    green: u8,
    blue: u8,
    alpha: u8,
}

impl AssColor {
    fn from_hex(raw: &str, fallback: &str, opacity: f64) -> Self {
        let opacity = opacity.clamp(0.0, 1.0);
        let (hex, alpha) = parse_hex_color(raw)
            .or_else(|| parse_hex_color(fallback))
            .unwrap_or_else(|| ("#FFFFFF".to_string(), None));
        let hex = hex.trim_start_matches('#');
        let red = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255);
        let green = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255);
        let blue = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255);
        let visible_alpha = alpha.unwrap_or(1.0).clamp(0.0, 1.0) * opacity;
        let alpha = ((1.0 - visible_alpha) * 255.0).round().clamp(0.0, 255.0) as u8;

        Self {
            red,
            green,
            blue,
            alpha,
        }
    }

    fn transparent_black() -> Self {
        Self {
            red: 0,
            green: 0,
            blue: 0,
            alpha: 255,
        }
    }

    fn ass_value(self) -> String {
        format!(
            "&H{:02X}{:02X}{:02X}{:02X}",
            self.alpha, self.blue, self.green, self.red
        )
    }
}

fn ass_timecode(seconds: f64) -> String {
    let total_centiseconds = (seconds.max(0.0) * 100.0).round() as u64;
    let centiseconds = total_centiseconds % 100;
    let total_seconds = total_centiseconds / 100;
    let secs = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let mins = total_minutes % 60;
    let hours = total_minutes / 60;

    format!("{hours}:{mins:02}:{secs:02}.{centiseconds:02}")
}

fn ass_sanitize_style_field(raw: &str, fallback: &str) -> String {
    let sanitized = raw.replace([',', '\r', '\n', '\t'], " ").trim().to_string();

    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn ass_escape_text(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut escaped = String::with_capacity(normalized.len());

    for ch in normalized.chars() {
        match ch {
            '\n' => escaped.push_str(r"\N"),
            '\\' => escaped.push_str(r"\\"),
            '{' => escaped.push_str(r"\{"),
            '}' => escaped.push_str(r"\}"),
            _ if ch.is_control() => escaped.push(' '),
            _ => escaped.push(ch),
        }
    }

    escaped
}

/// Reads the horizontal alignment an effect stores, normalized.
fn caption_effect_alignment(effect: &Effect) -> String {
    effect
        .get_param("alignment")
        .and_then(ParamValue::as_str)
        .unwrap_or("center")
        .to_ascii_lowercase()
}

/// Numpad alignment for a `\pos`-anchored block.
///
/// Always the middle row, so the block centers vertically on the point it is
/// positioned at - which is what both the preview and the `drawtext` fallback
/// do with the same coordinates.
fn ass_alignment_from_effect(effect: &Effect) -> i32 {
    match caption_effect_alignment(effect).as_str() {
        "left" => 4,
        "right" => 6,
        _ => 5,
    }
}

/// Full numpad alignment for a margin-anchored block.
///
/// Rows 1-3 sit on the bottom margin, 4-6 center vertically, 7-9 hang from the
/// top margin; the column follows the text's own alignment.
fn ass_numpad_alignment(vertical: CaptionVertical, alignment: &str) -> i32 {
    let column = match alignment {
        "left" => 1,
        "right" => 3,
        _ => 2,
    };
    let row_base = match vertical {
        CaptionVertical::Bottom => 0,
        CaptionVertical::Center => 3,
        CaptionVertical::Top => 6,
    };

    row_base + column
}

/// Vertical resolution every ASS script this exporter writes is authored in.
///
/// libass scales a script from its `PlayRes` onto the frame, so pinning the
/// height makes a font size mean the same thing at every export resolution:
/// `fontSize: 48` is "48px at 1080p", exactly as the preview reads it
/// (`fontSize * canvasHeight / 1080` in `src/utils/textRenderer.ts`). While
/// `PlayRes` tracked the output size, the same caption came out half as tall
/// relative to the frame on a 4K export as on a 1080p one.
const ASS_PLAY_RES_Y: u32 = 1080;

/// Rounds to an even number so a `PlayRes` never lands on a half pixel.
fn round_to_even(value: f64) -> u32 {
    if !value.is_finite() {
        return 2;
    }

    ((value / 2.0).round() * 2.0).clamp(2.0, 100_000.0) as u32
}

/// Returns the `PlayResX`/`PlayResY` an ASS script for this canvas is authored in.
fn ass_play_resolution(canvas: &Canvas) -> (u32, u32) {
    let aspect = if canvas.is_valid() {
        canvas.aspect_ratio()
    } else {
        16.0 / 9.0
    };

    (
        round_to_even(f64::from(ASS_PLAY_RES_Y) * aspect),
        ASS_PLAY_RES_Y,
    )
}

/// Where a burned-in text block sits, and whether libass may wrap it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum AssTextAnchor {
    /// Placed by `\pos`, which fixes where the block sits but does not stop
    /// libass deriving its wrap width from MarginL/MarginR. Writing both as
    /// zero is what leaves the block wrapping only at the frame edge, which is
    /// what an exact placement wants: a box narrower than the frame would
    /// re-flow text the author positioned by hand.
    Absolute { x: f64, y: f64, alignment: i32 },
    /// Placed by margins, which leaves libass free to wrap the line inside the
    /// box those margins describe.
    Margins {
        alignment: i32,
        margin_l: i32,
        margin_r: i32,
        margin_v: i32,
    },
}

impl AssTextAnchor {
    fn alignment(self) -> i32 {
        match self {
            Self::Absolute { alignment, .. } | Self::Margins { alignment, .. } => alignment,
        }
    }

    /// Margins as the `MarginL,MarginR,MarginV` columns of a style or event.
    fn margin_columns(self) -> (i32, i32, i32) {
        match self {
            Self::Absolute { .. } => (0, 0, 0),
            Self::Margins {
                margin_l,
                margin_r,
                margin_v,
                ..
            } => (margin_l, margin_r, margin_v),
        }
    }

    /// The `\pos` override this anchor needs, if any.
    fn position_override(self) -> String {
        match self {
            Self::Absolute { x, y, .. } => format!("\\pos({x:.2},{y:.2})"),
            Self::Margins { .. } => String::new(),
        }
    }
}

/// Resolves the anchor an ASS event for `clip` uses.
///
/// Preset captions become margin anchors so libass can wrap them; everything
/// else keeps the exact placement it had. Text clips in particular are driven
/// by a clip transform whose whole point is an exact position, and custom
/// caption positions name a point the author picked - neither survives being
/// re-expressed as a margin, so both accept wrapping only at the frame edge.
fn ass_text_anchor(
    clip: &Clip,
    track_kind: &TrackKind,
    effect: &Effect,
    play_res_x: u32,
    play_res_y: u32,
) -> AssTextAnchor {
    let absolute = AssTextAnchor::Absolute {
        x: effect_float_param(effect, "x", 0.5).clamp(0.0, 1.0) * f64::from(play_res_x),
        y: effect_float_param(effect, "y", 0.5).clamp(0.0, 1.0) * f64::from(play_res_y),
        alignment: ass_alignment_from_effect(effect),
    };

    if *track_kind != TrackKind::Caption {
        return absolute;
    }

    let anchor =
        resolve_caption_anchor(clip.caption_position.as_ref(), clip.caption_style.as_ref());
    let CaptionAnchor::Preset {
        vertical,
        margin_percent,
    } = anchor
    else {
        return absolute;
    };

    let alignment = caption_effect_alignment(effect);
    let side_margin = (CAPTION_SIDE_MARGIN_PERCENT / 100.0 * f64::from(play_res_x)).round() as i32;
    let margin_v = match vertical {
        // libass ignores MarginV for the middle row, so naming one would only
        // mislead whoever reads the script.
        CaptionVertical::Center => 0,
        _ => (normalized_caption_margin_percent(margin_percent) / 100.0 * f64::from(play_res_y))
            .round() as i32,
    };

    AssTextAnchor::Margins {
        alignment: ass_numpad_alignment(vertical, &alignment),
        margin_l: side_margin,
        margin_r: side_margin,
        margin_v,
    }
}

fn effect_string_param(effect: &Effect, name: &str, fallback: &str) -> String {
    effect
        .get_param(name)
        .and_then(ParamValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn effect_int_param(effect: &Effect, name: &str, fallback: i64) -> i64 {
    effect
        .get_param(name)
        .and_then(ParamValue::as_int)
        .unwrap_or(fallback)
}

/// Reads a float parameter, treating a non-finite one as unset.
///
/// The last line of defence for the numeric columns of an ASS script. Every
/// caller clamps what it gets here, and `f64::clamp` returns NaN unchanged, so
/// without this a NaN or infinity that reached an effect param from *any*
/// source - a hand-written plan, a plugin, a future parser - would be formatted
/// straight into a style or an override tag as `NaN` or `inf` and cost libass
/// the whole line. `parse_json_number` already rejects them at the caption
/// parser; this makes the property hold no matter which path set the param.
fn effect_float_param(effect: &Effect, name: &str, fallback: f64) -> f64 {
    debug_assert!(
        fallback.is_finite(),
        "the fallback for '{name}' must itself be a real number"
    );
    effect
        .get_float(name)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn effect_bool_param(effect: &Effect, name: &str, fallback: bool) -> bool {
    effect.get_bool(name).unwrap_or(fallback)
}

fn ass_color_param(effect: &Effect, name: &str, fallback: &str, opacity: f64) -> Option<AssColor> {
    effect
        .get_param(name)
        .and_then(ParamValue::as_str)
        .map(|value| AssColor::from_hex(value, fallback, opacity))
}

/// Everything about an ASS event that the clip's own effect does not decide.
struct AssEventContext<'a> {
    style_name: &'a str,
    layer: i32,
    /// Font family after bundled/system resolution, so a family that resolves
    /// nowhere is named explicitly rather than left to libass to guess at.
    font_family: &'a str,
    anchor: AssTextAnchor,
    /// Where this render's own clock starts on the timeline, so the event lands
    /// at the same picture a full render would have put it on.
    window_start_sec: f64,
}

fn append_ass_text_style_and_event(
    styles: &mut String,
    events: &mut String,
    context: &AssEventContext<'_>,
    clip: &Clip,
    effect: &Effect,
) {
    let AssEventContext {
        style_name,
        layer,
        font_family,
        anchor,
        window_start_sec,
    } = *context;
    let opacity = effect_float_param(effect, "opacity", 1.0).clamp(0.0, 1.0);
    let font_family = ass_sanitize_style_field(font_family, "Arial");
    let font_size = effect_float_param(effect, "font_size", 48.0).clamp(1.0, 500.0);
    let font_weight = effect_int_param(effect, "font_weight", 400).clamp(100, 900);
    let bold = effect_bool_param(effect, "bold", false) || font_weight >= 600;
    let italic = effect_bool_param(effect, "italic", false);
    let underline = effect_bool_param(effect, "underline", false);
    let letter_spacing = effect_int_param(effect, "letter_spacing", 0).clamp(-100, 200);
    let scale_x_percent = effect_float_param(effect, "scale_x_percent", 100.0).clamp(1.0, 1000.0);
    let scale_y_percent = effect_float_param(effect, "scale_y_percent", 100.0).clamp(1.0, 1000.0);
    let primary = AssColor::from_hex(
        &effect_string_param(effect, "color", "#FFFFFF"),
        "#FFFFFF",
        opacity,
    );
    // Decoration alphas compose with the layer opacity, exactly as they do in
    // the drawtext path, so both renderers read one style the same way.
    let decoration_alpha = |name: &str, fallback: f64| {
        effect_float_param(effect, name, fallback).clamp(0.0, 1.0) * opacity
    };
    let outline_color = ass_color_param(
        effect,
        "outline_color",
        "#000000",
        decoration_alpha("outline_opacity", 1.0),
    );
    let outline_width = if effect.get_param("outline_color").is_some() {
        effect_int_param(effect, "outline_width", 2).clamp(0, 100) as f64
    } else {
        0.0
    };
    let shadow_color = ass_color_param(
        effect,
        "shadow_color",
        "#000000",
        decoration_alpha("shadow_opacity", 0.8),
    );
    let has_shadow = shadow_color.is_some();
    let shadow_x = if has_shadow {
        effect_int_param(effect, "shadow_x", 0).clamp(-500, 500)
    } else {
        0
    };
    let shadow_y = if has_shadow {
        effect_int_param(effect, "shadow_y", 0).clamp(-500, 500)
    } else {
        0
    };
    let shadow_size = if has_shadow {
        shadow_x.abs().max(shadow_y.abs()) as f64
    } else {
        0.0
    };
    let background_color = ass_color_param(
        effect,
        "background_color",
        "#000000",
        decoration_alpha("background_opacity", 1.0),
    );
    let background_padding = effect_int_param(effect, "background_padding", 10).clamp(0, 500);
    let border_style = if background_color.is_some() { 3 } else { 1 };
    let style_outline_width = if background_color.is_some() {
        background_padding as f64
    } else {
        outline_width
    };
    // `BorderStyle: 3` draws its opaque box in the *OutlineColour* column and
    // uses BackColour only for the drop-shadow box behind it. Writing the box
    // colour to BackColour therefore painted it nowhere unless the style also
    // carried a shadow offset, and left the box column fully transparent: a
    // boxed caption burned in as bare white text over the footage. The box
    // replaces the outline in this border style, so nothing is lost by giving
    // it the column, and the shadow keeps its own.
    let border_color = background_color
        .or(outline_color)
        .unwrap_or_else(AssColor::transparent_black);
    let back_color = shadow_color.unwrap_or_else(AssColor::transparent_black);
    let alignment = anchor.alignment();
    let (margin_l, margin_r, margin_v) = anchor.margin_columns();

    styles.push_str(&format!(
        "Style: {style_name},{font_family},{font_size:.2},{},{},{},{},{},{},{},0,{scale_x_percent:.2},{scale_y_percent:.2},{letter_spacing},0,{border_style},{style_outline_width:.2},{shadow_size:.2},{alignment},{margin_l},{margin_r},{margin_v},1\n",
        primary.ass_value(),
        primary.ass_value(),
        border_color.ass_value(),
        back_color.ass_value(),
        if bold { -1 } else { 0 },
        if italic { -1 } else { 0 },
        if underline { -1 } else { 0 },
    ));

    let rotation = effect_float_param(effect, "rotation", 0.0);
    let shadow_blur = effect_int_param(effect, "shadow_blur", 0).clamp(0, 500);
    // One event per clip, with the line breaks the author wrote carried as
    // `\N`. Splitting the block into a positioned event per line made libass
    // draw a `BorderStyle: 3` background box around each line instead of around
    // the block, and left every line immune to wrapping.
    let text = ass_escape_text(&effect_string_param(effect, "text", "Title"));
    let event_border_width = style_outline_width;
    let start = ass_timecode(clip.place.timeline_in_sec - window_start_sec);
    let end = ass_timecode(clip.place.timeline_out_sec() - window_start_sec);
    let position = anchor.position_override();

    events.push_str(&format!(
        "Dialogue: {layer},{start},{end},{style_name},,{margin_l},{margin_r},{margin_v},,{{{position}\\an{alignment}\\frz{rotation:.2}\\b{font_weight}\\bord{event_border_width:.2}\\xshad{shadow_x}\\yshad{shadow_y}\\blur{shadow_blur}\\fsp{letter_spacing}}}{text}\n",
    ));
}

/// How a requested font family was satisfied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FontResolution {
    /// Compiled into the binary. The script embeds it, so the burn-in looks the
    /// same on a machine that has never seen the family.
    Bundled(&'static str),
    /// Installed on this host. libass resolves it through the system provider.
    System,
    /// Available nowhere. libass would silently pick some fallback and never
    /// say which, so the script names a bundled family instead.
    Substituted(&'static str),
}

/// Resolves the family a text style asks for against bundled, then system fonts.
///
/// Shared by the script builder and export validation so the warning a caller
/// sees and the font that actually renders can never disagree.
pub(crate) fn resolve_text_font_family(requested: &str) -> FontResolution {
    if let Some(font) = crate::core::text::bundled_fonts::resolve_bundled(requested) {
        return FontResolution::Bundled(font.family);
    }

    let requested = requested.trim();
    if crate::core::text::fonts::system_font_family_installed(requested) {
        FontResolution::System
    } else {
        FontResolution::Substituted(crate::core::text::bundled_fonts::DEFAULT_BUNDLED_FAMILY)
    }
}

/// Ceiling on the bytes one script may carry in its `[Fonts]` section.
///
/// A script is written to a temp file and parsed in full before the first
/// frame, so an unbounded section would be paid for on every export. The cap is
/// far above what the bundled families need; it exists so a future family list
/// cannot quietly turn into a multi-hundred-megabyte script.
const MAX_EMBEDDED_FONT_BYTES: usize = 20 * 1024 * 1024;

/// Accumulates the `[Fonts]` section of a script.
#[derive(Default)]
struct AssFontEmbedder {
    body: String,
    embedded: Vec<&'static str>,
    total_bytes: usize,
}

impl AssFontEmbedder {
    /// Embeds every weight of `family`, once, if it is bundled and fits.
    fn embed_family(&mut self, family: &str) {
        for font in crate::core::text::bundled_fonts::bundled_family_faces(family) {
            if self.embedded.contains(&font.file_name) {
                continue;
            }

            if self.total_bytes + font.bytes.len() > MAX_EMBEDDED_FONT_BYTES {
                tracing::warn!(
                    "Skipping embedded font '{}' ({} bytes): the ASS script would exceed the {} byte embed cap",
                    font.file_name,
                    font.bytes.len(),
                    MAX_EMBEDDED_FONT_BYTES
                );
                continue;
            }

            self.body
                .push_str(&crate::core::text::ass_embed::encode_attached_font(
                    font.file_name,
                    font.bytes,
                ));
            self.embedded.push(font.file_name);
            self.total_bytes += font.bytes.len();
        }
    }

    /// Renders the section, or nothing when no font was embedded.
    fn into_section(self) -> String {
        if self.body.is_empty() {
            String::new()
        } else {
            format!("[Fonts]\n{}\n", self.body)
        }
    }
}

/// Size of the `Layer` band one track owns in the burned-in ASS script.
const ASS_LAYERS_PER_TRACK: i32 = 1000;

/// Resolves the ASS `Layer` an event on a given track and clip is drawn at.
///
/// libass draws a higher `Layer` in front of a lower one, so the number has to
/// grow with the visual stack depth: the topmost track (track index 0, the
/// deepest position — see [`visual_stack_depths`]) gets the largest layer and
/// therefore draws over everything below it.
///
/// `clip_index` only orders events inside a single track, where clips cannot
/// overlap in time anyway. It is clamped to the track's own band so a track
/// carrying a very long clip list can never reach into the band owned by the
/// track above it.
fn ass_dialogue_layer(stack_depth: usize, clip_index: usize) -> i32 {
    let depth = i32::try_from(stack_depth).unwrap_or(i32::MAX / ASS_LAYERS_PER_TRACK);
    let within_track = i32::try_from(clip_index)
        .unwrap_or(i32::MAX)
        .min(ASS_LAYERS_PER_TRACK - 1);

    depth
        .saturating_mul(ASS_LAYERS_PER_TRACK)
        .saturating_add(within_track)
}

/// Builds the ASS script the libass export path burns text overlays with.
///
/// The script is authored in a fixed 1080-tall coordinate space (see
/// [`ASS_PLAY_RES_Y`]) whose aspect follows the sequence canvas, not the export
/// resolution, so the same project burns identical-looking text at every output
/// size.
///
/// Exposed so the curated text preset contract tests can assert a resolved
/// style reaches the second render path as well as `drawtext`, and so the CLI
/// end-to-end tests can hand the real script to a real libass rather than
/// asserting against a re-implementation of it.
pub fn build_ass_text_overlay_script(
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
) -> Result<Option<String>, ExportError> {
    build_ass_text_overlay_script_in_window(sequence, effects, 0.0)
}

/// [`build_ass_text_overlay_script`], with every event's timing rebased.
///
/// `window_start_sec` is where the render's own clock begins on the timeline.
/// The `subtitles` filter reads the script against that clock, so a ranged
/// render needs the events moved back by exactly as much as the graph was.
/// [`ass_timecode`] floors a negative start at zero, which is what an overlay
/// already on screen when the window opens should be.
pub(crate) fn build_ass_text_overlay_script_in_window(
    sequence: &Sequence,
    effects: &HashMap<String, Effect>,
    window_start_sec: f64,
) -> Result<Option<String>, ExportError> {
    let (play_res_x, play_res_y) = ass_play_resolution(&sequence.format.canvas);
    let mut styles = String::new();
    let mut events = String::new();
    let mut fonts = AssFontEmbedder::default();
    let mut event_count = 0usize;

    let stack_depths = visual_stack_depths(sequence);

    for track in &sequence.tracks {
        if !track_included_in_media_collection(track) {
            continue;
        }

        let stack_depth = stack_depths.get(track.id.as_str()).copied().unwrap_or(0);

        for (clip_index, clip) in track.clips.iter().enumerate() {
            if !clip.enabled {
                continue;
            }

            let Some(effect) = (match track.kind {
                TrackKind::Caption => build_caption_text_effect(clip),
                TrackKind::Video | TrackKind::Overlay if is_text_clip(clip) => {
                    Some(build_text_clip_effect_with_transform(clip, effects)?)
                }
                _ => None,
            }) else {
                continue;
            };

            let start = clip.place.timeline_in_sec;
            let end = clip.place.timeline_out_sec();
            if !start.is_finite() || !end.is_finite() || end <= start {
                if is_text_clip(clip) {
                    return Err(ExportError::InvalidSettings(format!(
                        "Text clip '{}' has invalid timing",
                        clip.id
                    )));
                }
                continue;
            }

            // A clip that ended before the window opened contributes no event.
            // `ass_timecode` would clamp both its rebased bounds to zero and emit
            // a zero-length `Dialogue` that libass never draws — harmless, but
            // dropping it keeps this path in step with the drawtext burn-in,
            // which likewise renders nothing for a clip in front of the window.
            if end - window_start_sec < 0.0 {
                continue;
            }

            let requested_family = ass_sanitize_style_field(
                &effect_string_param(&effect, "font_family", "Arial"),
                "Arial",
            );
            let font_family = match resolve_text_font_family(&requested_family) {
                FontResolution::Bundled(family) | FontResolution::Substituted(family) => {
                    fonts.embed_family(family);
                    family.to_string()
                }
                FontResolution::System => requested_family,
            };

            let style_name = format!("OpenReelioText{event_count}");
            append_ass_text_style_and_event(
                &mut styles,
                &mut events,
                &AssEventContext {
                    style_name: &style_name,
                    layer: ass_dialogue_layer(stack_depth, clip_index),
                    font_family: &font_family,
                    anchor: ass_text_anchor(clip, &track.kind, &effect, play_res_x, play_res_y),
                    window_start_sec,
                },
                clip,
                &effect,
            );
            event_count += 1;
        }
    }

    if event_count == 0 {
        return Ok(None);
    }

    // `WrapStyle: 0` is what makes a caption wrap at all; the margins on a
    // preset caption's event give libass the box to wrap it inside.
    Ok(Some(format!(
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\nPlayResX: {play_res_x}\nPlayResY: {play_res_y}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n{styles}\n{}[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n{events}",
        fonts.into_section()
    )))
}

/// Reads the filter names an FFmpeg binary reports, or `None` if it cannot run.
///
/// Kept apart from the caller so a failed probe is distinguishable from a
/// binary that genuinely has no filters, and so the cache can hold only the
/// answers worth keeping.
async fn probe_ffmpeg_filters(ffmpeg_path: &Path) -> Option<HashSet<String>> {
    let args = vec!["-hide_banner".to_string(), "-filters".to_string()];
    let output = execute_ffmpeg_output(ffmpeg_path, &args).await.ok()?;

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));

    Some(
        text.lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                // The table's first column is the capability flags; the name
                // is the second.
                let _flags = parts.next()?;
                parts.next().map(str::to_string)
            })
            .collect(),
    )
}

pub(super) fn append_ass_text_overlay(
    filter_complex: &mut String,
    base_video_label: &str,
    ass_path: &Path,
) -> String {
    use crate::core::effects::escape_ffmpeg_filter_value;

    let output_label = "[txtass0]";
    let path_text = ass_path.to_string_lossy();
    // Both values land inside a single-quoted filter argument, so they must go
    // through the canonical filtergraph escaper: a literal `'` has to be emitted
    // as `'\''`, otherwise it terminates the quoted region and the rest of the
    // value is parsed as filtergraph syntax (`;`/`[`/`]` + `movie=` would give
    // arbitrary file read/write).
    let escaped_path = escape_ffmpeg_filter_value(path_text.as_ref());
    // The filter takes a single directory, and libass reads it in addition to
    // the host's own font provider. Taking whichever path happened to sort
    // first meant a per-user font folder could shadow the system one; naming
    // the platform's primary folder makes the choice deterministic.
    let fonts_dir_option = crate::core::text::fonts::primary_system_font_directory()
        .filter(|directory| {
            // Same apostrophe limit as the `.ass` path: FFmpeg cannot carry a literal
            // `'` into an option value. Unlike the script path, this option is purely
            // additive — libass still consults the host font provider without it — and
            // the user cannot relocate the system font directory. So drop the option
            // instead of failing the export.
            match crate::core::fs::validate_filter_safe_path(directory, "System font directory") {
                Ok(()) => true,
                Err(message) => {
                    tracing::warn!("{message} Continuing without the fontsdir option.");
                    false
                }
            }
        })
        .map(|directory| {
            let directory_text = directory.to_string_lossy();
            format!(
                ":fontsdir='{}'",
                escape_ffmpeg_filter_value(directory_text.as_ref())
            )
        })
        .unwrap_or_default();
    // `original_size` is deliberately absent. The filter turns it into a libass
    // pixel aspect of frame-AR over original-AR, i.e. it exists to un-stretch a
    // script authored for one aspect and then anamorphically squeezed into
    // another. This pipeline never squeezes: normalization letterboxes every
    // source into the output dimensions, so the pixel aspect is always 1 and
    // the script's own `PlayRes` aspect is the only thing libass needs. Naming
    // the canvas here distorted glyphs by frame-AR/canvas-AR whenever an export
    // preset overrode the output to a different aspect than the sequence canvas
    // (a vertical canvas exported through a 16:9 preset stretched 3.16x).
    filter_complex.push(';');
    filter_complex.push_str(&format!(
        "{base_video_label}subtitles=filename='{escaped_path}'{fonts_dir_option}{output_label}"
    ));
    output_label.to_string()
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

    async fn ffmpeg_supports_filter(&self, filter_name: &str) -> bool {
        let ffmpeg_path = self.ffmpeg.info().ffmpeg_path.clone();

        // Cached per binary for the life of the process. Which filters an
        // FFmpeg has cannot change while it is running, and the question is
        // asked far more often than it looks: a contact sheet asks once per
        // cell, so a 4x4 sheet used to spawn sixteen `ffmpeg -filters`
        // processes and parse sixteen copies of the same several-hundred-line
        // table before drawing anything.
        static FILTER_TABLES: std::sync::OnceLock<
            tokio::sync::Mutex<HashMap<PathBuf, HashSet<String>>>,
        > = std::sync::OnceLock::new();
        let tables = FILTER_TABLES.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));

        let mut tables = tables.lock().await;
        if let Some(cached) = tables.get(&ffmpeg_path) {
            return cached.contains(filter_name);
        }

        // Only a successful probe is remembered. Caching a failure would turn
        // one transient spawn error into an export that silently takes the
        // `drawtext` fallback for the rest of the session.
        let Some(filters) = probe_ffmpeg_filters(&ffmpeg_path).await else {
            return false;
        };
        let supported = filters.contains(filter_name);
        tables.insert(ffmpeg_path, filters);
        supported
    }

    /// Build FFmpeg arguments for simple single-clip export
    fn build_simple_export_args(
        &self,
        input_path: &Path,
        settings: &ExportSettings,
    ) -> Vec<String> {
        let video_codec = settings.video_encoder_name();
        let audio_codec = settings.audio_encoder_name();

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
            if matches!(
                settings.video_codec,
                VideoCodec::H264 | VideoCodec::H265 | VideoCodec::Vp9
            ) {
                args.extend(super::hardware::resolve_quality_args(&video_codec, crf));
            }
        }

        // Encoder speed/compression trade-off (software x264/x265 only)
        args.extend(settings.encoder_speed_args(&video_codec));

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
    /// Dimensions are used for mask-aware (power window) filter generation.
    /// Dimensions and frame rate are also handed to effects that cannot express
    /// their output frame — `zoompan` is the one that cannot.
    pub(super) fn build_clip_filter_graph(
        &self,
        clip: &Clip,
        effects: &std::collections::HashMap<String, Effect>,
        width: Option<u32>,
        height: Option<u32>,
        fps: Option<f64>,
        handles: ClipHandles,
    ) -> FilterGraph {
        build_clip_filter_graph(clip, effects, width, height, fps, handles)
    }
}

/// Re-anchors an effect's time parameters onto the stream that will carry it.
///
/// A clip taking part in a transition is decoded from `head_sec` before its in
/// point, and `setpts=PTS-STARTPTS` puts `t=0` on the first frame of *that*
/// stream. Every filter parameter measured in seconds from the clip's start is
/// therefore that much too early: an authored fade-in completes half a blend
/// before the picture the editor drew it under, and an authored fade-out reaches
/// black before the blend even begins and then holds black all the way through
/// it — the exact opposite of a dissolve.
///
/// Only clips with a head handle are touched, so the graph emitted for every
/// other clip is byte-identical to the one this builder has always produced.
fn anchor_effect_to_branch(effect: Effect, head_sec: f64) -> Effect {
    use crate::core::effects::EffectType;

    if !head_sec.is_finite() || head_sec <= 0.0 {
        return effect;
    }

    match effect.effect_type {
        EffectType::Fade => {
            let mut anchored = effect;
            let start = anchored.get_float("start_time").unwrap_or(0.0).max(0.0);
            anchored.set_param("start_time", ParamValue::Float(start + head_sec));
            anchored
        }
        EffectType::AutoReframe => anchor_auto_reframe_keyframes(effect, head_sec),
        EffectType::Zoom => {
            // `zoompan` counts output frames rather than seconds, so the builder
            // is told the offset in seconds and converts it against the canvas
            // rate it is already given. Without it the move starts on the first
            // frame of the *branch* and is `head_sec` through by the time the
            // clip's own picture appears.
            let mut anchored = effect;
            anchored.set_param(BRANCH_OFFSET_PARAM, ParamValue::Float(head_sec));
            anchored
        }
        // Everything else is either time-invariant (a colour grade looks the
        // same on every frame) or keyframed, and keyframed effects are already
        // resolved to a single sampled value before they reach the graph — and
        // refused by validation besides.
        _ => effect,
    }
}

/// Moves an auto-reframe track's keyframe times into branch time.
///
/// The crop path builds a piecewise-linear expression in `t` out of the
/// keyframes stored in the effect's `analysis_data` JSON, so the shift has to
/// happen inside that payload. A payload that cannot be read is returned
/// untouched: the crop builder already degrades to a static centre crop when the
/// analysis is unusable, and inventing a shift for data nobody could parse would
/// be worse than leaving it alone.
fn anchor_auto_reframe_keyframes(effect: Effect, head_sec: f64) -> Effect {
    let Some(raw) = effect
        .get_param("analysis_data")
        .and_then(ParamValue::as_str)
        .map(str::to_string)
    else {
        return effect;
    };

    let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return effect;
    };

    let Some(keyframes) = parsed
        .get_mut("keyframes")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return effect;
    };

    for keyframe in keyframes.iter_mut() {
        let Some(time) = keyframe.get("t").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let Some(shifted) = serde_json::Number::from_f64(time + head_sec) else {
            continue;
        };
        keyframe["t"] = serde_json::Value::Number(shifted);
    }

    let mut anchored = effect;
    anchored.set_param("analysis_data", ParamValue::String(parsed.to_string()));
    anchored
}

/// Builds the effect chain for one clip.
///
/// Free-standing because validation has to walk the same chain the render will
/// emit — to work out what size the picture is by the time the transform stage
/// sees it — and validation has no `ExportEngine` to hand.
pub(super) fn build_clip_filter_graph(
    clip: &Clip,
    effects: &std::collections::HashMap<String, Effect>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    handles: ClipHandles,
) -> FilterGraph {
    {
        use crate::core::effects::EffectType;

        let mut graph = FilterGraph::new();
        if let (Some(w), Some(h)) = (width, height) {
            graph.set_dimensions(w as i32, h as i32);
        }
        if let Some(fps) = fps {
            graph.set_fps(fps);
        }

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

                // `xfade` needs the outgoing *and* incoming streams, so it is
                // stitched at the clip boundary by `stitch_transition_groups`.
                // Letting it into the single-input clip chain emits a two-input
                // filter with one input, which FFmpeg rejects outright — the
                // export fails rather than merely looking wrong.
                if effect.effect_type.is_two_input_transition() {
                    continue;
                }

                // If effect has keyframes, resolve them at midpoint
                let resolved_effect = if effect.has_keyframes() {
                    effect.with_params_at_time(midpoint_time)
                } else {
                    effect.clone()
                };
                graph.add_effect(anchor_effect_to_branch(resolved_effect, handles.head_sec));
            }
        }

        // Sort effects by order
        graph.sort_by_order();

        graph
    }
}

impl ExportEngine {
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
        self.build_complex_filter_args_with_audio_info_internal(
            sequence, assets, effects, audio_info, settings, None,
        )
    }

    fn build_complex_filter_args_with_audio_info_internal(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        audio_info: &std::collections::HashMap<String, AssetAudioInfo>,
        settings: &ExportSettings,
        ass_text_overlay_path: Option<&Path>,
    ) -> Result<Vec<String>, ExportError> {
        super::ffmpeg_plan::build_sequence_ffmpeg_args(
            super::ffmpeg_plan::SequenceFfmpegBuildContext {
                engine: self,
                sequence,
                assets,
                effects,
                audio_info,
                settings,
                render_plan: None,
                ass_text_overlay_path,
            },
        )
    }

    #[cfg(test)]
    fn build_audio_only_filter_args_with_audio_info(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        audio_info: &std::collections::HashMap<String, AssetAudioInfo>,
        settings: &ExportSettings,
    ) -> Result<Vec<String>, ExportError> {
        super::ffmpeg_plan::build_audio_only_ffmpeg_args(
            super::ffmpeg_plan::AudioOnlyFfmpegBuildContext {
                engine: self,
                sequence,
                assets,
                effects,
                audio_info,
                settings,
                render_plan: None,
            },
        )
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
        self.export_sequence_with_effects_internal(
            sequence,
            assets,
            effects,
            settings,
            None,
            progress_tx,
            cancel_rx,
        )
        .await
    }

    /// Export a sequence using a precomputed render plan contract.
    #[allow(clippy::too_many_arguments)]
    pub async fn export_sequence_with_effects_for_plan(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        settings: &ExportSettings,
        render_plan: &RenderPlan,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<ExportResult, ExportError> {
        self.export_sequence_with_effects_internal(
            sequence,
            assets,
            effects,
            settings,
            Some(render_plan),
            progress_tx,
            cancel_rx,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn export_sequence_with_effects_internal(
        &self,
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        effects: &std::collections::HashMap<String, Effect>,
        settings: &ExportSettings,
        render_plan: Option<&RenderPlan>,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<ExportResult, ExportError> {
        if let Some(plan) = render_plan {
            if !plan.validation.is_valid {
                return Err(ExportError::InvalidSettings(format!(
                    "Render plan validation failed: {}",
                    plan.validation.errors.join("; ")
                )));
            }
        }

        // Probe all assets to determine audio stream availability
        // This prevents FFmpeg from failing when clips don't have audio
        let audio_info = self.probe_assets_for_audio(sequence, assets).await;

        let mut ass_text_overlay_dir: Option<tempfile::TempDir> = None;
        let mut ass_text_overlay_path: Option<PathBuf> = None;
        // The script is written before the graph is built, so it has to resolve
        // the same window the builder will: `subtitles` reads its timings
        // against the graph's clock, and that clock now starts at the window.
        let text_overlay_window = RenderWindow::resolve(
            sequence.output_duration(),
            settings.start_time,
            settings.end_time,
            output_video_fps(sequence, settings),
        );
        if let Some(ass_script) = build_ass_text_overlay_script_in_window(
            sequence,
            effects,
            text_overlay_window.start_sec(),
        )? {
            if self.ffmpeg_supports_filter("subtitles").await {
                let temp_dir = tempfile::Builder::new()
                    .prefix("openreelio-text-overlays-")
                    .tempdir()
                    .map_err(ExportError::IoError)?;
                let ass_path = temp_dir.path().join("text-overlays.ass");
                // The `subtitles` filter takes this path as a quoted option value, and
                // FFmpeg's filtergraph grammar cannot carry a literal `'` through to the
                // filter. The temp directory inherits the system temp root, which on
                // Windows sits under the user profile (`C:\Users\Ben's PC\...`), so this
                // is reachable without anything malformed. Fail loudly with a fixable
                // instruction rather than rendering a video with every caption missing.
                crate::core::fs::validate_filter_safe_path(&ass_path, "Text overlay path")
                    .map_err(ExportError::InvalidSettings)?;
                tokio::fs::write(&ass_path, ass_script)
                    .await
                    .map_err(ExportError::IoError)?;
                ass_text_overlay_path = Some(ass_path);
                ass_text_overlay_dir = Some(temp_dir);
            } else {
                tracing::warn!(
                    "FFmpeg subtitles filter is unavailable; falling back to drawtext overlays"
                );
            }
        }

        let mut args = super::ffmpeg_plan::build_sequence_ffmpeg_args(
            super::ffmpeg_plan::SequenceFfmpegBuildContext {
                engine: self,
                sequence,
                assets,
                effects,
                audio_info: &audio_info,
                settings,
                render_plan,
                ass_text_overlay_path: ass_text_overlay_path.as_deref(),
            },
        )?;

        let _keep_ass_text_overlay_dir_alive = ass_text_overlay_dir;

        // Calculate total duration from enabled clips only so progress/ETA
        // are accurate when trailing clips are disabled.
        let total_duration =
            effective_export_duration(sequence, settings.start_time, settings.end_time);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (total_duration * fps) as u64;

        // Add progress output to stdout for real-time tracking.
        insert_output_option_args(&mut args, ["-progress".to_string(), "pipe:1".to_string()])?;

        // The graph goes to FFmpeg as a file, not as an argv value: an animated
        // clip's motion expressions alone can outgrow the command-line limit.
        // Only FFmpeg 7.0 and later can read one, so an older or unrecognised
        // binary keeps the inline graph it has always been given.
        let (args, filter_script_dir) = super::ffmpeg_graph::materialize_filter_script(
            args,
            super::ffmpeg_graph::ffmpeg_supports_filter_script(&self.ffmpeg.info().version),
        )
        .map_err(ExportError::IoError)?;
        let _keep_filter_script_dir_alive = filter_script_dir;

        let invocation = if let Some(plan) = render_plan {
            build_ffmpeg_invocation_for_render_plan(plan, args)
        } else {
            build_ffmpeg_invocation_from_args(args, total_frames, None)
        }
        .map_err(|error| ExportError::InvalidSettings(error.to_string()))?;

        let execution = execute_ffmpeg_invocation(
            self.ffmpeg.info().ffmpeg_path.as_path(),
            invocation,
            total_duration,
            progress_tx,
            cancel_rx,
            "Starting export...",
            "Export complete!",
        )
        .await?;

        Ok(ExportResult {
            output_path: execution.output_path,
            duration_sec: total_duration,
            file_size: execution.file_size,
            encoding_time_sec: execution.encoding_time_sec,
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
        let input_path = Path::new(&asset.uri);
        let mut args = self.build_simple_export_args(input_path, settings);

        // Calculate total frames
        let duration = asset.duration_sec.unwrap_or(0.0);
        let fps = settings.fps.unwrap_or(30.0);
        let total_frames = (duration * fps) as u64;

        insert_output_option_args(&mut args, ["-progress".to_string(), "pipe:1".to_string()])?;
        let invocation = build_ffmpeg_invocation_from_args(args, total_frames, None)
            .map_err(|error| ExportError::InvalidSettings(error.to_string()))?;
        let execution = execute_ffmpeg_invocation(
            self.ffmpeg.info().ffmpeg_path.as_path(),
            invocation,
            duration,
            progress_tx,
            None,
            "Starting export...",
            "Export complete!",
        )
        .await?;

        Ok(ExportResult {
            output_path: execution.output_path,
            duration_sec: duration,
            file_size: execution.file_size,
            encoding_time_sec: execution.encoding_time_sec,
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
    /// * `project_root` - Project directory, used to resolve project-relative
    ///   asset paths via [`Asset::resolved_path`]. An asset imported relative to
    ///   the project keeps a `uri` from wherever it was first seen, so a moved
    ///   or copied project only finds its media through this.
    /// * `settings` - Frame export settings (time, format, output path)
    pub async fn export_frame(
        &self,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        project_root: &Path,
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
        let source_time = clip_source_time_at(clip, settings.time_sec);

        // Resolve asset path, preferring the project-relative location.
        let asset_path = asset.resolved_path(project_root);
        if !asset_path.exists() {
            return Err(ExportError::InvalidSettings(format!(
                "Asset file not found: {}",
                asset_path.display()
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

        // Downscale-only filter: sources narrower than the limit stay native.
        // The quotes protect the comma from the filtergraph separator.
        if let Some(max_width) = settings.max_width {
            args.push("-vf".to_string());
            args.push(format!("scale='min({},iw)':-2", max_width));
        }

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

        let ffmpeg_path = &self.ffmpeg.info().ffmpeg_path;
        execute_ffmpeg_output(ffmpeg_path, &args)
            .await
            .map_err(|error| match error {
                ExportError::FFmpegFailed(message) => {
                    ExportError::FFmpegFailed(format!("Frame export failed: {}", message))
                }
                other => other,
            })?;

        // FFmpeg exits successfully but writes nothing when the seek lands past
        // the end of the source media, so a missing file is reported as a
        // seek-out-of-range error instead of a bare IO error. Every other IO
        // failure (permissions, a removed output directory) keeps its own cause.
        let metadata = match tokio::fs::metadata(&settings.output_path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ExportError::InvalidSettings(format!(
                    "No frame was produced at time {:.3}s (source time {:.3}s in '{}'). \
                     The requested position is likely past the end of the source media.",
                    settings.time_sec,
                    source_time,
                    asset_path.display()
                )));
            }
            Err(error) => return Err(ExportError::IoError(error)),
        };
        let file_size = metadata.len();

        // Source dimensions come from the asset's video stream when known,
        // otherwise the sequence canvas is the best available approximation.
        let (source_width, source_height) = if let Some(ref video) = asset.video {
            (video.width, video.height)
        } else {
            (sequence.format.canvas.width, sequence.format.canvas.height)
        };
        // Prefer the written image's real size: asset metadata can be stale or
        // missing, and the scale filter resolves against the true source.
        let (width, height) = probed_image_dimensions(&self.ffmpeg, &settings.output_path)
            .await
            .unwrap_or_else(|| {
                scaled_frame_dimensions(source_width, source_height, settings.max_width)
            });

        Ok(FrameExportResult {
            output_path: settings.output_path.clone(),
            file_size,
            format: settings.format,
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
        self.export_audio_only_internal(
            sequence,
            assets,
            effects,
            settings,
            None,
            progress_tx,
            cancel_rx,
        )
        .await
    }

    /// Export audio using a precomputed render plan contract.
    #[allow(clippy::too_many_arguments)]
    pub async fn export_audio_only_for_plan(
        &self,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        settings: &AudioExportSettings,
        render_plan: &RenderPlan,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<AudioExportResult, ExportError> {
        self.export_audio_only_internal(
            sequence,
            assets,
            effects,
            settings,
            Some(render_plan),
            progress_tx,
            cancel_rx,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn export_audio_only_internal(
        &self,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        settings: &AudioExportSettings,
        render_plan: Option<&RenderPlan>,
        progress_tx: Option<Sender<ExportProgress>>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    ) -> Result<AudioExportResult, ExportError> {
        if let Some(plan) = render_plan {
            if !plan.validation.is_valid {
                return Err(ExportError::InvalidSettings(format!(
                    "Render plan validation failed: {}",
                    plan.validation.errors.join("; ")
                )));
            }
        }

        settings.validate()?;

        // Verify at least one clip has audio
        let audio_info = self.probe_assets_for_audio(sequence, assets).await;
        let has_any_audio = sequence_has_exportable_audio(sequence, assets, &audio_info);

        if !has_any_audio {
            return Err(ExportError::InvalidSettings(
                "No audio tracks found in sequence".to_string(),
            ));
        }

        let (normalized_start_time, normalized_end_time) =
            normalize_output_time_range(sequence, settings.start_time, settings.end_time)?;
        let mut normalized_settings = settings.clone();
        normalized_settings.start_time = normalized_start_time;
        normalized_settings.end_time = normalized_end_time;

        // Convert to export settings so we can reuse range handling/output path wiring.
        let export_settings = normalized_settings.to_export_settings();

        let mut args = super::ffmpeg_plan::build_audio_only_ffmpeg_args(
            super::ffmpeg_plan::AudioOnlyFfmpegBuildContext {
                engine: self,
                sequence,
                assets,
                effects,
                audio_info: &audio_info,
                settings: &export_settings,
                render_plan,
            },
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
            normalized_settings.format.codec().to_string(),
        ];

        if let Some(ref bitrate) = normalized_settings.bitrate {
            output_options.push("-b:a".to_string());
            output_options.push(bitrate.clone());
        } else if let Some(default_br) = normalized_settings.format.default_bitrate() {
            output_options.push("-b:a".to_string());
            output_options.push(default_br.to_string());
        }

        if let Some(sr) = normalized_settings.sample_rate {
            output_options.push("-ar".to_string());
            output_options.push(sr.to_string());
        }

        output_options.push("-progress".to_string());
        output_options.push("pipe:1".to_string());
        insert_output_option_args(&mut args, output_options)?;

        // Create output directory if needed
        if let Some(parent) = normalized_settings.output_path.parent() {
            if !parent.as_os_str().is_empty() {
                tokio::fs::create_dir_all(parent).await?;
            }
        }

        // Calculate total duration for progress
        let duration = effective_export_duration(
            sequence,
            normalized_settings.start_time,
            normalized_settings.end_time,
        );
        let total_frames = (duration * sequence.format.fps.as_f64()).ceil() as u64;

        // Same script-file delivery, and the same version gate, as the video
        // path, so both exports agree on how the graph reaches FFmpeg.
        let (args, filter_script_dir) = super::ffmpeg_graph::materialize_filter_script(
            args,
            super::ffmpeg_graph::ffmpeg_supports_filter_script(&self.ffmpeg.info().version),
        )
        .map_err(ExportError::IoError)?;
        let _keep_filter_script_dir_alive = filter_script_dir;

        let invocation = if let Some(plan) = render_plan {
            build_ffmpeg_invocation_for_render_plan(plan, args)
        } else {
            build_ffmpeg_invocation_from_args(args, total_frames, None)
        }
        .map_err(|error| ExportError::InvalidSettings(error.to_string()))?;

        let execution = execute_ffmpeg_invocation(
            self.ffmpeg.info().ffmpeg_path.as_path(),
            invocation,
            duration,
            progress_tx,
            cancel_rx,
            "Starting audio export...",
            "Audio export complete!",
        )
        .await
        .map_err(|error| match error {
            ExportError::FFmpegFailed(message) => {
                ExportError::FFmpegFailed(format!("Audio export failed: {}", message))
            }
            other => other,
        })?;

        Ok(AudioExportResult {
            output_path: execution.output_path,
            duration_sec: duration,
            file_size: execution.file_size,
            format: settings.format.clone(),
            encoding_time_sec: execution.encoding_time_sec,
        })
    }

    /// Find the topmost visible video clip at a given time position.
    ///
    /// Iterates video tracks from top to bottom (highest index first) and
    /// returns the first enabled clip that covers the requested time.
    ///
    /// Text clips and adjustment layers are skipped because they have no
    /// file-backed source. `None` therefore means [`ExportEngine::export_frame`]
    /// cannot serve the requested time and a composited render is required.
    pub fn find_topmost_clip_at_time<'a>(
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

/// How badly a validation finding affects the export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFindingSeverity {
    /// The export cannot run until the caller fixes this.
    Error,
    /// The export runs, but the file differs from what the timeline shows.
    Warning,
}

/// A single validation finding, addressed at the thing that caused it.
///
/// The flat `errors`/`warnings` string lists say only *what* is wrong; a caller
/// that wants to take the user to the offending clip needs the id too, and every
/// clip-specific validator already has it in scope when it formats the message.
#[derive(Debug, Clone)]
pub struct ExportFinding {
    /// Whether this blocks the export or only degrades it.
    pub severity: ExportFindingSeverity,
    /// Human-readable description, identical to the `errors`/`warnings` entry.
    pub message: String,
    /// Sequence the finding belongs to, when the validator knows it.
    pub sequence_id: Option<String>,
    /// Clip the finding is about, when the finding is about one clip.
    pub clip_id: Option<String>,
}

/// Validation result for export settings
#[derive(Debug, Clone)]
pub struct ExportValidation {
    /// Whether the export can proceed
    pub is_valid: bool,
    /// List of validation errors
    pub errors: Vec<String>,
    /// List of warnings (non-blocking)
    pub warnings: Vec<String>,
    /// Structured view of the same findings, carrying the ids of what caused them.
    ///
    /// This is the source of truth; `is_valid`, `errors` and `warnings` are kept
    /// in sync with it so existing consumers keep working unchanged.
    pub findings: Vec<ExportFinding>,
}

impl ExportValidation {
    /// Create a valid result
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            errors: Vec::new(),
            warnings: Vec::new(),
            findings: Vec::new(),
        }
    }

    /// Create an invalid result with errors
    pub fn invalid(errors: Vec<String>) -> Self {
        let mut validation = Self::valid();
        for error in errors {
            validation.add_error(error);
        }
        validation
    }

    /// Add an error
    pub fn add_error(&mut self, error: impl Into<String>) {
        self.push(ExportFindingSeverity::Error, error.into(), None, None);
    }

    /// Add a warning
    pub fn add_warning(&mut self, warning: impl Into<String>) {
        self.push(ExportFindingSeverity::Warning, warning.into(), None, None);
    }

    /// Add an error a caller can navigate to.
    pub fn add_clip_error(
        &mut self,
        sequence_id: impl Into<String>,
        clip_id: impl Into<String>,
        error: impl Into<String>,
    ) {
        self.push(
            ExportFindingSeverity::Error,
            error.into(),
            Some(sequence_id.into()),
            Some(clip_id.into()),
        );
    }

    /// Add a warning a caller can navigate to.
    pub fn add_clip_warning(
        &mut self,
        sequence_id: impl Into<String>,
        clip_id: impl Into<String>,
        warning: impl Into<String>,
    ) {
        self.push(
            ExportFindingSeverity::Warning,
            warning.into(),
            Some(sequence_id.into()),
            Some(clip_id.into()),
        );
    }

    fn push(
        &mut self,
        severity: ExportFindingSeverity,
        message: String,
        sequence_id: Option<String>,
        clip_id: Option<String>,
    ) {
        match severity {
            ExportFindingSeverity::Error => {
                self.errors.push(message.clone());
                self.is_valid = false;
            }
            ExportFindingSeverity::Warning => self.warnings.push(message.clone()),
        }
        self.findings.push(ExportFinding {
            severity,
            message,
            sequence_id,
            clip_id,
        });
    }
}

fn validate_clip_effect_contract(
    validation: &mut ExportValidation,
    sequence_id: &str,
    clip: &Clip,
    track: &Track,
    effects: &std::collections::HashMap<String, Effect>,
    transition_plan: &TransitionPlan,
) {
    if !clip.enabled || clip.effects.is_empty() {
        return;
    }

    for effect_id in &clip.effects {
        let Some(effect) = effects.get(effect_id) else {
            validation.add_clip_error(
                sequence_id,
                &clip.id,
                format!(
                    "Clip '{}' on track '{}' references missing effect '{}'",
                    clip.id, track.name, effect_id
                ),
            );
            continue;
        };

        if !effect.enabled {
            continue;
        }

        let capability = effect_capability(&effect.effect_type);
        let label = effect_type_label(&effect.effect_type);

        // A two-input transition renders as a real `xfade` when both clips have
        // unused source media to reach into. When one of them does not — or the
        // boundary is not a boundary at all — the render degrades to a cut, and
        // the reason comes from the same plan the render used, so the warning
        // and the file can never disagree.
        //
        // Matched on the effect's id, not its label: two dissolves on one clip
        // share a label, and the plan refuses exactly one of them. Matching by
        // label reported that refusal against both, so the caller saw the same
        // sentence twice and could not tell which effect it was about.
        //
        // An eligible transition normally produces no warning — it renders
        // exactly what the timeline shows — unless the plan attached an advisory
        // saying the blend will not be visible.
        if effect.effect_type.is_two_input_transition() {
            for refusal in transition_plan.refusals() {
                if refusal.clip_id == clip.id && refusal.effect_id == *effect_id {
                    validation.add_clip_warning(sequence_id, &clip.id, refusal.warning());
                }
            }
            for advisory in transition_plan.advisories() {
                if advisory.clip_id == clip.id && advisory.effect_id == *effect_id {
                    validation.add_clip_warning(sequence_id, &clip.id, advisory.warning());
                }
            }
        }

        if !capability.export.is_supported() {
            let reason = capability
                .export_reason
                .unwrap_or("This effect is not implemented by final export.");
            validation.add_clip_error(
                sequence_id,
                &clip.id,
                format!(
                    "Effect '{}' on clip '{}' is not supported in final export: {}",
                    label, clip.id, reason
                ),
            );
        }

        if !effect.keyframes.is_empty() {
            validation.add_clip_error(
                sequence_id,
                &clip.id,
                format!(
                    "Keyframed effect '{}' on clip '{}' is not supported in final export yet; export would otherwise render a static sampled value",
                    label, clip.id
                ),
            );
        }
    }
}

fn validate_clip_frame_alignment(
    validation: &mut ExportValidation,
    sequence_id: &str,
    clock: &TimelineClock,
    clip: &Clip,
    track: &Track,
) {
    let start = clip.place.timeline_in_sec;
    let end = clip.place.timeline_out_sec();

    if !clock.is_frame_aligned(start) || !clock.is_frame_aligned(end) {
        validation.add_clip_warning(
            sequence_id,
            &clip.id,
            format!(
                "Clip '{}' on track '{}' is not aligned to sequence frame boundaries at {}/{} fps",
                clip.id,
                track.name,
                clock.fps().num,
                clock.fps().den
            ),
        );
    }
}

fn has_active_tonemap(settings: &ExportSettings) -> bool {
    settings
        .tonemap_mode
        .as_ref()
        .is_some_and(|mode| !matches!(mode, TonemapMode::None))
}

fn linear_gain_to_db(gain: f32) -> f64 {
    if gain <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * (gain as f64).log10()
    }
}

fn max_clip_volume_db(clip: &Clip) -> f64 {
    if clip.audio.has_volume_automation() {
        clip.audio
            .volume_keyframes
            .iter()
            .map(|keyframe| keyframe.value_db)
            .fold(f64::NEG_INFINITY, f64::max)
    } else {
        clip.audio.volume_db as f64
    }
}

fn validate_clip_asset_qc(
    validation: &mut ExportValidation,
    clip: &Clip,
    track: &Track,
    asset: &Asset,
    sequence: &Sequence,
    settings: &ExportSettings,
) {
    if asset.missing {
        validation.add_clip_error(
            &sequence.id,
            &clip.id,
            format!(
                "Asset '{}' is marked missing/offline for clip '{}'",
                asset.id, clip.id
            ),
        );
    }

    if let Some(video) = asset.video.as_ref() {
        if video.is_hdr && !settings.is_hdr() && !has_active_tonemap(settings) {
            validation.add_clip_warning(
                &sequence.id,
                &clip.id,
                format!(
                    "HDR source asset '{}' on clip '{}' is exporting to SDR without tonemapping; verify gamut/clipping in scopes or enable HDR export/tonemap",
                    asset.id, clip.id
                ),
            );
        }
    }

    let carries_audio = matches!(asset.kind, AssetKind::Audio | AssetKind::Video)
        && asset.audio.is_some()
        && !clip.audio.muted;
    if carries_audio {
        let combined_gain_db = max_clip_volume_db(clip)
            + linear_gain_to_db(track.volume)
            + sequence.master_volume_db as f64;

        if combined_gain_db > 3.0 {
            validation.add_clip_warning(
                &sequence.id,
                &clip.id,
                format!(
                    "Clip '{}' on track '{}' has {:.1} dB combined gain; verify loudness and clipping before export",
                    clip.id, track.name, combined_gain_db
                ),
            );
        }
    }
}

/// Line height the ASS burn-in path is allowed to silently ignore.
///
/// 1.2 is both the typographic default and roughly what libass derives from
/// font metrics, so a style at or near it loses nothing by being dropped.
const ASS_DEFAULT_LINE_HEIGHT: f64 = 1.2;

/// How far a stored line height may sit from the default before it is worth
/// telling the caller it will not survive the render.
const ASS_LINE_HEIGHT_WARNING_TOLERANCE: f64 = 0.15;

/// Warns about text styling the libass burn-in path cannot reproduce.
///
/// The ASS path is the one an export actually takes whenever FFmpeg has the
/// `subtitles` filter, and it has two blind spots the `drawtext` fallback does
/// not: ASS has no line-spacing control at all, so libass follows the font's own
/// metrics, and a missing font is substituted without saying so. Both are
/// reported here rather than discovered in the finished file.
fn validate_text_render_fidelity(
    validation: &mut ExportValidation,
    sequence: &Sequence,
    effects: &std::collections::HashMap<String, Effect>,
) {
    for track in &sequence.tracks {
        if !track_included_in_media_collection(track) {
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            let effect = match track.kind {
                TrackKind::Caption => build_caption_text_effect(clip),
                TrackKind::Video | TrackKind::Overlay if is_text_clip(clip) => {
                    // A clip missing its effect is already an error from the
                    // main validation walk; there is nothing to add here.
                    build_text_clip_effect_with_transform(clip, effects).ok()
                }
                _ => None,
            };
            let Some(effect) = effect else {
                continue;
            };

            let line_height = effect_float_param(&effect, "line_height", ASS_DEFAULT_LINE_HEIGHT);
            if (line_height - ASS_DEFAULT_LINE_HEIGHT).abs() > ASS_LINE_HEIGHT_WARNING_TOLERANCE {
                validation.add_clip_warning(
                    &sequence.id,
                    &clip.id,
                    format!(
                        "Line height {line_height:.2} on clip '{}' on track '{}' is honored only by the drawtext fallback; the libass burn-in path an export normally takes follows the font's own line metrics",
                        clip.id, track.name
                    ),
                );
            }

            let requested_family = ass_sanitize_style_field(
                &effect_string_param(&effect, "font_family", "Arial"),
                "Arial",
            );
            if let FontResolution::Substituted(replacement) =
                resolve_text_font_family(&requested_family)
            {
                validation.add_clip_warning(
                    &sequence.id,
                    &clip.id,
                    format!(
                        "Font '{requested_family}' on clip '{}' on track '{}' is neither bundled nor installed; the clip renders in the bundled '{replacement}' instead",
                        clip.id, track.name
                    ),
                );
            }
        }
    }
}

fn validate_caption_track_qc(
    validation: &mut ExportValidation,
    sequence_id: &str,
    clock: &TimelineClock,
    track: &Track,
) {
    let mut enabled_caption_clips: Vec<&Clip> =
        track.clips.iter().filter(|clip| clip.enabled).collect();

    for clip in &enabled_caption_clips {
        validate_clip_frame_alignment(validation, sequence_id, clock, clip, track);

        let caption_text = clip.label.as_deref().unwrap_or("").trim();
        if caption_text.is_empty() {
            validation.add_clip_warning(
                sequence_id,
                &clip.id,
                format!(
                    "Caption clip '{}' on track '{}' has empty text",
                    clip.id, track.name
                ),
            );
        }

        let duration = clip.place.duration_sec;
        if duration <= 0.0 {
            validation.add_clip_warning(
                sequence_id,
                &clip.id,
                format!(
                    "Caption clip '{}' on track '{}' has no visible duration",
                    clip.id, track.name
                ),
            );
        } else if duration < 0.5 {
            validation.add_clip_warning(
                sequence_id,
                &clip.id,
                format!(
                    "Caption clip '{}' on track '{}' is shorter than 0.5 seconds",
                    clip.id, track.name
                ),
            );
        }
    }

    enabled_caption_clips.sort_by(|a, b| {
        a.place
            .timeline_in_sec
            .partial_cmp(&b.place.timeline_in_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    for pair in enabled_caption_clips.windows(2) {
        let previous = pair[0];
        let next = pair[1];
        if previous.place.overlaps(&next.place) {
            validation.add_clip_warning(
                sequence_id,
                &next.id,
                format!(
                    "Caption clips '{}' and '{}' overlap on track '{}'",
                    previous.id, next.id, track.name
                ),
            );
        }
    }
}

/// Validate export settings before starting export.
///
/// This can spawn FFprobe (see [`validate_export_settings_with_dimensions`]), so
/// callers on an async runtime must run it on a blocking thread.
pub fn validate_export_settings(
    sequence: &Sequence,
    assets: &std::collections::HashMap<String, Asset>,
    effects: &std::collections::HashMap<String, Effect>,
    settings: &ExportSettings,
) -> ExportValidation {
    validate_export_settings_with_dimensions(sequence, assets, effects, settings, None, None)
}

/// Validate export settings, reusing measurements someone already took.
///
/// Placing a transformed clip needs the source's real pixel size, and deciding
/// whether a transition has a handle needs the source's real length. Without
/// `known_source_dimensions` and `known_source_durations` this measures the
/// sources itself, which spawns a synchronous FFprobe per asset — pass
/// [`source_dimensions_from_audio_info`] and [`source_durations_from_audio_info`]
/// when the export has already probed.
pub fn validate_export_settings_with_dimensions(
    sequence: &Sequence,
    assets: &std::collections::HashMap<String, Asset>,
    effects: &std::collections::HashMap<String, Effect>,
    settings: &ExportSettings,
    known_source_dimensions: Option<&SourceDimensionMap>,
    known_source_durations: Option<&SourceDurationMap>,
) -> ExportValidation {
    let mut validation = ExportValidation::valid();
    let timeline_clock = TimelineClock::new(sequence.format.fps.clone());
    let (canvas_width, canvas_height) = output_video_dimensions(sequence, settings);
    // Seeded from whatever the caller already measured, then filled in by the
    // same resolver the filtergraph builder uses, so validation and the render
    // cannot disagree about how big a source is.
    let mut source_dimensions: SourceDimensionCache = known_source_dimensions
        .map(|known| {
            known
                .iter()
                .map(|(asset_id, dimensions)| (asset_id.clone(), Some(*dimensions)))
                .collect()
        })
        .unwrap_or_default();

    // Planned with the same resolver the filtergraph builder uses, for the same
    // reason: a transition the render blends must not be reported as a cut, and
    // one it refuses must say why.
    // Seeded exactly like the dimension cache above, and for the same reason:
    // validation used to start from nothing here and re-probe every asset a
    // transition touched, even when the caller had just measured them all.
    let mut source_durations: SourceDurationCache = known_source_durations
        .map(|known| {
            known
                .iter()
                .map(|(asset_id, duration)| (asset_id.clone(), Some(*duration)))
                .collect()
        })
        .unwrap_or_default();
    let transition_plan = plan_sequence_transitions(
        sequence,
        assets,
        effects,
        output_video_fps(sequence, settings),
        |asset| resolve_asset_source_duration(asset, &mut source_durations),
    );

    for error in validate_export_settings_options(settings) {
        validation.add_error(error);
    }

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

    // Kept as one message rather than one per clip, but addressed at the first
    // offending clip so the caller has somewhere to jump to.
    let first_unsupported_overlay_clip = sequence
        .tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Overlay && track_included_in_export(track))
        .flat_map(|track| track.clips.iter())
        .find(|clip| clip.enabled && !is_text_clip(clip))
        .map(|clip| clip.id.clone());
    let has_enabled_unsupported_overlay_clips = first_unsupported_overlay_clip.is_some();
    if let Some(clip_id) = first_unsupported_overlay_clip {
        validation.add_clip_error(
            &sequence.id,
            clip_id,
            "Overlay tracks are not supported in final render export yet",
        );
    }

    let visual_clip_count: usize = sequence
        .tracks
        .iter()
        .filter(|track| track_included_in_export(track))
        .map(|track| {
            track
                .clips
                .iter()
                .filter(|clip| {
                    clip.enabled
                        && !clip.is_adjustment_layer()
                        && (track.kind == TrackKind::Video
                            || track.kind == TrackKind::Caption
                            || (track.kind == TrackKind::Overlay && is_text_clip(clip)))
                })
                .count()
        })
        .sum();
    if visual_clip_count == 0 {
        if !has_enabled_unsupported_overlay_clips {
            validation.add_error("Sequence has no visual clips to export");
        }
        return validation;
    }

    validate_text_render_fidelity(&mut validation, sequence, effects);

    // Check all clip assets exist (except virtual text clips) and are safe to read.
    for track in &sequence.tracks {
        if !track_included_in_media_collection(track) {
            continue;
        }

        if track.kind == TrackKind::Caption {
            // Caption tracks are burned in separately and do not use file-backed assets.
            validate_caption_track_qc(&mut validation, &sequence.id, &timeline_clock, track);
            continue;
        }

        for clip in &track.clips {
            if !clip.enabled {
                continue;
            }

            if track.kind == TrackKind::Overlay && !is_text_clip(clip) {
                continue;
            }

            validate_clip_frame_alignment(
                &mut validation,
                &sequence.id,
                &timeline_clock,
                clip,
                track,
            );
            validate_clip_effect_contract(
                &mut validation,
                &sequence.id,
                clip,
                track,
                effects,
                &transition_plan,
            );

            // Pan, zoom and anchor moves now render: the composite animates them
            // straight from the keyframes. What still does not render is motion
            // that turns the picture — FFmpeg cannot resize a frame per-frame and
            // rotate it in the same pass — along with keyframes too degenerate to
            // animate, such as a lone keyframe that disagrees with the clip's own
            // transform. Those still composite once at the base transform, so the
            // caller is told rather than left to discover it.
            if track.kind == TrackKind::Video
                && clip_motion_differs_from_base_transform(clip)
                && !clip_motion_renders_animated(clip)
                && !clip.is_adjustment_layer()
                && !is_text_clip(clip)
            {
                validation.add_clip_warning(
                    &sequence.id,
                    &clip.id,
                    format!(
                        "Motion keyframes on clip '{}' on track '{}' are not yet rendered; the clip renders with its base transform",
                        clip.id, track.name
                    ),
                );
            }

            if is_text_clip(clip) {
                // Ensure the clip has an enabled TextOverlay effect so rendering is deterministic.
                let has_text_overlay = clip.effects.iter().any(|effect_id| {
                    effects
                        .get(effect_id)
                        .is_some_and(|e| e.effect_type == EffectType::TextOverlay && e.enabled)
                });
                if !has_text_overlay {
                    validation.add_clip_error(
                        &sequence.id,
                        &clip.id,
                        format!(
                            "Text clip '{}' is missing an enabled TextOverlay effect",
                            clip.id
                        ),
                    );
                }
                continue;
            }

            // Adjustment layers have no source media — skip file validation
            if clip.is_adjustment_layer() {
                for effect in clip.effects.iter().filter_map(|id| effects.get(id)) {
                    if effect.enabled
                        && effect.is_video()
                        && !effect_type_supports_timeline_enable(&effect.effect_type)
                    {
                        validation.add_clip_error(
                            &sequence.id,
                            &clip.id,
                            untimeable_adjustment_effect_message(
                                &effect_type_label(&effect.effect_type),
                                &clip.id,
                                &track.name,
                            ),
                        );
                    }
                }
                continue;
            }

            let Some(asset) = assets.get(&clip.asset_id) else {
                validation.add_clip_error(
                    &sequence.id,
                    &clip.id,
                    format!("Asset '{}' not found for clip '{}'", clip.asset_id, clip.id),
                );
                continue;
            };

            // Defense-in-depth: validate local file path early to avoid starting an export
            // that will certainly fail (or could be abused if the state is compromised).
            if let Err(err) = validate_local_input_path(&asset.uri, "Asset file") {
                validation.add_clip_error(
                    &sequence.id,
                    &clip.id,
                    format!("Invalid asset path for asset '{}': {}", asset.id, err),
                );
            }

            // A clip may name more source than its media holds — an insert made
            // before the asset was probed takes a default length whatever the
            // file is, and splitting such a clip hands the tail half a range
            // that starts past the end. Saying so here is what keeps raw FFmpeg
            // stderr from being the only signal.
            if let Some(finding) = source_overrun_finding(clip, asset, track, &mut source_durations)
            {
                validation.add_clip_warning(&sequence.id, &clip.id, finding);
            }

            // Placing a transformed clip needs the source's real pixel size. An
            // identity clip is only fitted to the canvas, so it never pays for
            // this and never fails on it.
            if track.kind == TrackKind::Video && clip_needs_transform_composition(clip) {
                // A clip composited only for its motion has somewhere to fall
                // back to — the plain canvas fit it rendered as before motion
                // animated — so an unmeasurable source costs it the animation
                // rather than the whole export. The render degrades to the same
                // fit, so the two passes agree on what the file will contain.
                let motion_only = clip_composition_is_motion_only(clip);
                match resolve_asset_source_dimensions(asset, &mut source_dimensions) {
                    None if motion_only => validation.add_clip_warning(
                        &sequence.id,
                        &clip.id,
                        unmeasurable_motion_message(
                            &clip.id,
                            &track.name,
                            &format!("the source dimensions of asset '{}' are unknown", asset.id),
                        ),
                    ),
                    None => validation.add_clip_error(
                        &sequence.id,
                        &clip.id,
                        format!(
                            "Could not determine source dimensions of asset '{}' needed to place transformed clip '{}'",
                            asset.id, clip.id
                        ),
                    ),
                    Some(probed_dimensions) => {
                        // The clip's own effects can resize the picture before
                        // the transform sees it. Failing loudly beats scaling
                        // against a size that is no longer true.
                        // Only the size the chain produces matters here, and no
                        // resizing filter is time-anchored, so the branch offset
                        // a transition would add cannot change the answer.
                        let graph = build_clip_filter_graph(
                            clip,
                            effects,
                            Some(canvas_width),
                            Some(canvas_height),
                            Some(output_video_fps(sequence, settings)),
                            ClipHandles::default(),
                        );
                        if let Err(effect_label) =
                            effective_source_dimensions(probed_dimensions, &graph)
                        {
                            if motion_only {
                                validation.add_clip_warning(
                                    &sequence.id,
                                    &clip.id,
                                    unmeasurable_motion_message(
                                        &clip.id,
                                        &track.name,
                                        &format!(
                                            "effect '{}' changes the picture size unpredictably",
                                            effect_label
                                        ),
                                    ),
                                );
                            } else {
                                validation.add_clip_error(
                                    &sequence.id,
                                    &clip.id,
                                    unmeasurable_effect_message(&effect_label, &clip.id),
                                );
                            }
                        }
                    }
                }
            }

            validate_clip_asset_qc(&mut validation, clip, track, asset, sequence, settings);
        }
    }

    if let Some(refusal) = super::pip_stitch::composite_refusal(sequence, &transition_plan) {
        validation.add_clip_error(
            sequence.id.clone(),
            refusal.clip_id.to_string(),
            refusal.message,
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
    let engine = ExportEngine::new(crate::core::ffmpeg::FFmpegRunner::new(
        crate::core::ffmpeg::FFmpegInfo {
            ffmpeg_path: crate::core::ffmpeg::resolved_ffmpeg_path(),
            ffprobe_path: crate::core::ffmpeg::resolved_ffprobe_path(),
            version: "test-builder".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        },
    ));

    super::ffmpeg_plan::build_sequence_ffmpeg_args(super::ffmpeg_plan::SequenceFfmpegBuildContext {
        engine: &engine,
        sequence,
        assets,
        effects,
        audio_info,
        settings,
        render_plan: None,
        ass_text_overlay_path: None,
    })
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
    use crate::core::timeline::Transform;

    fn create_temp_media_file(filename: &str) -> String {
        let dir = std::env::temp_dir().join("openreelio-test-media");
        let _ = std::fs::create_dir_all(&dir);

        let unique = ulid::Ulid::new().to_string();
        let path = dir.join(format!("{unique}_{filename}"));
        std::fs::write(&path, b"").expect("create temp media file");
        path.to_string_lossy().to_string()
    }

    #[test]
    fn test_build_ass_text_overlay_script_maps_text_clip_style_and_transform() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let effect_id = "text-effect".to_string();
        let mut text_clip = Clip::new(&format!("{}title", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.5)
            .place_at(1.25);
        text_clip.effects.push(effect_id.clone());
        text_clip.transform.position = Point2D::new(0.25, 0.75);
        text_clip.transform.scale = Point2D::new(2.0, 1.0);
        text_clip.transform.rotation_deg = 15.0;
        text_clip.opacity = 0.75;
        track.add_clip(text_clip);
        sequence.add_track(track);

        let mut effect = Effect::with_id(&effect_id, EffectType::TextOverlay);
        effect.set_param(
            "text",
            ParamValue::String("Hello\nWorld {safe}".to_string()),
        );
        effect.set_param("font_family", ParamValue::String("Inter".to_string()));
        effect.set_param("font_size", ParamValue::Float(64.0));
        effect.set_param("font_weight", ParamValue::Int(700));
        effect.set_param("color", ParamValue::String("#AABBCC".to_string()));
        effect.set_param("opacity", ParamValue::Float(0.75));
        effect.set_param("outline_color", ParamValue::String("#101112".to_string()));
        effect.set_param("outline_width", ParamValue::Int(3));
        effect.set_param("shadow_color", ParamValue::String("#00000080".to_string()));
        effect.set_param("shadow_x", ParamValue::Int(8));
        effect.set_param("shadow_y", ParamValue::Int(4));
        effect.set_param("line_height", ParamValue::Float(1.5));

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let script = build_ass_text_overlay_script(&sequence, &effects)
            .expect("script result")
            .expect("script exists");

        assert!(script.contains("PlayResX: 1920"));
        assert!(script.contains("PlayResY: 1080"));
        assert!(script.contains("Style: OpenReelioText0,Inter,96.00,&H40CCBBAA"));
        assert!(script.contains(",133.33,66.67,"));
        // A rotated, multi-line text block is one event carrying `\N`, so the
        // rotation applies to the block rather than to each line separately.
        assert_eq!(script.matches("Dialogue:").count(), 1);
        assert!(script.contains("Dialogue: 0,0:00:01.25,0:00:04.75,OpenReelioText0,,0,0,0,,"));
        assert!(script.contains(r"\pos(480.00,810.00)\an5\frz15.00\b700"));
        assert!(script.contains(r"\xshad8\yshad4"));
        assert!(script.contains(r"Hello\NWorld \{safe\}"));
    }

    #[test]
    fn ass_script_wraps_text_rather_than_clipping_it() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Wrap me".to_string());
        track.add_clip(clip);
        sequence.add_track(track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert!(
            script.contains("WrapStyle: 0"),
            "WrapStyle 2 disables wrapping entirely. Got: {script}"
        );
    }

    #[test]
    fn ass_play_resolution_is_pinned_to_1080_regardless_of_export_size() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // 4K and vertical canvases both author the script in a 1080-tall space,
        // so `fontSize: 48` means the same fraction of the frame everywhere.
        for (canvas_width, canvas_height, expected_play_res_x) in [
            (3840u32, 2160u32, 1920u32),
            (1080, 1920, 608),
            (1920, 1080, 1920),
        ] {
            let mut sequence = Sequence::new(
                "Test",
                SequenceFormat::new(canvas_width, canvas_height, 30, 1, 48000),
            );
            let mut track = Track::new_caption("Captions");
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            clip.label = Some("Scaled".to_string());
            clip.caption_style = Some(serde_json::json!({ "fontSize": 48 }));
            clip.caption_position = Some(serde_json::json!({
                "type": "custom",
                "xPercent": 50,
                "yPercent": 50
            }));
            track.add_clip(clip);
            sequence.add_track(track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            assert!(
                script.contains(&format!("PlayResX: {expected_play_res_x}")),
                "{canvas_width}x{canvas_height} should author at PlayResX {expected_play_res_x}. Got: {script}"
            );
            assert!(
                script.contains("PlayResY: 1080"),
                "{canvas_width}x{canvas_height} should author at PlayResY 1080. Got: {script}"
            );
            // The font size stays nominal and `\pos` lands in PlayRes space,
            // never in output pixels.
            assert!(
                script.contains(",48.00,"),
                "font size must stay in PlayRes space. Got: {script}"
            );
            let expected_x = f64::from(expected_play_res_x) * 0.5;
            assert!(
                script.contains(&format!("\\pos({expected_x:.2},540.00)")),
                "position must be in PlayRes space. Got: {script}"
            );
        }
    }

    #[test]
    fn preset_caption_anchors_on_margins_so_libass_can_wrap_it() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // 10% of PlayResX (1920) on each side leaves the 80% wrap box; 8% of
        // PlayResY (1080) is the preset's own margin.
        for (alignment, expected_alignment) in [("left", 1), ("center", 2), ("right", 3)] {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut track = Track::new_caption("Captions");
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            clip.label = Some("Anchored".to_string());
            clip.caption_style = Some(serde_json::json!({ "alignment": alignment }));
            clip.caption_position = Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": 8
            }));
            track.add_clip(clip);
            sequence.add_track(track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            assert!(
                !script.contains("\\pos("),
                "`\\pos` disables margins, so a wrapped caption must not carry one. Got: {script}"
            );
            assert!(
                script.contains(&format!(
                    "Dialogue: 0,0:00:00.00,0:00:02.00,OpenReelioText0,,192,192,86,,{{\\an{expected_alignment}"
                )),
                "{alignment} caption should carry margins and \\an{expected_alignment}. Got: {script}"
            );
            assert!(
                script.contains(&format!(",{expected_alignment},192,192,86,1\n")),
                "the style should carry the same anchor as the event. Got: {script}"
            );
        }
    }

    #[test]
    fn preset_caption_vertical_selects_the_numpad_row() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        for (vertical, expected_alignment, expected_margin_v) in
            [("top", 8, 86), ("center", 5, 0), ("bottom", 2, 86)]
        {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut track = Track::new_caption("Captions");
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            clip.label = Some("Row".to_string());
            clip.caption_position = Some(serde_json::json!({
                "type": "preset",
                "vertical": vertical,
                "marginPercent": 8
            }));
            track.add_clip(clip);
            sequence.add_track(track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            assert!(
                script.contains(&format!(
                    ",,192,192,{expected_margin_v},,{{\\an{expected_alignment}"
                )),
                "{vertical} should map to \\an{expected_alignment}. Got: {script}"
            );
        }
    }

    #[test]
    fn export_and_preview_agree_on_the_horizontal_anchor_of_a_preset_caption() {
        // Mirrors `resolveCaptionAnchor` in src/utils/captionStyle.ts, pinned by
        // captionStyle.test.ts: alignment picks 10 / 50 / 90 percent.
        for (alignment, expected_x) in [("left", 0.10), ("center", 0.50), ("right", 0.90)] {
            let anchor = CaptionAnchor::Preset {
                vertical: CaptionVertical::Bottom,
                margin_percent: 5.0,
            };
            let (x, y) = caption_anchor_position(anchor, alignment);
            assert!(
                (x - expected_x).abs() < 1e-9,
                "{alignment} should anchor at {expected_x}, got {x}"
            );
            assert!((y - 0.95).abs() < 1e-9);
        }

        // A custom position keeps the coordinates its author chose.
        let (x, y) = caption_anchor_position(CaptionAnchor::Custom { x: 0.8, y: 0.9 }, "left");
        assert!((x - 0.8).abs() < 1e-9 && (y - 0.9).abs() < 1e-9);
    }

    #[test]
    fn bundled_font_is_embedded_in_the_script_that_uses_it() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        for (index, family) in ["bebasneue", "Bebas Neue"].iter().enumerate() {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(index as f64 * 2.0);
            clip.label = Some("Bundled".to_string());
            clip.caption_style = Some(serde_json::json!({ "fontFamily": family }));
            track.add_clip(clip);
        }
        sequence.add_track(track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert!(script.contains("[Fonts]\n"));
        assert_eq!(
            script.matches("fontname: BebasNeue-Regular_0.ttf").count(),
            1,
            "a family used twice must still be embedded once. Got: {script}"
        );
        // Both spellings normalize to the family the embedded font declares.
        assert_eq!(
            script.matches("Bebas Neue,").count(),
            2,
            "both clips should name the canonical family. Got: {script}"
        );
    }

    #[test]
    fn a_font_available_nowhere_is_substituted_and_reported() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let missing = "Definitely Not An Installed Family";
        assert_eq!(
            resolve_text_font_family(missing),
            FontResolution::Substituted("TikTok Sans"),
        );

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.id = "missing-font-caption".to_string();
        clip.label = Some("Substituted".to_string());
        clip.caption_style = Some(serde_json::json!({ "fontFamily": missing }));
        track.add_clip(clip);
        sequence.add_track(track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");
        assert!(
            script.contains("Style: OpenReelioText0,TikTok Sans,"),
            "a missing family must be replaced explicitly, not left to libass. Got: {script}"
        );
        assert!(script.contains("fontname: TikTokSans-Regular_0.ttf"));

        let mut validation = ExportValidation::valid();
        validate_text_render_fidelity(&mut validation, &sequence, &HashMap::new());
        assert!(
            validation.warnings.iter().any(|warning| {
                warning.contains("missing-font-caption")
                    && warning.contains(missing)
                    && warning.contains("TikTok Sans")
            }),
            "the substitution must be reported. Got: {:?}",
            validation.warnings
        );
    }

    #[test]
    fn a_custom_line_height_is_reported_as_unrenderable() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        for (clip_id, line_height) in [
            ("default-spacing", 1.2),
            ("within-tolerance", 1.3),
            ("wide-spacing", 1.8),
        ] {
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            clip.id = clip_id.to_string();
            clip.label = Some("Spaced".to_string());
            clip.caption_style = Some(serde_json::json!({ "lineHeight": line_height }));
            track.add_clip(clip);
        }
        sequence.add_track(track);

        let mut validation = ExportValidation::valid();
        validate_text_render_fidelity(&mut validation, &sequence, &HashMap::new());

        let spacing_warnings: Vec<&String> = validation
            .warnings
            .iter()
            .filter(|warning| warning.contains("Line height"))
            .collect();
        assert_eq!(
            spacing_warnings.len(),
            1,
            "only a line height that visibly deviates should warn. Got: {:?}",
            validation.warnings
        );
        assert!(spacing_warnings[0].contains("wide-spacing"));
        assert!(validation.is_valid, "the warning must not block the export");
    }

    #[test]
    fn test_build_ass_text_overlay_script_preserves_background_padding() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let effect_id = "boxed-text-effect".to_string();
        let mut text_clip = Clip::new(&format!("{}boxed", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        text_clip.effects.push(effect_id.clone());
        track.add_clip(text_clip);
        sequence.add_track(track);

        let mut effect = Effect::with_id(&effect_id, EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Boxed".to_string()));
        effect.set_param(
            "background_color",
            ParamValue::String("#00000080".to_string()),
        );
        effect.set_param("background_padding", ParamValue::Int(24));

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let script = build_ass_text_overlay_script(&sequence, &effects)
            .expect("script result")
            .expect("script exists");

        assert!(
            script.contains(",3,24.00,0.00,5,"),
            "Expected BorderStyle=3 with exported background padding. Got: {script}"
        );
        assert!(
            script.contains(r"\bord24.00"),
            "Expected dialogue override to preserve background padding. Got: {script}"
        );
    }

    /// Builds the ASS script for one caption carrying `style` at the default anchor.
    fn caption_ass_script_for_style(style: serde_json::Value) -> String {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Boxed".to_string());
        clip.caption_style = Some(style);
        track.add_clip(clip);
        sequence.add_track(track);

        build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists")
    }

    /// Column indices of the `[V4+ Styles]` `Format:` line this exporter writes.
    mod ass_style_column {
        /// `OutlineColour`, which `BorderStyle: 3` draws its opaque box in.
        pub const BORDER_COLOUR: usize = 5;
        /// `BackColour`, which carries the drop shadow.
        pub const BACK_COLOUR: usize = 6;
        /// `BorderStyle`: 1 for outline plus shadow, 3 for an opaque box.
        pub const BORDER_STYLE: usize = 15;
    }

    /// Splits the script's single `Style:` line into its columns.
    fn ass_style_columns(script: &str) -> Vec<String> {
        script
            .lines()
            .find(|line| line.starts_with("Style: "))
            .expect("the script carries a style line")
            .split(',')
            .map(str::to_string)
            .collect()
    }

    /// Reads the `OutlineColour` and `BackColour` columns out of a `Style:` line.
    fn ass_border_and_back_colour(script: &str) -> (String, String) {
        let columns = ass_style_columns(script);
        (
            columns[ass_style_column::BORDER_COLOUR].clone(),
            columns[ass_style_column::BACK_COLOUR].clone(),
        )
    }

    /// Reads the visible alpha of an `&HAABBGGRR` colour, where `0xFF` is invisible.
    fn ass_colour_visible_alpha(raw: &str) -> u8 {
        let hex = raw.trim().trim_start_matches("&H");
        assert_eq!(hex.len(), 8, "an ASS colour is eight hex digits: {raw}");
        255 - u8::from_str_radix(&hex[0..2], 16).expect("the alpha byte parses")
    }

    #[test]
    fn a_boxed_caption_writes_its_box_colour_to_the_ass_border_column() {
        // libass draws a `BorderStyle: 3` box in the OutlineColour column and
        // reserves BackColour for the drop-shadow box behind it. Writing the
        // box colour to BackColour left the box column fully transparent, so a
        // boxed caption burned in as bare text over the footage.
        let script = caption_ass_script_for_style(serde_json::json!({
            "color": { "r": 255, "g": 255, "b": 255, "a": 255 },
            "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 180 },
            "shadowColor": { "r": 0, "g": 0, "b": 0, "a": 120 },
            "shadowOffset": 2.0,
        }));

        let (border, back) = ass_border_and_back_colour(&script);
        // Alpha is inverted in ASS: 180/255 visible becomes 0x4B opaque-from-255.
        assert_eq!(
            border, "&H4B000000",
            "the box colour must reach the border column. Got: {script}"
        );
        assert_eq!(
            back, "&H87000000",
            "the shadow colour must keep the back column. Got: {script}"
        );
        assert!(
            script.contains(",3,10.00,2.00,"),
            "a box must select BorderStyle 3 and keep its shadow. Got: {script}"
        );
    }

    #[test]
    fn an_outlined_caption_still_writes_its_outline_to_the_ass_border_column() {
        // The border column is shared: without a box it carries the outline,
        // exactly as it did before boxes were routed through it.
        let script = caption_ass_script_for_style(serde_json::json!({
            "color": { "r": 255, "g": 255, "b": 255, "a": 255 },
            "outlineColor": { "r": 0, "g": 0, "b": 0, "a": 255 },
            "outlineWidth": 4.0,
        }));

        let (border, back) = ass_border_and_back_colour(&script);
        assert_eq!(border, "&H00000000", "Got: {script}");
        assert_eq!(
            back, "&HFF000000",
            "no shadow leaves the back column transparent. Got: {script}"
        );
        assert!(
            script.contains(",1,4.00,0.00,"),
            "an outline must stay on BorderStyle 1. Got: {script}"
        );
    }

    #[test]
    fn every_curated_pack_with_a_background_burns_a_visible_box() {
        use crate::core::style::caption_packs::CAPTION_PACKS;

        // `boxed-contrast`, `broadcast-lower` and `high-contrast-accessible`
        // are the packs whose whole point is the box. Walking the table rather
        // than naming them keeps a future boxed pack from shipping unchecked.
        let boxed: Vec<&str> = CAPTION_PACKS
            .iter()
            .filter(|pack| pack.style().background_color.is_some())
            .map(|pack| pack.id)
            .collect();
        assert!(
            boxed.contains(&"boxed-contrast")
                && boxed.contains(&"broadcast-lower")
                && boxed.contains(&"high-contrast-accessible"),
            "the boxed packs must still be boxed, got {boxed:?}"
        );

        for pack in CAPTION_PACKS
            .iter()
            .filter(|pack| pack.style().background_color.is_some())
        {
            let style =
                serde_json::to_value(pack.style()).expect("a pack style serializes to JSON");
            let script = caption_ass_script_for_style(style);
            let columns = ass_style_columns(&script);

            assert_eq!(
                columns[ass_style_column::BORDER_STYLE],
                "3",
                "pack '{}' must select BorderStyle 3. Got: {script}",
                pack.id
            );
            let alpha = ass_colour_visible_alpha(&columns[ass_style_column::BORDER_COLOUR]);
            assert!(
                alpha >= 128,
                "pack '{}' must draw a box the footage cannot swallow, got alpha {alpha}",
                pack.id
            );
        }
    }

    #[test]
    fn caption_typography_reaches_the_ass_style_fields_that_can_carry_it() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Text clips already mapped underline, letter spacing and shadow blur;
        // a caption dropped all three even though the ASS style has a column
        // for each. `drawtext` has no equivalent, so the fallback is unchanged.
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Typography".to_string());
        clip.caption_style = Some(serde_json::json!({
            "underline": true,
            "letterSpacing": 6,
            "shadowBlur": 4,
            "shadowColor": "#000000",
        }));
        track.add_clip(clip.clone());
        sequence.add_track(track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");
        assert!(
            script.contains(",0,-1,0,100.00,100.00,6,"),
            "underline and spacing must reach the style. Got: {script}"
        );
        assert!(
            script.contains(r"\blur4\fsp6"),
            "shadow blur and spacing must reach the event. Got: {script}"
        );

        let filter = build_caption_drawtext_with_enable(&clip).expect("drawtext filter");
        assert!(
            !filter.contains("blur") && !filter.contains("spacing"),
            "the drawtext fallback must be unchanged. Got: {filter}"
        );
    }

    #[test]
    fn test_caption_decoration_alpha_reaches_the_drawtext_filter() {
        use crate::core::timeline::Clip;

        // A translucent box is the whole point of a boxed caption style: if the
        // alpha is dropped, the box that was supposed to let the footage read
        // through renders as an opaque slab instead.
        let mut caption_clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        caption_clip.label = Some("Translucent".to_string());
        caption_clip.caption_style = Some(serde_json::json!({
            "fontSize": 48,
            "color": { "r": 255, "g": 255, "b": 255, "a": 255 },
            "backgroundColor": { "r": 0, "g": 0, "b": 0, "a": 153 },
            "shadowColor": { "r": 0, "g": 0, "b": 0, "a": 128 },
        }));

        let filter = build_caption_drawtext_with_enable(&caption_clip).expect("drawtext filter");

        assert!(
            filter.contains("boxcolor=0x000000@0.60"),
            "background alpha must reach boxcolor, got: {filter}"
        );
        assert!(
            filter.contains("shadowcolor=0x000000@0.50"),
            "shadow alpha must reach shadowcolor, got: {filter}"
        );
        // Fully opaque text still renders without an alpha suffix.
        assert!(
            filter.contains("fontcolor=0xFFFFFF:"),
            "opaque text must not gain an alpha suffix, got: {filter}"
        );
    }

    #[test]
    fn test_a_caption_position_that_names_no_point_keeps_the_preset_default() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // A position blob with no coordinates in it used to resolve to the
        // custom point (0.5, 0.9), which the burn-in writes as `\pos` - and a
        // positioned event has no margins, so the caption lost wrapping and its
        // alignment-driven anchor to a value nobody chose.
        for position in [
            serde_json::json!({}),
            serde_json::json!({ "type": "custom" }),
        ] {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut caption_track = Track::new_caption("Captions");
            let mut caption_clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            caption_clip.label = Some("Defaulted".to_string());
            caption_clip.caption_position = Some(position.clone());
            caption_track.add_clip(caption_clip);
            sequence.add_track(caption_track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            assert!(
                !script.contains("\\pos("),
                "{position} must not pin the caption. Got: {script}"
            );
            assert!(
                script.contains(",2,192,192,54,"),
                "{position} must keep the default bottom margins. Got: {script}"
            );
        }
    }

    #[test]
    fn test_a_non_finite_caption_number_never_reaches_the_ass_script() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // `"NaN"`, `"inf"` and friends parse as perfectly good `f64`s, and every
        // consumer of a caption number goes on to `clamp` it - which returns NaN
        // unchanged rather than pulling it into range. A style blob carrying one
        // used to be formatted straight into an ASS style column as the literal
        // text `NaN`, and libass drops a line it cannot parse, so the caption
        // silently vanished from the render.
        for hostile in [
            "NaN",
            "nan",
            "inf",
            "-inf",
            "Infinity",
            "-Infinity",
            "infinity",
        ] {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut track = Track::new_caption("Captions");
            let mut clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            clip.label = Some("Hostile numbers".to_string());
            clip.caption_style = Some(serde_json::json!({
                "fontSize": hostile,
                "lineHeight": hostile,
                "letterSpacing": hostile,
                "opacity": hostile,
                "outlineWidth": hostile,
                "backgroundPadding": hostile,
            }));
            clip.caption_position = Some(serde_json::json!({
                "type": "preset",
                "vertical": "bottom",
                "marginPercent": hostile,
            }));
            track.add_clip(clip);
            sequence.add_track(track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            // Rust formats the two as `NaN` and `inf`/`-inf`. `Inf` with a
            // capital I is not checked because the script's own
            // `[Script Info]` header contains it.
            for poison in ["NaN", "nan", "inf"] {
                assert!(
                    !script.contains(poison),
                    "'{hostile}' must not survive into the script as '{poison}'. Got: {script}"
                );
            }
            // And the field falls back to the default rather than to something
            // arbitrary: 48pt type, held off the bottom by the shared margin.
            assert!(
                script.contains(",48.00,"),
                "a refused font size must fall back to the default. Got: {script}"
            );
            assert!(
                script.contains(",2,192,192,54,1\n"),
                "a refused margin must fall back to the shared default. Got: {script}"
            );
        }
    }

    #[test]
    fn test_a_non_finite_effect_param_cannot_be_formatted_into_an_ass_field() {
        use crate::core::effects::ParamValue;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // Defence in depth for the formatters themselves: whatever put a
        // non-finite number on an effect param - a hand-written plan, a plugin,
        // a parser that has not been written yet - the ASS emitter must still
        // produce a script libass can read. `rotation` is the sharp case,
        // because it is the one float the emitter never clamped at all.
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Poisoned params".to_string());
        track.add_clip(clip);
        sequence.add_track(track);

        let mut effect = build_caption_text_effect(&sequence.tracks[0].clips[0])
            .expect("a caption clip builds a text effect");
        for param in ["font_size", "rotation", "opacity", "x", "y"] {
            effect.set_param(param, ParamValue::Float(f64::NAN));
        }
        effect.set_param("scale_x_percent", ParamValue::Float(f64::INFINITY));
        effect.set_param("scale_y_percent", ParamValue::Float(f64::NEG_INFINITY));

        let mut styles = String::new();
        let mut events = String::new();
        append_ass_text_style_and_event(
            &mut styles,
            &mut events,
            &AssEventContext {
                style_name: "OpenReelioText0",
                layer: 0,
                font_family: "Arial",
                window_start_sec: 0.0,
                anchor: ass_text_anchor(
                    &sequence.tracks[0].clips[0],
                    &TrackKind::Caption,
                    &effect,
                    1920,
                    1080,
                ),
            },
            &sequence.tracks[0].clips[0],
            &effect,
        );

        let emitted = format!("{styles}{events}");
        for poison in ["NaN", "nan", "inf"] {
            assert!(
                !emitted.contains(poison),
                "a non-finite param must not be formatted as '{poison}'. Got: {emitted}"
            );
        }
        assert!(
            emitted.contains("\\frz0.00"),
            "an unusable rotation falls back to no rotation. Got: {emitted}"
        );
        assert!(
            emitted.contains(",100.00,100.00,"),
            "unusable scales fall back to unscaled type. Got: {emitted}"
        );
    }

    #[test]
    fn test_a_positionless_caption_burns_in_at_the_preview_default_margin() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // A caption can be created with no stored position at all, and the
        // preview draws that caption `DEFAULT_CAPTION_POSITION.marginPercent`
        // (`src/types/index.ts`) of the canvas off the bottom. The burn-in used
        // to carry its own default of twice that, so the very same caption sat
        // at one height on screen and another in the exported file.
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        caption_clip.label = Some("Positionless".to_string());
        assert!(
            caption_clip.caption_position.is_none(),
            "the fixture has to exercise the no-stored-position path"
        );
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        let expected_margin_v =
            (CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT / 100.0 * 1080.0).round() as i32;
        assert_eq!(
            expected_margin_v, 54,
            "the shared default is 5% of a 1080-line canvas"
        );
        assert!(
            !script.contains("\\pos("),
            "a positionless caption keeps its margins rather than being pinned. Got: {script}"
        );
        assert!(
            script.contains(&format!(",,192,192,{expected_margin_v},,")),
            "the event's MarginV must be the preview's default, not the burn-in's own. \
             Got: {script}"
        );
        assert!(
            script.contains(&format!(",2,192,192,{expected_margin_v},1\n")),
            "the style must carry the same MarginV as the event. Got: {script}"
        );
    }

    #[test]
    fn test_the_burn_in_and_the_render_graph_agree_on_the_default_caption_height() {
        // The ASS path expresses the default as a margin off the bottom edge
        // and the render graph as a distance down from the top, so the one
        // number they share only stays shared if both are read from the same
        // constant. `resolve_caption_position_percent` in `graph.rs` is the
        // other half of this pairing.
        let anchor = resolve_caption_anchor(None, None);
        let (_, y) = caption_anchor_position(anchor, "center");

        assert_eq!(
            y * 100.0,
            100.0 - CAPTION_DEFAULT_VERTICAL_MARGIN_PERCENT,
            "a positionless caption sits one default margin above the bottom edge"
        );
    }

    #[test]
    fn test_bold_caption_emits_a_bold_weight_override() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // `\b<weight>` is an absolute weight in libass and outranks the style's
        // `Bold` column, so an event that always said `\b400` rendered regular
        // however loudly the style claimed bold.
        for style in [
            serde_json::json!({ "fontFamily": "Poppins", "bold": true }),
            serde_json::json!({ "fontFamily": "Poppins", "fontWeight": 700 }),
            serde_json::json!({ "fontFamily": "Poppins", "fontWeight": "bold" }),
        ] {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut caption_track = Track::new_caption("Captions");
            let mut caption_clip = Clip::new("caption-asset")
                .with_source_range(0.0, 2.0)
                .place_at(0.0);
            caption_clip.label = Some("Bold caption".to_string());
            caption_clip.caption_style = Some(style.clone());
            caption_track.add_clip(caption_clip);
            sequence.add_track(caption_track);

            let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
                .expect("script result")
                .expect("script exists");

            assert!(
                script.contains(r"\b700"),
                "a bold caption must override to weight 700 for {style}. Got: {script}"
            );
            assert!(
                !script.contains(r"\b400"),
                "the default weight must not survive for {style}. Got: {script}"
            );
            assert!(
                script.contains(",-1,0,0,0,"),
                "the style must still declare Bold. Got: {script}"
            );
        }
    }

    #[test]
    fn test_regular_caption_keeps_the_default_weight() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        caption_clip.label = Some("Regular caption".to_string());
        caption_clip.caption_style = Some(serde_json::json!({ "fontFamily": "Poppins" }));
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert!(script.contains(r"\b400"), "got: {script}");
        assert!(!script.contains(r"\b700"), "got: {script}");
    }

    #[test]
    fn test_build_ass_text_overlay_script_maps_caption_style_and_position() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.5);
        caption_clip.label = Some("Caption line".to_string());
        caption_clip.caption_style = Some(serde_json::json!({
            "fontFamily": "Arial",
            "fontSize": 42,
            "color": { "r": 255, "g": 240, "b": 32, "a": 204 },
            "outlineColor": "#000000",
            "outlineWidth": 4,
            "alignment": "right",
            "fontWeight": 700
        }));
        caption_clip.caption_position = Some(serde_json::json!({
            "type": "custom",
            "xPercent": 80,
            "yPercent": 90
        }));
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert!(script.contains("Style: OpenReelioText0,Arial,42.00,&H3320F0FF"));
        assert!(script.contains("Dialogue: 0,0:00:00.50,0:00:02.50,OpenReelioText0"));
        // A custom position is an exact point, so it keeps `\pos` - now in the
        // 1080-tall PlayRes space rather than in output pixels.
        assert!(script.contains(r"\pos(1536.00,972.00)\an6"));
        assert!(
            script.contains(",6,0,0,0,1\n"),
            "a positioned caption carries no margins. Got: {script}"
        );
        assert!(script.contains("Caption line"));
    }

    /// Builds a sequence whose topmost track and the track under it both carry
    /// an overlapping overlay, so the two burn-in paths can be asked which one
    /// they draw in front.
    ///
    /// Track index 0 is the topmost track, exactly as `build_render_graph`
    /// treats it, so the clip named "Top overlay" has to win the pixel.
    fn sequence_with_overlapping_overlays_on_two_tracks(
        top_kind: TrackKind,
        bottom_kind: TrackKind,
    ) -> (Sequence, HashMap<String, Effect>) {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut effects: HashMap<String, Effect> = HashMap::new();

        for (kind, label, track_name) in [
            (top_kind, "Top overlay", "Top"),
            (bottom_kind, "Bottom overlay", "Bottom"),
        ] {
            let mut track = match kind {
                TrackKind::Caption => Track::new_caption(track_name),
                _ => Track::new_video(track_name),
            };

            if kind == TrackKind::Caption {
                let mut clip = Clip::new("caption-asset")
                    .with_source_range(0.0, 4.0)
                    .place_at(0.0);
                clip.label = Some(label.to_string());
                track.add_clip(clip);
            } else {
                let effect_id = format!("effect-{track_name}");
                let mut clip = Clip::new(&format!("{TEXT_ASSET_PREFIX}{track_name}"))
                    .with_source_range(0.0, 4.0)
                    .place_at(0.0);
                clip.effects.push(effect_id.clone());
                track.add_clip(clip);

                let mut effect = Effect::with_id(&effect_id, EffectType::TextOverlay);
                effect.set_param("text", ParamValue::String(label.to_string()));
                effects.insert(effect_id, effect);
            }

            sequence.add_track(track);
        }

        (sequence, effects)
    }

    /// Returns the ASS `Layer` of the single event whose text is `needle`.
    fn ass_layer_of_event(script: &str, needle: &str) -> i32 {
        let matching: Vec<&str> = script
            .lines()
            .filter(|line| line.starts_with("Dialogue: ") && line.contains(needle))
            .collect();
        assert_eq!(
            matching.len(),
            1,
            "expected exactly one event carrying '{needle}'. Got: {matching:?}"
        );

        matching[0]
            .trim_start_matches("Dialogue: ")
            .split(',')
            .next()
            .expect("a Dialogue line always has a Layer field")
            .parse()
            .expect("the Layer field is an integer")
    }

    /// Feature: Overlay stacking order in the export
    ///   Scenario: two overlapping captions sit on different tracks
    ///     Given a caption on the topmost track and one on the track below it
    ///     When the ASS burn-in script is built
    ///     Then the topmost track's event carries the higher `Layer`
    ///
    /// libass draws a higher `Layer` in front of a lower one, so the layer has
    /// to grow with visual stack depth. Deriving it from the raw track index
    /// instead put the topmost track underneath everything below it.
    #[test]
    fn should_draw_the_topmost_track_over_the_track_below_when_captions_overlap() {
        let (sequence, effects) = sequence_with_overlapping_overlays_on_two_tracks(
            TrackKind::Caption,
            TrackKind::Caption,
        );

        let script = build_ass_text_overlay_script(&sequence, &effects)
            .expect("script result")
            .expect("script exists");

        let top_layer = ass_layer_of_event(&script, "Top overlay");
        let bottom_layer = ass_layer_of_event(&script, "Bottom overlay");

        // Two drawing tracks: the topmost sits at depth 1, the one below it at
        // depth 0, and each track owns a 1000-wide band of layers.
        assert_eq!(top_layer, 1000);
        assert_eq!(bottom_layer, 0);
        assert!(
            top_layer > bottom_layer,
            "the topmost track must draw in front. Got top={top_layer}, bottom={bottom_layer}"
        );
    }

    /// Feature: Overlay stacking order in the export
    ///   Scenario: a text clip on the topmost track overlaps a caption below it
    ///     Given a text clip on track 0 and a caption on track 1
    ///     When the ASS burn-in script is built
    ///     Then the text clip's event carries the higher `Layer`
    #[test]
    fn should_draw_a_topmost_text_clip_over_a_caption_on_the_track_below() {
        let (sequence, effects) =
            sequence_with_overlapping_overlays_on_two_tracks(TrackKind::Video, TrackKind::Caption);

        let script = build_ass_text_overlay_script(&sequence, &effects)
            .expect("script result")
            .expect("script exists");

        assert_eq!(ass_layer_of_event(&script, "Top overlay"), 1000);
        assert_eq!(ass_layer_of_event(&script, "Bottom overlay"), 0);
    }

    /// A single overlay track is the whole visual stack, so it sits at depth 0
    /// and keeps `Layer: 0` — the value every single-track script has always
    /// carried.
    #[test]
    fn should_keep_a_lone_overlay_track_on_layer_zero() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Only line".to_string());
        track.add_clip(clip);
        sequence.add_track(track);

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert_eq!(ass_layer_of_event(&script, "Only line"), 0);
    }

    /// An audio track draws nothing, so it must not take a position in the
    /// visual stack: the lone caption track is still the whole picture stack.
    #[test]
    fn should_ignore_audio_tracks_when_numbering_overlay_layers() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut caption_track = Track::new_caption("Captions");
        let mut clip = Clip::new("caption-asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.0);
        clip.label = Some("Only line".to_string());
        caption_track.add_clip(clip);
        sequence.add_track(caption_track);
        sequence.add_track(Track::new_audio("Audio 1"));

        let script = build_ass_text_overlay_script(&sequence, &HashMap::new())
            .expect("script result")
            .expect("script exists");

        assert_eq!(ass_layer_of_event(&script, "Only line"), 0);
    }

    /// Feature: Overlay stacking order in the export
    ///   Scenario: the `drawtext` fallback burns two overlapping overlays
    ///     Given a caption on the topmost track and one on the track below it
    ///     When the fallback filter chain is built
    ///     Then the topmost track's `drawtext` is chained last, over the other
    ///
    /// A `drawtext` chain paints in order, so the filter appended last wins the
    /// pixel. Ordering the chain by start time alone left the bottom track on
    /// top, the same inversion the ASS path had.
    #[test]
    fn should_chain_the_topmost_tracks_drawtext_last_when_overlays_overlap() {
        let (sequence, effects) = sequence_with_overlapping_overlays_on_two_tracks(
            TrackKind::Caption,
            TrackKind::Caption,
        );

        let all_clips = collect_enabled_clips_sorted(&sequence);
        let overlays = collect_drawtext_text_overlays(
            &sequence,
            &all_clips,
            &effects,
            &RenderWindow::resolve(sequence.output_duration(), None, None, 30.0),
        )
        .expect("fallback overlays should build");

        let mut filter_complex = String::from("[0:v]null[outv]");
        append_drawtext_text_overlays(&mut filter_complex, "[outv]", &overlays);

        let top = filter_complex
            .find("Top overlay")
            .expect("the topmost track's drawtext should be in the chain");
        let bottom = filter_complex
            .find("Bottom overlay")
            .expect("the lower track's drawtext should be in the chain");

        assert!(
            bottom < top,
            "the topmost track must be painted last. Got: {filter_complex}"
        );
    }

    /// The fallback chain also has to respect track order across overlay kinds:
    /// a caption below a text clip must not paint over it just because captions
    /// used to be appended in a second pass.
    #[test]
    fn should_chain_a_caption_below_a_text_clip_before_it() {
        let (sequence, effects) =
            sequence_with_overlapping_overlays_on_two_tracks(TrackKind::Video, TrackKind::Caption);

        let all_clips = collect_enabled_clips_sorted(&sequence);
        let overlays = collect_drawtext_text_overlays(
            &sequence,
            &all_clips,
            &effects,
            &RenderWindow::resolve(sequence.output_duration(), None, None, 30.0),
        )
        .expect("fallback overlays should build");

        let mut filter_complex = String::from("[0:v]null[outv]");
        append_drawtext_text_overlays(&mut filter_complex, "[outv]", &overlays);

        let top = filter_complex
            .find("Top overlay")
            .expect("the topmost track's drawtext should be in the chain");
        let bottom = filter_complex
            .find("Bottom overlay")
            .expect("the lower track's drawtext should be in the chain");

        assert!(
            bottom < top,
            "the topmost track must be painted last. Got: {filter_complex}"
        );
    }

    #[test]
    fn test_build_filter_uses_ass_subtitles_when_sidecar_is_provided() {
        use crate::core::assets::VideoInfo;
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
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
        let mut caption_clip = Clip::new("caption_asset")
            .with_source_range(0.0, 2.0)
            .place_at(0.25);
        caption_clip.label = Some("Caption".to_string());
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("ass_sidecar_base.mp4");
        let mut video_asset =
            Asset::new_video("ass_sidecar_base.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = HashMap::new();
        assets.insert(video_asset.id.clone(), video_asset);
        let mut audio_info = HashMap::new();
        audio_info.insert(
            "video_asset".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );
        let settings = ExportSettings::default();
        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let ass_path = PathBuf::from("/tmp/openreelio:text,overlay.ass");

        let args = engine
            .build_complex_filter_args_with_audio_info_internal(
                &sequence,
                &assets,
                &HashMap::new(),
                &audio_info,
                &settings,
                Some(&ass_path),
            )
            .expect("filter args");
        let filter = args
            .windows(2)
            .find_map(|pair| (pair[0] == "-filter_complex").then_some(pair[1].as_str()))
            .expect("filter complex");

        assert!(filter.contains("subtitles=filename='/tmp/openreelio\\:text\\,overlay.ass'"));
        assert!(filter.contains("[txtass0]"));
        // Normalization letterboxes into the output size, so the pixel aspect
        // is always 1 and `original_size` would only ever distort the glyphs.
        assert!(
            !filter.contains("original_size"),
            "the subtitles filter must not set a pixel aspect. Got: {filter}"
        );
        assert!(!filter.contains("drawtext="));
    }

    #[test]
    fn test_ass_subtitles_filter_never_sets_a_pixel_aspect() {
        // A vertical sequence exported through a 16:9 preset used to hand
        // libass `original_size=1080x1920` against a 1920x1080 frame, which is
        // a pixel aspect of 3.16 - every glyph came out stretched. The pipeline
        // letterboxes rather than squeezes, so there is no aspect to correct.
        let mut filter_complex = String::from("[0:v]null[outv]");
        let label = append_ass_text_overlay(
            &mut filter_complex,
            "[outv]",
            &PathBuf::from("/tmp/vertical.ass"),
        );

        assert_eq!(label, "[txtass0]");
        assert!(
            !filter_complex.contains("original_size"),
            "got: {filter_complex}"
        );
        assert!(filter_complex.contains("subtitles=filename='/tmp/vertical.ass'"));
    }

    #[test]
    fn test_ass_subtitles_path_single_quote_cannot_break_out_of_filter() {
        // The ASS file lives under a project-derived directory, so a crafted
        // project path can carry a single quote. An unescaped `'` would close the
        // quoted filename and turn the rest of the value into filtergraph syntax
        // (`;[in]movie=...` = arbitrary file read/write). The canonical escaper
        // rewrites every literal quote to `'\''`, keeping the payload inside the
        // quoted region.
        let mut filter_complex = String::from("[0:v]null[outv]");
        let label = append_ass_text_overlay(
            &mut filter_complex,
            "[outv]",
            &PathBuf::from("/tmp/x';[in]movie=filename=/etc/passwd[out];[out].ass"),
        );

        assert_eq!(label, "[txtass0]");
        assert!(
            !filter_complex.contains("x';"),
            "Single quote must not terminate the quoted region: {filter_complex}"
        );
        assert!(
            filter_complex.contains(
                "subtitles=filename='/tmp/x'\\'';[in]movie=filename=/etc/passwd[out];[out].ass'"
            ),
            "Expected close-escape-reopen quoting of the injected value, got: {filter_complex}"
        );
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
    fn test_validation_rejects_asset_marked_missing_offline() {
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

        let video_path = create_temp_media_file("validation_offline_video.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_offline_video.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        video_asset.missing = true;
        assets.insert("video_asset".to_string(), video_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("missing/offline")));
    }

    #[test]
    fn test_validation_warns_hdr_source_to_sdr_without_tonemap() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("hdr_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_hdr_source.mp4");
        let mut assets = HashMap::new();
        let video_info = VideoInfo {
            is_hdr: true,
            color_transfer: Some("smpte2084".to_string()),
            ..Default::default()
        };
        let mut video_asset =
            Asset::new_video("validation_hdr_source.mp4", &video_path, video_info)
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "hdr_asset".to_string();
        assets.insert("hdr_asset".to_string(), video_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            validation.is_valid,
            "HDR-to-SDR QC should warn, not block export. Got: {validation:?}"
        );
        assert!(validation.warnings.iter().any(|warning| {
            warning.contains("HDR source") && warning.contains("gamut/clipping")
        }));
    }

    #[test]
    fn test_validation_allows_hdr_source_to_sdr_with_tonemap_without_warning() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.add_clip(
            Clip::new("hdr_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_hdr_tonemapped_source.mp4");
        let mut assets = HashMap::new();
        let video_info = VideoInfo {
            is_hdr: true,
            color_transfer: Some("smpte2084".to_string()),
            ..Default::default()
        };
        let mut video_asset = Asset::new_video(
            "validation_hdr_tonemapped_source.mp4",
            &video_path,
            video_info,
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "hdr_asset".to_string();
        assets.insert("hdr_asset".to_string(), video_asset);

        let settings = ExportSettings {
            tonemap_mode: Some(TonemapMode::Reinhard),
            ..ExportSettings::default()
        };
        let validation = validate_export_settings(&sequence, &assets, &HashMap::new(), &settings);

        assert!(validation.is_valid);
        assert!(!validation
            .warnings
            .iter()
            .any(|warning| warning.contains("HDR source")));
    }

    #[test]
    fn test_validation_warns_high_audio_gain_for_loudness_qc() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        track.volume = 2.0;
        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.audio.volume_db = 1.0;
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_loudness_video.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_loudness_video.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        video_asset.audio = Some(AudioInfo::default());
        assets.insert("video_asset".to_string(), video_asset);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(validation.is_valid);
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.contains("loudness and clipping")));
    }

    #[test]
    fn test_validation_rejects_missing_clip_effect_reference() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.effects.push("missing_effect".to_string());
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_missing_effect.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_missing_effect.mp4",
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

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("references missing effect")));
    }

    #[test]
    fn test_validation_rejects_unsupported_final_export_effect() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let effect = Effect::new(EffectType::BackgroundRemoval);
        let effect_id = effect.id.clone();
        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.effects.push(effect_id.clone());
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_unsupported_effect.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_unsupported_effect.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(!validation.is_valid);
        assert!(validation.errors.iter().any(|error| {
            error.contains("Background Removal") && error.contains("not supported in final export")
        }));
    }

    #[test]
    fn test_validation_allows_disabled_unsupported_effect() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut effect = Effect::new(EffectType::BackgroundRemoval);
        effect.enabled = false;
        let effect_id = effect.id.clone();
        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.effects.push(effect_id.clone());
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_disabled_unsupported_effect.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_disabled_unsupported_effect.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(
            validation.is_valid,
            "Disabled unsupported effects should not block export. Got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_warns_when_clip_is_not_frame_aligned() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.01),
        );
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_frame_alignment.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_frame_alignment.mp4",
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
            validation.is_valid,
            "Frame alignment warnings should not block compatibility exports"
        );
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.contains("frame boundaries")));
    }

    #[test]
    fn test_validation_rejects_keyframed_effects_for_final_export() {
        use crate::core::assets::VideoInfo;
        use crate::core::effects::Keyframe;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut effect = Effect::new(EffectType::Brightness);
        effect.keyframes.insert(
            "value".to_string(),
            vec![
                Keyframe::new(0.0, ParamValue::Float(0.0)),
                Keyframe::new(1.0, ParamValue::Float(0.5)),
            ],
        );
        let effect_id = effect.id.clone();
        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.effects.push(effect_id.clone());
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_keyframed_effect.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_keyframed_effect.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(!validation.is_valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("Keyframed effect 'Brightness'")));
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
    fn test_validation_warns_caption_text_timing_and_overlap_qc() {
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
        let mut empty_caption = Clip::new("caption_empty")
            .with_source_range(0.0, 0.25)
            .place_at(0.0);
        empty_caption.label = Some("   ".to_string());
        caption_track.add_clip(empty_caption);

        let mut overlapping_caption = Clip::new("caption_overlap")
            .with_source_range(0.0, 1.0)
            .place_at(0.2);
        overlapping_caption.label = Some("Readable caption".to_string());
        caption_track.add_clip(overlapping_caption);
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("validation_caption_qc_video.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_caption_qc_video.mp4",
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

        assert!(validation.is_valid);
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.contains("empty text")));
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.contains("shorter than 0.5 seconds")));
        assert!(validation
            .warnings
            .iter()
            .any(|warning| warning.contains("overlap")));
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

    /// Feature: Blend modes in the final render
    /// Scenario: the validator refuses the modes the render cannot do, and only those
    ///
    /// Both halves matter, and the second one is why this test is written against
    /// `validate_export_settings` rather than against the builder. Every surface
    /// that can start a render — the export job, the preview job and the CLI —
    /// gates on `is_valid`, so a stale refusal here makes a working feature
    /// unreachable no matter what the builder can do. A blanket "blend mode
    /// export is not supported yet" outlived the support for ten of the modes
    /// and kept them blocked everywhere, while the builder-level tests passed.
    #[test]
    fn test_validation_refuses_unsupported_blend_modes_and_admits_supported_ones() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{BlendMode, Clip, SequenceFormat, Track};

        let validate_with = |blend_mode: BlendMode| {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut track = Track::new_video("Video 1");
            let mut clip = Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0);
            clip.id = "blended".to_string();
            clip.blend_mode = blend_mode;
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

            validate_export_settings(
                &sequence,
                &assets,
                &std::collections::HashMap::new(),
                &ExportSettings::default(),
            )
        };

        // A mode the stack reproduces has to pass the gate, or the feature is
        // unreachable however well the builder renders it.
        let supported = validate_with(BlendMode::Multiply);
        assert!(
            !supported
                .errors
                .iter()
                .any(|error| error.to_lowercase().contains("blend")),
            "Multiply renders, so validation must not refuse it. Got: {:?}",
            supported.errors
        );

        // A mode it cannot reproduce is still refused, and still says which clip.
        let refused = validate_with(BlendMode::SoftLight);
        assert!(!refused.is_valid, "Soft Light must still block the export");
        let finding = refused
            .findings
            .iter()
            .find(|finding| finding.message.contains("cannot perform yet"))
            .unwrap_or_else(|| panic!("expected a blend refusal: {:?}", refused.findings));
        assert_eq!(
            finding.clip_id.as_deref(),
            Some("blended"),
            "the refusal must name the clip whose blend mode has to change"
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a moved, translucent clip exports instead of being refused
    ///
    /// The preview has always let a clip be moved and faded. Export used to
    /// reject exactly those clips, so a project that looked finished could not
    /// be rendered at all. The composite path renders them now.
    #[test]
    fn test_validation_accepts_a_clip_the_export_now_composites() {
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
            VideoInfo {
                width: 1280,
                height: 720,
                ..VideoInfo::default()
            },
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
            validation.is_valid,
            "a transformed, translucent clip must export. Got: {:?}",
            validation.errors
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: an unmeasurable source is refused instead of guessed at
    ///
    /// The import placeholder is a non-zero 1920x1080, so a transformed clip
    /// whose file cannot be probed used to be placed as though it were exactly
    /// 1080p — right-looking on 1080p footage, silently stretched on anything
    /// else. Refusing is the only honest answer.
    #[test]
    fn test_validation_refuses_a_transformed_clip_with_no_measurable_source() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.transform.position = Point2D::new(0.25, 0.75);
        track.add_clip(clip);
        sequence.add_track(track);

        // An empty file FFprobe cannot read, carrying the untouched import
        // placeholder as its only stored metadata.
        let video_path = create_temp_media_file("validation_unmeasurable.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_unmeasurable.mp4",
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
                .any(|error| error.contains("Could not determine source dimensions")),
            "an unmeasurable transformed clip must be refused. Got: {:?}",
            validation.errors
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: caller-supplied measurements spare validation its own probes
    #[test]
    fn test_validation_uses_pre_resolved_source_dimensions() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.transform.position = Point2D::new(0.25, 0.75);
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_preresolved.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_preresolved.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let known: SourceDimensionMap = [("video_asset".to_string(), (1080_u32, 1920_u32))]
            .into_iter()
            .collect();

        let validation = validate_export_settings_with_dimensions(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
            Some(&known),
            None,
        );

        assert!(
            validation.is_valid,
            "an already-measured source needs no probe of its own. Got: {:?}",
            validation.errors
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: keyframed motion renders static, and says so
    ///
    /// The preview animates `motion_keyframes` and so, now, does the export —
    /// but only for motion that does not turn the picture. A move that rotates
    /// still composites once, and silently rendering the base transform would
    /// hand back a file that disagrees with what the editor just watched.
    #[test]
    fn test_validation_warns_that_rotating_motion_keyframes_render_static() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track, TransformKeyframe};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.id = "moving-clip".to_string();
        clip.motion_keyframes = vec![
            TransformKeyframe {
                time_offset: 0.0,
                transform: Transform::default(),
                interpolation: Default::default(),
            },
            TransformKeyframe {
                time_offset: 3.0,
                transform: Transform {
                    position: Point2D::new(0.75, 0.5),
                    // The turn is what keeps this clip on the static path:
                    // `rotate` cannot follow a frame that resizes under it.
                    rotation_deg: 30.0,
                    ..Transform::default()
                },
                interpolation: Default::default(),
            },
        ];
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("validation_motion.mp4");
        let mut assets = HashMap::new();
        let mut video_asset =
            Asset::new_video("validation_motion.mp4", &video_path, VideoInfo::default())
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
            validation.is_valid,
            "keyframed motion must not block the export: {:?}",
            validation.errors
        );
        let warning = validation
            .warnings
            .iter()
            .find(|warning| warning.contains("Motion keyframes"))
            .unwrap_or_else(|| {
                panic!(
                    "keyframed motion must be reported: {:?}",
                    validation.warnings
                )
            });
        assert!(
            warning.contains("moving-clip"),
            "the warning must name the clip: {warning}"
        );
        assert!(
            warning.contains("base transform"),
            "the warning must say what happens instead: {warning}"
        );
    }

    /// Feature: Export preflight
    /// Scenario: a degrading clip is reported with somewhere to go
    ///
    /// The export dialog turns each finding into a row the user can click to
    /// land on the offending clip. A warning that carries only prose leaves the
    /// user to hunt for the clip themselves, which is the whole failure mode the
    /// preflight exists to avoid.
    #[test]
    fn test_findings_carry_clip_id_for_motion_keyframe_warning() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track, TransformKeyframe};
        use crate::core::Point2D;

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");

        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.id = "moving-clip".to_string();
        clip.motion_keyframes = vec![
            TransformKeyframe {
                time_offset: 0.0,
                transform: Transform::default(),
                interpolation: Default::default(),
            },
            TransformKeyframe {
                time_offset: 3.0,
                transform: Transform {
                    position: Point2D::new(0.75, 0.5),
                    // Rotating motion is the kind that still degrades.
                    rotation_deg: 30.0,
                    ..Transform::default()
                },
                interpolation: Default::default(),
            },
        ];
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("findings_motion.mp4");
        let mut assets = HashMap::new();
        let mut video_asset =
            Asset::new_video("findings_motion.mp4", &video_path, VideoInfo::default())
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
            validation.is_valid,
            "a degrading clip must not block the export: {:?}",
            validation.errors
        );

        let finding = validation
            .findings
            .iter()
            .find(|finding| finding.message.contains("Motion keyframes"))
            .unwrap_or_else(|| {
                panic!(
                    "keyframed motion must produce a finding: {:?}",
                    validation.findings
                )
            });

        assert_eq!(finding.severity, ExportFindingSeverity::Warning);
        assert_eq!(finding.clip_id.as_deref(), Some("moving-clip"));
        assert_eq!(finding.sequence_id.as_deref(), Some(sequence.id.as_str()));
        assert!(
            validation.warnings.contains(&finding.message),
            "the flat warning list must stay in sync with the findings"
        );
    }

    /// Feature: Export preflight
    /// Scenario: a blocking overlap names the clip that has to move
    #[test]
    fn test_findings_carry_clip_id_for_layered_overlap_error() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut top_track = Track::new_video("Video 1");
        let mut top_clip = Clip::new("asset_top")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        top_clip.id = "base-clip".to_string();
        top_track.add_clip(top_clip);
        sequence.add_track(top_track);

        let mut bottom_track = Track::new_video("Video 2");
        let mut bottom_clip = Clip::new("asset_bottom")
            .with_source_range(0.0, 5.0)
            .place_at(2.0);
        bottom_clip.id = "pip-clip".to_string();
        // Overlapping clips composite now; what is still refused is a blend mode
        // `overlay` cannot perform.
        bottom_clip.blend_mode = BlendMode::SoftLight;
        bottom_track.add_clip(bottom_clip);
        sequence.add_track(bottom_track);

        let top_path = create_temp_media_file("findings_layered_top.mp4");
        let mut top_asset =
            Asset::new_video("findings_layered_top.mp4", &top_path, VideoInfo::default())
                .with_duration(5.0)
                .with_file_size(5_000_000);
        top_asset.id = "asset_top".to_string();

        let bottom_path = create_temp_media_file("findings_layered_bottom.mp4");
        let mut bottom_asset = Asset::new_video(
            "findings_layered_bottom.mp4",
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

        assert!(!validation.is_valid, "layered video must block the export");

        let finding = validation
            .findings
            .iter()
            .find(|finding| finding.message.contains("cannot perform yet"))
            .unwrap_or_else(|| {
                panic!(
                    "layered video must produce a finding: {:?}",
                    validation.findings
                )
            });

        assert_eq!(finding.severity, ExportFindingSeverity::Error);
        assert_eq!(
            finding.clip_id.as_deref(),
            Some("pip-clip"),
            "the finding must name the clip whose blend mode cannot be rendered"
        );
        assert_eq!(finding.sequence_id.as_deref(), Some(sequence.id.as_str()));
        assert!(
            validation.errors.contains(&finding.message),
            "the flat error list must stay in sync with the findings"
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
    fn test_validation_allows_overlay_text_clips_over_base_video() {
        use crate::core::assets::VideoInfo;
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track, TrackKind};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut overlay_track = Track::new("Overlay Text", TrackKind::Overlay);

        let effect_id = "overlay_text_effect".to_string();
        let mut text_clip = Clip::new(&format!("{}overlay", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        text_clip.effects.push(effect_id.clone());
        overlay_track.add_clip(text_clip);
        sequence.add_track(overlay_track);

        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.id = effect_id.clone();
        effect.set_param("text", ParamValue::String("Overlay title".to_string()));

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let video_path = create_temp_media_file("validation_overlay_text_base.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_overlay_text_base.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(
            validation.is_valid,
            "Expected overlay text clips to pass export validation. Got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_allows_video_track_text_layer_over_base_video() {
        use crate::core::assets::VideoInfo;
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut text_track = Track::new_video("Text Layer");
        let effect_id = "title_text_effect".to_string();
        let mut text_clip = Clip::new(&format!("{}title", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        text_clip.effects.push(effect_id.clone());
        text_track.add_clip(text_clip);
        sequence.add_track(text_track);

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.id = effect_id.clone();
        effect.set_param("text", ParamValue::String("Title".to_string()));

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let video_path = create_temp_media_file("validation_video_text_layer_base.mp4");
        let mut assets = HashMap::new();
        let mut video_asset = Asset::new_video(
            "validation_video_text_layer_base.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();
        assets.insert("video_asset".to_string(), video_asset);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(
            validation.is_valid,
            "Expected video-track text layers over video to pass validation. Got: {validation:?}"
        );
    }

    #[test]
    fn test_validation_allows_text_only_overlay_export_with_generated_base() {
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track, TrackKind};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut overlay_track = Track::new("Overlay Text", TrackKind::Overlay);

        let effect_id = "overlay_text_effect".to_string();
        let mut text_clip = Clip::new(&format!("{}overlay", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        text_clip.effects.push(effect_id.clone());
        overlay_track.add_clip(text_clip);
        sequence.add_track(overlay_track);

        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.id = effect_id.clone();
        effect.set_param("text", ParamValue::String("Overlay title".to_string()));

        let mut effects = HashMap::new();
        effects.insert(effect_id, effect);

        let validation = validate_export_settings(
            &sequence,
            &HashMap::new(),
            &effects,
            &ExportSettings::default(),
        );

        assert!(
            validation.is_valid,
            "Expected text-only overlay export to pass validation so export can generate a base. Got: {validation:?}"
        );
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

    /// Feature: Export preflight
    /// Scenario: layered clips are refused only for a blend the stack cannot do
    ///
    /// Overlapping video composites now. `overlay` performs source-over and
    /// nothing else, so a layer asking for any other blend mode would render a
    /// picture the preview never drew, and the export says so instead.
    #[test]
    fn test_validation_rejects_layered_video_clips_with_an_unsupported_blend_mode() {
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
        let mut bottom_clip = Clip::new("asset_bottom")
            .with_source_range(0.0, 5.0)
            .place_at(2.0);
        bottom_clip.blend_mode = BlendMode::SoftLight;
        bottom_track.add_clip(bottom_clip);
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
                .any(|error| error.contains("cannot perform yet")),
            "Expected a blend-mode validation error. Got: {:?}",
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

        let settings = ExportSettings {
            output_path: temp_dir.path().join("exports/final/out.mp4"),
            ..ExportSettings::default()
        };

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
    fn test_export_preset_mp4_draft() {
        let settings =
            ExportSettings::from_preset(ExportPreset::Mp4Draft, PathBuf::from("draft.mp4"));

        assert_eq!(settings.width, Some(1280));
        assert_eq!(settings.height, Some(720));
        assert_eq!(settings.video_bitrate, Some("3M".to_string()));
        assert_eq!(settings.crf, Some(28));
    }

    #[test]
    fn test_export_preset_mp4_high() {
        let settings =
            ExportSettings::from_preset(ExportPreset::Mp4High, PathBuf::from("high.mp4"));

        assert_eq!(settings.width, Some(1920));
        assert_eq!(settings.height, Some(1080));
        assert_eq!(settings.video_bitrate, Some("15M".to_string()));
        assert_eq!(settings.crf, Some(18));
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
    fn test_export_preset_prores_master_preserves_sequence_format() {
        let settings =
            ExportSettings::from_preset(ExportPreset::ProRes, PathBuf::from("master.mov"));

        assert_eq!(settings.video_codec, VideoCodec::ProRes);
        assert_eq!(settings.audio_codec, AudioCodec::Pcm);
        assert_eq!(settings.width, None);
        assert_eq!(settings.height, None);
        assert_eq!(settings.fps, None);
    }

    /// Feature: Structured video export requests
    /// Scenario: should convert legacy YouTube preset to an explicit request
    #[test]
    fn video_export_request_should_convert_legacy_youtube_preset() {
        let preset = ExportPreset::from_legacy_id("youtube_1080p").unwrap();
        let request = ExportSettings::request_from_preset(preset);

        assert_eq!(request.container, ContainerFormat::Mp4);
        assert_eq!(request.video_codec, VideoCodec::H264);
        assert_eq!(request.audio_codec, AudioCodec::Aac);
        assert_eq!(request.quality_tier, ExportQualityTier::Standard);
        assert_eq!(request.width, Some(1920));
        assert_eq!(request.height, Some(1080));
    }

    /// Feature: Structured video export requests
    /// Scenario: should accept project-wide hyphenated preset aliases
    #[test]
    fn video_export_request_should_accept_project_preset_aliases() {
        let aliases = [
            ("youtube-1080p", ExportPreset::Youtube1080p),
            ("mp4-h264-1080p", ExportPreset::Youtube1080p),
            ("mp4-draft", ExportPreset::Mp4Draft),
            ("mp4-high", ExportPreset::Mp4High),
            ("webm-vp9-720p", ExportPreset::WebmVp9),
        ];

        for (alias, expected) in aliases {
            let actual = ExportPreset::from_legacy_id(alias).unwrap();
            assert_eq!(actual, expected, "alias {alias} should map correctly");
        }
    }

    /// Feature: Structured video export requests
    /// Scenario: should reject unknown legacy presets instead of silently defaulting
    #[test]
    fn video_export_request_should_reject_unknown_legacy_preset() {
        let error = ExportPreset::from_legacy_id("unknown_delivery").unwrap_err();

        assert!(
            error.to_string().contains("Unknown export preset"),
            "unexpected error: {error}"
        );
    }

    /// Feature: Structured video export validation
    /// Scenario: should reject incompatible container and codec combinations
    #[test]
    fn video_export_request_should_reject_container_codec_mismatch() {
        let request = VideoExportRequest {
            container: ContainerFormat::Webm,
            video_codec: VideoCodec::ProRes,
            audio_codec: AudioCodec::Opus,
            quality_tier: ExportQualityTier::Master,
            width: Some(1920),
            height: Some(1080),
            fps: Some(30.0),
            video_bitrate: None,
            audio_bitrate: None,
            crf: None,
            two_pass: false,
            hdr_mode: HdrMode::Sdr,
            max_cll: None,
            max_fall: None,
            bit_depth: None,
        };

        let error =
            validate_video_export_request(&request, Path::new("/tmp/master.webm")).unwrap_err();

        assert!(
            error.to_string().contains("does not support video codec"),
            "unexpected error: {error}"
        );
    }

    /// Feature: Structured video export validation
    /// Scenario: should reject output extension mismatches before rendering
    #[test]
    fn video_export_request_should_reject_extension_mismatch() {
        let request = ExportSettings::request_from_preset(ExportPreset::ProRes);

        let error =
            validate_video_export_request(&request, Path::new("/tmp/master.mp4")).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("does not match selected container"),
            "unexpected error: {error}"
        );
    }

    /// Feature: Structured video export validation
    /// Scenario: should accept alternate file extensions for the same container
    #[test]
    fn video_export_request_should_accept_mp4_container_m4v_extension() {
        let request = ExportSettings::request_from_preset(ExportPreset::Youtube1080p);

        validate_video_export_request(&request, Path::new("/tmp/delivery.m4v"))
            .expect("m4v is an MPEG-4 container extension");
    }

    /// Feature: Structured video export validation
    /// Scenario: should reject HDR requests with H.264 before rendering
    #[test]
    fn video_export_request_should_reject_hdr_h264() {
        let request = VideoExportRequest {
            hdr_mode: HdrMode::Hdr10,
            bit_depth: Some(10),
            max_cll: Some(1000),
            max_fall: Some(400),
            ..ExportSettings::request_from_preset(ExportPreset::Youtube1080p)
        };

        let error =
            validate_video_export_request(&request, Path::new("/tmp/delivery.mp4")).unwrap_err();

        assert!(
            error.to_string().contains("HDR export requires H.265"),
            "unexpected error: {error}"
        );
    }

    /// Feature: Structured video export validation
    /// Scenario: should carry valid HDR settings into export settings
    #[test]
    fn video_export_request_should_apply_hdr_settings() {
        let request = VideoExportRequest {
            video_codec: VideoCodec::H265,
            hdr_mode: HdrMode::Hdr10,
            bit_depth: Some(10),
            max_cll: Some(1000),
            max_fall: Some(400),
            ..ExportSettings::request_from_preset(ExportPreset::Youtube1080p)
        };

        let settings = ExportSettings::from_video_request(
            &request,
            PathBuf::from("/tmp/delivery.mp4"),
            None,
            None,
        )
        .expect("HDR H.265 request should be valid");

        assert_eq!(settings.video_codec, VideoCodec::H265);
        assert_eq!(settings.hdr_mode, HdrMode::Hdr10);
        assert_eq!(settings.bit_depth, Some(10));
        assert_eq!(settings.max_cll, Some(1000));
        assert_eq!(settings.max_fall, Some(400));
    }

    /// Feature: WebM VP9 quality export
    /// Scenario: should include VP9 CRF quality args in generated FFmpeg args
    #[test]
    fn webm_vp9_export_should_include_crf_quality_args() {
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let settings =
            ExportSettings::from_preset(ExportPreset::WebmVp9, PathBuf::from("output.webm"));

        let args = engine.build_simple_export_args(Path::new("/tmp/input.webm"), &settings);

        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-crf" && pair[1] == "31"),
            "expected VP9 CRF args, got: {args:?}"
        );
    }

    // -------------------------------------------------------------------------
    // Encoder speed / proxy render
    // -------------------------------------------------------------------------

    fn test_export_engine() -> ExportEngine {
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};

        ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }))
    }

    fn preset_arg_value(args: &[String]) -> Option<&str> {
        args.windows(2)
            .find(|pair| pair[0] == "-preset")
            .map(|pair| pair[1].as_str())
    }

    /// Feature: Encoder speed validation
    /// Scenario: should accept the documented x264/x265 preset ladder
    #[test]
    fn is_valid_encoder_speed_should_accept_known_presets() {
        for value in ENCODER_SPEED_VALUES {
            assert!(
                is_valid_encoder_speed(value),
                "expected '{value}' to be accepted"
            );
        }
        assert!(is_valid_encoder_speed("  UltraFast "));
    }

    /// Feature: Encoder speed validation
    /// Scenario: should reject values FFmpeg would not understand
    #[test]
    fn is_valid_encoder_speed_should_reject_unknown_values() {
        for value in ["", "turbo", "ultra fast", "p4", "0"] {
            assert!(
                !is_valid_encoder_speed(value),
                "expected '{value}' to be rejected"
            );
        }
    }

    /// Feature: Encoder speed validation
    /// Scenario: should surface a validation error for a bogus encoder speed
    #[test]
    fn validate_export_settings_options_should_reject_bogus_encoder_speed() {
        let settings = ExportSettings {
            encoder_speed: Some("turbo".to_string()),
            ..ExportSettings::default()
        };

        let errors = validate_export_settings_options(&settings);

        assert!(
            errors.iter().any(|error| error.contains("turbo")),
            "expected an encoder speed error, got: {errors:?}"
        );
    }

    /// Feature: Encoder speed validation
    /// Scenario: should accept a valid encoder speed without adding errors
    #[test]
    fn validate_export_settings_options_should_accept_valid_encoder_speed() {
        let settings = ExportSettings {
            encoder_speed: Some("ultrafast".to_string()),
            ..ExportSettings::default()
        };

        let errors = validate_export_settings_options(&settings);

        assert!(errors.is_empty(), "expected no errors, got: {errors:?}");
    }

    /// Feature: Proxy render preset
    /// Scenario: should produce 480p, CRF 30, ultrafast settings that follow the sequence fps
    #[test]
    fn proxy_settings_should_use_fast_480p_configuration() {
        let settings = ExportSettings::proxy(
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1920, 1080),
            None,
            None,
        );

        assert_eq!(settings.width, Some(854));
        assert_eq!(settings.height, Some(480));
        assert_eq!(settings.crf, Some(30));
        assert_eq!(settings.video_codec, VideoCodec::H264);
        assert_eq!(settings.audio_codec, AudioCodec::Aac);
        assert_eq!(settings.audio_bitrate.as_deref(), Some("96k"));
        assert_eq!(settings.video_bitrate, None);
        assert_eq!(settings.fps, None);
        assert_eq!(settings.encoder_speed.as_deref(), Some("ultrafast"));
        assert!(!settings.two_pass);
    }

    /// Feature: Proxy render preset
    /// Scenario: should be reachable by the id every surface advertises
    #[test]
    fn from_preset_id_should_serve_the_proxy_profile() {
        // The desktop render commands used to resolve a preset id through
        // `ExportPreset::from_legacy_id` alone, which has no proxy arm — so the
        // preset the CLI documents came back as "Unknown export preset".
        assert!(ExportPreset::from_legacy_id("proxy_480p").is_err());

        for id in ["proxy_480p", "proxy", "Proxy-480p", " PROXY_480P "] {
            let settings = ExportSettings::from_preset_id(
                id,
                PathBuf::from("proxy.mp4"),
                &Canvas::new(1080, 1920),
                Some(2.0),
                Some(5.0),
            )
            .unwrap_or_else(|error| panic!("'{id}' must resolve to the proxy profile: {error}"));

            // Fitted to the sequence rather than to a fixed 854x480 frame: a
            // vertical edit pillarboxed into landscape is useless to look at.
            assert_eq!(settings.width, Some(480), "{id}");
            assert_eq!(settings.height, Some(854), "{id}");
            assert_eq!(settings.crf, Some(30), "{id}");
            assert_eq!(settings.encoder_speed.as_deref(), Some("ultrafast"), "{id}");
            assert_eq!(settings.start_time, Some(2.0), "{id}");
            assert_eq!(settings.end_time, Some(5.0), "{id}");
        }
    }

    /// Feature: Proxy render preset
    /// Scenario: should not change how any other preset resolves
    #[test]
    fn from_preset_id_should_leave_every_other_preset_alone() {
        let settings = ExportSettings::from_preset_id(
            "mp4_draft",
            PathBuf::from("draft.mp4"),
            &Canvas::new(1080, 1920),
            Some(1.0),
            Some(4.0),
        )
        .expect("a fixed-frame preset still resolves");

        let expected =
            ExportSettings::from_preset(ExportPreset::Mp4Draft, PathBuf::from("draft.mp4"));
        assert_eq!(settings.width, expected.width);
        assert_eq!(settings.height, expected.height);
        assert_eq!(settings.crf, expected.crf);
        assert_eq!(settings.encoder_speed, expected.encoder_speed);
        // The range is the one thing a preset id does not carry.
        assert_eq!(settings.start_time, Some(1.0));
        assert_eq!(settings.end_time, Some(4.0));

        assert!(ExportSettings::from_preset_id(
            "not_a_preset",
            PathBuf::from("out.mp4"),
            &Canvas::new(1920, 1080),
            None,
            None,
        )
        .is_err());
    }

    /// Feature: Proxy render preset
    /// Scenario: should follow the sequence aspect instead of pillarboxing it
    #[test]
    fn proxy_settings_should_follow_a_vertical_canvas() {
        let settings = ExportSettings::proxy(
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1080, 1920),
            None,
            None,
        );

        assert_eq!(settings.width, Some(480));
        assert_eq!(settings.height, Some(854));
    }

    /// Feature: Preview render cache profile
    /// Scenario: should render at the sequence canvas and fps with no bitrate cap
    #[test]
    fn preview_cache_settings_should_use_the_sequence_canvas_and_fps() {
        let settings = ExportSettings::preview_cache(
            PathBuf::from("segment_0000.mov"),
            &Canvas::new(1920, 1080),
            Some(0.0),
            Some(5.0),
        );

        // Full sequence resolution: a downscale would move absolute-pixel text,
        // stroke and blur sizes relative to the frame and stop matching export.
        assert_eq!(settings.width, Some(1920));
        assert_eq!(settings.height, Some(1080));
        // Follows the sequence fps rather than pinning 30.
        assert_eq!(settings.fps, None);
        // Lossless: no bitrate cap and no quality knob at all.
        assert_eq!(settings.video_bitrate, None);
        assert_eq!(settings.crf, None);
        assert_eq!(settings.encoder_speed, None);
        assert_eq!(settings.video_codec, VideoCodec::UtVideo);
        assert_eq!(settings.audio_codec, AudioCodec::Aac);
        assert_eq!(settings.audio_bitrate.as_deref(), Some("128k"));
        assert_eq!(settings.hdr_mode, HdrMode::Sdr);
        assert!(!settings.two_pass);
        assert_eq!(settings.start_time, Some(0.0));
        assert_eq!(settings.end_time, Some(5.0));
    }

    /// Feature: Preview render cache profile
    /// Scenario: should be a lossless profile the segment validator accepts
    #[test]
    fn preview_cache_settings_should_be_lossless_and_pass_segment_validation() {
        let settings = ExportSettings::preview_cache(
            PathBuf::from("segment_0000.mov"),
            &Canvas::new(1920, 1080),
            Some(0.0),
            Some(5.0),
        );

        // The codec records the compositor's own planes verbatim: `gbrp` in, no
        // conversion, no subsampling, no quantization. This is the single place
        // the output pixel format is stated, so anything else here silently
        // reintroduces the chroma error the codec was chosen to remove.
        assert_eq!(output_video_pixel_format(&settings), "gbrp");
        assert_eq!(
            super::super::hardware::software_encoder_name(&settings.video_codec),
            "utvideo"
        );

        // `crf: None` is load-bearing rather than cosmetic: the cache fill runs
        // this validator on every segment, and a lossless codec has no CRF
        // range, so a stray CRF would fail every segment render.
        assert!(crf_range_for_codec(&settings.video_codec).is_none());
        assert!(
            validate_export_settings_options(&settings).is_empty(),
            "preview_cache profile rejected: {:?}",
            validate_export_settings_options(&settings)
        );

        // And the .mov extension is what makes that validation pass: the
        // container is inferred from the output path, and MP4 cannot carry
        // this codec.
        let in_mp4 = ExportSettings {
            output_path: PathBuf::from("segment_0000.mp4"),
            ..settings.clone()
        };
        assert!(!validate_export_settings_options(&in_mp4).is_empty());
    }

    /// Feature: Preview render cache profile
    /// Scenario: should retire caches written by the previous H.264 profile
    #[test]
    fn preview_cache_profile_hash_should_differ_from_the_h264_profile() {
        let canvas = Canvas::new(1920, 1080);
        let lossless = ExportSettings::preview_cache(PathBuf::new(), &canvas, None, None);

        // The old profile: same frame, H.264 4:2:0 at CRF 28.
        let legacy = ExportSettings {
            video_codec: VideoCodec::H264,
            crf: Some(28),
            encoder_speed: Some("ultrafast".to_string()),
            ..lossless.clone()
        };

        // The profile hash names the directory segments live in, so a differing
        // hash is what makes every cache written by the old profile
        // unreachable instead of being served at the wrong fidelity.
        assert_ne!(
            super::super::cache::compute_profile_hash(&lossless),
            super::super::cache::compute_profile_hash(&legacy)
        );
    }

    /// Feature: Preview render cache profile
    /// Scenario: should keep a vertical sequence vertical instead of pillarboxing it
    #[test]
    fn preview_cache_settings_should_follow_a_vertical_canvas() {
        let settings = ExportSettings::preview_cache(
            PathBuf::from("segment_0000.mov"),
            &Canvas::new(1080, 1920),
            None,
            None,
        );

        assert_eq!(settings.width, Some(1080));
        assert_eq!(settings.height, Some(1920));
    }

    // -----------------------------------------------------------------------
    // Preview cache fidelity (FFmpeg-backed)
    // -----------------------------------------------------------------------

    const CACHE_FIDELITY_CANVAS: (u32, u32) = (96, 64);
    const CACHE_FIDELITY_FPS: i32 = 10;
    const CACHE_FIDELITY_SEC: f64 = 1.0;

    /// Writes the picture the cache is most likely to damage.
    ///
    /// `testsrc2` is chosen for its hard, fully saturated colour edges and its
    /// smooth ramps: those are exactly the two features 4:2:0 subsampling and
    /// quantization destroy, and the two the agent reading these frames cares
    /// about (text and UI are hard chroma edges). It is written back out as
    /// Ut Video `gbrp` so the fixture itself is lossless and can serve as the
    /// reference the render is compared against.
    fn write_chroma_edge_source(ffmpeg: &std::path::Path, path: &std::path::Path) -> bool {
        let mut build = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut build);
        let built = build
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "testsrc2=size={}x{}:rate={}:duration={}",
                    CACHE_FIDELITY_CANVAS.0,
                    CACHE_FIDELITY_CANVAS.1,
                    CACHE_FIDELITY_FPS,
                    CACHE_FIDELITY_SEC
                ),
                "-c:v",
                "utvideo",
                "-pix_fmt",
                "gbrp",
            ])
            .arg(path)
            .output();

        matches!(built, Ok(built) if built.status.success()) && path.exists()
    }

    /// Decodes a file to raw `gbrp` planes, one `Vec` per frame.
    ///
    /// `gbrp` is the compositor's own working format, so these bytes are the
    /// planes themselves — nothing is converted on the way out and a comparison
    /// of them is a comparison of the pictures.
    fn decode_gbrp_frames(ffmpeg: &std::path::Path, path: &std::path::Path) -> Vec<Vec<u8>> {
        let mut decode = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut decode);
        let decoded = decode
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(path)
            .args(["-pix_fmt", "gbrp", "-f", "rawvideo", "-"])
            .output()
            .expect("decode to gbrp");
        assert!(
            decoded.status.success(),
            "could not decode {}: {}",
            path.display(),
            String::from_utf8_lossy(&decoded.stderr)
        );

        let frame_bytes = 3 * CACHE_FIDELITY_CANVAS.0 as usize * CACHE_FIDELITY_CANVAS.1 as usize;
        decoded
            .stdout
            .chunks_exact(frame_bytes)
            .map(<[u8]>::to_vec)
            .collect()
    }

    /// Renders `sequence` through the real builder with `settings` and returns
    /// the result decoded back to `gbrp`.
    fn render_and_decode_gbrp(
        ffmpeg: &std::path::Path,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        settings: &ExportSettings,
    ) -> Vec<Vec<u8>> {
        let args = build_complex_filter_args_with_audio_info(
            sequence,
            assets,
            &HashMap::new(),
            &HashMap::new(),
            settings,
        )
        .expect("the builder must produce a filtergraph");

        let mut render = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut render);
        let result = render
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .expect("run ffmpeg");
        assert!(
            result.status.success(),
            "ffmpeg refused the builder's graph: {}\n{args:?}",
            String::from_utf8_lossy(&result.stderr)
        );

        decode_gbrp_frames(ffmpeg, &settings.output_path)
    }

    /// The largest per-sample difference between two frame sequences, in 0-255.
    fn max_plane_error(left: &[Vec<u8>], right: &[Vec<u8>]) -> u8 {
        assert!(!left.is_empty(), "no frames to compare");
        assert_eq!(left.len(), right.len(), "frame counts differ");
        left.iter()
            .zip(right.iter())
            .flat_map(|(a, b)| a.iter().zip(b.iter()))
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0)
    }

    /// Feature: Preview render cache fidelity
    /// Scenario: a cached segment decodes back to the composite it was made from
    ///
    /// This is the claim the codec choice rests on, measured rather than
    /// asserted: the cache is read by an agent that judges the frame, so any
    /// error it introduces is error the agent attributes to the edit. The same
    /// picture is put through the profile this replaced to show the measurement
    /// is capable of failing — an all-zero result on a picture no codec could
    /// damage would prove nothing.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary (with `utvideo`).
    /// Run with:
    ///   cargo test -p openreelio --features gui --lib -- --ignored \
    ///     the_preview_cache_is_byte_identical
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn the_preview_cache_is_byte_identical_to_the_composite_it_caches() {
        use crate::core::assets::VideoInfo;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("chroma_edges.mov");
        if !write_chroma_edge_source(&ffmpeg, &source) {
            skip_without_ffmpeg("ffmpeg could not build the chroma-edge fixture");
            return;
        }

        // A single full-frame clip at the canvas size and cadence: the composite
        // is then the source frames themselves, so the source doubles as the
        // reference the cache must reproduce.
        let mut asset = Asset::new_video(
            "edges",
            &source.to_string_lossy(),
            VideoInfo {
                width: CACHE_FIDELITY_CANVAS.0,
                height: CACHE_FIDELITY_CANVAS.1,
                ..VideoInfo::default()
            },
        )
        .with_duration(CACHE_FIDELITY_SEC)
        .with_file_size(1_000_000);
        asset.id = "edges".to_string();
        let mut assets = HashMap::new();
        assets.insert("edges".to_string(), asset);

        let format = SequenceFormat::new(
            CACHE_FIDELITY_CANVAS.0,
            CACHE_FIDELITY_CANVAS.1,
            CACHE_FIDELITY_FPS,
            1,
            48_000,
        );
        let canvas = format.canvas.clone();
        let mut sequence = Sequence::new("Fidelity", format);
        sequence.tracks.clear();
        let mut track = Track::new_video("V1");
        let mut clip = Clip::new("edges")
            .with_source_range(0.0, CACHE_FIDELITY_SEC)
            .place_at(0.0);
        clip.id = "edges0".to_string();
        track.add_clip(clip);
        sequence.add_track(track);

        let reference = decode_gbrp_frames(&ffmpeg, &source);

        // When the segment is rendered through the real preview-cache profile
        let cached = render_and_decode_gbrp(
            &ffmpeg,
            &sequence,
            &assets,
            &ExportSettings::preview_cache(
                dir.path().join("segment_0000.mov"),
                &canvas,
                None,
                None,
            ),
        );

        // Then it decodes back to the composite exactly.
        let lossless_error = max_plane_error(&reference, &cached);
        eprintln!("[preview-cache] utvideo/gbrp max plane error: {lossless_error}/255");
        assert_eq!(
            lossless_error, 0,
            "the preview cache must be a byte-exact record of the composite"
        );

        // And the profile this replaced damages the very same picture, so the
        // zero above is a property of the codec and not of the fixture.
        let legacy = render_and_decode_gbrp(
            &ffmpeg,
            &sequence,
            &assets,
            &ExportSettings {
                output_path: dir.path().join("legacy_0000.mp4"),
                video_codec: VideoCodec::H264,
                crf: Some(28),
                encoder_speed: Some("ultrafast".to_string()),
                ..ExportSettings::preview_cache(PathBuf::new(), &canvas, None, None)
            },
        );
        let lossy_error = max_plane_error(&reference, &legacy);
        eprintln!("[preview-cache] legacy h264/yuv420p max plane error: {lossy_error}/255");
        assert!(
            lossy_error > 0,
            "the fixture cannot detect codec error: H.264 4:2:0 reproduced it exactly"
        );
    }

    /// Feature: Proxy frame fitting
    /// Scenario: should fit any canvas inside the 480p budget without upscaling
    #[test]
    fn proxy_frame_dimensions_should_fit_the_480p_budget() {
        // Landscape 16:9 keeps the classic 480p frame.
        assert_eq!(proxy_frame_dimensions(1920, 1080), (854, 480));
        // Vertical 9:16 is the same frame turned on its side, not a letterbox.
        assert_eq!(proxy_frame_dimensions(1080, 1920), (480, 854));
        // Square fits the short-edge budget on both axes.
        assert_eq!(proxy_frame_dimensions(1080, 1080), (480, 480));
        // 2.39:1 would be 1152 wide at 480 tall, so the long edge binds.
        assert_eq!(proxy_frame_dimensions(1920, 800), (854, 356));
    }

    /// Feature: Proxy frame fitting
    /// Scenario: should never upscale a canvas that already fits
    #[test]
    fn proxy_frame_dimensions_should_not_upscale_a_small_canvas() {
        assert_eq!(proxy_frame_dimensions(640, 360), (640, 360));
        assert_eq!(proxy_frame_dimensions(320, 240), (320, 240));
    }

    /// Feature: Proxy frame fitting
    /// Scenario: should fall back to the 16:9 frame for an unusable canvas
    #[test]
    fn proxy_frame_dimensions_should_tolerate_a_zero_canvas() {
        assert_eq!(proxy_frame_dimensions(0, 1080), (854, 480));
        assert_eq!(proxy_frame_dimensions(1920, 0), (854, 480));
    }

    /// Feature: Proxy render preset
    /// Scenario: should carry the requested partial render range
    #[test]
    fn proxy_settings_should_carry_the_requested_range() {
        let settings = ExportSettings::proxy(
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1920, 1080),
            Some(1.0),
            Some(3.5),
        );

        assert_eq!(settings.start_time, Some(1.0));
        assert_eq!(settings.end_time, Some(3.5));
    }

    /// Feature: Proxy render preset
    /// Scenario: should pass the ultrafast preset through to the FFmpeg arguments
    #[test]
    fn proxy_settings_should_emit_ultrafast_preset_args() {
        let engine = test_export_engine();
        let settings = ExportSettings::proxy(
            PathBuf::from("proxy.mp4"),
            &Canvas::new(1920, 1080),
            None,
            None,
        );

        let args = engine.build_simple_export_args(Path::new("/tmp/input.mp4"), &settings);

        assert_eq!(
            preset_arg_value(&args),
            Some("ultrafast"),
            "expected ultrafast preset args, got: {args:?}"
        );
    }

    /// Feature: Encoder speed argument emission
    /// Scenario: should keep existing output byte-identical when no encoder speed is set
    #[test]
    fn default_settings_should_not_emit_preset_args() {
        let engine = test_export_engine();
        let settings = ExportSettings::default();

        let args = engine.build_simple_export_args(Path::new("/tmp/input.mp4"), &settings);

        assert_eq!(preset_arg_value(&args), None, "unexpected args: {args:?}");
    }

    /// Feature: Encoder speed argument emission
    /// Scenario: should ignore encoder speed for encoders that do not accept the x264 ladder
    #[test]
    fn encoder_speed_args_should_only_apply_to_software_x264_and_x265() {
        let settings = ExportSettings {
            encoder_speed: Some("ultrafast".to_string()),
            ..ExportSettings::default()
        };

        assert_eq!(
            settings.encoder_speed_args("libx264"),
            vec!["-preset".to_string(), "ultrafast".to_string()]
        );
        assert_eq!(
            settings.encoder_speed_args("libx265"),
            vec!["-preset".to_string(), "ultrafast".to_string()]
        );
        assert!(settings.encoder_speed_args("h264_nvenc").is_empty());
        assert!(settings.encoder_speed_args("h264_videotoolbox").is_empty());
        assert!(settings.encoder_speed_args("libvpx-vp9").is_empty());
        assert!(settings.encoder_speed_args("prores_ks").is_empty());
    }

    /// Feature: Encoder speed argument emission
    /// Scenario: should drop an invalid encoder speed rather than hand FFmpeg a bad flag
    #[test]
    fn encoder_speed_args_should_drop_invalid_values() {
        let settings = ExportSettings {
            encoder_speed: Some("turbo".to_string()),
            ..ExportSettings::default()
        };

        assert!(settings.encoder_speed_args("libx264").is_empty());
    }

    /// Feature: Encoder speed argument emission
    /// Scenario: should reach the plan/filter-complex export path used by `render start`
    #[test]
    fn sequence_export_args_should_carry_the_proxy_encoder_speed() {
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

        let video_path = create_temp_media_file("proxy_encoder_speed.mp4");
        let mut video_asset =
            Asset::new_video("proxy_encoder_speed.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let proxy_args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &audio_info_map,
            &ExportSettings::proxy(
                PathBuf::from("proxy.mp4"),
                &Canvas::new(1920, 1080),
                None,
                None,
            ),
        )
        .expect("proxy settings should build export args");

        assert_eq!(
            preset_arg_value(&proxy_args),
            Some("ultrafast"),
            "expected ultrafast preset args, got: {proxy_args:?}"
        );

        let default_args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &audio_info_map,
            &ExportSettings::default(),
        )
        .expect("default settings should build export args");

        assert_eq!(
            preset_arg_value(&default_args),
            None,
            "default settings must not emit -preset, got: {default_args:?}"
        );
    }

    /// Feature: Encoder speed serialization
    /// Scenario: should stay absent from JSON when unset so stored settings are unchanged
    #[test]
    fn encoder_speed_should_be_omitted_from_serialization_when_unset() {
        let settings = ExportSettings::default();

        let json = serde_json::to_string(&settings).unwrap();

        assert!(
            !json.contains("encoderSpeed"),
            "expected encoderSpeed to be omitted, got: {json}"
        );
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
            video_duration_sec: Some(10.0),
            video: Some(VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 30.0,
                codec: "h264".to_string(),
                pixel_format: "yuv420p".to_string(),
                bitrate: Some(8_000_000),
                is_hdr: false,
                color_transfer: None,
                rotation_deg: 0.0,
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
            video_duration_sec: Some(10.0),
            video: Some(VideoStreamInfo {
                width: 1920,
                height: 1080,
                fps: 30.0,
                codec: "h264".to_string(),
                pixel_format: "yuv420p".to_string(),
                bitrate: Some(8_000_000),
                is_hdr: false,
                color_transfer: None,
                rotation_deg: 0.0,
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
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
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
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
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
    fn test_audio_only_filter_builder_accepts_pure_audio_sequences() {
        use crate::core::assets::AudioInfo;
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Audio Only", SequenceFormat::youtube_1080());
        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("audio_asset")
                .with_source_range(0.0, 4.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);

        let audio_path = create_temp_media_file("audio_only_builder.mp3");
        let mut audio_asset =
            Asset::new_audio("audio_only_builder.mp3", &audio_path, AudioInfo::default())
                .with_duration(4.0)
                .with_file_size(1_000_000);
        audio_asset.id = "audio_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert(audio_asset.id.clone(), audio_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "audio_asset".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let settings = AudioExportSettings {
            format: AudioExportFormat::Mp3,
            output_path: PathBuf::from("/tmp/audio-only.mp3"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        }
        .to_export_settings();

        let args = engine
            .build_audio_only_filter_args_with_audio_info(
                &sequence,
                &assets,
                &std::collections::HashMap::new(),
                &audio_info_map,
                &settings,
            )
            .expect("audio-only export args should build");

        let args_str = args.join(" ");
        assert!(args_str.contains("-map [outa_base]") || args_str.contains("-map [outa]"));
        assert!(!args_str.contains("Sequence has no visual clips to export"));
    }

    #[test]
    fn test_audio_only_filter_builder_skips_visual_assets_without_audio() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Audio Mix", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("broken_video")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("voiceover")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);

        let mut broken_video = Asset::new_video(
            "broken_visual.mp4",
            "/missing/broken_visual.mp4",
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        broken_video.id = "broken_video".to_string();
        broken_video.audio = None;

        let voiceover_path = create_temp_media_file("audio_only_voiceover.wav");
        let mut voiceover = Asset::new_audio(
            "audio_only_voiceover.wav",
            &voiceover_path,
            AudioInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(1_000_000);
        voiceover.id = "voiceover".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert(broken_video.id.clone(), broken_video);
        assets.insert(voiceover.id.clone(), voiceover);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "broken_video".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );
        audio_info_map.insert(
            "voiceover".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: PathBuf::from("/tmp/audio-only.wav"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        }
        .to_export_settings();

        let args = engine
            .build_audio_only_filter_args_with_audio_info(
                &sequence,
                &assets,
                &std::collections::HashMap::new(),
                &audio_info_map,
                &settings,
            )
            .expect("visual-only broken assets should not block audio-only export");

        let args_str = args.join(" ");
        assert!(args_str.contains(&voiceover_path));
        assert!(!args_str.contains("/missing/broken_visual.mp4"));
    }

    /// Feature: audio-only export padding
    /// Scenario: the timeline outlives the last clip that carries audio
    #[test]
    fn test_audio_only_filter_builder_pads_to_the_sequence_end() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Audio Tail", SequenceFormat::youtube_1080());

        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("voiceover")
                .with_source_range(0.0, 4.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);

        // Silent picture holds the timeline open to 10s. An export range inside
        // it is valid, so the master audio has to reach that far.
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("silent_video")
                .with_source_range(0.0, 6.0)
                .place_at(4.0),
        );
        sequence.add_track(video_track);

        let voiceover_path = create_temp_media_file("audio_tail_voiceover.wav");
        let mut voiceover = Asset::new_audio(
            "audio_tail_voiceover.wav",
            &voiceover_path,
            AudioInfo::default(),
        )
        .with_duration(4.0)
        .with_file_size(1_000_000);
        voiceover.id = "voiceover".to_string();

        let silent_video_path = create_temp_media_file("audio_tail_silent.mp4");
        let mut silent_video = Asset::new_video(
            "audio_tail_silent.mp4",
            &silent_video_path,
            VideoInfo::default(),
        )
        .with_duration(6.0)
        .with_file_size(5_000_000);
        silent_video.id = "silent_video".to_string();
        silent_video.audio = None;

        let mut assets = std::collections::HashMap::new();
        assets.insert(voiceover.id.clone(), voiceover);
        assets.insert(silent_video.id.clone(), silent_video);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "voiceover".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );
        audio_info_map.insert(
            "silent_video".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: PathBuf::from("/tmp/audio-tail.wav"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        }
        .to_export_settings();

        let args = engine
            .build_audio_only_filter_args_with_audio_info(
                &sequence,
                &assets,
                &std::collections::HashMap::new(),
                &audio_info_map,
                &settings,
            )
            .expect("audio-only export args should build");

        let args_str = args.join(" ");
        assert!(
            args_str.contains("apad=whole_dur=10"),
            "audio must be padded to the sequence end, got: {args_str}"
        );
    }

    /// Builds an audio-only export of a 4s voiceover at 0s plus `tail_track`,
    /// returning the joined arguments so the padding target can be read off.
    fn audio_only_args_with_tail(tail_track: Track, tail_asset: Option<Asset>) -> String {
        use crate::core::assets::AudioInfo;
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use crate::core::timeline::{Clip, SequenceFormat};

        let mut sequence = Sequence::new("Audio Tail", SequenceFormat::youtube_1080());
        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("voiceover")
                .with_source_range(0.0, 4.0)
                .place_at(0.0),
        );
        sequence.add_track(audio_track);
        sequence.add_track(tail_track);

        let voiceover_path = create_temp_media_file("audio_tail_case.wav");
        let mut voiceover =
            Asset::new_audio("audio_tail_case.wav", &voiceover_path, AudioInfo::default())
                .with_duration(4.0)
                .with_file_size(1_000_000);
        voiceover.id = "voiceover".to_string();

        let mut assets = std::collections::HashMap::new();
        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "voiceover".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );
        if let Some(asset) = tail_asset {
            audio_info_map.insert(
                asset.id.clone(),
                AssetAudioInfo {
                    has_audio: true,
                    ..AssetAudioInfo::default()
                },
            );
            assets.insert(asset.id.clone(), asset);
        }
        assets.insert(voiceover.id.clone(), voiceover);

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));
        let settings = AudioExportSettings {
            format: AudioExportFormat::Wav,
            output_path: PathBuf::from("/tmp/audio-tail-case.wav"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        }
        .to_export_settings();

        engine
            .build_audio_only_filter_args_with_audio_info(
                &sequence,
                &assets,
                &std::collections::HashMap::new(),
                &audio_info_map,
                &settings,
            )
            .expect("audio-only export args should build")
            .join(" ")
    }

    /// Feature: audio-only export padding
    /// Scenario: should not pad silence out to a clip the export drops
    ///
    /// Padding to the editing extent produced files far longer than the
    /// program: a disabled tail clip, or one on a muted track, is not in the
    /// output and cannot lengthen it.
    #[test]
    fn test_audio_only_filter_builder_does_not_pad_past_dropped_clips() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::Clip;

        let mut disabled_tail = Track::new_video("Video 1");
        let mut disabled = Clip::new("silent_video")
            .with_source_range(0.0, 6.0)
            .place_at(4.0);
        disabled.enabled = false;
        disabled_tail.add_clip(disabled);

        let mut muted_track_tail = Track::new_audio("Audio 2");
        muted_track_tail.muted = true;
        muted_track_tail.add_clip(
            Clip::new("muted_track_asset")
                .with_source_range(0.0, 6.0)
                .place_at(4.0),
        );

        let silent_video_path = create_temp_media_file("audio_tail_dropped.mp4");
        let mut silent_video = Asset::new_video(
            "audio_tail_dropped.mp4",
            &silent_video_path,
            VideoInfo::default(),
        )
        .with_duration(6.0)
        .with_file_size(5_000_000);
        silent_video.id = "silent_video".to_string();
        silent_video.audio = None;

        for (label, tail, asset) in [
            ("disabled clip", disabled_tail, Some(silent_video)),
            ("clip on a muted track", muted_track_tail, None),
        ] {
            let args_str = audio_only_args_with_tail(tail, asset);
            assert!(
                args_str.contains("apad=whole_dur=4"),
                "a trailing {label} is not in the output, so the pad target stays at the \
                 last clip the export keeps. Got: {args_str}"
            );
        }
    }

    /// Feature: audio-only export padding
    /// Scenario: should pad silence out to an enabled but muted tail clip
    ///
    /// Muting a clip silences it; it still occupies its span, and a range
    /// render inside that span has to receive packets.
    #[test]
    fn test_audio_only_filter_builder_pads_past_a_muted_tail_clip() {
        use crate::core::assets::AudioInfo;
        use crate::core::timeline::Clip;

        let mut tail_track = Track::new_audio("Audio 2");
        let mut muted_clip = Clip::new("muted_clip_asset")
            .with_source_range(0.0, 6.0)
            .place_at(4.0);
        muted_clip.audio.muted = true;
        tail_track.add_clip(muted_clip);

        let muted_path = create_temp_media_file("audio_tail_muted.wav");
        let mut muted_asset =
            Asset::new_audio("audio_tail_muted.wav", &muted_path, AudioInfo::default())
                .with_duration(6.0)
                .with_file_size(1_000_000);
        muted_asset.id = "muted_clip_asset".to_string();

        let args_str = audio_only_args_with_tail(tail_track, Some(muted_asset));

        assert!(
            args_str.contains("apad=whole_dur=10"),
            "a muted clip contributes silence for its span, got: {args_str}"
        );
    }

    /// Feature: audio-only export padding
    /// Scenario: both master-audio branches, and targets that cannot be padded
    #[test]
    fn test_master_audio_output_pads_every_branch_and_rejects_invalid_targets() {
        let mut single = String::from("[0:a]anull[a0]");
        let label = append_master_audio_output(&mut single, &["[a0]".to_string()], 0.0, 12.5)
            .expect("a single stream produces a master output");
        assert_eq!(label, "[outa_base]");
        assert!(single.contains("apad=whole_dur=12.5"), "{single}");

        let mut mixed = String::from("[0:a]anull[a0]");
        append_master_audio_output(
            &mut mixed,
            &["[a0]".to_string(), "[a1]".to_string()],
            0.0,
            12.5,
        )
        .expect("a mix produces a master output");
        assert!(mixed.contains("amix=inputs=2"), "{mixed}");
        assert!(mixed.contains("apad=whole_dur=12.5"), "{mixed}");

        // A target that is zero, negative, or not a number is not a duration
        // FFmpeg can pad to, so no padding is emitted at all.
        for target in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut graph = String::from("[0:a]anull[a0]");
            append_master_audio_output(&mut graph, &["[a0]".to_string()], 0.0, target)
                .expect("a single stream produces a master output");
            assert!(!graph.contains("apad"), "target {target}: {graph}");
        }

        assert!(
            append_master_audio_output(&mut String::new(), &[], 0.0, 5.0).is_none(),
            "no audio streams means no master audio output"
        );
    }

    #[test]
    fn test_build_filter_keeps_audio_from_hidden_video_tracks() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Hidden Video Audio", SequenceFormat::youtube_1080());

        let visible_video_path = create_temp_media_file("visible_video.mp4");
        let hidden_video_path = create_temp_media_file("hidden_video.mp4");

        let mut visible_track = Track::new_video("Visible Video");
        visible_track.add_clip(
            Clip::new("visible_video")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(visible_track);

        let mut hidden_track = Track::new_video("Hidden Video");
        hidden_track.visible = false;
        hidden_track.add_clip(
            Clip::new("hidden_video")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(hidden_track);

        let mut visible_asset = Asset::new_video(
            "visible_video.mp4",
            &visible_video_path,
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        visible_asset.id = "visible_video".to_string();
        visible_asset.audio = None;

        let mut hidden_asset =
            Asset::new_video("hidden_video.mp4", &hidden_video_path, VideoInfo::default())
                .with_duration(5.0)
                .with_file_size(5_000_000);
        hidden_asset.id = "hidden_video".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert(visible_asset.id.clone(), visible_asset);
        assets.insert(hidden_asset.id.clone(), hidden_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "visible_video".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );
        audio_info_map.insert(
            "hidden_video".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &audio_info_map,
            &ExportSettings::default(),
        )
        .expect("hidden video track audio should remain in the export mix");

        let args_str = args.join(" ");
        assert!(args_str.contains(&visible_video_path));
        assert!(args_str.contains(&hidden_video_path));
        assert!(args_str.contains("-map [outa_base]") || args_str.contains("-map [outa]"));
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
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
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
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
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

    /// Feature: Windowed render
    /// Scenario: a caption that ended before the window is not drawn
    ///
    /// `between` is inclusive, so clamping a caption's rebased end to `0.0` would
    /// gate it as `between(t,0,0)` — true on the window's first frame. A caption
    /// that left the screen before the window opened must carry no gate at all.
    /// This is the fast, ffmpeg-free guard for that regression; the byte-exact
    /// `a_windowed_render_is_byte_identical_…` suite proves the pixels too.
    #[test]
    fn a_caption_that_ended_before_a_windowed_render_is_not_drawn() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 8.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut caption_track = Track::new_caption("Captions");
        let mut caption_clip = Clip::new("caption")
            .with_source_range(0.0, 1.0)
            .place_at(1.0);
        caption_clip.label = Some("GONE".to_string());
        caption_track.add_clip(caption_clip);
        sequence.add_track(caption_track);

        let video_path = create_temp_media_file("video_caption_before_window.mp4");
        let mut video_asset = Asset::new_video(
            "video_caption_before_window.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(8.0)
        .with_file_size(8_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let effects = std::collections::HashMap::new();
        // The caption runs 1.0-2.0s; the window opens at 5.0s, long after it left.
        let settings = ExportSettings {
            start_time: Some(5.0),
            end_time: Some(7.0),
            ..ExportSettings::default()
        };

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &settings,
        )
        .expect("the windowed caption fixture must build");
        let args_str = args.join(" ");

        assert!(
            !args_str.contains("between(t,0.000000,0.000000)"),
            "a caption that ended before the window must not be gated always-on: {args_str}"
        );
        assert!(
            !args_str.contains("drawtext"),
            "a caption that ended before the window must not be drawn at all: {args_str}"
        );
    }

    #[test]
    fn test_build_filter_composites_overlay_text_after_video_concat() {
        use crate::core::assets::VideoInfo;
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track, TrackKind};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut overlay_track = Track::new("Overlay Text", TrackKind::Overlay);
        let effect_id = "overlay_text_effect".to_string();
        let mut text_clip = Clip::new(&format!("{}overlay", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 2.0)
            .place_at(0.5);
        text_clip.effects.push(effect_id.clone());
        overlay_track.add_clip(text_clip);
        sequence.add_track(overlay_track);

        let video_path = create_temp_media_file("video_overlay_text.mp4");
        let mut video_asset =
            Asset::new_video("video_overlay_text.mp4", &video_path, VideoInfo::default())
                .with_duration(3.0)
                .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), video_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "video_asset".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.id = effect_id.clone();
        text_effect.set_param("text", ParamValue::String("Overlay title".to_string()));
        text_effect.set_param("x", ParamValue::Float(0.5));
        text_effect.set_param("y", ParamValue::Float(0.2));

        let mut effects = std::collections::HashMap::new();
        effects.insert(effect_id, text_effect);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &ExportSettings::default(),
        )
        .expect("overlay text filter generation should succeed");
        let args_str = args.join(" ");

        assert!(
            args_str.contains("[outv]drawtext="),
            "Expected overlay text to be drawn over the concatenated video output. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("between(t,0.500000,2.500000)"),
            "Expected overlay text time window in drawtext enable expression. Got: {}",
            args_str
        );

        let input_count = args.iter().filter(|arg| arg.as_str() == "-i").count();
        assert_eq!(
            input_count, 1,
            "Overlay text should not add a color-source video segment"
        );

        let first_map_index = args
            .iter()
            .position(|arg| arg.as_str() == "-map")
            .expect("Expected at least one -map argument");
        assert_eq!(
            args.get(first_map_index + 1).map(String::as_str),
            Some("[txtv0]"),
            "Expected video map label to use overlay-text-composited stream"
        );
    }

    #[test]
    fn test_build_filter_composites_video_track_text_after_video_concat() {
        use crate::core::assets::VideoInfo;
        use crate::core::commands::TEXT_ASSET_PREFIX;
        use crate::core::effects::{Effect, EffectType, ParamValue};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());

        let mut text_track = Track::new_video("Text Layer");
        let effect_id = "video_track_text_effect".to_string();
        let mut text_clip = Clip::new(&format!("{}title", TEXT_ASSET_PREFIX))
            .with_source_range(0.0, 2.0)
            .place_at(0.5);
        text_clip.effects.push(effect_id.clone());
        text_track.add_clip(text_clip);
        sequence.add_track(text_track);

        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let video_path = create_temp_media_file("video_track_text_base.mp4");
        let mut video_asset = Asset::new_video(
            "video_track_text_base.mp4",
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
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let mut text_effect = Effect::new(EffectType::TextOverlay);
        text_effect.id = effect_id.clone();
        text_effect.set_param("text", ParamValue::String("Video layer title".to_string()));

        let mut effects = std::collections::HashMap::new();
        effects.insert(effect_id, text_effect);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info_map,
            &ExportSettings::default(),
        )
        .expect("video-track text filter generation should succeed");
        let args_str = args.join(" ");

        assert!(
            args_str.contains("[outv]drawtext="),
            "Expected video-track text to be drawn over the concatenated video output. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("between(t,0.500000,2.500000)"),
            "Expected text layer time window in drawtext enable expression. Got: {}",
            args_str
        );

        let input_count = args.iter().filter(|arg| arg.as_str() == "-i").count();
        assert_eq!(
            input_count, 1,
            "Video-track text overlay should not add a color-source video segment"
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
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
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
        audio_info.insert(
            "asset1".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );
        audio_info.insert(
            "asset2".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );

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
            filter_complex.contains("color=c=black:s=1920x1080:r=30:d=3"),
            "Expected black video filler to preserve the timeline gap. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("[vgap0]"),
            "Expected video gap segment to participate in the video concat chain. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("amix=inputs=2"),
            "Expected audio timeline mix instead of concat. Got: {filter_complex}"
        );
    }

    #[test]
    fn test_build_filter_extends_video_for_trailing_audio_only_timeline() {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut audio_track = Track::new_audio("Audio 1");
        audio_track.add_clip(
            Clip::new("audio_asset")
                .with_source_range(0.0, 4.0)
                .place_at(8.0),
        );
        sequence.add_track(audio_track);

        let video_path = create_temp_media_file("trailing_audio_video.mp4");
        let mut video_asset = Asset::new_video(
            "trailing_audio_video.mp4",
            &video_path,
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_file_size(5_000_000);
        video_asset.id = "video_asset".to_string();

        let audio_path = create_temp_media_file("trailing_audio.wav");
        let mut audio_asset =
            Asset::new_audio("trailing_audio.wav", &audio_path, AudioInfo::default())
                .with_duration(4.0)
                .with_file_size(1_000_000);
        audio_asset.id = "audio_asset".to_string();

        let mut assets = HashMap::new();
        assets.insert(video_asset.id.clone(), video_asset);
        assets.insert(audio_asset.id.clone(), audio_asset);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("trailing audio-only timeline should build");

        let filter_complex = args
            .windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .unwrap();

        assert!(
            filter_complex.contains("adelay=delays=8000:all=1"),
            "Expected trailing audio clip to keep its timeline position. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("color=c=black:s=1920x1080:r=30:d=7"),
            "Expected black video extension from the last visual clip to the audio timeline end. Got: {filter_complex}"
        );
    }

    /// Builds a 1920x1080 sequence with a 5s file-backed clip on `Video 1` and
    /// whatever `tail_track` adds after it, plus the asset that clip needs.
    ///
    /// The tail decides the output length; the assertions below read it off the
    /// black tail gap the filter graph pads with.
    fn sequence_with_video_body_and_tail(
        tail_track: Track,
    ) -> (Sequence, std::collections::HashMap<String, Asset>) {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat};

        let mut sequence = Sequence::new("Tail", SequenceFormat::youtube_1080());
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);
        sequence.add_track(tail_track);

        let video_path = create_temp_media_file("tail_body.mp4");
        let mut video_asset = Asset::new_video("tail_body.mp4", &video_path, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert(video_asset.id.clone(), video_asset);

        (sequence, assets)
    }

    fn filter_complex_of(args: &[String]) -> &str {
        args.windows(2)
            .find_map(|window| (window[0] == "-filter_complex").then_some(window[1].as_str()))
            .expect("filter_complex argument")
    }

    /// A 1080p sequence holding one 720p clip for three seconds.
    ///
    /// The source is deliberately smaller than the canvas so the "fit the source
    /// into the canvas first" half of the placement contract is exercised rather
    /// than cancelling out at 1:1.
    fn sequence_with_one_transformed_clip(
        transform: Transform,
        opacity: f32,
    ) -> (Sequence, std::collections::HashMap<String, Asset>) {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat};

        let mut sequence = Sequence::new("Transform", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let mut clip = Clip::new("video_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        clip.transform = transform;
        clip.opacity = opacity;
        track.add_clip(clip);
        sequence.add_track(track);

        let video_path = create_temp_media_file("transform_source.mp4");
        let mut video_asset = Asset::new_video(
            "transform_source.mp4",
            &video_path,
            VideoInfo {
                width: 1280,
                height: 720,
                ..VideoInfo::default()
            },
        )
        .with_duration(3.0)
        .with_file_size(3_000_000);
        video_asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert(video_asset.id.clone(), video_asset);

        (sequence, assets)
    }

    fn build_transform_filter_complex(transform: Transform, opacity: f32) -> String {
        let (sequence, assets) = sequence_with_one_transformed_clip(transform, opacity);
        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("a transformed clip should build a filtergraph");
        filter_complex_of(&args).to_string()
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a 10-bit export composites at 10 bits
    ///
    /// `overlay` defaults to 8-bit `yuv420`. Leaving it there would mean a clip
    /// quietly lost two bits per channel for no reason other than having been
    /// moved, which is the kind of loss nobody would think to look for.
    #[test]
    fn test_build_filter_keeps_a_ten_bit_export_at_ten_bits() {
        let (sequence, assets) = sequence_with_one_transformed_clip(Transform::default(), 0.5);
        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings {
                bit_depth: Some(10),
                ..ExportSettings::default()
            },
        )
        .expect("a ten-bit transformed clip should build a filtergraph");
        let filter_complex = filter_complex_of(&args);

        assert!(
            filter_complex.contains("format=yuva420p10le,colorchannelmixer=aa=0.5"),
            "the alpha stage must keep the output's bit depth. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("format=yuv444p10,setsar=1,fps=30,trim=end_frame=90,"),
            "the composite must not downconvert the canvas. Got: {filter_complex}"
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a scaled, repositioned clip is composited onto the canvas
    ///
    /// 1280x720 fits a 1920x1080 canvas at 1.5x, halved by the clip scale to
    /// 960x540. Its centre lands at (0.3 * 1920, 0.75 * 1080) = (576, 810), so
    /// the frame's top-left corner is (96, 540).
    #[test]
    fn test_build_filter_composites_a_scaled_and_moved_clip() {
        use crate::core::Point2D;

        let filter_complex = build_transform_filter_complex(
            Transform {
                scale: Point2D::new(0.5, 0.5),
                position: Point2D::new(0.3, 0.75),
                ..Transform::default()
            },
            1.0,
        );

        assert!(
            filter_complex.contains("scale=960:540,setsar=1[vnorm0_tx];"),
            "the clip must be scaled to its transformed size. Got: {filter_complex}"
        );
        assert!(
            filter_complex
                .contains("color=c=black:s=1920x1080:r=30:d=3.033333,format=yuv420p[vnorm0_bg];"),
            "the composite needs a canvas one frame longer than the clip. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains(
                "[vnorm0_bg][vnorm0_tx]overlay=x=96:y=540:format=yuv444,setsar=1,fps=30,trim=end_frame=90,setpts=PTS-STARTPTS,format=yuv420p[vnorm0];"
            ),
            "the clip must be placed at the transformed corner. Got: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("colorchannelmixer"),
            "a fully opaque clip must not pay for an alpha filter. Got: {filter_complex}"
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a faded clip keeps its framing and gains an alpha stage
    #[test]
    fn test_build_filter_renders_clip_opacity() {
        let filter_complex = build_transform_filter_complex(Transform::default(), 0.5);

        assert!(
            filter_complex.contains(
                "scale=1920:1080,setsar=1,format=rgba,colorchannelmixer=aa=0.5[vnorm0_tx];"
            ),
            "a faded clip must be attenuated before compositing. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("overlay=x=0:y=0:format=yuv444,"),
            "an untransformed faded clip still fills the canvas. Got: {filter_complex}"
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a rotated clip gets a box big enough for its own corners
    ///
    /// A 960x540 frame turned a quarter turn sweeps a 540x960 box. Rotating
    /// about the centre anchor leaves the picture centred, so the box's corner
    /// is (960 - 270, 540 - 480).
    #[test]
    fn test_build_filter_rotates_a_clip_into_a_bounding_box() {
        use crate::core::Point2D;

        let filter_complex = build_transform_filter_complex(
            Transform {
                scale: Point2D::new(0.5, 0.5),
                rotation_deg: 90.0,
                ..Transform::default()
            },
            1.0,
        );

        assert!(
            filter_complex.contains(
                "scale=960:540,setsar=1,format=yuva420p,rotate=1.570796:ow=540:oh=960:c=black@0[vnorm0_tx];"
            ),
            "the rotation must be given a box that fits the turned frame. Got: {filter_complex}"
        );
        assert!(
            filter_complex.contains("overlay=x=690:y=60:format=yuv444,"),
            "the rotated frame must stay centred on its anchor. Got: {filter_complex}"
        );
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: an untouched clip keeps the cheaper letterbox graph
    ///
    /// The composite path costs an extra canvas source and an overlay per clip.
    /// Nothing about an identity clip needs either, and the whole existing corpus
    /// of graph-shape tests is written against the fit-and-pad chain.
    #[test]
    fn test_build_filter_leaves_an_identity_clip_on_the_normalization_path() {
        let filter_complex = build_transform_filter_complex(Transform::default(), 1.0);

        assert!(
            filter_complex.contains(
                "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[vnorm0];"
            ),
            "an identity clip must still be fitted and padded. Got: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("overlay="),
            "an identity clip must not be composited. Got: {filter_complex}"
        );
    }

    /// A sequence of one-clip video tracks. The first placement becomes track 0,
    /// which is the topmost track.
    fn sequence_of_layers(
        placements: &[(f64, f64)],
    ) -> (Sequence, std::collections::HashMap<String, Asset>) {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat};

        let mut sequence = Sequence::new("Layers", SequenceFormat::youtube_1080());
        let mut assets = std::collections::HashMap::new();

        for (index, (start_sec, duration_sec)) in placements.iter().enumerate() {
            let asset_id = format!("layer_asset{index}");
            let mut clip = Clip::new(&asset_id)
                .with_source_range(0.0, *duration_sec)
                .place_at(*start_sec);
            clip.id = format!("layer{index}");

            let mut track = Track::new_video(&format!("Video {}", index + 1));
            track.add_clip(clip);
            sequence.add_track(track);

            let path = create_temp_media_file(&format!("layer{index}.mp4"));
            let mut asset = Asset::new_video(
                &format!("layer{index}.mp4"),
                &path,
                VideoInfo {
                    width: 1920,
                    height: 1080,
                    ..VideoInfo::default()
                },
            )
            .with_duration(*duration_sec)
            .with_file_size(3_000_000);
            asset.id = asset_id.clone();
            assets.insert(asset_id, asset);
        }

        (sequence, assets)
    }

    fn layer_filter_complex(placements: &[(f64, f64)]) -> String {
        let (sequence, assets) = sequence_of_layers(placements);
        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("layered clips should build a filtergraph");
        filter_complex_of(&args).to_string()
    }

    /// Feature: Layered video in the final render
    /// Scenario: overlapping clips are composited, not played one after another
    ///
    /// The timeline stitch concatenates whatever it is handed, so two clips
    /// sharing seconds used to be refused outright — the alternative was a render
    /// that played them in turn and finished longer than the timeline. They are
    /// stacked into one picture now.
    #[test]
    fn two_overlapping_clips_are_composited_instead_of_played_in_turn() {
        // Track 0 (the top layer) sits over the second half of track 1.
        let filter_complex = layer_filter_complex(&[(1.0, 3.0), (0.0, 3.0)]);

        assert!(
            filter_complex.contains("format=gbrap"),
            "every layer must be staged with transparency: {filter_complex}"
        );
        assert!(
            filter_complex.contains(":color=black@0"),
            "a layer must letterbox into transparency, not into black: {filter_complex}"
        );
        assert!(
            filter_complex.contains("format=gbrp,setsar=1,trim=end_frame=120,"),
            "the composite needs an opaque black backdrop pinned to the group: \
             {filter_complex}"
        );
        assert!(
            filter_complex.contains(
                "overlay=x=0:y=0:format=auto:alpha=straight:eof_action=pass:repeatlast=0"
            ),
            "the stack must not freeze a layer that ends early: {filter_complex}"
        );
        assert!(
            filter_complex.contains("[vpip0]"),
            "the group must fold into one composited segment: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("concat="),
            "a composite covering the whole timeline leaves nothing to concatenate: \
             {filter_complex}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a timeline whose clips take turns is untouched
    ///
    /// The composite costs a backdrop and an overlay per layer, and every
    /// existing graph-shape test is written against the unfolded chain. A
    /// sequential timeline must come out exactly as it always did.
    #[test]
    fn a_timeline_without_overlap_emits_no_composite_at_all() {
        let filter_complex = layer_filter_complex(&[(0.0, 3.0), (3.0, 3.0)]);

        for absent in ["gbrap", "vpip", "pipbd", "pipk", "color=black@0", "blend="] {
            assert!(
                !filter_complex.contains(absent),
                "clips that take turns must not pay for compositing ({absent}): \
                 {filter_complex}"
            );
        }
        assert!(
            filter_complex.contains("concat="),
            "back-to-back clips are still concatenated: {filter_complex}"
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a blended clip composites even with nothing to overlap
    ///
    /// The preview blends every clip against what it has already drawn, so a
    /// blended clip with nothing beneath it blends against the opaque black
    /// canvas. It therefore becomes a composite of one layer, while the clip
    /// beside it — which asks for nothing — keeps the ordinary graph.
    #[test]
    fn a_blended_clip_composites_while_its_plain_neighbour_does_not() {
        use crate::core::timeline::BlendMode;

        let (mut sequence, assets) = sequence_of_layers(&[(0.0, 3.0), (3.0, 3.0)]);
        sequence.tracks[0].clips[0].blend_mode = BlendMode::Multiply;

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("a blended clip should build a filtergraph");
        let filter_complex = filter_complex_of(&args).to_string();

        assert!(
            filter_complex.contains("blend=all_mode=multiply:repeatlast=0"),
            "the blended clip must be blended: {filter_complex}"
        );
        assert!(
            filter_complex.contains("[vpip0]"),
            "the blended clip must become a composite: {filter_complex}"
        );
        assert_eq!(
            filter_complex.matches("blend=").count(),
            1,
            "only the blended clip pays for a blend: {filter_complex}"
        );
        assert!(
            filter_complex.contains("concat="),
            "the plain neighbour is still concatenated after it: {filter_complex}"
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a real export of a blended clip renders and stays in time
    ///
    /// The string assertions describe the graph; this hands the builder's own
    /// argument list to a real FFmpeg and measures the file. A blended clip
    /// becomes a composite of one layer, so this also covers a composite sitting
    /// next to an ordinary concatenated clip — the arrangement the fold and the
    /// timeline stitch have to agree about.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored exports_a_blended_clip
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_real_export_of_a_blended_clip_renders_and_stays_in_time() {
        use crate::core::assets::VideoInfo;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{BlendMode, Clip, SequenceFormat};

        const CANVAS: (u32, u32) = (64, 64);
        const GREY: (u8, u8, u8) = (128, 128, 128);
        const EXPECTED_FRAMES: usize = 60;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let path = dir.path().join("grey.mp4");
        let mut build = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut build);
        let built = build
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=black:s={}x{}:r=30:d=2.2", CANVAS.0, CANVAS.1),
                "-vf",
                &format!("geq=r={}:g={}:b={}", GREY.0, GREY.1, GREY.2),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&path)
            .output();
        let Ok(built) = built else {
            skip_without_ffmpeg("ffmpeg could not be launched");
            return;
        };
        if !built.status.success() || !path.exists() {
            skip_without_ffmpeg("ffmpeg could not build the fixture");
            return;
        }

        let mut sequence = Sequence::new("Blend", SequenceFormat::youtube_1080());
        sequence.tracks.clear();
        let mut track = Track::new_video("Video 1");
        // Multiply against the black canvas, which the preview draws as black.
        let mut blended = Clip::new("grey_asset")
            .with_source_range(0.0, 1.0)
            .place_at(0.0);
        blended.id = "blended".to_string();
        blended.blend_mode = BlendMode::Multiply;
        track.add_clip(blended);
        // A plain neighbour, so the composite has to sit inside a concat.
        let mut plain = Clip::new("grey_asset")
            .with_source_range(0.0, 1.0)
            .place_at(1.0);
        plain.id = "plain".to_string();
        track.add_clip(plain);
        sequence.add_track(track);

        let mut asset = Asset::new_video(
            "grey_asset",
            &path.to_string_lossy(),
            VideoInfo {
                width: CANVAS.0,
                height: CANVAS.1,
                ..VideoInfo::default()
            },
        )
        .with_duration(2.2)
        .with_file_size(1_000_000);
        asset.id = "grey_asset".to_string();
        let mut assets = HashMap::new();
        assets.insert(asset.id.clone(), asset);

        let mut args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings {
                width: Some(CANVAS.0),
                height: Some(CANVAS.1),
                ..ExportSettings::default()
            },
        )
        .expect("a blended clip must build a filtergraph");

        let output = dir.path().join("render.mp4");
        let last = args.len() - 1;
        args[last] = output.to_string_lossy().to_string();

        let mut render = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut render);
        let result = render
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .expect("run ffmpeg");
        assert!(
            result.status.success(),
            "ffmpeg refused the builder's own blend graph: {}\n{args:?}",
            String::from_utf8_lossy(&result.stderr)
        );

        let mut decode = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut decode);
        let decoded = decode
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(&output)
            .args(["-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .expect("decode the render");
        assert!(decoded.status.success(), "the render must decode");

        let frame_bytes = CANVAS.0 as usize * CANVAS.1 as usize * 3;
        let frames: Vec<&[u8]> = decoded.stdout.chunks_exact(frame_bytes).collect();
        assert_eq!(
            frames.len(),
            EXPECTED_FRAMES,
            "a two-second timeline must render two seconds"
        );

        let centre = |frame: &[u8]| {
            let offset = ((32 * CANVAS.0 + 32) * 3) as usize;
            (frame[offset], frame[offset + 1], frame[offset + 2])
        };
        let near = |got: (u8, u8, u8), want: u8| {
            (i16::from(got.0) - i16::from(want)).abs() < 40
                && (i16::from(got.1) - i16::from(want)).abs() < 40
        };
        assert!(
            near(centre(frames[10]), 0),
            "grey multiplied against the black canvas must render black, got {:?}",
            centre(frames[10])
        );
        assert!(
            near(centre(frames[45]), GREY.0),
            "the plain neighbour must render its own grey, got {:?}",
            centre(frames[45])
        );
    }

    /// Feature: Blend modes in the final render
    /// Scenario: a blend on a clip that also has a transition is refused
    ///
    /// The transition folds its two clips into a single stream before the layers
    /// are stacked, so the blend would apply to the cross-faded pair rather than
    /// to the clip against the backdrop. Rendering that would produce a plausible
    /// picture that is not the one the preview draws, so the export says no.
    #[test]
    fn a_blend_on_a_transitioning_clip_is_refused_by_builder_and_preflight() {
        use crate::core::timeline::BlendMode;

        let (mut sequence, assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("blended-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        // Multiply is a mode the stack *can* perform; what it cannot do is
        // perform it on a clip the transition has already folded away.
        sequence.tracks[0].clips[0].blend_mode = BlendMode::Multiply;

        let error = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect_err("a blend on a transitioning clip must refuse the render");
        assert!(
            format!("{error:?}").contains("clip0")
                && format!("{error:?}").contains("transition and a blend mode"),
            "the refusal must say which clip and why: {error:?}"
        );

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());
        let finding = validation
            .findings
            .iter()
            .find(|finding| finding.message.contains("transition and a blend mode"))
            .unwrap_or_else(|| {
                panic!(
                    "the preflight must refuse it too: {:?}",
                    validation.findings
                )
            });
        assert_eq!(
            finding.clip_id.as_deref(),
            Some("clip0"),
            "the preflight must name the same clip the builder does"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a clip can be in a transition and in a composite at once
    ///
    /// The two folds run in a forced order — transitions first, because their
    /// stitch pairs segments by adjacency after sorting and folding overlaps
    /// first would leave a planned boundary with nothing beside it. What makes
    /// the combination work is that the composite plan pulls *whole* transition
    /// chains into the group it touches: if one side of an `xfade` were staged
    /// opaquely and the other transparently, the opaque one would black out the
    /// layers beneath for its half of the boundary.
    #[test]
    fn a_clip_in_both_a_transition_and_a_composite_renders_as_both() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::Clip;

        let (mut sequence, mut assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("pip-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );

        // A picture-in-picture on a lower track, straddling the blended boundary.
        let mut pip_track = Track::new_video("Video 2");
        let mut pip_clip = Clip::new("pip_asset")
            .with_source_range(0.0, 4.0)
            .place_at(3.0);
        pip_clip.id = "pip-clip".to_string();
        pip_track.add_clip(pip_clip);
        sequence.add_track(pip_track);

        let pip_path = create_temp_media_file("pip_layer.mp4");
        let mut pip_asset = Asset::new_video(
            "pip_layer.mp4",
            &pip_path,
            VideoInfo {
                width: 1920,
                height: 1080,
                ..VideoInfo::default()
            },
        )
        .with_duration(4.0)
        .with_file_size(3_000_000);
        pip_asset.id = "pip_asset".to_string();
        assets.insert(pip_asset.id.clone(), pip_asset);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("a transition inside a composite must still build");
        let filter_complex = filter_complex_of(&args).to_string();

        assert!(
            filter_complex.contains("xfade"),
            "the boundary must still blend: {filter_complex}"
        );
        assert!(
            filter_complex.contains("[vpip0]"),
            "the layers must still composite: {filter_complex}"
        );
        // Both sides of the blend are staged the same way, or the opaque one
        // would black out the PiP for its half of the boundary. One transparent
        // pad each: the two transition sides and the PiP.
        assert_eq!(
            filter_complex.matches(":color=black@0,").count(),
            3,
            "both transition sides and the PiP must all be staged transparently: \
             {filter_complex}"
        );
        // The blended pair is on track 0, so it composites last and lands on top
        // of the picture-in-picture rather than under it.
        assert!(
            filter_complex.contains("[pipbd0][pipL0_0]overlay=")
                && filter_complex.contains("[pipk0_0][vxf0_1]overlay="),
            "the blended pair must be stacked above the lower track: {filter_complex}"
        );
    }

    /// A transition fixture: the sequence and the three maps the builder reads.
    type TransitionFixture = (
        Sequence,
        std::collections::HashMap<String, Asset>,
        std::collections::HashMap<String, Effect>,
        std::collections::HashMap<String, AssetAudioInfo>,
    );

    /// Builds the fixture's transition pair with an extra track above it.
    ///
    /// The added track becomes track 0 — the topmost — and the transition pair
    /// drops to track 1, which is the arrangement both scenarios below need.
    fn transition_pair_under_a_top_layer(
        top_clip: Clip,
        top_duration_sec: f64,
        dissolve_id: &str,
    ) -> TransitionFixture {
        use crate::core::assets::VideoInfo;

        let (mut sequence, mut assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve(dissolve_id))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );

        let asset_id = top_clip.asset_id.clone();
        let mut top_track = Track::new_video("Top");
        top_track.add_clip(top_clip);
        sequence.tracks.insert(0, top_track);

        let path = create_temp_media_file("top_layer.mp4");
        let mut asset = Asset::new_video(
            "top_layer.mp4",
            &path,
            VideoInfo {
                width: 1920,
                height: 1080,
                ..VideoInfo::default()
            },
        )
        .with_duration(top_duration_sec)
        .with_file_size(3_000_000);
        asset.id = asset_id.clone();
        assets.insert(asset_id, asset);

        (sequence, assets, effects, audio_info)
    }

    /// Feature: Layered video in the final render
    /// Scenario: a full-screen clip over a blended boundary still exports
    ///
    /// An earlier draft dropped the layers beneath an opaque, canvas-filling top
    /// layer as an optimisation. Dropping them took the transition planner's own
    /// clips with them, so the boundary it had already planned could never be
    /// folded and the export died on
    /// "Transition on clip 'clip0' was planned but its boundary was never
    /// folded" — an outright failure on a timeline the preflight permits.
    ///
    /// Every layer is composited now, so the covering clip simply covers the
    /// ones beneath through `overlay`, and the boundary underneath still blends.
    #[test]
    fn a_full_screen_clip_over_a_blended_boundary_still_exports() {
        use crate::core::timeline::Clip;

        let mut top_clip = Clip::new("top_asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        top_clip.id = "cover-clip".to_string();

        let (sequence, assets, effects, audio_info) =
            transition_pair_under_a_top_layer(top_clip, 10.0, "covered-dissolve");

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("a full-canvas clip over a transition must not fail the export");
        let filter_complex = filter_complex_of(&args).to_string();

        assert!(
            filter_complex.contains("xfade"),
            "the boundary underneath must still blend: {filter_complex}"
        );
        assert!(
            filter_complex.contains("[vpip0]"),
            "the covering clip and the pair beneath it must composite: {filter_complex}"
        );
        // Three layers staged transparently: the covering clip and both sides of
        // the boundary. None of them is dropped.
        assert_eq!(
            filter_complex.matches(":color=black@0,").count(),
            3,
            "no layer may be discarded: {filter_complex}"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a blend pulled into a composite by a transition is refused
    ///
    /// The composite planner merges whole transition chains into whatever group
    /// they touch, so a clip can join a composite without ever overlapping
    /// anything. A preflight that looked only at overlap runs never examined such
    /// a clip, and its blend mode was silently dropped: the render composited it
    /// as plain source-over and differed from the preview with no diagnostic.
    ///
    /// Here the picture-in-picture overlaps only the *outgoing* clip, and it is
    /// the *incoming* one — reached through the dissolve — that asks for
    /// Multiply.
    #[test]
    fn a_blend_reached_only_through_a_transition_is_still_refused() {
        use crate::core::timeline::{BlendMode, Clip};

        let mut pip_clip = Clip::new("top_asset")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        pip_clip.id = "pip-clip".to_string();

        let (mut sequence, assets, effects, audio_info) =
            transition_pair_under_a_top_layer(pip_clip, 3.0, "reached-dissolve");
        // Track 1 is the transition pair; its second clip starts at 5.0 and so
        // never shares a second with the picture-in-picture above.
        sequence.tracks[1].clips[1].blend_mode = BlendMode::SoftLight;

        let error = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect_err("a blend the stack cannot perform must refuse the render");
        assert!(
            format!("{error:?}").contains("clip1"),
            "the refusal must name the clip whose blend cannot be rendered: {error:?}"
        );

        // The preflight has to refuse exactly what the builder refuses, or the
        // GUI would offer an export that then fails.
        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());
        let finding = validation
            .findings
            .iter()
            .find(|finding| finding.message.contains("cannot perform yet"))
            .unwrap_or_else(|| {
                panic!(
                    "the preflight must refuse it too: {:?}",
                    validation.findings
                )
            });
        assert_eq!(
            finding.clip_id.as_deref(),
            Some("clip1"),
            "the preflight must name the same clip the builder does"
        );
    }

    /// Feature: Layered video in the final render
    /// Scenario: a real export of a picture-in-picture renders and stays in time
    ///
    /// The string assertions above describe the graph the builder writes. This
    /// one hands that graph — the builder's own argument list, unedited but for
    /// the output path — to a real FFmpeg and measures the file that comes out.
    ///
    /// Length is the point. Before compositing, two clips sharing seconds were
    /// concatenated, so a four-second timeline rendered as seven seconds of video
    /// with the layers playing one after the other. That is why the export used
    /// to refuse them outright.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored exports_a_picture_in_picture
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_real_export_of_a_picture_in_picture_renders_and_stays_in_time() {
        use crate::core::assets::VideoInfo;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{Clip, SequenceFormat};
        use crate::core::Point2D;

        const CANVAS: (u32, u32) = (320, 180);
        const BASE: (u8, u8, u8) = (255, 0, 0);
        const PIP: (u8, u8, u8) = (0, 255, 0);
        // The base runs 0-4s, the PiP 1-3s, so the timeline is four seconds.
        const EXPECTED_FRAMES: usize = 120;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");

        let make =
            |name: &str, colour: (u8, u8, u8), duration: f64| -> Option<std::path::PathBuf> {
                let path = dir.path().join(name);
                let mut command = std::process::Command::new(&ffmpeg);
                crate::core::process::configure_std_command(&mut command);
                let built = command
                    .args([
                        "-y",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        &format!(
                            "color=c=black:s={}x{}:r=30:d={duration}",
                            CANVAS.0, CANVAS.1
                        ),
                        "-vf",
                        &format!("geq=r={}:g={}:b={}", colour.0, colour.1, colour.2),
                        "-pix_fmt",
                        "yuv420p",
                    ])
                    .arg(&path)
                    .output()
                    .ok()?;
                (built.status.success() && path.exists()).then_some(path)
            };

        let (Some(base_path), Some(pip_path)) =
            (make("base.mp4", BASE, 4.0), make("pip.mp4", PIP, 2.0))
        else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let mut sequence = Sequence::new("PiP", SequenceFormat::youtube_1080());
        sequence.format.canvas.width = CANVAS.0;
        sequence.format.canvas.height = CANVAS.1;

        // Track 0 is the topmost track: a half-size picture-in-picture, offset
        // from the centre so its rectangle is unmistakable.
        let mut pip_track = Track::new_video("Video 1");
        let mut pip_clip = Clip::new("pip_asset")
            .with_source_range(0.0, 2.0)
            .place_at(1.0);
        pip_clip.id = "pip-clip".to_string();
        pip_clip.transform.scale = Point2D::new(0.5, 0.5);
        pip_clip.transform.position = Point2D::new(0.25, 0.25);
        pip_track.add_clip(pip_clip);
        sequence.add_track(pip_track);

        let mut base_track = Track::new_video("Video 2");
        let mut base_clip = Clip::new("base_asset")
            .with_source_range(0.0, 4.0)
            .place_at(0.0);
        base_clip.id = "base-clip".to_string();
        base_track.add_clip(base_clip);
        sequence.add_track(base_track);

        let mut assets = HashMap::new();
        for (id, path, duration) in [
            ("pip_asset", &pip_path, 2.0),
            ("base_asset", &base_path, 4.0),
        ] {
            let mut asset = Asset::new_video(
                id,
                &path.to_string_lossy(),
                VideoInfo {
                    width: CANVAS.0,
                    height: CANVAS.1,
                    ..VideoInfo::default()
                },
            )
            .with_duration(duration)
            .with_file_size(1_000_000);
            asset.id = id.to_string();
            assets.insert(asset.id.clone(), asset);
        }

        let mut args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings {
                width: Some(CANVAS.0),
                height: Some(CANVAS.1),
                ..ExportSettings::default()
            },
        )
        .expect("a layered sequence must build a filtergraph");

        // The builder's own arguments, unedited but for where the file lands.
        let output = dir.path().join("render.mp4");
        let last = args.len() - 1;
        args[last] = output.to_string_lossy().to_string();

        let mut render = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut render);
        let result = render
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .expect("run ffmpeg");
        assert!(
            result.status.success(),
            "ffmpeg refused the builder's own composite graph: {}\n{args:?}",
            String::from_utf8_lossy(&result.stderr)
        );

        // Decode the render back as raw RGB and measure it.
        let mut decode = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut decode);
        let decoded = decode
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(&output)
            .args(["-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .expect("decode the render");
        assert!(decoded.status.success(), "the render must decode");

        let frame_bytes = CANVAS.0 as usize * CANVAS.1 as usize * 3;
        let frames: Vec<&[u8]> = decoded.stdout.chunks_exact(frame_bytes).collect();
        assert_eq!(
            frames.len(),
            EXPECTED_FRAMES,
            "a four-second timeline must render four seconds; concatenating the layers \
             instead would have produced {} seconds",
            frames.len() as f64 / 30.0
        );

        // Lossy encoding, so the colours are near rather than exact.
        let near = |frame: &[u8], x: u32, y: u32, want: (u8, u8, u8)| -> bool {
            let offset = ((y * CANVAS.0 + x) * 3) as usize;
            let got = (frame[offset], frame[offset + 1], frame[offset + 2]);
            (i16::from(got.0) - i16::from(want.0)).abs() < 40
                && (i16::from(got.1) - i16::from(want.1)).abs() < 40
                && (i16::from(got.2) - i16::from(want.2)).abs() < 40
        };

        // Frame 0: the PiP has not started, so the base layer owns the canvas.
        assert!(
            near(frames[0], 80, 45, BASE) && near(frames[0], 300, 170, BASE),
            "before the PiP starts the base layer must fill the canvas"
        );
        // Frame 45 is inside the PiP's second: its picture is centred on
        // (0.25, 0.25) of the canvas at half size, so (80, 45) is inside it.
        assert!(
            near(frames[45], 80, 45, PIP),
            "the picture-in-picture must be on screen while it plays"
        );
        assert!(
            near(frames[45], 300, 170, BASE),
            "the base layer must still show around the picture-in-picture"
        );
        // Frame 100 is past the PiP: it must have left, not frozen on screen.
        assert!(
            near(frames[100], 80, 45, BASE),
            "the picture-in-picture must leave when it ends, not freeze on screen"
        );
    }

    /// Builds a one-effect graph the dimension walker can be pointed at.
    fn graph_with_effect(effect: Effect) -> FilterGraph {
        let mut graph = FilterGraph::new();
        graph.add_effect(effect);
        graph.sort_by_order();
        graph
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: a crop resizes the picture the transform is measured against
    ///
    /// The transform emits an absolute `scale=W:H`. Measuring it against the
    /// file on disk while the effect chain hands it a cropped frame stretches
    /// the clip by exactly the crop ratio.
    #[test]
    fn test_effective_source_dimensions_follows_a_crop() {
        let mut crop = Effect::new(EffectType::Crop);
        crop.set_param("width", ParamValue::Float(640.0));
        crop.set_param("height", ParamValue::Float(360.0));
        crop.set_param("x", ParamValue::Float(0.0));
        crop.set_param("y", ParamValue::Float(0.0));

        let dimensions = effective_source_dimensions((1920, 1080), &graph_with_effect(crop))
            .expect("a crop's output size is written into the filter");

        assert_eq!(dimensions, (640, 360));
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: a zoom hands the transform the canvas it was told about
    ///
    /// `zoompan` resizes, so the picture reaching the transform is whatever the
    /// zoom's `s` says and not the size of the source — this bites even a clip
    /// whose only "transform" is an opacity change. The graph publishes the
    /// canvas onto the effect, so the measurement and the emitted filter agree.
    #[test]
    fn test_effective_source_dimensions_follows_a_zoom() {
        let mut zoom = Effect::new(EffectType::Zoom);
        zoom.set_param("zoom_type", ParamValue::String("in".to_string()));
        zoom.set_param("duration", ParamValue::Float(2.0));
        zoom.set_param("zoom_factor", ParamValue::Float(1.5));

        let mut graph = FilterGraph::new().with_dimensions(1920, 1080);
        graph.set_fps(30.0);
        graph.add_effect(zoom);

        let dimensions = effective_source_dimensions((3840, 2160), &graph)
            .expect("zoompan states its output size");

        assert_eq!(dimensions, (1920, 1080));
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: a zoom on a graph that was never told its canvas
    ///
    /// FFmpeg's own `zoompan` default is `hd720`, so a chain that says nothing
    /// still resizes to 720p. The measurement has to report that rather than
    /// pretend the picture came through untouched.
    #[test]
    fn test_effective_source_dimensions_follows_a_zoom_without_a_canvas() {
        let dimensions = effective_source_dimensions(
            (3840, 2160),
            &graph_with_effect(Effect::new(EffectType::Zoom)),
        )
        .expect("zoompan states its output size");

        assert_eq!(dimensions, (1280, 720));
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: effects that do not resize leave the measurement alone
    #[test]
    fn test_effective_source_dimensions_ignores_non_resizing_effects() {
        let mut brightness = Effect::new(EffectType::Brightness);
        brightness.set_param("value", ParamValue::Float(0.2));

        let dimensions =
            effective_source_dimensions((1280, 720), &graph_with_effect(brightness)).unwrap();

        assert_eq!(dimensions, (1280, 720));
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: a crop that cannot be measured is refused rather than guessed
    ///
    /// `AutoReframe` without analysis data emits `null`, but a crop whose size
    /// is an expression would be unreadable. Placing the clip anyway would put
    /// it silently in the wrong place and at the wrong size.
    #[test]
    fn test_effective_source_dimensions_refuses_an_unreadable_resize() {
        let unreadable = "crop=iw/2:ih/2:0:0";

        assert!(matches!(
            filter_segment_dimensions(unreadable),
            SegmentDimensions::Unknown
        ));
    }

    /// Feature: Effect-aware transform placement
    /// Scenario: a masked effect composites back at the original size
    ///
    /// `apply_effect_through_mask_group` overlays the corrected picture onto the
    /// untouched one, so the group always outputs what it was handed.
    #[test]
    fn test_effective_source_dimensions_ignores_a_masked_crop() {
        use crate::core::masks::{Mask, MaskShape, RectMask};

        let mut crop = Effect::new(EffectType::Crop);
        crop.set_param("width", ParamValue::Float(640.0));
        crop.set_param("height", ParamValue::Float(360.0));
        crop.masks
            .masks
            .push(Mask::new(MaskShape::Rectangle(RectMask::default())));

        let dimensions =
            effective_source_dimensions((1920, 1080), &graph_with_effect(crop)).unwrap();

        assert_eq!(dimensions, (1920, 1080));
    }

    /// Feature: Source measurement
    /// Scenario: an unprobeable asset with placeholder metadata is unresolvable
    ///
    /// `ImportAssetCommand::new` files unenriched video away as a whole
    /// `VideoInfo::default()`, which is a non-zero 1920x1080. Trusting it would
    /// turn "nobody measured this" into "it is exactly 1080p".
    #[test]
    fn test_resolve_source_dimensions_rejects_the_import_placeholder() {
        use crate::core::assets::VideoInfo;

        let missing_path = std::env::temp_dir().join("openreelio-does-not-exist.mp4");
        let mut asset = Asset::new_video(
            "placeholder.mp4",
            missing_path.to_string_lossy().as_ref(),
            VideoInfo::default(),
        );
        asset.id = "placeholder_asset".to_string();

        let mut cache = SourceDimensionCache::new();
        assert_eq!(resolve_asset_source_dimensions(&asset, &mut cache), None);
    }

    /// Feature: Source measurement
    /// Scenario: enriched metadata still rescues an unprobeable asset
    #[test]
    fn test_resolve_source_dimensions_falls_back_to_measured_metadata() {
        use crate::core::assets::VideoInfo;

        let missing_path = std::env::temp_dir().join("openreelio-does-not-exist.mp4");
        let mut asset = Asset::new_video(
            "measured.mp4",
            missing_path.to_string_lossy().as_ref(),
            VideoInfo {
                width: 1080,
                height: 1920,
                ..VideoInfo::default()
            },
        );
        asset.id = "measured_asset".to_string();

        let mut cache = SourceDimensionCache::new();
        assert_eq!(
            resolve_asset_source_dimensions(&asset, &mut cache),
            Some((1080, 1920))
        );
    }

    /// Feature: Truthful degradation
    /// Scenario: motion that matches the base transform is not worth a warning
    ///
    /// The export composites the clip once at its base transform. Keyframes that
    /// describe exactly that picture change nothing, and warning about them
    /// teaches callers to ignore the warning that matters.
    #[test]
    fn test_motion_warning_only_fires_when_the_keyframes_move_the_clip() {
        use crate::core::timeline::{Clip, KeyframeInterpolation, TransformKeyframe};
        use crate::core::Point2D;

        let base = Transform {
            position: Point2D::new(0.25, 0.5),
            ..Transform::default()
        };
        let keyframe_at = |time_offset: f64, transform: Transform| TransformKeyframe {
            time_offset,
            transform,
            interpolation: KeyframeInterpolation::Linear,
        };

        let mut clip = Clip::new("asset").with_source_range(0.0, 2.0).place_at(0.0);
        clip.transform = base.clone();
        assert!(!clip_motion_differs_from_base_transform(&clip));

        clip.motion_keyframes = vec![keyframe_at(0.0, base.clone())];
        assert!(
            !clip_motion_differs_from_base_transform(&clip),
            "a lone keyframe equal to the base renders exactly as the export already does"
        );

        clip.motion_keyframes = vec![
            keyframe_at(0.0, base.clone()),
            keyframe_at(1.0, base.clone()),
        ];
        assert!(
            !clip_motion_differs_from_base_transform(&clip),
            "keyframes that never differ describe a static clip"
        );

        clip.motion_keyframes = vec![
            keyframe_at(0.0, base.clone()),
            keyframe_at(
                1.0,
                Transform {
                    position: Point2D::new(0.75, 0.5),
                    ..Transform::default()
                },
            ),
        ];
        assert!(
            clip_motion_differs_from_base_transform(&clip),
            "motion the export will not render must be reported"
        );

        clip.motion_keyframes = vec![keyframe_at(0.0, Transform::default())];
        assert!(
            clip_motion_differs_from_base_transform(&clip),
            "a single keyframe that disagrees with the base is still a difference"
        );
    }

    /// Feature: Render output length
    /// Scenario: a tail clip that emits no stream still holds the render open
    ///
    /// An adjustment layer grades the picture below it and contributes no
    /// stream of its own. Before the canonical output duration, the render
    /// stopped at the last file-backed clip and silently dropped the tail.
    #[test]
    fn test_build_filter_covers_a_trailing_adjustment_layer() {
        use crate::core::timeline::Clip;

        let mut tail_track = Track::new_video("Video 2");
        let mut adjustment = Clip::new("adjustment")
            .with_source_range(0.0, 7.0)
            .place_at(5.0);
        adjustment.is_adjustment_layer = true;
        tail_track.add_clip(adjustment);

        let (sequence, assets) = sequence_with_video_body_and_tail(tail_track);
        assert_eq!(sequence.output_duration(), 12.0);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("trailing adjustment layer should build");

        let filter_complex = filter_complex_of(&args);
        assert!(
            filter_complex.contains("color=c=black:s=1920x1080:r=30:d=7"),
            "the render must reach the adjustment layer's out point. Got: {filter_complex}"
        );
    }

    /// Builds a sequence whose second video track is an adjustment layer
    /// carrying one enabled effect of the given type.
    fn sequence_with_adjustment_layer_effect(
        effect_type: EffectType,
    ) -> (
        Sequence,
        std::collections::HashMap<String, Asset>,
        std::collections::HashMap<String, Effect>,
    ) {
        use crate::core::timeline::Clip;

        let effect = Effect::new(effect_type);
        let effect_id = effect.id.clone();

        let mut adjustment_track = Track::new_video("Adjustments");
        let mut adjustment = Clip::new("adjustment")
            .with_source_range(0.0, 3.0)
            .place_at(0.0);
        adjustment.is_adjustment_layer = true;
        adjustment.effects.push(effect_id.clone());
        adjustment_track.add_clip(adjustment);

        let (sequence, assets) = sequence_with_video_body_and_tail(adjustment_track);
        let mut effects = std::collections::HashMap::new();
        effects.insert(effect_id, effect);

        (sequence, assets, effects)
    }

    /// Feature: Adjustment layers
    /// Scenario: an effect that cannot be time-gated is refused by name
    ///
    /// An adjustment layer's effects are gated with `enable='between(t,…)'` so
    /// they apply only over the layer. FFmpeg refuses `enable` on `zoompan`
    /// outright — "Timeline ('enable' option) not supported with filter
    /// 'zoompan'" — and the whole export died on that message, quoting a filter
    /// the editor never chose. Validation now refuses the edit instead.
    #[test]
    fn should_refuse_an_untimeable_effect_on_an_adjustment_layer() {
        let (sequence, assets, effects) = sequence_with_adjustment_layer_effect(EffectType::Zoom);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(!validation.is_valid, "the export must be refused up front");
        let reported = validation.errors.join("; ");
        assert!(
            reported.contains("Zoom") && reported.contains("adjustment layer"),
            "the refusal must name the effect and why: {reported}"
        );
        assert!(
            reported.contains("adjustment"),
            "the refusal must name the clip: {reported}"
        );
    }

    /// Feature: Adjustment layers
    /// Scenario: an opacity is refused by name rather than crashing the render
    ///
    /// `Opacity` emits `format=rgba,colorchannelmixer=aa=…`, and `format` has no
    /// timeline support: the gated graph died on "Timeline ('enable' option) not
    /// supported with filter 'format'", naming a filter the editor never chose.
    #[test]
    fn should_refuse_an_opacity_on_an_adjustment_layer() {
        let (sequence, assets, effects) =
            sequence_with_adjustment_layer_effect(EffectType::Opacity);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(!validation.is_valid, "the export must be refused up front");
        let reported = validation.errors.join("; ");
        assert!(
            reported.contains("Opacity") && reported.contains("adjustment layer"),
            "the refusal must name the effect and why: {reported}"
        );
    }

    /// Feature: Adjustment layers
    /// Scenario: a colour tool that opens with `format=` is refused by name
    ///
    /// `Curves` (its Luma-vs-Sat leg emits `format=yuv444p,geq=…`) and
    /// `HSLQualifier` (`format=rgba,geq=…`) both lead with a `format` conversion
    /// once a curve or a qualifier is set, and `format` has no timeline support,
    /// so the gated graph died on "Timeline ('enable' option) not supported with
    /// filter 'format'" — a path a user reaches from the Color panel. They are
    /// refused up front by name, like `Opacity`, rather than crashing the render.
    #[test]
    fn should_refuse_a_format_leading_colour_effect_on_an_adjustment_layer() {
        for (effect_type, label) in [
            (EffectType::Curves, "Curves"),
            (EffectType::HSLQualifier, "HSL Qualifier"),
        ] {
            let (sequence, assets, effects) =
                sequence_with_adjustment_layer_effect(effect_type.clone());

            let validation =
                validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

            assert!(
                !validation.is_valid,
                "a {effect_type:?} on an adjustment layer must be refused up front"
            );
            let reported = validation.errors.join("; ");
            assert!(
                reported.contains(label) && reported.contains("adjustment layer"),
                "the refusal must name the effect and why: {reported}"
            );
        }
    }

    /// Feature: Adjustment layers
    /// Scenario: an effect the export has no filter for is a no-op, not a crash
    ///
    /// `Levels`, `Glow`, `MotionBlur`, `BlendMode`, `Custom` and every disabled
    /// effect reach the adjustment path as a bare `null`. Gating that produced
    /// `null:enable='between(t,…)'`, which FFmpeg cannot parse, so a layer
    /// carrying one of them failed the whole export.
    #[test]
    fn should_allow_an_effect_with_no_filter_of_its_own_on_an_adjustment_layer() {
        // `Custom` is left out: it is refused a step earlier, by the
        // unsupported-in-export check that applies to any clip.
        for effect_type in [
            EffectType::Levels,
            EffectType::Glow,
            EffectType::MotionBlur,
            EffectType::BlendMode,
        ] {
            let (sequence, assets, effects) =
                sequence_with_adjustment_layer_effect(effect_type.clone());

            let validation =
                validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

            assert!(
                validation.is_valid,
                "a {effect_type:?} renders as a no-op and must not be refused: {:?}",
                validation.errors
            );
        }
    }

    /// Feature: Adjustment layers
    /// Scenario: an effect that can be time-gated is still allowed
    #[test]
    fn should_allow_a_timeable_effect_on_an_adjustment_layer() {
        let (sequence, assets, effects) =
            sequence_with_adjustment_layer_effect(EffectType::Brightness);

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(
            validation.is_valid,
            "a colour grade is exactly what an adjustment layer is for: {:?}",
            validation.errors
        );
    }

    /// Feature: Adjustment layers
    /// Scenario: FFmpeg really does refuse the graph the refusal replaces
    ///
    /// The refusal above is only worth having if the alternative is a failed
    /// render. This hands the real FFmpeg the gated graph the adjustment path
    /// would otherwise emit for each effect the table calls untimeable, and
    /// asserts FFmpeg rejects it *for that reason* — and that a gated colour
    /// grade in the same shape still renders, so the assertion discriminates.
    ///
    /// `Subtitle`, `Stabilize` and the `xfade` transitions are in the table too
    /// but are not checkable this way: they fail on a missing file, a missing
    /// build option or a missing second input before FFmpeg gets as far as the
    /// timeline check. They were measured by hand against ffmpeg 9.0.1 with
    /// valid arguments and all three refuse `enable`.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored adjustment
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn ffmpeg_refuses_a_time_gated_effect_on_an_adjustment_layer() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        let graph_of = |effect: Effect| {
            let mut graph = FilterGraph::new().with_dimensions(320, 180);
            graph.set_fps(30.0);
            graph.add_effect(effect);
            graph
        };
        let gated =
            |effect: Effect| graph_of(effect).to_video_filter_complex_timed("0:v", "out", 0.0, 1.0);
        let ungated = |effect: Effect| graph_of(effect).to_video_filter_complex("0:v", "out");

        let translucent = || {
            let mut effect = Effect::new(EffectType::Opacity);
            effect.set_param("value", ParamValue::Float(0.5));
            effect
        };

        let run = |filtergraph: &str| {
            let mut cmd = std::process::Command::new(&ffmpeg);
            crate::core::process::configure_std_command(&mut cmd);
            cmd.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x180:r=30:d=0.2",
                "-filter_complex",
                filtergraph,
                "-map",
                "[out]",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .output()
        };

        for effect in [
            Effect::new(EffectType::Zoom),
            Effect::new(EffectType::Crop),
            translucent(),
        ] {
            let effect_type = effect.effect_type.clone();
            assert!(
                !effect_type_supports_timeline_enable(&effect_type),
                "{effect_type:?} is claimed to be untimeable"
            );

            let Ok(refused) = run(&gated(effect)) else {
                skip_without_ffmpeg("ffmpeg could not be launched");
                return;
            };
            let stderr = String::from_utf8_lossy(&refused.stderr);
            assert!(
                !refused.status.success() && stderr.contains("not supported with filter"),
                "a time-gated {effect_type:?} must be refused by ffmpeg for its lack of \
                 timeline support, got: {stderr}"
            );
        }

        let allowed = run(&gated(Effect::new(EffectType::Brightness))).expect("run ffmpeg");
        assert!(
            allowed.status.success(),
            "a time-gated colour grade must still render: {}",
            String::from_utf8_lossy(&allowed.stderr)
        );

        // Every effect the export has no filter body for — and every disabled
        // one — reaches the adjustment path as a `null`. Decorating that with
        // `enable=` produced `null:enable='between(t,…)'`, which FFmpeg cannot
        // even parse ("No option name near 'between(…)'"), so a layer carrying
        // one of these killed the whole render. They have to render as the
        // no-ops they are.
        let mut disabled_grade = Effect::new(EffectType::Brightness);
        disabled_grade.enabled = false;
        for effect in [
            Effect::new(EffectType::Levels),
            Effect::new(EffectType::Glow),
            Effect::new(EffectType::MotionBlur),
            Effect::new(EffectType::BlendMode),
            Effect::new(EffectType::Custom("nonesuch".to_string())),
            disabled_grade,
        ] {
            let effect_type = effect.effect_type.clone();
            let graph = gated(effect);
            assert!(
                !graph.contains("enable="),
                "a no-op {effect_type:?} must not be gated at all: {graph}"
            );

            let rendered = run(&graph).expect("run ffmpeg");
            assert!(
                rendered.status.success(),
                "a {effect_type:?} on an adjustment layer must render as a no-op: {}",
                String::from_utf8_lossy(&rendered.stderr)
            );
        }

        // The same effects on an ordinary clip are untouched by all of this: an
        // opacity still composites and a bodiless effect still passes through.
        for effect in [translucent(), Effect::new(EffectType::Levels)] {
            let effect_type = effect.effect_type.clone();
            let rendered = run(&ungated(effect)).expect("run ffmpeg");
            assert!(
                rendered.status.success(),
                "an ungated {effect_type:?} must still render: {}",
                String::from_utf8_lossy(&rendered.stderr)
            );
        }
    }

    /// Feature: Render output length
    /// Scenario: a clip on a hidden video track still holds the render open
    #[test]
    fn test_build_filter_covers_a_trailing_clip_on_a_hidden_track() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::Clip;

        let mut tail_track = Track::new_video("Video 2");
        tail_track.visible = false;
        tail_track.add_clip(
            Clip::new("hidden_asset")
                .with_source_range(0.0, 7.0)
                .place_at(5.0),
        );

        let (sequence, mut assets) = sequence_with_video_body_and_tail(tail_track);

        let hidden_path = create_temp_media_file("tail_hidden.mp4");
        let mut hidden_asset =
            Asset::new_video("tail_hidden.mp4", &hidden_path, VideoInfo::default())
                .with_duration(7.0)
                .with_file_size(5_000_000);
        hidden_asset.id = "hidden_asset".to_string();
        hidden_asset.audio = None;
        assets.insert(hidden_asset.id.clone(), hidden_asset);

        let mut audio_info_map = std::collections::HashMap::new();
        audio_info_map.insert(
            "hidden_asset".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
        );

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &audio_info_map,
            &ExportSettings::default(),
        )
        .expect("trailing hidden clip should build");

        let filter_complex = filter_complex_of(&args);
        assert!(
            filter_complex.contains("color=c=black:s=1920x1080:r=30:d=7"),
            "a hidden track contributes no picture but still occupies the timeline. \
             Got: {filter_complex}"
        );
    }

    /// Feature: Render output length
    /// Scenario: a disabled tail clip is not in the output and must not extend it
    ///
    /// This is the render half of the duration agreement: padding black out to
    /// a clip the export drops would make the file longer than the program.
    #[test]
    fn test_build_filter_stops_at_the_last_enabled_clip() {
        use crate::core::timeline::Clip;

        let mut tail_track = Track::new_video("Video 2");
        let mut disabled = Clip::new("disabled_asset")
            .with_source_range(0.0, 7.0)
            .place_at(5.0);
        disabled.enabled = false;
        tail_track.add_clip(disabled);

        let (sequence, assets) = sequence_with_video_body_and_tail(tail_track);
        assert_eq!(
            sequence.duration(),
            12.0,
            "the editing extent still shows it"
        );
        assert_eq!(sequence.output_duration(), 5.0);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("disabled tail clip should build");

        let filter_complex = filter_complex_of(&args);
        assert!(
            !filter_complex.contains("color=c=black"),
            "a disabled clip must not pad the render with black. Got: {filter_complex}"
        );
    }

    #[test]
    fn test_validation_does_not_warn_for_supported_timeline_gaps() {
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

        let path1 = create_temp_media_file("gap_validation_1.mp4");
        let mut asset1 = Asset::new_video("gap_validation_1.mp4", &path1, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        asset1.id = "asset1".to_string();
        asset1.audio = Some(AudioInfo::default());

        let path2 = create_temp_media_file("gap_validation_2.mp4");
        let mut asset2 = Asset::new_video("gap_validation_2.mp4", &path2, VideoInfo::default())
            .with_duration(5.0)
            .with_file_size(5_000_000);
        asset2.id = "asset2".to_string();
        asset2.audio = Some(AudioInfo::default());

        let mut assets = HashMap::new();
        assets.insert(asset1.id.clone(), asset1);
        assets.insert(asset2.id.clone(), asset2);

        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );

        assert!(
            !validation
                .warnings
                .iter()
                .any(|warning| warning.contains("does not preserve gaps")),
            "Timeline gaps are now represented by video filler segments. Got warnings: {:?}",
            validation.warnings
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
        audio_info.insert(
            "asset1".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );

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
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
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
            "fontWeight": 700,
            "alignment": "left",
            "color": { "r": 255, "g": 0, "b": 0, "a": 128 },
            "backgroundColor": "#00000080",
            "backgroundPadding": 18,
            "outlineColor": "#000000",
            "outlineWidth": 3,
            "shadowColor": "#112233",
            "shadowOffsetX": 4,
            "shadowOffsetY": 6,
            "lineHeight": 1.5
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
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
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
        // A preset margin is a gap to the block's bottom edge, so the block
        // sits entirely above the 95% line rather than straddling it - the same
        // placement the ASS event margins and the preview produce.
        assert!(
            args_str.contains("y=(h*0.9500)-text_h"),
            "Expected the bottom preset to anchor the block's bottom edge on the margin. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("x=(w*0.1000)"),
            "Expected left alignment to anchor on the 10% left margin, matching the preview. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("font='Arial\\:style=Bold'") || args_str.contains("style=Bold"),
            "Expected numeric font weight to request bold font style. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("boxborderw=18"),
            "Expected caption background padding to map to boxborderw. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("shadowx=4") && args_str.contains("shadowy=6"),
            "Expected caption shadow offsets to map independently. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("line_spacing=32"),
            "Expected caption line height to map to drawtext line spacing. Got: {}",
            args_str
        );
    }

    #[test]
    fn test_font_weight_implies_bold_accepts_numeric_strings() {
        assert_eq!(
            font_weight_implies_bold(&serde_json::json!("600")),
            Some(true)
        );
        assert_eq!(
            font_weight_implies_bold(&serde_json::json!("700.0")),
            Some(true)
        );
        assert_eq!(
            font_weight_implies_bold(&serde_json::json!("500")),
            Some(false)
        );
        assert_eq!(
            font_weight_implies_bold(&serde_json::json!(700)),
            Some(true)
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
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
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
        audio_info_map.insert(
            "with_audio".to_string(),
            AssetAudioInfo {
                has_audio: true,
                ..AssetAudioInfo::default()
            },
        );
        audio_info_map.insert(
            "without_audio".to_string(),
            AssetAudioInfo {
                has_audio: false,
                ..AssetAudioInfo::default()
            },
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
    // Transition Export Tests
    //
    // A two-input transition (`xfade`) is rendered by extending both clips into
    // unused source media — handles — so the blend costs no timeline time and
    // the file stays exactly `Sequence::output_duration()` long. These tests pin
    // the two halves of that: the exact filtergraph an eligible boundary emits,
    // and the named warning an ineligible one degrades to.
    //
    // Offsets below are hand-computed in frames at the fixture's 30fps and
    // written out, because an offset derived by the same arithmetic the code
    // uses would assert nothing.
    // -------------------------------------------------------------------------

    /// Handle length the transition fixtures leave on either side of each clip.
    const FIXTURE_HANDLE_SEC: f64 = 1.0;

    /// One clip in a transition fixture.
    struct TransitionClipSpec {
        /// Length of the clip's slot on the timeline.
        duration_sec: f64,
        /// Effect the clip carries, if any.
        effect: Option<Effect>,
        /// Unused source media either side of the clip's range.
        handle_sec: f64,
        /// Playback speed; the source range is scaled to keep the slot.
        speed: f32,
    }

    impl TransitionClipSpec {
        fn new(duration_sec: f64, effect: Option<Effect>) -> Self {
            Self {
                duration_sec,
                effect,
                handle_sec: FIXTURE_HANDLE_SEC,
                speed: 1.0,
            }
        }

        /// A clip whose source is fully consumed, so it has no handle to give.
        fn without_handles(mut self) -> Self {
            self.handle_sec = 0.0;
            self
        }

        fn at_speed(mut self, speed: f32) -> Self {
            self.speed = speed;
            self
        }
    }

    /// Builds a single-video-track sequence of back-to-back clips and returns
    /// the assets/effects/audio maps needed to render it.
    ///
    /// Every clip's range sits `handle_sec` into an asset that runs
    /// `handle_sec` past it, so a transition has real unused media to reach
    /// into — which is what makes the blend observable at all. `with_audio`
    /// gives every asset an audio stream, which is what makes the audio half of
    /// the stitch observable.
    #[allow(clippy::type_complexity)]
    fn build_transition_fixture(
        clips: &[TransitionClipSpec],
        with_audio: bool,
    ) -> (
        Sequence,
        std::collections::HashMap<String, Asset>,
        std::collections::HashMap<String, Effect>,
        std::collections::HashMap<String, AssetAudioInfo>,
    ) {
        use crate::core::assets::{AudioInfo, VideoInfo};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let mut assets = std::collections::HashMap::new();
        let mut effects = std::collections::HashMap::new();
        let mut audio_info = std::collections::HashMap::new();
        let mut timeline_start = 0.0_f64;

        for (index, spec) in clips.iter().enumerate() {
            let asset_id = format!("asset{index}");
            let source_length = spec.duration_sec * spec.speed as f64;
            // A clip playing fast eats more source per second of handle, so the
            // fixture's handle is stated in timeline seconds and converted here
            // — otherwise a 2x clip would silently have half the handle.
            let source_handle = spec.handle_sec * spec.speed as f64;
            let source_in = source_handle;
            let source_out = source_in + source_length;
            let asset_duration = source_out + source_handle;

            let mut clip = Clip::new(&asset_id)
                .with_source_range(source_in, source_out)
                .place_at(timeline_start);
            clip.speed = spec.speed;
            clip.place.duration_sec = spec.duration_sec;
            clip.id = format!("clip{index}");

            if let Some(effect) = &spec.effect {
                clip.effects.push(effect.id.clone());
                effects.insert(effect.id.clone(), effect.clone());
            }

            track.add_clip(clip);

            let path = create_temp_media_file(&format!("video{index}.mp4"));
            // An explicit size rather than `VideoInfo::default()`: the default is
            // the "nobody measured this" placeholder the transform path refuses
            // to place a clip with.
            let video_info = VideoInfo {
                width: 1280,
                height: 720,
                ..VideoInfo::default()
            };
            let mut asset = Asset::new_video(&format!("video{index}.mp4"), &path, video_info)
                .with_duration(asset_duration)
                .with_file_size(10_000_000);
            asset.id = asset_id.clone();
            if with_audio {
                asset = asset.with_audio_info(AudioInfo::default());
            }
            assets.insert(asset_id.clone(), asset);
            audio_info.insert(
                asset_id,
                AssetAudioInfo {
                    has_audio: with_audio,
                    source_duration_sec: Some(asset_duration),
                    ..AssetAudioInfo::default()
                },
            );

            timeline_start += spec.duration_sec;
        }

        sequence.add_track(track);
        (sequence, assets, effects, audio_info)
    }

    /// Builds an enabled effect with the given parameters.
    fn transition_effect(
        id: &str,
        effect_type: crate::core::effects::EffectType,
        params: &[(&str, crate::core::effects::ParamValue)],
    ) -> Effect {
        let mut effect = Effect::new(effect_type);
        effect.id = id.to_string();
        for (key, value) in params {
            effect.params.insert((*key).to_string(), value.clone());
        }
        effect.enabled = true;
        effect
    }

    /// A one-second cross dissolve.
    fn one_second_dissolve(id: &str) -> Effect {
        use crate::core::effects::{EffectType, ParamValue};

        transition_effect(
            id,
            EffectType::CrossDissolve,
            &[("duration", ParamValue::Float(1.0))],
        )
    }

    fn build_fixture_args(clips: &[TransitionClipSpec], with_audio: bool) -> Vec<String> {
        let (sequence, assets, effects, audio_info) = build_transition_fixture(clips, with_audio);

        build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build")
    }

    /// Counts the `concat=n=2:v=1:a=0` clauses that stitch the video timeline.
    fn video_concat_count(args: &[String]) -> usize {
        args.join(" ").matches("concat=n=2:v=1:a=0").count()
    }

    #[test]
    fn a_two_input_transition_with_handles_is_stitched_as_an_xfade() {
        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let joined = args.join(" ");

        // The outgoing clip's stream is its 5s slot plus a 0.5s tail handle:
        // 165 frames at 30fps. `xfade` eats 30, so 135 frames play untouched
        // first and the blend starts on frame 135 — 4.5s, which puts it half a
        // transition either side of the 5s cut.
        assert!(
            joined.contains("xfade=transition=fade:duration=1.0000:offset=4.5000"),
            "an eligible dissolve must blend at the frame the handles put it on: {joined}"
        );
        // Both clips fold into one segment covering the whole timeline, so
        // nothing is left to concatenate.
        assert_eq!(
            video_concat_count(&args),
            0,
            "a blended boundary replaces the concat that used to cut it: {joined}"
        );
        // The handles come out of source media, not out of the timeline.
        assert!(
            joined.contains("trim=start=1:end=6.5"),
            "the outgoing clip must reach 0.5s past its out point: {joined}"
        );
        assert!(
            joined.contains("trim=start=0.5:end=6"),
            "the incoming clip must start 0.5s before its in point: {joined}"
        );
        // Both sides are pinned to the frame count the offset was derived from.
        assert!(
            joined.contains("trim=end_frame=165"),
            "a segment feeding an xfade must be exactly as long as planned: {joined}"
        );
    }

    #[test]
    fn a_transition_on_a_muted_video_track_is_left_out_instead_of_failing_the_export() {
        use crate::core::timeline::{Clip, Track};

        // Muting a video track drops it from the render, so its clips never
        // become segments. The planner used to plan the transition anyway, and
        // the stitch then found a plan entry it could not fold and refused the
        // entire export - a muted track took the whole file down with it.
        let (mut sequence, assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("muted-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        sequence.tracks[0].muted = true;

        // Something has to survive the mute, or the export would have nothing
        // to render for reasons that have nothing to do with the transition.
        let mut audible = Track::new_video("Video 2");
        let mut clip = Clip::new("asset0")
            .with_source_range(0.0, 5.0)
            .place_at(0.0);
        clip.id = "kept-clip".to_string();
        audible.add_clip(clip);
        sequence.add_track(audible);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("a transition on a muted track must not fail the export");
        let joined = args.join(" ");

        assert!(
            !joined.contains("xfade"),
            "a muted track's transition must be absent from the graph: {joined}"
        );
    }

    #[test]
    fn an_audio_only_export_hears_the_same_crossfades_the_video_export_shows() {
        use crate::core::effects::{EffectType, ParamValue};
        use crate::core::ffmpeg::{FFmpegInfo, FFmpegRunner};
        use std::path::PathBuf;

        // Every transition length is quantised to whole *output* frames. An
        // export that overrides the frame rate therefore gets a different
        // number of frames — and so a different crossfade length — and the
        // audio-only path used to quantise against the sequence's own rate
        // instead, producing an audio render that did not match its picture.
        //
        // 0.4s at the sequence's 30fps is 12 frames = 0.4000s. At the 24fps
        // override it is round(9.6) = 10 frames = 0.4167s. Only the second is
        // what the video path will render. The outgoing branch is its 5s slot
        // plus a 5-frame tail (0.2083s), so its fade-out starts at
        // 5.2083 - 0.4167 = 4.7917s.
        let dissolve = transition_effect(
            "transition-fps",
            EffectType::CrossDissolve,
            &[("duration", ParamValue::Float(0.4))],
        );

        let (sequence, assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(dissolve)),
                TransitionClipSpec::new(5.0, None),
            ],
            true,
        );

        let engine = ExportEngine::new(FFmpegRunner::new(FFmpegInfo {
            ffmpeg_path: PathBuf::from("/usr/bin/ffmpeg"),
            ffprobe_path: PathBuf::from("/usr/bin/ffprobe"),
            version: "test".to_string(),
            is_bundled: false,
            source: crate::core::ffmpeg::FFmpegSource::System,
        }));

        let settings = ExportSettings {
            fps: Some(24.0),
            ..ExportSettings::default()
        };

        let video = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &settings,
        )
        .expect("filter args build")
        .join(" ");

        let audio = engine
            .build_audio_only_filter_args_with_audio_info(
                &sequence,
                &assets,
                &effects,
                &audio_info,
                &settings,
            )
            .expect("audio-only args build")
            .join(" ");

        assert!(
            video.contains("afade=t=out:st=4.7917:d=0.4167:curve=qsin"),
            "the video path quantises against the override: {video}"
        );
        assert!(
            audio.contains("afade=t=out:st=4.7917:d=0.4167:curve=qsin"),
            "extracting the audio must not change the edit: {audio}"
        );
        assert!(
            audio.contains("adelay=delays=4792"),
            "the incoming branch must open where the picture does: {audio}"
        );
    }

    #[test]
    fn an_odd_frame_transition_lands_on_the_frame_the_split_gave_it() {
        use crate::core::effects::{EffectType, ParamValue};

        // 0.5s at 30fps is 15 frames, which cannot be halved: the planner gives
        // 7 to the incoming head and 8 to the outgoing tail so the blend still
        // starts on the cut's frame. The outgoing stream is therefore
        // 150 + 8 = 158 frames, `xfade` eats 15, and 143 frames pass through
        // first — 143/30 = 4.7667s.
        //
        // The number matters because it is what separates a frame-counted
        // offset from a seconds-counted one. Anything that computed the offset
        // as "the group's seconds minus half the blend" would read 4.7500 here,
        // and every previous fixture used an even frame count where the two
        // agree exactly.
        let half_second = transition_effect(
            "transition-odd",
            EffectType::CrossDissolve,
            &[("duration", ParamValue::Float(0.5))],
        );

        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(half_second)),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let joined = args.join(" ");

        assert!(
            joined.contains("xfade=transition=fade:duration=0.5000:offset=4.7667"),
            "an odd frame count puts the extra frame past the cut: {joined}"
        );
        assert!(
            joined.contains("trim=end_frame=158"),
            "the outgoing stream is its 150-frame slot plus an 8-frame tail: {joined}"
        );
        assert!(
            joined.contains("trim=end_frame=157"),
            "the incoming stream is its 150-frame slot plus a 7-frame head: {joined}"
        );
    }

    #[test]
    fn a_second_two_input_transition_on_one_clip_is_refused_by_name() {
        use crate::core::effects::{EffectType, ParamValue};

        // A clip has one out point. The wipe used to be dropped in silence.
        let wipe = transition_effect(
            "transition-wipe",
            EffectType::Wipe,
            &[("duration", ParamValue::Float(1.0))],
        );

        let (mut sequence, assets, mut effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        sequence.tracks[0].clips[0].effects.push(wipe.id.clone());
        effects.insert(wipe.id.clone(), wipe);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        assert!(
            joined.contains("xfade=transition=fade"),
            "the first transition still renders: {joined}"
        );
        assert!(
            !joined.contains("wipeleft"),
            "the second one cannot also occupy the out point: {joined}"
        );

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());
        let wipe_warnings: Vec<&String> = validation
            .warnings
            .iter()
            .filter(|warning| warning.contains("Wipe"))
            .collect();
        assert_eq!(
            wipe_warnings.len(),
            1,
            "the dropped wipe must be reported exactly once: {:?}",
            validation.warnings
        );
        assert!(
            wipe_warnings[0].contains("already occupies"),
            "the warning must say what took the out point: {}",
            wipe_warnings[0]
        );
    }

    #[test]
    fn two_same_typed_transitions_on_one_clip_warn_once_about_the_refused_one() {
        // The refusal used to be matched to an effect by its human-readable
        // label, so two dissolves on one clip produced the same sentence twice
        // and the caller could not tell which effect it named.
        let (mut sequence, assets, mut effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-first"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let second = one_second_dissolve("transition-second");
        sequence.tracks[0].clips[0].effects.push(second.id.clone());
        effects.insert(second.id.clone(), second);

        let _ = audio_info;
        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        let dissolve_warnings: Vec<&String> = validation
            .warnings
            .iter()
            .filter(|warning| warning.contains("Cross Dissolve"))
            .collect();
        assert_eq!(
            dissolve_warnings.len(),
            1,
            "one refused effect is one warning: {:?}",
            validation.warnings
        );
    }

    #[test]
    fn an_authored_video_fade_stays_on_the_clip_it_was_drawn_on() {
        use crate::core::effects::{EffectType, ParamValue};

        // The picture fades are anchored in seconds from the first frame of the
        // stream, and a transition starts that stream half a blend early. Left
        // alone, the incoming clip's fade-in completed 0.5s before the picture
        // the editor drew it under, and the outgoing clip's fade-out reached
        // black at its out point and then held black through the entire blend —
        // the opposite of a dissolve.
        let fade_out = transition_effect(
            "video-fade-out",
            EffectType::Fade,
            &[
                ("duration", ParamValue::Float(1.0)),
                ("fade_in", ParamValue::Bool(false)),
                // Anchored where AddEffect puts it: clip_duration - fade.
                ("start_time", ParamValue::Float(4.0)),
            ],
        );
        let fade_in = transition_effect(
            "video-fade-in",
            EffectType::Fade,
            &[
                ("duration", ParamValue::Float(1.0)),
                ("fade_in", ParamValue::Bool(true)),
            ],
        );

        let (mut sequence, assets, mut effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        sequence.tracks[0].clips[0]
            .effects
            .push(fade_out.id.clone());
        effects.insert(fade_out.id.clone(), fade_out);
        sequence.tracks[0].clips[1].effects.push(fade_in.id.clone());
        effects.insert(fade_in.id.clone(), fade_in);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        // The outgoing clip has no head handle — only a tail — so its fade-out
        // keeps its authored anchor and still reaches black on its out point,
        // 0.5s before the branch ends.
        assert!(
            joined.contains("fade=t=out:st=4.0000:d=1.0000"),
            "the fade-out must end on the clip's out point: {joined}"
        );
        // The incoming clip's branch opens 0.5s before its in point, so its
        // fade-in has to start there rather than on the first frame decoded.
        assert!(
            joined.contains("fade=t=in:st=0.5000:d=1.0000"),
            "the fade-in must start on the clip's in point, not the branch's: {joined}"
        );
    }

    #[test]
    fn an_auto_reframe_track_follows_the_clip_rather_than_the_branch() {
        use crate::core::effects::{EffectType, ParamValue};

        // Auto-reframe builds a piecewise-linear crop expression in `t` out of
        // the keyframe times stored in its analysis payload, so it drifts by
        // exactly the head handle for the same reason a fade does — the shot
        // stays framed for where the subject was half a blend earlier.
        let mut effect = Effect::new(EffectType::AutoReframe);
        effect.id = "reframe".to_string();
        effect.enabled = true;
        effect.set_param(
            "analysis_data",
            ParamValue::String(
                serde_json::json!({
                    "crop_w": 608,
                    "crop_h": 1080,
                    "keyframes": [
                        { "t": 0.0, "x": 100, "y": 0 },
                        { "t": 2.0, "x": 300, "y": 0 },
                    ],
                })
                .to_string(),
            ),
        );

        let anchored = anchor_effect_to_branch(effect.clone(), 0.5);
        let payload: serde_json::Value = serde_json::from_str(
            anchored
                .get_param("analysis_data")
                .and_then(ParamValue::as_str)
                .expect("the payload survives anchoring"),
        )
        .expect("the payload is still valid JSON");

        let times: Vec<f64> = payload["keyframes"]
            .as_array()
            .expect("keyframes")
            .iter()
            .map(|keyframe| keyframe["t"].as_f64().expect("a time"))
            .collect();
        assert_eq!(
            times,
            vec![0.5, 2.5],
            "every keyframe must move later by the head handle"
        );
        assert_eq!(
            payload["crop_w"], 608,
            "nothing but the times may be touched"
        );

        let untouched = anchor_effect_to_branch(effect, 0.0);
        let untouched_payload: serde_json::Value = serde_json::from_str(
            untouched
                .get_param("analysis_data")
                .and_then(ParamValue::as_str)
                .expect("payload"),
        )
        .expect("valid JSON");
        assert_eq!(
            untouched_payload["keyframes"][0]["t"], 0.0,
            "a clip with no handle keeps the track it was given"
        );
    }

    /// Feature: Transitions
    /// Scenario: a zoom on a dissolving clip starts where it was authored
    ///
    /// A clip in a transition is decoded from `head_sec` before its in point, so
    /// `zoompan`'s output-frame counter is already running while the picture the
    /// editor drew the move under has not appeared yet. Unanchored, the move is
    /// `head_sec` through by the time the clip's own footage starts.
    #[test]
    fn a_zoom_on_a_clip_with_handles_waits_for_the_clips_own_picture() {
        use crate::core::effects::EffectType;

        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(2.0));

        let mut graph = FilterGraph::new().with_dimensions(1920, 1080);
        graph.set_fps(30.0);
        graph.add_effect(anchor_effect_to_branch(effect.clone(), 0.5));
        let anchored = graph.to_video_filter_complex("trim0", "v0");

        // Half a second of head handle at 30fps is fifteen frames of branch that
        // are not the clip's own picture.
        assert!(
            anchored.contains("*max(on-15,0)"),
            "the move must hold until the clip's own picture starts: {anchored}"
        );

        let mut unhandled = FilterGraph::new().with_dimensions(1920, 1080);
        unhandled.set_fps(30.0);
        unhandled.add_effect(anchor_effect_to_branch(effect, 0.0));
        let plain = unhandled.to_video_filter_complex("trim0", "v0");

        assert!(
            plain.contains("*on,") && !plain.contains("max(on-"),
            "a clip with no handle keeps the graph it has always had: {plain}"
        );
    }

    #[test]
    fn a_video_fade_on_a_clip_without_handles_is_emitted_exactly_as_before() {
        use crate::core::effects::{EffectType, ParamValue};

        // The anchoring must be invisible to every clip the transition engine
        // did not touch.
        let fade_in = transition_effect(
            "video-fade-in",
            EffectType::Fade,
            &[
                ("duration", ParamValue::Float(1.0)),
                ("fade_in", ParamValue::Bool(true)),
            ],
        );

        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(fade_in)),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );

        assert!(
            args.join(" ").contains("fade=t=in:st=0:d=1.0000"),
            "an ordinary clip keeps the bare `st=0` it always had: {}",
            args.join(" ")
        );
    }

    #[test]
    fn a_transition_keeps_its_offset_when_a_gap_precedes_it() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        // The whole point of folding a transition group before the timeline
        // stitch: black filler is generated by a `color` source whose final
        // frame FFmpeg 6.x and 9.x round differently, and the blend must not
        // move because of it.
        let dissolve = one_second_dissolve("transition-after-gap");

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let mut effects = std::collections::HashMap::new();
        let mut assets = std::collections::HashMap::new();
        let mut audio_info = std::collections::HashMap::new();

        for (index, timeline_in) in [2.0_f64, 7.0].into_iter().enumerate() {
            let asset_id = format!("asset{index}");
            let mut clip = Clip::new(&asset_id)
                .with_source_range(1.0, 6.0)
                .place_at(timeline_in);
            clip.id = format!("clip{index}");
            if index == 0 {
                clip.effects.push(dissolve.id.clone());
            }
            track.add_clip(clip);

            let path = create_temp_media_file(&format!("video{index}.mp4"));
            let mut asset =
                Asset::new_video(&format!("video{index}.mp4"), &path, VideoInfo::default())
                    .with_duration(7.0);
            asset.id = asset_id.clone();
            assets.insert(asset_id.clone(), asset);
            audio_info.insert(
                asset_id,
                AssetAudioInfo {
                    source_duration_sec: Some(7.0),
                    ..AssetAudioInfo::default()
                },
            );
        }
        effects.insert(dissolve.id.clone(), dissolve);
        sequence.add_track(track);

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        assert!(
            joined.contains("color=c=black"),
            "the two-second hole before the clips must still render as filler: {joined}"
        );
        assert!(
            joined.contains("offset=4.5000"),
            "the offset is measured inside the group, not from the start of the video: {joined}"
        );
        assert_eq!(
            video_concat_count(&args),
            1,
            "filler and the folded group stitch through one concat: {joined}"
        );
    }

    #[test]
    fn two_chained_transitions_each_land_on_their_own_boundary() {
        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-a"))),
                TransitionClipSpec::new(4.0, Some(one_second_dissolve("transition-b"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let joined = args.join(" ");

        // First fold: 165 frames of clip 0, minus the 30 the blend eats, is 135
        // pass-through frames. Afterwards the accumulated stream is
        // 135 + (4s slot + two 0.5s handles = 150) = 285 frames.
        assert!(
            joined.contains("offset=4.5000"),
            "the first boundary sits at frame 135: {joined}"
        );
        // Second fold: 285 - 30 = 255 pass-through frames, so 254.5/30s. Getting
        // this wrong by the first transition's length is the classic chained-
        // offset bug, and it would read 7.4833 here.
        assert!(
            joined.contains("offset=8.5000"),
            "the second boundary sits at frame 255, not at 255 minus the first blend: {joined}"
        );
        assert_eq!(
            video_concat_count(&args),
            0,
            "all three clips fold into one stream: {joined}"
        );
    }

    #[test]
    fn a_transformed_clip_at_a_boundary_is_pinned_to_its_extended_slot() {
        let (mut sequence, assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-scaled"))),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        // A scaled clip is composited onto the canvas instead of fitted to it,
        // and that path pins its own frame count — which has to be the extended
        // one, or the fold's offset points at the wrong frame.
        sequence.tracks[0].clips[0].transform.scale.x = 0.5;
        sequence.tracks[0].clips[0].transform.scale.y = 0.5;

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        assert!(
            joined.contains("overlay="),
            "a scaled clip must go through the composite path: {joined}"
        );
        assert!(
            joined.contains("trim=end_frame=165"),
            "the composite must last the slot plus its handle, not just the slot: {joined}"
        );
        assert!(
            joined.contains("offset=4.5000"),
            "the blend still lands on frame 135: {joined}"
        );
    }

    #[test]
    fn a_faster_outgoing_clip_reaches_further_into_its_source() {
        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-fast")))
                    .at_speed(2.0),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let joined = args.join(" ");

        // The clip's 5s slot consumes 10s of source, so a 0.5s handle costs a
        // whole second of it: the range runs 2..12 and the render window 2..13.
        assert!(
            joined.contains("trim=start=2:end=13"),
            "a 2x clip must spend two seconds of source per second of handle: {joined}"
        );
        assert!(
            joined.contains("offset=4.5000"),
            "the handle is still half the blend in timeline seconds: {joined}"
        );
    }

    #[test]
    fn a_single_input_transition_effect_stays_in_the_clip_chain() {
        use crate::core::effects::{EffectType, ParamValue};

        // `Fade` is in the Transition *category* but is a one-input filter, so
        // the two-input exclusion must not swallow it.
        let fade = transition_effect(
            "transition-fade",
            EffectType::Fade,
            &[
                ("duration", ParamValue::Float(1.0)),
                ("fade_in", ParamValue::Bool(true)),
            ],
        );

        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(fade)),
                TransitionClipSpec::new(5.0, None),
                TransitionClipSpec::new(5.0, None),
            ],
            false,
        );
        let joined = args.join(" ");

        assert!(
            joined.contains("fade=t=in"),
            "a single-input transition must render in the clip chain: {joined}"
        );
        assert!(
            !joined.contains("xfade"),
            "fade must not be mistaken for a two-input transition: {joined}"
        );
        assert_eq!(
            video_concat_count(&args),
            2,
            "three parts stitch through two concats: {joined}"
        );
    }

    #[test]
    fn a_transition_crossfades_the_audio_without_moving_either_clip() {
        let args = build_fixture_args(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            true,
        );
        let joined = args.join(" ");

        // The outgoing branch runs 0.5s long and fades out over the whole blend:
        // 5.5s of branch minus the 1s transition.
        assert!(
            joined.contains("atrim=start=1:end=6.5"),
            "the outgoing audio must follow its picture past the cut: {joined}"
        );
        assert!(
            joined.contains("afade=t=out:st=4.5000:d=1.0000:curve=qsin"),
            "the outgoing branch must fade out across the blend: {joined}"
        );
        // The incoming branch starts 0.5s early, so its delay shrinks to match:
        // its first sample now belongs at 4.5s, not 5s.
        assert!(
            joined.contains("atrim=start=0.5:end=6"),
            "the incoming audio must start before its in point: {joined}"
        );
        assert!(
            joined.contains("afade=t=in:st=0:d=1.0000:curve=qsin"),
            "the incoming branch must fade in across the blend: {joined}"
        );
        assert!(
            joined.contains("adelay=delays=4500"),
            "the incoming branch's first sample belongs half a blend before the cut: {joined}"
        );
        // `qsin` squares sum to one, and the master mix sums without
        // normalising, so the level is flat through the blend.
        assert!(
            joined.contains("normalize=0"),
            "constant-power fades only stay constant if the mix does not renormalise: {joined}"
        );
        assert!(
            joined.contains("apad=whole_dur=10"),
            "the output is still exactly as long as the timeline: {joined}"
        );
    }

    #[test]
    fn an_authored_fade_survives_the_engine_fade_on_the_same_clip() {
        let (mut sequence, assets, effects, audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            true,
        );
        // A fade the editor authored on the incoming clip stays anchored to that
        // clip's in point, which the handle has pushed 0.5s into the branch.
        sequence.tracks[0].clips[1].audio.fade_in_sec = 0.5;

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &audio_info,
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        assert!(
            joined.contains("[afin1]afade=t=in:st=0:d=1.0000:curve=qsin[axfin1]"),
            "the engine fade must chain after the authored one, not replace it: {joined}"
        );
        assert!(
            joined.contains("afade=t=in:st=0.5000:d=0.5000"),
            "the authored fade must stay on the clip's own in point: {joined}"
        );
    }

    #[test]
    fn a_transition_at_a_non_adjacent_boundary_degrades_to_a_cut_and_names_the_gap() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let dissolve = one_second_dissolve("transition-gap");

        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("Video 1");
        let mut effects = std::collections::HashMap::new();

        let mut clip1 = Clip::new("asset0")
            .with_source_range(1.0, 6.0)
            .place_at(0.0);
        clip1.id = "clip0".to_string();
        clip1.effects.push(dissolve.id.clone());
        effects.insert(dissolve.id.clone(), dissolve);
        track.add_clip(clip1);
        // Two-second hole between the clips: there is nothing to blend into.
        let mut clip2 = Clip::new("asset1")
            .with_source_range(1.0, 6.0)
            .place_at(7.0);
        clip2.id = "clip1".to_string();
        track.add_clip(clip2);
        sequence.add_track(track);

        let mut assets = std::collections::HashMap::new();
        for index in 0..2 {
            let asset_id = format!("asset{index}");
            let path = create_temp_media_file(&format!("video{index}.mp4"));
            let mut asset =
                Asset::new_video(&format!("video{index}.mp4"), &path, VideoInfo::default())
                    .with_duration(7.0)
                    .with_file_size(10_000_000);
            asset.id = asset_id.clone();
            assets.insert(asset_id, asset);
        }

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &effects,
            &std::collections::HashMap::new(),
            &ExportSettings::default(),
        )
        .expect("filter args build");
        let joined = args.join(" ");

        assert!(
            !joined.contains("xfade"),
            "a boundary that is not a boundary must not be blended: {joined}"
        );
        assert!(
            joined.contains("color=c=black"),
            "the hole must render as black filler: {joined}"
        );
        assert_eq!(
            video_concat_count(&args),
            2,
            "clip, filler, and clip stitch through two concats: {joined}"
        );

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());
        assert!(
            validation
                .warnings
                .iter()
                .any(|warning| warning.contains("nothing to blend into")),
            "the warning must say the boundary is missing: {:?}",
            validation.warnings
        );
    }

    #[test]
    fn a_transition_without_handles_warns_that_the_boundary_stays_a_cut() {
        let (sequence, assets, effects, _audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve")))
                    .without_handles(),
                TransitionClipSpec::new(5.0, None),
            ],
            true,
        );

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(
            validation.is_valid,
            "a transition must not block the export: {:?}",
            validation.errors
        );
        let warning = validation
            .warnings
            .iter()
            .find(|warning| warning.contains("renders as a cut"))
            .unwrap_or_else(|| {
                panic!(
                    "a refused transition must be reported: {:?}",
                    validation.warnings
                )
            });
        assert!(
            warning.contains("Cross Dissolve"),
            "the warning must name the effect: {warning}"
        );
        assert!(
            warning.contains("handle"),
            "the warning must say what was missing: {warning}"
        );
    }

    #[test]
    fn an_eligible_transition_is_not_warned_about() {
        let (sequence, assets, effects, _audio_info) = build_transition_fixture(
            &[
                TransitionClipSpec::new(5.0, Some(one_second_dissolve("transition-dissolve"))),
                TransitionClipSpec::new(5.0, None),
            ],
            true,
        );

        let validation =
            validate_export_settings(&sequence, &assets, &effects, &ExportSettings::default());

        assert!(validation.is_valid, "{:?}", validation.errors);
        assert!(
            !validation
                .warnings
                .iter()
                .any(|warning| warning.contains("Cross Dissolve")),
            "a transition the render blends must not be reported as a cut: {:?}",
            validation.warnings
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

        // Text clips are composited over the concatenated picture rather than
        // decoded as their own media input.
        assert!(
            args_str.contains(&regular_path),
            "Should include file input for regular clip. Got: {}",
            args_str
        );
        assert!(
            args_str.contains("[outv]drawtext="),
            "Text clip should be drawn over the concatenated video output. Got: {}",
            args_str
        );
        let input_count = args.iter().filter(|arg| arg.as_str() == "-i").count();
        assert_eq!(input_count, 1, "Text overlay should not add a media input");

        // The text clip runs from 5s to 10s but the only file-backed clip ends
        // at 5s, so the timeline needs five seconds of black underneath it.
        // Without that tail the render stops at 5s and the title disappears.
        assert!(
            args_str.contains("color=c=black:s=1920x1080:r=30:d=5"),
            "Text past the last file-backed clip needs a black tail. Got: {}",
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
            source: crate::core::ffmpeg::FFmpegSource::System,
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
    fn test_output_video_pixel_format_preserves_10_bit_requests() {
        let sdr = ExportSettings::default();
        assert_eq!(output_video_pixel_format(&sdr), "yuv420p");

        let hdr_h265 = ExportSettings {
            hdr_mode: HdrMode::Hdr10,
            video_codec: VideoCodec::H265,
            ..Default::default()
        };
        assert_eq!(output_video_pixel_format(&hdr_h265), "yuv420p10le");

        let explicit_10_bit = ExportSettings {
            bit_depth: Some(10),
            ..Default::default()
        };
        assert_eq!(output_video_pixel_format(&explicit_10_bit), "yuv420p10le");

        let prores = ExportSettings {
            video_codec: VideoCodec::ProRes,
            ..Default::default()
        };
        assert_eq!(output_video_pixel_format(&prores), "yuv422p10le");
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
            ExportPreset::Mp4Draft,
            ExportPreset::Mp4High,
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
    fn should_not_add_slow_motion_filter_for_nearest_mode() {
        let mut clip = Clip::new("asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        clip.speed = 0.5;
        clip.slow_motion_interpolation = SlowMotionInterpolation::Nearest;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "vtrim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

        assert!(
            !filter.contains("minterpolate"),
            "nearest mode should preserve legacy frame duplication: {filter}"
        );
    }

    #[test]
    fn should_add_frame_blend_filter_for_slow_motion_export() {
        let mut clip = Clip::new("asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        clip.speed = 0.5;
        clip.slow_motion_interpolation = SlowMotionInterpolation::FrameBlend;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "vtrim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

        assert!(
            filter.contains("minterpolate=mi_mode=blend"),
            "frame blend slow motion should include minterpolate blend: {filter}"
        );
    }

    #[test]
    fn should_add_motion_compensated_filter_for_slow_motion_export() {
        let mut clip = Clip::new("asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        clip.speed = 0.5;
        clip.slow_motion_interpolation = SlowMotionInterpolation::MotionCompensated;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "vtrim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

        assert!(
            filter.contains("minterpolate=mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"),
            "motion-compensated slow motion should include minterpolate mci: {filter}"
        );
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
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

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
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

        // Then filter includes tpad clone
        assert!(
            filter.contains("tpad=stop_mode=clone:stop_duration=3"),
            "should contain tpad: {filter}"
        );
    }

    /// Feature: Still images on the timeline
    /// Scenario: a photo fills the slot the editor gave it
    ///
    /// An image decodes to exactly one frame, so cutting a window out of it —
    /// what every other branch of the trim builder does — leaves the clip one
    /// frame long however many seconds it occupies. The slot is filled by cloning
    /// that frame, the same way a freeze frame is.
    #[test]
    fn should_hold_a_still_image_across_its_whole_slot() {
        use crate::core::timeline::Clip;

        let mut clip = Clip::new("photo").with_source_range(0.0, 5.0);
        clip.place.duration_sec = 5.0;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::StillImage,
            None,
        );

        assert!(
            filter.contains("tpad=stop_mode=clone:stop_duration=5"),
            "a still must be cloned across its slot: {filter}"
        );
        assert!(
            filter.contains("trim=0:5"),
            "the clone must be cut back to the slot: {filter}"
        );
    }

    /// Feature: Still images on the timeline
    /// Scenario: a photo trimmed away from its start still renders
    ///
    /// A still has one frame at t=0 and nothing after it, so a `trim` starting at
    /// the clip's source in point finds no frame at all and the clip renders
    /// nothing. The source window is not a thing a still has.
    #[test]
    fn should_ignore_the_source_window_of_a_still_image() {
        use crate::core::timeline::Clip;

        let mut clip = Clip::new("photo").with_source_range(2.0, 6.0);
        clip.place.duration_sec = 4.0;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::StillImage,
            None,
        );

        assert!(
            filter.contains("trim=end_frame=1"),
            "a still is read as its single frame, not as a window: {filter}"
        );
        assert!(
            !filter.contains("trim=start=2"),
            "there is no frame at the source in point to seek to: {filter}"
        );
    }

    /// Feature: Still images on the timeline
    /// Scenario: the hold covers the handles a transition decodes as well
    #[test]
    fn should_hold_a_still_image_across_its_transition_handles() {
        use crate::core::timeline::Clip;

        let mut clip = Clip::new("photo").with_source_range(0.0, 2.0);
        clip.place.duration_sec = 2.0;

        let mut filter = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter,
            ClipHandles {
                head_sec: 0.5,
                tail_sec: 0.25,
            },
            TrimSourceKind::StillImage,
            None,
        );

        assert!(
            filter.contains("stop_duration=2.75"),
            "the hold must cover the handles too: {filter}"
        );
    }

    /// Feature: Still images on the timeline
    /// Scenario: only a source that really holds one picture is held
    #[test]
    fn should_classify_only_single_frame_images_as_stills() {
        use crate::core::assets::{Asset, VideoInfo};

        let video = Asset::new_video("clip", "file:///a.mp4", VideoInfo::default());
        assert_eq!(
            TrimSourceKind::for_asset(&video, None),
            TrimSourceKind::Motion,
            "a video is cut from its window whatever a frame count says"
        );
        assert_eq!(
            TrimSourceKind::for_asset(&video, Some(1)),
            TrimSourceKind::Motion
        );

        let image = Asset::new_image("photo", "file:///a.png", 1920, 1080);
        assert_eq!(
            TrimSourceKind::for_asset(&image, Some(1)),
            TrimSourceKind::StillImage
        );
        assert_eq!(
            TrimSourceKind::for_asset(&image, None),
            TrimSourceKind::StillImage,
            "an unmeasurable image falls back to the still path"
        );
    }

    /// Feature: Animated images on the timeline
    /// Scenario: a GIF, WebP or APNG that holds many frames keeps its motion
    ///
    /// `AssetKind::Image` is decided by file extension alone, and `gif`, `webp`,
    /// `avif` and `png` are all extensions an animation can wear. Classifying on
    /// the kind froze every one of them to its first frame.
    #[test]
    fn should_cut_an_animated_image_from_its_window_like_any_other_motion() {
        use crate::core::assets::Asset;

        let animated = Asset::new_image("reaction", "file:///a.gif", 320, 240);
        assert_eq!(
            TrimSourceKind::for_asset(&animated, Some(30)),
            TrimSourceKind::Motion,
            "an animation must keep its frames and its source-in window"
        );

        let clip = Clip::new("asset").with_source_range(0.5, 1.5).place_at(0.0);
        let mut filter_complex = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter_complex,
            ClipHandles::default(),
            TrimSourceKind::for_asset(&animated, Some(30)),
            None,
        );

        assert!(
            filter_complex.contains("trim=start=0.5:end=1.5"),
            "an animation keeps the window the edit asked for: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("end_frame=1"),
            "an animation must not be cut to a single frame: {filter_complex}"
        );
    }

    /// Feature: Still images on the timeline
    /// Scenario: a photo renders every frame of its slot, zoomed or not
    ///
    /// The string assertions above encode a belief about what `tpad` does to a
    /// one-frame input. This one hands the real FFmpeg the graph the export
    /// builds around a real PNG and counts what comes out: one luma plane per
    /// frame at the canvas size, so a wrong frame count and a wrong frame size
    /// both show up as a wrong byte count.
    ///
    /// Measured negative control (ffmpeg 9.0.1, 320x180 canvas, 2s at 30fps): the
    /// plain source-window trim this replaced rendered one frame — 57600 bytes
    /// where 3456000 were due — whether or not a zoom was in the chain. A Ken
    /// Burns move on a photo exported as a single-frame flash.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored still
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_still_image_renders_every_frame_of_its_slot() {
        use crate::core::effects::{Effect, EffectType, FilterGraph};
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::Clip;

        const CANVAS_WIDTH: u32 = 320;
        const CANVAS_HEIGHT: u32 = 180;
        const FPS: f64 = 30.0;
        const SLOT_SEC: f64 = 2.0;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        let dir = tempfile::tempdir().expect("temp dir");
        let photo = dir.path().join("photo.png");
        let mut built_cmd = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut built_cmd);
        let built = built_cmd
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=1:duration=1",
                "-frames:v",
                "1",
            ])
            .arg(&photo)
            .output();
        let Ok(built) = built else {
            skip_without_ffmpeg("ffmpeg could not be launched");
            return;
        };
        if !built.status.success() || !photo.exists() {
            skip_without_ffmpeg("ffmpeg could not build the fixture");
            return;
        }

        let mut clip = Clip::new("photo").with_source_range(0.0, SLOT_SEC);
        clip.place.duration_sec = SLOT_SEC;

        // Classified the way the export classifies it, so this also guards the
        // photo against being mistaken for an animation and cut to its window.
        let asset = crate::core::assets::Asset::new_image(
            "photo",
            &photo.to_string_lossy(),
            CANVAS_WIDTH,
            CANVAS_HEIGHT,
        );
        let mut frame_counts = SourceFrameCountCache::new();
        let source_kind = resolve_trim_source_kind(&asset, &mut frame_counts);
        assert_eq!(
            source_kind,
            TrimSourceKind::StillImage,
            "a real PNG holds one picture and must take the still path"
        );

        for zoomed in [false, true] {
            let mut filter_complex = String::new();
            build_video_trim_filter(
                &clip,
                0,
                "trim0",
                &mut filter_complex,
                ClipHandles::default(),
                source_kind,
                None,
            );

            if zoomed {
                let mut graph =
                    FilterGraph::new().with_dimensions(CANVAS_WIDTH as i32, CANVAS_HEIGHT as i32);
                graph.set_fps(FPS);
                let mut effect = Effect::new(EffectType::Zoom);
                effect.set_param("duration", ParamValue::Float(SLOT_SEC));
                effect.set_param("zoom_factor", ParamValue::Float(1.5));
                graph.add_effect(effect);
                filter_complex.push_str(&graph.to_video_filter_complex("trim0", "v0"));
            } else {
                filter_complex.push_str("[trim0]null[v0]");
            }
            filter_complex.push(';');

            append_video_stream_normalization(
                &mut filter_complex,
                "v0",
                "out",
                CANVAS_WIDTH,
                CANVAS_HEIGHT,
                FPS,
                "yuv420p",
                None,
                false,
            );

            let graph_file = dir.path().join("graph.txt");
            std::fs::write(&graph_file, filter_complex.trim_end_matches(';'))
                .expect("write filtergraph");

            let mut render_cmd = std::process::Command::new(&ffmpeg);
            crate::core::process::configure_std_command(&mut render_cmd);
            let render = render_cmd
                .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
                .arg(&photo)
                .arg("-/filter_complex")
                .arg(&graph_file)
                .args(["-map", "[out]", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
                .output()
                .expect("run ffmpeg");

            assert!(
                render.status.success(),
                "ffmpeg refused the still-image graph (zoomed={zoomed}): {}",
                String::from_utf8_lossy(&render.stderr)
            );

            let expected_frames = (SLOT_SEC * FPS).round() as usize;
            let frame_bytes = CANVAS_WIDTH as usize * CANVAS_HEIGHT as usize;
            assert_eq!(
                render.stdout.len(),
                expected_frames * frame_bytes,
                "a {SLOT_SEC}s still at {FPS}fps must render {expected_frames} frames \
                 of {CANVAS_WIDTH}x{CANVAS_HEIGHT} (zoomed={zoomed}), got {} frames",
                render.stdout.len() / frame_bytes.max(1)
            );
        }
    }

    /// Feature: Animated images on the timeline
    /// Scenario: a GIF, WebP or APNG exports its animation, not its first frame
    ///
    /// `AssetKind::Image` comes from the file extension alone, so holding every
    /// image across its slot held the animated ones too: a reaction GIF exported
    /// as one frame cloned for the length of the clip. Measured against ffmpeg
    /// 9.0.1, a 30-frame GIF rendered 30 identical frames — one unique picture
    /// where 30 were due — and `freezedetect` fired at 0.133s and never ended.
    ///
    /// The classification is measured here rather than asserted from the
    /// extension, because the declared metadata cannot answer it: a still JPEG
    /// advertises a duration, a one-frame GIF advertises a frame count of 1, and
    /// an animated APNG or WebP advertises neither.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored animated
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn an_animated_image_renders_its_animation_and_not_a_frozen_frame() {
        use crate::core::assets::Asset;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::Clip;
        use std::collections::HashSet;

        const CANVAS_WIDTH: u32 = 320;
        const CANVAS_HEIGHT: u32 = 180;
        const FPS: f64 = 30.0;
        const SLOT_SEC: f64 = 1.0;
        const SOURCE_FRAMES: usize = 30;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        let dir = tempfile::tempdir().expect("temp dir");
        let build = |name: &str, frames: usize, rate: u32| -> Option<std::path::PathBuf> {
            let path = dir.path().join(name);
            let mut built_cmd = std::process::Command::new(&ffmpeg);
            crate::core::process::configure_std_command(&mut built_cmd);
            let built = built_cmd
                .args([
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("testsrc=size=320x240:rate={rate}"),
                    "-frames:v",
                    &frames.to_string(),
                ])
                .arg(&path)
                .output()
                .ok()?;
            (built.status.success() && path.exists()).then_some(path)
        };

        let (Some(animated), Some(single_frame), Some(apng)) = (
            build("anim.gif", SOURCE_FRAMES, 30),
            build("one.gif", 1, 30),
            build("anim.apng", 20, 10),
        ) else {
            skip_without_ffmpeg("ffmpeg could not build the fixtures");
            return;
        };

        let mut frame_counts = SourceFrameCountCache::new();
        let kind_of = |path: &std::path::Path, cache: &mut SourceFrameCountCache| {
            let asset = Asset::new_image("image", &path.to_string_lossy(), 320, 240);
            resolve_trim_source_kind(&asset, cache)
        };

        assert_eq!(
            kind_of(&animated, &mut frame_counts),
            TrimSourceKind::Motion,
            "a 30-frame GIF is moving media"
        );
        assert_eq!(
            kind_of(&apng, &mut frame_counts),
            TrimSourceKind::Motion,
            "an animated APNG is moving media, though it advertises no duration \
             and no frame count"
        );
        assert_eq!(
            kind_of(&single_frame, &mut frame_counts),
            TrimSourceKind::StillImage,
            "a one-frame GIF is a photo, though it advertises a duration"
        );

        let mut clip = Clip::new("anim").with_source_range(0.0, SLOT_SEC);
        clip.place.duration_sec = SLOT_SEC;

        let mut filter_complex = String::new();
        build_video_trim_filter(
            &clip,
            0,
            "trim0",
            &mut filter_complex,
            ClipHandles::default(),
            kind_of(&animated, &mut frame_counts),
            None,
        );
        filter_complex.push_str("[trim0]null[v0];");
        append_video_stream_normalization(
            &mut filter_complex,
            "v0",
            "out",
            CANVAS_WIDTH,
            CANVAS_HEIGHT,
            FPS,
            "yuv420p",
            None,
            false,
        );

        let graph_file = dir.path().join("graph.txt");
        std::fs::write(&graph_file, filter_complex.trim_end_matches(';')).expect("write graph");

        let mut render_cmd = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut render_cmd);
        let render = render_cmd
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(&animated)
            .arg("-/filter_complex")
            .arg(&graph_file)
            .args(["-map", "[out]", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output()
            .expect("run ffmpeg");

        assert!(
            render.status.success(),
            "ffmpeg refused the animated-image graph: {}",
            String::from_utf8_lossy(&render.stderr)
        );

        let frame_bytes = CANVAS_WIDTH as usize * CANVAS_HEIGHT as usize;
        let frames: Vec<&[u8]> = render.stdout.chunks_exact(frame_bytes).collect();
        assert_eq!(
            frames.len(),
            (SLOT_SEC * FPS).round() as usize,
            "the clip still has to fill its slot"
        );

        let unique: HashSet<&[u8]> = frames.iter().copied().collect();
        assert!(
            unique.len() > 1,
            "an animated GIF must render its animation, got {} unique picture(s) \
             across {} frames — the still path cloned one frame",
            unique.len(),
            frames.len()
        );
    }

    #[test]
    fn should_include_areverse_for_reversed_clip_audio() {
        use crate::core::timeline::Clip;

        // Given a reversed clip
        let mut clip = Clip::new("asset_1").with_source_range(2.0, 8.0);
        clip.reverse = true;

        let mut filter = String::new();
        let result_label = build_audio_trim_filter(
            &clip,
            0,
            "atrim0",
            &mut filter,
            ClipHandles::default(),
            EngineAudioFades::default(),
        );

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
        let result_label = build_audio_trim_filter(
            &clip,
            0,
            "atrim0",
            &mut filter,
            ClipHandles::default(),
            EngineAudioFades::default(),
        );

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
        build_video_trim_filter(
            &clip,
            0,
            "vtrim0",
            &mut filter,
            ClipHandles::default(),
            TrimSourceKind::Motion,
            None,
        );

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
        let result_label = build_audio_trim_filter(
            &clip,
            0,
            "atrim0",
            &mut filter,
            ClipHandles::default(),
            EngineAudioFades::default(),
        );

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
            settings: None,
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
            settings: None,
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

    /// Builds a one-clip sequence long enough to slice a window out of.
    fn twenty_second_range_fixture(
        name: &str,
    ) -> (Sequence, std::collections::HashMap<String, Asset>) {
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

        let video_path = create_temp_media_file(name);
        let mut asset = Asset::new_video(name, &video_path, VideoInfo::default())
            .with_duration(20.0)
            .with_file_size(10_000_000);
        asset.id = "asset1".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("asset1".to_string(), asset);

        (sequence, assets)
    }

    /// Feature: Range Export
    /// Scenario: a range render is a graph that starts at the range, not a seek
    ///
    /// The output-side `-ss` this replaced asked FFmpeg to build the whole
    /// timeline and throw the front of it away, which is how a range render could
    /// land half an output frame out of phase with the same frames of a full one.
    /// What the builder emits now is a graph whose own clock starts on the
    /// window's first frame, so there is nothing left to seek past.
    #[test]
    fn complex_export_args_should_render_the_range_as_a_window_shaped_graph() {
        let (sequence, assets) = twenty_second_range_fixture("range_args.mp4");

        let settings = ExportSettings {
            output_path: std::path::PathBuf::from("/tmp/range.mp4"),
            start_time: Some(5.0),
            end_time: Some(15.0),
            ..ExportSettings::default()
        };

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &settings,
        )
        .expect("range export args should build");

        assert!(
            !args.iter().any(|arg| arg == "-ss"),
            "a window-shaped graph must not be seeked into. Got: {:?}",
            args
        );
        assert!(
            args.windows(2)
                .any(|window| window[0] == "-t" && window[1] == "10"),
            "Expected the window length as the output duration. Got: {:?}",
            args
        );

        let filter_complex = filter_complex_of(&args);
        // 5s at the sequence's 30fps output rate is 150 frames of the clip that
        // a full render would have written before the window began.
        assert!(
            filter_complex.contains("trim=start_frame=150,setpts=PTS-STARTPTS"),
            "the segment straddling the window's start must drop the frames in \
             front of it: {filter_complex}"
        );
        assert!(
            filter_complex.contains("trim=end_frame=300"),
            "the picture must be pinned to the window's own frame count: \
             {filter_complex}"
        );
    }

    /// Feature: Range Export
    /// Scenario: a full export emits exactly the arguments it always did
    ///
    /// The window machinery has one hard invariant: a render with no range must
    /// be untouched by it, down to the argument list. A regression here would
    /// invalidate every cached preview segment and change every full export.
    #[test]
    fn a_full_export_should_carry_no_range_arguments_at_all() {
        let (sequence, assets) = twenty_second_range_fixture("full_args.mp4");

        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
            &ExportSettings {
                output_path: std::path::PathBuf::from("/tmp/full.mp4"),
                ..ExportSettings::default()
            },
        )
        .expect("full export args should build");

        assert!(
            !args.iter().any(|arg| arg == "-ss" || arg == "-t"),
            "a full export takes no range arguments. Got: {:?}",
            args
        );
        let filter_complex = filter_complex_of(&args);
        assert!(
            !filter_complex.contains("start_frame=") && !filter_complex.contains("nullsink"),
            "a full export must not be shaped to a window: {filter_complex}"
        );
    }

    /// A video-with-audio timeline whose clips are placed as `(start, duration)`.
    fn windowed_audio_fixture(
        name: &str,
        placements: &[(f64, f64)],
    ) -> (
        Sequence,
        std::collections::HashMap<String, Asset>,
        std::collections::HashMap<String, AssetAudioInfo>,
    ) {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Windowed audio", SequenceFormat::youtube_1080());
        sequence.tracks.clear();
        let mut track = Track::new_video("V1");
        for (index, (start_sec, duration_sec)) in placements.iter().enumerate() {
            let mut clip = Clip::new("asset1")
                .with_source_range(0.0, *duration_sec)
                .place_at(*start_sec);
            clip.id = format!("clip{index}");
            track.add_clip(clip);
        }
        sequence.add_track(track);

        let video_path = create_temp_media_file(name);
        let mut asset = Asset::new_video(name, &video_path, VideoInfo::default())
            .with_duration(60.0)
            .with_file_size(10_000_000);
        asset.id = "asset1".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("asset1".to_string(), asset);

        let mut audio_info = std::collections::HashMap::new();
        audio_info.insert(
            "asset1".to_string(),
            AssetAudioInfo {
                has_audio: true,
                source_dimensions: None,
                source_duration_sec: Some(60.0),
            },
        );

        (sequence, assets, audio_info)
    }

    fn windowed_range_graph(
        sequence: &Sequence,
        assets: &std::collections::HashMap<String, Asset>,
        audio_info: &std::collections::HashMap<String, AssetAudioInfo>,
        start_time: f64,
        end_time: f64,
    ) -> Vec<String> {
        build_complex_filter_args_with_audio_info(
            sequence,
            assets,
            &std::collections::HashMap::new(),
            audio_info,
            &ExportSettings {
                output_path: std::path::PathBuf::from("/tmp/windowed-audio.mp4"),
                start_time: Some(start_time),
                end_time: Some(end_time),
                ..ExportSettings::default()
            },
        )
        .expect("the windowed builder must produce a filtergraph")
    }

    /// Feature: Windowed render
    /// Scenario: sound that started before the window is cut, not stacked on it
    ///
    /// `adelay` can only push a branch later, so a branch whose first sample is
    /// in front of the window cannot be placed with one. Clamping the delay at
    /// zero instead — which is what the absolute-time graph did — would pile the
    /// whole branch onto the window's first sample.
    #[test]
    fn a_windowed_render_cuts_the_sound_that_started_before_the_window() {
        let (sequence, assets, audio_info) =
            windowed_audio_fixture("window_audio_head.mp4", &[(0.0, 10.0)]);

        let args = windowed_range_graph(&sequence, &assets, &audio_info, 4.0, 6.0);
        let filter_complex = filter_complex_of(&args);

        assert!(
            filter_complex.contains("atrim=start=4,asetpts=PTS-STARTPTS"),
            "the branch must lose its first four seconds: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("adelay"),
            "a branch cut to the window starts at its first sample: {filter_complex}"
        );
    }

    /// Feature: Windowed render
    /// Scenario: sound that starts inside the window is delayed by its own offset
    #[test]
    fn a_windowed_render_delays_the_sound_that_starts_inside_the_window() {
        let (sequence, assets, audio_info) =
            windowed_audio_fixture("window_audio_tail.mp4", &[(0.0, 4.0), (6.0, 4.0)]);

        let args = windowed_range_graph(&sequence, &assets, &audio_info, 4.0, 8.0);
        let filter_complex = filter_complex_of(&args);

        assert!(
            filter_complex.contains("adelay=delays=2000:all=1"),
            "the second clip starts two seconds into the window: {filter_complex}"
        );
    }

    /// Feature: Windowed render
    /// Scenario: a window between every audio branch still carries silence
    ///
    /// A file with no audio stream is a different file from one holding silence:
    /// the muxer reports a different layout, and a caller splicing rendered
    /// windows together gets a gap it cannot join. The full render of these same
    /// seconds pads silence there, so the window has to as well.
    #[test]
    fn a_window_past_every_audio_branch_still_carries_an_audio_stream() {
        let (mut sequence, assets, audio_info) =
            windowed_audio_fixture("window_audio_silence.mp4", &[(0.0, 2.0), (5.0, 4.0)]);
        // Only the first clip makes a sound; the second is muted, so the window
        // over it has nothing to mix.
        sequence.tracks[0].clips[1].audio.muted = true;

        let args = windowed_range_graph(&sequence, &assets, &audio_info, 6.0, 8.0);
        let filter_complex = filter_complex_of(&args);

        assert!(
            filter_complex.contains("anullsrc"),
            "the window must still carry silence: {filter_complex}"
        );
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "-map" && pair[1] == "[outa_base]"),
            "the silence has to reach the output. Got: {args:?}"
        );
    }

    /// Feature: Windowed render
    /// Scenario: a clip outside the window is never opened
    ///
    /// A clip that shares no frame with the window gets neither an `-i` nor a
    /// chain, so FFmpeg never opens or probes it. The one surviving clip
    /// renumbers to input 0 — the label suffix follows the emitted-input count,
    /// not the clip's position on the timeline.
    #[test]
    fn a_clip_outside_the_window_gets_neither_an_input_nor_a_chain() {
        let (sequence, assets, audio_info) = windowed_audio_fixture(
            "window_pruned_chain.mp4",
            &[(0.0, 2.0), (2.0, 2.0), (4.0, 2.0)],
        );

        let args = windowed_range_graph(&sequence, &assets, &audio_info, 4.0, 6.0);
        let filter_complex = filter_complex_of(&args);

        assert_eq!(
            args.iter().filter(|arg| *arg == "-i").count(),
            1,
            "only the clip inside the window is opened. Got: {args:?}"
        );
        assert!(
            filter_complex.contains("[0:v]"),
            "the surviving clip renumbers to input 0: {filter_complex}"
        );
        assert!(
            !filter_complex.contains("[1:v]") && !filter_complex.contains("[2:v]"),
            "the two clips in front of the window must never be opened: {filter_complex}"
        );
    }

    // =========================================================================
    // Windowed render: byte-exactness against a full render
    // =========================================================================

    /// Canvas the windowed-render fixtures render at.
    ///
    /// Deliberately the same size as the source media, so no scaler runs and the
    /// only thing under test is *which* frames come out.
    const WINDOW_TEST_CANVAS: (u32, u32) = (64, 64);
    /// Output frame rate every windowed-render fixture is built and measured at.
    const WINDOW_TEST_FPS: f64 = 30.0;
    /// Length of the counter fixture, in seconds.
    const WINDOW_TEST_SOURCE_SEC: f64 = 12.0;

    /// Export settings for the windowed-render fixtures.
    ///
    /// CRF 0 with no bitrate cap is what makes the comparison meaningful: two
    /// *lossy* encodes of the same pictures decode to different bytes, because
    /// they carry different GOP structures. Lossless x264 decodes back to the
    /// exact frames the graph produced, so a difference between the two renders
    /// can only be a difference in the graph.
    fn windowed_render_settings(
        output: std::path::PathBuf,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> ExportSettings {
        ExportSettings {
            output_path: output,
            width: Some(WINDOW_TEST_CANVAS.0),
            height: Some(WINDOW_TEST_CANVAS.1),
            fps: Some(WINDOW_TEST_FPS),
            crf: Some(0),
            video_bitrate: None,
            start_time,
            end_time,
            ..ExportSettings::default()
        }
    }

    /// Writes a source that identifies both its frame *and* its geometry.
    ///
    /// Two components, and both are load-bearing:
    ///
    /// * `2 * (N mod 64)` is a flat, per-frame luma step. A static picture would
    ///   be useless here — shifted by a frame it looks identical, which is
    ///   exactly the defect this suite exists to catch — and stepping by two
    ///   makes a one-frame slip a difference in every single pixel.
    /// * A four-quadrant pattern at distinct levels gives the frame a *place*.
    ///   Without it a zoom or a pan would be invisible: scaling a flat picture
    ///   produces the same flat picture, so the Ken Burns fixture would pass even
    ///   if the move restarted at the window instead of continuing through it.
    ///
    /// The two sum to at most 254, so nothing clips and every pair of frames is
    /// distinguishable both in time and in space.
    fn write_frame_counter_source(ffmpeg: &std::path::Path, path: &std::path::Path) -> bool {
        let mut build = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut build);
        let built = build
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "color=c=black:s={}x{}:r={}:d={}",
                    WINDOW_TEST_CANVAS.0,
                    WINDOW_TEST_CANVAS.1,
                    WINDOW_TEST_FPS,
                    WINDOW_TEST_SOURCE_SEC
                ),
                "-vf",
                "geq=lum='2*(N-64*floor(N/64))+32*floor(X/32)+96*floor(Y/32)':cb=128:cr=128",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-crf",
                "0",
                "-preset",
                "ultrafast",
            ])
            .arg(path)
            .output();

        matches!(built, Ok(built) if built.status.success()) && path.exists()
    }

    /// The counter source as an asset the builders will accept.
    fn frame_counter_asset(path: &std::path::Path, id: &str) -> Asset {
        use crate::core::assets::VideoInfo;

        let mut asset = Asset::new_video(
            id,
            &path.to_string_lossy(),
            VideoInfo {
                width: WINDOW_TEST_CANVAS.0,
                height: WINDOW_TEST_CANVAS.1,
                ..VideoInfo::default()
            },
        )
        .with_duration(WINDOW_TEST_SOURCE_SEC)
        .with_file_size(1_000_000);
        asset.id = id.to_string();
        asset
    }

    /// Renders one sequence through the real builder and decodes its luma.
    ///
    /// Gray is the Y plane verbatim for a `yuv420p` file, so nothing is converted
    /// on the way out and a comparison of these bytes is a comparison of the
    /// frames themselves.
    fn render_luma_frames(
        ffmpeg: &std::path::Path,
        output: &std::path::Path,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        start_time: Option<f64>,
        end_time: Option<f64>,
    ) -> Vec<Vec<u8>> {
        let settings = windowed_render_settings(output.to_path_buf(), start_time, end_time);
        let args = build_complex_filter_args_with_audio_info(
            sequence,
            assets,
            effects,
            &HashMap::new(),
            &settings,
        )
        .expect("the windowed builder must produce a filtergraph");

        let mut render = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut render);
        let result = render
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .expect("run ffmpeg");
        assert!(
            result.status.success(),
            "ffmpeg refused the builder's own window graph: {}\n{args:?}",
            String::from_utf8_lossy(&result.stderr)
        );

        let mut decode = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut decode);
        let decoded = decode
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(output)
            .args(["-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output()
            .expect("decode the render");
        assert!(decoded.status.success(), "the render must decode");

        let frame_bytes = WINDOW_TEST_CANVAS.0 as usize * WINDOW_TEST_CANVAS.1 as usize;
        decoded
            .stdout
            .chunks_exact(frame_bytes)
            .map(<[u8]>::to_vec)
            .collect()
    }

    /// Asserts every window of one fixture is a verbatim slice of its full render.
    fn assert_windows_slice_the_full_render(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        fixture: &str,
        sequence: &Sequence,
        assets: &HashMap<String, Asset>,
        effects: &HashMap<String, Effect>,
        windows: &[(&str, f64, f64)],
    ) {
        let full = render_luma_frames(
            ffmpeg,
            &dir.join(format!("{fixture}-full.mp4")),
            sequence,
            assets,
            effects,
            None,
            None,
        );
        assert!(
            !full.is_empty(),
            "the full render of '{fixture}' produced no frames"
        );
        // A fixture whose every frame is one flat colour proves nothing about
        // geometry: a zoom, a pan or a composite offset would all be invisible
        // in it, and the comparisons below would pass on phase alone. The black
        // tail is the one fixture that is *supposed* to be flat.
        assert!(
            fixture == "tail"
                || full
                    .iter()
                    .any(|frame| frame.iter().any(|pixel| *pixel != frame[0])),
            "the full render of '{fixture}' carries no spatial detail at all"
        );

        let timeline_frames = (sequence.output_duration() * WINDOW_TEST_FPS).round() as i64;

        for (case, start_sec, end_sec) in windows {
            let started = std::time::Instant::now();
            // The same snap the builder performs, spelled out here so the
            // expectation is derived independently of the code under test.
            let first_frame =
                ((start_sec * WINDOW_TEST_FPS).round() as i64).clamp(0, timeline_frames);
            let last_frame = ((end_sec * WINDOW_TEST_FPS).round() as i64)
                .clamp(0, timeline_frames)
                .max(first_frame + 1);

            let windowed = render_luma_frames(
                ffmpeg,
                &dir.join(format!("{fixture}-{case}.mp4")),
                sequence,
                assets,
                effects,
                Some(*start_sec),
                Some(*end_sec),
            );

            assert_eq!(
                windowed.len() as i64,
                last_frame - first_frame,
                "[{fixture}/{case}] the window must hold exactly the frames it spans"
            );

            for (offset, frame) in windowed.iter().enumerate() {
                let source_index = first_frame as usize + offset;
                assert!(
                    source_index < full.len(),
                    "[{fixture}/{case}] the full render is only {} frames long, \
                     but the window reaches frame {source_index}",
                    full.len()
                );
                // Reported by hand rather than with `assert_eq!`: the frames are
                // several thousand bytes each, and a dump of two of them buries
                // the one number that says what went wrong.
                let reference = &full[source_index];
                if frame != reference {
                    let pixel = frame
                        .iter()
                        .zip(reference.iter())
                        .position(|(left, right)| left != right)
                        .unwrap_or(0);
                    panic!(
                        "[{fixture}/{case}] window frame {offset} is not full-render \
                         frame {source_index}: they first differ at pixel {pixel}, \
                         {} against {}",
                        frame[pixel], reference[pixel]
                    );
                }
            }

            eprintln!(
                "[{fixture}/{case}] {} frames from {first_frame} matched in {:?}",
                windowed.len(),
                started.elapsed()
            );
        }
    }

    /// Feature: Windowed render
    /// Scenario: a window is byte-for-byte the same frames as the full render
    ///
    /// The whole contract of a range render in one assertion: the file it writes
    /// must be indistinguishable from the corresponding frames of a render of
    /// the whole timeline. Every fixture below is a graph shape where "just seek
    /// past the front of it" and "build the graph at the window" can disagree —
    /// a cut, a cross dissolve, a composite, a gap, an animated clip, a burnt-in
    /// caption, and a bound that does not sit on the frame grid.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test -p openreelio --features gui --lib -- --ignored \
    ///     a_windowed_render_is_byte_identical
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_windowed_render_is_byte_identical_to_the_same_frames_of_a_full_render() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{
            Clip, KeyframeInterpolation, SequenceFormat, Track, Transform, TransformKeyframe,
        };
        use crate::core::Point2D;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("counter.mp4");
        if !write_frame_counter_source(&ffmpeg, &source) {
            skip_without_ffmpeg("ffmpeg could not build the frame counter fixture");
            return;
        }

        let mut assets = HashMap::new();
        assets.insert(
            "counter".to_string(),
            frame_counter_asset(&source, "counter"),
        );
        let no_effects: HashMap<String, Effect> = HashMap::new();

        let square_canvas = || {
            let mut format = SequenceFormat::youtube_1080();
            format.canvas.width = WINDOW_TEST_CANVAS.0;
            format.canvas.height = WINDOW_TEST_CANVAS.1;
            format
        };

        let placed = |id: &str, source_in: f64, source_out: f64, at: f64| {
            let mut clip = Clip::new("counter")
                .with_source_range(source_in, source_out)
                .place_at(at);
            clip.id = id.to_string();
            clip
        };

        // (a) mid-clip, (b) exactly on a cut, (h) off the frame grid.
        {
            let mut sequence = Sequence::new("Cuts", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            track.add_clip(placed("cut0", 0.0, 2.0, 0.0));
            track.add_clip(placed("cut1", 3.0, 5.0, 2.0));
            track.add_clip(placed("cut2", 6.0, 8.0, 4.0));
            sequence.add_track(track);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "cuts",
                &sequence,
                &assets,
                &no_effects,
                &[
                    ("a-mid-clip", 0.5, 1.5),
                    ("b-on-a-cut", 2.0, 4.0),
                    ("h-off-grid", 2.017, 4.004),
                ],
            );
        }

        // Input pruning: a window over the last of six clips opens only that one
        // clip's file, and the result is still byte-identical to the full render.
        {
            let mut sequence = Sequence::new("Pruned", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            for i in 0..6u32 {
                track.add_clip(placed(&format!("prune{i}"), 0.0, 2.0, 2.0 * f64::from(i)));
            }
            sequence.add_track(track);

            // The window sits inside the sixth clip (10.0-12.0), so the five in
            // front of it must never be opened.
            let probe_args = build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &no_effects,
                &HashMap::new(),
                &windowed_render_settings(
                    dir.path().join("prune-probe.mp4"),
                    Some(10.0),
                    Some(11.0),
                ),
            )
            .expect("the pruning fixture must build");
            assert_eq!(
                probe_args.iter().filter(|arg| *arg == "-i").count(),
                1,
                "only the clip inside the window is opened: {probe_args:?}"
            );

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "pruned",
                &sequence,
                &assets,
                &no_effects,
                &[("last-of-six", 10.0, 11.0)],
            );
        }

        // (e) over a black gap between two clips.
        {
            let mut sequence = Sequence::new("Gap", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            track.add_clip(placed("gap0", 0.0, 2.0, 0.0));
            track.add_clip(placed("gap1", 3.0, 5.0, 4.0));
            sequence.add_track(track);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "gap",
                &sequence,
                &assets,
                &no_effects,
                &[("e-over-a-gap", 1.5, 4.5)],
            );
        }

        // (c) straddling a cross dissolve.
        {
            let mut sequence = Sequence::new("Dissolve", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            let mut outgoing = placed("xf0", 1.0, 4.0, 0.0);
            let dissolve = one_second_dissolve("window-dissolve");
            outgoing.effects.push(dissolve.id.clone());
            track.add_clip(outgoing);
            track.add_clip(placed("xf1", 5.0, 8.0, 3.0));
            // A plain clip after the pair, so a window can sit entirely past the
            // boundary and the plan has to lose it.
            track.add_clip(placed("xf2", 9.0, 11.0, 6.0));
            sequence.add_track(track);

            let mut effects = HashMap::new();
            effects.insert(dissolve.id.clone(), dissolve);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "dissolve",
                &sequence,
                &assets,
                &effects,
                &[
                    ("c-through-a-blend", 2.0, 4.0),
                    ("c-after-a-blend", 4.0, 6.0),
                    // Both sides of the boundary are outside these windows, so
                    // the plan entry has to go with them: an entry whose clips
                    // never arrive fails the stitch outright.
                    ("c-before-the-blend", 0.5, 1.5),
                    ("c-past-the-blend", 6.5, 7.5),
                ],
            );
        }

        // (d) inside a picture-in-picture overlap.
        {
            let mut sequence = Sequence::new("Pip", square_canvas());
            sequence.tracks.clear();
            let mut overlay_track = Track::new_video("V2");
            let mut overlay = placed("pip-top", 6.0, 8.0, 2.0);
            overlay.transform.scale = Point2D::new(0.5, 0.5);
            overlay.transform.position = Point2D::new(0.7, 0.3);
            overlay_track.add_clip(overlay);
            let mut base_track = Track::new_video("V1");
            base_track.add_clip(placed("pip-base", 0.0, 6.0, 0.0));
            // A clip after the composite, so a window can sit entirely past it.
            base_track.add_clip(placed("pip-after", 9.0, 11.0, 6.0));
            // Track 0 is the topmost, so the overlay track goes in first.
            sequence.add_track(overlay_track);
            sequence.add_track(base_track);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "pip",
                &sequence,
                &assets,
                &no_effects,
                &[
                    ("d-inside-a-composite", 2.5, 4.5),
                    // The whole composite is outside this window. A group that
                    // arrives with fewer layers than the plan promised fails the
                    // fold, so the plan has to lose the group whole.
                    ("d-past-the-composite", 6.5, 7.5),
                ],
            );
        }

        // (f) opening partway through a Ken Burns move.
        {
            let mut sequence = Sequence::new("KenBurns", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            let mut moved = placed("kb0", 0.0, 4.0, 0.0);
            moved.motion_keyframes = vec![
                TransformKeyframe {
                    time_offset: 0.0,
                    transform: Transform {
                        scale: Point2D::new(1.0, 1.0),
                        ..Transform::default()
                    },
                    interpolation: KeyframeInterpolation::Linear,
                },
                TransformKeyframe {
                    time_offset: 4.0,
                    transform: Transform {
                        scale: Point2D::new(1.8, 1.8),
                        position: Point2D::new(0.35, 0.65),
                        ..Transform::default()
                    },
                    interpolation: KeyframeInterpolation::Linear,
                },
            ];
            track.add_clip(moved);
            sequence.add_track(track);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "kenburns",
                &sequence,
                &assets,
                &no_effects,
                &[("f-mid-animation", 1.0, 3.0)],
            );
        }

        // A window over the black tail past the last picture. Nothing survives
        // the prune, and what a full render draws there is black.
        {
            let mut sequence = Sequence::new("Tail", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            track.add_clip(placed("tail0", 0.0, 4.0, 0.0));
            // An adjustment layer with no effects draws nothing but still
            // occupies the timeline, which is what puts black after the clip.
            let mut spacer = Clip::adjustment_layer(4.0).place_at(6.0);
            spacer.id = "tail-spacer".to_string();
            track.add_clip(spacer);
            sequence.add_track(track);

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "tail",
                &sequence,
                &assets,
                &no_effects,
                &[("black-tail", 6.5, 8.5)],
            );
        }

        // (g) over a burnt-in caption.
        {
            let mut sequence = Sequence::new("Caption", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            track.add_clip(placed("cap-base", 0.0, 4.0, 0.0));
            sequence.add_track(track);

            let mut caption_track = Track::new_caption("Captions");
            let mut caption = Clip::new("counter")
                .with_source_range(0.0, 2.0)
                .place_at(1.0);
            caption.id = "cap0".to_string();
            caption.label = Some("WINDOW".to_string());
            caption_track.add_clip(caption);
            sequence.add_track(caption_track);

            // Guard against a vacuous case: if the caption never reached the
            // graph, this fixture would just be the plain clip and would prove
            // nothing about rebasing an `enable` gate.
            let probe_args = build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &no_effects,
                &HashMap::new(),
                &windowed_render_settings(
                    dir.path().join("caption-probe.mp4"),
                    Some(1.5),
                    Some(3.5),
                ),
            )
            .expect("the caption fixture must build");
            let probe_graph = filter_complex_of(&probe_args);
            assert!(
                probe_graph.contains("drawtext"),
                "the caption must be burnt in for this case to mean anything: {probe_graph}"
            );
            assert!(
                // The caption runs 1.0-3.0s and the window opens at 1.5s, so
                // it is already on screen when the render starts and leaves it
                // 1.5s in. Both bounds are the window's clock, not the timeline's.
                probe_graph.contains("enable='between(t,0.000000,1.500000)'"),
                "the caption's gate must be expressed in the window's own clock: {probe_graph}"
            );

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "caption",
                &sequence,
                &assets,
                &no_effects,
                &[("g-over-a-caption", 1.5, 3.5)],
            );
        }

        // A caption that ended before the window opened must not be drawn on the
        // window's first frame. Its rebased bounds are both negative, and
        // `between` is inclusive, so a naive `.max(0.0)` on the end would gate it
        // as `between(t,0,0)` — true at t=0. The preview cache renders
        // consecutive windows, so that bug flashes every earlier caption onto the
        // first frame of every later segment.
        {
            let mut sequence = Sequence::new("CaptionBeforeWindow", square_canvas());
            sequence.tracks.clear();
            let mut track = Track::new_video("V1");
            track.add_clip(placed("capfront-base", 0.0, 8.0, 0.0));
            sequence.add_track(track);

            let mut caption_track = Track::new_caption("Captions");
            let mut caption = Clip::new("counter")
                .with_source_range(0.0, 1.0)
                .place_at(1.0);
            caption.id = "capfront0".to_string();
            caption.label = Some("GONE".to_string());
            caption_track.add_clip(caption);
            sequence.add_track(caption_track);

            // The window opens at 5.0s, long after the caption left the screen at
            // 2.0s, so the graph must carry no gate on it at all — and in
            // particular not the always-on `between(t,0.000000,0.000000)`.
            let probe_args = build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &no_effects,
                &HashMap::new(),
                &windowed_render_settings(
                    dir.path().join("caption-front-probe.mp4"),
                    Some(5.0),
                    Some(7.0),
                ),
            )
            .expect("the caption fixture must build");
            let probe_graph = filter_complex_of(&probe_args);
            assert!(
                !probe_graph.contains("between(t,0.000000,0.000000)"),
                "a caption that ended before the window must not be gated on: {probe_graph}"
            );
            assert!(
                !probe_graph.contains("drawtext"),
                "a caption that ended before the window must not be drawn: {probe_graph}"
            );

            assert_windows_slice_the_full_render(
                &ffmpeg,
                dir.path(),
                "caption-before-window",
                &sequence,
                &assets,
                &no_effects,
                &[("caption-in-front", 5.0, 7.0)],
            );
        }
    }

    /// Feature: Windowed render
    /// Scenario: a real render of a window past every audio branch still muxes
    ///
    /// The string assertion elsewhere says the silence reaches the graph; this
    /// hands the graph to a real FFmpeg, because a source spliced in at the wrong
    /// point of a filtergraph is a syntax error rather than a wrong picture.
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_real_windowed_render_past_every_audio_branch_still_writes_sound() {
        use crate::core::assets::VideoInfo;
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("with-sound.mp4");

        let mut build = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut build);
        let built = build
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "color=c=black:s={}x{}:r={}:d=12",
                    WINDOW_TEST_CANVAS.0, WINDOW_TEST_CANVAS.1, WINDOW_TEST_FPS
                ),
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=12",
                "-pix_fmt",
                "yuv420p",
                "-c:v",
                "libx264",
                "-crf",
                "0",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&source)
            .output();
        let Ok(built) = built else {
            skip_without_ffmpeg("ffmpeg could not be launched");
            return;
        };
        if !built.status.success() || !source.exists() {
            skip_without_ffmpeg("ffmpeg could not build the sound fixture");
            return;
        }

        let mut sequence = Sequence::new("Silence", SequenceFormat::youtube_1080());
        sequence.tracks.clear();
        let mut track = Track::new_video("V1");
        let mut audible = Clip::new("sound").with_source_range(0.0, 2.0).place_at(0.0);
        audible.id = "audible".to_string();
        track.add_clip(audible);
        // The only clip inside the window is muted, so the mix has nothing left.
        let mut silent = Clip::new("sound").with_source_range(4.0, 8.0).place_at(5.0);
        silent.id = "silent".to_string();
        silent.audio.muted = true;
        track.add_clip(silent);
        sequence.add_track(track);

        let mut asset = Asset::new_video(
            "sound",
            &source.to_string_lossy(),
            VideoInfo {
                width: WINDOW_TEST_CANVAS.0,
                height: WINDOW_TEST_CANVAS.1,
                ..VideoInfo::default()
            },
        )
        .with_duration(12.0)
        .with_file_size(1_000_000);
        asset.id = "sound".to_string();
        let mut assets = HashMap::new();
        assets.insert("sound".to_string(), asset);

        let mut audio_info = HashMap::new();
        audio_info.insert(
            "sound".to_string(),
            AssetAudioInfo {
                has_audio: true,
                source_dimensions: Some(WINDOW_TEST_CANVAS),
                source_duration_sec: Some(12.0),
            },
        );

        let output = dir.path().join("silence-window.mp4");
        let args = build_complex_filter_args_with_audio_info(
            &sequence,
            &assets,
            &HashMap::new(),
            &audio_info,
            &windowed_render_settings(output.clone(), Some(6.0), Some(8.0)),
        )
        .expect("the silence fallback must build a filtergraph");

        let mut render = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut render);
        let result = render
            .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
            .args(&args)
            .output()
            .expect("run ffmpeg");
        assert!(
            result.status.success(),
            "ffmpeg refused the silence fallback graph: {}\n{args:?}",
            String::from_utf8_lossy(&result.stderr)
        );

        let mut decode = std::process::Command::new(&ffmpeg);
        crate::core::process::configure_std_command(&mut decode);
        let decoded = decode
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(&output)
            .args(["-vn", "-f", "s16le", "-ac", "1", "-ar", "48000", "-"])
            .output()
            .expect("decode the render's audio");
        assert!(
            decoded.status.success() && !decoded.stdout.is_empty(),
            "the window must still carry an audio stream"
        );
        assert!(
            decoded
                .stdout
                .chunks_exact(2)
                .all(|sample| sample == [0, 0]),
            "the audio in this window is silence, not the clip before it"
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
            max_width: None,
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
            max_width: None,
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
            max_width: None,
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
            max_width: None,
        };
        assert!(settings.validate().is_ok());
    }

    /// Feature: Frame Export Settings
    /// Scenario: should reject a zero maximum width
    #[test]
    fn frame_export_settings_should_reject_zero_max_width() {
        let settings = FrameExportSettings {
            time_sec: 1.0,
            format: ImageFormat::Png,
            output_path: std::env::temp_dir().join("frame.png"),
            quality: None,
            max_width: Some(0),
        };
        assert!(settings.validate().is_err());
    }

    /// Builds a one-clip sequence plus an asset whose `uri` no longer resolves
    /// but whose `relative_path` still points at `relative` inside the project.
    ///
    /// This is the shape a project takes after it is moved or copied: the URI
    /// records where the media was first seen, the relative path records where
    /// it lives now.
    fn relocated_project_fixture(
        relative: &str,
    ) -> (Sequence, std::collections::HashMap<String, Asset>) {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Relocated", SequenceFormat::youtube_1080());
        let mut video_track = Track::new_video("Video 1");
        video_track.add_clip(
            Clip::new("video_asset")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(video_track);

        let mut asset = Asset::new_video(
            "clip.mp4",
            "/previous/machine/clip.mp4",
            VideoInfo::default(),
        )
        .with_duration(5.0)
        .with_relative_path(relative);
        asset.id = "video_asset".to_string();

        let mut assets = std::collections::HashMap::new();
        assets.insert("video_asset".to_string(), asset);

        (sequence, assets)
    }

    /// Feature: Frame export on a relocated project
    /// Scenario: should resolve media through the project root, not the stale URI
    #[tokio::test]
    async fn export_frame_should_resolve_media_relative_to_the_project() {
        let project = tempfile::tempdir().expect("temp project");
        let media_dir = project.path().join("media");
        std::fs::create_dir_all(&media_dir).expect("create media dir");
        std::fs::write(media_dir.join("clip.mp4"), b"").expect("write media");

        let (sequence, assets) = relocated_project_fixture("media/clip.mp4");
        let settings = FrameExportSettings {
            time_sec: 1.0,
            format: ImageFormat::Png,
            output_path: project.path().join("frame.png"),
            quality: None,
            max_width: None,
        };

        let error = test_export_engine()
            .export_frame(&sequence, &assets, project.path(), &settings)
            .await
            .expect_err("the fixture FFmpeg path does not exist, so the run cannot succeed");

        // The run gets past asset resolution and fails only on the fake FFmpeg
        // binary; the stale URI would have stopped it before that.
        assert!(
            !error.to_string().contains("Asset file not found"),
            "media under the project root must resolve, got: {error}"
        );
    }

    /// Feature: Frame export on a relocated project
    /// Scenario: should name the resolved path when the media is genuinely missing
    #[tokio::test]
    async fn export_frame_should_report_the_resolved_path_when_media_is_missing() {
        let project = tempfile::tempdir().expect("temp project");
        let (sequence, assets) = relocated_project_fixture("media/clip.mp4");
        let settings = FrameExportSettings {
            time_sec: 1.0,
            format: ImageFormat::Png,
            output_path: project.path().join("frame.png"),
            quality: None,
            max_width: None,
        };

        let error = test_export_engine()
            .export_frame(&sequence, &assets, project.path(), &settings)
            .await
            .expect_err("the media file was never created");

        let message = error.to_string();
        assert!(message.contains("Asset file not found"), "got: {message}");
        assert!(
            message.contains("clip.mp4") && !message.contains("previous"),
            "the message must name the path that was actually looked up, got: {message}"
        );
    }

    /// Feature: Frame Scaling
    /// Scenario: should keep native size when no maximum width is requested
    #[test]
    fn scaled_frame_dimensions_should_keep_native_size_without_limit() {
        assert_eq!(scaled_frame_dimensions(1920, 1080, None), (1920, 1080));
    }

    /// Feature: Frame Scaling
    /// Scenario: should never upscale narrower sources
    #[test]
    fn scaled_frame_dimensions_should_not_upscale() {
        assert_eq!(scaled_frame_dimensions(640, 360, Some(1280)), (640, 360));
    }

    /// Feature: Frame Scaling
    /// Scenario: should preserve aspect ratio with an even height
    #[test]
    fn scaled_frame_dimensions_should_preserve_aspect_with_even_height() {
        assert_eq!(scaled_frame_dimensions(1920, 1080, Some(1280)), (1280, 720));
        assert_eq!(scaled_frame_dimensions(3840, 2160, Some(1280)), (1280, 720));
        // 1280 * 240 / 320 = 960 exactly.
        assert_eq!(scaled_frame_dimensions(320, 240, Some(160)), (160, 120));
        // 100 * 57 / 111 = 51.35 -> nearest even is 52.
        assert_eq!(scaled_frame_dimensions(111, 57, Some(100)), (100, 52));
    }

    /// Feature: Frame Scaling
    /// Scenario: should stay at a valid minimum height for extreme ratios
    #[test]
    fn scaled_frame_dimensions_should_clamp_height_to_two() {
        assert_eq!(scaled_frame_dimensions(4000, 10, Some(2)), (2, 2));
    }

    /// Feature: Frame Scaling
    /// Scenario: should tolerate unknown source dimensions
    #[test]
    fn scaled_frame_dimensions_should_tolerate_zero_source() {
        assert_eq!(scaled_frame_dimensions(0, 0, Some(1280)), (0, 0));
    }

    /// Feature: Timeline To Source Mapping
    /// Scenario: should account for placement, source in-point and speed
    #[test]
    fn clip_source_time_at_should_map_timeline_to_source() {
        let mut clip = Clip::new("asset_1");
        clip.place.timeline_in_sec = 10.0;
        clip.range.source_in_sec = 2.0;
        clip.speed = 2.0;

        assert_eq!(clip_source_time_at(&clip, 10.0), 2.0);
        assert_eq!(clip_source_time_at(&clip, 12.0), 6.0);
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
        assert_eq!(AudioExportFormat::M4a.extension(), "m4a");
        assert_eq!(AudioExportFormat::Flac.extension(), "flac");
        assert_eq!(AudioExportFormat::Ogg.extension(), "ogg");
    }

    /// Feature: Audio Export Format
    /// Scenario: should return correct FFmpeg codec for each format
    #[test]
    fn audio_export_format_should_return_correct_codec() {
        assert_eq!(AudioExportFormat::Wav.codec(), "pcm_s16le");
        assert_eq!(AudioExportFormat::Mp3.codec(), "libmp3lame");
        assert_eq!(AudioExportFormat::M4a.codec(), "aac");
        assert_eq!(AudioExportFormat::Flac.codec(), "flac");
        assert_eq!(AudioExportFormat::Ogg.codec(), "libopus");
    }

    /// Feature: Audio Export Format
    /// Scenario: should return default bitrate only for lossy formats
    #[test]
    fn audio_export_format_should_return_default_bitrate_only_for_lossy() {
        assert!(AudioExportFormat::Wav.default_bitrate().is_none());
        assert!(AudioExportFormat::Flac.default_bitrate().is_none());
        assert_eq!(AudioExportFormat::Mp3.default_bitrate(), Some("320k"));
        assert_eq!(AudioExportFormat::M4a.default_bitrate(), Some("256k"));
        assert_eq!(AudioExportFormat::Ogg.default_bitrate(), Some("192k"));
    }

    /// Feature: Audio Export Format
    /// Scenario: should serialize/deserialize as snake_case
    #[test]
    fn audio_export_format_should_roundtrip_json() {
        let formats = vec![
            AudioExportFormat::Wav,
            AudioExportFormat::Mp3,
            AudioExportFormat::M4a,
            AudioExportFormat::Flac,
            AudioExportFormat::Ogg,
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
            format: AudioExportFormat::M4a,
            output_path: PathBuf::from("/tmp/audio.m4a"),
            bitrate: Some("256k".to_string()),
            sample_rate: Some(44100),
            start_time: None,
            end_time: None,
        };
        let export = settings.to_export_settings();

        assert_eq!(export.audio_codec, AudioCodec::Aac);
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
            format: AudioExportFormat::Ogg,
            output_path: PathBuf::from("/tmp/audio.ogg"),
            bitrate: None,
            sample_rate: None,
            start_time: None,
            end_time: None,
        };
        let export = settings.to_export_settings();
        assert_eq!(export.audio_bitrate, Some("192k".to_string()));
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

    #[test]
    fn normalize_output_time_range_should_clamp_negative_start_time() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Audio", SequenceFormat::youtube_1080());
        let mut track = Track::new_audio("Audio 1");
        track.add_clip(
            Clip::new("asset-1")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(track);
        let (start, end) = normalize_output_time_range(&sequence, Some(-5.0), Some(4.0)).unwrap();

        assert_eq!(start, Some(0.0));
        assert_eq!(end, Some(4.0));
    }

    #[test]
    fn normalize_output_time_range_should_reject_start_beyond_duration() {
        use crate::core::timeline::{Clip, SequenceFormat, Track};

        let mut sequence = Sequence::new("Audio", SequenceFormat::youtube_1080());
        let mut track = Track::new_audio("Audio 1");
        track.add_clip(
            Clip::new("asset-1")
                .with_source_range(0.0, 5.0)
                .place_at(0.0),
        );
        sequence.add_track(track);

        let result = normalize_output_time_range(&sequence, Some(10.0), Some(12.0));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("outside the sequence duration"));
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

    // -------------------------------------------------------------------------
    // Animated motion keyframes
    // -------------------------------------------------------------------------

    /// A clip carrying `keyframes` as `(time_offset, transform, hold)`.
    fn motion_clip(keyframes: &[(f64, Transform, bool)]) -> Clip {
        use crate::core::timeline::{KeyframeInterpolation, TransformKeyframe};

        let mut clip = Clip::new("asset").with_source_range(0.0, 3.0).place_at(0.0);
        clip.id = "motion-clip".to_string();
        clip.motion_keyframes = keyframes
            .iter()
            .map(|(time_offset, transform, hold)| TransformKeyframe {
                time_offset: *time_offset,
                transform: transform.clone(),
                interpolation: if *hold {
                    KeyframeInterpolation::Hold
                } else {
                    KeyframeInterpolation::Linear
                },
            })
            .collect();
        clip
    }

    /// A transform with the fields motion actually animates.
    fn motion_transform(position: (f64, f64), scale: (f64, f64), rotation_deg: f64) -> Transform {
        use crate::core::Point2D;

        Transform {
            position: Point2D::new(position.0, position.1),
            scale: Point2D::new(scale.0, scale.1),
            rotation_deg,
            anchor: Point2D::center(),
        }
    }

    /// The animated composition a clip's keyframes produce on a given canvas.
    fn animated_motion_graph(
        clip: &Clip,
        source: (u32, u32),
        canvas: (u32, u32),
        fps: f64,
        slot_sec: f64,
        head_sec: f64,
    ) -> String {
        let track = super::super::transform_layout::resolve_clip_motion_track(
            source.0, source.1, canvas.0, canvas.1, clip, head_sec,
        )
        .expect("clip has motion keyframes");

        let mut graph = String::new();
        append_animated_video_transform_composition(
            &mut graph, "0:v", "out", &track, 1.0, slot_sec, canvas.0, canvas.1, fps, "yuv420p",
            false,
        );
        graph
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: a pan-and-zoom clip is composited by expression, not by constant
    ///
    /// The static composition bakes every number into the graph, so it can only
    /// draw one picture. Animating means the frame size and the overlay corner
    /// both have to become expressions FFmpeg re-reads each frame.
    #[test]
    fn an_animated_clip_scales_and_overlays_by_expression() {
        let clip = motion_clip(&[
            (0.0, motion_transform((0.3, 0.5), (0.5, 0.5), 0.0), false),
            (3.0, motion_transform((0.7, 0.5), (1.0, 1.0), 0.0), false),
        ]);
        let graph = animated_motion_graph(&clip, (640, 360), (1280, 720), 30.0, 3.0, 0.0);

        assert!(
            graph.contains("scale=w='if(lt(t,0),640") && graph.contains(":eval=frame"),
            "the frame size must be a per-frame expression: {graph}"
        );
        assert!(
            graph.contains("overlay=x='") && graph.contains("*overlay_w"),
            "the overlay corner must be an expression reading the staged size: {graph}"
        );
        assert!(
            graph.contains(":eval=frame:format=yuv444,"),
            "the overlay must re-read its expressions per frame: {graph}"
        );
        assert!(
            graph.contains("format=yuva420p"),
            "the staged clip must carry alpha or overlay silently freezes its size: {graph}"
        );
        assert!(
            !graph.contains("rotate="),
            "the animated path never rotates: {graph}"
        );
        assert!(
            graph.contains(
                "setsar=1,fps=30,trim=end_frame=90,setpts=PTS-STARTPTS,format=yuv420p[out];"
            ),
            "the segment must end in the same shape a static one does: {graph}"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: `hold` steps instead of ramping
    ///
    /// `getClipMotionTransformAtTime` returns the *start* keyframe's transform
    /// for a whole `hold` segment, so the expression must carry a constant over
    /// that span rather than a slope.
    #[test]
    fn a_held_motion_segment_emits_a_constant_not_a_ramp() {
        let held = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.5, 0.5), 0.0), true),
            (1.5, motion_transform((0.5, 0.5), (1.0, 1.0), 0.0), false),
            (3.0, motion_transform((0.5, 0.5), (1.0, 1.0), 0.0), false),
        ]);
        let graph = animated_motion_graph(&held, (640, 360), (1280, 720), 30.0, 3.0, 0.0);

        assert!(
            graph.contains("if(lt(t,1.5),640,"),
            "a held segment must carry its start value flat across the span: {graph}"
        );
        assert!(
            !graph.contains("*(t-0)/1.5"),
            "a held segment must not interpolate: {graph}"
        );
    }

    /// Feature: Keyframed motion across a transition handle
    /// Scenario: keyframe times move into branch time
    ///
    /// Every branch ends in `setpts=PTS-STARTPTS`, so `t` is measured from the
    /// start of the *handle*, not the start of the clip. Leaving the keyframe
    /// times alone would run the whole move early by the handle's length.
    #[test]
    fn motion_keyframe_times_shift_into_branch_time_by_the_head_handle() {
        let clip = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.5, 0.5), 0.0), false),
            (2.0, motion_transform((0.5, 0.5), (1.0, 1.0), 0.0), false),
        ]);

        let unhandled = animated_motion_graph(&clip, (640, 360), (1280, 720), 30.0, 3.0, 0.0);
        assert!(
            unhandled.contains("if(lt(t,0),640,if(lt(t,2),640"),
            "without a handle the move starts at the clip's own zero: {unhandled}"
        );

        let handled = animated_motion_graph(&clip, (640, 360), (1280, 720), 30.0, 3.0, 0.5);
        assert!(
            handled.contains("if(lt(t,0.5),640,if(lt(t,2.5),640"),
            "a half-second handle must push every keyframe time out by it: {handled}"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: motion that turns the picture keeps the static composite
    ///
    /// `rotate` never re-configures when its input changes size, so an animated
    /// `scale` feeding it freezes the picture at its first frame's dimensions —
    /// silently, with no FFmpeg warning. Until that is solved a rotating move
    /// composites once and the export says so.
    #[test]
    fn rotating_motion_is_refused_by_the_animated_path() {
        let rotating = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.5, 0.5), 0.0), false),
            (3.0, motion_transform((0.5, 0.5), (1.0, 1.0), 15.0), false),
        ]);
        assert!(
            !clip_motion_renders_animated(&rotating),
            "a move that rotates must not take the animated path"
        );

        let panning = motion_clip(&[
            (0.0, motion_transform((0.3, 0.5), (1.0, 1.0), 0.0), false),
            (3.0, motion_transform((0.7, 0.5), (1.0, 1.0), 0.0), false),
        ]);
        assert!(
            clip_motion_renders_animated(&panning),
            "a pan must take the animated path"
        );

        let single = motion_clip(&[(0.0, motion_transform((0.3, 0.5), (1.0, 1.0), 0.0), false)]);
        assert!(
            !clip_motion_renders_animated(&single),
            "one keyframe describes a still picture, not a move"
        );

        let unmoving = motion_clip(&[
            (0.0, motion_transform((0.3, 0.5), (1.0, 1.0), 0.0), false),
            (3.0, motion_transform((0.3, 0.5), (1.0, 1.0), 0.0), false),
        ]);
        assert!(
            !clip_motion_renders_animated(&unmoving),
            "keyframes that agree describe a still picture too"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: a clip with no motion emits exactly the graph it always did
    ///
    /// The animated path is additive. A clip without keyframes must come out of
    /// the composer byte-for-byte as before, or every existing render changes
    /// under a feature nobody switched on.
    #[test]
    fn a_clip_without_motion_keeps_the_static_composition_byte_for_byte() {
        use crate::core::Point2D;

        let transform = Transform {
            position: Point2D::new(0.5, 0.5),
            scale: Point2D::new(0.5, 0.5),
            rotation_deg: 0.0,
            anchor: Point2D::center(),
        };
        let layout = super::super::transform_layout::compute_clip_transform_layout(
            640, 360, 1280, 720, &transform, 1.0,
        );

        let mut graph = String::new();
        append_video_transform_composition(
            &mut graph, "0:v", "out", &layout, 3.0, 1280, 720, 30.0, "yuv420p", false,
        );

        assert_eq!(
            graph,
            concat!(
                "[0:v]scale=640:360,setsar=1[out_tx];",
                "color=c=black:s=1280x720:r=30:d=3.033333,format=yuv420p[out_bg];",
                "[out_bg][out_tx]overlay=x=320:y=180:format=yuv444,setsar=1,fps=30,",
                "trim=end_frame=90,setpts=PTS-STARTPTS,format=yuv420p[out];"
            ),
            "the static composition must be untouched by the animated path"
        );

        let still = Clip::new("asset").with_source_range(0.0, 3.0).place_at(0.0);
        assert!(
            !clip_motion_renders_animated(&still),
            "a clip with no keyframes has no motion to render"
        );
    }

    // -------------------------------------------------------------------------
    // Composite chroma placement
    // -------------------------------------------------------------------------

    /// Builds a solid-white clip of `size`, encoded to a real file.
    ///
    /// Solid rather than a box on black so the lit region of a rendered frame is
    /// exactly the rectangle `overlay` placed — its corner is the measurement.
    fn solid_white_clip(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        name: &str,
        size: (u32, u32),
        duration_sec: f64,
    ) -> Option<std::path::PathBuf> {
        let path = dir.join(name);
        let mut built_cmd = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut built_cmd);
        let built = built_cmd
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "color=c=white:s={}x{}:r=30:d={duration_sec}",
                    size.0, size.1
                ),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&path)
            .output()
            .ok()?;

        (built.status.success() && path.exists()).then_some(path)
    }

    /// Renders `graph` over `input` and hands back its frames as single-plane luma.
    fn render_composite_luma_frames(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        input: &std::path::Path,
        graph: &str,
        size: (u32, u32),
    ) -> Vec<Vec<u8>> {
        let graph_file = dir.join("graph.txt");
        std::fs::write(&graph_file, graph.trim_end_matches(';')).expect("write filtergraph");

        let mut render_cmd = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut render_cmd);
        let render = render_cmd
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(input)
            .arg("-/filter_complex")
            .arg(&graph_file)
            .args(["-map", "[out]", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output()
            .expect("run ffmpeg");

        assert!(
            render.status.success(),
            "ffmpeg refused the composite graph: {}\n{graph}",
            String::from_utf8_lossy(&render.stderr)
        );

        render
            .stdout
            .chunks_exact(size.0 as usize * size.1 as usize)
            .map(<[u8]>::to_vec)
            .collect()
    }

    /// The top-left corner of the lit region of one luma frame, if it has one.
    fn lit_corner(frame: &[u8], width: u32) -> Option<(u32, u32)> {
        let width = width as usize;
        frame
            .iter()
            .enumerate()
            .filter(|(_, luma)| **luma > 127)
            .map(|(index, _)| ((index % width) as u32, (index / width) as u32))
            .fold(None, |corner, (x, y)| match corner {
                None => Some((x, y)),
                Some((min_x, min_y)) => Some((min_x.min(x), min_y.min(y))),
            })
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: the composite can address every pixel, not every other one
    ///
    /// `overlay` composites in whatever mode it is given, and a chroma-subsampled
    /// mode cannot address an odd column or row — it floors the corner to the
    /// nearest chroma sample. So the mode has to be 4:4:4 whatever depth the
    /// output itself is written at. 4:2:2 is not enough: it subsamples
    /// horizontally, so it loses the column and keeps the row.
    #[test]
    fn the_composite_overlay_runs_in_full_chroma_at_every_output_depth() {
        let layout = ClipTransformLayout {
            scaled_width: 160,
            scaled_height: 90,
            rotation_rad: 0.0,
            bounding_width: 160,
            bounding_height: 90,
            overlay_x: 41,
            overlay_y: 27,
            opacity: 1.0,
        };

        for (pixel_format, expected_overlay) in [
            ("yuv420p", "yuv444"),
            ("yuv420p10le", "yuv444p10"),
            ("yuv422p10le", "yuv444p10"),
        ] {
            let mut graph = String::new();
            append_video_transform_composition(
                &mut graph,
                "0:v",
                "vnorm0",
                &layout,
                1.0,
                320,
                180,
                30.0,
                pixel_format,
                false,
            );

            assert!(
                graph.contains(&format!("overlay=x=41:y=27:format={expected_overlay},")),
                "a {pixel_format} export must composite in {expected_overlay}: {graph}"
            );
            for subsampled in ["format=yuv420,", "format=yuv420p10,", "format=yuv422p10,"] {
                assert!(
                    !graph.contains(subsampled),
                    "a {pixel_format} export must not composite in a subsampled mode \
                     ({subsampled}): {graph}"
                );
            }
        }
    }

    /// Feature: Transformed clips in the final render
    /// Scenario: a clip placed on an odd pixel renders on that pixel
    ///
    /// The string assertion above encodes a belief about what `overlay`'s
    /// `format` does to an odd corner. This one hands the real FFmpeg the graph
    /// the export builds and measures where the picture actually landed.
    ///
    /// Measured negative control (bundled FFmpeg 8.0.1, reproduced identically on
    /// 9.0.1; 320x180 canvas, a 160x90 clip placed at (41, 27)): the `yuv420`
    /// mode this replaced rendered the picture at (40, 26) — a whole pixel up and
    /// to the left of where the preview draws it. On a 1280x720 canvas the 10-bit
    /// `yuv422p10` mode put a clip placed at (201, 101) at (200, 101), losing the
    /// column and keeping the row, because 4:2:2 subsamples horizontally only.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored odd_pixel
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_composited_clip_lands_on_the_odd_pixel_it_was_placed_on() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (320, 180);
        const CLIP: (u32, u32) = (160, 90);
        const CORNER: (u32, u32) = (41, 27);

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        let dir = tempfile::tempdir().expect("temp dir");
        let Some(input) = solid_white_clip(&ffmpeg, dir.path(), "white.mp4", CLIP, 0.6) else {
            skip_without_ffmpeg("ffmpeg could not build the fixture");
            return;
        };

        let layout = ClipTransformLayout {
            scaled_width: CLIP.0,
            scaled_height: CLIP.1,
            rotation_rad: 0.0,
            bounding_width: CLIP.0,
            bounding_height: CLIP.1,
            overlay_x: CORNER.0 as i32,
            overlay_y: CORNER.1 as i32,
            opacity: 1.0,
        };
        assert!(
            layout.overlay_x % 2 != 0 && layout.overlay_y % 2 != 0,
            "this fixture only measures anything if the corner is odd"
        );

        let mut graph = String::new();
        append_video_transform_composition(
            &mut graph, "0:v", "out", &layout, 0.5, CANVAS.0, CANVAS.1, 30.0, "yuv420p", false,
        );

        let frames = render_composite_luma_frames(&ffmpeg, dir.path(), &input, &graph, CANVAS);
        assert!(!frames.is_empty(), "the composite must render frames");

        for (index, frame) in frames.iter().enumerate() {
            let corner = lit_corner(frame, CANVAS.0)
                .unwrap_or_else(|| panic!("frame {index} rendered no picture at all"));
            assert_eq!(
                corner, CORNER,
                "frame {index} must composite at the odd pixel it was placed on, \
                 not the nearest chroma sample"
            );
        }
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: a slow pan advances every frame instead of stalling in pairs
    ///
    /// The animated path positions `overlay` by expression, and FFmpeg evaluates
    /// those expressions per frame with no rounding of its own — so unlike the
    /// static path, whose layout pre-snaps its corner, a pan really does ask
    /// `overlay` for odd columns. In a chroma-subsampled mode it cannot give them:
    /// every second frame floors back onto the frame before it, and a move slower
    /// than two pixels a frame comes out visibly juddering.
    ///
    /// A pan of 64 pixels across 60 frames is ~1.08 px a frame, which is the
    /// regime that exposes it. Measured negative control (bundled FFmpeg 8.0.1,
    /// reproduced identically on 9.0.1): the `yuv420` mode this replaced stalled
    /// on 28 of the 59 frame transitions and reached only 32 distinct positions
    /// across 60 frames, never once landing on an odd column — the picture
    /// advanced 0, 2, 0, 2 pixels instead of one a frame. In 4:4:4 the same pan
    /// reaches all 60.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored pan_advances
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn an_animated_pan_advances_every_frame_instead_of_stalling_in_pairs() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (320, 180);
        const SOURCE: (u32, u32) = (160, 90);
        const SLOT_SEC: f64 = 2.0;
        const EXPECTED_FRAMES: usize = 60;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };

        let dir = tempfile::tempdir().expect("temp dir");
        let Some(input) = solid_white_clip(&ffmpeg, dir.path(), "white.mp4", SOURCE, 2.2) else {
            skip_without_ffmpeg("ffmpeg could not build the fixture");
            return;
        };

        // Half scale keeps the staged frame at the source's own 160x90, so the
        // pan is the only thing moving and the lit corner is the overlay corner.
        let clip = motion_clip(&[
            (0.0, motion_transform((0.4, 0.5), (0.5, 0.5), 0.0), false),
            (
                SLOT_SEC,
                motion_transform((0.6, 0.5), (0.5, 0.5), 0.0),
                false,
            ),
        ]);
        let graph = animated_motion_graph(&clip, SOURCE, CANVAS, 30.0, SLOT_SEC, 0.0);

        let frames = render_composite_luma_frames(&ffmpeg, dir.path(), &input, &graph, CANVAS);
        assert_eq!(
            frames.len(),
            EXPECTED_FRAMES,
            "the pan must fill its slot without changing the frame count"
        );

        let corners: Vec<u32> = frames
            .iter()
            .enumerate()
            .map(|(index, frame)| {
                lit_corner(frame, CANVAS.0)
                    .unwrap_or_else(|| panic!("frame {index} rendered no picture at all"))
                    .0
            })
            .collect();

        let stalled = corners.windows(2).filter(|pair| pair[0] == pair[1]).count();
        assert_eq!(
            stalled,
            0,
            "a pan of ~1.08 px a frame must advance on every frame; it stalled on \
             {stalled} of {} transitions, which is the subsampled-mode judder: {corners:?}",
            corners.len() - 1
        );

        let distinct: std::collections::HashSet<u32> = corners.iter().copied().collect();
        assert_eq!(
            distinct.len(),
            EXPECTED_FRAMES,
            "every frame of the pan must occupy its own column, got {} across {EXPECTED_FRAMES} \
             frames: {corners:?}",
            distinct.len()
        );

        let odd = corners.iter().filter(|x| *x % 2 == 1).count();
        assert!(
            odd > 0,
            "a pan that never lands on an odd column is still snapped to the chroma \
             grid: {corners:?}"
        );
    }

    /// Feature: Export preflight
    /// Scenario: motion that now renders stops warning
    ///
    /// The warning existed because the export ignored motion. Now that pan, zoom
    /// and anchor moves render, warning about them would train users to ignore
    /// the warning that still matters.
    #[test]
    fn test_motion_warning_is_silent_for_motion_the_export_now_renders() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{SequenceFormat, Track};

        let build = |rotation_deg: f64, name: &str| {
            let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
            let mut track = Track::new_video("Video 1");
            let mut clip = motion_clip(&[
                (0.0, motion_transform((0.3, 0.5), (0.5, 0.5), 0.0), false),
                (
                    3.0,
                    motion_transform((0.7, 0.5), (1.0, 1.0), rotation_deg),
                    false,
                ),
            ]);
            clip.asset_id = "video_asset".to_string();
            track.add_clip(clip);
            sequence.add_track(track);

            let video_path = create_temp_media_file(name);
            let mut assets = HashMap::new();
            // Real stored dimensions, not the `VideoInfo::default()` placeholder:
            // the placeholder means "nobody measured this", which sends the clip
            // down the unmeasurable-source fallback and would have this test
            // asserting about a warning it never meant to provoke.
            let mut video_asset = Asset::new_video(
                name,
                &video_path,
                VideoInfo {
                    width: 1280,
                    height: 720,
                    ..VideoInfo::default()
                },
            )
            .with_duration(3.0)
            .with_file_size(3_000_000);
            video_asset.id = "video_asset".to_string();
            assets.insert("video_asset".to_string(), video_asset);

            validate_export_settings(
                &sequence,
                &assets,
                &HashMap::new(),
                &ExportSettings::default(),
            )
        };

        let panning = build(0.0, "motion_pan.mp4");
        assert!(
            !panning
                .warnings
                .iter()
                .any(|warning| warning.contains("Motion keyframes")),
            "a pan-and-zoom move renders, so it must not warn: {:?}",
            panning.warnings
        );

        let rotating = build(30.0, "motion_rotate.mp4");
        assert!(
            rotating
                .warnings
                .iter()
                .any(|warning| warning.contains("Motion keyframes")),
            "a rotating move still degrades, so it must warn: {:?}",
            rotating.warnings
        );
    }

    // -------------------------------------------------------------------------
    // Animated motion, measured against real FFmpeg output
    // -------------------------------------------------------------------------

    /// A white rectangle centred on black, encoded to a real file.
    ///
    /// A file rather than `-f lavfi` so the graph under test is the only
    /// filtergraph in the command and its frames have been through a decoder,
    /// exactly as a render's would be.
    fn motion_white_box_clip(
        ffmpeg: &std::path::Path,
        dir: &std::path::Path,
        canvas: (u32, u32),
        box_size: (u32, u32),
        seconds: f64,
    ) -> Option<std::path::PathBuf> {
        let (width, height) = canvas;
        let (box_width, box_height) = box_size;
        let path = dir.join("motion-source.mp4");
        let source = format!(
            "color=c=black:s={width}x{height}:r=30:d={seconds},\
             drawbox=x={}:y={}:w={box_width}:h={box_height}:color=white:t=fill",
            (width - box_width) / 2,
            (height - box_height) / 2,
        );

        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        let built = command
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                &source,
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&path)
            .output()
            .ok()?;

        (built.status.success() && path.exists()).then_some(path)
    }

    /// Renders `graph` over `input` and hands back its frames as single-plane luma.
    fn motion_luma_frames(
        ffmpeg: &std::path::Path,
        input: &std::path::Path,
        graph: &str,
        canvas: (u32, u32),
    ) -> Vec<Vec<u8>> {
        let dir = tempfile::tempdir().expect("temp dir");
        let graph_file = dir.path().join("graph.txt");
        std::fs::write(&graph_file, graph.trim_end_matches(';')).expect("write filtergraph");

        let mut command = std::process::Command::new(ffmpeg);
        crate::core::process::configure_std_command(&mut command);
        let render = command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(input)
            .arg("-/filter_complex")
            .arg(&graph_file)
            .args(["-map", "[out]", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output()
            .expect("run ffmpeg");

        assert!(
            render.status.success(),
            "ffmpeg refused the animated graph: {}\n{graph}",
            String::from_utf8_lossy(&render.stderr)
        );

        let frame_bytes = (canvas.0 * canvas.1) as usize;
        render
            .stdout
            .chunks_exact(frame_bytes)
            .map(<[u8]>::to_vec)
            .collect()
    }

    /// White-pixel count and centroid of one luma frame.
    fn motion_white_region(frame: &[u8], width: u32) -> Option<(usize, f64, f64)> {
        motion_lit_region(frame, width, 127)
    }

    /// Count and centroid of the pixels of one luma frame above `threshold`.
    ///
    /// A translucent clip composites to a mid grey, so it has to be measured
    /// against "not black" rather than against white.
    fn motion_lit_region(frame: &[u8], width: u32, threshold: u8) -> Option<(usize, f64, f64)> {
        let lit: Vec<(usize, usize)> = frame
            .iter()
            .enumerate()
            .filter(|(_, luma)| **luma > threshold)
            .map(|(index, _)| (index % width as usize, index / width as usize))
            .collect();
        if lit.is_empty() {
            return None;
        }
        let area = lit.len();
        let sum_x: usize = lit.iter().map(|(x, _)| *x).sum();
        let sum_y: usize = lit.iter().map(|(_, y)| *y).sum();
        Some((area, sum_x as f64 / area as f64, sum_y as f64 / area as f64))
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: the rendered pixels actually move
    ///
    /// The string assertions above encode a belief about what `scale=eval=frame`
    /// and an expression `overlay` do. This one hands real FFmpeg the graph the
    /// export builds and measures the frames that come back: a zoom must grow the
    /// white region, a pan must move its centroid while holding its area, a
    /// `hold` must step rather than ramp, and a clip whose keyframes agree must
    /// not move a single pixel.
    ///
    /// The last of those is the control that makes the rest mean something: it
    /// runs the same animated code path and must still come out bit-constant.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib --features dev-full -- --ignored motion
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn animated_motion_moves_the_rendered_pixels() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (320, 180);
        const SOURCE: (u32, u32) = (320, 180);
        const FPS: f64 = 30.0;
        const SLOT_SEC: f64 = 2.0;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(input) = motion_white_box_clip(&ffmpeg, dir.path(), SOURCE, (160, 90), SLOT_SEC)
        else {
            skip_without_ffmpeg("the white-box fixture could not be encoded");
            return;
        };

        let render = |clip: &Clip| {
            let graph = animated_motion_graph(clip, SOURCE, CANVAS, FPS, SLOT_SEC, 0.0);
            motion_luma_frames(&ffmpeg, &input, &graph, CANVAS)
        };

        // --- zoom in: the white region has to grow ---------------------------
        let zooming = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.4, 0.4), 0.0), false),
            (2.0, motion_transform((0.5, 0.5), (0.9, 0.9), 0.0), false),
        ]);
        let frames = render(&zooming);
        assert_eq!(frames.len(), 60, "the slot must render every frame");
        let areas: Vec<usize> = frames
            .iter()
            .map(|frame| motion_white_region(frame, CANVAS.0).expect("lit pixels").0)
            .collect();
        assert!(
            areas.last().unwrap() > &(areas[0] * 4),
            "a 0.4x -> 0.9x zoom must grow the white region several fold: {} -> {}",
            areas[0],
            areas.last().unwrap()
        );
        assert!(
            areas.windows(2).all(|pair| pair[1] >= pair[0]),
            "a monotonic zoom must never shrink between frames: {areas:?}"
        );
        assert!(
            areas.iter().collect::<std::collections::HashSet<_>>().len() > 20,
            "a zoom must resize continuously, not in a couple of jumps: {areas:?}"
        );

        // --- pan: the centroid has to travel, the area must not --------------
        let panning = motion_clip(&[
            (0.0, motion_transform((0.3, 0.5), (0.5, 0.5), 0.0), false),
            (2.0, motion_transform((0.7, 0.5), (0.5, 0.5), 0.0), false),
        ]);
        let frames = render(&panning);
        let measured: Vec<(usize, f64, f64)> = frames
            .iter()
            .map(|frame| motion_white_region(frame, CANVAS.0).expect("lit pixels"))
            .collect();
        let (first_area, first_x, first_y) = measured[0];
        let (last_area, last_x, last_y) = *measured.last().unwrap();
        assert!(
            last_x - first_x > 90.0,
            "a 0.3 -> 0.7 pan across a 320px canvas must move the centroid ~128px: {first_x} -> {last_x}"
        );
        assert!(
            (last_y - first_y).abs() < 2.0,
            "a horizontal pan must not drift vertically: {first_y} -> {last_y}"
        );
        assert!(
            (last_area as f64 - first_area as f64).abs() / (first_area as f64) < 0.02,
            "a pan must not resize the picture: {first_area} -> {last_area}"
        );

        // --- hold: two states, not a ramp ------------------------------------
        let held = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.4, 0.4), 0.0), true),
            (1.0, motion_transform((0.5, 0.5), (0.9, 0.9), 0.0), false),
            (2.0, motion_transform((0.5, 0.5), (0.9, 0.9), 0.0), false),
        ]);
        let frames = render(&held);
        let held_areas: std::collections::BTreeSet<usize> = frames
            .iter()
            .map(|frame| motion_white_region(frame, CANVAS.0).expect("lit pixels").0)
            .collect();
        assert_eq!(
            held_areas.len(),
            2,
            "a held segment then a flat one must render exactly two sizes: {held_areas:?}"
        );

        // --- negative control: keyframes that agree must not move a pixel ----
        let still = motion_clip(&[
            (0.0, motion_transform((0.4, 0.6), (0.7, 0.7), 0.0), false),
            (1.0, motion_transform((0.4, 0.6), (0.7, 0.7), 0.0), false),
            (2.0, motion_transform((0.6, 0.6), (0.7, 0.7), 0.0), false),
        ]);
        // Only the last segment moves, so the first second is the control: every
        // frame of it must be byte-identical to the one before.
        let frames = render(&still);
        let held_frames = &frames[..30];
        assert!(
            held_frames.windows(2).all(|pair| pair[0] == pair[1]),
            "frames inside a segment whose endpoints agree must be bit-identical"
        );
        let (start_area, start_x, _) = motion_white_region(&frames[0], CANVAS.0).expect("lit");
        let (end_area, end_x, _) =
            motion_white_region(frames.last().unwrap(), CANVAS.0).expect("lit");
        assert_eq!(
            start_area, end_area,
            "the moving segment only pans, so the area must hold"
        );
        assert!(
            end_x - start_x > 40.0,
            "the clip must still move once its moving segment starts: {start_x} -> {end_x}"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: the whole builder routes an animated clip to the animated path
    ///
    /// The composition gate, the routing branch and the emitter are three
    /// separate decisions, and a clip only animates if all three agree. This
    /// drives the real argument builder rather than the emitter alone, so a gate
    /// that never opens shows up here instead of shipping.
    #[test]
    fn the_argument_builder_animates_a_clip_that_carries_motion() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{SequenceFormat, TransformKeyframe};

        let build = |keyframes: Vec<TransformKeyframe>, transform: Transform| {
            let mut sequence = Sequence::new("Motion", SequenceFormat::youtube_1080());
            let mut track = Track::new_video("Video 1");
            let mut clip = Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0);
            clip.transform = transform;
            clip.motion_keyframes = keyframes;
            track.add_clip(clip);
            sequence.add_track(track);

            let video_path = create_temp_media_file("motion_source.mp4");
            let mut video_asset = Asset::new_video(
                "motion_source.mp4",
                &video_path,
                VideoInfo {
                    width: 1280,
                    height: 720,
                    ..VideoInfo::default()
                },
            )
            .with_duration(3.0)
            .with_file_size(3_000_000);
            video_asset.id = "video_asset".to_string();
            let mut assets = HashMap::new();
            assets.insert(video_asset.id.clone(), video_asset);

            let args = build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &HashMap::new(),
                &HashMap::new(),
                &ExportSettings::default(),
            )
            .expect("a clip with motion should build a filtergraph");
            filter_complex_of(&args).to_string()
        };

        let panning = vec![
            TransformKeyframe {
                time_offset: 0.0,
                transform: motion_transform((0.3, 0.5), (0.5, 0.5), 0.0),
                interpolation: Default::default(),
            },
            TransformKeyframe {
                time_offset: 3.0,
                transform: motion_transform((0.7, 0.5), (1.0, 1.0), 0.0),
                interpolation: Default::default(),
            },
        ];

        // The clip's own transform is the identity, so only the keyframes can
        // have pulled the composition in at all.
        let animated = build(panning.clone(), Transform::default());
        assert!(
            animated.contains(":eval=frame"),
            "an identity-transform clip with motion must still animate: {animated}"
        );
        assert!(
            animated.contains("overlay=x='"),
            "the overlay corner must be an expression: {animated}"
        );

        // The same move, but turning: still one static composite.
        let mut rotating = panning;
        rotating[1].transform.rotation_deg = 20.0;
        let stilled = build(rotating, Transform::default());
        assert!(
            !stilled.contains(":eval=frame"),
            "rotating motion must not reach the animated path: {stilled}"
        );

        // And a clip with no motion at all is untouched by any of this.
        let plain = build(Vec::new(), Transform::default());
        assert!(
            !plain.contains(":eval=frame") && !plain.contains("overlay=x='"),
            "a clip without motion must build exactly as it always did: {plain}"
        );
    }

    /// The animated composition a clip's keyframes produce, at a given opacity.
    fn animated_motion_graph_with_opacity(
        clip: &Clip,
        source: (u32, u32),
        canvas: (u32, u32),
        fps: f64,
        slot_sec: f64,
        head_sec: f64,
        opacity: f64,
    ) -> String {
        let track = super::super::transform_layout::resolve_clip_motion_track(
            source.0, source.1, canvas.0, canvas.1, clip, head_sec,
        )
        .expect("clip has motion keyframes");

        let mut graph = String::new();
        append_animated_video_transform_composition(
            &mut graph, "0:v", "out", &track, opacity, slot_sec, canvas.0, canvas.1, fps,
            "yuv420p", false,
        );
        graph
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: alpha attenuation runs before the animated scale
    ///
    /// `colorchannelmixer` works in RGB, so in a `yuva*` graph FFmpeg wraps it in
    /// a yuva -> argb -> yuva conversion. Placed after the animated `scale` that
    /// conversion is configured once and keeps rescaling every later frame back to
    /// the first frame's size, freezing the animation outright. Attenuating alpha
    /// does not depend on the frame's size, so it belongs above `scale`.
    #[test]
    fn a_translucent_animated_clip_attenuates_before_it_scales() {
        let clip = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.4, 0.4), 0.0), false),
            (2.0, motion_transform((0.5, 0.5), (0.9, 0.9), 0.0), false),
        ]);

        let graph =
            animated_motion_graph_with_opacity(&clip, (640, 360), (1280, 720), 30.0, 2.0, 0.0, 0.5);

        let mixer = graph
            .find("colorchannelmixer")
            .expect("a translucent clip must attenuate its alpha");
        let scale = graph
            .find("scale=w='")
            .expect("an animated clip must scale by expression");
        assert!(
            mixer < scale,
            "the alpha filter must precede the animated scale or the size freezes: {graph}"
        );

        // Nothing may sit between the animated scale and the staged label but
        // `setsar`, which converts no formats and so inserts no converter.
        let staged = &graph[scale..graph.find("[out_tx]").expect("staged label")];
        assert!(
            staged.ends_with("eval=frame,setsar=1"),
            "no format-converting filter may follow the animated scale: {staged}"
        );

        // An opaque clip emits no attenuation at all, and still stages in yuva.
        let opaque =
            animated_motion_graph_with_opacity(&clip, (640, 360), (1280, 720), 30.0, 2.0, 0.0, 1.0);
        assert!(
            !opaque.contains("colorchannelmixer"),
            "an opaque clip must not pay for an alpha filter: {opaque}"
        );
        assert!(
            opaque.starts_with("[0:v]format=yuva420p,scale=w='"),
            "the staged chain must convert format before it scales: {opaque}"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: a sub-microsecond keyframe span cannot divide by zero
    ///
    /// Times are emitted through `format_speed_number`, which rounds to six
    /// decimals. A raw span of 1e-7 is comfortably greater than zero in Rust and
    /// formats to a literal `0` in the graph, so guarding on the raw value would
    /// hand FFmpeg `…*(t-0)/0`.
    #[test]
    fn a_sub_microsecond_keyframe_span_never_emits_a_zero_divisor() {
        let clip = motion_clip(&[
            (0.0, motion_transform((0.3, 0.5), (0.4, 0.4), 0.0), false),
            (1e-7, motion_transform((0.7, 0.5), (0.9, 0.9), 0.0), false),
            (2.0, motion_transform((0.7, 0.5), (0.9, 0.9), 0.0), false),
        ]);

        let graph = animated_motion_graph(&clip, (640, 360), (1280, 720), 30.0, 2.0, 0.0);

        assert!(
            !graph.contains("/0)") && !graph.contains("/0,"),
            "a span that rounds to zero must not become a divisor: {graph}"
        );
        assert!(
            graph.contains(":eval=frame"),
            "the rest of the move must still animate: {graph}"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: motion the render cannot animate leaves the graph untouched
    ///
    /// The byte-for-byte guarantee, driven through the real argument builder
    /// rather than the composer alone: a clip whose keyframes cannot be animated
    /// must produce exactly the graph it produced before motion rendered at all.
    #[test]
    fn unanimatable_motion_builds_the_same_graph_as_no_motion_at_all() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{SequenceFormat, TransformKeyframe};

        let build = |keyframes: Vec<TransformKeyframe>| {
            let mut sequence = Sequence::new("Motion", SequenceFormat::youtube_1080());
            let mut track = Track::new_video("Video 1");
            let mut clip = Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0);
            clip.transform = motion_transform((0.4, 0.6), (0.5, 0.5), 0.0);
            clip.motion_keyframes = keyframes;
            track.add_clip(clip);
            sequence.add_track(track);

            let video_path = create_temp_media_file("no_regression.mp4");
            let mut video_asset = Asset::new_video(
                "no_regression.mp4",
                &video_path,
                VideoInfo {
                    width: 1280,
                    height: 720,
                    ..VideoInfo::default()
                },
            )
            .with_duration(3.0)
            .with_file_size(3_000_000);
            video_asset.id = "video_asset".to_string();
            let mut assets = HashMap::new();
            assets.insert(video_asset.id.clone(), video_asset);

            let args = build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &HashMap::new(),
                &HashMap::new(),
                &ExportSettings::default(),
            )
            .expect("the clip should build a filtergraph");
            filter_complex_of(&args).to_string()
        };

        let keyframe_at = |time_offset: f64, transform: Transform| TransformKeyframe {
            time_offset,
            transform,
            interpolation: Default::default(),
        };

        let baseline = build(Vec::new());

        // One keyframe describes a still picture.
        let single = build(vec![keyframe_at(
            0.0,
            motion_transform((0.2, 0.2), (0.9, 0.9), 0.0),
        )]);
        assert_eq!(
            single, baseline,
            "a lone keyframe must not change the emitted graph"
        );

        // Keyframes that agree describe a still picture too.
        let unmoving = build(vec![
            keyframe_at(0.0, motion_transform((0.2, 0.2), (0.9, 0.9), 0.0)),
            keyframe_at(3.0, motion_transform((0.2, 0.2), (0.9, 0.9), 0.0)),
        ]);
        assert_eq!(
            unmoving, baseline,
            "keyframes that agree must not change the emitted graph"
        );

        // And motion that turns the picture stays on the static path.
        let rotating = build(vec![
            keyframe_at(0.0, motion_transform((0.2, 0.2), (0.9, 0.9), 0.0)),
            keyframe_at(3.0, motion_transform((0.6, 0.6), (1.2, 1.2), 25.0)),
        ]);
        assert_eq!(
            rotating, baseline,
            "rotating motion must not change the emitted graph"
        );

        // The control: motion the render *can* animate must differ, or the three
        // assertions above would pass for the wrong reason.
        let panning = build(vec![
            keyframe_at(0.0, motion_transform((0.2, 0.2), (0.9, 0.9), 0.0)),
            keyframe_at(3.0, motion_transform((0.6, 0.6), (1.2, 1.2), 0.0)),
        ]);
        assert_ne!(
            panning, baseline,
            "animatable motion must actually change the emitted graph"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: an unmeasurable source costs the animation, not the export
    ///
    /// Compositing needs the source's real pixel size. Widening the composition
    /// gate to cover motion meant an identity-transform clip that merely carried
    /// keyframes started demanding that size — and an asset whose size cannot be
    /// measured turned a previously working export into a blocked one. Such a
    /// clip has somewhere to fall back to: the plain canvas fit it always had.
    #[test]
    fn a_motion_clip_with_an_unmeasurable_source_still_exports() {
        use crate::core::assets::VideoInfo;
        use crate::core::timeline::{SequenceFormat, TransformKeyframe};

        // `VideoInfo::default()` is the 1920x1080 placeholder an unenriched
        // import stores, which `stored_asset_source_dimensions` refuses, and the
        // file does not exist so the probe cannot rescue it either.
        let build = |transform: Transform, opacity: f32| {
            let mut sequence = Sequence::new("Motion", SequenceFormat::youtube_1080());
            let mut track = Track::new_video("Video 1");
            let mut clip = Clip::new("video_asset")
                .with_source_range(0.0, 3.0)
                .place_at(0.0);
            clip.id = "motion-clip".to_string();
            clip.transform = transform;
            clip.opacity = opacity;
            clip.motion_keyframes = vec![
                TransformKeyframe {
                    time_offset: 0.0,
                    transform: motion_transform((0.3, 0.5), (0.5, 0.5), 0.0),
                    interpolation: Default::default(),
                },
                TransformKeyframe {
                    time_offset: 3.0,
                    transform: motion_transform((0.7, 0.5), (1.0, 1.0), 0.0),
                    interpolation: Default::default(),
                },
            ];
            track.add_clip(clip);
            sequence.add_track(track);

            let video_path = create_temp_media_file("unmeasurable.mp4");
            let mut video_asset =
                Asset::new_video("unmeasurable.mp4", &video_path, VideoInfo::default())
                    .with_duration(3.0)
                    .with_file_size(3_000_000);
            video_asset.id = "video_asset".to_string();
            let mut assets = HashMap::new();
            assets.insert(video_asset.id.clone(), video_asset);

            (sequence, assets)
        };

        // Motion alone: the export survives, fitted to the canvas, and says so.
        let (sequence, assets) = build(Transform::default(), 1.0);
        let validation = validate_export_settings(
            &sequence,
            &assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );
        assert!(
            validation.is_valid,
            "motion alone must not block an export over an unmeasurable source: {:?}",
            validation.errors
        );
        assert!(
            validation
                .warnings
                .iter()
                .any(|warning| warning.contains("Motion keyframes")
                    && warning.contains("fitted to the canvas")),
            "the lost animation has to be reported: {:?}",
            validation.warnings
        );

        let graph = filter_complex_of(
            &build_complex_filter_args_with_audio_info(
                &sequence,
                &assets,
                &HashMap::new(),
                &HashMap::new(),
                &ExportSettings::default(),
            )
            .expect("an unmeasurable motion clip must still build a graph"),
        )
        .to_string();
        assert!(
            !graph.contains(":eval=frame"),
            "the degraded clip must not animate: {graph}"
        );

        // A clip whose own transform places it still needs the size, and still
        // fails loudly without it — that error is not a regression, it is the
        // point of the check.
        let (placed, placed_assets) = build(motion_transform((0.25, 0.25), (0.5, 0.5), 0.0), 1.0);
        let placed_validation = validate_export_settings(
            &placed,
            &placed_assets,
            &HashMap::new(),
            &ExportSettings::default(),
        );
        assert!(
            !placed_validation.is_valid,
            "a clip whose own transform needs placing must still fail without a size"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: a translucent clip animates as readily as an opaque one
    ///
    /// Alpha attenuation is the one filter in the staged chain that converts pixel
    /// format, and a converter downstream of the animated `scale` is configured
    /// once and then rescales every later frame back to the first frame's size.
    /// With `colorchannelmixer` left after `scale` this measured 3676 lit pixels
    /// on frame 0 and 3676 on frame 59 of a 0.4x -> 0.9x zoom — seven distinct
    /// sizes across sixty frames, i.e. frozen. Hoisting it above `scale` gives
    /// 3676 -> 14306 across sixty distinct sizes.
    ///
    /// This is a silent wrong render rather than a loud one: the clip still pans,
    /// FFmpeg prints no warning, and the motion warning is suppressed because the
    /// export believes it animated the clip. Only the pixels tell.
    ///
    /// Ignored by default because it needs an `ffmpeg` binary. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml --lib --features dev-full -- --ignored translucent
    #[test]
    #[ignore = "requires an ffmpeg binary; run with --ignored"]
    fn a_translucent_animated_clip_still_moves_its_pixels() {
        use crate::core::test_ffmpeg::{require_or_skip_ffmpeg, skip_without_ffmpeg};

        const CANVAS: (u32, u32) = (320, 180);
        const SOURCE: (u32, u32) = (320, 180);
        const FPS: f64 = 30.0;
        const SLOT_SEC: f64 = 2.0;
        // Half-opaque white over black lands near luma 128, right on the white
        // threshold, so the region is measured against "not black" instead.
        const LIT: u8 = 40;

        let Some(ffmpeg) = require_or_skip_ffmpeg() else {
            return;
        };
        let dir = tempfile::tempdir().expect("temp dir");
        let Some(input) = motion_white_box_clip(&ffmpeg, dir.path(), SOURCE, (160, 90), SLOT_SEC)
        else {
            skip_without_ffmpeg("the white-box fixture could not be encoded");
            return;
        };

        let zooming = motion_clip(&[
            (0.0, motion_transform((0.5, 0.5), (0.4, 0.4), 0.0), false),
            (2.0, motion_transform((0.5, 0.5), (0.9, 0.9), 0.0), false),
        ]);
        let graph =
            animated_motion_graph_with_opacity(&zooming, SOURCE, CANVAS, FPS, SLOT_SEC, 0.0, 0.5);
        let frames = motion_luma_frames(&ffmpeg, &input, &graph, CANVAS);
        assert_eq!(frames.len(), 60, "the slot must render every frame");

        let areas: Vec<usize> = frames
            .iter()
            .map(|frame| {
                motion_lit_region(frame, CANVAS.0, LIT)
                    .expect("a translucent clip is still visible")
                    .0
            })
            .collect();

        assert!(
            areas.last().unwrap() > &(areas[0] * 3),
            "a translucent 0.4x -> 0.9x zoom must still grow several fold: {} -> {}",
            areas[0],
            areas.last().unwrap()
        );
        assert!(
            areas.iter().collect::<std::collections::HashSet<_>>().len() > 20,
            "a translucent clip must resize continuously, not freeze at frame one: {areas:?}"
        );

        // And it really is translucent: half-opaque white over black must land
        // well below the full-white the opaque path produces.
        let centre = frames[frames.len() - 1][(CANVAS.1 / 2 * CANVAS.0 + CANVAS.0 / 2) as usize];
        assert!(
            (LIT..200).contains(&centre),
            "the clip must be dimmed by its opacity, got luma {centre}"
        );
    }
}
