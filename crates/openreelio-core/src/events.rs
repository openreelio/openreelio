//! Event Broadcasting Abstraction
//!
//! Decouples the core engine from Tauri's event system. In the GUI app,
//! events are emitted to the WebView frontend. In CLI mode, events can
//! be logged, sent to a channel, or silently discarded.

use serde_json::Value;

/// Trait for broadcasting events to listeners (frontend, CLI, tests).
///
/// The core engine emits events for progress updates, state changes,
/// and notifications. The concrete implementation determines how these
/// events are delivered.
pub trait EventBroadcaster: Send + Sync {
    /// Emit an event with a JSON payload.
    ///
    /// Implementations should handle errors gracefully (log and continue)
    /// rather than propagating them — event delivery failure should not
    /// abort the operation that triggered the event.
    fn emit(&self, event: &str, payload: Value);
}

/// No-op broadcaster that silently discards all events.
///
/// Used for CLI operations where event feedback is unnecessary,
/// and for unit tests that don't need event verification.
pub struct NullBroadcaster;

impl EventBroadcaster for NullBroadcaster {
    fn emit(&self, _event: &str, _payload: Value) {
        // Intentionally empty — events are silently discarded
    }
}

/// Channel-based broadcaster for asynchronous event consumption.
///
/// Events are sent to an unbounded MPSC channel. The receiver can
/// process events in a separate task (e.g., for CLI progress bars
/// or structured logging output).
pub struct ChannelBroadcaster {
    tx: tokio::sync::mpsc::UnboundedSender<(String, Value)>,
}

impl ChannelBroadcaster {
    /// Creates a new channel broadcaster and returns the receiver end.
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<(String, Value)>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Self { tx }, rx)
    }
}

impl EventBroadcaster for ChannelBroadcaster {
    fn emit(&self, event: &str, payload: Value) {
        if let Err(e) = self.tx.send((event.to_string(), payload)) {
            tracing::warn!("Failed to send event '{}': {}", event, e);
        }
    }
}

/// Logging broadcaster that writes events to the tracing log.
///
/// Useful for CLI mode where events should appear in structured logs
/// rather than being sent to a UI.
pub struct LogBroadcaster;

impl EventBroadcaster for LogBroadcaster {
    fn emit(&self, event: &str, payload: Value) {
        tracing::info!(event = %event, payload = %payload, "event emitted");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_broadcaster_does_not_panic() {
        let broadcaster = NullBroadcaster;
        broadcaster.emit("test_event", serde_json::json!({"key": "value"}));
    }

    #[test]
    fn channel_broadcaster_delivers_events() {
        let (broadcaster, mut rx) = ChannelBroadcaster::new();
        broadcaster.emit("test_event", serde_json::json!({"key": "value"}));

        let (event, payload) = rx.try_recv().unwrap();
        assert_eq!(event, "test_event");
        assert_eq!(payload, serde_json::json!({"key": "value"}));
    }

    #[test]
    fn log_broadcaster_does_not_panic() {
        let broadcaster = LogBroadcaster;
        broadcaster.emit("test_event", serde_json::json!({"key": "value"}));
    }
}
