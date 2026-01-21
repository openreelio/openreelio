use crate::core::{AssetId, ClipId, SequenceId, TimeSec, TrackId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "commandType", content = "payload", rename_all = "camelCase")]
pub enum CommandPayload {
    #[serde(alias = "insertClip", alias = "InsertClip", rename_all = "camelCase")]
    InsertClip {
        sequence_id: SequenceId,
        track_id: TrackId,
        asset_id: AssetId,
        #[serde(alias = "timelineIn")]
        timeline_start: Option<TimeSec>, // Allow flexible naming
    },
    #[serde(
        alias = "removeClip",
        alias = "RemoveClip",
        alias = "deleteClip",
        alias = "DeleteClip",
        rename_all = "camelCase"
    )]
    RemoveClip {
        sequence_id: SequenceId,
        track_id: TrackId,
        clip_id: ClipId,
    },
    #[serde(alias = "moveClip", alias = "MoveClip", rename_all = "camelCase")]
    MoveClip {
        sequence_id: SequenceId,
        track_id: TrackId, // Source track
        clip_id: ClipId,
        #[serde(alias = "newTimelineIn")]
        new_timeline_in: TimeSec,
        #[serde(alias = "newTrackId")]
        new_track_id: Option<TrackId>,
    },
    #[serde(alias = "trimClip", alias = "TrimClip", rename_all = "camelCase")]
    TrimClip {
        sequence_id: SequenceId,
        track_id: TrackId,
        clip_id: ClipId,
        #[serde(alias = "newSourceIn")]
        new_source_in: Option<TimeSec>,
        #[serde(alias = "newSourceOut")]
        new_source_out: Option<TimeSec>,
        #[serde(alias = "newTimelineIn")]
        new_timeline_in: Option<TimeSec>,
    },
    #[serde(alias = "splitClip", alias = "SplitClip", rename_all = "camelCase")]
    SplitClip {
        sequence_id: SequenceId,
        track_id: TrackId,
        clip_id: ClipId,
        #[serde(alias = "splitTime", alias = "atTimelineSec")]
        split_time: TimeSec,
    },
    #[serde(alias = "importAsset", alias = "ImportAsset", rename_all = "camelCase")]
    ImportAsset { name: String, uri: String },
    #[serde(alias = "removeAsset", alias = "RemoveAsset", rename_all = "camelCase")]
    RemoveAsset { asset_id: AssetId },
    #[serde(
        alias = "createSequence",
        alias = "CreateSequence",
        rename_all = "camelCase"
    )]
    CreateSequence {
        name: String,
        format: Option<String>,
    },
    #[serde(
        alias = "updateCaption",
        alias = "UpdateCaption",
        rename_all = "camelCase"
    )]
    UpdateCaption {
        sequence_id: SequenceId,
        track_id: TrackId,
        #[serde(alias = "clipId")]
        caption_id: ClipId,
        text: Option<String>,
        #[serde(alias = "startSec")]
        start_sec: Option<TimeSec>,
        #[serde(alias = "endSec")]
        end_sec: Option<TimeSec>,
        // Forward-compatible fields currently used by UI/QC but not applied by core yet.
        // Keep them to avoid rejecting payloads during strict parsing.
        style: Option<serde_json::Value>,
        position: Option<serde_json::Value>,
    },
}

impl CommandPayload {
    pub fn parse(command_type: String, payload: serde_json::Value) -> Result<Self, String> {
        let raw_request = serde_json::json!({
            "commandType": command_type,
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
}
