//! Mask Commands Module
//!
//! Implements mask (Power Windows) editing commands for the event sourcing system.
//! Masks are used for selective effect application within a specific region.

use serde::{Deserialize, Serialize};

use crate::core::{
    commands::{Command, CommandResult, StateChange},
    masks::{Mask, MaskBlendMode, MaskShape},
    project::ProjectState,
    ClipId, CoreError, CoreResult, EffectId, MaskId, SequenceId, TrackId,
};

// =============================================================================
// AddMaskCommand
// =============================================================================

/// Command to add a mask to an effect.
///
/// # Parameters
/// - `sequence_id`: The sequence containing the clip
/// - `track_id`: The track containing the clip
/// - `clip_id`: The clip containing the effect
/// - `effect_id`: The effect to add the mask to
/// - `shape`: The mask shape (rectangle, ellipse, polygon, bezier)
///
/// # Example
/// ```ignore
/// use openreelio_lib::core::masks::{MaskShape, RectMask};
///
/// let cmd = AddMaskCommand::new("seq-1", "track-1", "clip-1", "effect-1",
///     MaskShape::Rectangle(RectMask::default()));
/// executor.execute(cmd)?;
/// ```
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMaskCommand {
    pub sequence_id: SequenceId,
    pub track_id: TrackId,
    pub clip_id: ClipId,
    pub effect_id: EffectId,
    pub shape: MaskShape,
    /// Optional mask name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional feather amount (0.0-1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    /// Whether to invert the mask
    #[serde(default)]
    pub inverted: bool,
    #[serde(skip)]
    created_mask_id: Option<MaskId>,
}

impl AddMaskCommand {
    pub fn new(
        sequence_id: impl Into<String>,
        track_id: impl Into<String>,
        clip_id: impl Into<String>,
        effect_id: impl Into<String>,
        shape: MaskShape,
    ) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            track_id: track_id.into(),
            clip_id: clip_id.into(),
            effect_id: effect_id.into(),
            shape,
            name: None,
            feather: None,
            inverted: false,
            created_mask_id: None,
        }
    }

    /// Sets the mask name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets the feather amount
    pub fn with_feather(mut self, feather: f64) -> Self {
        self.feather = Some(feather.clamp(0.0, 1.0));
        self
    }

    /// Inverts the mask
    pub fn inverted(mut self) -> Self {
        self.inverted = true;
        self
    }
}

impl Command for AddMaskCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate shape
        self.shape.validate().map_err(CoreError::ValidationError)?;

        // Find the effect
        let effect = state
            .effects
            .get_mut(&self.effect_id)
            .ok_or_else(|| CoreError::EffectNotFound(self.effect_id.clone()))?;

        // Create the mask
        let mut mask = Mask::new(self.shape.clone());
        if let Some(ref name) = self.name {
            mask.name = name.clone();
        }
        if let Some(feather) = self.feather {
            mask.feather = feather;
        }
        mask.inverted = self.inverted;

        let mask_id = mask.id.clone();
        self.created_mask_id = Some(mask_id.clone());

        // Add mask to effect
        effect.masks.add(mask);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::EffectUpdated {
                effect_id: self.effect_id.clone(),
            })
            .with_created_id(&mask_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(ref mask_id) = self.created_mask_id else {
            return Ok(());
        };

        if let Some(effect) = state.effects.get_mut(&self.effect_id) {
            effect.masks.remove(mask_id);
        }

        Ok(())
    }

    fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        self.execute(state)
    }

    fn type_name(&self) -> &'static str {
        "AddMask"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

// =============================================================================
// UpdateMaskCommand
// =============================================================================

/// Command to update a mask's properties.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMaskCommand {
    pub effect_id: EffectId,
    pub mask_id: MaskId,
    /// New shape (if changing)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<MaskShape>,
    /// New name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// New feather value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feather: Option<f64>,
    /// New opacity value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    /// New expansion value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expansion: Option<f64>,
    /// New inverted state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inverted: Option<bool>,
    /// New blend mode
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend_mode: Option<MaskBlendMode>,
    /// New enabled state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// New locked state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(skip)]
    previous_mask: Option<Mask>,
}

impl UpdateMaskCommand {
    pub fn new(effect_id: impl Into<String>, mask_id: impl Into<String>) -> Self {
        Self {
            effect_id: effect_id.into(),
            mask_id: mask_id.into(),
            shape: None,
            name: None,
            feather: None,
            opacity: None,
            expansion: None,
            inverted: None,
            blend_mode: None,
            enabled: None,
            locked: None,
            previous_mask: None,
        }
    }

    /// Sets a new shape
    pub fn with_shape(mut self, shape: MaskShape) -> Self {
        self.shape = Some(shape);
        self
    }

    /// Sets a new name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets a new feather value
    pub fn with_feather(mut self, feather: f64) -> Self {
        self.feather = Some(feather.clamp(0.0, 1.0));
        self
    }

    /// Sets a new opacity value
    pub fn with_opacity(mut self, opacity: f64) -> Self {
        self.opacity = Some(opacity.clamp(0.0, 1.0));
        self
    }

    /// Sets a new expansion value
    pub fn with_expansion(mut self, expansion: f64) -> Self {
        self.expansion = Some(expansion.clamp(-1.0, 1.0));
        self
    }

    /// Sets the inverted state
    pub fn with_inverted(mut self, inverted: bool) -> Self {
        self.inverted = Some(inverted);
        self
    }

    /// Sets the blend mode
    pub fn with_blend_mode(mut self, blend_mode: MaskBlendMode) -> Self {
        self.blend_mode = Some(blend_mode);
        self
    }

    /// Sets the enabled state
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = Some(enabled);
        self
    }

    /// Sets the locked state
    pub fn with_locked(mut self, locked: bool) -> Self {
        self.locked = Some(locked);
        self
    }
}

impl Command for UpdateMaskCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Validate new shape if provided
        if let Some(ref shape) = self.shape {
            shape.validate().map_err(CoreError::ValidationError)?;
        }

        // Find the effect
        let effect = state
            .effects
            .get_mut(&self.effect_id)
            .ok_or_else(|| CoreError::EffectNotFound(self.effect_id.clone()))?;

        // Find the mask
        let mask = effect.masks.get_mut(&self.mask_id).ok_or_else(|| {
            CoreError::ValidationError(format!("Mask not found: {}", self.mask_id))
        })?;

        // Store previous state for undo
        self.previous_mask = Some(mask.clone());

        // Apply updates
        if let Some(ref shape) = self.shape {
            mask.shape = shape.clone();
        }
        if let Some(ref name) = self.name {
            mask.name = name.clone();
        }
        if let Some(feather) = self.feather {
            mask.feather = feather;
        }
        if let Some(opacity) = self.opacity {
            mask.opacity = opacity;
        }
        if let Some(expansion) = self.expansion {
            mask.expansion = expansion;
        }
        if let Some(inverted) = self.inverted {
            mask.inverted = inverted;
        }
        if let Some(ref blend_mode) = self.blend_mode {
            mask.blend_mode = blend_mode.clone();
        }
        if let Some(enabled) = self.enabled {
            mask.enabled = enabled;
        }
        if let Some(locked) = self.locked {
            mask.locked = locked;
        }

        let op_id = ulid::Ulid::new().to_string();
        Ok(
            CommandResult::new(&op_id).with_change(StateChange::EffectUpdated {
                effect_id: self.effect_id.clone(),
            }),
        )
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(ref previous) = self.previous_mask else {
            return Ok(());
        };

        if let Some(effect) = state.effects.get_mut(&self.effect_id) {
            if let Some(mask) = effect.masks.get_mut(&self.mask_id) {
                *mask = previous.clone();
            }
        }

        Ok(())
    }

    fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        self.execute(state)
    }

    fn type_name(&self) -> &'static str {
        "UpdateMask"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

// =============================================================================
// RemoveMaskCommand
// =============================================================================

/// Command to remove a mask from an effect.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveMaskCommand {
    pub effect_id: EffectId,
    pub mask_id: MaskId,
    #[serde(skip)]
    removed_mask: Option<Mask>,
}

impl RemoveMaskCommand {
    pub fn new(effect_id: impl Into<String>, mask_id: impl Into<String>) -> Self {
        Self {
            effect_id: effect_id.into(),
            mask_id: mask_id.into(),
            removed_mask: None,
        }
    }
}

impl Command for RemoveMaskCommand {
    fn execute(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        // Find the effect
        let effect = state
            .effects
            .get_mut(&self.effect_id)
            .ok_or_else(|| CoreError::EffectNotFound(self.effect_id.clone()))?;

        // Remove the mask
        let removed = effect.masks.remove(&self.mask_id).ok_or_else(|| {
            CoreError::ValidationError(format!("Mask not found: {}", self.mask_id))
        })?;

        self.removed_mask = Some(removed);

        let op_id = ulid::Ulid::new().to_string();
        Ok(CommandResult::new(&op_id)
            .with_change(StateChange::EffectUpdated {
                effect_id: self.effect_id.clone(),
            })
            .with_deleted_id(&self.mask_id))
    }

    fn undo(&self, state: &mut ProjectState) -> CoreResult<()> {
        let Some(ref removed) = self.removed_mask else {
            return Ok(());
        };

        if let Some(effect) = state.effects.get_mut(&self.effect_id) {
            effect.masks.add(removed.clone());
        }

        Ok(())
    }

    fn redo(&mut self, state: &mut ProjectState) -> CoreResult<CommandResult> {
        self.execute(state)
    }

    fn type_name(&self) -> &'static str {
        "RemoveMask"
    }

    fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        effects::{Effect, EffectType},
        masks::RectMask,
        project::ProjectState,
    };

    fn setup_state_with_effect() -> (ProjectState, EffectId) {
        let mut state = ProjectState::new("test");
        let effect = Effect::new(EffectType::ColorWheels);
        let effect_id = effect.id.clone();
        state.effects.insert(effect_id.clone(), effect);
        (state, effect_id)
    }

    #[test]
    fn test_add_mask_command() {
        let (mut state, effect_id) = setup_state_with_effect();

        let mut cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        )
        .with_name("Test Mask")
        .with_feather(0.1);

        let result = cmd.execute(&mut state).unwrap();
        assert_eq!(result.created_ids.len(), 1);

        let effect = state.effects.get(&effect_id).unwrap();
        assert_eq!(effect.masks.len(), 1);

        let mask = effect.masks.masks.first().unwrap();
        assert_eq!(mask.name, "Test Mask");
        assert_eq!(mask.feather, 0.1);
    }

    #[test]
    fn test_add_mask_command_undo() {
        let (mut state, effect_id) = setup_state_with_effect();

        let mut cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        );

        cmd.execute(&mut state).unwrap();
        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 1);

        cmd.undo(&mut state).unwrap();
        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 0);
    }

    #[test]
    fn test_add_mask_validates_shape() {
        let (mut state, effect_id) = setup_state_with_effect();

        // Invalid polygon (only 2 points)
        use crate::core::masks::{Point2D, PolygonMask};
        let invalid_polygon =
            PolygonMask::new(vec![Point2D::new(0.0, 0.0), Point2D::new(1.0, 1.0)]);

        let mut cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Polygon(invalid_polygon),
        );

        let result = cmd.execute(&mut state);
        assert!(result.is_err());
    }

    #[test]
    fn test_update_mask_command() {
        let (mut state, effect_id) = setup_state_with_effect();

        // First add a mask
        let mut add_cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        );
        let result = add_cmd.execute(&mut state).unwrap();
        let mask_id = result.created_ids[0].clone();

        // Now update it
        let mut update_cmd = UpdateMaskCommand::new(&effect_id, &mask_id)
            .with_name("Updated Mask")
            .with_feather(0.5)
            .with_inverted(true);

        update_cmd.execute(&mut state).unwrap();

        let effect = state.effects.get(&effect_id).unwrap();
        let mask = effect.masks.get(&mask_id).unwrap();
        assert_eq!(mask.name, "Updated Mask");
        assert_eq!(mask.feather, 0.5);
        assert!(mask.inverted);
    }

    #[test]
    fn test_update_mask_command_undo() {
        let (mut state, effect_id) = setup_state_with_effect();

        // Add a mask
        let mut add_cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        )
        .with_name("Original");
        let result = add_cmd.execute(&mut state).unwrap();
        let mask_id = result.created_ids[0].clone();

        // Update it
        let mut update_cmd = UpdateMaskCommand::new(&effect_id, &mask_id).with_name("Changed");
        update_cmd.execute(&mut state).unwrap();

        // Verify change
        let mask = state
            .effects
            .get(&effect_id)
            .unwrap()
            .masks
            .get(&mask_id)
            .unwrap();
        assert_eq!(mask.name, "Changed");

        // Undo
        update_cmd.undo(&mut state).unwrap();

        // Verify restoration
        let mask = state
            .effects
            .get(&effect_id)
            .unwrap()
            .masks
            .get(&mask_id)
            .unwrap();
        assert_eq!(mask.name, "Original");
    }

    #[test]
    fn test_remove_mask_command() {
        let (mut state, effect_id) = setup_state_with_effect();

        // Add a mask
        let mut add_cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        );
        let result = add_cmd.execute(&mut state).unwrap();
        let mask_id = result.created_ids[0].clone();

        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 1);

        // Remove it
        let mut remove_cmd = RemoveMaskCommand::new(&effect_id, &mask_id);
        remove_cmd.execute(&mut state).unwrap();

        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 0);
    }

    #[test]
    fn test_remove_mask_command_undo() {
        let (mut state, effect_id) = setup_state_with_effect();

        // Add a mask
        let mut add_cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        )
        .with_name("To Remove");
        let result = add_cmd.execute(&mut state).unwrap();
        let mask_id = result.created_ids[0].clone();

        // Remove it
        let mut remove_cmd = RemoveMaskCommand::new(&effect_id, &mask_id);
        remove_cmd.execute(&mut state).unwrap();
        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 0);

        // Undo
        remove_cmd.undo(&mut state).unwrap();
        assert_eq!(state.effects.get(&effect_id).unwrap().masks.len(), 1);

        let mask = state
            .effects
            .get(&effect_id)
            .unwrap()
            .masks
            .get(&mask_id)
            .unwrap();
        assert_eq!(mask.name, "To Remove");
    }

    #[test]
    fn test_command_type_names() {
        let add_cmd = AddMaskCommand::new("s", "t", "c", "e", MaskShape::default());
        assert_eq!(add_cmd.type_name(), "AddMask");

        let update_cmd = UpdateMaskCommand::new("e", "m");
        assert_eq!(update_cmd.type_name(), "UpdateMask");

        let remove_cmd = RemoveMaskCommand::new("e", "m");
        assert_eq!(remove_cmd.type_name(), "RemoveMask");
    }

    #[test]
    fn test_add_mask_inverted() {
        let (mut state, effect_id) = setup_state_with_effect();

        let mut cmd = AddMaskCommand::new(
            "seq-1",
            "track-1",
            "clip-1",
            &effect_id,
            MaskShape::Rectangle(RectMask::default()),
        )
        .inverted();

        cmd.execute(&mut state).unwrap();

        let effect = state.effects.get(&effect_id).unwrap();
        let mask = effect.masks.masks.first().unwrap();
        assert!(mask.inverted);
    }
}
