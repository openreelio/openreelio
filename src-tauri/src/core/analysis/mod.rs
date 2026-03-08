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
pub mod dtw;
pub mod esd;
pub mod segmentation;
pub mod style_planner;
pub mod types;
pub mod visual;

pub use types::*;

use std::path::{Path, PathBuf};

use crate::core::annotations::models::{ShotResult, TranscriptSegment};
use crate::core::captions::{
    audio::{extract_audio_for_transcription, load_audio_samples},
    whisper::{
        default_models_dir, is_whisper_available, TranscriptionOptions, WhisperEngine, WhisperModel,
    },
};
use crate::core::indexing::shots::{ShotDetector, ShotDetectorConfig};
use crate::core::{CoreError, CoreResult};

use audio::AudioProfiler;
use segmentation::ContentSegmenter;
use visual::VisualAnalyzer;

/// Directory name within .openreelio for analysis artifacts
const ANALYSIS_DIR: &str = "analysis";

/// Name of the bundle JSON file
const BUNDLE_FILENAME: &str = "bundle.json";

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
    /// Path to FFmpeg binary (uses PATH if not set)
    ffmpeg_path: PathBuf,
}

impl AnalysisJobRunner {
    /// Creates a new job runner for the given project directory
    pub fn new(project_dir: &Path) -> Self {
        Self {
            project_dir: project_dir.to_path_buf(),
            ffmpeg_path: PathBuf::from("ffmpeg"),
        }
    }

    /// Creates a job runner with a custom FFmpeg path
    pub fn with_ffmpeg_path(mut self, ffmpeg_path: PathBuf) -> Self {
        self.ffmpeg_path = ffmpeg_path;
        self
    }

    /// Returns the directory for an asset's analysis artifacts
    fn asset_analysis_dir(&self, asset_id: &str) -> PathBuf {
        self.project_dir
            .join(".openreelio")
            .join(ANALYSIS_DIR)
            .join(asset_id)
    }

    /// Returns the path to an asset's bundle JSON file
    fn bundle_path(&self, asset_id: &str) -> PathBuf {
        self.asset_analysis_dir(asset_id).join(BUNDLE_FILENAME)
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
                bundle.transcript = Some(transcript.clone());
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

        // Save bundle to disk
        self.save_bundle(&bundle)?;
        emit_progress(
            "bundle",
            "saved",
            Some(self.bundle_path(asset_id).display().to_string()),
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
        let path = self.bundle_path(asset_id);
        if !path.exists() {
            return Ok(None);
        }

        let content = std::fs::read_to_string(&path)?;
        let bundle: AnalysisBundle = serde_json::from_str(&content)?;
        Ok(Some(bundle))
    }

    /// Saves an analysis bundle to disk using atomic write.
    fn save_bundle(&self, bundle: &AnalysisBundle) -> CoreResult<()> {
        let dir = self.asset_analysis_dir(&bundle.asset_id);
        std::fs::create_dir_all(&dir)?;

        let path = dir.join(BUNDLE_FILENAME);
        let temp_path = dir.join(format!(".{}.tmp.{}", BUNDLE_FILENAME, std::process::id()));

        let content = serde_json::to_string_pretty(bundle)
            .map_err(|e| CoreError::Internal(format!("Failed to serialize bundle: {}", e)))?;

        // Atomic write: temp file → rename
        std::fs::write(&temp_path, &content)?;
        std::fs::rename(&temp_path, &path).map_err(|e| {
            let _ = std::fs::remove_file(&temp_path);
            CoreError::Internal(format!("Failed to rename bundle file: {}", e))
        })?;

        tracing::debug!(
            "Analysis bundle saved for asset {} at {}",
            bundle.asset_id,
            path.display()
        );

        Ok(())
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
        let keyframe_dir = self.asset_analysis_dir(asset_id).join("keyframes");
        let keyframe_paths = analyzer
            .extract_keyframes(video_path, &results, &keyframe_dir)
            .await?;

        for (shot, path) in results.iter_mut().zip(keyframe_paths) {
            shot.keyframe_path = Some(path.to_string_lossy().to_string());
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

        let model = WhisperModel::Base;
        let model_path = default_models_dir().join(model.filename());
        if !model_path.exists() {
            return Err(CoreError::NotFound(format!(
                "Whisper model not found at {}",
                model_path.display()
            )));
        }

        let analysis_dir = self.asset_analysis_dir(asset_id);
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
        let keyframe_dir = self.asset_analysis_dir(asset_id).join("keyframes");
        let _keyframe_paths = analyzer
            .extract_keyframes(video_path, shots_ref, &keyframe_dir)
            .await?;

        // Default to local analysis; vision API results can update the bundle later
        let frames = analyzer.analyze_frames_local(video_path, shots_ref).await?;
        Ok(Some(frames))
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

        let path = runner.bundle_path("asset_001");
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
        });

        runner.save_bundle(&bundle).unwrap();

        let loaded = runner.load_bundle("asset_001").unwrap();
        assert_eq!(loaded.asset_id, "asset_001");
        assert_eq!(loaded.shots.as_ref().unwrap().len(), 2);
        assert_eq!(loaded.audio_profile.as_ref().unwrap().bpm, Some(120.0));
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
    fn should_overwrite_existing_bundle_on_save() {
        let temp_dir = TempDir::new().unwrap();
        let runner = AnalysisJobRunner::new(temp_dir.path());

        // Save first version
        let bundle1 = AnalysisBundle::new("asset_003", VideoMetadata::new(10.0));
        runner.save_bundle(&bundle1).unwrap();

        // Save updated version
        let mut bundle2 = AnalysisBundle::new("asset_003", VideoMetadata::new(10.0));
        bundle2.shots = Some(vec![ShotResult::new(0.0, 10.0, 1.0)]);
        runner.save_bundle(&bundle2).unwrap();

        let loaded = runner.load_bundle("asset_003").unwrap();
        assert!(loaded.shots.is_some());
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
}
