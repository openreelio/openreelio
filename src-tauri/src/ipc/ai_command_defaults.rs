pub(crate) fn command_needs_sequence_id(command_type: &str) -> bool {
    matches!(
        command_type,
        "InsertClip"
            | "InsertEdit"
            | "OverwriteEdit"
            | "RippleDelete"
            | "Lift"
            | "ExtractEdit"
            | "CloseGap"
            | "CloseAllGaps"
            | "SplitClip"
            | "DeleteClip"
            | "RemoveClip"
            | "TrimClip"
            | "MoveClip"
            | "SetClipTransform"
            | "SetClipMute"
            | "SetClipAudio"
            | "SetClipBlendMode"
            | "SetClipSpeed"
            | "setClipSpeed"
            | "CreateTrack"
            | "createTrack"
            | "AddTrack"
            | "addTrack"
            | "RemoveTrack"
            | "removeTrack"
            | "deleteTrack"
            | "DeleteTrack"
            | "RenameTrack"
            | "renameTrack"
            | "ToggleTrackMute"
            | "toggleTrackMute"
            | "ToggleTrackLock"
            | "toggleTrackLock"
            | "ToggleTrackVisibility"
            | "toggleTrackVisibility"
            | "UpdateCaption"
            | "CreateCaption"
            | "DeleteCaption"
            | "AddMarker"
            | "addMarker"
            | "RemoveMarker"
            | "removeMarker"
            | "DeleteMarker"
            | "deleteMarker"
            | "ReorderTracks"
            | "reorderTracks"
    )
}

pub(crate) fn ensure_sequence_id(
    params: &mut serde_json::Map<String, serde_json::Value>,
    command_type: &str,
    sequence_id: &str,
) {
    if command_needs_sequence_id(command_type) && !params.contains_key("sequenceId") {
        params.insert(
            "sequenceId".to_string(),
            serde_json::json!(sequence_id.to_string()),
        );
    }
}

pub(crate) fn command_needs_track_id(command_type: &str) -> bool {
    matches!(
        command_type,
        "SplitClip"
            | "SetClipTransform"
            | "SetClipMute"
            | "SetClipAudio"
            | "SetClipBlendMode"
            | "SetClipSpeed"
            | "setClipSpeed"
            | "DeleteClip"
            | "RemoveClip"
            | "TrimClip"
            | "MoveClip"
            | "UpdateCaption"
            | "CreateCaption"
            | "DeleteCaption"
    )
}

#[cfg(test)]
mod tests {
    use super::{command_needs_sequence_id, command_needs_track_id, ensure_sequence_id};

    #[test]
    fn ensure_sequence_id_injects_for_new_timeline_edit_commands() {
        for command_type in [
            "InsertEdit",
            "OverwriteEdit",
            "RippleDelete",
            "Lift",
            "ExtractEdit",
        ] {
            assert!(command_needs_sequence_id(command_type));

            let mut params = serde_json::Map::new();
            ensure_sequence_id(&mut params, command_type, "seq_active");

            assert_eq!(
                params.get("sequenceId"),
                Some(&serde_json::json!("seq_active"))
            );
        }
    }

    #[test]
    fn ensure_sequence_id_preserves_existing_value() {
        let mut params = serde_json::Map::from_iter([(
            "sequenceId".to_string(),
            serde_json::json!("seq_existing"),
        )]);

        ensure_sequence_id(&mut params, "InsertEdit", "seq_active");

        assert_eq!(
            params.get("sequenceId"),
            Some(&serde_json::json!("seq_existing"))
        );
    }

    #[test]
    fn command_needs_track_id_marks_clip_targeted_commands() {
        assert!(command_needs_track_id("TrimClip"));
        assert!(command_needs_track_id("UpdateCaption"));
        assert!(!command_needs_track_id("InsertEdit"));
    }
}
