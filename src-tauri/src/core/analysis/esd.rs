//! Editing Style Document (ESD) Module (ADR-049)
//!
//! Defines the ESD schema, generates ESDs from analysis bundles,
//! and provides file-based CRUD operations.
//!
//! ESDs are stored as JSON files at `{project}/.openreelio/esds/{id}.json`,
//! separate from the ops.jsonl event log (analysis products, not edit commands).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::{AnalysisBundle, AudioProfile, ContentSegment, FrameAnalysis};
use crate::core::annotations::models::ShotResult;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Directory name within .openreelio for ESD files
const ESDS_DIR: &str = "esds";

/// Maximum offset (seconds) between audio events and visual cuts for sync detection
const SYNC_TOLERANCE_SEC: f64 = 0.2;

/// Mean shot duration threshold above which tempo is Slow
const TEMPO_SLOW_THRESHOLD: f64 = 5.0;

/// Mean shot duration threshold below which tempo is Fast
const TEMPO_FAST_THRESHOLD: f64 = 2.0;

// =============================================================================
// Tempo Classification
// =============================================================================

/// Pacing tempo classification based on mean shot duration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TempoClassification {
    /// Mean shot duration < 2.0s
    Fast,
    /// Mean shot duration between 2.0s and 5.0s (inclusive)
    Moderate,
    /// Mean shot duration > 5.0s
    Slow,
}

impl TempoClassification {
    /// Classifies tempo from mean shot duration in seconds
    pub fn from_mean_duration(mean: f64) -> Self {
        if mean < TEMPO_FAST_THRESHOLD {
            Self::Fast
        } else if mean > TEMPO_SLOW_THRESHOLD {
            Self::Slow
        } else {
            Self::Moderate
        }
    }
}

// =============================================================================
// Rhythm Profile
// =============================================================================

/// Statistical profile of shot durations in a video
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RhythmProfile {
    /// Shot durations in seconds, in original sequence order
    pub shot_durations: Vec<f64>,
    /// Mean shot duration
    pub mean_duration: f64,
    /// Median shot duration
    pub median_duration: f64,
    /// Population standard deviation of shot durations
    pub std_deviation: f64,
    /// Shortest shot duration
    pub min_duration: f64,
    /// Longest shot duration
    pub max_duration: f64,
    /// Overall tempo classification
    pub tempo_classification: TempoClassification,
}

// =============================================================================
// Transition Types
// =============================================================================

/// A single transition between two consecutive shots
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransitionEntry {
    /// Transition type (e.g., "cut", "dissolve", "wipe")
    #[serde(rename = "type")]
    pub transition_type: String,
    /// Index of the outgoing shot
    pub from_shot_index: usize,
    /// Index of the incoming shot
    pub to_shot_index: usize,
    /// Duration of the transition in seconds (0.0 for hard cuts)
    pub duration_sec: f64,
}

/// Inventory of all transitions in a video
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransitionInventory {
    /// All transitions in sequential order
    pub transitions: Vec<TransitionEntry>,
    /// Frequency count of each transition type
    pub type_frequency: HashMap<String, u32>,
    /// Most frequently used transition type
    pub dominant_type: String,
}

// =============================================================================
// Pacing & Sync
// =============================================================================

/// A point on the normalized pacing curve
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PacingPoint {
    /// Normalized position in timeline (0.0-1.0, shot center / total duration)
    pub normalized_position: f64,
    /// Normalized duration (0.0-1.0, shot duration / max shot duration)
    pub normalized_duration: f64,
}

/// A detected synchronization point between audio and visual events
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncPoint {
    /// Time of the visual event (shot boundary) in seconds
    pub time_sec: f64,
    /// Type of audio event (e.g., "loudness_peak")
    pub audio_event_type: String,
    /// Type of visual event (e.g., "shot_boundary")
    pub visual_event_type: String,
    /// Offset in seconds (audio_time - visual_time; negative = audio leads)
    pub offset_sec: f64,
}

/// Compact audio characteristics stored with the ESD for compatibility scoring.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioFingerprint {
    /// Estimated tempo of the reference audio, when detectable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<f64>,
    /// Average spectral centroid of the reference audio in hertz.
    pub spectral_centroid_hz: f64,
}

// =============================================================================
// Editing Style Document
// =============================================================================

/// Complete editing style document extracted from a reference video.
///
/// Captures the rhythm, transitions, pacing, audio-visual sync,
/// content structure, and camera patterns of the reference.
/// Stored at `{project}/.openreelio/esds/{id}.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditingStyleDocument {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// Display name
    pub name: String,
    /// ID of the source asset this ESD was generated from
    pub source_asset_id: String,
    /// ISO 8601 timestamp of creation
    pub created_at: String,
    /// Schema version for forward compatibility
    pub version: String,
    /// Statistical profile of shot durations
    pub rhythm_profile: RhythmProfile,
    /// Inventory of transitions between shots
    pub transition_inventory: TransitionInventory,
    /// Compact reference audio signature used for compatibility scoring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_fingerprint: Option<AudioFingerprint>,
    /// Normalized pacing curve
    pub pacing_curve: Vec<PacingPoint>,
    /// Detected audio-visual sync points
    pub sync_points: Vec<SyncPoint>,
    /// Content segment map (from analysis bundle)
    pub content_map: Vec<ContentSegment>,
    /// Camera pattern analysis per shot (from analysis bundle)
    pub camera_patterns: Vec<FrameAnalysis>,
    /// Forward-compatible extension fields preserved during round-trip I/O.
    #[serde(default, flatten)]
    pub extra_fields: HashMap<String, serde_json::Value>,
}

/// Summary information for listing ESDs without loading full documents
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EsdSummary {
    /// Unique identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// Source asset ID
    pub source_asset_id: String,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// Tempo classification from rhythm profile
    pub tempo_classification: TempoClassification,
}

// =============================================================================
// ESD Generator
// =============================================================================

/// Generates an [`EditingStyleDocument`] from an [`AnalysisBundle`]
pub struct EsdGenerator;

impl EsdGenerator {
    /// Generates a complete ESD from an analysis bundle.
    ///
    /// Extracts rhythm profile, pacing curve, sync points, and transition
    /// inventory from the bundle's analysis results. Missing bundle fields
    /// produce empty arrays.
    pub fn generate(bundle: &AnalysisBundle) -> CoreResult<EditingStyleDocument> {
        let shots = bundle.shots.as_deref().unwrap_or(&[]);
        let shot_durations: Vec<f64> = shots.iter().map(|s| s.duration()).collect();

        let rhythm_profile = Self::compute_rhythm_profile(&shot_durations);
        let pacing_curve = Self::compute_pacing_curve(shots);
        let sync_points = match &bundle.audio_profile {
            Some(audio) => Self::detect_sync_points(shots, audio),
            None => Vec::new(),
        };
        let transition_inventory = Self::build_transition_inventory(shots.len());
        let audio_fingerprint = bundle.audio_profile.as_ref().map(|audio| AudioFingerprint {
            bpm: audio.bpm,
            spectral_centroid_hz: audio.spectral_centroid_hz,
        });
        let content_map = bundle.segments.clone().unwrap_or_default();
        let camera_patterns = bundle.frame_analysis.clone().unwrap_or_default();

        let id = uuid::Uuid::new_v4().to_string();

        Ok(EditingStyleDocument {
            id,
            name: format!("ESD-{}", bundle.asset_id),
            source_asset_id: bundle.asset_id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            version: "1.0.0".to_string(),
            rhythm_profile,
            transition_inventory,
            audio_fingerprint,
            pacing_curve,
            sync_points,
            content_map,
            camera_patterns,
            extra_fields: HashMap::new(),
        })
    }

    /// Computes the rhythm profile from shot durations.
    ///
    /// Public for use by the style planner and tests.
    pub fn compute_rhythm_profile(durations: &[f64]) -> RhythmProfile {
        if durations.is_empty() {
            return RhythmProfile {
                shot_durations: Vec::new(),
                mean_duration: 0.0,
                median_duration: 0.0,
                std_deviation: 0.0,
                min_duration: 0.0,
                max_duration: 0.0,
                tempo_classification: TempoClassification::Moderate,
            };
        }

        let mean = compute_mean(durations);
        let median = compute_median(durations);
        let std_dev = compute_std_dev(durations, mean);
        let min = durations.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = durations.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let tempo = TempoClassification::from_mean_duration(mean);

        RhythmProfile {
            shot_durations: durations.to_vec(),
            mean_duration: mean,
            median_duration: median,
            std_deviation: std_dev,
            min_duration: min,
            max_duration: max,
            tempo_classification: tempo,
        }
    }

    /// Computes the normalized pacing curve from shots.
    ///
    /// Each point's position is the shot center divided by total duration,
    /// and the normalized duration is the shot duration divided by the
    /// longest shot duration.
    fn compute_pacing_curve(shots: &[ShotResult]) -> Vec<PacingPoint> {
        if shots.is_empty() {
            return Vec::new();
        }

        let total_duration = shots.last().map(|s| s.end_sec).unwrap_or(0.0);
        if total_duration <= 0.0 {
            return Vec::new();
        }

        let max_shot_duration = shots.iter().map(|s| s.duration()).fold(0.0_f64, f64::max);
        if max_shot_duration <= 0.0 {
            return Vec::new();
        }

        shots
            .iter()
            .map(|shot| {
                let center = (shot.start_sec + shot.end_sec) / 2.0;
                PacingPoint {
                    normalized_position: center / total_duration,
                    normalized_duration: shot.duration() / max_shot_duration,
                }
            })
            .collect()
    }

    /// Detects sync points between audio loudness peaks and shot boundaries.
    ///
    /// Finds loudness peaks exceeding median + 1 standard deviation, then
    /// matches them against shot boundary times within a 0.2 second tolerance.
    fn detect_sync_points(shots: &[ShotResult], audio: &AudioProfile) -> Vec<SyncPoint> {
        let loudness = &audio.loudness_profile;
        if loudness.is_empty() || shots.len() < 2 {
            return Vec::new();
        }

        // Threshold for significant audio events
        let mean = compute_mean(loudness);
        let std_dev = compute_std_dev(loudness, mean);
        let median = compute_median(loudness);
        let threshold = median + std_dev;

        // Find audio peaks (local maxima above threshold)
        let mut peak_times: Vec<f64> = Vec::new();
        for i in 0..loudness.len() {
            if loudness[i] > threshold {
                let above_prev = i == 0 || loudness[i] >= loudness[i - 1];
                let above_next = i == loudness.len() - 1 || loudness[i] >= loudness[i + 1];
                if above_prev && above_next {
                    peak_times.push(i as f64);
                }
            }
        }

        // Shot boundaries (cut points between consecutive shots)
        let boundaries: Vec<f64> = shots[..shots.len() - 1].iter().map(|s| s.end_sec).collect();

        // For each boundary, find closest peak within tolerance
        let mut sync_points = Vec::new();
        for &boundary in &boundaries {
            let mut closest_peak: Option<f64> = None;
            let mut min_distance = f64::MAX;

            for &peak_time in &peak_times {
                let distance = (peak_time - boundary).abs();
                if distance <= SYNC_TOLERANCE_SEC && distance < min_distance {
                    min_distance = distance;
                    closest_peak = Some(peak_time);
                }
            }

            if let Some(peak_time) = closest_peak {
                sync_points.push(SyncPoint {
                    time_sec: boundary,
                    audio_event_type: "loudness_peak".to_string(),
                    visual_event_type: "shot_boundary".to_string(),
                    offset_sec: peak_time - boundary,
                });
            }
        }

        sync_points
    }

    /// Builds a default transition inventory where all transitions are hard cuts.
    ///
    /// ML-based transition detection is a future enhancement; for now every
    /// boundary between consecutive shots is recorded as a cut with 0 duration.
    fn build_transition_inventory(shot_count: usize) -> TransitionInventory {
        if shot_count < 2 {
            return TransitionInventory {
                transitions: Vec::new(),
                type_frequency: HashMap::new(),
                dominant_type: "cut".to_string(),
            };
        }

        let transition_count = shot_count - 1;
        let transitions: Vec<TransitionEntry> = (0..transition_count)
            .map(|i| TransitionEntry {
                transition_type: "cut".to_string(),
                from_shot_index: i,
                to_shot_index: i + 1,
                duration_sec: 0.0,
            })
            .collect();

        let mut type_frequency = HashMap::new();
        type_frequency.insert("cut".to_string(), transition_count as u32);

        TransitionInventory {
            transitions,
            type_frequency,
            dominant_type: "cut".to_string(),
        }
    }
}

// =============================================================================
// CRUD Operations (Async)
// =============================================================================

/// Returns the ESD storage directory for a project
fn esds_dir(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(".openreelio").join(ESDS_DIR)
}

/// Returns the file path for an ESD by its ID
fn esd_path(project_dir: &Path, id: &str) -> std::path::PathBuf {
    esds_dir(project_dir).join(format!("{}.json", id))
}

/// Validates an ESD ID to prevent path traversal
fn validate_esd_id(id: &str) -> CoreResult<()> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(CoreError::ValidationError(
            "Invalid ESD ID: must not be empty or contain path separators".to_string(),
        ));
    }
    Ok(())
}

/// Saves an ESD to disk at `{project}/.openreelio/esds/{id}.json`.
///
/// Uses atomic write (temp file + rename) to prevent partial writes.
pub async fn save_esd(project_dir: &Path, esd: &EditingStyleDocument) -> CoreResult<()> {
    validate_esd_id(&esd.id)?;

    let dir = esds_dir(project_dir);
    tokio::fs::create_dir_all(&dir).await?;

    let path = esd_path(project_dir, &esd.id);
    let temp_path = dir.join(format!(".{}.json.tmp.{}", esd.id, std::process::id()));

    let content = serde_json::to_string_pretty(esd)
        .map_err(|e| CoreError::Internal(format!("Failed to serialize ESD: {}", e)))?;

    tokio::fs::write(&temp_path, &content).await?;
    if let Err(e) = tokio::fs::rename(&temp_path, &path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(CoreError::Internal(format!(
            "Failed to rename ESD file: {}",
            e
        )));
    }

    tracing::debug!("ESD saved: {} at {}", esd.id, path.display());
    Ok(())
}

/// Loads an ESD from disk by its ID. Returns `None` if not found.
pub async fn load_esd(project_dir: &Path, id: &str) -> CoreResult<Option<EditingStyleDocument>> {
    validate_esd_id(id)?;

    let path = esd_path(project_dir, id);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => {
            let esd: EditingStyleDocument = serde_json::from_str(&content)?;
            Ok(Some(esd))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CoreError::IoError(e)),
    }
}

/// Lists all ESDs in a project as summaries (id, name, source_asset_id,
/// created_at, tempo_classification).
pub async fn list_esds_in_project(project_dir: &Path) -> CoreResult<Vec<EsdSummary>> {
    let dir = esds_dir(project_dir);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(CoreError::IoError(e)),
    };

    let mut summaries = Vec::new();

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            // Skip temp files
            if let Some(name) = path.file_stem().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
                    continue;
                }
            }

            match tokio::fs::read_to_string(&path).await {
                Ok(content) => match serde_json::from_str::<EditingStyleDocument>(&content) {
                    Ok(esd) => {
                        summaries.push(EsdSummary {
                            id: esd.id,
                            name: esd.name,
                            source_asset_id: esd.source_asset_id,
                            created_at: esd.created_at,
                            tempo_classification: esd.rhythm_profile.tempo_classification,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("Skipping invalid ESD file {}: {}", path.display(), e);
                    }
                },
                Err(e) => {
                    tracing::warn!("Failed to read ESD file {}: {}", path.display(), e);
                }
            }
        }
    }

    // Sort by creation time (newest first)
    summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(summaries)
}

/// Deletes an ESD from disk. Returns `true` if the file existed.
pub async fn delete_esd_file(project_dir: &Path, id: &str) -> CoreResult<bool> {
    validate_esd_id(id)?;

    let path = esd_path(project_dir, id);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {
            tracing::debug!("ESD deleted: {}", id);
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(CoreError::IoError(e)),
    }
}

// =============================================================================
// Statistical Helpers
// =============================================================================

/// Computes the arithmetic mean of a slice
fn compute_mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

/// Computes the median of a slice
fn compute_median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    if n % 2 == 0 {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    }
}

/// Computes the population standard deviation given a precomputed mean
fn compute_std_dev(values: &[f64], mean: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    variance.sqrt()
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::types::{AudioProfile, VideoMetadata};
    use crate::core::annotations::models::ShotResult;
    use tempfile::TempDir;

    // -------------------------------------------------------------------------
    // TempoClassification Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_classify_fast_tempo_when_mean_below_2s() {
        assert_eq!(
            TempoClassification::from_mean_duration(1.5),
            TempoClassification::Fast
        );
        assert_eq!(
            TempoClassification::from_mean_duration(0.5),
            TempoClassification::Fast
        );
    }

    #[test]
    fn should_classify_moderate_tempo_when_mean_between_2s_and_5s() {
        assert_eq!(
            TempoClassification::from_mean_duration(2.0),
            TempoClassification::Moderate
        );
        assert_eq!(
            TempoClassification::from_mean_duration(3.5),
            TempoClassification::Moderate
        );
        assert_eq!(
            TempoClassification::from_mean_duration(5.0),
            TempoClassification::Moderate
        );
    }

    #[test]
    fn should_classify_slow_tempo_when_mean_above_5s() {
        assert_eq!(
            TempoClassification::from_mean_duration(5.5),
            TempoClassification::Slow
        );
        assert_eq!(
            TempoClassification::from_mean_duration(120.0),
            TempoClassification::Slow
        );
    }

    #[test]
    fn should_serialize_tempo_classification_to_snake_case() {
        assert_eq!(
            serde_json::to_string(&TempoClassification::Fast).unwrap(),
            "\"fast\""
        );
        assert_eq!(
            serde_json::to_string(&TempoClassification::Moderate).unwrap(),
            "\"moderate\""
        );
        assert_eq!(
            serde_json::to_string(&TempoClassification::Slow).unwrap(),
            "\"slow\""
        );
    }

    // -------------------------------------------------------------------------
    // Statistical Helpers Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_mean_correctly() {
        assert!((compute_mean(&[2.0, 4.0, 6.0]) - 4.0).abs() < 1e-10);
        assert_eq!(compute_mean(&[]), 0.0);
        assert!((compute_mean(&[5.0]) - 5.0).abs() < 1e-10);
    }

    #[test]
    fn should_compute_median_for_even_length() {
        assert!((compute_median(&[1.0, 3.0, 5.0, 7.0]) - 4.0).abs() < 1e-10);
    }

    #[test]
    fn should_compute_median_for_odd_length() {
        assert!((compute_median(&[1.0, 3.0, 5.0]) - 3.0).abs() < 1e-10);
    }

    #[test]
    fn should_compute_std_dev_correctly() {
        let values = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
        let mean = compute_mean(&values);
        let std_dev = compute_std_dev(&values, mean);
        assert!((std_dev - 2.0).abs() < 0.01);
    }

    // -------------------------------------------------------------------------
    // RhythmProfile Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_rhythm_profile_from_varied_shot_lengths() {
        let durations = [2.0, 1.5, 3.0, 0.5, 8.0, 1.0];
        let profile = EsdGenerator::compute_rhythm_profile(&durations);

        // Mean = 16.0 / 6 ≈ 2.6667
        assert!((profile.mean_duration - 2.6667).abs() < 0.001);
        // Median of sorted [0.5, 1.0, 1.5, 2.0, 3.0, 8.0] = (1.5 + 2.0) / 2 = 1.75
        assert!((profile.median_duration - 1.75).abs() < 0.001);
        assert_eq!(profile.tempo_classification, TempoClassification::Moderate);
        assert_eq!(profile.shot_durations, durations.to_vec());
        assert!((profile.min_duration - 0.5).abs() < 1e-10);
        assert!((profile.max_duration - 8.0).abs() < 1e-10);
        // Population std_dev ≈ 2.511
        assert!((profile.std_deviation - 2.511).abs() < 0.01);
    }

    #[test]
    fn should_compute_rhythm_profile_from_single_shot() {
        let durations = [120.0];
        let profile = EsdGenerator::compute_rhythm_profile(&durations);

        assert!((profile.mean_duration - 120.0).abs() < 1e-10);
        assert!((profile.median_duration - 120.0).abs() < 1e-10);
        assert!((profile.std_deviation - 0.0).abs() < 1e-10);
        assert_eq!(profile.tempo_classification, TempoClassification::Slow);
    }

    #[test]
    fn should_handle_empty_durations_in_rhythm_profile() {
        let profile = EsdGenerator::compute_rhythm_profile(&[]);

        assert!(profile.shot_durations.is_empty());
        assert_eq!(profile.mean_duration, 0.0);
        assert_eq!(profile.median_duration, 0.0);
        assert_eq!(profile.std_deviation, 0.0);
        assert_eq!(profile.tempo_classification, TempoClassification::Moderate);
    }

    // -------------------------------------------------------------------------
    // PacingCurve Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_pacing_curve_from_3_shot_video() {
        let shots = vec![
            ShotResult::new(0.0, 4.0, 0.9),
            ShotResult::new(4.0, 6.0, 0.9),
            ShotResult::new(6.0, 12.0, 0.9),
        ];

        let curve = EsdGenerator::compute_pacing_curve(&shots);

        assert_eq!(curve.len(), 3);
        // Shot 0: center=2.0, dur=4.0, total=12.0, max_dur=6.0
        assert!((curve[0].normalized_position - 0.167).abs() < 0.001);
        assert!((curve[0].normalized_duration - 0.667).abs() < 0.001);
        // Shot 1: center=5.0, dur=2.0
        assert!((curve[1].normalized_position - 0.417).abs() < 0.001);
        assert!((curve[1].normalized_duration - 0.333).abs() < 0.001);
        // Shot 2: center=9.0, dur=6.0
        assert!((curve[2].normalized_position - 0.75).abs() < 0.001);
        assert!((curve[2].normalized_duration - 1.0).abs() < 0.001);
    }

    #[test]
    fn should_return_empty_pacing_curve_for_no_shots() {
        let curve = EsdGenerator::compute_pacing_curve(&[]);
        assert!(curve.is_empty());
    }

    #[test]
    fn should_have_normalized_values_in_0_to_1_range() {
        let shots = vec![
            ShotResult::new(0.0, 3.0, 0.9),
            ShotResult::new(3.0, 5.0, 0.9),
            ShotResult::new(5.0, 10.0, 0.9),
            ShotResult::new(10.0, 11.0, 0.9),
        ];

        let curve = EsdGenerator::compute_pacing_curve(&shots);

        for point in &curve {
            assert!(
                point.normalized_position >= 0.0 && point.normalized_position <= 1.0,
                "Position {} out of range",
                point.normalized_position
            );
            assert!(
                point.normalized_duration >= 0.0 && point.normalized_duration <= 1.0,
                "Duration {} out of range",
                point.normalized_duration
            );
        }
    }

    // -------------------------------------------------------------------------
    // SyncPoint Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_sync_points_within_tolerance() {
        // Shots with cuts at 1.0s and 3.0s
        let shots = vec![
            ShotResult::new(0.0, 1.0, 0.9),
            ShotResult::new(1.0, 3.0, 0.9),
            ShotResult::new(3.0, 5.0, 0.9),
        ];
        // Audio loudness peaks at indices 1 and 3 (exactly at cut times)
        // Threshold: median(-30) + std_dev ≈ -17.75 → peaks at -5 exceed it
        let audio = AudioProfile {
            bpm: None,
            spectral_centroid_hz: 0.0,
            loudness_profile: vec![-30.0, -5.0, -30.0, -5.0, -30.0],
            peak_db: -5.0,
            silence_regions: vec![],
        };

        let sync = EsdGenerator::detect_sync_points(&shots, &audio);

        assert_eq!(sync.len(), 2);
        assert!((sync[0].time_sec - 1.0).abs() < 1e-10);
        assert!((sync[0].offset_sec).abs() <= SYNC_TOLERANCE_SEC);
        assert_eq!(sync[0].audio_event_type, "loudness_peak");
        assert_eq!(sync[0].visual_event_type, "shot_boundary");
        assert!((sync[1].time_sec - 3.0).abs() < 1e-10);
    }

    #[test]
    fn should_return_no_sync_points_when_peaks_far_from_boundaries() {
        let shots = vec![
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 10.0, 0.9),
        ];
        // Peak at index 2 (2.0s) is far from boundary at 5.0s
        let audio = AudioProfile {
            bpm: None,
            spectral_centroid_hz: 0.0,
            loudness_profile: vec![-30.0, -30.0, -5.0, -30.0, -30.0, -30.0],
            peak_db: -5.0,
            silence_regions: vec![],
        };

        let sync = EsdGenerator::detect_sync_points(&shots, &audio);

        assert!(sync.is_empty());
    }

    #[test]
    fn should_return_no_sync_points_for_single_shot() {
        let shots = vec![ShotResult::new(0.0, 10.0, 1.0)];
        let audio = AudioProfile {
            bpm: None,
            spectral_centroid_hz: 0.0,
            loudness_profile: vec![-20.0; 10],
            peak_db: -20.0,
            silence_regions: vec![],
        };

        let sync = EsdGenerator::detect_sync_points(&shots, &audio);
        assert!(sync.is_empty());
    }

    // -------------------------------------------------------------------------
    // TransitionInventory Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_build_all_cut_transition_inventory() {
        let inventory = EsdGenerator::build_transition_inventory(6);

        assert_eq!(inventory.transitions.len(), 5);
        assert_eq!(inventory.dominant_type, "cut");
        assert_eq!(inventory.type_frequency.get("cut"), Some(&5));

        for (i, t) in inventory.transitions.iter().enumerate() {
            assert_eq!(t.transition_type, "cut");
            assert_eq!(t.from_shot_index, i);
            assert_eq!(t.to_shot_index, i + 1);
            assert_eq!(t.duration_sec, 0.0);
        }
    }

    #[test]
    fn should_build_empty_inventory_for_single_shot() {
        let inventory = EsdGenerator::build_transition_inventory(1);

        assert!(inventory.transitions.is_empty());
        assert!(inventory.type_frequency.is_empty());
        assert_eq!(inventory.dominant_type, "cut");
    }

    // -------------------------------------------------------------------------
    // ESD Generation Tests
    // -------------------------------------------------------------------------

    fn make_test_bundle() -> AnalysisBundle {
        let mut bundle =
            AnalysisBundle::new("test_asset", VideoMetadata::new(12.0).with_audio(true));
        bundle.shots = Some(vec![
            ShotResult::new(0.0, 4.0, 0.9),
            ShotResult::new(4.0, 6.0, 0.9),
            ShotResult::new(6.0, 12.0, 0.9),
        ]);
        bundle.audio_profile = Some(AudioProfile {
            bpm: Some(120.0),
            spectral_centroid_hz: 2500.0,
            loudness_profile: vec![
                -20.0, -18.0, -22.0, -19.0, -10.0, -21.0, -8.0, -20.0, -22.0, -19.0, -21.0, -20.0,
            ],
            peak_db: -8.0,
            silence_regions: vec![],
        });
        bundle
    }

    #[test]
    fn should_generate_esd_from_complete_bundle() {
        let bundle = make_test_bundle();
        let esd = EsdGenerator::generate(&bundle).unwrap();

        assert!(!esd.id.is_empty());
        assert_eq!(esd.source_asset_id, "test_asset");
        assert_eq!(esd.version, "1.0.0");
        assert_eq!(esd.rhythm_profile.shot_durations.len(), 3);
        assert_eq!(esd.transition_inventory.transitions.len(), 2);
        assert_eq!(
            esd.audio_fingerprint.as_ref().and_then(|audio| audio.bpm),
            Some(120.0)
        );
        assert_eq!(esd.pacing_curve.len(), 3);
        assert!(!esd.created_at.is_empty());
    }

    #[test]
    fn should_generate_esd_from_empty_bundle() {
        let bundle = AnalysisBundle::new("empty", VideoMetadata::new(0.0));
        let esd = EsdGenerator::generate(&bundle).unwrap();

        assert!(esd.rhythm_profile.shot_durations.is_empty());
        assert!(esd.transition_inventory.transitions.is_empty());
        assert!(esd.pacing_curve.is_empty());
        assert!(esd.sync_points.is_empty());
        assert!(esd.audio_fingerprint.is_none());
        assert!(esd.content_map.is_empty());
        assert!(esd.camera_patterns.is_empty());
    }

    #[test]
    fn should_roundtrip_esd_via_json() {
        let bundle = make_test_bundle();
        let esd = EsdGenerator::generate(&bundle).unwrap();

        let json = serde_json::to_string_pretty(&esd).unwrap();
        let parsed: EditingStyleDocument = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, esd.id);
        assert_eq!(parsed.version, "1.0.0");
        assert_eq!(parsed.source_asset_id, "test_asset");
        assert_eq!(
            parsed.rhythm_profile.shot_durations.len(),
            esd.rhythm_profile.shot_durations.len()
        );
        assert_eq!(parsed.audio_fingerprint, esd.audio_fingerprint);
        assert_eq!(
            parsed.transition_inventory.dominant_type,
            esd.transition_inventory.dominant_type
        );
        assert_eq!(parsed.pacing_curve.len(), esd.pacing_curve.len());
    }

    #[test]
    fn should_preserve_unknown_fields_when_roundtripping_future_esd_schema() {
        let bundle = make_test_bundle();
        let mut value = serde_json::to_value(EsdGenerator::generate(&bundle).unwrap()).unwrap();
        value["futureField"] = serde_json::json!({
            "version": 2,
            "enabled": true,
        });

        let parsed: EditingStyleDocument = serde_json::from_value(value).unwrap();
        let serialized = serde_json::to_value(&parsed).unwrap();

        assert_eq!(
            serialized["futureField"],
            serde_json::json!({
                "version": 2,
                "enabled": true,
            })
        );
    }

    #[test]
    fn should_roundtrip_esd_summary_via_json() {
        let summary = EsdSummary {
            id: "abc-123".to_string(),
            name: "ESD-test".to_string(),
            source_asset_id: "asset-1".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            tempo_classification: TempoClassification::Fast,
        };

        let json = serde_json::to_string(&summary).unwrap();
        let parsed: EsdSummary = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "abc-123");
        assert_eq!(parsed.tempo_classification, TempoClassification::Fast);
    }

    // -------------------------------------------------------------------------
    // CRUD Tests
    // -------------------------------------------------------------------------

    #[tokio::test]
    async fn should_save_and_load_esd_roundtrip() {
        let temp = TempDir::new().unwrap();
        let bundle = make_test_bundle();
        let esd = EsdGenerator::generate(&bundle).unwrap();
        let esd_id = esd.id.clone();

        save_esd(temp.path(), &esd).await.unwrap();
        let loaded = load_esd(temp.path(), &esd_id).await.unwrap();

        assert!(loaded.is_some());
        let loaded = loaded.unwrap();
        assert_eq!(loaded.id, esd_id);
        assert_eq!(loaded.source_asset_id, "test_asset");
        assert_eq!(loaded.version, "1.0.0");
    }

    #[tokio::test]
    async fn should_return_none_when_esd_not_found() {
        let temp = TempDir::new().unwrap();
        let loaded = load_esd(temp.path(), "nonexistent").await.unwrap();
        assert!(loaded.is_none());
    }

    #[tokio::test]
    async fn should_list_multiple_esds() {
        let temp = TempDir::new().unwrap();

        let bundle1 = make_test_bundle();
        let esd1 = EsdGenerator::generate(&bundle1).unwrap();
        save_esd(temp.path(), &esd1).await.unwrap();

        let mut bundle2 = make_test_bundle();
        bundle2.asset_id = "asset_2".to_string();
        let esd2 = EsdGenerator::generate(&bundle2).unwrap();
        save_esd(temp.path(), &esd2).await.unwrap();

        let summaries = list_esds_in_project(temp.path()).await.unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[tokio::test]
    async fn should_return_empty_list_when_no_esds_dir() {
        let temp = TempDir::new().unwrap();
        let summaries = list_esds_in_project(temp.path()).await.unwrap();
        assert!(summaries.is_empty());
    }

    #[tokio::test]
    async fn should_delete_existing_esd() {
        let temp = TempDir::new().unwrap();
        let bundle = make_test_bundle();
        let esd = EsdGenerator::generate(&bundle).unwrap();
        let esd_id = esd.id.clone();

        save_esd(temp.path(), &esd).await.unwrap();

        let deleted = delete_esd_file(temp.path(), &esd_id).await.unwrap();
        assert!(deleted);

        let loaded = load_esd(temp.path(), &esd_id).await.unwrap();
        assert!(loaded.is_none());
    }

    #[tokio::test]
    async fn should_return_false_when_deleting_nonexistent_esd() {
        let temp = TempDir::new().unwrap();
        let deleted = delete_esd_file(temp.path(), "nonexistent").await.unwrap();
        assert!(!deleted);
    }

    #[tokio::test]
    async fn should_reject_invalid_esd_id() {
        let temp = TempDir::new().unwrap();
        assert!(load_esd(temp.path(), "../escape").await.is_err());
        assert!(load_esd(temp.path(), "").await.is_err());
        assert!(load_esd(temp.path(), "foo/bar").await.is_err());
        assert!(load_esd(temp.path(), "foo\\bar").await.is_err());
    }

    #[tokio::test]
    async fn should_crud_full_lifecycle() {
        let temp = TempDir::new().unwrap();
        let bundle = make_test_bundle();
        let esd = EsdGenerator::generate(&bundle).unwrap();
        let id = esd.id.clone();

        // Generate & save
        save_esd(temp.path(), &esd).await.unwrap();

        // Get
        let loaded = load_esd(temp.path(), &id).await.unwrap().unwrap();
        assert_eq!(loaded.id, id);

        // List
        let list = list_esds_in_project(temp.path()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, id);

        // Delete
        let deleted = delete_esd_file(temp.path(), &id).await.unwrap();
        assert!(deleted);

        // Verify deleted
        let gone = load_esd(temp.path(), &id).await.unwrap();
        assert!(gone.is_none());

        let empty = list_esds_in_project(temp.path()).await.unwrap();
        assert!(empty.is_empty());
    }
}
