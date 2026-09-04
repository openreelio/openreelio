//! Sequence Commands Module
//!
//! Implements all sequence-related editing commands.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    project::ProjectState,
    timeline::{Canvas, FpsSpec, Sequence, SequenceFormat, SequenceHdrSettings, Track, TrackKind},
    CoreError, CoreResult, SequenceId,
};

// =============================================================================
// CreateSequenceCommand
// =============================================================================

/// Command to create a new sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSequenceCommand {
    /// Sequence name
    pub name: String,
    /// Sequence format preset
    pub format: String,
    /// Whether to add default tracks
    pub add_default_tracks: bool,
    /// Created sequence ID (stored after execution for undo)
    #[serde(skip)]
    created_sequence_id: Option<SequenceId>,
    /// Previously active sequence ID, restored on undo when possible.
    #[serde(skip)]
    previous_active_sequence_id: Option<SequenceId>,
}

impl CreateSequenceCommand {
    /// Creates a new create sequence command
    pub fn new(name: &str, format: &str) -> Self {
        Self {
            name: name.to_string(),
            format: format.to_string(),
            add_default_tracks: true,
            created_sequence_id: None,
            previous_active_sequence_id: None,
        }
    }

    /// Sets whether to add default tracks
    pub fn with_default_tracks(mut self, add: bool) -> Self {
        self.add_default_tracks = add;
        self
    }

    fn resolve_sequence_format(format: &str) -> SequenceFormat {
        match format.trim().to_ascii_lowercase().as_str() {
            "1080p" | "youtube_1080" | "youtube_1080p" | "landscape_1080" | "1920x1080" => {
                SequenceFormat::youtube_1080()
            }
            "4k" | "uhd_4k" | "youtube_4k" | "3840x2160" => SequenceFormat::youtube_4k(),
            "shorts" | "youtube_shorts" | "shorts_1080" | "vertical" | "vertical_1080"
            | "vertical_1080p" | "portrait_1080" | "1080x1920" | "9:16" => {
                SequenceFormat::youtube_shorts()
            }
            _ => SequenceFormat::youtube_1080(),
        }
    }
}

impl Command for CreateSequenceCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let seq_format = Self::resolve_sequence_format(&self.format);

        // Create sequence
        let mut sequence = Sequence::new(&self.name, seq_format);

        // Add default tracks if requested
        if self.add_default_tracks {
            let video_track = Track::new("Video 1", TrackKind::Video).with_base_track(true);
            let audio_track = Track::new("Audio 1", TrackKind::Audio).with_base_track(true);
            sequence.add_track(video_track);
            sequence.add_track(audio_track);
        }

        let seq_id = sequence.id.clone();
        self.created_sequence_id = Some(seq_id.clone());
        self.previous_active_sequence_id = state.active_sequence_id.clone();

        // Insert into state
        state.sequences.insert(seq_id.clone(), sequence);

        // Newly created sequences should be visible immediately in the editor.
        state.active_sequence_id = Some(seq_id.clone());

        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::SequenceCreated {
                sequence_id: seq_id.clone(),
            })
            .with_created_id(&seq_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref seq_id) = self.created_sequence_id {
            state.sequences.remove(seq_id);

            // Restore the previous active sequence when possible.
            if state.active_sequence_id.as_ref() == Some(seq_id) {
                state.active_sequence_id = self
                    .previous_active_sequence_id
                    .as_ref()
                    .filter(|previous_id| state.sequences.contains_key(*previous_id))
                    .cloned()
                    .or_else(|| state.sequences.keys().next().cloned());
            }

            state.is_dirty = true;
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "CreateSequence"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

// =============================================================================
// DeleteSequenceCommand
// =============================================================================

/// Command to delete a sequence
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSequenceCommand {
    /// Sequence ID to delete
    pub sequence_id: SequenceId,
    /// Stored sequence data for undo
    #[serde(skip)]
    deleted_sequence: Option<Sequence>,
    /// Whether this was the active sequence
    #[serde(skip)]
    was_active: bool,
}

impl DeleteSequenceCommand {
    /// Creates a new delete sequence command
    pub fn new(sequence_id: &str) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            deleted_sequence: None,
            was_active: false,
        }
    }
}

impl Command for DeleteSequenceCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Check if sequence exists
        let sequence = state
            .sequences
            .get(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?
            .clone();

        // Store for undo
        self.deleted_sequence = Some(sequence);
        self.was_active = state.active_sequence_id.as_ref() == Some(&self.sequence_id);

        // Remove from state
        state.sequences.remove(&self.sequence_id);

        // Update active sequence if needed
        if self.was_active {
            state.active_sequence_id = state.sequences.keys().next().cloned();
        }

        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();

        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            })
            .with_deleted_id(&self.sequence_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        if let Some(ref sequence) = self.deleted_sequence {
            state
                .sequences
                .insert(self.sequence_id.clone(), sequence.clone());

            // Restore active sequence if it was active
            if self.was_active {
                state.active_sequence_id = Some(self.sequence_id.clone());
            }

            state.is_dirty = true;
        }
        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "DeleteSequence"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "sequenceId": self.sequence_id })
    }
}

// =============================================================================
// SetMasterVolumeCommand
// =============================================================================

const MASTER_MIN_VOLUME_DB: f32 = -60.0;
const MASTER_MAX_VOLUME_DB: f32 = 6.0;

/// Command to set the master output volume on a sequence.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMasterVolumeCommand {
    pub sequence_id: SequenceId,
    pub volume_db: f32,
    #[serde(skip)]
    previous_volume_db: Option<f32>,
}

impl SetMasterVolumeCommand {
    pub fn new(sequence_id: &str, volume_db: f32) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            volume_db,
            previous_volume_db: None,
        }
    }
}

impl Command for SetMasterVolumeCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        if !self.volume_db.is_finite() {
            return Err(CoreError::InvalidCommand(
                "Master volume must be a finite number".to_string(),
            ));
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        self.previous_volume_db = Some(sequence.master_volume_db);
        sequence.master_volume_db = self
            .volume_db
            .clamp(MASTER_MIN_VOLUME_DB, MASTER_MAX_VOLUME_DB);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous) = self.previous_volume_db else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            sequence.master_volume_db = previous;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetMasterVolume"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "volumeDb": self.volume_db,
        })
    }
}

// =============================================================================
// UpdateSequenceHdrSettingsCommand
// =============================================================================

/// Command to update sequence-level HDR export settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSequenceHdrSettingsCommand {
    pub sequence_id: SequenceId,
    pub settings: SequenceHdrSettings,
    #[serde(skip)]
    previous_settings: Option<SequenceHdrSettings>,
    #[serde(skip)]
    previous_modified_at: Option<String>,
}

impl UpdateSequenceHdrSettingsCommand {
    pub fn new(sequence_id: &str, settings: SequenceHdrSettings) -> Self {
        Self {
            sequence_id: sequence_id.to_string(),
            settings: settings.normalized(),
            previous_settings: None,
            previous_modified_at: None,
        }
    }
}

impl Command for UpdateSequenceHdrSettingsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        self.settings = self.settings.clone().normalized();
        self.previous_settings = Some(sequence.hdr_settings.clone());
        self.previous_modified_at = Some(sequence.modified_at.clone());
        sequence.hdr_settings = self.settings.clone();
        sequence.modified_at = chrono::Utc::now().to_rfc3339();
        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
                sequence_id: self.sequence_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(previous) = &self.previous_settings else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            sequence.hdr_settings = previous.clone();
            if let Some(previous_modified_at) = &self.previous_modified_at {
                sequence.modified_at = previous_modified_at.clone();
            }
            state.is_dirty = true;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateSequenceHdrSettings"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "settings": self.settings,
        })
    }
}

// =============================================================================
// SetSequenceFormatCommand
// =============================================================================

/// Smallest canvas edge a sequence may declare, in pixels.
const MIN_CANVAS_DIMENSION: u32 = 16;

/// Largest canvas edge a sequence may declare, in pixels.
///
/// Matches the level ceiling of the codecs the exporter drives; anything larger
/// would be accepted here and refused by every render preset.
const MAX_CANVAS_DIMENSION: u32 = 16384;

/// Audio sample rates the export pipeline accepts, in Hz.
///
/// The renderer validates a requested rate as `1..=192000`, but only the
/// standard family actually survives a round trip through the encoders it
/// drives, so a sequence may only declare one of these.
const SUPPORTED_AUDIO_SAMPLE_RATES: &[u32] = &[
    8_000, 11_025, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
];

/// Largest audio channel count a sequence may declare.
///
/// The export pipeline mixes to stereo, so a higher count would be a promise
/// the renderer cannot keep.
const MAX_AUDIO_CHANNELS: u8 = 2;

/// Command to change a sequence's delivery format: frame rate, canvas size and
/// audio format.
///
/// Every field is optional and at least one must be set; the fields left unset
/// keep their current value. The sequence defaults to the project's active one.
///
/// # Frame rate
///
/// `fps` accepts either an exact ratio (`{"num": 30000, "den": 1001}`) or a
/// decimal (`29.97`); [`FpsSpec::to_ratio`] documents how a decimal is snapped.
/// Changing the frame rate re-times nothing: the timeline is stored in seconds,
/// so every clip keeps the instant it starts and ends at. What changes is the
/// grid the renderer quantises to — cut positions land on the nearest new
/// frame, and transition durations are re-derived in frames.
///
/// # Canvas
///
/// Clip transforms are canvas-relative (normalized position and scale), so they
/// are left exactly as they are: a clip centered at half scale stays centered at
/// half scale. What changes is how the source *fits*: a 16:9 clip on a canvas
/// that becomes 9:16 will letterbox or crop according to the clip's own fit
/// behaviour. This command does not re-fit anything, and does not try to guess
/// which of those the caller wanted.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSequenceFormatCommand {
    /// Sequence to change; the active sequence when omitted.
    pub sequence_id: Option<SequenceId>,
    /// New frame rate, as an exact ratio or a decimal.
    pub fps: Option<FpsSpec>,
    /// New canvas width in pixels.
    pub width: Option<u32>,
    /// New canvas height in pixels.
    pub height: Option<u32>,
    /// New audio sample rate in Hz.
    pub audio_sample_rate: Option<u32>,
    /// New audio channel count.
    pub audio_channels: Option<u8>,
    /// Sequence the command actually changed, kept for undo.
    #[serde(skip)]
    resolved_sequence_id: Option<SequenceId>,
    /// Format replaced by this command, restored on undo.
    #[serde(skip)]
    previous_format: Option<SequenceFormat>,
    /// Modification timestamp replaced by this command, restored on undo.
    #[serde(skip)]
    previous_modified_at: Option<String>,
}

impl SetSequenceFormatCommand {
    /// Creates a command that changes nothing yet; set at least one field.
    pub fn new() -> Self {
        Self {
            sequence_id: None,
            fps: None,
            width: None,
            height: None,
            audio_sample_rate: None,
            audio_channels: None,
            resolved_sequence_id: None,
            previous_format: None,
            previous_modified_at: None,
        }
    }

    /// Targets an explicit sequence instead of the active one.
    pub fn for_sequence(mut self, sequence_id: &str) -> Self {
        self.sequence_id = Some(sequence_id.to_string());
        self
    }

    /// Sets the frame rate.
    pub fn with_fps(mut self, fps: FpsSpec) -> Self {
        self.fps = Some(fps);
        self
    }

    /// Sets the canvas size in pixels.
    pub fn with_canvas(mut self, width: u32, height: u32) -> Self {
        self.width = Some(width);
        self.height = Some(height);
        self
    }

    /// Sets the audio sample rate in Hz.
    pub fn with_audio_sample_rate(mut self, sample_rate: u32) -> Self {
        self.audio_sample_rate = Some(sample_rate);
        self
    }

    /// Sets the audio channel count.
    pub fn with_audio_channels(mut self, channels: u8) -> Self {
        self.audio_channels = Some(channels);
        self
    }

    /// Builds the format this command would produce from `current`.
    ///
    /// Separated from [`Command::execute`] so the validation is a pure function
    /// over the requested fields and can be tested without a project.
    fn resolve_format(&self, current: &SequenceFormat) -> CoreResult<SequenceFormat> {
        if self.fps.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.audio_sample_rate.is_none()
            && self.audio_channels.is_none()
        {
            return Err(CoreError::InvalidCommand(
                "SetSequenceFormat requires at least one of fps, width, height, \
                 audioSampleRate or audioChannels"
                    .to_string(),
            ));
        }

        let mut next = current.clone();

        if let Some(spec) = &self.fps {
            next.fps = spec.to_ratio().ok_or_else(|| {
                CoreError::InvalidCommand(
                    "Frame rate must be a positive rate of at most 1000 fps, given either as \
                     a number or as {\"num\", \"den\"} with both terms positive"
                        .to_string(),
                )
            })?;
        }

        // Only a *requested* edge is validated. A sequence already on disk may
        // carry an odd or out-of-range canvas (an older project, a hand-edited
        // snapshot), and refusing an unrelated `--fps 25` because of it would
        // leave the caller with no way to change anything at all.
        if let Some(width) = self.width {
            Self::validate_canvas_dimension(width, "width")?;
        }
        if let Some(height) = self.height {
            Self::validate_canvas_dimension(height, "height")?;
        }
        next.canvas = Canvas::new(
            self.width.unwrap_or(current.canvas.width),
            self.height.unwrap_or(current.canvas.height),
        );

        if let Some(sample_rate) = self.audio_sample_rate {
            if !SUPPORTED_AUDIO_SAMPLE_RATES.contains(&sample_rate) {
                return Err(CoreError::InvalidCommand(format!(
                    "Audio sample rate {sample_rate} Hz is not supported; use one of: {}",
                    SUPPORTED_AUDIO_SAMPLE_RATES
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            next.audio_sample_rate = sample_rate;
        }

        if let Some(channels) = self.audio_channels {
            if channels == 0 || channels > MAX_AUDIO_CHANNELS {
                return Err(CoreError::InvalidCommand(format!(
                    "Audio channel count must be 1 or {MAX_AUDIO_CHANNELS}, got {channels}"
                )));
            }
            next.audio_channels = channels;
        }

        Ok(next)
    }

    fn validate_canvas_dimension(value: u32, label: &str) -> CoreResult<()> {
        if !(MIN_CANVAS_DIMENSION..=MAX_CANVAS_DIMENSION).contains(&value) {
            return Err(CoreError::InvalidCommand(format!(
                "Canvas {label} must be between {MIN_CANVAS_DIMENSION} and \
                 {MAX_CANVAS_DIMENSION} pixels, got {value}"
            )));
        }
        if !value.is_multiple_of(2) {
            return Err(CoreError::InvalidCommand(format!(
                "Canvas {label} must be an even number of pixels (4:2:0 chroma \
                 subsampling halves both edges), got {value}"
            )));
        }
        Ok(())
    }
}

impl Default for SetSequenceFormatCommand {
    fn default() -> Self {
        Self::new()
    }
}

impl Command for SetSequenceFormatCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence_id = self
            .sequence_id
            .clone()
            .or_else(|| state.active_sequence_id.clone())
            .ok_or_else(|| {
                CoreError::InvalidCommand(
                    "SetSequenceFormat needs a sequenceId: the project has no active sequence"
                        .to_string(),
                )
            })?;

        let sequence = state
            .sequences
            .get(&sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.clone()))?;

        // Validated before anything is written, so a refused format leaves the
        // sequence exactly as it was.
        let next_format = self.resolve_format(&sequence.format)?;

        let sequence = state
            .sequences
            .get_mut(&sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.clone()))?;

        self.previous_format = Some(sequence.format.clone());
        self.previous_modified_at = Some(sequence.modified_at.clone());
        self.resolved_sequence_id = Some(sequence_id.clone());

        sequence.format = next_format;
        sequence.modified_at = chrono::Utc::now().to_rfc3339();
        state.is_dirty = true;

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::SequenceModified {
                sequence_id: sequence_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let (Some(sequence_id), Some(previous_format)) =
            (&self.resolved_sequence_id, &self.previous_format)
        else {
            return Ok(());
        };

        if let Some(sequence) = state.sequences.get_mut(sequence_id) {
            sequence.format = previous_format.clone();
            if let Some(previous_modified_at) = &self.previous_modified_at {
                sequence.modified_at = previous_modified_at.clone();
            }
            state.is_dirty = true;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "SetSequenceFormat"
    }

    fn to_json(&self) -> serde_json::Value {
        // Only the requested sequence. `CommandExecutor` captures `to_json()`
        // *before* `execute` runs, so `resolved_sequence_id` is always `None`
        // here; a payload that names no sequence is completed from the
        // `SequenceModified` change the execution reports.
        let mut payload = serde_json::Map::new();
        if let Some(sequence_id) = self.sequence_id.clone() {
            payload.insert(
                "sequenceId".to_string(),
                serde_json::Value::String(sequence_id),
            );
        }
        if let Some(fps) = &self.fps {
            payload.insert("fps".to_string(), serde_json::json!(fps));
        }
        if let Some(width) = self.width {
            payload.insert("width".to_string(), serde_json::json!(width));
        }
        if let Some(height) = self.height {
            payload.insert("height".to_string(), serde_json::json!(height));
        }
        if let Some(sample_rate) = self.audio_sample_rate {
            payload.insert(
                "audioSampleRate".to_string(),
                serde_json::json!(sample_rate),
            );
        }
        if let Some(channels) = self.audio_channels {
            payload.insert("audioChannels".to_string(), serde_json::json!(channels));
        }

        serde_json::Value::Object(payload)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::SequenceHdrMode;

    fn create_test_state() -> ProjectState {
        // Use new_empty for isolated sequence tests
        ProjectState::new_empty("Test Project")
    }

    #[test]
    fn test_create_sequence_command() {
        let mut state = create_test_state();
        assert!(state.sequences.is_empty());

        let mut cmd = CreateSequenceCommand::new("Main Sequence", "1080p");
        let result = cmd.execute(&mut state).unwrap();

        assert_eq!(result.created_ids.len(), 1);
        assert_eq!(state.sequences.len(), 1);

        let seq = state.sequences.values().next().unwrap();
        assert_eq!(seq.name, "Main Sequence");
        assert_eq!(seq.tracks.len(), 2); // Video + Audio default tracks
    }

    #[test]
    fn test_create_sequence_sets_active() {
        let mut state = create_test_state();
        assert!(state.active_sequence_id.is_none());

        let mut cmd = CreateSequenceCommand::new("First", "1080p");
        cmd.execute(&mut state).unwrap();

        assert!(state.active_sequence_id.is_some());
    }

    #[test]
    fn test_create_sequence_replaces_active_sequence() {
        let mut state = create_test_state();

        let mut first_cmd = CreateSequenceCommand::new("First", "1080p");
        first_cmd.execute(&mut state).unwrap();
        let first_id = state.active_sequence_id.clone().unwrap();

        let mut second_cmd = CreateSequenceCommand::new("Second", "1080p");
        second_cmd.execute(&mut state).unwrap();
        let second_id = state.active_sequence_id.clone().unwrap();

        assert_ne!(first_id, second_id);
        assert_eq!(state.sequences.get(&second_id).unwrap().name, "Second");

        second_cmd.undo(&mut state).unwrap();
        assert_eq!(state.active_sequence_id, Some(first_id));
    }

    #[test]
    fn test_create_sequence_accepts_vertical_format_aliases() {
        for alias in [
            "shorts",
            "youtube_shorts",
            "vertical_1080",
            "1080x1920",
            "9:16",
        ] {
            let format = CreateSequenceCommand::resolve_sequence_format(alias);
            assert_eq!(format.canvas.width, 1080, "alias: {alias}");
            assert_eq!(format.canvas.height, 1920, "alias: {alias}");
        }
    }

    #[test]
    fn test_create_sequence_without_default_tracks() {
        let mut state = create_test_state();

        let mut cmd =
            CreateSequenceCommand::new("Empty Sequence", "1080p").with_default_tracks(false);
        cmd.execute(&mut state).unwrap();

        let seq = state.sequences.values().next().unwrap();
        assert!(seq.tracks.is_empty());
    }

    #[test]
    fn test_create_sequence_undo() {
        let mut state = create_test_state();

        let mut cmd = CreateSequenceCommand::new("To Remove", "1080p");
        cmd.execute(&mut state).unwrap();
        assert_eq!(state.sequences.len(), 1);

        cmd.undo(&mut state).unwrap();
        assert!(state.sequences.is_empty());
    }

    #[test]
    fn test_delete_sequence_command() {
        let mut state = create_test_state();

        // Create sequence first
        let mut create_cmd = CreateSequenceCommand::new("To Delete", "1080p");
        let result = create_cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();

        // Delete it
        let mut delete_cmd = DeleteSequenceCommand::new(&seq_id);
        delete_cmd.execute(&mut state).unwrap();

        assert!(state.sequences.is_empty());
    }

    #[test]
    fn test_delete_sequence_undo() {
        let mut state = create_test_state();

        // Create and delete
        let mut create_cmd = CreateSequenceCommand::new("Restorable", "1080p");
        let result = create_cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();

        let mut delete_cmd = DeleteSequenceCommand::new(&seq_id);
        delete_cmd.execute(&mut state).unwrap();
        assert!(state.sequences.is_empty());

        // Undo deletion
        delete_cmd.undo(&mut state).unwrap();
        assert_eq!(state.sequences.len(), 1);
        assert_eq!(state.sequences.get(&seq_id).unwrap().name, "Restorable");
    }

    #[test]
    fn test_delete_nonexistent_sequence() {
        let mut state = create_test_state();

        let mut cmd = DeleteSequenceCommand::new("nonexistent");
        let result = cmd.execute(&mut state);

        assert!(matches!(result, Err(CoreError::SequenceNotFound(_))));
    }

    // =========================================================================
    // SetMasterVolumeCommand Tests
    // =========================================================================

    fn create_test_state_with_sequence() -> (ProjectState, String) {
        let mut state = create_test_state();
        let mut cmd = CreateSequenceCommand::new("Test Seq", "1080p");
        let result = cmd.execute(&mut state).unwrap();
        let seq_id = result.created_ids[0].clone();
        (state, seq_id)
    }

    #[test]
    fn test_set_master_volume_applies_value() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -6.0);
        cmd.execute(&mut state).unwrap();

        assert!((state.sequences[&seq_id].master_volume_db - (-6.0)).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_clamps_to_range() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        // Above max
        let mut cmd = SetMasterVolumeCommand::new(&seq_id, 20.0);
        cmd.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - 6.0).abs() < 1e-6);

        // Below min
        let mut cmd2 = SetMasterVolumeCommand::new(&seq_id, -100.0);
        cmd2.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - (-60.0)).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_undo_restores_previous() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -12.0);
        cmd.execute(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - (-12.0)).abs() < 1e-6);

        cmd.undo(&mut state).unwrap();
        assert!((state.sequences[&seq_id].master_volume_db - 0.0).abs() < 1e-6);
    }

    #[test]
    fn test_set_master_volume_rejects_nan() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, f32::NAN);
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_master_volume_persists_in_project() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetMasterVolumeCommand::new(&seq_id, -3.0);
        cmd.execute(&mut state).unwrap();

        // Verify the value is stored on the sequence
        let seq = state.sequences.get(&seq_id).unwrap();
        assert!((seq.master_volume_db - (-3.0)).abs() < 1e-6);
    }

    #[test]
    fn test_update_sequence_hdr_settings_normalizes_and_undoes() {
        let (mut state, seq_id) = create_test_state_with_sequence();
        let original_modified_at = "2026-01-01T00:00:00Z".to_string();
        state.sequences.get_mut(&seq_id).unwrap().modified_at = original_modified_at.clone();

        let mut cmd = UpdateSequenceHdrSettingsCommand::new(
            &seq_id,
            SequenceHdrSettings {
                hdr_mode: SequenceHdrMode::Hdr10,
                max_cll: Some(20000),
                max_fall: None,
                bit_depth: 8,
            },
        );
        cmd.execute(&mut state).unwrap();

        let settings = &state.sequences[&seq_id].hdr_settings;
        assert_eq!(settings.hdr_mode, SequenceHdrMode::Hdr10);
        assert_eq!(settings.bit_depth, 10);
        assert_eq!(settings.max_cll, Some(10000));
        assert_eq!(settings.max_fall, Some(400));
        assert_ne!(state.sequences[&seq_id].modified_at, original_modified_at);

        cmd.undo(&mut state).unwrap();

        let settings = &state.sequences[&seq_id].hdr_settings;
        assert_eq!(settings.hdr_mode, SequenceHdrMode::Sdr);
        assert_eq!(settings.bit_depth, 8);
        assert_eq!(settings.max_cll, None);
        assert_eq!(settings.max_fall, None);
        assert_eq!(state.sequences[&seq_id].modified_at, original_modified_at);
    }

    // =========================================================================
    // SetSequenceFormatCommand Tests
    // =========================================================================

    #[test]
    fn should_apply_a_vertical_25fps_format_to_the_active_sequence() {
        let (mut state, seq_id) = create_test_state_with_sequence();
        assert_eq!(state.sequences[&seq_id].format.canvas.width, 1920);

        let mut cmd = SetSequenceFormatCommand::new()
            .with_fps(FpsSpec::Decimal(25.0))
            .with_canvas(1080, 1920);
        let result = cmd.execute(&mut state).expect("format applies");

        let format = &state.sequences[&seq_id].format;
        assert_eq!((format.fps.num, format.fps.den), (25, 1));
        assert_eq!((format.canvas.width, format.canvas.height), (1080, 1920));
        assert!(matches!(
            result.changes.first(),
            Some(StateChange::SequenceModified { sequence_id }) if sequence_id == &seq_id
        ));
    }

    #[test]
    fn should_leave_unset_fields_alone() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = SetSequenceFormatCommand::new().with_fps(FpsSpec::Decimal(29.97));
        cmd.execute(&mut state).expect("format applies");

        let format = &state.sequences[&seq_id].format;
        assert_eq!((format.fps.num, format.fps.den), (30000, 1001));
        assert_eq!((format.canvas.width, format.canvas.height), (1920, 1080));
        assert_eq!(format.audio_sample_rate, 48000);
    }

    #[test]
    fn should_restore_the_previous_format_on_undo() {
        let (mut state, seq_id) = create_test_state_with_sequence();
        let original_modified_at = "2026-01-01T00:00:00Z".to_string();
        state.sequences.get_mut(&seq_id).unwrap().modified_at = original_modified_at.clone();

        let mut cmd = SetSequenceFormatCommand::new()
            .with_fps(FpsSpec::Decimal(25.0))
            .with_canvas(1080, 1920);
        cmd.execute(&mut state).expect("format applies");
        cmd.undo(&mut state).expect("undo applies");

        let sequence = &state.sequences[&seq_id];
        assert_eq!((sequence.format.fps.num, sequence.format.fps.den), (30, 1));
        assert_eq!(
            (sequence.format.canvas.width, sequence.format.canvas.height),
            (1920, 1080)
        );
        assert_eq!(sequence.modified_at, original_modified_at);
    }

    #[test]
    fn should_refuse_a_request_that_changes_nothing() {
        let (mut state, _seq_id) = create_test_state_with_sequence();

        let mut cmd = SetSequenceFormatCommand::new();
        let error = cmd.execute(&mut state).expect_err("empty request refused");

        assert!(matches!(error, CoreError::InvalidCommand(_)));
    }

    #[test]
    fn should_refuse_an_odd_or_out_of_range_canvas_and_leave_the_sequence_untouched() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        for (width, height) in [(1081, 1920), (1080, 1921), (8, 1080), (1920, 20000)] {
            let mut cmd = SetSequenceFormatCommand::new().with_canvas(width, height);
            assert!(
                cmd.execute(&mut state).is_err(),
                "{width}x{height} should be refused"
            );
        }

        let format = &state.sequences[&seq_id].format;
        assert_eq!((format.canvas.width, format.canvas.height), (1920, 1080));
    }

    #[test]
    fn should_refuse_an_unsupported_audio_format() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        assert!(SetSequenceFormatCommand::new()
            .with_audio_sample_rate(47_000)
            .execute(&mut state)
            .is_err());
        assert!(SetSequenceFormatCommand::new()
            .with_audio_channels(6)
            .execute(&mut state)
            .is_err());
        assert!(SetSequenceFormatCommand::new()
            .with_audio_channels(0)
            .execute(&mut state)
            .is_err());

        assert_eq!(state.sequences[&seq_id].format.audio_sample_rate, 48000);
        assert_eq!(state.sequences[&seq_id].format.audio_channels, 2);
    }

    #[test]
    fn should_refuse_a_frame_rate_that_is_not_a_usable_timebase() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        assert!(SetSequenceFormatCommand::new()
            // Built as a struct literal on purpose: `Ratio::new` silently
            // rewrites a zero denominator to 1, but a deserialized payload
            // keeps the zero, and that is the shape this must refuse.
            .with_fps(FpsSpec::Ratio(crate::core::Ratio { num: 30, den: 0 }))
            .execute(&mut state)
            .is_err());
        assert!(SetSequenceFormatCommand::new()
            .with_fps(FpsSpec::Decimal(0.0))
            .execute(&mut state)
            .is_err());

        assert_eq!(state.sequences[&seq_id].format.fps.num, 30);
    }

    #[test]
    fn should_refuse_a_sequence_that_does_not_exist() {
        let (mut state, _seq_id) = create_test_state_with_sequence();

        let mut cmd = SetSequenceFormatCommand::new()
            .for_sequence("nonexistent")
            .with_fps(FpsSpec::Decimal(25.0));

        assert!(matches!(
            cmd.execute(&mut state),
            Err(CoreError::SequenceNotFound(_))
        ));
    }

    #[test]
    fn should_omit_the_sequence_from_the_logged_payload_when_none_was_named() {
        // `CommandExecutor` captures `to_json()` before `execute`, so the
        // resolved sequence is never in it. The executor fills the gap from the
        // `SequenceModified` change instead — see
        // `should_replay_a_sequence_format_change_from_the_ops_log`.
        let (mut state, _seq_id) = create_test_state_with_sequence();

        let mut cmd = SetSequenceFormatCommand::new().with_fps(FpsSpec::Decimal(25.0));
        assert!(cmd.to_json().get("sequenceId").is_none());

        cmd.execute(&mut state).expect("format applies");
        assert!(cmd.to_json().get("sequenceId").is_none());
    }

    #[test]
    fn should_accept_a_frame_rate_change_on_a_sequence_whose_canvas_is_invalid() {
        // A project written before the canvas rules existed, or hand-edited.
        // Changing only the frame rate must not be refused because of it.
        let (mut state, seq_id) = create_test_state_with_sequence();
        state
            .sequences
            .get_mut(&seq_id)
            .expect("sequence exists")
            .format
            .canvas = Canvas::new(1920, 1081);

        SetSequenceFormatCommand::new()
            .with_fps(FpsSpec::Decimal(25.0))
            .execute(&mut state)
            .expect("fps applies over an odd canvas");

        let format = &state.sequences[&seq_id].format;
        assert_eq!((format.fps.num, format.fps.den), (25, 1));
        assert_eq!((format.canvas.width, format.canvas.height), (1920, 1081));
    }

    #[test]
    fn test_update_sequence_hdr_settings_clamps_fall_to_cll() {
        let (mut state, seq_id) = create_test_state_with_sequence();

        let mut cmd = UpdateSequenceHdrSettingsCommand::new(
            &seq_id,
            SequenceHdrSettings {
                hdr_mode: SequenceHdrMode::Hdr10,
                max_cll: Some(500),
                max_fall: Some(900),
                bit_depth: 10,
            },
        );
        cmd.execute(&mut state).unwrap();

        let settings = &state.sequences[&seq_id].hdr_settings;
        assert_eq!(settings.max_cll, Some(500));
        assert_eq!(settings.max_fall, Some(500));
    }
}
