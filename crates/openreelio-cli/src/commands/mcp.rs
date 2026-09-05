//! MCP server surface for external AI agents.
//!
//! The server is read-only by default. Mutating tools appear either when the
//! host supplies a single-use approval token through the environment, or when
//! the operator starts the server with `--allow-write` — a local-trust switch
//! that trades per-call approval for an unattended edit loop.
//!
//! # Scope
//!
//! The server exposes exactly one project directory, and that directory is its
//! whole filesystem scope. Every path-typed tool argument resolves inside it
//! through [`confine_to_project`] — the server has no working directory a client
//! could reason about, and an unconfined path handed to FFmpeg would turn a
//! read-only server into a whole-disk existence oracle and an outbound-connection
//! primitive.
//!
//! A path that arrives as project state rather than as a tool argument — an
//! asset URI — is checked too ([`confine_asset_media`]), but against a
//! different rule: **locality, not location**. The app imports media by
//! reference and leaves it where the user put it, so requiring project-relative
//! media would refuse every GUI-authored project whose footage lives on a
//! camera dump or a shared drive — while protecting nothing, because the
//! sequence those same assets are cut into is already rendered and exported
//! from wherever the media lies. What is enforced is that this server must not
//! be the thing that reaches off-host: a UNC or network URI is refused
//! lexically, before anything stats it, and media that is not readable here is
//! refused rather than handed to FFmpeg.
//!
//! The one deliberate exception is the grant-gated plan surface: commands such as
//! `ImportAsset` name media anywhere the operator's user can read, because pulling
//! external footage into a project is what an editor does. That exception is
//! bounded by the confinement above — an out-of-tree path a plan writes into
//! project state still cannot be handed to FFmpeg by any tool on this server.
//!
//! None of this applies to the local CLI (`openreelio-cli transcription`,
//! `render`, `analysis`). There the operator's own shell already reaches the whole
//! filesystem, so confining the CLI would buy nothing and would break the normal
//! workflow of editing a project that references footage on another drive.

use crate::{
    commands::frame::{
        self, DEFAULT_AROUND_COUNT, DEFAULT_AROUND_SPAN_SEC, DEFAULT_MAX_WIDTH, MAX_CELL_SIZE_PX,
        MAX_GRID_CELLS, MAX_SHEET_DIMENSION_PX, MAX_STILL_WIDTH_PX, MIN_CELL_SIZE_PX,
        MIN_STILL_WIDTH_PX,
    },
    commands::{help_json, plan, render, transcription, verify},
    output,
};
// Decoding the images a tool returned is a test-only concern now that the
// encoding itself lives in the core's frame-probe artifacts.
#[cfg(test)]
use base64::Engine as _;
use clap::Args;
#[cfg(test)]
use openreelio_core::commands::SplitClipCommand;
use openreelio_core::commands::{get_text_data, is_text_clip, InsertMediaCommand};
use openreelio_core::ffmpeg::FFmpegRunner;
use openreelio_core::ipc::CommandPayload;
use openreelio_core::qc::verify::{
    VerifyArgumentNames, VerifyRequest, DEFAULT_FAIL_ON, DEFAULT_MEASURE_TIMEOUT_SEC,
};
#[cfg(test)]
use openreelio_core::render::frame_probe::frame_cache_dir;
use openreelio_core::render::frame_probe::media as frame_probe_media;
use openreelio_core::render::frame_probe::{
    allocate_frame_output, inline_frame_images, FrameArtifact, FrameOutput, MediaLocalityError,
    MAX_CACHED_FRAME_DIRECTORIES, MAX_INLINE_FRAME_STILLS,
};
use openreelio_core::render::{
    agent_render_dir, ensure_agent_render_range_within_cap, prune_agent_renders, ImageFormat,
    MAX_AGENT_RENDERS, MAX_AGENT_RENDER_RANGE_SEC,
};
use openreelio_core::style::{
    caption_pack_ids, text_preset_keys, transition_recipe_ids, TextPresetCategory, TEXT_PRESETS,
};
use openreelio_core::timeline::TrackKind;
use openreelio_core::TimeRange;
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Args)]
pub struct McpAction {
    /// Project directory path to expose through read-only tools
    #[arg(long)]
    pub project: Option<PathBuf>,

    /// Serve MCP JSON-RPC over stdio
    #[arg(long)]
    pub stdio: bool,

    /// Enable mutating tools without a per-call approval token
    ///
    /// Intended for a locally trusted client editing a local project; every
    /// mutation still goes through the command log and stays undoable.
    #[arg(long)]
    pub allow_write: bool,
}

#[derive(Clone, Debug, Default)]
struct McpServerState {
    project: Option<PathBuf>,
    allow_write: bool,
    client_name: Option<String>,
    client_version: Option<String>,
    approval_token: Option<String>,
    approval_expires_at_ms: Option<i64>,
    approval_expiry_error: Option<String>,
    approval_plan_id: Option<String>,
    approval_project_id: Option<String>,
    approval_runtime_id: Option<String>,
    approval_session_id: Option<String>,
    approval_consumed: Arc<Mutex<bool>>,
}

pub fn execute(action: McpAction) -> anyhow::Result<()> {
    let state = build_server_state(&action);

    if action.stdio {
        if state.allow_write {
            // The operator gave up per-call approval, so the only remaining
            // safeguard is who they let talk to this process. Say so once.
            eprintln!(
                "warning: --allow-write enables OpenReelio MCP mutations without per-call approval; use it only with a locally trusted client"
            );
        }
        serve_stdio(state)
    } else {
        output::print_json_pretty(&serde_json::json!({
            "server": {
                "name": "openreelio",
                "version": env!("CARGO_PKG_VERSION"),
                "transport": "stdio"
            },
            "command": build_discovery_command(&state),
            "tools": build_tools(&state),
            "resources": build_resources(),
            "policy": build_policy(&state)
        }))
    }
}

/// Builds the server state from the operator's flags and the host environment.
///
/// Every approval variable is read through the same empty-filter: an exported
/// but empty value is an unset value, never a grant. Reading the token any other
/// way would let `OPENREELIO_MCP_APPROVAL_TOKEN=""` pair with a request carrying
/// `"approvalToken": ""` and pass the equality check with no approval behind it.
fn build_server_state(action: &McpAction) -> McpServerState {
    let (approval_expires_at_ms, approval_expiry_error) = read_approval_expiry_from_env();
    McpServerState {
        project: action.project.clone(),
        allow_write: action.allow_write,
        client_name: None,
        client_version: None,
        approval_token: read_trimmed_env("OPENREELIO_MCP_APPROVAL_TOKEN"),
        approval_expires_at_ms,
        approval_expiry_error,
        approval_plan_id: read_trimmed_env("OPENREELIO_MCP_APPROVAL_PLAN_ID"),
        approval_project_id: read_trimmed_env("OPENREELIO_MCP_APPROVAL_PROJECT_ID"),
        approval_runtime_id: read_trimmed_env("OPENREELIO_MCP_APPROVAL_RUNTIME_ID"),
        approval_session_id: read_trimmed_env("OPENREELIO_MCP_APPROVAL_SESSION_ID"),
        approval_consumed: Arc::new(Mutex::new(false)),
    }
}

/// Command line an operator copies into a client config.
///
/// It has to reproduce the mode this discovery run reported, otherwise copying
/// it silently downgrades a local-write server to read-only.
fn build_discovery_command(state: &McpServerState) -> &'static str {
    if state.allow_write {
        "openreelio-cli mcp --stdio --project <project-path> --allow-write"
    } else {
        "openreelio-cli mcp --stdio --project <project-path>"
    }
}

/// The server's policy block: the single description of what this server may do.
///
/// Discovery and the stdio host context report the *same* object, because two
/// descriptions of one server are two chances to be wrong: before this was
/// shared, discovery called an `--allow-write` server `read-write-local` while
/// the host context called it `allow-write-local`, and both claimed
/// `project-readonly` filesystem access while the server was writing the
/// project. `approvalMode` is kept as an alias of `mode` for clients that read
/// the host context's original key name.
fn build_policy(state: &McpServerState) -> Value {
    let mode = policy_mode(state);
    serde_json::json!({
        "mode": mode,
        "approvalMode": mode,
        "mutations": if state.mutations_enabled() { "enabled" } else { "disabled" },
        "rawMediaAccess": if state.project.is_some() { "transcription-generate,frame-extract" } else { "none" },
        "cacheWrites": if state.project.is_some() { "frame-extract" } else { "none" },
        "filesystemAccess": filesystem_access(state)
    })
}

/// Names the grant the server is running under.
fn policy_mode(state: &McpServerState) -> &'static str {
    if state.allow_write {
        "allow-write-local"
    } else if state.has_active_approval_token() {
        "approve-mutations"
    } else {
        "read-only"
    }
}

/// Names what the server may do to the *project* — its state and command log.
///
/// Mutating tools write the project through the command log, so a server that
/// advertises them must not report read-only access. A path the *client* names
/// never reaches outside the project directory in any mode (see
/// [`confine_to_project`]); the project's own media is read wherever the
/// project says it lives, as long as it is on this machine (see
/// [`confine_asset_media`]), because that is what importing by reference means.
///
/// `project-readonly` is a claim about project state, not about every byte under
/// the directory: `openreelio.frame.extract` writes the stills it returns into
/// `.openreelio/cache/frames/`, which is derived data the project reconstructs
/// and the operator can delete. That write is disclosed separately as
/// `cacheWrites` rather than folded in here, because a client deciding whether
/// to trust the server with an edit is asking about the command log. The cache
/// bounds itself — every allocation through
/// `openreelio_core::render::frame_probe::allocate_frame_output` prunes the
/// cache down to its newest `MAX_CACHED_FRAME_DIRECTORIES` entries — so the
/// disclosure is of a fixed footprint rather than of unbounded growth.
fn filesystem_access(state: &McpServerState) -> &'static str {
    if state.project.is_none() {
        "none"
    } else if state.mutations_enabled() {
        "project-write"
    } else {
        "project-readonly"
    }
}

impl McpServerState {
    /// Whether mutating tools are available at all.
    ///
    /// `--allow-write` and an approval token are alternatives, not layers: the
    /// flag is an operator-level grant for the whole session, the token a
    /// host-issued grant for a single call.
    fn mutations_enabled(&self) -> bool {
        self.allow_write || self.has_active_approval_token()
    }

    fn has_active_approval_token(&self) -> bool {
        self.active_approval_token(None).is_ok()
    }

    fn active_approval_token(&self, plan_id: Option<&str>) -> Result<&str, ToolError> {
        // An empty token is not a grant. Filtering it here — not only where the
        // environment is read — keeps a directly constructed state honest too.
        let Some(token) = self
            .approval_token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
        else {
            return Err(ToolError::PermissionDenied(
                "This tool requires an approval token".to_string(),
            ));
        };

        if let Some(error) = &self.approval_expiry_error {
            return Err(ToolError::PermissionDenied(format!(
                "approvalToken expiry is invalid: {error}"
            )));
        }

        if let Some(expires_at_ms) = self.approval_expires_at_ms {
            if expires_at_ms <= current_time_millis() {
                return Err(ToolError::PermissionDenied(
                    "approvalToken is expired".to_string(),
                ));
            }
        }

        if *self.approval_consumed.lock().map_err(|_| {
            ToolError::PermissionDenied("approvalToken state is poisoned".to_string())
        })? {
            return Err(ToolError::PermissionDenied(
                "approvalToken has already been consumed".to_string(),
            ));
        }

        if let (Some(expected_plan_id), Some(actual_plan_id)) =
            (self.approval_plan_id.as_deref(), plan_id)
        {
            if expected_plan_id != actual_plan_id {
                return Err(ToolError::PermissionDenied(format!(
                    "approvalToken is scoped to plan '{expected_plan_id}', not '{actual_plan_id}'"
                )));
            }
        }

        Ok(token)
    }

    fn consume_approval_token(&self) -> Result<(), ToolError> {
        let mut consumed = self.approval_consumed.lock().map_err(|_| {
            ToolError::PermissionDenied("approvalToken state is poisoned".to_string())
        })?;
        if *consumed {
            return Err(ToolError::PermissionDenied(
                "approvalToken has already been consumed".to_string(),
            ));
        }
        *consumed = true;
        Ok(())
    }

    /// Checks the caller-supplied token against the host-issued grant.
    ///
    /// Both mutating tools authorize through this one path so an argument that
    /// is missing, empty, or simply wrong is rejected identically wherever it
    /// arrives; `plan_id` additionally holds the token to its plan scope.
    fn verify_approval_token(
        &self,
        arguments: &Value,
        plan_id: Option<&str>,
    ) -> Result<(), ToolError> {
        let expected_token = self.active_approval_token(plan_id)?;
        let actual_token = arguments
            .get("approvalToken")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| ToolError::PermissionDenied("approvalToken is required".to_string()))?;

        if actual_token != expected_token {
            return Err(ToolError::PermissionDenied(
                "approvalToken is invalid".to_string(),
            ));
        }

        Ok(())
    }

    /// Holds the token to the project the host scoped it to.
    ///
    /// Every mutating tool applies this: a grant issued for one project must not
    /// be spendable against whichever project this server happens to serve.
    fn ensure_token_project_scope(&self, project_id: &str) -> Result<(), ToolError> {
        if let Some(expected_project_id) = self.approval_project_id.as_deref() {
            if expected_project_id != project_id {
                return Err(ToolError::PermissionDenied(format!(
                    "approvalToken is scoped to project '{expected_project_id}', not '{project_id}'"
                )));
            }
        }

        Ok(())
    }

    fn ensure_media_insert_token_scope(&self, project_id: &str) -> Result<(), ToolError> {
        if let Some(plan_id) = self.approval_plan_id.as_deref() {
            return Err(ToolError::PermissionDenied(format!(
                "approvalToken is scoped to plan '{plan_id}' and cannot be used for openreelio.media.insert"
            )));
        }

        self.ensure_token_project_scope(project_id)
    }
}

fn current_time_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_approval_expiry_from_env() -> (Option<i64>, Option<String>) {
    let Ok(raw) = std::env::var("OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS") else {
        return (None, None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return (None, None);
    }

    match raw.parse::<i64>() {
        Ok(value) => (Some(value), None),
        Err(error) => (
            None,
            Some(format!(
                "OPENREELIO_MCP_APPROVAL_EXPIRES_AT_MS must be a unix epoch millisecond timestamp: {error}"
            )),
        ),
    }
}

fn read_trimmed_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn serve_stdio(state: McpServerState) -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                let response = jsonrpc_error(Value::Null, -32700, format!("Parse error: {error}"));
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let response = handle_jsonrpc_request(&state, request);
        if !response.is_null() {
            writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
            stdout.flush()?;
        }
    }

    Ok(())
}

fn handle_jsonrpc_request(state: &McpServerState, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => return jsonrpc_error(id, -32600, "Invalid JSON-RPC request"),
    };

    match method {
        "initialize" => jsonrpc_result(
            id,
            serde_json::json!({
                "protocolVersion": "2025-06-18",
                "serverInfo": {
                    "name": "openreelio",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "tools": {},
                    "resources": {}
                }
            }),
        ),
        "tools/list" => jsonrpc_result(id, serde_json::json!({ "tools": build_tools(state) })),
        "resources/list" => {
            jsonrpc_result(id, serde_json::json!({ "resources": build_resources() }))
        }
        "resources/read" => {
            let uri = request
                .pointer("/params/uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match read_resource(state, uri) {
                Ok(contents) => jsonrpc_result(id, serde_json::json!({ "contents": contents })),
                Err(error) => jsonrpc_error(id, -32602, error.to_string()),
            }
        }
        "tools/call" => {
            let name = request
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            match call_tool(state, name, arguments) {
                Ok(output) => jsonrpc_result(
                    id,
                    serde_json::json!({
                        "content": output.into_content(),
                        "isError": false
                    }),
                ),
                Err(ToolError::UnknownTool(message)) => jsonrpc_error(id, -32601, message),
                Err(ToolError::InvalidArguments(message)) => jsonrpc_error(id, -32602, message),
                Err(ToolError::PermissionDenied(message)) => jsonrpc_error(id, -32001, message),
                Err(ToolError::Execution(message)) => jsonrpc_error(id, -32000, message),
            }
        }
        "notifications/initialized" => Value::Null,
        _ => jsonrpc_error(id, -32601, format!("Method '{method}' is not supported")),
    }
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message.into(),
        },
    })
}

/// One successful tool result on the way to the wire.
///
/// Every tool returns a JSON document, and that document is always the last
/// content block, so a client that only reads text keeps working. A tool that
/// produces pictures — today only `openreelio.frame.extract` — attaches them as
/// MCP `image` blocks in front of it, which is what lets a vision model judge a
/// render without a filesystem tool to read the file back with.
///
/// A tool that attaches no image serialises exactly as it did before images
/// existed; see `should_keep_text_only_tool_results_unchanged`.
#[derive(Debug)]
struct ToolOutput {
    value: Value,
    images: Vec<ToolImage>,
}

/// One inline image content block.
#[derive(Debug)]
struct ToolImage {
    /// Base64-encoded image bytes, as the MCP `image` block carries them.
    data: String,
    mime_type: String,
}

impl ToolOutput {
    fn with_images(value: Value, images: Vec<ToolImage>) -> Self {
        Self { value, images }
    }

    /// Renders the result as MCP content blocks: images first, JSON last.
    fn into_content(self) -> Vec<Value> {
        let mut content: Vec<Value> = self
            .images
            .into_iter()
            .map(|image| {
                serde_json::json!({
                    "type": "image",
                    "data": image.data,
                    "mimeType": image.mime_type,
                })
            })
            .collect();

        content.push(serde_json::json!({
            "type": "text",
            "text": serde_json::to_string_pretty(&self.value).unwrap_or_else(|_| "{}".to_string())
        }));

        content
    }
}

impl From<Value> for ToolOutput {
    fn from(value: Value) -> Self {
        Self {
            value,
            images: Vec::new(),
        }
    }
}

#[derive(Debug)]
enum ToolError {
    UnknownTool(String),
    InvalidArguments(String),
    PermissionDenied(String),
    Execution(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownTool(message)
            | Self::InvalidArguments(message)
            | Self::PermissionDenied(message)
            | Self::Execution(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ToolError {}

/// Tools that only appear once mutations are allowed.
///
/// Named here rather than only where they are pushed, so the guard that reads
/// argument names out of the schemas can build the whole table and the
/// advertised list can be derived from it by removing these.
const MUTATING_TOOL_NAMES: [&str; 2] = ["openreelio.media.insert", "openreelio.plan.apply"];

/// The tools this server advertises to a client.
///
/// The mutating pair is filtered out of [`all_tool_schemas`] rather than left
/// unbuilt, because their schemas are needed either way: `tools/call` validates
/// arguments against them even on a read-only server, where the answer is a
/// permission refusal rather than a silent shrug at an unknown key.
fn build_tools(state: &McpServerState) -> Vec<Value> {
    let mut tools = all_tool_schemas(state);
    if !state.mutations_enabled() {
        tools.retain(|entry| {
            entry
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(|name| !MUTATING_TOOL_NAMES.contains(&name))
        });
    }
    tools
}

/// Every tool this server knows how to describe, mutating ones included.
fn all_tool_schemas(state: &McpServerState) -> Vec<Value> {
    let mut tools = vec![
        tool(
            "openreelio.host.context",
            "OpenReelio host context",
            "Read host identity, active project, UI defaults, capabilities, and read-only policy.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.project.info",
            "OpenReelio project info",
            "Read project metadata and save state.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.selection.read",
            "OpenReelio selection",
            "Read current timeline selection defaults for headless external clients.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.diagnostics.read",
            "OpenReelio diagnostics",
            "Read project warnings and validation diagnostics without mutation.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.timeline.snapshot",
            "OpenReelio timeline snapshot",
            "Read the timeline: tracks, clips, markers, and the where-to-look signals for each sequence — durationSec/outputDurationSec, fps and fpsRatio, canvas, editPoints (cut times), markers, transitions (each blend span centred on its cut, which no clip boundary gives you), and inspectionHints counts.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.assets.list",
            "OpenReelio assets",
            "Read asset metadata and missing/offline status.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.transcription.status",
            "OpenReelio transcription status",
            "Read local Whisper transcription readiness, model directory, and installed model inventory.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.transcription.generate",
            "OpenReelio transcription generation",
            "Generate speech-to-text transcript segments from a project asset or from the audible mix of a sequence.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "assetId": {
                        "type": "string",
                        "description": "Asset ID to transcribe when sequenceAudio is false."
                    },
                    "sequenceAudio": {
                        "type": "boolean",
                        "description": "Set true to transcribe the audible audio mix of a sequence instead of a single asset."
                    },
                    "sequenceId": {
                        "type": "string",
                        "description": "Sequence ID for sequenceAudio mode. Defaults to active sequence."
                    },
                    "language": {
                        "type": "string",
                        "description": "Language code such as auto, en, ko, ja, or zh. Defaults to auto."
                    },
                    "model": {
                        "type": "string",
                        "enum": ["auto", "tiny", "base", "small", "medium", "large", "large-v3", "large-v3-turbo", "large-v3-turbo-q5_0", "large-v3-turbo-q8_0", "large-v3-q5_0"],
                        "description": "Whisper model to use. Defaults to auto, which selects the best installed model. Every model except large produces DTW-aligned word timings; large (ggml-large.bin) keeps the cheaper heuristic ones because its filename does not pin a version."
                    },
                    "translate": { "type": "boolean" }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.annotation.read",
            "OpenReelio asset annotation",
            "Read cached objects/faces/OCR/shot annotations for one asset before choosing safe text or caption placement.",
            serde_json::json!({
                "type": "object",
                "required": ["assetId"],
                "properties": {
                    "assetId": { "type": "string" }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.command.schema",
            "OpenReelio command schema",
            "Read the command schema, text/caption workflows, and payload conventions available to external agents.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "openreelio.command.validate",
            "OpenReelio command validation",
            "Validate one backend command payload without executing it.",
            serde_json::json!({
                "type": "object",
                "required": ["commandType", "payload"],
                "properties": {
                    "commandType": { "type": "string" },
                    "payload": { "type": "object" }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.plan.validate",
            "OpenReelio plan validation",
            "Validate a multi-step command plan without executing it. Reports duplicate and missing step ids, dependency cycles, the step cap, and any payload that does not parse.",
            serde_json::json!({
                "type": "object",
                "required": ["plan"],
                "properties": {
                    "plan": plan_schema()
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.verify",
            "OpenReelio verify",
            "Run deterministic quality control over a sequence and, with 'file', over a rendered export. Every check that ran, was skipped, or errored is reported, so 'checked and clean' is distinguishable from 'never checked'. Per-check status is passed (ran, found nothing), warned (ran, warning/info findings only), failed (ran, error or critical findings), skipped, or errored; checks[].passed is true only for 'passed', while the top-level status/passed follow severity. Violations carry an executable suggestedFix plan; caption checks report one violation per track whose fix repairs every listed cue at once, so the loop does not have to be run once per caption.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "sequenceId": {
                        "type": "string",
                        "description": "Sequence to verify. Defaults to the active sequence."
                    },
                    "file": {
                        "type": "string",
                        "description": "Rendered file to measure for black/freeze/silence, EBU R128 loudness, peaks, and caption legibility. Must be inside the project directory; a relative path resolves against the project root and anything outside it is rejected, so render into the project before verifying. Without it only structural checks run and FFmpeg is never invoked. A whole-sequence render from timeline zero needs nothing else; to judge a PARTIAL render pass 'fileRange' with the timeline seconds it holds."
                    },
                    "fileRange": {
                        "type": "array",
                        "items": { "type": "number", "minimum": 0 },
                        "minItems": 2,
                        "maxItems": 2,
                        "description": "Timeline seconds 'file' holds, as [start, end] — the same pair openreelio.render.range reports and openreelio.frame.extract takes. Declaring it grades the render's length, black, freeze, silence and caption contrast against that window instead of against the whole sequence, and every rendered finding's timeRange is reported in TIMELINE seconds. Without it a partial render reads as a truncated deliverable and render.duration_mismatch fails the run. Only means something with 'file'."
                    },
                    "structuralOnly": {
                        "type": "boolean",
                        "description": "Run structural checks only and never touch FFmpeg. Cannot be combined with file."
                    },
                    "failOn": {
                        "type": "string",
                        "enum": ["info", "warning", "error", "critical"],
                        "description": "Lowest severity that marks the run as failed. Defaults to error."
                    },
                    "checks": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Check IDs to run exclusively; asset.license and sequence.duration are opt-in and only run when named here."
                    },
                    "skip": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Check IDs to disable."
                    },
                    "targetLufs": {
                        "type": "number",
                        "description": "Integrated loudness target in LUFS the rendered file is measured against. Only meaningful with 'file'."
                    },
                    "maxTruePeak": {
                        "type": "number",
                        "description": "Highest acceptable true peak in dBTP. Only meaningful with 'file'."
                    },
                    "durationToleranceSec": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Divergence tolerated between the rendered file's length and the sequence's, in seconds. Honoured exactly, so a tighter value really is tighter."
                    },
                    "timeoutSec": {
                        "type": "integer",
                        "minimum": 1,
                        "description": format!("Timeout for the rendered-file measurement pass, in seconds. Defaults to {DEFAULT_MEASURE_TIMEOUT_SEC}.")
                    }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.frame.extract",
            "OpenReelio frame extract",
            &format!("See the edit — and above all, see what you just changed. Right after applying an edit, call this with the affectedRanges it reported as ranges and grid:'auto': it samples only the seconds that moved and returns them as ONE contact sheet whose cells[] name their timecode and their reason. (affected:true reads the last recorded edit instead, which is a shared slot — pair it with afterOp when you use it.) Other event samplers answer the other standing questions without any arithmetic: atCuts for continuity (each cut gives the outgoing shot's last frame and the incoming shot's first), atTransitions for a blend's start/cut/end, atCaptions for readability (pass cellWidth 640 or more so the words are legible), atMarkers, perShot for coverage, and around+span for one moment in detail. Samplers combine, and 'limit' caps how many frames come back. Reach for 'between' — evenly spaced midpoints that land on no event at all — only when nothing event-driven fits. Timeline stills show the COMPOSITED edit by default: captions, text, transforms and blends, exactly what export produces. Without 'grid' the result is up to {MAX_INLINE_FRAME_STILLS} separate stills; with it, one sheet. Images are written into the project's own cache (.openreelio/cache/frames/) and their paths are reported; the caller does not choose where. The cache keeps only its {MAX_CACHED_FRAME_DIRECTORIES} newest entries, so use a reported path before it ages out. 'file' reads an already rendered video instead of the timeline and must be inside the project directory; to judge a partial render with the samplers, pass 'fileRange' [start, end] with the timeline range you rendered — the samplers then read those seconds of the timeline and every cell carries both fileSec and timelineSec."),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "time": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Single timeline time in seconds, or a time inside the file when 'file' is given."
                    },
                    "times": {
                        "type": "array",
                        "items": { "type": "number", "minimum": 0 },
                        "description": format!(
                            "Times in seconds. Without 'grid' each one returns its own still, capped at {MAX_INLINE_FRAME_STILLS}; with 'grid' the list becomes the sheet's cells, in the order given."
                        )
                    },
                    "grid": {
                        "type": "string",
                        "description": format!(
                            "Contact sheet layout as COLSxROWS (e.g. '4x3'), at most {MAX_GRID_CELLS} cells, and at most {MAX_SHEET_DIMENSION_PX}px on either finished edge. Or 'auto', which sizes the sheet from however many samples there turn out to be — use it with a sampler or with 'times'; 'between' still needs an explicit COLSxROWS. One sheet is one inline image however many cells it holds."
                        )
                    },
                    "affected": {
                        "type": "boolean",
                        "description": "Sample the timeline ranges the LAST applied edit changed: each range's start, its middle, its last frame, and both sides of every cut inside it. This is the post-apply look: run it straight after plan.apply or a mutating tool. The record is one slot every surface overwrites, including edits made in the app itself, so pass 'afterOp' with the operation id your own apply reported — or pass 'ranges' outright, which needs no record at all. Errors when nothing has been applied to this sequence yet, or when the last edit was on another sequence."
                    },
                    "afterOp": {
                        "type": "string",
                        "description": "Operation id the recorded hand-off must end at, from your own apply ('opId' / the last of plan.apply's 'operationIds'). Only with 'affected'. An edit applied after yours makes this a refusal naming both operations instead of a confident picture of somebody else's seconds."
                    },
                    "ranges": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "startSec": { "type": "number", "minimum": 0 },
                                "endSec": { "type": "number", "minimum": 0 }
                            },
                            "required": ["startSec", "endSec"],
                            "additionalProperties": false
                        },
                        "minItems": 1,
                        "description": "Sample these timeline ranges — the same samples 'affected' takes, over ranges you name. Pass the 'affectedRanges' your own edit reported: no record is read, so nothing another surface does in between can redirect the look. Cannot be combined with 'affected'."
                    },
                    "atCuts": {
                        "type": "boolean",
                        "description": "Sample both sides of every cut: the outgoing shot's last frame (cut - 1.5/fps, because seeks resolve forward) and the incoming shot's first. The continuity check."
                    },
                    "atTransitions": {
                        "type": "boolean",
                        "description": "Sample the start, the cut and the end of every two-input transition. None of those three is a clip boundary, so they cannot be derived from a clip list."
                    },
                    "atCaptions": {
                        "type": "boolean",
                        "description": "Sample the middle of every caption and text span — the settled frame, after any animation in. Pass cellWidth 640 or more when sheeting these, or the words are unreadable."
                    },
                    "atMarkers": {
                        "type": "boolean",
                        "description": "Sample every sequence marker."
                    },
                    "perShot": {
                        "type": "boolean",
                        "description": "Sample the middle of every shot on the video tracks the export includes. Coverage at a glance; pair with limit on a long sequence."
                    },
                    "around": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Sample a window centred on this timeline time in seconds — one moment in detail."
                    },
                    "span": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "description": format!("Half-width of the 'around' window in seconds (default {DEFAULT_AROUND_SPAN_SEC}). Only with 'around'.")
                    },
                    "aroundCount": {
                        "type": "integer",
                        "minimum": 1,
                        "description": format!("Number of 'around' samples, spread across the window including its edges (default {DEFAULT_AROUND_COUNT}). Only with 'around'.")
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "description": format!("Largest number of sampler times to keep. Over the limit the list is thinned evenly, keeping the first and last, and 'sampler.limited' reports it. Without 'grid' a sampler is capped at {MAX_INLINE_FRAME_STILLS} stills, so pass a limit at or under that.")
                    },
                    "between": {
                        "type": "array",
                        "items": { "type": "number", "minimum": 0 },
                        "minItems": 2,
                        "maxItems": 2,
                        "description": "Start and end seconds sampled evenly across the grid. Only with 'grid'."
                    },
                    "file": {
                        "type": "string",
                        "description": "Rendered video to read instead of the timeline, in the file's own timebase. Must be inside the project directory; a relative path resolves against the project root and anything outside it is rejected. Cannot be combined with sequenceId or mode. Add 'fileRange' to sample it with the event samplers."
                    },
                    "fileRange": {
                        "type": "array",
                        "items": { "type": "number", "minimum": 0 },
                        "minItems": 2,
                        "maxItems": 2,
                        "description": "The timeline range [start, end] the 'file' covers — the range you rendered. With a sampler this is what makes the samplers work on a render: they read the timeline over this range and every time is translated into the file as t - start, so cells carry BOTH fileSec and timelineSec plus their reason, and any sample the file turns out not to hold is dropped and counted as sampler.droppedOutsideFile. A cut sitting at the very start of the range is the one ordinary exception: its outgoing frame is a frame and a half earlier, before the file begins, so only the incoming side is shown and the miss is counted as sampler.droppedBeforeFile. Without a sampler it is only recorded as source.timelineRange; 'time', 'times' and 'between' stay file-relative either way. Only with 'file'."
                    },
                    "assetId": {
                        "type": "string",
                        "description": "Extract from this asset's OWN media timebase instead of the timeline — 'what does this footage look like at 12s', before it is cut. Requires 'sourceTime', and cannot be combined with any timeline selector (time, times, grid, between) or with a sampler. The asset's media must be readable on this machine and must not sit on a UNC or network path."
                    },
                    "sourceTime": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Time in seconds inside the asset's own media. Only with 'assetId'."
                    },
                    "sequenceId": {
                        "type": "string",
                        "description": "Sequence to read. Defaults to the active sequence."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["fast", "composite"],
                        "description": "Timeline extraction mode: composite (default) renders the full stack — captions, text, transforms, layered clips and blends — losslessly, reading an already rendered preview-cache segment when one covers the time; fast reads the topmost clip's own media only and shows none of the edit. Every still reports which it was as source: cache | composite | source."
                    },
                    "cellWidth": {
                        "type": "integer",
                        "minimum": MIN_CELL_SIZE_PX,
                        "maximum": MAX_CELL_SIZE_PX,
                        "description": "Contact sheet cell width in pixels (default 320). Only with 'grid'; alone it derives the height at 16:9."
                    },
                    "cellHeight": {
                        "type": "integer",
                        "minimum": MIN_CELL_SIZE_PX,
                        "maximum": MAX_CELL_SIZE_PX,
                        "description": "Contact sheet cell height in pixels (default 180). Only with 'grid'; alone it derives the width at 16:9."
                    },
                    "labelCells": {
                        "type": "boolean",
                        "description": "Burn each cell's index and timecode into the sheet, so a judgement can name the cell it is about. Only with 'grid'. Each label ends in the clock it quotes: 'tl' for a timeline second, 'file' for an offset into a rendered file. On a 'fileRange' sheet the burnt-in timecode is the TIMELINE second the cell shows, not the file offset; the file offset is still reported as cells[].fileSec."
                    },
                    "maxWidth": {
                        "type": "integer",
                        "minimum": MIN_STILL_WIDTH_PX,
                        "maximum": MAX_STILL_WIDTH_PX,
                        "description": format!("Maximum still width in pixels, {MIN_STILL_WIDTH_PX}-{MAX_STILL_WIDTH_PX}, aspect preserved and never upscaled. Defaults to {DEFAULT_MAX_WIDTH}.")
                    }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.render.range",
            "OpenReelio draft render",
            &format!("Render a range of the timeline to a draft video file, for the questions a still cannot answer: motion, pacing, whether a transition reads. The file lands in the project's own agent render cache (.openreelio/cache/renders/agent/) and the caller does not choose where; only the {MAX_AGENT_RENDERS} newest drafts are kept, so use the reported outputPath before it ages out. A draft is a look, not a deliverable: at most {MAX_AGENT_RENDER_RANGE_SEC:.0}s of timeline per call, so render around the moment in question rather than the whole edit. Then judge it without re-rendering: openreelio.frame.extract with {{file, between:[0, durationSec], grid:'4x3', labelCells:true}} sweeps the whole draft and always has something to show, and openreelio.frame.extract with {{file, fileRange:[start, start + durationSec], atCuts:true, grid:'auto'}} sheets the cuts when the rendered range holds any — a sampler over a range with no such event errors rather than returning an empty sheet. openreelio.verify with {{file, fileRange:[start, start + durationSec]}} measures black, freeze, silence, loudness, peaks and caption legibility over the same file — pass the fileRange or the draft reads as a truncated deliverable."),
            serde_json::json!({
                "type": "object",
                "required": ["start", "end"],
                "properties": {
                    "start": {
                        "type": "number",
                        "minimum": 0,
                        "description": "First timeline second of the range to render."
                    },
                    "end": {
                        "type": "number",
                        "minimum": 0,
                        "description": format!("Last timeline second of the range. Must be after 'start', and at most {MAX_AGENT_RENDER_RANGE_SEC:.0}s beyond it.")
                    },
                    "sequenceId": {
                        "type": "string",
                        "description": "Sequence to render. Defaults to the active sequence."
                    },
                    "preset": {
                        "type": "string",
                        "enum": [render::PROXY_PRESET_ID, render::DRAFT_PRESET_ID],
                        "description": format!("Draft preset. '{}' (default) is a 480p-class CRF 30 ultrafast proxy fitted to the sequence canvas — never pillarboxed. '{}' is a 720p draft, worth the extra encode time when judging the legibility of burned-in text.", render::PROXY_PRESET_ID, render::DRAFT_PRESET_ID)
                    }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "openreelio.preview.describe",
            "OpenReelio preview state",
            "Read non-sensitive preview state.",
            serde_json::json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
    ];

    tools.push(tool(
        "openreelio.media.insert",
        "OpenReelio media insert",
        "Insert a media asset through the drag-and-drop parity path: validates visible track placement, preserves source ranges, and creates linked audio for video assets.",
        serde_json::json!({
            "type": "object",
            "required": required_fields(state, &["sequenceId", "trackId", "assetId", "timelineStart"]),
            "properties": {
                "approvalToken": { "type": "string" },
                "sequenceId": { "type": "string" },
                "trackId": { "type": "string" },
                "assetId": { "type": "string" },
                "timelineStart": { "type": "number" },
                "sourceIn": { "type": "number" },
                "sourceOut": { "type": "number" },
                "audioOnly": {
                    "type": "boolean",
                    "description": "Set true only when intentionally placing a video asset as audio-only on an audio track."
                },
                "autoExtractLinkedAudio": {
                    "type": "boolean",
                    "description": "Defaults true for video assets on visual tracks."
                }
            },
            "additionalProperties": false
        }),
    ));
    tools.push(tool(
        "openreelio.plan.apply",
        "OpenReelio approved plan apply",
        "Apply a validated edit plan, including text/caption commands, through the OpenReelio command log path using an approval token. The whole plan is validated before anything is mutated, and a step failure rolls every applied step back.",
        serde_json::json!({
            "type": "object",
            "required": required_fields(state, &["plan"]),
            "properties": {
                "approvalToken": { "type": "string" },
                "plan": plan_schema()
            },
            "additionalProperties": false
        }),
    ));

    tools
}

/// JSON Schema for an [`plan::EditPlan`], shared by both plan tools.
///
/// Spelled out rather than left as an opaque object: a client that cannot see
/// the step shape has to guess it, and a guessed plan fails validation for
/// reasons the schema could have prevented. Nested objects stay open because
/// the deserializer tolerates unknown fields — a stricter schema than the
/// parser would reject plans that actually work.
fn plan_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "description": "An atomic edit plan. Every step is validated before any is applied, and a step failure rolls the whole plan back.",
        "required": ["id", "steps"],
        "properties": {
            "id": {
                "type": "string",
                "description": "Plan identifier. An approval token is scoped to this value."
            },
            "steps": {
                "type": "array",
                "maxItems": plan::MAX_PLAN_STEPS,
                "description": "Plan steps. Execution order comes from dependsOn, not array order; a dependency cycle rejects the plan.",
                "items": {
                    "type": "object",
                    "required": ["id", "commandType", "payload"],
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Step identifier, unique within the plan."
                        },
                        "commandType": {
                            "type": "string",
                            "description": "Backend command type, e.g. SplitClip. Call openreelio.command.schema for the supported list."
                        },
                        "payload": {
                            "type": "object",
                            "description": "Command payload for commandType, in the same shape openreelio.command.validate accepts."
                        },
                        "dependsOn": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Step ids that must complete first. Each must name a step in this plan."
                        }
                    }
                }
            }
        }
    })
}

/// Builds a mutating tool's `required` list.
///
/// `--allow-write` removes the per-call approval requirement, so the token must
/// also disappear from the schema; leaving it required would make every call an
/// argument error for a client that has no token to send.
fn required_fields(state: &McpServerState, fields: &[&str]) -> Vec<String> {
    let mut required = Vec::with_capacity(fields.len() + 1);
    if !state.allow_write {
        required.push("approvalToken".to_string());
    }
    required.extend(fields.iter().map(|field| (*field).to_string()));
    required
}

fn tool(name: &str, title: &str, description: &str, input_schema: Value) -> Value {
    serde_json::json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": input_schema,
    })
}

fn build_resources() -> Vec<Value> {
    vec![
        resource(
            "openreelio://host/context",
            "OpenReelio host context",
            "application/json",
        ),
        resource(
            "openreelio://timeline/snapshot",
            "OpenReelio timeline snapshot",
            "application/json",
        ),
        resource(
            "openreelio://command/schema",
            "OpenReelio command schema",
            "application/json",
        ),
    ]
}

fn resource(uri: &str, name: &str, mime_type: &str) -> Value {
    serde_json::json!({
        "uri": uri,
        "name": name,
        "mimeType": mime_type,
    })
}

fn read_resource(state: &McpServerState, uri: &str) -> Result<Vec<Value>, ToolError> {
    let value = match uri {
        "openreelio://host/context" => build_host_context(state),
        "openreelio://timeline/snapshot" => build_timeline_snapshot(state)?,
        "openreelio://command/schema" => build_command_schema(),
        other => {
            return Err(ToolError::InvalidArguments(format!(
                "Resource '{other}' is not available"
            )))
        }
    };

    Ok(vec![serde_json::json!({
        "uri": uri,
        "mimeType": "application/json",
        "text": serde_json::to_string_pretty(&value)
            .map_err(|error| ToolError::Execution(error.to_string()))?,
    })])
}

fn call_tool(
    state: &McpServerState,
    name: &str,
    arguments: Value,
) -> Result<ToolOutput, ToolError> {
    ensure_known_arguments(state, name, &arguments)?;

    // `openreelio.frame.extract` is the one tool that answers with pictures; the
    // rest hand back a JSON document that becomes a lone text block.
    if name == "openreelio.frame.extract" {
        return run_frame_extract_tool(state, arguments);
    }

    let value = match name {
        "openreelio.host.context" => Ok(build_host_context(state)),
        "openreelio.project.info" => build_project_info(state),
        "openreelio.selection.read" => Ok(build_selection()),
        "openreelio.diagnostics.read" => build_diagnostics(state),
        "openreelio.timeline.snapshot" => build_timeline_snapshot(state),
        "openreelio.assets.list" => build_assets_list(state),
        "openreelio.transcription.status" => Ok(serde_json::to_value(
            transcription::build_transcription_status(),
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?),
        "openreelio.transcription.generate" => generate_transcription(state, arguments),
        "openreelio.annotation.read" => build_annotation_read(state, arguments),
        "openreelio.command.schema" => Ok(build_command_schema()),
        "openreelio.command.validate" => validate_command(arguments),
        "openreelio.plan.validate" => validate_plan(arguments),
        "openreelio.verify" => run_verify_tool(state, arguments),
        "openreelio.render.range" => run_render_range_tool(state, arguments),
        "openreelio.media.insert" => apply_media_insert(state, arguments),
        "openreelio.plan.apply" => apply_plan(state, arguments),
        "openreelio.preview.describe" => Ok(build_preview_state()),
        other => Err(ToolError::UnknownTool(format!(
            "Tool '{other}' is not available"
        ))),
    }?;

    Ok(ToolOutput::from(value))
}

/// Rejects a `tools/call` carrying an argument the tool has no such thing as.
///
/// Most schemas here declare `additionalProperties: false`, but a schema is a
/// promise a client may or may not validate against — nothing on this side
/// enforced it, so `atCut: true` or `timeout_sec: 30` was accepted, silently
/// ignored, and answered with a confident result computed from the defaults.
/// Naming the key is the whole point: a typo and a genuinely unsupported
/// argument look identical to the caller until somebody says which key was not
/// recognised.
///
/// The known set is read from the tool's own schema rather than restated, so a
/// property added to a schema is accepted the moment it exists, and nested
/// objects that close themselves are checked too — `ranges[0].startSecs` is the
/// same typo one level down. A schema that stays open (the plan steps do, so a
/// plan the deserializer tolerates is not rejected by a stricter schema than the
/// parser) stops the walk there.
///
/// Every tool is checked, including the mutating pair a read-only server does
/// not advertise: their answer is otherwise "you may not do that" alone, and a
/// caller that fixes the grant then hits the same typo it was never told about.
/// This runs ahead of the grant check, so a call that is wrong in both ways is
/// reported as the argument error — the half the caller can fix on its own.
/// A tool this server does not have at all is left alone; the dispatcher reports
/// it as unknown, which is a better answer than a list of its arguments.
fn ensure_known_arguments(
    state: &McpServerState,
    name: &str,
    arguments: &Value,
) -> Result<(), ToolError> {
    let tools = all_tool_schemas(state);
    let Some(schema) = tools
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|entry| entry.get("inputSchema"))
    else {
        return Ok(());
    };

    ensure_object_matches_schema(name, arguments, schema)
}

/// Checks one value against one object schema, then recurses into whatever that
/// schema closes.
///
/// `subject` is what a refusal calls the thing being checked: the tool name at
/// the top, `<tool> ranges[0]` a level down, so a caller reads which object it
/// got wrong as well as which key.
fn ensure_object_matches_schema(
    subject: &str,
    value: &Value,
    schema: &Value,
) -> Result<(), ToolError> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    // Only schemas that closed themselves are enforced; an open one means the
    // tool deliberately accepts what it does not declare.
    if schema.get("additionalProperties") != Some(&Value::Bool(false)) {
        return Ok(());
    }
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };

    let mut unknown: Vec<&str> = object
        .keys()
        .filter(|key| !properties.contains_key(*key))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        let mut known: Vec<&str> = properties.keys().map(String::as_str).collect();
        known.sort_unstable();

        return Err(ToolError::InvalidArguments(format!(
            "{subject} has no argument named {}. It accepts: {}.",
            unknown.join(", "),
            if known.is_empty() {
                "no arguments".to_string()
            } else {
                known.join(", ")
            }
        )));
    }

    for (key, property) in properties {
        let Some(argument) = object.get(key) else {
            continue;
        };
        if argument.is_object() {
            ensure_object_matches_schema(&format!("{subject} {key}"), argument, property)?;
            continue;
        }
        let (Some(entries), Some(items)) = (argument.as_array(), property.get("items")) else {
            continue;
        };
        for (index, entry) in entries.iter().enumerate() {
            ensure_object_matches_schema(&format!("{subject} {key}[{index}]"), entry, items)?;
        }
    }

    Ok(())
}

fn generate_transcription(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    let Some(project_path) = state.project.as_ref() else {
        return Err(ToolError::InvalidArguments(
            "openreelio.transcription.generate requires mcp --project <project-path>".to_string(),
        ));
    };

    let language =
        optional_string_argument(&arguments, "language")?.unwrap_or_else(|| "auto".to_string());
    let model =
        optional_string_argument(&arguments, "model")?.unwrap_or_else(|| "auto".to_string());
    let translate = optional_bool_argument(&arguments, "translate")?.unwrap_or(false);
    let sequence_audio = optional_bool_argument(&arguments, "sequenceAudio")?.unwrap_or(false);
    let project = super::load_project(project_path).map_err(|error| {
        ToolError::Execution(format!(
            "Failed to open project '{}': {error}",
            project_path.display()
        ))
    })?;
    let output = if sequence_audio {
        let sequence_id = super::resolve_sequence_id(
            &project,
            optional_string_argument(&arguments, "sequenceId")?,
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?;
        confine_sequence_media(&project, &sequence_id)?;
        serde_json::to_value(
            transcription::generate_sequence_transcription(
                &project,
                &sequence_id,
                &language,
                &model,
                translate,
            )
            .map_err(|error| ToolError::Execution(error.to_string()))?,
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?
    } else {
        let asset_id = required_string_argument(&arguments, "assetId")?;
        confine_asset_media(&project, &asset_id)?;
        serde_json::to_value(
            transcription::generate_asset_transcription(
                &project, &asset_id, &language, &model, translate,
            )
            .map_err(|error| ToolError::Execution(error.to_string()))?,
        )
        .map_err(|error| ToolError::Execution(error.to_string()))?
    };

    Ok(output)
}

/// Checks one asset's media before FFmpeg is asked to read it.
///
/// Deliberately *not* a project-directory confinement, unlike the rule
/// [`confine_to_project`] applies to client-supplied paths. The app imports
/// media by reference: the file stays where the user put it, and
/// [`Asset::resolved_path`](openreelio_core::assets::Asset::resolved_path)
/// hands back that original absolute path. Requiring it to live inside the
/// project refused every project the GUI ever authored — the ordinary case,
/// footage on a camera dump or a shared drive — while protecting nothing, since
/// the sequence those assets are cut into is already rendered, previewed and
/// exported from wherever the media lies.
///
/// What is enforced is what this server itself adds: it must not be the thing
/// that reaches off-host. A UNC or network path is refused lexically, before
/// anything stats it, because on Windows the stat *is* the outbound SMB
/// connection and the NTLM handshake that leaks with it. Media that is not
/// readable here is refused too, so the client is told the footage is missing
/// rather than reading an FFmpeg error about a file it cannot see.
///
/// Neither error names the resolved path: a rejection must not be readable as
/// an existence oracle for whatever the URI pointed at.
fn confine_asset_media(
    project: &openreelio_core::ActiveProject,
    asset_id: &str,
) -> Result<(), ToolError> {
    frame_probe_media::check_asset_media(&project.path, &project.state, asset_id)
        .map_err(media_locality_error)
}

/// Maps a shared media-locality refusal onto this surface's error kinds.
///
/// The distinction is worth keeping: reaching off-host is a policy decision
/// this server makes, while media that is simply not on the machine is an
/// environment failure whose fix is to reconnect a drive.
fn media_locality_error(error: MediaLocalityError) -> ToolError {
    match error {
        MediaLocalityError::OffHost { .. } => ToolError::PermissionDenied(error.to_string()),
        MediaLocalityError::Unreadable { .. } => ToolError::Execution(error.to_string()),
    }
}

/// Checks every asset a sequence's render will read.
///
/// The render graph covers the whole sequence, so every asset it references is
/// checked rather than the audible or visible subset alone: which layers
/// survive muting and trimming is the graph's decision, and media this machine
/// cannot read — or must not reach for — is worth refusing before FFmpeg is
/// spawned at all.
fn confine_sequence_media(
    project: &openreelio_core::ActiveProject,
    sequence_id: &str,
) -> Result<(), ToolError> {
    frame_probe_media::check_sequence_media(&project.path, &project.state, sequence_id)
        .map_err(media_locality_error)
}

fn build_host_context(state: &McpServerState) -> Value {
    let project = load_project_summary(state);
    let approval_grant = build_approval_grant_context(state);
    serde_json::json!({
        "host": {
            "appId": "openreelio",
            "appName": "OpenReelio",
            "appVersion": env!("CARGO_PKG_VERSION"),
            "surface": "external-mcp-client",
            "os": std::env::consts::OS,
            "locale": std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string()),
            "clientInfo": {
                "name": state.client_name,
                "version": state.client_version
            }
        },
        "project": project,
        "ui": {
            "activePanel": "headless",
            "playheadSeconds": 0.0,
            "selectedClipIds": [],
            "selectedTrackIds": [],
            "selectedRange": Value::Null,
            "visibleTimelineRange": Value::Null,
            "previewState": "idle"
        },
        "capabilities": {
            "timelineRead": true,
            "commandValidate": true,
            "planValidate": true,
            "transcriptionGenerate": true,
            "transcriptionStatus": true,
            "verify": true,
            "mediaInsertWithApproval": state.mutations_enabled(),
            "planApplyWithApproval": state.mutations_enabled(),
            "previewFrameRead": false,
            "diagnosticsRead": true,
            "renderControl": false
        },
        "policy": build_policy(state),
        "approvalGrant": approval_grant
    })
}

fn build_approval_grant_context(state: &McpServerState) -> Value {
    let (consumed, state_error) = match state.approval_consumed.lock() {
        Ok(consumed) => (*consumed, Value::Null),
        Err(_) => (true, serde_json::json!("approvalToken state is poisoned")),
    };

    serde_json::json!({
        "available": state.has_active_approval_token(),
        "consumed": consumed,
        "expiresAtMs": state.approval_expires_at_ms,
        "expiryError": state.approval_expiry_error,
        "scopes": {
            "planId": state.approval_plan_id,
            "projectId": state.approval_project_id,
            "runtimeId": state.approval_runtime_id,
            "sessionId": state.approval_session_id
        },
        "stateError": state_error
    })
}

fn load_project_summary(state: &McpServerState) -> Value {
    let Some(path) = &state.project else {
        return serde_json::json!({
            "projectId": Value::Null,
            "projectName": Value::Null,
            "projectKind": "video-editing-project",
            "saveState": "unknown",
            "available": false,
        });
    };

    match super::load_project(path) {
        Ok(project) => serde_json::json!({
            "projectId": project.state.meta.id,
            "projectName": project.state.meta.name,
            "projectKind": "video-editing-project",
            "saveState": if project.state.is_dirty { "dirty" } else { "clean" },
            "available": true,
            "activeSequenceId": project.state.active_sequence_id,
        }),
        Err(error) => serde_json::json!({
            "projectId": Value::Null,
            "projectName": Value::Null,
            "projectKind": "video-editing-project",
            "saveState": "unknown",
            "available": false,
            "error": error.to_string(),
        }),
    }
}

fn build_project_info(state: &McpServerState) -> Result<Value, ToolError> {
    let Some(path) = &state.project else {
        return Ok(serde_json::json!({
            "available": false,
            "reason": "No project path was provided"
        }));
    };
    let project =
        super::load_project(path).map_err(|error| ToolError::Execution(error.to_string()))?;
    Ok(serde_json::json!({
        "available": true,
        "id": project.state.meta.id,
        "name": project.state.meta.name,
        "path": path.display().to_string(),
        "activeSequenceId": project.state.active_sequence_id,
        "assetCount": project.state.assets.len(),
        "sequenceCount": project.state.sequences.len(),
        "opCount": project.state.op_count,
        "lastOpId": project.state.last_op_id,
        "isDirty": project.state.is_dirty,
    }))
}

fn build_selection() -> Value {
    serde_json::json!({
        "selectedClipIds": [],
        "selectedTrackIds": [],
        "selectedRange": Value::Null,
        "playheadSeconds": 0.0,
        "source": "headless-default"
    })
}

fn build_diagnostics(state: &McpServerState) -> Result<Value, ToolError> {
    let mut warnings = Vec::new();
    let Some(path) = &state.project else {
        warnings.push("No project path was provided".to_string());
        return Ok(serde_json::json!({
            "status": "warning",
            "warnings": warnings,
            "errors": [],
        }));
    };

    let project =
        super::load_project(path).map_err(|error| ToolError::Execution(error.to_string()))?;
    let missing_assets: Vec<Value> = project
        .state
        .assets
        .values()
        .filter(|asset| asset.missing)
        .map(|asset| {
            serde_json::json!({
                "id": asset.id,
                "name": asset.name,
                "kind": format!("{:?}", asset.kind),
            })
        })
        .collect();

    if !missing_assets.is_empty() {
        warnings.push(format!("{} asset(s) are missing", missing_assets.len()));
    }

    Ok(serde_json::json!({
        "status": if warnings.is_empty() { "ok" } else { "warning" },
        "warnings": warnings,
        "errors": [],
        "missingAssets": missing_assets,
    }))
}

fn build_timeline_snapshot(state: &McpServerState) -> Result<Value, ToolError> {
    let Some(path) = &state.project else {
        return Ok(serde_json::json!({
            "available": false,
            "reason": "No project path was provided",
            "sequences": []
        }));
    };
    let project =
        super::load_project(path).map_err(|error| ToolError::Execution(error.to_string()))?;
    let active_sequence_id = project.state.active_sequence_id.clone();
    let sequences: Vec<Value> = project
        .state
        .sequences
        .iter()
        .map(|(sequence_id, sequence)| {
            let tracks: Vec<Value> = sequence
                .tracks
                .iter()
                .map(|track| {
                    let clips: Vec<Value> = track
                        .clips
                        .iter()
                        .map(|clip| {
                            let mut clip_snapshot = serde_json::json!({
                                "id": clip.id,
                                "assetId": clip.asset_id,
                                "label": clip.label,
                                "timelineInSec": clip.place.timeline_in_sec,
                                "durationSec": clip.place.duration_sec,
                                "sourceInSec": clip.range.source_in_sec,
                                "sourceOutSec": clip.range.source_out_sec,
                                "speed": clip.speed,
                                "enabled": clip.enabled,
                                "opacity": clip.opacity,
                                "transform": clip.transform,
                                "effectIds": clip.effects,
                            });

                            if let Some(object) = clip_snapshot.as_object_mut() {
                                if is_text_clip(clip) {
                                    object.insert(
                                        "kind".to_string(),
                                        Value::String("text".to_string()),
                                    );
                                    object.insert(
                                        "textData".to_string(),
                                        get_text_data(clip, &project.state)
                                            .and_then(|data| serde_json::to_value(data).ok())
                                            .unwrap_or(Value::Null),
                                    );
                                } else if matches!(&track.kind, TrackKind::Caption)
                                    || clip.caption_style.is_some()
                                    || clip.caption_position.is_some()
                                {
                                    object.insert(
                                        "kind".to_string(),
                                        Value::String("caption".to_string()),
                                    );
                                    object.insert(
                                        "captionStyle".to_string(),
                                        clip.caption_style.clone().unwrap_or(Value::Null),
                                    );
                                    object.insert(
                                        "captionPosition".to_string(),
                                        clip.caption_position.clone().unwrap_or(Value::Null),
                                    );
                                    object.insert(
                                        "text".to_string(),
                                        Value::String(clip.label.clone().unwrap_or_default()),
                                    );
                                } else {
                                    object.insert(
                                        "kind".to_string(),
                                        Value::String("media".to_string()),
                                    );
                                }
                            }

                            clip_snapshot
                        })
                        .collect();
                    serde_json::json!({
                        "id": track.id,
                        "name": track.name,
                        "kind": format!("{:?}", track.kind),
                        "muted": track.muted,
                        "locked": track.locked,
                        "visible": track.visible,
                        "clipCount": clips.len(),
                        "clips": clips,
                    })
                })
                .collect();
            // Where-to-look signals: duration, frame rate, cut times, marker
            // times, transition spans and the caption/text spans. A transition
            // blends across the cut rather than along a clip, so no reader can
            // derive its span from the clip list below it. The whole summary is
            // published, exactly as `timeline info` publishes it: an agent that
            // reads the snapshot instead of the CLI must not have to reassemble
            // the caption spans from the clip list to ask the same question.
            let summary =
                openreelio_core::timeline::inspection_summary(sequence, &project.state.effects);
            serde_json::json!({
                "id": sequence_id,
                "name": sequence.name,
                "isActive": active_sequence_id.as_deref() == Some(sequence_id.as_str()),
                "trackCount": tracks.len(),
                "markerCount": sequence.markers.len(),
                "durationSec": summary.duration_sec,
                "outputDurationSec": summary.output_duration_sec,
                "fps": summary.fps,
                "fpsRatio": summary.fps_ratio,
                "canvas": summary.canvas,
                "editPoints": summary.edit_points,
                "cuts": summary.cuts,
                "markers": summary.markers,
                "transitions": summary.transitions,
                "captionSpans": summary.caption_spans,
                "textSpans": summary.text_spans,
                "inspectionHints": summary.inspection_hints,
                "tracks": tracks,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "available": true,
        "activeSequenceId": active_sequence_id,
        "sequences": sequences,
    }))
}

fn build_assets_list(state: &McpServerState) -> Result<Value, ToolError> {
    let Some(path) = &state.project else {
        return Ok(serde_json::json!({
            "available": false,
            "reason": "No project path was provided",
            "assets": []
        }));
    };
    let project =
        super::load_project(path).map_err(|error| ToolError::Execution(error.to_string()))?;
    let assets: Vec<Value> = project
        .state
        .assets
        .values()
        .map(|asset| {
            let has_annotation = annotation_path(path, &asset.id)
                .map(|annotation_path| annotation_path.exists())
                .unwrap_or(false);
            serde_json::json!({
                "id": asset.id,
                "name": asset.name,
                "kind": format!("{:?}", asset.kind),
                "durationSec": asset.duration_sec,
                "fileSize": asset.file_size,
                "missing": asset.missing,
                "workspaceManaged": asset.workspace_managed,
                "hasAnnotation": has_annotation,
                "tags": asset.tags,
            })
        })
        .collect();

    Ok(serde_json::json!({
        "available": true,
        "count": assets.len(),
        "assets": assets,
    }))
}

fn build_annotation_read(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    let Some(path) = &state.project else {
        return Ok(serde_json::json!({
            "status": "error",
            "message": "No project path was provided"
        }));
    };
    let asset_id = arguments
        .get("assetId")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments("assetId is required".to_string()))?;

    let asset_id = validate_annotation_asset_id(asset_id)?;
    let annotation = load_annotation_for_asset(path, asset_id)?;
    Ok(serde_json::json!({
        "status": "ok",
        "assetId": asset_id,
        "available": annotation.is_some(),
        "annotation": annotation,
    }))
}

fn validate_annotation_asset_id(asset_id: &str) -> Result<&str, ToolError> {
    let trimmed = asset_id.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArguments(
            "assetId is required".to_string(),
        ));
    }

    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err(ToolError::InvalidArguments(
            "assetId may only contain ASCII letters, numbers, hyphens, and underscores".to_string(),
        ));
    }

    Ok(trimmed)
}

/// Locates one asset's cached annotation inside the project directory.
///
/// The asset ID is already restricted to characters that cannot form a path, so
/// the confinement pass is defence in depth: it keeps this lookup on the same
/// enforced scope as every other path the server touches.
fn annotation_path(project_dir: &Path, asset_id: &str) -> Result<PathBuf, ToolError> {
    let asset_id = validate_annotation_asset_id(asset_id)?;
    let relative = Path::new(".openreelio")
        .join("annotations")
        .join(format!("{asset_id}.json"));
    confine_to_project(project_dir, "assetId", &relative.to_string_lossy())
}

fn load_annotation_for_asset(
    project_dir: &std::path::Path,
    asset_id: &str,
) -> Result<Option<Value>, ToolError> {
    let path = annotation_path(project_dir, asset_id)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path).map_err(|error| {
        ToolError::Execution(format!(
            "Failed to read annotation '{}': {error}",
            path.display()
        ))
    })?;
    serde_json::from_str::<Value>(&content)
        .map(Some)
        .map_err(|error| {
            ToolError::Execution(format!(
                "Failed to deserialize annotation '{}': {error}",
                path.display()
            ))
        })
}

/// Text preset ids whose anchor is part of the template, not a suggestion.
///
/// Smart placement moves an overlay it believes is a title, a lower third, a
/// subtitle, or a callout. Everything else — credits, brand marks, creative
/// treatments — was placed deliberately by the preset, so the category decides
/// this rather than a hand-kept list of ids.
fn template_placement_text_preset_ids() -> Vec<&'static str> {
    TEXT_PRESETS
        .iter()
        .filter(|preset| {
            matches!(
                preset.category,
                TextPresetCategory::Credit
                    | TextPresetCategory::Brand
                    | TextPresetCategory::Creative
            )
        })
        .map(|preset| preset.id)
        .collect()
}

/// One line per text preset: what it is for, and how long it usually runs.
///
/// Reading the catalog out of the registry is what keeps a hint from
/// advertising a preset the parser rejects.
fn text_preset_catalog_line() -> Vec<String> {
    TEXT_PRESETS
        .iter()
        .map(|preset| {
            format!(
                "{} ({}, ~{}s): {}",
                preset.id,
                preset.category.as_str(),
                preset.default_duration_sec,
                preset.description
            )
        })
        .collect()
}

fn build_command_schema() -> Value {
    // Read the curated ids from the core registries rather than restating them:
    // a pack added to core shows up in the hints, and a hint can never name an
    // id the validator would reject.
    let caption_style_pack_ids = caption_pack_ids();
    let transition_recipe_ids = transition_recipe_ids();
    let text_preset_keys = text_preset_keys();
    let template_placement_preset_ids = template_placement_text_preset_ids();
    let text_preset_catalog = text_preset_catalog_line();

    serde_json::json!({
        "commands": CommandPayload::SUPPORTED_COMMAND_TYPES,
        "count": CommandPayload::SUPPORTED_COMMAND_TYPES.len(),
        "cli": help_json::build_schema(),
        "payloadHints": {
            "CreateTrack": {
                "required": ["sequenceId", "kind", "name"],
                "optional": ["position"],
                "note": "Use kind video or overlay for editable text clips. AddTextClip requires a target video/overlay track; create one first when no suitable upper text track exists."
            },
            "SetCaptionTrackLanguage": {
                "required": ["sequenceId", "trackId", "language"],
                "note": "Use this for caption tracks only. Language should be a BCP-47-ish code such as en, ko, ja, zh, es, or en-us."
            },
            "InsertClip": {
                "required": ["sequenceId", "trackId", "assetId", "timelineStart"],
                "optional": ["sourceIn", "sourceOut"],
                "note": "Raw InsertClip is primitive and does not auto-create linked audio. Use openreelio.media.insert for normal media placement so video remains visible and linked audio stays in sync."
            },
            "ImportGeneratedCaptions": {
                "required": ["sequenceId", "trackId", "segments"],
                "optional": ["stylePack", "style", "position", "replaceExisting"],
                "segmentShape": { "startSec": "number", "endSec": "number", "text": "string" },
                "styleShape": "Caption style may include fontFamily, fontSize, fontWeight, bold, italic, underline, color, opacity, backgroundColor, backgroundPadding, outlineColor, outlineWidth, shadowColor, shadowOffsetX, shadowOffsetY, shadowBlur, alignment, lineHeight, and letterSpacing.",
                "positionShape": "Caption position supports preset top/center/bottom or custom xPercent/yPercent.",
                "stylePackHints": caption_style_pack_ids,
                "stylePackShape": "stylePack names a curated caption pack that is applied as the base layer; style and position override it key by key. Every pack is checked to stay inside the title-safe area on both 1920x1080 and 1080x1920.",
                "note": "Use this for AI/STT transcript segments so generated captions are imported atomically and remain undoable as one command. Prefer stylePack over hand-assembled style values unless the brief needs something no pack expresses."
            },
            "CreateCaption": {
                "required": ["sequenceId", "trackId", "text", "startSec", "endSec"],
                "optional": ["stylePack", "style", "position"],
                "stylePackHints": caption_style_pack_ids,
                "stylePackShape": "stylePack names a curated caption pack that is applied as the base layer; style and position override it key by key.",
                "note": "Use this for individual caption lines. UpdateCaption accepts the same stylePack field, where it restyles WITHOUT moving the caption: an update keeps the existing anchor unless it also carries an explicit position."
            },
            "AddEffect": {
                "required": ["sequenceId", "trackId", "clipId"],
                "optional": ["effectType", "recipe", "params", "keyframes", "position"],
                "recipeHints": transition_recipe_ids,
                "recipeShape": "recipe names a curated transition recipe and supplies both effectType and its baseline params (duration, offset, direction, fade_in); anything in params overrides the recipe key by key. Naming a recipe and a contradictory effectType is rejected.",
                "note": "Transitions are effects: there is no AddTransition command. Either effectType or recipe must be present. fade-out is anchored on the clip's tail when the command is executed, so pass params.start_time only to place the fade somewhere else."
            },
            "transcriptionGenerate": {
                "tool": "openreelio.transcription.generate",
                "required": [],
                "optional": ["assetId", "sequenceAudio", "sequenceId", "language", "model", "translate"],
                "note": "sequenceAudio=true transcribes the audible edited timeline mix and returns TIMELINE-relative segment times that pass straight to ImportGeneratedCaptions; this is the default path for captioning. assetId transcribes one source asset and returns SOURCE-relative times (0-based to the asset) that are NOT safe as direct timeline caption times; map them to the placed clip before ImportGeneratedCaptions."
            },
            "transcriptionStatus": {
                "tool": "openreelio.transcription.status",
                "required": [],
                "optional": [],
                "note": "Use this read-only MCP tool to check whether local Whisper is compiled in and which model files are installed."
            },
            "AddTextClip": {
                "required": ["sequenceId", "trackId", "timelineIn", "duration"],
                "optional": ["preset", "textData"],
                "textDataShape": "TextClipData includes content, style(fontFamily/fontSize/fontWeight/color/backgroundColor/backgroundPadding/alignment/bold/italic/underline/lineHeight/letterSpacing), position(x/y 0..1), shadow(color/offsetX/offsetY/blur), outline(color/width), rotation, and opacity.",
                "presetHints": text_preset_keys,
                "presetShape": "preset names a curated text preset that supplies the whole TextClipData; textData then carries only what overrides it, commonly just content, and may be omitted entirely. Every id and alias listed here is accepted by this payload and by `text add --preset`. Nested layers merge key by key, so {\"style\":{\"bold\":false}} or {\"shadow\":{\"offsetX\":2}} keeps everything else the preset chose.",
                "presetCatalog": text_preset_catalog,
                "note": "Either preset or textData must be present: without a preset, textData is required and must be complete. Text clips must be placed on a video or overlay track. Use SetClipTransform after creation when scale or anchor must be exact."
            },
            "UpdateTextClip": {
                "required": ["sequenceId", "trackId", "clipId", "textData"],
                "note": "Send the full updated TextClipData so style, position, shadow, outline, rotation, and opacity remain deterministic."
            },
            "SetClipTransform": {
                "required": ["sequenceId", "trackId", "clipId", "transform"],
                "transformShape": "transform includes position{x,y}, scale{x,y}, rotationDeg, and anchor{x,y}; text clips use this for preview drag/resize/rotate parity.",
                "note": "Renders in the final export for every visual clip, not just in the preview: position, scale, rotationDeg and anchor are all composited onto the canvas. SetClipOpacity likewise renders. Motion keyframes (SetClipMotionKeyframes) still render static at the clip's base transform and the render reports a warning saying so."
            }
        },
        "mediaWorkflows": {
            "timelinePlacement": [
                "Use openreelio.media.insert when approval is available and the task places a media asset on the timeline.",
                "Target video/image assets to video or overlay tracks and audio assets to audio tracks.",
                "Do not put a video asset on an audio track unless audioOnly=true is intentional; that creates an audio-only clip and will not show in preview.",
                "Let autoExtractLinkedAudio default to true for video assets with audio."
            ]
        },
        "textWorkflows": {
            "editableOverlay": [
                "Read timeline.snapshot to find the active sequence, existing text clips, and usable video/overlay tracks.",
                "Read annotation.read for overlapping source assets when placement should avoid faces, objects, or OCR text.",
                "CreateTrack(kind=\"video\" or \"overlay\") when there is no unlocked non-overlapping text track above the media.",
                "AddTextClip with a preset id, or with a complete TextClipData for content, typography, color, background, shadow, outline, position, rotation, and opacity when no preset fits.",
                "Prefer preset plus a content override over hand-assembled typography; see presetCatalog under payloadHints.AddTextClip for what each id is for.",
                "SetClipTransform for exact drag/resize/rotate placement using normalized position, scale, rotationDeg, and anchor; it renders in the final export as well as in the preview."
            ],
            "timedSubtitles": [
                "Call openreelio.transcription.status first and explain missing model installation before attempting automatic subtitles.",
                "If no model is installed, tell the user to install one through the OpenReelio UI or `openreelio-cli transcription install --model large-v3-turbo-q5_0` before transcription.generate.",
                "Prefer openreelio.transcription.generate(sequenceAudio=true, sequenceId, language=\"auto\", model=\"auto\") as the default captioning path: its segment times are TIMELINE-relative and reflect cuts, trims, overlaps, and volume, so they pass straight to ImportGeneratedCaptions.",
                "Use openreelio.transcription.generate(assetId, language=\"auto\", model=\"auto\") for source-asset analysis only: its times are SOURCE-relative (0-based to the asset) and must be mapped to the placed clip before ImportGeneratedCaptions, not used as direct timeline caption times.",
                "Use ImportGeneratedCaptions for AI transcript segments or CreateCaption/UpdateCaption for individual caption lines.",
                "Pass stylePack (a curated caption pack id) rather than assembling caption typography field by field; the packs are the checked quality floor and stay inside the title-safe area on landscape and vertical canvases alike.",
                "Use caption style/position metadata for subtitle readability instead of editable overlay text when the user wants semantic subtitles."
            ],
            "placementDefaults": {
                "subtitle": "Bottom center around y=0.85 with outline/shadow unless it covers important visual content.",
                "title": "Center or upper third depending on the shot composition.",
                "lowerThird": "Lower-left or lower-center with enough safe margin and readable contrast.",
                "creditBrand": format!(
                    "These presets preserve their template position unless the user asks for automatic placement: {}.",
                    template_placement_preset_ids.join(", ")
                )
            }
        },
        "payloadFormat": {
            "commandType": "PascalCase backend command type",
            "payload": "camelCase JSON object matching the command payload"
        }
    })
}

fn required_string_argument(arguments: &Value, key: &str) -> Result<String, ToolError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| ToolError::InvalidArguments(format!("{key} is required")))
}

fn optional_string_argument(arguments: &Value, key: &str) -> Result<Option<String>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| Ok(Some(value.to_string())))
        .unwrap_or_else(|| {
            Err(ToolError::InvalidArguments(format!(
                "{key} must be a non-empty string when provided"
            )))
        })
}

fn optional_string_array_argument(
    arguments: &Value,
    key: &str,
) -> Result<Option<Vec<String>>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let items = value.as_array().ok_or_else(|| {
        ToolError::InvalidArguments(format!("{key} must be an array of strings when provided"))
    })?;

    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| {
                    ToolError::InvalidArguments(format!(
                        "{key} must contain only non-empty strings"
                    ))
                })
        })
        .collect::<Result<Vec<String>, ToolError>>()
        .map(Some)
}

fn optional_non_negative_number_array(
    arguments: &Value,
    key: &str,
) -> Result<Option<Vec<f64>>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let items = value.as_array().ok_or_else(|| {
        ToolError::InvalidArguments(format!("{key} must be an array of numbers when provided"))
    })?;

    items
        .iter()
        .map(|item| {
            item.as_f64()
                .filter(|number| number.is_finite() && *number >= 0.0)
                .ok_or_else(|| {
                    ToolError::InvalidArguments(format!(
                        "{key} must contain only finite non-negative numbers"
                    ))
                })
        })
        .collect::<Result<Vec<f64>, ToolError>>()
        .map(Some)
}

/// Reads a pixel dimension: a whole number of at least one pixel.
fn optional_pixel_argument(arguments: &Value, key: &str) -> Result<Option<u32>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    value
        .as_u64()
        .filter(|pixels| *pixels >= 1)
        .and_then(|pixels| u32::try_from(pixels).ok())
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!(
                "{key} must be a whole number of pixels of at least 1"
            ))
        })
}

fn optional_bool_argument(arguments: &Value, key: &str) -> Result<Option<bool>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value.as_bool().map(Some).ok_or_else(|| {
        ToolError::InvalidArguments(format!("{key} must be a boolean when provided"))
    })
}

fn required_non_negative_number(arguments: &Value, key: &str) -> Result<f64, ToolError> {
    let value = arguments
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| ToolError::InvalidArguments(format!("{key} is required")))?;
    if !value.is_finite() || value < 0.0 {
        return Err(ToolError::InvalidArguments(format!(
            "{key} must be a finite non-negative number"
        )));
    }
    Ok(value)
}

fn optional_non_negative_number(arguments: &Value, key: &str) -> Result<Option<f64>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(number) = value.as_f64() else {
        return Err(ToolError::InvalidArguments(format!(
            "{key} must be a number"
        )));
    };
    if !number.is_finite() || number < 0.0 {
        return Err(ToolError::InvalidArguments(format!(
            "{key} must be a finite non-negative number"
        )));
    }
    Ok(Some(number))
}

// ── Filesystem scope ────────────────────────────────────────────────────────

/// Resolves a client-supplied path argument inside the served project directory.
///
/// The project directory is the server's entire filesystem scope, so a relative
/// path is joined onto the project root — an MCP server is spawned by its host
/// and has no working directory a client could reason about — and anything that
/// would land outside is rejected: an absolute path elsewhere on disk, a `..`
/// escape, a UNC/device path, a URL, or a symlink pointing out of the project.
///
/// Rejection is lexical *before* it is filesystem-based, which is the point of
/// the helper. These paths are handed to FFmpeg, so a path that reached the
/// filesystem first would answer "does this file exist?" for the whole disk and,
/// for a UNC path, make the server open an outbound network connection — both
/// from a server advertising itself as read-only.
///
/// Returns the resolved absolute path.
/// Reads an optional finite number, of either sign.
///
/// `targetLufs` and `maxTruePeak` are both negative in every realistic value,
/// so the non-negative reader cannot serve them.
fn optional_finite_number(arguments: &Value, key: &str) -> Result<Option<f64>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    value
        .as_f64()
        .filter(|number| number.is_finite())
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!("{key} must be a finite number when provided"))
        })
}

/// Reads an optional whole number of seconds, at least one.
fn optional_positive_seconds(arguments: &Value, key: &str) -> Result<Option<u64>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    value
        .as_u64()
        .filter(|seconds| *seconds >= 1)
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!(
                "{key} must be a whole number of seconds of at least 1 when provided"
            ))
        })
}

fn confine_to_project(
    project_root: &Path,
    key: &str,
    requested: &str,
) -> Result<PathBuf, ToolError> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArguments(format!(
            "{key} must not be empty"
        )));
    }

    if trimmed.contains("://") {
        return Err(ToolError::PermissionDenied(format!(
            "{key} must be a filesystem path inside the project directory, not a URL"
        )));
    }

    // Matched on the raw string: a platform whose path parser does not recognise
    // `\\server\share` as a network path would otherwise treat it as a file name
    // and only fail later, for the wrong reason.
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err(ToolError::PermissionDenied(format!(
            "{key} must be a filesystem path inside the project directory; UNC, device, and network paths are rejected"
        )));
    }

    let requested_path = Path::new(trimmed);
    let escapes_scope = requested_path
        .components()
        .any(|component| match component {
            Component::ParentDir => true,
            Component::Prefix(prefix) => !matches!(prefix.kind(), std::path::Prefix::Disk(_)),
            _ => false,
        });
    if escapes_scope {
        return Err(path_escape_error(key, trimmed));
    }

    // The project root comes from the operator, not the client, so resolving it
    // is safe and gives every later comparison one form to work against.
    let canonical_root = std::fs::canonicalize(project_root).map_err(|error| {
        ToolError::Execution(format!(
            "Project directory '{}' could not be resolved: {error}",
            project_root.display()
        ))
    })?;
    let scope_root = strip_verbatim_prefix(&canonical_root);

    let candidate = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        scope_root.join(requested_path)
    };
    if !path_is_within(&scope_root, &candidate) {
        return Err(path_escape_error(key, trimmed));
    }

    // Only now is touching the filesystem safe: the path is already known to be
    // inside the project, so resolving it cannot probe anything outside it.
    let mut nearest_existing = candidate.as_path();
    while !nearest_existing.exists() {
        nearest_existing = nearest_existing
            .parent()
            .ok_or_else(|| path_escape_error(key, trimmed))?;
    }
    let canonical_existing = std::fs::canonicalize(nearest_existing)
        .map_err(|error| ToolError::Execution(format!("{key} could not be resolved: {error}")))?;
    if !path_is_within(&scope_root, &strip_verbatim_prefix(&canonical_existing)) {
        return Err(path_escape_error(key, trimmed));
    }

    Ok(candidate)
}

/// One rejection message for every way out of the project directory.
///
/// Absolute, traversing, and symlinked paths fail identically so the wording
/// cannot be used to distinguish "outside the project" from "does not exist".
fn path_escape_error(key: &str, requested: &str) -> ToolError {
    // Worded exactly as the in-app bridge words it, so an agent that meets the
    // rule on one surface recognises it on the other.
    ToolError::PermissionDenied(format!(
        "{key} '{requested}' must resolve inside the project directory"
    ))
}

/// Removes the `\\?\` verbatim prefix `canonicalize` adds on Windows.
///
/// A client never sends that prefix, so comparisons and joins use the plain
/// form. Verbatim UNC roots keep theirs: stripping it would change which share
/// the path names.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// True when `path` is `base` itself or lives underneath it.
fn path_is_within(base: &Path, path: &Path) -> bool {
    let mut path_components = path.components();
    for base_component in base.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };
        if !path_components_match(base_component, path_component) {
            return false;
        }
    }
    true
}

/// Windows path comparison is case-insensitive, so components are folded there.
#[cfg(windows)]
fn path_components_match(base: Component<'_>, candidate: Component<'_>) -> bool {
    base.as_os_str().to_string_lossy().to_ascii_lowercase()
        == candidate.as_os_str().to_string_lossy().to_ascii_lowercase()
}

/// Every other platform compares components verbatim.
#[cfg(not(windows))]
fn path_components_match(base: Component<'_>, candidate: Component<'_>) -> bool {
    base == candidate
}

/// Runs deterministic QC and returns the same document `openreelio-cli verify`
/// prints.
///
/// Verify mutates nothing, so the tool is always registered. The rendered pass
/// can run for minutes on a long export; the stdio loop handles one request at a
/// time and imposes no deadline of its own, so the measurement timeout is the
/// only bound and stays at the CLI default.
fn run_verify_tool(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    let Some(project_path) = state.project.as_ref() else {
        return Err(ToolError::InvalidArguments(
            "openreelio.verify requires mcp --project <project-path>".to_string(),
        ));
    };

    let requested_file = optional_string_argument(&arguments, "file")?;
    let structural_only = optional_bool_argument(&arguments, "structuralOnly")?.unwrap_or(false);
    if requested_file.is_some() && structural_only {
        return Err(ToolError::InvalidArguments(
            "file and structuralOnly cannot be combined".to_string(),
        ));
    }

    // The rendered file is measured with FFmpeg, so it has to stay inside the
    // project the server was started on, in every mode.
    let file = requested_file
        .map(|requested| confine_to_project(project_path, "file", &requested))
        .transpose()?;

    // Every field the engine accepts is read. Built exhaustively rather than
    // with `..Default::default()`: a struct-update fallback silently pinned the
    // measurement thresholds to their defaults, so a client that sent
    // `targetLufs` got a verdict measured against something else and no
    // indication that its argument had been dropped.
    let request = VerifyRequest {
        sequence: optional_string_argument(&arguments, "sequenceId")?,
        file,
        file_range: optional_non_negative_number_array(&arguments, "fileRange")?,
        structural_only,
        checks: optional_string_array_argument(&arguments, "checks")?,
        skip: optional_string_array_argument(&arguments, "skip")?,
        target_lufs: optional_finite_number(&arguments, "targetLufs")?,
        max_true_peak: optional_finite_number(&arguments, "maxTruePeak")?,
        duration_tolerance_sec: optional_non_negative_number(&arguments, "durationToleranceSec")?,
        fail_on: optional_string_argument(&arguments, "failOn")?
            .unwrap_or_else(|| DEFAULT_FAIL_ON.to_string()),
        timeout_sec: optional_positive_seconds(&arguments, "timeoutSec")?
            .unwrap_or(DEFAULT_MEASURE_TIMEOUT_SEC),
        // A refusal from the shared engine reaches an MCP client, which sends
        // JSON fields and has no command-line flags to correct.
        names: VerifyArgumentNames::api(),
    };

    // The exit code is dropped on purpose: the report already carries `status`,
    // `passed`, and the per-check outcomes an MCP client acts on, and a JSON-RPC
    // result has nowhere honest to put a process code.
    let (report, _exit_code) = verify::run_verify(project_path, request)
        .map_err(|error| ToolError::Execution(error.to_string()))?;
    Ok(report)
}

// ── Draft rendering ─────────────────────────────────────────────────────────

/// Renders one bounded range of the timeline into the agent render cache.
///
/// The render itself goes through `render start`'s own path — the same preset
/// table, the same export validation, the same result document — so a draft an
/// agent asks for here is the file the command line would have produced. What
/// this adds is everything that makes it safe to hand to a tool loop: the
/// output path is the server's, not the caller's, so nothing can be written
/// outside the project; the directory is pruned to its newest few drafts before
/// the render starts; and the range is capped, because a draft is a look at one
/// moment rather than a deliverable.
///
/// The answer names what to do with the file, because the whole point of
/// producing it is the step after: sheeting its cuts, or measuring it.
fn run_render_range_tool(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    let Some(project_path) = state.project.as_ref() else {
        return Err(ToolError::InvalidArguments(
            "openreelio.render.range requires mcp --project <project-path>".to_string(),
        ));
    };

    let start = required_non_negative_number(&arguments, "start")?;
    let end = required_non_negative_number(&arguments, "end")?;
    if start >= end {
        return Err(ToolError::InvalidArguments(format!(
            "start ({start}) must be before end ({end})"
        )));
    }
    // The output always lands in the agent directory, so the cap always applies.
    ensure_agent_render_range_within_cap(true, start, end).map_err(ToolError::InvalidArguments)?;

    let preset = optional_string_argument(&arguments, "preset")?
        .unwrap_or_else(|| render::PROXY_PRESET_ID.to_string());
    if preset != render::PROXY_PRESET_ID && preset != render::DRAFT_PRESET_ID {
        return Err(ToolError::InvalidArguments(format!(
            "preset must be '{}' or '{}' (got '{preset}')",
            render::PROXY_PRESET_ID,
            render::DRAFT_PRESET_ID
        )));
    }

    // Opened here rather than left to the render so the media check runs against
    // the same snapshot, and so an off-host clip is refused before FFmpeg is
    // asked to reach for it.
    let project = super::load_project(project_path).map_err(|error| {
        ToolError::Execution(format!(
            "Failed to open project '{}': {error}",
            project_path.display()
        ))
    })?;
    let sequence_id = super::resolve_sequence_id(
        &project,
        optional_string_argument(&arguments, "sequenceId")?,
    )
    .map_err(|error| ToolError::Execution(error.to_string()))?;
    confine_sequence_media(&project, &sequence_id)?;

    let output_path = allocate_agent_render_path(project_path)?;
    let payload = render::run_start_render(render::StartArgs {
        path: project_path.clone(),
        output_path,
        preset: preset.clone(),
        proxy: false,
        sequence: Some(sequence_id),
        start: Some(start),
        end: Some(end),
        progress: false,
    })
    .map_err(|error| ToolError::Execution(error.to_string()))?;

    let rendered_path = payload
        .get("outputPath")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // The range the file actually holds, not the one that was asked for: a
    // draft render routinely lands a frame short, and every `timelineSec` the
    // samplers report is offset by whatever this declaration gets wrong.
    //
    // Measured off the file rather than taken from the render result, which
    // reports the length the export *planned* for the range. The follow-ups
    // below hand these seconds straight to `frame.extract`, so a planned number
    // that the encoder did not quite reach becomes a sampled time the file has
    // no frame at. A probe that cannot run falls back to what was planned, and
    // then to the requested range — a hint is not worth failing a good render
    // over.
    let rendered_duration_sec = measure_rendered_duration_sec(Path::new(&rendered_path))
        .or_else(|| {
            payload
                .get("durationSec")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(end - start);

    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        // Replaced rather than reported alongside the planned length: this is
        // the number the follow-ups below are built from, and a caller reading
        // `durationSec` is asking how much picture the file holds.
        object.insert(
            "durationSec".to_string(),
            serde_json::json!(rendered_duration_sec),
        );
        object.insert(
            "timelineRange".to_string(),
            serde_json::json!({ "startSec": start, "endSec": end }),
        );
        object.insert(
            "nextStep".to_string(),
            serde_json::json!({
                // The unconditional look: an even sweep of the draft always has
                // something to show. A sampler is the better question when the
                // range holds events, but `atCuts` over a range with no cut in
                // it is an error, and that is the ordinary case for a draft
                // rendered around one moment.
                "sweep": {
                    "tool": "openreelio.frame.extract",
                    "arguments": {
                        "file": rendered_path,
                        "between": [0.0, rendered_duration_sec],
                        "grid": "4x3",
                        "labelCells": true
                    },
                    "note": "Sweeps the whole draft evenly; always has something to show."
                },
                "judgeEvents": {
                    "tool": "openreelio.frame.extract",
                    "arguments": {
                        "file": rendered_path,
                        "fileRange": [start, start + rendered_duration_sec],
                        "atCuts": true,
                        "grid": "auto",
                        "labelCells": true
                    },
                    "note": "Use when the rendered range contains cuts; swap atCuts for atCaptions, atTransitions or perShot to judge those instead. Errors when the range holds no such event. A cut sitting at the very start of the range shows only its incoming side — its outgoing frame is a frame and a half earlier, before this file begins, and is reported as sampler.droppedBeforeFile; render from slightly earlier to see both sides."
                },
                "measure": {
                    "tool": "openreelio.verify",
                    "arguments": { "file": rendered_path }
                }
            }),
        );
    }

    Ok(payload)
}

/// Measures how many seconds of media a rendered file actually holds.
///
/// The same probe `openreelio.verify --file` measures a render with, so the two
/// tools never disagree about the length of the file they were both handed.
/// `None` when FFmpeg is not resolvable here, when the probe fails, or when the
/// file declares no usable duration; every one of those is a reason to fall back
/// to what the render planned rather than to fail a draft that exists.
fn measure_rendered_duration_sec(path: &Path) -> Option<f64> {
    if !path.is_file() {
        return None;
    }
    let info = crate::ffmpeg_env::ensure_ffmpeg_optional()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let probed = runtime.block_on(FFmpegRunner::new(info).probe(path)).ok()?;

    Some(probed.duration_sec).filter(|value| value.is_finite() && *value > 0.0)
}

/// Reserves the path one draft render writes into, and bounds the directory.
///
/// Pruning runs before the render rather than after it, and asks to keep one
/// fewer than the bound, so the directory holds [`MAX_AGENT_RENDERS`] once this
/// render lands. The name carries a millisecond stamp: two drafts asked for in
/// the same second must not collide, and the stamp is also what makes "newest"
/// meaningful to a reader listing the directory.
fn allocate_agent_render_path(project_path: &Path) -> Result<PathBuf, ToolError> {
    let directory = agent_render_dir(project_path);
    std::fs::create_dir_all(&directory).map_err(|error| {
        ToolError::Execution(format!(
            "Failed to create the agent render directory '{}': {error}",
            directory.display()
        ))
    })?;
    // A prune failure is not worth losing the render over: the directory being
    // one file over its bound is a housekeeping problem, and the next call
    // sweeps it.
    let _ = prune_agent_renders(project_path, MAX_AGENT_RENDERS.saturating_sub(1), None);

    Ok(directory.join(format!("proxy-{}.mp4", current_time_millis())))
}

// ── Frame extraction ────────────────────────────────────────────────────────

/// A parsed `openreelio.frame.extract` request.
///
/// Reading is separated from execution because clap — where the CLI gets its
/// argument rules — is never run on this surface. What clap enforces for the
/// command line, [`FrameProbePlan::validate`] enforces for everything else, and
/// this type hands it the request before a directory is reserved or a project
/// is opened, so a bad combination comes back as an argument error rather than
/// an execution failure.
///
/// The rules themselves are deliberately *not* restated here. They used to be,
/// and the restatement drifted: it spoke a slightly different English, and it
/// answered some refusals the engine never got to make. Only what the engine
/// cannot know stays — how many images one JSON-RPC reply can carry.
#[derive(Clone)]
#[cfg_attr(test, derive(Debug))]
struct FrameExtractRequest {
    asset_id: Option<String>,
    source_time: Option<f64>,
    time: Option<f64>,
    times: Option<Vec<f64>>,
    grid: Option<String>,
    between: Option<Vec<f64>>,
    file: Option<String>,
    file_range: Option<Vec<f64>>,
    sequence_id: Option<String>,
    mode: Option<String>,
    cell_width: Option<u32>,
    cell_height: Option<u32>,
    label_cells: bool,
    max_width: Option<u32>,
    at_cuts: bool,
    at_transitions: bool,
    at_captions: bool,
    at_markers: bool,
    per_shot: bool,
    around: Option<f64>,
    span: Option<f64>,
    around_count: Option<usize>,
    affected: bool,
    after_op: Option<String>,
    ranges: Option<Vec<TimeRange>>,
    limit: Option<usize>,
}

impl FrameExtractRequest {
    fn parse(arguments: &Value) -> Result<Self, ToolError> {
        let request = Self {
            asset_id: optional_string_argument(arguments, "assetId")?,
            source_time: optional_non_negative_number(arguments, "sourceTime")?,
            time: optional_non_negative_number(arguments, "time")?,
            times: optional_non_negative_number_array(arguments, "times")?,
            grid: optional_string_argument(arguments, "grid")?,
            between: optional_non_negative_number_array(arguments, "between")?,
            file: optional_string_argument(arguments, "file")?,
            file_range: optional_non_negative_number_array(arguments, "fileRange")?,
            sequence_id: optional_string_argument(arguments, "sequenceId")?,
            mode: optional_string_argument(arguments, "mode")?,
            cell_width: optional_pixel_argument(arguments, "cellWidth")?,
            cell_height: optional_pixel_argument(arguments, "cellHeight")?,
            label_cells: optional_bool_argument(arguments, "labelCells")?.unwrap_or(false),
            max_width: optional_pixel_argument(arguments, "maxWidth")?,
            at_cuts: optional_bool_argument(arguments, "atCuts")?.unwrap_or(false),
            at_transitions: optional_bool_argument(arguments, "atTransitions")?.unwrap_or(false),
            at_captions: optional_bool_argument(arguments, "atCaptions")?.unwrap_or(false),
            at_markers: optional_bool_argument(arguments, "atMarkers")?.unwrap_or(false),
            per_shot: optional_bool_argument(arguments, "perShot")?.unwrap_or(false),
            around: optional_non_negative_number(arguments, "around")?,
            span: optional_positive_number(arguments, "span")?,
            around_count: optional_positive_count(arguments, "aroundCount")?,
            affected: optional_bool_argument(arguments, "affected")?.unwrap_or(false),
            after_op: optional_string_argument(arguments, "afterOp")?,
            ranges: optional_time_ranges_argument(arguments, "ranges")?,
            limit: optional_positive_count(arguments, "limit")?,
        };

        request.validate()?;
        Ok(request)
    }

    fn is_grid(&self) -> bool {
        self.grid.is_some()
    }

    /// Whether any event sampler was asked for.
    fn has_sampler(&self) -> bool {
        self.at_cuts
            || self.at_transitions
            || self.at_captions
            || self.at_markers
            || self.per_shot
            || self.around.is_some()
            || self.affected
            || self.ranges.is_some()
    }

    /// Rejects the request, in this surface's own vocabulary, before anything
    /// is reserved or opened.
    fn validate(&self) -> Result<(), ToolError> {
        self.validate_inline_budget()?;
        self.validate_through_engine()
    }

    /// Bounds how much picture one JSON-RPC reply carries.
    ///
    /// The only rule the engine cannot make: it knows nothing about a response
    /// budget, and a sheet is one image however many cells it holds, so only
    /// the separate-stills paths are capped. A sampler's count is not knowable
    /// until the sequence is read, so its cap is expressed as the `limit` the
    /// caller states up front — and `into_extract_args` supplies that limit
    /// when the caller states none.
    fn validate_inline_budget(&self) -> Result<(), ToolError> {
        if self.is_grid() {
            return Ok(());
        }
        if let Some(times) = self.times.as_deref() {
            if times.len() > MAX_INLINE_FRAME_STILLS {
                return Err(ToolError::InvalidArguments(format!(
                    "times asks for {} stills, more than the maximum of {MAX_INLINE_FRAME_STILLS} one reply carries. Ask for fewer, or pass grid for a contact sheet.",
                    times.len()
                )));
            }
        }
        match self.limit {
            Some(limit) if limit > MAX_INLINE_FRAME_STILLS => Err(ToolError::InvalidArguments(
                format!("limit asks for up to {limit} stills, more than the maximum of {MAX_INLINE_FRAME_STILLS} one reply carries. Lower it, or pass grid for a contact sheet."),
            )),
            _ => Ok(()),
        }
    }

    /// Runs the extraction engine's own guards against this request.
    ///
    /// The paths are placeholders: nothing the guards read depends on them —
    /// the format is stated outright by `into_extract_args`, so the output path
    /// is never consulted for one — and reserving a real cache entry before the
    /// request is known to be servable is exactly what leaves a directory
    /// behind for every refusal.
    fn validate_through_engine(&self) -> Result<(), ToolError> {
        let args = self.clone().into_extract_args(
            PathBuf::new(),
            PathBuf::new(),
            self.file.as_deref().map(PathBuf::from),
            self.sequence_id.clone(),
        );

        frame::FrameProbePlan::validate(&args.into_request())
            .map_err(|error| ToolError::InvalidArguments(error.to_string()))
    }

    /// Builds the CLI-side arguments, with the paths the server chose.
    fn into_extract_args(
        self,
        project_path: PathBuf,
        out: PathBuf,
        file: Option<PathBuf>,
        sequence_id: Option<String>,
    ) -> frame::ExtractArgs {
        let sampler_batch = self.has_sampler() && !self.is_grid();

        frame::ExtractArgs {
            path: project_path,
            out,
            file,
            file_range: self.file_range,
            asset: self.asset_id,
            source_time: self.source_time,
            time: self.time,
            times: self.times,
            sequence: sequence_id,
            mode: self.mode,
            max_width: self.max_width,
            // The images travel inline, so they are encoded for a vision model
            // rather than for archival: JPEG keeps one response a size a client
            // can actually carry.
            format: Some("jpeg".to_string()),
            grid: self.grid,
            between: self.between,
            count: None,
            cell_width: self.cell_width,
            cell_height: self.cell_height,
            label_cells: self.label_cells,
            at_cuts: self.at_cuts,
            at_transitions: self.at_transitions,
            at_captions: self.at_captions,
            at_markers: self.at_markers,
            per_shot: self.per_shot,
            around: self.around,
            span: self.span,
            around_count: self.around_count,
            affected: self.affected,
            after_op: self.after_op,
            // `ExtractArgs` carries the CLI's own shape — the flat pairs clap
            // collects from a repeated `--range START END` — so the parsed
            // ranges are flattened back into it rather than the struct growing
            // a second spelling of the same argument.
            range: self.ranges.map(|ranges| {
                ranges
                    .into_iter()
                    .flat_map(|range| [range.start_sec, range.end_sec])
                    .collect()
            }),
            // A batch of stills travels inline, so an unbounded sampler would
            // build a response no host can carry. The cap is applied as the
            // caller's own budget when they state none.
            limit: match (self.limit, sampler_batch) {
                (Some(limit), _) => Some(limit),
                (None, true) => Some(MAX_INLINE_FRAME_STILLS),
                (None, false) => None,
            },
            // Every refusal the engine makes travels back to an MCP client,
            // which sends JSON keys and has no flags to correct. `sequenceId`
            // and `assetId` are this surface's own spellings of the shared
            // `sequence` and `asset` labels.
            names: MCP_FRAME_ARGUMENT_NAMES,
        }
    }
}

/// How `openreelio.frame.extract` spells the engine's arguments.
///
/// The shared JSON vocabulary, with the two keys this surface names
/// differently. Every override here has to be a property of the tool's own
/// `inputSchema` — a refusal naming an argument the schema does not declare is
/// one the client cannot act on — which
/// `frame_argument_names_should_match_the_advertised_schema` enforces.
const MCP_FRAME_ARGUMENT_NAMES: &frame::FrameProbeArgumentNames = &frame::FrameProbeArgumentNames {
    sequence: "sequenceId",
    asset: "assetId",
    ..*frame::API_ARGUMENT_NAMES
};

/// Reads an optional strictly positive number of seconds.
fn optional_positive_number(arguments: &Value, key: &str) -> Result<Option<f64>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    value
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!("{key} must be a positive number when provided"))
        })
}

/// Reads an optional list of `{startSec, endSec}` timeline ranges.
///
/// Every value is checked here rather than left to the engine so a malformed
/// range is an argument error the client can fix, in the same words for every
/// entry. `startSec == endSec` is accepted: that is how a marker's own instant
/// is expressed, and the sampler gives it a single sample.
fn optional_time_ranges_argument(
    arguments: &Value,
    key: &str,
) -> Result<Option<Vec<TimeRange>>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    let entries = value.as_array().ok_or_else(|| {
        ToolError::InvalidArguments(format!(
            "{key} must be an array of {{startSec, endSec}} objects"
        ))
    })?;
    if entries.is_empty() {
        return Err(ToolError::InvalidArguments(format!(
            "{key} requires at least one range"
        )));
    }

    let mut ranges = Vec::with_capacity(entries.len());
    for entry in entries {
        let read = |field: &str| {
            entry
                .get(field)
                .and_then(Value::as_f64)
                .filter(|number| number.is_finite() && *number >= 0.0)
                .ok_or_else(|| {
                    ToolError::InvalidArguments(format!(
                        "{key} entries need a finite, non-negative {field}"
                    ))
                })
        };
        let start_sec = read("startSec")?;
        let end_sec = read("endSec")?;
        if end_sec < start_sec {
            return Err(ToolError::InvalidArguments(format!(
                "{key} entries need endSec at or after startSec (got {start_sec} to {end_sec})"
            )));
        }
        ranges.push(TimeRange { start_sec, end_sec });
    }

    Ok(Some(ranges))
}

/// Reads an optional whole count of at least one.
fn optional_positive_count(arguments: &Value, key: &str) -> Result<Option<usize>, ToolError> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }

    value
        .as_u64()
        .filter(|count| *count >= 1)
        .and_then(|count| usize::try_from(count).ok())
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!("{key} must be a whole number of at least 1"))
        })
}

fn run_frame_extract_tool(
    state: &McpServerState,
    arguments: Value,
) -> Result<ToolOutput, ToolError> {
    let Some(project_path) = state.project.as_ref() else {
        return Err(ToolError::InvalidArguments(
            "openreelio.frame.extract requires mcp --project <project-path>".to_string(),
        ));
    };

    let request = FrameExtractRequest::parse(&arguments)?;

    // A rendered file is a client-supplied path handed to FFmpeg, so it is
    // confined like every other one. Timeline extraction instead opens the media
    // the sequence's clips point at, which arrives as project state and is
    // confined there — the same split `openreelio.transcription.generate` makes.
    //
    // A sampled file sits on the first side of that split even though it reads
    // the sequence: the sequence is read for its cut and caption *times*, and
    // every picture comes out of the confined file. No clip's media is opened,
    // so no clip's media is checked — which is also what the in-app IPC does.
    let (file, project, sequence_id) = match request.file.as_deref() {
        Some(requested) if request.has_sampler() => {
            let file = confine_to_project(project_path, "file", requested)?;
            let project = super::load_project(project_path).map_err(|error| {
                ToolError::Execution(format!(
                    "Failed to open project '{}': {error}",
                    project_path.display()
                ))
            })?;
            // `sequenceId` is refused alongside `file`, so a sampled file always
            // reads the active sequence — the one the render came from.
            // Resolved here only so a project without one is refused before a
            // cache directory is reserved; the engine resolves the same id from
            // this same snapshot, and a file names a timebase rather than a
            // sequence, so nothing is passed on.
            super::resolve_sequence_id(&project, None)
                .map_err(|error| ToolError::Execution(error.to_string()))?;
            (Some(file), Some(project), None)
        }
        Some(requested) => (
            Some(confine_to_project(project_path, "file", requested)?),
            None,
            None,
        ),
        None => {
            let project = super::load_project(project_path).map_err(|error| {
                ToolError::Execution(format!(
                    "Failed to open project '{}': {error}",
                    project_path.display()
                ))
            })?;
            // An asset request reads exactly one piece of media in its own
            // timebase, and never opens the sequence; walking every clip would
            // refuse a still of a perfectly readable asset because some other
            // clip in the edit is offline.
            if let Some(asset_id) = request.asset_id.as_deref() {
                confine_asset_media(&project, asset_id)?;
                (None, Some(project), None)
            } else {
                let sequence_id = super::resolve_sequence_id(&project, request.sequence_id.clone())
                    .map_err(|error| ToolError::Execution(error.to_string()))?;
                confine_sequence_media(&project, &sequence_id)?;
                (None, Some(project), Some(sequence_id))
            }
        }
    };

    // Allocated only once every argument, path, and media check has passed, so
    // a rejected request leaves no directory behind at all.
    let output = frame_output_slot(project_path, &request)?;
    // A rendered file names a timebase, not a sequence, and the engine refuses
    // the pair on every surface — the file arms above therefore carry no id at
    // all, and this is only where the timeline arm's reaches the request.
    let args = request.into_extract_args(
        project_path.clone(),
        output.out().to_path_buf(),
        file,
        sequence_id,
    );

    extract_inline_frames(args, project.as_ref()).inspect_err(|_error| {
        // Nothing usable came back, so this call's directory is residue: FFmpeg
        // and the sequence-bounds check both run after the mkdir, and an empty
        // entry per failed probe is how the cache grows fastest.
        output.discard();
    })
}

/// Reserves the cache entry this extraction writes into.
///
/// The images are encoded for a vision model rather than for archival, so the
/// stills are JPEG — see `into_extract_args`, which forces the same format on
/// the probe.
fn frame_output_slot(
    project_path: &Path,
    request: &FrameExtractRequest,
) -> Result<FrameOutput, ToolError> {
    let artifact = if request.is_grid() {
        FrameArtifact::Sheet
    } else if request.times.is_some() || request.has_sampler() {
        FrameArtifact::Batch
    } else {
        FrameArtifact::Still
    };

    allocate_frame_output(project_path, artifact, ImageFormat::Jpeg)
        .map_err(|error| ToolError::Execution(error.to_string()))
}

/// Runs the extraction and reads its images back for the wire.
///
/// `project` is the snapshot `confine_sequence_media` approved. Handing it to
/// the extraction is what keeps the check and the read on the same state: a
/// second `load_project` would replay `ops.jsonl` again and could resolve clip
/// media the confinement never saw.
fn extract_inline_frames(
    args: frame::ExtractArgs,
    project: Option<&openreelio_core::ActiveProject>,
) -> Result<ToolOutput, ToolError> {
    // `frame::run_extract` resolves FFmpeg through `ensure_ffmpeg`, so a machine
    // without it fails here with a message naming that, rather than hanging.
    let payload = match project {
        Some(project) => frame::run_extract_with_project(args, project),
        None => frame::run_extract(args),
    }
    .map_err(|error| ToolError::Execution(error.to_string()))?;
    let images = inline_frame_images(&payload, MAX_INLINE_FRAME_STILLS)
        .map_err(|error| ToolError::Execution(error.to_string()))?
        .into_iter()
        .map(|image| ToolImage {
            data: image.data,
            mime_type: image.mime_type,
        })
        .collect();

    Ok(ToolOutput::with_images(payload, images))
}

fn apply_media_insert(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    // `--allow-write` is the grant; there is no token to check, scope, or spend.
    if !state.allow_write {
        state.verify_approval_token(&arguments, None)?;

        if let Some(plan_id) = state.approval_plan_id.as_deref() {
            return Err(ToolError::PermissionDenied(format!(
                "approvalToken is scoped to plan '{plan_id}' and cannot be used for openreelio.media.insert"
            )));
        }
    }

    let sequence_id = required_string_argument(&arguments, "sequenceId")?;
    let track_id = required_string_argument(&arguments, "trackId")?;
    let asset_id = required_string_argument(&arguments, "assetId")?;
    let timeline_start = required_non_negative_number(&arguments, "timelineStart")?;
    let source_in = optional_non_negative_number(&arguments, "sourceIn")?;
    let source_out = optional_non_negative_number(&arguments, "sourceOut")?;
    let audio_only = arguments
        .get("audioOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let auto_extract_linked_audio = arguments
        .get("autoExtractLinkedAudio")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let project_path = state.project.as_ref().ok_or_else(|| {
        ToolError::InvalidArguments("A project path is required to insert media".to_string())
    })?;
    let mut project = super::load_project(project_path)
        .map_err(|error| ToolError::Execution(error.to_string()))?;
    if !state.allow_write {
        state.ensure_media_insert_token_scope(&project.state.meta.id)?;
    }

    // Validate the inputs against the canonical command schema, then run the
    // single canonical InsertMedia command. All linked-audio business logic now
    // lives once in `openreelio_core::commands::InsertMediaCommand`, applied as a
    // single undoable unit.
    CommandPayload::parse(
        "InsertMedia".to_string(),
        serde_json::json!({
            "sequenceId": sequence_id,
            "trackId": track_id,
            "assetId": asset_id,
            "timelineStart": timeline_start,
            "sourceIn": source_in,
            "sourceOut": source_out,
            "audioOnly": audio_only,
            "autoExtractLinkedAudio": auto_extract_linked_audio,
        }),
    )
    .map_err(ToolError::InvalidArguments)?;

    // Single-use consumption belongs to the token path only; spending it under
    // `--allow-write` would let exactly one mutation through per session.
    if !state.allow_write {
        state.consume_approval_token()?;
    }

    let command = InsertMediaCommand::new(&sequence_id, &track_id, &asset_id, timeline_start)
        .with_source_range(source_in, source_out)
        .with_audio_only(audio_only)
        .with_auto_extract_linked_audio(auto_extract_linked_audio);

    // Run through the canonical executor path (single op + single undo entry).
    let command_result = project
        .executor
        .execute(Box::new(command), &mut project.state)
        .map_err(|error| ToolError::Execution(format!("Media insert failed: {error}")))?;

    super::save_project(&mut project).map_err(|error| ToolError::Execution(error.to_string()))?;

    // Reconstruct the response details from the realized state. The primary clip
    // is the first created ID; linked audio (if any) is the partner clip sharing
    // the primary clip's link group.
    let primary_clip_id = command_result.created_ids.first().cloned().ok_or_else(|| {
        ToolError::Execution("Media insert did not return a created clip id".to_string())
    })?;
    let sequence = project.state.sequences.get(&sequence_id).ok_or_else(|| {
        ToolError::Execution(format!("Sequence '{sequence_id}' not found after insert"))
    })?;
    let primary_clip = sequence
        .tracks
        .iter()
        .find(|t| t.id == track_id)
        .and_then(|t| t.clips.iter().find(|c| c.id == primary_clip_id))
        .ok_or_else(|| {
            ToolError::Execution("Inserted clip not found after media insert".to_string())
        })?;
    let source_range = Some((
        primary_clip.range.source_in_sec,
        primary_clip.range.source_out_sec,
    ));
    let duration_sec = primary_clip.place.duration_sec;

    let linked_audio = match primary_clip.link_group_id.clone() {
        Some(link_group_id) => sequence
            .tracks
            .iter()
            .find_map(|t| {
                t.clips
                    .iter()
                    .find(|c| {
                        c.id != primary_clip_id
                            && c.link_group_id.as_deref() == Some(link_group_id.as_str())
                    })
                    .map(|c| (t.id.clone(), c.id.clone()))
            })
            .map(|(audio_track_id, audio_clip_id)| {
                let created_track = command_result.created_ids.contains(&audio_track_id);
                serde_json::json!({
                    "trackId": audio_track_id,
                    "clipId": audio_clip_id,
                    "createdTrack": created_track,
                })
            })
            .unwrap_or(Value::Null),
        None => Value::Null,
    };

    Ok(serde_json::json!({
        "status": "ok",
        "message": "Media inserted through the drag-and-drop parity path.",
        "opId": command_result.op_id,
        "createdIds": command_result.created_ids,
        "clipId": primary_clip_id,
        "sequenceId": sequence_id,
        "trackId": track_id,
        "assetId": asset_id,
        "timelineStart": timeline_start,
        "sourceIn": source_range.map(|range| range.0),
        "sourceOut": source_range.map(|range| range.1),
        "durationSec": duration_sec,
        "linkedAudio": linked_audio
    }))
}

fn validate_command(arguments: Value) -> Result<Value, ToolError> {
    let command_type = arguments
        .get("commandType")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments("commandType is required".to_string()))?;
    let payload = arguments
        .get("payload")
        .cloned()
        .ok_or_else(|| ToolError::InvalidArguments("payload is required".to_string()))?;
    if !payload.is_object() {
        return Err(ToolError::InvalidArguments(
            "payload must be a JSON object".to_string(),
        ));
    }

    match CommandPayload::parse(command_type.to_string(), payload) {
        Ok(_) => Ok(serde_json::json!({
            "status": "ok",
            "commandType": command_type,
            "message": "Command payload is valid"
        })),
        Err(error) => Ok(serde_json::json!({
            "status": "error",
            "commandType": command_type,
            "message": "Command payload is invalid",
            "error": error.to_string()
        })),
    }
}

/// Names the steps that are missing a field the plan shape requires.
///
/// Deserialization reports the first missing field as one serde message with no
/// step attribution, which is useless to an agent holding a fifty-step plan.
/// This is deliberately presence-only: it says which step lacks which key and
/// stops there, so every judgement about what those keys *contain* still comes
/// from the shared validator and cannot drift from what `plan execute` accepts.
fn missing_step_field_errors(plan_value: &Value) -> Vec<String> {
    let Some(steps) = plan_value.get("steps").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut errors = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let Some(fields) = step.as_object() else {
            errors.push(format!("Step at index {index} must be a JSON object"));
            continue;
        };

        let label = match fields.get("id").and_then(Value::as_str) {
            Some(id) => format!("Step '{id}' (index {index})"),
            None => format!("Step at index {index}"),
        };
        for required in ["id", "commandType", "payload"] {
            if !fields.contains_key(required) {
                errors.push(format!("{label} is missing '{required}'"));
            }
        }
    }

    errors
}

fn validate_plan(arguments: Value) -> Result<Value, ToolError> {
    let plan_value = arguments
        .get("plan")
        .cloned()
        .ok_or_else(|| ToolError::InvalidArguments("plan is required".to_string()))?;
    let plan_id = plan_value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    // A plan that will not even deserialize is a validation finding, not a
    // protocol error: the caller asked what is wrong with the plan, and an
    // error list answers that better than a JSON-RPC failure does.
    let edit_plan: plan::EditPlan = match serde_json::from_value(plan_value.clone()) {
        Ok(edit_plan) => edit_plan,
        Err(error) => {
            let mut errors = missing_step_field_errors(&plan_value);
            errors.push(format!("Plan does not match the expected shape: {error}"));
            return Ok(serde_json::json!({
                "status": "error",
                "planId": plan_id,
                "message": "Plan validation failed",
                "errors": errors
            }));
        }
    };

    // Everything structural lives in the shared validator, so this surface
    // cannot drift from what `plan execute` will actually accept.
    let validation = plan::validate_edit_plan(&edit_plan);

    Ok(if validation.errors.is_empty() {
        serde_json::json!({
            "status": "ok",
            "planId": edit_plan.id,
            "stepCount": edit_plan.steps.len(),
            "stepsWithReferences": validation.steps_with_references,
            "message": "Plan is valid"
        })
    } else {
        serde_json::json!({
            "status": "error",
            "planId": edit_plan.id,
            "message": "Plan validation failed",
            "errors": validation.errors,
            "stepsWithReferences": validation.steps_with_references
        })
    })
}

fn apply_plan(state: &McpServerState, arguments: Value) -> Result<Value, ToolError> {
    // `--allow-write` is the grant; there is no token to check, scope, or spend.
    if !state.allow_write {
        state.active_approval_token(None)?;
    }

    let plan_value = arguments
        .get("plan")
        .cloned()
        .ok_or_else(|| ToolError::InvalidArguments("plan is required".to_string()))?;
    let plan_id = plan_value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments("plan.id is required".to_string()))?;
    if !state.allow_write {
        state.verify_approval_token(&arguments, Some(plan_id))?;
    }

    let project_path = state.project.as_ref().ok_or_else(|| {
        ToolError::InvalidArguments("A project path is required to apply a plan".to_string())
    })?;
    let edit_plan: plan::EditPlan = serde_json::from_value(plan_value)
        .map_err(|error| ToolError::InvalidArguments(format!("Invalid plan JSON: {error}")))?;

    let validation = plan::validate_edit_plan(&edit_plan);
    if !validation.errors.is_empty() {
        return Ok(serde_json::json!({
            "status": "error",
            "message": "Plan validation failed",
            "planId": edit_plan.id,
            "errors": validation.errors,
            "stepsWithReferences": validation.steps_with_references,
        }));
    }

    // The project has to be open before the token can be held to its project
    // scope, and the scope has to hold before the token is spent: a grant issued
    // for another project buys nothing here.
    let mut project = super::load_project(project_path)
        .map_err(|error| ToolError::Execution(error.to_string()))?;
    if !state.allow_write {
        state.ensure_token_project_scope(&project.state.meta.id)?;
    }

    // Single-use consumption belongs to the token path only; spending it under
    // `--allow-write` would let exactly one plan through per session.
    if !state.allow_write {
        state.consume_approval_token()?;
    }

    let result = plan::apply_edit_plan(&mut project, &edit_plan)
        .map_err(|error| ToolError::Execution(error.to_string()))?;

    if result["status"] == "ok" {
        // Every step is already fsynced into the append-only ops log, so a save
        // failure leaves the plan durably applied: the next open folds those ops
        // back in. The message has to say so, or a client reading a plain
        // execution error will re-apply the whole plan.
        super::save_project(&mut project).map_err(|error| {
            ToolError::Execution(format!(
                "Plan applied but the project could not be saved: {error}. \
                 Every step is already in the operations log and will be present \
                 on the next open — do NOT re-apply this plan."
            ))
        })?;
    }

    Ok(result)
}

/// Describes what a headless server can say about preview.
///
/// There is no interactive preview to report on, so the playhead is a constant.
/// What is *not* constant is whether frames can be seen at all: this used to
/// answer `rawFrameAccess: "disabled"` while `openreelio.frame.extract` was
/// registered two functions away, which told a client the one thing it most
/// needed to know, wrongly. The tool that does exist is named instead.
fn build_preview_state() -> Value {
    serde_json::json!({
        "state": "idle",
        "playheadSeconds": 0.0,
        "frameExtraction": "openreelio.frame.extract",
        "source": "headless-default"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use openreelio_core::assets::AudioInfo;
    use openreelio_core::commands::{
        AddTextClipCommand, AddTrackCommand, CreateCaptionCommand, ImportAssetCommand,
        SetClipTransformCommand,
    };
    use openreelio_core::text::{TextClipData, TextOutline, TextPosition, TextShadow, TextStyle};
    use openreelio_core::timeline::Transform;
    use openreelio_core::Point2D;

    fn request(method: &str, params: Value) -> Value {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        })
    }

    #[test]
    fn should_expose_text_and_caption_details_in_timeline_snapshot() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("text_snapshot_project");
        let mut project =
            openreelio_core::ActiveProject::create("Text Snapshot", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");

        let title_track_result = project
            .executor
            .execute(
                Box::new(AddTrackCommand::new(
                    &sequence_id,
                    "Editable Text",
                    TrackKind::Video,
                )),
                &mut project.state,
            )
            .expect("add title track");
        let title_track_id = title_track_result.created_ids[0].clone();

        let text_data = TextClipData::new("Editable Title")
            .with_style(
                TextStyle::default()
                    .with_font_family("Inter")
                    .with_font_size(64)
                    .with_font_weight(700)
                    .with_color("#FFEE00")
                    .with_background("#000000AA"),
            )
            .with_position(TextPosition::new(0.3, 0.72))
            .with_shadow(TextShadow::soft())
            .with_outline(TextOutline::thin().with_color("#111111"))
            .with_rotation(12.0)
            .with_opacity(0.8);
        let text_result = project
            .executor
            .execute(
                Box::new(AddTextClipCommand::new(
                    &sequence_id,
                    &title_track_id,
                    1.0,
                    4.0,
                    text_data,
                )),
                &mut project.state,
            )
            .expect("add text clip");
        let text_clip_id = text_result.created_ids[0].clone();

        let transform = Transform {
            position: Point2D::new(0.42, 0.66),
            scale: Point2D::new(1.2, 0.9),
            rotation_deg: 18.0,
            ..Default::default()
        };
        project
            .executor
            .execute(
                Box::new(SetClipTransformCommand::new(
                    &sequence_id,
                    &title_track_id,
                    &text_clip_id,
                    transform,
                )),
                &mut project.state,
            )
            .expect("transform text clip");

        let caption_track_result = project
            .executor
            .execute(
                Box::new(AddTrackCommand::new(
                    &sequence_id,
                    "Captions",
                    TrackKind::Caption,
                )),
                &mut project.state,
            )
            .expect("add caption track");
        let caption_track_id = caption_track_result.created_ids[0].clone();
        let caption_result = project
            .executor
            .execute(
                Box::new(
                    CreateCaptionCommand::new(&sequence_id, &caption_track_id, 2.0, 3.5)
                        .with_text("Caption line")
                        .with_style(Some(serde_json::json!({
                            "fontFamily": "Noto Sans",
                            "fontSize": 42,
                            "color": "#FFFFFF"
                        })))
                        .with_position(Some(serde_json::json!({
                            "x": 50,
                            "y": 86
                        }))),
                ),
                &mut project.state,
            )
            .expect("add caption clip");
        let caption_clip_id = caption_result.created_ids[0].clone();

        project.save().expect("save project");
        drop(project);

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };
        let snapshot = build_timeline_snapshot(&state).expect("timeline snapshot");
        let tracks = snapshot["sequences"][0]["tracks"]
            .as_array()
            .expect("tracks");
        let text_clip = tracks
            .iter()
            .flat_map(|track| track["clips"].as_array().expect("clips"))
            .find(|clip| clip["id"] == text_clip_id)
            .expect("text clip");
        assert_eq!(text_clip["kind"], "text");
        assert_eq!(text_clip["textData"]["content"], "Editable Title");
        assert_eq!(text_clip["textData"]["style"]["fontFamily"], "Inter");
        assert_eq!(text_clip["textData"]["style"]["fontWeight"], 700);
        assert_eq!(text_clip["textData"]["position"]["x"], 0.42);
        assert_eq!(text_clip["textData"]["position"]["y"], 0.66);
        assert_eq!(text_clip["textData"]["rotation"], 18.0);
        assert_eq!(text_clip["textData"]["shadow"]["blur"], 4);
        assert_eq!(text_clip["transform"]["position"]["x"], 0.42);
        assert_eq!(text_clip["transform"]["scale"]["x"], 1.2);
        assert!(
            (text_clip["opacity"].as_f64().expect("opacity") - 0.8).abs() < 0.001,
            "expected text opacity near 0.8, got {}",
            text_clip["opacity"]
        );

        let caption_clip = tracks
            .iter()
            .flat_map(|track| track["clips"].as_array().expect("clips"))
            .find(|clip| clip["id"] == caption_clip_id)
            .expect("caption clip");
        assert_eq!(caption_clip["kind"], "caption");
        assert_eq!(caption_clip["text"], "Caption line");
        assert_eq!(caption_clip["captionStyle"]["fontFamily"], "Noto Sans");
        assert_eq!(caption_clip["captionPosition"]["y"], 86);
    }

    #[test]
    fn should_advertise_only_read_only_tools_when_listing_tools() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();

        assert!(names.contains(&"openreelio.host.context"));
        assert!(names.contains(&"openreelio.timeline.snapshot"));
        assert!(names.contains(&"openreelio.transcription.status"));
        assert!(names.contains(&"openreelio.transcription.generate"));
        assert!(names.contains(&"openreelio.annotation.read"));
        assert!(names.contains(&"openreelio.command.schema"));
        assert!(!names.contains(&"openreelio.transcription.install_model"));
        assert!(!names.contains(&"openreelio.plan.apply"));
    }

    #[test]
    fn should_explain_text_workflows_in_command_schema() {
        let schema = build_command_schema();

        assert!(schema["payloadHints"]["AddTextClip"].is_object());
        assert_eq!(
            schema["payloadHints"]["transcriptionGenerate"]["tool"],
            "openreelio.transcription.generate"
        );
        assert_eq!(
            schema["payloadHints"]["transcriptionStatus"]["tool"],
            "openreelio.transcription.status"
        );
        assert!(schema["payloadHints"]["transcriptionInstallModel"].is_null());
        assert!(schema["payloadHints"]["UpdateTextClip"].is_object());
        assert!(schema["payloadHints"]["SetClipTransform"].is_object());
        assert_eq!(
            schema["textWorkflows"]["placementDefaults"]["subtitle"],
            "Bottom center around y=0.85 with outline/shadow unless it covers important visual content."
        );
    }

    #[test]
    fn should_advertise_curated_pack_ids_from_the_core_registries() {
        let schema = build_command_schema();

        // The hint lists must be the registries themselves, not a restatement:
        // an id an agent reads here has to be an id the parser accepts.
        for hint_path in ["CreateCaption", "ImportGeneratedCaptions"] {
            let hints = schema["payloadHints"][hint_path]["stylePackHints"]
                .as_array()
                .unwrap_or_else(|| panic!("{hint_path} must advertise stylePackHints"));
            let advertised: Vec<&str> = hints.iter().filter_map(Value::as_str).collect();
            assert_eq!(advertised, caption_pack_ids());
        }

        let recipes = schema["payloadHints"]["AddEffect"]["recipeHints"]
            .as_array()
            .expect("AddEffect must advertise recipeHints");
        let advertised: Vec<&str> = recipes.iter().filter_map(Value::as_str).collect();
        assert_eq!(advertised, transition_recipe_ids());

        // Every advertised id must round-trip through the strict parser.
        for pack_id in caption_pack_ids() {
            CommandPayload::parse(
                "CreateCaption".to_string(),
                serde_json::json!({
                    "sequenceId": "seq",
                    "trackId": "track",
                    "text": "hint check",
                    "startSec": 0.0,
                    "endSec": 1.0,
                    "stylePack": pack_id,
                }),
            )
            .unwrap_or_else(|error| panic!("advertised pack '{pack_id}' must parse: {error}"));
        }

        for recipe_id in transition_recipe_ids() {
            CommandPayload::parse(
                "AddEffect".to_string(),
                serde_json::json!({
                    "sequenceId": "seq",
                    "trackId": "track",
                    "clipId": "clip",
                    "recipe": recipe_id,
                }),
            )
            .unwrap_or_else(|error| panic!("advertised recipe '{recipe_id}' must parse: {error}"));
        }
    }

    #[test]
    fn should_advertise_text_preset_ids_from_the_core_registry() {
        let schema = build_command_schema();

        let hints = schema["payloadHints"]["AddTextClip"]["presetHints"]
            .as_array()
            .expect("AddTextClip must advertise presetHints");
        let advertised: Vec<&str> = hints.iter().filter_map(Value::as_str).collect();
        assert_eq!(advertised, text_preset_keys());

        // Every advertised spelling must round-trip through the strict parser.
        // The bug this closes advertised quote, watermark, and countdown while
        // the parser rejected all three.
        for key in text_preset_keys() {
            CommandPayload::parse(
                "AddTextClip".to_string(),
                serde_json::json!({
                    "sequenceId": "seq",
                    "trackId": "track",
                    "timelineIn": 0.0,
                    "duration": 3.0,
                    "preset": key,
                }),
            )
            .unwrap_or_else(|error| panic!("advertised preset '{key}' must parse: {error}"));
        }

        let catalog = schema["payloadHints"]["AddTextClip"]["presetCatalog"]
            .as_array()
            .expect("AddTextClip must describe what each preset is for");
        assert_eq!(catalog.len(), TEXT_PRESETS.len());
    }

    #[test]
    fn should_declare_the_add_text_clip_fields_the_parser_actually_requires() {
        // A hint is only worth reading if it matches the wire shape. `textData`
        // was left in `required` when `preset` was added, which tells a client
        // to hand-assemble the typography the preset field exists to replace.
        let schema = build_command_schema();
        let hint = &schema["payloadHints"]["AddTextClip"];

        let required: Vec<&str> = hint["required"]
            .as_array()
            .expect("required list")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let optional: Vec<&str> = hint["optional"]
            .as_array()
            .expect("optional list")
            .iter()
            .filter_map(Value::as_str)
            .collect();

        assert!(
            !required.contains(&"textData"),
            "textData is optional once a preset is named: {required:?}"
        );
        assert!(optional.contains(&"textData") && optional.contains(&"preset"));

        // The payload built from exactly the required fields plus a preset is
        // the one the hint promises works.
        let mut payload = serde_json::Map::new();
        for field in &required {
            payload.insert(
                (*field).to_string(),
                match *field {
                    "timelineIn" => serde_json::json!(0.0),
                    "duration" => serde_json::json!(3.0),
                    other => serde_json::json!(other),
                },
            );
        }
        payload.insert("preset".to_string(), serde_json::json!("centered-title"));
        CommandPayload::parse("AddTextClip".to_string(), Value::Object(payload))
            .expect("the advertised required set plus a preset must parse");

        // And without either half it must still fail, which is what the note says.
        CommandPayload::parse(
            "AddTextClip".to_string(),
            serde_json::json!({
                "sequenceId": "seq",
                "trackId": "track",
                "timelineIn": 0.0,
                "duration": 3.0,
            }),
        )
        .expect_err("neither preset nor textData must be rejected");
    }

    #[test]
    fn should_read_cached_annotation_for_asset() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("annotation_project");
        let project =
            openreelio_core::ActiveProject::create("Annotation Project", project_path.clone())
                .expect("project");
        let asset_id = "asset-annotation-1";
        drop(project);

        let annotation_dir = project_path.join(".openreelio").join("annotations");
        std::fs::create_dir_all(&annotation_dir).expect("annotation dir");
        std::fs::write(
            annotation_dir.join(format!("{asset_id}.json")),
            serde_json::json!({
                "version": "1",
                "assetId": asset_id,
                "assetHash": "hash",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "analysis": {
                    "faces": {
                        "provider": "google_cloud",
                        "analyzedAt": "2026-01-01T00:00:00Z",
                        "config": {},
                        "results": [{
                            "timeSec": 1.0,
                            "confidence": 0.9,
                            "boundingBox": { "left": 0.25, "top": 0.7, "width": 0.5, "height": 0.2 },
                            "emotions": []
                        }]
                    }
                }
            })
            .to_string(),
        )
        .expect("write annotation");

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.annotation.read",
                    "arguments": { "assetId": asset_id }
                }),
            ),
        );
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let value: Value = serde_json::from_str(text).expect("annotation JSON");

        assert_eq!(value["status"], "ok");
        assert_eq!(value["available"], true);
        assert_eq!(
            value["annotation"]["analysis"]["faces"]["results"][0]["confidence"],
            0.9
        );
    }

    #[test]
    fn should_reject_annotation_asset_id_path_traversal() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let state = McpServerState {
            project: Some(temp_dir.path().join("annotation_project")),
            ..Default::default()
        };

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.annotation.read",
                    "arguments": { "assetId": "../secret" }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32602);
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("assetId"));
    }

    #[test]
    fn should_return_openreelio_host_context_when_agent_calls_context_tool() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.host.context",
                    "arguments": {}
                }),
            ),
        );

        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let context: Value = serde_json::from_str(text).expect("context JSON");

        assert_eq!(context["host"]["appId"], "openreelio");
        assert_eq!(context["host"]["surface"], "external-mcp-client");
        assert_eq!(context["policy"]["approvalMode"], "read-only");
        assert_eq!(context["capabilities"]["planApplyWithApproval"], false);
    }

    #[test]
    fn should_reject_plan_apply_when_no_approval_token_is_configured() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "plan": { "id": "plan-1", "steps": [] }
                    }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32001);
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("approval token"));
    }

    #[test]
    fn should_reject_plan_apply_without_valid_approval_token() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("approval_denied_project");
        let project =
            openreelio_core::ActiveProject::create("Approval Denied", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_op_count = project.state.op_count;
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            approval_token: Some("expected-token".to_string()),
            ..Default::default()
        };
        let plan = serde_json::json!({
            "id": "denied-plan",
            "steps": [{
                "id": "step-1",
                "commandType": "AddTrack",
                "payload": {
                    "sequenceId": sequence_id,
                    "name": "Denied Track",
                    "kind": "video"
                },
                "dependsOn": []
            }]
        });

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "wrong-token",
                        "plan": plan
                    }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32001);
        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        assert_eq!(reopened.state.op_count, initial_op_count);
    }

    #[test]
    fn should_reject_plan_apply_when_approval_token_is_scoped_to_another_plan() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("wrong_plan_scope_project");
        let project =
            openreelio_core::ActiveProject::create("Wrong Plan Scope", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        drop(project);

        let state = McpServerState {
            project: Some(project_path),
            approval_token: Some("scoped-token".to_string()),
            approval_plan_id: Some("expected-plan".to_string()),
            ..Default::default()
        };
        let plan = serde_json::json!({
            "id": "actual-plan",
            "steps": [{
                "id": "step-1",
                "commandType": "AddTrack",
                "payload": {
                    "sequenceId": sequence_id,
                    "name": "Wrong Scope Track",
                    "kind": "video"
                },
                "dependsOn": []
            }]
        });

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "scoped-token",
                        "plan": plan
                    }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32001);
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("expected-plan"));
    }

    #[test]
    fn should_reject_media_insert_when_approval_token_is_plan_scoped() {
        let state = McpServerState {
            approval_token: Some("scoped-token".to_string()),
            approval_plan_id: Some("plan-1".to_string()),
            ..Default::default()
        };

        let error = apply_media_insert(
            &state,
            serde_json::json!({
                "approvalToken": "scoped-token",
                "sequenceId": "seq-1",
                "trackId": "track-1",
                "assetId": "asset-1",
                "timelineStart": 0
            }),
        )
        .expect_err("plan-scoped token should be rejected");

        assert!(error.to_string().contains("plan-1"));
        assert!(error.to_string().contains("openreelio.media.insert"));
    }

    #[test]
    fn should_reject_media_insert_when_approval_token_project_scope_differs() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("wrong_media_project_scope");
        let project =
            openreelio_core::ActiveProject::create("Wrong Media Scope", project_path.clone())
                .expect("project");
        let actual_project_id = project.state.meta.id.clone();
        drop(project);

        let state = McpServerState {
            project: Some(project_path),
            approval_token: Some("project-token".to_string()),
            approval_project_id: Some("expected-project".to_string()),
            ..Default::default()
        };

        let error = apply_media_insert(
            &state,
            serde_json::json!({
                "approvalToken": "project-token",
                "sequenceId": "seq-1",
                "trackId": "track-1",
                "assetId": "asset-1",
                "timelineStart": 0
            }),
        )
        .expect_err("wrong project-scoped token should be rejected");

        assert!(error.to_string().contains("expected-project"));
        assert!(error.to_string().contains(&actual_project_id));
    }

    #[test]
    fn should_insert_video_with_linked_audio_through_media_insert() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("linked_media_project");
        let media_path = temp_dir.path().join("clip.mp4");
        std::fs::write(&media_path, b"fake video bytes").expect("media fixture");

        let mut project =
            openreelio_core::ActiveProject::create("Linked Media", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let track_id = project.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Video | TrackKind::Overlay))
            .expect("video track")
            .id
            .clone();
        let import_command = ImportAssetCommand::new("clip.mp4", &media_path.to_string_lossy())
            .with_duration(8.0)
            .with_audio_info(AudioInfo::default());
        let asset_id = import_command.asset_id().to_string();
        project
            .executor
            .execute(Box::new(import_command), &mut project.state)
            .expect("import video asset");
        project.save().expect("save project");
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            approval_token: Some("media-token".to_string()),
            ..Default::default()
        };
        let result = apply_media_insert(
            &state,
            serde_json::json!({
                "approvalToken": "media-token",
                "sequenceId": sequence_id,
                "trackId": track_id,
                "assetId": asset_id,
                "timelineStart": 0.0
            }),
        )
        .expect("media insert");

        let linked_audio = result["linkedAudio"].as_object().expect("linked audio");
        let result_sequence_id = result["sequenceId"].as_str().expect("sequence id");
        let result_track_id = result["trackId"].as_str().expect("track id");
        let video_clip_id = result["clipId"].as_str().expect("video clip id");
        let audio_track_id = linked_audio["trackId"].as_str().expect("audio track id");
        let audio_clip_id = linked_audio["clipId"].as_str().expect("audio clip id");

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        let sequence = reopened
            .state
            .sequences
            .get(result_sequence_id)
            .expect("sequence");
        let video_clip = sequence
            .tracks
            .iter()
            .find(|track| track.id == result_track_id)
            .and_then(|track| track.clips.iter().find(|clip| clip.id == video_clip_id))
            .expect("video clip");
        let audio_clip = sequence
            .tracks
            .iter()
            .find(|track| track.id == audio_track_id)
            .and_then(|track| track.clips.iter().find(|clip| clip.id == audio_clip_id))
            .expect("audio clip");

        assert!(video_clip.audio.muted);
        assert!(video_clip.link_group_id.is_some());
        assert_eq!(video_clip.link_group_id, audio_clip.link_group_id);
    }

    #[test]
    fn should_report_plan_cycles_when_validating_mcp_plan() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.validate",
                    "arguments": {
                        "plan": {
                            "id": "cyclic-plan",
                            "steps": [
                                {
                                    "id": "step-a",
                                    "commandType": "AddTrack",
                                    "payload": {
                                        "sequenceId": "sequence-1",
                                        "name": "A",
                                        "kind": "video"
                                    },
                                    "dependsOn": ["step-b"]
                                },
                                {
                                    "id": "step-b",
                                    "commandType": "AddTrack",
                                    "payload": {
                                        "sequenceId": "sequence-1",
                                        "name": "B",
                                        "kind": "video"
                                    },
                                    "dependsOn": ["step-a"]
                                }
                            ]
                        }
                    }
                }),
            ),
        );

        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let result: Value = serde_json::from_str(text).expect("validate result JSON");
        assert_eq!(result["status"], "error");
        let errors = result["errors"].as_array().expect("errors");
        assert!(errors
            .iter()
            .any(|error| error.as_str().expect("error").contains("Cycle detected")));
    }

    /// The step cap lives in the shared validator, so MCP must inherit it
    /// without mcp.rs knowing the number.
    #[test]
    fn should_reject_an_over_cap_plan_through_the_mcp_validator() {
        let steps: Vec<Value> = (0..=plan::MAX_PLAN_STEPS)
            .map(|index| {
                serde_json::json!({
                    "id": format!("step-{index}"),
                    "commandType": "AddTrack",
                    "payload": { "sequenceId": "sequence-1", "name": "T", "kind": "video" }
                })
            })
            .collect();

        let result = call_plan_validate(serde_json::json!({
            "id": "over-cap",
            "steps": steps
        }));

        assert_eq!(result["status"], "error");
        assert!(
            result["errors"]
                .as_array()
                .expect("errors")
                .iter()
                .any(|error| error
                    .as_str()
                    .expect("error")
                    .contains("exceeds the maximum")),
            "the shared step cap must reach MCP: {result}"
        );
    }

    /// Asking what is wrong with a plan must answer with findings, not with a
    /// protocol failure the caller cannot act on.
    #[test]
    fn should_report_a_malformed_plan_as_validation_findings() {
        let result = call_plan_validate(serde_json::json!({
            "id": "malformed",
            "steps": [{ "id": "step-a", "payload": {} }]
        }));

        assert_eq!(result["status"], "error");
        assert_eq!(result["planId"], "malformed");
        assert!(!result["errors"].as_array().expect("errors").is_empty());
    }

    #[test]
    fn should_describe_real_plan_steps_in_both_plan_tool_schemas() {
        let state = McpServerState {
            allow_write: true,
            ..Default::default()
        };
        let tools = build_tools(&state);

        for name in ["openreelio.plan.validate", "openreelio.plan.apply"] {
            let schema = &tools
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("{name} must be advertised"))["inputSchema"]
                ["properties"]["plan"];

            let step = &schema["properties"]["steps"]["items"];
            assert_eq!(
                schema["required"],
                serde_json::json!(["id", "steps"]),
                "{name} must name the plan's required fields"
            );
            assert_eq!(
                step["required"],
                serde_json::json!(["id", "commandType", "payload"]),
                "{name} must describe a step instead of an opaque object"
            );
            assert!(step["properties"]["dependsOn"].is_object());
            assert_eq!(
                schema["properties"]["steps"]["maxItems"],
                plan::MAX_PLAN_STEPS
            );
        }
    }

    fn call_plan_validate(plan: Value) -> Value {
        let response = handle_jsonrpc_request(
            &McpServerState::default(),
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.validate",
                    "arguments": { "plan": plan }
                }),
            ),
        );
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        serde_json::from_str(text).expect("validate result JSON")
    }

    /// A plan that will not deserialize must still name the step at fault.
    ///
    /// Serde reports the first missing field once, with no step attribution; an
    /// agent holding a long plan cannot act on that.
    #[test]
    fn should_name_the_step_that_is_missing_a_required_field() {
        let result = call_plan_validate(serde_json::json!({
            "id": "shape-plan",
            "steps": [
                {
                    "id": "step-a",
                    "commandType": "AddTrack",
                    "payload": { "sequenceId": "sequence-1", "name": "A", "kind": "video" }
                },
                {
                    "id": "step-b",
                    "payload": { "sequenceId": "sequence-1", "name": "B", "kind": "video" }
                }
            ]
        }));

        assert_eq!(result["status"], "error");
        let errors = result["errors"].as_array().expect("errors");
        assert!(
            errors.iter().any(|error| {
                let error = error.as_str().expect("error");
                error.contains("step-b")
                    && error.contains("index 1")
                    && error.contains("commandType")
            }),
            "the report must say which step lacks which field: {result}"
        );
        assert!(
            !errors
                .iter()
                .any(|error| error.as_str().expect("error").contains("step-a")),
            "the sound step must not be blamed: {result}"
        );
    }

    /// A step that is not an object at all is attributed by index.
    #[test]
    fn should_report_a_non_object_step_by_index() {
        let result = call_plan_validate(serde_json::json!({
            "id": "shape-plan",
            "steps": ["not-a-step"]
        }));

        assert_eq!(result["status"], "error");
        assert!(
            result["errors"]
                .as_array()
                .expect("errors")
                .iter()
                .any(|error| error
                    .as_str()
                    .expect("error")
                    .contains("Step at index 0 must be a JSON object")),
            "{result}"
        );
    }

    #[test]
    fn should_not_advertise_plan_apply_when_approval_token_is_expired() {
        let state = McpServerState {
            approval_token: Some("expired-token".to_string()),
            approval_expires_at_ms: Some(1),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();

        assert!(!names.contains(&"openreelio.plan.apply"));
    }

    #[test]
    fn should_reject_plan_apply_when_approval_token_is_expired() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("expired_approval_project");
        let project =
            openreelio_core::ActiveProject::create("Expired Approval", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_op_count = project.state.op_count;
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            approval_token: Some("expired-token".to_string()),
            approval_expires_at_ms: Some(1),
            ..Default::default()
        };
        let plan = serde_json::json!({
            "id": "expired-plan",
            "steps": [{
                "id": "step-1",
                "commandType": "AddTrack",
                "payload": {
                    "sequenceId": sequence_id,
                    "name": "Expired Track",
                    "kind": "video"
                },
                "dependsOn": []
            }]
        });

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "expired-token",
                        "plan": plan
                    }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32001);
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("expired"));
        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        assert_eq!(reopened.state.op_count, initial_op_count);
    }

    #[test]
    fn should_apply_plan_when_approval_token_matches() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("approval_project");
        let project = openreelio_core::ActiveProject::create("Approval", project_path.clone())
            .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_track_count = project
            .state
            .sequences
            .get(&sequence_id)
            .expect("sequence state")
            .tracks
            .len();
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            approval_token: Some("approved-token".to_string()),
            approval_plan_id: Some("approved-plan".to_string()),
            ..Default::default()
        };
        let plan = serde_json::json!({
            "id": "approved-plan",
            "steps": [{
                "id": "step-1",
                "commandType": "AddTrack",
                "payload": {
                    "sequenceId": sequence_id,
                    "name": "Approved Track",
                    "kind": "video"
                },
                "dependsOn": []
            }]
        });

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "approved-token",
                        "plan": plan
                    }
                }),
            ),
        );

        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let result: Value = serde_json::from_str(text).expect("apply result JSON");
        assert_eq!(result["status"], "ok");
        assert_eq!(result["planId"], "approved-plan");
        assert_eq!(result["stepsExecuted"], 1);

        // The where-to-look signal rides along with the shared plan applier, so
        // an MCP client gets the same answer as `plan execute` without the CLI
        // envelope. An empty list is the right answer for a bare AddTrack — an
        // empty track shows nothing — but the keys have to be there.
        assert_eq!(result["sequenceId"], sequence_id.as_str());
        assert!(
            result["affectedRanges"].is_array(),
            "plan.apply must report affectedRanges: {result}"
        );
        assert!(
            result["stepResults"][0]["affectedRanges"].is_array(),
            "every step result must report affectedRanges: {result}"
        );

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        let sequence = reopened
            .state
            .sequences
            .get(result["sequenceId"].as_str().unwrap_or(""))
            .or_else(|| reopened.state.sequences.get(&sequence_id))
            .expect("sequence after apply");
        assert_eq!(sequence.tracks.len(), initial_track_count + 1);
        assert!(sequence
            .tracks
            .iter()
            .any(|track| track.name == "Approved Track"));

        let replay_response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "approved-token",
                        "plan": {
                            "id": "approved-plan",
                            "steps": [{
                                "id": "step-1",
                                "commandType": "AddTrack",
                                "payload": {
                                    "sequenceId": sequence_id,
                                    "name": "Replay Track",
                                    "kind": "video"
                                },
                                "dependsOn": []
                            }]
                        }
                    }
                }),
            ),
        );
        assert_eq!(replay_response["error"]["code"], -32001);
        assert!(replay_response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("already been consumed"));
    }

    #[test]
    fn should_advertise_mutating_tools_without_a_token_when_allow_write_is_set() {
        let state = McpServerState {
            allow_write: true,
            ..Default::default()
        };
        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");

        let find = |name: &str| {
            tools
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("tool '{name}' must be advertised"))
                .clone()
        };

        for name in ["openreelio.media.insert", "openreelio.plan.apply"] {
            let required = find(name)["inputSchema"]["required"]
                .as_array()
                .expect("required array")
                .clone();
            assert!(
                !required.iter().any(|field| field == "approvalToken"),
                "{name} must not require approvalToken under --allow-write"
            );
        }

        assert_eq!(
            find("openreelio.media.insert")["inputSchema"]["required"],
            serde_json::json!(["sequenceId", "trackId", "assetId", "timelineStart"])
        );
        assert_eq!(
            find("openreelio.plan.apply")["inputSchema"]["required"],
            serde_json::json!(["plan"])
        );
    }

    #[test]
    fn should_keep_the_approval_token_required_without_allow_write() {
        let state = McpServerState {
            approval_token: Some("token".to_string()),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");
        let media_insert = tools
            .iter()
            .find(|tool| tool["name"] == "openreelio.media.insert")
            .expect("media insert tool");

        assert_eq!(
            media_insert["inputSchema"]["required"],
            serde_json::json!([
                "approvalToken",
                "sequenceId",
                "trackId",
                "assetId",
                "timelineStart"
            ])
        );
    }

    #[test]
    fn should_report_local_write_policy_when_allow_write_is_set() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let state = McpServerState {
            project: Some(temp_dir.path().to_path_buf()),
            allow_write: true,
            ..Default::default()
        };

        assert_eq!(
            build_policy(&state),
            serde_json::json!({
                "mode": "allow-write-local",
                "approvalMode": "allow-write-local",
                "mutations": "enabled",
                "rawMediaAccess": "transcription-generate,frame-extract",
                "cacheWrites": "frame-extract",
                "filesystemAccess": "project-write"
            })
        );
        assert_eq!(
            build_discovery_command(&state),
            "openreelio-cli mcp --stdio --project <project-path> --allow-write"
        );
        assert_eq!(
            build_policy(&McpServerState::default()),
            serde_json::json!({
                "mode": "read-only",
                "approvalMode": "read-only",
                "mutations": "disabled",
                "rawMediaAccess": "none",
                "cacheWrites": "none",
                "filesystemAccess": "none"
            })
        );
        assert_eq!(
            build_discovery_command(&McpServerState::default()),
            "openreelio-cli mcp --stdio --project <project-path>"
        );

        // Discovery and the host context describe the same server, so they must
        // not disagree about the mode or about filesystem access.
        let context = build_host_context(&state);
        assert_eq!(context["policy"], build_policy(&state));
        assert_eq!(context["policy"]["approvalMode"], "allow-write-local");
        assert_eq!(context["policy"]["filesystemAccess"], "project-write");
        assert_eq!(context["capabilities"]["planApplyWithApproval"], true);
        assert_eq!(context["capabilities"]["mediaInsertWithApproval"], true);
    }

    #[test]
    fn should_report_read_only_filesystem_access_without_a_write_grant() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let state = McpServerState {
            project: Some(temp_dir.path().to_path_buf()),
            ..Default::default()
        };

        let context = build_host_context(&state);
        assert_eq!(context["policy"]["filesystemAccess"], "project-readonly");
        assert_eq!(context["policy"]["mode"], "read-only");
        assert_eq!(context["policy"]["mutations"], "disabled");
        // `openreelio.frame.extract` writes the stills it returns into the
        // project's cache even here, so the policy discloses it rather than
        // letting "project-readonly" read as "writes nothing".
        assert_eq!(context["policy"]["cacheWrites"], "frame-extract");
    }

    #[test]
    fn should_report_token_authorized_policy_when_an_approval_token_is_active() {
        let state = McpServerState {
            approval_token: Some("token".to_string()),
            ..Default::default()
        };

        // The tool list already exposes the mutating tools here, so the policy
        // block must not claim the server is read-only.
        assert_eq!(build_policy(&state)["mode"], "approve-mutations");
        assert_eq!(build_policy(&state)["mutations"], "enabled");
        assert_eq!(
            build_discovery_command(&state),
            "openreelio-cli mcp --stdio --project <project-path>"
        );

        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "openreelio.plan.apply"));
    }

    #[test]
    fn should_apply_two_plans_in_a_row_when_allow_write_is_set() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("allow_write_plan_project");
        let project = openreelio_core::ActiveProject::create("Allow Write", project_path.clone())
            .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_track_count = project
            .state
            .sequences
            .get(&sequence_id)
            .expect("sequence state")
            .tracks
            .len();
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            allow_write: true,
            ..Default::default()
        };

        let apply = |track_name: &str| {
            handle_jsonrpc_request(
                &state,
                request(
                    "tools/call",
                    serde_json::json!({
                        "name": "openreelio.plan.apply",
                        "arguments": {
                            "plan": {
                                "id": format!("allow-write-{track_name}"),
                                "steps": [{
                                    "id": "step-1",
                                    "commandType": "AddTrack",
                                    "payload": {
                                        "sequenceId": sequence_id,
                                        "name": track_name,
                                        "kind": "video"
                                    },
                                    "dependsOn": []
                                }]
                            }
                        }
                    }),
                ),
            )
        };

        for track_name in ["First Track", "Second Track"] {
            let response = apply(track_name);
            let text = response["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or_else(|| panic!("apply '{track_name}' failed: {response}"));
            let result: Value = serde_json::from_str(text).expect("apply result JSON");
            assert_eq!(result["status"], "ok", "apply '{track_name}': {result}");
        }

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        let sequence = reopened
            .state
            .sequences
            .get(&sequence_id)
            .expect("sequence after apply");
        assert_eq!(sequence.tracks.len(), initial_track_count + 2);
    }

    #[test]
    fn should_insert_media_twice_when_allow_write_is_set() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("allow_write_media_project");
        let media_path = temp_dir.path().join("clip.mp4");
        std::fs::write(&media_path, b"fake video bytes").expect("media fixture");

        let mut project =
            openreelio_core::ActiveProject::create("Allow Write Media", project_path.clone())
                .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let track_id = project.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Video | TrackKind::Overlay))
            .expect("video track")
            .id
            .clone();
        let import_command = ImportAssetCommand::new("clip.mp4", &media_path.to_string_lossy())
            .with_duration(8.0)
            .with_audio_info(AudioInfo::default());
        let asset_id = import_command.asset_id().to_string();
        project
            .executor
            .execute(Box::new(import_command), &mut project.state)
            .expect("import video asset");
        project.save().expect("save project");
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            allow_write: true,
            ..Default::default()
        };

        let mut clip_ids = Vec::new();
        for timeline_start in [0.0, 10.0] {
            let result = apply_media_insert(
                &state,
                serde_json::json!({
                    "sequenceId": sequence_id,
                    "trackId": track_id,
                    "assetId": asset_id,
                    "timelineStart": timeline_start
                }),
            )
            .unwrap_or_else(|error| panic!("media insert at {timeline_start} failed: {error}"));
            clip_ids.push(result["clipId"].as_str().expect("clip id").to_string());
        }

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        let track = reopened.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .expect("video track after insert");
        for clip_id in &clip_ids {
            assert!(
                track.clips.iter().any(|clip| &clip.id == clip_id),
                "clip '{clip_id}' must survive the second insert"
            );
        }
    }

    #[test]
    fn should_always_advertise_the_verify_tool() {
        for state in [
            McpServerState::default(),
            McpServerState {
                allow_write: true,
                ..Default::default()
            },
        ] {
            let response =
                handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
            let tools = response["result"]["tools"].as_array().expect("tools array");
            assert!(
                tools.iter().any(|tool| tool["name"] == "openreelio.verify"),
                "verify is read-only-safe and must always be advertised"
            );
        }
    }

    #[test]
    fn should_run_structural_checks_through_the_verify_tool() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("verify_tool_project");
        let project = openreelio_core::ActiveProject::create("Verify Tool", project_path.clone())
            .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        drop(project);

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.verify",
                    "arguments": { "structuralOnly": true }
                }),
            ),
        );

        let text = response["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("verify tool failed: {response}"));
        let report: Value = serde_json::from_str(text).expect("verify report JSON");

        assert_eq!(report["target"]["sequenceId"], sequence_id);
        // Structural-only never invokes FFmpeg, so the tool works on a machine
        // that has none installed.
        assert_eq!(report["measurements"]["measured"], false);
        assert!(!report["checks"]
            .as_array()
            .expect("checks array")
            .is_empty());
    }

    /// Feature: Verifying a partial render over MCP
    /// Scenario: should advertise the window a partial render declares
    ///
    /// The tool's schema is the only thing a client reads before calling, and
    /// it is also what the unknown-argument guard checks against: a `fileRange`
    /// missing from it would be refused as a typo.
    #[test]
    fn should_advertise_the_file_range_argument_on_the_verify_tool() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
        let tools = response["result"]["tools"].as_array().expect("tools array");
        let verify = tools
            .iter()
            .find(|tool| tool["name"] == "openreelio.verify")
            .expect("verify is always advertised");

        let file_range = &verify["inputSchema"]["properties"]["fileRange"];
        assert_eq!(file_range["type"], "array");
        assert_eq!(file_range["minItems"], 2);
        assert_eq!(file_range["maxItems"], 2);
    }

    /// Feature: Verifying a partial render over MCP
    /// Scenario: should refuse a window that names no stretch of timeline
    ///
    /// The refusal comes from the shared engine, so it has to arrive in the
    /// client's own vocabulary rather than the command line's.
    #[test]
    fn should_refuse_a_verify_file_range_that_is_not_a_span() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("verify_range_project");
        drop(
            openreelio_core::ActiveProject::create("Verify Range", project_path.clone())
                .expect("project"),
        );

        let state = McpServerState {
            project: Some(project_path.clone()),
            ..Default::default()
        };
        let render = project_path.join("excerpt.mp4");
        std::fs::write(&render, b"not really a video").expect("placeholder render");

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.verify",
                    "arguments": { "file": "excerpt.mp4", "fileRange": [40.0, 10.0] }
                }),
            ),
        );

        let message = response["result"]["content"][0]["text"]
            .as_str()
            .or_else(|| response["error"]["message"].as_str())
            .unwrap_or_else(|| panic!("a refusal carries a message: {response}"));
        assert!(
            message.contains("fileRange"),
            "the refusal must name the argument the client sent: {message}"
        );
    }

    // ── openreelio.frame.extract ────────────────────────────────────────────

    /// Resolves FFmpeg exactly as the tool does, or `None` on a machine without
    /// it, so the image tests skip rather than fail there.
    fn ffmpeg_for_tests() -> Option<PathBuf> {
        crate::ffmpeg_env::ensure_ffmpeg()
            .ok()
            .map(|info| info.ffmpeg_path)
    }

    /// Builds a project whose single clip is backed by a real decodable video
    /// living inside the project directory.
    ///
    /// In-project media is a convenience only: `confine_sequence_media` accepts
    /// media anywhere local, and keeping the fixture inside the temp project
    /// keeps everything one test wrote in one directory.
    fn project_with_real_media(temp_dir: &tempfile::TempDir, name: &str) -> Option<PathBuf> {
        let ffmpeg = ffmpeg_for_tests()?;
        let media_path = temp_dir.path().join(name).join("clip.mp4");
        let (project_path, _, _) = project_with_media_asset(temp_dir, name, &media_path);

        // The helper leaves a placeholder at the asset's path; replace it with
        // something FFmpeg can actually decode a frame out of.
        let status = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x240:d=6",
                "-c:v",
                "mpeg4",
            ])
            .arg(&media_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()?;
        if !status.success() {
            eprintln!("Skipping frame extract test: ffmpeg could not write the fixture");
            return None;
        }

        Some(project_path)
    }

    fn frame_extract_state(project_path: PathBuf) -> McpServerState {
        McpServerState {
            project: Some(project_path),
            ..Default::default()
        }
    }

    /// Feature: MCP frame extraction
    /// Scenario: a refusal names an argument the client can actually send
    ///
    /// The engine builds every refusal out of this table, so a label that is not
    /// a property of the advertised schema tells a client to fix a key that does
    /// not exist. `assetId` was exactly that: the schema declared `assetId` while
    /// the refusals said `asset`.
    #[test]
    fn frame_argument_names_should_match_the_advertised_schema() {
        let state = McpServerState {
            project: Some(PathBuf::from("unused")),
            ..Default::default()
        };
        let tools = build_tools(&state);
        let properties = tools
            .iter()
            .find(|tool| tool["name"] == "openreelio.frame.extract")
            .and_then(|tool| tool["inputSchema"]["properties"].as_object())
            .expect("frame.extract advertises an object schema");

        let names = MCP_FRAME_ARGUMENT_NAMES;
        let declared = [
            names.file,
            names.file_range,
            names.asset,
            names.source_time,
            names.time,
            names.times,
            names.sequence,
            names.mode,
            names.max_width,
            names.grid,
            names.between,
            names.cell_width,
            names.cell_height,
            names.label_cells,
            names.at_cuts,
            names.at_transitions,
            names.at_captions,
            names.at_markers,
            names.per_shot,
            names.around,
            names.span,
            names.around_count,
            names.affected,
            names.after_op,
            names.ranges,
            names.limit,
        ];

        for name in declared {
            assert!(
                properties.contains_key(name),
                "frame.extract refuses in terms of '{name}', which its schema does not declare"
            );
        }
        // `format` and `count` are the two the engine accepts but this surface
        // never advertises: images travel inline as JPEG, and a sampled sheet
        // sizes itself. Naming them keeps the omission deliberate.
        assert!(!properties.contains_key(names.format));
        assert!(!properties.contains_key(names.count));
        assert_eq!(
            names.sequence, "sequenceId",
            "the surface's own spelling of the sequence argument"
        );
        assert_eq!(names.asset, "assetId");
    }

    #[test]
    fn should_reject_an_argument_no_tool_declares() {
        let state = McpServerState {
            project: Some(PathBuf::from("unused")),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": { "atCut": true }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32602);
        let message = response["error"]["message"]
            .as_str()
            .expect("an argument error carries a message");
        assert!(
            message.contains("atCut") && message.contains("atCuts"),
            "the refusal must name the key and what the tool does accept: {message}"
        );
    }

    /// Feature: MCP argument validation
    /// Scenario: a mutating tool's arguments are checked on a read-only server
    ///
    /// The known set used to be read from the advertised list, which drops the
    /// mutating pair when writes are off — so a misspelled `media.insert` was
    /// answered with a permission refusal alone, and the caller fixed the grant
    /// and hit the same typo again.
    #[test]
    fn should_reject_an_unknown_argument_on_a_tool_writes_are_off_for() {
        let state = McpServerState {
            project: Some(PathBuf::from("unused")),
            ..Default::default()
        };
        assert!(
            !state.mutations_enabled(),
            "the point of this test is a server that does not advertise the tool"
        );

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.media.insert",
                    "arguments": { "sequenceIdd": "seq-1" }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32602);
        let message = response["error"]["message"]
            .as_str()
            .expect("an argument error carries a message");
        assert!(
            message.contains("sequenceIdd"),
            "the refusal must name the misspelled key: {message}"
        );
    }

    /// Feature: MCP argument validation
    /// Scenario: a typo inside a nested object is named too
    #[test]
    fn should_reject_an_unknown_argument_inside_a_closed_sub_schema() {
        let state = McpServerState {
            project: Some(PathBuf::from("unused")),
            ..Default::default()
        };
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": { "ranges": [{ "startSec": 1.0, "endSecs": 2.0 }] }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32602);
        let message = response["error"]["message"]
            .as_str()
            .expect("an argument error carries a message");
        assert!(
            message.contains("ranges[0]") && message.contains("endSecs"),
            "the refusal must name the entry and the key: {message}"
        );
    }

    #[test]
    fn should_always_advertise_the_frame_extract_tool() {
        for state in [
            McpServerState::default(),
            McpServerState {
                allow_write: true,
                ..Default::default()
            },
        ] {
            let response =
                handle_jsonrpc_request(&state, request("tools/list", serde_json::json!({})));
            let tools = response["result"]["tools"].as_array().expect("tools array");
            assert!(
                tools
                    .iter()
                    .any(|tool| tool["name"] == "openreelio.frame.extract"),
                "seeing the edit is a read, so frame extraction must not need a write grant"
            );
        }
    }

    #[test]
    fn should_keep_text_only_tool_results_unchanged() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({ "name": "openreelio.preview.describe", "arguments": {} }),
            ),
        );

        // Image blocks must be additive: a tool that produces none serialises
        // exactly as it did before they existed.
        let content = response["result"]["content"]
            .as_array()
            .expect("content array");
        assert_eq!(content.len(), 1, "text-only results carry one block");
        assert_eq!(content[0]["type"], "text");
        assert!(content[0].get("data").is_none());
        assert!(content[0].get("mimeType").is_none());
        assert_eq!(
            content[0]["text"].as_str().expect("text block"),
            serde_json::to_string_pretty(&build_preview_state()).expect("pretty JSON")
        );
        assert_eq!(response["result"]["isError"], false);
    }

    #[test]
    fn should_refuse_to_read_a_render_outside_the_project() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_scope_project");
        let outside = temp_dir.path().join("outside_render.mp4");
        std::fs::write(&outside, b"fake render bytes").expect("outside render");

        let state = frame_extract_state(project_path);
        for requested in ["../outside_render.mp4", &outside.to_string_lossy()] {
            let error = run_frame_extract_tool(
                &state,
                serde_json::json!({ "time": 0.5, "file": requested }),
            )
            .expect_err("a render outside the project must be refused");
            assert!(
                matches!(error, ToolError::PermissionDenied(_)),
                "expected a confinement refusal, got {error:?}"
            );
        }
    }

    #[test]
    fn should_refuse_a_contact_sheet_larger_than_the_cell_cap() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_cap_project");
        let state = frame_extract_state(project_path);

        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({ "grid": "12x12", "between": [0.0, 4.0] }),
        )
        .expect_err("a grid past the cell cap must be refused");
        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains("144") && message.contains(&MAX_GRID_CELLS.to_string()),
            "the refusal must name what was asked for and the cap: {message}"
        );
    }

    #[test]
    fn should_refuse_more_stills_than_one_response_can_carry() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_stills_cap_project");
        let state = frame_extract_state(project_path);

        let times: Vec<f64> = (0..=MAX_INLINE_FRAME_STILLS)
            .map(|index| index as f64 * 0.1)
            .collect();
        let error = run_frame_extract_tool(&state, serde_json::json!({ "times": times }))
            .expect_err("an unbounded batch must be refused");
        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains(&MAX_INLINE_FRAME_STILLS.to_string()),
            "the refusal must name the cap: {message}"
        );
    }

    #[test]
    fn should_refuse_sheet_arguments_without_a_grid() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_sheet_flags_project");
        let state = frame_extract_state(project_path);

        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({ "time": 1.0, "labelCells": true }),
        )
        .expect_err("sheet-only arguments must be refused without a grid");
        assert!(matches!(error, ToolError::InvalidArguments(_)));
    }

    #[test]
    fn should_return_one_inline_image_per_still() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_still_project") else {
            return;
        };
        let state = frame_extract_state(project_path.clone());

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": { "time": 1.0 }
                }),
            ),
        );

        let content = response["result"]["content"]
            .as_array()
            .unwrap_or_else(|| panic!("frame extract failed: {response}"));
        assert_eq!(content.len(), 2, "one image block plus the metadata block");
        assert_image_block(&content[0], "image/jpeg");

        let payload: Value =
            serde_json::from_str(content[1]["text"].as_str().expect("text block")).expect("JSON");
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["count"], 1);

        // The still lands in the project's own cache, and the path is reported
        // so the caller can point other tools at it.
        let written = PathBuf::from(payload["frames"][0]["path"].as_str().expect("frame path"));
        assert!(written.exists(), "the reported path must exist");
        assert!(
            written.starts_with(
                project_path
                    .join(".openreelio")
                    .join("cache")
                    .join("frames")
            ),
            "frames must be written into the project frame cache, got {}",
            written.display()
        );
    }

    #[test]
    fn should_return_a_contact_sheet_as_one_image_with_cell_metadata() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_sheet_project") else {
            return;
        };
        let state = frame_extract_state(project_path);

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": {
                        "grid": "2x2",
                        "times": [0.0, 1.0, 2.0, 3.0],
                        "labelCells": true
                    }
                }),
            ),
        );

        let content = response["result"]["content"]
            .as_array()
            .unwrap_or_else(|| panic!("frame extract failed: {response}"));
        assert_eq!(
            content.len(),
            2,
            "a sheet is one image however many cells it holds"
        );
        assert_image_block(&content[0], "image/jpeg");

        let payload: Value =
            serde_json::from_str(content[1]["text"].as_str().expect("text block")).expect("JSON");
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["sheet"]["cols"], 2);
        assert_eq!(payload["sheet"]["rows"], 2);
        assert_eq!(payload["sheet"]["labeled"], true);

        // The cell map is what makes the image judgeable: every cell has to name
        // the timecode it shows and its place in the layout.
        let cells = payload["sheet"]["cells"]
            .as_array()
            .expect("cells array")
            .clone();
        assert_eq!(cells.len(), 4);
        for (index, cell) in cells.iter().enumerate() {
            assert_eq!(cell["index"], index);
            assert_eq!(cell["row"], index / 2);
            assert_eq!(cell["col"], index % 2);
            assert_eq!(cell["timelineSec"], index as f64);
        }
    }

    /// Splits the fixture's single clip so the timeline has a real cut.
    ///
    /// Both halves stay inside the six seconds of decodable media, so the frame
    /// before the cut and the frame after it can both actually be extracted.
    fn split_the_only_clip(project_path: &Path, at_sec: f64) {
        let mut project =
            super::super::load_project(&project_path.to_path_buf()).expect("project opens");
        let sequence_id = project
            .state
            .active_sequence_id
            .clone()
            .expect("active sequence");
        let (track_id, clip_id) = {
            let sequence = &project.state.sequences[&sequence_id];
            let track = sequence
                .tracks
                .iter()
                .find(|track| !track.clips.is_empty())
                .expect("a track with a clip");
            (track.id.clone(), track.clips[0].id.clone())
        };

        project
            .executor
            .execute(
                Box::new(SplitClipCommand::new(
                    &sequence_id,
                    &track_id,
                    &clip_id,
                    at_sec,
                )),
                &mut project.state,
            )
            .expect("split clip");
        project.save().expect("save project");
    }

    #[test]
    fn should_sheet_both_sides_of_every_cut_as_one_auto_sized_image() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_at_cuts_project") else {
            return;
        };
        split_the_only_clip(&project_path, 3.0);
        let state = frame_extract_state(project_path);

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": { "atCuts": true, "grid": "auto" }
                }),
            ),
        );

        let content = response["result"]["content"]
            .as_array()
            .unwrap_or_else(|| panic!("frame extract failed: {response}"));
        assert_eq!(
            content.len(),
            2,
            "an auto sheet is one image plus its metadata"
        );
        assert_image_block(&content[0], "image/jpeg");

        let payload: Value =
            serde_json::from_str(content[1]["text"].as_str().expect("text block")).expect("JSON");
        assert_eq!(payload["status"], "ok");
        // Two samples per cut, laid out side by side without the caller
        // choosing a layout.
        assert_eq!(payload["sheet"]["cols"], 2);
        assert_eq!(payload["sheet"]["rows"], 1);

        let cells = payload["sheet"]["cells"].as_array().expect("cells");
        assert_eq!(cells.len(), 2, "{payload}");
        // The reason is what makes the picture readable: the first cell is the
        // outgoing shot, the second the incoming one.
        assert_eq!(cells[0]["reason"], "cutBefore");
        assert_eq!(cells[1]["reason"], "cutAfter");
        assert_eq!(cells[1]["timelineSec"].as_f64(), Some(3.0));
        assert!(
            cells[0]["timelineSec"].as_f64().expect("cell time") < 3.0,
            "the outgoing frame has to be sampled before the cut: {payload}"
        );

        assert_eq!(payload["sampler"]["kinds"][0], "atCuts");
        assert_eq!(payload["sampler"]["selected"], 2);
        assert_eq!(payload["sampler"]["limited"], false);
    }

    /// Writes a decodable `render.mp4` of `duration_sec` inside the project.
    ///
    /// Stands in for a draft render of one stretch of the timeline: what the
    /// file samplers need from it is a real video stream of the right length in
    /// its own timebase, which is what a range render produces. The end-to-end
    /// path through `render start --proxy` is covered by the CLI integration
    /// tests, which drive the real binary.
    fn rendered_range_file(project_path: &Path, duration_sec: f64) -> Option<String> {
        let ffmpeg = ffmpeg_for_tests()?;
        let output = project_path.join("render.mp4");
        let status = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=white:s=320x240:r=25:d={duration_sec}"),
                "-c:v",
                "mpeg4",
            ])
            .arg(&output)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()?;
        if !status.success() || !output.exists() {
            eprintln!("Skipping file-sampler test: ffmpeg could not write the render fixture");
            return None;
        }

        Some("render.mp4".to_string())
    }

    #[test]
    fn should_sheet_both_sides_of_a_cut_inside_a_rendered_range() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_file_range_project")
        else {
            return;
        };
        split_the_only_clip(&project_path, 3.0);
        // A draft of timeline 2.0s-5.0s: three seconds of picture starting at
        // the file's own zero.
        let Some(file) = rendered_range_file(&project_path, 3.0) else {
            return;
        };
        let state = frame_extract_state(project_path);

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": {
                        "file": file,
                        "fileRange": [2.0, 5.0],
                        "atCuts": true,
                        "grid": "auto"
                    }
                }),
            ),
        );

        let content = response["result"]["content"]
            .as_array()
            .unwrap_or_else(|| panic!("frame extract failed: {response}"));
        assert_eq!(content.len(), 2, "an auto sheet is one image plus metadata");
        assert_image_block(&content[0], "image/jpeg");

        let payload: Value =
            serde_json::from_str(content[1]["text"].as_str().expect("text block")).expect("JSON");
        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["mode"], "file");
        assert_eq!(
            payload["source"]["timelineRange"],
            serde_json::json!([2.0, 5.0])
        );

        let cells = payload["sheet"]["cells"].as_array().expect("cells");
        assert_eq!(cells.len(), 2, "{payload}");
        assert_eq!(cells[0]["reason"], "cutBefore");
        assert_eq!(cells[1]["reason"], "cutAfter");
        // Both keys, because they answer different questions: where in this
        // file, and where in the edit.
        assert_eq!(cells[1]["timelineSec"].as_f64(), Some(3.0));
        assert_eq!(cells[1]["fileSec"].as_f64(), Some(1.0));
        let before_file_sec = cells[0]["fileSec"].as_f64().expect("cell file time");
        assert!(
            before_file_sec < 1.0 && before_file_sec > 0.0,
            "the outgoing frame sits just before the cut, inside the file: {payload}"
        );

        assert_eq!(payload["sampler"]["kinds"][0], "atCuts");
        assert_eq!(payload["sampler"]["selected"], 2);
        assert_eq!(payload["sampler"]["droppedOutsideFile"], 0);
    }

    /// Feature: MCP frame extraction
    /// Scenario: sampling a render does not need the sequence's media
    ///
    /// The samplers read the sequence for cut and caption *times*; every picture
    /// comes out of the confined file, and no clip's media is opened. Refusing
    /// the call because some clip is on a disconnected drive turned a perfectly
    /// answerable question about an artifact that already exists into a refusal
    /// — and the in-app IPC, which shares this engine, never did that.
    #[test]
    fn should_sample_a_render_even_when_the_sequences_media_is_off_host() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir.path().join("off_host_sampler").join("clip.mp4");
        let (project_path, _sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "off_host_sampler", &inside_media);
        // A cut inside the declared range, so the sampler has something to find
        // and the run reaches the file it was asked to read.
        split_the_only_clip(&project_path, 1.5);

        let mut project = super::super::load_project(&project_path).expect("load project");
        project.state.assets.get_mut(&asset_id).expect("asset").uri =
            "\\\\attacker.example\\share\\probe.mp4".to_string();
        project
            .state
            .assets
            .get_mut(&asset_id)
            .expect("asset")
            .relative_path = None;
        project.save().expect("save project");
        drop(project);

        let state = frame_extract_state(project_path);
        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.frame.extract",
                    "arguments": {
                        "file": "draft.mp4",
                        "fileRange": [0.0, 3.0],
                        "atCuts": true,
                        "grid": "auto"
                    }
                }),
            ),
        );

        // The render itself was never written, so this still fails — but on the
        // file it was asked to read, not on media it was never going to open.
        let message = response["error"]["message"]
            .as_str()
            .unwrap_or_else(|| panic!("the missing draft must be reported: {response}"));
        assert!(
            message.contains("draft.mp4") && message.contains("not found"),
            "the refusal must be about the render, got: {message}"
        );
        assert!(
            !message.contains("UNC") && !message.contains("network path"),
            "the sequence's media is never opened by a sampled file: {message}"
        );
    }

    #[test]
    fn should_refuse_a_sampler_on_a_rendered_file_that_declares_no_range() {
        let error = FrameExtractRequest::parse(&serde_json::json!({
            "file": "render.mp4",
            "atCuts": true,
            "grid": "auto"
        }))
        .expect_err("a rendered video has no timeline of its own to sample");

        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains("fileRange"),
            "the refusal must name the argument that lifts it: {message}"
        );
    }

    #[test]
    fn should_accept_a_sampler_on_a_rendered_file_that_declares_its_range() {
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "file": "render.mp4",
            "fileRange": [2.0, 6.0],
            "atCuts": true,
            "grid": "auto"
        }))
        .expect("a declared range makes the render samplable");

        let args = request.into_extract_args(
            PathBuf::from("project"),
            PathBuf::from("project/sheet.jpg"),
            Some(PathBuf::from("project/render.mp4")),
            Some("seq-resolved".to_string()),
        );
        assert_eq!(args.file_range, Some(vec![2.0, 6.0]));
        assert!(args.at_cuts);
    }

    #[test]
    fn should_reject_a_file_range_that_names_nothing_usable() {
        for arguments in [
            // No file to declare a range for.
            serde_json::json!({ "time": 1.0, "fileRange": [2.0, 6.0] }),
            // Reversed, and zero-width.
            serde_json::json!({ "file": "render.mp4", "time": 1.0, "fileRange": [6.0, 2.0] }),
            serde_json::json!({ "file": "render.mp4", "time": 1.0, "fileRange": [2.0, 2.0] }),
            // Negative, and the wrong number of values.
            serde_json::json!({ "file": "render.mp4", "time": 1.0, "fileRange": [-1.0, 6.0] }),
            serde_json::json!({ "file": "render.mp4", "time": 1.0, "fileRange": [2.0] }),
        ] {
            assert!(
                FrameExtractRequest::parse(&arguments).is_err(),
                "{arguments} is not a usable declaration"
            );
        }
    }

    #[test]
    fn should_accept_a_declared_range_alongside_file_relative_times() {
        // Allowed and useful: the times stay file-relative, and the payload
        // still records which seconds of the edit the file holds.
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "file": "render.mp4",
            "fileRange": [2.0, 6.0],
            "times": [0.5, 1.5]
        }))
        .expect("a declared range needs no sampler");

        assert_eq!(request.file_range, Some(vec![2.0, 6.0]));
    }

    #[test]
    fn should_refuse_a_sampler_combined_with_a_hand_written_time_list() {
        let error = FrameExtractRequest::parse(&serde_json::json!({
            "atCuts": true,
            "times": [1.0, 2.0]
        }))
        .expect_err("a sampler and a list describe different pictures");

        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains("times"),
            "the refusal must name the conflicting selector: {message}"
        );
    }

    #[test]
    fn should_sample_the_ranges_the_caller_names_without_reading_the_record() {
        // What a client sends straight after an apply: the `affectedRanges` the
        // apply itself reported. No hand-off file is read, so nothing another
        // surface does in between can redirect the look.
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "ranges": [{ "startSec": 1.0, "endSec": 2.5 }, { "startSec": 9.0, "endSec": 9.0 }],
            "grid": "auto"
        }))
        .expect("named ranges are a sampler in their own right");

        assert!(!request.affected, "no record is consulted");
        let args = request.into_extract_args(
            PathBuf::from("project"),
            PathBuf::from("project/sheet.jpg"),
            None,
            Some("seq".to_string()),
        );
        // Flattened into the CLI's own repeated `--range START END` shape.
        assert_eq!(args.range, Some(vec![1.0, 2.5, 9.0, 9.0]));
    }

    #[test]
    fn should_refuse_named_ranges_alongside_the_recorded_ones() {
        let error = FrameExtractRequest::parse(&serde_json::json!({
            "ranges": [{ "startSec": 1.0, "endSec": 2.5 }],
            "affected": true
        }))
        .expect_err("two authorities on the same ranges cannot both be honoured");

        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains("affected") && message.contains("ranges"),
            "the refusal must name both sources: {message}"
        );
    }

    #[test]
    fn should_refuse_malformed_ranges_and_an_orphaned_after_op() {
        for arguments in [
            serde_json::json!({ "ranges": [] }),
            serde_json::json!({ "ranges": [{ "startSec": 2.0, "endSec": 1.0 }] }),
            serde_json::json!({ "ranges": [{ "startSec": -1.0, "endSec": 1.0 }] }),
            serde_json::json!({ "ranges": [{ "startSec": 1.0 }] }),
            serde_json::json!({ "ranges": "1.0,2.0" }),
            // `afterOp` checks the record `affected` reads; without it there is
            // no record in play to check.
            serde_json::json!({ "atCuts": true, "afterOp": "op-1" }),
        ] {
            let error = FrameExtractRequest::parse(&arguments)
                .expect_err(&format!("{arguments} must be refused"));
            assert!(
                matches!(error, ToolError::InvalidArguments(_)),
                "{arguments} must be an argument refusal, got {error:?}"
            );
        }

        let checked = FrameExtractRequest::parse(&serde_json::json!({
            "affected": true,
            "afterOp": "op-1"
        }))
        .expect("afterOp belongs with affected");
        assert_eq!(checked.after_op.as_deref(), Some("op-1"));
    }

    #[test]
    fn should_accept_a_sampler_with_an_explicit_grid() {
        // A sampler is its own time source, and `between`/`times` are refused
        // alongside one — so demanding them here rejected the only shape a
        // sampled sheet with a fixed layout can have.
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "atCuts": true,
            "grid": "4x3"
        }))
        .expect("a sampler sizes its own sheet");

        assert!(request.at_cuts);
        assert_eq!(request.grid.as_deref(), Some("4x3"));
    }

    #[test]
    fn should_still_refuse_a_sampler_sheet_whose_image_is_too_large() {
        let error = FrameExtractRequest::parse(&serde_json::json!({
            "atCuts": true,
            "grid": "8x8",
            "cellWidth": 1024,
            "cellHeight": 1024
        }))
        .expect_err("the finished image is knowable before anything is sampled");

        assert!(matches!(error, ToolError::InvalidArguments(_)));
    }

    #[test]
    fn should_refuse_an_auto_grid_with_nothing_to_size_it_from() {
        let error = FrameExtractRequest::parse(&serde_json::json!({
            "grid": "auto",
            "between": [0.0, 4.0]
        }))
        .expect_err("between already fixes its own count");

        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains("COLSxROWS"),
            "the refusal must point at an explicit layout: {message}"
        );
    }

    #[test]
    fn should_cap_a_sampler_batch_at_the_inline_still_budget() {
        // A sheet is one image whatever it holds, so only the batch path is
        // capped — and the cap is applied as the caller's own limit, because
        // the sample count is not known until the sequence is read.
        let batch = FrameExtractRequest::parse(&serde_json::json!({ "perShot": true }))
            .expect("a sampler batch parses")
            .into_extract_args(
                PathBuf::from("project"),
                PathBuf::from("project/stills"),
                None,
                Some("seq".to_string()),
            );
        assert_eq!(batch.limit, Some(MAX_INLINE_FRAME_STILLS));

        let sheet =
            FrameExtractRequest::parse(&serde_json::json!({ "perShot": true, "grid": "auto" }))
                .expect("a sampler sheet parses")
                .into_extract_args(
                    PathBuf::from("project"),
                    PathBuf::from("project/sheet.jpg"),
                    None,
                    Some("seq".to_string()),
                );
        assert_eq!(sheet.limit, None, "a sheet needs no still budget");

        let error = FrameExtractRequest::parse(
            &serde_json::json!({ "perShot": true, "limit": MAX_INLINE_FRAME_STILLS + 1 }),
        )
        .expect_err("an oversized batch must be refused");
        assert!(matches!(error, ToolError::InvalidArguments(_)));
    }

    #[test]
    fn should_carry_every_sampler_through_to_the_extraction_arguments() {
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "affected": true,
            "atCuts": true,
            "atTransitions": true,
            "atCaptions": true,
            "atMarkers": true,
            "perShot": true,
            "around": 4.25,
            "span": 0.75,
            "aroundCount": 7,
            "limit": 9,
            "grid": "auto"
        }))
        .expect("a fully specified sampler request parses");

        let args = request.into_extract_args(
            PathBuf::from("project"),
            PathBuf::from("project/sheet.jpg"),
            None,
            Some("seq-resolved".to_string()),
        );

        // Every flag here decides which seconds are looked at, and the mapping
        // is written out by hand — a transposed pair would still compile.
        assert!(args.affected);
        assert!(args.at_cuts);
        assert!(args.at_transitions);
        assert!(args.at_captions);
        assert!(args.at_markers);
        assert!(args.per_shot);
        assert_eq!(args.around, Some(4.25));
        assert_eq!(args.span, Some(0.75));
        assert_eq!(args.around_count, Some(7));
        assert_eq!(args.limit, Some(9));
        assert_eq!(args.grid.as_deref(), Some("auto"));
    }

    #[test]
    fn should_carry_every_sheet_selector_through_to_the_extraction_arguments() {
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "grid": "2x2",
            "times": [0.0, 1.0, 2.0, 3.0],
            "mode": "composite",
            "maxWidth": 1920,
            "cellWidth": 512,
            "cellHeight": 288,
            "labelCells": true,
            "sequenceId": "seq-requested"
        }))
        .expect("a fully specified sheet request parses");
        assert_eq!(request.sequence_id.as_deref(), Some("seq-requested"));

        let args = request.into_extract_args(
            PathBuf::from("project"),
            PathBuf::from("project/sheet.jpg"),
            None,
            Some("seq-resolved".to_string()),
        );

        // Every one of these decides what FFmpeg is actually asked for, and the
        // mapping is written out by hand — a transposed pair would still compile.
        assert_eq!(args.grid.as_deref(), Some("2x2"));
        assert_eq!(args.times, Some(vec![0.0, 1.0, 2.0, 3.0]));
        assert_eq!(args.mode.as_deref(), Some("composite"));
        assert_eq!(args.max_width, Some(1920));
        assert_eq!(args.cell_width, Some(512));
        assert_eq!(args.cell_height, Some(288));
        assert!(args.label_cells);
        // The server resolves the sequence itself, so the extraction gets the
        // resolved id rather than whatever the client typed.
        assert_eq!(args.sequence.as_deref(), Some("seq-resolved"));
        assert_eq!(args.format.as_deref(), Some("jpeg"));
        assert_eq!(args.out, PathBuf::from("project/sheet.jpg"));
    }

    #[test]
    fn should_carry_a_composite_still_request_through_to_the_extraction_arguments() {
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "time": 4.2,
            "mode": "composite",
            "maxWidth": 640
        }))
        .expect("a composite still request parses");

        let args = request.into_extract_args(
            PathBuf::from("project"),
            PathBuf::from("project/frame.jpg"),
            None,
            Some("seq-resolved".to_string()),
        );

        // A lost `mode` degrades silently to fast, which returns a topmost-clip
        // frame with no effects or text — a wrong answer rather than an error.
        assert_eq!(args.mode.as_deref(), Some("composite"));
        assert_eq!(args.time, Some(4.2));
        assert_eq!(args.max_width, Some(640));
        assert!(args.grid.is_none());
        assert!(args.cell_width.is_none());
        assert!(args.cell_height.is_none());
    }

    #[test]
    fn should_refuse_a_still_wider_than_one_response_can_carry() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_width_cap_project");
        let state = frame_extract_state(project_path);

        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({ "time": 1.0, "maxWidth": MAX_STILL_WIDTH_PX + 1 }),
        )
        .expect_err("an unbounded still width must be refused");
        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal");
        };
        assert!(
            message.contains(&MAX_STILL_WIDTH_PX.to_string()),
            "the refusal must name the cap: {message}"
        );
    }

    #[test]
    fn should_refuse_a_contact_sheet_no_vision_host_would_accept() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_sheet_pixel_cap_project");
        let state = frame_extract_state(project_path);

        // Both limbs are inside every advertised cap — 64 cells is under 100 and
        // 1024px cells are the documented maximum — yet the sheet is 8192px wide.
        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({
                "grid": "8x8",
                "between": [0.0, 4.0],
                "cellWidth": MAX_CELL_SIZE_PX
            }),
        )
        .expect_err("a sheet past the pixel cap must be refused");
        let ToolError::InvalidArguments(message) = error else {
            panic!("expected an argument refusal, not an execution failure");
        };
        assert!(
            message.contains("8192") && message.contains(&MAX_SHEET_DIMENSION_PX.to_string()),
            "the refusal must name the computed size and the limit: {message}"
        );
    }

    #[test]
    fn should_measure_the_sheet_the_extraction_will_actually_build() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_sheet_rows_project");
        let state = frame_extract_state(project_path);

        // A 1x10 column of 1024px cells is 10240px tall on paper, but the
        // extraction drops rows no sample reaches, so four times build a 4-row
        // sheet that fits. Measuring the requested rows would refuse a legal
        // sheet.
        let request = FrameExtractRequest::parse(&serde_json::json!({
            "grid": "1x10",
            "times": [0.0, 1.0, 2.0, 3.0],
            "cellHeight": MAX_CELL_SIZE_PX
        }));
        assert!(
            request.is_ok(),
            "a short time list shrinks the sheet: {:?}",
            request.err()
        );

        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({
                "grid": "1x10",
                "between": [0.0, 4.0],
                "cellHeight": MAX_CELL_SIZE_PX
            }),
        )
        .expect_err("a full column of maximum cells must be refused");
        assert!(matches!(error, ToolError::InvalidArguments(_)));
    }

    #[test]
    fn should_not_leave_a_cache_directory_behind_when_the_extraction_fails() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_cache_failure_project");
        let state = frame_extract_state(project_path.clone());

        // The bytes are not a video, so the extraction fails inside FFmpeg —
        // after the cache directory has already been created for it.
        let error = run_frame_extract_tool(
            &state,
            serde_json::json!({ "time": 0.5, "file": "render.mp4" }),
        )
        .expect_err("a fake render cannot be extracted from");
        assert!(matches!(error, ToolError::Execution(_)));

        let cache_root = frame_cache_dir(&project_path);
        let leftovers = std::fs::read_dir(&cache_root)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        assert_eq!(
            leftovers,
            0,
            "a failed extraction must not leave an entry in {}",
            cache_root.display()
        );
    }

    #[test]
    fn should_not_create_a_cache_directory_for_a_rejected_request() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "frame_cache_rejected_project");
        let state = frame_extract_state(project_path.clone());

        run_frame_extract_tool(
            &state,
            serde_json::json!({ "grid": "12x12", "between": [0.0, 4.0] }),
        )
        .expect_err("a grid past the cell cap must be refused");

        assert!(
            !frame_cache_dir(&project_path).exists(),
            "a refused request must not touch the cache at all"
        );
    }

    #[test]
    fn should_size_the_contact_sheet_from_the_requested_cell_size() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_cell_size_project")
        else {
            return;
        };
        let state = frame_extract_state(project_path);

        let sheet = |arguments: Value| -> (usize, usize) {
            let response = handle_jsonrpc_request(
                &state,
                request(
                    "tools/call",
                    serde_json::json!({
                        "name": "openreelio.frame.extract",
                        "arguments": arguments
                    }),
                ),
            );
            let content = response["result"]["content"]
                .as_array()
                .unwrap_or_else(|| panic!("frame extract failed: {response}"));
            assert_image_block(&content[0], "image/jpeg");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(content[0]["data"].as_str().expect("image data"))
                .expect("image data must be valid base64");
            jpeg_dimensions(&bytes)
        };

        let (default_width, default_height) = sheet(serde_json::json!({
            "grid": "2x2",
            "times": [0.0, 1.0, 2.0, 3.0]
        }));
        let (custom_width, custom_height) = sheet(serde_json::json!({
            "grid": "2x2",
            "times": [0.0, 1.0, 2.0, 3.0],
            "cellWidth": 200,
            "cellHeight": 120
        }));

        // The cell size has to reach the tiler, not just the JSON: a sheet built
        // at the default geometry would report the requested cells and return
        // the wrong picture.
        assert!(
            custom_width < default_width && custom_height < default_height,
            "a smaller cell must produce a smaller sheet: {custom_width}x{custom_height} \
             vs default {default_width}x{default_height}"
        );
        // Two columns of 200px plus the tiler's padding and margin.
        assert!(
            (400..=464).contains(&custom_width) && (240..=304).contains(&custom_height),
            "the sheet must be two 200x120 cells wide and tall, got {custom_width}x{custom_height}"
        );
    }

    #[test]
    fn should_extract_from_the_project_snapshot_the_confinement_approved() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let Some(project_path) = project_with_real_media(&temp_dir, "frame_shared_project") else {
            return;
        };
        let project = super::super::load_project(&project_path).expect("project opens");

        let out = temp_dir.path().join("shared_snapshot_frame.jpg");
        let args = frame::ExtractArgs {
            // Deliberately bogus: `load_project` cannot resolve it, so an
            // extraction that re-opened the project would fail here. Succeeding
            // is the proof that `confine_sequence_media` and FFmpeg read one
            // snapshot rather than two replays of the log.
            path: temp_dir.path().join("this_directory_does_not_exist"),
            out: out.clone(),
            file: None,
            file_range: None,
            asset: None,
            source_time: None,
            time: Some(1.0),
            times: None,
            sequence: None,
            mode: None,
            max_width: None,
            format: Some("jpeg".to_string()),
            grid: None,
            between: None,
            count: None,
            cell_width: None,
            cell_height: None,
            label_cells: false,
            at_cuts: false,
            at_transitions: false,
            at_captions: false,
            at_markers: false,
            per_shot: false,
            around: None,
            span: None,
            around_count: None,
            affected: false,
            after_op: None,
            range: None,
            limit: None,
            names: frame::CLI_ARGUMENT_NAMES,
        };

        frame::run_extract_with_project(args, &project)
            .expect("the handed project must be the one extracted from");
        assert!(out.exists(), "the still must have been written");
    }

    /// Reads a JPEG's pixel dimensions from its first frame header.
    ///
    /// Inlined rather than pulled in as a decoding dependency the crate does not
    /// otherwise need: the assertion only asks how large the sheet is.
    fn jpeg_dimensions(bytes: &[u8]) -> (usize, usize) {
        let mut index = 2; // Past the SOI marker.
        while index + 9 < bytes.len() {
            assert_eq!(bytes[index], 0xFF, "expected a JPEG marker at byte {index}");
            // A marker may be preceded by any number of 0xFF fill bytes.
            let mut marker_at = index + 1;
            while bytes[marker_at] == 0xFF {
                marker_at += 1;
            }
            let marker = bytes[marker_at];
            let length = usize::from(u16::from_be_bytes([
                bytes[marker_at + 1],
                bytes[marker_at + 2],
            ]));

            // SOF0..SOF15 carry the dimensions; DHT, JPG and DAC share the range.
            if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                let height = u16::from_be_bytes([bytes[marker_at + 4], bytes[marker_at + 5]]);
                let width = u16::from_be_bytes([bytes[marker_at + 6], bytes[marker_at + 7]]);
                return (usize::from(width), usize::from(height));
            }
            index = marker_at + 1 + length;
        }

        panic!("no frame header in the JPEG");
    }

    /// Asserts a content block is a usable MCP image.
    fn assert_image_block(block: &Value, expected_mime_type: &str) {
        assert_eq!(block["type"], "image");
        assert_eq!(block["mimeType"], expected_mime_type);

        let encoded = block["data"].as_str().expect("image data");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("image data must be valid base64");
        assert!(!bytes.is_empty(), "an empty image is not an image");
        assert_eq!(
            &bytes[..3],
            &[0xFF, 0xD8, 0xFF],
            "the bytes must actually be the JPEG the mimeType claims"
        );
    }

    #[test]
    fn should_reject_verify_arguments_that_contradict_each_other() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let state = McpServerState {
            project: Some(temp_dir.path().join("verify_conflict_project")),
            ..Default::default()
        };

        let error = run_verify_tool(
            &state,
            serde_json::json!({ "file": "render.mp4", "structuralOnly": true }),
        )
        .expect_err("file and structuralOnly must conflict");

        assert!(error.to_string().contains("structuralOnly"));
    }

    /// Creates a project with one rendered-looking file inside it.
    fn project_with_file(temp_dir: &tempfile::TempDir, name: &str) -> (PathBuf, PathBuf) {
        let project_path = temp_dir.path().join(name);
        openreelio_core::ActiveProject::create("Confinement", project_path.clone())
            .expect("project");
        let file_path = project_path.join("render.mp4");
        std::fs::write(&file_path, b"not a real render").expect("write render");
        (project_path, file_path)
    }

    #[test]
    fn should_accept_a_verify_file_inside_the_project_directory() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, file_path) = project_with_file(&temp_dir, "confined_project");

        let relative = confine_to_project(&project_path, "file", "render.mp4")
            .expect("a path inside the project must be accepted");
        let absolute = confine_to_project(&project_path, "file", &file_path.to_string_lossy())
            .expect("an absolute path inside the project must be accepted");

        for resolved in [relative, absolute] {
            assert_eq!(
                std::fs::canonicalize(&resolved).expect("canonicalize resolved"),
                std::fs::canonicalize(&file_path).expect("canonicalize expected")
            );
        }
    }

    #[test]
    fn should_reject_verify_file_paths_that_escape_the_project_directory() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "escape_project");
        let outside = temp_dir.path().join("outside.mp4");
        std::fs::write(&outside, b"outside the project").expect("write outside file");

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };

        for hostile in [
            outside.to_string_lossy().to_string(),
            "../outside.mp4".to_string(),
            "sub/../../outside.mp4".to_string(),
            "\\\\attacker\\share\\probe.mp4".to_string(),
            "//attacker/share/probe.mp4".to_string(),
            "http://attacker.example/probe.mp4".to_string(),
        ] {
            let error = run_verify_tool(&state, serde_json::json!({ "file": hostile.clone() }))
                .expect_err(&format!("'{hostile}' must be rejected"));
            assert!(
                matches!(error, ToolError::PermissionDenied(_)),
                "'{hostile}' must be denied by policy, got {error:?}"
            );
        }
    }

    #[test]
    fn should_not_report_whether_an_out_of_scope_path_exists() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "oracle_project");
        let existing_outside = temp_dir.path().join("exists.mp4");
        std::fs::write(&existing_outside, b"outside the project").expect("write outside file");
        let missing_outside = temp_dir.path().join("missing.mp4");

        // An existence oracle is exactly what confinement removes, so both
        // answers have to look the same to the client.
        let existing_error =
            confine_to_project(&project_path, "file", &existing_outside.to_string_lossy())
                .expect_err("an existing file outside the project must be rejected");
        let missing_error =
            confine_to_project(&project_path, "file", &missing_outside.to_string_lossy())
                .expect_err("a missing file outside the project must be rejected");

        assert_eq!(
            existing_error.to_string().replace("exists", "missing"),
            missing_error.to_string()
        );
    }

    /// Builds a project holding one asset backed by `media_path`, with the asset
    /// placed on the active sequence. Returns the project path, sequence ID, and
    /// asset ID.
    ///
    /// The media fixture is written after the project exists so a fixture that
    /// lives inside the project directory does not race project creation.
    fn project_with_media_asset(
        temp_dir: &tempfile::TempDir,
        name: &str,
        media_path: &Path,
    ) -> (PathBuf, String, String) {
        let project_path = temp_dir.path().join(name);
        let mut project =
            openreelio_core::ActiveProject::create("Media Scope", project_path.clone())
                .expect("project");
        if let Some(parent) = media_path.parent() {
            std::fs::create_dir_all(parent).expect("media parent");
        }
        std::fs::write(media_path, b"fake video bytes").expect("media fixture");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let track_id = project.state.sequences[&sequence_id]
            .tracks
            .iter()
            .find(|track| matches!(track.kind, TrackKind::Video | TrackKind::Overlay))
            .expect("video track")
            .id
            .clone();

        let import_command = ImportAssetCommand::new("clip.mp4", &media_path.to_string_lossy())
            .with_duration(8.0)
            .with_audio_info(AudioInfo::default());
        let asset_id = import_command.asset_id().to_string();
        project
            .executor
            .execute(Box::new(import_command), &mut project.state)
            .expect("import asset");
        project
            .executor
            .execute(
                Box::new(InsertMediaCommand::new(
                    &sequence_id,
                    &track_id,
                    &asset_id,
                    0.0,
                )),
                &mut project.state,
            )
            .expect("insert media");
        project.save().expect("save project");
        drop(project);

        (project_path, sequence_id, asset_id)
    }

    #[test]
    fn should_read_media_the_app_imported_from_outside_the_project() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let outside_media = temp_dir.path().join("outside.mp4");
        let (project_path, sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "outside_media_project", &outside_media);

        // The GUI imports media by reference and leaves it where the user put
        // it, so this is what an ordinary project looks like. Refusing it made
        // every GUI-authored project untranscribable and unlookable-at through
        // this server, while protecting nothing: the same media is already
        // rendered and exported from where it lies.
        let project = super::super::load_project(&project_path).expect("load project");
        confine_asset_media(&project, &asset_id).expect("external media must be accepted");
        confine_sequence_media(&project, &sequence_id)
            .expect("a sequence of external media must be accepted");
    }

    #[test]
    fn should_allow_transcription_scope_for_media_inside_the_project() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir
            .path()
            .join("inside_media_project")
            .join("media")
            .join("clip.mp4");
        let (project_path, sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "inside_media_project", &inside_media);

        let project = super::super::load_project(&project_path).expect("load project");
        confine_asset_media(&project, &asset_id).expect("in-project media must be accepted");
        confine_sequence_media(&project, &sequence_id)
            .expect("a sequence of in-project media must be accepted");
    }

    #[test]
    fn should_refuse_transcription_for_asset_uris_that_leave_the_machine() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir.path().join("hostile_uri_project").join("clip.mp4");
        let (project_path, _sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "hostile_uri_project", &inside_media);

        // The command layer refuses these, so they can only arrive on a project
        // written by something else. Locality is what makes that harmless: the
        // server must never be the thing that opens an outbound connection.
        for hostile_uri in [
            "\\\\attacker.example\\share\\probe.mp4",
            "//attacker.example/share/probe.mp4",
        ] {
            let mut project = super::super::load_project(&project_path).expect("load project");
            project.state.assets.get_mut(&asset_id).expect("asset").uri = hostile_uri.to_string();

            let error = confine_asset_media(&project, &asset_id)
                .expect_err(&format!("'{hostile_uri}' must be refused"));
            assert!(
                matches!(error, ToolError::PermissionDenied(_)),
                "'{hostile_uri}' must be denied by policy, got {error:?}"
            );
            assert!(
                !error.to_string().contains("attacker.example"),
                "the refusal must not echo the path: {error}"
            );
        }

        // A URL is not a share, so it is not a policy refusal — but it names no
        // media on this machine either, and is refused before FFmpeg sees it.
        let mut project = super::super::load_project(&project_path).expect("load project");
        project.state.assets.get_mut(&asset_id).expect("asset").uri =
            "http://attacker.example/probe.mp4".to_string();
        let error = confine_asset_media(&project, &asset_id).expect_err("a URL must be refused");
        assert!(
            !error.to_string().contains("attacker.example"),
            "the refusal must not echo the path: {error}"
        );
    }

    #[test]
    fn should_refuse_transcription_for_media_that_is_not_on_this_machine() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir
            .path()
            .join("missing_media_project")
            .join("clip.mp4");
        let (project_path, sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "missing_media_project", &inside_media);

        // A disconnected drive, or footage moved after import: FFmpeg would
        // report it as a decode failure halfway through, so it is caught here
        // and named as what it is — without saying where the file was looked for.
        std::fs::remove_file(&inside_media).expect("remove the media fixture");

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };
        for arguments in [
            serde_json::json!({ "assetId": asset_id }),
            serde_json::json!({ "sequenceAudio": true, "sequenceId": sequence_id }),
        ] {
            let error = generate_transcription(&state, arguments.clone())
                .expect_err(&format!("{arguments} must be refused"));
            assert!(
                error.to_string().contains("no readable media"),
                "{arguments} must say the media is missing, got {error:?}"
            );
            assert!(
                !error.to_string().contains("clip.mp4"),
                "the refusal must not echo the resolved path: {error}"
            );
        }
    }

    /// Class guard for RC-E: every MCP surface that turns a client-influenced
    /// value into a filesystem path reaching FFmpeg, and where that path is
    /// confined.
    ///
    /// This test is a checklist with teeth: adding an FFmpeg-backed tool without
    /// confining its media path should make it fail. It asserts the two shapes
    /// that exist today — a path-typed tool argument, and a path that arrives as
    /// project state — and pins the tool inventory the boundary was reasoned
    /// about, so a new tool cannot be added silently.
    #[test]
    fn should_confine_every_mcp_path_that_reaches_ffmpeg() {
        // 1. The tool inventory. Any name added here must be classified below.
        let state = McpServerState {
            project: Some(PathBuf::from("unused")),
            allow_write: true,
            ..Default::default()
        };
        let advertised: Vec<String> = build_tools(&state)
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();

        // Tools that spawn FFmpeg. Each is covered by a confinement test above.
        let ffmpeg_backed = [
            "openreelio.verify",
            "openreelio.transcription.generate",
            "openreelio.frame.extract",
            "openreelio.render.range",
        ];
        // Everything else reads or writes project state only; none of them opens
        // a media file, so none of them can be used as a read primitive.
        let state_only = [
            "openreelio.host.context",
            "openreelio.project.info",
            "openreelio.selection.read",
            "openreelio.diagnostics.read",
            "openreelio.timeline.snapshot",
            "openreelio.assets.list",
            "openreelio.transcription.status",
            "openreelio.annotation.read",
            "openreelio.command.schema",
            "openreelio.command.validate",
            "openreelio.plan.validate",
            "openreelio.media.insert",
            "openreelio.plan.apply",
            "openreelio.preview.describe",
        ];

        for name in &advertised {
            assert!(
                ffmpeg_backed.contains(&name.as_str()) || state_only.contains(&name.as_str()),
                "'{name}' is a new MCP tool: classify it here and confine its \
                 media path if it reaches FFmpeg"
            );
        }
        for name in ffmpeg_backed.iter().chain(state_only.iter()) {
            assert!(
                advertised.contains(&name.to_string()),
                "'{name}' disappeared from the MCP surface; update this guard"
            );
        }

        // 2. `openreelio.verify` — a path-typed tool argument, confined by
        //    `confine_to_project` at mcp.rs `run_verify_tool`.
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "class_guard_project");
        let verify_state = McpServerState {
            project: Some(project_path.clone()),
            ..Default::default()
        };
        let error = run_verify_tool(
            &verify_state,
            serde_json::json!({ "file": "../outside.mp4" }),
        )
        .expect_err("verify must confine its file argument");
        assert!(matches!(error, ToolError::PermissionDenied(_)));

        // 3. `openreelio.transcription.generate` — a path that arrives as project
        //    state, checked by `confine_asset_media` before FFmpeg is spawned.
        //    The rule there is locality, not location — media merely living
        //    outside the project is ordinary and must keep working — so the
        //    check is exercised with media this machine cannot read. Refusing an
        //    off-host UNC path is covered by
        //    `should_refuse_transcription_for_asset_uris_that_leave_the_machine`,
        //    which can hand the confinement a URI the command layer refuses to
        //    store.
        let unreadable_media = temp_dir.path().join("class_guard_unreadable.mp4");
        let (media_project, _, asset_id) =
            project_with_media_asset(&temp_dir, "class_guard_media", &unreadable_media);
        std::fs::remove_file(&unreadable_media).expect("remove the media fixture");
        let media_state = McpServerState {
            project: Some(media_project),
            ..Default::default()
        };
        let error =
            generate_transcription(&media_state, serde_json::json!({ "assetId": asset_id }))
                .expect_err("transcription must check its media path");
        assert!(
            error.to_string().contains("no readable media"),
            "the media check must run before FFmpeg, got {error:?}"
        );

        // 3b. `openreelio.frame.extract` reaches FFmpeg through *both* kinds of
        //     path, so both are checked: `file` as a tool argument, confined to
        //     the project, and the sequence's own media as project state.
        let error = run_frame_extract_tool(
            &verify_state,
            serde_json::json!({ "time": 0.0, "file": "../outside.mp4" }),
        )
        .expect_err("frame extract must confine its file argument");
        assert!(matches!(error, ToolError::PermissionDenied(_)));

        let error = run_frame_extract_tool(&media_state, serde_json::json!({ "time": 0.0 }))
            .expect_err("frame extract must check the sequence's media");
        assert!(
            error.to_string().contains("no readable media"),
            "the media check must run before FFmpeg, got {error:?}"
        );

        // 4. Documented exception: plan payload paths are NOT confined to the
        //    project, because importing external footage is the point of the
        //    grant-gated plan surface. They are validated at the command layer
        //    instead (`ImportAssetCommand`/`UpdateAssetCommand` reject URLs,
        //    relative paths, traversal, and non-files), and the confinement in
        //    (3) is what keeps an out-of-tree path they store from reaching
        //    FFmpeg through this server.
        let outside_import = temp_dir.path().join("plan_import.mp4");
        std::fs::write(&outside_import, b"fake video bytes").expect("import fixture");
        let import_result = CommandPayload::parse(
            "ImportAsset".to_string(),
            serde_json::json!({
                "name": "plan_import.mp4",
                "uri": outside_import.to_string_lossy()
            }),
        );
        assert!(
            import_result.is_ok(),
            "external footage must stay importable through a plan"
        );
    }

    /// Restores an environment variable to its pre-test value when dropped.
    ///
    /// The variable is process-wide, so a test that cleared it unconditionally
    /// would discard a value the test process was started with, and a failed
    /// assertion would leave the override in place for whatever runs next.
    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn set_value(&self, value: &str) {
            std::env::set_var(self.key, value);
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var(self.key, previous),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn should_treat_an_empty_approval_token_environment_value_as_no_grant() {
        // Both cases live in one test because they mutate the same process-wide
        // environment variable.
        let action = McpAction {
            project: None,
            stdio: false,
            allow_write: false,
        };

        let approval_token_env = EnvVarGuard::set("OPENREELIO_MCP_APPROVAL_TOKEN", "   ");
        let state = build_server_state(&action);

        assert!(state.approval_token.is_none());
        assert!(!state.has_active_approval_token());
        assert!(!state.mutations_enabled());
        assert_eq!(policy_mode(&state), "read-only");

        let tools = build_tools(&state);
        assert!(
            !tools
                .iter()
                .any(|tool| tool["name"] == "openreelio.plan.apply"),
            "an empty token must not unlock the mutating tools"
        );

        approval_token_env.set_value("real-token");
        let granted = build_server_state(&action);
        assert_eq!(granted.approval_token.as_deref(), Some("real-token"));
        assert!(granted.has_active_approval_token());
    }

    #[test]
    fn should_reject_an_empty_approval_token_argument() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("empty_token_project");
        let project = openreelio_core::ActiveProject::create("Empty Token", project_path.clone())
            .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_op_count = project.state.op_count;
        drop(project);

        let plan = serde_json::json!({
            "id": "empty-token-plan",
            "steps": [{
                "id": "step-1",
                "commandType": "AddTrack",
                "payload": {
                    "sequenceId": sequence_id,
                    "name": "Should Not Exist",
                    "kind": "video"
                },
                "dependsOn": []
            }]
        });

        // A configured token with an empty request token, and an empty token on
        // both sides — neither is an approval.
        for approval_token in [Some("real-token".to_string()), Some(String::new())] {
            let state = McpServerState {
                project: Some(project_path.clone()),
                approval_token,
                ..Default::default()
            };

            let response = handle_jsonrpc_request(
                &state,
                request(
                    "tools/call",
                    serde_json::json!({
                        "name": "openreelio.plan.apply",
                        "arguments": {
                            "approvalToken": "",
                            "plan": plan.clone()
                        }
                    }),
                ),
            );

            assert_eq!(response["error"]["code"], -32001, "{response}");
        }

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        assert_eq!(reopened.state.op_count, initial_op_count);
    }

    #[test]
    fn should_reject_plan_apply_when_approval_token_project_scope_differs() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let project_path = temp_dir.path().join("plan_project_scope_project");
        let project = openreelio_core::ActiveProject::create("Plan Scope", project_path.clone())
            .expect("project");
        let sequence_id = project.state.active_sequence_id.clone().expect("sequence");
        let initial_op_count = project.state.op_count;
        drop(project);

        let state = McpServerState {
            project: Some(project_path.clone()),
            approval_token: Some("scoped-token".to_string()),
            approval_project_id: Some("some-other-project".to_string()),
            ..Default::default()
        };

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.plan.apply",
                    "arguments": {
                        "approvalToken": "scoped-token",
                        "plan": {
                            "id": "cross-project-plan",
                            "steps": [{
                                "id": "step-1",
                                "commandType": "AddTrack",
                                "payload": {
                                    "sequenceId": sequence_id,
                                    "name": "Cross Project Track",
                                    "kind": "video"
                                },
                                "dependsOn": []
                            }]
                        }
                    }
                }),
            ),
        );

        assert_eq!(response["error"]["code"], -32001, "{response}");
        assert!(response["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("scoped to project"));

        let reopened = openreelio_core::ActiveProject::open(project_path).expect("reopen");
        assert_eq!(reopened.state.op_count, initial_op_count);
        assert!(
            !*state.approval_consumed.lock().expect("consumed state"),
            "a token rejected on scope must not be spent"
        );
    }

    #[test]
    fn should_deny_every_mutation_and_confine_every_path_in_the_default_server() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let (project_path, _) = project_with_file(&temp_dir, "class_guard_project");
        let outside = temp_dir.path().join("outside.mp4");
        std::fs::write(&outside, b"outside the project").expect("write outside file");

        // No --allow-write and no token: the shipped default.
        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };

        let advertised: Vec<String> = build_tools(&state)
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_string())
            .collect();

        for mutating_tool in ["openreelio.media.insert", "openreelio.plan.apply"] {
            assert!(
                !advertised.contains(&mutating_tool.to_string()),
                "{mutating_tool} must not be advertised without a grant"
            );

            let response = handle_jsonrpc_request(
                &state,
                request(
                    "tools/call",
                    serde_json::json!({
                        "name": mutating_tool,
                        // The one argument both tools declare: arguments are
                        // checked before the grant is, so a payload carrying a
                        // key the other tool has no such thing as would come
                        // back as an argument error rather than a denial.
                        "arguments": { "approvalToken": "" }
                    }),
                ),
            );
            assert_eq!(
                response["error"]["code"], -32001,
                "{mutating_tool} must be denied: {response}"
            );
        }

        // Every path-typed argument on the read-only surface stays in scope.
        for hostile in [
            outside.to_string_lossy().to_string(),
            "../outside.mp4".to_string(),
            "\\\\attacker\\share\\probe.mp4".to_string(),
        ] {
            let response = handle_jsonrpc_request(
                &state,
                request(
                    "tools/call",
                    serde_json::json!({
                        "name": "openreelio.verify",
                        "arguments": { "file": hostile }
                    }),
                ),
            );
            assert_eq!(response["error"]["code"], -32001, "{response}");
        }

        let response = handle_jsonrpc_request(
            &state,
            request(
                "tools/call",
                serde_json::json!({
                    "name": "openreelio.annotation.read",
                    "arguments": { "assetId": "../../secret" }
                }),
            ),
        );
        assert_eq!(response["error"]["code"], -32602, "{response}");
    }

    #[test]
    fn should_expose_host_context_as_mcp_resource() {
        let state = McpServerState::default();
        let response = handle_jsonrpc_request(
            &state,
            request(
                "resources/read",
                serde_json::json!({
                    "uri": "openreelio://host/context"
                }),
            ),
        );

        let text = response["result"]["contents"][0]["text"]
            .as_str()
            .expect("resource text");
        let context: Value = serde_json::from_str(text).expect("context JSON");

        assert_eq!(context["host"]["appName"], "OpenReelio");
        assert_eq!(context["project"]["projectKind"], "video-editing-project");
    }
}
