//! Streaming AI Completion Module
//!
//! Provides a streaming IPC command that uses Tauri's event system to emit
//! LLM response chunks to the frontend in real time. Supports Anthropic,
//! OpenAI, Gemini, and local (Ollama) providers.
//!
//! # Architecture
//!
//! The [`stream_ai_completion`] command is a Tauri IPC command that:
//! 1. Reads the active provider configuration from the module-level cache
//! 2. Builds a provider-specific streaming HTTP request
//! 3. Reads the SSE byte stream incrementally via `reqwest::Response::chunk()`
//! 4. Parses SSE events and extracts text deltas
//! 5. Emits [`StreamEvent`] payloads to the frontend via `app.emit()`
//!
//! The frontend listens on `ai_stream_{stream_id}` using `@tauri-apps/api/event`.
//!
//! # Provider Configuration
//!
//! Provider credentials are cached in a module-level [`OnceLock`] when
//! [`set_streaming_provider_config`] is called (typically from
//! `configure_ai_provider`). This avoids modifying [`AppState`] and keeps
//! streaming decoupled from the generic `AIProvider` trait.

use std::sync::OnceLock;

#[cfg(feature = "ai-providers")]
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::Mutex as TokioMutex;

#[cfg(feature = "ai-providers")]
use tokio::sync::oneshot;

use crate::core::ai::providers::ProviderType;

// =============================================================================
// Stream Event Types (emitted to frontend via Tauri events)
// =============================================================================

/// A single event emitted during a streaming AI completion.
///
/// Events are sent to the frontend on the channel `ai_stream_{stream_id}`.
/// The `type` tag (via `serde(tag = "type")`) lets the frontend switch on
/// event kind without an additional wrapper.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StreamEvent {
    /// A chunk of generated text content.
    TextDelta { content: String },
    /// A chunk of reasoning/thinking content (e.g., Anthropic extended thinking).
    ReasoningDelta { content: String },
    /// Indicates a tool call has started.
    ToolCallStart { id: String, name: String },
    /// A chunk of tool call argument JSON.
    ToolCallDelta {
        id: String,
        #[serde(rename = "argsChunk")]
        args_chunk: String,
    },
    /// Indicates a tool call is complete with the full arguments.
    ToolCallComplete {
        id: String,
        name: String,
        #[serde(rename = "argsJson")]
        args_json: String,
    },
    /// Token usage statistics (typically emitted once near the end).
    Usage {
        #[serde(rename = "inputTokens")]
        input_tokens: u32,
        #[serde(rename = "outputTokens")]
        output_tokens: u32,
    },
    /// An error occurred during streaming.
    Error { message: String },
    /// The stream has completed.
    Done {
        #[serde(rename = "finishReason")]
        finish_reason: String,
        /// Final output token count (if provided by the provider, e.g. Anthropic message_delta).
        #[serde(rename = "outputTokens", skip_serializing_if = "Option::is_none")]
        output_tokens: Option<u32>,
    },
}

// =============================================================================
// Stream Options DTO
// =============================================================================

/// Optional parameters for a streaming completion request.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamOptionsDto {
    /// Maximum tokens to generate.
    pub max_tokens: Option<u32>,
    /// Sampling temperature (0.0 - 2.0).
    pub temperature: Option<f32>,
    /// Model override (uses provider default if not set).
    pub model: Option<String>,
    /// Whether to request JSON output mode.
    pub json_mode: Option<bool>,
}

// =============================================================================
// Stream Message DTO
// =============================================================================

/// A single message in the conversation history for streaming requests.
///
/// This mirrors `ConversationMessage` from the provider module but carries
/// the `specta::Type` derive for frontend type generation.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamMessage {
    /// Role: "user", "assistant", or "system".
    pub role: String,
    /// Message text content.
    pub content: String,
}

/// Tool definition passed from the frontend for model function-calling.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamToolDefinition {
    /// Tool/function name.
    pub name: String,
    /// Human-readable description of the tool.
    pub description: String,
    /// JSON Schema describing tool input parameters.
    pub parameters: serde_json::Value,
}

// =============================================================================
// Streaming Provider Configuration (module-level cache)
// =============================================================================

/// Cached provider configuration used by the streaming command.
///
/// This is stored separately from the `Box<dyn AIProvider>` in the gateway
/// because the trait does not expose streaming capabilities. The streaming
/// command needs raw HTTP access (API key, base URL, provider type).
#[derive(Debug, Clone)]
pub struct StreamingProviderConfig {
    /// Provider type identifier.
    pub provider_type: ProviderType,
    /// API key for authentication.
    pub api_key: String,
    /// Base URL for API requests.
    pub base_url: String,
    /// Default model to use.
    pub model: String,
}

/// Module-level storage for the active streaming provider configuration.
///
/// Initialized via [`set_streaming_provider_config`] when the AI provider is
/// configured, and read by [`stream_ai_completion`] on each streaming request.
static STREAMING_CONFIG: OnceLock<TokioMutex<Option<StreamingProviderConfig>>> = OnceLock::new();

/// Stores the active provider configuration for streaming.
///
/// This should be called from `configure_ai_provider` whenever the provider
/// is (re)configured so that the streaming command has access to the raw
/// credentials.
pub async fn set_streaming_provider_config(config: StreamingProviderConfig) {
    let mutex = STREAMING_CONFIG.get_or_init(|| TokioMutex::new(None));
    let mut guard = mutex.lock().await;
    *guard = Some(config);
}

/// Clears the cached streaming provider configuration.
///
/// Called when the AI provider is cleared/removed.
pub async fn clear_streaming_provider_config() {
    let mutex = STREAMING_CONFIG.get_or_init(|| TokioMutex::new(None));
    let mut guard = mutex.lock().await;
    *guard = None;
}

/// Reads a clone of the current streaming provider configuration.
async fn get_streaming_config() -> Option<StreamingProviderConfig> {
    let mutex = STREAMING_CONFIG.get_or_init(|| TokioMutex::new(None));
    let guard = mutex.lock().await;
    guard.clone()
}

/// Active stream cancel channels keyed by stream ID.
#[cfg(feature = "ai-providers")]
static ACTIVE_STREAMS: OnceLock<TokioMutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();

#[cfg(feature = "ai-providers")]
async fn register_stream(stream_id: &str, cancel_tx: oneshot::Sender<()>) {
    let mutex = ACTIVE_STREAMS.get_or_init(|| TokioMutex::new(HashMap::new()));
    let mut guard = mutex.lock().await;
    guard.insert(stream_id.to_string(), cancel_tx);
}

#[cfg(feature = "ai-providers")]
async fn take_stream_cancel_sender(stream_id: &str) -> Option<oneshot::Sender<()>> {
    let mutex = ACTIVE_STREAMS.get_or_init(|| TokioMutex::new(HashMap::new()));
    let mut guard = mutex.lock().await;
    guard.remove(stream_id)
}

#[cfg(feature = "ai-providers")]
async fn unregister_stream(stream_id: &str) {
    let mutex = ACTIVE_STREAMS.get_or_init(|| TokioMutex::new(HashMap::new()));
    let mut guard = mutex.lock().await;
    guard.remove(stream_id);
}

// =============================================================================
// SSE Parsing Utilities
// =============================================================================

/// Extracts the data payload from an SSE line.
///
/// Returns `Some(data)` for lines starting with `"data: "` that are not the
/// `[DONE]` sentinel. Returns `None` for comment lines, event type lines,
/// empty lines, and the `[DONE]` marker.
fn parse_sse_line(line: &str) -> Option<&str> {
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" {
        return None;
    }
    Some(data)
}

fn normalized_tool_schema(value: &serde_json::Value) -> serde_json::Value {
    if value.is_object() {
        value.clone()
    } else {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": true,
        })
    }
}

#[cfg(feature = "ai-providers")]
fn flush_pending_tool_calls(
    app: &tauri::AppHandle,
    event_name: &str,
    pending_tool_calls: &mut HashMap<String, (String, String)>,
) {
    let pending = pending_tool_calls.drain().collect::<Vec<_>>();
    for (id, (name, args_json)) in pending {
        let payload = StreamEvent::ToolCallComplete {
            id,
            name,
            args_json: if args_json.trim().is_empty() {
                "{}".to_string()
            } else {
                args_json
            },
        };
        let _ = app.emit(event_name, &payload);
    }
}

// =============================================================================
// Provider-Specific SSE Event Parsers
// =============================================================================

/// Parses an Anthropic streaming SSE event into a [`StreamEvent`].
///
/// Anthropic uses typed events:
/// - `message_start`: contains usage info
/// - `content_block_delta`: contains `text_delta` or `thinking_delta`
/// - `message_delta`: contains `stop_reason` and final usage
/// - `message_stop`: terminal event
///
/// Returns `None` for events that do not map to a meaningful `StreamEvent`
/// (e.g., `ping`, `content_block_start`, `content_block_stop`).
fn parse_anthropic_event(data: &str) -> Option<StreamEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let event_type = value.get("type")?.as_str()?;

    match event_type {
        "content_block_delta" => {
            let delta = value.get("delta")?;
            let delta_type = delta.get("type")?.as_str()?;

            match delta_type {
                "text_delta" => {
                    let text = delta.get("text")?.as_str()?;
                    Some(StreamEvent::TextDelta {
                        content: text.to_string(),
                    })
                }
                "thinking_delta" => {
                    let thinking = delta.get("thinking")?.as_str()?;
                    Some(StreamEvent::ReasoningDelta {
                        content: thinking.to_string(),
                    })
                }
                "input_json_delta" => {
                    let partial_json = delta.get("partial_json")?.as_str()?;
                    // Tool call argument streaming - extract the index to identify the tool
                    let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    Some(StreamEvent::ToolCallDelta {
                        id: format!("tool_{}", index),
                        args_chunk: partial_json.to_string(),
                    })
                }
                _ => None,
            }
        }
        "content_block_start" => {
            let content_block = value.get("content_block")?;
            let block_type = content_block.get("type")?.as_str()?;

            if block_type == "tool_use" {
                let index = value.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let id = format!("tool_{}", index);
                let name = content_block.get("name")?.as_str()?.to_string();

                if let Some(input) = content_block.get("input") {
                    let args_json =
                        serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string());
                    Some(StreamEvent::ToolCallComplete {
                        id,
                        name,
                        args_json,
                    })
                } else {
                    Some(StreamEvent::ToolCallStart { id, name })
                }
            } else {
                None
            }
        }
        "message_start" => {
            // Extract initial usage from the message object
            let message = value.get("message")?;
            let usage = message.get("usage")?;
            let input_tokens = usage.get("input_tokens")?.as_u64()? as u32;
            // output_tokens may be 0 at start
            let output_tokens = usage
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            })
        }
        "message_delta" => {
            let delta = value.get("delta")?;
            let stop_reason = delta
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .unwrap_or("stop")
                .to_string();

            // Extract final output token count if present in usage
            let final_output_tokens = value
                .get("usage")
                .and_then(|usage| usage.get("output_tokens"))
                .and_then(|v| v.as_u64())
                .map(|t| t as u32);

            Some(StreamEvent::Done {
                finish_reason: stop_reason,
                output_tokens: final_output_tokens,
            })
        }
        "error" => {
            let error = value.get("error")?;
            let message = error
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown Anthropic streaming error");
            Some(StreamEvent::Error {
                message: message.to_string(),
            })
        }
        // ping, content_block_stop, message_stop: no meaningful event
        _ => None,
    }
}

/// Parses an OpenAI streaming SSE event into a [`StreamEvent`].
///
/// OpenAI streams `data: {json}` lines where each JSON object has a
/// `choices[0].delta` with optional `content`, `role`, or `tool_calls` fields.
/// The final chunk often has `finish_reason` set.
///
/// Returns `None` for events without meaningful content (e.g., role-only deltas).
fn parse_openai_event(data: &str) -> Option<StreamEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;

    // Check for usage in the response (OpenAI sends usage in the last chunk
    // when `stream_options: {include_usage: true}` is set, or after all choices)
    if let Some(usage) = value.get("usage") {
        let prompt_tokens = usage
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let completion_tokens = usage
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        if prompt_tokens > 0 || completion_tokens > 0 {
            return Some(StreamEvent::Usage {
                input_tokens: prompt_tokens,
                output_tokens: completion_tokens,
            });
        }
    }

    let choices = value.get("choices")?.as_array()?;
    let choice = choices.first()?;

    // Check finish_reason first
    if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
        return Some(StreamEvent::Done {
            finish_reason: reason.to_string(),
            output_tokens: None,
        });
    }

    let delta = choice.get("delta")?;

    // Tool calls
    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
        if let Some(tc) = tool_calls.first() {
            let provider_id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
            let id = if provider_id.is_empty() {
                format!("tool_{}", index)
            } else {
                provider_id
            };
            let function = tc.get("function")?;

            // If name is present, this is the start of a tool call.
            // Always emit ToolCallStart first; any arguments in the same
            // delta are treated as the first ToolCallDelta (OpenAI may
            // send partial arguments alongside the name).
            if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                return Some(StreamEvent::ToolCallStart {
                    id,
                    name: name.to_string(),
                });
            }

            // Otherwise it's an argument chunk
            if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) {
                return Some(StreamEvent::ToolCallDelta {
                    id,
                    args_chunk: args.to_string(),
                });
            }
        }
        return None;
    }

    // Text content
    let content = delta.get("content")?.as_str()?;
    if content.is_empty() {
        return None;
    }

    Some(StreamEvent::TextDelta {
        content: content.to_string(),
    })
}

/// Parses a Google Gemini streaming SSE event into a [`StreamEvent`].
///
/// Gemini streams complete candidate objects. Each SSE data line contains a
/// JSON object with `candidates[0].content.parts[0].text` for text content,
/// and `usageMetadata` for token counts.
///
/// Returns `None` for events without extractable content.
fn parse_gemini_event(data: &str) -> Option<StreamEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;

    // Check for prompt feedback (blocked content)
    if let Some(feedback) = value.get("promptFeedback") {
        if let Some(reason) = feedback.get("blockReason").and_then(|v| v.as_str()) {
            return Some(StreamEvent::Error {
                message: format!("Content blocked by Gemini safety filters: {}", reason),
            });
        }
    }

    // Try to extract candidate data (may be absent in usage-only events)
    let candidate = value
        .get("candidates")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());

    if let Some(candidate) = candidate {
        // Check finish reason
        let finish_reason = candidate
            .get("finishReason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Extract either text or function call from candidate parts.
        if let Some(parts) = candidate
            .get("content")
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
        {
            for (index, part) in parts.iter().enumerate() {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    if !text.is_empty() {
                        // If there's also a finish reason, we emit text first;
                        // the finish reason will come in a subsequent event.
                        return Some(StreamEvent::TextDelta {
                            content: text.to_string(),
                        });
                    }
                }

                if let Some(function_call) = part
                    .get("functionCall")
                    .or_else(|| part.get("function_call"))
                {
                    let name = function_call
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let args = function_call
                        .get("args")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    let args_json =
                        serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                    return Some(StreamEvent::ToolCallComplete {
                        id: format!("tool_{}", index),
                        name,
                        args_json,
                    });
                }
            }
        }

        // If no text but we have a finish reason, emit Done
        if let Some(reason) = finish_reason {
            let mapped_reason = match reason.as_str() {
                "STOP" => "stop",
                "MAX_TOKENS" => "length",
                "SAFETY" | "RECITATION" | "OTHER" => "content_filter",
                other => other,
            };
            return Some(StreamEvent::Done {
                finish_reason: mapped_reason.to_string(),
                output_tokens: None,
            });
        }
    }

    // Check for usage metadata (may come with or without candidates)
    if let Some(usage) = value.get("usageMetadata") {
        let prompt_tokens = usage
            .get("promptTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let candidates_tokens = usage
            .get("candidatesTokenCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        if prompt_tokens > 0 || candidates_tokens > 0 {
            return Some(StreamEvent::Usage {
                input_tokens: prompt_tokens,
                output_tokens: candidates_tokens,
            });
        }
    }

    None
}

/// Parses a local (Ollama) streaming event into a [`StreamEvent`].
///
/// Ollama streams newline-delimited JSON (not SSE). Each line is a complete
/// JSON object with a `response` field for text content and a `done` boolean.
fn parse_local_event(data: &str) -> Option<StreamEvent> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;

    // Check if the stream is done
    let is_done = value.get("done").and_then(|v| v.as_bool()).unwrap_or(false);

    if is_done {
        // Extract final usage if available
        if let (Some(prompt_tokens), Some(eval_tokens)) = (
            value.get("prompt_eval_count").and_then(|v| v.as_u64()),
            value.get("eval_count").and_then(|v| v.as_u64()),
        ) {
            // We'll emit usage; the caller will emit Done separately
            return Some(StreamEvent::Usage {
                input_tokens: prompt_tokens as u32,
                output_tokens: eval_tokens as u32,
            });
        }

        return Some(StreamEvent::Done {
            finish_reason: "stop".to_string(),
            output_tokens: None,
        });
    }

    // Extract text content
    let response = value.get("response")?.as_str()?;
    if response.is_empty() {
        return None;
    }

    Some(StreamEvent::TextDelta {
        content: response.to_string(),
    })
}

// =============================================================================
// HTTP Request Builders (provider-specific)
// =============================================================================

/// Builds an Anthropic streaming HTTP request.
#[cfg(feature = "ai-providers")]
fn build_anthropic_request(
    client: &reqwest::Client,
    config: &StreamingProviderConfig,
    messages: &[StreamMessage],
    system_prompt: &Option<String>,
    options: &Option<StreamOptionsDto>,
    tools: &Option<Vec<StreamToolDefinition>>,
) -> reqwest::RequestBuilder {
    use crate::core::ai::providers::AnthropicProvider;

    let model = options
        .as_ref()
        .and_then(|o| o.model.clone())
        .unwrap_or_else(|| config.model.clone());

    // Default to 16384 to avoid truncating complex structured responses.
    let max_tokens = options.as_ref().and_then(|o| o.max_tokens).unwrap_or(16384);

    let mut api_messages: Vec<serde_json::Value> = Vec::new();
    for msg in messages {
        if msg.role != "system" {
            api_messages.push(serde_json::json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
    }

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": api_messages,
        "stream": true,
    });

    if let Some(system) = system_prompt {
        body["system"] = serde_json::Value::String(system.clone());
    }

    if let Some(opts) = options {
        if let Some(temp) = opts.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
    }

    if let Some(tool_defs) = tools {
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::Value::Array(
                tool_defs
                    .iter()
                    .map(|tool| {
                        serde_json::json!({
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": normalized_tool_schema(&tool.parameters),
                        })
                    })
                    .collect(),
            );
        }
    }

    let url = format!("{}/v1/messages", config.base_url);
    client
        .post(&url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", AnthropicProvider::API_VERSION)
        .header("Content-Type", "application/json")
        .json(&body)
}

/// Builds an OpenAI streaming HTTP request.
#[cfg(feature = "ai-providers")]
fn build_openai_request(
    client: &reqwest::Client,
    config: &StreamingProviderConfig,
    messages: &[StreamMessage],
    system_prompt: &Option<String>,
    options: &Option<StreamOptionsDto>,
    tools: &Option<Vec<StreamToolDefinition>>,
) -> reqwest::RequestBuilder {
    let model = options
        .as_ref()
        .and_then(|o| o.model.clone())
        .unwrap_or_else(|| config.model.clone());

    let mut api_messages: Vec<serde_json::Value> = Vec::new();

    // Add system prompt as first message
    if let Some(system) = system_prompt {
        api_messages.push(serde_json::json!({
            "role": "system",
            "content": system,
        }));
    }

    for msg in messages {
        if msg.role != "system" {
            api_messages.push(serde_json::json!({
                "role": msg.role,
                "content": msg.content,
            }));
        }
    }

    let mut body = serde_json::json!({
        "model": model,
        "messages": api_messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    if let Some(opts) = options {
        if let Some(max_tokens) = opts.max_tokens {
            body["max_tokens"] = serde_json::json!(max_tokens);
        }
        if let Some(temp) = opts.temperature {
            body["temperature"] = serde_json::json!(temp);
        }
        if opts.json_mode == Some(true) {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
    }

    if let Some(tool_defs) = tools {
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::Value::Array(
                tool_defs
                    .iter()
                    .map(|tool| {
                        serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": normalized_tool_schema(&tool.parameters),
                            },
                        })
                    })
                    .collect(),
            );
            body["tool_choice"] = serde_json::json!("auto");
        }
    }

    let url = format!("{}/chat/completions", config.base_url);
    client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
}

/// Builds a Google Gemini streaming HTTP request.
#[cfg(feature = "ai-providers")]
fn build_gemini_request(
    client: &reqwest::Client,
    config: &StreamingProviderConfig,
    messages: &[StreamMessage],
    system_prompt: &Option<String>,
    options: &Option<StreamOptionsDto>,
    tools: &Option<Vec<StreamToolDefinition>>,
) -> reqwest::RequestBuilder {
    let model = options
        .as_ref()
        .and_then(|o| o.model.clone())
        .unwrap_or_else(|| config.model.clone());

    let mut contents: Vec<serde_json::Value> = Vec::new();
    let mut system_parts: Vec<String> = Vec::new();

    if let Some(system) = system_prompt {
        if !system.trim().is_empty() {
            system_parts.push(system.clone());
        }
    }

    for msg in messages {
        let role_lower = msg.role.to_ascii_lowercase();
        if role_lower == "system" {
            if !msg.content.trim().is_empty() {
                system_parts.push(msg.content.clone());
            }
            continue;
        }

        let gemini_role = match role_lower.as_str() {
            "assistant" | "model" => "model",
            _ => "user",
        };

        contents.push(serde_json::json!({
            "role": gemini_role,
            "parts": [{ "text": msg.content }],
        }));
    }

    let mut body = serde_json::json!({ "contents": contents });

    if !system_parts.is_empty() {
        body["systemInstruction"] = serde_json::json!({
            "parts": [{ "text": system_parts.join("\n\n") }],
        });
    }

    let mut gen_config = serde_json::Map::new();
    if let Some(opts) = options {
        if let Some(temp) = opts.temperature {
            gen_config.insert("temperature".to_string(), serde_json::json!(temp));
        }
        if let Some(max_tokens) = opts.max_tokens {
            gen_config.insert("maxOutputTokens".to_string(), serde_json::json!(max_tokens));
        }
        if opts.json_mode == Some(true) {
            gen_config.insert(
                "responseMimeType".to_string(),
                serde_json::json!("application/json"),
            );
        }
    }
    if !gen_config.is_empty() {
        body["generationConfig"] = serde_json::Value::Object(gen_config);
    }

    if let Some(tool_defs) = tools {
        if !tool_defs.is_empty() {
            body["tools"] = serde_json::json!([
                {
                    "functionDeclarations": tool_defs.iter().map(|tool| {
                        serde_json::json!({
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": normalized_tool_schema(&tool.parameters),
                        })
                    }).collect::<Vec<_>>()
                }
            ]);
        }
    }

    // Gemini uses a different endpoint suffix for streaming
    let url = format!(
        "{}/models/{}:streamGenerateContent?alt=sse",
        config.base_url, model
    );

    client
        .post(&url)
        .header("x-goog-api-key", &config.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
}

/// Builds a local (Ollama) streaming HTTP request.
#[cfg(feature = "ai-providers")]
fn build_local_request(
    client: &reqwest::Client,
    config: &StreamingProviderConfig,
    messages: &[StreamMessage],
    system_prompt: &Option<String>,
    options: &Option<StreamOptionsDto>,
    _tools: &Option<Vec<StreamToolDefinition>>,
) -> reqwest::RequestBuilder {
    let model = options
        .as_ref()
        .and_then(|o| o.model.clone())
        .unwrap_or_else(|| config.model.clone());

    let mut api_messages: Vec<serde_json::Value> = Vec::new();

    if let Some(system) = system_prompt {
        api_messages.push(serde_json::json!({
            "role": "system",
            "content": system,
        }));
    }

    for msg in messages {
        api_messages.push(serde_json::json!({
            "role": msg.role,
            "content": msg.content,
        }));
    }

    let mut body = serde_json::json!({
        "model": model,
        "messages": api_messages,
        "stream": true,
    });

    if let Some(opts) = options {
        let mut opts_map = serde_json::Map::new();
        if let Some(temp) = opts.temperature {
            opts_map.insert("temperature".to_string(), serde_json::json!(temp));
        }
        if !opts_map.is_empty() {
            body["options"] = serde_json::Value::Object(opts_map);
        }
    }

    let url = format!("{}/api/chat", config.base_url);
    client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
}

// =============================================================================
// SSE Line Buffer
// =============================================================================

/// Accumulates bytes from chunked HTTP responses and yields complete lines.
///
/// SSE events are delimited by newlines (`\n` or `\r\n`). This buffer
/// collects incoming bytes and splits them into complete lines as they
/// become available.
struct SseLineBuffer {
    /// Accumulated bytes that haven't yet formed a complete line.
    buffer: String,
}

impl SseLineBuffer {
    fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// Appends raw bytes and returns all complete lines found.
    ///
    /// Incomplete trailing data is kept in the internal buffer for the
    /// next call.
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let text = String::from_utf8_lossy(chunk);
        self.buffer.push_str(&text);

        let mut lines = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let line = self.buffer[..pos].trim_end_matches('\r').to_string();
            // Use drain to avoid reallocating the entire remaining buffer
            self.buffer.drain(..=pos);
            lines.push(line);
        }

        lines
    }

    /// Returns any remaining data in the buffer as a final line.
    ///
    /// This should be called after the stream ends to handle any trailing
    /// content that wasn't terminated by a newline.
    fn flush(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            None
        } else {
            let remaining = std::mem::take(&mut self.buffer);
            let trimmed = remaining.trim_end_matches('\r').to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }
    }
}

// =============================================================================
// IPC Command
// =============================================================================

/// Streams an AI completion to the frontend via Tauri events.
///
/// The frontend should listen on `ai_stream_{stream_id}` for [`StreamEvent`]
/// payloads. The command returns `Ok(())` immediately after starting the
/// stream, or `Err(String)` if the stream cannot be initiated (e.g., no
/// provider configured, HTTP error).
///
/// # Arguments
///
/// * `app` - Tauri application handle for event emission
/// * `stream_id` - Frontend-generated UUID to namespace the event channel
/// * `messages` - Conversation history
/// * `system_prompt` - Optional system prompt
/// * `options` - Optional streaming parameters (model, temperature, etc.)
/// * `tools` - Optional tool/function definitions for model tool-calling
#[cfg(feature = "ai-providers")]
#[tauri::command]
#[specta::specta]
pub async fn stream_ai_completion(
    app: tauri::AppHandle,
    stream_id: String,
    messages: Vec<StreamMessage>,
    system_prompt: Option<String>,
    options: Option<StreamOptionsDto>,
    tools: Option<Vec<StreamToolDefinition>>,
) -> Result<(), String> {
    let config = get_streaming_config().await.ok_or_else(|| {
        "AI provider not configured. Please configure a provider first.".to_string()
    })?;

    let event_name = format!("ai_stream_{}", stream_id);

    // Build HTTP client with a generous timeout for streaming connections.
    // We don't use the provider's client because it may have a short timeout
    // that would kill long-running streams.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Build the provider-specific streaming request
    let is_local = config.provider_type == ProviderType::Local;
    let request = match config.provider_type {
        ProviderType::Anthropic => build_anthropic_request(
            &client,
            &config,
            &messages,
            &system_prompt,
            &options,
            &tools,
        ),
        ProviderType::OpenAI => build_openai_request(
            &client,
            &config,
            &messages,
            &system_prompt,
            &options,
            &tools,
        ),
        ProviderType::Gemini => build_gemini_request(
            &client,
            &config,
            &messages,
            &system_prompt,
            &options,
            &tools,
        ),
        ProviderType::Local => build_local_request(
            &client,
            &config,
            &messages,
            &system_prompt,
            &options,
            &tools,
        ),
    };

    // Send the request
    let response = request
        .send()
        .await
        .map_err(|e| format!("Streaming request failed: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<unreadable response body>".to_string());

        let error_msg = format!("{} API error ({}): {}", config.provider_type, status, body);

        // Emit the error to the frontend before returning
        let _ = app.emit(
            &event_name,
            &StreamEvent::Error {
                message: error_msg.clone(),
            },
        );
        let _ = app.emit(
            &event_name,
            &StreamEvent::Done {
                finish_reason: "error".to_string(),
                output_tokens: None,
            },
        );

        return Err(error_msg);
    }

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    register_stream(&stream_id, cancel_tx).await;

    // Spawn a background task to read the stream and emit events.
    // This allows the IPC command to return immediately.
    let provider_type = config.provider_type;
    let stream_id_for_task = stream_id.clone();
    tokio::spawn(async move {
        let mut line_buffer = SseLineBuffer::new();
        let mut response = response;
        let mut emitted_done = false;
        let mut pending_tool_calls: HashMap<String, (String, String)> = HashMap::new();

        let parse_line = |line: &str| -> Option<StreamEvent> {
            if is_local {
                // Ollama uses newline-delimited JSON, not SSE
                parse_local_event(line)
            } else if let Some(data) = parse_sse_line(line) {
                match provider_type {
                    ProviderType::Anthropic => parse_anthropic_event(data),
                    ProviderType::OpenAI => parse_openai_event(data),
                    ProviderType::Gemini => parse_gemini_event(data),
                    ProviderType::Local => parse_local_event(data),
                }
            } else {
                None
            }
        };

        // Read chunks incrementally using reqwest's chunk() method.
        // This does not require the "stream" feature.
        'stream_loop: loop {
            let chunk_result = tokio::select! {
                _ = &mut cancel_rx => {
                    flush_pending_tool_calls(&app, &event_name, &mut pending_tool_calls);
                    if !emitted_done {
                        let _ = app.emit(
                            &event_name,
                            &StreamEvent::Done {
                                finish_reason: "cancelled".to_string(),
                                output_tokens: None,
                            },
                        );
                    }
                    break 'stream_loop;
                }
                result = response.chunk() => result,
            };

            match chunk_result {
                Ok(Some(bytes)) => {
                    let lines = line_buffer.push(&bytes);
                    for line in lines {
                        if line.is_empty() {
                            continue;
                        }

                        let event = parse_line(&line);

                        if let Some(evt) = event {
                            match &evt {
                                StreamEvent::ToolCallStart { id, name } => {
                                    pending_tool_calls
                                        .entry(id.clone())
                                        .and_modify(|entry| entry.0 = name.clone())
                                        .or_insert_with(|| (name.clone(), String::new()));
                                }
                                StreamEvent::ToolCallDelta { id, args_chunk } => {
                                    let entry = pending_tool_calls
                                        .entry(id.clone())
                                        .or_insert_with(|| (id.clone(), String::new()));
                                    entry.1.push_str(args_chunk);
                                }
                                StreamEvent::ToolCallComplete { id, .. } => {
                                    pending_tool_calls.remove(id);
                                }
                                StreamEvent::Done { .. } => {
                                    flush_pending_tool_calls(
                                        &app,
                                        &event_name,
                                        &mut pending_tool_calls,
                                    );
                                }
                                _ => {}
                            }

                            if matches!(&evt, StreamEvent::Done { .. }) {
                                emitted_done = true;
                            }
                            if let Err(e) = app.emit(&event_name, &evt) {
                                tracing::warn!(
                                    "Failed to emit stream event for {}: {}",
                                    stream_id,
                                    e
                                );
                                break 'stream_loop;
                            }
                        }
                    }
                }
                Ok(None) => {
                    // Stream ended. Flush any remaining buffer content.
                    if let Some(line) = line_buffer.flush() {
                        if !line.is_empty() {
                            let event = parse_line(&line);

                            if let Some(evt) = event {
                                match &evt {
                                    StreamEvent::ToolCallStart { id, name } => {
                                        pending_tool_calls
                                            .entry(id.clone())
                                            .and_modify(|entry| entry.0 = name.clone())
                                            .or_insert_with(|| (name.clone(), String::new()));
                                    }
                                    StreamEvent::ToolCallDelta { id, args_chunk } => {
                                        let entry = pending_tool_calls
                                            .entry(id.clone())
                                            .or_insert_with(|| (id.clone(), String::new()));
                                        entry.1.push_str(args_chunk);
                                    }
                                    StreamEvent::ToolCallComplete { id, .. } => {
                                        pending_tool_calls.remove(id);
                                    }
                                    StreamEvent::Done { .. } => {
                                        flush_pending_tool_calls(
                                            &app,
                                            &event_name,
                                            &mut pending_tool_calls,
                                        );
                                    }
                                    _ => {}
                                }

                                if matches!(&evt, StreamEvent::Done { .. }) {
                                    emitted_done = true;
                                }
                                let _ = app.emit(&event_name, &evt);
                            }
                        }
                    }

                    // Always emit a Done event if we haven't already
                    if !emitted_done {
                        flush_pending_tool_calls(&app, &event_name, &mut pending_tool_calls);
                        let _ = app.emit(
                            &event_name,
                            &StreamEvent::Done {
                                finish_reason: "stop".to_string(),
                                output_tokens: None,
                            },
                        );
                    }
                    break;
                }
                Err(e) => {
                    tracing::error!("Stream read error for {}: {}", stream_id, e);
                    let _ = app.emit(
                        &event_name,
                        &StreamEvent::Error {
                            message: format!("Stream read error: {}", e),
                        },
                    );
                    if !emitted_done {
                        let _ = app.emit(
                            &event_name,
                            &StreamEvent::Done {
                                finish_reason: "error".to_string(),
                                output_tokens: None,
                            },
                        );
                    }
                    break;
                }
            }
        }

        unregister_stream(&stream_id_for_task).await;
        tracing::debug!("AI stream {} completed", stream_id_for_task);
    });

    Ok(())
}

/// Aborts an active AI stream by stream ID.
#[cfg(feature = "ai-providers")]
#[tauri::command]
#[specta::specta]
pub async fn abort_ai_stream(stream_id: String) -> Result<(), String> {
    if let Some(cancel_tx) = take_stream_cancel_sender(&stream_id).await {
        let _ = cancel_tx.send(());
    }
    Ok(())
}

/// Stub implementation when the `ai-providers` feature is not enabled.
#[cfg(not(feature = "ai-providers"))]
#[tauri::command]
#[specta::specta]
pub async fn stream_ai_completion(
    _app: tauri::AppHandle,
    _stream_id: String,
    _messages: Vec<StreamMessage>,
    _system_prompt: Option<String>,
    _options: Option<StreamOptionsDto>,
    _tools: Option<Vec<StreamToolDefinition>>,
) -> Result<(), String> {
    Err("AI providers feature not enabled. Build with --features ai-providers".to_string())
}

/// Stub abort implementation when the `ai-providers` feature is not enabled.
#[cfg(not(feature = "ai-providers"))]
#[tauri::command]
#[specta::specta]
pub async fn abort_ai_stream(_stream_id: String) -> Result<(), String> {
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // SSE Line Parser Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_parse_sse_line_with_data() {
        let result = parse_sse_line("data: {\"key\": \"value\"}");
        assert_eq!(result, Some("{\"key\": \"value\"}"));
    }

    #[test]
    fn test_parse_sse_line_done_sentinel() {
        let result = parse_sse_line("data: [DONE]");
        assert_eq!(result, None);
    }

    #[test]
    fn test_parse_sse_line_empty_data() {
        let result = parse_sse_line("data: ");
        assert_eq!(result, Some(""));
    }

    #[test]
    fn test_parse_sse_line_not_data() {
        assert_eq!(parse_sse_line("event: message_start"), None);
        assert_eq!(parse_sse_line("id: 123"), None);
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line(": comment"), None);
        assert_eq!(parse_sse_line("retry: 5000"), None);
    }

    #[test]
    fn test_parse_sse_line_no_space_after_colon() {
        // "data:" without space is not valid SSE prefix "data: "
        let result = parse_sse_line("data:{\"key\": 1}");
        assert_eq!(result, None);
    }

    // -------------------------------------------------------------------------
    // SSE Line Buffer Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_line_buffer_single_complete_line() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.push(b"data: hello\n");
        assert_eq!(lines, vec!["data: hello"]);
    }

    #[test]
    fn test_line_buffer_multiple_lines() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.push(b"data: first\ndata: second\n");
        assert_eq!(lines, vec!["data: first", "data: second"]);
    }

    #[test]
    fn test_line_buffer_partial_line() {
        let mut buffer = SseLineBuffer::new();
        let lines1 = buffer.push(b"data: hel");
        assert!(lines1.is_empty());

        let lines2 = buffer.push(b"lo\n");
        assert_eq!(lines2, vec!["data: hello"]);
    }

    #[test]
    fn test_line_buffer_crlf() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.push(b"data: hello\r\n");
        assert_eq!(lines, vec!["data: hello"]);
    }

    #[test]
    fn test_line_buffer_empty_lines() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.push(b"data: hello\n\ndata: world\n");
        assert_eq!(lines, vec!["data: hello", "", "data: world"]);
    }

    #[test]
    fn test_line_buffer_flush_remaining() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.push(b"data: partial");
        assert!(lines.is_empty());

        let remaining = buffer.flush();
        assert_eq!(remaining, Some("data: partial".to_string()));
    }

    #[test]
    fn test_line_buffer_flush_empty() {
        let mut buffer = SseLineBuffer::new();
        assert_eq!(buffer.flush(), None);
    }

    #[test]
    fn test_line_buffer_flush_after_complete_line() {
        let mut buffer = SseLineBuffer::new();
        let _ = buffer.push(b"data: hello\n");
        assert_eq!(buffer.flush(), None);
    }

    #[test]
    fn test_line_buffer_multi_chunk_accumulation() {
        let mut buffer = SseLineBuffer::new();

        let lines1 = buffer.push(b"da");
        assert!(lines1.is_empty());

        let lines2 = buffer.push(b"ta: ");
        assert!(lines2.is_empty());

        let lines3 = buffer.push(b"hello\ndata: wor");
        assert_eq!(lines3, vec!["data: hello"]);

        let lines4 = buffer.push(b"ld\n");
        assert_eq!(lines4, vec!["data: world"]);
    }

    // -------------------------------------------------------------------------
    // Anthropic Event Parser Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_anthropic_text_delta() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "Hello");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_thinking_delta() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze..."}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::ReasoningDelta { content }) => {
                assert_eq!(content, "Let me analyze...");
            }
            other => panic!("Expected ReasoningDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_tool_call_start() {
        let data = r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"split_clip"}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::ToolCallStart { id, name }) => {
                assert_eq!(id, "tool_1");
                assert_eq!(name, "split_clip");
            }
            other => panic!("Expected ToolCallStart, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_tool_call_complete_with_inline_input() {
        let data = r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"trim_clip","input":{"clipId":"c1","time":3.5}}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::ToolCallComplete {
                id,
                name,
                args_json,
            }) => {
                assert_eq!(id, "tool_0");
                assert_eq!(name, "trim_clip");
                assert_eq!(args_json, "{\"clipId\":\"c1\",\"time\":3.5}");
            }
            other => panic!("Expected ToolCallComplete, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_input_json_delta() {
        let data = r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"time\":5.0}"}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::ToolCallDelta { id, args_chunk }) => {
                assert_eq!(id, "tool_1");
                assert_eq!(args_chunk, "{\"time\":5.0}");
            }
            other => panic!("Expected ToolCallDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_message_start_usage() {
        let data = r#"{"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20251015","usage":{"input_tokens":100,"output_tokens":0}}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            }) => {
                assert_eq!(input_tokens, 100);
                assert_eq!(output_tokens, 0);
            }
            other => panic!("Expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_message_delta_done() {
        let data = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::Done {
                finish_reason,
                output_tokens,
            }) => {
                assert_eq!(finish_reason, "end_turn");
                assert_eq!(output_tokens, Some(50));
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_error_event() {
        let data =
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Server overloaded"}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::Error { message }) => {
                assert_eq!(message, "Server overloaded");
            }
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn test_anthropic_ping_ignored() {
        let data = r#"{"type":"ping"}"#;
        let event = parse_anthropic_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_anthropic_content_block_stop_ignored() {
        let data = r#"{"type":"content_block_stop","index":0}"#;
        let event = parse_anthropic_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_anthropic_message_stop_ignored() {
        let data = r#"{"type":"message_stop"}"#;
        let event = parse_anthropic_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_anthropic_invalid_json() {
        let event = parse_anthropic_event("not valid json");
        assert!(event.is_none());
    }

    // -------------------------------------------------------------------------
    // OpenAI Event Parser Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_openai_text_delta() {
        let data = r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "Hello");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_finish_reason() {
        let data =
            r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::Done { finish_reason, .. }) => {
                assert_eq!(finish_reason, "stop");
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_finish_reason_length() {
        let data =
            r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::Done { finish_reason, .. }) => {
                assert_eq!(finish_reason, "length");
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_tool_call_start() {
        let data = r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"split_clip","arguments":""}}]},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::ToolCallStart { id, name }) => {
                assert_eq!(id, "call_abc");
                assert_eq!(name, "split_clip");
            }
            other => panic!("Expected ToolCallStart, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_tool_call_delta() {
        let data = r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"time\":"}}]},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::ToolCallDelta { id, args_chunk }) => {
                assert_eq!(id, "tool_0");
                assert_eq!(args_chunk, "{\"time\":");
            }
            other => panic!("Expected ToolCallDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_usage_event() {
        let data = r#"{"id":"chatcmpl-123","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":25,"total_tokens":75}}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            }) => {
                assert_eq!(input_tokens, 50);
                assert_eq!(output_tokens, 25);
            }
            other => panic!("Expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_role_only_delta_ignored() {
        let data = r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_openai_empty_content_ignored() {
        let data = r#"{"id":"chatcmpl-123","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_openai_invalid_json() {
        let event = parse_openai_event("not valid json");
        assert!(event.is_none());
    }

    // -------------------------------------------------------------------------
    // Gemini Event Parser Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_gemini_text_delta() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":"Hello world"}],"role":"model"},"index":0}]}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "Hello world");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_tool_call_complete() {
        let data = r#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"split_clip","args":{"clipId":"c1","time":5}}}],"role":"model"},"index":0}]}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::ToolCallComplete {
                id,
                name,
                args_json,
            }) => {
                assert_eq!(id, "tool_0");
                assert_eq!(name, "split_clip");
                assert_eq!(args_json, "{\"clipId\":\"c1\",\"time\":5}");
            }
            other => panic!("Expected ToolCallComplete, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_finish_reason_stop() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::Done { finish_reason, .. }) => {
                assert_eq!(finish_reason, "stop");
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_finish_with_text_returns_text_first() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":"Final chunk"}],"role":"model"},"finishReason":"STOP","index":0}]}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "Final chunk");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_safety_blocked() {
        let data = r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::Error { message }) => {
                assert!(message.contains("SAFETY"));
            }
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_usage_only() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"totalTokenCount":150}}"#;
        // Empty text with no finish reason -> should fall through to usage
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            }) => {
                assert_eq!(input_tokens, 100);
                assert_eq!(output_tokens, 50);
            }
            other => panic!("Expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_max_tokens_finish_reason() {
        let data = r#"{"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"MAX_TOKENS","index":0}]}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::Done { finish_reason, .. }) => {
                assert_eq!(finish_reason, "length");
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_invalid_json() {
        let event = parse_gemini_event("not valid json");
        assert!(event.is_none());
    }

    // -------------------------------------------------------------------------
    // Local (Ollama) Event Parser Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_local_text_response() {
        let data = r#"{"model":"llama3.2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"response":"Hello","done":false}"#;
        let event = parse_local_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "Hello");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_local_done_with_usage() {
        let data = r#"{"model":"llama3.2","done":true,"total_duration":1000,"prompt_eval_count":50,"eval_count":25}"#;
        let event = parse_local_event(data);
        match event {
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            }) => {
                assert_eq!(input_tokens, 50);
                assert_eq!(output_tokens, 25);
            }
            other => panic!("Expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn test_local_done_without_usage() {
        let data = r#"{"model":"llama3.2","done":true}"#;
        let event = parse_local_event(data);
        match event {
            Some(StreamEvent::Done { finish_reason, .. }) => {
                assert_eq!(finish_reason, "stop");
            }
            other => panic!("Expected Done, got {:?}", other),
        }
    }

    #[test]
    fn test_local_empty_response_ignored() {
        let data = r#"{"model":"llama3.2","response":"","done":false}"#;
        let event = parse_local_event(data);
        assert!(event.is_none());
    }

    #[test]
    fn test_local_invalid_json() {
        let event = parse_local_event("not valid json");
        assert!(event.is_none());
    }

    // -------------------------------------------------------------------------
    // StreamEvent Serialization Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_stream_event_text_delta_serialization() {
        let event = StreamEvent::TextDelta {
            content: "Hello".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"textDelta\""));
        assert!(json.contains("\"content\":\"Hello\""));
    }

    #[test]
    fn test_stream_event_done_serialization() {
        let event = StreamEvent::Done {
            finish_reason: "stop".to_string(),
            output_tokens: None,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"done\""));
        assert!(json.contains("\"finishReason\":\"stop\""));
        // output_tokens is skipped when None
        assert!(!json.contains("outputTokens"));
    }

    #[test]
    fn test_stream_event_done_with_output_tokens_serialization() {
        let event = StreamEvent::Done {
            finish_reason: "end_turn".to_string(),
            output_tokens: Some(42),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"done\""));
        assert!(json.contains("\"finishReason\":\"end_turn\""));
        assert!(json.contains("\"outputTokens\":42"));
    }

    #[test]
    fn test_stream_event_error_serialization() {
        let event = StreamEvent::Error {
            message: "Something went wrong".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"error\""));
        assert!(json.contains("\"message\":\"Something went wrong\""));
    }

    #[test]
    fn test_stream_event_usage_serialization() {
        let event = StreamEvent::Usage {
            input_tokens: 100,
            output_tokens: 50,
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"usage\""));
        assert!(json.contains("\"inputTokens\":100"));
        assert!(json.contains("\"outputTokens\":50"));
    }

    #[test]
    fn test_stream_event_reasoning_delta_serialization() {
        let event = StreamEvent::ReasoningDelta {
            content: "Thinking...".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"reasoningDelta\""));
        assert!(json.contains("\"content\":\"Thinking...\""));
    }

    #[test]
    fn test_stream_event_tool_call_start_serialization() {
        let event = StreamEvent::ToolCallStart {
            id: "call_123".to_string(),
            name: "split_clip".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"type\":\"toolCallStart\""));
        assert!(json.contains("\"id\":\"call_123\""));
        assert!(json.contains("\"name\":\"split_clip\""));
    }

    #[test]
    fn test_stream_event_deserialization_roundtrip() {
        let event = StreamEvent::TextDelta {
            content: "Hello world".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        let deserialized: StreamEvent = serde_json::from_str(&json).unwrap();
        match deserialized {
            StreamEvent::TextDelta { content } => {
                assert_eq!(content, "Hello world");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    // -------------------------------------------------------------------------
    // StreamOptionsDto Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_stream_options_serialization() {
        let opts = StreamOptionsDto {
            max_tokens: Some(1024),
            temperature: Some(0.7),
            model: Some("gpt-5.2".to_string()),
            json_mode: Some(true),
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"maxTokens\":1024"));
        assert!(json.contains("\"temperature\":0.7"));
        assert!(json.contains("\"model\":\"gpt-5.2\""));
        assert!(json.contains("\"jsonMode\":true"));
    }

    #[test]
    fn test_stream_options_all_none() {
        let opts = StreamOptionsDto {
            max_tokens: None,
            temperature: None,
            model: None,
            json_mode: None,
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"maxTokens\":null"));
    }

    // -------------------------------------------------------------------------
    // StreamMessage Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_stream_message_serialization() {
        let msg = StreamMessage {
            role: "user".to_string(),
            content: "Hello, how are you?".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"role\":\"user\""));
        assert!(json.contains("\"content\":\"Hello, how are you?\""));
    }

    // -------------------------------------------------------------------------
    // StreamingProviderConfig Tests
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn test_streaming_config_lifecycle() {
        // This test covers set, get, clear, and re-set in a single test
        // to avoid race conditions from parallel test execution on shared
        // global state.

        // 1. Set an initial config
        let config = StreamingProviderConfig {
            provider_type: ProviderType::OpenAI,
            api_key: "test-key".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-5.2".to_string(),
        };
        set_streaming_provider_config(config).await;

        let retrieved = get_streaming_config().await;
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.provider_type, ProviderType::OpenAI);
        assert_eq!(retrieved.api_key, "test-key");
        assert_eq!(retrieved.base_url, "https://api.openai.com/v1");
        assert_eq!(retrieved.model, "gpt-5.2");

        // 2. Clear the config
        clear_streaming_provider_config().await;
        let cleared = get_streaming_config().await;
        assert!(cleared.is_none());

        // 3. Re-set with a different provider
        let new_config = StreamingProviderConfig {
            provider_type: ProviderType::Gemini,
            api_key: "gemini-key".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            model: "gemini-3-flash-preview".to_string(),
        };
        set_streaming_provider_config(new_config).await;

        let retrieved = get_streaming_config().await;
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().provider_type, ProviderType::Gemini);
    }

    // -------------------------------------------------------------------------
    // Integration-Style Parser Tests (multi-line SSE streams)
    // -------------------------------------------------------------------------

    #[test]
    fn test_anthropic_full_stream_sequence() {
        let sse_lines = vec![
            r#"data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20251015","usage":{"input_tokens":25,"output_tokens":0}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}"#,
            r#"data: {"type":"message_stop"}"#,
        ];

        let mut events: Vec<StreamEvent> = Vec::new();
        for line in sse_lines {
            if let Some(data) = parse_sse_line(line) {
                if let Some(event) = parse_anthropic_event(data) {
                    events.push(event);
                }
            }
        }

        assert_eq!(events.len(), 4); // Usage, TextDelta, TextDelta, Done
        assert!(matches!(
            &events[0],
            StreamEvent::Usage {
                input_tokens: 25,
                output_tokens: 0
            }
        ));
        assert!(matches!(&events[1], StreamEvent::TextDelta { content } if content == "Hello"));
        assert!(matches!(&events[2], StreamEvent::TextDelta { content } if content == " world"));
        assert!(
            matches!(&events[3], StreamEvent::Done { finish_reason, output_tokens } if finish_reason == "end_turn" && *output_tokens == Some(10))
        );
    }

    #[test]
    fn test_openai_full_stream_sequence() {
        let sse_lines = vec![
            r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
            "data: [DONE]",
        ];

        let mut events: Vec<StreamEvent> = Vec::new();
        for line in sse_lines {
            if let Some(data) = parse_sse_line(line) {
                if let Some(event) = parse_openai_event(data) {
                    events.push(event);
                }
            }
        }

        assert_eq!(events.len(), 3); // TextDelta, TextDelta, Done
        assert!(matches!(&events[0], StreamEvent::TextDelta { content } if content == "Hello"));
        assert!(matches!(&events[1], StreamEvent::TextDelta { content } if content == " world"));
        assert!(
            matches!(&events[2], StreamEvent::Done { finish_reason, .. } if finish_reason == "stop")
        );
    }

    #[test]
    fn test_gemini_full_stream_sequence() {
        let sse_lines = vec![
            r#"data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"index":0}]}"#,
            r#"data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"},"index":0}]}"#,
            r#"data: {"candidates":[{"content":{"parts":[{"text":""}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5,"totalTokenCount":15}}"#,
        ];

        let mut events: Vec<StreamEvent> = Vec::new();
        for line in sse_lines {
            if let Some(data) = parse_sse_line(line) {
                if let Some(event) = parse_gemini_event(data) {
                    events.push(event);
                }
            }
        }

        assert_eq!(events.len(), 3); // TextDelta, TextDelta, Done
        assert!(matches!(&events[0], StreamEvent::TextDelta { content } if content == "Hello"));
        assert!(matches!(&events[1], StreamEvent::TextDelta { content } if content == " world"));
        assert!(
            matches!(&events[2], StreamEvent::Done { finish_reason, .. } if finish_reason == "stop")
        );
    }

    #[test]
    fn test_local_full_stream_sequence() {
        let lines = vec![
            r#"{"model":"llama3.2","response":"Hello","done":false}"#,
            r#"{"model":"llama3.2","response":" world","done":false}"#,
            r#"{"model":"llama3.2","done":true,"prompt_eval_count":20,"eval_count":10}"#,
        ];

        let mut events: Vec<StreamEvent> = Vec::new();
        for line in lines {
            if let Some(event) = parse_local_event(line) {
                events.push(event);
            }
        }

        assert_eq!(events.len(), 3); // TextDelta, TextDelta, Usage
        assert!(matches!(&events[0], StreamEvent::TextDelta { content } if content == "Hello"));
        assert!(matches!(&events[1], StreamEvent::TextDelta { content } if content == " world"));
        assert!(matches!(
            &events[2],
            StreamEvent::Usage {
                input_tokens: 20,
                output_tokens: 10
            }
        ));
    }

    // -------------------------------------------------------------------------
    // Edge Case Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_anthropic_unicode_content() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello \u00e9\u00e8\u00ea"}}"#;
        let event = parse_anthropic_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert!(content.contains('\u{00e9}')); // e with acute
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_openai_content_with_newlines() {
        let data = r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"line1\nline2"},"finish_reason":null}]}"#;
        let event = parse_openai_event(data);
        match event {
            Some(StreamEvent::TextDelta { content }) => {
                assert_eq!(content, "line1\nline2");
            }
            other => panic!("Expected TextDelta, got {:?}", other),
        }
    }

    #[test]
    fn test_gemini_no_candidates() {
        let data = r#"{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":0,"totalTokenCount":10}}"#;
        let event = parse_gemini_event(data);
        match event {
            Some(StreamEvent::Usage {
                input_tokens,
                output_tokens,
            }) => {
                assert_eq!(input_tokens, 10);
                assert_eq!(output_tokens, 0);
            }
            other => panic!("Expected Usage, got {:?}", other),
        }
    }
}
