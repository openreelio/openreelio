//! Style-Aware Plan Generator (ADR-050)
//!
//! Generates an [`AgentPlan`] that transforms source footage to match
//! the editing style captured in an [`EditingStyleDocument`].
//!
//! Uses DTW alignment to map reference shot pacing onto the source
//! timeline, producing executable `AddTrack`, `InsertClip`, and `SplitClip`
//! plan steps. Non-cut reference transitions currently surface as warnings until
//! transition execution is supported by agent plans.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::dtw::{dtw_align, DtwResult};
use super::esd::{AudioFingerprint, EditingStyleDocument};
use super::types::{AnalysisBundle, AudioProfile, ContentSegment, SegmentType};
use crate::core::ai::agent_plan::{AgentPlan, PlanRiskLevel, PlanStep};
use crate::core::annotations::models::ShotResult;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Weight for duration ratio in compatibility score
const WEIGHT_DURATION: f64 = 0.3;

/// Weight for content type overlap in compatibility score
const WEIGHT_CONTENT: f64 = 0.3;

/// Weight for audio similarity in compatibility score
const WEIGHT_AUDIO: f64 = 0.2;

/// Weight for shot count ratio in compatibility score
const WEIGHT_SHOTS: f64 = 0.2;

/// Minimum source-to-reference duration ratio before warning
const MIN_DURATION_RATIO_WARN: f64 = 0.3;

/// Duration ratio above which the source is considered substantially longer.
const LONG_SOURCE_RATIO_INFO: f64 = 1.5;

/// Default audio similarity when audio data is unavailable
const DEFAULT_AUDIO_SIMILARITY: f64 = 0.5;

/// Minimum cut spacing to avoid duplicate or degenerate splits.
const MIN_SPLIT_GAP_SEC: f64 = 0.05;

/// Minimum distance from clip edges for a valid split.
const MIN_SPLIT_EDGE_SEC: f64 = 0.1;

// =============================================================================
// Types
// =============================================================================

/// Result of applying a reference editing style to source footage
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StylePlanResult {
    /// Executable plan with AddTrack, InsertClip, and SplitClip steps
    pub plan: AgentPlan,
    /// Compatibility score between reference and source (0.0 - 1.0)
    pub compatibility_score: f64,
    /// Warnings about potential issues (e.g., length mismatch)
    pub warnings: Vec<String>,
}

/// Concrete timeline context required to build an executable style plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StylePlanningContext {
    /// Sequence where the generated style edit will be inserted.
    pub sequence_id: String,
    /// Source asset to place on the timeline before splitting.
    pub source_asset_id: String,
    /// Name for the dedicated style-transfer track created by the plan.
    pub track_name: String,
}

impl StylePlanningContext {
    /// Creates a new planning context with a default track name.
    pub fn new(sequence_id: impl Into<String>, source_asset_id: impl Into<String>) -> Self {
        Self {
            sequence_id: sequence_id.into(),
            source_asset_id: source_asset_id.into(),
            track_name: "Reference Style".to_string(),
        }
    }

    /// Overrides the default generated track name.
    pub fn with_track_name(mut self, track_name: impl Into<String>) -> Self {
        self.track_name = track_name.into();
        self
    }
}

// =============================================================================
// Style Planner
// =============================================================================

/// Generates edit plans that replicate a reference editing style
pub struct StylePlanner;

impl StylePlanner {
    /// Generates an executable [`AgentPlan`] that applies the reference ESD's
    /// editing style to the source footage described by `source_bundle`.
    ///
    /// The resulting plan creates a dedicated video track, inserts the source
    /// asset, and then performs sequential `SplitClip` commands using DTW-guided
    /// cut points.
    pub fn plan(
        esd: &EditingStyleDocument,
        source_bundle: &AnalysisBundle,
        context: &StylePlanningContext,
    ) -> CoreResult<StylePlanResult> {
        if context.sequence_id.trim().is_empty() {
            return Err(CoreError::ValidationError(
                "Style planning requires a target sequence ID".to_string(),
            ));
        }
        if context.source_asset_id.trim().is_empty() {
            return Err(CoreError::ValidationError(
                "Style planning requires a source asset ID".to_string(),
            ));
        }
        if !source_bundle.asset_id.is_empty() && source_bundle.asset_id != context.source_asset_id {
            return Err(CoreError::ValidationError(format!(
                "Source bundle asset '{}' does not match planning asset '{}'",
                source_bundle.asset_id, context.source_asset_id
            )));
        }

        let ref_durations = &esd.rhythm_profile.shot_durations;
        let source_shots = source_bundle.shots.as_deref().unwrap_or(&[]);
        let source_durations: Vec<f64> = source_shots.iter().map(|s| s.duration()).collect();

        let ref_total: f64 = ref_durations.iter().sum();
        let src_total = source_bundle.metadata.duration_sec;

        let mut warnings = Vec::new();

        // Warn about extreme duration mismatches
        if ref_total > 0.0 {
            let ratio = src_total / ref_total;
            if ratio < MIN_DURATION_RATIO_WARN {
                warnings.push(format!(
                    "Source duration ({:.1}s) is {:.0}% of reference ({:.1}s), may produce sparse edit",
                    src_total,
                    ratio * 100.0,
                    ref_total
                ));
            } else if ratio > LONG_SOURCE_RATIO_INFO {
                warnings.push(format!(
                    "Source duration is {:.1}x longer than reference; split points are stretched across the source timeline",
                    ratio
                ));
            }
        }

        // DTW alignment over normalized duration sequences.
        let dtw_result = if !ref_durations.is_empty() && !source_durations.is_empty() {
            Some(dtw_align(ref_durations, &source_durations))
        } else {
            None
        };

        let cut_times =
            Self::compute_cut_times(ref_durations, source_shots, src_total, dtw_result.as_ref());

        let requested_cut_count = ref_durations.len().saturating_sub(1);
        if !ref_durations.is_empty() && requested_cut_count > cut_times.len() {
            warnings.push(format!(
                "Generated {} cut points from {} reference boundaries after DTW compression",
                cut_times.len(),
                requested_cut_count
            ));
        }

        let unsupported_transitions = esd
            .transition_inventory
            .transitions
            .iter()
            .filter(|transition| {
                transition.transition_type != "cut" || transition.duration_sec > f64::EPSILON
            })
            .count();
        if unsupported_transitions > 0 {
            warnings.push(format!(
                "Skipped {} non-cut reference transitions because executable agent plans do not yet support transition commands",
                unsupported_transitions
            ));
        }

        // Generate plan steps.
        let steps = if ref_durations.is_empty() || src_total <= 0.0 {
            Vec::new()
        } else {
            Self::generate_steps(context, &cut_times)
        };

        // Compute compatibility score
        let compatibility_score = Self::compute_compatibility_score(esd, source_bundle);

        if compatibility_score < 0.4 {
            warnings.push(format!(
                "Low compatibility score ({:.2}): reference and source have significant differences in content, duration, or structure",
                compatibility_score
            ));
        }

        let plan = AgentPlan {
            id: uuid::Uuid::new_v4().to_string(),
            goal: format!("Apply editing style '{}' to source footage", esd.name),
            steps,
            approval_granted: false,
            session_id: None,
        };

        // Add DTW distance info as a warning/info
        if let Some(ref dtw) = dtw_result {
            if dtw.distance > 0.0 {
                warnings.push(format!(
                    "DTW alignment distance: {:.2} (lower = closer rhythm match)",
                    dtw.distance
                ));
            }
        }

        Ok(StylePlanResult {
            plan,
            compatibility_score,
            warnings,
        })
    }

    /// Generates `AddTrack`, `InsertClip`, and `SplitClip` steps.
    fn generate_steps(context: &StylePlanningContext, cut_times: &[f64]) -> Vec<PlanStep> {
        let track_step_id = "step-0".to_string();
        let insert_step_id = "step-1".to_string();
        let track_name = if context.track_name.trim().is_empty() {
            "Reference Style".to_string()
        } else {
            context.track_name.trim().to_string()
        };

        let mut steps = vec![
            PlanStep {
                id: track_step_id.clone(),
                tool_name: "AddTrack".to_string(),
                params: serde_json::json!({
                    "sequenceId": context.sequence_id.clone(),
                    "kind": "video",
                    "name": track_name,
                }),
                description: "Create a dedicated track for style transfer".to_string(),
                risk_level: PlanRiskLevel::Low,
                depends_on: vec![],
                optional: false,
            },
            PlanStep {
                id: insert_step_id.clone(),
                tool_name: "InsertClip".to_string(),
                params: serde_json::json!({
                    "sequenceId": context.sequence_id.clone(),
                    "trackId": step_reference(&track_step_id, "createdIds.0"),
                    "assetId": context.source_asset_id.clone(),
                    "timelineStart": 0.0,
                }),
                description: "Insert the source footage onto the generated style track".to_string(),
                risk_level: PlanRiskLevel::Low,
                depends_on: vec![track_step_id.clone()],
                optional: false,
            },
        ];

        let mut previous_tail_step_id = insert_step_id;

        for (index, cut_time) in cut_times.iter().enumerate() {
            let step_id = format!("step-{}", index + 2);
            steps.push(PlanStep {
                id: step_id.clone(),
                tool_name: "SplitClip".to_string(),
                params: serde_json::json!({
                    "sequenceId": context.sequence_id.clone(),
                    "trackId": step_reference(&track_step_id, "createdIds.0"),
                    "clipId": step_reference(&previous_tail_step_id, "createdIds.0"),
                    "splitTime": round_cut_time(*cut_time),
                }),
                description: format!(
                    "Split the styled source clip at {:.2}s to match reference pacing",
                    cut_time
                ),
                risk_level: PlanRiskLevel::Low,
                depends_on: vec![previous_tail_step_id.clone()],
                optional: false,
            });
            previous_tail_step_id = step_id;
        }

        steps
    }

    /// Computes DTW-guided cut points across the source timeline.
    fn compute_cut_times(
        ref_durations: &[f64],
        source_shots: &[ShotResult],
        src_total: f64,
        dtw_result: Option<&DtwResult>,
    ) -> Vec<f64> {
        let boundary_count = ref_durations.len().saturating_sub(1);
        if boundary_count == 0 || src_total <= 0.0 {
            return Vec::new();
        }

        let ref_total = ref_durations.iter().sum::<f64>();
        let scaled_cut_times = Self::compute_scaled_cut_times(ref_durations, ref_total, src_total);

        let Some(dtw_result) = dtw_result else {
            return scaled_cut_times;
        };
        if source_shots.is_empty() {
            return scaled_cut_times;
        }

        let dtw_cut_times =
            Self::map_dtw_boundary_times(dtw_result, source_shots, ref_durations.len());
        let mut duplicate_run_end = vec![0usize; boundary_count];
        let mut run_start = 0usize;
        while run_start < boundary_count {
            let mut run_end = run_start;
            if let Some(boundary_time) = dtw_cut_times[run_start] {
                while run_end + 1 < boundary_count
                    && dtw_cut_times[run_end + 1].is_some_and(|next_time| {
                        (next_time - boundary_time).abs() <= MIN_SPLIT_GAP_SEC
                    })
                {
                    run_end += 1;
                }
            }

            for slot in &mut duplicate_run_end[run_start..=run_end] {
                *slot = run_end;
            }
            run_start = run_end + 1;
        }

        let mut cut_times = Vec::with_capacity(boundary_count);
        let mut last_cut = None;

        for index in 0..boundary_count {
            let run_end = duplicate_run_end[index];
            let scaled_time = scaled_cut_times.get(index).copied();

            let preferred = if run_end > index {
                dtw_cut_times[run_end].and_then(|terminal| {
                    scaled_time.map(|st| st.min(terminal - MIN_SPLIT_GAP_SEC))
                })
            } else {
                dtw_cut_times[index]
            };
            let fallback = scaled_time;

            if let Some(selected) = Self::select_cut_time(preferred, fallback, src_total, last_cut)
            {
                cut_times.push(selected);
                last_cut = Some(selected);
            }
        }

        if cut_times.is_empty() {
            scaled_cut_times
        } else {
            cut_times
        }
    }

    /// Maps each reference boundary to the end of the latest aligned source shot.
    fn map_dtw_boundary_times(
        dtw_result: &DtwResult,
        source_shots: &[ShotResult],
        ref_shot_count: usize,
    ) -> Vec<Option<f64>> {
        let mut max_source_by_ref = vec![None; ref_shot_count];
        for &(ref_index, source_index) in &dtw_result.path {
            let slot = &mut max_source_by_ref[ref_index];
            *slot = Some(slot.map_or(source_index, |current: usize| current.max(source_index)));
        }

        max_source_by_ref
            .into_iter()
            .take(ref_shot_count.saturating_sub(1))
            .map(|source_index: Option<usize>| {
                source_index.and_then(|index| source_shots.get(index).map(|shot| shot.end_sec))
            })
            .collect()
    }

    /// Computes proportional cut points when DTW anchors are unavailable.
    fn compute_scaled_cut_times(ref_durations: &[f64], ref_total: f64, src_total: f64) -> Vec<f64> {
        if ref_total <= 0.0 || src_total <= 0.0 {
            return Vec::new();
        }

        let mut cumulative = 0.0;
        let mut cut_times = Vec::with_capacity(ref_durations.len().saturating_sub(1));

        for duration in ref_durations
            .iter()
            .take(ref_durations.len().saturating_sub(1))
        {
            cumulative += duration;
            let scaled_time = (cumulative / ref_total) * src_total;
            if let Some(valid_cut) = Self::select_cut_time(
                Some(scaled_time),
                None,
                src_total,
                cut_times.last().copied(),
            ) {
                cut_times.push(valid_cut);
            }
        }

        cut_times
    }

    /// Selects the first valid cut time from the preferred and fallback values.
    fn select_cut_time(
        preferred: Option<f64>,
        fallback: Option<f64>,
        src_total: f64,
        last_cut: Option<f64>,
    ) -> Option<f64> {
        [preferred, fallback]
            .into_iter()
            .flatten()
            .map(round_cut_time)
            .find(|time| Self::is_valid_cut_time(*time, src_total, last_cut))
    }

    /// Returns whether a split time is valid for plan generation.
    fn is_valid_cut_time(time: f64, src_total: f64, last_cut: Option<f64>) -> bool {
        if !time.is_finite() || time <= MIN_SPLIT_EDGE_SEC || time >= src_total - MIN_SPLIT_EDGE_SEC
        {
            return false;
        }

        last_cut.is_none_or(|last_time| time - last_time > MIN_SPLIT_GAP_SEC)
    }

    /// Computes a compatibility score between a reference ESD and source footage.
    ///
    /// Weighted combination of four factors:
    /// - Duration ratio proximity (0.3): how close are total durations?
    /// - Content type overlap (0.3): Jaccard similarity of segment types
    /// - Audio similarity (0.2): BPM and spectral centroid ratio
    /// - Shot count ratio (0.2): how similar are the shot counts?
    pub fn compute_compatibility_score(
        esd: &EditingStyleDocument,
        source_bundle: &AnalysisBundle,
    ) -> f64 {
        let ref_total: f64 = esd.rhythm_profile.shot_durations.iter().sum();
        let src_total = source_bundle.metadata.duration_sec;
        let ref_shots = esd.rhythm_profile.shot_durations.len();
        let src_shots = source_bundle.shots.as_ref().map(|s| s.len()).unwrap_or(0);

        // 1. Duration ratio proximity
        let duration_score = if ref_total > 0.0 && src_total > 0.0 {
            1.0 - (1.0 - src_total / ref_total).abs().min(1.0)
        } else {
            0.0
        };

        // 2. Content type overlap (Jaccard similarity)
        let content_score = Self::jaccard_segment_types(
            &esd.content_map,
            source_bundle.segments.as_deref().unwrap_or(&[]),
        );

        // 3. Audio similarity (BPM + spectral centroid ratio when reference audio exists)
        let audio_score = Self::compute_audio_similarity(
            esd.audio_fingerprint.as_ref(),
            source_bundle.audio_profile.as_ref(),
        );

        // 4. Shot count ratio
        let shot_score = if ref_shots > 0 && src_shots > 0 {
            1.0 - (1.0 - src_shots as f64 / ref_shots as f64).abs().min(1.0)
        } else {
            0.0
        };

        duration_score * WEIGHT_DURATION
            + content_score * WEIGHT_CONTENT
            + audio_score * WEIGHT_AUDIO
            + shot_score * WEIGHT_SHOTS
    }

    /// Computes Jaccard similarity between the segment types present
    /// in two content segment lists.
    fn jaccard_segment_types(
        ref_segments: &[ContentSegment],
        src_segments: &[ContentSegment],
    ) -> f64 {
        let ref_types: HashSet<SegmentType> = ref_segments
            .iter()
            .map(|s| s.segment_type.clone())
            .collect();
        let src_types: HashSet<SegmentType> = src_segments
            .iter()
            .map(|s| s.segment_type.clone())
            .collect();

        if ref_types.is_empty() && src_types.is_empty() {
            return 1.0;
        }

        let intersection = ref_types.intersection(&src_types).count();
        let union = ref_types.union(&src_types).count();

        if union == 0 {
            return 0.0;
        }

        intersection as f64 / union as f64
    }

    /// Computes similarity between reference and source audio fingerprints.
    fn compute_audio_similarity(
        reference_audio: Option<&AudioFingerprint>,
        source_audio: Option<&AudioProfile>,
    ) -> f64 {
        let (Some(reference_audio), Some(source_audio)) = (reference_audio, source_audio) else {
            return DEFAULT_AUDIO_SIMILARITY;
        };

        let bpm_score = match (reference_audio.bpm, source_audio.bpm) {
            (Some(reference_bpm), Some(source_bpm)) => {
                Self::ratio_proximity(source_bpm, reference_bpm)
            }
            _ => DEFAULT_AUDIO_SIMILARITY,
        };
        let centroid_score = Self::ratio_proximity(
            source_audio.spectral_centroid_hz,
            reference_audio.spectral_centroid_hz,
        );

        (bpm_score + centroid_score) / 2.0
    }

    /// Computes ratio proximity in the range [0.0, 1.0].
    fn ratio_proximity(lhs: f64, rhs: f64) -> f64 {
        if lhs <= 0.0 || rhs <= 0.0 {
            return DEFAULT_AUDIO_SIMILARITY;
        }

        1.0 - (1.0 - (lhs / rhs)).abs().min(1.0)
    }
}

/// Creates a `$fromStep` plan reference.
fn step_reference(step_id: &str, path: &str) -> serde_json::Value {
    serde_json::json!({
        "$fromStep": step_id,
        "$path": path,
    })
}

/// Rounds generated cut times to centisecond precision.
fn round_cut_time(time: f64) -> f64 {
    (time * 100.0).round() / 100.0
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::esd::{
        AudioFingerprint, EsdGenerator, TransitionEntry, TransitionInventory,
    };
    use crate::core::analysis::types::{AudioProfile, ContentSegment, SegmentType, VideoMetadata};
    use crate::core::annotations::models::ShotResult;
    use std::collections::HashMap;

    /// Creates a minimal ESD for testing
    fn make_test_esd(shot_durations: Vec<f64>) -> EditingStyleDocument {
        let rhythm = EsdGenerator::compute_rhythm_profile(&shot_durations);
        let n = shot_durations.len();
        let transitions = if n >= 2 {
            (0..n - 1)
                .map(|i| TransitionEntry {
                    transition_type: "cut".to_string(),
                    from_shot_index: i,
                    to_shot_index: i + 1,
                    duration_sec: 0.0,
                })
                .collect()
        } else {
            vec![]
        };
        let mut type_frequency = HashMap::new();
        if n >= 2 {
            type_frequency.insert("cut".to_string(), (n - 1) as u32);
        }

        EditingStyleDocument {
            id: "esd-test".to_string(),
            name: "Test ESD".to_string(),
            source_asset_id: "ref-asset".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            version: "1.0.0".to_string(),
            rhythm_profile: rhythm,
            transition_inventory: TransitionInventory {
                transitions,
                type_frequency,
                dominant_type: "cut".to_string(),
            },
            audio_fingerprint: Some(AudioFingerprint {
                bpm: Some(120.0),
                spectral_centroid_hz: 2000.0,
            }),
            pacing_curve: vec![],
            sync_points: vec![],
            content_map: vec![],
            camera_patterns: vec![],
            extra_fields: HashMap::new(),
        }
    }

    fn make_context() -> StylePlanningContext {
        StylePlanningContext::new("sequence-1", "src-asset").with_track_name("Styled Source")
    }

    /// Creates a minimal source bundle for testing
    fn make_test_bundle(shot_durations: Vec<f64>, segments: Vec<SegmentType>) -> AnalysisBundle {
        let total_duration: f64 = shot_durations.iter().sum();
        let mut bundle = AnalysisBundle::new(
            "src-asset",
            VideoMetadata::new(total_duration).with_audio(true),
        );

        let mut shots = Vec::new();
        let mut cumulative = 0.0;
        for dur in &shot_durations {
            shots.push(ShotResult::new(cumulative, cumulative + dur, 0.9));
            cumulative += dur;
        }
        bundle.shots = Some(shots);

        if !segments.is_empty() {
            let seg_dur = total_duration / segments.len() as f64;
            let mut start = 0.0;
            let content_segments: Vec<ContentSegment> = segments
                .into_iter()
                .map(|st| {
                    let seg = ContentSegment::new(start, start + seg_dur, st, 0.8);
                    start += seg_dur;
                    seg
                })
                .collect();
            bundle.segments = Some(content_segments);
        }

        bundle.audio_profile = Some(AudioProfile {
            bpm: Some(120.0),
            spectral_centroid_hz: 2000.0,
            loudness_profile: vec![-20.0; total_duration as usize],
            peak_db: -10.0,
            silence_regions: vec![],
        });

        bundle
    }

    // -------------------------------------------------------------------------
    // Plan Generation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_generate_plan_for_similar_length_footage() {
        let mut esd = make_test_esd(vec![3.0, 2.0, 4.0, 1.0]);
        esd.content_map = vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9),
            ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.9),
        ];
        let bundle = make_test_bundle(
            vec![2.5, 2.5, 3.5, 1.5],
            vec![SegmentType::Talk, SegmentType::Performance],
        );

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();

        assert!(!result.plan.steps.is_empty());
        assert!(result.compatibility_score > 0.7);
        assert_eq!(result.plan.steps[0].tool_name, "AddTrack");
        assert_eq!(result.plan.steps[1].tool_name, "InsertClip");

        let splits: Vec<_> = result
            .plan
            .steps
            .iter()
            .filter(|s| s.tool_name == "SplitClip")
            .collect();
        assert_eq!(splits.len(), 3);
        assert_eq!(splits[0].params["clipId"]["$fromStep"], "step-1");
        assert_eq!(splits[1].params["clipId"]["$fromStep"], "step-2");
        assert!((splits[0].params["splitTime"].as_f64().unwrap() - 2.5).abs() < 0.01);
        assert!((splits[1].params["splitTime"].as_f64().unwrap() - 5.0).abs() < 0.01);
        assert!((splits[2].params["splitTime"].as_f64().unwrap() - 8.5).abs() < 0.01);
    }

    #[test]
    fn should_generate_more_cuts_for_longer_source() {
        let esd = make_test_esd(vec![2.0, 3.0, 5.0]); // 10s total, 2 cuts
        let bundle = make_test_bundle(vec![6.0, 9.0, 15.0], vec![SegmentType::Talk]); // 30s total (3x longer)

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();

        // Should have 2 split_clip steps scaled to 30s
        let splits: Vec<_> = result
            .plan
            .steps
            .iter()
            .filter(|s| s.tool_name == "SplitClip")
            .collect();
        assert_eq!(splits.len(), 2);

        let first_time = splits[0].params["splitTime"].as_f64().unwrap();
        assert!((first_time - 6.0).abs() < 0.1);

        let second_time = splits[1].params["splitTime"].as_f64().unwrap();
        assert!((second_time - 15.0).abs() < 0.1);
    }

    #[test]
    fn should_warn_when_source_much_shorter_than_reference() {
        let esd = make_test_esd(vec![10.0, 20.0, 30.0]); // 60s
        let bundle = make_test_bundle(vec![3.0, 5.0, 2.0], vec![SegmentType::Talk]); // 10s (17% of ref)

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();

        assert!(
            result.warnings.iter().any(|w| w.contains("sparse edit")),
            "Expected duration warning, got: {:?}",
            result.warnings
        );
    }

    #[test]
    fn should_generate_empty_plan_for_empty_esd() {
        let esd = make_test_esd(vec![]);
        let bundle = make_test_bundle(vec![5.0], vec![]);

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();
        assert!(result.plan.steps.is_empty());
    }

    #[test]
    fn should_split_within_single_source_shot_when_dtw_compresses_boundaries() {
        let esd = make_test_esd(vec![1.0, 1.0, 1.0, 1.0]);
        let bundle = make_test_bundle(vec![2.0, 2.0], vec![SegmentType::Talk]);

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();
        let split_times: Vec<f64> = result
            .plan
            .steps
            .iter()
            .filter(|step| step.tool_name == "SplitClip")
            .filter_map(|step| step.params["splitTime"].as_f64())
            .collect();

        assert_eq!(split_times.len(), 3);
        assert!(split_times[0] < 2.0);
        assert!(split_times.windows(2).all(|window| window[1] > window[0]));
        assert!(split_times.iter().all(|time| *time > 0.0 && *time < 4.0));
    }

    #[test]
    fn should_warn_when_non_cut_transitions_cannot_be_executed() {
        let mut esd = make_test_esd(vec![3.0, 3.0]);
        esd.transition_inventory = TransitionInventory {
            transitions: vec![TransitionEntry {
                transition_type: "dissolve".to_string(),
                from_shot_index: 0,
                to_shot_index: 1,
                duration_sec: 0.5,
            }],
            type_frequency: HashMap::from([("dissolve".to_string(), 1)]),
            dominant_type: "dissolve".to_string(),
        };

        let bundle = make_test_bundle(vec![3.0, 3.0], vec![SegmentType::Talk]);
        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();

        assert!(result
            .plan
            .steps
            .iter()
            .all(|step| step.tool_name != "AddTransition"));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("Skipped 1 non-cut reference transitions")));
    }

    // -------------------------------------------------------------------------
    // Compatibility Score Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_score_high_for_similar_content() {
        let mut esd = make_test_esd(vec![3.0, 2.0, 4.0, 1.0]); // 10s, 4 shots
        esd.content_map = vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9),
            ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.9),
        ];

        let bundle = make_test_bundle(
            vec![2.5, 2.5, 3.0, 2.0],
            vec![SegmentType::Talk, SegmentType::Performance],
        ); // 10s, 4 shots, same segment types

        let score = StylePlanner::compute_compatibility_score(&esd, &bundle);
        assert!(
            score > 0.7,
            "Expected high score for similar content, got {}",
            score
        );
    }

    #[test]
    fn should_score_low_for_mismatched_content() {
        let mut esd = make_test_esd(vec![0.5, 0.5, 0.5]); // 1.5s, 3 shots (fast)
        esd.content_map = vec![ContentSegment::new(0.0, 1.5, SegmentType::Montage, 0.9)];

        let bundle = make_test_bundle(vec![30.0, 20.0, 40.0, 50.0, 60.0], vec![SegmentType::Talk]); // 200s, 5 shots (talk only)

        let score = StylePlanner::compute_compatibility_score(&esd, &bundle);
        assert!(
            score < 0.4,
            "Expected low score for mismatched content, got {}",
            score
        );
    }

    #[test]
    fn should_include_low_compatibility_warning() {
        let esd = make_test_esd(vec![0.5, 0.3, 0.2]); // 1s montage
        let bundle = make_test_bundle(vec![60.0, 60.0], vec![SegmentType::Talk]); // 120s talking head

        let result = StylePlanner::plan(&esd, &bundle, &make_context()).unwrap();
        assert!(result.compatibility_score < 0.4);
        assert!(
            result
                .warnings
                .iter()
                .any(|w| w.contains("Low compatibility")),
            "Expected low compatibility warning, got: {:?}",
            result.warnings
        );
    }

    // -------------------------------------------------------------------------
    // Jaccard Similarity Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_perfect_jaccard_for_identical_types() {
        let segments = vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9),
            ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.9),
        ];

        let score = StylePlanner::jaccard_segment_types(&segments, &segments);
        assert!((score - 1.0).abs() < 1e-10);
    }

    #[test]
    fn should_compute_zero_jaccard_for_disjoint_types() {
        let ref_segs = vec![ContentSegment::new(0.0, 5.0, SegmentType::Montage, 0.9)];
        let src_segs = vec![ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9)];

        let score = StylePlanner::jaccard_segment_types(&ref_segs, &src_segs);
        assert!((score - 0.0).abs() < 1e-10);
    }

    #[test]
    fn should_compute_partial_jaccard() {
        let ref_segs = vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9),
            ContentSegment::new(5.0, 10.0, SegmentType::Performance, 0.9),
        ];
        let src_segs = vec![
            ContentSegment::new(0.0, 5.0, SegmentType::Talk, 0.9),
            ContentSegment::new(5.0, 10.0, SegmentType::Reaction, 0.9),
        ];

        // intersection = {Talk}, union = {Talk, Performance, Reaction}
        let score = StylePlanner::jaccard_segment_types(&ref_segs, &src_segs);
        assert!((score - 1.0 / 3.0).abs() < 0.01);
    }

    #[test]
    fn should_return_1_for_both_empty_segments() {
        let score = StylePlanner::jaccard_segment_types(&[], &[]);
        assert!((score - 1.0).abs() < 1e-10);
    }

    // -------------------------------------------------------------------------
    // StylePlanResult Serialization Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_roundtrip_style_plan_result_via_json() {
        let result = StylePlanResult {
            plan: AgentPlan {
                id: "plan-1".to_string(),
                goal: "Apply style".to_string(),
                steps: vec![PlanStep {
                    id: "step-0".to_string(),
                    tool_name: "split_clip".to_string(),
                    params: serde_json::json!({"splitTime": 5.0}),
                    description: "Split at 5s".to_string(),
                    risk_level: PlanRiskLevel::Low,
                    depends_on: vec![],
                    optional: false,
                }],
                approval_granted: false,
                session_id: None,
            },
            compatibility_score: 0.85,
            warnings: vec!["Test warning".to_string()],
        };

        let json = serde_json::to_string_pretty(&result).unwrap();
        let parsed: StylePlanResult = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.plan.id, "plan-1");
        assert_eq!(parsed.plan.steps.len(), 1);
        assert!((parsed.compatibility_score - 0.85).abs() < 1e-10);
        assert_eq!(parsed.warnings.len(), 1);
    }
}
