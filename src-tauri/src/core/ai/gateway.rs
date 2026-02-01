//! AI Gateway Module
//!
//! Central gateway for AI operations including editing proposals,
//! content analysis, and script generation.

use std::sync::Arc;
use tokio::sync::RwLock;

use super::{
    edit_script::EditScript,
    provider::{AIProvider, CompletionRequest, CompletionResponse},
};
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Provider Runtime Status
// =============================================================================

/// Cached provider runtime status used for IPC/UI.
#[derive(Clone, Debug, Default)]
pub struct ProviderRuntimeStatus {
    pub provider_type: Option<String>,
    pub is_configured: bool,
    pub is_available: bool,
    pub current_model: Option<String>,
    pub available_models: Vec<String>,
    pub error_message: Option<String>,
}

// =============================================================================
// AI Gateway Configuration
// =============================================================================

/// Configuration for the AI Gateway
#[derive(Clone, Debug)]
pub struct AIGatewayConfig {
    /// Default model to use
    pub default_model: String,
    /// Maximum retries for failed requests
    pub max_retries: u32,
    /// Temperature for creative tasks
    pub creative_temperature: f32,
    /// Temperature for analytical tasks
    pub analytical_temperature: f32,
    /// Maximum tokens for script generation
    pub max_script_tokens: u32,
}

impl Default for AIGatewayConfig {
    fn default() -> Self {
        Self {
            default_model: "gpt-4".to_string(),
            max_retries: 3,
            creative_temperature: 0.8,
            analytical_temperature: 0.2,
            max_script_tokens: 4096,
        }
    }
}

// =============================================================================
// Edit Context
// =============================================================================

/// Context for AI edit operations
#[derive(Clone, Debug, Default)]
pub struct EditContext {
    /// Project name
    pub project_name: Option<String>,
    /// Current timeline duration in seconds
    pub timeline_duration: f64,
    /// Available asset IDs
    pub asset_ids: Vec<String>,
    /// Available track IDs
    pub track_ids: Vec<String>,
    /// Current playhead position
    pub playhead_position: f64,
    /// Selected clip IDs
    pub selected_clips: Vec<String>,
    /// Transcript text for context
    pub transcript_context: Option<String>,
}

impl EditContext {
    /// Creates a new empty context
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the timeline duration
    pub fn with_duration(mut self, duration: f64) -> Self {
        self.timeline_duration = duration;
        self
    }

    /// Adds asset IDs
    pub fn with_assets(mut self, asset_ids: Vec<String>) -> Self {
        self.asset_ids = asset_ids;
        self
    }

    /// Adds track IDs
    pub fn with_tracks(mut self, track_ids: Vec<String>) -> Self {
        self.track_ids = track_ids;
        self
    }

    /// Sets selected clips
    pub fn with_selection(mut self, clips: Vec<String>) -> Self {
        self.selected_clips = clips;
        self
    }

    /// Sets playhead position
    pub fn with_playhead(mut self, playhead_sec: f64) -> Self {
        self.playhead_position = playhead_sec;
        self
    }

    /// Sets transcript context
    pub fn with_transcript(mut self, transcript: &str) -> Self {
        self.transcript_context = Some(transcript.to_string());
        self
    }
}

// =============================================================================
// AI Gateway
// =============================================================================

/// Central gateway for AI operations
pub struct AIGateway {
    /// AI provider (Arc for shared ownership)
    provider: Arc<RwLock<Option<Arc<dyn AIProvider>>>>,
    /// Configuration
    config: AIGatewayConfig,
    /// Cached provider status
    status: Arc<RwLock<ProviderRuntimeStatus>>,
}

// =============================================================================
// System Prompt Constants
// =============================================================================

/// Base system prompt for AI edit script generation
const SYSTEM_PROMPT_BASE: &str = r#"You are an AI video editing assistant for OpenReelio. Generate valid EditScript JSON to accomplish editing tasks.

## CRITICAL RULES

1. **Only use IDs from context** - Never invent UUIDs. Only reference clipId, trackId, assetId values provided.
2. **Time in seconds** - All time values are floating-point SECONDS, not frames. Example: 5.5 = 5.5 seconds
3. **Command order matters** - Commands execute sequentially. Create before reference.
4. **Minimal operations** - Use the fewest commands to achieve the goal.

## EditScript Format

```json
{
  "intent": "User's request",
  "commands": [{ "commandType": "...", "params": {...} }],
  "requires": [],
  "qcRules": ["Verification steps"],
  "risk": { "copyright": "none", "nsfw": "none" },
  "explanation": "What this edit accomplishes"
}
```

## Timeline Commands

### InsertClip - Add asset to timeline
{ "commandType": "InsertClip", "params": { "trackId": "required", "assetId": "required", "timelineStart": number, "sourceIn"?: number, "sourceOut"?: number }}

### SplitClip - Split clip at time (creates {id}_split)
{ "commandType": "SplitClip", "params": { "clipId": "required", "atTimelineSec": number }}

### DeleteClip - Remove clip (leaves gap)
{ "commandType": "DeleteClip", "params": { "clipId": "required" }}

### RippleDelete - Delete and close gap
{ "commandType": "RippleDelete", "params": { "clipId": "required", "affectAllTracks"?: boolean }}

### TrimClip - Adjust in/out points
{ "commandType": "TrimClip", "params": { "clipId": "required", "newSourceIn"?: number, "newSourceOut"?: number, "newTimelineIn"?: number }}

### MoveClip - Reposition clip
{ "commandType": "MoveClip", "params": { "clipId": "required", "newTimelineIn": number, "newTrackId"?: string }}

### DuplicateClip - Clone clip
{ "commandType": "DuplicateClip", "params": { "clipId": "required", "targetTrackId"?: string, "offset"?: number }}

## Track Commands

### AddTrack
{ "commandType": "AddTrack", "params": { "type": "video|audio", "name"?: string }}

### MuteTrack
{ "commandType": "MuteTrack", "params": { "trackId": "required", "muted": boolean }}

## Effect Commands

### AddEffect
{ "commandType": "AddEffect", "params": { "clipId": "required", "effectType": string, "params": object }}

Effect types: brightness/contrast/saturation (-100 to 100), blur (radius: 0-100), opacity (0-100), fadeIn/fadeOut (duration: seconds), scale (x/y: %), rotate (angle: degrees)

## Keyframe Commands (ALWAYS need 2+ keyframes for animation)

### AddKeyframe
{ "commandType": "AddKeyframe", "params": { "clipId": "required", "paramPath": "e.g. opacity", "time": number, "value": any, "easing"?: "linear|easeIn|easeOut|easeInOut" }}

## Transition Commands (clips must be adjacent)

### AddTransition
{ "commandType": "AddTransition", "params": { "clipAId": "required", "clipBId": "required", "type": "crossfade|dissolve|wipe|fade", "duration": number }}

## Common Patterns

Remove section 10s-15s:
[SplitClip at 10s] -> [SplitClip at 15s on _split] -> [RippleDelete _split]

Fade in over 2s:
[AddKeyframe opacity=0 at t=0] -> [AddKeyframe opacity=100 at t=2 easeOut]

## FORBIDDEN
- Inventing IDs not in context
- Frame numbers (use seconds only)
- Single keyframe for animation
- Negative time values"#;

impl AIGateway {
    /// Creates a new AI gateway with no provider
    pub fn new(config: AIGatewayConfig) -> Self {
        Self {
            provider: Arc::new(RwLock::new(None)),
            config,
            status: Arc::new(RwLock::new(ProviderRuntimeStatus::default())),
        }
    }

    /// Creates a gateway with default configuration
    pub fn with_defaults() -> Self {
        Self::new(AIGatewayConfig::default())
    }

    /// Sets the AI provider
    pub async fn set_provider(&self, provider: impl AIProvider + 'static) {
        let mut guard = self.provider.write().await;
        let arc: Arc<dyn AIProvider> = Arc::new(provider);
        *guard = Some(Arc::clone(&arc));

        let mut status = self.status.write().await;
        status.provider_type = Some(arc.name().to_string());
        status.is_configured = arc.is_available();
        // Connectivity must be confirmed via health_check.
        status.is_available = false;
        status.error_message = None;
    }

    /// Sets the AI provider from a boxed trait object
    pub async fn set_provider_boxed(&self, provider: Box<dyn AIProvider>) {
        let mut guard = self.provider.write().await;
        let arc: Arc<dyn AIProvider> = Arc::from(provider);
        *guard = Some(Arc::clone(&arc));

        let mut status = self.status.write().await;
        status.provider_type = Some(arc.name().to_string());
        status.is_configured = arc.is_available();
        status.is_available = false;
        status.error_message = None;
    }

    /// Sets provider and status in one operation (used by IPC configuration).
    pub async fn set_provider_boxed_with_status(
        &self,
        provider: Box<dyn AIProvider>,
        status: ProviderRuntimeStatus,
    ) {
        let mut guard = self.provider.write().await;
        *guard = Some(Arc::from(provider));

        let mut status_guard = self.status.write().await;
        *status_guard = status;
    }

    /// Clears the current provider
    pub async fn clear_provider(&self) {
        let mut guard = self.provider.write().await;
        *guard = None;

        let mut status = self.status.write().await;
        *status = ProviderRuntimeStatus::default();
    }

    /// Checks if a provider is available
    pub async fn has_provider(&self) -> bool {
        let status = self.status.read().await;
        status.is_available
    }

    /// Returns whether a provider is configured (even if not currently reachable).
    pub async fn is_configured(&self) -> bool {
        let status = self.status.read().await;
        status.is_configured
    }

    /// Gets the provider name
    pub async fn provider_name(&self) -> Option<String> {
        let guard = self.provider.read().await;
        guard.as_ref().map(|p| p.name().to_string())
    }

    pub async fn provider_status(&self) -> ProviderRuntimeStatus {
        self.status.read().await.clone()
    }

    pub async fn update_provider_status(&self, is_available: bool, error_message: Option<String>) {
        let mut status = self.status.write().await;
        status.is_available = is_available;
        status.error_message = error_message;
    }

    // =========================================================================
    // Edit Script Generation
    // =========================================================================

    /// Generates an edit script from a user intent
    pub async fn generate_edit_script(
        &self,
        intent: &str,
        context: &EditContext,
    ) -> CoreResult<EditScript> {
        let provider = self.get_provider().await?;

        let system_prompt = self.build_system_prompt(context);
        let user_prompt = self.build_user_prompt(intent, context);

        let request = CompletionRequest::new(&user_prompt)
            .with_system(&system_prompt)
            .with_max_tokens(self.config.max_script_tokens)
            .with_temperature(self.config.creative_temperature)
            .with_json_mode();

        let response = self.complete_with_retry(provider.as_ref(), request).await?;

        self.parse_edit_script(&response.text, intent)
    }

    /// Analyzes content and suggests edits
    pub async fn analyze_and_suggest(&self, context: &EditContext) -> CoreResult<Vec<EditScript>> {
        let provider = self.get_provider().await?;

        let system_prompt = r#"You are a professional video editor AI assistant.
Analyze the provided context and suggest 3 different editing approaches.
Return JSON array of edit scripts."#;

        let context_json = serde_json::to_string_pretty(&serde_json::json!({
            "duration": context.timeline_duration,
            "assets": context.asset_ids.len(),
            "tracks": context.track_ids.len(),
            "hasTranscript": context.transcript_context.is_some(),
        }))
        .unwrap_or_default();

        let request = CompletionRequest::new(&format!(
            "Analyze this project and suggest editing improvements:\n{}",
            context_json
        ))
        .with_system(system_prompt)
        .with_max_tokens(self.config.max_script_tokens)
        .with_temperature(self.config.analytical_temperature)
        .with_json_mode();

        let response = self.complete_with_retry(provider.as_ref(), request).await?;

        self.parse_suggestions(&response.text)
    }

    /// Validates an edit script for safety and correctness
    pub async fn validate_script(&self, script: &EditScript) -> CoreResult<ValidationResult> {
        // Perform basic validation
        let mut issues = Vec::new();
        let mut warnings = Vec::new();

        // Check for empty commands
        if script.commands.is_empty() {
            issues.push("Script has no commands".to_string());
        }

        // Check for high risk
        if script.has_high_risk() {
            warnings.push("Script contains high-risk operations".to_string());
        }

        // Validate individual commands
        for (i, cmd) in script.commands.iter().enumerate() {
            if cmd.command_type.is_empty() {
                issues.push(format!("Command {} has empty type", i));
            }

            // Check for required parameters based on command type
            match cmd.command_type.as_str() {
                "InsertClip" => {
                    if cmd.params.get("trackId").is_none() {
                        issues.push(format!("InsertClip command {} missing trackId", i));
                    }
                    if cmd.params.get("assetId").is_none() {
                        issues.push(format!("InsertClip command {} missing assetId", i));
                    }
                    match cmd.params.get("timelineStart") {
                        None => issues.push(format!("InsertClip command {} missing timelineStart", i)),
                        Some(v) => match v.as_f64() {
                            Some(t) if t.is_finite() && t >= 0.0 => {}
                            _ => issues.push(format!(
                                "InsertClip command {} invalid timelineStart (must be finite, non-negative number)",
                                i
                            )),
                        },
                    }
                }
                "SplitClip" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("SplitClip command {} missing clipId", i));
                    }
                    match cmd.params.get("atTimelineSec") {
                        None => {
                            issues.push(format!("SplitClip command {} missing atTimelineSec", i))
                        }
                        Some(v) => match v.as_f64() {
                            Some(t) if t.is_finite() && t >= 0.0 => {}
                            _ => issues
                                .push(format!("SplitClip command {} invalid atTimelineSec", i)),
                        },
                    }
                }
                "DeleteClip" | "RippleDelete" | "DuplicateClip" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("{} command {} missing clipId", cmd.command_type, i));
                    }
                }
                "TrimClip" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("TrimClip command {} missing clipId", i));
                    }

                    // TrimClip must have at least one trim parameter
                    let has_source_in = cmd.params.get("newSourceIn").is_some();
                    let has_source_out = cmd.params.get("newSourceOut").is_some();
                    let has_timeline_in = cmd.params.get("newTimelineIn").is_some();

                    if !has_source_in && !has_source_out && !has_timeline_in {
                        issues.push(format!(
                            "TrimClip command {} must specify at least one of newSourceIn, newSourceOut, or newTimelineIn",
                            i
                        ));
                    }

                    // Validate numeric parameters if present
                    for param_name in ["newSourceIn", "newSourceOut", "newTimelineIn"] {
                        if let Some(v) = cmd.params.get(param_name) {
                            match v.as_f64() {
                                Some(t) if t.is_finite() && t >= 0.0 => {}
                                _ => issues.push(format!(
                                    "TrimClip command {} invalid {} (must be non-negative number)",
                                    i, param_name
                                )),
                            }
                        }
                    }
                }
                "MoveClip" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("MoveClip command {} missing clipId", i));
                    }
                    match cmd.params.get("newTimelineIn") {
                        None => {
                            issues.push(format!("MoveClip command {} missing newTimelineIn", i))
                        }
                        Some(v) => match v.as_f64() {
                            Some(t) if t.is_finite() && t >= 0.0 => {}
                            _ => {
                                issues.push(format!("MoveClip command {} invalid newTimelineIn", i))
                            }
                        },
                    }
                }
                "AddTrack" => match cmd.params.get("type") {
                    None => issues.push(format!("AddTrack command {} missing type", i)),
                    Some(v) => match v.as_str() {
                        Some("video") | Some("audio") => {}
                        _ => issues.push(format!(
                            "AddTrack command {} invalid type (must be 'video' or 'audio')",
                            i
                        )),
                    },
                },
                "MuteTrack" => {
                    if cmd.params.get("trackId").is_none() {
                        issues.push(format!("MuteTrack command {} missing trackId", i));
                    }
                    match cmd.params.get("muted") {
                        None => issues.push(format!("MuteTrack command {} missing muted", i)),
                        Some(v) if !v.is_boolean() => {
                            issues.push(format!(
                                "MuteTrack command {} invalid muted (must be boolean)",
                                i
                            ));
                        }
                        _ => {}
                    }
                }
                "DeleteTrack" | "LockTrack" => {
                    if cmd.params.get("trackId").is_none() {
                        issues.push(format!(
                            "{} command {} missing trackId",
                            cmd.command_type, i
                        ));
                    }
                }
                "AddEffect" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("AddEffect command {} missing clipId", i));
                    }
                    if cmd.params.get("effectType").is_none() {
                        issues.push(format!("AddEffect command {} missing effectType", i));
                    }
                    if cmd.params.get("params").is_none() {
                        issues.push(format!("AddEffect command {} missing params", i));
                    }
                }
                "AddKeyframe" => {
                    if cmd.params.get("clipId").is_none() {
                        issues.push(format!("AddKeyframe command {} missing clipId", i));
                    }
                    if cmd.params.get("paramPath").is_none() {
                        issues.push(format!("AddKeyframe command {} missing paramPath", i));
                    }
                    match cmd.params.get("time") {
                        None => issues.push(format!("AddKeyframe command {} missing time", i)),
                        Some(v) => match v.as_f64() {
                            Some(t) if t.is_finite() && t >= 0.0 => {}
                            _ => issues.push(format!(
                                "AddKeyframe command {} invalid time (must be non-negative number)",
                                i
                            )),
                        },
                    }
                    if cmd.params.get("value").is_none() {
                        issues.push(format!("AddKeyframe command {} missing value", i));
                    }
                }
                "AddTransition" => {
                    if cmd.params.get("clipAId").is_none() {
                        issues.push(format!("AddTransition command {} missing clipAId", i));
                    }
                    if cmd.params.get("clipBId").is_none() {
                        issues.push(format!("AddTransition command {} missing clipBId", i));
                    }
                    if cmd.params.get("type").is_none() {
                        issues.push(format!("AddTransition command {} missing type", i));
                    }
                    match cmd.params.get("duration") {
                        None => {
                            issues.push(format!("AddTransition command {} missing duration", i))
                        }
                        Some(v) => match v.as_f64() {
                            Some(d) if d.is_finite() && d > 0.0 => {}
                            _ => issues.push(format!(
                                "AddTransition command {} invalid duration (must be positive)",
                                i
                            )),
                        },
                    }
                }
                "UpdateEffect" | "RemoveEffect" | "UpdateKeyframe" | "DeleteKeyframe"
                | "RemoveTransition" | "AddCaption" | "ExportVideo" => {
                    // These commands have varying required params - basic validation only
                }
                _ => {
                    warnings.push(format!("Unknown command type: {}", cmd.command_type));
                }
            }
        }

        Ok(ValidationResult {
            is_valid: issues.is_empty(),
            issues,
            warnings,
        })
    }

    // =========================================================================
    // Text Analysis
    // =========================================================================

    /// Generates a summary of video content from transcript
    pub async fn summarize_content(&self, transcript: &str) -> CoreResult<String> {
        let provider = self.get_provider().await?;

        let request = CompletionRequest::new(&format!(
            "Summarize this video transcript in 2-3 sentences:\n\n{}",
            transcript
        ))
        .with_system("You are a content summarization assistant. Be concise and accurate.")
        .with_max_tokens(256)
        .with_temperature(0.3);

        let response = self.complete_with_retry(provider.as_ref(), request).await?;
        Ok(response.text)
    }

    /// Extracts key moments from a transcript
    pub async fn extract_key_moments(
        &self,
        _transcript: &str,
        timestamps: &[(f64, f64, String)],
    ) -> CoreResult<Vec<KeyMoment>> {
        let provider = self.get_provider().await?;

        let segments_json = timestamps
            .iter()
            .map(|(start, end, text)| {
                serde_json::json!({
                    "start": start,
                    "end": end,
                    "text": text
                })
            })
            .collect::<Vec<_>>();

        let request = CompletionRequest::new(&format!(
            "Identify key moments in this video. Return JSON array with start, end, and description:\n\n{}",
            serde_json::to_string_pretty(&segments_json).unwrap_or_default()
        ))
        .with_system("You are a video content analyst. Identify the most important moments.")
        .with_max_tokens(1024)
        .with_temperature(0.3)
        .with_json_mode();

        let response = self.complete_with_retry(provider.as_ref(), request).await?;

        self.parse_key_moments(&response.text)
    }

    // =========================================================================
    // Embeddings
    // =========================================================================

    /// Generates embeddings for text
    pub async fn embed_texts(&self, texts: Vec<String>) -> CoreResult<Vec<Vec<f32>>> {
        let provider = self.get_provider().await?;
        provider.embed(texts).await
    }

    // =========================================================================
    // Helper Methods
    // =========================================================================

    /// Gets the provider or returns an error
    async fn get_provider(&self) -> CoreResult<Arc<dyn AIProvider>> {
        let guard = self.provider.read().await;
        match guard.as_ref() {
            Some(p) => Ok(Arc::clone(p)),
            None => Err(CoreError::Internal("No AI provider configured".to_string())),
        }
    }

    /// Performs a lightweight health check for the configured provider.
    pub async fn health_check(&self) -> CoreResult<()> {
        let provider = self.get_provider().await?;
        provider.health_check().await
    }

    /// Completes a request with retry logic
    async fn complete_with_retry(
        &self,
        provider: &dyn AIProvider,
        request: CompletionRequest,
    ) -> CoreResult<CompletionResponse> {
        let mut last_error = None;

        for attempt in 0..self.config.max_retries {
            match provider.complete(request.clone()).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    last_error = Some(e);
                    if attempt < self.config.max_retries - 1 {
                        // Exponential backoff could be added here
                        tokio::time::sleep(tokio::time::Duration::from_millis(
                            100 * (2_u64.pow(attempt)),
                        ))
                        .await;
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| CoreError::Internal("Unknown error".to_string())))
    }

    /// Builds the system prompt for edit script generation
    fn build_system_prompt(&self, context: &EditContext) -> String {
        // Enhanced system prompt with comprehensive command reference
        let mut prompt = String::from(SYSTEM_PROMPT_BASE);

        // Add dynamic context information
        if !context.asset_ids.is_empty() {
            prompt.push_str("\n\n## Available Assets\n");
            for (i, id) in context.asset_ids.iter().take(20).enumerate() {
                prompt.push_str(&format!("- Asset {}: `{}`\n", i + 1, id));
            }
            if context.asset_ids.len() > 20 {
                prompt.push_str(&format!("... and {} more\n", context.asset_ids.len() - 20));
            }
        }

        if !context.track_ids.is_empty() {
            prompt.push_str("\n## Available Tracks\n");
            for id in &context.track_ids {
                prompt.push_str(&format!("- `{}`\n", id));
            }
        }

        prompt
    }

    /// Builds the user prompt
    fn build_user_prompt(&self, intent: &str, context: &EditContext) -> String {
        let mut prompt = format!("User intent: {}\n\n", intent);

        prompt.push_str(&format!(
            "Context:\n- Timeline duration: {:.2}s\n- Available assets: {}\n- Available tracks: {}\n",
            context.timeline_duration,
            context.asset_ids.len(),
            context.track_ids.len()
        ));

        if context.playhead_position > 0.0 {
            prompt.push_str(&format!("- Playhead: {:.2}s\n", context.playhead_position));
        }

        if !context.selected_clips.is_empty() {
            prompt.push_str(&format!(
                "- Selected clips: {}\n",
                context.selected_clips.join(", ")
            ));
        }

        if let Some(transcript) = &context.transcript_context {
            prompt.push_str(&format!(
                "\nTranscript excerpt:\n{}\n",
                transcript.chars().take(500).collect::<String>()
            ));
        }

        prompt.push_str("\nGenerate an EditScript to accomplish this intent.");
        prompt
    }

    /// Parses an edit script from JSON response
    fn parse_edit_script(&self, json: &str, _intent: &str) -> CoreResult<EditScript> {
        // Try to parse as JSON first
        if let Ok(script) = serde_json::from_str::<EditScript>(json) {
            return Ok(script);
        }

        // Try to extract JSON from markdown code blocks
        let json_str = if json.contains("```json") {
            json.split("```json")
                .nth(1)
                .and_then(|s| s.split("```").next())
                .unwrap_or(json)
        } else if json.contains("```") {
            json.split("```")
                .nth(1)
                .and_then(|s| s.split("```").next())
                .unwrap_or(json)
        } else {
            json
        };

        serde_json::from_str(json_str.trim()).map_err(|e| {
            // Return a minimal valid script if parsing fails
            CoreError::Internal(format!("Failed to parse edit script: {}", e))
        })
    }

    /// Parses suggestions from JSON response
    fn parse_suggestions(&self, json: &str) -> CoreResult<Vec<EditScript>> {
        // Try direct parsing
        if let Ok(scripts) = serde_json::from_str::<Vec<EditScript>>(json) {
            return Ok(scripts);
        }

        // Try extracting from code blocks
        let json_str = if json.contains("```json") {
            json.split("```json")
                .nth(1)
                .and_then(|s| s.split("```").next())
                .unwrap_or(json)
        } else {
            json
        };

        serde_json::from_str(json_str.trim())
            .map_err(|e| CoreError::Internal(format!("Failed to parse suggestions: {}", e)))
    }

    /// Parses key moments from JSON response
    fn parse_key_moments(&self, json: &str) -> CoreResult<Vec<KeyMoment>> {
        // Try direct parsing
        if let Ok(moments) = serde_json::from_str::<Vec<KeyMoment>>(json) {
            return Ok(moments);
        }

        // Try extracting from code blocks
        let json_str = if json.contains("```json") {
            json.split("```json")
                .nth(1)
                .and_then(|s| s.split("```").next())
                .unwrap_or(json)
        } else {
            json
        };

        serde_json::from_str(json_str.trim())
            .map_err(|e| CoreError::Internal(format!("Failed to parse key moments: {}", e)))
    }
}

impl Default for AIGateway {
    fn default() -> Self {
        Self::with_defaults()
    }
}

// =============================================================================
// Validation Result
// =============================================================================

/// Result of script validation
#[derive(Clone, Debug)]
pub struct ValidationResult {
    /// Whether the script is valid
    pub is_valid: bool,
    /// List of issues (errors)
    pub issues: Vec<String>,
    /// List of warnings
    pub warnings: Vec<String>,
}

// =============================================================================
// Key Moment
// =============================================================================

/// A key moment extracted from video content
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMoment {
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
    /// Description of the moment
    pub description: String,
    /// Importance score (0.0 - 1.0)
    #[serde(default)]
    pub importance: f64,
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ai::edit_script::EditCommand;
    use crate::core::ai::provider::MockAIProvider;

    // -------------------------------------------------------------------------
    // Configuration Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_config_default() {
        let config = AIGatewayConfig::default();

        assert_eq!(config.default_model, "gpt-4");
        assert_eq!(config.max_retries, 3);
        assert!(config.creative_temperature > 0.0);
        assert!(config.analytical_temperature < config.creative_temperature);
    }

    // -------------------------------------------------------------------------
    // Edit Context Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_edit_context_builder() {
        let context = EditContext::new()
            .with_duration(120.0)
            .with_assets(vec!["asset_1".to_string(), "asset_2".to_string()])
            .with_tracks(vec!["track_v".to_string(), "track_a".to_string()])
            .with_selection(vec!["clip_1".to_string()])
            .with_transcript("Hello world");

        assert_eq!(context.timeline_duration, 120.0);
        assert_eq!(context.asset_ids.len(), 2);
        assert_eq!(context.track_ids.len(), 2);
        assert_eq!(context.selected_clips.len(), 1);
        assert!(context.transcript_context.is_some());
    }

    // -------------------------------------------------------------------------
    // Gateway Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_gateway_creation() {
        let gateway = AIGateway::with_defaults();
        assert_eq!(gateway.config.max_retries, 3);
    }

    #[tokio::test]
    async fn test_gateway_provider_management() {
        let gateway = AIGateway::with_defaults();

        // Initially no provider
        assert!(!gateway.has_provider().await);
        assert!(gateway.provider_name().await.is_none());

        // Set provider
        let provider = MockAIProvider::new("test-provider");
        gateway.set_provider(provider).await;

        assert!(gateway.is_configured().await);
        assert!(!gateway.has_provider().await);

        // Mark as available (simulates a successful health check)
        gateway.update_provider_status(true, None).await;
        assert!(gateway.has_provider().await);
        assert_eq!(
            gateway.provider_name().await,
            Some("test-provider".to_string())
        );

        // Clear provider
        gateway.clear_provider().await;
        assert!(!gateway.has_provider().await);
        assert!(!gateway.is_configured().await);
    }

    #[tokio::test]
    async fn test_gateway_unavailable_provider() {
        let gateway = AIGateway::with_defaults();

        let provider = MockAIProvider::new("test").with_available(false);
        gateway.set_provider(provider).await;

        assert!(!gateway.is_configured().await);
        assert!(!gateway.has_provider().await);
    }

    // -------------------------------------------------------------------------
    // Validation Tests
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn test_validate_empty_script() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Test");

        let result = gateway.validate_script(&script).await.unwrap();

        assert!(!result.is_valid);
        assert!(!result.issues.is_empty());
    }

    #[tokio::test]
    async fn test_validate_valid_script() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Add clip")
            .add_command(EditCommand::insert_clip("track_1", "asset_1", 0.0));

        let result = gateway.validate_script(&script).await.unwrap();

        assert!(result.is_valid);
        assert!(result.issues.is_empty());
    }

    #[tokio::test]
    async fn test_validate_missing_params() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script
            .commands
            .push(EditCommand::new("InsertClip", serde_json::json!({})));

        let result = gateway.validate_script(&script).await.unwrap();

        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("trackId")));
        assert!(result.issues.iter().any(|i| i.contains("assetId")));
        assert!(result.issues.iter().any(|i| i.contains("timelineStart")));
    }

    #[tokio::test]
    async fn test_validate_unknown_command() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Test")
            .add_command(EditCommand::new("UnknownCommand", serde_json::json!({})));

        let result = gateway.validate_script(&script).await.unwrap();

        assert!(result.is_valid); // Unknown commands are warnings, not errors
        assert!(result.warnings.iter().any(|w| w.contains("Unknown")));
    }

    // -------------------------------------------------------------------------
    // Parse Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_edit_script_json() {
        let gateway = AIGateway::with_defaults();
        let json = r#"{
            "intent": "Add intro",
            "commands": [
                {
                    "commandType": "InsertClip",
                    "params": {"trackId": "v1", "assetId": "a1", "timelineStart": 0}
                }
            ],
            "requires": [],
            "qcRules": [],
            "risk": {"copyright": "none", "nsfw": "none"},
            "explanation": "Adding intro clip"
        }"#;

        let script = gateway.parse_edit_script(json, "Add intro").unwrap();

        assert_eq!(script.intent, "Add intro");
        assert_eq!(script.commands.len(), 1);
    }

    #[test]
    fn test_parse_edit_script_with_code_block() {
        let gateway = AIGateway::with_defaults();
        let json = r#"Here's the edit script:

```json
{
    "intent": "Add clip",
    "commands": [],
    "requires": [],
    "qcRules": [],
    "risk": {"copyright": "none", "nsfw": "none"},
    "explanation": "Test"
}
```

This will add the clip."#;

        let script = gateway.parse_edit_script(json, "Add clip").unwrap();
        assert_eq!(script.intent, "Add clip");
    }

    #[test]
    fn test_parse_key_moments() {
        let gateway = AIGateway::with_defaults();
        let json = r#"[
            {"start": 0.0, "end": 5.0, "description": "Introduction", "importance": 0.8},
            {"start": 30.0, "end": 45.0, "description": "Main point", "importance": 1.0}
        ]"#;

        let moments = gateway.parse_key_moments(json).unwrap();

        assert_eq!(moments.len(), 2);
        assert_eq!(moments[0].description, "Introduction");
        assert_eq!(moments[1].importance, 1.0);
    }

    // -------------------------------------------------------------------------
    // Prompt Building Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_build_user_prompt() {
        let gateway = AIGateway::with_defaults();
        let context = EditContext::new()
            .with_duration(60.0)
            .with_assets(vec!["a1".to_string()])
            .with_selection(vec!["c1".to_string()]);

        let prompt = gateway.build_user_prompt("Add transition", &context);

        assert!(prompt.contains("Add transition"));
        assert!(prompt.contains("60.00s"));
        assert!(prompt.contains("c1"));
    }

    #[test]
    fn test_build_user_prompt_with_transcript() {
        let gateway = AIGateway::with_defaults();
        let context = EditContext::new().with_transcript("Hello, welcome to the video.");

        let prompt = gateway.build_user_prompt("Summarize", &context);

        assert!(prompt.contains("Hello, welcome"));
    }

    // -------------------------------------------------------------------------
    // Enhanced Validation Tests
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn test_validate_add_track_valid() {
        let gateway = AIGateway::with_defaults();
        let script =
            EditScript::new("Add track").add_command(EditCommand::add_track("video", Some("Main")));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_add_track_invalid_type() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script.commands.push(EditCommand::new(
            "AddTrack",
            serde_json::json!({ "type": "invalid" }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("invalid type")));
    }

    #[tokio::test]
    async fn test_validate_mute_track_valid() {
        let gateway = AIGateway::with_defaults();
        let script =
            EditScript::new("Mute track").add_command(EditCommand::mute_track("track_1", true));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_mute_track_missing_muted() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script.commands.push(EditCommand::new(
            "MuteTrack",
            serde_json::json!({ "trackId": "track_1" }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("missing muted")));
    }

    #[tokio::test]
    async fn test_validate_add_effect_valid() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Add effect").add_command(EditCommand::add_effect(
            "clip_1",
            "brightness",
            serde_json::json!({ "value": 20 }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_add_effect_missing_params() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script.commands.push(EditCommand::new(
            "AddEffect",
            serde_json::json!({ "clipId": "clip_1", "effectType": "brightness" }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("missing params")));
    }

    #[tokio::test]
    async fn test_validate_add_keyframe_valid() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Add keyframe").add_command(EditCommand::add_keyframe(
            "clip_1",
            "opacity",
            0.0,
            serde_json::json!(0),
            None,
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_add_keyframe_negative_time() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script.commands.push(EditCommand::new(
            "AddKeyframe",
            serde_json::json!({
                "clipId": "clip_1",
                "paramPath": "opacity",
                "time": -1.0,
                "value": 100
            }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("invalid time")));
    }

    #[tokio::test]
    async fn test_validate_add_transition_valid() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Add transition").add_command(EditCommand::add_transition(
            "clip_1",
            "clip_2",
            "crossfade",
            1.0,
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_add_transition_zero_duration() {
        let gateway = AIGateway::with_defaults();
        let mut script = EditScript::new("Test");
        script.commands.push(EditCommand::new(
            "AddTransition",
            serde_json::json!({
                "clipAId": "clip_1",
                "clipBId": "clip_2",
                "type": "crossfade",
                "duration": 0.0
            }),
        ));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(!result.is_valid);
        assert!(result.issues.iter().any(|i| i.contains("invalid duration")));
    }

    #[tokio::test]
    async fn test_validate_move_clip_valid() {
        let gateway = AIGateway::with_defaults();
        let script =
            EditScript::new("Move clip").add_command(EditCommand::move_clip("clip_1", 10.0, None));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_split_clip_valid() {
        let gateway = AIGateway::with_defaults();
        let script =
            EditScript::new("Split clip").add_command(EditCommand::split_clip("clip_1", 5.0));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[tokio::test]
    async fn test_validate_ripple_delete_valid() {
        let gateway = AIGateway::with_defaults();
        let script = EditScript::new("Ripple delete")
            .add_command(EditCommand::ripple_delete("clip_1", true));

        let result = gateway.validate_script(&script).await.unwrap();
        assert!(result.is_valid);
    }

    #[test]
    fn test_build_system_prompt_contains_commands() {
        let gateway = AIGateway::with_defaults();
        let context = EditContext::new();

        let prompt = gateway.build_system_prompt(&context);

        // Verify system prompt contains key command references
        assert!(prompt.contains("InsertClip"));
        assert!(prompt.contains("SplitClip"));
        assert!(prompt.contains("RippleDelete"));
        assert!(prompt.contains("AddKeyframe"));
        assert!(prompt.contains("AddTransition"));
    }

    #[test]
    fn test_build_system_prompt_with_context() {
        let gateway = AIGateway::with_defaults();
        let context = EditContext::new()
            .with_assets(vec!["asset_1".to_string(), "asset_2".to_string()])
            .with_tracks(vec!["track_v1".to_string()]);

        let prompt = gateway.build_system_prompt(&context);

        // Verify context is included
        assert!(prompt.contains("asset_1"));
        assert!(prompt.contains("asset_2"));
        assert!(prompt.contains("track_v1"));
    }
}
