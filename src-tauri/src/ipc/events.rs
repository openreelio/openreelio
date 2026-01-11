//! Tauri Event Emission Module
//!
//! Handles broadcasting state changes to the frontend via Tauri's event system.
//! Events are emitted after successful command execution to keep the UI in sync.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::core::commands::{CommandResult, StateChange};

// =============================================================================
// Event Types
// =============================================================================

/// Event names used for frontend communication
pub mod event_names {
    /// State changed event (generic)
    pub const STATE_CHANGED: &str = "state:changed";
    /// Project opened event
    pub const PROJECT_OPENED: &str = "project:opened";
    /// Project closed event
    pub const PROJECT_CLOSED: &str = "project:closed";
    /// Project saved event
    pub const PROJECT_SAVED: &str = "project:saved";
    /// Asset added event
    pub const ASSET_ADDED: &str = "asset:added";
    /// Asset removed event
    pub const ASSET_REMOVED: &str = "asset:removed";
    /// Clip created event
    pub const CLIP_CREATED: &str = "clip:created";
    /// Clip modified event
    pub const CLIP_MODIFIED: &str = "clip:modified";
    /// Clip deleted event
    pub const CLIP_DELETED: &str = "clip:deleted";
    /// Track created event
    pub const TRACK_CREATED: &str = "track:created";
    /// Track modified event
    pub const TRACK_MODIFIED: &str = "track:modified";
    /// Track deleted event
    pub const TRACK_DELETED: &str = "track:deleted";
    /// Sequence created event
    pub const SEQUENCE_CREATED: &str = "sequence:created";
    /// Sequence modified event
    pub const SEQUENCE_MODIFIED: &str = "sequence:modified";
    /// Undo/Redo state changed event
    pub const HISTORY_CHANGED: &str = "history:changed";
    /// Playback state changed event
    pub const PLAYBACK_CHANGED: &str = "playback:changed";
    /// Job progress event
    pub const JOB_PROGRESS: &str = "job:progress";
    /// Job completed event
    pub const JOB_COMPLETED: &str = "job:completed";
    /// Job failed event
    pub const JOB_FAILED: &str = "job:failed";
}

// =============================================================================
// Event Payloads
// =============================================================================

/// Generic state change event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateChangedEvent {
    /// Operation ID that caused the change
    pub op_id: String,
    /// List of state changes
    pub changes: Vec<StateChange>,
    /// Created entity IDs
    pub created_ids: Vec<String>,
    /// Deleted entity IDs
    pub deleted_ids: Vec<String>,
}

impl From<&CommandResult> for StateChangedEvent {
    fn from(result: &CommandResult) -> Self {
        Self {
            op_id: result.op_id.clone(),
            changes: result.changes.clone(),
            created_ids: result.created_ids.clone(),
            deleted_ids: result.deleted_ids.clone(),
        }
    }
}

/// Project opened event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpenedEvent {
    /// Project name
    pub name: String,
    /// Project path
    pub path: String,
}

/// Project saved event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSavedEvent {
    /// Project path
    pub path: String,
    /// Timestamp
    pub timestamp: String,
}

/// Asset event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEvent {
    /// Asset ID
    pub asset_id: String,
}

/// Clip event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEvent {
    /// Clip ID
    pub clip_id: String,
    /// Sequence ID
    pub sequence_id: Option<String>,
    /// Track ID
    pub track_id: Option<String>,
}

/// Track event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEvent {
    /// Track ID
    pub track_id: String,
    /// Sequence ID
    pub sequence_id: Option<String>,
}

/// History (undo/redo) state event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChangedEvent {
    /// Whether undo is available
    pub can_undo: bool,
    /// Whether redo is available
    pub can_redo: bool,
    /// Number of operations in undo stack
    pub undo_count: usize,
    /// Number of operations in redo stack
    pub redo_count: usize,
}

/// Job progress event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    /// Job ID
    pub job_id: String,
    /// Progress percentage (0-100)
    pub progress: f32,
    /// Current status message
    pub message: Option<String>,
}

/// Job completed event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCompletedEvent {
    /// Job ID
    pub job_id: String,
    /// Result data (job-specific)
    pub result: Option<serde_json::Value>,
}

/// Job failed event payload
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailedEvent {
    /// Job ID
    pub job_id: String,
    /// Error message
    pub error: String,
}

// =============================================================================
// Event Emitter
// =============================================================================

/// Event emitter for broadcasting state changes
pub struct EventEmitter;

impl EventEmitter {
    /// Emits a state changed event based on command result
    pub fn emit_state_changed(app: &AppHandle, result: &CommandResult) -> Result<(), String> {
        let event = StateChangedEvent::from(result);
        app.emit(event_names::STATE_CHANGED, &event)
            .map_err(|e| format!("Failed to emit state changed event: {}", e))
    }

    /// Emits individual change events for each state change
    pub fn emit_changes(app: &AppHandle, result: &CommandResult) -> Result<(), String> {
        for change in &result.changes {
            match change {
                StateChange::AssetAdded { asset_id } => {
                    let event = AssetEvent {
                        asset_id: asset_id.clone(),
                    };
                    app.emit(event_names::ASSET_ADDED, &event)
                        .map_err(|e| format!("Failed to emit asset added event: {}", e))?;
                }
                StateChange::AssetRemoved { asset_id } => {
                    let event = AssetEvent {
                        asset_id: asset_id.clone(),
                    };
                    app.emit(event_names::ASSET_REMOVED, &event)
                        .map_err(|e| format!("Failed to emit asset removed event: {}", e))?;
                }
                StateChange::ClipCreated { clip_id } => {
                    let event = ClipEvent {
                        clip_id: clip_id.clone(),
                        sequence_id: None,
                        track_id: None,
                    };
                    app.emit(event_names::CLIP_CREATED, &event)
                        .map_err(|e| format!("Failed to emit clip created event: {}", e))?;
                }
                StateChange::ClipModified { clip_id } => {
                    let event = ClipEvent {
                        clip_id: clip_id.clone(),
                        sequence_id: None,
                        track_id: None,
                    };
                    app.emit(event_names::CLIP_MODIFIED, &event)
                        .map_err(|e| format!("Failed to emit clip modified event: {}", e))?;
                }
                StateChange::ClipDeleted { clip_id } => {
                    let event = ClipEvent {
                        clip_id: clip_id.clone(),
                        sequence_id: None,
                        track_id: None,
                    };
                    app.emit(event_names::CLIP_DELETED, &event)
                        .map_err(|e| format!("Failed to emit clip deleted event: {}", e))?;
                }
                StateChange::TrackCreated { track_id } => {
                    let event = TrackEvent {
                        track_id: track_id.clone(),
                        sequence_id: None,
                    };
                    app.emit(event_names::TRACK_CREATED, &event)
                        .map_err(|e| format!("Failed to emit track created event: {}", e))?;
                }
                StateChange::TrackModified { track_id } => {
                    let event = TrackEvent {
                        track_id: track_id.clone(),
                        sequence_id: None,
                    };
                    app.emit(event_names::TRACK_MODIFIED, &event)
                        .map_err(|e| format!("Failed to emit track modified event: {}", e))?;
                }
                StateChange::TrackDeleted { track_id } => {
                    let event = TrackEvent {
                        track_id: track_id.clone(),
                        sequence_id: None,
                    };
                    app.emit(event_names::TRACK_DELETED, &event)
                        .map_err(|e| format!("Failed to emit track deleted event: {}", e))?;
                }
                StateChange::SequenceCreated { sequence_id } => {
                    app.emit(
                        event_names::SEQUENCE_CREATED,
                        &serde_json::json!({ "sequenceId": sequence_id }),
                    )
                    .map_err(|e| format!("Failed to emit sequence created event: {}", e))?;
                }
                StateChange::SequenceModified { sequence_id } => {
                    app.emit(
                        event_names::SEQUENCE_MODIFIED,
                        &serde_json::json!({ "sequenceId": sequence_id }),
                    )
                    .map_err(|e| format!("Failed to emit sequence modified event: {}", e))?;
                }
                StateChange::CaptionCreated { caption_id } => {
                    app.emit(
                        "caption:created",
                        &serde_json::json!({ "captionId": caption_id }),
                    )
                    .map_err(|e| format!("Failed to emit caption created event: {}", e))?;
                }
                StateChange::CaptionModified { caption_id } => {
                    app.emit(
                        "caption:modified",
                        &serde_json::json!({ "captionId": caption_id }),
                    )
                    .map_err(|e| format!("Failed to emit caption modified event: {}", e))?;
                }
                StateChange::CaptionDeleted { caption_id } => {
                    app.emit(
                        "caption:deleted",
                        &serde_json::json!({ "captionId": caption_id }),
                    )
                    .map_err(|e| format!("Failed to emit caption deleted event: {}", e))?;
                }
                StateChange::EffectApplied { effect_id } => {
                    app.emit(
                        "effect:applied",
                        &serde_json::json!({ "effectId": effect_id }),
                    )
                    .map_err(|e| format!("Failed to emit effect applied event: {}", e))?;
                }
                StateChange::EffectRemoved { effect_id } => {
                    app.emit(
                        "effect:removed",
                        &serde_json::json!({ "effectId": effect_id }),
                    )
                    .map_err(|e| format!("Failed to emit effect removed event: {}", e))?;
                }
            }
        }
        Ok(())
    }

    /// Emits a project opened event
    pub fn emit_project_opened(
        app: &AppHandle,
        name: &str,
        path: &str,
    ) -> Result<(), String> {
        let event = ProjectOpenedEvent {
            name: name.to_string(),
            path: path.to_string(),
        };
        app.emit(event_names::PROJECT_OPENED, &event)
            .map_err(|e| format!("Failed to emit project opened event: {}", e))
    }

    /// Emits a project closed event
    pub fn emit_project_closed(app: &AppHandle) -> Result<(), String> {
        app.emit(event_names::PROJECT_CLOSED, &())
            .map_err(|e| format!("Failed to emit project closed event: {}", e))
    }

    /// Emits a project saved event
    pub fn emit_project_saved(app: &AppHandle, path: &str) -> Result<(), String> {
        let event = ProjectSavedEvent {
            path: path.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        app.emit(event_names::PROJECT_SAVED, &event)
            .map_err(|e| format!("Failed to emit project saved event: {}", e))
    }

    /// Emits a history changed event
    pub fn emit_history_changed(
        app: &AppHandle,
        can_undo: bool,
        can_redo: bool,
        undo_count: usize,
        redo_count: usize,
    ) -> Result<(), String> {
        let event = HistoryChangedEvent {
            can_undo,
            can_redo,
            undo_count,
            redo_count,
        };
        app.emit(event_names::HISTORY_CHANGED, &event)
            .map_err(|e| format!("Failed to emit history changed event: {}", e))
    }

    /// Emits a job progress event
    pub fn emit_job_progress(
        app: &AppHandle,
        job_id: &str,
        progress: f32,
        message: Option<&str>,
    ) -> Result<(), String> {
        let event = JobProgressEvent {
            job_id: job_id.to_string(),
            progress,
            message: message.map(|s| s.to_string()),
        };
        app.emit(event_names::JOB_PROGRESS, &event)
            .map_err(|e| format!("Failed to emit job progress event: {}", e))
    }

    /// Emits a job completed event
    pub fn emit_job_completed(
        app: &AppHandle,
        job_id: &str,
        result: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let event = JobCompletedEvent {
            job_id: job_id.to_string(),
            result,
        };
        app.emit(event_names::JOB_COMPLETED, &event)
            .map_err(|e| format!("Failed to emit job completed event: {}", e))
    }

    /// Emits a job failed event
    pub fn emit_job_failed(
        app: &AppHandle,
        job_id: &str,
        error: &str,
    ) -> Result<(), String> {
        let event = JobFailedEvent {
            job_id: job_id.to_string(),
            error: error.to_string(),
        };
        app.emit(event_names::JOB_FAILED, &event)
            .map_err(|e| format!("Failed to emit job failed event: {}", e))
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_changed_event_from_result() {
        let result = CommandResult::new("op_001")
            .with_change(StateChange::ClipCreated {
                clip_id: "clip_001".to_string(),
            })
            .with_created_id("clip_001");

        let event = StateChangedEvent::from(&result);

        assert_eq!(event.op_id, "op_001");
        assert_eq!(event.changes.len(), 1);
        assert_eq!(event.created_ids.len(), 1);
        assert_eq!(event.created_ids[0], "clip_001");
    }

    #[test]
    fn test_event_serialization() {
        let event = ProjectOpenedEvent {
            name: "Test Project".to_string(),
            path: "/path/to/project".to_string(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("Test Project"));
        assert!(json.contains("/path/to/project"));
    }

    #[test]
    fn test_history_changed_event() {
        let event = HistoryChangedEvent {
            can_undo: true,
            can_redo: false,
            undo_count: 5,
            redo_count: 0,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("canUndo"));
        assert!(json.contains("undoCount"));
    }

    #[test]
    fn test_job_progress_event() {
        let event = JobProgressEvent {
            job_id: "job_001".to_string(),
            progress: 75.5,
            message: Some("Rendering frame 150/200".to_string()),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("job_001"));
        assert!(json.contains("75.5"));
        assert!(json.contains("Rendering frame"));
    }
}
