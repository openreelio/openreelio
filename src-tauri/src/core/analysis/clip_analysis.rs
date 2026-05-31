//! Timeline clip-level analysis and frame indexing.
//!
//! This module builds a cacheable analysis bundle for a single timeline clip.
//! It deliberately reuses the timeline model's playback mapping so speed,
//! reverse playback, freeze frames, and time remapping stay consistent with
//! edits and renders.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::assets::Asset;
use crate::core::ffmpeg::FFmpegRunner;
use crate::core::project::ProjectState;
use crate::core::timeline::{Clip, Sequence, Track};
use crate::core::{CoreError, CoreResult};

const CLIP_ANALYSIS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_REPRESENTATIVE_SAMPLE_COUNT: u32 = 5;
const DEFAULT_DENSE_INTERVAL_SEC: f64 = 0.25;
const DEFAULT_DENSE_MAX_SAMPLES: u32 = 48;
const MAX_ALLOWED_SAMPLES: u32 = 240;
const MIN_INTERVAL_SEC: f64 = 0.001;
const TIME_EPSILON: f64 = 1e-6;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipAnalysisMode {
    #[default]
    Representative,
    Dense,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisOptions {
    #[serde(default)]
    pub mode: ClipAnalysisMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_interval_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_samples: Option<u32>,
    #[serde(default = "default_include_edges")]
    pub include_edges: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_start_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_end_sec: Option<f64>,
    #[serde(default)]
    pub force_refresh: bool,
}

impl Default for ClipAnalysisOptions {
    fn default() -> Self {
        Self {
            mode: ClipAnalysisMode::Representative,
            target_interval_sec: None,
            max_samples: None,
            include_edges: default_include_edges(),
            range_start_sec: None,
            range_end_sec: None,
            force_refresh: false,
        }
    }
}

fn default_include_edges() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipSamplePolicy {
    pub mode: ClipAnalysisMode,
    pub target_interval_sec: f64,
    pub max_samples: u32,
    pub include_edges: bool,
    pub requested_timeline_start_sec: f64,
    pub requested_timeline_end_sec: f64,
    pub effective_timeline_start_sec: f64,
    pub effective_timeline_end_sec: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceRangeSummary {
    pub source_in_sec: f64,
    pub source_out_sec: f64,
    pub duration_sec: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRangeSummary {
    pub timeline_in_sec: f64,
    pub timeline_out_sec: f64,
    pub duration_sec: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipPlaybackSummary {
    pub speed: f64,
    pub reverse: bool,
    pub freeze_frame: bool,
    pub has_time_remap: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSourceMappingEntry {
    pub timeline_sec: f64,
    pub timeline_offset_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
    pub inside_clip: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FrameExtractionStatus {
    Ready,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameSampleSignals {
    pub clip_progress: f64,
    pub source_progress: f64,
    pub nearest_boundary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual_complexity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjacent_difference: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrameSample {
    pub sample_id: String,
    pub index: u32,
    pub timeline_sec: f64,
    pub timeline_offset_sec: f64,
    pub source_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
    pub image_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub sampling_reason: String,
    pub extraction_status: FrameExtractionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub signals: FrameSampleSignals,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisWindow {
    pub window_id: String,
    pub timeline_start_sec: f64,
    pub timeline_end_sec: f64,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub sample_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipAnalysisQualityStatus {
    Ready,
    Partial,
    Insufficient,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisQuality {
    pub status: ClipAnalysisQualityStatus,
    pub score: u32,
    pub critical_signals: Vec<String>,
    pub missing_signals: Vec<String>,
    pub degraded_signals: Vec<String>,
    pub recommended_actions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisBundle {
    pub schema_version: u32,
    pub fingerprint: String,
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    pub asset_id: String,
    pub asset_name: String,
    pub asset_hash: String,
    pub source_range: SourceRangeSummary,
    pub timeline_range: TimelineRangeSummary,
    pub playback: ClipPlaybackSummary,
    pub sample_policy: ClipSamplePolicy,
    pub mapping: Vec<TimelineSourceMappingEntry>,
    pub samples: Vec<FrameSample>,
    pub windows: Vec<ClipAnalysisWindow>,
    pub quality: ClipAnalysisQuality,
    pub artifact_dir: String,
    pub errors: Vec<String>,
    pub analyzed_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipAnalysisBundleSource {
    Cached,
    Generated,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisResponse {
    pub source: ClipAnalysisBundleSource,
    pub bundle: ClipAnalysisBundle,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnalysisTarget {
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
}

#[derive(Clone)]
pub struct ResolvedClipContext {
    pub sequence: Sequence,
    pub track: Track,
    pub clip: Clip,
    pub asset: Asset,
}

#[derive(Clone, Debug)]
struct PlannedFrameSample {
    timeline_sec: f64,
    reason: String,
}

pub fn resolve_asset_media_path(project_path: &Path, asset_path: &str) -> PathBuf {
    let path = PathBuf::from(asset_path);
    if path.is_absolute() {
        path
    } else {
        project_path.join(path)
    }
}

pub fn resolve_clip_context(
    state: &ProjectState,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
) -> CoreResult<ResolvedClipContext> {
    let sequence = state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.to_string()))?;
    let track = sequence
        .tracks
        .iter()
        .find(|track| track.id == track_id)
        .ok_or_else(|| CoreError::TrackNotFound(track_id.to_string()))?;
    let clip = track
        .clips
        .iter()
        .find(|clip| clip.id == clip_id)
        .ok_or_else(|| CoreError::ClipNotFound(clip_id.to_string()))?;

    if clip.is_adjustment_layer || clip.is_compound() {
        return Err(CoreError::ValidationError(format!(
            "Clip {} does not reference a directly inspectable media asset",
            clip_id
        )));
    }

    let asset = state
        .assets
        .get(&clip.asset_id)
        .ok_or_else(|| CoreError::AssetNotFound(clip.asset_id.clone()))?;

    Ok(ResolvedClipContext {
        sequence: sequence.clone(),
        track: track.clone(),
        clip: clip.clone(),
        asset: asset.clone(),
    })
}

pub fn resolve_clip_analysis_targets(
    state: &ProjectState,
    sequence_id: &str,
    track_id: Option<&str>,
    start_sec: f64,
    end_sec: f64,
) -> CoreResult<Vec<ClipAnalysisTarget>> {
    if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
        return Err(CoreError::InvalidTimeRange(start_sec, end_sec));
    }

    let sequence = state
        .sequences
        .get(sequence_id)
        .ok_or_else(|| CoreError::SequenceNotFound(sequence_id.to_string()))?;
    let mut targets = Vec::new();

    for track in &sequence.tracks {
        if track_id.is_some_and(|requested| requested != track.id) {
            continue;
        }
        if !track.is_video() || !track.visible {
            continue;
        }

        for clip in &track.clips {
            let clip_start = clip.place.timeline_in_sec;
            let clip_end = clip.place.timeline_out_sec();
            let overlaps = clip_start < end_sec && clip_end > start_sec;
            if overlaps && clip.enabled && !clip.is_adjustment_layer && !clip.is_compound() {
                targets.push(ClipAnalysisTarget {
                    sequence_id: sequence_id.to_string(),
                    track_id: track.id.clone(),
                    clip_id: clip.id.clone(),
                });
            }
        }
    }

    Ok(targets)
}

pub fn map_timeline_times_for_clip(
    state: &ProjectState,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    timeline_times: &[f64],
) -> CoreResult<Vec<TimelineSourceMappingEntry>> {
    let context = resolve_clip_context(state, sequence_id, track_id, clip_id)?;
    let fps = source_fps(&context.asset).or_else(|| sequence_fps(&context.sequence));
    Ok(build_timeline_source_mapping(
        &context.clip,
        fps,
        timeline_times,
    ))
}

pub fn build_timeline_source_mapping(
    clip: &Clip,
    fps: Option<f64>,
    timeline_times: &[f64],
) -> Vec<TimelineSourceMappingEntry> {
    timeline_times
        .iter()
        .map(|time| map_single_timeline_time(clip, fps, *time))
        .collect()
}

pub fn resolve_sample_policy(
    clip: &Clip,
    options: &ClipAnalysisOptions,
) -> CoreResult<ClipSamplePolicy> {
    let clip_start = clip.place.timeline_in_sec;
    let clip_end = clip.place.timeline_out_sec();

    if !clip_start.is_finite() || !clip_end.is_finite() || clip_end <= clip_start {
        return Err(CoreError::ValidationError(format!(
            "Clip {} has an invalid timeline range",
            clip.id
        )));
    }

    let requested_start = options.range_start_sec.unwrap_or(clip_start);
    let requested_end = options.range_end_sec.unwrap_or(clip_end);

    if !requested_start.is_finite() || !requested_end.is_finite() {
        return Err(CoreError::ValidationError(
            "Clip analysis range must use finite timeline seconds".to_string(),
        ));
    }
    if requested_end <= requested_start {
        return Err(CoreError::InvalidTimeRange(requested_start, requested_end));
    }

    let effective_start = requested_start.clamp(clip_start, clip_end);
    let effective_end = requested_end.clamp(clip_start, clip_end);
    if effective_end <= effective_start {
        return Err(CoreError::InvalidTimeRange(requested_start, requested_end));
    }

    let max_samples = options
        .max_samples
        .unwrap_or(match options.mode {
            ClipAnalysisMode::Representative => DEFAULT_REPRESENTATIVE_SAMPLE_COUNT,
            ClipAnalysisMode::Dense => DEFAULT_DENSE_MAX_SAMPLES,
        })
        .clamp(1, MAX_ALLOWED_SAMPLES);

    let target_interval_sec = match options.mode {
        ClipAnalysisMode::Representative => {
            let span = effective_end - effective_start;
            if max_samples <= 1 {
                span.max(MIN_INTERVAL_SEC)
            } else {
                (span / f64::from(max_samples - 1)).max(MIN_INTERVAL_SEC)
            }
        }
        ClipAnalysisMode::Dense => options
            .target_interval_sec
            .unwrap_or(DEFAULT_DENSE_INTERVAL_SEC)
            .clamp(MIN_INTERVAL_SEC, 60.0),
    };

    Ok(ClipSamplePolicy {
        mode: options.mode.clone(),
        target_interval_sec: round_time(target_interval_sec),
        max_samples,
        include_edges: options.include_edges,
        requested_timeline_start_sec: round_time(requested_start),
        requested_timeline_end_sec: round_time(requested_end),
        effective_timeline_start_sec: round_time(effective_start),
        effective_timeline_end_sec: round_time(effective_end),
    })
}

pub fn sample_clip_timeline_times(
    clip: &Clip,
    fps: Option<f64>,
    options: &ClipAnalysisOptions,
) -> CoreResult<(ClipSamplePolicy, Vec<TimelineSourceMappingEntry>)> {
    let policy = resolve_sample_policy(clip, options)?;
    let planned = plan_frame_samples(&policy, fps);
    let times = planned
        .iter()
        .map(|sample| sample.timeline_sec)
        .collect::<Vec<_>>();
    let mut mapping = build_timeline_source_mapping(clip, fps, &times);

    for (entry, planned_sample) in mapping.iter_mut().zip(planned) {
        entry.reason = planned_sample.reason;
    }

    Ok((policy, mapping))
}

pub async fn analyze_timeline_clip_bundle(
    project_path: &Path,
    state: &ProjectState,
    ffmpeg: &FFmpegRunner,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    options: ClipAnalysisOptions,
) -> CoreResult<ClipAnalysisResponse> {
    let context = resolve_clip_context(state, sequence_id, track_id, clip_id)?;
    let fps = source_fps(&context.asset).or_else(|| sequence_fps(&context.sequence));
    let (policy, mapping) = sample_clip_timeline_times(&context.clip, fps, &options)?;
    let fingerprint = build_clip_analysis_fingerprint(&context, &policy, &options);

    if !options.force_refresh {
        if let Some(bundle) = load_clip_analysis_bundle_optional(project_path, &fingerprint)? {
            return Ok(ClipAnalysisResponse {
                source: ClipAnalysisBundleSource::Cached,
                bundle,
            });
        }
    }

    let media_path = resolve_asset_media_path(project_path, &context.asset.uri);
    if !media_path.exists() {
        return Err(CoreError::FileNotFound(media_path.display().to_string()));
    }

    if context.asset.video.is_none() {
        return Err(CoreError::UnsupportedAssetFormat(format!(
            "Clip {} references asset {} without a video stream",
            clip_id, context.asset.id
        )));
    }

    let artifact_dir = clip_analysis_dir(project_path, &fingerprint);
    let frames_dir = artifact_dir.join("frames");
    tokio::fs::create_dir_all(&frames_dir).await?;

    let mut samples = Vec::new();
    let mut errors = Vec::new();

    for (index, entry) in mapping.iter().enumerate() {
        let source_sec = match entry.source_sec {
            Some(source_sec) => source_sec,
            None => {
                let error = format!(
                    "Timeline time {:.6}s is outside clip {} and cannot be sampled",
                    entry.timeline_sec, clip_id
                );
                errors.push(error);
                continue;
            }
        };

        let sample_id = format!("f{:04}", index + 1);
        let output_path = frames_dir.join(format!("{sample_id}.jpg"));
        let extraction_result = ffmpeg
            .extract_frame(&media_path, source_sec, &output_path)
            .await
            .map_err(|error| error.to_string());

        let (extraction_status, error) = match extraction_result {
            Ok(()) => (FrameExtractionStatus::Ready, None),
            Err(message) => {
                let full_message = format!(
                    "Failed to extract frame {} at source {:.6}s: {}",
                    sample_id, source_sec, message
                );
                errors.push(full_message.clone());
                (FrameExtractionStatus::Failed, Some(full_message))
            }
        };

        let video = context.asset.video.as_ref();
        samples.push(FrameSample {
            sample_id,
            index: index as u32,
            timeline_sec: entry.timeline_sec,
            timeline_offset_sec: entry.timeline_offset_sec,
            source_sec,
            frame_index: entry.frame_index,
            image_path: output_path.to_string_lossy().to_string(),
            width: video.map(|info| info.width),
            height: video.map(|info| info.height),
            sampling_reason: entry.reason.clone(),
            extraction_status,
            error,
            signals: build_sample_signals(&context.clip, source_sec, entry.timeline_sec),
        });
    }

    let windows = build_windows(&policy, &samples);
    let quality = build_quality(&samples, &errors);

    let bundle = ClipAnalysisBundle {
        schema_version: CLIP_ANALYSIS_SCHEMA_VERSION,
        fingerprint,
        sequence_id: sequence_id.to_string(),
        track_id: track_id.to_string(),
        clip_id: clip_id.to_string(),
        asset_id: context.asset.id.clone(),
        asset_name: context.asset.name.clone(),
        asset_hash: context.asset.hash.clone(),
        source_range: SourceRangeSummary {
            source_in_sec: round_time(context.clip.range.source_in_sec),
            source_out_sec: round_time(context.clip.range.source_out_sec),
            duration_sec: round_time(
                (context.clip.range.source_out_sec - context.clip.range.source_in_sec).max(0.0),
            ),
        },
        timeline_range: TimelineRangeSummary {
            timeline_in_sec: round_time(context.clip.place.timeline_in_sec),
            timeline_out_sec: round_time(context.clip.place.timeline_out_sec()),
            duration_sec: round_time(context.clip.place.duration_sec),
        },
        playback: ClipPlaybackSummary {
            speed: round_time(context.clip.safe_speed()),
            reverse: context.clip.reverse,
            freeze_frame: context.clip.freeze_frame,
            has_time_remap: context.clip.has_time_remap(),
        },
        sample_policy: policy,
        mapping,
        samples,
        windows,
        quality,
        artifact_dir: artifact_dir.to_string_lossy().to_string(),
        errors,
        analyzed_at: chrono::Utc::now().to_rfc3339(),
    };

    save_clip_analysis_bundle(project_path, &bundle)?;

    Ok(ClipAnalysisResponse {
        source: ClipAnalysisBundleSource::Generated,
        bundle,
    })
}

pub struct TimelineRangeSelection<'a> {
    pub sequence_id: &'a str,
    pub track_id: Option<&'a str>,
    pub start_sec: f64,
    pub end_sec: f64,
}

pub async fn inspect_timeline_range_bundles(
    project_path: &Path,
    state: &ProjectState,
    ffmpeg: &FFmpegRunner,
    selection: TimelineRangeSelection<'_>,
    mut options: ClipAnalysisOptions,
) -> CoreResult<Vec<ClipAnalysisResponse>> {
    let targets = resolve_clip_analysis_targets(
        state,
        selection.sequence_id,
        selection.track_id,
        selection.start_sec,
        selection.end_sec,
    )?;
    let mut responses = Vec::new();

    for target in targets {
        options.range_start_sec = Some(selection.start_sec);
        options.range_end_sec = Some(selection.end_sec);
        responses.push(
            analyze_timeline_clip_bundle(
                project_path,
                state,
                ffmpeg,
                &target.sequence_id,
                &target.track_id,
                &target.clip_id,
                options.clone(),
            )
            .await?,
        );
    }

    Ok(responses)
}

pub fn load_clip_analysis_bundle_optional(
    project_path: &Path,
    fingerprint: &str,
) -> CoreResult<Option<ClipAnalysisBundle>> {
    validate_fingerprint(fingerprint)?;
    let path = clip_analysis_bundle_path(project_path, fingerprint)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&path)?;
    let bundle = serde_json::from_str(&content)?;
    Ok(Some(bundle))
}

pub fn save_clip_analysis_bundle(
    project_path: &Path,
    bundle: &ClipAnalysisBundle,
) -> CoreResult<()> {
    validate_fingerprint(&bundle.fingerprint)?;
    let path = clip_analysis_bundle_path(project_path, &bundle.fingerprint)?;
    crate::core::fs::atomic_write_json_pretty(&path, bundle)
}

fn build_clip_analysis_fingerprint(
    context: &ResolvedClipContext,
    policy: &ClipSamplePolicy,
    options: &ClipAnalysisOptions,
) -> String {
    let basis = serde_json::json!({
        "schemaVersion": CLIP_ANALYSIS_SCHEMA_VERSION,
        "sequenceId": context.sequence.id,
        "trackId": context.track.id,
        "clipId": context.clip.id,
        "assetId": context.asset.id,
        "assetHash": context.asset.hash,
        "assetUri": context.asset.uri,
        "sourceInBits": context.clip.range.source_in_sec.to_bits(),
        "sourceOutBits": context.clip.range.source_out_sec.to_bits(),
        "timelineInBits": context.clip.place.timeline_in_sec.to_bits(),
        "timelineDurationBits": context.clip.place.duration_sec.to_bits(),
        "speedBits": context.clip.speed.to_bits(),
        "reverse": context.clip.reverse,
        "freezeFrame": context.clip.freeze_frame,
        "enabled": context.clip.enabled,
        "timeRemap": serde_json::to_value(&context.clip.time_remap)
            .unwrap_or(serde_json::Value::Null),
        "mode": clip_analysis_mode_key(&options.mode),
        "includeEdges": options.include_edges,
        "targetIntervalBits": options.target_interval_sec.map(f64::to_bits),
        "maxSamples": options.max_samples,
        "rangeStartBits": options.range_start_sec.map(f64::to_bits),
        "rangeEndBits": options.range_end_sec.map(f64::to_bits),
        "resolvedTargetIntervalBits": policy.target_interval_sec.to_bits(),
        "resolvedMaxSamples": policy.max_samples,
    });

    format!("clip_{:016x}", stable_hash64(basis.to_string().as_bytes()))
}

fn clip_analysis_mode_key(mode: &ClipAnalysisMode) -> &'static str {
    match mode {
        ClipAnalysisMode::Representative => "representative",
        ClipAnalysisMode::Dense => "dense",
    }
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn clip_analysis_dir(project_path: &Path, fingerprint: &str) -> PathBuf {
    project_path
        .join(".openreelio")
        .join("analysis")
        .join("clips")
        .join(fingerprint)
}

fn clip_analysis_bundle_path(project_path: &Path, fingerprint: &str) -> CoreResult<PathBuf> {
    validate_fingerprint(fingerprint)?;
    Ok(clip_analysis_dir(project_path, fingerprint).join("bundle.json"))
}

fn validate_fingerprint(fingerprint: &str) -> CoreResult<()> {
    if fingerprint.is_empty() {
        return Err(CoreError::ValidationError(
            "Clip analysis fingerprint must not be empty".to_string(),
        ));
    }
    if !fingerprint
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(CoreError::ValidationError(format!(
            "Clip analysis fingerprint contains unsafe characters: {}",
            fingerprint
        )));
    }
    Ok(())
}

fn map_single_timeline_time(
    clip: &Clip,
    fps: Option<f64>,
    timeline_sec: f64,
) -> TimelineSourceMappingEntry {
    let clip_start = clip.place.timeline_in_sec;
    let clip_end = clip.place.timeline_out_sec();
    let timeline_offset_sec = round_time(timeline_sec - clip_start);

    if !timeline_sec.is_finite() {
        return TimelineSourceMappingEntry {
            timeline_sec,
            timeline_offset_sec,
            source_sec: None,
            frame_index: None,
            inside_clip: false,
            reason: "invalidTimelineTime".to_string(),
        };
    }

    if timeline_sec < clip_start {
        return TimelineSourceMappingEntry {
            timeline_sec: round_time(timeline_sec),
            timeline_offset_sec,
            source_sec: None,
            frame_index: None,
            inside_clip: false,
            reason: "beforeClipStart".to_string(),
        };
    }

    if timeline_sec >= clip_end {
        return TimelineSourceMappingEntry {
            timeline_sec: round_time(timeline_sec),
            timeline_offset_sec,
            source_sec: None,
            frame_index: None,
            inside_clip: false,
            reason: "atOrAfterClipEnd".to_string(),
        };
    }

    let source_sec = clamp_source_for_frame(clip, clip.timeline_to_source(timeline_sec), fps);

    TimelineSourceMappingEntry {
        timeline_sec: round_time(timeline_sec),
        timeline_offset_sec,
        source_sec: Some(round_time(source_sec)),
        frame_index: source_to_frame_index(source_sec, fps),
        inside_clip: true,
        reason: "requested".to_string(),
    }
}

fn plan_frame_samples(policy: &ClipSamplePolicy, fps: Option<f64>) -> Vec<PlannedFrameSample> {
    let start = policy.effective_timeline_start_sec;
    let end = policy.effective_timeline_end_sec;
    let max_samples = policy.max_samples as usize;
    let last_inside = last_inside_time(start, end, fps);

    let mut samples = Vec::new();
    match policy.mode {
        ClipAnalysisMode::Representative => {
            if max_samples == 1 {
                push_unique_sample(
                    &mut samples,
                    (start + last_inside) / 2.0,
                    "representativeMidpoint",
                );
            } else if policy.include_edges {
                for index in 0..max_samples {
                    let ratio = index as f64 / (max_samples - 1) as f64;
                    let time = start + (last_inside - start) * ratio;
                    let reason = if index == 0 {
                        "leadingEdge"
                    } else if index == max_samples - 1 {
                        "trailingEdge"
                    } else if (ratio - 0.5).abs() < 0.001 {
                        "representativeMidpoint"
                    } else {
                        "representativeInterval"
                    };
                    push_unique_sample(&mut samples, time, reason);
                }
            } else {
                for index in 0..max_samples {
                    let ratio = (index + 1) as f64 / (max_samples + 1) as f64;
                    push_unique_sample(
                        &mut samples,
                        start + (last_inside - start) * ratio,
                        "representativeInterior",
                    );
                }
            }
        }
        ClipAnalysisMode::Dense => {
            if policy.include_edges {
                push_unique_sample(&mut samples, start, "leadingEdge");
            }

            let mut time = if policy.include_edges {
                start + policy.target_interval_sec
            } else {
                start
            };
            while time < end && samples.len() < max_samples {
                push_unique_sample(&mut samples, time.min(last_inside), "denseInterval");
                time += policy.target_interval_sec;
            }

            if policy.include_edges && samples.len() < max_samples {
                push_unique_sample(&mut samples, last_inside, "trailingEdge");
            }
        }
    }

    samples.truncate(max_samples);
    samples
}

fn push_unique_sample(samples: &mut Vec<PlannedFrameSample>, timeline_sec: f64, reason: &str) {
    let rounded = round_time(timeline_sec);
    if samples
        .iter()
        .any(|sample| (sample.timeline_sec - rounded).abs() <= TIME_EPSILON)
    {
        return;
    }
    samples.push(PlannedFrameSample {
        timeline_sec: rounded,
        reason: reason.to_string(),
    });
}

fn last_inside_time(start: f64, end: f64, fps: Option<f64>) -> f64 {
    let epsilon = fps
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .map(|fps| (0.5 / fps).clamp(TIME_EPSILON, 0.01))
        .unwrap_or(0.001);
    (end - epsilon).max(start)
}

fn clamp_source_for_frame(clip: &Clip, source_sec: f64, fps: Option<f64>) -> f64 {
    let source_in = clip.range.source_in_sec;
    let source_out = clip.range.source_out_sec;
    if source_out <= source_in {
        return source_in;
    }

    let epsilon = fps
        .filter(|fps| fps.is_finite() && *fps > 0.0)
        .map(|fps| (0.5 / fps).clamp(TIME_EPSILON, 0.01))
        .unwrap_or(0.001);
    source_sec.clamp(source_in, (source_out - epsilon).max(source_in))
}

fn build_sample_signals(clip: &Clip, source_sec: f64, timeline_sec: f64) -> FrameSampleSignals {
    let timeline_duration = clip.place.duration_sec.max(TIME_EPSILON);
    let source_duration = (clip.range.source_out_sec - clip.range.source_in_sec).max(TIME_EPSILON);
    let clip_progress =
        ((timeline_sec - clip.place.timeline_in_sec) / timeline_duration).clamp(0.0, 1.0);
    let source_progress =
        ((source_sec - clip.range.source_in_sec) / source_duration).clamp(0.0, 1.0);
    let nearest_boundary = if clip_progress <= 0.2 {
        "start"
    } else if clip_progress >= 0.8 {
        "end"
    } else {
        "middle"
    };

    FrameSampleSignals {
        clip_progress: round_time(clip_progress),
        source_progress: round_time(source_progress),
        nearest_boundary: nearest_boundary.to_string(),
        visual_complexity: None,
        adjacent_difference: None,
    }
}

fn build_windows(policy: &ClipSamplePolicy, samples: &[FrameSample]) -> Vec<ClipAnalysisWindow> {
    if samples.is_empty() {
        return Vec::new();
    }

    let source_start = samples
        .iter()
        .map(|sample| sample.source_sec)
        .fold(f64::INFINITY, f64::min);
    let source_end = samples
        .iter()
        .map(|sample| sample.source_sec)
        .fold(f64::NEG_INFINITY, f64::max);

    vec![ClipAnalysisWindow {
        window_id: "requestedRange".to_string(),
        timeline_start_sec: policy.effective_timeline_start_sec,
        timeline_end_sec: policy.effective_timeline_end_sec,
        source_start_sec: round_time(source_start),
        source_end_sec: round_time(source_end),
        sample_ids: samples
            .iter()
            .map(|sample| sample.sample_id.clone())
            .collect(),
    }]
}

fn build_quality(samples: &[FrameSample], errors: &[String]) -> ClipAnalysisQuality {
    let ready_count = samples
        .iter()
        .filter(|sample| sample.extraction_status == FrameExtractionStatus::Ready)
        .count();
    let failed_count = samples.len().saturating_sub(ready_count);
    let mut critical_signals = Vec::new();
    let mut missing_signals = Vec::new();
    let mut degraded_signals = Vec::new();
    let mut recommended_actions = Vec::new();

    if !samples.is_empty() {
        critical_signals.push("timeline-source mapping".to_string());
    } else {
        missing_signals.push("timeline-source mapping".to_string());
    }

    if ready_count > 0 {
        critical_signals.push("frame samples".to_string());
    } else {
        missing_signals.push("frame samples".to_string());
        recommended_actions.push(
            "Verify FFmpeg availability and the media file path before relying on visual edits."
                .to_string(),
        );
    }

    if failed_count > 0 {
        degraded_signals.push(format!(
            "{} frame sample(s) failed extraction",
            failed_count
        ));
        recommended_actions.push(
            "Re-run the clip analysis after checking media readability or reduce sample density."
                .to_string(),
        );
    }

    if !errors.is_empty() {
        degraded_signals.push(format!("{} analysis error(s) recorded", errors.len()));
    }

    let status = if ready_count == 0 {
        ClipAnalysisQualityStatus::Insufficient
    } else if failed_count > 0 || !errors.is_empty() {
        ClipAnalysisQualityStatus::Partial
    } else {
        ClipAnalysisQualityStatus::Ready
    };

    let score = match status {
        ClipAnalysisQualityStatus::Ready => 100,
        ClipAnalysisQualityStatus::Partial => {
            let ratio = ready_count as f64 / samples.len().max(1) as f64;
            (55.0 + ratio * 35.0).round() as u32
        }
        ClipAnalysisQualityStatus::Insufficient => 20,
    };

    ClipAnalysisQuality {
        status,
        score,
        critical_signals,
        missing_signals,
        degraded_signals,
        recommended_actions,
    }
}

fn source_to_frame_index(source_sec: f64, fps: Option<f64>) -> Option<u64> {
    let fps = fps.filter(|fps| fps.is_finite() && *fps > 0.0)?;
    Some((source_sec.max(0.0) * fps).floor() as u64)
}

fn source_fps(asset: &Asset) -> Option<f64> {
    asset
        .video
        .as_ref()
        .map(|video| video.fps.as_f64())
        .filter(|fps| fps.is_finite() && *fps > 0.0)
}

fn sequence_fps(sequence: &Sequence) -> Option<f64> {
    let fps = sequence.format.fps.as_f64();
    if fps.is_finite() && fps > 0.0 {
        Some(fps)
    } else {
        None
    }
}

fn round_time(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::assets::{Asset, AssetKind, LicenseInfo, ProxyStatus, VideoInfo};
    use crate::core::timeline::{
        ClipPlace, KeyframeInterpolation, TimeRemapCurve, TimeRemapKeyframe, TrackKind,
    };

    fn test_asset(id: &str) -> Asset {
        Asset {
            id: id.to_string(),
            kind: AssetKind::Video,
            name: "clip.mp4".to_string(),
            uri: "/tmp/clip.mp4".to_string(),
            hash: "sha256:test".to_string(),
            duration_sec: Some(20.0),
            file_size: 100,
            imported_at: "2026-01-01T00:00:00Z".to_string(),
            video: Some(VideoInfo::default()),
            audio: None,
            license: LicenseInfo::default(),
            tags: vec![],
            thumbnail_url: None,
            proxy_status: ProxyStatus::NotNeeded,
            proxy_url: None,
            bin_id: None,
            relative_path: None,
            workspace_managed: false,
            missing: false,
        }
    }

    fn test_state_with_clip(mut clip: Clip) -> (ProjectState, String, String, String) {
        let mut state = ProjectState::new_empty("test");
        let mut sequence = Sequence::new(
            "Sequence",
            crate::core::timeline::SequenceFormat::youtube_1080(),
        );
        let mut track = Track::new("Video 1", TrackKind::Video);
        let sequence_id = sequence.id.clone();
        let track_id = track.id.clone();
        let asset_id = clip.asset_id.clone();
        clip.id = "clip-1".to_string();
        let clip_id = clip.id.clone();

        track.add_clip(clip);
        sequence.add_track(track);
        state.assets.insert(asset_id.clone(), test_asset(&asset_id));
        state.sequences.insert(sequence_id.clone(), sequence);
        state.active_sequence_id = Some(sequence_id.clone());

        (state, sequence_id, track_id, clip_id)
    }

    fn test_bundle(fingerprint: &str) -> ClipAnalysisBundle {
        ClipAnalysisBundle {
            schema_version: CLIP_ANALYSIS_SCHEMA_VERSION,
            fingerprint: fingerprint.to_string(),
            sequence_id: "seq-1".to_string(),
            track_id: "track-1".to_string(),
            clip_id: "clip-1".to_string(),
            asset_id: "asset-1".to_string(),
            asset_name: "clip.mp4".to_string(),
            asset_hash: "sha256:test".to_string(),
            source_range: SourceRangeSummary {
                source_in_sec: 0.0,
                source_out_sec: 5.0,
                duration_sec: 5.0,
            },
            timeline_range: TimelineRangeSummary {
                timeline_in_sec: 1.0,
                timeline_out_sec: 6.0,
                duration_sec: 5.0,
            },
            playback: ClipPlaybackSummary {
                speed: 1.0,
                reverse: false,
                freeze_frame: false,
                has_time_remap: false,
            },
            sample_policy: ClipSamplePolicy {
                mode: ClipAnalysisMode::Representative,
                target_interval_sec: 1.0,
                max_samples: 1,
                include_edges: true,
                requested_timeline_start_sec: 1.0,
                requested_timeline_end_sec: 6.0,
                effective_timeline_start_sec: 1.0,
                effective_timeline_end_sec: 6.0,
            },
            mapping: vec![TimelineSourceMappingEntry {
                timeline_sec: 1.0,
                timeline_offset_sec: 0.0,
                source_sec: Some(0.0),
                frame_index: Some(0),
                inside_clip: true,
                reason: "leadingEdge".to_string(),
            }],
            samples: vec![FrameSample {
                sample_id: "f0001".to_string(),
                index: 0,
                timeline_sec: 1.0,
                timeline_offset_sec: 0.0,
                source_sec: 0.0,
                frame_index: Some(0),
                image_path: "/tmp/frame.jpg".to_string(),
                width: Some(1920),
                height: Some(1080),
                sampling_reason: "leadingEdge".to_string(),
                extraction_status: FrameExtractionStatus::Ready,
                error: None,
                signals: FrameSampleSignals {
                    clip_progress: 0.0,
                    source_progress: 0.0,
                    nearest_boundary: "start".to_string(),
                    visual_complexity: None,
                    adjacent_difference: None,
                },
            }],
            windows: vec![],
            quality: ClipAnalysisQuality {
                status: ClipAnalysisQualityStatus::Ready,
                score: 100,
                critical_signals: vec!["frame samples".to_string()],
                missing_signals: vec![],
                degraded_signals: vec![],
                recommended_actions: vec![],
            },
            artifact_dir: "/tmp/clip".to_string(),
            errors: vec![],
            analyzed_at: "2026-05-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn maps_forward_clip_timeline_to_source_frames() {
        let clip = Clip::with_range("asset-1", 10.0, 20.0).place_at(5.0);
        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[5.0, 7.5, 14.999]);

        assert_eq!(mapping.len(), 3);
        assert_eq!(mapping[0].source_sec, Some(10.0));
        assert_eq!(mapping[0].frame_index, Some(300));
        assert_eq!(mapping[1].source_sec, Some(12.5));
        assert_eq!(mapping[1].frame_index, Some(375));
        assert!(mapping[2].inside_clip);
    }

    #[test]
    fn maps_reverse_clip_inside_source_range() {
        let mut clip = Clip::with_range("asset-1", 10.0, 20.0).place_at(5.0);
        clip.reverse = true;
        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[5.0, 10.0, 14.999]);

        assert_eq!(mapping[0].source_sec, Some(19.99));
        assert_eq!(mapping[1].source_sec, Some(15.0));
        assert!(mapping[2].source_sec.unwrap() >= 10.0);
    }

    #[test]
    fn maps_speed_adjusted_clip_timeline_to_source_frames() {
        let mut clip = Clip::with_range("asset-1", 0.0, 10.0).place_at(0.0);
        clip.speed = 2.0;
        clip.place.duration_sec = 5.0;
        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[2.5]);

        assert_eq!(mapping[0].source_sec, Some(5.0));
        assert_eq!(mapping[0].frame_index, Some(150));
    }

    #[test]
    fn maps_freeze_frame_clip_to_source_in() {
        let mut clip = Clip::with_range("asset-1", 10.0, 20.0).place_at(5.0);
        clip.freeze_frame = true;
        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[8.0, 12.0]);

        assert_eq!(mapping[0].source_sec, Some(10.0));
        assert_eq!(mapping[1].source_sec, Some(10.0));
    }

    #[test]
    fn maps_time_remapped_clip_with_curve() {
        let mut clip = Clip::with_range("asset-1", 0.0, 10.0).place_at(5.0);
        clip.place.duration_sec = 4.0;
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 2.0,
                interpolation: KeyframeInterpolation::Linear,
            },
            TimeRemapKeyframe {
                timeline_time: 4.0,
                source_time: 6.0,
                interpolation: KeyframeInterpolation::Linear,
            },
        ]));

        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[7.0]);

        assert_eq!(mapping[0].source_sec, Some(4.0));
        assert_eq!(mapping[0].frame_index, Some(120));
    }

    #[test]
    fn rejects_outside_clip_mapping() {
        let clip = Clip::with_range("asset-1", 0.0, 5.0).place_at(10.0);
        let mapping = build_timeline_source_mapping(&clip, Some(30.0), &[9.0, 15.0]);

        assert_eq!(mapping[0].reason, "beforeClipStart");
        assert_eq!(mapping[1].reason, "atOrAfterClipEnd");
        assert!(!mapping[0].inside_clip);
        assert!(!mapping[1].inside_clip);
    }

    #[test]
    fn samples_dense_clip_without_crossing_clip_end() {
        let clip = Clip::with_range("asset-1", 0.0, 2.0).place_at(3.0);
        let options = ClipAnalysisOptions {
            mode: ClipAnalysisMode::Dense,
            target_interval_sec: Some(0.5),
            max_samples: Some(10),
            ..Default::default()
        };
        let (_policy, mapping) = sample_clip_timeline_times(&clip, Some(30.0), &options).unwrap();

        assert!(!mapping.is_empty());
        assert!(mapping.iter().all(|entry| entry.timeline_sec < 5.0));
        assert!(mapping.iter().all(|entry| entry.inside_clip));
        assert_eq!(mapping.first().unwrap().reason, "leadingEdge");
        assert_eq!(mapping.last().unwrap().reason, "trailingEdge");
    }

    #[test]
    fn dense_sampling_allows_frame_level_intervals() {
        let clip = Clip::with_range("asset-1", 0.0, 1.0).place_at(0.0);
        let options = ClipAnalysisOptions {
            mode: ClipAnalysisMode::Dense,
            target_interval_sec: Some(1.0 / 120.0),
            max_samples: Some(8),
            ..Default::default()
        };

        let (policy, mapping) = sample_clip_timeline_times(&clip, Some(120.0), &options).unwrap();

        assert!(policy.target_interval_sec < 0.02);
        assert_eq!(mapping.len(), 8);
        assert_eq!(mapping[1].timeline_sec, 0.008333);
    }

    #[test]
    fn range_targets_skip_disabled_clips() {
        let mut visible_clip = Clip::with_range("asset-1", 0.0, 5.0).place_at(0.0);
        visible_clip.id = "visible".to_string();
        let mut disabled_clip = Clip::with_range("asset-1", 0.0, 5.0).place_at(1.0);
        disabled_clip.id = "disabled".to_string();
        disabled_clip.enabled = false;

        let mut state = ProjectState::new_empty("test");
        let mut sequence = Sequence::new(
            "Sequence",
            crate::core::timeline::SequenceFormat::youtube_1080(),
        );
        let mut track = Track::new("Video 1", TrackKind::Video);
        let sequence_id = sequence.id.clone();
        let track_id = track.id.clone();
        track.add_clip(visible_clip);
        track.add_clip(disabled_clip);
        sequence.add_track(track);
        state
            .assets
            .insert("asset-1".to_string(), test_asset("asset-1"));
        state.sequences.insert(sequence_id.clone(), sequence);

        let targets =
            resolve_clip_analysis_targets(&state, &sequence_id, Some(&track_id), 0.0, 4.0).unwrap();

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].clip_id, "visible");
    }

    #[test]
    fn builds_stable_fingerprint_for_same_clip_context() {
        let clip = Clip::with_range("asset-1", 0.0, 5.0).place_at(1.0);
        let (state, sequence_id, track_id, clip_id) = test_state_with_clip(clip);
        let context = resolve_clip_context(&state, &sequence_id, &track_id, &clip_id).unwrap();
        let options = ClipAnalysisOptions::default();
        let policy = resolve_sample_policy(&context.clip, &options).unwrap();

        let left = build_clip_analysis_fingerprint(&context, &policy, &options);
        let right = build_clip_analysis_fingerprint(&context, &policy, &options);

        assert_eq!(left, right);
        assert!(left.starts_with("clip_"));
    }

    #[test]
    fn fingerprint_changes_when_clip_timing_changes() {
        let clip = Clip::with_range("asset-1", 0.0, 5.0).place_at(1.0);
        let (state, sequence_id, track_id, clip_id) = test_state_with_clip(clip);
        let context = resolve_clip_context(&state, &sequence_id, &track_id, &clip_id).unwrap();
        let options = ClipAnalysisOptions::default();
        let policy = resolve_sample_policy(&context.clip, &options).unwrap();
        let left = build_clip_analysis_fingerprint(&context, &policy, &options);

        let mut changed = context.clone();
        changed.clip.place = ClipPlace::new(2.0, 5.0);
        let changed_policy = resolve_sample_policy(&changed.clip, &options).unwrap();
        let right = build_clip_analysis_fingerprint(&changed, &changed_policy, &options);

        assert_ne!(left, right);
    }

    #[test]
    fn serializes_clip_analysis_bundle_with_camel_case_fields() {
        let response = ClipAnalysisResponse {
            source: ClipAnalysisBundleSource::Generated,
            bundle: test_bundle("clip_serialized"),
        };

        let json = serde_json::to_string(&response).unwrap();

        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"samplePolicy\""));
        assert!(json.contains("\"clipId\""));
        assert!(json.contains("\"frameIndex\""));
        assert!(json.contains("\"source\":\"generated\""));
    }

    #[test]
    fn rejects_unsafe_clip_analysis_fingerprints() {
        let project_dir = std::path::Path::new("/tmp/project");

        let result = load_clip_analysis_bundle_optional(project_dir, "../outside");

        assert!(result.is_err());
    }

    #[test]
    fn saves_and_loads_clip_analysis_bundle() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle = test_bundle("clip_cache_reuse");

        save_clip_analysis_bundle(temp_dir.path(), &bundle).unwrap();
        let loaded = load_clip_analysis_bundle_optional(temp_dir.path(), "clip_cache_reuse")
            .unwrap()
            .unwrap();

        assert_eq!(loaded.fingerprint, bundle.fingerprint);
        assert_eq!(loaded.samples.len(), 1);
        assert_eq!(loaded.mapping[0].frame_index, Some(0));
    }
}
