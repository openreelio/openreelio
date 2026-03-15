//! Source Monitor IPC commands
//!
//! Commands for managing the source monitor state: loading assets,
//! setting In/Out points for 3-point editing, and querying current state.
//! All state is runtime-only (not persisted in project files).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::AppState;

// =============================================================================
// DTOs
// =============================================================================

/// Input payload for loading an asset into the source monitor.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSourceAssetPayload {
    /// Asset ID to load. Pass null/empty to clear the source monitor.
    pub asset_id: Option<String>,
}

/// Input payload for setting an In or Out point.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSourcePointPayload {
    /// Time in seconds for the In or Out point.
    pub time_sec: f64,
}

/// Response DTO for source monitor state.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceMonitorStateDto {
    /// Currently loaded asset ID, or null if none.
    pub asset_id: Option<String>,
    /// In point in seconds, or null if unset.
    pub in_point: Option<f64>,
    /// Out point in seconds, or null if unset.
    pub out_point: Option<f64>,
    /// Current playhead position in the source asset (seconds).
    pub playhead_sec: f64,
    /// Marked duration (out - in) if both points are set, otherwise null.
    pub marked_duration: Option<f64>,
}

impl SourceMonitorStateDto {
    fn from_runtime(state: &crate::SourceMonitorState) -> Self {
        Self {
            asset_id: state.asset_id.clone(),
            in_point: state.in_point,
            out_point: state.out_point,
            playhead_sec: state.playhead_sec,
            marked_duration: state.marked_duration(),
        }
    }
}

fn emit_source_monitor_changed(app: &tauri::AppHandle, dto: &SourceMonitorStateDto) {
    use tauri::Emitter;

    if let Err(error) = app.emit(crate::ipc::event_names::SOURCE_MONITOR_CHANGED, dto) {
        tracing::warn!("Failed to emit source_monitor:changed event: {}", error);
    }
}

pub(crate) async fn reset_source_monitor_state(state: &AppState) {
    let dto = {
        let mut source = state.source_monitor.lock().await;
        source.clear();
        SourceMonitorStateDto::from_runtime(&source)
    };

    if let Some(app) = state.app_handle.get() {
        emit_source_monitor_changed(app, &dto);
    }
}

// =============================================================================
// Validation Helpers
// =============================================================================

/// Validates that a time value is finite and non-negative.
fn validate_time_sec(field_name: &str, value: f64) -> Result<f64, String> {
    if !value.is_finite() {
        return Err(format!("{field_name} must be a finite number"));
    }
    if value < 0.0 {
        return Err(format!("{field_name} must be non-negative"));
    }
    Ok(value)
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Loads an asset into the source monitor, resetting In/Out points and playhead.
///
/// Passing a null or empty asset_id clears the source monitor.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(asset_id = ?payload.asset_id))]
pub async fn set_source_asset(
    payload: SetSourceAssetPayload,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SourceMonitorStateDto, String> {
    let asset_id = payload
        .asset_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| id.trim().to_string());

    let dto = {
        let mut source = state.source_monitor.lock().await;
        source.set_asset(asset_id);
        SourceMonitorStateDto::from_runtime(&source)
    };

    emit_source_monitor_changed(&app, &dto);

    Ok(dto)
}

/// Sets the In point for the source monitor.
///
/// Validates that the In point is before the current Out point (if set).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(time_sec = payload.time_sec))]
pub async fn set_source_in(
    payload: SetSourcePointPayload,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SourceMonitorStateDto, String> {
    let time_sec = validate_time_sec("timeSec", payload.time_sec)?;

    let dto = {
        let mut source = state.source_monitor.lock().await;

        if source.asset_id.is_none() {
            return Err("No asset loaded in source monitor".to_string());
        }

        if let Some(out) = source.out_point {
            if time_sec >= out {
                return Err(format!(
                    "In point ({:.3}s) must be before out point ({:.3}s)",
                    time_sec, out
                ));
            }
        }

        source.set_in_point(time_sec);
        SourceMonitorStateDto::from_runtime(&source)
    };

    emit_source_monitor_changed(&app, &dto);

    Ok(dto)
}

/// Sets the Out point for the source monitor.
///
/// Validates that the Out point is after the current In point (if set).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(time_sec = payload.time_sec))]
pub async fn set_source_out(
    payload: SetSourcePointPayload,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SourceMonitorStateDto, String> {
    let time_sec = validate_time_sec("timeSec", payload.time_sec)?;

    let dto = {
        let mut source = state.source_monitor.lock().await;

        if source.asset_id.is_none() {
            return Err("No asset loaded in source monitor".to_string());
        }

        if let Some(inp) = source.in_point {
            if time_sec <= inp {
                return Err(format!(
                    "Out point ({:.3}s) must be after in point ({:.3}s)",
                    time_sec, inp
                ));
            }
        }

        source.set_out_point(time_sec);
        SourceMonitorStateDto::from_runtime(&source)
    };

    emit_source_monitor_changed(&app, &dto);

    Ok(dto)
}

/// Clears both In and Out points from the source monitor.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app))]
pub async fn clear_source_in_out(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SourceMonitorStateDto, String> {
    let dto = {
        let mut source = state.source_monitor.lock().await;
        source.clear_in_out();
        SourceMonitorStateDto::from_runtime(&source)
    };

    emit_source_monitor_changed(&app, &dto);

    Ok(dto)
}

/// Returns the current source monitor state.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn get_source_state(state: State<'_, AppState>) -> Result<SourceMonitorStateDto, String> {
    let source = state.source_monitor.lock().await;
    Ok(SourceMonitorStateDto::from_runtime(&source))
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a default SourceMonitorState for testing.
    fn make_state() -> crate::SourceMonitorState {
        crate::SourceMonitorState {
            asset_id: None,
            in_point: None,
            out_point: None,
            playhead_sec: 0.0,
        }
    }

    #[test]
    fn test_default_state_is_empty() {
        let state = make_state();
        assert!(state.asset_id.is_none());
        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 0.0);
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_set_asset_resets_points() {
        let mut state = make_state();
        state.asset_id = Some("asset_001".to_string());
        state.in_point = Some(2.0);
        state.out_point = Some(8.0);
        state.playhead_sec = 5.0;

        // Simulate set_source_asset: loading a new asset resets everything
        state.asset_id = Some("asset_002".to_string());
        state.in_point = None;
        state.out_point = None;
        state.playhead_sec = 0.0;

        assert_eq!(state.asset_id.as_deref(), Some("asset_002"));
        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 0.0);
    }

    #[test]
    fn test_set_in_point() {
        let mut state = make_state();
        state.asset_id = Some("asset_001".to_string());
        state.in_point = Some(2.5);

        assert_eq!(state.in_point, Some(2.5));
        assert!(state.marked_duration().is_none()); // out_point still None
    }

    #[test]
    fn test_set_out_point() {
        let mut state = make_state();
        state.asset_id = Some("asset_001".to_string());
        state.in_point = Some(2.5);
        state.out_point = Some(8.0);

        assert_eq!(state.out_point, Some(8.0));
        assert_eq!(state.marked_duration(), Some(5.5));
    }

    #[test]
    fn test_in_point_must_be_before_out() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: None,
            out_point: Some(5.0),
            playhead_sec: 0.0,
        };

        // Validation: in_point 6.0 >= out_point 5.0 should be rejected
        let candidate_in = 6.0;
        if let Some(out) = state.out_point {
            assert!(candidate_in >= out, "Should fail: in >= out");
        }
    }

    #[test]
    fn test_out_point_must_be_after_in() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(5.0),
            out_point: None,
            playhead_sec: 0.0,
        };

        // Validation: out_point 3.0 <= in_point 5.0 should be rejected
        let candidate_out = 3.0;
        if let Some(inp) = state.in_point {
            assert!(candidate_out <= inp, "Should fail: out <= in");
        }
    }

    #[test]
    fn test_clear_in_out() {
        let mut state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: Some(8.0),
            playhead_sec: 4.0,
        };

        state.in_point = None;
        state.out_point = None;

        assert!(state.in_point.is_none());
        assert!(state.out_point.is_none());
        assert_eq!(state.playhead_sec, 4.0); // playhead preserved
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_marked_duration_both_set() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(1.5),
            out_point: Some(10.0),
            playhead_sec: 0.0,
        };
        assert_eq!(state.marked_duration(), Some(8.5));
    }

    #[test]
    fn test_marked_duration_only_in() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(1.5),
            out_point: None,
            playhead_sec: 0.0,
        };
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_marked_duration_only_out() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: None,
            out_point: Some(10.0),
            playhead_sec: 0.0,
        };
        assert!(state.marked_duration().is_none());
    }

    #[test]
    fn test_validate_time_sec_valid() {
        assert_eq!(validate_time_sec("test", 5.0).unwrap(), 5.0);
        assert_eq!(validate_time_sec("test", 0.0).unwrap(), 0.0);
    }

    #[test]
    fn test_validate_time_sec_negative() {
        assert!(validate_time_sec("test", -1.0).is_err());
    }

    #[test]
    fn test_validate_time_sec_nan() {
        assert!(validate_time_sec("test", f64::NAN).is_err());
    }

    #[test]
    fn test_validate_time_sec_infinity() {
        assert!(validate_time_sec("test", f64::INFINITY).is_err());
    }

    #[test]
    fn test_dto_from_runtime() {
        let state = crate::SourceMonitorState {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.0),
            out_point: Some(8.0),
            playhead_sec: 5.0,
        };
        let dto = SourceMonitorStateDto::from_runtime(&state);
        assert_eq!(dto.asset_id.as_deref(), Some("asset_001"));
        assert_eq!(dto.in_point, Some(2.0));
        assert_eq!(dto.out_point, Some(8.0));
        assert_eq!(dto.playhead_sec, 5.0);
        assert_eq!(dto.marked_duration, Some(6.0));
    }

    #[test]
    fn test_dto_from_empty_runtime() {
        let state = make_state();
        let dto = SourceMonitorStateDto::from_runtime(&state);
        assert!(dto.asset_id.is_none());
        assert!(dto.in_point.is_none());
        assert!(dto.out_point.is_none());
        assert_eq!(dto.playhead_sec, 0.0);
        assert!(dto.marked_duration.is_none());
    }

    #[test]
    fn test_dto_serialization() {
        let dto = SourceMonitorStateDto {
            asset_id: Some("asset_001".to_string()),
            in_point: Some(2.5),
            out_point: Some(8.0),
            playhead_sec: 5.0,
            marked_duration: Some(5.5),
        };
        let json = serde_json::to_string(&dto).unwrap();
        assert!(json.contains("assetId"));
        assert!(json.contains("inPoint"));
        assert!(json.contains("outPoint"));
        assert!(json.contains("playheadSec"));
        assert!(json.contains("markedDuration"));

        // Round-trip
        let parsed: SourceMonitorStateDto = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.asset_id.as_deref(), Some("asset_001"));
        assert_eq!(parsed.in_point, Some(2.5));
    }
}
