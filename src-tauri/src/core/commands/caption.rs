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

fn normalize_generated_caption_text(text: &str) -> Option<String> {
    let trimmed = text
        .trim_matches(['\u{FEFF}', '\u{0000}'])
        .trim()
        .to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
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
            style: None,
            position: None,
            created_caption_id: None,
        }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = text.into();
        self
    }

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
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
        clip.caption_style = self.style.clone().filter(|style| !style.is_null());
        clip.caption_position = self.position.clone().filter(|position| !position.is_null());

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
// ImportGeneratedCaptionsCommand
// =============================================================================

/// A single segment produced by speech-to-text or another caption generator.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCaptionSegment {
    #[serde(alias = "startTime", alias = "start")]
    pub start_sec: TimeSec,
    #[serde(alias = "endTime", alias = "end")]
    pub end_sec: TimeSec,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(alias = "speakerId", skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl GeneratedCaptionSegment {
    pub fn new(start_sec: TimeSec, end_sec: TimeSec, text: impl Into<String>) -> Self {
        Self {
            start_sec,
            end_sec,
            text: text.into(),
            confidence: None,
            speaker: None,
            language: None,
        }
    }
}

/// Command to import generated captions as one atomic edit operation.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportGeneratedCaptionsCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub segments: Vec<GeneratedCaptionSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<serde_json::Value>,
    #[serde(default)]
    pub replace_existing: bool,
    #[serde(skip)]
    created_caption_ids: Vec<ClipId>,
    #[serde(skip)]
    removed_clips: Vec<(usize, Clip)>,
}

impl ImportGeneratedCaptionsCommand {
    pub fn new(sequence_id: &str, track_id: &str, segments: Vec<GeneratedCaptionSegment>) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            track_id: track_id.to_string(),
            segments,
            style: None,
            position: None,
            replace_existing: false,
            created_caption_ids: Vec::new(),
            removed_clips: Vec::new(),
        }
    }

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
        self
    }

    pub fn replace_existing(mut self, replace_existing: bool) -> Self {
        self.replace_existing = replace_existing;
        self
    }

    fn normalized_segments(&self) -> CoreResult<Vec<GeneratedCaptionSegment>> {
        if self.segments.is_empty() {
            return Err(CoreError::ValidationError(
                "Generated caption import requires at least one segment".to_string(),
            ));
        }

        let mut segments = Vec::with_capacity(self.segments.len());
        for (index, segment) in self.segments.iter().enumerate() {
            if !is_valid_time_sec(segment.start_sec) || !is_valid_time_sec(segment.end_sec) {
                return Err(CoreError::ValidationError(format!(
                    "Generated caption segment {} time range must be finite and non-negative",
                    index + 1
                )));
            }
            if segment.start_sec >= segment.end_sec {
                return Err(CoreError::InvalidTimeRange(
                    segment.start_sec,
                    segment.end_sec,
                ));
            }

            let text = normalize_generated_caption_text(&segment.text).ok_or_else(|| {
                CoreError::ValidationError(format!(
                    "Generated caption segment {} text cannot be empty",
                    index + 1
                ))
            })?;

            let mut normalized = segment.clone();
            normalized.text = text;
            segments.push(normalized);
        }

        segments.sort_by(|left, right| {
            left.start_sec
                .total_cmp(&right.start_sec)
                .then_with(|| left.end_sec.total_cmp(&right.end_sec))
                .then_with(|| left.text.cmp(&right.text))
        });

        Ok(segments)
    }
}

impl Command for ImportGeneratedCaptionsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let segments = self.normalized_segments()?;
        self.created_caption_ids.clear();
        self.removed_clips.clear();

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

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);

        if self.replace_existing {
            self.removed_clips = track.clips.iter().cloned().enumerate().collect();
            for (_, clip) in &self.removed_clips {
                result = result
                    .with_change(StateChange::CaptionDeleted {
                        caption_id: clip.id.clone(),
                    })
                    .with_deleted_id(&clip.id);
            }
            track.clips.clear();
        }

        for segment in segments {
            let duration = segment.end_sec - segment.start_sec;
            let mut clip = Clip::new(CAPTION_ASSET_ID);
            clip.speed = 1.0;
            clip.place = ClipPlace::new(segment.start_sec, duration);
            clip.range = ClipRange::new(0.0, duration);
            clip.label = Some(segment.text);
            clip.caption_style = self.style.clone().filter(|style| !style.is_null());
            clip.caption_position = self.position.clone().filter(|position| !position.is_null());

            let caption_id = clip.id.clone();
            self.created_caption_ids.push(caption_id.clone());
            track.add_clip(clip);
            result = result
                .with_change(StateChange::CaptionCreated {
                    caption_id: caption_id.clone(),
                })
                .with_created_id(&caption_id);
        }

        track.clips.sort_by(|left, right| {
            left.place
                .timeline_in_sec
                .total_cmp(&right.place.timeline_in_sec)
                .then_with(|| {
                    left.place
                        .timeline_out_sec()
                        .total_cmp(&right.place.timeline_out_sec())
                })
                .then_with(|| left.id.cmp(&right.id))
        });

        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.get_track_mut(&self.track_id) else {
            return Ok(());
        };

        for caption_id in &self.created_caption_ids {
            track.remove_clip(caption_id);
        }

        if self.replace_existing {
            for (position, clip) in &self.removed_clips {
                if *position <= track.clips.len() {
                    track.clips.insert(*position, clip.clone());
                } else {
                    track.clips.push(clip.clone());
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "ImportGeneratedCaptions"
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
    #[serde(skip)]
    old_style: Option<Option<serde_json::Value>>,
    #[serde(skip)]
    old_position: Option<Option<serde_json::Value>>,
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
            old_style: None,
            old_position: None,
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

    pub fn with_style(mut self, style: Option<serde_json::Value>) -> Self {
        self.style = style;
        self
    }

    pub fn with_position(mut self, position: Option<serde_json::Value>) -> Self {
        self.position = position;
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
            has_style = self.style.is_some(),
            has_position = self.position.is_some(),
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
        self.old_style = Some(clip.caption_style.clone());
        self.old_position = Some(clip.caption_position.clone());

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

        if let Some(style) = self.style.clone() {
            clip.caption_style = if style.is_null() { None } else { Some(style) };
        }

        if let Some(position) = self.position.clone() {
            clip.caption_position = if position.is_null() {
                None
            } else {
                Some(position)
            };
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
        if let Some(old_style) = &self.old_style {
            clip.caption_style = old_style.clone();
        }
        if let Some(old_position) = &self.old_position {
            clip.caption_position = old_position.clone();
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

    fn state_with_caption_track() -> (ProjectState, String, String) {
        let mut state = ProjectState::new_empty("Test");
        let mut sequence = Sequence::new("Sequence 1", SequenceFormat::youtube_1080());
        let track = Track::new_caption("Captions");
        let seq_id = sequence.id.clone();
        let track_id = track.id.clone();
        sequence.add_track(track);
        state.active_sequence_id = Some(seq_id.clone());
        state.sequences.insert(seq_id.clone(), sequence);
        (state, seq_id, track_id)
    }

    #[test]
    fn import_generated_captions_creates_sorted_caption_clips() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let style = serde_json::json!({ "fontSize": 48 });
        let position = serde_json::json!({ "type": "preset", "vertical": "bottom" });
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![
                GeneratedCaptionSegment::new(2.0, 3.0, "Second"),
                GeneratedCaptionSegment::new(0.0, 1.5, " First "),
            ],
        )
        .with_style(Some(style.clone()))
        .with_position(Some(position.clone()));

        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 2);
        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 2);
        assert_eq!(track.clips[0].label.as_deref(), Some("First"));
        assert_eq!(track.clips[0].caption_style, Some(style));
        assert_eq!(track.clips[0].caption_position, Some(position));
        assert_eq!(track.clips[1].label.as_deref(), Some("Second"));
    }

    #[test]
    fn import_generated_captions_can_replace_existing_captions_and_undo() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let existing_id = {
            let sequence = state.sequences.get_mut(&seq_id).unwrap();
            let track = sequence.get_track_mut(&track_id).unwrap();
            let mut clip = Clip::new(CAPTION_ASSET_ID);
            clip.label = Some("Old".to_string());
            clip.place = ClipPlace::new(0.0, 1.0);
            clip.range = ClipRange::new(0.0, 1.0);
            let id = clip.id.clone();
            track.add_clip(clip);
            id
        };

        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![GeneratedCaptionSegment::new(1.0, 2.0, "New")],
        )
        .replace_existing(true);

        let result = cmd.execute(&mut state).unwrap();
        assert_eq!(result.deleted_ids, vec![existing_id.clone()]);
        assert_eq!(result.created_ids.len(), 1);
        {
            let sequence = state.get_sequence(&seq_id).unwrap();
            let track = sequence.get_track(&track_id).unwrap();
            assert_eq!(track.clips.len(), 1);
            assert_eq!(track.clips[0].label.as_deref(), Some("New"));
        }

        cmd.undo(&mut state).unwrap();
        let sequence = state.get_sequence(&seq_id).unwrap();
        let track = sequence.get_track(&track_id).unwrap();
        assert_eq!(track.clips.len(), 1);
        assert_eq!(track.clips[0].id, existing_id);
        assert_eq!(track.clips[0].label.as_deref(), Some("Old"));
    }

    #[test]
    fn import_generated_captions_rejects_empty_segment_text() {
        let (mut state, seq_id, track_id) = state_with_caption_track();
        let mut cmd = ImportGeneratedCaptionsCommand::new(
            &seq_id,
            &track_id,
            vec![GeneratedCaptionSegment::new(0.0, 1.0, "   ")],
        );

        let err = cmd.execute(&mut state).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }

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
