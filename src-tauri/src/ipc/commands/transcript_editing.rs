//! Transcript-Based Editing Commands
//!
//! IPC commands for transcript-driven video editing: word-level timing,
//! range deletion, segment reordering, and cleanup detection (S35-002).

use specta::Type;
use tauri::State;

use crate::core::analysis::cleanup::{self, DetectedRegion};
use crate::core::analysis::speaker_turns::infer_speaker_turns;
use crate::core::analysis::AnalysisJobRunner;
use crate::core::annotations::models::{
    adjust_insert_target_after_removal, estimate_word_timings, source_to_timeline, TranscriptWord,
};
use crate::AppState;

/// Default confidence when transcript segments lack confidence data
const DEFAULT_TRANSCRIPT_CONFIDENCE: f64 = 0.8;

// =============================================================================
// DTOs
// =============================================================================

/// Arguments for deleting a transcript time range from a clip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTranscriptRangeArgs {
    /// Sequence containing the clip
    pub sequence_id: String,
    /// Track containing the clip
    pub track_id: String,
    /// Clip to operate on
    pub clip_id: String,
    /// Start time in source-relative seconds
    pub start_sec: f64,
    /// End time in source-relative seconds
    pub end_sec: f64,
}

/// Arguments for reordering a transcript segment within a clip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderTranscriptSegmentArgs {
    /// Sequence containing the clip
    pub sequence_id: String,
    /// Track containing the clip
    pub track_id: String,
    /// Clip to operate on
    pub clip_id: String,
    /// Start of the segment to move (source-relative seconds)
    pub source_start_sec: f64,
    /// End of the segment to move (source-relative seconds)
    pub source_end_sec: f64,
    /// Target position to insert at (timeline-relative seconds)
    pub target_position_sec: f64,
}

// =============================================================================
// IPC Commands
// =============================================================================

/// Returns word-level timing estimates for an asset's transcript.
///
/// Loads transcript segments from the analysis bundle, then splits each
/// segment into words with linearly interpolated start/end times.
#[tauri::command]
#[specta::specta]
pub async fn get_transcript_words(
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TranscriptWord>, String> {
    if asset_id.trim().is_empty() {
        return Err("Asset ID cannot be empty".to_string());
    }

    let (project_path, index_db_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        let path = project.path.clone();
        let db_path = project.path.join("index.db");
        (path, db_path)
    };

    // Try loading transcript from analysis bundle
    let runner = AnalysisJobRunner::new(&project_path);
    let mut bundle_speech_regions = Vec::new();
    if let Ok(Some(bundle)) = runner.load_bundle_optional(&asset_id) {
        if let Some(audio_profile) = bundle.audio_profile.as_ref() {
            bundle_speech_regions = audio_profile.speech_regions.clone();
        }
        if let Some(ref segments) = bundle.transcript {
            if !segments.is_empty() {
                let inferred = infer_speaker_turns(segments, &bundle_speech_regions);
                return Ok(estimate_word_timings(&inferred));
            }
        }
    }

    if index_db_path.exists() {
        use crate::core::indexing::{transcripts::load_transcript, IndexDb};
        if let Ok(db) = IndexDb::open(&index_db_path) {
            if let Ok(transcript) = load_transcript(&db, &asset_id) {
                if !transcript.segments.is_empty() {
                    let converted: Vec<crate::core::annotations::models::TranscriptSegment> =
                        transcript
                            .segments
                            .iter()
                            .map(|s| {
                                crate::core::annotations::models::TranscriptSegment::new(
                                    s.start_sec,
                                    s.end_sec,
                                    &s.text,
                                    s.confidence.unwrap_or(DEFAULT_TRANSCRIPT_CONFIDENCE),
                                )
                            })
                            .collect();
                    let inferred = infer_speaker_turns(&converted, &bundle_speech_regions);
                    return Ok(estimate_word_timings(&inferred));
                }
            }
        }
    }

    Err(format!(
        "No transcript found for asset '{}'. Run transcription first.",
        asset_id
    ))
}

/// Deletes a time range from a clip using split + ripple delete.
///
/// Converts source-relative times to timeline positions, splits the clip
/// at boundaries, and ripple-deletes the middle section. Each sub-operation
/// is a separate undoable command.
#[tauri::command]
#[specta::specta]
pub async fn delete_transcript_range(
    args: DeleteTranscriptRangeArgs,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::core::commands::{RippleDeleteCommand, SplitClipCommand};

    if args.start_sec >= args.end_sec {
        return Err("Start time must be before end time".to_string());
    }
    if args.start_sec < 0.0 {
        return Err("Start time cannot be negative".to_string());
    }

    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| "No project is currently open".to_string())?;

    // Resolve clip and compute timeline positions
    let (tl_start, tl_end, clip_tl_in, clip_tl_end) = {
        let seq = project
            .state
            .sequences
            .get(&args.sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", args.sequence_id))?;
        let track = seq
            .tracks
            .iter()
            .find(|t| t.id == args.track_id)
            .ok_or_else(|| format!("Track not found: {}", args.track_id))?;
        let clip = track
            .clips
            .iter()
            .find(|c| c.id == args.clip_id)
            .ok_or_else(|| format!("Clip not found: {}", args.clip_id))?;

        let src_in = clip.range.source_in_sec;
        let speed = clip.speed as f64;
        let c_in = clip.place.timeline_in_sec;
        let c_end = clip.place.timeline_out_sec();

        let tl_s = source_to_timeline(args.start_sec, src_in, c_in, speed, c_end);
        let tl_e = source_to_timeline(args.end_sec, src_in, c_in, speed, c_end);

        if (tl_e - tl_s).abs() < 0.001 {
            return Err("Computed timeline range is too small to delete".to_string());
        }
        (tl_s, tl_e, c_in, c_end)
    };

    // Step 1: Split at end boundary (if not at clip end)
    if (tl_end - clip_tl_end).abs() > 0.001 {
        let cmd = SplitClipCommand::new(&args.sequence_id, &args.track_id, &args.clip_id, tl_end);
        project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to split at end: {}", e))?;
    }

    // Step 2: Split at start boundary (if not at clip start)
    let middle_clip_id = if (tl_start - clip_tl_in).abs() > 0.001 {
        let cmd = SplitClipCommand::new(&args.sequence_id, &args.track_id, &args.clip_id, tl_start);
        let result = project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to split at start: {}", e))?;
        result
            .created_ids
            .first()
            .cloned()
            .ok_or_else(|| "Split did not create a new clip".to_string())?
    } else {
        args.clip_id.clone()
    };

    // Step 3: Ripple delete the middle clip
    let cmd = RippleDeleteCommand::new(&args.sequence_id, &args.track_id, vec![middle_clip_id]);
    project
        .executor
        .execute(Box::new(cmd), &mut project.state)
        .map_err(|e| format!("Failed to ripple delete: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "deletedRange": { "startSec": args.start_sec, "endSec": args.end_sec },
        "timelineRange": { "startSec": tl_start, "endSec": tl_end }
    }))
}

/// Reorders a transcript segment by extracting it and inserting at a new position.
///
/// Splits the clip at segment boundaries, ripple-deletes the segment,
/// then inserts it at the target position using insert edit.
#[tauri::command]
#[specta::specta]
pub async fn reorder_transcript_segment(
    args: ReorderTranscriptSegmentArgs,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::core::commands::{InsertEditCommand, RippleDeleteCommand, SplitClipCommand};

    if args.source_start_sec >= args.source_end_sec {
        return Err("Segment start must be before segment end".to_string());
    }
    if args.source_start_sec < 0.0 {
        return Err("Segment start time cannot be negative".to_string());
    }

    let mut guard = state.project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| "No project is currently open".to_string())?;

    // Resolve clip data for timeline position calculation
    let (tl_start, tl_end, clip_tl_in, clip_tl_end, source_asset_id) = {
        let seq = project
            .state
            .sequences
            .get(&args.sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", args.sequence_id))?;
        let track = seq
            .tracks
            .iter()
            .find(|t| t.id == args.track_id)
            .ok_or_else(|| format!("Track not found: {}", args.track_id))?;
        let clip = track
            .clips
            .iter()
            .find(|c| c.id == args.clip_id)
            .ok_or_else(|| format!("Clip not found: {}", args.clip_id))?;

        let src_in = clip.range.source_in_sec;
        let speed = clip.speed as f64;
        let c_in = clip.place.timeline_in_sec;
        let c_end = clip.place.timeline_out_sec();

        let tl_s = source_to_timeline(args.source_start_sec, src_in, c_in, speed, c_end);
        let tl_e = source_to_timeline(args.source_end_sec, src_in, c_in, speed, c_end);

        if (tl_e - tl_s).abs() < 0.001 {
            return Err("Computed segment range is too small to move".to_string());
        }

        (tl_s, tl_e, c_in, c_end, clip.asset_id.clone())
    };

    // Step 1: Split at end boundary (if not at clip end)
    if (tl_end - clip_tl_end).abs() > 0.001 {
        let cmd = SplitClipCommand::new(&args.sequence_id, &args.track_id, &args.clip_id, tl_end);
        project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to split at segment end: {}", e))?;
    }

    // Step 2: Split at start boundary (if not at clip start)
    let segment_clip_id = if (tl_start - clip_tl_in).abs() > 0.001 {
        let cmd = SplitClipCommand::new(&args.sequence_id, &args.track_id, &args.clip_id, tl_start);
        let result = project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to split at segment start: {}", e))?;
        result
            .created_ids
            .first()
            .cloned()
            .ok_or_else(|| "Split did not create a new clip".to_string())?
    } else {
        args.clip_id.clone()
    };

    // Step 3: Ripple delete the segment from current position
    let cmd = RippleDeleteCommand::new(&args.sequence_id, &args.track_id, vec![segment_clip_id]);
    project
        .executor
        .execute(Box::new(cmd), &mut project.state)
        .map_err(|e| format!("Failed to remove segment: {}", e))?;

    // Step 4: Insert the segment at the target position after accounting for
    // the ripple-delete that already closed the source gap.
    let adjusted_target =
        adjust_insert_target_after_removal(args.target_position_sec, tl_start, tl_end);
    let cmd = InsertEditCommand::new(
        &args.sequence_id,
        &args.track_id,
        &source_asset_id,
        adjusted_target,
    )
    .with_source_range(args.source_start_sec, args.source_end_sec);
    let result = project
        .executor
        .execute(Box::new(cmd), &mut project.state)
        .map_err(|e| format!("Failed to insert segment at target: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "movedSegment": {
            "sourceStartSec": args.source_start_sec,
            "sourceEndSec": args.source_end_sec
        },
        "targetPositionSec": args.target_position_sec,
        "appliedTargetPositionSec": adjusted_target,
        "newClipId": result.created_ids.first()
    }))
}

// =============================================================================
// Cleanup Detection DTOs (S35-002)
// =============================================================================

/// Arguments for detecting silence regions in an asset's audio.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectSilenceArgs {
    /// Asset ID to analyze
    pub asset_id: String,
    /// Silence threshold in dB (e.g., -30.0). Lower = more sensitive.
    pub threshold_db: f64,
    /// Minimum silence duration in seconds (e.g., 0.3)
    pub min_duration_sec: f64,
}

/// Arguments for detecting filler words in a transcript.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectFillerWordsArgs {
    /// Asset ID whose transcript to scan
    pub asset_id: String,
    /// Custom filler word list (if empty, uses defaults)
    pub custom_words: Vec<String>,
}

/// Arguments for batch-removing detected regions from a clip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDetectedRegionsArgs {
    /// Sequence containing the clip
    pub sequence_id: String,
    /// Track containing the clip
    pub track_id: String,
    /// Clip to operate on
    pub clip_id: String,
    /// Regions to remove (source-relative time ranges)
    pub regions: Vec<DetectedRegion>,
    /// Inward padding in seconds to apply to each region boundary (default: 0.05)
    pub padding_sec: f64,
}

/// Result of a cleanup detection operation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDetectionResult {
    /// Detected regions (before padding)
    pub regions: Vec<DetectedRegion>,
    /// Total count of detected regions
    pub count: usize,
    /// Total duration of detected regions in seconds
    pub total_duration_sec: f64,
}

// =============================================================================
// Cleanup Detection IPC Commands (S35-002)
// =============================================================================

/// Detects silence regions in an asset's audio with custom sensitivity.
///
/// Runs FFmpeg's `silencedetect` filter with the specified threshold and
/// minimum duration. Falls back to cached analysis data only when the request
/// matches the cached threshold and can be satisfied by duration filtering.
#[tauri::command]
#[specta::specta]
pub async fn detect_silence_regions(
    args: DetectSilenceArgs,
    state: State<'_, AppState>,
    ffmpeg_state: State<'_, crate::core::ffmpeg::SharedFFmpegState>,
) -> Result<CleanupDetectionResult, String> {
    if args.asset_id.trim().is_empty() {
        return Err("Asset ID cannot be empty".to_string());
    }

    // Resolve asset path from project state
    let (project_path, asset_path) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;

        let asset = project
            .state
            .assets
            .values()
            .find(|a| a.id == args.asset_id)
            .ok_or_else(|| format!("Asset not found: {}", args.asset_id))?;

        let resolved = asset.resolved_path(&project.path);
        (project.path.clone(), resolved.to_string_lossy().to_string())
    };

    // Cached silence data is only reusable when the caller requested the same
    // threshold and a minimum duration that can be derived by filtering.
    let runner = AnalysisJobRunner::new(&project_path);
    if let Ok(Some(bundle)) = runner.load_bundle_optional(&args.asset_id) {
        if let Some(ref audio_profile) = bundle.audio_profile {
            if cleanup::can_reuse_cached_silence_regions(args.threshold_db, args.min_duration_sec) {
                let filtered = cleanup::filter_silence_regions(
                    &audio_profile.silence_regions,
                    args.min_duration_sec,
                );
                let detected = cleanup::silence_to_detected_regions(&filtered);
                let total = detected.iter().map(|r| r.end_sec - r.start_sec).sum();
                let count = detected.len();
                return Ok(CleanupDetectionResult {
                    regions: detected,
                    count,
                    total_duration_sec: total,
                });
            }
        }
    }

    // Run fresh silence detection with custom parameters via FFmpeg
    let ffmpeg_path = {
        let ffmpeg_guard = ffmpeg_state.read().await;
        let ffmpeg = ffmpeg_guard.runner().ok_or_else(|| {
            "FFmpeg not initialized. Please check FFmpeg installation.".to_string()
        })?;
        ffmpeg.info().ffmpeg_path.clone()
    };

    let profiler = crate::core::analysis::audio::AudioProfiler::new(ffmpeg_path);
    let video_path = std::path::Path::new(&asset_path);

    let silence_regions = profiler
        .detect_silence_custom(video_path, args.threshold_db, args.min_duration_sec)
        .await
        .map_err(|e| format!("Silence detection failed: {}", e))?;

    let detected = cleanup::silence_to_detected_regions(&silence_regions);
    let total = detected.iter().map(|r| r.end_sec - r.start_sec).sum();
    let count = detected.len();

    Ok(CleanupDetectionResult {
        regions: detected,
        count,
        total_duration_sec: total,
    })
}

/// Detects filler words in an asset's transcript.
///
/// Loads the transcript (from analysis bundle or index DB), then scans
/// for configurable filler word patterns. Multi-word patterns like
/// "you know" are supported.
#[tauri::command]
#[specta::specta]
pub async fn detect_filler_words(
    args: DetectFillerWordsArgs,
    state: State<'_, AppState>,
) -> Result<CleanupDetectionResult, String> {
    if args.asset_id.trim().is_empty() {
        return Err("Asset ID cannot be empty".to_string());
    }

    // Load transcript words (reuses existing get_transcript_words logic)
    let words = get_transcript_words(args.asset_id.clone(), state).await?;

    // Determine filler word list
    let patterns: Vec<&str> = if args.custom_words.is_empty() {
        cleanup::DEFAULT_FILLER_WORDS_EN.to_vec()
    } else {
        args.custom_words.iter().map(|s| s.as_str()).collect()
    };

    let filler_matches = cleanup::detect_filler_words(&words, &patterns);
    let detected = cleanup::fillers_to_detected_regions(&filler_matches);
    let total = detected.iter().map(|r| r.end_sec - r.start_sec).sum();
    let count = detected.len();

    Ok(CleanupDetectionResult {
        regions: detected,
        count,
        total_duration_sec: total,
    })
}

/// Removes multiple detected regions from a clip via batch ripple delete.
///
/// Regions are processed in reverse chronological order so that each
/// deletion does not shift the positions of earlier regions. Each region
/// is padded inward by `padding_sec` to preserve natural breath sounds.
///
/// All operations are individually undoable.
#[tauri::command]
#[specta::specta]
pub async fn remove_detected_regions(
    args: RemoveDetectedRegionsArgs,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use crate::core::commands::{RippleDeleteCommand, SplitClipCommand};

    if args.regions.is_empty() {
        return Err("No regions to remove".to_string());
    }

    // Apply padding and sort for safe removal
    let (clip_source_in, clip_source_out) = {
        let guard = state.project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| "No project is currently open".to_string())?;
        let seq = project
            .state
            .sequences
            .get(&args.sequence_id)
            .ok_or_else(|| format!("Sequence not found: {}", args.sequence_id))?;
        let track = seq
            .tracks
            .iter()
            .find(|t| t.id == args.track_id)
            .ok_or_else(|| format!("Track not found: {}", args.track_id))?;
        let clip = track
            .clips
            .iter()
            .find(|c| c.id == args.clip_id)
            .ok_or_else(|| format!("Clip not found: {}", args.clip_id))?;
        (clip.range.source_in_sec, clip.range.source_out_sec)
    };

    let padded = cleanup::apply_padding(
        &args.regions,
        args.padding_sec,
        clip_source_in,
        clip_source_out,
    );
    let mut sorted = padded;
    cleanup::sort_regions_for_removal(&mut sorted);

    if sorted.is_empty() {
        return Ok(serde_json::json!({
            "success": true,
            "removedCount": 0,
            "message": "No regions large enough to remove after padding"
        }));
    }

    let mut removed_count = 0;

    // Process each region in reverse order
    for region in &sorted {
        // Re-read clip state each iteration since previous deletions modify it
        let clip_info = {
            let guard = state.project.lock().await;
            let project = guard
                .as_ref()
                .ok_or_else(|| "No project is currently open".to_string())?;
            let seq = project
                .state
                .sequences
                .get(&args.sequence_id)
                .ok_or_else(|| format!("Sequence not found: {}", args.sequence_id))?;
            let track = seq
                .tracks
                .iter()
                .find(|t| t.id == args.track_id)
                .ok_or_else(|| format!("Track not found: {}", args.track_id))?;

            // Find the clip that covers this source-relative time range.
            // After splits, the original clip_id may have been split into multiple clips.
            let covering_clip = track.clips.iter().find(|c| {
                let src_in = c.range.source_in_sec;
                let src_out = c.range.source_out_sec;
                src_in <= region.start_sec + 0.001 && src_out >= region.end_sec - 0.001
            });

            covering_clip.map(|c| {
                (
                    c.id.clone(),
                    c.range.source_in_sec,
                    c.place.timeline_in_sec,
                    c.speed as f64,
                    c.place.timeline_out_sec(),
                )
            })
        };

        let Some((clip_id, src_in, tl_in, speed, tl_end)) = clip_info else {
            // Clip may have been removed by a previous operation — skip
            continue;
        };

        let tl_start = source_to_timeline(region.start_sec, src_in, tl_in, speed, tl_end);
        let tl_region_end = source_to_timeline(region.end_sec, src_in, tl_in, speed, tl_end);

        if (tl_region_end - tl_start).abs() < 0.001 {
            continue;
        }

        let mut guard = state.project.lock().await;
        let project = guard
            .as_mut()
            .ok_or_else(|| "No project is currently open".to_string())?;

        // Split at end (if not at clip end)
        if (tl_region_end - tl_end).abs() > 0.001 {
            let cmd =
                SplitClipCommand::new(&args.sequence_id, &args.track_id, &clip_id, tl_region_end);
            project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| format!("Failed to split at region end: {}", e))?;
        }

        // Split at start (if not at clip start)
        let middle_clip_id = if (tl_start - tl_in).abs() > 0.001 {
            let cmd = SplitClipCommand::new(&args.sequence_id, &args.track_id, &clip_id, tl_start);
            let result = project
                .executor
                .execute(Box::new(cmd), &mut project.state)
                .map_err(|e| format!("Failed to split at region start: {}", e))?;
            result
                .created_ids
                .first()
                .cloned()
                .unwrap_or_else(|| clip_id.clone())
        } else {
            clip_id.clone()
        };

        // Ripple delete the middle clip
        let cmd = RippleDeleteCommand::new(&args.sequence_id, &args.track_id, vec![middle_clip_id]);
        project
            .executor
            .execute(Box::new(cmd), &mut project.state)
            .map_err(|e| format!("Failed to remove region: {}", e))?;

        removed_count += 1;
    }

    Ok(serde_json::json!({
        "success": true,
        "removedCount": removed_count,
        "totalRegionsDetected": args.regions.len()
    }))
}

// Tests for pure helpers (source_to_timeline, adjust_insert_target_after_removal,
// estimate_word_timings) live in core::annotations::models::tests where they
// compile under #[cfg(test)] (the commands module is #[cfg(not(test))]).
