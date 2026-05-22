//! Codex app-server process transport types and JSONL codec helpers.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use uuid::Uuid;

pub const CODEX_APP_SERVER_EVENT_PREFIX: &str = "codex:app-server";

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartCodexAppServerInput {
    pub server_id: Option<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerStartResult {
    pub server_id: String,
    pub event_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub bridge_cwd: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerSessionInput {
    pub server_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerWriteInput {
    pub server_id: String,
    pub message: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexAppServerStreamEvent {
    Message { message: Value },
    Stderr { text: String },
    Error { message: String },
    Exit { exit_code: Option<i32> },
}

pub fn codex_app_server_event_name(server_id: &str) -> String {
    format!("{CODEX_APP_SERVER_EVENT_PREFIX}:{server_id}")
}

pub fn normalize_codex_app_server_id(server_id: Option<String>) -> Result<String, String> {
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

pub fn encode_json_rpc_line(message: &Value) -> Result<Vec<u8>, String> {
    if !message.is_object() {
        return Err("Codex app-server messages must be JSON objects".to_string());
    }

    let mut line = serde_json::to_vec(message)
        .map_err(|error| format!("Failed to encode Codex app-server message: {error}"))?;
    line.push(b'\n');
    Ok(line)
}

pub fn decode_json_rpc_line(line: &str) -> Result<Value, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("Codex app-server emitted an empty stdout line".to_string());
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|error| format!("Failed to decode Codex app-server stdout JSON: {error}"))?;
    if !value.is_object() {
        return Err("Codex app-server stdout JSON must be an object".to_string());
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_encode_json_rpc_message_as_single_newline_delimited_object() {
        let encoded = encode_json_rpc_line(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize"
        }))
        .expect("encoded");

        assert!(encoded.ends_with(b"\n"));
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);
        assert_eq!(
            std::str::from_utf8(&encoded).expect("utf8"),
            "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"initialize\"}\n"
        );
    }

    #[test]
    fn should_reject_non_object_json_rpc_messages() {
        let error = encode_json_rpc_line(&serde_json::json!(["not", "object"]))
            .expect_err("non-object error");

        assert!(error.contains("JSON objects"));
    }

    #[test]
    fn should_decode_stdout_json_rpc_object_lines() {
        let decoded = decode_json_rpc_line(r#"{"id":1,"result":{}}"#).expect("decoded");

        assert_eq!(decoded["id"], 1);
        assert!(decoded["result"].is_object());
    }

    #[test]
    fn should_report_malformed_stdout_without_panicking() {
        let error = decode_json_rpc_line("not-json").expect_err("decode error");

        assert!(error.contains("Failed to decode"));
    }

    #[test]
    fn should_normalize_missing_server_id_to_uuid() {
        let id = normalize_codex_app_server_id(None).expect("id");

        assert_eq!(id.len(), 36);
    }
}
