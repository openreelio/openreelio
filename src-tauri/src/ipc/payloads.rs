use crate::core::effects::{EffectType, ParamValue};
use crate::core::masks::{MaskBlendMode, MaskShape};
use crate::core::text::TextClipData;
use crate::core::timeline::{BlendMode, Transform};
use crate::core::{AssetId, BinId, ClipId, EffectId, MaskId, SequenceId, TimeSec, TrackId};
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
pub struct UpdateCaptionPayload {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    pub text: Option<String>,
    #[serde(alias = "startSec")]
    pub start_sec: Option<TimeSec>,
    #[serde(alias = "endSec")]
    pub end_sec: Option<TimeSec>,
    // Forward-compatible fields currently used by UI/QC but not applied by core yet.
    // Keep them to avoid rejecting payloads during strict parsing.
    pub style: Option<serde_json::Value>,
    pub position: Option<serde_json::Value>,
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
    #[serde(default)]
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
// Bin/Folder Payloads
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBinPayload {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<BinId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveBinPayload {
    pub bin_id: BinId,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameBinPayload {
    pub bin_id: BinId,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveBinPayload {
    pub bin_id: BinId,
    /// New parent bin ID (null for root level)
    pub parent_id: Option<BinId>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBinColorPayload {
    pub bin_id: BinId,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveAssetToBinPayload {
    pub asset_id: AssetId,
    /// Target bin ID (null to move to root)
    pub bin_id: Option<BinId>,
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

    #[serde(alias = "setTrackBlendMode", alias = "SetTrackBlendMode")]
    SetTrackBlendMode(SetTrackBlendModePayload),

    #[serde(alias = "importAsset", alias = "ImportAsset")]
    ImportAsset(ImportAssetPayload),

    #[serde(alias = "removeAsset", alias = "RemoveAsset")]
    RemoveAsset(RemoveAssetPayload),

    #[serde(alias = "createSequence", alias = "CreateSequence")]
    CreateSequence(CreateSequencePayload),

    #[serde(alias = "updateCaption", alias = "UpdateCaption")]
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

    // Bin/Folder commands
    #[serde(alias = "createBin", alias = "CreateBin")]
    CreateBin(CreateBinPayload),

    #[serde(
        alias = "removeBin",
        alias = "RemoveBin",
        alias = "deleteBin",
        alias = "DeleteBin"
    )]
    RemoveBin(RemoveBinPayload),

    #[serde(alias = "renameBin", alias = "RenameBin")]
    RenameBin(RenameBinPayload),

    #[serde(alias = "moveBin", alias = "MoveBin")]
    MoveBin(MoveBinPayload),

    #[serde(alias = "setBinColor", alias = "SetBinColor")]
    SetBinColor(SetBinColorPayload),

    #[serde(alias = "moveAssetToBin", alias = "MoveAssetToBin")]
    MoveAssetToBin(MoveAssetToBinPayload),
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
