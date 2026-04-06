//! Analysis inspection commands: cached source analysis reporting.

use crate::output;
use chrono::Utc;
use clap::Subcommand;
use openreelio_core::assets::AssetKind;
use openreelio_core::commands::{AddTrackCommand, InsertClipCommand};
use openreelio_core::timeline::TrackKind;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum AnalysisAction {
    /// Build a source analysis report for an asset from cached analysis artifacts
    Report {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID
        #[arg(long)]
        id: String,
    },

    /// Search moments, chapters, highlights, and speaker turns inside a cached source analysis report
    Search {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Asset ID
        #[arg(long)]
        id: String,

        /// Search query
        #[arg(long)]
        query: String,

        /// Sections to search: moments, chapters, highlights, speakerTurns
        #[arg(long, value_delimiter = ',')]
        sections: Vec<String>,

        /// Maximum matches to return
        #[arg(long, default_value_t = 5)]
        limit: usize,
    },

    /// Search source-analysis results across multiple video assets
    SearchLibrary {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Search query
        #[arg(long)]
        query: String,

        /// Optional asset IDs to restrict search scope
        #[arg(long, value_delimiter = ',')]
        ids: Vec<String>,

        /// Restrict search to assets not currently used on any timeline
        #[arg(long, default_value_t = false)]
        unused_only: bool,

        /// Sections to search: moments, chapters, highlights, speakerTurns
        #[arg(long, value_delimiter = ',')]
        sections: Vec<String>,

        /// Maximum matches to return
        #[arg(long, default_value_t = 8)]
        limit: usize,

        /// Maximum candidate assets to inspect
        #[arg(long, default_value_t = 20)]
        asset_limit: usize,
    },

    /// Build a selects stringout plan from ranked source matches, with optional direct apply
    BuildSelects {
        /// Project directory path
        #[arg(long)]
        path: PathBuf,

        /// Search query
        #[arg(long)]
        query: String,

        /// Sequence ID (defaults to active sequence)
        #[arg(long)]
        sequence: Option<String>,

        /// Optional target video track ID
        #[arg(long)]
        track: Option<String>,

        /// Target track name when creating or reusing a selects track
        #[arg(long, default_value = "Source Selects")]
        track_name: String,

        /// Optional timeline start position for the first selects clip
        #[arg(long)]
        timeline_start: Option<f64>,

        /// Optional asset IDs to restrict search scope
        #[arg(long, value_delimiter = ',')]
        ids: Vec<String>,

        /// Restrict search to assets not currently used on any timeline
        #[arg(long, default_value_t = false)]
        unused_only: bool,

        /// Sections to search: moments, chapters, highlights, speakerTurns
        #[arg(long, value_delimiter = ',')]
        sections: Vec<String>,

        /// Maximum final selects to keep
        #[arg(long, default_value_t = 6)]
        limit: usize,

        /// Maximum candidate assets to inspect
        #[arg(long, default_value_t = 20)]
        asset_limit: usize,

        /// Extra padding before and after each selected source range
        #[arg(long, default_value_t = 0.25)]
        padding_sec: f64,

        /// Gap between selects on the timeline
        #[arg(long, default_value_t = 0.25)]
        gap_sec: f64,

        /// Apply the generated selects directly to the target track
        #[arg(long, default_value_t = false)]
        apply: bool,
    },
}

struct SourceLibrarySearchResult {
    query: String,
    sections: Vec<String>,
    searched_asset_count: usize,
    skipped_asset_count: usize,
    skipped_assets: Vec<Value>,
    matches: Vec<Value>,
}

fn normalize_search_sections(sections: &[String]) -> Vec<String> {
    let filtered = sections
        .iter()
        .filter_map(|section| match section.as_str() {
            "moments" => Some("moments".to_string()),
            "chapters" => Some("chapters".to_string()),
            "highlights" => Some("highlights".to_string()),
            "speakerTurns" | "speaker-turns" | "speaker_turns" => Some("speakerTurns".to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();

    if filtered.is_empty() {
        vec![
            "moments".to_string(),
            "chapters".to_string(),
            "highlights".to_string(),
            "speakerTurns".to_string(),
        ]
    } else {
        filtered
    }
}

fn value_score(value: &Value) -> f64 {
    value.get("score").and_then(Value::as_f64).unwrap_or(0.0)
}

fn value_start_sec(value: &Value) -> f64 {
    value.get("startSec").and_then(Value::as_f64).unwrap_or(0.0)
}

fn value_end_sec(value: &Value) -> f64 {
    value.get("endSec").and_then(Value::as_f64).unwrap_or(0.0)
}

fn clamp_select_range(
    asset_duration_sec: Option<f64>,
    start_sec: f64,
    end_sec: f64,
) -> (f64, f64, f64) {
    let bounded_start = start_sec.max(0.0);
    let bounded_end = asset_duration_sec
        .filter(|duration| duration.is_finite() && *duration >= 0.0)
        .map(|duration| end_sec.min(duration))
        .unwrap_or(end_sec)
        .max(bounded_start);

    (
        round_to(bounded_start),
        round_to(bounded_end),
        round_to((bounded_end - bounded_start).max(0.0)),
    )
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedShotResult {
    start_sec: f64,
    end_sec: f64,
    confidence: f64,
    keyframe_path: Option<String>,
    #[serde(default)]
    keyframe_selection_method: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedTranscriptSegment {
    start_sec: f64,
    end_sec: f64,
    text: String,
    confidence: f64,
    language: Option<String>,
    speaker_id: Option<String>,
    speaker_turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedSilenceRegion {
    start_sec: f64,
    end_sec: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedSpeechRegion {
    start_sec: f64,
    end_sec: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAudioProfile {
    bpm: Option<f64>,
    spectral_centroid_hz: f64,
    loudness_profile: Vec<f64>,
    peak_db: f64,
    silence_regions: Vec<CachedSilenceRegion>,
    #[serde(default)]
    speech_regions: Vec<CachedSpeechRegion>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedContentSegment {
    start_sec: f64,
    end_sec: f64,
    segment_type: String,
    confidence: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFrameAnalysis {
    camera_angle: String,
    motion_direction: String,
    visual_complexity: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedContactSheet {
    path: String,
    frame_count: usize,
    columns: usize,
    rows: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedObjectDetection {
    time_sec: f64,
    labels: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFaceDetection {
    time_sec: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedTextDetection {
    time_sec: f64,
    text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedVideoMetadata {
    duration_sec: f64,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    codec: Option<String>,
    has_audio: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAnalysisBundle {
    shots: Option<Vec<CachedShotResult>>,
    transcript: Option<Vec<CachedTranscriptSegment>>,
    audio_profile: Option<CachedAudioProfile>,
    segments: Option<Vec<CachedContentSegment>>,
    frame_analysis: Option<Vec<CachedFrameAnalysis>>,
    #[serde(default)]
    contact_sheet: Option<CachedContactSheet>,
    metadata: CachedVideoMetadata,
    #[serde(default)]
    errors: BTreeMap<String, String>,
    analyzed_at: String,
}

pub fn execute(action: AnalysisAction) -> anyhow::Result<()> {
    match action {
        AnalysisAction::Report { path, id } => {
            let project_dir = std::fs::canonicalize(&path).map_err(|e| {
                anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e)
            })?;
            let project = super::load_project(&project_dir)?;
            let report = build_source_analysis_report(&project, &project_dir, &id)?;
            output::print_json_pretty(&report)
        }
        AnalysisAction::Search {
            path,
            id,
            query,
            sections,
            limit,
        } => {
            let project_dir = std::fs::canonicalize(&path).map_err(|e| {
                anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e)
            })?;
            let project = super::load_project(&project_dir)?;
            let report = build_source_analysis_report(&project, &project_dir, &id)?;
            let normalized_sections = normalize_search_sections(&sections);
            let results =
                search_source_analysis_report_value(&report, &query, &normalized_sections, limit);
            output::print_json_pretty(&json!({
                "assetId": report.get("assetId").and_then(Value::as_str).unwrap_or(id.as_str()),
                "assetName": report.get("assetName").and_then(Value::as_str).unwrap_or("unknown"),
                "query": query,
                "sections": normalized_sections,
                "count": results.len(),
                "matches": results,
            }))
        }
        AnalysisAction::SearchLibrary {
            path,
            query,
            ids,
            unused_only,
            sections,
            limit,
            asset_limit,
        } => {
            let project_dir = std::fs::canonicalize(&path).map_err(|e| {
                anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e)
            })?;
            let project = super::load_project(&project_dir)?;
            let normalized_sections = normalize_search_sections(&sections);
            let requested_ids = if ids.is_empty() {
                None
            } else {
                Some(ids.into_iter().collect::<BTreeSet<_>>())
            };
            let result = search_source_library_matches(
                &project,
                &project_dir,
                &query,
                requested_ids.as_ref(),
                unused_only,
                &normalized_sections,
                limit,
                asset_limit,
            );

            output::print_json_pretty(&json!({
                "query": result.query,
                "sections": result.sections,
                "searchedAssetCount": result.searched_asset_count,
                "skippedAssetCount": result.skipped_asset_count,
                "skippedAssets": result.skipped_assets,
                "count": result.matches.len(),
                "matches": result.matches,
            }))
        }
        AnalysisAction::BuildSelects {
            path,
            query,
            sequence,
            track,
            track_name,
            timeline_start,
            ids,
            unused_only,
            sections,
            limit,
            asset_limit,
            padding_sec,
            gap_sec,
            apply,
        } => {
            let project_dir = std::fs::canonicalize(&path).map_err(|e| {
                anyhow::anyhow!("Project path '{}' not found: {}", path.display(), e)
            })?;
            let mut project = super::load_project(&project_dir)?;
            let normalized_sections = normalize_search_sections(&sections);
            let requested_ids = if ids.is_empty() {
                None
            } else {
                Some(ids.into_iter().collect::<BTreeSet<_>>())
            };
            let search_result = search_source_library_matches(
                &project,
                &project_dir,
                &query,
                requested_ids.as_ref(),
                unused_only,
                &normalized_sections,
                limit.saturating_mul(3).max(1),
                asset_limit,
            );
            let selects = build_source_selects_from_matches(
                &project,
                &search_result.matches,
                padding_sec.max(0.0),
                gap_sec.max(0.0),
                limit.clamp(1, 24),
            );

            let resolved_sequence_id = super::resolve_sequence_id(&project, sequence)?;
            let timeline_plan = build_selects_timeline_plan(
                &project,
                &resolved_sequence_id,
                track.as_deref(),
                &track_name,
                timeline_start,
                gap_sec.max(0.0),
                &selects,
            )?;

            let applied = if apply {
                let result = apply_source_selects(
                    &mut project,
                    &resolved_sequence_id,
                    track.as_deref(),
                    &track_name,
                    timeline_start,
                    &selects,
                )?;
                super::save_project(&mut project)?;
                Some(result)
            } else {
                None
            };

            output::print_json_pretty(&json!({
                "query": search_result.query,
                "sections": search_result.sections,
                "searchedAssetCount": search_result.searched_asset_count,
                "skippedAssetCount": search_result.skipped_asset_count,
                "skippedAssets": search_result.skipped_assets,
                "count": selects.len(),
                "selects": selects,
                "timelinePlan": timeline_plan,
                "applied": applied,
            }))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn search_source_library_matches(
    project: &openreelio_core::ActiveProject,
    project_dir: &Path,
    query: &str,
    requested_ids: Option<&BTreeSet<String>>,
    unused_only: bool,
    sections: &[String],
    limit: usize,
    asset_limit: usize,
) -> SourceLibrarySearchResult {
    let mut assets = project
        .state
        .assets
        .values()
        .filter(|asset| asset.kind == AssetKind::Video && asset.video.is_some())
        .filter(|asset| {
            requested_ids
                .as_ref()
                .map(|ids| ids.contains(asset.id.as_str()))
                .unwrap_or(true)
        })
        .map(|asset| {
            let timeline_clip_count = count_asset_usage(project, asset.id.as_str());
            let on_timeline = timeline_clip_count > 0;
            (asset, timeline_clip_count, on_timeline)
        })
        .filter(|(_, _, on_timeline)| !unused_only || !*on_timeline)
        .collect::<Vec<_>>();
    assets.sort_by(|left, right| {
        if left.2 != right.2 {
            return left.2.cmp(&right.2);
        }

        right
            .0
            .imported_at
            .cmp(&left.0.imported_at)
            .then_with(|| left.0.name.cmp(&right.0.name))
    });

    let mut matches = Vec::new();
    let mut searched_asset_count = 0usize;
    let mut skipped_asset_count = 0usize;
    let mut skipped_assets = Vec::new();

    for (asset, timeline_clip_count, on_timeline) in
        assets.into_iter().take(asset_limit.clamp(1, 100))
    {
        searched_asset_count += 1;
        match build_source_analysis_report(project, project_dir, asset.id.as_str()) {
            Ok(report) => {
                let asset_matches =
                    search_source_analysis_report_value(&report, query, sections, limit);
                for entry in asset_matches {
                    let mut entry_object = entry.as_object().cloned().unwrap_or_default();
                    entry_object.insert("assetId".to_string(), json!(asset.id));
                    entry_object.insert("assetName".to_string(), json!(asset.name));
                    entry_object.insert("onTimeline".to_string(), json!(on_timeline));
                    entry_object
                        .insert("timelineClipCount".to_string(), json!(timeline_clip_count));
                    matches.push(Value::Object(entry_object));
                }
            }
            Err(error) => {
                skipped_asset_count += 1;
                skipped_assets.push(json!({
                    "assetId": asset.id,
                    "assetName": asset.name,
                    "reason": error.to_string(),
                }));
            }
        }
    }

    let matches = rerank_source_library_matches(matches, query)
        .into_iter()
        .take(limit.clamp(1, 50))
        .collect();

    SourceLibrarySearchResult {
        query: query.to_string(),
        sections: sections.to_vec(),
        searched_asset_count,
        skipped_asset_count,
        skipped_assets,
        matches,
    }
}

fn dedupe_source_library_matches(matches: &[Value], minimum_overlap_sec: f64) -> Vec<Value> {
    let mut deduped = Vec::new();

    for candidate in matches {
        let candidate_asset_id = candidate
            .get("assetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let candidate_start = value_start_sec(candidate);
        let candidate_end = value_end_sec(candidate);
        let overlaps_existing = deduped.iter().any(|existing: &Value| {
            let existing_asset_id = existing
                .get("assetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            existing_asset_id == candidate_asset_id
                && overlap_duration(
                    value_start_sec(existing),
                    value_end_sec(existing),
                    candidate_start,
                    candidate_end,
                ) > minimum_overlap_sec
        });
        if !overlaps_existing {
            deduped.push(candidate.clone());
        }
    }

    deduped
}

fn build_source_selects_from_matches(
    project: &openreelio_core::ActiveProject,
    matches: &[Value],
    padding_sec: f64,
    gap_sec: f64,
    limit: usize,
) -> Vec<Value> {
    let deduped = dedupe_source_library_matches(matches, 0.25);
    let mut cursor_sec = 0.0;

    deduped
        .into_iter()
        .take(limit.clamp(1, 24))
        .enumerate()
        .filter_map(|(index, entry)| {
            let asset_id = entry.get("assetId").and_then(Value::as_str)?;
            let asset = project.state.assets.get(asset_id)?;
            let (source_in_sec, source_out_sec, duration_sec) = clamp_select_range(
                asset.duration_sec,
                value_start_sec(&entry) - padding_sec,
                value_end_sec(&entry) + padding_sec,
            );
            let select = json!({
                "index": index,
                "assetId": asset_id,
                "assetName": entry.get("assetName").and_then(Value::as_str).unwrap_or(asset.name.as_str()),
                "sectionType": entry.get("sectionType").and_then(Value::as_str).unwrap_or("moments"),
                "rawScore": entry.get("rawScore").cloned().unwrap_or_else(|| json!(value_score(&entry))),
                "score": value_score(&entry),
                "rankingNotes": entry.get("rankingNotes").cloned().unwrap_or_else(|| json!([])),
                "whyMatched": entry.get("whyMatched").cloned().unwrap_or_else(|| json!([])),
                "preview": entry.get("preview").and_then(Value::as_str).unwrap_or_default(),
                "keyframePath": entry.get("keyframePath").cloned().unwrap_or(Value::Null),
                "onTimeline": entry.get("onTimeline").and_then(Value::as_bool).unwrap_or(false),
                "timelineClipCount": entry.get("timelineClipCount").and_then(Value::as_u64).unwrap_or(0),
                "metadata": entry.get("metadata").cloned().unwrap_or(Value::Null),
                "sourceInSec": source_in_sec,
                "sourceOutSec": source_out_sec,
                "durationSec": duration_sec,
                "timelineStartSec": round_to(cursor_sec),
            });
            cursor_sec += duration_sec + gap_sec.max(0.0);
            Some(select)
        })
        .collect()
}

fn resolve_existing_selects_track<'a>(
    sequence: &'a openreelio_core::timeline::Sequence,
    track_id: Option<&str>,
    track_name: &str,
) -> anyhow::Result<Option<&'a openreelio_core::timeline::Track>> {
    if let Some(track_id) = track_id {
        let track = sequence
            .tracks
            .iter()
            .find(|track| track.id == track_id)
            .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", track_id))?;
        if track.kind != TrackKind::Video {
            return Err(anyhow::anyhow!(
                "Selects can currently be applied to video tracks only."
            ));
        }
        return Ok(Some(track));
    }

    Ok(sequence
        .tracks
        .iter()
        .find(|track| track.kind == TrackKind::Video && track.name.trim() == track_name.trim()))
}

fn build_selects_timeline_plan(
    project: &openreelio_core::ActiveProject,
    sequence_id: &str,
    track_id: Option<&str>,
    track_name: &str,
    timeline_start: Option<f64>,
    gap_sec: f64,
    selects: &[Value],
) -> anyhow::Result<Value> {
    let sequence = project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))?;
    let existing_track = resolve_existing_selects_track(sequence, track_id, track_name)?;
    let base_timeline_start = timeline_start
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or_else(|| {
            existing_track
                .map(|track| {
                    track
                        .clips
                        .iter()
                        .map(|clip| clip.place.timeline_in_sec + clip.place.duration_sec)
                        .fold(0.0, f64::max)
                })
                .unwrap_or(0.0)
        });
    let mut steps = Vec::new();
    if existing_track.is_none() && track_id.is_none() {
        steps.push(json!({ "action": "add_track", "trackName": track_name }));
    }
    steps.extend(selects.iter().map(|select| {
        json!({
            "action": "insert_clip",
            "assetId": select.get("assetId").and_then(Value::as_str).unwrap_or_default(),
            "assetName": select.get("assetName").and_then(Value::as_str).unwrap_or_default(),
            "timelineStartSec": round_to(base_timeline_start + select.get("timelineStartSec").and_then(Value::as_f64).unwrap_or(0.0)),
            "sourceInSec": select.get("sourceInSec").and_then(Value::as_f64).unwrap_or(0.0),
            "sourceOutSec": select.get("sourceOutSec").and_then(Value::as_f64).unwrap_or(0.0),
            "trackId": existing_track.map(|track| track.id.clone()),
            "trackName": track_name,
        })
    }));

    Ok(json!({
        "sequenceId": sequence_id,
        "targetTrackId": existing_track.map(|track| track.id.clone()),
        "targetTrackName": track_name,
        "timelineStartSec": round_to(base_timeline_start),
        "gapSec": round_to(gap_sec.max(0.0)),
        "steps": steps
    }))
}

fn apply_source_selects(
    project: &mut openreelio_core::ActiveProject,
    sequence_id: &str,
    track_id: Option<&str>,
    track_name: &str,
    timeline_start: Option<f64>,
    selects: &[Value],
) -> anyhow::Result<Value> {
    let sequence = project
        .state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| anyhow::anyhow!("Sequence '{}' not found", sequence_id))?;
    let existing_track = resolve_existing_selects_track(sequence, track_id, track_name)?;

    let (resolved_track_id, created_track) = if let Some(track) = existing_track {
        (track.id.clone(), false)
    } else {
        let command = AddTrackCommand::new(sequence_id, track_name, TrackKind::Video);
        let result = project
            .executor
            .execute(Box::new(command.clone()), &mut project.state)
            .map_err(|e| anyhow::anyhow!("CreateTrack failed: {}", e))?;
        let created_track_id = result
            .created_ids
            .first()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("CreateTrack did not return a created track id"))?;
        (created_track_id, true)
    };

    let refreshed_sequence = project.state.sequences.get(sequence_id).ok_or_else(|| {
        anyhow::anyhow!(
            "Sequence '{}' not found after track resolution",
            sequence_id
        )
    })?;
    let target_track = refreshed_sequence
        .tracks
        .iter()
        .find(|track| track.id == resolved_track_id)
        .ok_or_else(|| anyhow::anyhow!("Track '{}' not found", resolved_track_id))?;
    let base_timeline_start = timeline_start
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or_else(|| {
            target_track
                .clips
                .iter()
                .map(|clip| clip.place.timeline_in_sec + clip.place.duration_sec)
                .fold(0.0, f64::max)
        });

    let mut inserted_clip_ids = Vec::new();
    for select in selects {
        let asset_id = select
            .get("assetId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Select is missing assetId"))?;
        let source_in = select
            .get("sourceInSec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let source_out = select
            .get("sourceOutSec")
            .and_then(Value::as_f64)
            .unwrap_or(source_in);
        let timeline_offset = select
            .get("timelineStartSec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let command = InsertClipCommand::new(
            sequence_id,
            &resolved_track_id,
            asset_id,
            base_timeline_start + timeline_offset,
        )
        .with_source_range(source_in, source_out);
        let result = project
            .executor
            .execute(Box::new(command), &mut project.state)
            .map_err(|e| anyhow::anyhow!("InsertClip failed: {}", e))?;
        inserted_clip_ids.extend(result.created_ids);
    }

    Ok(json!({
        "sequenceId": sequence_id,
        "trackId": resolved_track_id,
        "createdTrack": created_track,
        "insertedClipCount": inserted_clip_ids.len(),
        "insertedClipIds": inserted_clip_ids,
    }))
}

fn build_source_analysis_report(
    project: &openreelio_core::ActiveProject,
    project_dir: &Path,
    asset_id: &str,
) -> anyhow::Result<Value> {
    let asset = project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| anyhow::anyhow!("Asset '{}' not found", asset_id))?;
    if asset.kind != AssetKind::Video || asset.video.is_none() {
        return Err(anyhow::anyhow!(
            "source analysis report tools currently support video assets with a video stream only."
        ));
    }

    let timeline_clip_count = count_asset_usage(project, asset_id);
    let (bundle, bundle_warning) = match load_cached_bundle(project_dir, asset_id) {
        Ok(bundle) => (bundle, None),
        Err(error) => (
            None,
            Some(format!("Failed to parse cached analysis bundle: {}", error)),
        ),
    };
    let (annotation, annotation_warning) = match load_annotation(project_dir, asset_id) {
        Ok(annotation) => (annotation, None),
        Err(error) => (
            None,
            Some(format!("Failed to parse cached annotation: {}", error)),
        ),
    };

    let annotation_shots =
        annotation_typed_results::<CachedShotResult>(annotation.as_ref(), "shots");
    let annotation_transcript =
        annotation_typed_results::<CachedTranscriptSegment>(annotation.as_ref(), "transcript");
    let shots = bundle
        .as_ref()
        .and_then(|cached| cached.shots.clone())
        .unwrap_or(annotation_shots);
    let transcript = bundle
        .as_ref()
        .and_then(|cached| cached.transcript.clone())
        .unwrap_or(annotation_transcript);
    let audio_profile = bundle
        .as_ref()
        .and_then(|cached| cached.audio_profile.clone());
    let segments = bundle
        .as_ref()
        .and_then(|cached| cached.segments.clone())
        .unwrap_or_default();
    let frame_analysis = bundle
        .as_ref()
        .and_then(|cached| cached.frame_analysis.clone())
        .unwrap_or_default();
    let contact_sheet = bundle
        .as_ref()
        .and_then(|cached| cached.contact_sheet.clone());
    let duration_sec = bundle
        .as_ref()
        .map(|cached| cached.metadata.duration_sec)
        .filter(|value| value.is_finite())
        .or(asset.duration_sec);
    let width = bundle
        .as_ref()
        .and_then(|cached| cached.metadata.width)
        .or_else(|| asset.video.as_ref().map(|video| video.width));
    let height = bundle
        .as_ref()
        .and_then(|cached| cached.metadata.height)
        .or_else(|| asset.video.as_ref().map(|video| video.height));
    let fps = bundle
        .as_ref()
        .and_then(|cached| cached.metadata.fps)
        .or_else(|| asset.video.as_ref().map(|video| video.fps.as_f64()));
    let codec = bundle
        .as_ref()
        .and_then(|cached| cached.metadata.codec.clone())
        .or_else(|| asset.video.as_ref().map(|video| video.codec.clone()));
    let shot_durations: Vec<f64> = shots
        .iter()
        .map(|shot| (shot.end_sec - shot.start_sec).max(0.0))
        .collect();
    let total_shot_duration: f64 = shot_durations.iter().sum();
    let transcript_word_count: usize = transcript
        .iter()
        .map(|segment| {
            segment
                .text
                .split_whitespace()
                .filter(|token| !token.is_empty())
                .count()
        })
        .sum();
    let transcript_languages = unique_sorted_strings(
        transcript
            .iter()
            .filter_map(|segment| segment.language.clone())
            .collect(),
    );
    let speaker_count = unique_sorted_strings(
        transcript
            .iter()
            .filter_map(|segment| segment.speaker_id.clone())
            .collect(),
    )
    .len();

    let mut warnings = Vec::new();
    if let Some(warning) = bundle_warning {
        warnings.push(warning);
    }
    if let Some(warning) = annotation_warning {
        warnings.push(warning);
    }
    if bundle.is_none() {
        warnings.push(
            "Cached analysis bundle not found. Run in-app analysis first for full source reports."
                .to_string(),
        );
    }
    if annotation.is_none() {
        warnings.push(
            "Cached annotation not found. Object, face, and OCR summaries may be incomplete."
                .to_string(),
        );
    }
    if transcript.is_empty() {
        warnings.push(
            "Transcript data is missing. Generate transcript analysis for searchable dialogue."
                .to_string(),
        );
    }
    if bundle.is_none() || frame_analysis.is_empty() {
        warnings.push(
            "Visual composition analysis is missing. Generate visual analysis for framing cues."
                .to_string(),
        );
    }
    if let Some(cached) = bundle.as_ref() {
        for (analysis_type, message) in &cached.errors {
            warnings.push(format!("{}: {}", analysis_type, message));
        }
    }

    let segment_distribution = build_segment_distribution(&segments, duration_sec);
    let top_camera_angles = top_counts(
        frame_analysis
            .iter()
            .map(|entry| entry.camera_angle.clone())
            .collect::<Vec<_>>(),
        4,
    );
    let top_motion_directions = top_counts(
        frame_analysis
            .iter()
            .map(|entry| entry.motion_direction.clone())
            .collect::<Vec<_>>(),
        4,
    );
    let chapters = build_report_chapters(&shots, &transcript, &segments);
    let chapters_count = chapters.len();
    let chapters_json = chapters.clone();
    let annotation_available_types = annotation_available_types(annotation.as_ref());
    let annotation_providers = annotation_provider_labels(annotation.as_ref());
    let top_object_labels = top_counts(annotation_object_labels(annotation.as_ref()), 6);
    let ocr_preview = annotation_ocr_preview(annotation.as_ref());
    let object_detections =
        annotation_typed_results::<CachedObjectDetection>(annotation.as_ref(), "objects");
    let face_detections =
        annotation_typed_results::<CachedFaceDetection>(annotation.as_ref(), "faces");
    let text_detections =
        annotation_typed_results::<CachedTextDetection>(annotation.as_ref(), "textOcr");
    let object_times = object_detections
        .iter()
        .map(|entry| entry.time_sec)
        .collect::<Vec<_>>();
    let text_times = text_detections
        .iter()
        .map(|entry| entry.time_sec)
        .collect::<Vec<_>>();
    let silence_regions = audio_profile
        .as_ref()
        .map(|profile| profile.silence_regions.clone())
        .unwrap_or_default();
    let speech_regions = audio_profile
        .as_ref()
        .map(|profile| {
            derive_speech_regions(
                &profile.speech_regions,
                &profile.silence_regions,
                duration_sec,
            )
        })
        .unwrap_or_default();
    let highlights = build_report_highlights(
        &transcript,
        &shots,
        &segments,
        &object_times,
        &text_times,
        &chapters,
    );
    let highlights_count = highlights.len();
    let highlights_json = highlights.clone();
    let moments = build_report_moments(
        &shots,
        &transcript,
        &segments,
        &speech_regions,
        &silence_regions,
        &object_detections,
        &face_detections,
        &text_detections,
    );
    let moments_count = moments.len();
    let moments_json = moments.clone();
    let speaker_turns =
        build_speaker_turns(&transcript, &speech_regions, &silence_regions, &segments);
    let speaker_turn_count = speaker_turns.len();
    let speaker_turns_json = speaker_turns.clone();
    let segment_distribution_json = segment_entries_to_json(segment_distribution.clone());
    let top_camera_angles_json = simple_count_entries_to_json(top_camera_angles.clone());
    let top_motion_directions_json = simple_count_entries_to_json(top_motion_directions.clone());
    let top_object_labels_json = simple_count_entries_to_json(top_object_labels.clone());
    let object_detection_count = annotation_results_len(annotation.as_ref(), "objects");
    let face_detection_count = annotation_results_len(annotation.as_ref(), "faces");
    let ocr_text_count = annotation_results_len(annotation.as_ref(), "textOcr");
    let silence_region_count = silence_regions.len();
    let silence_duration_sec = silence_regions
        .iter()
        .map(|region| region.end_sec - region.start_sec)
        .sum::<f64>();
    let speech_duration_sec = speech_regions
        .iter()
        .map(|region| region.end_sec - region.start_sec)
        .sum::<f64>();
    let analyzed_at = bundle
        .as_ref()
        .map(|cached| cached.analyzed_at.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let generated_at = Utc::now().to_rfc3339();
    let bundle_source = "cached";
    let summary = if bundle.is_some() {
        format!(
            "Source report for {}: {} shots, {} transcript segments, {} speaker turns, {} content segments{}.",
            asset.name,
            shots.len(),
            transcript.len(),
            speaker_turn_count,
            segments.len(),
            if object_detection_count > 0 {
                format!(", {} object detections", object_detection_count)
            } else {
                String::new()
            }
        )
    } else if !shots.is_empty() || !transcript.is_empty() || object_detection_count > 0 {
        format!(
            "Partial source report for {}: cached bundle is missing, but cached annotation-derived signals were reused where available.",
            asset.name
        )
    } else {
        format!(
            "Partial source report for {}: metadata is available, but no cached analysis bundle was found.",
            asset.name
        )
    };
    let asset_kind = format!("{:?}", asset.kind).to_lowercase();
    let coverage = json!({
        "shots": !shots.is_empty(),
        "transcript": !transcript.is_empty(),
        "audio": audio_profile.is_some(),
        "segments": !segments.is_empty(),
        "visual": !frame_analysis.is_empty(),
        "annotation": annotation.is_some(),
    });

    let report = json!({
        "reportVersion": "1.0",
        "assetId": asset_id,
        "assetName": asset.name,
        "assetKind": asset_kind.clone(),
        "assetUri": asset.uri,
        "generatedAt": generated_at,
        "analyzedAt": analyzed_at,
        "bundleSource": bundle_source,
        "summary": summary,
        "coverage": coverage.clone(),
        "metadata": {
            "durationSec": duration_sec.map(round_to),
            "durationLabel": format_duration_label(duration_sec),
            "width": width,
            "height": height,
            "fps": fps.map(round_to),
            "codec": codec,
            "hasAudio": bundle.as_ref().map(|cached| cached.metadata.has_audio).unwrap_or(asset.audio.is_some()),
            "hasVideoStream": asset.video.is_some(),
            "hasAudioStream": asset.audio.is_some(),
            "onTimeline": timeline_clip_count > 0,
            "timelineClipCount": timeline_clip_count,
        },
        "shots": {
            "count": shots.len(),
            "averageDurationSec": if shot_durations.is_empty() { None } else { Some(round_to(total_shot_duration / shot_durations.len() as f64)) },
            "minDurationSec": shot_durations.iter().cloned().reduce(f64::min).map(round_to),
            "maxDurationSec": shot_durations.iter().cloned().reduce(f64::max).map(round_to),
            "firstShots": shots.iter().take(8).enumerate().map(|(index, shot)| json!({
                "index": index,
                "startSec": round_to(shot.start_sec),
                "endSec": round_to(shot.end_sec),
                "durationSec": round_to((shot.end_sec - shot.start_sec).max(0.0)),
                "confidence": round_to(shot.confidence),
                "keyframePath": shot.keyframe_path,
                "keyframeSelectionMethod": shot.keyframe_selection_method,
            })).collect::<Vec<_>>(),
        },
        "transcript": {
            "segmentCount": transcript.len(),
            "wordCount": transcript_word_count,
            "speakerCount": speaker_count,
            "speakerTurnCount": speaker_turn_count,
            "languages": transcript_languages,
            "excerpt": build_transcript_excerpt(&transcript),
            "firstSegments": transcript.iter().take(8).enumerate().map(|(index, segment)| json!({
                "index": index,
                "startSec": round_to(segment.start_sec),
                "endSec": round_to(segment.end_sec),
                "text": segment.text,
                "confidence": round_to(segment.confidence),
                "speakerId": segment.speaker_id,
                "speakerTurnId": segment.speaker_turn_id,
            })).collect::<Vec<_>>(),
        },
        "audio": {
            "hasAudioProfile": audio_profile.is_some(),
            "bpm": audio_profile.as_ref().and_then(|profile| profile.bpm.map(round_to)),
            "peakDb": audio_profile.as_ref().map(|profile| round_to(profile.peak_db)),
            "spectralCentroidHz": audio_profile.as_ref().map(|profile| round_to(profile.spectral_centroid_hz)),
            "silenceRegionCount": silence_region_count,
            "silenceDurationSec": round_to(silence_duration_sec),
            "silenceSharePercent": duration_sec.filter(|value| *value > 0.0).map(|value| round_to(silence_duration_sec / value * 100.0)).unwrap_or(0.0),
            "speechRegionCount": speech_regions.len(),
            "speechDurationSec": round_to(speech_duration_sec),
            "speechSharePercent": duration_sec.filter(|value| *value > 0.0).map(|value| round_to(speech_duration_sec / value * 100.0)).unwrap_or(0.0),
            "longestSpeechRegionSec": speech_regions.iter().map(|region| region.end_sec - region.start_sec).reduce(f64::max).map(round_to),
            "longestSilenceRegionSec": silence_regions.iter().map(|region| region.end_sec - region.start_sec).reduce(f64::max).map(round_to),
            "firstSpeechRegions": speech_regions.iter().take(6).enumerate().map(|(index, region)| json!({
                "index": index,
                "startSec": round_to(region.start_sec),
                "endSec": round_to(region.end_sec),
                "durationSec": round_to((region.end_sec - region.start_sec).max(0.0)),
            })).collect::<Vec<_>>(),
            "loudnessSampleCount": audio_profile.as_ref().map(|profile| profile.loudness_profile.len()).unwrap_or(0),
        },
        "segments": {
            "count": segments.len(),
            "distribution": segment_distribution_json,
            "firstSegments": segments.iter().take(8).enumerate().map(|(index, segment)| json!({
                "index": index,
                "type": segment.segment_type,
                "startSec": round_to(segment.start_sec),
                "endSec": round_to(segment.end_sec),
                "durationSec": round_to((segment.end_sec - segment.start_sec).max(0.0)),
                "confidence": round_to(segment.confidence),
            })).collect::<Vec<_>>(),
        },
        "visual": {
            "sampleCount": frame_analysis.len(),
            "averageComplexity": if frame_analysis.is_empty() { None } else { Some(round_to(frame_analysis.iter().map(|entry| entry.visual_complexity).sum::<f64>() / frame_analysis.len() as f64)) },
            "topCameraAngles": top_camera_angles_json,
            "topMotionDirections": top_motion_directions_json,
            "contactSheet": contact_sheet.as_ref().map(|sheet| json!({
                "path": sheet.path,
                "frameCount": sheet.frame_count,
                "columns": sheet.columns,
                "rows": sheet.rows,
            })),
        },
        "moments": {
            "count": moments_count,
            "items": moments_json,
        },
        "chapters": {
            "count": chapters_count,
            "items": chapters_json,
        },
        "highlights": {
            "count": highlights_count,
            "items": highlights_json,
        },
        "speakerTurns": {
            "count": speaker_turn_count,
            "items": speaker_turns_json,
        },
        "annotations": {
            "availableTypes": annotation_available_types,
            "providers": annotation_providers,
            "objectDetectionCount": object_detection_count,
            "faceDetectionCount": face_detection_count,
            "ocrTextCount": ocr_text_count,
            "topObjectLabels": top_object_labels_json,
            "ocrPreview": ocr_preview,
            "updatedAt": annotation.as_ref().and_then(|value| value.get("updatedAt")).and_then(Value::as_str),
        },
        "warnings": warnings,
        "errors": bundle.as_ref().map(|cached| cached.errors.clone()).unwrap_or_default(),
        "markdown": build_markdown(
            asset.name.as_str(),
            asset_id,
            bundle_source,
            &generated_at,
            &coverage,
            &asset_kind,
            &summary,
            &format_duration_label(duration_sec),
            width,
            height,
            fps.map(round_to),
            codec.as_deref(),
            bundle.as_ref().map(|cached| cached.metadata.has_audio).unwrap_or(asset.audio.is_some()),
            shots.len(),
            if shot_durations.is_empty() { None } else { Some(round_to(total_shot_duration / shot_durations.len() as f64)) },
            shot_durations.iter().cloned().reduce(f64::min).map(round_to),
            shot_durations.iter().cloned().reduce(f64::max).map(round_to),
            transcript.len(),
            transcript_word_count,
            speaker_count,
            speaker_turn_count,
            &transcript_languages,
            build_transcript_excerpt(&transcript).as_deref(),
            audio_profile.as_ref().and_then(|profile| profile.bpm.map(round_to)),
            audio_profile.as_ref().map(|profile| round_to(profile.peak_db)),
            audio_profile.as_ref().map(|profile| round_to(profile.spectral_centroid_hz)),
            silence_region_count,
            round_to(silence_duration_sec),
            speech_regions.len(),
            round_to(speech_duration_sec),
            duration_sec.filter(|value| *value > 0.0).map(|value| round_to(speech_duration_sec / value * 100.0)).unwrap_or(0.0),
            duration_sec.filter(|value| *value > 0.0).map(|value| round_to(silence_duration_sec / value * 100.0)).unwrap_or(0.0),
            speech_regions.iter().map(|region| region.end_sec - region.start_sec).reduce(f64::max).map(round_to),
            silence_regions.iter().map(|region| region.end_sec - region.start_sec).reduce(f64::max).map(round_to),
            &segment_distribution,
            frame_analysis.len(),
            if frame_analysis.is_empty() { None } else { Some(round_to(frame_analysis.iter().map(|entry| entry.visual_complexity).sum::<f64>() / frame_analysis.len() as f64)) },
            &top_camera_angles,
            &top_motion_directions,
            contact_sheet.as_ref(),
            &moments,
            &chapters,
            &highlights,
            &speaker_turns,
            &annotation_available_types,
            &annotation_providers,
            object_detection_count,
            face_detection_count,
            ocr_text_count,
            &top_object_labels,
            &ocr_preview,
            &warnings,
        ),
    });

    Ok(report)
}

fn count_asset_usage(project: &openreelio_core::ActiveProject, asset_id: &str) -> usize {
    project
        .state
        .sequences
        .values()
        .map(|sequence| {
            sequence
                .tracks
                .iter()
                .map(|track| {
                    track
                        .clips
                        .iter()
                        .filter(|clip| clip.asset_id == asset_id)
                        .count()
                })
                .sum::<usize>()
        })
        .sum()
}

fn load_cached_bundle(
    project_dir: &Path,
    asset_id: &str,
) -> anyhow::Result<Option<CachedAnalysisBundle>> {
    let path = project_dir
        .join(".openreelio")
        .join("analysis")
        .join(asset_id)
        .join("bundle.json");

    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path).map_err(|e| {
        anyhow::anyhow!("Failed to read analysis bundle '{}': {}", path.display(), e)
    })?;
    let bundle = serde_json::from_str::<CachedAnalysisBundle>(&content).map_err(|e| {
        anyhow::anyhow!(
            "Failed to deserialize analysis bundle '{}': {}",
            path.display(),
            e
        )
    })?;

    Ok(Some(bundle))
}

fn load_annotation(project_dir: &Path, asset_id: &str) -> anyhow::Result<Option<Value>> {
    let path = project_dir
        .join(".openreelio")
        .join("annotations")
        .join(format!("{}.json", asset_id));

    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("Failed to read annotation '{}': {}", path.display(), e))?;
    let annotation = serde_json::from_str::<Value>(&content).map_err(|e| {
        anyhow::anyhow!(
            "Failed to deserialize annotation '{}': {}",
            path.display(),
            e
        )
    })?;

    Ok(Some(annotation))
}

fn normalize_search_query(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn tokenize_search_query(text: &str) -> Vec<String> {
    normalize_search_query(text)
        .split(|ch: char| !ch.is_alphanumeric())
        .map(|token| token.trim().to_string())
        .filter(|token| token.len() >= 2)
        .collect()
}

fn value_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn score_search_fields(
    query: &str,
    query_tokens: &[String],
    fields: Vec<(&str, Vec<String>, f64)>,
) -> (f64, Vec<String>) {
    let mut score = 0.0;
    let mut why_matched = Vec::new();

    for (field, values, weight) in fields {
        let normalized_values = values
            .into_iter()
            .map(|value| normalize_search_query(&value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if normalized_values.is_empty() {
            continue;
        }

        let mut field_score = 0.0;
        if !query.is_empty() && normalized_values.iter().any(|value| value.contains(query)) {
            field_score += weight * 4.0;
        }

        let token_hits = query_tokens
            .iter()
            .filter(|token| {
                normalized_values
                    .iter()
                    .any(|value| value.contains(token.as_str()))
            })
            .count() as f64;
        if token_hits > 0.0 {
            field_score += token_hits * weight;
        }

        if field_score > 0.0 {
            score += field_score;
            why_matched.push(field.to_string());
        }
    }

    why_matched.sort();
    why_matched.dedup();
    (score, why_matched)
}

fn derive_select_query_intent(query: &str) -> (bool, bool, bool, bool) {
    let normalized = normalize_search_query(query);
    let tokens = tokenize_search_query(query);
    let contains_any = |terms: &[&str]| {
        terms
            .iter()
            .any(|term| normalized.contains(term) || tokens.iter().any(|token| token == term))
    };

    (
        contains_any(&[
            "interview",
            "question",
            "answer",
            "quote",
            "dialogue",
            "conversation",
            "spoken",
            "speech",
            "host",
            "guest",
            "narration",
            "talk",
        ]),
        contains_any(&[
            "pause", "silent", "silence", "quiet", "breath", "beat", "gap",
        ]),
        contains_any(&["b-roll", "broll", "visual", "shot", "crowd", "reaction"]),
        contains_any(&["quote", "line", "soundbite", "statement"]),
    )
}

fn rerank_source_library_matches(matches: Vec<Value>, query: &str) -> Vec<Value> {
    let (dialogue_intent, pause_intent, visual_intent, quote_intent) =
        derive_select_query_intent(query);

    let mut reranked = matches
        .into_iter()
        .map(|entry| {
            let mut object = entry.as_object().cloned().unwrap_or_default();
            let raw_score = object.get("score").and_then(Value::as_f64).unwrap_or(0.0);
            let mut score = raw_score;
            let mut ranking_notes = Vec::new();
            let section_type = object
                .get("sectionType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let duration_sec = object
                .get("metadata")
                .and_then(|value| value.get("durationSec"))
                .and_then(Value::as_f64)
                .unwrap_or_else(|| {
                    (object.get("endSec").and_then(Value::as_f64).unwrap_or(0.0)
                        - object
                            .get("startSec")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0))
                    .max(0.0)
                });
            let audio_cue = object
                .get("metadata")
                .and_then(|value| value.get("audioCue"))
                .and_then(Value::as_str);
            let on_timeline = object
                .get("onTimeline")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let timeline_clip_count = object
                .get("timelineClipCount")
                .and_then(Value::as_u64)
                .unwrap_or(0) as f64;

            if dialogue_intent {
                if section_type == "speakerTurns" {
                    score += 3.0;
                    ranking_notes.push("dialogue query prefers speaker turns".to_string());
                }
                if audio_cue == Some("speech-heavy") {
                    score += 1.5;
                    ranking_notes.push("speech-heavy moment".to_string());
                } else if audio_cue == Some("spoken content") {
                    score += 1.0;
                    ranking_notes.push("spoken content moment".to_string());
                }
            }

            if quote_intent && section_type == "speakerTurns" {
                score += 1.5;
                ranking_notes.push("quote query prefers coherent speaker turns".to_string());
            }

            if pause_intent {
                if audio_cue == Some("long pause") {
                    score += 3.0;
                    ranking_notes.push("pause query prefers long pauses".to_string());
                } else if audio_cue == Some("quiet gap") {
                    score += 2.5;
                    ranking_notes.push("pause query prefers quiet gaps".to_string());
                }
            } else if audio_cue == Some("long pause") {
                score -= 1.5;
                ranking_notes.push("long pause de-emphasized".to_string());
            } else if audio_cue == Some("quiet gap") {
                score -= 1.0;
                ranking_notes.push("quiet gap de-emphasized".to_string());
            }

            if !dialogue_intent && !pause_intent && visual_intent && section_type == "speakerTurns"
            {
                score -= 0.75;
                ranking_notes.push("visual query slightly de-emphasizes speaker turns".to_string());
            }

            if (3.0..=12.0).contains(&duration_sec) {
                score += 1.0;
                ranking_notes.push("usable select duration".to_string());
            } else if duration_sec < 1.0 {
                score -= 1.0;
                ranking_notes.push("too short for most selects".to_string());
            } else if duration_sec > 20.0 {
                score -= 1.0;
                ranking_notes.push("too long for most selects".to_string());
            }

            if !on_timeline {
                score += 0.5;
                ranking_notes.push("unused asset diversity bonus".to_string());
            }
            if timeline_clip_count > 0.0 {
                score -= (timeline_clip_count * 0.15).min(0.75);
            }

            object.insert("rawScore".to_string(), json!(round_to(raw_score)));
            object.insert("score".to_string(), json!(round_to(score)));
            object.insert("rankingNotes".to_string(), json!(ranking_notes));
            Value::Object(object)
        })
        .collect::<Vec<_>>();

    reranked.sort_by(|left, right| value_score(right).total_cmp(&value_score(left)));
    reranked
}

fn search_source_analysis_report_value(
    report: &Value,
    query: &str,
    sections: &[String],
    limit: usize,
) -> Vec<Value> {
    let normalized_query = normalize_search_query(query);
    let query_tokens = tokenize_search_query(query);
    let effective_sections = if sections.is_empty() {
        vec![
            "moments".to_string(),
            "chapters".to_string(),
            "highlights".to_string(),
        ]
    } else {
        sections.to_vec()
    };

    let mut matches = Vec::new();

    if effective_sections
        .iter()
        .any(|section| section == "moments")
    {
        for moment in report
            .get("moments")
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (score, why_matched) = score_search_fields(
                &normalized_query,
                &query_tokens,
                vec![
                    (
                        "summary",
                        vec![moment
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        3.0,
                    ),
                    (
                        "transcriptExcerpt",
                        vec![moment
                            .get("transcriptExcerpt")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        3.0,
                    ),
                    (
                        "audioCue",
                        vec![moment
                            .get("audioCue")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "topObjectLabels",
                        value_string_array(moment.get("topObjectLabels")),
                        2.0,
                    ),
                    (
                        "ocrTextPreview",
                        value_string_array(moment.get("ocrTextPreview")),
                        2.0,
                    ),
                    (
                        "dominantSegmentType",
                        vec![moment
                            .get("dominantSegmentType")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        1.0,
                    ),
                ],
            );
            if score <= 0.0 {
                continue;
            }

            matches.push(json!({
                "sectionType": "moments",
                "index": moment.get("index").and_then(Value::as_u64).unwrap_or(0),
                "startSec": moment.get("startSec").and_then(Value::as_f64).unwrap_or(0.0),
                "endSec": moment.get("endSec").and_then(Value::as_f64).unwrap_or(0.0),
                "score": round_to(score),
                "whyMatched": why_matched,
                "preview": moment.get("summary").and_then(Value::as_str).unwrap_or_default(),
                "keyframePath": moment.get("keyframePath").cloned().unwrap_or(Value::Null),
                "metadata": {
                    "audioCue": moment.get("audioCue").cloned().unwrap_or(Value::Null),
                    "durationSec": moment.get("durationSec").cloned().unwrap_or(Value::Null),
                    "dominantSegmentType": moment.get("dominantSegmentType").cloned().unwrap_or(Value::Null),
                },
            }));
        }
    }

    if effective_sections
        .iter()
        .any(|section| section == "chapters")
    {
        for chapter in report
            .get("chapters")
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (score, why_matched) = score_search_fields(
                &normalized_query,
                &query_tokens,
                vec![
                    (
                        "title",
                        vec![chapter
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        3.0,
                    ),
                    (
                        "summary",
                        vec![chapter
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "dominantSegmentType",
                        vec![chapter
                            .get("dominantSegmentType")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        1.0,
                    ),
                ],
            );
            if score <= 0.0 {
                continue;
            }

            matches.push(json!({
                "sectionType": "chapters",
                "index": chapter.get("index").and_then(Value::as_u64).unwrap_or(0),
                "startSec": chapter.get("startSec").and_then(Value::as_f64).unwrap_or(0.0),
                "endSec": chapter.get("endSec").and_then(Value::as_f64).unwrap_or(0.0),
                "score": round_to(score),
                "whyMatched": why_matched,
                "preview": format!("{} - {}", chapter.get("title").and_then(Value::as_str).unwrap_or_default(), chapter.get("summary").and_then(Value::as_str).unwrap_or_default()),
                "keyframePath": Value::Null,
                "metadata": {
                    "durationSec": chapter.get("durationSec").cloned().unwrap_or(Value::Null),
                    "dominantSegmentType": chapter.get("dominantSegmentType").cloned().unwrap_or(Value::Null),
                },
            }));
        }
    }

    if effective_sections
        .iter()
        .any(|section| section == "highlights")
    {
        for highlight in report
            .get("highlights")
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (score, why_matched) = score_search_fields(
                &normalized_query,
                &query_tokens,
                vec![
                    (
                        "reason",
                        vec![highlight
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "quote",
                        vec![highlight
                            .get("quote")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        3.0,
                    ),
                ],
            );
            if score <= 0.0 {
                continue;
            }

            matches.push(json!({
                "sectionType": "highlights",
                "index": highlight.get("index").and_then(Value::as_u64).unwrap_or(0),
                "startSec": highlight.get("startSec").and_then(Value::as_f64).unwrap_or(0.0),
                "endSec": highlight.get("endSec").and_then(Value::as_f64).unwrap_or(0.0),
                "score": round_to(score),
                "whyMatched": why_matched,
                "preview": highlight.get("quote").and_then(Value::as_str).unwrap_or_else(|| highlight.get("reason").and_then(Value::as_str).unwrap_or_default()),
                "keyframePath": Value::Null,
                "metadata": {
                    "durationSec": round_to((highlight.get("endSec").and_then(Value::as_f64).unwrap_or(0.0) - highlight.get("startSec").and_then(Value::as_f64).unwrap_or(0.0)).max(0.0)),
                },
            }));
        }
    }

    if effective_sections
        .iter()
        .any(|section| section == "speakerTurns")
    {
        for turn in report
            .get("speakerTurns")
            .and_then(|value| value.get("items"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (score, why_matched) = score_search_fields(
                &normalized_query,
                &query_tokens,
                vec![
                    (
                        "label",
                        vec![turn
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "excerpt",
                        vec![turn
                            .get("excerpt")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        3.0,
                    ),
                    (
                        "audioCue",
                        vec![turn
                            .get("audioCue")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "speakerId",
                        vec![turn
                            .get("speakerId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        2.0,
                    ),
                    (
                        "dominantSegmentType",
                        vec![turn
                            .get("dominantSegmentType")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()],
                        1.0,
                    ),
                ],
            );
            if score <= 0.0 {
                continue;
            }

            matches.push(json!({
                "sectionType": "speakerTurns",
                "index": turn.get("index").and_then(Value::as_u64).unwrap_or(0),
                "startSec": turn.get("startSec").and_then(Value::as_f64).unwrap_or(0.0),
                "endSec": turn.get("endSec").and_then(Value::as_f64).unwrap_or(0.0),
                "score": round_to(score),
                "whyMatched": why_matched,
                "preview": format!("{} - {}", turn.get("label").and_then(Value::as_str).unwrap_or_default(), turn.get("excerpt").and_then(Value::as_str).unwrap_or_default()),
                "keyframePath": Value::Null,
                "metadata": {
                    "audioCue": turn.get("audioCue").cloned().unwrap_or(Value::Null),
                    "durationSec": turn.get("durationSec").cloned().unwrap_or(Value::Null),
                    "speakerId": turn.get("speakerId").cloned().unwrap_or(Value::Null),
                    "wordCount": turn.get("wordCount").cloned().unwrap_or(Value::Null),
                    "segmentCount": turn.get("segmentCount").cloned().unwrap_or(Value::Null),
                    "dominantSegmentType": turn.get("dominantSegmentType").cloned().unwrap_or(Value::Null),
                },
            }));
        }
    }

    rerank_source_library_matches(matches, query)
        .into_iter()
        .take(limit.clamp(1, 50))
        .collect()
}

fn annotation_typed_results<T: DeserializeOwned>(annotation: Option<&Value>, key: &str) -> Vec<T> {
    annotation
        .and_then(|value| value.get("analysis"))
        .and_then(|analysis| analysis.get(key))
        .and_then(|entry| entry.get("results"))
        .cloned()
        .and_then(|results| serde_json::from_value::<Vec<T>>(results).ok())
        .unwrap_or_default()
}

fn round_to(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn format_duration_label(duration_sec: Option<f64>) -> String {
    let Some(duration_sec) = duration_sec.filter(|value| value.is_finite() && *value >= 0.0) else {
        return "unknown".to_string();
    };

    let total_seconds = duration_sec.round() as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        return format!("{}h {}m {}s", hours, minutes, seconds);
    }
    if minutes > 0 {
        return format!("{}m {}s", minutes, seconds);
    }

    format!("{}s", seconds)
}

fn build_transcript_excerpt(transcript: &[CachedTranscriptSegment]) -> Option<String> {
    let joined = transcript
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = joined.split_whitespace().collect::<Vec<_>>().join(" ");

    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= 240 {
        return Some(normalized);
    }

    let excerpt = normalized.chars().take(237).collect::<String>();
    Some(format!("{}...", excerpt.trim_end()))
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn format_timecode(time_sec: f64) -> String {
    let total_seconds = time_sec.max(0.0).floor() as u64;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;

    if hours > 0 {
        return format!("{:02}:{:02}:{:02}", hours, minutes, seconds);
    }

    format!("{:02}:{:02}", minutes, seconds)
}

fn build_label_from_text(text: &str, fallback: &str, max_words: usize) -> String {
    let normalized = normalize_text(text);
    if normalized.is_empty() {
        return fallback.to_string();
    }

    let words = normalized.split(' ').collect::<Vec<_>>();
    if words.len() <= max_words {
        return normalized;
    }

    format!(
        "{}...",
        words
            .into_iter()
            .take(max_words)
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn overlap_duration(left_start: f64, left_end: f64, right_start: f64, right_end: f64) -> f64 {
    (left_end.min(right_end) - left_start.max(right_start)).max(0.0)
}

fn count_overlapping_shots(shots: &[CachedShotResult], start_sec: f64, end_sec: f64) -> usize {
    shots
        .iter()
        .filter(|shot| overlap_duration(shot.start_sec, shot.end_sec, start_sec, end_sec) > 0.0)
        .count()
}

fn count_timed_events_in_range(events: &[f64], start_sec: f64, end_sec: f64) -> usize {
    events
        .iter()
        .filter(|time_sec| **time_sec >= start_sec && **time_sec <= end_sec)
        .count()
}

fn derive_speech_regions(
    explicit_speech_regions: &[CachedSpeechRegion],
    silence_regions: &[CachedSilenceRegion],
    duration_sec: Option<f64>,
) -> Vec<CachedSpeechRegion> {
    if !explicit_speech_regions.is_empty() {
        return explicit_speech_regions.to_vec();
    }

    let Some(duration_sec) = duration_sec.filter(|value| value.is_finite() && *value > 0.0) else {
        return Vec::new();
    };

    let mut sorted = silence_regions.to_vec();
    sorted.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));
    let mut speech_regions = Vec::new();
    let mut cursor_sec = 0.0;

    for region in sorted {
        let start_sec = region.start_sec.max(0.0).min(duration_sec);
        let end_sec = region.end_sec.max(start_sec).min(duration_sec);
        if start_sec > cursor_sec {
            speech_regions.push(CachedSpeechRegion {
                start_sec: cursor_sec,
                end_sec: start_sec,
            });
        }
        cursor_sec = cursor_sec.max(end_sec);
    }

    if cursor_sec < duration_sec {
        speech_regions.push(CachedSpeechRegion {
            start_sec: cursor_sec,
            end_sec: duration_sec,
        });
    }

    speech_regions
}

fn sum_overlap_duration<T>(
    ranges: &[T],
    start_sec: f64,
    end_sec: f64,
    project: impl Fn(&T) -> (f64, f64),
) -> f64 {
    ranges
        .iter()
        .map(|range| {
            let (range_start, range_end) = project(range);
            overlap_duration(range_start, range_end, start_sec, end_sec)
        })
        .sum()
}

fn build_audio_cue(
    speech_regions: &[CachedSpeechRegion],
    silence_regions: &[CachedSilenceRegion],
    start_sec: f64,
    end_sec: f64,
) -> Option<String> {
    let window_duration_sec = (end_sec - start_sec).max(0.0);
    if window_duration_sec <= 0.0 {
        return None;
    }

    let speech_duration_sec = sum_overlap_duration(speech_regions, start_sec, end_sec, |region| {
        (region.start_sec, region.end_sec)
    });
    let silence_duration_sec =
        sum_overlap_duration(silence_regions, start_sec, end_sec, |region| {
            (region.start_sec, region.end_sec)
        });
    let speech_share = speech_duration_sec / window_duration_sec;
    let silence_share = silence_duration_sec / window_duration_sec;

    if speech_share >= 0.75 {
        return Some("speech-heavy".to_string());
    }
    if silence_share >= 0.5 {
        return Some("long pause".to_string());
    }
    if speech_share > 0.15 {
        return Some("spoken content".to_string());
    }
    if silence_share > 0.15 {
        return Some("quiet gap".to_string());
    }

    None
}

fn ends_sentence(text: &str) -> bool {
    let trimmed = text
        .trim_end()
        .trim_end_matches(&['"', '\'', ')', ']', '}', '”', '’'][..]);
    trimmed.ends_with('.') || trimmed.ends_with('!') || trimmed.ends_with('?')
}

fn dominant_speech_region_index(
    speech_regions: &[CachedSpeechRegion],
    start_sec: f64,
    end_sec: f64,
) -> Option<usize> {
    speech_regions
        .iter()
        .enumerate()
        .map(|(index, region)| {
            (
                index,
                overlap_duration(region.start_sec, region.end_sec, start_sec, end_sec),
            )
        })
        .filter(|(_, overlap)| *overlap > 0.0)
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(index, _)| index)
}

fn build_speaker_turns(
    transcript: &[CachedTranscriptSegment],
    speech_regions: &[CachedSpeechRegion],
    silence_regions: &[CachedSilenceRegion],
    segments: &[CachedContentSegment],
) -> Vec<Value> {
    if transcript.is_empty() {
        return Vec::new();
    }

    let mut sorted = transcript.to_vec();
    sorted.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));
    let mut groups: Vec<Vec<CachedTranscriptSegment>> = Vec::new();
    let mut current: Vec<CachedTranscriptSegment> = Vec::new();
    let mut previous_speech_region_index: Option<usize> = None;

    for segment in sorted {
        let current_speech_region_index =
            dominant_speech_region_index(speech_regions, segment.start_sec, segment.end_sec);

        if current.is_empty() {
            current.push(segment);
            previous_speech_region_index = current_speech_region_index;
            continue;
        }

        let previous = current.last().expect("current turn should be non-empty");
        let gap_sec = (segment.start_sec - previous.end_sec).max(0.0);
        let explicit_turn_changed = match (
            previous.speaker_turn_id.as_ref(),
            segment.speaker_turn_id.as_ref(),
        ) {
            (Some(left), Some(right)) => Some(left != right),
            _ => None,
        };
        let speech_region_changed = previous_speech_region_index.is_some()
            && current_speech_region_index.is_some()
            && previous_speech_region_index != current_speech_region_index
            && gap_sec > 0.2;
        let should_split = explicit_turn_changed.unwrap_or(
            gap_sec > 1.0
                || speech_region_changed
                || (gap_sec > 0.35 && ends_sentence(&previous.text)),
        );

        if should_split {
            groups.push(current);
            current = vec![segment];
        } else {
            current.push(segment);
        }

        previous_speech_region_index = current_speech_region_index;
    }

    if !current.is_empty() {
        groups.push(current);
    }

    groups
        .into_iter()
        .enumerate()
        .map(|(index, group)| {
            let start_sec = group
                .first()
                .map(|segment| segment.start_sec)
                .unwrap_or(0.0);
            let end_sec = group
                .last()
                .map(|segment| segment.end_sec)
                .unwrap_or(start_sec);
            let dominant_segment_type = dominant_segment_type(segments, start_sec, end_sec);
            let audio_cue = build_audio_cue(speech_regions, silence_regions, start_sec, end_sec);
            let speaker_ids = unique_sorted_strings(
                group
                    .iter()
                    .filter_map(|segment| segment.speaker_id.clone())
                    .collect::<Vec<_>>(),
            );
            let speaker_id = if speaker_ids.len() == 1 {
                Some(speaker_ids[0].clone())
            } else {
                None
            };
            let word_count = group
                .iter()
                .map(|segment| {
                    normalize_text(&segment.text)
                        .split(' ')
                        .filter(|token| !token.is_empty())
                        .count()
                })
                .sum::<usize>();
            let excerpt = build_transcript_excerpt(&group)
                .unwrap_or_else(|| "No transcript excerpt available.".to_string());
            let turn_id = group
                .first()
                .and_then(|segment| segment.speaker_turn_id.clone())
                .unwrap_or_else(|| format!("turn_{:03}", index + 1));

            json!({
                "index": index,
                "turnId": turn_id,
                "label": speaker_id.clone().unwrap_or_else(|| format!("Turn {}", index + 1)),
                "speakerId": speaker_id,
                "startSec": round_to(start_sec),
                "endSec": round_to(end_sec),
                "durationSec": round_to((end_sec - start_sec).max(0.0)),
                "segmentCount": group.len(),
                "wordCount": word_count,
                "excerpt": excerpt,
                "audioCue": audio_cue,
                "dominantSegmentType": dominant_segment_type,
            })
        })
        .collect()
}

fn dominant_segment_type(
    segments: &[CachedContentSegment],
    start_sec: f64,
    end_sec: f64,
) -> Option<String> {
    let mut durations = BTreeMap::<String, f64>::new();

    for segment in segments {
        let overlap = overlap_duration(segment.start_sec, segment.end_sec, start_sec, end_sec);
        if overlap <= 0.0 {
            continue;
        }

        *durations.entry(segment.segment_type.clone()).or_insert(0.0) += overlap;
    }

    durations
        .into_iter()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(segment_type, _)| segment_type)
}

fn build_report_chapters(
    shots: &[CachedShotResult],
    transcript: &[CachedTranscriptSegment],
    segments: &[CachedContentSegment],
) -> Vec<Value> {
    if !transcript.is_empty() {
        let mut sorted = transcript.to_vec();
        sorted.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));
        let mut groups: Vec<Vec<CachedTranscriptSegment>> = Vec::new();
        let mut current: Vec<CachedTranscriptSegment> = Vec::new();

        for segment in sorted {
            if current.is_empty() {
                current.push(segment);
                continue;
            }

            let previous = current.last().expect("current group should be non-empty");
            let group_start_sec = current[0].start_sec;
            let gap_sec = (segment.start_sec - previous.end_sec).max(0.0);
            let chapter_duration_sec = segment.end_sec - group_start_sec;
            let current_type = dominant_segment_type(segments, group_start_sec, previous.end_sec);
            let next_type = dominant_segment_type(segments, segment.start_sec, segment.end_sec);
            let should_split = gap_sec > 6.0
                || chapter_duration_sec > 45.0
                || (gap_sec > 1.5
                    && current_type.is_some()
                    && next_type.is_some()
                    && current_type != next_type);

            if should_split {
                groups.push(current);
                current = vec![segment];
            } else {
                current.push(segment);
            }
        }

        if !current.is_empty() {
            groups.push(current);
        }

        return groups
            .into_iter()
            .enumerate()
            .map(|(index, group)| {
                let start_sec = group.first().map(|segment| segment.start_sec).unwrap_or(0.0);
                let end_sec = group.last().map(|segment| segment.end_sec).unwrap_or(start_sec);
                let dominant = dominant_segment_type(segments, start_sec, end_sec);
                json!({
                    "index": index,
                    "startSec": round_to(start_sec),
                    "endSec": round_to(end_sec),
                    "durationSec": round_to((end_sec - start_sec).max(0.0)),
                    "title": build_label_from_text(
                        &group.first().map(|segment| segment.text.clone()).unwrap_or_default(),
                        &dominant.clone().map(|value| format!("{} section {}", value, index + 1)).unwrap_or_else(|| format!("Section {}", index + 1)),
                        8,
                    ),
                    "summary": build_transcript_excerpt(&group).unwrap_or_else(|| "No transcript summary available.".to_string()),
                    "shotCount": count_overlapping_shots(shots, start_sec, end_sec),
                    "dominantSegmentType": dominant,
                })
            })
            .collect();
    }

    if !segments.is_empty() {
        return segments
            .iter()
            .take(12)
            .enumerate()
            .map(|(index, segment)| {
                json!({
                    "index": index,
                    "startSec": round_to(segment.start_sec),
                    "endSec": round_to(segment.end_sec),
                    "durationSec": round_to((segment.end_sec - segment.start_sec).max(0.0)),
                    "title": format!("{} section {}", segment.segment_type, index + 1),
                    "summary": format!("{} segment lasting {}.", segment.segment_type, format_duration_label(Some(segment.end_sec - segment.start_sec))),
                    "shotCount": count_overlapping_shots(shots, segment.start_sec, segment.end_sec),
                    "dominantSegmentType": segment.segment_type,
                })
            })
            .collect();
    }

    shots
        .chunks(5)
        .enumerate()
        .map(|(index, group)| {
            let start_sec = group.first().map(|shot| shot.start_sec).unwrap_or(0.0);
            let end_sec = group.last().map(|shot| shot.end_sec).unwrap_or(start_sec);
            json!({
                "index": index,
                "startSec": round_to(start_sec),
                "endSec": round_to(end_sec),
                "durationSec": round_to((end_sec - start_sec).max(0.0)),
                "title": format!("Shot block {}", index + 1),
                "summary": format!("{} shots grouped into one structural chapter.", group.len()),
                "shotCount": group.len(),
                "dominantSegmentType": Value::Null,
            })
        })
        .collect()
}

fn build_report_highlights(
    transcript: &[CachedTranscriptSegment],
    shots: &[CachedShotResult],
    segments: &[CachedContentSegment],
    object_times: &[f64],
    text_times: &[f64],
    chapters: &[Value],
) -> Vec<Value> {
    let mut sorted = transcript.to_vec();
    sorted.sort_by(|left, right| left.start_sec.total_cmp(&right.start_sec));

    let mut groups: Vec<Vec<CachedTranscriptSegment>> = Vec::new();
    let mut current: Vec<CachedTranscriptSegment> = Vec::new();

    for segment in sorted {
        if current.is_empty() {
            current.push(segment);
            continue;
        }

        let previous = current
            .last()
            .expect("current highlight block should be non-empty");
        let block_start_sec = current[0].start_sec;
        let gap_sec = (segment.start_sec - previous.end_sec).max(0.0);
        let next_duration_sec = segment.end_sec - block_start_sec;
        if gap_sec > 1.25 || next_duration_sec > 14.0 {
            groups.push(current);
            current = vec![segment];
        } else {
            current.push(segment);
        }
    }

    if !current.is_empty() {
        groups.push(current);
    }

    let mut candidates = groups
        .into_iter()
        .map(|group| {
            let start_sec = group
                .first()
                .map(|segment| segment.start_sec)
                .unwrap_or(0.0);
            let end_sec = group
                .last()
                .map(|segment| segment.end_sec)
                .unwrap_or(start_sec);
            let duration_sec = (end_sec - start_sec).max(0.5);
            let word_count = group
                .iter()
                .map(|segment| {
                    normalize_text(&segment.text)
                        .split(' ')
                        .filter(|token| !token.is_empty())
                        .count()
                })
                .sum::<usize>();
            let dialogue_density = word_count as f64 / duration_sec;
            let shot_count = count_overlapping_shots(shots, start_sec, end_sec);
            let object_count = count_timed_events_in_range(object_times, start_sec, end_sec);
            let ocr_count = count_timed_events_in_range(text_times, start_sec, end_sec);
            let dominant = dominant_segment_type(segments, start_sec, end_sec);

            let mut score = (word_count.min(24) as f64) * 0.45 + dialogue_density.min(6.0) * 1.6;
            score += (shot_count.min(5) as f64) * 0.75;
            score += (object_count.min(3) as f64) * 0.75;
            score += (ocr_count.min(2) as f64) * 0.75;
            if (2.0..=12.0).contains(&duration_sec) {
                score += 1.0;
            }
            if matches!(dominant.as_deref(), Some("talk") | Some("performance")) {
                score += 1.2;
            }

            let mut reason_parts = vec!["dense spoken content".to_string()];
            if shot_count >= 2 {
                reason_parts.push(format!("{} overlapping shots", shot_count));
            }
            if object_count > 0 {
                reason_parts.push("object activity".to_string());
            }
            if ocr_count > 0 {
                reason_parts.push("on-screen text".to_string());
            }
            if let Some(dominant) = dominant {
                reason_parts.push(format!("{} section", dominant));
            }

            json!({
                "startSec": start_sec,
                "endSec": end_sec,
                "reason": reason_parts.join(", "),
                "quote": build_transcript_excerpt(&group),
                "score": round_to(score),
            })
        })
        .collect::<Vec<_>>();

    candidates.sort_by(|left, right| {
        let left_score = left.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        let right_score = right.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        right_score.total_cmp(&left_score)
    });

    let mut selected = Vec::new();
    for candidate in candidates {
        let candidate_start = candidate
            .get("startSec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let candidate_end = candidate
            .get("endSec")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let overlaps_existing = selected.iter().any(|existing: &Value| {
            let existing_start = existing
                .get("startSec")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let existing_end = existing
                .get("endSec")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            overlap_duration(existing_start, existing_end, candidate_start, candidate_end) > 1.0
        });
        if overlaps_existing {
            continue;
        }

        selected.push(candidate);
        if selected.len() >= 5 {
            break;
        }
    }

    if selected.is_empty() {
        selected = chapters
            .iter()
            .take(3)
            .map(|chapter| {
                let start_sec = chapter.get("startSec").and_then(Value::as_f64).unwrap_or(0.0);
                let end_sec = chapter.get("endSec").and_then(Value::as_f64).unwrap_or(start_sec);
                let shot_count = chapter.get("shotCount").and_then(Value::as_u64).unwrap_or(0) as f64;
                let dominant = chapter
                    .get("dominantSegmentType")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                json!({
                    "startSec": start_sec,
                    "endSec": end_sec,
                    "reason": dominant.map(|value| format!("{} structural chapter", value)).unwrap_or_else(|| "structural chapter".to_string()),
                    "quote": chapter.get("summary").and_then(Value::as_str),
                    "score": round_to(3.0 + shot_count * 0.5),
                })
            })
            .collect();
    }

    selected
        .into_iter()
        .enumerate()
        .map(|(index, mut highlight)| {
            if let Some(map) = highlight.as_object_mut() {
                map.insert("index".to_string(), json!(index));
                map.insert(
                    "startSec".to_string(),
                    json!(round_to(
                        map.get("startSec").and_then(Value::as_f64).unwrap_or(0.0)
                    )),
                );
                map.insert(
                    "endSec".to_string(),
                    json!(round_to(
                        map.get("endSec").and_then(Value::as_f64).unwrap_or(0.0)
                    )),
                );
            }
            highlight
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_report_moments(
    shots: &[CachedShotResult],
    transcript: &[CachedTranscriptSegment],
    segments: &[CachedContentSegment],
    speech_regions: &[CachedSpeechRegion],
    silence_regions: &[CachedSilenceRegion],
    object_detections: &[CachedObjectDetection],
    face_detections: &[CachedFaceDetection],
    text_detections: &[CachedTextDetection],
) -> Vec<Value> {
    shots.iter()
        .enumerate()
        .map(|(index, shot)| {
            let overlapping_transcript = transcript
                .iter()
                .filter(|segment| {
                    overlap_duration(segment.start_sec, segment.end_sec, shot.start_sec, shot.end_sec)
                        > 0.0
                })
                .cloned()
                .collect::<Vec<_>>();
            let overlapping_objects = object_detections
                .iter()
                .filter(|entry| entry.time_sec >= shot.start_sec && entry.time_sec <= shot.end_sec)
                .collect::<Vec<_>>();
            let overlapping_faces = face_detections
                .iter()
                .filter(|entry| entry.time_sec >= shot.start_sec && entry.time_sec <= shot.end_sec)
                .count();
            let overlapping_text = text_detections
                .iter()
                .filter(|entry| entry.time_sec >= shot.start_sec && entry.time_sec <= shot.end_sec)
                .collect::<Vec<_>>();
            let transcript_excerpt = build_transcript_excerpt(&overlapping_transcript);
            let dominant_segment_type = dominant_segment_type(segments, shot.start_sec, shot.end_sec);
            let overlapping_speech_regions = speech_regions
                .iter()
                .filter(|region| {
                    overlap_duration(region.start_sec, region.end_sec, shot.start_sec, shot.end_sec)
                        > 0.0
                })
                .count();
            let overlapping_silence_regions = silence_regions
                .iter()
                .filter(|region| {
                    overlap_duration(region.start_sec, region.end_sec, shot.start_sec, shot.end_sec)
                        > 0.0
                })
                .count();
            let audio_cue = build_audio_cue(speech_regions, silence_regions, shot.start_sec, shot.end_sec);
            let top_object_labels = top_counts(
                overlapping_objects
                    .iter()
                    .flat_map(|entry| entry.labels.iter().cloned())
                    .collect::<Vec<_>>(),
                4,
            )
            .into_iter()
            .map(|(label, _)| label)
            .collect::<Vec<_>>();
            let ocr_text_preview = overlapping_text
                .iter()
                .map(|entry| normalize_text(&entry.text))
                .filter(|text| !text.is_empty())
                .take(3)
                .collect::<Vec<_>>();

            let mut summary_parts = Vec::new();
            if let Some(excerpt) = transcript_excerpt.clone() {
                summary_parts.push(excerpt);
            }
            if let Some(segment_type) = dominant_segment_type.clone() {
                summary_parts.push(format!("{} moment", segment_type));
            }
            if let Some(audio_cue) = audio_cue.clone() {
                summary_parts.push(audio_cue);
            }
            if !top_object_labels.is_empty() {
                summary_parts.push(format!("objects: {}", top_object_labels.join(", ")));
            }
            if !ocr_text_preview.is_empty() {
                summary_parts.push(format!("text: {}", ocr_text_preview.join(" | ")));
            }

            json!({
                "index": index,
                "startSec": round_to(shot.start_sec),
                "endSec": round_to(shot.end_sec),
                "durationSec": round_to((shot.end_sec - shot.start_sec).max(0.0)),
                "keyframePath": shot.keyframe_path,
                "transcriptExcerpt": transcript_excerpt,
                "dominantSegmentType": dominant_segment_type,
                "topObjectLabels": top_object_labels,
                "ocrTextPreview": ocr_text_preview,
                "audioCue": audio_cue,
                "speechRegionCount": overlapping_speech_regions,
                "silenceRegionCount": overlapping_silence_regions,
                "faceCount": overlapping_faces,
                "objectCount": overlapping_objects.len(),
                "summary": if summary_parts.is_empty() {
                    format!("Shot {} from {} to {}.", index + 1, format_timecode(shot.start_sec), format_timecode(shot.end_sec))
                } else {
                    summary_parts.join(" | ")
                },
            })
        })
        .collect()
}

fn unique_sorted_strings(values: Vec<String>) -> Vec<String> {
    let mut unique = values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    unique.sort();
    unique.dedup();
    unique
}

fn top_counts<I>(values: I, limit: usize) -> Vec<(String, usize)>
where
    I: IntoIterator<Item = String>,
{
    let mut counts = BTreeMap::<String, usize>::new();
    for value in values {
        let normalized = value.trim().to_string();
        if normalized.is_empty() {
            continue;
        }
        *counts.entry(normalized).or_insert(0) += 1;
    }

    let mut entries = counts.into_iter().collect::<Vec<_>>();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    entries.truncate(limit);
    entries
}

fn build_segment_distribution(
    segments: &[CachedContentSegment],
    total_duration_sec: Option<f64>,
) -> Vec<(String, usize, f64, f64)> {
    let mut stats = BTreeMap::<String, (usize, f64)>::new();
    for segment in segments {
        let entry = stats
            .entry(segment.segment_type.clone())
            .or_insert((0usize, 0.0));
        entry.0 += 1;
        entry.1 += (segment.end_sec - segment.start_sec).max(0.0);
    }

    let mut distribution = stats
        .into_iter()
        .map(|(label, (count, duration_sec))| {
            let share_percent = total_duration_sec
                .filter(|value| *value > 0.0)
                .map(|value| round_to(duration_sec / value * 100.0))
                .unwrap_or(0.0);
            (label, count, round_to(duration_sec), share_percent)
        })
        .collect::<Vec<_>>();
    distribution.sort_by(|left, right| right.2.total_cmp(&left.2));
    distribution
}

fn simple_count_entries_to_json(entries: Vec<(String, usize)>) -> Vec<Value> {
    entries
        .into_iter()
        .map(|(label, count)| json!({ "label": label, "count": count }))
        .collect()
}

fn segment_entries_to_json(entries: Vec<(String, usize, f64, f64)>) -> Vec<Value> {
    entries
        .into_iter()
        .map(|(label, count, duration_sec, share_percent)| {
            json!({
                "label": label,
                "count": count,
                "durationSec": duration_sec,
                "sharePercent": share_percent,
            })
        })
        .collect()
}

fn annotation_available_types(annotation: Option<&Value>) -> Vec<String> {
    let Some(analysis) = annotation.and_then(|value| value.get("analysis")) else {
        return Vec::new();
    };

    ["shots", "transcript", "objects", "faces", "textOcr"]
        .into_iter()
        .filter(|key| analysis.get(key).is_some())
        .map(ToString::to_string)
        .collect()
}

fn annotation_provider_labels(annotation: Option<&Value>) -> Vec<String> {
    let Some(analysis) = annotation.and_then(|value| value.get("analysis")) else {
        return Vec::new();
    };

    let mut providers = ["shots", "transcript", "objects", "faces", "textOcr"]
        .into_iter()
        .filter_map(|key| analysis.get(key))
        .filter_map(|entry| entry.get("provider"))
        .filter_map(provider_label)
        .collect::<Vec<_>>();
    providers.sort();
    providers.dedup();
    providers
}

fn provider_label(value: &Value) -> Option<String> {
    if let Some(label) = value.as_str() {
        return Some(label.to_string());
    }

    value
        .get("custom")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn annotation_results_len(annotation: Option<&Value>, key: &str) -> usize {
    annotation
        .and_then(|value| value.get("analysis"))
        .and_then(|analysis| analysis.get(key))
        .and_then(|entry| entry.get("results"))
        .and_then(Value::as_array)
        .map(|results| results.len())
        .unwrap_or(0)
}

fn annotation_object_labels(annotation: Option<&Value>) -> Vec<String> {
    annotation
        .and_then(|value| value.get("analysis"))
        .and_then(|analysis| analysis.get("objects"))
        .and_then(|entry| entry.get("results"))
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .filter_map(|result| result.get("labels"))
                .filter_map(Value::as_array)
                .flat_map(|labels| labels.iter().filter_map(Value::as_str))
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn annotation_ocr_preview(annotation: Option<&Value>) -> Vec<String> {
    annotation
        .and_then(|value| value.get("analysis"))
        .and_then(|analysis| analysis.get("textOcr"))
        .and_then(|entry| entry.get("results"))
        .and_then(Value::as_array)
        .map(|results| {
            results
                .iter()
                .filter_map(|result| result.get("text"))
                .filter_map(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .take(5)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn build_markdown(
    asset_name: &str,
    asset_id: &str,
    bundle_source: &str,
    generated_at: &str,
    coverage: &Value,
    asset_kind: &str,
    summary: &str,
    duration_label: &str,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    codec: Option<&str>,
    has_audio: bool,
    shot_count: usize,
    average_shot_duration: Option<f64>,
    min_shot_duration: Option<f64>,
    max_shot_duration: Option<f64>,
    transcript_segment_count: usize,
    transcript_word_count: usize,
    speaker_count: usize,
    speaker_turn_count: usize,
    transcript_languages: &[String],
    transcript_excerpt: Option<&str>,
    bpm: Option<f64>,
    peak_db: Option<f64>,
    spectral_centroid_hz: Option<f64>,
    silence_region_count: usize,
    silence_duration_sec: f64,
    speech_region_count: usize,
    speech_duration_sec: f64,
    speech_share_percent: f64,
    silence_share_percent: f64,
    longest_speech_region_sec: Option<f64>,
    longest_silence_region_sec: Option<f64>,
    segment_distribution: &[(String, usize, f64, f64)],
    visual_sample_count: usize,
    average_complexity: Option<f64>,
    top_camera_angles: &[(String, usize)],
    top_motion_directions: &[(String, usize)],
    contact_sheet: Option<&CachedContactSheet>,
    moments: &[Value],
    chapters: &[Value],
    highlights: &[Value],
    speaker_turns: &[Value],
    annotation_available_types: &[String],
    annotation_providers: &[String],
    object_detection_count: usize,
    face_detection_count: usize,
    ocr_text_count: usize,
    top_object_labels: &[(String, usize)],
    ocr_preview: &[String],
    warnings: &[String],
) -> String {
    let mut lines = vec![
        format!("# Source Analysis Report: {}", asset_name),
        String::new(),
        format!("- Asset ID: {}", asset_id),
        format!("- Bundle source: {}", bundle_source),
        format!("- Generated at: {}", generated_at),
        format!("- Summary: {}", summary),
        String::new(),
        "## File Info".to_string(),
        String::new(),
        format!("- Kind: {}", asset_kind),
        format!("- Duration: {}", duration_label),
        format!(
            "- Resolution: {} x {}",
            width
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            height
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!(
            "- FPS: {}",
            fps.map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!("- Codec: {}", codec.unwrap_or("unknown")),
        format!("- Audio stream: {}", if has_audio { "yes" } else { "no" }),
        String::new(),
        "## Coverage".to_string(),
        String::new(),
        format!(
            "- Shots: {}",
            if coverage["shots"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        format!(
            "- Transcript: {}",
            if coverage["transcript"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        format!(
            "- Audio profile: {}",
            if coverage["audio"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        format!(
            "- Segments: {}",
            if coverage["segments"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        format!(
            "- Visual analysis: {}",
            if coverage["visual"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        format!(
            "- Annotations: {}",
            if coverage["annotation"].as_bool().unwrap_or(false) {
                "available"
            } else {
                "missing"
            }
        ),
        String::new(),
        "## Shot Summary".to_string(),
        String::new(),
        format!("- Shot count: {}", shot_count),
        format!(
            "- Average duration: {}s",
            average_shot_duration
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!(
            "- Fastest shot: {}s",
            min_shot_duration
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
        format!(
            "- Longest shot: {}s",
            max_shot_duration
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        ),
    ];

    if transcript_segment_count > 0 {
        lines.extend([
            String::new(),
            "## Transcript Summary".to_string(),
            String::new(),
            format!("- Segment count: {}", transcript_segment_count),
            format!("- Estimated word count: {}", transcript_word_count),
            format!("- Speakers detected: {}", speaker_count),
            format!("- Speaker turns: {}", speaker_turn_count),
            format!(
                "- Languages: {}",
                if transcript_languages.is_empty() {
                    "unknown".to_string()
                } else {
                    transcript_languages.join(", ")
                }
            ),
        ]);
        if let Some(excerpt) = transcript_excerpt {
            lines.push(format!("- Excerpt: {}", excerpt));
        }
    }

    if !speaker_turns.is_empty() {
        lines.extend([String::new(), "## Speaker Turns".to_string(), String::new()]);
        for turn in speaker_turns.iter().take(8) {
            let start_sec = turn.get("startSec").and_then(Value::as_f64).unwrap_or(0.0);
            let end_sec = turn
                .get("endSec")
                .and_then(Value::as_f64)
                .unwrap_or(start_sec);
            let label = turn.get("label").and_then(Value::as_str).unwrap_or("Turn");
            let segment_count = turn
                .get("segmentCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let word_count = turn.get("wordCount").and_then(Value::as_u64).unwrap_or(0);
            let audio_cue = turn.get("audioCue").and_then(Value::as_str);
            lines.push(format!(
                "- {}-{} | {} | {} segments | {} words{}",
                format_timecode(start_sec),
                format_timecode(end_sec),
                label,
                segment_count,
                word_count,
                audio_cue
                    .map(|value| format!(" | {}", value))
                    .unwrap_or_default(),
            ));
            if let Some(excerpt) = turn.get("excerpt").and_then(Value::as_str) {
                lines.push(format!("- Excerpt: {}", excerpt));
            }
        }
        if speaker_turns.len() > 8 {
            lines.push(format!(
                "- ... {} more speaker turns omitted from Markdown preview",
                speaker_turns.len() - 8
            ));
        }
    }

    if !moments.is_empty() {
        lines.extend([String::new(), "## Moments".to_string(), String::new()]);
        for moment in moments.iter().take(12) {
            let start_sec = moment
                .get("startSec")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let end_sec = moment
                .get("endSec")
                .and_then(Value::as_f64)
                .unwrap_or(start_sec);
            let summary = moment
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("moment summary unavailable");
            lines.push(format!(
                "- {}-{} | {}",
                format_timecode(start_sec),
                format_timecode(end_sec),
                summary,
            ));
            if let Some(keyframe_path) = moment.get("keyframePath").and_then(Value::as_str) {
                lines.push(format!("- Keyframe: {}", keyframe_path));
            }
        }
        if moments.len() > 12 {
            lines.push(format!(
                "- ... {} more moments omitted from Markdown preview",
                moments.len() - 12
            ));
        }
    }

    if bpm.is_some() || peak_db.is_some() || spectral_centroid_hz.is_some() {
        lines.extend([
            String::new(),
            "## Audio Summary".to_string(),
            String::new(),
            format!(
                "- BPM: {}",
                bpm.map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            format!(
                "- Peak dB: {}",
                peak_db
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            format!(
                "- Spectral centroid: {} Hz",
                spectral_centroid_hz
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            format!("- Silence regions: {}", silence_region_count),
            format!("- Silence duration: {}s", silence_duration_sec),
            format!("- Silence share: {}%", silence_share_percent),
            format!("- Speech regions: {}", speech_region_count),
            format!("- Speech duration: {}s", speech_duration_sec),
            format!("- Speech share: {}%", speech_share_percent),
            format!(
                "- Longest speech region: {}s",
                longest_speech_region_sec
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            format!(
                "- Longest silence region: {}s",
                longest_silence_region_sec
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ]);
    }

    if !segment_distribution.is_empty() {
        lines.extend([String::new(), "## Segment Mix".to_string(), String::new()]);
        for (label, count, duration_sec, share_percent) in segment_distribution.iter().take(6) {
            lines.push(format!(
                "- {}: {} segments, {}s ({}%)",
                label, count, duration_sec, share_percent
            ));
        }
    }

    if visual_sample_count > 0 {
        lines.extend([
            String::new(),
            "## Visual Cues".to_string(),
            String::new(),
            format!("- Frame samples analyzed: {}", visual_sample_count),
            format!(
                "- Average complexity: {}",
                average_complexity
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ]);
        if !top_camera_angles.is_empty() {
            lines.push(format!(
                "- Dominant camera angles: {}",
                top_camera_angles
                    .iter()
                    .map(|(label, count)| format!("{} ({})", label, count))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !top_motion_directions.is_empty() {
            lines.push(format!(
                "- Dominant motion: {}",
                top_motion_directions
                    .iter()
                    .map(|(label, count)| format!("{} ({})", label, count))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }

    if let Some(contact_sheet) = contact_sheet {
        lines.extend([
            String::new(),
            "## Visual Artifacts".to_string(),
            String::new(),
            format!("- Contact sheet: {}", contact_sheet.path),
            format!(
                "- Layout: {} frames in {}x{} grid",
                contact_sheet.frame_count, contact_sheet.columns, contact_sheet.rows
            ),
        ]);
    }

    if !chapters.is_empty() {
        lines.extend([String::new(), "## Chapters".to_string(), String::new()]);
        for chapter in chapters {
            let start_sec = chapter
                .get("startSec")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let end_sec = chapter
                .get("endSec")
                .and_then(Value::as_f64)
                .unwrap_or(start_sec);
            let title = chapter
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Untitled chapter");
            let shot_count = chapter
                .get("shotCount")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let dominant_segment_type = chapter
                .get("dominantSegmentType")
                .and_then(Value::as_str)
                .map(ToString::to_string);
            lines.push(format!(
                "- {}-{} | {} | {} shots{}",
                format_timecode(start_sec),
                format_timecode(end_sec),
                title,
                shot_count,
                dominant_segment_type
                    .map(|value| format!(" | {}", value))
                    .unwrap_or_default(),
            ));
            if let Some(summary) = chapter.get("summary").and_then(Value::as_str) {
                lines.push(format!("- Summary: {}", summary));
            }
        }
    }

    if !highlights.is_empty() {
        lines.extend([
            String::new(),
            "## Candidate Highlights".to_string(),
            String::new(),
        ]);
        for highlight in highlights {
            let start_sec = highlight
                .get("startSec")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let end_sec = highlight
                .get("endSec")
                .and_then(Value::as_f64)
                .unwrap_or(start_sec);
            let score = highlight
                .get("score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let reason = highlight
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("candidate moment");
            lines.push(format!(
                "- {}-{} | score {} | {}",
                format_timecode(start_sec),
                format_timecode(end_sec),
                score,
                reason,
            ));
            if let Some(quote) = highlight.get("quote").and_then(Value::as_str) {
                lines.push(format!("- Quote: {}", quote));
            }
        }
    }

    if !annotation_available_types.is_empty() || object_detection_count > 0 {
        lines.extend([
            String::new(),
            "## Annotation Signals".to_string(),
            String::new(),
            format!(
                "- Available types: {}",
                annotation_available_types.join(", ")
            ),
            format!(
                "- Providers: {}",
                if annotation_providers.is_empty() {
                    "unknown".to_string()
                } else {
                    annotation_providers.join(", ")
                }
            ),
            format!("- Object detections: {}", object_detection_count),
            format!("- Face detections: {}", face_detection_count),
            format!("- OCR detections: {}", ocr_text_count),
        ]);
        if !top_object_labels.is_empty() {
            lines.push(format!(
                "- Top object labels: {}",
                top_object_labels
                    .iter()
                    .map(|(label, count)| format!("{} ({})", label, count))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !ocr_preview.is_empty() {
            lines.push(format!("- OCR preview: {}", ocr_preview.join(" | ")));
        }
    }

    if !warnings.is_empty() {
        lines.extend([String::new(), "## Warnings".to_string(), String::new()]);
        for warning in warnings {
            lines.push(format!("- {}", warning));
        }
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::{
        annotation_typed_results, build_report_chapters, build_report_highlights,
        build_report_moments, build_segment_distribution, build_transcript_excerpt,
        format_duration_label, normalize_search_sections, search_source_analysis_report_value,
        top_counts, CachedContentSegment, CachedFaceDetection, CachedObjectDetection,
        CachedShotResult, CachedSpeechRegion, CachedTextDetection, CachedTranscriptSegment,
    };
    use serde_json::{json, Value};

    #[test]
    fn format_duration_label_should_format_minutes_and_seconds() {
        assert_eq!(format_duration_label(Some(350.14)), "5m 50s");
        assert_eq!(format_duration_label(None), "unknown");
    }

    #[test]
    fn top_counts_should_sort_by_frequency_then_label() {
        let counts = top_counts(
            vec![
                "person".to_string(),
                "microphone".to_string(),
                "person".to_string(),
            ],
            5,
        );
        assert_eq!(counts[0], ("person".to_string(), 2));
        assert_eq!(counts[1], ("microphone".to_string(), 1));
    }

    #[test]
    fn build_transcript_excerpt_should_truncate_long_text() {
        let excerpt = build_transcript_excerpt(&[super::CachedTranscriptSegment {
            start_sec: 0.0,
            end_sec: 2.0,
            text: "hello".repeat(80),
            confidence: 0.9,
            language: Some("en".to_string()),
            speaker_id: None,
            speaker_turn_id: None,
        }])
        .expect("excerpt should exist");

        assert!(excerpt.ends_with("..."));
        assert!(excerpt.len() <= 240);
    }

    #[test]
    fn build_segment_distribution_should_compute_share_percent() {
        let distribution = build_segment_distribution(
            &[
                super::CachedContentSegment {
                    start_sec: 0.0,
                    end_sec: 5.0,
                    segment_type: "talk".to_string(),
                    confidence: 0.9,
                },
                super::CachedContentSegment {
                    start_sec: 5.0,
                    end_sec: 10.0,
                    segment_type: "talk".to_string(),
                    confidence: 0.9,
                },
            ],
            Some(20.0),
        );

        assert_eq!(distribution[0].0, "talk");
        assert_eq!(distribution[0].1, 2);
        assert_eq!(distribution[0].2, 10.0);
        assert_eq!(distribution[0].3, 50.0);
    }

    #[test]
    fn annotation_typed_results_should_deserialize_cached_shots() {
        let annotation = json!({
            "analysis": {
                "shots": {
                    "results": [
                        {
                            "startSec": 0.0,
                            "endSec": 4.0,
                            "confidence": 0.91,
                            "keyframePath": "shots/0001.jpg"
                        }
                    ]
                }
            }
        });

        let shots = annotation_typed_results::<CachedShotResult>(Some(&annotation), "shots");
        assert_eq!(shots.len(), 1);
        assert_eq!(shots[0].start_sec, 0.0);
        assert_eq!(shots[0].end_sec, 4.0);
    }

    #[test]
    fn build_report_chapters_and_highlights_should_return_structured_items() {
        let shots = vec![
            CachedShotResult {
                start_sec: 0.0,
                end_sec: 3.0,
                confidence: 0.9,
                keyframe_path: Some("shots/0001.jpg".to_string()),
                keyframe_selection_method: Some("thumbnail".to_string()),
            },
            CachedShotResult {
                start_sec: 3.0,
                end_sec: 8.0,
                confidence: 0.88,
                keyframe_path: Some("shots/0002.jpg".to_string()),
                keyframe_selection_method: Some("thumbnail".to_string()),
            },
        ];
        let transcript = vec![
            CachedTranscriptSegment {
                start_sec: 0.0,
                end_sec: 2.0,
                text: "Welcome back everyone".to_string(),
                confidence: 0.95,
                language: Some("en".to_string()),
                speaker_id: Some("speaker_1".to_string()),
                speaker_turn_id: Some("turn_001".to_string()),
            },
            CachedTranscriptSegment {
                start_sec: 2.2,
                end_sec: 4.5,
                text: "Tonight we have a special performance".to_string(),
                confidence: 0.95,
                language: Some("en".to_string()),
                speaker_id: Some("speaker_1".to_string()),
                speaker_turn_id: Some("turn_001".to_string()),
            },
        ];
        let segments = vec![CachedContentSegment {
            start_sec: 0.0,
            end_sec: 8.0,
            segment_type: "talk".to_string(),
            confidence: 0.9,
        }];

        let chapters = build_report_chapters(&shots, &transcript, &segments);
        let highlights =
            build_report_highlights(&transcript, &shots, &segments, &[1.0], &[2.5], &chapters);

        assert!(!chapters.is_empty());
        assert_eq!(chapters[0]["index"], 0);
        assert!(chapters[0]["title"]
            .as_str()
            .unwrap_or_default()
            .contains("Welcome"));
        assert!(!highlights.is_empty());
        assert_eq!(highlights[0]["index"], 0);
        assert!(highlights[0]["score"].as_f64().unwrap_or_default() > 0.0);
    }

    #[test]
    fn build_report_moments_should_merge_transcript_and_annotation_context() {
        let moments = build_report_moments(
            &[CachedShotResult {
                start_sec: 0.0,
                end_sec: 4.0,
                confidence: 0.9,
                keyframe_path: Some("shots/0001.jpg".to_string()),
                keyframe_selection_method: Some("thumbnail".to_string()),
            }],
            &[CachedTranscriptSegment {
                start_sec: 0.5,
                end_sec: 2.5,
                text: "Welcome to the show".to_string(),
                confidence: 0.95,
                language: Some("en".to_string()),
                speaker_id: Some("speaker_1".to_string()),
                speaker_turn_id: Some("turn_001".to_string()),
            }],
            &[CachedContentSegment {
                start_sec: 0.0,
                end_sec: 4.0,
                segment_type: "talk".to_string(),
                confidence: 0.9,
            }],
            &[CachedSpeechRegion {
                start_sec: 0.0,
                end_sec: 4.0,
            }],
            &[],
            &[CachedObjectDetection {
                time_sec: 1.0,
                labels: vec!["person".to_string(), "microphone".to_string()],
            }],
            &[CachedFaceDetection { time_sec: 1.2 }],
            &[CachedTextDetection {
                time_sec: 2.0,
                text: "LIVE".to_string(),
            }],
        );

        assert_eq!(moments.len(), 1);
        assert_eq!(moments[0]["keyframePath"], "shots/0001.jpg");
        assert_eq!(moments[0]["faceCount"], 1);
        assert_eq!(moments[0]["objectCount"], 1);
        assert!(moments[0]["summary"]
            .as_str()
            .unwrap_or_default()
            .contains("Welcome"));
    }

    #[test]
    fn search_source_analysis_report_value_should_rank_moment_matches() {
        let report = json!({
            "moments": {
                "items": [
                    {
                        "index": 0,
                        "startSec": 0.0,
                        "endSec": 4.0,
                        "summary": "Crowd cheer with stage text",
                        "transcriptExcerpt": "The crowd is cheering loudly",
                        "topObjectLabels": ["crowd", "person"],
                        "ocrTextPreview": ["CHEER"],
                        "dominantSegmentType": "performance",
                        "keyframePath": "shots/0001.jpg"
                    }
                ]
            },
            "chapters": { "items": [] },
            "highlights": { "items": [] }
        });

        let matches = search_source_analysis_report_value(
            &report,
            "crowd cheer",
            &["moments".to_string()],
            5,
        );

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["sectionType"], "moments");
        assert_eq!(matches[0]["keyframePath"], "shots/0001.jpg");
        assert!(matches[0]["score"].as_f64().unwrap_or_default() > 0.0);
    }

    #[test]
    fn normalize_search_sections_should_fallback_to_defaults_for_invalid_input() {
        let normalized = normalize_search_sections(&["invalid".to_string()]);
        assert_eq!(
            normalized,
            vec![
                "moments".to_string(),
                "chapters".to_string(),
                "highlights".to_string(),
                "speakerTurns".to_string()
            ]
        );
    }

    #[test]
    fn search_source_analysis_report_value_should_not_cap_results_at_twenty() {
        let report = json!({
            "moments": {
                "items": (0..25).map(|index| json!({
                    "index": index,
                    "startSec": index,
                    "endSec": index + 1,
                    "summary": format!("crowd cheer {}", index),
                    "transcriptExcerpt": Value::Null,
                    "topObjectLabels": [],
                    "ocrTextPreview": [],
                    "dominantSegmentType": "performance",
                    "keyframePath": Value::Null,
                })).collect::<Vec<_>>()
            },
            "chapters": { "items": [] },
            "highlights": { "items": [] }
        });

        let matches = search_source_analysis_report_value(
            &report,
            "crowd cheer",
            &["moments".to_string()],
            30,
        );

        assert_eq!(matches.len(), 25);
    }
}
