use crate::core::timeline::Transform;
use crate::core::{AssetId, ClipId, SequenceId, TimeSec, TrackId};
use serde::{Deserialize, Serialize};

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

    #[serde(alias = "importAsset", alias = "ImportAsset")]
    ImportAsset(ImportAssetPayload),

    #[serde(alias = "removeAsset", alias = "RemoveAsset")]
    RemoveAsset(RemoveAssetPayload),

    #[serde(alias = "createSequence", alias = "CreateSequence")]
    CreateSequence(CreateSequencePayload),

    #[serde(alias = "updateCaption", alias = "UpdateCaption")]
    UpdateCaption(UpdateCaptionPayload),
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
}
