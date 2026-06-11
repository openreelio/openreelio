use crate::core::assets::{AudioInfo, LicenseInfo, ProxyStatus, VideoInfo};
use crate::core::effects::{EffectType, Keyframe, ParamValue};
use crate::core::masks::{MaskBlendMode, MaskKeyframe, MaskShape};
use crate::core::project::ProjectState;
use crate::core::text::TextClipData;
use crate::core::timeline::{
    BlendMode, MarkerType, SequenceHdrSettings, Track, TrackKind, Transform, TransformKeyframe,
};
use crate::core::{AssetId, ClipId, Color, EffectId, MaskId, SequenceId, TimeSec, TrackId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Payload Structs (Strict / Injection-Resistant)
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
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

/// Payload for Insert Edit (ripple insert — pushes downstream clips).
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RippleDeletePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiftPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// One or more clip IDs to remove.
    pub clip_ids: Vec<ClipId>,
}

/// Payload for Extract Edit (remove In/Out range + close gap).
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindGapsPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

/// Payload for Close Gap (close a specific gap by shifting downstream clips).
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseAllGapsPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    #[serde(alias = "newTrackId")]
    pub new_track_id: Option<TrackId>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTrackBlendModePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipBlendModePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub blend_mode: BlendMode,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrimClipPayload {
    pub sequence_id: SequenceId,
    /// Track containing the clip.
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(alias = "newStart")]
    pub new_source_in: Option<TimeSec>,
    #[serde(alias = "newEnd")]
    pub new_source_out: Option<TimeSec>,
    #[serde(alias = "newTimelineIn")]
    pub new_timeline_in: Option<TimeSec>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipTransformPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub transform: Transform,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipMotionKeyframesPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframes: Vec<TransformKeyframe>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipOpacityPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub opacity: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipSpeedPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub speed: f32,
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipSlowMotionInterpolationPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub interpolation: crate::core::timeline::SlowMotionInterpolation,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReverseClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipEnabledPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub enabled: bool,
}

/// Clip reference: a (trackId, clipId) pair used in multi-clip commands.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipRef {
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UngroupClipsPayload {
    pub sequence_id: SequenceId,
    pub clip_refs: Vec<ClipRef>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DetachAudioPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_audio_track_id: Option<TrackId>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFreezeFramePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub playhead_sec: f64,
    #[serde(default = "default_freeze_duration")]
    pub duration_sec: f64,
}

fn default_freeze_duration() -> f64 {
    crate::core::commands::DEFAULT_FREEZE_FRAME_DURATION
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTimeRemapPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub time_remap: crate::core::timeline::TimeRemapCurve,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearTimeRemapPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipMutePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub muted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetClipAudioPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub volume_db: Option<f32>,
    pub pan: Option<f32>,
    pub muted: Option<bool>,
    pub fade_in_sec: Option<TimeSec>,
    pub fade_out_sec: Option<TimeSec>,
    pub audio_role: Option<String>,
    pub audio_tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAudioKeyframePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAudioKeyframePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
    pub new_time_offset: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioKeyframeValuePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframe_index: usize,
    pub value_db: f64,
    pub interpolation: Option<crate::core::timeline::KeyframeInterpolation>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioFadeInPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    #[serde(default)]
    pub fade_type: crate::core::timeline::FadeType,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetAudioFadeOutPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub duration: f64,
    #[serde(default)]
    pub fade_type: crate::core::timeline::FadeType,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SplitClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    #[serde(alias = "splitTime", alias = "atTimelineSec")]
    pub split_time: TimeSec,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportAssetPayload {
    pub name: String,
    pub uri: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAssetPayload {
    pub asset_id: AssetId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSequencePayload {
    pub name: String,
    pub format: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetMasterVolumePayload {
    pub sequence_id: SequenceId,
    pub volume_db: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSequenceHdrSettingsPayload {
    pub sequence_id: SequenceId,
    pub settings: SequenceHdrSettings,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTrackPayload {
    pub sequence_id: SequenceId,
    pub kind: TrackKind,
    pub name: String,
    pub position: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTrackPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameTrackPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "name")]
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCaptionTrackLanguagePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub language: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderTracksPayload {
    pub sequence_id: SequenceId,
    pub new_order: Vec<TrackId>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTrackVolumePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Linear track volume, where 1.0 is unity and 2.0 is +6 dB.
    pub volume: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackMutePayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub muted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackLockPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub locked: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToggleTrackVisibilityPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub visible: bool,
}

// =============================================================================
// Marker Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMarkerPayload {
    pub sequence_id: SequenceId,
    #[serde(alias = "time")]
    pub time_sec: TimeSec,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_type: Option<MarkerType>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveMarkerPayload {
    pub sequence_id: SequenceId,
    pub marker_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    pub text: Option<String>,
    #[serde(alias = "startSec", alias = "startTime")]
    pub start_sec: Option<TimeSec>,
    #[serde(alias = "endSec", alias = "endTime")]
    pub end_sec: Option<TimeSec>,
    // Forward-compatible fields currently used by UI/QC but not applied by core yet.
    // Keep them to avoid rejecting payloads during strict parsing.
    pub style: Option<serde_json::Value>,
    pub position: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub text: String,
    #[serde(alias = "startTime")]
    pub start_sec: TimeSec,
    #[serde(alias = "endTime")]
    pub end_sec: TimeSec,
    // Forward-compatible fields currently used by UI/agent prompts but not
    // applied by core command logic yet.
    pub style: Option<serde_json::Value>,
    pub position: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedCaptionSegmentPayload {
    #[serde(alias = "startTime", alias = "start")]
    pub start_sec: TimeSec,
    #[serde(alias = "endTime", alias = "end")]
    pub end_sec: TimeSec,
    pub text: String,
    pub confidence: Option<f64>,
    #[serde(alias = "speakerId")]
    pub speaker: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportGeneratedCaptionsPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub segments: Vec<GeneratedCaptionSegmentPayload>,
    pub style: Option<serde_json::Value>,
    pub position: Option<serde_json::Value>,
    #[serde(default)]
    pub replace_existing: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
}

// =============================================================================
// Effect Payloads
// =============================================================================

/// Payload for adding an effect to a clip.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddEffectPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_type: EffectType,
    #[serde(default, alias = "parameters")]
    pub params: HashMap<String, ParamValue>,
    #[serde(default)]
    pub keyframes: HashMap<String, Vec<Keyframe>>,
    /// Optional position in the effect list (None = append at end)
    pub position: Option<usize>,
}

/// Payload for removing an effect from a clip.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveEffectPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_id: EffectId,
}

/// Payload for updating effect parameters.
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteEffectsPayload {
    pub sequence_id: SequenceId,
    /// Target clips to receive the pasted effects: [{trackId, clipId}]
    pub target_clips: Vec<ClipRef>,
    /// Serialized source effects (from copy_clip_effects IPC result)
    pub source_effects: Vec<serde_json::Value>,
}

/// Payload for selective paste of effects and attributes.
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddTextClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    /// Timeline position to insert the text clip at (seconds)
    #[serde(alias = "timelineStart")]
    pub timeline_in: TimeSec,
    /// Duration of the text clip (seconds)
    pub duration: TimeSec,
    /// Text content and styling data
    pub text_data: TextClipData,
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
#[derive(Debug, Serialize, Deserialize, Clone)]
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
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveTextClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

// =============================================================================
// Filesystem Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateFolderPayload {
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameFilePayload {
    pub old_relative_path: String,
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFilePayload {
    pub source_path: String,
    pub dest_folder_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteFilePayload {
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyAudioDuckingPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub keyframes: Vec<crate::core::timeline::AudioKeyframe>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCompoundClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_ids: Vec<ClipId>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnnestCompoundClipPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "commandType", content = "payload", rename_all = "camelCase")]
pub enum CommandPayload {
    #[serde(alias = "insertClip", alias = "InsertClip")]
    InsertClip(InsertClipPayload),

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

impl CommandPayload {
    pub const SUPPORTED_COMMAND_TYPES: &'static [&'static str] = &[
        "InsertClip",
        "InsertEdit",
        "OverwriteEdit",
        "RippleDelete",
        "Lift",
        "ExtractEdit",
        "CloseGap",
        "CloseAllGaps",
        "RemoveClip",
        "MoveClip",
        "TrimClip",
        "SplitClip",
        "SetClipTransform",
        "SetClipMotionKeyframes",
        "SetClipOpacity",
        "SetClipSpeed",
        "SetClipSlowMotionInterpolation",
        "ReverseClip",
        "SetClipEnabled",
        "LinkClips",
        "UnlinkClips",
        "GroupClips",
        "UngroupClips",
        "DetachAudio",
        "CreateFreezeFrame",
        "SetTimeRemap",
        "ClearTimeRemap",
        "SetClipMute",
        "SetClipAudio",
        "AddAudioKeyframe",
        "RemoveAudioKeyframe",
        "MoveAudioKeyframe",
        "SetAudioKeyframeValue",
        "SetAudioFadeIn",
        "SetAudioFadeOut",
        "SetTrackBlendMode",
        "SetClipBlendMode",
        "ImportAsset",
        "RemoveAsset",
        "UpdateAsset",
        "CreateSequence",
        "SetMasterVolume",
        "UpdateSequenceHdrSettings",
        "CreateTrack",
        "RemoveTrack",
        "RenameTrack",
        "SetCaptionTrackLanguage",
        "ReorderTracks",
        "SetTrackVolume",
        "ToggleTrackMute",
        "ToggleTrackLock",
        "ToggleTrackVisibility",
        "AddMarker",
        "RemoveMarker",
        "CreateCaption",
        "ImportGeneratedCaptions",
        "DeleteCaption",
        "UpdateCaption",
        "AddEffect",
        "RemoveEffect",
        "UpdateEffect",
        "AddMask",
        "UpdateMask",
        "RemoveMask",
        "AddTextClip",
        "UpdateTextClip",
        "RemoveTextClip",
        "CreateFolder",
        "RenameFile",
        "MoveFile",
        "DeleteFile",
        "ApplyAudioDucking",
        "CreateCompoundClip",
        "UnnestCompoundClip",
        "CreateAdjustmentLayer",
        "PasteEffects",
        "PasteAttributes",
        "RemoveAttributes",
    ];

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
        serde_json::from_value(raw_request).map_err(|e| format!("Invalid command payload: {}", e))
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
            InsertClipCommand, InsertEditCommand, LiftCommand, LinkClipsCommand,
            MoveAudioKeyframeCommand, MoveClipCommand, MoveFileCommand, OverwriteEditCommand,
            RemoveAssetCommand, RemoveAudioKeyframeCommand, RemoveClipCommand, RemoveEffectCommand,
            RemoveMarkerCommand, RemoveMaskCommand, RemoveTextClipCommand, RemoveTrackCommand,
            RenameFileCommand, RenameTrackCommand, ReorderTracksCommand, ReverseClipCommand,
            RippleDeleteCommand, SetAudioFadeInCommand, SetAudioFadeOutCommand,
            SetAudioKeyframeValueCommand, SetCaptionTrackLanguageCommand, SetClipAudioCommand,
            SetClipBlendModeCommand, SetClipEnabledCommand, SetClipMotionKeyframesCommand,
            SetClipMuteCommand, SetClipOpacityCommand, SetClipSlowMotionInterpolationCommand,
            SetClipSpeedCommand, SetClipTransformCommand, SetMasterVolumeCommand,
            SetTimeRemapCommand, SetTrackBlendModeCommand, SetTrackVolumeCommand, SplitClipCommand,
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
                let mut cmd =
                    AddEffectCommand::new(&p.sequence_id, &p.track_id, &p.clip_id, p.effect_type);
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
}
