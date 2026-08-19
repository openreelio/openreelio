//! Style-Aware Plan Generator (ADR-050)
//!
//! Generates an [`AgentPlan`] that transforms source footage to match
//! the editing style captured in an [`EditingStyleDocument`].
//!
//! Uses DTW alignment to map reference shot pacing onto the source
//! timeline, producing executable `AddTrack`, `InsertClip`, and `SplitClip`
//! plan steps.
//!
//! The same cut machinery also serves a curated
//! [`PacingProfileSpec`](crate::core::style::PacingProfileSpec) — see
//! [`StylePlanner::plan_from_profile`] — which is the input to reach for when
//! there is no reference video, only an idiom to cut in.
//!
//! Neither path plans a transition today. The profile path *can* — the
//! `AddEffect` cadence is implemented and tested — but no shipped profile asks
//! for one while a profile cannot tell which of the cuts it places left the
//! source media a blend has to be paid for with. The ESD
//! path cannot at all: a reference ESD's transition inventory records *that* a
//! dissolve happened, never which curated recipe would reproduce it, so non-cut
//! reference transitions stay a warning rather than a guess.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::dtw::{dtw_align, DtwResult};
use super::esd::{AudioFingerprint, EditingStyleDocument};
use super::types::{AnalysisBundle, AudioProfile, ContentSegment, SegmentType};
use crate::core::ai::agent_plan::{AgentPlan, PlanRiskLevel, PlanStep};
use crate::core::annotations::models::ShotResult;
use crate::core::style::PacingProfileSpec;
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

/// How far a profile cut may move to land on a detected source shot change,
/// as a fraction of the profile's target shot length.
///
/// Half a shot is the largest move that cannot reorder cuts: beyond it a cut
/// could snap past its neighbour's ideal position and the pacing the profile
/// asked for stops being recognisable.
const SHOT_SNAP_FRACTION: f64 = 0.5;

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

/// Where a generated plan places its curated transitions.
#[derive(Clone, Copy, Debug)]
struct TransitionCadence {
    /// Curated transition recipe id, resolved at `CommandPayload::parse`.
    recipe: &'static str,
    /// Place a transition every N cut boundaries, starting at the first.
    every_n: usize,
}

/// Cut times after snapping, plus how many actually moved.
struct SnappedCutTimes {
    cut_times: Vec<f64>,
    moved_count: usize,
}

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
        Self::validate_context(source_bundle, context)?;

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
            approval_proof: None,
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

    /// Generates an executable [`AgentPlan`] that cuts the source footage to a
    /// curated pacing profile.
    ///
    /// This is the reference-free half of style planning: instead of measuring
    /// shot durations off a reference video, the profile states the mean shot
    /// length, how much shots should vary, and how often to place a transition.
    /// Everything downstream is the ESD path's machinery — the same cut
    /// validity rules, the same `AddTrack` / `InsertClip` / `SplitClip` shape —
    /// so a plan from a profile and a plan from a reference are the same kind
    /// of object.
    ///
    /// Cut placement is deterministic: the same profile on the same source
    /// always produces the same plan, so a review of the plan is a review of
    /// what will execute.
    pub fn plan_from_profile(
        profile: &PacingProfileSpec,
        source_bundle: &AnalysisBundle,
        context: &StylePlanningContext,
    ) -> CoreResult<StylePlanResult> {
        Self::validate_context(source_bundle, context)?;

        let src_total = source_bundle.metadata.duration_sec;
        let source_shots = source_bundle.shots.as_deref().unwrap_or(&[]);
        let mut warnings = Vec::new();

        if !src_total.is_finite() || src_total <= 0.0 {
            return Err(CoreError::ValidationError(format!(
                "Source asset '{}' has no known duration; run analysis before planning",
                context.source_asset_id
            )));
        }

        let shot_durations = Self::profile_shot_durations(profile, src_total);
        let mut cut_times = Self::compute_scaled_cut_times(&shot_durations, src_total, src_total);
        let ungrouped_cut_count = cut_times.len();

        // A source that rounds to a single shot produces no splits at all. That
        // is a legitimate answer, but an empty `cutCount` with no explanation
        // reads as a broken command, so the reason travels with the plan.
        if ungrouped_cut_count == 0 {
            warnings.push(format!(
                "Source is {:.1}s, shorter than 1.5x the profile's {:.1}s target shot, so it \
                 rounds to a single shot; no cuts planned. The plan still creates the track and \
                 places the clip",
                src_total, profile.target_shot_sec
            ));
        }

        if profile.respect_shot_boundaries {
            let boundaries = Self::interior_shot_boundaries(source_shots, src_total);

            if source_shots.is_empty() {
                warnings.push(format!(
                    "Profile '{}' respects shot boundaries, but no shot detection results are \
                     cached for this asset; cuts fall on the profile's own grid. Run `analysis \
                     shots` first to align them with the footage",
                    profile.id
                ));
            } else if boundaries.is_empty() {
                // Shot detection ran and found one shot spanning the whole
                // source, so there is nothing to snap onto. Without this the
                // profile's headline behaviour is a silent no-op.
                warnings.push(format!(
                    "Profile '{}' respects shot boundaries, but shot detection found a single \
                     shot covering the whole source; there is nothing to snap onto and cuts fall \
                     on the profile's own grid",
                    profile.id
                ));
            } else {
                let snapped = Self::snap_cut_times_to_shots(
                    &cut_times,
                    &boundaries,
                    src_total,
                    profile.target_shot_sec * SHOT_SNAP_FRACTION,
                );
                let moved = snapped.moved_count;
                cut_times = snapped.cut_times;
                if moved > 0 {
                    warnings.push(format!(
                        "Moved {} of {} cuts onto detected shot changes",
                        moved,
                        cut_times.len()
                    ));
                }
            }
        }

        if ungrouped_cut_count > 0 && cut_times.is_empty() {
            warnings.push(format!(
                "All {} planned cuts collided with each other once snapped onto detected shot \
                 changes; no cuts planned. The plan still creates the track and places the clip",
                ungrouped_cut_count
            ));
        }

        let cadence = profile
            .active_transition()
            .map(|(recipe, every_n)| TransitionCadence { recipe, every_n });

        // The track and the clip are planned whether or not any cut is: a plan
        // that places the footage is a usable answer, an empty one is not.
        let steps = Self::generate_steps_with_transitions(context, &cut_times, cadence);

        let compatibility_score = Self::profile_fidelity_score(profile, &cut_times, src_total);

        let plan = AgentPlan {
            id: uuid::Uuid::new_v4().to_string(),
            goal: format!("Cut source footage to the '{}' pacing profile", profile.id),
            steps,
            approval_granted: false,
            approval_proof: None,
            session_id: None,
        };

        Ok(StylePlanResult {
            plan,
            compatibility_score,
            warnings,
        })
    }

    /// Validates the planning context against the bundle it will cut.
    fn validate_context(
        source_bundle: &AnalysisBundle,
        context: &StylePlanningContext,
    ) -> CoreResult<()> {
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

        Ok(())
    }

    /// Builds the shot durations a profile asks for across the whole source.
    ///
    /// Shot lengths alternate `target - variance/2`, `target + variance/2`, so
    /// consecutive shots differ audibly while the mean stays on target. The
    /// alternation is a fixed pattern rather than a random draw on purpose: a
    /// plan an agent is expected to read, edit, and re-run has to be the same
    /// plan every time it is generated. The result is then scaled so the shots
    /// sum to exactly the source duration, which also corrects the imbalance an
    /// odd shot count leaves in a two-phase pattern.
    fn profile_shot_durations(profile: &PacingProfileSpec, src_total: f64) -> Vec<f64> {
        let target = profile.target_shot_sec;
        if !target.is_finite() || target <= 0.0 || !src_total.is_finite() || src_total <= 0.0 {
            return Vec::new();
        }

        let shot_count = (src_total / target).round().max(1.0) as usize;
        let half_swing = (profile.shot_variance_sec / 2.0).clamp(0.0, target * 0.9);

        let mut durations: Vec<f64> = (0..shot_count)
            .map(|index| {
                if index % 2 == 0 {
                    target - half_swing
                } else {
                    target + half_swing
                }
            })
            .collect();

        let generated_total: f64 = durations.iter().sum();
        if generated_total > 0.0 {
            let scale = src_total / generated_total;
            for duration in &mut durations {
                *duration *= scale;
            }
        }

        durations
    }

    /// Returns the detected shot changes that fall inside the source.
    ///
    /// A shot's end at the very end of the source is not a boundary anything can
    /// be cut on, so a bundle with one shot yields no boundaries at all — which
    /// is the case worth reporting rather than silently ignoring.
    fn interior_shot_boundaries(source_shots: &[ShotResult], src_total: f64) -> Vec<f64> {
        source_shots
            .iter()
            .map(|shot| shot.end_sec)
            .filter(|time| time.is_finite() && *time > 0.0 && *time < src_total)
            .collect()
    }

    /// Moves each cut onto the nearest detected shot change within `tolerance`.
    ///
    /// A cut that lands mid-shot reads as an accident; a cut on a shot change
    /// reads as an edit. Cuts with no shot change nearby stay where the profile
    /// put them rather than being dragged somewhere arbitrary, and a snap that
    /// would collide with the previous cut is dropped by the same validity
    /// rules the ESD path uses.
    fn snap_cut_times_to_shots(
        cut_times: &[f64],
        boundaries: &[f64],
        src_total: f64,
        tolerance_sec: f64,
    ) -> SnappedCutTimes {
        let mut snapped = Vec::with_capacity(cut_times.len());
        let mut moved_count = 0usize;
        let mut last_cut = None;

        for cut_time in cut_times {
            let nearest = boundaries
                .iter()
                .copied()
                .min_by(|left, right| {
                    (left - cut_time)
                        .abs()
                        .partial_cmp(&(right - cut_time).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .filter(|boundary| (boundary - cut_time).abs() <= tolerance_sec);

            let Some(selected) =
                Self::select_cut_time(nearest, Some(*cut_time), src_total, last_cut)
            else {
                continue;
            };

            if (selected - *cut_time).abs() > f64::EPSILON {
                moved_count += 1;
            }
            snapped.push(selected);
            last_cut = Some(selected);
        }

        SnappedCutTimes {
            cut_times: snapped,
            moved_count,
        }
    }

    /// Scores how closely the generated cuts match the profile's target.
    ///
    /// Unlike the ESD path there is no reference to be compatible *with*, so
    /// the score reports fidelity instead: how close the mean generated shot is
    /// to the length the profile asked for. A source too short to cut at all
    /// scores 0.
    fn profile_fidelity_score(
        profile: &PacingProfileSpec,
        cut_times: &[f64],
        src_total: f64,
    ) -> f64 {
        if cut_times.is_empty() || src_total <= 0.0 {
            return 0.0;
        }

        let mean_shot_sec = src_total / (cut_times.len() + 1) as f64;
        Self::ratio_proximity(mean_shot_sec, profile.target_shot_sec)
    }

    /// Generates `AddTrack`, `InsertClip`, and `SplitClip` steps.
    fn generate_steps(context: &StylePlanningContext, cut_times: &[f64]) -> Vec<PlanStep> {
        Self::generate_steps_with_transitions(context, cut_times, None)
    }

    /// Generates the cut steps, then the transition steps a cadence asks for.
    ///
    /// No shipped profile asks for one yet. The renderer blends a two-input
    /// transition where both clips still hold unused source media, but a pacing
    /// profile places cuts by target shot length and cannot tell which of them
    /// left that media behind, so a profile that planned a dissolve would be
    /// planning an edit the export could only sometimes deliver. The cadence is
    /// kept implemented and tested (see the test-only profile in
    /// [`pacing_profiles`](crate::core::style::pacing_profiles)) so the planner
    /// half is ready once a profile can also choose eligible boundaries.
    ///
    /// Transitions are placed on the *outgoing* clip of a boundary — the clip
    /// that ends at the cut, not the one that starts there. Attaching to the
    /// incoming clip would move every transition one cut later.
    ///
    /// The outgoing clip of boundary `i` is whatever the split at the previous
    /// boundary left behind — `SplitClip` keeps the original id on the left
    /// fragment and returns the right one, so boundary 0's outgoing clip is the
    /// inserted clip itself and boundary `i`'s is the clip the split at
    /// boundary `i - 1` created. Each `AddEffect` therefore depends on the
    /// split that *closes* its boundary, so the clip is already its final
    /// length when the effect lands on it.
    fn generate_steps_with_transitions(
        context: &StylePlanningContext,
        cut_times: &[f64],
        cadence: Option<TransitionCadence>,
    ) -> Vec<PlanStep> {
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

        let mut previous_tail_step_id = insert_step_id.clone();
        // Boundary `i` is closed by the split at `cut_times[i]`; its outgoing
        // clip is whatever that split's predecessor left behind.
        let mut outgoing_step_ids = Vec::with_capacity(cut_times.len());
        let mut closing_step_ids = Vec::with_capacity(cut_times.len());

        for (index, cut_time) in cut_times.iter().enumerate() {
            let step_id = format!("step-{}", index + 2);
            outgoing_step_ids.push(previous_tail_step_id.clone());
            closing_step_ids.push(step_id.clone());
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

        let Some(cadence) = cadence.filter(|cadence| cadence.every_n > 0) else {
            return steps;
        };

        for (transition_index, boundary) in
            (0..cut_times.len()).step_by(cadence.every_n).enumerate()
        {
            let step_id = format!("step-{}", cut_times.len() + 2 + transition_index);

            steps.push(PlanStep {
                id: step_id,
                tool_name: "AddEffect".to_string(),
                params: serde_json::json!({
                    "sequenceId": context.sequence_id.clone(),
                    "trackId": step_reference(&track_step_id, "createdIds.0"),
                    "clipId": step_reference(&outgoing_step_ids[boundary], "createdIds.0"),
                    "recipe": cadence.recipe,
                }),
                description: format!(
                    "Place the '{}' transition on the cut at {:.2}s",
                    cadence.recipe, cut_times[boundary]
                ),
                risk_level: PlanRiskLevel::Low,
                depends_on: vec![closing_step_ids[boundary].clone()],
                optional: false,
            });
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
                dtw_cut_times[run_end]
                    .and_then(|terminal| scaled_time.map(|st| st.min(terminal - MIN_SPLIT_GAP_SEC)))
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
    use crate::core::analysis::types::{
        AudioProfile, ContentSegment, SegmentType, SpeechRegion, VideoMetadata,
    };
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
            speech_regions: vec![SpeechRegion::new(0.0, total_duration)],
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
                approval_proof: None,
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

    // =========================================================================
    // Pacing profile planning
    // =========================================================================

    fn profile(id: &str) -> &'static crate::core::style::PacingProfileSpec {
        crate::core::style::resolve_pacing_profile(id).expect("profile resolves")
    }

    /// The test-only profile that still places transitions.
    ///
    /// No shipped profile does while the renderer turns a two-input transition
    /// into a cut, but the cadence machinery is finished and stays proven here.
    fn transition_profile() -> &'static crate::core::style::PacingProfileSpec {
        &crate::core::style::pacing_profiles::TRANSITION_CADENCE_TEST_PROFILE
    }

    fn plain_bundle(duration_sec: f64) -> AnalysisBundle {
        AnalysisBundle::new(
            "src-asset",
            VideoMetadata::new(duration_sec).with_audio(true),
        )
    }

    fn split_times(plan: &AgentPlan) -> Vec<f64> {
        plan.steps
            .iter()
            .filter(|step| step.tool_name == "SplitClip")
            .map(|step| step.params["splitTime"].as_f64().expect("split time"))
            .collect()
    }

    fn transition_steps(plan: &AgentPlan) -> Vec<&PlanStep> {
        plan.steps
            .iter()
            .filter(|step| step.tool_name == "AddEffect")
            .collect()
    }

    #[test]
    fn a_profile_plan_cuts_near_its_target_shot_length() {
        let bundle = plain_bundle(60.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result =
            StylePlanner::plan_from_profile(profile("steady-documentary"), &bundle, &context)
                .expect("plan generates");

        let cuts = split_times(&result.plan);
        assert!(!cuts.is_empty(), "a 60s source must be cut");

        let mean_shot = 60.0 / (cuts.len() + 1) as f64;
        assert!(
            (mean_shot - 4.5).abs() < 1.0,
            "mean shot {mean_shot} should sit near the 4.5s target"
        );
    }

    #[test]
    fn profile_planning_is_deterministic() {
        let bundle = make_test_bundle(vec![3.0, 4.0, 2.5, 6.0, 5.0], vec![]);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let first = StylePlanner::plan_from_profile(profile("dynamic-social"), &bundle, &context)
            .expect("plan generates");
        let second = StylePlanner::plan_from_profile(profile("dynamic-social"), &bundle, &context)
            .expect("plan generates");

        assert_eq!(split_times(&first.plan), split_times(&second.plan));
        assert_eq!(
            first.plan.steps.len(),
            second.plan.steps.len(),
            "the same profile on the same source must plan the same edit"
        );
    }

    #[test]
    fn shot_lengths_alternate_around_the_target() {
        let bundle = plain_bundle(60.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result = StylePlanner::plan_from_profile(profile("calm-longform"), &bundle, &context)
            .expect("plan generates");

        let cuts = split_times(&result.plan);
        assert!(cuts.len() >= 2, "expected several cuts, got {cuts:?}");

        let mut lengths = Vec::new();
        let mut previous = 0.0;
        for cut in &cuts {
            lengths.push(cut - previous);
            previous = *cut;
        }

        // A variance-carrying profile must not produce a metronome.
        let shortest = lengths.iter().cloned().fold(f64::MAX, f64::min);
        let longest = lengths.iter().cloned().fold(f64::MIN, f64::max);
        assert!(
            longest - shortest > 0.5,
            "calm-longform declares 2s of swing but produced {lengths:?}"
        );
    }

    #[test]
    fn a_boundary_respecting_profile_snaps_cuts_onto_detected_shots() {
        // Shot changes every 5s; the profile's own 2.5s grid lands half its
        // cuts between them, so those have to move onto the real changes.
        let bundle = make_test_bundle(vec![5.0; 6], vec![]);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result = StylePlanner::plan_from_profile(profile("dynamic-social"), &bundle, &context)
            .expect("plan generates");

        let boundaries: Vec<f64> = (1..6).map(|index| index as f64 * 5.0).collect();
        let snapped = split_times(&result.plan)
            .into_iter()
            .filter(|cut| {
                boundaries
                    .iter()
                    .any(|boundary| (boundary - cut).abs() < 0.01)
            })
            .count();

        assert!(
            snapped > 0,
            "a boundary-respecting profile must land cuts on detected shot changes"
        );
    }

    #[test]
    fn a_boundary_respecting_profile_says_so_when_there_are_no_shots() {
        let bundle = plain_bundle(40.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result =
            StylePlanner::plan_from_profile(profile("steady-documentary"), &bundle, &context)
                .expect("plan generates");

        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("analysis") && warning.contains("shots")),
            "the warning must name the command that fixes it: {:?}",
            result.warnings
        );
    }

    #[test]
    fn every_shipped_profile_emits_no_transition_steps() {
        // Shipped profiles cut hard while the renderer turns a two-input
        // transition into a cut. A profile that planned one would be planning
        // an edit the export cannot deliver.
        let bundle = plain_bundle(60.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        for spec in crate::core::style::PACING_PROFILES {
            let result =
                StylePlanner::plan_from_profile(spec, &bundle, &context).expect("plan generates");
            assert!(
                transition_steps(&result.plan).is_empty(),
                "profile '{}' must cut hard",
                spec.id
            );
        }
    }

    #[test]
    fn transitions_land_every_n_boundaries_on_the_outgoing_clip() {
        let bundle = plain_bundle(60.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let spec = transition_profile();
        let (recipe, every_n) = spec
            .active_transition()
            .expect("profile places transitions");

        let result =
            StylePlanner::plan_from_profile(spec, &bundle, &context).expect("plan generates");
        let cut_count = split_times(&result.plan).len();
        let transitions = transition_steps(&result.plan);

        assert_eq!(
            transitions.len(),
            cut_count.div_ceil(every_n),
            "expected one transition every {every_n} of {cut_count} cuts"
        );

        for step in &transitions {
            assert_eq!(step.params["recipe"].as_str(), Some(recipe));
            assert!(
                step.params["clipId"]["$fromStep"].is_string(),
                "a transition must reference the clip a previous step created: {}",
                step.params
            );
        }

        // Boundary 0's outgoing clip is the inserted clip itself: `SplitClip`
        // leaves the original id on the left fragment.
        assert_eq!(
            transitions[0].params["clipId"]["$fromStep"].as_str(),
            Some("step-1"),
        );
    }

    #[test]
    fn every_transition_step_waits_for_the_split_that_closes_its_boundary() {
        let bundle = plain_bundle(60.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result = StylePlanner::plan_from_profile(transition_profile(), &bundle, &context)
            .expect("plan generates");

        let transitions = transition_steps(&result.plan);
        assert!(
            !transitions.is_empty(),
            "the test profile must plan transitions"
        );

        let step_ids: std::collections::HashSet<&str> = result
            .plan
            .steps
            .iter()
            .map(|step| step.id.as_str())
            .collect();

        for step in transitions {
            assert_eq!(step.depends_on.len(), 1, "step '{}'", step.id);
            let dependency = &step.depends_on[0];
            assert!(
                step_ids.contains(dependency.as_str()),
                "step '{}' depends on unknown step '{dependency}'",
                step.id
            );
        }
    }

    #[test]
    fn a_source_shorter_than_one_shot_still_places_the_clip_and_says_why_it_did_not_cut() {
        let bundle = plain_bundle(2.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result = StylePlanner::plan_from_profile(profile("calm-longform"), &bundle, &context)
            .expect("plan generates");

        assert!(
            split_times(&result.plan).is_empty(),
            "a 2s source cannot be cut to 7s shots"
        );
        let tool_names: Vec<&str> = result
            .plan
            .steps
            .iter()
            .map(|step| step.tool_name.as_str())
            .collect();
        assert_eq!(
            tool_names,
            vec!["AddTrack", "InsertClip"],
            "an uncut plan must still place the footage"
        );
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("1.5x") && warning.contains("no cuts planned")),
            "{:?}",
            result.warnings
        );
    }

    #[test]
    fn a_source_between_one_and_one_and_a_half_target_shots_says_why_it_did_not_cut() {
        // The gap that used to return `status: ok` with an empty plan and no
        // explanation: longer than one target shot, too short to round to two.
        let bundle = plain_bundle(5.4);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result =
            StylePlanner::plan_from_profile(profile("steady-documentary"), &bundle, &context)
                .expect("plan generates");

        assert!(split_times(&result.plan).is_empty());
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("1.5x") && warning.contains("no cuts planned")),
            "a silent zero-cut plan must explain itself: {:?}",
            result.warnings
        );
    }

    #[test]
    fn a_single_detected_shot_is_reported_rather_than_silently_ignored() {
        // Shot detection ran and found one shot spanning the source, so
        // `respectShotBoundaries` has nothing to snap onto.
        let bundle = make_test_bundle(vec![40.0], vec![]);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let result =
            StylePlanner::plan_from_profile(profile("steady-documentary"), &bundle, &context)
                .expect("plan generates");

        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("single shot")),
            "a no-op snap must say so: {:?}",
            result.warnings
        );
    }

    #[test]
    fn planning_without_a_source_duration_is_rejected() {
        let bundle = plain_bundle(0.0);
        let context = StylePlanningContext::new("seq-1", "src-asset");

        let error = StylePlanner::plan_from_profile(profile("dynamic-social"), &bundle, &context)
            .expect_err("a zero-length source cannot be cut");

        assert!(format!("{error}").contains("analysis"), "{error}");
    }

    #[test]
    fn a_mismatched_bundle_asset_is_rejected() {
        let bundle = plain_bundle(30.0);
        let context = StylePlanningContext::new("seq-1", "other-asset");

        StylePlanner::plan_from_profile(profile("dynamic-social"), &bundle, &context)
            .expect_err("bundle and context must agree on the asset");
    }
}
