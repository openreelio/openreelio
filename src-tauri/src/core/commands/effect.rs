//! Effect Commands Module
//!
//! Implements effect editing commands for the event sourcing system.
//! Effects can be added to clips to apply video/audio transformations.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    effects::{Effect, EffectType, Keyframe, ParamValue},
    project::ProjectState,
    timeline::{AudioSettings, BlendMode, Transform},
    ClipId, CoreError, CoreResult, EffectId, SequenceId, TrackId,
};

fn validate_target_clips(
    sequence: &crate::core::timeline::Sequence,
    target_clips: &[(TrackId, ClipId)],
) -> CoreResult<()> {
    for (track_id, clip_id) in target_clips {
        let track = sequence
            .tracks
            .iter()
            .find(|candidate| &candidate.id == track_id)
            .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                track_id
            )));
        }

        if !track.clips.iter().any(|clip| &clip.id == clip_id) {
            return Err(CoreError::ClipNotFound(clip_id.clone()));
        }
    }

    Ok(())
}

fn deserialize_source_effects(source_effects: &[serde_json::Value]) -> CoreResult<Vec<Effect>> {
    source_effects
        .iter()
        .map(|source_effect| {
            serde_json::from_value(source_effect.clone())
                .map_err(|e| CoreError::InvalidCommand(format!("Invalid effect data: {e}")))
        })
        .collect()
}

// =============================================================================
// AddEffectCommand
// =============================================================================

/// Command to add an effect to a clip.
///
/// # Parameters
/// - `sequence_id`: The sequence containing the clip
/// - `track_id`: The track containing the clip
/// - `clip_id`: The clip to add the effect to
/// - `effect_type`: The type of effect to add
/// - `params`: Optional initial parameters for the effect
///
/// # Example
/// ```ignore
/// let cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
///     .with_param("radius", ParamValue::Float(10.0));
/// executor.execute(cmd)?;
/// ```
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddEffectCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_type: EffectType,
    #[serde(default)]
    pub params: std::collections::HashMap<String, ParamValue>,
    #[serde(default)]
    pub keyframes: std::collections::HashMap<String, Vec<Keyframe>>,
    /// Position in the effect list (None = append at end)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<usize>,
    #[serde(skip)]
    created_effect_id: Option<EffectId>,
}

impl AddEffectCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
        effect_type: EffectType,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            effect_type,
            params: std::collections::HashMap::new(),
            keyframes: std::collections::HashMap::new(),
            position: None,
            created_effect_id: None,
        }
    }

    /// Add a parameter value to the effect
    pub fn with_param(mut self, name: impl Into<String>, value: ParamValue) -> Self {
        self.params.insert(name.into(), value);
        self
    }

    /// Set keyframes for an animatable parameter.
    pub fn with_keyframes(mut self, name: impl Into<String>, keyframes: Vec<Keyframe>) -> Self {
        self.keyframes.insert(name.into(), keyframes);
        self
    }

    /// Set the position where the effect should be inserted
    pub fn at_position(mut self, position: usize) -> Self {
        self.position = Some(position);
        self
    }
}

impl Command for AddEffectCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate sequence exists
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Find the track
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // Find the clip
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Create the effect
        let mut effect = Effect::new(self.effect_type.clone());
        for (key, value) in &self.params {
            effect.set_param(key, value.clone());
        }
        effect.keyframes = self.keyframes.clone();

        let effect_id = effect.id.clone();
        self.created_effect_id = Some(effect_id.clone());

        // Add effect to clip's effect list
        match self.position {
            Some(pos) if pos < clip.effects.len() => {
                clip.effects.insert(pos, effect_id.clone());
            }
            _ => {
                clip.effects.push(effect_id.clone());
            }
        }

        // Store effect in state's effect registry
        state.effects.insert(effect_id.clone(), effect);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::EffectAdded {
                effect_id: effect_id.clone(),
                clip_id: self.clip_id.clone(),
            })
            .with_created_id(&effect_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(effect_id) = self.created_effect_id.as_deref() else {
            return Ok(());
        };

        // Remove from clip's effect list
        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                if let Some(clip) = track.get_clip_mut(&self.clip_id) {
                    clip.effects.retain(|id| id != effect_id);
                }
            }
        }

        // Remove from state's effect registry
        state.effects.remove(effect_id);

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "AddEffect"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id.clone(),
            "trackId": self.track_id.clone(),
            "clipId": self.clip_id.clone(),
            "effectType": self.effect_type.clone(),
            "params": self.params.clone(),
            "keyframes": self.keyframes.clone(),
            "position": self.position,
        })
    }
}

// =============================================================================
// RemoveEffectCommand
// =============================================================================

/// Command to remove an effect from a clip.
///
/// # Parameters
/// - `sequence_id`: The sequence containing the clip
/// - `track_id`: The track containing the clip
/// - `clip_id`: The clip to remove the effect from
/// - `effect_id`: The ID of the effect to remove
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveEffectCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_id: EffectId,
    #[serde(skip)]
    removed_effect: Option<Effect>,
    #[serde(skip)]
    original_position: Option<usize>,
}

impl RemoveEffectCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
        effect_id: impl Into<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            effect_id: effect_id.into(),
            removed_effect: None,
            original_position: None,
        }
    }
}

impl Command for RemoveEffectCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate sequence exists
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        // Find the track
        let track = sequence
            .get_track_mut(&self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        // Find the clip
        let clip = track
            .get_clip_mut(&self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Find and store original position
        let position = clip
            .effects
            .iter()
            .position(|id| id == &self.effect_id)
            .ok_or_else(|| {
                CoreError::NotFound(format!(
                    "Effect {} not found in clip {}",
                    self.effect_id, self.clip_id
                ))
            })?;

        self.original_position = Some(position);

        // Remove from clip's effect list
        clip.effects.remove(position);

        // Remove from state's effect registry and store for undo
        self.removed_effect = state.effects.remove(&self.effect_id);

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::EffectRemoved {
                effect_id: self.effect_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(effect) = self.removed_effect.clone() else {
            return Ok(());
        };

        let Some(position) = self.original_position else {
            return Ok(());
        };

        // Restore to clip's effect list at the exact original position.
        // The position was captured at the time of removal and represents the
        // index where the effect resided. We must restore to this exact position
        // to maintain effect ordering integrity after undo.
        if let Some(sequence) = state.sequences.get_mut(&self.sequence_id) {
            if let Some(track) = sequence.get_track_mut(&self.track_id) {
                if let Some(clip) = track.get_clip_mut(&self.clip_id) {
                    // Clamp position to current effects length to handle edge cases
                    // where other effects may have been removed during undo chain.
                    let insert_pos = position.min(clip.effects.len());
                    clip.effects.insert(insert_pos, self.effect_id.clone());
                }
            }
        }

        // Restore to state's effect registry
        state.effects.insert(self.effect_id.clone(), effect);

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveEffect"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id.clone(),
            "trackId": self.track_id.clone(),
            "clipId": self.clip_id.clone(),
            "effectId": self.effect_id.clone(),
        })
    }
}

// =============================================================================
// UpdateEffectCommand
// =============================================================================

/// Command to update effect parameters.
///
/// # Parameters
/// - `effect_id`: The ID of the effect to update
/// - `params`: Map of parameter names to new values
/// - `enabled`: Optional - toggle effect enabled state
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEffectCommand {
    pub effect_id: EffectId,
    #[serde(default)]
    pub params: std::collections::HashMap<String, ParamValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip)]
    previous_params: std::collections::HashMap<String, ParamValue>,
    #[serde(skip)]
    previous_enabled: Option<bool>,
}

impl UpdateEffectCommand {
    pub fn new(effect_id: impl Into<String>) -> Self {
        Self {
            effect_id: effect_id.into(),
            params: std::collections::HashMap::new(),
            enabled: None,
            previous_params: std::collections::HashMap::new(),
            previous_enabled: None,
        }
    }

    /// Set a parameter value
    pub fn with_param(mut self, name: impl Into<String>, value: ParamValue) -> Self {
        self.params.insert(name.into(), value);
        self
    }

    /// Toggle the effect's enabled state
    pub fn set_enabled(mut self, enabled: bool) -> Self {
        self.enabled = Some(enabled);
        self
    }
}

impl Command for UpdateEffectCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let effect = state
            .effects
            .get_mut(&self.effect_id)
            .ok_or_else(|| CoreError::NotFound(format!("Effect not found: {}", self.effect_id)))?;

        // Store previous values for undo
        for key in self.params.keys() {
            if let Some(prev) = effect.get_param(key) {
                self.previous_params.insert(key.clone(), prev.clone());
            }
        }

        if self.enabled.is_some() {
            self.previous_enabled = Some(effect.enabled);
        }

        // Apply new parameter values
        for (key, value) in &self.params {
            effect.set_param(key, value.clone());
        }

        // Apply enabled state if specified
        if let Some(enabled) = self.enabled {
            effect.enabled = enabled;
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::EffectUpdated {
                effect_id: self.effect_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(effect) = state.effects.get_mut(&self.effect_id) else {
            return Ok(());
        };

        // Restore previous parameter values
        for (key, value) in &self.previous_params {
            effect.set_param(key, value.clone());
        }

        // Restore enabled state
        if let Some(enabled) = self.previous_enabled {
            effect.enabled = enabled;
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "UpdateEffect"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "effectId": self.effect_id.clone(),
            "params": self.params.clone(),
            "enabled": self.enabled,
        })
    }
}

// =============================================================================
// PasteEffectsCommand
// =============================================================================

/// Command to paste all copied effects onto one or more target clips.
///
/// Each source effect is deep-cloned with a new unique ID.
/// This is the "paste all" operation — for selective paste, use PasteAttributesCommand.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteEffectsCommand {
    pub sequence_id: SequenceId,
    /// Target clips to receive the pasted effects
    pub target_clips: Vec<(TrackId, ClipId)>,
    /// Serialized source effects (from copy_clip_effects IPC)
    pub source_effects: Vec<serde_json::Value>,
    /// IDs of effects created during execute (for undo)
    #[serde(skip)]
    created_effect_ids: Vec<(TrackId, ClipId, Vec<EffectId>)>,
}

impl PasteEffectsCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        target_clips: Vec<(String, String)>,
        source_effects: Vec<serde_json::Value>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            target_clips,
            source_effects,
            created_effect_ids: Vec::new(),
        }
    }
}

impl Command for PasteEffectsCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let source_effects = deserialize_source_effects(&self.source_effects)?;
        {
            let sequence = state
                .sequences
                .get(&self.sequence_id)
                .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
            validate_target_clips(sequence, &self.target_clips)?;
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let mut all_created: Vec<(TrackId, ClipId, Vec<EffectId>)> = Vec::new();

        for (track_id, clip_id) in &self.target_clips {
            let track = sequence
                .tracks
                .iter_mut()
                .find(|t| &t.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;

            let clip = track
                .clips
                .iter_mut()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;

            let mut ids_for_clip = Vec::new();

            for src_effect in &source_effects {
                // Create new effect instance with fresh ID
                let mut new_effect = Effect::new(src_effect.effect_type.clone());
                new_effect.enabled = src_effect.enabled;
                new_effect.params = src_effect.params.clone();
                new_effect.keyframes = src_effect.keyframes.clone();
                new_effect.order = src_effect.order;
                new_effect.masks = src_effect.masks.clone();

                let new_id = new_effect.id.clone();
                clip.effects.push(new_id.clone());
                state.effects.insert(new_id.clone(), new_effect);
                ids_for_clip.push(new_id);
            }

            all_created.push((track_id.clone(), clip_id.clone(), ids_for_clip));
        }

        self.created_effect_ids = all_created;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for (_, clip_id, ids) in &self.created_effect_ids {
            for id in ids {
                result = result
                    .with_created_id(id)
                    .with_change(StateChange::EffectAdded {
                        effect_id: id.clone(),
                        clip_id: clip_id.clone(),
                    });
            }
        }
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        for (track_id, clip_id, effect_ids) in &self.created_effect_ids {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| &t.id == track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| &c.id == clip_id) {
                    clip.effects.retain(|id| !effect_ids.contains(id));
                }
            }
            for eid in effect_ids {
                state.effects.remove(eid);
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "PasteEffects"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "targetClips": self.target_clips.iter().map(|(t, c)|
                serde_json::json!({"trackId": t, "clipId": c})
            ).collect::<Vec<_>>(),
            "sourceEffectCount": self.source_effects.len(),
        })
    }
}

// =============================================================================
// PasteAttributesCommand
// =============================================================================

/// Flags indicating which attributes to paste from the clipboard.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeSelection {
    /// Indices of effects in the source list to paste (empty = no effects)
    #[serde(default)]
    pub effect_indices: Vec<usize>,
    /// Whether to paste transform (position, scale, rotation)
    #[serde(default)]
    pub transform: bool,
    /// Whether to paste opacity
    #[serde(default)]
    pub opacity: bool,
    /// Whether to paste blend mode
    #[serde(default)]
    pub blend_mode: bool,
    /// Whether to paste speed/reverse
    #[serde(default)]
    pub speed: bool,
    /// Whether to paste audio settings (volume, pan, fades)
    #[serde(default)]
    pub audio_settings: bool,
}

/// Serialized clip attributes for paste operations.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAttributeValues {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverse: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<serde_json::Value>,
}

/// Command to selectively paste effects and/or attributes from clipboard to clips.
///
/// Unlike PasteEffectsCommand which pastes all effects, this command allows the user
/// to select which effects and attributes to paste through a dialog.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteAttributesCommand {
    pub sequence_id: SequenceId,
    pub target_clips: Vec<(TrackId, ClipId)>,
    /// All source effects (full serialized data from copy_clip_effects)
    pub source_effects: Vec<serde_json::Value>,
    /// Source clip attributes (from copy_clip_effects)
    pub source_attributes: ClipAttributeValues,
    /// What to paste
    pub selection: AttributeSelection,
    /// Previous state for undo
    #[serde(skip)]
    previous_state: Vec<PasteUndoEntry>,
}

/// Undo state for a single clip in PasteAttributesCommand
#[derive(Clone, Debug)]
struct PasteUndoEntry {
    track_id: TrackId,
    clip_id: ClipId,
    created_effect_ids: Vec<EffectId>,
    prev_transform: Option<Transform>,
    prev_opacity: Option<f32>,
    prev_blend_mode: Option<BlendMode>,
    prev_speed: Option<f32>,
    prev_reverse: Option<bool>,
    prev_audio: Option<AudioSettings>,
}

impl PasteAttributesCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        target_clips: Vec<(String, String)>,
        source_effects: Vec<serde_json::Value>,
        source_attributes: ClipAttributeValues,
        selection: AttributeSelection,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            target_clips,
            source_effects,
            source_attributes,
            selection,
            previous_state: Vec::new(),
        }
    }
}

impl Command for PasteAttributesCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let selected_source_effects: Vec<Effect> = self
            .selection
            .effect_indices
            .iter()
            .map(|&index| {
                let source_effect = self.source_effects.get(index).ok_or_else(|| {
                    CoreError::ValidationError(format!(
                        "Selected effect index '{}' is out of range",
                        index
                    ))
                })?;

                serde_json::from_value(source_effect.clone())
                    .map_err(|e| CoreError::InvalidCommand(format!("Invalid effect data: {e}")))
            })
            .collect::<CoreResult<Vec<_>>>()?;

        {
            let sequence = state
                .sequences
                .get(&self.sequence_id)
                .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;
            validate_target_clips(sequence, &self.target_clips)?;
        }

        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let mut undo_entries: Vec<PasteUndoEntry> = Vec::new();

        for (track_id, clip_id) in &self.target_clips {
            let track = sequence
                .tracks
                .iter_mut()
                .find(|t| &t.id == track_id)
                .ok_or_else(|| CoreError::TrackNotFound(track_id.clone()))?;

            let clip = track
                .clips
                .iter_mut()
                .find(|c| &c.id == clip_id)
                .ok_or_else(|| CoreError::ClipNotFound(clip_id.clone()))?;

            let mut entry = PasteUndoEntry {
                track_id: track_id.clone(),
                clip_id: clip_id.clone(),
                created_effect_ids: Vec::new(),
                prev_transform: None,
                prev_opacity: None,
                prev_blend_mode: None,
                prev_speed: None,
                prev_reverse: None,
                prev_audio: None,
            };

            // Paste selected effects
            for src_effect in &selected_source_effects {
                let mut new_effect = Effect::new(src_effect.effect_type.clone());
                new_effect.enabled = src_effect.enabled;
                new_effect.params = src_effect.params.clone();
                new_effect.keyframes = src_effect.keyframes.clone();
                new_effect.order = src_effect.order;
                new_effect.masks = src_effect.masks.clone();

                let new_id = new_effect.id.clone();
                clip.effects.push(new_id.clone());
                state.effects.insert(new_id.clone(), new_effect);
                entry.created_effect_ids.push(new_id);
            }

            // Paste selected attributes
            if self.selection.transform {
                if let Some(ref t_val) = self.source_attributes.transform {
                    match serde_json::from_value::<Transform>(t_val.clone()) {
                        Ok(t) => {
                            entry.prev_transform = Some(clip.transform.clone());
                            clip.transform = t;
                        }
                        Err(e) => {
                            tracing::warn!("Failed to deserialize transform attribute: {}", e);
                        }
                    }
                }
            }
            if self.selection.opacity {
                if let Some(o) = self.source_attributes.opacity {
                    entry.prev_opacity = Some(clip.opacity);
                    clip.opacity = o;
                }
            }
            if self.selection.blend_mode {
                if let Some(ref bm_val) = self.source_attributes.blend_mode {
                    match serde_json::from_value::<BlendMode>(bm_val.clone()) {
                        Ok(bm) => {
                            entry.prev_blend_mode = Some(clip.blend_mode.clone());
                            clip.blend_mode = bm;
                        }
                        Err(e) => {
                            tracing::warn!("Failed to deserialize blend_mode attribute: {}", e);
                        }
                    }
                }
            }
            if self.selection.speed {
                if let Some(s) = self.source_attributes.speed {
                    entry.prev_speed = Some(clip.speed);
                    clip.speed = s;
                }
                if let Some(r) = self.source_attributes.reverse {
                    entry.prev_reverse = Some(clip.reverse);
                    clip.reverse = r;
                }
            }
            if self.selection.audio_settings {
                if let Some(ref a_val) = self.source_attributes.audio {
                    match serde_json::from_value::<AudioSettings>(a_val.clone()) {
                        Ok(a) => {
                            entry.prev_audio = Some(clip.audio.clone());
                            clip.audio = a;
                        }
                        Err(e) => {
                            tracing::warn!("Failed to deserialize audio attribute: {}", e);
                        }
                    }
                }
            }

            undo_entries.push(entry);
        }

        self.previous_state = undo_entries;

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for entry in &self.previous_state {
            for id in &entry.created_effect_ids {
                result = result
                    .with_created_id(id)
                    .with_change(StateChange::EffectAdded {
                        effect_id: id.clone(),
                        clip_id: entry.clip_id.clone(),
                    });
            }
            if entry.prev_transform.is_some()
                || entry.prev_opacity.is_some()
                || entry.prev_blend_mode.is_some()
                || entry.prev_speed.is_some()
                || entry.prev_reverse.is_some()
                || entry.prev_audio.is_some()
            {
                result = result.with_change(StateChange::ClipModified {
                    clip_id: entry.clip_id.clone(),
                });
            }
        }
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };

        for entry in &self.previous_state {
            if let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == entry.track_id) {
                if let Some(clip) = track.clips.iter_mut().find(|c| c.id == entry.clip_id) {
                    // Remove pasted effects
                    clip.effects
                        .retain(|id| !entry.created_effect_ids.contains(id));

                    // Restore attributes
                    if let Some(ref t) = entry.prev_transform {
                        clip.transform = t.clone();
                    }
                    if let Some(o) = entry.prev_opacity {
                        clip.opacity = o;
                    }
                    if let Some(ref bm) = entry.prev_blend_mode {
                        clip.blend_mode = bm.clone();
                    }
                    if let Some(s) = entry.prev_speed {
                        clip.speed = s;
                    }
                    if let Some(r) = entry.prev_reverse {
                        clip.reverse = r;
                    }
                    if let Some(ref a) = entry.prev_audio {
                        clip.audio = a.clone();
                    }
                }
            }

            for eid in &entry.created_effect_ids {
                state.effects.remove(eid);
            }
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "PasteAttributes"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "targetClips": self.target_clips.iter().map(|(t, c)|
                serde_json::json!({"trackId": t, "clipId": c})
            ).collect::<Vec<_>>(),
            "selection": serde_json::to_value(&self.selection).unwrap_or_default(),
        })
    }
}

// =============================================================================
// RemoveAttributesCommand
// =============================================================================

/// Command to selectively remove effects and/or reset attributes on a clip.
///
/// Mirrors PasteAttributes — the dialog shows all current effects and attributes,
/// and the user selects which to remove/reset.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAttributesCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    /// Effect IDs to remove from the clip
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
    /// Previous state for undo
    #[serde(skip)]
    removed_effects: Vec<(EffectId, usize, Effect)>,
    #[serde(skip)]
    prev_transform: Option<Transform>,
    #[serde(skip)]
    prev_opacity: Option<f32>,
    #[serde(skip)]
    prev_blend_mode: Option<BlendMode>,
    #[serde(skip)]
    prev_speed: Option<f32>,
    #[serde(skip)]
    prev_reverse: Option<bool>,
    #[serde(skip)]
    prev_audio: Option<AudioSettings>,
}

impl RemoveAttributesCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            effect_ids: Vec::new(),
            reset_transform: false,
            reset_opacity: false,
            reset_blend_mode: false,
            reset_speed: false,
            reset_audio: false,
            removed_effects: Vec::new(),
            prev_transform: None,
            prev_opacity: None,
            prev_blend_mode: None,
            prev_speed: None,
            prev_reverse: None,
            prev_audio: None,
        }
    }

    pub fn with_effect_ids(mut self, ids: Vec<String>) -> Self {
        self.effect_ids = ids;
        self
    }

    pub fn with_reset_transform(mut self, v: bool) -> Self {
        self.reset_transform = v;
        self
    }

    pub fn with_reset_opacity(mut self, v: bool) -> Self {
        self.reset_opacity = v;
        self
    }

    pub fn with_reset_blend_mode(mut self, v: bool) -> Self {
        self.reset_blend_mode = v;
        self
    }

    pub fn with_reset_speed(mut self, v: bool) -> Self {
        self.reset_speed = v;
        self
    }

    pub fn with_reset_audio(mut self, v: bool) -> Self {
        self.reset_audio = v;
        self
    }
}

impl Command for RemoveAttributesCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        let sequence = state
            .sequences
            .get_mut(&self.sequence_id)
            .ok_or_else(|| CoreError::SequenceNotFound(self.sequence_id.clone()))?;

        let track = sequence
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| CoreError::TrackNotFound(self.track_id.clone()))?;

        if track.locked {
            return Err(CoreError::ValidationError(format!(
                "Track '{}' is locked",
                self.track_id
            )));
        }

        let clip = track
            .clips
            .iter_mut()
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| CoreError::ClipNotFound(self.clip_id.clone()))?;

        // Remove specified effects (capture position and data for undo)
        let mut removed = Vec::new();
        for eid in &self.effect_ids {
            if let Some(pos) = clip.effects.iter().position(|id| id == eid) {
                clip.effects.remove(pos);
                if let Some(effect) = state.effects.remove(eid) {
                    removed.push((eid.clone(), pos, effect));
                }
            }
        }
        self.removed_effects = removed;

        // Reset attributes to defaults
        if self.reset_transform {
            self.prev_transform = Some(clip.transform.clone());
            clip.transform = Transform::default();
        }
        if self.reset_opacity {
            self.prev_opacity = Some(clip.opacity);
            clip.opacity = 1.0;
        }
        if self.reset_blend_mode {
            self.prev_blend_mode = Some(clip.blend_mode.clone());
            clip.blend_mode = BlendMode::default();
        }
        if self.reset_speed {
            self.prev_speed = Some(clip.speed);
            self.prev_reverse = Some(clip.reverse);
            clip.speed = 1.0;
            clip.reverse = false;
        }
        if self.reset_audio {
            self.prev_audio = Some(clip.audio.clone());
            clip.audio = AudioSettings::default();
        }

        let op_id = ulid::Ulid::new().to_string();
        let mut result = CommandResult::new(&op_id);
        for (eid, _, _) in &self.removed_effects {
            result = result.with_change(StateChange::EffectRemoved {
                effect_id: eid.clone(),
            });
        }
        if self.prev_transform.is_some()
            || self.prev_opacity.is_some()
            || self.prev_blend_mode.is_some()
            || self.prev_speed.is_some()
            || self.prev_reverse.is_some()
            || self.prev_audio.is_some()
        {
            result = result.with_change(StateChange::ClipModified {
                clip_id: self.clip_id.clone(),
            });
        }
        Ok(result)
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(sequence) = state.sequences.get_mut(&self.sequence_id) else {
            return Ok(());
        };
        let Some(track) = sequence.tracks.iter_mut().find(|t| t.id == self.track_id) else {
            return Ok(());
        };
        let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) else {
            return Ok(());
        };

        // Restore removed effects at their original positions
        for (eid, pos, effect) in self.removed_effects.iter().rev() {
            let insert_pos = (*pos).min(clip.effects.len());
            clip.effects.insert(insert_pos, eid.clone());
            state.effects.insert(eid.clone(), effect.clone());
        }

        // Restore attributes
        if let Some(ref t) = self.prev_transform {
            clip.transform = t.clone();
        }
        if let Some(o) = self.prev_opacity {
            clip.opacity = o;
        }
        if let Some(ref bm) = self.prev_blend_mode {
            clip.blend_mode = bm.clone();
        }
        if let Some(s) = self.prev_speed {
            clip.speed = s;
        }
        if let Some(r) = self.prev_reverse {
            clip.reverse = r;
        }
        if let Some(ref a) = self.prev_audio {
            clip.audio = a.clone();
        }

        Ok(())
    }

    fn type_name(&self) -> &'static str {
        "RemoveAttributes"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "sequenceId": self.sequence_id,
            "trackId": self.track_id,
            "clipId": self.clip_id,
            "effectIds": self.effect_ids,
            "resetTransform": self.reset_transform,
            "resetOpacity": self.reset_opacity,
            "resetBlendMode": self.reset_blend_mode,
            "resetSpeed": self.reset_speed,
            "resetAudio": self.reset_audio,
        })
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        assets::{Asset, VideoInfo},
        effects::Easing,
        timeline::{Clip, Sequence, SequenceFormat, Track, TrackKind},
    };

    fn create_test_state() -> ProjectState {
        let mut state = ProjectState::new("Test Project");

        // Create a test asset
        let asset =
            Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default()).with_duration(10.0);
        let asset_id = asset.id.clone();
        state.assets.insert(asset.id.clone(), asset);

        // Create a test sequence with track and clip
        let mut sequence = Sequence::new("Test Sequence", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut track = Track::new("Video Track", TrackKind::Video);
        track.id = "track-1".to_string();

        let mut clip = Clip::new(&asset_id);
        clip.id = "clip-1".to_string();
        track.add_clip(clip);

        sequence.tracks.push(track);
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    // =========================================================================
    // AddEffectCommand Tests
    // =========================================================================

    #[test]
    fn test_add_effect_command_basic() {
        let mut state = create_test_state();
        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);

        let result = cmd.execute(&mut state).unwrap();

        // Verify effect was created
        assert!(!result.created_ids.is_empty());
        let effect_id = result.created_ids[0].clone();

        // Verify effect is in state
        assert!(state.effects.contains_key(&effect_id));

        // Verify effect is in clip's effect list
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert!(clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_add_effect_command_with_params() {
        let mut state = create_test_state();
        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
            .with_param("radius", ParamValue::Float(15.0))
            .with_param("sigma", ParamValue::Float(5.0));

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("radius"), Some(15.0));
        assert_eq!(effect.get_float("sigma"), Some(5.0));
    }

    #[test]
    fn test_add_effect_command_with_keyframes() {
        let mut state = create_test_state();
        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
            .with_param("radius", ParamValue::Float(12.0))
            .with_keyframes(
                "radius",
                vec![
                    Keyframe::new(0.0, ParamValue::Float(4.0)),
                    Keyframe::with_easing(1.0, ParamValue::Float(12.0), Easing::EaseOut),
                ],
            );

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        let effect = state.effects.get(&effect_id).unwrap();
        let radius_keyframes = effect.keyframes.get("radius").unwrap();
        assert_eq!(radius_keyframes.len(), 2);
        assert_eq!(radius_keyframes[0].value, ParamValue::Float(4.0));
        assert_eq!(radius_keyframes[1].easing, Easing::EaseOut);
    }

    #[test]
    fn test_add_effect_command_at_position() {
        let mut state = create_test_state();

        // Add first effect
        let mut cmd1 =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let result1 = cmd1.execute(&mut state).unwrap();
        let effect1_id = result1.created_ids[0].clone();

        // Add second effect at position 0
        let mut cmd2 = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Brightness)
            .at_position(0);
        let result2 = cmd2.execute(&mut state).unwrap();
        let effect2_id = result2.created_ids[0].clone();

        // Verify order - effect2 should be first
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert_eq!(clip.effects[0], effect2_id);
        assert_eq!(clip.effects[1], effect1_id);
    }

    #[test]
    fn test_add_effect_command_undo() {
        let mut state = create_test_state();
        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        // Undo
        cmd.undo(&mut state).unwrap();

        // Verify effect is removed from state
        assert!(!state.effects.contains_key(&effect_id));

        // Verify effect is removed from clip
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert!(!clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_add_effect_command_invalid_sequence() {
        let mut state = create_test_state();
        let mut cmd =
            AddEffectCommand::new("invalid-seq", "track-1", "clip-1", EffectType::GaussianBlur);

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_effect_command_invalid_track() {
        let mut state = create_test_state();
        let mut cmd =
            AddEffectCommand::new("seq-1", "invalid-track", "clip-1", EffectType::GaussianBlur);

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_add_effect_command_invalid_clip() {
        let mut state = create_test_state();
        let mut cmd =
            AddEffectCommand::new("seq-1", "track-1", "invalid-clip", EffectType::GaussianBlur);

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    // =========================================================================
    // RemoveEffectCommand Tests
    // =========================================================================

    #[test]
    fn test_remove_effect_command_basic() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let add_result = add_cmd.execute(&mut state).unwrap();
        let effect_id = add_result.created_ids[0].clone();

        // Now remove it
        let mut remove_cmd =
            RemoveEffectCommand::new("seq-1", "track-1", "clip-1", effect_id.clone());
        let _remove_result = remove_cmd.execute(&mut state).unwrap();

        // Verify effect is removed from state
        assert!(!state.effects.contains_key(&effect_id));

        // Verify effect is removed from clip
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert!(!clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_remove_effect_command_undo() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(10.0));
        let add_result = add_cmd.execute(&mut state).unwrap();
        let effect_id = add_result.created_ids[0].clone();

        // Remove it
        let mut remove_cmd =
            RemoveEffectCommand::new("seq-1", "track-1", "clip-1", effect_id.clone());
        remove_cmd.execute(&mut state).unwrap();

        // Undo the removal
        remove_cmd.undo(&mut state).unwrap();

        // Verify effect is restored in state
        assert!(state.effects.contains_key(&effect_id));
        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("radius"), Some(10.0));

        // Verify effect is restored in clip
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert!(clip.effects.contains(&effect_id));
    }

    #[test]
    fn test_remove_effect_command_invalid_effect() {
        let mut state = create_test_state();

        let mut cmd = RemoveEffectCommand::new("seq-1", "track-1", "clip-1", "nonexistent-effect");
        let result = cmd.execute(&mut state);

        assert!(result.is_err());
    }

    #[test]
    fn test_remove_effect_preserves_position() {
        let mut state = create_test_state();

        // Add three effects
        let mut cmd1 =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let effect1_id = cmd1.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd2 = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Brightness);
        let effect2_id = cmd2.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd3 = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Contrast);
        let effect3_id = cmd3.execute(&mut state).unwrap().created_ids[0].clone();

        // Remove middle effect
        let mut remove_cmd =
            RemoveEffectCommand::new("seq-1", "track-1", "clip-1", effect2_id.clone());
        remove_cmd.execute(&mut state).unwrap();

        // Undo - should restore at original position
        remove_cmd.undo(&mut state).unwrap();

        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();

        assert_eq!(clip.effects[0], effect1_id);
        assert_eq!(clip.effects[1], effect2_id);
        assert_eq!(clip.effects[2], effect3_id);
    }

    // =========================================================================
    // UpdateEffectCommand Tests
    // =========================================================================

    #[test]
    fn test_update_effect_command_basic() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0));
        let effect_id = add_cmd.execute(&mut state).unwrap().created_ids[0].clone();

        // Update the effect
        let mut update_cmd = UpdateEffectCommand::new(effect_id.clone())
            .with_param("radius", ParamValue::Float(20.0));
        update_cmd.execute(&mut state).unwrap();

        // Verify update
        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("radius"), Some(20.0));
    }

    #[test]
    fn test_update_effect_command_multiple_params() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0))
                .with_param("sigma", ParamValue::Float(2.0));
        let effect_id = add_cmd.execute(&mut state).unwrap().created_ids[0].clone();

        // Update multiple params
        let mut update_cmd = UpdateEffectCommand::new(effect_id.clone())
            .with_param("radius", ParamValue::Float(15.0))
            .with_param("sigma", ParamValue::Float(7.5));
        update_cmd.execute(&mut state).unwrap();

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("radius"), Some(15.0));
        assert_eq!(effect.get_float("sigma"), Some(7.5));
    }

    #[test]
    fn test_update_effect_command_enabled() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let effect_id = add_cmd.execute(&mut state).unwrap().created_ids[0].clone();

        // Verify default enabled state
        assert!(state.effects.get(&effect_id).unwrap().enabled);

        // Disable the effect
        let mut update_cmd = UpdateEffectCommand::new(effect_id.clone()).set_enabled(false);
        update_cmd.execute(&mut state).unwrap();

        assert!(!state.effects.get(&effect_id).unwrap().enabled);
    }

    #[test]
    fn test_update_effect_command_undo() {
        let mut state = create_test_state();

        // First add an effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0));
        let effect_id = add_cmd.execute(&mut state).unwrap().created_ids[0].clone();

        // Update the effect
        let mut update_cmd = UpdateEffectCommand::new(effect_id.clone())
            .with_param("radius", ParamValue::Float(20.0))
            .set_enabled(false);
        update_cmd.execute(&mut state).unwrap();

        // Undo
        update_cmd.undo(&mut state).unwrap();

        // Verify original values restored
        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("radius"), Some(5.0));
        assert!(effect.enabled);
    }

    #[test]
    fn test_update_effect_command_invalid_effect() {
        let mut state = create_test_state();

        let mut cmd = UpdateEffectCommand::new("nonexistent-effect")
            .with_param("radius", ParamValue::Float(10.0));
        let result = cmd.execute(&mut state);

        assert!(result.is_err());
    }

    // =========================================================================
    // Transition Effect Tests
    // =========================================================================

    #[test]
    fn test_add_transition_effect() {
        let mut state = create_test_state();

        let mut cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::CrossDissolve)
                .with_param("duration", ParamValue::Float(1.5))
                .with_param("offset", ParamValue::Float(5.0));

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.effect_type, EffectType::CrossDissolve);
        assert_eq!(effect.get_float("duration"), Some(1.5));
        assert_eq!(effect.get_float("offset"), Some(5.0));
    }

    #[test]
    fn test_add_wipe_transition() {
        let mut state = create_test_state();

        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Wipe)
            .with_param("direction", ParamValue::String("right".to_string()))
            .with_param("duration", ParamValue::Float(0.5));

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.effect_type, EffectType::Wipe);
        assert_eq!(
            effect.get_param("direction").and_then(|v| v.as_str()),
            Some("right")
        );
    }

    #[test]
    fn test_add_zoom_transition() {
        let mut state = create_test_state();

        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Zoom)
            .with_param("zoom_type", ParamValue::String("out".to_string()))
            .with_param("zoom_factor", ParamValue::Float(2.0))
            .with_param("center_x", ParamValue::Float(0.75))
            .with_param("center_y", ParamValue::Float(0.25));

        let result = cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.effect_type, EffectType::Zoom);
        assert_eq!(effect.get_float("zoom_factor"), Some(2.0));
        assert_eq!(effect.get_float("center_x"), Some(0.75));
    }

    // =========================================================================
    // Edge Case Tests
    // =========================================================================

    #[test]
    fn test_remove_effect_preserves_position_at_middle() {
        let mut state = create_test_state();

        // Add five effects: A, B, C, D, E
        let mut cmd_a =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let a_id = cmd_a.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_b = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Brightness);
        let b_id = cmd_b.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_c = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Contrast);
        let c_id = cmd_c.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_d = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Saturation);
        let d_id = cmd_d.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_e = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Hue);
        let e_id = cmd_e.execute(&mut state).unwrap().created_ids[0].clone();

        // Remove C (index 2)
        let mut remove_c = RemoveEffectCommand::new("seq-1", "track-1", "clip-1", c_id.clone());
        remove_c.execute(&mut state).unwrap();

        // Order should be: A, B, D, E
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert_eq!(clip.effects.len(), 4);
        assert_eq!(clip.effects[0], a_id);
        assert_eq!(clip.effects[1], b_id);
        assert_eq!(clip.effects[2], d_id);
        assert_eq!(clip.effects[3], e_id);

        // Undo removal of C - should restore at position 2
        remove_c.undo(&mut state).unwrap();

        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert_eq!(clip.effects.len(), 5);
        assert_eq!(clip.effects[0], a_id);
        assert_eq!(clip.effects[1], b_id);
        assert_eq!(clip.effects[2], c_id); // C restored at original position
        assert_eq!(clip.effects[3], d_id);
        assert_eq!(clip.effects[4], e_id);
    }

    #[test]
    fn test_remove_effect_undo_with_shrunk_list() {
        let mut state = create_test_state();

        // Add three effects: A, B, C
        let mut cmd_a =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let _a_id = cmd_a.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_b = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Brightness);
        let b_id = cmd_b.execute(&mut state).unwrap().created_ids[0].clone();

        let mut cmd_c = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Contrast);
        let c_id = cmd_c.execute(&mut state).unwrap().created_ids[0].clone();

        // Remove C (index 2)
        let mut remove_c = RemoveEffectCommand::new("seq-1", "track-1", "clip-1", c_id.clone());
        remove_c.execute(&mut state).unwrap();

        // Also remove B (now at index 1)
        let mut remove_b = RemoveEffectCommand::new("seq-1", "track-1", "clip-1", b_id.clone());
        remove_b.execute(&mut state).unwrap();

        // Now undo C removal - original position was 2 but list only has 1 element
        // Should clamp to position 1 (end of list)
        remove_c.undo(&mut state).unwrap();

        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert_eq!(clip.effects.len(), 2);
        // C should be at the end (clamped position)
        assert!(clip.effects.contains(&c_id));
    }

    #[test]
    fn test_update_effect_with_new_param() {
        let mut state = create_test_state();

        // Add effect without sigma param
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0));
        let effect_id = add_cmd.execute(&mut state).unwrap().created_ids[0].clone();

        // Update with a new param that didn't exist
        let mut update_cmd =
            UpdateEffectCommand::new(effect_id.clone()).with_param("sigma", ParamValue::Float(3.0));
        update_cmd.execute(&mut state).unwrap();

        // Verify new param exists
        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.get_float("sigma"), Some(3.0));

        // Undo - sigma should remain since there was no previous value to restore
        update_cmd.undo(&mut state).unwrap();
        let effect = state.effects.get(&effect_id).unwrap();
        // Note: undo only restores previous values, doesn't remove new ones
        // This is documented behavior
        assert_eq!(effect.get_float("sigma"), Some(3.0));
    }

    #[test]
    fn test_add_effect_command_with_position_past_end() {
        let mut state = create_test_state();

        // Add one effect first
        let mut cmd1 =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur);
        let first_id = cmd1.execute(&mut state).unwrap().created_ids[0].clone();

        // Add second effect at position 100 (way past the end)
        let mut cmd2 = AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::Brightness)
            .at_position(100);
        let second_id = cmd2.execute(&mut state).unwrap().created_ids[0].clone();

        // Second effect should be appended at end, not inserted at position 100
        let clip = state
            .sequences
            .get("seq-1")
            .unwrap()
            .get_track("track-1")
            .unwrap()
            .get_clip("clip-1")
            .unwrap();
        assert_eq!(clip.effects.len(), 2);
        assert_eq!(clip.effects[0], first_id);
        assert_eq!(clip.effects[1], second_id);
    }

    #[test]
    fn test_multiple_undo_redo_effect_operations() {
        let mut state = create_test_state();

        // Add effect
        let mut add_cmd =
            AddEffectCommand::new("seq-1", "track-1", "clip-1", EffectType::GaussianBlur)
                .with_param("radius", ParamValue::Float(5.0));
        let result = add_cmd.execute(&mut state).unwrap();
        let effect_id = result.created_ids[0].clone();

        // Update effect
        let mut update_cmd = UpdateEffectCommand::new(effect_id.clone())
            .with_param("radius", ParamValue::Float(15.0));
        update_cmd.execute(&mut state).unwrap();

        // Verify update applied
        assert_eq!(
            state.effects.get(&effect_id).unwrap().get_float("radius"),
            Some(15.0)
        );

        // Undo update
        update_cmd.undo(&mut state).unwrap();
        assert_eq!(
            state.effects.get(&effect_id).unwrap().get_float("radius"),
            Some(5.0)
        );

        // Undo add
        add_cmd.undo(&mut state).unwrap();
        assert!(!state.effects.contains_key(&effect_id));
    }

    // =================================================================
    // PasteEffectsCommand Tests (BDD-style)
    // =================================================================

    fn create_two_clip_state() -> ProjectState {
        let mut state = ProjectState::new("Test Project");
        let asset =
            Asset::new_video("test.mp4", "/test.mp4", VideoInfo::default()).with_duration(10.0);
        let asset_id = asset.id.clone();
        state.assets.insert(asset.id.clone(), asset);

        let mut sequence = Sequence::new("Test Seq", SequenceFormat::youtube_1080());
        sequence.id = "seq-1".to_string();

        let mut track = Track::new("Video Track", TrackKind::Video);
        track.id = "track-1".to_string();

        let mut clip_a = Clip::new(&asset_id);
        clip_a.id = "clip-a".to_string();

        let mut clip_b = Clip::new(&asset_id);
        clip_b.id = "clip-b".to_string();
        clip_b.place.timeline_in_sec = 5.0;

        track.add_clip(clip_a);
        track.add_clip(clip_b);
        sequence.tracks.push(track);
        state.sequences.insert(sequence.id.clone(), sequence);

        state
    }

    fn add_effect_to_clip(state: &mut ProjectState, effect_type: EffectType) -> String {
        let mut cmd = AddEffectCommand::new("seq-1", "track-1", "clip-a", effect_type);
        cmd.execute(state).unwrap();
        cmd.created_effect_id.unwrap()
    }

    fn serialize_effects(state: &ProjectState, ids: &[&str]) -> Vec<serde_json::Value> {
        ids.iter()
            .filter_map(|id| {
                state
                    .effects
                    .get(*id)
                    .and_then(|e| serde_json::to_value(e).ok())
            })
            .collect()
    }

    #[test]
    fn should_paste_all_effects_to_single_target_clip() {
        // Given a clip with two effects
        let mut state = create_two_clip_state();
        let eid1 = add_effect_to_clip(&mut state, EffectType::Brightness);
        let eid2 = add_effect_to_clip(&mut state, EffectType::Contrast);
        let source_effects = serialize_effects(&state, &[&eid1, &eid2]);

        // When pasting effects to clip-b
        let mut cmd = PasteEffectsCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            source_effects,
        );
        let result = cmd.execute(&mut state).unwrap();

        // Then clip-b should have 2 new effects with unique IDs
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert_eq!(clip_b.effects.len(), 2);
        assert_ne!(clip_b.effects[0], eid1);
        assert_ne!(clip_b.effects[1], eid2);
        assert_eq!(result.created_ids.len(), 2);

        // And the new effects should have correct types
        let new_e1 = state.effects.get(&clip_b.effects[0]).unwrap();
        let new_e2 = state.effects.get(&clip_b.effects[1]).unwrap();
        assert_eq!(new_e1.effect_type, EffectType::Brightness);
        assert_eq!(new_e2.effect_type, EffectType::Contrast);
    }

    #[test]
    fn should_paste_effects_to_multiple_target_clips() {
        // Given a clip with one effect
        let mut state = create_two_clip_state();
        let eid = add_effect_to_clip(&mut state, EffectType::GaussianBlur);
        let source_effects = serialize_effects(&state, &[&eid]);

        // Add a third clip using the real asset ID from the test state
        let asset_id = state.assets.keys().next().unwrap().clone();
        let seq = state.sequences.get_mut("seq-1").unwrap();
        let mut clip_c = Clip::new(&asset_id);
        clip_c.id = "clip-c".to_string();
        clip_c.place.timeline_in_sec = 10.0;
        seq.tracks[0].add_clip(clip_c);

        // When pasting to both clip-b and clip-c
        let mut cmd = PasteEffectsCommand::new(
            "seq-1",
            vec![
                ("track-1".to_string(), "clip-b".to_string()),
                ("track-1".to_string(), "clip-c".to_string()),
            ],
            source_effects,
        );
        cmd.execute(&mut state).unwrap();

        // Then both clips should have one new effect each
        let seq = &state.sequences["seq-1"];
        let clip_b = seq.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        let clip_c = seq.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-c")
            .unwrap();
        assert_eq!(clip_b.effects.len(), 1);
        assert_eq!(clip_c.effects.len(), 1);
        // And they should have different IDs (independent clones)
        assert_ne!(clip_b.effects[0], clip_c.effects[0]);
    }

    #[test]
    fn should_undo_paste_effects_removing_all_created_effects() {
        // Given a clip with one effect pasted to clip-b
        let mut state = create_two_clip_state();
        let eid = add_effect_to_clip(&mut state, EffectType::Saturation);
        let source_effects = serialize_effects(&state, &[&eid]);

        let mut cmd = PasteEffectsCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            source_effects,
        );
        cmd.execute(&mut state).unwrap();

        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert_eq!(clip_b.effects.len(), 1);
        let pasted_id = clip_b.effects[0].clone();

        // When undoing the paste
        cmd.undo(&mut state).unwrap();

        // Then clip-b should have no effects
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!(clip_b.effects.is_empty());
        // And the effect should be removed from the registry
        assert!(!state.effects.contains_key(&pasted_id));
    }

    #[test]
    fn should_reject_paste_to_locked_track() {
        let mut state = create_two_clip_state();
        let eid = add_effect_to_clip(&mut state, EffectType::Brightness);
        let source_effects = serialize_effects(&state, &[&eid]);

        // Lock the track
        state.sequences.get_mut("seq-1").unwrap().tracks[0].locked = true;

        let mut cmd = PasteEffectsCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            source_effects,
        );
        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn should_not_mutate_any_clip_when_paste_effects_target_validation_fails() {
        let mut state = create_two_clip_state();
        let eid = add_effect_to_clip(&mut state, EffectType::Brightness);
        let source_effects = serialize_effects(&state, &[&eid]);
        let original_effect_count = state.effects.len();

        let mut cmd = PasteEffectsCommand::new(
            "seq-1",
            vec![
                ("track-1".to_string(), "clip-b".to_string()),
                ("track-1".to_string(), "missing-clip".to_string()),
            ],
            source_effects,
        );

        assert!(cmd.execute(&mut state).is_err());

        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!(clip_b.effects.is_empty());
        assert_eq!(state.effects.len(), original_effect_count);
    }

    // =================================================================
    // PasteAttributesCommand Tests (BDD-style)
    // =================================================================

    #[test]
    fn should_selectively_paste_only_chosen_effects() {
        // Given a clip with 3 effects
        let mut state = create_two_clip_state();
        let eid1 = add_effect_to_clip(&mut state, EffectType::Brightness);
        let eid2 = add_effect_to_clip(&mut state, EffectType::Contrast);
        let eid3 = add_effect_to_clip(&mut state, EffectType::Saturation);
        let source_effects = serialize_effects(&state, &[&eid1, &eid2, &eid3]);

        // When pasting only effects at index 0 and 2
        let selection = AttributeSelection {
            effect_indices: vec![0, 2],
            ..Default::default()
        };
        let mut cmd = PasteAttributesCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            source_effects,
            ClipAttributeValues::default(),
            selection,
        );
        cmd.execute(&mut state).unwrap();

        // Then clip-b should have 2 effects (Brightness and Saturation)
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert_eq!(clip_b.effects.len(), 2);
        let e0 = state.effects.get(&clip_b.effects[0]).unwrap();
        let e1 = state.effects.get(&clip_b.effects[1]).unwrap();
        assert_eq!(e0.effect_type, EffectType::Brightness);
        assert_eq!(e1.effect_type, EffectType::Saturation);
    }

    #[test]
    fn should_paste_attributes_like_transform_and_opacity() {
        // Given clip-a with custom transform and opacity
        let mut state = create_two_clip_state();
        let clip_a = state.sequences.get_mut("seq-1").unwrap().tracks[0]
            .clips
            .iter_mut()
            .find(|c| c.id == "clip-a")
            .unwrap();
        clip_a.transform.rotation_deg = 45.0;
        clip_a.opacity = 0.5;

        let attrs = ClipAttributeValues {
            transform: Some(serde_json::to_value(&clip_a.transform).unwrap()),
            opacity: Some(clip_a.opacity),
            ..Default::default()
        };

        // When pasting transform and opacity to clip-b
        let selection = AttributeSelection {
            transform: true,
            opacity: true,
            ..Default::default()
        };
        let mut cmd = PasteAttributesCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            vec![],
            attrs,
            selection,
        );
        cmd.execute(&mut state).unwrap();

        // Then clip-b should have the same transform and opacity
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!((clip_b.transform.rotation_deg - 45.0).abs() < 0.001);
        assert!((clip_b.opacity - 0.5).abs() < 0.001);
    }

    #[test]
    fn should_undo_paste_attributes_restoring_original_values() {
        let mut state = create_two_clip_state();

        // Save original clip-b opacity
        let original_opacity = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap()
            .opacity;

        let attrs = ClipAttributeValues {
            opacity: Some(0.3),
            ..Default::default()
        };
        let selection = AttributeSelection {
            opacity: true,
            ..Default::default()
        };
        let mut cmd = PasteAttributesCommand::new(
            "seq-1",
            vec![("track-1".to_string(), "clip-b".to_string())],
            vec![],
            attrs,
            selection,
        );
        cmd.execute(&mut state).unwrap();

        // Verify paste worked
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!((clip_b.opacity - 0.3).abs() < 0.001);

        // Undo
        cmd.undo(&mut state).unwrap();
        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!((clip_b.opacity - original_opacity).abs() < 0.001);
    }

    #[test]
    fn should_not_mutate_any_clip_when_paste_attributes_target_validation_fails() {
        let mut state = create_two_clip_state();
        let original_opacity = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap()
            .opacity;

        let mut cmd = PasteAttributesCommand::new(
            "seq-1",
            vec![
                ("track-1".to_string(), "clip-b".to_string()),
                ("track-1".to_string(), "missing-clip".to_string()),
            ],
            vec![],
            ClipAttributeValues {
                opacity: Some(0.25),
                ..Default::default()
            },
            AttributeSelection {
                opacity: true,
                ..Default::default()
            },
        );

        assert!(cmd.execute(&mut state).is_err());

        let clip_b = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-b")
            .unwrap();
        assert!((clip_b.opacity - original_opacity).abs() < 0.001);
    }

    // =================================================================
    // RemoveAttributesCommand Tests (BDD-style)
    // =================================================================

    #[test]
    fn should_remove_specified_effects_from_clip() {
        // Given clip-a with 2 effects
        let mut state = create_two_clip_state();
        let eid1 = add_effect_to_clip(&mut state, EffectType::Brightness);
        let eid2 = add_effect_to_clip(&mut state, EffectType::Contrast);

        // When removing the first effect
        let mut cmd = RemoveAttributesCommand::new("seq-1", "track-1", "clip-a")
            .with_effect_ids(vec![eid1.clone()]);
        cmd.execute(&mut state).unwrap();

        // Then clip-a should have only the second effect
        let clip_a = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-a")
            .unwrap();
        assert_eq!(clip_a.effects.len(), 1);
        assert_eq!(clip_a.effects[0], eid2);
        assert!(!state.effects.contains_key(&eid1));
    }

    #[test]
    fn should_reset_attributes_to_defaults() {
        // Given clip-a with modified attributes
        let mut state = create_two_clip_state();
        let clip_a = state.sequences.get_mut("seq-1").unwrap().tracks[0]
            .clips
            .iter_mut()
            .find(|c| c.id == "clip-a")
            .unwrap();
        clip_a.opacity = 0.5;
        clip_a.speed = 2.0;
        clip_a.reverse = true;

        // When resetting opacity and speed
        let mut cmd = RemoveAttributesCommand::new("seq-1", "track-1", "clip-a")
            .with_reset_opacity(true)
            .with_reset_speed(true);
        cmd.execute(&mut state).unwrap();

        // Then attributes should be at defaults
        let clip_a = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-a")
            .unwrap();
        assert!((clip_a.opacity - 1.0).abs() < 0.001); // default opacity
        assert!((clip_a.speed - 1.0).abs() < 0.001); // default speed
        assert!(!clip_a.reverse); // default reverse
    }

    #[test]
    fn should_undo_remove_attributes_restoring_effects_at_original_positions() {
        // Given clip-a with 3 effects, remove the middle one
        let mut state = create_two_clip_state();
        let eid1 = add_effect_to_clip(&mut state, EffectType::Brightness);
        let eid2 = add_effect_to_clip(&mut state, EffectType::Contrast);
        let eid3 = add_effect_to_clip(&mut state, EffectType::Saturation);

        let mut cmd = RemoveAttributesCommand::new("seq-1", "track-1", "clip-a")
            .with_effect_ids(vec![eid2.clone()])
            .with_reset_opacity(true);

        let clip_a = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-a")
            .unwrap();
        let original_opacity = clip_a.opacity;

        cmd.execute(&mut state).unwrap();

        // Verify state after remove
        let clip_a = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-a")
            .unwrap();
        assert_eq!(clip_a.effects, vec![eid1.clone(), eid3.clone()]);

        // When undoing
        cmd.undo(&mut state).unwrap();

        // Then effects and opacity restored
        let clip_a = state.sequences["seq-1"].tracks[0]
            .clips
            .iter()
            .find(|c| c.id == "clip-a")
            .unwrap();
        assert_eq!(clip_a.effects, vec![eid1, eid2, eid3]);
        assert!((clip_a.opacity - original_opacity).abs() < 0.001);
        assert!(state.effects.contains_key(&clip_a.effects[1]));
    }

    #[test]
    fn should_reject_remove_attributes_on_locked_track() {
        let mut state = create_two_clip_state();
        state.sequences.get_mut("seq-1").unwrap().tracks[0].locked = true;

        let mut cmd =
            RemoveAttributesCommand::new("seq-1", "track-1", "clip-a").with_reset_opacity(true);
        assert!(cmd.execute(&mut state).is_err());
    }
}
