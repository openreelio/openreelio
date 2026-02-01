//! EditScript Module
//!
//! Defines the EditScript schema for AI-generated edit commands.

use serde::{Deserialize, Serialize};

// =============================================================================
// EditScript
// =============================================================================

/// AI-generated editing script
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditScript {
    /// User's intent/request description
    pub intent: String,
    /// Commands to execute
    pub commands: Vec<EditCommand>,
    /// Required resources/preprocessing
    pub requires: Vec<Requirement>,
    /// Quality check rules
    pub qc_rules: Vec<String>,
    /// Risk assessment
    pub risk: RiskAssessment,
    /// AI's explanation of the edit
    pub explanation: String,
    /// Preview plan (optional)
    pub preview_plan: Option<PreviewPlan>,
}

impl EditScript {
    /// Creates a new empty edit script
    pub fn new(intent: &str) -> Self {
        Self {
            intent: intent.to_string(),
            commands: Vec::new(),
            requires: Vec::new(),
            qc_rules: Vec::new(),
            risk: RiskAssessment::default(),
            explanation: String::new(),
            preview_plan: None,
        }
    }

    /// Adds a command to the script
    pub fn add_command(mut self, command: EditCommand) -> Self {
        self.commands.push(command);
        self
    }

    /// Adds a requirement
    pub fn add_requirement(mut self, requirement: Requirement) -> Self {
        self.requires.push(requirement);
        self
    }

    /// Sets the explanation
    pub fn with_explanation(mut self, explanation: &str) -> Self {
        self.explanation = explanation.to_string();
        self
    }

    /// Returns the number of commands
    pub fn command_count(&self) -> usize {
        self.commands.len()
    }

    /// Returns whether the script has any high-risk items
    pub fn has_high_risk(&self) -> bool {
        matches!(self.risk.copyright, RiskLevel::High) || matches!(self.risk.nsfw, NsfwRisk::Likely)
    }

    /// Validates the edit script
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.intent.is_empty() {
            errors.push("Intent is required".to_string());
        }

        if self.commands.is_empty() {
            errors.push("At least one command is required".to_string());
        }

        for (i, cmd) in self.commands.iter().enumerate() {
            if cmd.command_type.is_empty() {
                errors.push(format!("Command {} has empty type", i));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

// =============================================================================
// EditCommand
// =============================================================================

/// A single edit command in the script
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCommand {
    /// Command type (e.g., "InsertClip", "SplitClip")
    pub command_type: String,
    /// Command parameters
    pub params: serde_json::Value,
    /// Optional description
    pub description: Option<String>,
}

impl EditCommand {
    /// Creates a new edit command
    pub fn new(command_type: &str, params: serde_json::Value) -> Self {
        Self {
            command_type: command_type.to_string(),
            params,
            description: None,
        }
    }

    /// Creates an InsertClip command
    pub fn insert_clip(track_id: &str, asset_id: &str, timeline_start: f64) -> Self {
        Self::new(
            "InsertClip",
            serde_json::json!({
                "trackId": track_id,
                "assetId": asset_id,
                "timelineStart": timeline_start
            }),
        )
    }

    /// Creates a SplitClip command
    pub fn split_clip(clip_id: &str, at_sec: f64) -> Self {
        Self::new(
            "SplitClip",
            serde_json::json!({
                "clipId": clip_id,
                "atTimelineSec": at_sec
            }),
        )
    }

    /// Creates a DeleteClip command
    pub fn delete_clip(clip_id: &str) -> Self {
        Self::new(
            "DeleteClip",
            serde_json::json!({
                "clipId": clip_id
            }),
        )
    }

    /// Creates a TrimClip command
    ///
    /// # Arguments
    /// * `clip_id` - The ID of the clip to trim
    /// * `new_source_in` - New source in point (start of the source media to use)
    /// * `new_source_out` - New source out point (end of the source media to use)
    /// * `new_timeline_in` - New timeline position for the clip
    pub fn trim_clip(
        clip_id: &str,
        new_source_in: Option<f64>,
        new_source_out: Option<f64>,
        new_timeline_in: Option<f64>,
    ) -> Self {
        let mut params = serde_json::json!({ "clipId": clip_id });

        if let Some(source_in) = new_source_in {
            params["newSourceIn"] = serde_json::json!(source_in);
        }
        if let Some(source_out) = new_source_out {
            params["newSourceOut"] = serde_json::json!(source_out);
        }
        if let Some(timeline_in) = new_timeline_in {
            params["newTimelineIn"] = serde_json::json!(timeline_in);
        }

        Self::new("TrimClip", params)
    }

    /// Creates a MoveClip command
    ///
    /// # Arguments
    /// * `clip_id` - The ID of the clip to move
    /// * `new_timeline_in` - New timeline position in seconds
    /// * `new_track_id` - Optional: move to a different track
    pub fn move_clip(clip_id: &str, new_timeline_in: f64, new_track_id: Option<&str>) -> Self {
        let mut params = serde_json::json!({
            "clipId": clip_id,
            "newTimelineIn": new_timeline_in
        });

        if let Some(track_id) = new_track_id {
            params["newTrackId"] = serde_json::json!(track_id);
        }

        Self::new("MoveClip", params)
    }

    /// Creates a RippleDelete command
    pub fn ripple_delete(clip_id: &str, affect_all_tracks: bool) -> Self {
        Self::new(
            "RippleDelete",
            serde_json::json!({
                "clipId": clip_id,
                "affectAllTracks": affect_all_tracks
            }),
        )
    }

    /// Creates a DuplicateClip command
    pub fn duplicate_clip(
        clip_id: &str,
        target_track_id: Option<&str>,
        offset: Option<f64>,
    ) -> Self {
        let mut params = serde_json::json!({ "clipId": clip_id });

        if let Some(track_id) = target_track_id {
            params["targetTrackId"] = serde_json::json!(track_id);
        }
        if let Some(off) = offset {
            params["offset"] = serde_json::json!(off);
        }

        Self::new("DuplicateClip", params)
    }

    /// Creates an AddTrack command
    pub fn add_track(track_type: &str, name: Option<&str>) -> Self {
        let mut params = serde_json::json!({ "type": track_type });

        if let Some(n) = name {
            params["name"] = serde_json::json!(n);
        }

        Self::new("AddTrack", params)
    }

    /// Creates a MuteTrack command
    pub fn mute_track(track_id: &str, muted: bool) -> Self {
        Self::new(
            "MuteTrack",
            serde_json::json!({
                "trackId": track_id,
                "muted": muted
            }),
        )
    }

    /// Creates an AddEffect command
    pub fn add_effect(clip_id: &str, effect_type: &str, params: serde_json::Value) -> Self {
        Self::new(
            "AddEffect",
            serde_json::json!({
                "clipId": clip_id,
                "effectType": effect_type,
                "params": params
            }),
        )
    }

    /// Creates an AddKeyframe command
    pub fn add_keyframe(
        clip_id: &str,
        param_path: &str,
        time: f64,
        value: serde_json::Value,
        easing: Option<&str>,
    ) -> Self {
        let mut params = serde_json::json!({
            "clipId": clip_id,
            "paramPath": param_path,
            "time": time,
            "value": value
        });

        if let Some(e) = easing {
            params["easing"] = serde_json::json!(e);
        }

        Self::new("AddKeyframe", params)
    }

    /// Creates an AddTransition command
    pub fn add_transition(
        clip_a_id: &str,
        clip_b_id: &str,
        transition_type: &str,
        duration: f64,
    ) -> Self {
        Self::new(
            "AddTransition",
            serde_json::json!({
                "clipAId": clip_a_id,
                "clipBId": clip_b_id,
                "type": transition_type,
                "duration": duration
            }),
        )
    }

    /// Sets the description
    pub fn with_description(mut self, description: &str) -> Self {
        self.description = Some(description.to_string());
        self
    }
}

// =============================================================================
// Requirement
// =============================================================================

/// A requirement for the edit script
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    /// Type of requirement
    pub kind: RequirementKind,
    /// Search query (for asset search)
    pub query: Option<String>,
    /// Provider (for downloads/generation)
    pub provider: Option<String>,
    /// Additional parameters
    pub params: Option<serde_json::Value>,
}

impl Requirement {
    /// Creates an asset search requirement
    pub fn asset_search(query: &str) -> Self {
        Self {
            kind: RequirementKind::AssetSearch,
            query: Some(query.to_string()),
            provider: None,
            params: None,
        }
    }

    /// Creates a generation requirement
    pub fn generate(provider: &str, params: serde_json::Value) -> Self {
        Self {
            kind: RequirementKind::Generate,
            query: None,
            provider: Some(provider.to_string()),
            params: Some(params),
        }
    }

    /// Creates a download requirement
    pub fn download(provider: &str, query: &str) -> Self {
        Self {
            kind: RequirementKind::Download,
            query: Some(query.to_string()),
            provider: Some(provider.to_string()),
            params: None,
        }
    }
}

/// Type of requirement
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RequirementKind {
    /// Search for existing assets
    AssetSearch,
    /// Generate new content
    Generate,
    /// Download from external source
    Download,
}

// =============================================================================
// Risk Assessment
// =============================================================================

/// Risk assessment for the edit script
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessment {
    /// Copyright risk level
    pub copyright: RiskLevel,
    /// NSFW risk level
    pub nsfw: NsfwRisk,
}

impl RiskAssessment {
    /// Creates a low-risk assessment
    pub fn low() -> Self {
        Self {
            copyright: RiskLevel::None,
            nsfw: NsfwRisk::None,
        }
    }

    /// Creates a medium-risk assessment
    pub fn medium() -> Self {
        Self {
            copyright: RiskLevel::Medium,
            nsfw: NsfwRisk::Possible,
        }
    }
}

/// Risk level
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    #[default]
    None,
    Low,
    Medium,
    High,
}

/// NSFW risk level
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NsfwRisk {
    #[default]
    None,
    Possible,
    Likely,
}

// =============================================================================
// Preview Plan
// =============================================================================

/// Plan for previewing the edit
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPlan {
    /// Time ranges to preview
    pub ranges: Vec<PreviewRange>,
    /// Whether full render is needed
    pub full_render: bool,
}

impl PreviewPlan {
    /// Creates a new preview plan
    pub fn new() -> Self {
        Self {
            ranges: Vec::new(),
            full_render: false,
        }
    }

    /// Adds a preview range
    pub fn add_range(mut self, start: f64, end: f64) -> Self {
        self.ranges.push(PreviewRange {
            start_sec: start,
            end_sec: end,
        });
        self
    }

    /// Marks as needing full render
    pub fn with_full_render(mut self) -> Self {
        self.full_render = true;
        self
    }
}

impl Default for PreviewPlan {
    fn default() -> Self {
        Self::new()
    }
}

/// A time range for preview
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRange {
    pub start_sec: f64,
    pub end_sec: f64,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_edit_script_creation() {
        let script = EditScript::new("Add intro clip");

        assert_eq!(script.intent, "Add intro clip");
        assert!(script.commands.is_empty());
        assert!(script.requires.is_empty());
    }

    #[test]
    fn test_edit_script_builder() {
        let script = EditScript::new("Add clips")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0))
            .add_command(EditCommand::insert_clip("track_1", "asset_2", 5.0))
            .with_explanation("Adding two clips sequentially");

        assert_eq!(script.command_count(), 2);
        assert_eq!(script.explanation, "Adding two clips sequentially");
    }

    #[test]
    fn test_edit_script_validation_empty() {
        let script = EditScript::new("");

        let result = script.validate();
        assert!(result.is_err());

        let errors = result.unwrap_err();
        assert!(errors.iter().any(|e| e.contains("Intent")));
        assert!(errors.iter().any(|e| e.contains("command")));
    }

    #[test]
    fn test_edit_script_validation_valid() {
        let script = EditScript::new("Add clip")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0));

        assert!(script.validate().is_ok());
    }

    #[test]
    fn test_edit_script_high_risk() {
        let mut script = EditScript::new("Test");
        script.risk.copyright = RiskLevel::High;

        assert!(script.has_high_risk());

        script.risk.copyright = RiskLevel::Low;
        script.risk.nsfw = NsfwRisk::Likely;

        assert!(script.has_high_risk());
    }

    #[test]
    fn test_edit_command_insert_clip() {
        let cmd = EditCommand::insert_clip("track_1", "asset_1", 5.0);

        assert_eq!(cmd.command_type, "InsertClip");
        assert_eq!(cmd.params["trackId"], "track_1");
        assert_eq!(cmd.params["assetId"], "asset_1");
        assert_eq!(cmd.params["timelineStart"], 5.0);
    }

    #[test]
    fn test_edit_command_split_clip() {
        let cmd = EditCommand::split_clip("clip_1", 10.0);

        assert_eq!(cmd.command_type, "SplitClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["atTimelineSec"], 10.0);
    }

    #[test]
    fn test_edit_command_delete_clip() {
        let cmd = EditCommand::delete_clip("clip_1");

        assert_eq!(cmd.command_type, "DeleteClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
    }

    #[test]
    fn test_edit_command_trim_clip() {
        let cmd = EditCommand::trim_clip("clip_1", Some(1.0), Some(9.0), None);

        assert_eq!(cmd.command_type, "TrimClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["newSourceIn"], 1.0);
        assert_eq!(cmd.params["newSourceOut"], 9.0);
        assert!(cmd.params.get("newTimelineIn").is_none());
    }

    #[test]
    fn test_edit_command_trim_clip_with_timeline() {
        let cmd = EditCommand::trim_clip("clip_1", None, None, Some(5.0));

        assert_eq!(cmd.command_type, "TrimClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert!(cmd.params.get("newSourceIn").is_none());
        assert!(cmd.params.get("newSourceOut").is_none());
        assert_eq!(cmd.params["newTimelineIn"], 5.0);
    }

    #[test]
    fn test_edit_command_move_clip() {
        let cmd = EditCommand::move_clip("clip_1", 15.0, Some("track_2"));

        assert_eq!(cmd.command_type, "MoveClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["newTimelineIn"], 15.0);
        assert_eq!(cmd.params["newTrackId"], "track_2");
    }

    #[test]
    fn test_edit_command_move_clip_same_track() {
        let cmd = EditCommand::move_clip("clip_1", 20.0, None);

        assert_eq!(cmd.command_type, "MoveClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["newTimelineIn"], 20.0);
        assert!(cmd.params.get("newTrackId").is_none());
    }

    #[test]
    fn test_requirement_asset_search() {
        let req = Requirement::asset_search("funny cat video");

        assert_eq!(req.kind, RequirementKind::AssetSearch);
        assert_eq!(req.query, Some("funny cat video".to_string()));
    }

    #[test]
    fn test_requirement_generate() {
        let req = Requirement::generate("dalle", serde_json::json!({ "prompt": "A sunset" }));

        assert_eq!(req.kind, RequirementKind::Generate);
        assert_eq!(req.provider, Some("dalle".to_string()));
    }

    #[test]
    fn test_requirement_download() {
        let req = Requirement::download("pexels", "ocean waves");

        assert_eq!(req.kind, RequirementKind::Download);
        assert_eq!(req.provider, Some("pexels".to_string()));
        assert_eq!(req.query, Some("ocean waves".to_string()));
    }

    #[test]
    fn test_preview_plan() {
        let plan = PreviewPlan::new()
            .add_range(0.0, 5.0)
            .add_range(10.0, 15.0)
            .with_full_render();

        assert_eq!(plan.ranges.len(), 2);
        assert!(plan.full_render);
    }

    #[test]
    fn test_edit_script_serialization() {
        let script = EditScript::new("Test")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0))
            .with_explanation("Test explanation");

        let json = serde_json::to_string(&script).unwrap();
        let parsed: EditScript = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.intent, script.intent);
        assert_eq!(parsed.commands.len(), script.commands.len());
        assert_eq!(parsed.explanation, script.explanation);
    }

    // -------------------------------------------------------------------------
    // New Helper Method Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_edit_command_ripple_delete() {
        let cmd = EditCommand::ripple_delete("clip_1", true);

        assert_eq!(cmd.command_type, "RippleDelete");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["affectAllTracks"], true);
    }

    #[test]
    fn test_edit_command_ripple_delete_single_track() {
        let cmd = EditCommand::ripple_delete("clip_2", false);

        assert_eq!(cmd.command_type, "RippleDelete");
        assert_eq!(cmd.params["clipId"], "clip_2");
        assert_eq!(cmd.params["affectAllTracks"], false);
    }

    #[test]
    fn test_edit_command_duplicate_clip() {
        let cmd = EditCommand::duplicate_clip("clip_1", Some("track_2"), Some(10.0));

        assert_eq!(cmd.command_type, "DuplicateClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["targetTrackId"], "track_2");
        assert_eq!(cmd.params["offset"], 10.0);
    }

    #[test]
    fn test_edit_command_duplicate_clip_defaults() {
        let cmd = EditCommand::duplicate_clip("clip_1", None, None);

        assert_eq!(cmd.command_type, "DuplicateClip");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert!(cmd.params.get("targetTrackId").is_none());
        assert!(cmd.params.get("offset").is_none());
    }

    #[test]
    fn test_edit_command_add_track() {
        let cmd = EditCommand::add_track("video", Some("Main Video"));

        assert_eq!(cmd.command_type, "AddTrack");
        assert_eq!(cmd.params["type"], "video");
        assert_eq!(cmd.params["name"], "Main Video");
    }

    #[test]
    fn test_edit_command_add_track_no_name() {
        let cmd = EditCommand::add_track("audio", None);

        assert_eq!(cmd.command_type, "AddTrack");
        assert_eq!(cmd.params["type"], "audio");
        assert!(cmd.params.get("name").is_none());
    }

    #[test]
    fn test_edit_command_mute_track() {
        let cmd = EditCommand::mute_track("track_1", true);

        assert_eq!(cmd.command_type, "MuteTrack");
        assert_eq!(cmd.params["trackId"], "track_1");
        assert_eq!(cmd.params["muted"], true);
    }

    #[test]
    fn test_edit_command_add_effect() {
        let cmd =
            EditCommand::add_effect("clip_1", "brightness", serde_json::json!({ "value": 20 }));

        assert_eq!(cmd.command_type, "AddEffect");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["effectType"], "brightness");
        assert_eq!(cmd.params["params"]["value"], 20);
    }

    #[test]
    fn test_edit_command_add_keyframe() {
        let cmd = EditCommand::add_keyframe(
            "clip_1",
            "opacity",
            0.0,
            serde_json::json!(0),
            Some("easeOut"),
        );

        assert_eq!(cmd.command_type, "AddKeyframe");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["paramPath"], "opacity");
        assert_eq!(cmd.params["time"], 0.0);
        assert_eq!(cmd.params["value"], 0);
        assert_eq!(cmd.params["easing"], "easeOut");
    }

    #[test]
    fn test_edit_command_add_keyframe_no_easing() {
        let cmd = EditCommand::add_keyframe("clip_1", "opacity", 2.0, serde_json::json!(100), None);

        assert_eq!(cmd.command_type, "AddKeyframe");
        assert_eq!(cmd.params["clipId"], "clip_1");
        assert_eq!(cmd.params["time"], 2.0);
        assert_eq!(cmd.params["value"], 100);
        assert!(cmd.params.get("easing").is_none());
    }

    #[test]
    fn test_edit_command_add_transition() {
        let cmd = EditCommand::add_transition("clip_1", "clip_2", "crossfade", 1.5);

        assert_eq!(cmd.command_type, "AddTransition");
        assert_eq!(cmd.params["clipAId"], "clip_1");
        assert_eq!(cmd.params["clipBId"], "clip_2");
        assert_eq!(cmd.params["type"], "crossfade");
        assert_eq!(cmd.params["duration"], 1.5);
    }

    #[test]
    fn test_edit_command_with_description() {
        let cmd = EditCommand::delete_clip("clip_1").with_description("Remove intro clip");

        assert_eq!(cmd.description, Some("Remove intro clip".to_string()));
    }
}
