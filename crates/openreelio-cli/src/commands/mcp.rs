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
//! Confinement is enforced at the FFmpeg boundary, not only at the argument
//! boundary. A path that arrives as project state rather than as a tool argument
//! — an asset URI — is confined too ([`confine_asset_media`]), because project
//! state is data the server reads, not a grant: it can come from a foreign
//! project the operator pointed the server at, or from an `UpdateAsset` an
//! approved plan applied. The practical consequence is that media living outside
//! the project directory is not transcribable through MCP; ingest it into the
//! project workspace first.
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
    commands::{help_json, plan, transcription, verify},
    output,
};
use clap::Args;
use openreelio_core::commands::{get_text_data, is_text_clip, InsertMediaCommand};
use openreelio_core::ipc::CommandPayload;
use openreelio_core::style::{caption_pack_ids, transition_recipe_ids};
use openreelio_core::timeline::TrackKind;
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Timeout for the rendered-file measurement pass of `openreelio.verify`,
/// matching the `verify --timeout-sec` default.
const VERIFY_MEASURE_TIMEOUT_SEC: u64 = 600;

/// Severity threshold `openreelio.verify` applies when the caller names none,
/// matching the `verify --fail-on` default.
const DEFAULT_VERIFY_FAIL_ON: &str = "error";

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
        "rawMediaAccess": if state.project.is_some() { "transcription-generate" } else { "none" },
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

/// Names what the server may do to the project directory.
///
/// Mutating tools write the project through the command log, so a server that
/// advertises them must not report read-only access. Reads never reach outside
/// the project directory in any mode (see [`confine_to_project`]).
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
                Ok(value) => jsonrpc_result(
                    id,
                    serde_json::json!({
                        "content": [{
                            "type": "text",
                            "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
                        }],
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

fn build_tools(state: &McpServerState) -> Vec<Value> {
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
            "Read active timeline tracks, clips, markers, and duration summary.",
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
                        "enum": ["auto", "tiny", "base", "small", "medium", "large", "large-v3", "large-v3-turbo"],
                        "description": "Whisper model to use. Defaults to auto, which selects the best installed model."
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
            "Run deterministic quality control over a sequence and, with 'file', over a rendered export. Every check that ran, was skipped, or errored is reported, so 'checked and clean' is distinguishable from 'never checked'. Per-check status is passed (ran, found nothing), warned (ran, warning/info findings only), failed (ran, error or critical findings), skipped, or errored; checks[].passed is true only for 'passed', while the top-level status/passed follow severity. Violations carry an executable suggestedFix plan.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "sequenceId": {
                        "type": "string",
                        "description": "Sequence to verify. Defaults to the active sequence."
                    },
                    "file": {
                        "type": "string",
                        "description": "Rendered file to measure for black/freeze/silence, EBU R128 loudness, and peaks. Must be inside the project directory; a relative path resolves against the project root and anything outside it is rejected, so render into the project before verifying. Without it only structural checks run and FFmpeg is never invoked. Measured times are file-relative and compared against timeline times, so pass a full-sequence render rather than a partial one."
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

    if state.mutations_enabled() {
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
    }

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

fn call_tool(state: &McpServerState, name: &str, arguments: Value) -> Result<Value, ToolError> {
    match name {
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
        "openreelio.media.insert" => apply_media_insert(state, arguments),
        "openreelio.plan.apply" => apply_plan(state, arguments),
        "openreelio.preview.describe" => Ok(build_preview_state()),
        other => Err(ToolError::UnknownTool(format!(
            "Tool '{other}' is not available"
        ))),
    }
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

/// Confines one asset's media file to the served project directory.
///
/// The asset URI is project state rather than a tool argument, so it bypasses the
/// confinement [`confine_to_project`] applies to client-supplied paths — yet it
/// reaches FFmpeg exactly like one, through
/// [`Asset::resolved_path`](openreelio_core::assets::Asset::resolved_path). A
/// project whose state names media outside the served directory would otherwise
/// turn a read-only tool into a whole-disk read, and a UNC URI would make the
/// server open an outbound connection. Project state is not a grant: it can be
/// a foreign project the operator pointed the server at, or one an approved
/// `UpdateAsset`/`ImportAsset` rewrote.
///
/// The error names the asset, never the resolved path, so a rejection cannot be
/// read as an existence oracle for whatever the URI pointed at.
fn confine_asset_media(
    project: &openreelio_core::ActiveProject,
    asset_id: &str,
) -> Result<(), ToolError> {
    let Some(asset) = project.state.assets.get(asset_id) else {
        // A missing asset is the transcription command's error to report, with
        // its own wording; there is no path to confine here.
        return Ok(());
    };

    // Import canonicalizes the URI, so on Windows it carries the `\\?\` verbatim
    // prefix. Stripping it here is what tells an ordinary drive path apart from a
    // real UNC share, which keeps its prefix and is rejected below.
    let media_path = strip_verbatim_prefix(&asset.resolved_path(&project.path));
    match confine_to_project(&project.path, "asset media", &media_path.to_string_lossy()) {
        Ok(_) => Ok(()),
        // A project directory that cannot be resolved is an environment failure,
        // not a policy decision, and keeps its own wording.
        Err(error @ ToolError::Execution(_)) => Err(error),
        Err(_) => Err(ToolError::PermissionDenied(format!(
            "Asset '{asset_id}' resolves to media outside the served project directory; the MCP server only reads media inside the project it was started on"
        ))),
    }
}

/// Confines every asset a sequence mixdown will read.
///
/// The mixdown builds a render graph over the whole sequence, so confinement is
/// checked for every asset the sequence references rather than for the audible
/// subset alone: which layers survive muting and trimming is the render graph's
/// decision, and a scope violation anywhere in the sequence is worth refusing
/// before FFmpeg is spawned at all.
fn confine_sequence_media(
    project: &openreelio_core::ActiveProject,
    sequence_id: &str,
) -> Result<(), ToolError> {
    let Some(sequence) = project.state.sequences.get(sequence_id) else {
        // Reported by the transcription command in its own words.
        return Ok(());
    };

    for track in &sequence.tracks {
        for clip in &track.clips {
            confine_asset_media(project, &clip.asset_id)?;
        }
    }
    Ok(())
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
            serde_json::json!({
                "id": sequence_id,
                "name": sequence.name,
                "isActive": active_sequence_id.as_deref() == Some(sequence_id.as_str()),
                "trackCount": tracks.len(),
                "markerCount": sequence.markers.len(),
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

fn build_command_schema() -> Value {
    // Read the curated ids from the core registries rather than restating them:
    // a pack added to core shows up in the hints, and a hint can never name an
    // id the validator would reject.
    let caption_style_pack_ids = caption_pack_ids();
    let transition_recipe_ids = transition_recipe_ids();

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
                "required": ["sequenceId", "trackId", "timelineIn", "duration", "textData"],
                "textDataShape": "TextClipData includes content, style(fontFamily/fontSize/fontWeight/color/backgroundColor/backgroundPadding/alignment/bold/italic/underline/lineHeight/letterSpacing), position(x/y 0..1), shadow(color/offsetX/offsetY/blur), outline(color/width), rotation, and opacity.",
                "presetHints": "Production presets supported by UI/agent/CLI include title, centered-title, epic-title, chapter-title, lower-third, lower-third-news, lower-third-name-role, subtitle, callout, callout-stat, credits, credit-line, logo-bug, social-handle, quote, watermark, and countdown.",
                "note": "Text clips must be placed on a video or overlay track. Use SetClipTransform after creation when scale or anchor must be exact."
            },
            "UpdateTextClip": {
                "required": ["sequenceId", "trackId", "clipId", "textData"],
                "note": "Send the full updated TextClipData so style, position, shadow, outline, rotation, and opacity remain deterministic."
            },
            "SetClipTransform": {
                "required": ["sequenceId", "trackId", "clipId", "transform"],
                "transformShape": "transform includes position{x,y}, scale{x,y}, rotationDeg, and anchor{x,y}; text clips use this for preview drag/resize/rotate parity."
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
                "AddTextClip with complete TextClipData for content, typography, color, background, shadow, outline, position, rotation, and opacity.",
                "Use production text presets for common work: credits for end cards, logo-bug for channel marks, social-handle for creator IDs, lower-third-name-role for interviews, and callout-stat for numeric emphasis.",
                "SetClipTransform for exact preview drag/resize/rotate parity using normalized position, scale, rotationDeg, and anchor."
            ],
            "timedSubtitles": [
                "Call openreelio.transcription.status first and explain missing model installation before attempting automatic subtitles.",
                "If no model is installed, tell the user to install one through the OpenReelio UI or `openreelio-cli transcription install --model large-v3-turbo` before transcription.generate.",
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
                "creditBrand": "Credits, credit lines, logo bugs, social handles, quote, and watermark presets preserve their template position unless the user asks for automatic placement."
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
    ToolError::PermissionDenied(format!(
        "{key} must resolve inside the project directory; '{requested}' escapes it"
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

    let args = verify::VerifyArgs {
        path: project_path.clone(),
        sequence: optional_string_argument(&arguments, "sequenceId")?,
        file,
        structural_only,
        checks: optional_string_array_argument(&arguments, "checks")?,
        skip: optional_string_array_argument(&arguments, "skip")?,
        target_lufs: None,
        max_true_peak: None,
        duration_tolerance_sec: None,
        fail_on: optional_string_argument(&arguments, "failOn")?
            .unwrap_or_else(|| DEFAULT_VERIFY_FAIL_ON.to_string()),
        timeout_sec: VERIFY_MEASURE_TIMEOUT_SEC,
        json_pretty: false,
    };

    // The exit code is dropped on purpose: the report already carries `status`,
    // `passed`, and the per-check outcomes an MCP client acts on, and a JSON-RPC
    // result has nowhere honest to put a process code.
    let (report, _exit_code) =
        verify::run_verify(args).map_err(|error| ToolError::Execution(error.to_string()))?;
    Ok(report)
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
    let errors = plan::validate_edit_plan(&edit_plan);

    Ok(if errors.is_empty() {
        serde_json::json!({
            "status": "ok",
            "planId": edit_plan.id,
            "stepCount": edit_plan.steps.len(),
            "message": "Plan is valid"
        })
    } else {
        serde_json::json!({
            "status": "error",
            "planId": edit_plan.id,
            "message": "Plan validation failed",
            "errors": errors
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

    let validation_errors = plan::validate_edit_plan(&edit_plan);
    if !validation_errors.is_empty() {
        return Ok(serde_json::json!({
            "status": "error",
            "message": "Plan validation failed",
            "planId": edit_plan.id,
            "errors": validation_errors,
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

fn build_preview_state() -> Value {
    serde_json::json!({
        "state": "idle",
        "playheadSeconds": 0.0,
        "rawFrameAccess": "disabled",
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
                        "planId": "plan-1"
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
                "rawMediaAccess": "transcription-generate",
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
    fn should_refuse_to_transcribe_an_asset_whose_media_lives_outside_the_project() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let outside_media = temp_dir.path().join("outside.mp4");
        let (project_path, sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "outside_media_project", &outside_media);

        let state = McpServerState {
            project: Some(project_path),
            ..Default::default()
        };

        // Both transcription modes reach FFmpeg with this asset's path, so both
        // have to refuse before FFmpeg is spawned — the refusal must not depend
        // on whether Whisper happens to be compiled in on this build.
        for arguments in [
            serde_json::json!({ "assetId": asset_id }),
            serde_json::json!({ "sequenceAudio": true, "sequenceId": sequence_id }),
        ] {
            let error = generate_transcription(&state, arguments.clone())
                .expect_err(&format!("{arguments} must be refused"));
            assert!(
                matches!(error, ToolError::PermissionDenied(_)),
                "{arguments} must be denied by policy, got {error:?}"
            );
            assert!(
                !error.to_string().contains("outside.mp4"),
                "the refusal must not echo the out-of-scope path: {error}"
            );
        }
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
    fn should_refuse_transcription_for_asset_uris_that_leave_the_project_lexically() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir.path().join("hostile_uri_project").join("clip.mp4");
        let (project_path, _sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "hostile_uri_project", &inside_media);

        // The command layer refuses these, so they can only arrive on a project
        // written by something else. Confinement is what makes that harmless.
        for hostile_uri in [
            "http://attacker.example/probe.mp4",
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
        }
    }

    #[test]
    fn should_refuse_transcription_for_relative_paths_that_traverse_out_of_the_project() {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let inside_media = temp_dir
            .path()
            .join("traversal_uri_project")
            .join("clip.mp4");
        let outside_media = temp_dir.path().join("outside.mp4");
        std::fs::write(&outside_media, b"fake video bytes").expect("outside fixture");
        let (project_path, _sequence_id, asset_id) =
            project_with_media_asset(&temp_dir, "traversal_uri_project", &inside_media);

        // `Asset::resolved_path` joins `relative_path` onto the project root with
        // no traversal check of its own.
        let mut project = super::super::load_project(&project_path).expect("load project");
        let asset = project.state.assets.get_mut(&asset_id).expect("asset");
        asset.relative_path = Some("../outside.mp4".to_string());

        let error =
            confine_asset_media(&project, &asset_id).expect_err("traversal must be refused");
        assert!(
            matches!(error, ToolError::PermissionDenied(_)),
            "traversal must be denied by policy, got {error:?}"
        );
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
        let ffmpeg_backed = ["openreelio.verify", "openreelio.transcription.generate"];
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
        //    state, confined by `confine_asset_media` before FFmpeg is spawned.
        let outside_media = temp_dir.path().join("class_guard_outside.mp4");
        let (media_project, _, asset_id) =
            project_with_media_asset(&temp_dir, "class_guard_media", &outside_media);
        let media_state = McpServerState {
            project: Some(media_project),
            ..Default::default()
        };
        let error =
            generate_transcription(&media_state, serde_json::json!({ "assetId": asset_id }))
                .expect_err("transcription must confine its media path");
        assert!(matches!(error, ToolError::PermissionDenied(_)));

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
                        "arguments": { "approvalToken": "", "plan": { "id": "p" } }
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
