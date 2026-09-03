//! Claude Code headless (`claude -p`) transport types and helpers.
//!
//! Mirrors [`crate::core::codex_app_server`] for the Claude CLI. The heavy
//! process spawning and stream forwarding lives in the GUI-gated IPC layer
//! (`crate::ipc::commands::claude_headless`); this module holds the Tauri-free
//! data types and small helpers so they compile in the core crate.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use uuid::Uuid;

/// Event-name prefix for Claude headless stream events.
pub const CLAUDE_HEADLESS_EVENT_PREFIX: &str = "claude:headless";

/// A single MCP tool the OpenReelio loopback server exposes to Claude.
///
/// The frontend owns the `openreelio.*` catalog and passes it here so the tool
/// JSON schemas are single-sourced in TypeScript. `name` is the bare MCP tool
/// name; Claude sees it as `mcp__openreelio__<name>`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMcpToolSpec {
    /// Bare MCP tool name (no `openreelio.` prefix, no `mcp__` prefix).
    pub name: String,
    /// Human-readable tool description surfaced to Claude.
    pub description: String,
    /// JSON Schema describing the tool arguments (MCP `inputSchema`).
    pub input_schema: Value,
}

/// Input for `start_claude_headless`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartClaudeHeadlessInput {
    /// Optional caller-provided session id; a UUID is generated when absent.
    pub server_id: Option<String>,
    /// Working project path; canonicalized and confined to the open project.
    pub project_path: Option<String>,
    /// Model alias/name (defaults to `sonnet`).
    pub model: Option<String>,
    /// Reasoning effort level (defaults to `medium`).
    pub effort: Option<String>,
    /// `"subscription"` or `"api-key"`. Controls `ANTHROPIC_API_KEY` injection.
    pub auth_mode: String,
    /// Optional inline API key for one-off api-key runs (falls back to stored key).
    pub api_key: Option<String>,
    /// OpenReelio MCP tool catalog exposed to this session.
    pub tools: Vec<ClaudeMcpToolSpec>,
    /// Optional prior Claude session id to resume via `--resume <id>`.
    ///
    /// When present, the session is resumed instead of started fresh (the
    /// mutually exclusive `--session-id <uuid>` is omitted). Sessions persist
    /// under the managed `CLAUDE_CONFIG_DIR`, so resume works across restarts.
    /// This backs the frontend's interrupt-then-continue flow.
    pub resume_session_id: Option<String>,
    /// OpenReelio developer instructions appended to the system prompt
    /// (`--append-system-prompt`). Without them Claude behaves like a generic
    /// coding agent instead of driving the OpenReelio MCP tools.
    #[serde(default)]
    pub developer_instructions: Option<String>,
}

/// Result of `start_claude_headless`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHeadlessStartResult {
    /// Resolved session id.
    pub server_id: String,
    /// Tauri event name that carries this session's stream events.
    pub event_name: String,
    /// The launcher command label.
    pub command: String,
    /// The full argument vector passed to `claude`.
    pub args: Vec<String>,
    /// Working directory used for the Claude process.
    pub bridge_cwd: String,
    /// Loopback MCP endpoint URL registered for this session.
    pub mcp_url: String,
}

/// Selector input for session-scoped commands (stop).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHeadlessSessionInput {
    /// Target session id.
    pub server_id: String,
}

/// Input for `write_claude_headless_message`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHeadlessWriteInput {
    /// Target session id.
    pub server_id: String,
    /// The JSON message written as one NDJSON line to the child's stdin.
    pub message: Value,
}

/// Stream event forwarded from a Claude headless process to the frontend.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaudeHeadlessStreamEvent {
    /// A parsed NDJSON stdout message emitted by the Claude CLI.
    Message { message: Value },
    /// A raw stderr line.
    Stderr { text: String },
    /// A transport-level error (spawn/read/parse failure).
    Error { message: String },
    /// The Claude process exited.
    Exit { exit_code: Option<i32> },
}

/// One inline image content block a tool result carries.
///
/// MCP (2025-06-18) carries pictures as `{ type: "image", data, mimeType }`
/// where `data` is raw base64 with no `data:` URI prefix.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpImageBlock {
    /// Base64-encoded image bytes, with no `data:` URI prefix.
    pub data: String,
    /// IANA media type of `data`, for example `image/jpeg`.
    pub mime_type: String,
}

/// Response body for `respond_openreelio_mcp_call`.
///
/// The MCP server wraps this uniformly as
/// `{ content: [{ type: "text", text }, ...images], isError }` for the
/// `tools/call` result.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenReelioMcpCallResponse {
    /// Textual tool result (may be a JSON-encoded payload).
    pub text: String,
    /// Whether the tool call resulted in an error.
    pub is_error: bool,
    /// Pictures the tool produced, attached alongside the text.
    ///
    /// Defaulted so a caller that returns only text — every tool but the frame
    /// probe — keeps serialising exactly as it did before images existed.
    #[serde(default)]
    pub images: Vec<McpImageBlock>,
}

/// Builds the Tauri event name that carries a session's stream events.
pub fn claude_headless_event_name(server_id: &str) -> String {
    format!("{CLAUDE_HEADLESS_EVENT_PREFIX}:{server_id}")
}

/// Normalizes an optional caller session id, generating a UUID when absent.
pub fn normalize_claude_headless_id(server_id: Option<String>) -> Result<String, String> {
    let Some(server_id) = server_id else {
        return Ok(Uuid::new_v4().to_string());
    };
    let trimmed = server_id.trim();
    if trimmed.is_empty() {
        return Err("serverId is required".to_string());
    }
    if trimmed.len() > 128 {
        return Err("serverId must be 128 characters or fewer".to_string());
    }
    Ok(trimmed.to_string())
}

/// Classifies one raw stdout line from `claude -p --verbose` into a stream event.
///
/// A line that parses as JSON-RPC becomes a [`ClaudeHeadlessStreamEvent::Message`];
/// any other line is a benign diagnostic/warning (an update notice, a deprecation
/// hint, etc.) and is routed to the [`ClaudeHeadlessStreamEvent::Stderr`]
/// context-only channel rather than [`ClaudeHeadlessStreamEvent::Error`], so a
/// single non-JSON line never tears down a healthy session. `Error` is reserved
/// for genuine reader I/O failures at the reader call site.
pub fn classify_headless_stdout_line(line: &str) -> ClaudeHeadlessStreamEvent {
    match crate::core::codex_app_server::decode_json_rpc_line(line) {
        Ok(message) => ClaudeHeadlessStreamEvent::Message { message },
        Err(_) => ClaudeHeadlessStreamEvent::Stderr {
            text: line.to_string(),
        },
    }
}

/// Builds the `claude` argument vector.
///
/// `mcp_config_path` is a filesystem path (never inline JSON), so every argument
/// is free of double quotes and safe to pass to a Windows `.cmd`/`.bat` shim.
/// When `resume_session_id` is `Some`, the session is resumed via `--resume`
/// instead of started fresh via `--session-id` (the two are mutually exclusive).
pub fn build_claude_headless_args(
    model: &str,
    effort: &str,
    mcp_config_path: &str,
    session_id: &str,
    resume_session_id: Option<&str>,
    developer_instructions: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--replay-user-messages".to_string(),
        // Disable every built-in tool; only OpenReelio MCP tools remain.
        "--tools".to_string(),
        String::new(),
        // Auto-permit OpenReelio MCP tools (executor still enforces approval).
        "--allowedTools".to_string(),
        "mcp__openreelio__*".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--effort".to_string(),
        effort.to_string(),
        "--mcp-config".to_string(),
        mcp_config_path.to_string(),
        "--strict-mcp-config".to_string(),
        // Suppress project/local settings (and their hooks) leaking into output.
        "--setting-sources".to_string(),
        "user".to_string(),
    ];

    // Append the OpenReelio developer instructions to the default system
    // prompt. Without them Claude behaves like a generic coding agent in an
    // empty bridge directory (observed: it explored the cwd and attempted
    // shell commands instead of calling the OpenReelio MCP tools).
    if let Some(instructions) = developer_instructions {
        // Double quotes would make the argv unsafe for the legacy npm `.cmd`
        // shim (Rust refuses quoted args to batch files); single quotes keep
        // the prose readable and the argument shim-safe everywhere.
        let sanitized = instructions.trim().replace('"', "'");
        if !sanitized.is_empty() {
            args.push("--append-system-prompt".to_string());
            args.push(sanitized);
        }
    }

    match resume_session_id {
        Some(resume_id) => {
            args.push("--resume".to_string());
            args.push(resume_id.to_string());
        }
        None => {
            args.push("--session-id".to_string());
            args.push(session_id.to_string());
        }
    }

    args
}

/// Sanitizes an arbitrary session id into a filesystem-safe directory name.
///
/// Non-alphanumeric characters (except `-`/`_`) are replaced with `_`; an empty
/// result falls back to `"session"`.
pub fn sanitize_bridge_dir_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    }
}

/// Writes the loopback MCP config (which embeds the bearer token) to `path`,
/// restricting the file to the current user (mode 0600) on unix.
pub fn write_mcp_config_file(path: &Path, mcp_url: &str, token: &str) -> Result<(), String> {
    let config = json!({
        "mcpServers": {
            "openreelio": {
                "type": "http",
                "url": mcp_url,
                "headers": {
                    "Authorization": format!("Bearer {token}"),
                },
            },
        },
    });
    let encoded = serde_json::to_string(&config)
        .map_err(|error| format!("Failed to encode Claude MCP config: {error}"))?;

    // Create the file with owner-only permissions up front (unix) instead of
    // tightening after the write, so the bearer token is never briefly
    // readable through the default umask.
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("Failed to create Claude MCP config file: {error}"))?;
        file.write_all(encoded.as_bytes())
            .map_err(|error| format!("Failed to write Claude MCP config file: {error}"))?;
        // An existing file keeps its old mode despite `.mode()`, so re-assert.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure Claude MCP config file: {error}"))?;
    }

    #[cfg(not(unix))]
    std::fs::write(path, encoded.as_bytes())
        .map_err(|error| format!("Failed to write Claude MCP config file: {error}"))?;

    Ok(())
}

/// Prefix Claude namespaces this server's tools with.
///
/// The loopback server registers bare names and Claude asks for the prefixed
/// ones, so anything that reasons about a tool *name* has to accept both
/// spellings or it will silently only ever match one host.
pub const CLAUDE_MCP_TOOL_PREFIX: &str = "mcp__openreelio__";

/// Time a `tools/call` may take before the loopback server gives up on it.
///
/// Generous, because the wait covers a human: the frontend shows an approval
/// dialog and only answers once someone acts on it.
pub const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Time a `tools/call` that runs a render may take.
///
/// A proxy render of a range is FFmpeg work on top of the same approval wait,
/// and a cut long enough to be worth judging routinely outruns the default
/// budget. Timing it out reports a failed tool call for a render that is still
/// running and will finish, which is the one answer an agent cannot recover
/// from — it re-plans around a step it thinks did not happen.
pub const MCP_RENDER_CALL_TIMEOUT: Duration = Duration::from_secs(900);

/// The budget one `tools/call` is given, chosen by which tool was called.
///
/// `tool_name` may arrive bare (as the loopback server registers it) or
/// prefixed (as Claude spells it); both resolve to the same budget so the two
/// hosts cannot disagree about how long a render is allowed to take.
///
/// The bare name is matched *exactly*. A suffix match handed the render budget
/// to any tool whose name happened to end that way — `my_render_proxy`, a
/// differently prefixed host — which is a fifteen-minute wait granted to a tool
/// nobody sized it for.
pub fn tool_call_timeout(tool_name: &str) -> Duration {
    let bare = tool_name
        .strip_prefix(CLAUDE_MCP_TOOL_PREFIX)
        .unwrap_or(tool_name);

    if bare == RENDER_PROXY_TOOL {
        return MCP_RENDER_CALL_TIMEOUT;
    }

    MCP_CALL_TIMEOUT
}

/// Bare name of the one tool that renders, and so is given the longer budget.
const RENDER_PROXY_TOOL: &str = "render_proxy";

/// Wraps a frontend tool-call response as an MCP `tools/call` result payload of
/// the shape `{ content: [{ type: "text", text }, ...images], isError }`.
///
/// This is the single choke point every `tools/call` result passes through, so
/// it is also where pictures enter the protocol. The text block stays first and
/// stays unconditional: a client that reads only text sees exactly what it saw
/// before, and a tool that attaches no image serialises unchanged.
pub fn wrap_tool_result(response: OpenReelioMcpCallResponse) -> Value {
    let mut content = vec![json!({ "type": "text", "text": response.text })];
    content.extend(response.images.into_iter().map(|image| {
        json!({
            "type": "image",
            "data": image.data,
            "mimeType": image.mime_type,
        })
    }));

    json!({
        "content": content,
        "isError": response.is_error,
    })
}

/// Generates a random, URL-safe bearer token for a headless MCP session.
pub fn generate_mcp_bearer_token() -> String {
    use rand::{rngs::OsRng, RngCore};
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let mut token = String::with_capacity("or_claude_".len() + bytes.len() * 2);
    token.push_str("or_claude_");
    for byte in bytes {
        let _ = write!(&mut token, "{byte:02x}");
    }
    token
}

/// Parses a bearer token from a raw `Authorization` header value.
///
/// Pure string parsing (no axum types) so it lives in the Tauri-free core and is
/// unit-tested here. The IPC layer extracts the header string and delegates.
pub fn parse_bearer_token(header_value: Option<&str>) -> Option<String> {
    let value = header_value?;
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_namespaced_event_name() {
        assert_eq!(
            claude_headless_event_name("abc"),
            "claude:headless:abc".to_string()
        );
    }

    #[test]
    fn generates_uuid_when_server_id_absent() {
        let id = normalize_claude_headless_id(None).expect("id");
        assert_eq!(id.len(), 36);
    }

    #[test]
    fn rejects_blank_server_id() {
        assert!(normalize_claude_headless_id(Some("   ".to_string())).is_err());
    }

    #[test]
    fn classifies_non_json_stdout_line_as_stderr() {
        // A benign diagnostic line from `claude -p --verbose` must not become a
        // fatal `Error` event (which would tear down a healthy session).
        match classify_headless_stdout_line("Warning: a new version is available") {
            ClaudeHeadlessStreamEvent::Stderr { text } => {
                assert_eq!(text, "Warning: a new version is available");
            }
            other => panic!("expected Stderr, got {other:?}"),
        }
    }

    #[test]
    fn classifies_json_rpc_line_as_message() {
        let event = classify_headless_stdout_line("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}");
        assert!(matches!(event, ClaudeHeadlessStreamEvent::Message { .. }));
    }

    #[test]
    fn appends_sanitized_developer_instructions() {
        let args = build_claude_headless_args(
            "sonnet",
            "medium",
            "/tmp/mcp.json",
            "sid-1",
            None,
            Some("You are OpenReelio's \"editing\" agent. Use mcp__openreelio__project_state."),
        );
        let position = args
            .iter()
            .position(|arg| arg == "--append-system-prompt")
            .expect("append-system-prompt flag present");
        let value = &args[position + 1];
        assert!(value.contains("mcp__openreelio__project_state"));
        // Double quotes are rewritten so the argv stays .cmd-shim safe.
        assert!(!value.contains('"'));
        assert!(value.contains("'editing'"));
    }

    #[test]
    fn omits_developer_instructions_when_absent() {
        let args =
            build_claude_headless_args("sonnet", "medium", "/tmp/mcp.json", "sid-1", None, None);
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn builds_expected_headless_arg_vector() {
        let args =
            build_claude_headless_args("sonnet", "medium", "/tmp/mcp.json", "sid-1", None, None);
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"--tools".to_string()));
        assert!(args.contains(&"mcp__openreelio__*".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--session-id".to_string(), "sid-1".to_string()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--model".to_string(), "sonnet".to_string()]));
        // A file path, never inline JSON, is passed to --mcp-config.
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--mcp-config".to_string(), "/tmp/mcp.json".to_string()]));
        // No argument contains a double quote (Windows .cmd spawn safety).
        assert!(args.iter().all(|arg| !arg.contains('"')));
    }

    #[test]
    fn resume_session_replaces_session_id_flag() {
        let args = build_claude_headless_args(
            "sonnet",
            "medium",
            "/tmp/mcp.json",
            "sid-1",
            Some("prev"),
            None,
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--resume".to_string(), "prev".to_string()]));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn sanitizes_bridge_directory_names() {
        assert_eq!(sanitize_bridge_dir_name("a/b:c"), "a_b_c");
        assert_eq!(sanitize_bridge_dir_name(""), "session");
    }

    #[test]
    fn writes_mcp_config_file_with_bearer_header() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("mcp-config.json");
        write_mcp_config_file(&path, "http://127.0.0.1:9/mcp", "tok").expect("write");
        let contents = std::fs::read_to_string(&path).expect("read");
        let value: Value = serde_json::from_str(&contents).expect("json");
        assert_eq!(
            value["mcpServers"]["openreelio"]["url"],
            "http://127.0.0.1:9/mcp"
        );
        assert_eq!(
            value["mcpServers"]["openreelio"]["headers"]["Authorization"],
            "Bearer tok"
        );
    }

    #[test]
    fn wraps_tool_result_as_mcp_content() {
        let wrapped = wrap_tool_result(OpenReelioMcpCallResponse {
            text: "ok".to_string(),
            is_error: false,
            images: Vec::new(),
        });
        assert_eq!(wrapped["content"][0]["type"], "text");
        assert_eq!(wrapped["content"][0]["text"], "ok");
        // A text-only tool must serialise exactly as it did before images
        // existed, or every non-frame tool changes shape at once.
        assert_eq!(
            wrapped["content"].as_array().map(Vec::len),
            Some(1),
            "a tool that attaches no image must carry one block"
        );
        assert_eq!(wrapped["isError"], false);
    }

    #[test]
    fn tool_call_timeout_gives_a_render_its_own_budget() {
        // Bare as the loopback server registers it, prefixed as Claude spells
        // it: both hosts have to land on the same budget.
        assert_eq!(tool_call_timeout("render_proxy"), MCP_RENDER_CALL_TIMEOUT);
        assert_eq!(
            tool_call_timeout("mcp__openreelio__render_proxy"),
            MCP_RENDER_CALL_TIMEOUT
        );

        // Everything else keeps the default, which is sized for a human
        // answering an approval dialog rather than for FFmpeg.
        for tool in [
            "project_state",
            "frame_extract",
            "plan_apply",
            "mcp__openreelio__timeline_snapshot",
            // Matched exactly, not as a suffix or a prefix: only the tool that
            // actually renders gets the longer budget.
            "render_proxy_status",
            "my_render_proxy",
            "mcp__other__render_proxy",
        ] {
            assert_eq!(tool_call_timeout(tool), MCP_CALL_TIMEOUT, "{tool}");
        }

        assert!(MCP_RENDER_CALL_TIMEOUT > MCP_CALL_TIMEOUT);
    }

    #[test]
    fn omitted_images_default_to_none_for_existing_callers() {
        // The frontend bridge predates the field, so a response without it has
        // to keep deserialising rather than failing the whole tool call.
        let response: OpenReelioMcpCallResponse =
            serde_json::from_value(json!({ "text": "ok", "isError": false }))
                .expect("a response without images still parses");

        assert!(response.images.is_empty());
    }

    #[test]
    fn wraps_tool_result_images_after_the_text_block() {
        let wrapped = wrap_tool_result(OpenReelioMcpCallResponse {
            text: "{\"frames\":2}".to_string(),
            is_error: false,
            images: vec![
                McpImageBlock {
                    data: "AAAA".to_string(),
                    mime_type: "image/jpeg".to_string(),
                },
                McpImageBlock {
                    data: "BBBB".to_string(),
                    mime_type: "image/png".to_string(),
                },
            ],
        });

        let content = wrapped["content"].as_array().expect("content blocks");
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "{\"frames\":2}");
        // Order is the caller's: an image block that lost its place would put a
        // still against the wrong description of it.
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["data"], "AAAA");
        assert_eq!(content[1]["mimeType"], "image/jpeg");
        assert_eq!(content[2]["type"], "image");
        assert_eq!(content[2]["data"], "BBBB");
        assert_eq!(content[2]["mimeType"], "image/png");
        assert_eq!(wrapped["isError"], false);
    }

    #[test]
    fn generates_prefixed_unique_tokens() {
        let first = generate_mcp_bearer_token();
        let second = generate_mcp_bearer_token();
        assert!(first.starts_with("or_claude_"));
        assert!(first.len() > "or_claude_".len() + 32);
        assert_ne!(first, second);
    }

    #[test]
    fn parses_bearer_token_case_insensitively() {
        assert_eq!(
            parse_bearer_token(Some("Bearer or_claude_abc")),
            Some("or_claude_abc".to_string())
        );
        assert_eq!(
            parse_bearer_token(Some("bearer or_claude_abc")),
            Some("or_claude_abc".to_string())
        );
    }

    #[test]
    fn rejects_non_bearer_authorization() {
        assert_eq!(parse_bearer_token(Some("Basic Zm9vOmJhcg==")), None);
        assert_eq!(parse_bearer_token(Some("Bearer   ")), None);
        assert_eq!(parse_bearer_token(None), None);
    }
}
