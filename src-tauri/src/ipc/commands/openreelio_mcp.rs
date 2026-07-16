//! In-process loopback MCP server for the Claude Code headless runtime.
//!
//! Claude Code talks MCP over Streamable HTTP. Rather than pull in the full
//! `rmcp` server stack, this module implements the minimal JSON-RPC surface the
//! CLI needs (`initialize`, `tools/list`, `tools/call`) with a small `axum`
//! handler bound to `127.0.0.1` on an ephemeral port.
//!
//! Each headless session registers a random bearer token that maps to its
//! `server_id`, Claude `session_id`, and the OpenReelio tool catalog. A
//! `tools/call` is forwarded to the WebView domain executor via the
//! `openreelio:mcp:call` Tauri event and awaited on a `oneshot` channel keyed by
//! a generated `call_id`; the frontend answers with `respond_openreelio_mcp_call`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use tauri::{Emitter, State};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::core::claude_headless::{
    parse_bearer_token, wrap_tool_result, ClaudeMcpToolSpec, OpenReelioMcpCallResponse,
};
use crate::AppState;

/// Tauri event emitted when Claude invokes an OpenReelio MCP tool.
///
/// Payload (camelCase): `{ callId, serverId, sessionId, tool, args }`.
pub const OPENREELIO_MCP_CALL_EVENT: &str = "openreelio:mcp:call";

/// Tauri event emitted when a pending MCP tool call is cancelled (timed out or
/// its session was deregistered) so the WebView can dismiss the approval dialog.
///
/// Payload (camelCase): `{ callId, serverId }`.
pub const OPENREELIO_MCP_CANCEL_EVENT: &str = "openreelio:mcp:cancel";

/// MCP protocol revision advertised by the loopback server.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Maximum time to await a `tools/call` response from the frontend.
const MCP_CALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Registry entry for one headless session's bearer token.
struct McpSessionEntry {
    server_id: String,
    session_id: String,
    tools: Vec<ClaudeMcpToolSpec>,
    /// Whether the CLI has fetched this session's tool list yet.
    ///
    /// Claude connects to MCP servers asynchronously and starts the model turn
    /// without waiting, so a first user message sent immediately after spawn
    /// runs with NO tools (observed live: the model then role-plays the tool
    /// calls as text, fabricating results). Serving `tools/list` is the
    /// definitive "connected" signal the adapter waits for before the first
    /// message.
    tools_listed: bool,
}

/// A pending `tools/call` awaiting a frontend response.
struct PendingCall {
    /// The session's `server_id` (used to address a cancel event).
    server_id: String,
    /// Channel that delivers the frontend response back to the awaiting call.
    sender: oneshot::Sender<OpenReelioMcpCallResponse>,
}

/// Shared state accessible from the axum request handler.
pub struct OpenReelioMcpShared {
    app: tauri::AppHandle,
    /// bearer token -> session entry.
    sessions: Mutex<HashMap<String, McpSessionEntry>>,
    /// call_id -> pending responder.
    pending: Mutex<HashMap<String, PendingCall>>,
}

impl OpenReelioMcpShared {
    async fn tools_for(&self, token: &str) -> Option<Vec<ClaudeMcpToolSpec>> {
        let mut sessions = self.sessions.lock().await;
        sessions.get_mut(token).map(|entry| {
            entry.tools_listed = true;
            entry.tools.clone()
        })
    }

    /// Whether `tools/list` has been served for the session with `server_id`.
    async fn tools_listed_for_server(&self, server_id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions
            .values()
            .any(|entry| entry.server_id == server_id && entry.tools_listed)
    }

    /// Emits a best-effort cancel event for a pending call.
    fn emit_cancel(&self, call_id: &str, server_id: &str) {
        let _ = self.app.emit(
            OPENREELIO_MCP_CANCEL_EVENT,
            json!({ "callId": call_id, "serverId": server_id }),
        );
    }

    /// Returns `(server_id, session_id)` when the token maps to a session that
    /// exposes the named tool.
    async fn resolve_call(&self, token: &str, tool: &str) -> Option<(String, String)> {
        let sessions = self.sessions.lock().await;
        let entry = sessions.get(token)?;
        if entry.tools.iter().any(|spec| spec.name == tool) {
            Some((entry.server_id.clone(), entry.session_id.clone()))
        } else {
            None
        }
    }
}

/// Handle to the running loopback MCP server (one per app session).
pub struct OpenReelioMcpServer {
    port: u16,
    shared: Arc<OpenReelioMcpShared>,
    _task: tauri::async_runtime::JoinHandle<()>,
}

impl OpenReelioMcpServer {
    /// The MCP endpoint URL Claude should connect to.
    pub fn mcp_url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port)
    }

    /// Registers a headless session's bearer token and tool catalog.
    pub async fn register_session(
        &self,
        token: String,
        server_id: String,
        session_id: String,
        tools: Vec<ClaudeMcpToolSpec>,
    ) {
        let mut sessions = self.shared.sessions.lock().await;
        sessions.insert(
            token,
            McpSessionEntry {
                tools_listed: false,
                server_id,
                session_id,
                tools,
            },
        );
    }

    /// Removes a session's bearer token (called on session stop/exit).
    ///
    /// Any of that session's `tools/call` requests still awaiting a frontend
    /// response are dropped and a best-effort cancel event is emitted for each so
    /// the WebView can dismiss the now-orphaned approval dialog.
    pub async fn deregister_token(&self, token: &str) {
        let server_id = {
            let mut sessions = self.shared.sessions.lock().await;
            sessions.remove(token).map(|entry| entry.server_id)
        };

        let Some(server_id) = server_id else {
            return;
        };

        let cancelled: Vec<String> = {
            let mut pending = self.shared.pending.lock().await;
            let call_ids: Vec<String> = pending
                .iter()
                .filter(|(_, call)| call.server_id == server_id)
                .map(|(call_id, _)| call_id.clone())
                .collect();
            for call_id in &call_ids {
                pending.remove(call_id);
            }
            call_ids
        };

        for call_id in cancelled {
            self.shared.emit_cancel(&call_id, &server_id);
        }
    }
}

/// Ensures the loopback MCP server is running, starting it lazily on first use.
pub async fn ensure_openreelio_mcp_server(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
) -> Result<Arc<OpenReelioMcpServer>, String> {
    let mut guard = state.openreelio_mcp.lock().await;
    if let Some(server) = guard.as_ref() {
        return Ok(server.clone());
    }

    let shared = Arc::new(OpenReelioMcpShared {
        app: app.clone(),
        sessions: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashMap::new()),
    });

    let router = Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(shared.clone());

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|error| format!("Failed to bind OpenReelio MCP server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to read OpenReelio MCP server address: {error}"))?
        .port();

    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!("OpenReelio MCP server terminated: {error}");
        }
    });

    let server = Arc::new(OpenReelioMcpServer {
        port,
        shared,
        _task: task,
    });
    *guard = Some(server.clone());
    Ok(server)
}

/// Waits until Claude has fetched the MCP tool list for `server_id`.
///
/// Claude connects to MCP servers asynchronously and does not wait before
/// starting the model turn, so a user message sent immediately after spawn
/// runs with NO tools and the model role-plays the calls as text (verified by
/// probing: an immediate first message yields `mcp_servers: pending` and
/// `tools: []`, a delayed one yields `connected` and real tool calls). Serving
/// `tools/list` is the definitive readiness signal. Returns `true` when ready;
/// `false` after `timeout_ms` (default 15s) so callers can proceed degraded.
#[tauri::command]
#[specta::specta]
pub async fn wait_openreelio_mcp_ready(
    state: State<'_, AppState>,
    server_id: String,
    timeout_ms: Option<u32>,
) -> Result<bool, String> {
    let server = {
        let guard = state.openreelio_mcp.lock().await;
        guard.as_ref().cloned()
    };
    let Some(server) = server else {
        return Ok(false);
    };

    let deadline =
        std::time::Instant::now() + Duration::from_millis(u64::from(timeout_ms.unwrap_or(15_000)));
    loop {
        if server.shared.tools_listed_for_server(&server_id).await {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Delivers a frontend tool-call result back to a pending `tools/call`.
#[tauri::command]
#[specta::specta]
pub async fn respond_openreelio_mcp_call(
    state: State<'_, AppState>,
    call_id: String,
    response: OpenReelioMcpCallResponse,
) -> Result<(), String> {
    let server = {
        let guard = state.openreelio_mcp.lock().await;
        guard.clone()
    }
    .ok_or_else(|| "OpenReelio MCP server is not running".to_string())?;

    let pending = {
        let mut pending = server.shared.pending.lock().await;
        pending.remove(&call_id)
    }
    .ok_or_else(|| format!("Unknown or already-answered MCP call id: {call_id}"))?;

    pending
        .sender
        .send(response)
        .map_err(|_| "MCP call responder was dropped before the response arrived".to_string())
}

async fn handle_mcp(
    AxumState(shared): AxumState<Arc<OpenReelioMcpShared>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            "Missing or invalid Authorization bearer token",
        )
            .into_response();
    };

    let request: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return json_rpc_error(Value::Null, -32700, "Parse error"),
    };

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let id = request.get("id").cloned();

    // Notifications carry no id and expect no JSON-RPC response body.
    if method.starts_with("notifications/") || id.is_none() {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = id.unwrap_or(Value::Null);

    match method.as_str() {
        "initialize" => json_rpc_result(id, initialize_result()),
        "ping" => json_rpc_result(id, json!({})),
        "tools/list" => match shared.tools_for(&token).await {
            Some(tools) => json_rpc_result(id, json!({ "tools": encode_tool_list(&tools) })),
            None => json_rpc_error(id, -32001, "Unknown MCP session token"),
        },
        "tools/call" => handle_tools_call(&shared, &token, id, request.get("params")).await,
        other => json_rpc_error(id, -32601, &format!("Method not found: {other}")),
    }
}

async fn handle_tools_call(
    shared: &Arc<OpenReelioMcpShared>,
    token: &str,
    id: Value,
    params: Option<&Value>,
) -> Response {
    let Some(tool) = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
    else {
        return json_rpc_error(id, -32602, "tools/call requires a tool name");
    };
    let args = params
        .and_then(|params| params.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));

    let Some((server_id, session_id)) = shared.resolve_call(token, tool).await else {
        return json_rpc_error(id, -32601, &format!("Unknown OpenReelio tool: {tool}"));
    };

    let call_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel::<OpenReelioMcpCallResponse>();
    {
        let mut pending = shared.pending.lock().await;
        pending.insert(
            call_id.clone(),
            PendingCall {
                server_id: server_id.clone(),
                sender,
            },
        );
    }

    let emitted = shared.app.emit(
        OPENREELIO_MCP_CALL_EVENT,
        json!({
            "callId": call_id,
            "serverId": server_id,
            "sessionId": session_id,
            "tool": tool,
            "args": args,
        }),
    );
    if let Err(error) = emitted {
        shared.pending.lock().await.remove(&call_id);
        return json_rpc_error(
            id,
            -32603,
            &format!("Failed to dispatch OpenReelio tool call: {error}"),
        );
    }

    match timeout(MCP_CALL_TIMEOUT, receiver).await {
        Ok(Ok(response)) => json_rpc_result(id, wrap_tool_result(response)),
        Ok(Err(_)) => {
            // The responder was dropped (e.g. the session was deregistered).
            shared.pending.lock().await.remove(&call_id);
            json_rpc_error(id, -32603, "OpenReelio tool call was cancelled")
        }
        Err(_) => {
            // Timed out waiting for the frontend: cancel the approval dialog so
            // the WebView does not leave a stale, un-actionable prompt open.
            shared.pending.lock().await.remove(&call_id);
            shared.emit_cancel(&call_id, &server_id);
            json_rpc_error(id, -32603, "OpenReelio tool call timed out")
        }
    }
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": "openreelio",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

fn encode_tool_list(tools: &[ClaudeMcpToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|spec| {
            json!({
                "name": spec.name,
                "description": spec.description,
                "inputSchema": spec.input_schema,
            })
        })
        .collect()
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    // Delegate the pure parsing to the Tauri-free core (unit-tested there).
    parse_bearer_token(Some(value))
}

fn json_rpc_result(id: Value, result: Value) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
    )
        .into_response()
}

fn json_rpc_error(id: Value, code: i64, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

// The pure MCP helpers (`generate_mcp_bearer_token`, `parse_bearer_token`,
// `wrap_tool_result`) and their unit tests live in `core::claude_headless` where
// they compile under #[cfg(test)] (this commands module is #[cfg(not(test))]).
