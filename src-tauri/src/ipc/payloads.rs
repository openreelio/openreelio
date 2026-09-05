use super::command_schema::declare_command_payloads;
use crate::core::assets::{AudioInfo, LicenseInfo, ProxyStatus, VideoInfo};
use crate::core::effects::{EffectType, Keyframe, ParamValue};
use crate::core::masks::{MaskBlendMode, MaskKeyframe, MaskShape};
use crate::core::project::ProjectState;
use crate::core::text::TextClipData;
use crate::core::timeline::{
    BlendMode, FpsSpec, MarkerType, SequenceHdrSettings, Track, TrackKind, Transform,
    TransformKeyframe,
};
use crate::core::{AssetId, ClipId, Color, EffectId, MaskId, SequenceId, TimeSec, TrackId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Payload Structs (Strict / Injection-Resistant)
// =============================================================================

/// Payload for `InsertClip` (primitive placement at an exact timeline position).
///
/// Overwrites nothing and ripples nothing: the clip is placed where
/// `timelineStart` says. This primitive does not create the linked audio a
/// video asset carries — use `InsertMedia` for normal media placement so the
/// video stays visible and its audio stays in sync.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub asset_id: AssetId,
    /// Timeline position to insert at.
    ///
    /// Accepts both `timelineStart` and legacy `timelineIn`.
    #[serde(alias = "timelineIn")]
    pub timeline_start: TimeSec,
    /// Optional source start time for partial-range inserts.
    pub source_in: Option<TimeSec>,
    /// Optional source end time for partial-range inserts.
    pub source_out: Option<TimeSec>,
}

/// Payload for Insert Media (drag-and-drop parity composite insert).
///
/// Inserts a primary clip and, for video assets that carry audio, also creates
/// or reuses an audio track, inserts a linked audio clip, links the two clips,
/// and mutes the video clip. The whole composite is a single undoable unit.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertMediaPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub asset_id: AssetId,
    /// Timeline position to insert at.
    ///
    /// Accepts both `timelineStart` and legacy `timelineIn`.
    #[serde(alias = "timelineIn")]
    pub timeline_start: TimeSec,
    /// Optional source start time for partial-range inserts.
    pub source_in: Option<TimeSec>,
    /// Optional source end time for partial-range inserts.
    pub source_out: Option<TimeSec>,
    /// Place a video asset on an audio track intentionally (no preview clip).
    #[serde(default)]
    pub audio_only: bool,
    /// Auto-extract a linked audio clip for video assets that have audio.
    #[serde(default = "default_true")]
    pub auto_extract_linked_audio: bool,
}

/// Default value helper for `auto_extract_linked_audio` (defaults to enabled).
fn default_true() -> bool {
    true
}

/// Payload for Insert Edit (ripple insert — pushes downstream clips).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InsertEditPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub asset_id: AssetId,
    /// Playhead / timeline position to insert at.
    pub timeline_position: TimeSec,
    /// Optional source start time for partial-range inserts.
    pub source_in: Option<TimeSec>,
    /// Optional source end time for partial-range inserts.
    pub source_out: Option<TimeSec>,
}

/// Payload for Overwrite Edit (replaces content in time range — trims/removes overlapping clips).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverwriteEditPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub asset_id: AssetId,
    /// Playhead / timeline position to place the clip.
    pub timeline_position: TimeSec,
    /// Optional source start time for partial-range overwrites.
    pub source_in: Option<TimeSec>,
    /// Optional source end time for partial-range overwrites.
    pub source_out: Option<TimeSec>,
}

/// Payload for Ripple Delete (remove clips + close gaps).
///
/// A single clip may also be named as `clipId` instead of `clipIds`, and a
/// legacy `affectAllTracks` flag is accepted and ignored. Neither is listed as
/// a property below, which is why this payload does not declare
/// `additionalProperties: false`.
#[derive(Debug, Serialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RippleDeletePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
    ///
    /// Accepts `clipIds`, or `clipId` for a single clip; one of the two is
    /// required.
    pub clip_ids: Vec<ClipId>,
}

impl<'de> Deserialize<'de> for RippleDeletePayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RippleDeletePayloadCompat {
            sequence_id: SequenceId,
            track_id: TrackId,
            #[serde(default)]
            clip_ids: Vec<ClipId>,
            clip_id: Option<ClipId>,
            #[serde(default)]
            affect_all_tracks: Option<bool>,
        }

        let compat = RippleDeletePayloadCompat::deserialize(deserializer)?;
        let _ = compat.affect_all_tracks;

        let clip_ids = if !compat.clip_ids.is_empty() {
            compat.clip_ids
        } else if let Some(clip_id) = compat.clip_id {
            vec![clip_id]
        } else {
            return Err(serde::de::Error::missing_field("clipIds"));
        };

        Ok(Self {
            sequence_id: compat.sequence_id,
            track_id: compat.track_id,
            clip_ids,
        })
    }
}

/// Payload for Lift (remove clips, leave gaps).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiftPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
    pub clip_ids: Vec<ClipId>,
}

/// Payload for Extract Edit (remove In/Out range + close gap).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractEditPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// In point (start of extraction range).
    pub in_point: TimeSec,
    /// Out point (end of extraction range).
    pub out_point: TimeSec,
}

/// Payload for Find Gaps (query — returns gap info without mutating state).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindGapsPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

/// Payload for Close Gap (close a specific gap by shifting downstream clips).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseGapPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Start of the gap to close.
    pub gap_start: TimeSec,
    /// End of the gap to close.
    pub gap_end: TimeSec,
}

/// Payload for Close All Gaps (remove all gaps on a track).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseAllGapsPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

/// Payload for `RemoveClip` (remove one clip, leaving a gap).
///
/// Use `RippleDelete` to remove clips and close the gap behind them.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

/// Payload for `MoveClip` (move one clip in time, and optionally across tracks).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveClipPayload {
    pub sequence_id: SequenceId,
    /// Source track (required for strict input validation; ignored by core move logic).
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// New timeline position.
    ///
    /// Accepts both `newTimelineIn` and legacy `newStart`.
    #[serde(alias = "newStart")]
    pub new_timeline_in: TimeSec,
    /// Track to move the clip onto; it stays on `trackId` when omitted.
    #[serde(alias = "newTrackId")]
    pub new_track_id: Option<TrackId>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTrackBlendModePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipBlendModePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub blend_mode: BlendMode,
}

/// Payload for `TrimClip` (change a clip's source range and timeline position).
///
/// Every field but the ids is optional; an omitted one keeps its current value.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrimClipPayload {
    pub sequence_id: SequenceId,
    /// Track containing the clip.
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// New source in-point, in source seconds.
    ///
    /// Accepts both `newSourceIn` and legacy `newStart`.
    #[serde(alias = "newStart")]
    pub new_source_in: Option<TimeSec>,
    /// New source out-point, in source seconds.
    ///
    /// Accepts both `newSourceOut` and legacy `newEnd`.
    #[serde(alias = "newEnd")]
    pub new_source_out: Option<TimeSec>,
    /// New timeline position for the trimmed clip.
    #[serde(alias = "newTimelineIn")]
    pub new_timeline_in: Option<TimeSec>,
}

/// Payload for `SetClipTransform` (position, scale, rotation and anchor).
///
/// This renders in the final export for every visual clip, not just in the
/// preview. Motion keyframes (`SetClipMotionKeyframes`) still render static at
/// the clip's base transform, and the render reports a warning saying so.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipTransformPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub transform: Transform,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipMotionKeyframesPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframes: Vec<TransformKeyframe>,
}

/// Payload for `SetClipOpacity` (one clip's constant opacity).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipOpacityPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Opacity as a fraction: `0.0` fully transparent, `1.0` fully opaque.
    ///
    /// Values outside that range are clamped into it, so `100` means opaque,
    /// not "100 percent".
    pub opacity: f32,
}

/// Payload for `SetClipSpeed` (constant clip speed and direction).
///
/// Use `SetTimeRemap` for speed that varies across the clip.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipSpeedPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Playback rate multiplier: `1.0` real time, `0.5` half speed, `2.0`
    /// double speed. Must be finite and greater than zero.
    ///
    /// The clip's timeline duration changes with it; use
    /// `SetClipSlowMotionInterpolation` to choose how sub-real-time frames are
    /// generated.
    pub speed: f32,
    /// Whether the clip plays backwards. Defaults to `false`.
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipSlowMotionInterpolationPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub interpolation: crate::core::timeline::SlowMotionInterpolation,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReverseClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipEnabledPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub enabled: bool,
}

/// Clip reference: a (trackId, clipId) pair used in multi-clip commands.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipRef {
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UngroupClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachAudioPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_audio_track_id: Option<TrackId>,
}

/// Payload for `CreateFreezeFrame` (hold one frame of a clip).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFreezeFramePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Timeline position, in seconds, of the frame to hold. It must fall
    /// inside the clip.
    pub playhead_sec: f64,
    /// How long the held frame lasts, in seconds. Defaults to the standard
    /// freeze-frame duration when omitted.
    #[serde(default = "default_freeze_duration")]
    pub duration_sec: f64,
}

fn default_freeze_duration() -> f64 {
    crate::core::commands::DEFAULT_FREEZE_FRAME_DURATION
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTimeRemapPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub time_remap: crate::core::timeline::TimeRemapCurve,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearTimeRemapPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipMutePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub muted: bool,
}

/// Payload for `SetClipAudio` (clip gain, pan, mute, fades and roles).
///
/// Every field but the ids is optional and an omitted one is left alone, but
/// at least one of them must be present.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipAudioPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Clip gain in decibels, clamped to -60..=+6. `0` is unity gain.
    pub volume_db: Option<f32>,
    /// Stereo pan, clamped to -1.0 (left) ..= 1.0 (right); `0` is centred.
    pub pan: Option<f32>,
    /// Whether the clip's audio is silenced.
    pub muted: Option<bool>,
    /// Fade-in length in seconds, clamped to the clip's duration.
    pub fade_in_sec: Option<TimeSec>,
    /// Fade-out length in seconds, clamped to the clip's duration.
    ///
    /// A fade pair longer than the clip is shortened rather than rejected.
    pub fade_out_sec: Option<TimeSec>,
    /// Editorial role: `dialogue`, `music`, `sfx`, `ambience` or `voiceover`.
    /// `none` or an empty string clears it; anything else is rejected.
    pub audio_role: Option<String>,
    /// Free-form editorial tags, lowercased and de-duplicated on write.
    pub audio_tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddAudioKeyframePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub time_offset: f64,
    pub value_db: f64,
    #[serde(default)]
    pub interpolation: crate::core::timeline::KeyframeInterpolation,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAudioKeyframePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAudioKeyframePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
    pub new_time_offset: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioKeyframeValuePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
    pub value_db: f64,
    pub interpolation: Option<crate::core::timeline::KeyframeInterpolation>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioFadeInPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    #[serde(default)]
    pub fade_type: crate::core::timeline::FadeType,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioFadeOutPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    #[serde(default)]
    pub fade_type: crate::core::timeline::FadeType,
}

/// Payload for `SplitClip` (razor cut at a timeline position).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Timeline position to cut at, in timeline seconds.
    ///
    /// Accepts both `splitTime` and `atTimelineSec`.
    #[serde(alias = "splitTime", alias = "atTimelineSec")]
    pub split_time: TimeSec,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportAssetPayload {
    pub name: String,
    pub uri: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAssetPayload {
    pub asset_id: AssetId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAssetPayload {
    pub asset_id: AssetId,
    pub name: Option<String>,
    pub tags: Option<Vec<String>>,
    pub license: Option<LicenseInfo>,
    pub thumbnail_url: Option<Option<String>>,
    pub proxy_status: Option<ProxyStatus>,
    pub proxy_url: Option<Option<String>>,
    pub uri: Option<String>,
    pub duration_sec: Option<Option<f64>>,
    pub file_size: Option<u64>,
    pub video: Option<Option<VideoInfo>>,
    pub audio: Option<Option<AudioInfo>>,
    pub relative_path: Option<Option<String>>,
    pub workspace_managed: Option<bool>,
    pub missing: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSequencePayload {
    pub name: String,
    pub format: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetMasterVolumePayload {
    pub sequence_id: SequenceId,
    pub volume_db: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSequenceHdrSettingsPayload {
    pub sequence_id: SequenceId,
    pub settings: SequenceHdrSettings,
}

/// Payload for `SetSequenceFormat`.
///
/// Every field is optional and at least one must be given; the omitted fields
/// keep their current value. `sequenceId` defaults to the active sequence.
/// `fps` takes either an exact ratio (`{"num": 30000, "den": 1001}`) or a
/// decimal (`29.97`), which is snapped to the exact rational it names.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSequenceFormatPayload {
    /// Sequence to change; the active sequence when omitted.
    #[serde(default)]
    pub sequence_id: Option<SequenceId>,
    /// New frame rate, as an exact ratio or a decimal.
    #[serde(default)]
    pub fps: Option<FpsSpec>,
    /// New canvas width in pixels (even, 16..=16384).
    #[serde(default)]
    pub width: Option<u32>,
    /// New canvas height in pixels (even, 16..=16384).
    #[serde(default)]
    pub height: Option<u32>,
    /// New audio sample rate in Hz.
    #[serde(default)]
    pub audio_sample_rate: Option<u32>,
    /// New audio channel count (1 or 2).
    #[serde(default)]
    pub audio_channels: Option<u8>,
}

/// Payload for `CreateTrack`.
///
/// Editable text clips need a `video` or `overlay` track; `AddTextClip`
/// requires one and does not create it.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTrackPayload {
    pub sequence_id: SequenceId,
    pub kind: TrackKind,
    pub name: String,
    pub position: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTrackPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameTrackPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// New track name.
    ///
    /// Accepts both `newName` and `name`.
    #[serde(alias = "name")]
    pub new_name: String,
}

/// Payload for `SetCaptionTrackLanguage`.
///
/// Caption tracks only. The language is a BCP-47-ish code such as `en`, `ko`,
/// `ja`, `zh`, `es` or `en-us`.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCaptionTrackLanguagePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderTracksPayload {
    pub sequence_id: SequenceId,
    pub new_order: Vec<TrackId>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTrackVolumePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Linear track volume, where 1.0 is unity and 2.0 is +6 dB.
    pub volume: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackMutePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub muted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackLockPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub locked: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackVisibilityPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub visible: bool,
}

// =============================================================================
// Marker Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMarkerPayload {
    pub sequence_id: SequenceId,
    /// Timeline position of the marker, in seconds.
    ///
    /// Accepts both `timeSec` and `time`.
    #[serde(alias = "time")]
    pub time_sec: TimeSec,
    /// Marker label.
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_type: Option<MarkerType>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveMarkerPayload {
    pub sequence_id: SequenceId,
    pub marker_id: String,
}

/// Payload for `UpdateCaption` (restyle or retime one caption line).
///
/// Every field but the ids is optional; an omitted one keeps its current value.
/// `stylePack` contributes style only here: the command replaces the stored
/// anchor whenever the payload carries one, so an update restyles without
/// moving the caption unless it also passes `position`.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCaptionPayload {
    /// Sequence holding the caption track.
    pub sequence_id: SequenceId,
    /// Caption track holding the caption.
    pub track_id: TrackId,
    /// Caption to update.
    ///
    /// Accepts both `captionId` and `clipId`.
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    /// New caption text; the existing text is kept when omitted.
    pub text: Option<String>,
    /// New start time in timeline seconds; the existing one is kept when omitted.
    ///
    /// Accepts both `startSec` and `startTime`.
    #[serde(alias = "startSec", alias = "startTime")]
    pub start_sec: Option<TimeSec>,
    /// New end time in timeline seconds; the existing one is kept when omitted.
    ///
    /// Accepts both `endSec` and `endTime`.
    #[serde(alias = "endSec", alias = "endTime")]
    pub end_sec: Option<TimeSec>,
    // Forward-compatible fields currently used by UI/QC but not applied by core yet.
    // Keep them to avoid rejecting payloads during strict parsing.
    /// Caption style overrides, applied on top of `stylePack` key by key.
    ///
    /// Accepts fontFamily, fontSize, fontWeight, bold, italic, underline,
    /// color, opacity, backgroundColor, backgroundPadding, outlineColor,
    /// outlineWidth, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur,
    /// alignment, lineHeight and letterSpacing.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub style: Option<serde_json::Value>,
    /// Caption anchor: a `preset` of top/center/bottom, or custom
    /// `xPercent`/`yPercent`. The stored anchor is kept when omitted.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub position: Option<serde_json::Value>,
    /// Curated caption pack id, resolved into `style` only.
    ///
    /// An update replaces the stored anchor whenever it carries one, so a pack
    /// on an update restyles without moving the caption. Pass `position` to
    /// move it.
    #[serde(default)]
    pub style_pack: Option<String>,
}

/// Payload for `CreateCaption` (one caption line).
///
/// Use `ImportGeneratedCaptions` for transcript segments, which imports them
/// atomically as a single undoable command.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Caption text.
    pub text: String,
    /// Start time in timeline seconds.
    ///
    /// Accepts both `startSec` and `startTime`.
    #[serde(alias = "startTime")]
    pub start_sec: TimeSec,
    /// End time in timeline seconds.
    ///
    /// Accepts both `endSec` and `endTime`.
    #[serde(alias = "endTime")]
    pub end_sec: TimeSec,
    // Forward-compatible fields currently used by UI/agent prompts but not
    // applied by core command logic yet.
    /// Caption style overrides, applied on top of `stylePack` key by key.
    ///
    /// Accepts fontFamily, fontSize, fontWeight, bold, italic, underline,
    /// color, opacity, backgroundColor, backgroundPadding, outlineColor,
    /// outlineWidth, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur,
    /// alignment, lineHeight and letterSpacing.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub style: Option<serde_json::Value>,
    /// Caption anchor: a `preset` of top/center/bottom, or custom
    /// `xPercent`/`yPercent`.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub position: Option<serde_json::Value>,
    /// Curated caption pack id, resolved into `style` + `position`.
    #[serde(default)]
    pub style_pack: Option<String>,
}

/// One transcript segment in an `ImportGeneratedCaptions` payload.
///
/// The times are TIMELINE-relative. A transcription of a single source asset
/// returns SOURCE-relative times, which must be mapped onto the placed clip
/// before they are used here.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedCaptionSegmentPayload {
    /// Segment start in timeline seconds.
    ///
    /// Accepts `startSec`, `startTime` or `start`.
    #[serde(alias = "startTime", alias = "start")]
    pub start_sec: TimeSec,
    /// Segment end in timeline seconds.
    ///
    /// Accepts `endSec`, `endTime` or `end`.
    #[serde(alias = "endTime", alias = "end")]
    pub end_sec: TimeSec,
    /// Transcribed text for the segment.
    pub text: String,
    /// Recognition confidence, when the transcriber reported one.
    pub confidence: Option<f64>,
    /// Speaker label from diarization.
    ///
    /// Accepts both `speaker` and `speakerId`.
    #[serde(alias = "speakerId")]
    pub speaker: Option<String>,
    /// BCP-47-ish language code for the segment, e.g. `en` or `ko`.
    pub language: Option<String>,
}

/// Payload for `ImportGeneratedCaptions` (a whole transcript, atomically).
///
/// Every segment is imported as one undoable command. Prefer `stylePack` over
/// hand-assembled style values: the curated packs are the checked quality
/// floor and stay inside the title-safe area on landscape and vertical
/// canvases alike.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportGeneratedCaptionsPayload {
    /// Sequence holding the caption track.
    pub sequence_id: SequenceId,
    /// Caption track to import into.
    pub track_id: TrackId,
    /// Transcript segments, in timeline seconds.
    pub segments: Vec<GeneratedCaptionSegmentPayload>,
    /// Caption style overrides applied to every imported segment, on top of
    /// `stylePack` key by key.
    ///
    /// Accepts fontFamily, fontSize, fontWeight, bold, italic, underline,
    /// color, opacity, backgroundColor, backgroundPadding, outlineColor,
    /// outlineWidth, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur,
    /// alignment, lineHeight and letterSpacing.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub style: Option<serde_json::Value>,
    /// Caption anchor for every imported segment: a `preset` of
    /// top/center/bottom, or custom `xPercent`/`yPercent`.
    #[schemars(with = "Option<serde_json::Map<String, serde_json::Value>>")]
    pub position: Option<serde_json::Value>,
    /// Curated caption pack id, resolved into `style` + `position`.
    #[serde(default)]
    pub style_pack: Option<String>,
    /// Whether to clear the track's existing captions before importing.
    #[serde(default)]
    pub replace_existing: bool,
}

/// Payload for `DeleteCaption` (remove one caption line).
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Caption to delete.
    ///
    /// Accepts both `captionId` and `clipId`.
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
}

// =============================================================================
// Effect Payloads
// =============================================================================

/// Payload for adding an effect to a clip.
///
/// Either `effectType` or `recipe` must be present. A curated transition recipe
/// (see `core::style::transition_recipes`) supplies the effect type and its
/// baseline parameters; anything in `params` overrides the recipe key by key.
/// `CommandPayload::parse` performs that resolution, so a payload that reaches
/// command construction always carries an explicit effect type.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddEffectPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(default)]
    pub effect_type: Option<EffectType>,
    /// Curated transition recipe id, resolved into `effectType` + `params`.
    #[serde(default)]
    pub recipe: Option<String>,
    /// Effect parameters, overriding a `recipe`'s baseline key by key.
    ///
    /// Accepts both `params` and `parameters`.
    #[serde(default, alias = "parameters")]
    pub params: HashMap<String, ParamValue>,
    /// Keyframed parameter tracks, keyed by parameter name.
    #[serde(default)]
    pub keyframes: HashMap<String, Vec<Keyframe>>,
    /// Optional position in the effect list (None = append at end)
    pub position: Option<usize>,
}

/// Payload for removing an effect from a clip.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveEffectPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_id: EffectId,
}

/// Payload for updating effect parameters.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateEffectPayload {
    pub effect_id: EffectId,
    #[serde(default)]
    pub params: HashMap<String, ParamValue>,
    /// Optional - toggle effect enabled state
    pub enabled: Option<bool>,
}

// =============================================================================
// Effect Copy/Paste Payloads
// =============================================================================

/// Payload for pasting all copied effects onto target clips.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteEffectsPayload {
    pub sequence_id: SequenceId,
    /// Target clips to receive the pasted effects: [{trackId, clipId}]
    pub target_clips: Vec<ClipRef>,
    /// Serialized source effects (from copy_clip_effects IPC result)
    pub source_effects: Vec<serde_json::Value>,
}

/// Payload for selective paste of effects and attributes.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteAttributesPayload {
    pub sequence_id: SequenceId,
    pub target_clips: Vec<ClipRef>,
    /// All source effects (from copy_clip_effects IPC result)
    pub source_effects: Vec<serde_json::Value>,
    /// Source clip attributes (from copy_clip_effects IPC result)
    pub source_attributes: crate::core::commands::ClipAttributeValues,
    /// Which effects and attributes to paste
    pub selection: crate::core::commands::AttributeSelection,
}

/// Payload for removing effects and/or resetting attributes on a clip.
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAttributesPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Effect IDs to remove
    #[serde(default)]
    pub effect_ids: Vec<EffectId>,
    /// Which attributes to reset to defaults
    #[serde(default)]
    pub reset_transform: bool,
    #[serde(default)]
    pub reset_opacity: bool,
    #[serde(default)]
    pub reset_blend_mode: bool,
    #[serde(default)]
    pub reset_speed: bool,
    #[serde(default)]
    pub reset_audio: bool,
}

// =============================================================================
// Mask Payloads
// =============================================================================

/// Payload for adding a mask to an effect.
///
/// Masks enable selective effect application through shape-based regions.
///
/// # Example
///
/// ```json
/// {
///     "sequenceId": "seq_001",
///     "trackId": "video_001",
///     "clipId": "clip_001",
///     "effectId": "eff_001",
///     "shape": {
///         "type": "rectangle",
///         "x": 0.5,
///         "y": 0.5,
///         "width": 0.5,
///         "height": 0.5,
///         "cornerRadius": 0.0,
///         "rotation": 0.0
///     },
///     "name": "Vignette Mask",
///     "feather": 0.1,
///     "inverted": false
/// }
/// ```
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMaskPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_id: EffectId,
    /// Mask shape (rectangle, ellipse, polygon, or bezier)
    pub shape: MaskShape,
    /// Optional mask name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Feather amount (0.0-1.0 for edge softness)
    #[serde(default)]
    pub feather: f64,
    /// Whether the mask is inverted
    #[serde(default)]
    pub inverted: bool,
    /// Optional shape animation keyframes, commonly generated from tracking data
    #[serde(default)]
    pub keyframes: Vec<MaskKeyframe>,
    /// Optional tracking effect/source ID that generated the keyframes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_source_id: Option<String>,
}

/// Payload for updating a mask's properties.
///
/// All fields except `effectId` and `maskId` are optional.
/// Only provided fields will be updated.
///
/// # Example
///
/// ```json
/// {
///     "effectId": "eff_001",
///     "maskId": "mask_001",
///     "feather": 0.2,
///     "opacity": 0.8
/// }
/// ```
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateMaskPayload {
    pub effect_id: EffectId,
    pub mask_id: MaskId,
    /// New mask shape
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<MaskShape>,
    /// New mask name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New feather amount (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    /// New opacity (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// New expansion value (-1.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<f64>,
    /// Toggle mask inversion
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inverted: Option<bool>,
    /// New blend mode
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<MaskBlendMode>,
    /// Toggle mask enabled state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Toggle mask locked state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    /// Replacement shape animation keyframes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframes: Option<Vec<MaskKeyframe>>,
    /// Tracking effect/source ID that generated the keyframes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_source_id: Option<String>,
}

/// Payload for removing a mask from an effect.
///
/// # Example
///
/// ```json
/// {
///     "effectId": "eff_001",
///     "maskId": "mask_001"
/// }
/// ```
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveMaskPayload {
    pub effect_id: EffectId,
    pub mask_id: MaskId,
}

// =============================================================================
// Text Clip Payloads
// =============================================================================

/// Payload for adding a text clip to a track.
///
/// Creates a new clip with a virtual text asset and applies a TextOverlay
/// effect containing the text styling data.
///
/// A curated text preset id may stand in for most of `textData`; explicit
/// fields override the preset key by key. The preset is resolved during
/// deserialization, so what reaches the op log is the concrete `TextClipData`
/// the preset produced and never the id — replay does not consult the registry.
///
/// # Example
///
/// ```json
/// {
///     "sequenceId": "seq_001",
///     "trackId": "video_001",
///     "timelineIn": 5.0,
///     "duration": 3.0,
///     "textData": {
///         "content": "Hello World",
///         "style": {
///             "fontFamily": "Arial",
///             "fontSize": 48,
///             "color": "#FFFFFF"
///         }
///     }
/// }
/// ```
///
/// The same clip from a preset, where only the copy is the caller's business:
///
/// ```json
/// {
///     "sequenceId": "seq_001",
///     "trackId": "video_001",
///     "timelineIn": 5.0,
///     "duration": 3.0,
///     "preset": "quote",
///     "textData": { "content": "Hello World" }
/// }
/// ```
///
/// Unknown fields are rejected by the wire shape this deserializes from, and
/// `timelineStart` is accepted there as an alias for `timelineIn`.
// The wire shape this deserializes from is stricter and looser than the struct
// in different places, and the derived schema has to describe the *wire*: it
// rejects unknown fields, and `textData` may be absent or partial when
// `preset` names one. Only `schemars` sees these; serde still reads the hand
// written `Deserialize` below.
#[derive(Debug, Serialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(deny_unknown_fields)]
pub struct AddTextClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Timeline position to insert the text clip at (seconds)
    ///
    /// Accepts both `timelineIn` and `timelineStart`.
    pub timeline_in: TimeSec,
    /// Duration of the text clip (seconds)
    pub duration: TimeSec,
    /// Curated text preset id or alias, resolved into `text_data` on parse.
    ///
    /// Always `None` after deserialization: the preset has been expanded into
    /// concrete values by then, and keeping the id would put a registry lookup
    /// between the op log and the clip it describes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Text content and styling data
    ///
    /// Required unless `preset` names a preset, in which case it carries only
    /// the fields that override the preset.
    #[schemars(with = "Option<TextClipData>")]
    pub text_data: TextClipData,
}

impl<'de> Deserialize<'de> for AddTextClipPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// The wire shape, where `textData` may be partial or absent.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            sequence_id: SequenceId,
            track_id: TrackId,
            #[serde(alias = "timelineStart")]
            timeline_in: TimeSec,
            duration: TimeSec,
            #[serde(default)]
            preset: Option<String>,
            #[serde(default)]
            text_data: Option<serde_json::Value>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let text_data =
            crate::core::style::resolve_text_clip_data(wire.preset.as_deref(), wire.text_data)
                .map_err(serde::de::Error::custom)?;

        Ok(Self {
            sequence_id: wire.sequence_id,
            track_id: wire.track_id,
            timeline_in: wire.timeline_in,
            duration: wire.duration,
            preset: None,
            text_data,
        })
    }
}

/// Payload for updating a text clip's content and styling.
///
/// Updates the TextOverlay effect parameters associated with a text clip.
/// Only text clips (clips with virtual text asset IDs) can be updated.
///
/// # Example
///
/// ```json
/// {
///     "sequenceId": "seq_001",
///     "trackId": "video_001",
///     "clipId": "clip_001",
///     "textData": {
///         "content": "Updated Text",
///         "style": {
///             "fontFamily": "Helvetica",
///             "fontSize": 64,
///             "color": "#FF0000",
///             "bold": true
///         }
///     }
/// }
/// ```
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTextClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// New text content and styling data
    pub text_data: TextClipData,
}

/// Payload for removing a text clip from a track.
///
/// Removes both the clip and its associated TextOverlay effect.
/// Only text clips (clips with virtual text asset IDs) can be removed
/// using this command.
///
/// # Example
///
/// ```json
/// {
///     "sequenceId": "seq_001",
///     "trackId": "video_001",
///     "clipId": "clip_001"
/// }
/// ```
#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTextClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

// =============================================================================
// Filesystem Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolderPayload {
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameFilePayload {
    pub old_relative_path: String,
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFilePayload {
    pub source_path: String,
    pub dest_folder_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteFilePayload {
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyAudioDuckingPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframes: Vec<crate::core::timeline::AudioKeyframe>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCompoundClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_ids: Vec<ClipId>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnnestCompoundClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAdjustmentLayerPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub position: f64,
    pub duration: f64,
    pub name: Option<String>,
}

// =============================================================================
// Tagged Union
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type, schemars::JsonSchema)]
#[serde(tag = "commandType", content = "payload", rename_all = "camelCase")]
pub enum CommandPayload {
    #[serde(alias = "insertClip", alias = "InsertClip")]
    InsertClip(InsertClipPayload),

    #[serde(alias = "insertMedia", alias = "InsertMedia")]
    InsertMedia(InsertMediaPayload),

    #[serde(alias = "insertEdit", alias = "InsertEdit")]
    InsertEdit(InsertEditPayload),

    #[serde(alias = "overwriteEdit", alias = "OverwriteEdit")]
    OverwriteEdit(OverwriteEditPayload),

    #[serde(alias = "rippleDelete", alias = "RippleDelete")]
    RippleDelete(RippleDeletePayload),

    #[serde(alias = "lift", alias = "Lift", alias = "liftEdit", alias = "LiftEdit")]
    Lift(LiftPayload),

    #[serde(
        alias = "extractEdit",
        alias = "ExtractEdit",
        alias = "extract",
        alias = "Extract"
    )]
    ExtractEdit(ExtractEditPayload),

    #[serde(alias = "closeGap", alias = "CloseGap")]
    CloseGap(CloseGapPayload),

    #[serde(alias = "closeAllGaps", alias = "CloseAllGaps")]
    CloseAllGaps(CloseAllGapsPayload),

    #[serde(
        alias = "removeClip",
        alias = "RemoveClip",
        alias = "deleteClip",
        alias = "DeleteClip"
    )]
    RemoveClip(RemoveClipPayload),

    #[serde(alias = "moveClip", alias = "MoveClip")]
    MoveClip(MoveClipPayload),

    #[serde(alias = "trimClip", alias = "TrimClip")]
    TrimClip(TrimClipPayload),

    #[serde(alias = "splitClip", alias = "SplitClip")]
    SplitClip(SplitClipPayload),

    #[serde(alias = "setClipTransform", alias = "SetClipTransform")]
    SetClipTransform(SetClipTransformPayload),

    #[serde(alias = "setClipMotionKeyframes", alias = "SetClipMotionKeyframes")]
    SetClipMotionKeyframes(SetClipMotionKeyframesPayload),

    #[serde(alias = "setClipOpacity", alias = "SetClipOpacity")]
    SetClipOpacity(SetClipOpacityPayload),

    #[serde(
        alias = "setClipSpeed",
        alias = "SetClipSpeed",
        alias = "changeClipSpeed"
    )]
    SetClipSpeed(SetClipSpeedPayload),

    #[serde(
        alias = "setClipSlowMotionInterpolation",
        alias = "SetClipSlowMotionInterpolation"
    )]
    SetClipSlowMotionInterpolation(SetClipSlowMotionInterpolationPayload),

    #[serde(alias = "reverseClip", alias = "ReverseClip")]
    ReverseClip(ReverseClipPayload),

    #[serde(alias = "setClipEnabled", alias = "SetClipEnabled")]
    SetClipEnabled(SetClipEnabledPayload),

    #[serde(alias = "linkClips", alias = "LinkClips")]
    LinkClips(LinkClipsPayload),

    #[serde(alias = "unlinkClips", alias = "UnlinkClips")]
    UnlinkClips(UnlinkClipsPayload),

    #[serde(alias = "groupClips", alias = "GroupClips")]
    GroupClips(GroupClipsPayload),

    #[serde(alias = "ungroupClips", alias = "UngroupClips")]
    UngroupClips(UngroupClipsPayload),

    #[serde(alias = "detachAudio", alias = "DetachAudio")]
    DetachAudio(DetachAudioPayload),

    #[serde(
        alias = "createFreezeFrame",
        alias = "CreateFreezeFrame",
        alias = "freezeFrame"
    )]
    CreateFreezeFrame(CreateFreezeFramePayload),

    #[serde(alias = "setTimeRemap", alias = "SetTimeRemap")]
    SetTimeRemap(SetTimeRemapPayload),

    #[serde(alias = "clearTimeRemap", alias = "ClearTimeRemap")]
    ClearTimeRemap(ClearTimeRemapPayload),

    #[serde(alias = "setClipMute", alias = "SetClipMute")]
    SetClipMute(SetClipMutePayload),

    #[serde(alias = "setClipAudio", alias = "SetClipAudio")]
    SetClipAudio(SetClipAudioPayload),

    #[serde(alias = "addAudioKeyframe", alias = "AddAudioKeyframe")]
    AddAudioKeyframe(AddAudioKeyframePayload),

    #[serde(alias = "removeAudioKeyframe", alias = "RemoveAudioKeyframe")]
    RemoveAudioKeyframe(RemoveAudioKeyframePayload),

    #[serde(alias = "moveAudioKeyframe", alias = "MoveAudioKeyframe")]
    MoveAudioKeyframe(MoveAudioKeyframePayload),

    #[serde(alias = "setAudioKeyframeValue", alias = "SetAudioKeyframeValue")]
    SetAudioKeyframeValue(SetAudioKeyframeValuePayload),

    #[serde(alias = "setAudioFadeIn", alias = "SetAudioFadeIn")]
    SetAudioFadeIn(SetAudioFadeInPayload),

    #[serde(alias = "setAudioFadeOut", alias = "SetAudioFadeOut")]
    SetAudioFadeOut(SetAudioFadeOutPayload),

    #[serde(alias = "setTrackBlendMode", alias = "SetTrackBlendMode")]
    SetTrackBlendMode(SetTrackBlendModePayload),

    #[serde(alias = "setClipBlendMode", alias = "SetClipBlendMode")]
    SetClipBlendMode(SetClipBlendModePayload),

    #[serde(alias = "importAsset", alias = "ImportAsset")]
    ImportAsset(ImportAssetPayload),

    #[serde(alias = "removeAsset", alias = "RemoveAsset")]
    RemoveAsset(RemoveAssetPayload),

    #[serde(alias = "updateAsset", alias = "UpdateAsset")]
    UpdateAsset(UpdateAssetPayload),

    #[serde(alias = "createSequence", alias = "CreateSequence")]
    CreateSequence(CreateSequencePayload),

    #[serde(alias = "setMasterVolume", alias = "SetMasterVolume")]
    SetMasterVolume(SetMasterVolumePayload),

    #[serde(
        alias = "updateSequenceHdrSettings",
        alias = "UpdateSequenceHdrSettings"
    )]
    UpdateSequenceHdrSettings(UpdateSequenceHdrSettingsPayload),

    #[serde(alias = "setSequenceFormat", alias = "SetSequenceFormat")]
    SetSequenceFormat(SetSequenceFormatPayload),

    #[serde(
        alias = "createTrack",
        alias = "CreateTrack",
        alias = "addTrack",
        alias = "AddTrack"
    )]
    CreateTrack(CreateTrackPayload),

    #[serde(
        alias = "removeTrack",
        alias = "RemoveTrack",
        alias = "deleteTrack",
        alias = "DeleteTrack"
    )]
    RemoveTrack(RemoveTrackPayload),

    #[serde(alias = "renameTrack", alias = "RenameTrack")]
    RenameTrack(RenameTrackPayload),

    #[serde(alias = "setCaptionTrackLanguage", alias = "SetCaptionTrackLanguage")]
    SetCaptionTrackLanguage(SetCaptionTrackLanguagePayload),

    #[serde(alias = "reorderTracks", alias = "ReorderTracks")]
    ReorderTracks(ReorderTracksPayload),

    #[serde(alias = "setTrackVolume", alias = "SetTrackVolume")]
    SetTrackVolume(SetTrackVolumePayload),

    #[serde(alias = "toggleTrackMute", alias = "ToggleTrackMute")]
    ToggleTrackMute(ToggleTrackMutePayload),

    #[serde(alias = "toggleTrackLock", alias = "ToggleTrackLock")]
    ToggleTrackLock(ToggleTrackLockPayload),

    #[serde(alias = "toggleTrackVisibility", alias = "ToggleTrackVisibility")]
    ToggleTrackVisibility(ToggleTrackVisibilityPayload),

    // Marker commands
    #[serde(alias = "addMarker", alias = "AddMarker")]
    AddMarker(AddMarkerPayload),

    #[serde(
        alias = "removeMarker",
        alias = "RemoveMarker",
        alias = "deleteMarker",
        alias = "DeleteMarker"
    )]
    RemoveMarker(RemoveMarkerPayload),

    #[serde(
        alias = "createCaption",
        alias = "CreateCaption",
        alias = "addCaption",
        alias = "AddCaption"
    )]
    CreateCaption(CreateCaptionPayload),

    #[serde(
        alias = "importGeneratedCaptions",
        alias = "ImportGeneratedCaptions",
        alias = "createCaptionsFromTranscript",
        alias = "CreateCaptionsFromTranscript",
        alias = "addCaptionsFromTranscription",
        alias = "AddCaptionsFromTranscription"
    )]
    ImportGeneratedCaptions(ImportGeneratedCaptionsPayload),

    #[serde(alias = "deleteCaption", alias = "DeleteCaption")]
    DeleteCaption(DeleteCaptionPayload),

    #[serde(
        alias = "updateCaption",
        alias = "UpdateCaption",
        alias = "styleCaption",
        alias = "StyleCaption"
    )]
    UpdateCaption(UpdateCaptionPayload),

    #[serde(alias = "addEffect", alias = "AddEffect")]
    AddEffect(AddEffectPayload),

    #[serde(alias = "removeEffect", alias = "RemoveEffect")]
    RemoveEffect(RemoveEffectPayload),

    #[serde(alias = "updateEffect", alias = "UpdateEffect")]
    UpdateEffect(UpdateEffectPayload),

    // Mask commands
    #[serde(alias = "addMask", alias = "AddMask")]
    AddMask(AddMaskPayload),

    #[serde(alias = "updateMask", alias = "UpdateMask")]
    UpdateMask(UpdateMaskPayload),

    #[serde(
        alias = "removeMask",
        alias = "RemoveMask",
        alias = "deleteMask",
        alias = "DeleteMask"
    )]
    RemoveMask(RemoveMaskPayload),

    // Text clip commands
    #[serde(alias = "addTextClip", alias = "AddTextClip")]
    AddTextClip(AddTextClipPayload),

    #[serde(alias = "updateTextClip", alias = "UpdateTextClip")]
    UpdateTextClip(UpdateTextClipPayload),

    #[serde(alias = "removeTextClip", alias = "RemoveTextClip")]
    RemoveTextClip(RemoveTextClipPayload),

    // Filesystem commands
    #[serde(alias = "createFolder", alias = "CreateFolder")]
    CreateFolder(CreateFolderPayload),

    #[serde(alias = "renameFile", alias = "RenameFile")]
    RenameFile(RenameFilePayload),

    #[serde(alias = "moveFile", alias = "MoveFile")]
    MoveFile(MoveFilePayload),

    #[serde(alias = "deleteFile", alias = "DeleteFile")]
    DeleteFile(DeleteFilePayload),

    #[serde(alias = "applyAudioDucking", alias = "ApplyAudioDucking")]
    ApplyAudioDucking(ApplyAudioDuckingPayload),

    #[serde(alias = "createCompoundClip", alias = "CreateCompoundClip")]
    CreateCompoundClip(CreateCompoundClipPayload),

    #[serde(alias = "unnestCompoundClip", alias = "UnnestCompoundClip")]
    UnnestCompoundClip(UnnestCompoundClipPayload),

    #[serde(alias = "createAdjustmentLayer", alias = "CreateAdjustmentLayer")]
    CreateAdjustmentLayer(CreateAdjustmentLayerPayload),

    #[serde(alias = "pasteEffects", alias = "PasteEffects")]
    PasteEffects(PasteEffectsPayload),

    #[serde(alias = "pasteAttributes", alias = "PasteAttributes")]
    PasteAttributes(PasteAttributesPayload),

    #[serde(alias = "removeAttributes", alias = "RemoveAttributes")]
    RemoveAttributes(RemoveAttributesPayload),
}

// The one place the backend command surface is declared: each canonical
// PascalCase command type paired with the payload it parses into. The macro
// generates `CommandPayload::SUPPORTED_COMMAND_TYPES` and the
// `command_payload_schema` lookup from this single list, so a command cannot be
// advertised without a schema or carry a schema nobody can reach.
declare_command_payloads! {
    "InsertClip" => InsertClipPayload,
    "InsertMedia" => InsertMediaPayload,
    "InsertEdit" => InsertEditPayload,
    "OverwriteEdit" => OverwriteEditPayload,
    "RippleDelete" => RippleDeletePayload,
    "Lift" => LiftPayload,
    "ExtractEdit" => ExtractEditPayload,
    "CloseGap" => CloseGapPayload,
    "CloseAllGaps" => CloseAllGapsPayload,
    "RemoveClip" => RemoveClipPayload,
    "MoveClip" => MoveClipPayload,
    "TrimClip" => TrimClipPayload,
    "SplitClip" => SplitClipPayload,
    "SetClipTransform" => SetClipTransformPayload,
    "SetClipMotionKeyframes" => SetClipMotionKeyframesPayload,
    "SetClipOpacity" => SetClipOpacityPayload,
    "SetClipSpeed" => SetClipSpeedPayload,
    "SetClipSlowMotionInterpolation" => SetClipSlowMotionInterpolationPayload,
    "ReverseClip" => ReverseClipPayload,
    "SetClipEnabled" => SetClipEnabledPayload,
    "LinkClips" => LinkClipsPayload,
    "UnlinkClips" => UnlinkClipsPayload,
    "GroupClips" => GroupClipsPayload,
    "UngroupClips" => UngroupClipsPayload,
    "DetachAudio" => DetachAudioPayload,
    "CreateFreezeFrame" => CreateFreezeFramePayload,
    "SetTimeRemap" => SetTimeRemapPayload,
    "ClearTimeRemap" => ClearTimeRemapPayload,
    "SetClipMute" => SetClipMutePayload,
    "SetClipAudio" => SetClipAudioPayload,
    "AddAudioKeyframe" => AddAudioKeyframePayload,
    "RemoveAudioKeyframe" => RemoveAudioKeyframePayload,
    "MoveAudioKeyframe" => MoveAudioKeyframePayload,
    "SetAudioKeyframeValue" => SetAudioKeyframeValuePayload,
    "SetAudioFadeIn" => SetAudioFadeInPayload,
    "SetAudioFadeOut" => SetAudioFadeOutPayload,
    "SetTrackBlendMode" => SetTrackBlendModePayload,
    "SetClipBlendMode" => SetClipBlendModePayload,
    "ImportAsset" => ImportAssetPayload,
    "RemoveAsset" => RemoveAssetPayload,
    "UpdateAsset" => UpdateAssetPayload,
    "CreateSequence" => CreateSequencePayload,
    "SetMasterVolume" => SetMasterVolumePayload,
    "UpdateSequenceHdrSettings" => UpdateSequenceHdrSettingsPayload,
    "SetSequenceFormat" => SetSequenceFormatPayload,
    "CreateTrack" => CreateTrackPayload,
    "RemoveTrack" => RemoveTrackPayload,
    "RenameTrack" => RenameTrackPayload,
    "SetCaptionTrackLanguage" => SetCaptionTrackLanguagePayload,
    "ReorderTracks" => ReorderTracksPayload,
    "SetTrackVolume" => SetTrackVolumePayload,
    "ToggleTrackMute" => ToggleTrackMutePayload,
    "ToggleTrackLock" => ToggleTrackLockPayload,
    "ToggleTrackVisibility" => ToggleTrackVisibilityPayload,
    "AddMarker" => AddMarkerPayload,
    "RemoveMarker" => RemoveMarkerPayload,
    "CreateCaption" => CreateCaptionPayload,
    "ImportGeneratedCaptions" => ImportGeneratedCaptionsPayload,
    "DeleteCaption" => DeleteCaptionPayload,
    "UpdateCaption" => UpdateCaptionPayload,
    "AddEffect" => AddEffectPayload,
    "RemoveEffect" => RemoveEffectPayload,
    "UpdateEffect" => UpdateEffectPayload,
    "AddMask" => AddMaskPayload,
    "UpdateMask" => UpdateMaskPayload,
    "RemoveMask" => RemoveMaskPayload,
    "AddTextClip" => AddTextClipPayload,
    "UpdateTextClip" => UpdateTextClipPayload,
    "RemoveTextClip" => RemoveTextClipPayload,
    "CreateFolder" => CreateFolderPayload,
    "RenameFile" => RenameFilePayload,
    "MoveFile" => MoveFilePayload,
    "DeleteFile" => DeleteFilePayload,
    "ApplyAudioDucking" => ApplyAudioDuckingPayload,
    "CreateCompoundClip" => CreateCompoundClipPayload,
    "UnnestCompoundClip" => UnnestCompoundClipPayload,
    "CreateAdjustmentLayer" => CreateAdjustmentLayerPayload,
    "PasteEffects" => PasteEffectsPayload,
    "PasteAttributes" => PasteAttributesPayload,
    "RemoveAttributes" => RemoveAttributesPayload,
}

impl CommandPayload {
    /// Hard limit to prevent DoS via massive IPC payloads.
    ///
    /// This is intentionally conservative: edit commands should remain small and
    /// structured (IDs + timestamps), not bulk data blobs.
    const MAX_PAYLOAD_BYTES: usize = 512 * 1024; // 512 KiB

    pub fn parse(command_type: String, payload: serde_json::Value) -> Result<Self, String> {
        let command_type_trimmed = command_type.trim();
        if command_type_trimmed.is_empty() {
            return Err("commandType is empty".to_string());
        }
        if command_type_trimmed.len() > 128 {
            return Err("commandType is too long".to_string());
        }
        if command_type_trimmed.chars().any(|c| c.is_control()) {
            return Err("commandType contains control characters".to_string());
        }

        // Best-effort size check before attempting strict deserialization.
        // `serde_json::Value` already exists, so this is primarily to cap the
        // additional work + allocations that can happen during parsing.
        let payload_size = serde_json::to_vec(&payload)
            .map(|v| v.len())
            .unwrap_or(Self::MAX_PAYLOAD_BYTES + 1);
        if payload_size > Self::MAX_PAYLOAD_BYTES {
            return Err(format!(
                "Command payload too large ({} bytes, max {})",
                payload_size,
                Self::MAX_PAYLOAD_BYTES
            ));
        }

        let raw_request = serde_json::json!({
            "commandType": command_type_trimmed,
            "payload": payload
        });
        let mut parsed: Self = serde_json::from_value(raw_request)
            .map_err(|e| format!("Invalid command payload: {}", e))?;
        parsed.resolve_curated_packs()?;
        Ok(parsed)
    }

    /// Whether this payload leaves the sequence to the project's active one.
    ///
    /// Every surface that applies a command has to know which timeline the edit
    /// is measured against *before* it runs, and it reads that off the raw
    /// payload. A payload that carries no `sequenceId` normally names no
    /// timeline at all — an asset import, a `CreateSequence` — and is reported
    /// with no sequence and no affected ranges rather than a guess.
    ///
    /// `SetSequenceFormat` is the exception: its `sequenceId` is optional and
    /// the command itself falls back to `ProjectState::active_sequence_id`. It
    /// is the only such payload today — every other sequence-scoped payload
    /// declares `sequence_id` as required and fails to parse without one — so
    /// this is a match rather than a set of type names.
    pub fn targets_active_sequence(&self) -> bool {
        match self {
            Self::SetSequenceFormat(payload) => payload.sequence_id.is_none(),
            _ => false,
        }
    }

    /// Expands curated caption packs and transition recipes into explicit values.
    ///
    /// This runs at the single strict-parsing chokepoint every JSON entry point
    /// shares — GUI IPC, `command execute`, `plan execute`, agent steps — so a
    /// pack id is resolved once, before the command is built. What reaches the
    /// op log is the concrete style or effect type the pack produced; the id
    /// itself is not persisted, which is what makes replay independent of the
    /// pack table rather than a lookup into a registry that may have moved.
    ///
    /// The resolution is idempotent: re-parsing an already-resolved payload
    /// yields the same values, because the explicit fields it wrote fully cover
    /// the pack layer underneath.
    ///
    /// `UpdateCaption` is the one asymmetric case: a pack there contributes
    /// style only. The command replaces the stored anchor whenever it carries
    /// one, so inheriting the pack anchor would move a caption whose placement
    /// the caller never mentioned.
    fn resolve_curated_packs(&mut self) -> Result<(), String> {
        use crate::core::style::{
            resolve_caption_layers, resolve_caption_style, resolve_effect_recipe,
        };

        /// Applies a caption pack in place, leaving explicit values on top.
        fn apply_caption_pack(
            style_pack: Option<&str>,
            style: &mut Option<serde_json::Value>,
            position: &mut Option<serde_json::Value>,
        ) -> Result<(), String> {
            let resolved = resolve_caption_layers(style_pack, style.take(), position.take())?;
            *style = resolved.style;
            *position = resolved.position;
            Ok(())
        }

        match self {
            Self::CreateCaption(payload) => apply_caption_pack(
                payload.style_pack.as_deref(),
                &mut payload.style,
                &mut payload.position,
            )?,
            Self::UpdateCaption(payload) => {
                payload.style =
                    resolve_caption_style(payload.style_pack.as_deref(), payload.style.take())?;
            }
            Self::ImportGeneratedCaptions(payload) => apply_caption_pack(
                payload.style_pack.as_deref(),
                &mut payload.style,
                &mut payload.position,
            )?,
            Self::AddEffect(payload) => {
                let resolved = resolve_effect_recipe(
                    payload.recipe.as_deref(),
                    payload.effect_type.take(),
                    std::mem::take(&mut payload.params),
                )?;
                payload.effect_type = resolved.effect_type;
                payload.params = resolved.params;

                if payload.effect_type.is_none() {
                    return Err(
                        "AddEffect requires effectType, or a recipe that supplies one".to_string(),
                    );
                }
            }
            _ => {}
        }

        Ok(())
    }

    /// Converts a validated `CommandPayload` into an executable `Command` trait object.
    ///
    /// This function extracts the command construction logic so that it can be
    /// reused by both the `execute_command` IPC handler and the agent plan executor.
    ///
    /// `project_path` is needed only for filesystem commands (CreateFolder, RenameFile, etc.).
    pub fn build_command(
        self,
        project_path: &std::path::Path,
    ) -> Box<dyn crate::core::commands::Command> {
        use crate::core::commands::{
            AddAudioKeyframeCommand, AddEffectCommand, AddMarkerCommand, AddMaskCommand,
            AddTextClipCommand, AddTrackCommand, ApplyAudioDuckingCommand, ClearTimeRemapCommand,
            CloseAllGapsCommand, CloseGapCommand, CreateCaptionCommand, CreateFolderCommand,
            CreateFreezeFrameCommand, CreateSequenceCommand, DeleteCaptionCommand,
            DeleteFileCommand, DetachAudioCommand, ExtractEditCommand, GeneratedCaptionSegment,
            GroupClipsCommand, ImportAssetCommand, ImportGeneratedCaptionsCommand,
            InsertClipCommand, InsertEditCommand, InsertMediaCommand, LiftCommand,
            LinkClipsCommand, MoveAudioKeyframeCommand, MoveClipCommand, MoveFileCommand,
            OverwriteEditCommand, RemoveAssetCommand, RemoveAudioKeyframeCommand,
            RemoveClipCommand, RemoveEffectCommand, RemoveMarkerCommand, RemoveMaskCommand,
            RemoveTextClipCommand, RemoveTrackCommand, RenameFileCommand, RenameTrackCommand,
            ReorderTracksCommand, ReverseClipCommand, RippleDeleteCommand, SetAudioFadeInCommand,
            SetAudioFadeOutCommand, SetAudioKeyframeValueCommand, SetCaptionTrackLanguageCommand,
            SetClipAudioCommand, SetClipBlendModeCommand, SetClipEnabledCommand,
            SetClipMotionKeyframesCommand, SetClipMuteCommand, SetClipOpacityCommand,
            SetClipSlowMotionInterpolationCommand, SetClipSpeedCommand, SetClipTransformCommand,
            SetMasterVolumeCommand, SetSequenceFormatCommand, SetTimeRemapCommand,
            SetTrackBlendModeCommand, SetTrackVolumeCommand, SplitClipCommand,
            ToggleTrackLockCommand, ToggleTrackMuteCommand, ToggleTrackVisibilityCommand,
            TrimClipCommand, UngroupClipsCommand, UnlinkClipsCommand, UnnestCompoundClipCommand,
            UpdateAssetCommand, UpdateEffectCommand, UpdateMaskCommand,
            UpdateSequenceHdrSettingsCommand, UpdateTextCommand,
        };

        use crate::core::commands::{
            CreateAdjustmentLayerCommand, CreateCompoundClipCommand, PasteAttributesCommand,
            PasteEffectsCommand, RemoveAttributesCommand,
        };

        match self {
            CommandPayload::InsertClip(p) => {
                let mut command = InsertClipCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_start,
                );
                command.source_start = p.source_in;
                command.source_end = p.source_out;
                Box::new(command)
            }
            CommandPayload::InsertMedia(p) => {
                let command = InsertMediaCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_start,
                )
                .with_source_range(p.source_in, p.source_out)
                .with_audio_only(p.audio_only)
                .with_auto_extract_linked_audio(p.auto_extract_linked_audio);
                Box::new(command)
            }
            CommandPayload::InsertEdit(p) => {
                let mut command = InsertEditCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_position,
                );
                command.source_start = p.source_in;
                command.source_end = p.source_out;
                Box::new(command)
            }
            CommandPayload::OverwriteEdit(p) => {
                let mut command = OverwriteEditCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.asset_id,
                    p.timeline_position,
                );
                command.source_start = p.source_in;
                command.source_end = p.source_out;
                Box::new(command)
            }
            CommandPayload::RippleDelete(p) => Box::new(RippleDeleteCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.clip_ids,
            )),
            CommandPayload::Lift(p) => {
                Box::new(LiftCommand::new(&p.sequence_id, &p.track_id, p.clip_ids))
            }
            CommandPayload::ExtractEdit(p) => Box::new(ExtractEditCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.in_point,
                p.out_point,
            )),
            CommandPayload::CloseGap(p) => Box::new(CloseGapCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.gap_start,
                p.gap_end,
            )),
            CommandPayload::CloseAllGaps(p) => {
                Box::new(CloseAllGapsCommand::new(&p.sequence_id, &p.track_id))
            }
            CommandPayload::RemoveClip(p) => Box::new(RemoveClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::MoveClip(p) => Box::new(MoveClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.new_timeline_in,
                p.new_track_id,
            )),
            CommandPayload::TrimClip(p) => Box::new(TrimClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.new_source_in,
                p.new_source_out,
                p.new_timeline_in,
            )),
            CommandPayload::SplitClip(p) => Box::new(SplitClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.split_time,
            )),
            CommandPayload::SetClipTransform(p) => Box::new(SetClipTransformCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.transform,
            )),
            CommandPayload::SetClipMotionKeyframes(p) => {
                Box::new(SetClipMotionKeyframesCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.keyframes,
                ))
            }
            CommandPayload::SetClipOpacity(p) => Box::new(SetClipOpacityCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.opacity,
            )),
            CommandPayload::SetClipSpeed(p) => Box::new(SetClipSpeedCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.speed,
                p.reverse,
            )),
            CommandPayload::SetClipSlowMotionInterpolation(p) => {
                Box::new(SetClipSlowMotionInterpolationCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.interpolation,
                ))
            }
            CommandPayload::ReverseClip(p) => Box::new(ReverseClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::SetClipEnabled(p) => Box::new(SetClipEnabledCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.enabled,
            )),
            CommandPayload::LinkClips(p) => Box::new(LinkClipsCommand::new(
                &p.sequence_id,
                p.clip_refs
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect(),
            )),
            CommandPayload::UnlinkClips(p) => Box::new(UnlinkClipsCommand::new(
                &p.sequence_id,
                p.clip_refs
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect(),
            )),
            CommandPayload::GroupClips(p) => Box::new(GroupClipsCommand::new(
                &p.sequence_id,
                p.clip_refs
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect(),
            )),
            CommandPayload::UngroupClips(p) => Box::new(UngroupClipsCommand::new(
                &p.sequence_id,
                p.clip_refs
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect(),
            )),
            CommandPayload::DetachAudio(p) => Box::new(DetachAudioCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.target_audio_track_id,
            )),
            CommandPayload::CreateFreezeFrame(p) => Box::new(CreateFreezeFrameCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.playhead_sec,
                p.duration_sec,
            )),
            CommandPayload::SetTimeRemap(p) => Box::new(SetTimeRemapCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.time_remap,
            )),
            CommandPayload::ClearTimeRemap(p) => Box::new(ClearTimeRemapCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::SetClipMute(p) => Box::new(SetClipMuteCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.muted,
            )),
            CommandPayload::SetClipAudio(p) => {
                let mut cmd = SetClipAudioCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.volume_db,
                    p.pan,
                    p.muted,
                    p.fade_in_sec,
                    p.fade_out_sec,
                );
                if let Some(audio_role) = p.audio_role {
                    cmd = cmd.with_audio_role(audio_role);
                }
                if let Some(audio_tags) = p.audio_tags {
                    cmd = cmd.with_audio_tags(audio_tags);
                }
                Box::new(cmd)
            }
            CommandPayload::AddAudioKeyframe(p) => Box::new(AddAudioKeyframeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.time_offset,
                p.value_db,
                p.interpolation,
            )),
            CommandPayload::RemoveAudioKeyframe(p) => Box::new(RemoveAudioKeyframeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.keyframe_index,
            )),
            CommandPayload::MoveAudioKeyframe(p) => Box::new(MoveAudioKeyframeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.keyframe_index,
                p.new_time_offset,
            )),
            CommandPayload::SetAudioKeyframeValue(p) => {
                Box::new(SetAudioKeyframeValueCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.keyframe_index,
                    p.value_db,
                    p.interpolation,
                ))
            }
            CommandPayload::SetAudioFadeIn(p) => Box::new(SetAudioFadeInCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.duration,
                p.fade_type,
            )),
            CommandPayload::SetAudioFadeOut(p) => Box::new(SetAudioFadeOutCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.duration,
                p.fade_type,
            )),
            CommandPayload::SetTrackBlendMode(p) => Box::new(SetTrackBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.blend_mode,
            )),
            CommandPayload::SetTrackVolume(p) => Box::new(SetTrackVolumeCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.volume,
            )),
            CommandPayload::SetClipBlendMode(p) => Box::new(SetClipBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.blend_mode,
            )),
            CommandPayload::ImportAsset(p) => Box::new(ImportAssetCommand::new(&p.name, &p.uri)),
            CommandPayload::RemoveAsset(p) => Box::new(RemoveAssetCommand::new(&p.asset_id)),
            CommandPayload::UpdateAsset(p) => {
                let mut cmd = UpdateAssetCommand::new(&p.asset_id);
                if let Some(name) = &p.name {
                    cmd = cmd.with_name(name);
                }
                if let Some(tags) = p.tags {
                    cmd = cmd.with_tags(tags);
                }
                if let Some(license) = p.license {
                    cmd = cmd.with_license(license);
                }
                if let Some(thumbnail_url) = p.thumbnail_url {
                    cmd = cmd.with_thumbnail_url(thumbnail_url);
                }
                if let Some(proxy_status) = p.proxy_status {
                    cmd = cmd.with_proxy_status(proxy_status);
                }
                if let Some(proxy_url) = p.proxy_url {
                    cmd = cmd.with_proxy_url(proxy_url);
                }
                if let Some(uri) = &p.uri {
                    cmd = cmd.with_uri(uri);
                }
                if let Some(duration_sec) = p.duration_sec {
                    cmd = cmd.with_duration_sec(duration_sec);
                }
                if let Some(file_size) = p.file_size {
                    cmd = cmd.with_file_size(file_size);
                }
                if let Some(video) = p.video {
                    cmd = cmd.with_video(video);
                }
                if let Some(audio) = p.audio {
                    cmd = cmd.with_audio(audio);
                }
                if let Some(relative_path) = p.relative_path {
                    cmd = cmd.with_relative_path(relative_path);
                }
                if let Some(workspace_managed) = p.workspace_managed {
                    cmd = cmd.with_workspace_managed(workspace_managed);
                }
                if let Some(missing) = p.missing {
                    cmd = cmd.with_missing(missing);
                }
                Box::new(cmd)
            }
            CommandPayload::CreateSequence(p) => Box::new(CreateSequenceCommand::new(
                &p.name,
                &p.format.unwrap_or_else(|| "1080p".to_string()),
            )),
            CommandPayload::SetMasterVolume(p) => {
                Box::new(SetMasterVolumeCommand::new(&p.sequence_id, p.volume_db))
            }
            CommandPayload::UpdateSequenceHdrSettings(p) => Box::new(
                UpdateSequenceHdrSettingsCommand::new(&p.sequence_id, p.settings),
            ),
            CommandPayload::SetSequenceFormat(p) => {
                let mut cmd = SetSequenceFormatCommand::new();
                cmd.sequence_id = p.sequence_id;
                cmd.fps = p.fps;
                cmd.width = p.width;
                cmd.height = p.height;
                cmd.audio_sample_rate = p.audio_sample_rate;
                cmd.audio_channels = p.audio_channels;
                Box::new(cmd)
            }
            CommandPayload::CreateTrack(p) => {
                let mut cmd = AddTrackCommand::new(&p.sequence_id, &p.name, p.kind);
                if let Some(position) = p.position {
                    cmd = cmd.at_position(position);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveTrack(p) => {
                Box::new(RemoveTrackCommand::new(&p.sequence_id, &p.track_id))
            }
            CommandPayload::RenameTrack(p) => Box::new(RenameTrackCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.new_name,
            )),
            CommandPayload::SetCaptionTrackLanguage(p) => Box::new(
                SetCaptionTrackLanguageCommand::new(&p.sequence_id, &p.track_id, &p.language),
            ),
            CommandPayload::ReorderTracks(p) => {
                Box::new(ReorderTracksCommand::new(&p.sequence_id, p.new_order))
            }
            CommandPayload::ToggleTrackMute(p) => Box::new(ToggleTrackMuteCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.muted,
            )),
            CommandPayload::ToggleTrackLock(p) => Box::new(ToggleTrackLockCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.locked,
            )),
            CommandPayload::ToggleTrackVisibility(p) => Box::new(
                ToggleTrackVisibilityCommand::new(&p.sequence_id, &p.track_id, p.visible),
            ),
            CommandPayload::AddMarker(p) => {
                let mut cmd = AddMarkerCommand::new(&p.sequence_id, p.time_sec, &p.label);
                if let Some(color) = p.color {
                    cmd = cmd.with_color(color);
                }
                if let Some(marker_type) = p.marker_type {
                    cmd = cmd.with_marker_type(marker_type);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveMarker(p) => {
                Box::new(RemoveMarkerCommand::new(&p.sequence_id, &p.marker_id))
            }
            CommandPayload::CreateCaption(p) => Box::new(
                CreateCaptionCommand::new(&p.sequence_id, &p.track_id, p.start_sec, p.end_sec)
                    .with_text(p.text)
                    .with_style(p.style)
                    .with_position(p.position),
            ),
            CommandPayload::ImportGeneratedCaptions(p) => {
                let segments = p
                    .segments
                    .into_iter()
                    .map(|segment| GeneratedCaptionSegment {
                        start_sec: segment.start_sec,
                        end_sec: segment.end_sec,
                        text: segment.text,
                        confidence: segment.confidence,
                        speaker: segment.speaker,
                        language: segment.language,
                    })
                    .collect();
                Box::new(
                    ImportGeneratedCaptionsCommand::new(&p.sequence_id, &p.track_id, segments)
                        .with_style(p.style)
                        .with_position(p.position)
                        .replace_existing(p.replace_existing),
                )
            }
            CommandPayload::DeleteCaption(p) => Box::new(DeleteCaptionCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.caption_id,
            )),
            CommandPayload::UpdateCaption(p) => Box::new(
                crate::core::commands::UpdateCaptionCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.caption_id,
                )
                .with_text(p.text)
                .with_time_range(p.start_sec, p.end_sec)
                .with_style(p.style)
                .with_position(p.position),
            ),
            CommandPayload::AddEffect(p) => {
                // `parse` has already folded any recipe into `effect_type`; an
                // absent type is rejected there and again at execute.
                let mut cmd = AddEffectCommand::with_optional_type(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    p.effect_type,
                );
                for (key, value) in p.params {
                    cmd = cmd.with_param(key, value);
                }
                for (key, keyframes) in p.keyframes {
                    cmd = cmd.with_keyframes(key, keyframes);
                }
                if let Some(pos) = p.position {
                    cmd = cmd.at_position(pos);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveEffect(p) => Box::new(RemoveEffectCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                &p.effect_id,
            )),
            CommandPayload::UpdateEffect(p) => {
                let mut cmd = UpdateEffectCommand::new(&p.effect_id);
                for (key, value) in p.params {
                    cmd = cmd.with_param(key, value);
                }
                if let Some(enabled) = p.enabled {
                    cmd = cmd.set_enabled(enabled);
                }
                Box::new(cmd)
            }
            CommandPayload::AddMask(p) => {
                let mut cmd = AddMaskCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    &p.clip_id,
                    &p.effect_id,
                    p.shape,
                );
                if let Some(name) = p.name {
                    cmd = cmd.with_name(name);
                }
                if p.feather > 0.0 {
                    cmd = cmd.with_feather(p.feather);
                }
                if p.inverted {
                    cmd = cmd.inverted();
                }
                if !p.keyframes.is_empty() {
                    cmd = cmd.with_keyframes(p.keyframes);
                }
                if let Some(tracking_source_id) = p.tracking_source_id {
                    cmd = cmd.with_tracking_source_id(tracking_source_id);
                }
                Box::new(cmd)
            }
            CommandPayload::UpdateMask(p) => {
                let mut cmd = UpdateMaskCommand::new(&p.effect_id, &p.mask_id);
                if let Some(shape) = p.shape {
                    cmd = cmd.with_shape(shape);
                }
                if let Some(name) = p.name {
                    cmd = cmd.with_name(name);
                }
                if let Some(feather) = p.feather {
                    cmd = cmd.with_feather(feather);
                }
                if let Some(opacity) = p.opacity {
                    cmd = cmd.with_opacity(opacity);
                }
                if let Some(expansion) = p.expansion {
                    cmd = cmd.with_expansion(expansion);
                }
                if let Some(inverted) = p.inverted {
                    cmd = cmd.with_inverted(inverted);
                }
                if let Some(blend_mode) = p.blend_mode {
                    cmd = cmd.with_blend_mode(blend_mode);
                }
                if let Some(enabled) = p.enabled {
                    cmd = cmd.with_enabled(enabled);
                }
                if let Some(locked) = p.locked {
                    cmd = cmd.with_locked(locked);
                }
                if let Some(keyframes) = p.keyframes {
                    cmd = cmd.with_keyframes(keyframes);
                }
                if let Some(tracking_source_id) = p.tracking_source_id {
                    cmd = cmd.with_tracking_source_id(tracking_source_id);
                }
                Box::new(cmd)
            }
            CommandPayload::RemoveMask(p) => {
                Box::new(RemoveMaskCommand::new(&p.effect_id, &p.mask_id))
            }
            CommandPayload::AddTextClip(p) => Box::new(AddTextClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.timeline_in,
                p.duration,
                p.text_data,
            )),
            CommandPayload::UpdateTextClip(p) => Box::new(UpdateTextCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.text_data,
            )),
            CommandPayload::RemoveTextClip(p) => Box::new(RemoveTextClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::CreateFolder(p) => Box::new(CreateFolderCommand::new(
                &p.relative_path,
                project_path.to_path_buf(),
            )),
            CommandPayload::RenameFile(p) => Box::new(RenameFileCommand::new(
                &p.old_relative_path,
                &p.new_name,
                project_path.to_path_buf(),
            )),
            CommandPayload::MoveFile(p) => Box::new(MoveFileCommand::new(
                &p.source_path,
                &p.dest_folder_path,
                project_path.to_path_buf(),
            )),
            CommandPayload::DeleteFile(p) => Box::new(DeleteFileCommand::new(
                &p.relative_path,
                project_path.to_path_buf(),
            )),

            CommandPayload::ApplyAudioDucking(p) => Box::new(ApplyAudioDuckingCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.keyframes,
            )),
            CommandPayload::CreateCompoundClip(p) => {
                let mut cmd =
                    CreateCompoundClipCommand::new(&p.sequence_id, &p.track_id, p.clip_ids);
                if let Some(name) = p.name {
                    cmd = cmd.with_name(&name);
                }
                Box::new(cmd)
            }
            CommandPayload::UnnestCompoundClip(p) => Box::new(UnnestCompoundClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
            )),
            CommandPayload::CreateAdjustmentLayer(p) => {
                let mut cmd = CreateAdjustmentLayerCommand::new(
                    &p.sequence_id,
                    &p.track_id,
                    p.position,
                    p.duration,
                );
                if let Some(name) = p.name {
                    cmd = cmd.with_name(&name);
                }
                Box::new(cmd)
            }
            CommandPayload::PasteEffects(p) => {
                let target_clips: Vec<(String, String)> = p
                    .target_clips
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect();
                Box::new(PasteEffectsCommand::new(
                    p.sequence_id,
                    target_clips,
                    p.source_effects,
                ))
            }
            CommandPayload::PasteAttributes(p) => {
                let target_clips: Vec<(String, String)> = p
                    .target_clips
                    .into_iter()
                    .map(|r| (r.track_id, r.clip_id))
                    .collect();
                Box::new(PasteAttributesCommand::new(
                    p.sequence_id,
                    target_clips,
                    p.source_effects,
                    p.source_attributes,
                    p.selection,
                ))
            }
            CommandPayload::RemoveAttributes(p) => {
                let cmd = RemoveAttributesCommand::new(p.sequence_id, p.track_id, p.clip_id)
                    .with_effect_ids(p.effect_ids)
                    .with_reset_transform(p.reset_transform)
                    .with_reset_opacity(p.reset_opacity)
                    .with_reset_blend_mode(p.reset_blend_mode)
                    .with_reset_speed(p.reset_speed)
                    .with_reset_audio(p.reset_audio);
                Box::new(cmd)
            }
        }
    }
}

pub fn validate_command_payload_against_project_state(
    command_type: &str,
    payload: &CommandPayload,
    state: &ProjectState,
) -> Result<(), String> {
    match payload {
        CommandPayload::CreateCaption(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "caption",
            |track| track.is_caption(),
        ),
        CommandPayload::ImportGeneratedCaptions(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "caption",
            |track| track.is_caption(),
        ),
        CommandPayload::DeleteCaption(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "caption",
            |track| track.is_caption(),
        ),
        CommandPayload::UpdateCaption(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "caption",
            |track| track.is_caption(),
        ),
        CommandPayload::SetCaptionTrackLanguage(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "caption",
            |track| track.is_caption(),
        ),
        CommandPayload::AddTextClip(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "video or overlay",
            |track| track.is_video(),
        ),
        CommandPayload::UpdateTextClip(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "video or overlay",
            |track| track.is_video(),
        ),
        CommandPayload::RemoveTextClip(payload) => validate_track_kind(
            state,
            command_type,
            &payload.sequence_id,
            &payload.track_id,
            "video or overlay",
            |track| track.is_video(),
        ),
        _ => Ok(()),
    }
}

fn validate_track_kind(
    state: &ProjectState,
    command_type: &str,
    sequence_id: &str,
    track_id: &str,
    expected_kind: &str,
    predicate: impl Fn(&Track) -> bool,
) -> Result<(), String> {
    let sequence = state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| format!("{command_type} references missing sequence: {sequence_id}"))?;
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| format!("{command_type} references missing track: {track_id}"))?;

    if predicate(track) {
        Ok(())
    } else {
        Err(format!(
            "{command_type} requires a {expected_kind} track, but track {track_id} is {:?}",
            track.kind
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        project::ProjectState,
        timeline::{Sequence, SequenceFormat, SequenceHdrMode, Track, TrackKind},
    };

    fn state_with_video_and_caption_tracks() -> (ProjectState, String, String, String) {
        let mut state = ProjectState::new_empty("Validation Test");
        let mut sequence = Sequence::new("Main", SequenceFormat::youtube_1080());
        let sequence_id = sequence.id.clone();
        let video_track = Track::new("Video", TrackKind::Video);
        let video_track_id = video_track.id.clone();
        let caption_track = Track::new("Captions", TrackKind::Caption);
        let caption_track_id = caption_track.id.clone();

        sequence.add_track(video_track);
        sequence.add_track(caption_track);
        state.sequences.insert(sequence_id.clone(), sequence);

        (state, sequence_id, video_track_id, caption_track_id)
    }

    #[test]
    fn validate_project_state_rejects_import_generated_captions_on_video_track() {
        let (state, sequence_id, video_track_id, _) = state_with_video_and_caption_tracks();
        let payload = CommandPayload::parse(
            "ImportGeneratedCaptions".to_string(),
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": video_track_id,
                "segments": [{ "startSec": 0.0, "endSec": 1.0, "text": "Caption" }]
            }),
        )
        .expect("payload should parse");

        let error = validate_command_payload_against_project_state(
            "ImportGeneratedCaptions",
            &payload,
            &state,
        )
        .expect_err("video track should be rejected");

        assert!(error.contains("requires a caption track"));
    }

    #[test]
    fn validate_project_state_accepts_import_generated_captions_on_caption_track() {
        let (state, sequence_id, _, caption_track_id) = state_with_video_and_caption_tracks();
        let payload = CommandPayload::parse(
            "ImportGeneratedCaptions".to_string(),
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": caption_track_id,
                "segments": [{ "startSec": 0.0, "endSec": 1.0, "text": "Caption" }]
            }),
        )
        .expect("payload should parse");

        validate_command_payload_against_project_state("ImportGeneratedCaptions", &payload, &state)
            .expect("caption track should be accepted");
    }

    #[test]
    fn validate_project_state_rejects_add_text_clip_on_caption_track() {
        let (state, sequence_id, _, caption_track_id) = state_with_video_and_caption_tracks();
        let payload = CommandPayload::parse(
            "AddTextClip".to_string(),
            serde_json::json!({
                "sequenceId": sequence_id,
                "trackId": caption_track_id,
                "timelineIn": 0.0,
                "duration": 1.0,
                "textData": {
                    "content": "Overlay",
                    "style": {
                        "fontFamily": "Arial",
                        "fontSize": 48,
                        "color": "#FFFFFF"
                    },
                    "position": { "x": 0.5, "y": 0.5 }
                }
            }),
        )
        .expect("payload should parse");

        let error = validate_command_payload_against_project_state("AddTextClip", &payload, &state)
            .expect_err("caption track should be rejected");

        assert!(error.contains("requires a video or overlay track"));
    }
    use std::collections::HashSet;

    #[test]
    fn supported_command_types_are_unique_and_recognized_by_parser() {
        let mut seen = HashSet::new();

        for command_type in CommandPayload::SUPPORTED_COMMAND_TYPES {
            assert!(
                seen.insert(*command_type),
                "duplicate supported command type: {command_type}"
            );

            if let Err(error) =
                CommandPayload::parse((*command_type).to_string(), serde_json::json!({}))
            {
                assert!(
                    !error.contains("unknown variant"),
                    "{command_type} is listed but not recognized by CommandPayload::parse: {error}"
                );
            }
        }
    }

    #[test]
    fn parse_set_sequence_format_accepts_both_frame_rate_spellings() {
        let decimal = CommandPayload::parse(
            "SetSequenceFormat".to_string(),
            serde_json::json!({ "fps": 29.97, "width": 1080, "height": 1920 }),
        );
        match decimal {
            Ok(CommandPayload::SetSequenceFormat(inner)) => {
                assert_eq!(inner.sequence_id, None);
                assert_eq!(inner.fps, Some(FpsSpec::Decimal(29.97)));
                assert_eq!(inner.width, Some(1080));
                assert_eq!(inner.height, Some(1920));
                assert_eq!(inner.audio_sample_rate, None);
            }
            other => panic!("expected SetSequenceFormat payload, got: {other:?}"),
        }

        let ratio = CommandPayload::parse(
            "SetSequenceFormat".to_string(),
            serde_json::json!({ "fps": { "num": 24000, "den": 1001 } }),
        );
        match ratio {
            Ok(CommandPayload::SetSequenceFormat(inner)) => {
                assert_eq!(
                    inner.fps,
                    Some(FpsSpec::Ratio(crate::core::Ratio::new(24000, 1001)))
                );
            }
            other => panic!("expected SetSequenceFormat payload, got: {other:?}"),
        }
    }

    #[test]
    fn parse_set_sequence_format_rejects_an_unknown_field() {
        let error = CommandPayload::parse(
            "SetSequenceFormat".to_string(),
            serde_json::json!({ "fps": 25, "framerate": 25 }),
        )
        .expect_err("unknown fields are refused");

        assert!(error.contains("framerate"), "unexpected error: {error}");
    }

    #[test]
    fn parse_update_sequence_hdr_settings_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "settings": {
                "hdrMode": "hdr10",
                "maxCll": 1000,
                "maxFall": 400,
                "bitDepth": 10,
            },
        });

        let parsed = CommandPayload::parse("UpdateSequenceHdrSettings".to_string(), payload);
        match parsed {
            Ok(CommandPayload::UpdateSequenceHdrSettings(inner)) => {
                assert_eq!(inner.sequence_id, "seq_001");
                assert_eq!(inner.settings.hdr_mode, SequenceHdrMode::Hdr10);
                assert_eq!(inner.settings.bit_depth, 10);
                assert_eq!(inner.settings.max_cll, Some(1000));
                assert_eq!(inner.settings.max_fall, Some(400));
            }
            other => panic!("expected UpdateSequenceHdrSettings payload, got: {other:?}"),
        }
    }

    #[test]
    fn parse_update_caption_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "captionId": "cap_001",
            "text": "Updated text",
            "style": { "fontSize": 24 },
        });

        let parsed = CommandPayload::parse("UpdateCaption".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected UpdateCaption to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_create_caption_payload_supports_aliases() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "text": "Caption text",
            "startTime": 1.25,
            "endTime": 3.5,
        });

        for command_type in ["CreateCaption", "createCaption", "AddCaption", "addCaption"] {
            let parsed = CommandPayload::parse(command_type.to_string(), payload.clone());
            assert!(
                matches!(parsed, Ok(CommandPayload::CreateCaption(_))),
                "expected {command_type} alias to parse, got: {parsed:?}"
            );
        }
    }

    #[test]
    fn parse_import_generated_captions_payload_supports_transcription_aliases() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "segments": [
                {
                    "startTime": 0.0,
                    "endTime": 1.25,
                    "text": "Hello",
                    "confidence": 0.95,
                    "speakerId": "speaker_1",
                    "language": "en"
                }
            ],
            "style": { "fontSize": 42 },
            "position": { "type": "preset", "vertical": "bottom" },
            "replaceExisting": true
        });

        for command_type in [
            "ImportGeneratedCaptions",
            "importGeneratedCaptions",
            "CreateCaptionsFromTranscript",
            "addCaptionsFromTranscription",
        ] {
            let parsed = CommandPayload::parse(command_type.to_string(), payload.clone());
            match parsed {
                Ok(CommandPayload::ImportGeneratedCaptions(inner)) => {
                    assert_eq!(inner.segments.len(), 1);
                    assert_eq!(inner.segments[0].start_sec, 0.0);
                    assert_eq!(inner.segments[0].speaker.as_deref(), Some("speaker_1"));
                    assert!(inner.replace_existing);
                }
                other => panic!("expected {command_type} to parse, got: {other:?}"),
            }
        }
    }

    #[test]
    fn parse_delete_caption_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "captionId": "cap_001",
        });

        let parsed = CommandPayload::parse("DeleteCaption".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::DeleteCaption(_))),
            "expected DeleteCaption to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_add_effect_payload_supports_parameters_alias() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "effectType": "brightness",
            "parameters": {
                "value": 0.25
            }
        });

        let parsed = CommandPayload::parse("AddEffect".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::AddEffect(_))),
            "expected AddEffect with parameters alias to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_add_effect_payload_supports_keyframes() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "effectType": "gaussian_blur",
            "params": {
                "radius": 12.0
            },
            "keyframes": {
                "radius": [
                    {
                        "timeOffset": 0.0,
                        "value": 4.0,
                        "easing": "linear"
                    },
                    {
                        "timeOffset": 1.0,
                        "value": 12.0,
                        "easing": "ease_out"
                    }
                ]
            }
        });

        let parsed = CommandPayload::parse("AddEffect".to_string(), payload);
        match parsed {
            Ok(CommandPayload::AddEffect(payload)) => {
                assert_eq!(payload.keyframes.get("radius").map(Vec::len), Some(2));
            }
            other => panic!("expected AddEffect with keyframes to parse, got: {other:?}"),
        }
    }

    #[test]
    fn parse_ripple_delete_payload_supports_legacy_ai_shape() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "affectAllTracks": true,
        });

        let parsed = CommandPayload::parse("RippleDelete".to_string(), payload)
            .expect("expected legacy RippleDelete payload to parse");

        match parsed {
            CommandPayload::RippleDelete(inner) => {
                assert_eq!(inner.sequence_id, "seq_001");
                assert_eq!(inner.track_id, "track_001");
                assert_eq!(inner.clip_ids, vec!["clip_001".to_string()]);
            }
            other => panic!("expected RippleDelete payload, got: {other:?}"),
        }
    }

    #[test]
    fn parse_set_clip_transform_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "transform": {
                "position": { "x": 0.5, "y": 0.5 },
                "scale": { "x": 1.0, "y": 1.0 },
                "rotationDeg": 0.0,
                "anchor": { "x": 0.5, "y": 0.5 }
            }
        });

        let parsed = CommandPayload::parse("SetClipTransform".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected SetClipTransform to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_set_clip_motion_keyframes_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "keyframes": [
                {
                    "timeOffset": 0.0,
                    "interpolation": "linear",
                    "transform": {
                        "position": { "x": 0.5, "y": 0.5 },
                        "scale": { "x": 1.0, "y": 1.0 },
                        "rotationDeg": 0.0,
                        "anchor": { "x": 0.5, "y": 0.5 }
                    }
                }
            ]
        });

        let parsed = CommandPayload::parse("SetClipMotionKeyframes".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected SetClipMotionKeyframes to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetClipMotionKeyframes(inner)) = parsed {
            assert_eq!(inner.sequence_id, "seq_001");
            assert_eq!(inner.track_id, "track_001");
            assert_eq!(inner.clip_id, "clip_001");
            assert_eq!(inner.keyframes.len(), 1);
            assert_eq!(inner.keyframes[0].time_offset, 0.0);
        }
    }

    #[test]
    fn parse_set_clip_opacity_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "opacity": 0.45
        });

        let parsed = CommandPayload::parse("SetClipOpacity".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected SetClipOpacity to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetClipOpacity(inner)) = parsed {
            assert_eq!(inner.sequence_id, "seq_001");
            assert_eq!(inner.track_id, "track_001");
            assert_eq!(inner.clip_id, "clip_001");
            assert!((inner.opacity - 0.45).abs() < 0.001);
        }
    }

    #[test]
    fn parse_set_clip_speed_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "speed": 1.5,
        });

        let parsed = CommandPayload::parse("SetClipSpeed".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetClipSpeed(_))),
            "expected SetClipSpeed to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetClipSpeed(inner)) = parsed {
            assert!(!inner.reverse, "reverse should default to false");
        }
    }

    #[test]
    fn parse_set_clip_slow_motion_interpolation_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "interpolation": "motionCompensated",
        });

        let parsed = CommandPayload::parse("SetClipSlowMotionInterpolation".to_string(), payload);
        assert!(
            matches!(
                parsed,
                Ok(CommandPayload::SetClipSlowMotionInterpolation(_))
            ),
            "expected SetClipSlowMotionInterpolation to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_set_clip_speed_payload_supports_reverse_flag() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "speed": 1.0,
            "reverse": true,
        });

        let parsed = CommandPayload::parse("SetClipSpeed".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetClipSpeed(_))),
            "expected SetClipSpeed with reverse to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetClipSpeed(inner)) = parsed {
            assert!(inner.reverse, "reverse flag should be true when provided");
        }
    }

    #[test]
    fn parse_set_clip_mute_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "muted": true,
        });

        let parsed = CommandPayload::parse("SetClipMute".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetClipMute(_))),
            "expected SetClipMute to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_set_clip_audio_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "volumeDb": -6.0,
            "pan": 0.2,
            "fadeInSec": 1.25,
            "fadeOutSec": 0.75,
            "audioRole": "dialogue",
            "audioTags": ["interview", "lav"],
        });

        let parsed = CommandPayload::parse("SetClipAudio".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetClipAudio(_))),
            "expected SetClipAudio to parse, got: {parsed:?}"
        );
        if let Ok(CommandPayload::SetClipAudio(p)) = parsed {
            assert_eq!(p.audio_role.as_deref(), Some("dialogue"));
            assert_eq!(
                p.audio_tags,
                Some(vec!["interview".to_string(), "lav".to_string()])
            );
        }
    }

    #[test]
    fn parse_set_track_blend_mode_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "blendMode": "multiply",
        });

        let parsed = CommandPayload::parse("SetTrackBlendMode".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetTrackBlendMode(_))),
            "expected SetTrackBlendMode to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_set_track_blend_mode_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "blendMode": "multiply",
            "__proto__": { "pollute": true }
        });

        let parsed = CommandPayload::parse("SetTrackBlendMode".to_string(), payload);
        assert!(parsed.is_err());
    }

    #[test]
    fn parse_set_track_volume_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "volume": 0.5,
        });

        let parsed = CommandPayload::parse("SetTrackVolume".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetTrackVolume(_))),
            "expected SetTrackVolume to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetTrackVolume(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.track_id, "track_001");
            assert!((p.volume - 0.5).abs() < 0.001);
        }
    }

    #[test]
    fn parse_set_caption_track_language_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_caption_001",
            "language": "ko",
        });

        let parsed = CommandPayload::parse("SetCaptionTrackLanguage".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetCaptionTrackLanguage(_))),
            "expected SetCaptionTrackLanguage to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::SetCaptionTrackLanguage(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.track_id, "track_caption_001");
            assert_eq!(p.language, "ko");
        }
    }

    #[test]
    fn parse_toggle_track_mute_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "muted": true,
        });

        let parsed = CommandPayload::parse("ToggleTrackMute".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::ToggleTrackMute(_))),
            "expected ToggleTrackMute to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_toggle_track_lock_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "locked": true,
        });

        let parsed = CommandPayload::parse("ToggleTrackLock".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::ToggleTrackLock(_))),
            "expected ToggleTrackLock to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_toggle_track_visibility_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "visible": false,
        });

        let parsed = CommandPayload::parse("ToggleTrackVisibility".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::ToggleTrackVisibility(_))),
            "expected ToggleTrackVisibility to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_create_track_payload_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "kind": "video",
            "name": "Video 2",
            "position": 0,
        });

        let parsed = CommandPayload::parse("CreateTrack".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::CreateTrack(_))),
            "expected CreateTrack to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_create_track_payload_supports_aliases() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "kind": "audio",
            "name": "Audio 2",
            "position": 3,
        });

        for command_type in ["createTrack", "addTrack", "AddTrack"] {
            let parsed = CommandPayload::parse(command_type.to_string(), payload.clone());
            assert!(
                matches!(parsed, Ok(CommandPayload::CreateTrack(_))),
                "expected {command_type} alias to parse, got: {parsed:?}"
            );
        }
    }

    #[test]
    fn parse_create_track_payload_without_position_is_supported() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "kind": "video",
            "name": "Video 3",
        });

        let parsed = CommandPayload::parse("CreateTrack".to_string(), payload);
        assert!(
            matches!(
                parsed,
                Ok(CommandPayload::CreateTrack(CreateTrackPayload {
                    position: None,
                    ..
                }))
            ),
            "expected CreateTrack to parse without position, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_create_track_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "kind": "video",
            "name": "Video 2",
            "position": 0,
            "unexpected": true,
        });

        let parsed = CommandPayload::parse("CreateTrack".to_string(), payload);
        assert!(parsed.is_err());
    }

    #[test]
    fn parse_insert_clip_accepts_source_range() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "assetId": "asset_001",
            "timelineIn": 10.0,
            "sourceIn": 2.5,
            "sourceOut": 8.0,
        });

        let parsed = CommandPayload::parse("InsertClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected InsertClip source range to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::InsertClip(p)) = parsed {
            assert!((p.timeline_start - 10.0).abs() < 0.001);
            assert_eq!(p.source_in, Some(2.5));
            assert_eq!(p.source_out, Some(8.0));
        }
    }

    #[test]
    fn parse_insert_clip_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "assetId": "asset_001",
            "timelineIn": 10.0,
            "__proto__": { "pollute": true }
        });

        let parsed = CommandPayload::parse("InsertClip".to_string(), payload);
        assert!(parsed.is_err());
        let err = parsed.unwrap_err();
        assert!(
            err.contains("unknown field") || err.contains("unknown variant"),
            "expected unknown-field rejection, got: {err}"
        );
    }

    #[test]
    fn parse_rejects_oversized_payload() {
        // 600KiB of text exceeds the 512KiB limit.
        let huge = "x".repeat(600 * 1024);
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "splitTime": 10.0,
            "padding": huge,
        });

        let parsed = CommandPayload::parse("SplitClip".to_string(), payload);
        assert!(parsed.is_err());
        let err = parsed.unwrap_err();
        assert!(
            err.contains("too large"),
            "expected payload-size rejection, got: {err}"
        );
    }

    #[test]
    fn parse_rejects_empty_command_type() {
        let payload = serde_json::json!({});
        let parsed = CommandPayload::parse("   ".to_string(), payload);
        assert!(parsed.is_err());
        assert!(parsed.unwrap_err().contains("commandType is empty"));
    }

    #[test]
    fn parse_rejects_overlong_command_type() {
        let payload = serde_json::json!({});
        let long = "a".repeat(129);
        let parsed = CommandPayload::parse(long, payload);
        assert!(parsed.is_err());
        assert!(parsed.unwrap_err().contains("commandType is too long"));
    }

    #[test]
    fn parse_rejects_command_type_with_control_characters() {
        let payload = serde_json::json!({});
        let parsed = CommandPayload::parse("InsertClip\u{0007}".to_string(), payload);
        assert!(parsed.is_err());
        assert!(parsed
            .unwrap_err()
            .contains("commandType contains control characters"));
    }

    // =========================================================================
    // Text Clip Payload Tests
    // =========================================================================

    #[test]
    fn parse_add_text_clip_payload() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "timelineIn": 5.0,
            "duration": 3.0,
            "textData": {
                "content": "Hello World",
                "style": {
                    "fontFamily": "Arial",
                    "fontSize": 48,
                    "color": "#FFFFFF"
                },
                "position": {
                    "x": 0.5,
                    "y": 0.5
                }
            }
        });

        let parsed = CommandPayload::parse("AddTextClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected AddTextClip to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::AddTextClip(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.track_id, "track_001");
            assert!((p.timeline_in - 5.0).abs() < 0.001);
            assert!((p.duration - 3.0).abs() < 0.001);
            assert_eq!(p.text_data.content, "Hello World");
        }
    }

    #[test]
    fn parse_add_text_clip_with_full_styling() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "timelineIn": 0.0,
            "duration": 5.0,
            "textData": {
                "content": "Styled Title",
                "style": {
                    "fontFamily": "Helvetica",
                    "fontSize": 72,
                    "color": "#FF0000",
                    "backgroundColor": "#000000",
                    "backgroundPadding": 10,
                    "alignment": "center",
                    "bold": true,
                    "italic": false,
                    "underline": false,
                    "lineHeight": 1.2,
                    "letterSpacing": 0
                },
                "position": {
                    "x": 0.5,
                    "y": 0.8
                },
                "shadow": {
                    "color": "#000000",
                    "offsetX": 3,
                    "offsetY": 3,
                    "blur": 2
                },
                "outline": {
                    "color": "#FFFFFF",
                    "width": 2
                },
                "rotation": 0.0,
                "opacity": 1.0
            }
        });

        let parsed = CommandPayload::parse("AddTextClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected AddTextClip with full styling to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::AddTextClip(p)) = parsed {
            assert_eq!(p.text_data.style.font_family, "Helvetica");
            assert_eq!(p.text_data.style.font_size, 72);
            assert!(p.text_data.style.bold);
            assert!(p.text_data.shadow.is_some());
            assert!(p.text_data.outline.is_some());
        }
    }

    #[test]
    fn parse_update_text_clip_payload() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001",
            "textData": {
                "content": "Updated Text",
                "style": {
                    "fontFamily": "Verdana",
                    "fontSize": 64,
                    "color": "#00FF00"
                },
                "position": {
                    "x": 0.5,
                    "y": 0.5
                }
            }
        });

        let parsed = CommandPayload::parse("UpdateTextClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected UpdateTextClip to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::UpdateTextClip(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.clip_id, "clip_001");
            assert_eq!(p.text_data.content, "Updated Text");
        }
    }

    #[test]
    fn parse_remove_text_clip_payload() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "clipId": "clip_001"
        });

        let parsed = CommandPayload::parse("RemoveTextClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected RemoveTextClip to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::RemoveTextClip(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.track_id, "track_001");
            assert_eq!(p.clip_id, "clip_001");
        }
    }

    #[test]
    fn parse_add_text_clip_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "timelineIn": 0.0,
            "duration": 5.0,
            "textData": {
                "content": "Test",
                "style": {
                    "fontFamily": "Arial",
                    "fontSize": 48,
                    "color": "#FFFFFF"
                },
                "position": { "x": 0.5, "y": 0.5 }
            },
            "unknownField": "should_fail"
        });

        let parsed = CommandPayload::parse("AddTextClip".to_string(), payload);
        assert!(parsed.is_err());
        let err = parsed.unwrap_err();
        assert!(
            err.contains("unknown field"),
            "expected unknown-field rejection, got: {err}"
        );
    }

    #[test]
    fn parse_add_text_clip_with_timeline_start_alias() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "track_001",
            "timelineStart": 10.0,
            "duration": 5.0,
            "textData": {
                "content": "Test",
                "style": {
                    "fontFamily": "Arial",
                    "fontSize": 48,
                    "color": "#FFFFFF"
                },
                "position": { "x": 0.5, "y": 0.5 }
            }
        });

        let parsed = CommandPayload::parse("AddTextClip".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected timelineStart alias to work, got: {parsed:?}"
        );

        if let Ok(CommandPayload::AddTextClip(p)) = parsed {
            assert!((p.timeline_in - 10.0).abs() < 0.001);
        }
    }

    // =========================================================================
    // Mask Payload Tests
    // =========================================================================

    #[test]
    fn parse_add_mask_payload_rectangle() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "video_001",
            "clipId": "clip_001",
            "effectId": "eff_001",
            "shape": {
                "type": "rectangle",
                "x": 0.5,
                "y": 0.5,
                "width": 0.4,
                "height": 0.3,
                "cornerRadius": 0.0,
                "rotation": 0.0
            },
            "name": "Center Mask",
            "feather": 0.1,
            "inverted": false
        });

        let parsed = CommandPayload::parse("AddMask".to_string(), payload);
        assert!(parsed.is_ok(), "expected AddMask to parse, got: {parsed:?}");

        if let Ok(CommandPayload::AddMask(p)) = parsed {
            assert_eq!(p.sequence_id, "seq_001");
            assert_eq!(p.effect_id, "eff_001");
            assert_eq!(p.name, Some("Center Mask".to_string()));
            assert!((p.feather - 0.1).abs() < 0.001);
        }
    }

    #[test]
    fn parse_add_mask_payload_ellipse() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "video_001",
            "clipId": "clip_001",
            "effectId": "eff_001",
            "shape": {
                "type": "ellipse",
                "x": 0.5,
                "y": 0.5,
                "radiusX": 0.25,
                "radiusY": 0.25,
                "rotation": 0.0
            }
        });

        let parsed = CommandPayload::parse("AddMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected AddMask with ellipse to parse, got: {parsed:?}"
        );
    }

    #[test]
    fn parse_add_mask_payload_supports_tracking_keyframes() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "video_001",
            "clipId": "clip_001",
            "effectId": "eff_001",
            "shape": {
                "type": "rectangle",
                "x": 0.4,
                "y": 0.5,
                "width": 0.3,
                "height": 0.2,
                "cornerRadius": 0.0,
                "rotation": 0.0
            },
            "keyframes": [
                {
                    "timeOffset": 0.0,
                    "shape": {
                        "type": "rectangle",
                        "x": 0.4,
                        "y": 0.5,
                        "width": 0.3,
                        "height": 0.2,
                        "cornerRadius": 0.0,
                        "rotation": 0.0
                    },
                    "easing": "linear"
                },
                {
                    "timeOffset": 0.5,
                    "shape": {
                        "type": "rectangle",
                        "x": 0.5,
                        "y": 0.55,
                        "width": 0.3,
                        "height": 0.2,
                        "cornerRadius": 0.0,
                        "rotation": 0.0
                    },
                    "easing": "linear"
                }
            ],
            "trackingSourceId": "tracking-effect-001"
        });

        let parsed = CommandPayload::parse("AddMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected AddMask with tracking keyframes to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::AddMask(p)) = parsed {
            assert_eq!(p.keyframes.len(), 2);
            assert_eq!(p.tracking_source_id.as_deref(), Some("tracking-effect-001"));
        }
    }

    #[test]
    fn parse_update_mask_payload() {
        let payload = serde_json::json!({
            "effectId": "eff_001",
            "maskId": "mask_001",
            "feather": 0.2,
            "opacity": 0.8,
            "inverted": true,
            "enabled": true
        });

        let parsed = CommandPayload::parse("UpdateMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected UpdateMask to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::UpdateMask(p)) = parsed {
            assert_eq!(p.effect_id, "eff_001");
            assert_eq!(p.mask_id, "mask_001");
            assert_eq!(p.feather, Some(0.2));
            assert_eq!(p.opacity, Some(0.8));
            assert_eq!(p.inverted, Some(true));
        }
    }

    #[test]
    fn parse_update_mask_payload_supports_tracking_keyframes() {
        let payload = serde_json::json!({
            "effectId": "eff_001",
            "maskId": "mask_001",
            "keyframes": [
                {
                    "timeOffset": 0.0,
                    "shape": {
                        "type": "ellipse",
                        "x": 0.5,
                        "y": 0.5,
                        "radiusX": 0.2,
                        "radiusY": 0.1,
                        "rotation": 0.0
                    },
                    "easing": "linear"
                }
            ],
            "trackingSourceId": "tracking-effect-002"
        });

        let parsed = CommandPayload::parse("UpdateMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected UpdateMask with tracking keyframes to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::UpdateMask(p)) = parsed {
            assert_eq!(p.keyframes.as_ref().map(Vec::len), Some(1));
            assert_eq!(p.tracking_source_id.as_deref(), Some("tracking-effect-002"));
        }
    }

    #[test]
    fn parse_update_mask_with_blend_mode() {
        let payload = serde_json::json!({
            "effectId": "eff_001",
            "maskId": "mask_001",
            "blendMode": "subtract"
        });

        let parsed = CommandPayload::parse("UpdateMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected UpdateMask with blend mode to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::UpdateMask(p)) = parsed {
            assert!(p.blend_mode.is_some());
        }
    }

    #[test]
    fn parse_remove_mask_payload() {
        let payload = serde_json::json!({
            "effectId": "eff_001",
            "maskId": "mask_001"
        });

        let parsed = CommandPayload::parse("RemoveMask".to_string(), payload);
        assert!(
            parsed.is_ok(),
            "expected RemoveMask to parse, got: {parsed:?}"
        );

        if let Ok(CommandPayload::RemoveMask(p)) = parsed {
            assert_eq!(p.effect_id, "eff_001");
            assert_eq!(p.mask_id, "mask_001");
        }
    }

    #[test]
    fn parse_add_mask_rejects_unknown_fields() {
        let payload = serde_json::json!({
            "sequenceId": "seq_001",
            "trackId": "video_001",
            "clipId": "clip_001",
            "effectId": "eff_001",
            "shape": {
                "type": "rectangle",
                "x": 0.5,
                "y": 0.5,
                "width": 0.4,
                "height": 0.3
            },
            "unknownField": "should_fail"
        });

        let parsed = CommandPayload::parse("AddMask".to_string(), payload);
        assert!(parsed.is_err());
        let err = parsed.unwrap_err();
        assert!(
            err.contains("unknown field"),
            "expected unknown-field rejection, got: {err}"
        );
    }

    // =========================================================================
    // Derived payload schemas
    // =========================================================================

    use crate::ipc::command_schema::{
        all_command_payload_schemas, check_against_schema, property, required,
    };

    /// Feature: derived command payload schemas
    /// Scenario: every advertised command can be looked up
    ///
    /// The gap this closes: `command schema` listed eighty names and nothing
    /// about their shapes, so an agent learned a payload by guessing one and
    /// reading the parse error. A name an agent can discover and not resolve
    /// would put that guessing back.
    #[test]
    fn should_derive_a_schema_for_every_supported_command_type() {
        for command_type in CommandPayload::SUPPORTED_COMMAND_TYPES {
            let schema = command_payload_schema(command_type)
                .unwrap_or_else(|| panic!("{command_type} is advertised but has no schema"));

            assert_eq!(
                schema["title"], **command_type,
                "{command_type}'s schema must be titled by the command type an agent writes"
            );
            assert_eq!(
                schema["type"], "object",
                "{command_type}'s payload is a JSON object"
            );
            assert!(
                schema["properties"].is_object(),
                "{command_type}'s schema must name its properties"
            );
        }
    }

    #[test]
    fn should_not_answer_an_unknown_command_type_with_a_schema() {
        assert!(command_payload_schema("Bogus").is_none());
        assert!(command_payload_schema("").is_none());
    }

    /// The macro table pairs a command name with a payload struct by hand, and
    /// a mispairing would hand agents a plausible schema for the wrong command.
    /// The enum's own derived schema is the independent witness: it says which
    /// payload each variant actually deserializes into.
    #[test]
    fn should_pair_every_command_type_with_the_payload_its_variant_parses() {
        let enum_schema = serde_json::to_value(schemars::schema_for!(CommandPayload))
            .expect("the command union has a schema");
        let variants = enum_schema["oneOf"]
            .as_array()
            .expect("an adjacently tagged enum is a oneOf");

        for (command_type, struct_name) in COMMAND_PAYLOAD_STRUCT_NAMES {
            // serde renames the variants to camelCase; the PascalCase spelling
            // the table uses is one of the aliases, which schemars never emits.
            let variant = variants
                .iter()
                .find(|variant| {
                    variant["properties"]["commandType"]["enum"][0]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(command_type))
                })
                .unwrap_or_else(|| panic!("{command_type} names no variant of CommandPayload"));

            assert_eq!(
                variant["properties"]["payload"]["$ref"],
                format!("#/definitions/{struct_name}"),
                "{command_type} is paired with {struct_name}, which is not what its variant parses"
            );
        }
    }

    /// Feature: derived command payload schemas
    /// Scenario: an agent reads what UpdateCaption needs before composing one
    #[test]
    fn update_caption_schema_should_separate_the_ids_it_needs_from_what_it_may_change() {
        let schema = command_payload_schema("UpdateCaption").expect("UpdateCaption has a schema");

        assert_eq!(
            required(&schema),
            vec!["captionId", "sequenceId", "trackId"],
            "UpdateCaption needs exactly the three ids"
        );

        for optional in ["text", "startSec", "endSec", "style", "position"] {
            let field = property(&schema, optional)
                .unwrap_or_else(|| panic!("UpdateCaption must document {optional}"));
            assert!(
                !required(&schema).contains(&optional.to_string()),
                "{optional} is optional on UpdateCaption"
            );
            let description = field
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            assert!(
                !description.is_empty(),
                "{optional} must say what it does, not just its type"
            );
        }
    }

    /// The aliases are what an agent that learned an older spelling sends, and
    /// `schemars` never reads `#[serde(alias)]` — so they live in the doc
    /// comment, which the guard below keeps honest.
    #[test]
    fn update_caption_schema_should_name_the_spellings_its_parser_also_accepts() {
        let schema = command_payload_schema("UpdateCaption").expect("UpdateCaption has a schema");

        let caption_id = property(&schema, "captionId").expect("captionId is documented");
        assert!(
            caption_id["description"]
                .as_str()
                .is_some_and(|text| text.contains("clipId")),
            "captionId also answers to clipId: {caption_id:?}"
        );
    }

    /// Feature: derived command payload schemas
    /// Scenario: a frame rate may be written either way
    #[test]
    fn set_sequence_format_schema_should_offer_both_frame_rate_spellings() {
        let schema =
            command_payload_schema("SetSequenceFormat").expect("SetSequenceFormat has a schema");

        assert!(
            required(&schema).is_empty(),
            "every SetSequenceFormat field is optional"
        );

        let fps = property(&schema, "fps").expect("fps is documented");
        let referenced = fps["anyOf"]
            .as_array()
            .expect("an optional union is an anyOf")
            .iter()
            .filter_map(|entry| entry["$ref"].as_str())
            .collect::<Vec<_>>();
        assert!(
            referenced.contains(&"#/definitions/FpsSpec"),
            "fps must point at the number-or-ratio union: {fps:?}"
        );

        let fps_spec = &schema["definitions"]["FpsSpec"]["anyOf"];
        let spellings = fps_spec.as_array().expect("FpsSpec is a union");
        assert!(
            spellings
                .iter()
                .any(|entry| entry["type"] == "number" || entry["format"] == "double"),
            "a decimal rate must be accepted: {fps_spec}"
        );
        assert!(
            spellings.iter().any(|entry| {
                entry["$ref"] == "#/definitions/Ratio"
                    || entry["allOf"][0]["$ref"] == "#/definitions/Ratio"
            }),
            "an exact ratio must be accepted: {fps_spec}"
        );
        assert!(
            schema["definitions"]["Ratio"]["properties"]["num"].is_object(),
            "the ratio's own shape must travel with the schema"
        );
    }

    /// `deny_unknown_fields` is what makes a typo a parse error rather than a
    /// silently dropped field, so the schema has to say so.
    #[test]
    fn should_close_a_schema_exactly_where_the_parser_rejects_unknown_fields() {
        for closed in [
            "UpdateCaption",
            "SetSequenceFormat",
            "InsertClip",
            "AddTextClip",
        ] {
            let schema = command_payload_schema(closed).expect("the command has a schema");
            assert_eq!(
                schema["additionalProperties"], false,
                "{closed} rejects unknown fields and its schema must say so"
            );
        }

        // The two payloads with a hand written `Deserialize` accept spellings
        // no property lists, so declaring them closed would be a lie in the
        // other direction. Their struct docs name what else they take.
        let ripple = command_payload_schema("RippleDelete").expect("RippleDelete has a schema");
        assert!(
            ripple["additionalProperties"].is_null(),
            "RippleDelete also accepts clipId, so its schema must stay open"
        );
        assert!(
            ripple["description"]
                .as_str()
                .is_some_and(|text| text.contains("clipId")),
            "RippleDelete must say which other spelling it takes: {ripple:?}"
        );
    }

    /// Feature: derived command payload schemas
    /// Scenario: what the parser accepts, the schema accepts
    ///
    /// The schema is only worth reading if it agrees with the parser every
    /// surface runs payloads through. Each sample below is parsed strictly and
    /// then checked against its own schema, so a schema that drifted from the
    /// struct it was derived from fails here rather than in an agent's session.
    #[test]
    fn a_payload_the_parser_accepts_should_validate_against_its_own_schema() {
        let samples = [
            (
                "UpdateCaption",
                serde_json::json!({
                    "sequenceId": "seq_1",
                    "trackId": "track_c1",
                    "clipId": "caption_1",
                    "text": "Hello",
                    "startTime": 1.0,
                    "endTime": 2.5
                }),
            ),
            (
                "InsertClip",
                serde_json::json!({
                    "sequenceId": "seq_1",
                    "trackId": "track_v1",
                    "assetId": "asset_1",
                    "timelineIn": 0.0
                }),
            ),
            (
                "SplitClip",
                serde_json::json!({
                    "sequenceId": "seq_1",
                    "trackId": "track_v1",
                    "clipId": "clip_1",
                    "atTimelineSec": 5.0
                }),
            ),
            (
                "SetSequenceFormat",
                serde_json::json!({ "fps": { "num": 24000, "den": 1001 } }),
            ),
            (
                "RippleDelete",
                serde_json::json!({
                    "sequenceId": "seq_1",
                    "trackId": "track_v1",
                    "clipId": "clip_1"
                }),
            ),
        ];

        for (command_type, wire) in samples {
            let parsed = CommandPayload::parse(command_type.to_string(), wire)
                .unwrap_or_else(|error| panic!("{command_type} sample must parse: {error}"));

            // The parsed payload is re-serialized, which is the canonical
            // spelling of exactly the fields the schema was derived from.
            let canonical = serde_json::to_value(&parsed).expect("a parsed payload serializes")
                ["payload"]
                .clone();

            let schema = command_payload_schema(command_type).expect("the command has a schema");
            check_against_schema(&schema, &canonical).unwrap_or_else(|error| {
                panic!("{command_type} parses payloads its own schema rejects: {error}")
            });
        }
    }

    #[test]
    fn should_list_every_command_when_asked_for_all_of_them() {
        let all = all_command_payload_schemas();

        assert_eq!(
            all["count"].as_u64(),
            Some(CommandPayload::SUPPORTED_COMMAND_TYPES.len() as u64)
        );

        let entries = all["schemas"].as_array().expect("schemas is a list");
        let listed: Vec<&str> = entries
            .iter()
            .filter_map(|entry| entry["commandType"].as_str())
            .collect();
        assert_eq!(listed, CommandPayload::SUPPORTED_COMMAND_TYPES.to_vec());
        assert!(entries
            .iter()
            .all(|entry| entry["schema"]["type"] == "object"));
    }

    /// Feature: derived command payload schemas
    /// Scenario: a field an agent cannot type is at least a field it can read
    ///
    /// A handful of payload fields are `serde_json::Value`, which `schemars`
    /// renders as "anything" — a property with no `type`, no `$ref` and no
    /// union. That is honest but useless on its own: an agent reading it
    /// learns nothing at all. Such a field has to say in prose what it takes,
    /// so this fails when a free-form field is added without a doc comment.
    #[test]
    fn a_field_with_no_declared_shape_must_at_least_be_described() {
        /// Whether a property schema tells a caller what values it accepts.
        fn declares_a_shape(property: &serde_json::Value) -> bool {
            ["type", "$ref", "anyOf", "allOf", "oneOf", "enum", "const"]
                .iter()
                .any(|keyword| property.get(*keyword).is_some())
        }

        fn described(property: &serde_json::Value) -> bool {
            property
                .get("description")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        }

        let mut opaque: Vec<String> = Vec::new();

        for command_type in CommandPayload::SUPPORTED_COMMAND_TYPES {
            let schema = command_payload_schema(command_type)
                .unwrap_or_else(|| panic!("{command_type} is advertised but has no schema"));

            // The payload's own fields, then the fields of every type it
            // references: a free-form leaf is just as opaque one level down.
            let mut objects: Vec<(String, &serde_json::Value)> =
                vec![(command_type.to_string(), &schema)];
            if let Some(definitions) = schema["definitions"].as_object() {
                objects.extend(
                    definitions
                        .iter()
                        .map(|(name, definition)| (name.clone(), definition)),
                );
            }

            for (owner, object) in objects {
                let Some(properties) = object["properties"].as_object() else {
                    continue;
                };
                for (name, property) in properties {
                    if !declares_a_shape(property) && !described(property) {
                        opaque.push(format!("{owner}.{name}"));
                    }
                }
            }
        }

        opaque.sort();
        opaque.dedup();
        assert!(
            opaque.is_empty(),
            "these fields accept anything and say nothing — give the field a doc comment, or a \
             `#[schemars(with = \"…\")]` naming the shape the parser reads: {opaque:#?}"
        );
    }

    /// Feature: derived command payload schemas
    /// Scenario: an alias cannot be added without telling agents about it
    ///
    /// `schemars` reads `rename_all` but not `alias`, so a field's accepted
    /// spellings only reach an agent through its doc comment. Nothing in the
    /// compiler ties the two together — this does. It reads the payload source
    /// itself so an alias added tomorrow fails here rather than going
    /// unnoticed until an agent sends the old spelling and is told the field
    /// is unknown.
    #[test]
    fn every_field_alias_should_be_named_in_the_doc_comment_agents_read() {
        let source = include_str!("payloads.rs");
        let mut undocumented: Vec<String> = Vec::new();
        let mut current_struct: Option<&str> = None;
        let mut doc: Vec<String> = Vec::new();
        let mut aliases: Vec<String> = Vec::new();

        for line in source.lines() {
            if let Some(name) = line
                .strip_prefix("pub struct ")
                .and_then(|rest| rest.strip_suffix(" {"))
            {
                current_struct = Some(name);
                doc.clear();
                aliases.clear();
                continue;
            }
            if line == "}" {
                current_struct = None;
                continue;
            }
            let Some(owner) = current_struct else {
                continue;
            };

            // Only the struct's own fields, which sit at one level of
            // indentation; a `Wire` shape nested inside an `impl` is deeper and
            // is not what the schema is derived from.
            let Some(body) = line.strip_prefix("    ") else {
                continue;
            };
            if body.starts_with(' ') {
                continue;
            }

            if let Some(text) = body.strip_prefix("/// ").or(body.strip_prefix("///")) {
                doc.push(text.to_string());
                continue;
            }
            if body.starts_with("#[serde(") || body.starts_with("#[schemars(") {
                for alias in body.split("alias = \"").skip(1) {
                    if let Some(alias) = alias.split('"').next() {
                        aliases.push(alias.to_string());
                    }
                }
                continue;
            }
            if let Some(field) = body
                .strip_prefix("pub ")
                .and_then(|rest| rest.split(':').next())
            {
                let canonical = to_camel_case(field);
                let described = doc.join(" ");
                for alias in &aliases {
                    // An alias equal to the camelCase name serde already
                    // derives is a no-op; there is nothing to tell anyone.
                    if *alias == canonical {
                        continue;
                    }
                    if !described.contains(alias.as_str()) {
                        undocumented.push(format!("{owner}.{canonical} accepts '{alias}'"));
                    }
                }
            }
            doc.clear();
            aliases.clear();
        }

        assert!(
            undocumented.is_empty(),
            "these fields accept a spelling no agent can discover — name it in the field's doc \
             comment, which becomes the schema description: {undocumented:#?}"
        );
    }

    /// Converts a `snake_case` field name to the camelCase serde emits.
    fn to_camel_case(field: &str) -> String {
        let mut camel = String::with_capacity(field.len());
        let mut capitalize = false;
        for character in field.chars() {
            if character == '_' {
                capitalize = true;
                continue;
            }
            if capitalize {
                camel.extend(character.to_uppercase());
                capitalize = false;
            } else {
                camel.push(character);
            }
        }
        camel
    }
}
