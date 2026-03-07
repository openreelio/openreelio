use crate::core::effects::{EffectType, ParamValue};
use crate::core::masks::{MaskBlendMode, MaskShape};
use crate::core::text::TextClipData;
use crate::core::timeline::{BlendMode, MarkerType, TrackKind, Transform};
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
pub struct CreateSequencePayload {
    pub name: String,
    pub format: Option<String>,
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
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderTracksPayload {
    pub sequence_id: SequenceId,
    pub new_order: Vec<TrackId>,
}

// =============================================================================
// Marker Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddMarkerPayload {
    pub sequence_id: SequenceId,
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

// =============================================================================
// Tagged Union
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "commandType", content = "payload", rename_all = "camelCase")]
pub enum CommandPayload {
    #[serde(alias = "insertClip", alias = "InsertClip")]
    InsertClip(InsertClipPayload),

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

    #[serde(
        alias = "setClipSpeed",
        alias = "SetClipSpeed",
        alias = "changeClipSpeed"
    )]
    SetClipSpeed(SetClipSpeedPayload),

    #[serde(alias = "setClipMute", alias = "SetClipMute")]
    SetClipMute(SetClipMutePayload),

    #[serde(alias = "setClipAudio", alias = "SetClipAudio")]
    SetClipAudio(SetClipAudioPayload),

    #[serde(alias = "setTrackBlendMode", alias = "SetTrackBlendMode")]
    SetTrackBlendMode(SetTrackBlendModePayload),

    #[serde(alias = "setClipBlendMode", alias = "SetClipBlendMode")]
    SetClipBlendMode(SetClipBlendModePayload),

    #[serde(alias = "importAsset", alias = "ImportAsset")]
    ImportAsset(ImportAssetPayload),

    #[serde(alias = "removeAsset", alias = "RemoveAsset")]
    RemoveAsset(RemoveAssetPayload),

    #[serde(alias = "createSequence", alias = "CreateSequence")]
    CreateSequence(CreateSequencePayload),

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

    #[serde(alias = "reorderTracks", alias = "ReorderTracks")]
    ReorderTracks(ReorderTracksPayload),

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
            AddEffectCommand, AddMarkerCommand, AddMaskCommand, AddTextClipCommand,
            AddTrackCommand, CreateCaptionCommand, CreateFolderCommand, CreateSequenceCommand,
            DeleteCaptionCommand, DeleteFileCommand, ImportAssetCommand, InsertClipCommand,
            MoveClipCommand, MoveFileCommand, RemoveAssetCommand, RemoveClipCommand,
            RemoveEffectCommand, RemoveMarkerCommand, RemoveMaskCommand, RemoveTextClipCommand,
            RemoveTrackCommand, RenameFileCommand, RenameTrackCommand, ReorderTracksCommand,
            SetClipAudioCommand, SetClipBlendModeCommand, SetClipMuteCommand, SetClipSpeedCommand,
            SetClipTransformCommand, SetTrackBlendModeCommand, SplitClipCommand, TrimClipCommand,
            UpdateEffectCommand, UpdateMaskCommand, UpdateTextCommand,
        };

        match self {
            CommandPayload::InsertClip(p) => Box::new(InsertClipCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.asset_id,
                p.timeline_start,
            )),
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
            CommandPayload::SetClipSpeed(p) => Box::new(SetClipSpeedCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.speed,
                p.reverse,
            )),
            CommandPayload::SetClipMute(p) => Box::new(SetClipMuteCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.muted,
            )),
            CommandPayload::SetClipAudio(p) => Box::new(SetClipAudioCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.volume_db,
                p.pan,
                p.muted,
                p.fade_in_sec,
                p.fade_out_sec,
            )),
            CommandPayload::SetTrackBlendMode(p) => Box::new(SetTrackBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                p.blend_mode,
            )),
            CommandPayload::SetClipBlendMode(p) => Box::new(SetClipBlendModeCommand::new(
                &p.sequence_id,
                &p.track_id,
                &p.clip_id,
                p.blend_mode,
            )),
            CommandPayload::ImportAsset(p) => Box::new(ImportAssetCommand::new(&p.name, &p.uri)),
            CommandPayload::RemoveAsset(p) => Box::new(RemoveAssetCommand::new(&p.asset_id)),
            CommandPayload::CreateSequence(p) => Box::new(CreateSequenceCommand::new(
                &p.name,
                &p.format.unwrap_or_else(|| "1080p".to_string()),
            )),
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
            CommandPayload::ReorderTracks(p) => {
                Box::new(ReorderTracksCommand::new(&p.sequence_id, p.new_order))
            }
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        });

        let parsed = CommandPayload::parse("SetClipAudio".to_string(), payload);
        assert!(
            matches!(parsed, Ok(CommandPayload::SetClipAudio(_))),
            "expected SetClipAudio to parse, got: {parsed:?}"
        );
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
