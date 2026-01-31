//! Text Commands Module
//!
//! Implements text editing commands for the event sourcing system.
//! Text clips are created by adding TextOverlay effects to clips on
//! video or overlay tracks.
//!
//! # Architecture
//!
//! Text is implemented using the existing Effect system:
//! - `AddTextClipCommand` creates a new clip with a TextOverlay effect
//! - `UpdateTextCommand` updates the TextClipData stored in the effect params
//!
//! This approach leverages:
//! - Existing undo/redo infrastructure
//! - Existing FFmpeg drawtext filter builder
//! - Consistent state management

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    effects::{Effect, EffectType, ParamValue},
    project::ProjectState,
    text::TextClipData,
    timeline::{Clip, ClipPlace, ClipRange, TrackKind},
    ClipId, CoreError, CoreResult, EffectId, SequenceId, TimeSec, TrackId,
};

/// Virtual asset prefix for text clips.
/// Text clips use a virtual asset ID starting with this prefix.
pub const TEXT_ASSET_PREFIX: &str = "__text__";

// =============================================================================
// AddTextClipCommand
// =============================================================================

/// Command to add a text clip to a track.
///
/// Creates a new clip with a virtual text asset and applies a TextOverlay
/// effect containing the text styling data.
///
/// # Parameters
/// - `sequence_id`: The sequence to add the text to
/// - `track_id`: The track to add the text to (must be Video or Overlay)
/// - `timeline_in`: Start time on the timeline (seconds)
/// - `duration`: Duration of the text clip (seconds)
/// - `text_data`: Complete text styling and content
///
/// # Example
/// ```ignore
/// let cmd = AddTextClipCommand::new(
///     "seq-1",
///     "video-track",
///     0.0,
///     5.0,
///     TextClipData::title("Welcome"),
/// );
/// executor.execute(cmd)?;
/// ```
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTextClipCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub timeline_in: TimeSec,
    pub duration: TimeSec,
    pub text_data: TextClipData,
    /// Created clip ID for undo
    #[serde(skip)]
    created_clip_id: Option<ClipId>,
    /// Created effect ID for undo
    #[serde(skip)]
    created_effect_id: Option<EffectId>,
}

impl AddTextClipCommand {
    /// Creates a new AddTextClipCommand.
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        timeline_in: TimeSec,
        duration: TimeSec,
        text_data: TextClipData,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            timeline_in,
            duration,
            text_data,
            created_clip_id: None,
            created_effect_id: None,
        }
    }

    /// Creates a command with default text data.
    pub fn with_default_text(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        timeline_in: TimeSec,
        duration: TimeSec,
    ) -> Self {
        Self::new(
            sequence_id,
            track_id,
            timeline_in,
            duration,
            TextClipData::default(),
        )
    }

    /// Creates a title-style text command.
    pub fn title(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        timeline_in: TimeSec,
        duration: TimeSec,
        content: impl Into<String>,
    ) -> Self {
        Self::new(
            sequence_id,
            track_id,
            timeline_in,
            duration,
            TextClipData::title(content),
        )
    }

    /// Creates a lower-third style text command.
    pub fn lower_third(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        timeline_in: TimeSec,
        duration: TimeSec,
        content: impl Into<String>,
    ) -> Self {
        Self::new(
            sequence_id,
            track_id,
            timeline_in,
            duration,
            TextClipData::lower_third(content),
        )
    }
}

impl Command for AddTextClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // 1. Validate text data
        self.text_data
            .validate()
            .map_err(CoreError::ValidationError)?;

        // 2. Validate duration
        if !self.duration.is_finite() || self.duration <= 0.0 {
            return Err(CoreError::ValidationError(
                "Duration must be a positive finite number".to_string(),
            ));
        }

        // 3. Validate timeline position
        if !self.timeline_in.is_finite() || self.timeline_in < 0.0 {
            return Err(CoreError::ValidationError(
                "Timeline position must be a non-negative finite number".to_string(),
            ));
        }

        // 4. Validate sequence exists
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // 5. Validate track exists and is appropriate for text
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if !matches!(track.kind, TrackKind::Video | TrackKind::Overlay) {
            return Err(CoreError::ValidationError(
                "Text clips can only be added to Video or Overlay tracks".to_string(),
            ));
        }

        // 6. Create the virtual text asset ID
        let clip_id = ulid::Ulid::new().to_string();
        let asset_id = format!("{}{}", TEXT_ASSET_PREFIX, clip_id);

        // 7. Create the clip
        let clip = Clip {
            id: clip_id.clone(),
            asset_id,
            range: ClipRange::new(0.0, self.duration),
            place: ClipPlace::new(self.timeline_in, self.duration),
            transform: crate::core::timeline::Transform::default(),
            opacity: self.text_data.opacity as f32,
            speed: 1.0,
            effects: vec![], // Will add effect below
            audio: crate::core::timeline::AudioSettings::default(),
            label: Some(format!(
                "Text: {}",
                truncate_text(&self.text_data.content, 20)
            )),
            color: None,
        };

        // 8. Create the TextOverlay effect
        let mut effect = Effect::new(EffectType::TextOverlay);
        self.set_text_params(&mut effect);
        let effect_id = effect.id.clone();

        // 9. Add effect ID to clip's effect list
        let mut clip = clip;
        clip.effects.push(effect_id.clone());

        // 10. Store the clip in the track
        track.clips.push(clip);

        // 11. Sort clips by timeline position
        track.clips.sort_by(|a, b| {
            a.place
                .timeline_in_sec
                .total_cmp(&b.place.timeline_in_sec)
                .then_with(|| a.id.cmp(&b.id))
        });

        // 12. Store the effect in state
        state.effects.insert(effect_id.clone(), effect);

        // 13. Store created IDs for undo
        self.created_clip_id = Some(clip_id.clone());
        self.created_effect_id = Some(effect_id.clone());

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipCreated {
                clip_id: clip_id.clone(),
            })
            .with_change(StateChange::EffectAdded {
                effect_id: effect_id.clone(),
                clip_id: clip_id.clone(),
            })
            .with_created_id(&clip_id)
            .with_created_id(&effect_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Remove the effect
        if let Some(effect_id) = &self.created_effect_id {
            state.effects.remove(effect_id);
        }

        // Remove the clip
        if let Some(clip_id) = &self.created_clip_id {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.get_track_mut(&self.track_id) {
                    track.clips.retain(|c| c.id != *clip_id);
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "AddTextClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "timelineIn": self.timeline_in,
            "duration": self.duration,
            "textData": self.text_data,
        })
    }
}

impl AddTextClipCommand {
    /// Sets text data as effect parameters.
    fn set_text_params(&self, effect: &mut Effect) {
        // Content
        effect.set_param("text", ParamValue::String(self.text_data.content.clone()));

        // Style
        effect.set_param(
            "font_family",
            ParamValue::String(self.text_data.style.font_family.clone()),
        );
        effect.set_param(
            "font_size",
            ParamValue::Float(self.text_data.style.font_size as f64),
        );
        effect.set_param(
            "color",
            ParamValue::String(self.text_data.style.color.clone()),
        );
        effect.set_param(
            "background_padding",
            ParamValue::Int(self.text_data.style.background_padding as i64),
        );
        effect.set_param("bold", ParamValue::Bool(self.text_data.style.bold));
        effect.set_param("italic", ParamValue::Bool(self.text_data.style.italic));
        effect.set_param(
            "underline",
            ParamValue::Bool(self.text_data.style.underline),
        );
        effect.set_param(
            "line_height",
            ParamValue::Float(self.text_data.style.line_height),
        );
        effect.set_param(
            "letter_spacing",
            ParamValue::Int(self.text_data.style.letter_spacing as i64),
        );
        effect.set_param(
            "alignment",
            ParamValue::String(format!("{:?}", self.text_data.style.alignment).to_lowercase()),
        );

        if let Some(ref bg) = self.text_data.style.background_color {
            effect.set_param("background_color", ParamValue::String(bg.clone()));
        }

        // Position (normalized -> will be converted to pixels in filter builder)
        effect.set_param("x", ParamValue::Float(self.text_data.position.x));
        effect.set_param("y", ParamValue::Float(self.text_data.position.y));

        // Shadow
        if let Some(ref shadow) = self.text_data.shadow {
            effect.set_param("shadow_color", ParamValue::String(shadow.color.clone()));
            effect.set_param("shadow_x", ParamValue::Int(shadow.offset_x as i64));
            effect.set_param("shadow_y", ParamValue::Int(shadow.offset_y as i64));
            effect.set_param("shadow_blur", ParamValue::Int(shadow.blur as i64));
        }

        // Outline
        if let Some(ref outline) = self.text_data.outline {
            effect.set_param("outline_color", ParamValue::String(outline.color.clone()));
            effect.set_param("outline_width", ParamValue::Int(outline.width as i64));
        }

        // Other properties
        effect.set_param("rotation", ParamValue::Float(self.text_data.rotation));
        effect.set_param("opacity", ParamValue::Float(self.text_data.opacity));
    }
}

// =============================================================================
// UpdateTextCommand
// =============================================================================

/// Command to update text clip content and styling.
///
/// Updates the TextOverlay effect parameters associated with a text clip.
///
/// # Parameters
/// - `sequence_id`: The sequence containing the text clip
/// - `track_id`: The track containing the text clip
/// - `clip_id`: The text clip to update
/// - `text_data`: New text content and styling
///
/// # Example
/// ```ignore
/// let cmd = UpdateTextCommand::new(
///     "seq-1",
///     "video-track",
///     "clip-1",
///     TextClipData::new("Updated Text"),
/// );
/// executor.execute(cmd)?;
/// ```
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTextCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub text_data: TextClipData,
    /// Previous text data for undo
    #[serde(skip)]
    previous_text_data: Option<TextClipData>,
    /// Effect ID for updates
    #[serde(skip)]
    effect_id: Option<EffectId>,
}

impl UpdateTextCommand {
    /// Creates a new UpdateTextCommand.
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
        text_data: TextClipData,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            text_data,
            previous_text_data: None,
            effect_id: None,
        }
    }

    /// Updates only the content, keeping other styling.
    pub fn content_only(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        let text_data = TextClipData {
            content: content.into(),
            ..Default::default()
        };
        Self::new(sequence_id, track_id, clip_id, text_data)
    }
}

impl Command for UpdateTextCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // 1. Validate new text data
        self.text_data
            .validate()
            .map_err(CoreError::ValidationError)?;

        // 2. Find the clip
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // 3. Verify this is a text clip (has virtual text asset)
        if !clip.asset_id.starts_with(TEXT_ASSET_PREFIX) {
            return Err(CoreError::ValidationError(
                "Clip is not a text clip".to_string(),
            ));
        }

        // 4. Find the TextOverlay effect
        let effect_id = clip
            .effects
            .iter()
            .find(|id| {
                state
                    .effects
                    .get(*id)
                    .map(|e| e.effect_type == EffectType::TextOverlay)
                    .unwrap_or(false)
            })
            .cloned()
            .ok_or_else(|| {
                CoreError::NotFound("TextOverlay effect not found on clip".to_string())
            })?;

        self.effect_id = Some(effect_id.clone());

        // 5. Store previous data for undo
        if let Some(effect) = state.effects.get(&effect_id) {
            self.previous_text_data = Some(extract_text_data_from_effect(effect));
        }

        // 6. Update the effect
        if let Some(effect) = state.effects.get_mut(&effect_id) {
            set_text_params_on_effect(effect, &self.text_data);
        }

        // 7. Update clip opacity and label
        clip.opacity = self.text_data.opacity as f32;
        clip.label = Some(format!(
            "Text: {}",
            truncate_text(&self.text_data.content, 20)
        ));

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id).with_change(StateChange::EffectUpdated { effect_id }))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(effect_id) = &self.effect_id else {
            return Ok(());
        };

        let Some(previous_data) = &self.previous_text_data else {
            return Ok(());
        };

        // Restore effect parameters
        if let Some(effect) = state.effects.get_mut(effect_id) {
            set_text_params_on_effect(effect, previous_data);
        }

        // Restore clip opacity and label
        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                if let Some(clip) = track.get_clip_mut(&self.clip_id) {
                    clip.opacity = previous_data.opacity as f32;
                    clip.label = Some(format!(
                        "Text: {}",
                        truncate_text(&previous_data.content, 20)
                    ));
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateText"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "textData": self.text_data,
        })
    }
}

// =============================================================================
// RemoveTextClipCommand
// =============================================================================

/// Command to remove a text clip from a track.
///
/// Removes both the clip and its associated TextOverlay effect.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveTextClipCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Removed clip for undo
    #[serde(skip)]
    removed_clip: Option<Clip>,
    /// Removed effect for undo
    #[serde(skip)]
    removed_effect: Option<Effect>,
}

impl RemoveTextClipCommand {
    /// Creates a new RemoveTextClipCommand.
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            removed_clip: None,
            removed_effect: None,
        }
    }
}

impl Command for RemoveTextClipCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // 1. Find the clip
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // 2. Find and remove the clip
        let clip_idx = track
            .clips
            .iter()
            .position(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        let clip = track.clips.remove(clip_idx);

        // 3. Verify this is a text clip
        if !clip.asset_id.starts_with(TEXT_ASSET_PREFIX) {
            // Restore the clip - this is not a text clip
            track.clips.insert(clip_idx, clip);
            return Err(CoreError::ValidationError(
                "Clip is not a text clip".to_string(),
            ));
        }

        // 4. Store for undo
        self.removed_clip = Some(clip.clone());

        // 5. Remove the TextOverlay effect
        for effect_id in &clip.effects {
            if let Some(effect) = state.effects.get(effect_id) {
                if effect.effect_type == EffectType::TextOverlay {
                    self.removed_effect = state.effects.remove(effect_id);
                    break;
                }
            }
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::ClipDeleted {
                clip_id: self.clip_id.clone(),
            })
            .with_deleted_id(&self.clip_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        // Restore the effect first
        if let Some(effect) = &self.removed_effect {
            state.effects.insert(effect.id.clone(), effect.clone());
        }

        // Restore the clip
        if let Some(clip) = &self.removed_clip {
            if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
                if let Some(track) = sequence.get_track_mut(&self.track_id) {
                    track.clips.push(clip.clone());
                    track.clips.sort_by(|a, b| {
                        a.place
                            .timeline_in_sec
                            .total_cmp(&b.place.timeline_in_sec)
                            .then_with(|| a.id.cmp(&b.id))
                    });
                }
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveTextClip"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
        })
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Truncates text to a maximum length, adding "..." if truncated.
fn truncate_text(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        text.to_string()
    } else {
        format!("{}...", &text[..max_len.saturating_sub(3)])
    }
}

/// Sets text data parameters on an effect.
fn set_text_params_on_effect(effect: &mut Effect, text_data: &TextClipData) {
    effect.set_param("text", ParamValue::String(text_data.content.clone()));
    effect.set_param(
        "font_family",
        ParamValue::String(text_data.style.font_family.clone()),
    );
    effect.set_param(
        "font_size",
        ParamValue::Float(text_data.style.font_size as f64),
    );
    effect.set_param("color", ParamValue::String(text_data.style.color.clone()));
    effect.set_param(
        "background_padding",
        ParamValue::Int(text_data.style.background_padding as i64),
    );
    effect.set_param("bold", ParamValue::Bool(text_data.style.bold));
    effect.set_param("italic", ParamValue::Bool(text_data.style.italic));
    effect.set_param("underline", ParamValue::Bool(text_data.style.underline));
    effect.set_param(
        "line_height",
        ParamValue::Float(text_data.style.line_height),
    );
    effect.set_param(
        "letter_spacing",
        ParamValue::Int(text_data.style.letter_spacing as i64),
    );
    effect.set_param(
        "alignment",
        ParamValue::String(format!("{:?}", text_data.style.alignment).to_lowercase()),
    );

    if let Some(ref bg) = text_data.style.background_color {
        effect.set_param("background_color", ParamValue::String(bg.clone()));
    }

    effect.set_param("x", ParamValue::Float(text_data.position.x));
    effect.set_param("y", ParamValue::Float(text_data.position.y));

    if let Some(ref shadow) = text_data.shadow {
        effect.set_param("shadow_color", ParamValue::String(shadow.color.clone()));
        effect.set_param("shadow_x", ParamValue::Int(shadow.offset_x as i64));
        effect.set_param("shadow_y", ParamValue::Int(shadow.offset_y as i64));
        effect.set_param("shadow_blur", ParamValue::Int(shadow.blur as i64));
    }

    if let Some(ref outline) = text_data.outline {
        effect.set_param("outline_color", ParamValue::String(outline.color.clone()));
        effect.set_param("outline_width", ParamValue::Int(outline.width as i64));
    }

    effect.set_param("rotation", ParamValue::Float(text_data.rotation));
    effect.set_param("opacity", ParamValue::Float(text_data.opacity));
}

/// Extracts TextClipData from effect parameters.
fn extract_text_data_from_effect(effect: &Effect) -> TextClipData {
    use crate::core::text::{TextAlignment, TextOutline, TextPosition, TextShadow, TextStyle};

    let content = effect
        .get_param("text")
        .and_then(|v| v.as_str())
        .unwrap_or("Title")
        .to_string();

    let style = TextStyle {
        font_family: effect
            .get_param("font_family")
            .and_then(|v| v.as_str())
            .unwrap_or("Arial")
            .to_string(),
        font_size: effect.get_float("font_size").unwrap_or(48.0) as u32,
        color: effect
            .get_param("color")
            .and_then(|v| v.as_str())
            .unwrap_or("#FFFFFF")
            .to_string(),
        background_color: effect
            .get_param("background_color")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        background_padding: effect
            .get_param("background_padding")
            .and_then(|v| v.as_int())
            .unwrap_or(10)
            .clamp(0, 500) as u32,
        alignment: match effect
            .get_param("alignment")
            .and_then(|v| v.as_str())
            .unwrap_or("center")
        {
            "left" => TextAlignment::Left,
            "right" => TextAlignment::Right,
            _ => TextAlignment::Center,
        },
        bold: effect.get_bool("bold").unwrap_or(false),
        italic: effect.get_bool("italic").unwrap_or(false),
        underline: effect.get_bool("underline").unwrap_or(false),
        line_height: effect.get_float("line_height").unwrap_or(1.2),
        letter_spacing: effect
            .get_param("letter_spacing")
            .and_then(|v| v.as_int())
            .unwrap_or(0)
            .clamp(-500, 500) as i32,
    };

    let position = TextPosition {
        x: effect.get_float("x").unwrap_or(0.5),
        y: effect.get_float("y").unwrap_or(0.5),
    };

    let shadow = effect.get_param("shadow_color").map(|_| TextShadow {
        color: effect
            .get_param("shadow_color")
            .and_then(|v| v.as_str())
            .unwrap_or("#000000")
            .to_string(),
        offset_x: effect
            .get_param("shadow_x")
            .and_then(|v| v.as_int())
            .unwrap_or(2) as i32,
        offset_y: effect
            .get_param("shadow_y")
            .and_then(|v| v.as_int())
            .unwrap_or(2) as i32,
        blur: effect
            .get_param("shadow_blur")
            .and_then(|v| v.as_int())
            .unwrap_or(0)
            .clamp(0, 500) as u32,
    });

    let outline = effect.get_param("outline_color").map(|_| TextOutline {
        color: effect
            .get_param("outline_color")
            .and_then(|v| v.as_str())
            .unwrap_or("#000000")
            .to_string(),
        width: effect
            .get_param("outline_width")
            .and_then(|v| v.as_int())
            .unwrap_or(2) as u32,
    });

    TextClipData {
        content,
        style,
        position,
        shadow,
        outline,
        rotation: effect.get_float("rotation").unwrap_or(0.0),
        opacity: effect.get_float("opacity").unwrap_or(1.0),
    }
}

/// Checks if a clip is a text clip (has virtual text asset).
pub fn is_text_clip(clip: &Clip) -> bool {
    clip.asset_id.starts_with(TEXT_ASSET_PREFIX)
}

/// Gets the TextClipData from a text clip's effect.
pub fn get_text_data(clip: &Clip, state: &ProjectState) -> Option<TextClipData> {
    if !is_text_clip(clip) {
        return None;
    }

    for effect_id in &clip.effects {
        if let Some(effect) = state.effects.get(effect_id) {
            if effect.effect_type == EffectType::TextOverlay {
                return Some(extract_text_data_from_effect(effect));
            }
        }
    }

    None
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        text::TextClipData,
        timeline::{Sequence, SequenceFormat, Track, TrackKind},
    };

    fn create_test_state() -> ProjectState {
        let mut state = ProjectState::new_empty("Test Project");

        // Create a sequence with video and audio tracks
        let mut sequence = Sequence::new("Test Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut video_track = Track::new("Video 1", TrackKind::Video);
        video_track.id = "video-track".to_string();

        let mut overlay_track = Track::new("Overlay 1", TrackKind::Overlay);
        overlay_track.id = "overlay-track".to_string();

        let mut audio_track = Track::new("Audio 1", TrackKind::Audio);
        audio_track.id = "audio-track".to_string();

        sequence.tracks.push(video_track);
        sequence.tracks.push(overlay_track);
        sequence.tracks.push(audio_track);
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    // -------------------------------------------------------------------------
    // AddTextClipCommand Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_add_text_clip_to_video_track() {
        let mut state = create_test_state();
        let mut cmd = AddTextClipCommand::new(
            "seq-1",
            "video-track",
            0.0,
            5.0,
            TextClipData::new("Hello World"),
        );

        let result = cmd.execute(&mut state);
        assert!(result.is_ok(), "Expected success, got {:?}", result);

        let result = result.unwrap();
        assert_eq!(result.created_ids.len(), 2); // clip + effect

        // Verify clip was added
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        assert_eq!(track.clips.len(), 1);

        let clip = &track.clips[0];
        assert!(clip.asset_id.starts_with(TEXT_ASSET_PREFIX));
        assert_eq!(clip.place.timeline_in_sec, 0.0);
        assert_eq!(clip.place.duration_sec, 5.0);
        assert!(clip.label.as_ref().unwrap().contains("Hello World"));

        // Verify effect was created
        assert_eq!(state.effects.len(), 1);
        let effect_id = &clip.effects[0];
        let effect = state.effects.get(effect_id).unwrap();
        assert_eq!(effect.effect_type, EffectType::TextOverlay);
        assert_eq!(
            effect.get_param("text").and_then(|v| v.as_str()),
            Some("Hello World")
        );
    }

    #[test]
    fn test_add_text_clip_to_overlay_track() {
        let mut state = create_test_state();
        let mut cmd = AddTextClipCommand::new(
            "seq-1",
            "overlay-track",
            2.0,
            3.0,
            TextClipData::title("Title"),
        );

        let result = cmd.execute(&mut state);
        assert!(result.is_ok());

        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("overlay-track").unwrap();
        assert_eq!(track.clips.len(), 1);
    }

    #[test]
    fn test_add_text_clip_fails_on_audio_track() {
        let mut state = create_test_state();
        let mut cmd =
            AddTextClipCommand::new("seq-1", "audio-track", 0.0, 5.0, TextClipData::default());

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("Video or Overlay"),
            "Expected track type error, got: {}",
            err
        );
    }

    #[test]
    fn test_add_text_clip_fails_with_invalid_duration() {
        let mut state = create_test_state();

        // Test zero duration
        let mut cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, 0.0, TextClipData::default());
        assert!(cmd.execute(&mut state).is_err());

        // Test negative duration
        let mut cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, -1.0, TextClipData::default());
        assert!(cmd.execute(&mut state).is_err());

        // Test NaN duration
        let mut cmd = AddTextClipCommand::new(
            "seq-1",
            "video-track",
            0.0,
            f64::NAN,
            TextClipData::default(),
        );
        assert!(cmd.execute(&mut state).is_err());
    }

    #[test]
    fn test_add_text_clip_fails_with_invalid_timeline_in() {
        let mut state = create_test_state();

        // Test negative timeline position
        let mut cmd =
            AddTextClipCommand::new("seq-1", "video-track", -1.0, 5.0, TextClipData::default());
        assert!(cmd.execute(&mut state).is_err());
    }

    #[test]
    fn test_add_text_clip_fails_with_invalid_text() {
        let mut state = create_test_state();

        // Test empty content
        let mut cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, 5.0, TextClipData::new(""));
        assert!(cmd.execute(&mut state).is_err());
    }

    #[test]
    fn test_add_text_clip_fails_with_invalid_sequence() {
        let mut state = create_test_state();
        let mut cmd = AddTextClipCommand::new(
            "invalid-seq",
            "video-track",
            0.0,
            5.0,
            TextClipData::default(),
        );

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_text_clip_fails_with_invalid_track() {
        let mut state = create_test_state();
        let mut cmd =
            AddTextClipCommand::new("seq-1", "invalid-track", 0.0, 5.0, TextClipData::default());

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_text_clip_undo() {
        let mut state = create_test_state();
        let mut cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, 5.0, TextClipData::new("Test"));

        cmd.execute(&mut state).unwrap();

        // Verify clip and effect exist
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        assert_eq!(track.clips.len(), 1);
        assert_eq!(state.effects.len(), 1);

        // Undo
        cmd.undo(&mut state).unwrap();

        // Verify clip and effect are removed
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        assert_eq!(track.clips.len(), 0);
        assert_eq!(state.effects.len(), 0);
    }

    #[test]
    fn test_add_text_clip_with_full_styling() {
        use crate::core::text::{TextOutline, TextShadow, TextStyle};

        let mut state = create_test_state();
        let text_data = TextClipData {
            content: "Styled Text".to_string(),
            style: TextStyle {
                font_family: "Helvetica".to_string(),
                font_size: 72,
                color: "#FF0000".to_string(),
                bold: true,
                italic: true,
                ..Default::default()
            },
            shadow: Some(TextShadow::default()),
            outline: Some(TextOutline::default()),
            rotation: 15.0,
            opacity: 0.8,
            ..Default::default()
        };

        let mut cmd = AddTextClipCommand::new("seq-1", "video-track", 0.0, 5.0, text_data);
        cmd.execute(&mut state).unwrap();

        // Verify effect has all parameters
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        let clip = &track.clips[0];
        let effect = state.effects.get(&clip.effects[0]).unwrap();

        assert_eq!(
            effect.get_param("font_family").and_then(|v| v.as_str()),
            Some("Helvetica")
        );
        assert_eq!(effect.get_float("font_size"), Some(72.0));
        assert_eq!(
            effect.get_param("color").and_then(|v| v.as_str()),
            Some("#FF0000")
        );
        assert_eq!(effect.get_bool("bold"), Some(true));
        assert_eq!(effect.get_bool("italic"), Some(true));
        assert!(effect.get_param("shadow_color").is_some());
        assert!(effect.get_param("outline_color").is_some());
        assert_eq!(effect.get_float("rotation"), Some(15.0));
        assert_eq!(effect.get_float("opacity"), Some(0.8));
    }

    // -------------------------------------------------------------------------
    // UpdateTextCommand Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_update_text_content() {
        let mut state = create_test_state();

        // First add a text clip
        let mut add_cmd = AddTextClipCommand::new(
            "seq-1",
            "video-track",
            0.0,
            5.0,
            TextClipData::new("Original"),
        );
        add_cmd.execute(&mut state).unwrap();

        let clip_id = add_cmd.created_clip_id.clone().unwrap();

        // Update the text
        let mut update_cmd = UpdateTextCommand::new(
            "seq-1",
            "video-track",
            &clip_id,
            TextClipData::new("Updated"),
        );
        update_cmd.execute(&mut state).unwrap();

        // Verify update
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        let clip = track.get_clip(&clip_id).unwrap();
        let effect = state.effects.get(&clip.effects[0]).unwrap();

        assert_eq!(
            effect.get_param("text").and_then(|v| v.as_str()),
            Some("Updated")
        );
    }

    #[test]
    fn test_update_text_fails_on_non_text_clip() {
        let mut state = create_test_state();

        // Add a regular clip (not a text clip)
        let regular_clip = Clip::new("regular-asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        let clip_id = regular_clip.id.clone();

        let sequence = state.get_sequence_mut("seq-1").unwrap();
        let track = sequence.get_track_mut("video-track").unwrap();
        track.clips.push(regular_clip);

        // Try to update as text
        let mut update_cmd =
            UpdateTextCommand::new("seq-1", "video-track", &clip_id, TextClipData::new("Text"));
        let result = update_cmd.execute(&mut state);

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not a text clip"));
    }

    #[test]
    fn test_update_text_undo() {
        let mut state = create_test_state();

        // Add a text clip
        let mut add_cmd = AddTextClipCommand::new(
            "seq-1",
            "video-track",
            0.0,
            5.0,
            TextClipData::new("Original"),
        );
        add_cmd.execute(&mut state).unwrap();
        let clip_id = add_cmd.created_clip_id.clone().unwrap();

        // Update the text
        let mut update_cmd = UpdateTextCommand::new(
            "seq-1",
            "video-track",
            &clip_id,
            TextClipData::new("Updated"),
        );
        update_cmd.execute(&mut state).unwrap();

        // Undo
        update_cmd.undo(&mut state).unwrap();

        // Verify original content is restored
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        let clip = track.get_clip(&clip_id).unwrap();
        let effect = state.effects.get(&clip.effects[0]).unwrap();

        assert_eq!(
            effect.get_param("text").and_then(|v| v.as_str()),
            Some("Original")
        );
    }

    // -------------------------------------------------------------------------
    // RemoveTextClipCommand Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_remove_text_clip() {
        let mut state = create_test_state();

        // Add a text clip
        let mut add_cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, 5.0, TextClipData::new("Test"));
        add_cmd.execute(&mut state).unwrap();
        let clip_id = add_cmd.created_clip_id.clone().unwrap();

        // Verify clip exists
        assert_eq!(
            state
                .get_sequence("seq-1")
                .unwrap()
                .get_track("video-track")
                .unwrap()
                .clips
                .len(),
            1
        );
        assert_eq!(state.effects.len(), 1);

        // Remove the clip
        let mut remove_cmd = RemoveTextClipCommand::new("seq-1", "video-track", &clip_id);
        remove_cmd.execute(&mut state).unwrap();

        // Verify clip and effect are removed
        assert_eq!(
            state
                .get_sequence("seq-1")
                .unwrap()
                .get_track("video-track")
                .unwrap()
                .clips
                .len(),
            0
        );
        assert_eq!(state.effects.len(), 0);
    }

    #[test]
    fn test_remove_text_clip_fails_on_non_text_clip() {
        let mut state = create_test_state();

        // Add a regular clip
        let regular_clip = Clip::new("regular-asset")
            .with_source_range(0.0, 10.0)
            .place_at(0.0);
        let clip_id = regular_clip.id.clone();

        let sequence = state.get_sequence_mut("seq-1").unwrap();
        let track = sequence.get_track_mut("video-track").unwrap();
        track.clips.push(regular_clip);

        // Try to remove as text clip
        let mut remove_cmd = RemoveTextClipCommand::new("seq-1", "video-track", &clip_id);
        let result = remove_cmd.execute(&mut state);

        assert!(result.is_err());
        // Clip should still exist
        assert_eq!(
            state
                .get_sequence("seq-1")
                .unwrap()
                .get_track("video-track")
                .unwrap()
                .clips
                .len(),
            1
        );
    }

    #[test]
    fn test_remove_text_clip_undo() {
        let mut state = create_test_state();

        // Add a text clip
        let mut add_cmd =
            AddTextClipCommand::new("seq-1", "video-track", 0.0, 5.0, TextClipData::new("Test"));
        add_cmd.execute(&mut state).unwrap();
        let clip_id = add_cmd.created_clip_id.clone().unwrap();

        // Remove the clip
        let mut remove_cmd = RemoveTextClipCommand::new("seq-1", "video-track", &clip_id);
        remove_cmd.execute(&mut state).unwrap();

        // Undo
        remove_cmd.undo(&mut state).unwrap();

        // Verify clip and effect are restored
        assert_eq!(
            state
                .get_sequence("seq-1")
                .unwrap()
                .get_track("video-track")
                .unwrap()
                .clips
                .len(),
            1
        );
        assert_eq!(state.effects.len(), 1);
    }

    // -------------------------------------------------------------------------
    // Helper Function Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_is_text_clip() {
        let text_clip = Clip::new(&format!("{}12345", TEXT_ASSET_PREFIX));
        assert!(is_text_clip(&text_clip));

        let regular_clip = Clip::new("regular-asset");
        assert!(!is_text_clip(&regular_clip));
    }

    #[test]
    fn test_truncate_text() {
        assert_eq!(truncate_text("short", 10), "short");
        assert_eq!(truncate_text("this is a long text", 10), "this is...");
        assert_eq!(truncate_text("exactly10.", 10), "exactly10.");
    }

    #[test]
    fn test_get_text_data() {
        let mut state = create_test_state();

        // Add a text clip
        let mut add_cmd = AddTextClipCommand::new(
            "seq-1",
            "video-track",
            0.0,
            5.0,
            TextClipData::new("Test Content"),
        );
        add_cmd.execute(&mut state).unwrap();
        let clip_id = add_cmd.created_clip_id.clone().unwrap();

        // Get clip and extract text data
        let sequence = state.get_sequence("seq-1").unwrap();
        let track = sequence.get_track("video-track").unwrap();
        let clip = track.get_clip(&clip_id).unwrap();

        let text_data = get_text_data(clip, &state);
        assert!(text_data.is_some());
        assert_eq!(text_data.unwrap().content, "Test Content");
    }

    #[test]
    fn test_get_text_data_returns_none_for_non_text_clip() {
        let state = create_test_state();
        let regular_clip = Clip::new("regular-asset");

        let text_data = get_text_data(&regular_clip, &state);
        assert!(text_data.is_none());
    }
}
