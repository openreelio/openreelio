//! Headless perception verbs.
//!
//! These commands let an agent *generate* the analysis artifacts that
//! `analysis report` / `analysis search` only read: shot boundaries, silence
//! regions, audio profiles, and full analysis bundles. Everything runs
//! locally through FFmpeg — no network calls and no API keys.
//!
//! Persistence targets mirror what the GUI writes, so artifacts produced
//! headlessly show up in the app:
//!
//! - `{project}/index.db` `shots` table — the only source the GUI shot markers read
//! - `{project}/.openreelio/analysis/{asset_id}/bundle.json` — the analysis cache
//! - `{project}/.openreelio/annotations/{asset_id}.json` — the annotation store

use crate::ffmpeg_env::ensure_ffmpeg;
use crate::output;
use crate::validate;
use clap::Args;
use openreelio_core::analysis::audio::AudioProfiler;
use openreelio_core::analysis::cleanup::{
    DEFAULT_SILENCE_MIN_DURATION_SEC, DEFAULT_SILENCE_THRESHOLD_DB,
};
use openreelio_core::analysis::{
    AnalysisBundle, AnalysisJobRunner, AnalysisOptions, AudioProfile, VideoMetadata,
    SILENCE_FLOOR_DB,
};
use openreelio_core::annotations::{
    AnalysisProvider, AnalysisResult, AnnotationStore, AssetAnnotation, ShotResult,
};
use openreelio_core::assets::Asset;
use openreelio_core::ffmpeg::{FFmpegInfo, FFmpegRunner};
use openreelio_core::indexing::shots::{
    Shot, DEFAULT_FFMPEG_TIMEOUT_SECS, DEFAULT_MIN_SHOT_DURATION, DEFAULT_SCENE_THRESHOLD,
};
use openreelio_core::indexing::{IndexDb, ShotDetector, ShotDetectorConfig};
use openreelio_core::{ActiveProject, CoreError};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Attempts made when writing shots into `index.db`.
///
/// A GUI instance may hold the same SQLite file, so a transient `SQLITE_BUSY`
/// must not be reported as a failed detection.
const INDEX_DB_WRITE_ATTEMPTS: u32 = 3;

/// Base backoff between `index.db` write attempts.
const INDEX_DB_RETRY_BACKOFF: Duration = Duration::from_millis(50);

/// Tolerance used when comparing requested silence parameters with the cached
/// contract. Mirrors the tolerance `cleanup::can_reuse_cached_silence_regions`
/// applies on the read side.
const SILENCE_PARAMETER_EPSILON: f64 = 0.001;

/// Provider label recorded on annotations written by `analysis shots`.
const SHOT_DETECTOR_NAME: &str = "ffmpeg-scenedetect";

// ── Arguments ───────────────────────────────────────────────────────────

/// Arguments for `analysis shots`.
#[derive(Args)]
pub struct ShotsArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Asset ID
    #[arg(long)]
    pub id: String,

    /// Scene change threshold (0.0 - 1.0); lower values detect more cuts
    #[arg(long, default_value_t = DEFAULT_SCENE_THRESHOLD)]
    pub threshold: f64,

    /// Minimum shot duration in seconds; shorter shots are merged
    #[arg(long, default_value_t = DEFAULT_MIN_SHOT_DURATION)]
    pub min_shot_duration: f64,

    /// FFmpeg scene-detection timeout in seconds
    #[arg(long, default_value_t = DEFAULT_FFMPEG_TIMEOUT_SECS)]
    pub timeout_sec: u64,

    /// Detect only: skip the index.db, bundle, and annotation writes
    #[arg(long)]
    pub no_persist: bool,
}

/// Arguments for `analysis silence`.
#[derive(Args)]
pub struct SilenceArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Asset ID
    #[arg(long)]
    pub id: String,

    /// Silence threshold in dB (negative values are expected, e.g. -40)
    #[arg(long, allow_hyphen_values = true, default_value_t = DEFAULT_SILENCE_THRESHOLD_DB)]
    pub threshold_db: f64,

    /// Minimum silence duration in seconds
    #[arg(long, default_value_t = DEFAULT_SILENCE_MIN_DURATION_SEC)]
    pub min_duration: f64,
}

/// Arguments for `analysis audio`.
#[derive(Args)]
pub struct AudioArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Asset ID
    #[arg(long)]
    pub id: String,
}

/// Arguments for `analysis run`.
#[derive(Args)]
pub struct RunArgs {
    /// Project directory path
    #[arg(long)]
    pub path: PathBuf,

    /// Asset ID
    #[arg(long)]
    pub id: String,

    /// Run shot detection
    #[arg(long)]
    pub shots: bool,

    /// Run audio profiling (silence, loudness, BPM, speech regions)
    #[arg(long)]
    pub audio: bool,

    /// Run content segmentation (requires shots and audio)
    #[arg(long)]
    pub segments: bool,

    /// Run speech-to-text transcription (requires an installed Whisper model)
    #[arg(long)]
    pub transcript: bool,

    /// Run local visual frame analysis
    #[arg(long)]
    pub visual: bool,

    /// Run every local sub-job; transcription stays off unless --transcript is given
    #[arg(long)]
    pub all: bool,

    /// Stream NDJSON sub-job progress to stderr
    #[arg(long)]
    pub progress: bool,
}

// ── Verb entry points ───────────────────────────────────────────────────

/// Detects shot boundaries and persists them for the GUI and the analysis cache.
pub fn shots(args: ShotsArgs) -> anyhow::Result<()> {
    validate::non_empty(&args.id, "id")?;
    validate::time_non_negative(args.min_shot_duration, "min-shot-duration")?;
    if !args.threshold.is_finite() || !(0.0..=1.0).contains(&args.threshold) {
        return Err(anyhow::anyhow!(
            "Invalid value for --threshold: must be between 0.0 and 1.0 (got {})",
            args.threshold
        ));
    }
    if args.timeout_sec == 0 {
        return Err(anyhow::anyhow!(
            "Invalid value for --timeout-sec: must be >= 1"
        ));
    }

    let project = super::load_project(&args.path)?;
    let asset = resolve_asset(&project, &args.id)?;
    let media_path = asset.resolved_path(&project.path);
    let ffmpeg_info = ensure_ffmpeg()?;

    let detector = ShotDetector::with_config(ShotDetectorConfig {
        threshold: args.threshold,
        min_shot_duration: args.min_shot_duration,
        ffmpeg_path: Some(ffmpeg_info.ffmpeg_path.clone()),
        ffprobe_path: Some(ffmpeg_info.ffprobe_path.clone()),
        ffmpeg_timeout: Duration::from_secs(args.timeout_sec),
        ..ShotDetectorConfig::default()
    });

    let runtime = build_runtime()?;
    let detected = runtime
        .block_on(detector.detect(&media_path, &args.id))
        .map_err(|error| describe_shot_error(error, args.timeout_sec))?;

    let mut persisted: Vec<&str> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if !args.no_persist {
        match runtime.block_on(save_shots_to_index_db(&project.path, &detector, &detected)) {
            Ok(()) => persisted.push("indexDb"),
            Err(error) => warnings.push(format!("index.db write skipped: {}", error)),
        }

        let shot_results = to_shot_results(&detected);
        let metadata =
            runtime.block_on(resolve_video_metadata(asset, &media_path, &ffmpeg_info))?;

        AnalysisJobRunner::new(&project.path)
            .merge_bundle_shots(&args.id, &metadata, shot_results.clone())
            .map_err(|error| anyhow::anyhow!("Failed to update the analysis bundle: {}", error))?;
        persisted.push("bundle");

        save_shot_annotation(
            &project.path,
            &args.id,
            &asset.hash,
            shot_results,
            args.threshold,
            args.min_shot_duration,
        )?;
        persisted.push("annotations");
    }

    let total_duration_sec = detected.last().map(|shot| shot.end_sec).unwrap_or(0.0);
    let mut payload = json!({
        "status": "ok",
        "assetId": args.id,
        "shotCount": detected.len(),
        "totalDurationSec": total_duration_sec,
        "shots": detected
            .iter()
            .enumerate()
            .map(|(index, shot)| json!({
                "index": index,
                "startSec": shot.start_sec,
                "endSec": shot.end_sec,
                "durationSec": shot.duration(),
                "confidence": shot.quality_score.unwrap_or(DEFAULT_SHOT_CONFIDENCE),
            }))
            .collect::<Vec<_>>(),
        "persisted": persisted,
    });
    if !warnings.is_empty() {
        payload["warnings"] = json!(warnings);
    }

    output::print_json_pretty(&payload)
}

/// Detects silence regions, caching them only when the parameters match the
/// shared cache contract.
pub fn silence(args: SilenceArgs) -> anyhow::Result<()> {
    validate::non_empty(&args.id, "id")?;
    if !args.threshold_db.is_finite() {
        return Err(anyhow::anyhow!(
            "Invalid value for --threshold-db: must be a finite number"
        ));
    }
    if !args.min_duration.is_finite() || args.min_duration <= 0.0 {
        return Err(anyhow::anyhow!(
            "Invalid value for --min-duration: must be a positive finite number"
        ));
    }

    let project = super::load_project(&args.path)?;
    let asset = resolve_asset(&project, &args.id)?;
    let media_path = asset.resolved_path(&project.path);
    let ffmpeg_info = ensure_ffmpeg()?;

    let runtime = build_runtime()?;
    let profiler = AudioProfiler::new(ffmpeg_info.ffmpeg_path.clone());
    let regions = runtime
        .block_on(profiler.detect_silence_custom(&media_path, args.threshold_db, args.min_duration))
        .map_err(|error| anyhow::anyhow!("Silence detection failed: {}", error))?;

    let rejection = silence_cache_rejection(args.threshold_db, args.min_duration);
    if rejection.is_none() {
        let metadata =
            runtime.block_on(resolve_video_metadata(asset, &media_path, &ffmpeg_info))?;
        let cached_regions = regions.clone();
        AnalysisJobRunner::new(&project.path)
            .merge_bundle_update(&args.id, &metadata, move |bundle| {
                apply_silence_regions(bundle, cached_regions)
            })
            .map_err(|error| anyhow::anyhow!("Failed to update the analysis bundle: {}", error))?;
    }

    let total_silence_sec: f64 = regions.iter().map(|region| region.duration()).sum();
    let mut payload = json!({
        "status": "ok",
        "assetId": args.id,
        "thresholdDb": args.threshold_db,
        "minDurationSec": args.min_duration,
        "regionCount": regions.len(),
        "totalSilenceSec": total_silence_sec,
        "regions": regions
            .iter()
            .map(|region| json!({
                "startSec": region.start_sec,
                "endSec": region.end_sec,
                "durationSec": region.duration(),
            }))
            .collect::<Vec<_>>(),
        "persisted": rejection.is_none(),
    });
    if let Some(reason) = rejection {
        payload["reason"] = json!(reason);
    }

    output::print_json_pretty(&payload)
}

/// Runs the full audio profile (silence, loudness, BPM, speech regions).
pub fn audio(args: AudioArgs) -> anyhow::Result<()> {
    validate::non_empty(&args.id, "id")?;

    let project = super::load_project(&args.path)?;
    let asset = resolve_asset(&project, &args.id)?;
    let media_path = asset.resolved_path(&project.path);
    let ffmpeg_info = ensure_ffmpeg()?;

    let runtime = build_runtime()?;
    let metadata = runtime.block_on(resolve_video_metadata(asset, &media_path, &ffmpeg_info))?;
    if !metadata.duration_sec.is_finite() || metadata.duration_sec <= 0.0 {
        return Err(anyhow::anyhow!(
            "Asset '{}' has no usable duration; audio profiling needs a decodable media file",
            args.id
        ));
    }

    let profiler = AudioProfiler::new(ffmpeg_info.ffmpeg_path.clone());
    let profile = runtime
        .block_on(profiler.analyze(&media_path, metadata.duration_sec))
        .map_err(|error| anyhow::anyhow!("Audio profiling failed: {}", error))?;

    AnalysisJobRunner::new(&project.path)
        .merge_bundle_audio_profile(&args.id, &metadata, profile.clone())
        .map_err(|error| anyhow::anyhow!("Failed to update the analysis bundle: {}", error))?;

    let total_silence_sec: f64 = profile
        .silence_regions
        .iter()
        .map(|region| region.duration())
        .sum();
    let total_speech_sec: f64 = profile
        .speech_regions
        .iter()
        .map(|region| region.duration())
        .sum();

    output::print_json_pretty(&json!({
        "status": "ok",
        "assetId": args.id,
        "durationSec": metadata.duration_sec,
        "bpm": profile.bpm,
        "peakDb": profile.peak_db,
        "spectralCentroidHz": profile.spectral_centroid_hz,
        "loudnessSampleCount": profile.loudness_profile.len(),
        "silenceRegionCount": profile.silence_regions.len(),
        "totalSilenceSec": total_silence_sec,
        "speechRegionCount": profile.speech_regions.len(),
        "totalSpeechSec": total_speech_sec,
        "persisted": true,
    }))
}

/// Runs the composable analysis pipeline and caches the resulting bundle.
pub fn run(args: RunArgs) -> anyhow::Result<()> {
    validate::non_empty(&args.id, "id")?;

    let options = build_analysis_options(&args);
    if !options.has_any() {
        return Err(anyhow::anyhow!("No analysis sub-jobs were selected"));
    }
    if options.transcript {
        ensure_transcription_ready()?;
    }

    let project = super::load_project(&args.path)?;
    let asset = resolve_asset(&project, &args.id)?;
    let media_path = asset.resolved_path(&project.path);
    let ffmpeg_info = ensure_ffmpeg()?;

    let runtime = build_runtime()?;
    let metadata = runtime.block_on(resolve_video_metadata(asset, &media_path, &ffmpeg_info))?;

    let runner = AnalysisJobRunner::new(&project.path);
    // Captured before the run: `analyze_full_with_metadata` writes the bundle
    // itself, so results the enabled sub-jobs do not produce are merged back
    // afterwards instead of being dropped.
    let previous = runner
        .load_bundle_optional(&args.id)
        .map_err(|error| anyhow::anyhow!("Failed to read the cached analysis bundle: {}", error))?;

    let emit_progress = args.progress;
    let bundle = runtime
        .block_on(runner.analyze_full_with_metadata(
            &args.id,
            &media_path.to_string_lossy(),
            metadata.clone(),
            &options,
            |job, status, detail| {
                if emit_progress {
                    emit_progress_line(job, status, detail);
                }
            },
        ))
        .map_err(|error| anyhow::anyhow!("Analysis run failed: {}", error))?;

    let bundle = match previous {
        Some(previous) => runner
            .merge_bundle_update(&args.id, &metadata, |merged| {
                merged.backfill_missing_from(&previous)
            })
            .map_err(|error| anyhow::anyhow!("Failed to merge the analysis bundle: {}", error))?,
        None => bundle,
    };

    let enabled = enabled_job_names(&options);
    let failed = enabled
        .iter()
        .filter(|job| bundle.errors.contains_key(**job))
        .copied()
        .collect::<Vec<_>>();
    let all_failed = !enabled.is_empty() && failed.len() == enabled.len();
    let status = if failed.is_empty() {
        "ok"
    } else if all_failed {
        "failed"
    } else {
        "partial"
    };

    output::print_json_pretty(&json!({
        "status": status,
        "assetId": args.id,
        "bundlePath": bundle_path(&project.path, &args.id).display().to_string(),
        "options": {
            "shots": options.shots,
            "audio": options.audio,
            "segments": options.segments,
            "transcript": options.transcript,
            "visual": options.visual,
            "localOnly": options.local_only,
        },
        "durationSec": bundle.metadata.duration_sec,
        "shotCount": bundle.shots.as_ref().map(Vec::len),
        "segmentCount": bundle.segments.as_ref().map(Vec::len),
        "transcriptSegmentCount": bundle.transcript.as_ref().map(Vec::len),
        "frameAnalysisCount": bundle.frame_analysis.as_ref().map(Vec::len),
        "hasAudioProfile": bundle.audio_profile.is_some(),
        "contactSheetPath": bundle.contact_sheet.as_ref().map(|sheet| sheet.path.clone()),
        "analyzedAt": bundle.analyzed_at,
        "errors": bundle.errors,
    }))?;

    if all_failed {
        return Err(anyhow::anyhow!(
            "Every enabled analysis sub-job failed: {}",
            failed.join(", ")
        ));
    }

    Ok(())
}

// ── Shared helpers ──────────────────────────────────────────────────────

/// Confidence recorded for shots when FFmpeg reports no quality score.
///
/// Matches what `AnalysisJobRunner` stores, so bundles written by the CLI and
/// by the GUI stay comparable.
const DEFAULT_SHOT_CONFIDENCE: f64 = 0.9;

fn build_runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| anyhow::anyhow!("Failed to create Tokio runtime: {error}"))
}

fn resolve_asset<'a>(project: &'a ActiveProject, asset_id: &str) -> anyhow::Result<&'a Asset> {
    project
        .state
        .assets
        .get(asset_id)
        .ok_or_else(|| anyhow::anyhow!("Asset '{}' not found", asset_id))
}

/// Path of the cached analysis bundle for an asset.
fn bundle_path(project_dir: &Path, asset_id: &str) -> PathBuf {
    project_dir
        .join(".openreelio")
        .join("analysis")
        .join(asset_id)
        .join("bundle.json")
}

/// Adds actionable guidance to the two shot-detection failures an agent can fix.
fn describe_shot_error(error: CoreError, timeout_sec: u64) -> anyhow::Error {
    match &error {
        CoreError::ResourceExhausted(_) => anyhow::anyhow!(
            "{}. Raise --threshold or --min-shot-duration so FFmpeg reports fewer scene cuts.",
            error
        ),
        CoreError::Timeout(_) => anyhow::anyhow!(
            "{}. Raise --timeout-sec above {}s for long sources.",
            error,
            timeout_sec
        ),
        _ => anyhow::anyhow!("Shot detection failed: {}", error),
    }
}

/// Builds the analysis metadata, falling back to FFprobe when the asset record
/// has no usable duration.
async fn resolve_video_metadata(
    asset: &Asset,
    media_path: &Path,
    ffmpeg_info: &FFmpegInfo,
) -> anyhow::Result<VideoMetadata> {
    if let Some(duration_sec) = asset.duration_sec.filter(|value| *value > 0.0) {
        let has_audio = asset.audio.is_some();
        return Ok(match asset.video.as_ref() {
            Some(video) => VideoMetadata::new(duration_sec)
                .with_dimensions(video.width, video.height)
                .with_fps(video.fps.as_f64())
                .with_codec(&video.codec)
                .with_audio(has_audio),
            None => VideoMetadata::new(duration_sec).with_audio(has_audio),
        });
    }

    let runner = FFmpegRunner::new(ffmpeg_info.clone());
    let probed = runner.probe(media_path).await.map_err(|error| {
        anyhow::anyhow!("Failed to probe '{}': {}", media_path.display(), error)
    })?;

    let mut metadata = VideoMetadata::new(probed.duration_sec).with_audio(probed.audio.is_some());
    if let Some(video) = probed.video.as_ref() {
        metadata = metadata
            .with_dimensions(video.width, video.height)
            .with_fps(video.fps)
            .with_codec(&video.codec);
    }

    Ok(metadata)
}

fn to_shot_results(shots: &[Shot]) -> Vec<ShotResult> {
    shots
        .iter()
        .map(|shot| {
            ShotResult::new(
                shot.start_sec,
                shot.end_sec,
                shot.quality_score.unwrap_or(DEFAULT_SHOT_CONFIDENCE),
            )
        })
        .collect()
}

/// Writes shots into the project's `index.db`, retrying transient lock errors.
///
/// A running GUI instance can hold the same database, so a busy database is
/// retried rather than reported as a detection failure.
async fn save_shots_to_index_db(
    project_dir: &Path,
    detector: &ShotDetector,
    shots: &[Shot],
) -> anyhow::Result<()> {
    if shots.is_empty() {
        return Ok(());
    }

    let index_db_path = project_dir.join("index.db");
    let db = if index_db_path.exists() {
        IndexDb::open(&index_db_path)
    } else {
        IndexDb::create(&index_db_path)
    }
    .map_err(|error| anyhow::anyhow!("{}", error))?;

    let mut last_error = None;
    for attempt in 0..INDEX_DB_WRITE_ATTEMPTS {
        match detector.save_to_db(&db, shots) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(INDEX_DB_RETRY_BACKOFF * (attempt + 1)).await;
            }
        }
    }

    Err(anyhow::anyhow!(
        "{}",
        last_error.expect("a failed attempt always records an error")
    ))
}

/// Stores shot results in the per-asset annotation file.
fn save_shot_annotation(
    project_dir: &Path,
    asset_id: &str,
    asset_hash: &str,
    shots: Vec<ShotResult>,
    threshold: f64,
    min_shot_duration: f64,
) -> anyhow::Result<()> {
    let store = AnnotationStore::new(project_dir);
    let mut annotation = store
        .load(asset_id)
        .map_err(|error| anyhow::anyhow!("Failed to read the asset annotation: {}", error))?
        .unwrap_or_else(|| AssetAnnotation::new(asset_id, asset_hash));

    // Assets imported without a computed hash keep whatever the annotation
    // already recorded, so staleness detection is never downgraded.
    if !asset_hash.is_empty() {
        annotation.asset_hash = asset_hash.to_string();
    }

    annotation.set_shots(
        AnalysisResult::new(AnalysisProvider::Ffmpeg, shots).with_config(json!({
            "detector": SHOT_DETECTOR_NAME,
            "threshold": threshold,
            "minShotDuration": min_shot_duration,
        })),
    );

    store
        .save(&annotation)
        .map_err(|error| anyhow::anyhow!("Failed to write the asset annotation: {}", error))
}

/// Writes freshly detected silence into the bundle's audio profile.
///
/// When no profile exists yet the remaining fields stay at their unmeasured
/// defaults; `analysis audio` fills them in.
fn apply_silence_regions(
    bundle: &mut AnalysisBundle,
    regions: Vec<openreelio_core::analysis::SilenceRegion>,
) {
    match bundle.audio_profile.as_mut() {
        Some(profile) => profile.silence_regions = regions,
        None => {
            bundle.audio_profile = Some(AudioProfile {
                bpm: None,
                spectral_centroid_hz: 0.0,
                loudness_profile: Vec::new(),
                peak_db: SILENCE_FLOOR_DB,
                silence_regions: regions,
                speech_regions: Vec::new(),
            })
        }
    }
}

/// Returns why freshly detected silence must not enter the shared cache.
///
/// The cache is defined to hold regions detected at -40 dB over 0.5 s: readers
/// (the GUI cleanup panel) reuse it by *filtering* to a longer minimum
/// duration. Writing regions detected with other parameters would silently
/// answer those reads with the wrong set, so anything else stays output-only.
///
/// Note the asymmetry with `can_reuse_cached_silence_regions`: a reader asking
/// for a longer minimum duration may reuse the cache, but a detection run with
/// that longer minimum duration may not populate it.
fn silence_cache_rejection(threshold_db: f64, min_duration_sec: f64) -> Option<&'static str> {
    if (threshold_db - DEFAULT_SILENCE_THRESHOLD_DB).abs() > SILENCE_PARAMETER_EPSILON {
        return Some("non-default threshold");
    }
    if (min_duration_sec - DEFAULT_SILENCE_MIN_DURATION_SEC).abs() > SILENCE_PARAMETER_EPSILON {
        return Some("non-default min-duration");
    }
    None
}

/// Maps the `analysis run` flags onto the pipeline options.
///
/// With no sub-job flag the pipeline defaults apply (shots, audio, segments).
/// `--all` adds visual analysis; transcription stays opt-in because it needs a
/// downloaded Whisper model. `local_only` is always forced: the CLI has no
/// vision-provider credentials, and the non-local path would extract keyframes
/// twice for the same local result.
fn build_analysis_options(args: &RunArgs) -> AnalysisOptions {
    if args.all {
        return AnalysisOptions {
            shots: true,
            audio: true,
            segments: true,
            transcript: args.transcript,
            visual: true,
            local_only: true,
        };
    }

    let explicit = args.shots || args.audio || args.segments || args.transcript || args.visual;
    if !explicit {
        return AnalysisOptions {
            local_only: true,
            ..AnalysisOptions::default()
        };
    }

    AnalysisOptions {
        shots: args.shots,
        audio: args.audio,
        segments: args.segments,
        transcript: args.transcript,
        visual: args.visual,
        local_only: true,
    }
}

/// Names of the sub-jobs that were requested, in bundle error-key form.
fn enabled_job_names(options: &AnalysisOptions) -> Vec<&'static str> {
    let mut names = Vec::new();
    if options.shots {
        names.push("shots");
    }
    if options.audio {
        names.push("audio");
    }
    if options.transcript {
        names.push("transcript");
    }
    if options.segments {
        names.push("segments");
    }
    if options.visual {
        names.push("visual");
    }
    names
}

/// Fails before any FFmpeg work when transcription cannot succeed.
fn ensure_transcription_ready() -> anyhow::Result<()> {
    let status = super::transcription::build_transcription_status();
    if !status.feature_available {
        return Err(anyhow::anyhow!(
            "Transcription is unavailable: this build was compiled without the whisper feature"
        ));
    }
    if status.installed_count == 0 {
        return Err(anyhow::anyhow!(
            "No Whisper model is installed in '{}'. Run 'openreelio-cli transcription install --model auto' first.",
            status.models_dir
        ));
    }
    Ok(())
}

/// Writes one NDJSON progress record to stderr.
///
/// stdout stays reserved for the single result object.
fn emit_progress_line(job: &str, status: &str, detail: Option<String>) {
    let line: Value = json!({
        "type": "progress",
        "job": job,
        "status": status,
        "detail": detail,
    });
    eprintln!("{}", line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use openreelio_core::analysis::cleanup::can_reuse_cached_silence_regions;

    fn run_args() -> RunArgs {
        RunArgs {
            path: PathBuf::from("."),
            id: "asset_001".to_string(),
            shots: false,
            audio: false,
            segments: false,
            transcript: false,
            visual: false,
            all: false,
            progress: false,
        }
    }

    #[test]
    fn build_analysis_options_should_use_pipeline_defaults_without_flags() {
        let options = build_analysis_options(&run_args());

        assert!(options.shots);
        assert!(options.audio);
        assert!(options.segments);
        assert!(!options.transcript);
        assert!(!options.visual);
        assert!(options.local_only);
    }

    #[test]
    fn build_analysis_options_should_honour_an_explicit_single_job() {
        let options = build_analysis_options(&RunArgs {
            shots: true,
            ..run_args()
        });

        assert!(options.shots);
        assert!(!options.audio);
        assert!(!options.segments);
        assert!(options.local_only);
    }

    #[test]
    fn build_analysis_options_should_keep_transcription_off_for_all() {
        let options = build_analysis_options(&RunArgs {
            all: true,
            ..run_args()
        });

        assert!(options.shots);
        assert!(options.audio);
        assert!(options.segments);
        assert!(options.visual);
        assert!(!options.transcript);
    }

    #[test]
    fn build_analysis_options_should_add_transcription_to_all_when_requested() {
        let options = build_analysis_options(&RunArgs {
            all: true,
            transcript: true,
            ..run_args()
        });

        assert!(options.transcript);
        assert!(options.visual);
    }

    #[test]
    fn build_analysis_options_should_always_force_local_only() {
        for args in [
            run_args(),
            RunArgs {
                all: true,
                ..run_args()
            },
            RunArgs {
                visual: true,
                ..run_args()
            },
        ] {
            assert!(build_analysis_options(&args).local_only);
        }
    }

    #[test]
    fn enabled_job_names_should_list_only_requested_jobs() {
        let options = build_analysis_options(&RunArgs {
            shots: true,
            visual: true,
            ..run_args()
        });

        assert_eq!(enabled_job_names(&options), vec!["shots", "visual"]);
    }

    #[test]
    fn silence_cache_rejection_should_accept_the_cached_contract() {
        assert!(silence_cache_rejection(
            DEFAULT_SILENCE_THRESHOLD_DB,
            DEFAULT_SILENCE_MIN_DURATION_SEC
        )
        .is_none());
    }

    #[test]
    fn silence_cache_rejection_should_reject_other_thresholds() {
        assert_eq!(
            silence_cache_rejection(-30.0, DEFAULT_SILENCE_MIN_DURATION_SEC),
            Some("non-default threshold")
        );
        assert_eq!(
            silence_cache_rejection(-50.0, DEFAULT_SILENCE_MIN_DURATION_SEC),
            Some("non-default threshold")
        );
    }

    #[test]
    fn silence_cache_rejection_should_reject_other_minimum_durations() {
        assert_eq!(
            silence_cache_rejection(DEFAULT_SILENCE_THRESHOLD_DB, 0.25),
            Some("non-default min-duration")
        );
        assert_eq!(
            silence_cache_rejection(DEFAULT_SILENCE_THRESHOLD_DB, 2.0),
            Some("non-default min-duration")
        );
    }

    #[test]
    fn silence_cache_rejection_should_be_stricter_than_the_reuse_gate() {
        // A reader asking for a longer minimum duration may filter the cache,
        // but a run detecting at that duration must not populate it.
        assert!(can_reuse_cached_silence_regions(
            DEFAULT_SILENCE_THRESHOLD_DB,
            2.0
        ));
        assert!(silence_cache_rejection(DEFAULT_SILENCE_THRESHOLD_DB, 2.0).is_some());
    }

    #[test]
    fn apply_silence_regions_should_create_a_profile_when_none_exists() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(10.0));

        apply_silence_regions(
            &mut bundle,
            vec![openreelio_core::analysis::SilenceRegion::new(1.0, 3.0)],
        );

        let profile = bundle.audio_profile.expect("profile must be created");
        assert_eq!(profile.silence_regions.len(), 1);
        assert!(profile.loudness_profile.is_empty());
        assert!(profile.bpm.is_none());
    }

    #[test]
    fn apply_silence_regions_should_keep_measured_fields_of_an_existing_profile() {
        let mut bundle = AnalysisBundle::new("asset_001", VideoMetadata::new(10.0));
        bundle.audio_profile = Some(AudioProfile {
            bpm: Some(120.0),
            spectral_centroid_hz: 2500.0,
            loudness_profile: vec![-18.0],
            peak_db: -3.0,
            silence_regions: Vec::new(),
            speech_regions: Vec::new(),
        });

        apply_silence_regions(
            &mut bundle,
            vec![openreelio_core::analysis::SilenceRegion::new(0.0, 1.0)],
        );

        let profile = bundle.audio_profile.expect("profile must be preserved");
        assert_eq!(profile.bpm, Some(120.0));
        assert_eq!(profile.peak_db, -3.0);
        assert_eq!(profile.silence_regions.len(), 1);
    }

    #[test]
    fn bundle_path_should_match_the_cached_bundle_layout() {
        let path = bundle_path(Path::new("/projects/demo"), "asset_001");

        assert!(path.ends_with("asset_001/bundle.json"));
        assert!(path
            .to_string_lossy()
            .contains(&format!(".openreelio{}analysis", std::path::MAIN_SEPARATOR)));
    }

    #[test]
    fn to_shot_results_should_default_confidence_when_unscored() {
        let results = to_shot_results(&[Shot::new("asset_001", 0.0, 2.0)]);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].confidence, DEFAULT_SHOT_CONFIDENCE);
        assert_eq!(results[0].end_sec, 2.0);
    }
}
