//! Reference Video Analysis Pipeline
//!
//! Composable analysis pipeline for extracting video characteristics (ADR-048).
//!
//! Each analysis type (shots, audio, segments, visual) runs as an independent
//! sub-job. Results are aggregated into an `AnalysisBundle` with partial failure
//! support — a failed sub-job does not block others.
//!
//! ## Storage
//!
//! Bundles are cached at: `{project}/.openreelio/analysis/{asset_id}/bundle.json`
//!
//! ## Architecture
//!
//! ```text
//! AnalysisJobRunner::analyze_full()
//! ├── Shot detection (existing annotation system)
//! ├── Audio profiling (AudioProfiler)
//! ├── Transcript extraction (Whisper when available)
//! ├── Content segmentation (ContentSegmenter, depends on shots + audio)
//! └── Visual frame analysis (VisualAnalyzer, depends on shots)
//!     └── AnalysisBundle (aggregated, cached to disk)
//! ```

pub mod audio;
pub mod cleanup;
pub mod clip_analysis;
pub mod clip_perception;
pub mod color_match;
pub mod diarization_import;
pub mod diarization_runner;
pub mod dtw;
pub mod ducking;
pub mod esd;
#[cfg(feature = "ai-providers")]
pub mod openai_perception;
pub mod segmentation;
pub mod semantic_edit_plan;
pub mod speaker_turns;
pub mod style_planner;
pub mod types;
pub mod visual;

pub use clip_analysis::*;
pub use clip_perception::*;
pub use semantic_edit_plan::*;
pub use types::*;

use std::path::{Path, PathBuf};

use crate::core::annotations::models::{estimate_word_timings, ShotResult, TranscriptSegment};
use crate::core::captions::{
    audio::{extract_audio_for_transcription, load_audio_samples},
    whisper::{default_models_dir, is_whisper_available, TranscriptionOptions, WhisperEngine},
};
use crate::core::indexing::shots::{ShotDetector, ShotDetectorConfig};
use crate::core::{CoreError, CoreResult};

use audio::AudioProfiler;
use segmentation::ContentSegmenter;
use speaker_turns::infer_speaker_turns;
use visual::VisualAnalyzer;

/// Directory name within .openreelio for analysis artifacts
const ANALYSIS_DIR: &str = "analysis";

/// Name of the bundle JSON file
const BUNDLE_FILENAME: &str = "bundle.json";

/// Name of the generated contact-sheet image
const CONTACT_SHEET_FILENAME: &str = "contact-sheet.jpg";

/// Name of the advisory lock file guarding bundle read-modify-write cycles
const BUNDLE_LOCK_FILENAME: &str = "bundle.json.lock";

/// Advisory lock held for the duration of a bundle read-modify-write cycle.
///
/// The GUI job worker and the CLI are separate processes writing the same
/// bundle, so the lock is on the file system rather than in memory. The lock is
/// released when the guard drops.
struct BundleLock(std::fs::File);

impl Drop for BundleLock {
    fn drop(&mut self) {
        // Keep the handle alive for the lifetime of the guard. Locks are released on drop.
        let _ = &self.0;
    }
}

/// What a locked bundle update does when the asset has no cached bundle yet.
enum MissingBundle<'a> {
    /// Start from a fresh bundle built with this metadata.
    Create(&'a VideoMetadata),
    /// Leave the cache untouched and report that nothing was written.
    Skip,
}

/// Converts the result of an unconditional locked update back into a bundle.
///
/// [`AnalysisJobRunner::locked_bundle_update`] reports `None` only when the
/// mutation declined to persist, which an unconditional caller never does.
fn expect_persisted(updated: Option<AnalysisBundle>) -> CoreResult<AnalysisBundle> {
    updated.ok_or_else(|| {
        CoreError::Internal(
            "Analysis bundle update reported no write for an unconditional mutation".to_string(),
        )
    })
}

// =============================================================================
// Bundle Enrichment
// =============================================================================

/// Fields a slow, out-of-lock producer wants merged into a cached bundle.
///
/// A perception provider call takes seconds of network I/O, so it cannot run
/// while the bundle lock is held, and the bundle copy it starts from is stale by
/// the time it returns. Recording only the delta lets
/// [`AnalysisJobRunner::publish_enrichment`] replay it onto the bundle as it is
/// on disk *now*, inside the lock. Re-saving the producer's whole in-memory copy
/// instead would revert every slot a concurrent writer — a CLI analysis run,
/// another GUI job — filled while the producer was working.
#[derive(Debug, Default)]
pub struct BundleEnrichment {
    /// Error keys this pass resolved, cleared before `recorded_errors` apply.
    pub cleared_errors: Vec<&'static str>,
    /// Errors this pass recorded.
    pub recorded_errors: Vec<(&'static str, String)>,
    /// Frame readings, indexed against [`Self::analyzed_shots`].
    pub frame_analysis: Option<Vec<types::FrameAnalysis>>,
    /// Semantic frame observations, indexed against [`Self::analyzed_shots`].
    pub frame_observations: Option<Vec<types::FrameObservation>>,
    /// The cut list the frame results were computed from.
    pub analyzed_shots: Option<Vec<ShotResult>>,
    /// Transcript segments plus the detail record derived from them.
    pub transcript: Option<(Vec<TranscriptSegment>, types::TranscriptDetail)>,
}

impl BundleEnrichment {
    /// Returns whether the producer came back with nothing to publish.
    pub fn is_empty(&self) -> bool {
        self.cleared_errors.is_empty()
            && self.recorded_errors.is_empty()
            && self.frame_analysis.is_none()
            && self.frame_observations.is_none()
            && self.transcript.is_none()
    }

    /// Applies the recorded delta to `bundle`, reporting whether it changed.
    ///
    /// Only the fields the producer filled are touched, so slots another writer
    /// updated meanwhile survive. Frame results address shots by position and
    /// are therefore published only while the bundle still carries the cut list
    /// they were computed from.
    fn apply(self, bundle: &mut AnalysisBundle) -> bool {
        let mut changed = false;

        for key in self.cleared_errors {
            changed |= bundle.errors.remove(key).is_some();
        }
        for (key, message) in self.recorded_errors {
            bundle.add_error(key, message);
            changed = true;
        }

        if self.frame_analysis.is_some() || self.frame_observations.is_some() {
            if bundle.has_shot_boundaries(self.analyzed_shots.as_deref()) {
                if let Some(frames) = self.frame_analysis {
                    bundle.frame_analysis = Some(frames);
                    changed = true;
                }
                if let Some(observations) = self.frame_observations {
                    bundle.frame_observations = Some(observations);
                    changed = true;
                }
            } else {
                tracing::warn!(
                    "Discarding frame results for asset {}: shots changed while the provider ran",
                    bundle.asset_id
                );
            }
        }

        if let Some((segments, detail)) = self.transcript {
            bundle.transcript = Some(segments);
            bundle.transcript_detail = Some(detail);
            changed = true;
        }

        changed
    }
}

// =============================================================================
// Analysis Job Runner
// =============================================================================

/// Orchestrates the composable video analysis pipeline.
///
/// Runs enabled sub-jobs, collects results into an `AnalysisBundle`,
/// and persists the bundle to disk for future retrieval.
pub struct AnalysisJobRunner {
    /// Project root directory
    project_dir: PathBuf,
    /// Path to FFmpeg binary (globally resolved by default)
    ffmpeg_path: PathBuf,
    /// Path to FFprobe binary (globally resolved by default)
    ffprobe_path: PathBuf,
}

impl AnalysisJobRunner {
    /// Creates a new job runner for the given project directory
    pub fn new(project_dir: &Path) -> Self {
        Self {
            project_dir: project_dir.to_path_buf(),
            ffmpeg_path: crate::core::ffmpeg::resolved_ffmpeg_path(),
            ffprobe_path: crate::core::ffmpeg::resolved_ffprobe_path(),
        }
    }

    /// Creates a job runner with a custom FFmpeg path
    pub fn with_ffmpeg_path(mut self, ffmpeg_path: PathBuf) -> Self {
        self.ffmpeg_path = ffmpeg_path;
        self
    }

    /// Creates a job runner with a custom FFprobe path
    pub fn with_ffprobe_path(mut self, ffprobe_path: PathBuf) -> Self {
        self.ffprobe_path = ffprobe_path;
        self
    }

    /// Returns the directory for an asset's analysis artifacts.
    ///
    /// Validates `asset_id` to prevent path traversal before joining.
    pub(crate) fn asset_analysis_dir(&self, asset_id: &str) -> CoreResult<PathBuf> {
        Self::validate_asset_id(asset_id)?;
        Ok(self
            .project_dir
            .join(".openreelio")
            .join(ANALYSIS_DIR)
            .join(asset_id))
    }

    /// Validates that an asset ID is safe to embed in file paths.
    fn validate_asset_id(asset_id: &str) -> CoreResult<()> {
        if asset_id.is_empty() {
            return Err(CoreError::ValidationError(
                "Asset ID must not be empty".to_string(),
            ));
        }
        if asset_id.contains('/')
            || asset_id.contains('\\')
            || asset_id.contains("..")
            || asset_id.contains(':')
        {
            return Err(CoreError::ValidationError(format!(
                "Asset ID contains unsafe path characters: {}",
                asset_id
            )));
        }
        if asset_id.bytes().any(|b| b == 0) || asset_id.chars().any(|c| c.is_control()) {
            return Err(CoreError::ValidationError(format!(
                "Asset ID contains null bytes or control characters: {}",
                asset_id
            )));
        }
        Ok(())
    }

    /// Returns the path to an asset's bundle JSON file
    fn bundle_path(&self, asset_id: &str) -> CoreResult<PathBuf> {
        Ok(self.asset_analysis_dir(asset_id)?.join(BUNDLE_FILENAME))
    }

    /// Takes the exclusive advisory lock guarding an asset's bundle.
    ///
    /// Held across a whole load-mutate-save cycle so two processes updating
    /// different slots of the same bundle cannot overwrite each other.
    fn lock_bundle_exclusive(&self, asset_id: &str) -> CoreResult<BundleLock> {
        let lock_path = self
            .asset_analysis_dir(asset_id)?
            .join(BUNDLE_LOCK_FILENAME);
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path)?;
        // Use UFCS to avoid accidentally picking up newer std methods and violating MSRV.
        fs2::FileExt::lock_exclusive(&file)?;
        Ok(BundleLock(file))
    }

    /// Runs the full analysis pipeline with the given options.
    ///
    /// Sub-jobs run in parallel where possible. Failed sub-jobs record
    /// their errors in the bundle without blocking other analyses.
    /// The resulting bundle is saved to disk.
    pub async fn analyze_full(
        &self,
        asset_id: &str,
        asset_path: &str,
        duration_sec: f64,
        has_audio: bool,
        options: &AnalysisOptions,
    ) -> CoreResult<AnalysisBundle> {
        let metadata = VideoMetadata::new(duration_sec).with_audio(has_audio);
        self.analyze_full_with_metadata(asset_id, asset_path, metadata, options, |_, _, _| {})
            .await
    }

    /// Runs the full analysis pipeline with caller-provided metadata and progress updates.
    ///
    /// The returned bundle is the one that was persisted: results this run did
    /// not reproduce are merged back from the cache under the bundle lock, so it
    /// reflects the asset's complete analysis rather than just this run's slots.
    pub async fn analyze_full_with_metadata<F>(
        &self,
        asset_id: &str,
        asset_path: &str,
        metadata: VideoMetadata,
        options: &AnalysisOptions,
        mut emit_progress: F,
    ) -> CoreResult<AnalysisBundle>
    where
        F: FnMut(&str, &str, Option<String>),
    {
        let video_path = Path::new(asset_path);
        if !video_path.exists() {
            return Err(CoreError::FileNotFound(asset_path.to_string()));
        }

        let mut bundle = AnalysisBundle::new(asset_id, metadata);

        if options.shots {
            emit_progress("shots", "started", None);
        }
        if options.audio {
            emit_progress("audio", "started", None);
        }
        if options.transcript {
            emit_progress("transcript", "started", None);
        }

        // Phase 1: Run shot detection, audio profiling, and transcription in parallel.
        let (shots_result, audio_result, transcript_result) = tokio::join!(
            self.run_shots_if_enabled(video_path, asset_id, bundle.metadata.duration_sec, options),
            self.run_audio_if_enabled(
                video_path,
                bundle.metadata.duration_sec,
                bundle.metadata.has_audio,
                options,
            ),
            self.run_transcript_if_enabled(
                video_path,
                asset_id,
                bundle.metadata.has_audio,
                options
            ),
        );

        // Collect shot results
        let shots = match shots_result {
            Ok(Some(shots)) => {
                bundle.shots = Some(shots.clone());
                emit_progress(
                    "shots",
                    "completed",
                    Some(format!("{} shots detected", shots.len())),
                );
                Some(shots)
            }
            Ok(None) => None,
            Err(e) => {
                bundle.add_error("shots", e.to_string());
                emit_progress("shots", "failed", Some(e.to_string()));
                None
            }
        };

        if let Some(ref shots) = shots {
            match self
                .generate_contact_sheet_if_possible(asset_id, shots)
                .await
            {
                Ok(Some(contact_sheet)) => {
                    bundle.contact_sheet = Some(contact_sheet);
                }
                Ok(None) => {}
                Err(e) => {
                    bundle.add_error("contact_sheet", e.to_string());
                }
            }
        }

        // Collect audio results
        let audio_profile = match audio_result {
            Ok(Some(profile)) => {
                bundle.audio_profile = Some(profile.clone());
                emit_progress(
                    "audio",
                    "completed",
                    Some("Audio profile extracted".to_string()),
                );
                Some(profile)
            }
            Ok(None) => None,
            Err(e) => {
                bundle.add_error("audio", e.to_string());
                emit_progress("audio", "failed", Some(e.to_string()));
                None
            }
        };

        let transcript = match transcript_result {
            Ok(Some(transcript)) => {
                let transcript = infer_speaker_turns(
                    &transcript,
                    audio_profile
                        .as_ref()
                        .map(|profile| profile.speech_regions.as_slice())
                        .unwrap_or(&[]),
                );
                bundle.transcript = Some(transcript.clone());
                if !transcript.is_empty() {
                    let transcript_model =
                        crate::core::captions::whisper::WhisperModel::default_for_dir(
                            &default_models_dir(),
                        );
                    bundle.transcript_detail = Some(build_transcript_detail_from_segments(
                        &transcript,
                        "whisper",
                        transcript_model.name(),
                    ));
                }
                emit_progress(
                    "transcript",
                    "completed",
                    Some(format!("{} transcript segments", transcript.len())),
                );
                Some(transcript)
            }
            Ok(None) => None,
            Err(e) => {
                bundle.add_error("transcript", e.to_string());
                emit_progress("transcript", "failed", Some(e.to_string()));
                None
            }
        };

        if options.segments {
            emit_progress("segments", "started", None);
        }
        if options.visual {
            emit_progress("visual", "started", None);
        }

        // Phase 2: Run segmentation and visual analysis in parallel
        // (these depend on shots and/or audio from phase 1)
        let (segments_result, visual_result) = tokio::join!(
            self.run_segments_if_enabled(
                bundle.metadata.duration_sec,
                &shots,
                &audio_profile,
                transcript.as_deref(),
                options,
            ),
            self.run_visual_if_enabled(video_path, &shots, asset_id, options),
        );

        // Collect segmentation results
        match segments_result {
            Ok(Some(segments)) => {
                bundle.segments = Some(segments);
                emit_progress(
                    "segments",
                    "completed",
                    Some("Content segments classified".to_string()),
                );
            }
            Ok(None) => {
                if options.segments {
                    emit_progress(
                        "segments",
                        "skipped",
                        Some("Content segmentation prerequisites were unavailable".to_string()),
                    );
                }
            }
            Err(e) => {
                bundle.add_error("segments", e.to_string());
                emit_progress("segments", "failed", Some(e.to_string()));
            }
        }

        // Collect visual analysis results
        match visual_result {
            Ok(Some(frames)) => {
                bundle.frame_analysis = Some(frames);
                emit_progress(
                    "visual",
                    "completed",
                    Some("Visual frame analysis completed".to_string()),
                );
            }
            Ok(None) => {
                if options.visual {
                    emit_progress(
                        "visual",
                        "skipped",
                        Some("Visual analysis prerequisites were unavailable".to_string()),
                    );
                }
            }
            Err(e) => {
                bundle.add_error("visual", e.to_string());
                emit_progress("visual", "failed", Some(e.to_string()));
            }
        }

        // Save bundle to disk. The write merges with whatever is cached, so a
        // run with only some sub-jobs enabled keeps the results it did not
        // reproduce instead of erasing them.
        let bundle = self.save_bundle(&bundle)?;
        emit_progress(
            "bundle",
            "saved",
            Some(
                self.bundle_path(asset_id)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| "unknown".to_string()),
            ),
        );

        Ok(bundle)
    }

    /// Loads a cached analysis bundle from disk.
    pub fn load_bundle(&self, asset_id: &str) -> CoreResult<AnalysisBundle> {
        self.load_bundle_optional(asset_id)?
            .ok_or_else(|| CoreError::AnalysisBundleNotFound(asset_id.to_string()))
    }

    /// Loads a cached analysis bundle from disk when it exists.
    pub fn load_bundle_optional(&self, asset_id: &str) -> CoreResult<Option<AnalysisBundle>> {
        let path = self.bundle_path(asset_id)?;
        if !path.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(&path)?;
        let bundle: AnalysisBundle = serde_json::from_str(&content)?;
        Ok(Some(bundle))
    }

    /// Writes a bundle to disk with an atomic replace.
    ///
    /// Uses `atomic_write_json_pretty` from `crate::core::fs`, which handles
    /// Windows rename-over-existing semantics correctly.
    ///
    /// Private on purpose: the caller must already hold the bundle lock, which
    /// only [`Self::locked_bundle_update`] takes. Every write of `bundle.json`
    /// goes through that one path so a new writer cannot forget the lock.
    fn write_bundle(&self, bundle: &AnalysisBundle) -> CoreResult<()> {
        let path = self.bundle_path(&bundle.asset_id)?;

        crate::core::fs::atomic_write_json_pretty(&path, bundle)?;

        tracing::debug!(
            "Analysis bundle saved for asset {} at {}",
            bundle.asset_id,
            path.display()
        );

        Ok(())
    }

    /// Loads, mutates and writes the asset's bundle under the bundle lock.
    ///
    /// This is the only read-modify-write cycle over `bundle.json`. The GUI job
    /// worker and a CLI invocation are separate processes updating different
    /// slots of the same file, so holding the advisory lock across the whole
    /// cycle is what keeps the later write from silently dropping the earlier
    /// one.
    ///
    /// `mutate` returns `false` to abandon the update, leaving the cached bundle
    /// — including its `analyzed_at` stamp — exactly as it was. `missing` decides
    /// what happens when the asset has no cached bundle yet.
    fn locked_bundle_update<F>(
        &self,
        asset_id: &str,
        missing: MissingBundle<'_>,
        mutate: F,
    ) -> CoreResult<Option<AnalysisBundle>>
    where
        F: FnOnce(&mut AnalysisBundle) -> bool,
    {
        let _lock = self.lock_bundle_exclusive(asset_id)?;

        let mut bundle = match self.load_bundle_optional(asset_id)? {
            Some(bundle) => bundle,
            None => match missing {
                MissingBundle::Create(metadata) => AnalysisBundle::new(asset_id, metadata.clone()),
                MissingBundle::Skip => return Ok(None),
            },
        };

        if !mutate(&mut bundle) {
            return Ok(None);
        }

        bundle.analyzed_at = chrono::Utc::now().to_rfc3339();

        self.write_bundle(&bundle)?;
        Ok(Some(bundle))
    }

    /// Publishes a caller-produced bundle, keeping cached results it does not carry.
    ///
    /// A pipeline run only fills the slots its enabled sub-jobs produced, and a
    /// concurrent writer may have filled others in the meantime. The write takes
    /// the bundle lock and merges rather than overwrites: fresh results win, and
    /// slots this bundle leaves empty keep what the cache already held (subject
    /// to [`AnalysisBundle::backfill_missing_from`], which refuses to restore
    /// failed or shot-orphaned slots).
    ///
    /// Returns the bundle that was persisted.
    ///
    /// Private on purpose: publishing a whole bundle is only sound for the
    /// pipeline run that just produced it, because the merge can restore an
    /// absent slot but cannot tell a caller's stale value from a fresh one. A
    /// producer that works from a copy while other writers run — anything doing
    /// network I/O — must publish its delta through
    /// [`Self::publish_enrichment`] or [`Self::merge_bundle_update`] instead, so
    /// the read its merge is based on happens under the bundle lock.
    fn save_bundle(&self, bundle: &AnalysisBundle) -> CoreResult<AnalysisBundle> {
        let fresh = bundle.clone();
        let metadata = bundle.metadata.clone();
        let updated = self.locked_bundle_update(
            &bundle.asset_id,
            MissingBundle::Create(&metadata),
            move |stored| {
                let previous = std::mem::replace(stored, fresh);
                stored.backfill_missing_from(&previous);
                true
            },
        )?;
        expect_persisted(updated)
    }

    /// Applies `mutate` to the asset's cached bundle and writes it back.
    ///
    /// The bundle is loaded from disk first, so a caller that produces only one
    /// kind of result (shot detection, an audio profile) updates its own slot
    /// without discarding what earlier runs stored. When no bundle exists yet,
    /// a fresh one is created from `fallback_metadata`.
    ///
    /// Returns the merged bundle that was persisted.
    pub fn merge_bundle_update<F>(
        &self,
        asset_id: &str,
        fallback_metadata: &VideoMetadata,
        mutate: F,
    ) -> CoreResult<AnalysisBundle>
    where
        F: FnOnce(&mut AnalysisBundle),
    {
        let updated = self.locked_bundle_update(
            asset_id,
            MissingBundle::Create(fallback_metadata),
            |bundle| {
                mutate(bundle);
                true
            },
        )?;
        expect_persisted(updated)
    }

    /// Applies `mutate` to the asset's cached bundle, letting it decline the write.
    ///
    /// Same locking as [`Self::merge_bundle_update`], but `mutate` returns
    /// `false` when it finds nothing to merge into. The decision therefore
    /// happens under the same lock as the write, so a caller cannot report a
    /// successful update based on a state that changed before it wrote.
    ///
    /// Returns `None` when the mutation declined.
    pub fn try_merge_bundle_update<F>(
        &self,
        asset_id: &str,
        fallback_metadata: &VideoMetadata,
        mutate: F,
    ) -> CoreResult<Option<AnalysisBundle>>
    where
        F: FnOnce(&mut AnalysisBundle) -> bool,
    {
        self.locked_bundle_update(asset_id, MissingBundle::Create(fallback_metadata), mutate)
    }

    /// Merges a provider enrichment into the asset's cached bundle.
    ///
    /// The read the merge is based on happens inside the bundle lock, so the
    /// enrichment lands on the bundle as it is on disk when the producer
    /// returns rather than on the copy the producer started from. Returns
    /// `None` when the enrichment carries nothing, or nothing it carries
    /// changes the cached bundle; nothing is written in that case, so the
    /// `analyzed_at` stamp is left alone.
    pub fn publish_enrichment(
        &self,
        asset_id: &str,
        fallback_metadata: &VideoMetadata,
        enrichment: BundleEnrichment,
    ) -> CoreResult<Option<AnalysisBundle>> {
        if enrichment.is_empty() {
            return Ok(None);
        }

        self.try_merge_bundle_update(asset_id, fallback_metadata, |stored| {
            enrichment.apply(stored)
        })
    }

    /// Applies `mutate` to an already cached bundle, never creating one.
    ///
    /// For updates that only make sense on top of existing results, such as
    /// importing diarization into a transcript the pipeline produced. Returns
    /// `None` when no bundle is cached or when `mutate` declined; both the
    /// existence check and the write happen under the bundle lock.
    pub fn update_cached_bundle<F>(
        &self,
        asset_id: &str,
        mutate: F,
    ) -> CoreResult<Option<AnalysisBundle>>
    where
        F: FnOnce(&mut AnalysisBundle) -> bool,
    {
        self.locked_bundle_update(asset_id, MissingBundle::Skip, mutate)
    }

    /// Merges shot-detection results into the asset's cached bundle.
    ///
    /// Uses [`AnalysisBundle::replace_shots`], so keyframes recorded for
    /// unchanged boundaries survive and results indexed by shot position are
    /// dropped when the cut list changes.
    pub fn merge_bundle_shots(
        &self,
        asset_id: &str,
        fallback_metadata: &VideoMetadata,
        shots: Vec<ShotResult>,
    ) -> CoreResult<AnalysisBundle> {
        self.merge_bundle_update(asset_id, fallback_metadata, |bundle| {
            bundle.replace_shots(shots);
            bundle.errors.remove("shots");
        })
    }

    /// Merges an audio profile into the asset's cached bundle.
    pub fn merge_bundle_audio_profile(
        &self,
        asset_id: &str,
        fallback_metadata: &VideoMetadata,
        audio_profile: AudioProfile,
    ) -> CoreResult<AnalysisBundle> {
        self.merge_bundle_update(asset_id, fallback_metadata, |bundle| {
            bundle.audio_profile = Some(audio_profile);
            bundle.errors.remove("audio");
        })
    }

    async fn generate_contact_sheet_if_possible(
        &self,
        asset_id: &str,
        shots: &[ShotResult],
    ) -> CoreResult<Option<ContactSheetArtifact>> {
        let keyframes = shots
            .iter()
            .filter_map(|shot| shot.keyframe_path.as_ref().map(PathBuf::from))
            .collect::<Vec<_>>();
        if keyframes.is_empty() {
            return Ok(None);
        }

        let output_path = self
            .asset_analysis_dir(asset_id)?
            .join(CONTACT_SHEET_FILENAME);
        let analyzer = VisualAnalyzer::new(self.ffmpeg_path.clone());
        analyzer
            .generate_contact_sheet(&keyframes, &output_path)
            .await
    }

    // =========================================================================
    // Sub-job runners
    // =========================================================================

    /// Runs shot detection if enabled in options
    async fn run_shots_if_enabled(
        &self,
        video_path: &Path,
        asset_id: &str,
        duration_sec: f64,
        options: &AnalysisOptions,
    ) -> CoreResult<Option<Vec<ShotResult>>> {
        if !options.shots {
            return Ok(None);
        }

        let config = ShotDetectorConfig {
            ffmpeg_path: Some(self.ffmpeg_path.clone()),
            ffprobe_path: Some(self.ffprobe_path.clone()),
            ..Default::default()
        };

        let detector = ShotDetector::with_config(config);
        let detected_shots = detector.detect(video_path, asset_id).await?;

        let mut results: Vec<ShotResult> = detected_shots
            .into_iter()
            .map(|shot| {
                let mut result = ShotResult::new(
                    shot.start_sec,
                    shot.end_sec,
                    shot.quality_score.unwrap_or(0.9),
                );
                result.keyframe_path = shot.keyframe_path;
                result
            })
            .collect();

        if results.is_empty() {
            results.push(ShotResult::new(0.0, duration_sec, 1.0));
        }

        let analyzer = VisualAnalyzer::new(self.ffmpeg_path.clone());
        let keyframe_dir = self.asset_analysis_dir(asset_id)?.join("keyframes");
        let keyframes = analyzer
            .extract_keyframes(video_path, &results, &keyframe_dir)
            .await?;

        for (shot, keyframe) in results.iter_mut().zip(keyframes) {
            shot.keyframe_path = Some(keyframe.path.to_string_lossy().to_string());
            shot.keyframe_selection_method = Some(keyframe.method);
        }

        Ok(Some(results))
    }

    /// Runs transcription if enabled in options.
    async fn run_transcript_if_enabled(
        &self,
        video_path: &Path,
        asset_id: &str,
        has_audio: bool,
        options: &AnalysisOptions,
    ) -> CoreResult<Option<Vec<TranscriptSegment>>> {
        if !options.transcript {
            return Ok(None);
        }

        if !has_audio {
            return Ok(Some(Vec::new()));
        }

        if !is_whisper_available() {
            return Err(CoreError::NotSupported(
                "Transcription requires the optional whisper feature".to_string(),
            ));
        }

        let models_dir = default_models_dir();
        let model = crate::core::captions::whisper::WhisperModel::default_for_dir(&models_dir);
        let model_path = models_dir.join(model.filename());
        if !model_path.exists() {
            return Err(CoreError::NotFound(format!(
                "Whisper model not found at {}",
                model_path.display()
            )));
        }

        let analysis_dir = self.asset_analysis_dir(asset_id)?;
        tokio::fs::create_dir_all(&analysis_dir).await?;

        let temp_audio_path = analysis_dir.join("transcript.wav");
        let temp_audio_path_for_cleanup = temp_audio_path.clone();
        let input_path = video_path.to_path_buf();
        let ffmpeg_path = self.ffmpeg_path.to_string_lossy().to_string();
        let model_path_for_task = model_path.clone();

        let transcript_result =
            tokio::task::spawn_blocking(move || -> CoreResult<Vec<TranscriptSegment>> {
                extract_audio_for_transcription(&input_path, &temp_audio_path, Some(&ffmpeg_path))
                    .map_err(|error| {
                        CoreError::AnalysisFailed(format!(
                            "Failed to extract audio for transcription: {}",
                            error
                        ))
                    })?;

                let samples = load_audio_samples(&temp_audio_path).map_err(|error| {
                    CoreError::AnalysisFailed(format!(
                        "Failed to load transcription audio samples: {}",
                        error
                    ))
                })?;

                let engine = WhisperEngine::new(&model_path_for_task).map_err(|error| {
                    CoreError::AnalysisFailed(format!("Failed to initialize Whisper: {}", error))
                })?;

                let options = TranscriptionOptions::default();
                let result = engine.transcribe(&samples, &options).map_err(|error| {
                    CoreError::AnalysisFailed(format!("Transcription failed: {}", error))
                })?;

                let language = result.language.clone();
                Ok(result
                    .segments
                    .into_iter()
                    .map(|segment| {
                        TranscriptSegment::new(
                            segment.start_time,
                            segment.end_time,
                            &segment.text,
                            0.9,
                        )
                        .with_language(&language)
                    })
                    .collect())
            })
            .await
            .map_err(|error| {
                CoreError::AnalysisFailed(format!("Transcription task panicked: {}", error))
            })?;

        let _ = tokio::fs::remove_file(&temp_audio_path_for_cleanup).await;

        transcript_result.map(Some)
    }

    /// Runs audio profiling if enabled in options
    async fn run_audio_if_enabled(
        &self,
        video_path: &Path,
        duration_sec: f64,
        has_audio: bool,
        options: &AnalysisOptions,
    ) -> CoreResult<Option<AudioProfile>> {
        if !options.audio {
            return Ok(None);
        }

        if !has_audio {
            return Ok(Some(AudioProfile::silent(duration_sec)));
        }

        let profiler = AudioProfiler::new(self.ffmpeg_path.clone());
        let profile = profiler.analyze(video_path, duration_sec).await?;
        Ok(Some(profile))
    }

    /// Runs content segmentation if enabled in options
    async fn run_segments_if_enabled(
        &self,
        duration_sec: f64,
        shots: &Option<Vec<ShotResult>>,
        audio: &Option<AudioProfile>,
        transcript: Option<&[TranscriptSegment]>,
        options: &AnalysisOptions,
    ) -> CoreResult<Option<Vec<ContentSegment>>> {
        if !options.segments {
            return Ok(None);
        }

        // Segmentation requires shots and audio as inputs
        let shots_ref = match shots {
            Some(s) => s,
            None => {
                tracing::warn!("Content segmentation skipped: shot detection results unavailable");
                return Ok(None);
            }
        };

        let audio_ref = match audio {
            Some(a) => a,
            None => {
                tracing::warn!("Content segmentation skipped: audio profile unavailable");
                return Ok(None);
            }
        };

        let segmenter = ContentSegmenter::new();
        let segments =
            segmenter.segment_with_transcript(duration_sec, shots_ref, audio_ref, transcript)?;
        Ok(Some(segments))
    }

    /// Runs visual frame analysis if enabled in options
    async fn run_visual_if_enabled(
        &self,
        video_path: &Path,
        shots: &Option<Vec<ShotResult>>,
        asset_id: &str,
        options: &AnalysisOptions,
    ) -> CoreResult<Option<Vec<FrameAnalysis>>> {
        if !options.visual {
            return Ok(None);
        }

        let shots_ref = match shots {
            Some(s) if !s.is_empty() => s,
            _ => {
                tracing::warn!(
                    "Visual analysis skipped: shot detection results unavailable or empty"
                );
                return Ok(None);
            }
        };

        let analyzer = VisualAnalyzer::new(self.ffmpeg_path.clone());

        if options.local_only {
            // Local fallback: FFmpeg-based complexity estimation only
            let frames = analyzer.analyze_frames_local(video_path, shots_ref).await?;
            return Ok(Some(frames));
        }

        // For non-local-only mode, extract keyframes for potential vision API use.
        // The actual vision API call is handled at a higher layer (agent tools).
        // Here we provide local fallback as the default.
        let keyframe_dir = self.asset_analysis_dir(asset_id)?.join("keyframes");
        let _keyframe_paths = analyzer
            .extract_keyframes(video_path, shots_ref, &keyframe_dir)
            .await?;

        // Default to local analysis; vision API results can update the bundle later
        let frames = analyzer.analyze_frames_local(video_path, shots_ref).await?;
        Ok(Some(frames))
    }
}

fn build_transcript_detail_from_segments(
    transcript: &[TranscriptSegment],
    provider: &str,
    model: &str,
) -> types::TranscriptDetail {
    let full = transcript
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let words = estimate_word_timings(transcript);
    let speaker_segments = transcript
        .iter()
        .filter_map(|segment| {
            segment
                .speaker_id
                .as_ref()
                .map(|speaker_id| types::SpeakerSegment {
                    start_sec: segment.start_sec,
                    end_sec: segment.end_sec,
                    speaker_id: speaker_id.clone(),
                    text: segment.text.trim().to_string(),
                    confidence: Some(segment.confidence),
                })
        })
        .collect();

    types::TranscriptDetail {
        full,
        words,
        speaker_segments,
        provider: Some(types::PerceptionProviderMetadata::new(provider, model)),
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn should_compute_correct_bundle_path() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let path = runner.bundle_path("asset_001").unwrap();
        assert!(path.ends_with(".openreelio/analysis/asset_001/bundle.json"));
    }

    #[test]
    fn should_save_and_load_bundle_roundtrip() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut bundle =
            AnalysisBundle::new("asset_001", VideoMetadata::new(60.0).with_audio(true));
        bundle.shots = Some(vec![
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 12.0, 0.85),
        ]);
        bundle.audio_profile = Some(AudioProfile {
            bpm: Some(120.0),
            spectral_centroid_hz: 2500.0,
            loudness_profile: vec![-18.0, -16.5],
            peak_db: -0.5,
            silence_regions: vec![],
            speech_regions: vec![],
        });
        bundle.contact_sheet = Some(ContactSheetArtifact {
            path: temp_dir.path().join("sheet.jpg").display().to_string(),
            frame_count: 2,
            columns: 2,
            rows: 1,
        });

        runner.save_bundle(&bundle).unwrap();

        let loaded = runner.load_bundle("asset_001").unwrap();
        assert_eq!(loaded.asset_id, "asset_001");
        assert_eq!(loaded.shots.as_ref().unwrap().len(), 2);
        assert_eq!(loaded.audio_profile.as_ref().unwrap().bpm, Some(120.0));
        assert_eq!(loaded.contact_sheet.as_ref().unwrap().columns, 2);
    }

    #[test]
    fn should_create_bundle_from_fallback_metadata_when_merging_into_nothing() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());
        let metadata = VideoMetadata::new(12.0).with_audio(true);

        let merged = runner
            .merge_bundle_shots(
                "asset_100",
                &metadata,
                vec![ShotResult::new(0.0, 12.0, 0.9)],
            )
            .unwrap();

        assert_eq!(merged.metadata.duration_sec, 12.0);
        assert_eq!(merged.shots.as_ref().unwrap().len(), 1);
        assert_eq!(
            runner
                .load_bundle("asset_100")
                .unwrap()
                .shots
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn should_not_lose_a_slot_when_two_threads_merge_the_same_bundle() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().to_path_buf();
        let metadata = VideoMetadata::new(30.0).with_audio(true);

        let shots_dir = project_dir.clone();
        let shots_metadata = metadata.clone();
        let shots_writer = std::thread::spawn(move || {
            let runner = AnalysisJobRunner::new(&shots_dir);
            for _ in 0..20 {
                runner
                    .merge_bundle_shots(
                        "asset_200",
                        &shots_metadata,
                        vec![ShotResult::new(0.0, 30.0, 0.9)],
                    )
                    .unwrap();
            }
        });

        let audio_writer = std::thread::spawn(move || {
            let runner = AnalysisJobRunner::new(&project_dir);
            for _ in 0..20 {
                runner
                    .merge_bundle_audio_profile("asset_200", &metadata, AudioProfile::silent(30.0))
                    .unwrap();
            }
        });

        shots_writer.join().unwrap();
        audio_writer.join().unwrap();

        let runner = AnalysisJobRunner::new(temp_dir.path());
        let loaded = runner.load_bundle("asset_200").unwrap();
        assert!(
            loaded.shots.is_some(),
            "the shots slot must survive concurrent audio merges"
        );
        assert!(
            loaded.audio_profile.is_some(),
            "the audio slot must survive concurrent shot merges"
        );
    }

    #[test]
    fn should_not_lose_a_slot_when_a_pipeline_save_races_a_merge() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().to_path_buf();
        let metadata = VideoMetadata::new(30.0).with_audio(true);

        // Stands in for the GUI job worker: publishes a whole bundle produced by
        // a run that only enabled shot detection.
        let pipeline_dir = project_dir.clone();
        let pipeline_metadata = metadata.clone();
        let pipeline_writer = std::thread::spawn(move || {
            let runner = AnalysisJobRunner::new(&pipeline_dir);
            for _ in 0..20 {
                let mut bundle = AnalysisBundle::new("asset_201", pipeline_metadata.clone());
                bundle.shots = Some(vec![ShotResult::new(0.0, 30.0, 0.9)]);
                runner.save_bundle(&bundle).unwrap();
            }
        });

        // Stands in for a concurrent CLI `analysis audio`.
        let audio_writer = std::thread::spawn(move || {
            let runner = AnalysisJobRunner::new(&project_dir);
            for _ in 0..20 {
                runner
                    .merge_bundle_audio_profile("asset_201", &metadata, AudioProfile::silent(30.0))
                    .unwrap();
            }
        });

        pipeline_writer.join().unwrap();
        audio_writer.join().unwrap();

        let runner = AnalysisJobRunner::new(temp_dir.path());
        let loaded = runner.load_bundle("asset_201").unwrap();
        assert!(loaded.shots.is_some());
        assert!(
            loaded.audio_profile.is_some(),
            "a pipeline save must not overwrite a slot another writer filled"
        );
    }

    #[test]
    fn should_keep_cached_results_a_partial_run_did_not_reproduce() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut cached = AnalysisBundle::new("asset_202", VideoMetadata::new(30.0));
        cached.audio_profile = Some(AudioProfile::silent(30.0));
        cached.segments = Some(Vec::new());
        runner.save_bundle(&cached).unwrap();

        let mut fresh = AnalysisBundle::new("asset_202", VideoMetadata::new(30.0));
        fresh.shots = Some(vec![ShotResult::new(0.0, 30.0, 0.9)]);
        let persisted = runner.save_bundle(&fresh).unwrap();

        assert!(persisted.shots.is_some());
        assert!(persisted.audio_profile.is_some());
        assert!(persisted.segments.is_some());
        assert!(runner
            .load_bundle("asset_202")
            .unwrap()
            .audio_profile
            .is_some());
    }

    #[test]
    fn should_drop_shot_indexed_results_when_merged_shots_change_the_cut_list() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut cached = AnalysisBundle::new("asset_203", VideoMetadata::new(30.0));
        cached.shots = Some(vec![ShotResult::new(0.0, 30.0, 0.9)
            .with_keyframe(&temp_dir.path().join("shot_000.jpg").display().to_string())]);
        cached.frame_analysis = Some(vec![FrameAnalysis::local_fallback(0, 0.5)]);
        cached.contact_sheet = Some(ContactSheetArtifact {
            path: temp_dir.path().join("sheet.jpg").display().to_string(),
            frame_count: 1,
            columns: 1,
            rows: 1,
        });
        runner.save_bundle(&cached).unwrap();

        let merged = runner
            .merge_bundle_shots(
                "asset_203",
                &VideoMetadata::new(30.0),
                vec![
                    ShotResult::new(0.0, 12.0, 0.9),
                    ShotResult::new(12.0, 30.0, 0.9),
                ],
            )
            .unwrap();

        assert_eq!(merged.shots.as_ref().unwrap().len(), 2);
        assert!(
            merged.frame_analysis.is_none(),
            "readings of the old shot 0 must not be re-attached to a new shot 0"
        );
        assert!(merged.contact_sheet.is_none());

        let loaded = runner.load_bundle("asset_203").unwrap();
        assert!(loaded.frame_analysis.is_none());
        assert!(loaded.contact_sheet.is_none());
    }

    #[test]
    fn should_keep_keyframes_when_merged_shots_reproduce_the_cut_list() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());
        let keyframe = temp_dir.path().join("shot_000.jpg").display().to_string();

        let mut cached = AnalysisBundle::new("asset_204", VideoMetadata::new(30.0));
        cached.shots = Some(vec![
            ShotResult::new(0.0, 30.0, 0.9).with_keyframe(&keyframe)
        ]);
        cached.contact_sheet = Some(ContactSheetArtifact {
            path: temp_dir.path().join("sheet.jpg").display().to_string(),
            frame_count: 1,
            columns: 1,
            rows: 1,
        });
        runner.save_bundle(&cached).unwrap();

        // `analysis shots` re-detects the same cuts without extracting keyframes.
        let merged = runner
            .merge_bundle_shots(
                "asset_204",
                &VideoMetadata::new(30.0),
                vec![ShotResult::new(0.0, 30.0, 0.8)],
            )
            .unwrap();

        assert_eq!(
            merged.shots.as_ref().unwrap()[0].keyframe_path.as_deref(),
            Some(keyframe.as_str())
        );
        assert!(merged.contact_sheet.is_some());
    }

    #[test]
    fn should_not_write_when_a_merge_declines() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut cached = AnalysisBundle::new("asset_205", VideoMetadata::new(30.0));
        cached.analyzed_at = "2020-01-01T00:00:00+00:00".to_string();
        runner.save_bundle(&cached).unwrap();
        let stamp_before = runner.load_bundle("asset_205").unwrap().analyzed_at;

        let declined = runner
            .try_merge_bundle_update("asset_205", &VideoMetadata::new(30.0), |bundle| {
                bundle.segments = Some(Vec::new());
                false
            })
            .unwrap();

        assert!(declined.is_none());
        let loaded = runner.load_bundle("asset_205").unwrap();
        assert!(loaded.segments.is_none());
        assert_eq!(loaded.analyzed_at, stamp_before);
    }

    #[test]
    fn should_not_create_a_bundle_when_updating_an_uncached_asset() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let updated = runner
            .update_cached_bundle("asset_206", |bundle| {
                bundle.segments = Some(Vec::new());
                true
            })
            .unwrap();

        assert!(updated.is_none());
        assert!(runner.load_bundle_optional("asset_206").unwrap().is_none());
    }

    #[test]
    fn should_preserve_other_results_when_merging_shots_into_an_existing_bundle() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut existing = AnalysisBundle::new("asset_101", VideoMetadata::new(30.0));
        existing.audio_profile = Some(AudioProfile::silent(30.0));
        existing.segments = Some(Vec::new());
        runner.save_bundle(&existing).unwrap();

        runner
            .merge_bundle_shots(
                "asset_101",
                &VideoMetadata::new(0.0),
                vec![ShotResult::new(0.0, 30.0, 0.8)],
            )
            .unwrap();

        let loaded = runner.load_bundle("asset_101").unwrap();
        assert_eq!(loaded.shots.as_ref().unwrap().len(), 1);
        assert!(loaded.audio_profile.is_some());
        assert!(loaded.segments.is_some());
        // The fallback metadata must not overwrite what the bundle already knows.
        assert_eq!(loaded.metadata.duration_sec, 30.0);
    }

    #[test]
    fn should_clear_the_matching_error_when_merging_a_successful_result() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut existing = AnalysisBundle::new("asset_102", VideoMetadata::new(30.0));
        existing.add_error("audio", "FFmpeg missing".to_string());
        existing.add_error("shots", "FFmpeg missing".to_string());
        runner.save_bundle(&existing).unwrap();

        runner
            .merge_bundle_audio_profile(
                "asset_102",
                &VideoMetadata::new(30.0),
                AudioProfile::silent(30.0),
            )
            .unwrap();

        let loaded = runner.load_bundle("asset_102").unwrap();
        assert!(!loaded.errors.contains_key("audio"));
        assert!(loaded.errors.contains_key("shots"));
    }

    #[test]
    fn should_keep_a_concurrent_writers_slot_when_publishing_an_enrichment() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());
        let metadata = VideoMetadata::new(30.0).with_audio(true);

        // The bundle a perception provider starts its (slow) call from.
        let mut published = AnalysisBundle::new("asset_300", metadata.clone());
        published.shots = Some(vec![ShotResult::new(0.0, 30.0, 0.9)]);
        published.audio_profile = Some(AudioProfile::silent(30.0));
        runner.save_bundle(&published).unwrap();

        // A second writer re-profiles the audio while the provider is working.
        let mut reprofiled = AudioProfile::silent(30.0);
        reprofiled.bpm = Some(128.0);
        runner
            .merge_bundle_audio_profile("asset_300", &metadata, reprofiled)
            .unwrap();

        let enrichment = BundleEnrichment {
            transcript: Some((
                vec![TranscriptSegment::new(0.0, 2.0, "hello", 0.9)],
                build_transcript_detail_from_segments(
                    &[TranscriptSegment::new(0.0, 2.0, "hello", 0.9)],
                    "openai",
                    "gpt-test",
                ),
            )),
            ..Default::default()
        };
        let persisted = runner
            .publish_enrichment("asset_300", &metadata, enrichment)
            .unwrap()
            .expect("an enrichment carrying a transcript must be written");

        assert_eq!(
            persisted.audio_profile.as_ref().unwrap().bpm,
            Some(128.0),
            "the concurrent writer's audio profile must survive the enrichment"
        );
        assert!(persisted.transcript_detail.is_some());
        let reloaded = runner.load_bundle("asset_300").unwrap();
        assert_eq!(reloaded.audio_profile.as_ref().unwrap().bpm, Some(128.0));
        assert!(reloaded.transcript_detail.is_some());
    }

    #[test]
    fn should_discard_enriched_frame_results_when_shots_changed_during_the_provider_call() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());
        let metadata = VideoMetadata::new(30.0);

        let analyzed_shots = vec![
            ShotResult::new(0.0, 10.0, 0.9),
            ShotResult::new(10.0, 30.0, 0.9),
        ];
        let mut published = AnalysisBundle::new("asset_301", metadata.clone());
        published.shots = Some(analyzed_shots.clone());
        runner.save_bundle(&published).unwrap();

        // A re-detection lands while the provider is still reading the old cuts.
        runner
            .merge_bundle_shots(
                "asset_301",
                &metadata,
                vec![
                    ShotResult::new(0.0, 4.0, 0.9),
                    ShotResult::new(4.0, 30.0, 0.9),
                ],
            )
            .unwrap();

        let enrichment = BundleEnrichment {
            frame_analysis: Some(vec![FrameAnalysis::local_fallback(0, 0.5)]),
            analyzed_shots: Some(analyzed_shots),
            ..Default::default()
        };
        runner
            .publish_enrichment("asset_301", &metadata, enrichment)
            .unwrap();

        let reloaded = runner.load_bundle("asset_301").unwrap();
        assert_eq!(reloaded.shots.as_ref().unwrap()[0].end_sec, 4.0);
        assert!(
            reloaded.frame_analysis.is_none(),
            "frame results indexed against superseded shots must not be published"
        );
    }

    #[test]
    fn should_return_error_when_bundle_not_found() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let result = runner.load_bundle("nonexistent_asset");
        assert!(result.is_err());
    }

    #[test]
    fn should_return_none_when_optional_bundle_not_found() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let result = runner.load_bundle_optional("nonexistent_asset").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn should_save_bundle_with_errors() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        let mut bundle = AnalysisBundle::new("asset_002", VideoMetadata::new(30.0));
        bundle.shots = Some(vec![ShotResult::new(0.0, 30.0, 1.0)]);
        bundle.add_error("transcript", "Whisper not available".to_string());
        bundle.add_error("visual", "Vision API timeout".to_string());

        runner.save_bundle(&bundle).unwrap();

        let loaded = runner.load_bundle("asset_002").unwrap();
        assert!(loaded.shots.is_some());
        assert!(loaded.transcript.is_none());
        assert_eq!(loaded.errors.len(), 2);
        assert_eq!(loaded.errors["transcript"], "Whisper not available");
    }

    #[test]
    fn should_publish_fresh_results_over_an_existing_bundle_on_save() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        // Save first version
        let mut bundle1 = AnalysisBundle::new("asset_003", VideoMetadata::new(10.0));
        bundle1.shots = Some(vec![ShotResult::new(0.0, 10.0, 0.5)]);
        runner.save_bundle(&bundle1).unwrap();

        // Save updated version
        let mut bundle2 = AnalysisBundle::new("asset_003", VideoMetadata::new(10.0));
        bundle2.shots = Some(vec![ShotResult::new(0.0, 10.0, 1.0)]);
        runner.save_bundle(&bundle2).unwrap();

        let loaded = runner.load_bundle("asset_003").unwrap();
        assert_eq!(loaded.shots.as_ref().unwrap()[0].confidence, 1.0);
    }

    #[tokio::test]
    async fn should_return_complete_bundle_when_all_options_disabled() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        // Create a dummy file for the asset path
        let video_path = temp_dir.path().join("test.mp4");
        std::fs::write(&video_path, b"dummy").unwrap();

        let options = AnalysisOptions {
            shots: false,
            transcript: false,
            audio: false,
            segments: false,
            visual: false,
            local_only: false,
        };

        let bundle = runner
            .analyze_full(
                "asset_004",
                video_path.to_str().unwrap(),
                10.0,
                true,
                &options,
            )
            .await
            .unwrap();

        // All fields should be None (nothing enabled)
        assert!(bundle.shots.is_none());
        assert!(bundle.audio_profile.is_none());
        assert!(bundle.segments.is_none());
        assert!(bundle.frame_analysis.is_none());
        assert!(bundle.errors.is_empty());
    }

    #[tokio::test]
    async fn should_record_transcript_error_when_transcription_requested_without_whisper_feature() {
        if is_whisper_available() {
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());
        let video_path = temp_dir.path().join("test.mp4");
        std::fs::write(&video_path, b"dummy").unwrap();

        let options = AnalysisOptions {
            shots: false,
            transcript: true,
            audio: false,
            segments: false,
            visual: false,
            local_only: false,
        };

        let bundle = runner
            .analyze_full(
                "asset_005",
                video_path.to_str().unwrap(),
                10.0,
                true,
                &options,
            )
            .await
            .unwrap();

        assert!(bundle.transcript.is_none());
        assert!(bundle.errors.contains_key("transcript"));
    }

    #[test]
    fn should_reject_path_traversal_in_asset_id() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        assert!(runner.bundle_path("../escape").is_err());
        assert!(runner.bundle_path("").is_err());
        assert!(runner.bundle_path("foo/bar").is_err());
        assert!(runner.bundle_path("foo\\bar").is_err());
        assert!(runner.bundle_path("foo\0bar").is_err());
        assert!(runner.bundle_path("C:").is_err());
        // Valid asset IDs should work
        assert!(runner.bundle_path("asset_001").is_ok());
        assert!(runner.bundle_path("01HXYZ123ABC").is_ok());
    }
}
