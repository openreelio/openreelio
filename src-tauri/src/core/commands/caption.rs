//! Caption Commands Module
//!
//! Implements caption editing commands.
//! Currently captions are represented as `Clip` entries inside `TrackKind::Caption` tracks,
//! with `Clip.label` used as the caption text.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Clip, ClipPlace, ClipRange},
    ClipId, CoreError, CoreResult, SequenceId, TimeSec, TrackId,
};

const CAPTION_ASSET_ID: &str = "caption";

fn is_valid_time_sec(value: TimeSec) -> bool {
    value.is_finite() && value >= 0.0
}

fn normalize_caption_text(text: String) -> Option<String> {
    let trimmed = text.trim_matches(['\u{FEFF}', '\u{0000}']);
    if trimmed.is_empty() {
        None
    } else if trimmed.len() == text.len() {
        Some(text)
    } else {
        Some(trimmed.to_string())
    }
}

// =============================================================================
// CreateCaptionCommand
// =============================================================================

/// Command to create a caption clip on a caption track.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub start_sec: TimeSec,
    pub end_sec: TimeSec,
    pub text: String,
    #[serde(skip)]
    created_caption_id: Option<ClipId>,
}

impl CreateCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, start_sec: TimeSec, end_sec: TimeSec) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            start_sec,
            end_sec,
            text: String::new(),
            created_caption_id: None,
        }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }
}

impl Command for CreateCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !is_valid_time_sec(self.start_sec) || !is_valid_time_sec(self.end_sec) {
            return Err(CoreError::ValidationError(
                "Caption time range must be finite and non-negative".to_string(),
            ));
        }
        if self.start_sec >= self.end_sec {
            return Err(CoreError::InvalidTimeRange(self.start_sec, self.end_sec));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let duration = self.end_sec - self.start_sec;
        let mut clip = Clip::new(CAPTION_ASSET_ID);
        clip.speed = 1.0;
        clip.place = ClipPlace::new(self.start_sec, duration);
        clip.range = ClipRange::new(0.0, duration);
        clip.label = normalize_caption_text(std::mem::take(&mut self.text));

        let caption_id = clip.id.clone();
        self.created_caption_id = Some(caption_id.clone());
        track.add_clip(clip);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::CaptionCreated {
                caption_id: caption_id.clone(),
            })
            .with_created_id(&caption_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(caption_id) = self.created_caption_id.as_deref() else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                track.remove_clip(&caption_id.to_string());
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// DeleteCaptionCommand
// =============================================================================

/// Command to delete a caption clip from a caption track.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    #[serde(skip)]
    removed_clip: Option<Clip>,
    #[serde(skip)]
    original_position: Option<usize>,
}

impl DeleteCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, caption_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            caption_id: caption_id.to_string(),
            removed_clip: None,
            original_position: None,
        }
    }
}

impl Command for DeleteCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let pos = track
            .clips
            .iter()
            .position(|c| c.id == self.caption_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.caption_id.clone()))?;

        self.removed_clip = Some(track.clips[pos].clone());
        self.original_position = Some(pos);
        track.clips.remove(pos);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::CaptionDeleted {
                caption_id: self.caption_id.clone(),
            })
            .with_deleted_id(&self.caption_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(clip), Some(position)) = (&self.removed_clip, self.original_position) else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                if position <= track.clips.len() {
                    track.clips.insert(position, clip.clone());
                } else {
                    track.clips.push(clip.clone());
                }
            }
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DeleteCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// UpdateCaptionCommand
// =============================================================================

/// Command to update a caption clip's text and/or time range.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCaptionCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    #[serde(alias = "clipId")]
    pub caption_id: ClipId,
    pub text: Option<String>,
    pub start_sec: Option<TimeSec>,
    pub end_sec: Option<TimeSec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
    #[serde(skip)]
    old_label: Option<Option<String>>,
    #[serde(skip)]
    old_place: Option<ClipPlace>,
    #[serde(skip)]
    old_range: Option<ClipRange>,
}

impl UpdateCaptionCommand {
    pub fn new(sequence_id: &str, track_id: &str, caption_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            caption_id: caption_id.to_string(),
            text: None,
            start_sec: None,
            end_sec: None,
            style: None,
            position: None,
            old_label: None,
            old_place: None,
            old_range: None,
        }
    }

    pub fn with_text(mut self, text: Option<String>) -> Self {
        self.text = text;
        self
    }

    pub fn with_time_range(mut self, start_sec: Option<TimeSec>, end_sec: Option<TimeSec>) -> Self {
        self.start_sec = start_sec;
        self.end_sec = end_sec;
        self
    }
}

impl Command for UpdateCaptionCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        tracing::debug!(
            sequence_id = %self.sequence_id,
            track_id = %self.track_id,
            caption_id = %self.caption_id,
            has_text = self.text.is_some(),
            has_time_range = self.start_sec.is_some() || self.end_sec.is_some(),
            "Updating caption"
        );

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;
        if !track.is_caption() {
            return Err(CoreError::ValidationError(format!(
                "Track is not a caption track: {}",
                self.track_id
            )));
        }

        let clip = track
            .get_clip_mut(&self.caption_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.caption_id.clone()))?;

        self.old_label = Some(clip.label.clone());
        self.old_place = Some(clip.place.clone());
        self.old_range = Some(clip.range.clone());

        clip.speed = 1.0;

        if let Some(text) = self.text.clone() {
            clip.label = normalize_caption_text(text);
        }

        if self.start_sec.is_some() || self.end_sec.is_some() {
            let old_start = clip.place.timeline_in_sec;
            let old_end = clip.place.timeline_out_sec();

            let new_start = self.start_sec.unwrap_or(old_start);
            let new_end = self.end_sec.unwrap_or(old_end);

            if !is_valid_time_sec(new_start) || !is_valid_time_sec(new_end) {
                return Err(CoreError::ValidationError(
                    "Caption time range must be finite and non-negative".to_string(),
                ));
            }
            if new_start >= new_end {
                return Err(CoreError::InvalidTimeRange(new_start, new_end));
            }

            let duration = new_end - new_start;
            clip.place = ClipPlace::new(new_start, duration);
            clip.range = ClipRange::new(0.0, duration);
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::CaptionModified {
                caption_id: self.caption_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };
        let Some(clip) = track.get_clip_mut(&self.caption_id) else {
            return Ok(());
        };

        if let Some(old_label) = &self.old_label {
            clip.label = old_label.clone();
        }
        if let Some(old_place) = &self.old_place {
            clip.place = old_place.clone();
        }
        if let Some(old_range) = &self.old_range {
            clip.range = old_range.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateCaption"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Sequence, SequenceFormat, Track};

    #[test]
    fn update_caption_updates_label_and_time_range() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let mut clip = Clip::new(CAPTION_ASSET_ID);
        clip.label = Some("Old".to_string());
        clip.place = ClipPlace::new(1.0, 2.0);
        clip.range = ClipRange::new(0.0, 2.0);

        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_text(Some("New".to_string()))
            .with_time_range(Some(3.0), Some(5.5));

        cmd.execute(&mut state).unwrap();

        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        let clip = track.get_clip(&caption_id).unwrap();

        assert_eq!(clip.label.as_deref(), Some("New"));
        assert_eq!(clip.place.timeline_in_sec, 3.0);
        assert!((clip.place.duration_sec - 2.5).abs() < f64::EPSILON);
    }

    #[test]
    fn update_caption_rejects_end_before_start() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let clip = Clip::new(CAPTION_ASSET_ID);
        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_time_range(Some(5.0), Some(3.0));

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::InvalidTimeRange(_, _)));
    }

    #[test]
    fn update_caption_rejects_negative_times() {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let mut track = Track::new_caption("Captions");

        let clip = Clip::new(CAPTION_ASSET_ID);
        let caption_id = clip.id.clone();
        let track_id = track.id.clone();
        track.add_clip(clip);

        let seq_id = sequence.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);

        let mut cmd = UpdateCaptionCommand::new(&seq_id, &track_id, &caption_id)
            .with_time_range(Some(-1.0), Some(1.0));

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }
}
