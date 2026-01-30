//! Effect Commands Module
//!
//! Implements effect editing commands for the event sourcing system.
//! Effects can be added to clips to apply video/audio transformations.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    effects::{Effect, EffectType, ParamValue},
    project::ProjectState,
    ClipId, CoreError, CoreResult, EffectId, SequenceId, TrackId,
};

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
            position: None,
            created_effect_id: None,
        }
    }

    /// Add a parameter value to the effect
    pub fn with_param(mut self, name: impl Into<String>, value: ParamValue) -> Self {
        self.params.insert(name.into(), value);
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
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        assets::{Asset, VideoInfo},
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
}
