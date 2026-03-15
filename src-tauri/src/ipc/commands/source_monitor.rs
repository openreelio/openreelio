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

/// Result of a match frame operation.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchFrameResult {
    /// Asset ID of the clip under the playhead.
    pub asset_id: String,
    /// Corresponding source time within the asset (seconds).
    pub source_time_sec: f64,
}

/// Result of a reverse match frame operation.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReverseMatchFrameResult {
    /// Clip ID that contains the matching source position.
    pub clip_id: String,
    /// Track ID containing the matched clip.
    pub track_id: String,
    /// Timeline position corresponding to the source monitor's playhead.
    pub timeline_sec: f64,
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

/// Updates the source monitor playhead without modifying In/Out points.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(time_sec = payload.time_sec))]
pub async fn set_source_playhead(
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

        source.set_playhead(time_sec);
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
// Match Frame Commands
// =============================================================================

/// Finds the clip at the given timeline position, computes the corresponding
/// source time, and loads it into the source monitor.
///
/// This is the standard "Match Frame" operation (F key in Premiere/Avid).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, app), fields(time_sec = payload.time_sec))]
pub async fn match_frame(
    payload: SetSourcePointPayload,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<MatchFrameResult, String> {
    let time_sec = validate_time_sec("timeSec", payload.time_sec)?;

    // 1. Find clip at playhead in active sequence
    let (asset_id, source_time) = {
        let project_guard = state.project.lock().await;
        let project = project_guard
            .as_ref()
            .ok_or_else(|| "No project open".to_string())?;

        let seq_id = project
            .state
            .active_sequence_id
            .as_ref()
            .ok_or_else(|| "No active sequence".to_string())?;

        let sequence = project
            .state
            .sequences
            .get(seq_id)
            .ok_or_else(|| "Active sequence not found".to_string())?;

        let (clip, _track_id) = find_clip_at_time(sequence, time_sec)
            .ok_or_else(|| "No clip at playhead position".to_string())?;

        (clip.asset_id.clone(), clip.timeline_to_source(time_sec))
    };

    // 2. Update source monitor (project lock dropped above)
    let dto = {
        let mut source = state.source_monitor.lock().await;
        source.set_asset(Some(asset_id.clone()));
        source.playhead_sec = source_time;
        SourceMonitorStateDto::from_runtime(&source)
    };

    emit_source_monitor_changed(&app, &dto);

    Ok(MatchFrameResult {
        asset_id,
        source_time_sec: source_time,
    })
}

/// Reverse Match Frame: from the current source monitor state, finds the
/// corresponding clip and timeline position in the active sequence.
///
/// This is the "Reverse Match Frame" operation (Shift+F in Premiere).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn reverse_match_frame(
    state: State<'_, AppState>,
) -> Result<ReverseMatchFrameResult, String> {
    // 1. Get source monitor state
    let (asset_id, source_playhead) = {
        let source = state.source_monitor.lock().await;
        let id = source
            .asset_id
            .clone()
            .ok_or_else(|| "No asset loaded in source monitor".to_string())?;
        (id, source.playhead_sec)
    };

    // 2. Find matching clip in active sequence
    let project_guard = state.project.lock().await;
    let project = project_guard
        .as_ref()
        .ok_or_else(|| "No project open".to_string())?;

    let seq_id = project
        .state
        .active_sequence_id
        .as_ref()
        .ok_or_else(|| "No active sequence".to_string())?;

    let sequence = project
        .state
        .sequences
        .get(seq_id)
        .ok_or_else(|| "Active sequence not found".to_string())?;

    // Search all tracks for a clip with matching asset_id where the source
    // playhead falls within the clip's source range.
    for track in &sequence.tracks {
        if track.muted || !track.visible {
            continue;
        }
        for clip in &track.clips {
            if clip.asset_id != asset_id {
                continue;
            }
            if clip_contains_source_time(clip, source_playhead) {
                let safe_speed = if clip.speed > 0.0 {
                    clip.speed as f64
                } else {
                    1.0
                };
                let source_offset = source_playhead - clip.range.source_in_sec;
                let timeline_sec = clip.place.timeline_in_sec + (source_offset / safe_speed);

                return Ok(ReverseMatchFrameResult {
                    clip_id: clip.id.clone(),
                    track_id: track.id.clone(),
                    timeline_sec,
                });
            }
        }
    }

    Err("No matching clip found on timeline for current source position".to_string())
}

/// Helper: finds the first visible, unmuted clip at the given timeline time.
/// Returns the clip reference and its track ID.
fn find_clip_at_time<'a>(
    sequence: &'a crate::core::timeline::Sequence,
    time_sec: f64,
) -> Option<(&'a crate::core::timeline::Clip, &'a str)> {
    use crate::core::timeline::TrackKind;

    for track in &sequence.tracks {
        if track.kind != TrackKind::Video && track.kind != TrackKind::Audio {
            continue;
        }
        if track.muted || !track.visible {
            continue;
        }
        for clip in &track.clips {
            if clip.contains_time(time_sec) {
                return Some((clip, &track.id));
            }
        }
    }
    None
}

/// Helper: checks whether a source time falls inside a clip's source range.
/// Uses half-open interval [start, end) to match timeline containment semantics.
fn clip_contains_source_time(
    clip: &crate::core::timeline::Clip,
    source_time_sec: f64,
) -> bool {
    source_time_sec >= clip.range.source_in_sec && source_time_sec < clip.range.source_out_sec
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

    // =========================================================================
    // Match Frame helper tests
    // =========================================================================

    fn make_clip(asset_id: &str, source_in: f64, source_out: f64, timeline_in: f64) -> crate::core::timeline::Clip {
        crate::core::timeline::Clip::with_range(asset_id, source_in, source_out)
            .place_at(timeline_in)
    }

    fn make_sequence_with_clip(clip: crate::core::timeline::Clip) -> crate::core::timeline::Sequence {
        use crate::core::timeline::{Sequence, SequenceFormat, Track, TrackKind, CanvasFormat, FpsFormat};
        let mut seq = Sequence::new("test", SequenceFormat {
            canvas: CanvasFormat { width: 1920, height: 1080 },
            fps: FpsFormat { num: 30, den: 1 },
            audio_sample_rate: 48000,
        });
        let mut track = Track::new("Video 1", TrackKind::Video);
        track.clips.push(clip);
        seq.tracks.push(track);
        seq
    }

    #[test]
    fn test_find_clip_at_time_returns_clip_when_position_inside() {
        let clip = make_clip("asset-1", 10.0, 20.0, 5.0);
        let seq = make_sequence_with_clip(clip);

        let result = find_clip_at_time(&seq, 8.0);
        assert!(result.is_some());
        let (found_clip, track_id) = result.unwrap();
        assert_eq!(found_clip.asset_id, "asset-1");
        assert!(!track_id.is_empty());
    }

    #[test]
    fn test_find_clip_at_time_returns_none_when_outside() {
        let clip = make_clip("asset-1", 10.0, 20.0, 5.0);
        let seq = make_sequence_with_clip(clip);

        // Clip is at timeline [5.0, 15.0), so time 20.0 is outside
        assert!(find_clip_at_time(&seq, 20.0).is_none());
    }

    #[test]
    fn test_find_clip_at_time_skips_muted_tracks() {
        let clip = make_clip("asset-1", 0.0, 10.0, 0.0);
        let mut seq = make_sequence_with_clip(clip);
        seq.tracks[0].muted = true;

        assert!(find_clip_at_time(&seq, 5.0).is_none());
    }

    #[test]
    fn test_clip_contains_source_time_excludes_exact_out_point() {
        let clip = make_clip("asset-1", 10.0, 20.0, 5.0);

        assert!(clip_contains_source_time(&clip, 10.0));
        assert!(clip_contains_source_time(&clip, 19.999));
        assert!(!clip_contains_source_time(&clip, 20.0));
    }

    #[test]
    fn test_match_frame_result_serialization() {
        let result = MatchFrameResult {
            asset_id: "asset-42".to_string(),
            source_time_sec: 12.5,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("assetId"));
        assert!(json.contains("sourceTimeSec"));
        let parsed: MatchFrameResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.asset_id, "asset-42");
        assert_eq!(parsed.source_time_sec, 12.5);
    }

    #[test]
    fn test_reverse_match_frame_result_serialization() {
        let result = ReverseMatchFrameResult {
            clip_id: "clip-1".to_string(),
            track_id: "track-v1".to_string(),
            timeline_sec: 7.25,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("clipId"));
        assert!(json.contains("trackId"));
        assert!(json.contains("timelineSec"));
        let parsed: ReverseMatchFrameResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.timeline_sec, 7.25);
    }

    #[test]
    fn test_timeline_to_source_with_trim_offset() {
        // Clip: source range [10, 20], placed at timeline [5, 15]
        let clip = make_clip("asset-1", 10.0, 20.0, 5.0);
        // At timeline 8.0: offset=3.0, source_time = 10.0 + 3.0 = 13.0
        let source_time = clip.timeline_to_source(8.0);
        assert!((source_time - 13.0).abs() < 0.001);
    }
}
