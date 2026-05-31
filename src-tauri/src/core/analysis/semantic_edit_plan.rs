//! Semantic temporal edit planning from clip perception evidence.
//!
//! This module converts cached semantic clip observations into timeline ranges
//! and command drafts. It is intentionally read-only: actual edits must still
//! go through command-log tools.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::analysis::clip_analysis::load_clip_analysis_bundle_optional;
use crate::core::analysis::clip_perception::{
    load_clip_perception_bundle_optional, ClipPerceptionEvidenceSource, ClipSemanticObservation,
};
use crate::core::annotations::{AnnotationStore, AssetAnnotation, BoundingBox};
use crate::core::{CoreError, CoreResult};

const DEFAULT_PADDING_SEC: f64 = 0.2;
const DEFAULT_MERGE_GAP_SEC: f64 = 0.35;
const DEFAULT_MIN_CONFIDENCE: f64 = 0.0;
const DEFAULT_SPATIAL_TIME_TOLERANCE_SEC: f64 = 0.75;
const MAX_PADDING_SEC: f64 = 10.0;
const MAX_MERGE_GAP_SEC: f64 = 30.0;
const MAX_SPATIAL_TIME_TOLERANCE_SEC: f64 = 5.0;
const DEFAULT_MAX_RANGES: u32 = 12;
const MAX_RANGES: u32 = 50;
const MAX_SPATIAL_TARGETS_PER_RANGE: usize = 5;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SemanticTemporalEditAction {
    #[default]
    Blur,
    Highlight,
    Remove,
    Marker,
    AddText,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditPlanOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_gap_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_ranges: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_strength: Option<f64>,
    #[serde(default = "default_include_command_drafts")]
    pub include_command_drafts: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spatial_time_tolerance_sec: Option<f64>,
    #[serde(default = "default_include_spatial_targets")]
    pub include_spatial_targets: bool,
}

impl Default for SemanticTemporalEditPlanOptions {
    fn default() -> Self {
        Self {
            padding_sec: None,
            merge_gap_sec: None,
            min_confidence: None,
            max_ranges: None,
            text: None,
            effect_strength: None,
            include_command_drafts: default_include_command_drafts(),
            spatial_time_tolerance_sec: None,
            include_spatial_targets: default_include_spatial_targets(),
        }
    }
}

fn default_include_command_drafts() -> bool {
    true
}

fn default_include_spatial_targets() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SemanticTemporalEditQualityStatus {
    Ready,
    Partial,
    Insufficient,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditPlanQuality {
    pub status: SemanticTemporalEditQualityStatus,
    pub score: u32,
    pub matched_sample_count: u32,
    pub range_count: u32,
    pub warnings: Vec<String>,
    pub recommended_actions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditEvidence {
    pub sample_id: String,
    pub timeline_sec: f64,
    pub source_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_index: Option<u64>,
    pub image_path: String,
    pub description: String,
    pub confidence: f64,
    pub evidence_source: ClipPerceptionEvidenceSource,
    pub matched_fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SemanticTemporalEditDraftRisk {
    Low,
    NeedsReview,
    NeedsResolution,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditCommandDraft {
    pub command_type: String,
    pub payload: serde_json::Value,
    pub reason: String,
    pub requires_resolution: Vec<String>,
    pub risk: SemanticTemporalEditDraftRisk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SemanticTemporalSpatialTargetKind {
    Object,
    Face,
    TextOcr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalSpatialTarget {
    pub target_id: String,
    pub kind: SemanticTemporalSpatialTargetKind,
    pub label: String,
    pub source_sec: f64,
    pub time_delta_sec: f64,
    pub confidence: f64,
    pub bounding_box: BoundingBox,
    pub mask_shape: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditRange {
    pub range_id: String,
    pub timeline_start_sec: f64,
    pub timeline_end_sec: f64,
    pub source_start_sec: f64,
    pub source_end_sec: f64,
    pub sample_ids: Vec<String>,
    pub confidence: f64,
    pub matched_fields: Vec<String>,
    pub evidence: Vec<SemanticTemporalEditEvidence>,
    pub spatial_targets: Vec<SemanticTemporalSpatialTarget>,
    pub command_drafts: Vec<SemanticTemporalEditCommandDraft>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTemporalEditPlan {
    pub plan_id: String,
    pub perception_fingerprint: String,
    pub clip_fingerprint: String,
    pub sequence_id: String,
    pub track_id: String,
    pub clip_id: String,
    pub asset_id: String,
    pub query: String,
    pub action: SemanticTemporalEditAction,
    pub ranges: Vec<SemanticTemporalEditRange>,
    pub quality: SemanticTemporalEditPlanQuality,
    pub summary: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
struct MatchedObservation {
    observation: ClipSemanticObservation,
    matched_fields: Vec<String>,
}

#[derive(Clone, Debug)]
struct PlanPolicy {
    padding_sec: f64,
    merge_gap_sec: f64,
    min_confidence: f64,
    max_ranges: u32,
    text: Option<String>,
    effect_strength: Option<f64>,
    include_command_drafts: bool,
    spatial_time_tolerance_sec: f64,
    include_spatial_targets: bool,
}

#[derive(Clone, Copy, Debug)]
struct CommandDraftClipContext<'a> {
    sequence_id: &'a str,
    track_id: &'a str,
    clip_id: &'a str,
    clip_start: f64,
    clip_end: Option<f64>,
}

pub fn plan_semantic_clip_edit(
    project_path: &Path,
    perception_fingerprint: &str,
    query: &str,
    action: SemanticTemporalEditAction,
    options: SemanticTemporalEditPlanOptions,
) -> CoreResult<SemanticTemporalEditPlan> {
    let query = normalize_query(query);
    if query.is_empty() {
        return Err(CoreError::ValidationError(
            "Semantic edit query must not be empty".to_string(),
        ));
    }
    let policy = resolve_plan_policy(options);
    let bundle = load_clip_perception_bundle_optional(project_path, perception_fingerprint)?
        .ok_or_else(|| CoreError::AnalysisBundleNotFound(perception_fingerprint.to_string()))?;
    let clip_bundle = load_clip_analysis_bundle_optional(project_path, &bundle.clip_fingerprint)?;
    let clip_start = clip_bundle
        .as_ref()
        .map(|clip| clip.timeline_range.timeline_in_sec)
        .unwrap_or(0.0);
    let clip_end = clip_bundle
        .as_ref()
        .map(|clip| clip.timeline_range.timeline_out_sec);

    let mut matches = bundle
        .observations
        .iter()
        .filter_map(|observation| match_observation(observation, &query, policy.min_confidence))
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.observation
            .timeline_sec
            .partial_cmp(&right.observation.timeline_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut ranges = group_matches_into_ranges(&matches, &policy, clip_start, clip_end);
    ranges.truncate(policy.max_ranges as usize);
    let annotation = if policy.include_spatial_targets {
        AnnotationStore::new(project_path).load(&bundle.asset_id)?
    } else {
        None
    };

    for (index, range) in ranges.iter_mut().enumerate() {
        range.range_id = format!("range_{:03}", index + 1);
        if let Some(annotation) = annotation.as_ref() {
            range.spatial_targets = spatial_targets_for_range(range, annotation, &query, &policy);
        }
        if policy.include_command_drafts {
            range.command_drafts = build_command_drafts(
                range,
                &action,
                CommandDraftClipContext {
                    sequence_id: &bundle.sequence_id,
                    track_id: &bundle.track_id,
                    clip_id: &bundle.clip_id,
                    clip_start,
                    clip_end,
                },
                &policy,
            );
        }
        range
            .warnings
            .extend(spatial_warnings_for_action(&action, range));
    }

    let quality = build_plan_quality(matches.len(), &ranges, &action);
    let summary = build_plan_summary(&query, &action, &ranges, &quality);
    let plan_id = build_plan_id(perception_fingerprint, &query, &action, &policy);

    Ok(SemanticTemporalEditPlan {
        plan_id,
        perception_fingerprint: bundle.perception_fingerprint,
        clip_fingerprint: bundle.clip_fingerprint,
        sequence_id: bundle.sequence_id,
        track_id: bundle.track_id,
        clip_id: bundle.clip_id,
        asset_id: bundle.asset_id,
        query,
        action,
        ranges,
        quality,
        summary,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn resolve_plan_policy(options: SemanticTemporalEditPlanOptions) -> PlanPolicy {
    PlanPolicy {
        padding_sec: options
            .padding_sec
            .unwrap_or(DEFAULT_PADDING_SEC)
            .clamp(0.0, MAX_PADDING_SEC),
        merge_gap_sec: options
            .merge_gap_sec
            .unwrap_or(DEFAULT_MERGE_GAP_SEC)
            .clamp(0.0, MAX_MERGE_GAP_SEC),
        min_confidence: options
            .min_confidence
            .unwrap_or(DEFAULT_MIN_CONFIDENCE)
            .clamp(0.0, 1.0),
        max_ranges: options
            .max_ranges
            .unwrap_or(DEFAULT_MAX_RANGES)
            .clamp(1, MAX_RANGES),
        text: options
            .text
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty()),
        effect_strength: options.effect_strength.filter(|value| value.is_finite()),
        include_command_drafts: options.include_command_drafts,
        spatial_time_tolerance_sec: options
            .spatial_time_tolerance_sec
            .unwrap_or(DEFAULT_SPATIAL_TIME_TOLERANCE_SEC)
            .clamp(0.0, MAX_SPATIAL_TIME_TOLERANCE_SEC),
        include_spatial_targets: options.include_spatial_targets,
    }
}

fn normalize_query(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn text_matches_query(value: &str, query: &str) -> bool {
    let value = normalize_query(value);
    if value.is_empty() || query.is_empty() {
        return false;
    }
    if value.contains(query) {
        return true;
    }
    if value.len() >= 2 && query.contains(&value) {
        return true;
    }

    query
        .split_whitespace()
        .filter(|term| is_meaningful_query_term(term))
        .any(|term| value.contains(term) || (value.len() >= 2 && term.contains(&value)))
}

fn is_meaningful_query_term(term: &str) -> bool {
    if term.len() < 2 {
        return false;
    }
    !matches!(
        term,
        "the" | "and" | "for" | "with" | "from" | "that" | "this" | "clip" | "video"
    )
}

fn match_observation(
    observation: &ClipSemanticObservation,
    query: &str,
    min_confidence: f64,
) -> Option<MatchedObservation> {
    if observation.confidence < min_confidence {
        return None;
    }
    let mut fields = Vec::new();
    push_match(&mut fields, "description", &observation.description, query);
    push_match_vec(&mut fields, "subjects", &observation.subjects, query);
    push_match_vec(&mut fields, "actions", &observation.actions, query);
    push_match_vec(&mut fields, "visibleText", &observation.visible_text, query);
    push_match_vec(&mut fields, "objects", &observation.objects, query);
    if let Some(setting) = &observation.setting {
        push_match(&mut fields, "setting", setting, query);
    }
    if let Some(edit_usefulness) = &observation.edit_usefulness {
        push_match(&mut fields, "editUsefulness", edit_usefulness, query);
    }
    if fields.is_empty() {
        None
    } else {
        Some(MatchedObservation {
            observation: observation.clone(),
            matched_fields: fields,
        })
    }
}

fn push_match(fields: &mut Vec<String>, field: &str, value: &str, query: &str) {
    if text_matches_query(value, query) {
        fields.push(field.to_string());
    }
}

fn push_match_vec(fields: &mut Vec<String>, field: &str, values: &[String], query: &str) {
    if values.iter().any(|value| text_matches_query(value, query)) {
        fields.push(field.to_string());
    }
}

fn group_matches_into_ranges(
    matches: &[MatchedObservation],
    policy: &PlanPolicy,
    clip_start: f64,
    clip_end: Option<f64>,
) -> Vec<SemanticTemporalEditRange> {
    let mut ranges: Vec<SemanticTemporalEditRange> = Vec::new();
    for matched in matches {
        let observation = &matched.observation;
        let timeline_start = (observation.timeline_sec - policy.padding_sec).max(clip_start);
        let timeline_end = clip_end
            .map(|end| (observation.timeline_sec + policy.padding_sec).min(end))
            .unwrap_or(observation.timeline_sec + policy.padding_sec)
            .max(timeline_start + 0.001);
        let source_start = (observation.source_sec - policy.padding_sec).max(0.0);
        let source_end = (observation.source_sec + policy.padding_sec).max(source_start + 0.001);
        let evidence = evidence_from_match(matched);

        if let Some(last) = ranges.last_mut() {
            if timeline_start <= last.timeline_end_sec + policy.merge_gap_sec {
                last.timeline_end_sec = last.timeline_end_sec.max(timeline_end);
                last.source_start_sec = last.source_start_sec.min(source_start);
                last.source_end_sec = last.source_end_sec.max(source_end);
                last.sample_ids.push(observation.sample_id.clone());
                last.evidence.push(evidence);
                last.matched_fields = merge_strings(&last.matched_fields, &matched.matched_fields);
                last.confidence = average_confidence(&last.evidence);
                continue;
            }
        }

        ranges.push(SemanticTemporalEditRange {
            range_id: String::new(),
            timeline_start_sec: round_time(timeline_start),
            timeline_end_sec: round_time(timeline_end),
            source_start_sec: round_time(source_start),
            source_end_sec: round_time(source_end),
            sample_ids: vec![observation.sample_id.clone()],
            confidence: observation.confidence.clamp(0.0, 1.0),
            matched_fields: matched.matched_fields.clone(),
            evidence: vec![evidence],
            spatial_targets: Vec::new(),
            command_drafts: Vec::new(),
            warnings: Vec::new(),
        });
    }

    for range in &mut ranges {
        range.sample_ids.sort();
        range.sample_ids.dedup();
        range.matched_fields.sort();
        range.matched_fields.dedup();
        range.confidence = round_time(average_confidence(&range.evidence));
    }

    ranges
}

fn evidence_from_match(matched: &MatchedObservation) -> SemanticTemporalEditEvidence {
    let observation = &matched.observation;
    SemanticTemporalEditEvidence {
        sample_id: observation.sample_id.clone(),
        timeline_sec: observation.timeline_sec,
        source_sec: observation.source_sec,
        frame_index: observation.frame_index,
        image_path: observation.image_path.clone(),
        description: observation.description.clone(),
        confidence: observation.confidence.clamp(0.0, 1.0),
        evidence_source: observation.evidence_source.clone(),
        matched_fields: matched.matched_fields.clone(),
    }
}

fn merge_strings(left: &[String], right: &[String]) -> Vec<String> {
    let mut values = left.iter().cloned().collect::<BTreeSet<_>>();
    values.extend(right.iter().cloned());
    values.into_iter().collect()
}

fn average_confidence(evidence: &[SemanticTemporalEditEvidence]) -> f64 {
    if evidence.is_empty() {
        return 0.0;
    }
    evidence.iter().map(|entry| entry.confidence).sum::<f64>() / evidence.len() as f64
}

fn spatial_targets_for_range(
    range: &SemanticTemporalEditRange,
    annotation: &AssetAnnotation,
    query: &str,
    policy: &PlanPolicy,
) -> Vec<SemanticTemporalSpatialTarget> {
    let mut candidates = Vec::new();

    if let Some(objects) = annotation.analysis.objects.as_ref() {
        for detection in &objects.results {
            let Some(bounding_box) = detection.bounding_box.as_ref() else {
                continue;
            };
            if detection.confidence < policy.min_confidence {
                continue;
            }
            let Some(label) = detection
                .labels
                .iter()
                .find(|label| text_matches_query(label, query))
                .cloned()
            else {
                continue;
            };
            let Some(delta) = source_time_delta_for_range(detection.time_sec, range, policy) else {
                continue;
            };
            candidates.push(spatial_target(
                SemanticTemporalSpatialTargetKind::Object,
                label,
                detection.time_sec,
                delta,
                detection.confidence,
                bounding_box,
            ));
        }
    }

    if face_query_matches(query) {
        if let Some(faces) = annotation.analysis.faces.as_ref() {
            for detection in &faces.results {
                if detection.confidence < policy.min_confidence {
                    continue;
                }
                let Some(delta) = source_time_delta_for_range(detection.time_sec, range, policy)
                else {
                    continue;
                };
                candidates.push(spatial_target(
                    SemanticTemporalSpatialTargetKind::Face,
                    detection
                        .face_id
                        .clone()
                        .unwrap_or_else(|| "face".to_string()),
                    detection.time_sec,
                    delta,
                    detection.confidence,
                    &detection.bounding_box,
                ));
            }
        }
    }

    if let Some(text_ocr) = annotation.analysis.text_ocr.as_ref() {
        for detection in &text_ocr.results {
            let Some(bounding_box) = detection.bounding_box.as_ref() else {
                continue;
            };
            if detection.confidence < policy.min_confidence
                || !text_matches_query(&detection.text, query)
            {
                continue;
            }
            let Some(delta) = source_time_delta_for_range(detection.time_sec, range, policy) else {
                continue;
            };
            candidates.push(spatial_target(
                SemanticTemporalSpatialTargetKind::TextOcr,
                detection.text.clone(),
                detection.time_sec,
                delta,
                detection.confidence,
                bounding_box,
            ));
        }
    }

    candidates.sort_by(|left, right| {
        left.time_delta_sec
            .partial_cmp(&right.time_delta_sec)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .confidence
                    .partial_cmp(&left.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    candidates.truncate(MAX_SPATIAL_TARGETS_PER_RANGE);

    for (index, target) in candidates.iter_mut().enumerate() {
        target.target_id = format!("spatial_{:03}", index + 1);
    }

    candidates
}

fn source_time_delta_for_range(
    source_sec: f64,
    range: &SemanticTemporalEditRange,
    policy: &PlanPolicy,
) -> Option<f64> {
    let delta = if source_sec < range.source_start_sec {
        range.source_start_sec - source_sec
    } else if source_sec > range.source_end_sec {
        source_sec - range.source_end_sec
    } else {
        0.0
    };

    (delta <= policy.spatial_time_tolerance_sec).then_some(round_time(delta))
}

fn face_query_matches(query: &str) -> bool {
    [
        "face",
        "person",
        "people",
        "speaker",
        "presenter",
        "subject",
    ]
    .iter()
    .any(|needle| query.contains(needle))
}

fn spatial_target(
    kind: SemanticTemporalSpatialTargetKind,
    label: String,
    source_sec: f64,
    time_delta_sec: f64,
    confidence: f64,
    bounding_box: &BoundingBox,
) -> SemanticTemporalSpatialTarget {
    let bounding_box = normalize_bounding_box(bounding_box);
    SemanticTemporalSpatialTarget {
        target_id: String::new(),
        kind,
        label,
        source_sec: round_time(source_sec),
        time_delta_sec,
        confidence: confidence.clamp(0.0, 1.0),
        mask_shape: mask_shape_for_bbox(&bounding_box),
        bounding_box,
    }
}

fn normalize_bounding_box(bounding_box: &BoundingBox) -> BoundingBox {
    let left = bounding_box.left.clamp(0.0, 1.0);
    let top = bounding_box.top.clamp(0.0, 1.0);
    let right = (left + bounding_box.width.max(0.001)).clamp(0.0, 1.0);
    let bottom = (top + bounding_box.height.max(0.001)).clamp(0.0, 1.0);
    BoundingBox {
        left,
        top,
        width: (right - left).max(0.001),
        height: (bottom - top).max(0.001),
    }
}

fn mask_shape_for_bbox(bounding_box: &BoundingBox) -> serde_json::Value {
    let expansion = 0.03;
    let width = (bounding_box.width + expansion).clamp(0.02, 1.0);
    let height = (bounding_box.height + expansion).clamp(0.02, 1.0);
    let center_x = (bounding_box.left + bounding_box.width / 2.0).clamp(0.0, 1.0);
    let center_y = (bounding_box.top + bounding_box.height / 2.0).clamp(0.0, 1.0);

    serde_json::json!({
        "type": "rectangle",
        "x": round_time(center_x),
        "y": round_time(center_y),
        "width": round_time(width),
        "height": round_time(height),
        "cornerRadius": 0.02,
        "rotation": 0.0
    })
}

fn build_command_drafts(
    range: &SemanticTemporalEditRange,
    action: &SemanticTemporalEditAction,
    clip_context: CommandDraftClipContext<'_>,
    policy: &PlanPolicy,
) -> Vec<SemanticTemporalEditCommandDraft> {
    let mut drafts = Vec::new();
    let needs_start_split = range.timeline_start_sec > clip_context.clip_start + 0.001;
    let needs_end_split = clip_context
        .clip_end
        .is_some_and(|end| range.timeline_end_sec < end - 0.001);
    let needs_range_isolation = matches!(
        action,
        SemanticTemporalEditAction::Blur
            | SemanticTemporalEditAction::Highlight
            | SemanticTemporalEditAction::Remove
    );
    let isolated_clip_id = if needs_start_split || needs_end_split {
        "<isolatedClipId>"
    } else {
        clip_context.clip_id
    };

    if needs_range_isolation && needs_start_split {
        drafts.push(SemanticTemporalEditCommandDraft {
            command_type: "SplitClip".to_string(),
            payload: serde_json::json!({
                "sequenceId": clip_context.sequence_id,
                "trackId": clip_context.track_id,
                "clipId": clip_context.clip_id,
                "splitTime": range.timeline_start_sec,
            }),
            reason: "Create the leading boundary for the semantic target range.".to_string(),
            requires_resolution: Vec::new(),
            risk: SemanticTemporalEditDraftRisk::Low,
        });
    }

    if needs_range_isolation && needs_end_split {
        drafts.push(SemanticTemporalEditCommandDraft {
            command_type: "SplitClip".to_string(),
            payload: serde_json::json!({
                "sequenceId": clip_context.sequence_id,
                "trackId": clip_context.track_id,
                "clipId": isolated_clip_id,
                "splitTime": range.timeline_end_sec,
            }),
            reason: "Create the trailing boundary for the semantic target range.".to_string(),
            requires_resolution: vec!["isolatedClipId".to_string()],
            risk: SemanticTemporalEditDraftRisk::NeedsResolution,
        });
    }

    match action {
        SemanticTemporalEditAction::Blur => {
            drafts.push(SemanticTemporalEditCommandDraft {
                command_type: "AddEffect".to_string(),
                payload: serde_json::json!({
                    "sequenceId": clip_context.sequence_id,
                    "trackId": clip_context.track_id,
                    "clipId": isolated_clip_id,
                    "effectType": "gaussian_blur",
                    "params": {
                        "radius": blur_radius(policy)
                    }
                }),
                reason: "Apply blur to the isolated semantic target range.".to_string(),
                requires_resolution: unresolved_clip_requirements(
                    needs_start_split || needs_end_split,
                ),
                risk: SemanticTemporalEditDraftRisk::NeedsReview,
            });
            drafts.extend(mask_command_drafts_for_range(
                range,
                clip_context.sequence_id,
                clip_context.track_id,
                isolated_clip_id,
                needs_start_split || needs_end_split,
            ));
        }
        SemanticTemporalEditAction::Highlight => {
            drafts.push(SemanticTemporalEditCommandDraft {
                command_type: "AddEffect".to_string(),
                payload: serde_json::json!({
                    "sequenceId": clip_context.sequence_id,
                    "trackId": clip_context.track_id,
                    "clipId": isolated_clip_id,
                    "effectType": "brightness",
                    "params": {
                        "value": highlight_brightness(policy)
                    }
                }),
                reason: "Apply a mild visual emphasis to the isolated semantic target range."
                    .to_string(),
                requires_resolution: unresolved_clip_requirements(
                    needs_start_split || needs_end_split,
                ),
                risk: SemanticTemporalEditDraftRisk::NeedsReview,
            });
            drafts.extend(mask_command_drafts_for_range(
                range,
                clip_context.sequence_id,
                clip_context.track_id,
                isolated_clip_id,
                needs_start_split || needs_end_split,
            ));
        }
        SemanticTemporalEditAction::Remove => {
            drafts.push(SemanticTemporalEditCommandDraft {
                command_type: "RemoveClip".to_string(),
                payload: serde_json::json!({
                    "sequenceId": clip_context.sequence_id,
                    "trackId": clip_context.track_id,
                    "clipId": isolated_clip_id,
                }),
                reason: "Remove the isolated semantic target range.".to_string(),
                requires_resolution: unresolved_clip_requirements(
                    needs_start_split || needs_end_split,
                ),
                risk: SemanticTemporalEditDraftRisk::NeedsReview,
            });
        }
        SemanticTemporalEditAction::Marker => {
            drafts.push(SemanticTemporalEditCommandDraft {
                command_type: "AddMarker".to_string(),
                payload: serde_json::json!({
                    "sequenceId": clip_context.sequence_id,
                    "timeSec": range.evidence.first().map(|entry| entry.timeline_sec).unwrap_or(range.timeline_start_sec),
                    "label": format!("Semantic match: {}", range.evidence.first().map(|entry| entry.description.as_str()).unwrap_or("target")),
                    "color": "#F59E0B"
                }),
                reason: "Mark the first matching semantic sample on the timeline.".to_string(),
                requires_resolution: Vec::new(),
                risk: SemanticTemporalEditDraftRisk::Low,
            });
        }
        SemanticTemporalEditAction::AddText => {
            drafts.push(SemanticTemporalEditCommandDraft {
                command_type: "AddTextClip".to_string(),
                payload: serde_json::json!({
                    "sequenceId": clip_context.sequence_id,
                    "trackId": clip_context.track_id,
                    "timelineIn": range.timeline_start_sec,
                    "duration": (range.timeline_end_sec - range.timeline_start_sec).max(0.1),
                    "textData": {
                        "content": policy.text.clone().unwrap_or_else(|| "Add note".to_string())
                    }
                }),
                reason: "Place text over the semantic target range.".to_string(),
                requires_resolution: Vec::new(),
                risk: SemanticTemporalEditDraftRisk::NeedsReview,
            });
        }
    }

    drafts
}

fn blur_radius(policy: &PlanPolicy) -> f64 {
    policy.effect_strength.unwrap_or(18.0).clamp(0.0, 100.0)
}

fn highlight_brightness(policy: &PlanPolicy) -> f64 {
    policy.effect_strength.unwrap_or(0.12).clamp(-1.0, 1.0)
}

fn mask_command_drafts_for_range(
    range: &SemanticTemporalEditRange,
    sequence_id: &str,
    track_id: &str,
    clip_id: &str,
    needs_isolated_clip: bool,
) -> Vec<SemanticTemporalEditCommandDraft> {
    range
        .spatial_targets
        .iter()
        .map(|target| {
            let mut requires_resolution = unresolved_clip_requirements(needs_isolated_clip);
            requires_resolution.push("effectId".to_string());
            SemanticTemporalEditCommandDraft {
                command_type: "AddMask".to_string(),
                payload: serde_json::json!({
                    "sequenceId": sequence_id,
                    "trackId": track_id,
                    "clipId": clip_id,
                    "effectId": "<effectIdFromAddEffect>",
                    "shape": target.mask_shape.clone(),
                    "name": format!("Semantic mask: {}", target.label),
                    "feather": 0.08,
                    "inverted": false
                }),
                reason: format!(
                    "Constrain the preceding effect to the {} annotation box.",
                    target.label
                ),
                requires_resolution,
                risk: SemanticTemporalEditDraftRisk::NeedsResolution,
            }
        })
        .collect()
}

fn unresolved_clip_requirements(needs_isolated_clip: bool) -> Vec<String> {
    if needs_isolated_clip {
        vec!["isolatedClipId".to_string()]
    } else {
        Vec::new()
    }
}

fn spatial_warnings_for_action(
    action: &SemanticTemporalEditAction,
    range: &SemanticTemporalEditRange,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if matches!(
        action,
        SemanticTemporalEditAction::Blur | SemanticTemporalEditAction::Highlight
    ) {
        if range.spatial_targets.is_empty() {
            warnings.push(
                "This semantic evidence does not include bounding boxes; use full-frame effect only if acceptable, otherwise refine with mask/tracking before applying."
                    .to_string(),
            );
        } else {
            warnings.push(
                "Spatial annotation boxes are available; verify mask alignment and add tracking/keyframes for motion between sparse detections."
                    .to_string(),
            );
        }
    }
    if range
        .evidence
        .iter()
        .any(|entry| entry.evidence_source == ClipPerceptionEvidenceSource::LocalFallback)
    {
        warnings.push(
            "At least one matched sample only has timing fallback evidence; verify visually before editing."
                .to_string(),
        );
    }
    warnings
}

fn build_plan_quality(
    matched_sample_count: usize,
    ranges: &[SemanticTemporalEditRange],
    action: &SemanticTemporalEditAction,
) -> SemanticTemporalEditPlanQuality {
    let mut warnings = Vec::new();
    let mut recommended_actions = Vec::new();

    if matched_sample_count == 0 {
        recommended_actions.push(
            "Run describe_clip_frames or search_clip_evidence with a more specific query before planning this edit."
                .to_string(),
        );
        return SemanticTemporalEditPlanQuality {
            status: SemanticTemporalEditQualityStatus::Insufficient,
            score: 0,
            matched_sample_count: 0,
            range_count: 0,
            warnings,
            recommended_actions,
        };
    }

    if matches!(
        action,
        SemanticTemporalEditAction::Blur | SemanticTemporalEditAction::Highlight
    ) {
        if ranges.iter().any(|range| !range.spatial_targets.is_empty()) {
            warnings.push(
                "Spatial masks are drafted from source annotations and need visual review."
                    .to_string(),
            );
            recommended_actions.push(
                "Review mask boxes and add tracking/keyframes before applying object-specific effects."
                    .to_string(),
            );
        } else {
            warnings.push(
                "Spatial mask bounds are not available in current semantic evidence.".to_string(),
            );
            recommended_actions.push(
                "Review the sampled frames and refine mask/tracking before object-specific effects."
                    .to_string(),
            );
        }
    }

    let avg_confidence = average_confidence(
        &ranges
            .iter()
            .flat_map(|range| range.evidence.iter().cloned())
            .collect::<Vec<_>>(),
    );
    let status = if warnings.is_empty() {
        SemanticTemporalEditQualityStatus::Ready
    } else {
        SemanticTemporalEditQualityStatus::Partial
    };
    let score = (avg_confidence * 100.0).round().clamp(0.0, 100.0) as u32;

    SemanticTemporalEditPlanQuality {
        status,
        score,
        matched_sample_count: matched_sample_count as u32,
        range_count: ranges.len() as u32,
        warnings,
        recommended_actions,
    }
}

fn build_plan_summary(
    query: &str,
    action: &SemanticTemporalEditAction,
    ranges: &[SemanticTemporalEditRange],
    quality: &SemanticTemporalEditPlanQuality,
) -> String {
    if ranges.is_empty() {
        return format!("No semantic clip evidence matched \"{query}\".");
    }
    format!(
        "Planned {:?} for \"{}\" across {} range(s), quality {:?} {}.",
        action,
        query,
        ranges.len(),
        quality.status,
        quality.score
    )
}

fn build_plan_id(
    perception_fingerprint: &str,
    query: &str,
    action: &SemanticTemporalEditAction,
    policy: &PlanPolicy,
) -> String {
    let basis = serde_json::json!({
        "perceptionFingerprint": perception_fingerprint,
        "query": query,
        "action": action,
        "paddingSecBits": policy.padding_sec.to_bits(),
        "mergeGapSecBits": policy.merge_gap_sec.to_bits(),
        "minConfidenceBits": policy.min_confidence.to_bits(),
        "maxRanges": policy.max_ranges,
        "text": policy.text,
        "effectStrength": policy.effect_strength,
        "includeCommandDrafts": policy.include_command_drafts,
        "spatialTimeToleranceSecBits": policy.spatial_time_tolerance_sec.to_bits(),
        "includeSpatialTargets": policy.include_spatial_targets,
    });
    format!(
        "semantic_edit_{:016x}",
        stable_hash64(basis.to_string().as_bytes())
    )
}

fn stable_hash64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn round_time(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::clip_perception::{
        ClipPerceptionBundle, ClipPerceptionBundleSource, ClipPerceptionDetail,
        ClipPerceptionOptions, ClipPerceptionQuality, ClipPerceptionQualityStatus,
        ClipSemanticCoverage,
    };
    use crate::core::analysis::types::PerceptionProviderMetadata;
    use crate::core::annotations::{
        AnalysisProvider, AnalysisResult, AssetAnnotation, BoundingBox, ObjectDetection,
    };

    fn observation(
        sample_id: &str,
        timeline_sec: f64,
        description: &str,
        visible_text: Vec<&str>,
    ) -> ClipSemanticObservation {
        ClipSemanticObservation {
            sample_id: sample_id.to_string(),
            timeline_sec,
            source_sec: timeline_sec + 5.0,
            frame_index: Some((timeline_sec * 30.0) as u64),
            image_path: format!("/tmp/{sample_id}.jpg"),
            description: description.to_string(),
            subjects: vec!["presenter".to_string()],
            actions: vec!["pointing".to_string()],
            visible_text: visible_text.into_iter().map(str::to_string).collect(),
            objects: vec!["chart".to_string()],
            setting: Some("studio".to_string()),
            edit_usefulness: Some("Use for product emphasis.".to_string()),
            confidence: 0.9,
            evidence_source: ClipPerceptionEvidenceSource::SourceAnalysis,
            provider: PerceptionProviderMetadata::new("test", "model"),
        }
    }

    fn bundle(observations: Vec<ClipSemanticObservation>) -> ClipPerceptionBundle {
        ClipPerceptionBundle {
            schema_version: 1,
            perception_fingerprint: "perception_test".to_string(),
            clip_fingerprint: "clip_test".to_string(),
            sequence_id: "seq-1".to_string(),
            track_id: "track-1".to_string(),
            clip_id: "clip-1".to_string(),
            asset_id: "asset-1".to_string(),
            source: ClipPerceptionBundleSource::Generated,
            provider: None,
            model: None,
            prompt_version: 1,
            options: ClipPerceptionOptions {
                detail: ClipPerceptionDetail::Low,
                ..ClipPerceptionOptions::default()
            },
            observations,
            quality: ClipPerceptionQuality {
                status: ClipPerceptionQualityStatus::Ready,
                semantic_coverage: ClipSemanticCoverage::SourceReuse,
                matched_observation_count: 1,
                provider_observation_count: 0,
                fallback_observation_count: 0,
                missing_sample_ids: Vec::new(),
                recommended_actions: Vec::new(),
            },
            errors: Vec::new(),
            created_at: "2026-05-29T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn matches_query_against_visible_text() {
        let obs = observation("f0001", 10.0, "Presenter points.", vec!["LOGO"]);

        let matched = match_observation(&obs, "logo", 0.0).unwrap();

        assert_eq!(matched.matched_fields, vec!["visibleText"]);
    }

    #[test]
    fn matches_multi_word_query_by_meaningful_terms() {
        let obs = observation("f0001", 10.0, "Logo visible.", vec!["LOGO"]);

        let matched = match_observation(&obs, "product logo", 0.0).unwrap();

        assert!(matched.matched_fields.contains(&"description".to_string()));
        assert!(matched.matched_fields.contains(&"visibleText".to_string()));
    }

    #[test]
    fn groups_nearby_observations_into_one_range() {
        let matches = vec![
            match_observation(
                &observation("f0001", 10.0, "Logo visible.", vec!["LOGO"]),
                "logo",
                0.0,
            )
            .unwrap(),
            match_observation(
                &observation("f0002", 10.3, "Logo visible.", vec!["LOGO"]),
                "logo",
                0.0,
            )
            .unwrap(),
        ];
        let policy = resolve_plan_policy(SemanticTemporalEditPlanOptions::default());

        let ranges = group_matches_into_ranges(&matches, &policy, 0.0, None);

        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].sample_ids, vec!["f0001", "f0002"]);
        assert!(ranges[0].timeline_start_sec < 10.0);
        assert!(ranges[0].timeline_end_sec > 10.3);
    }

    #[test]
    fn clamps_padded_range_to_clip_start() {
        let matches = vec![match_observation(
            &observation("f0001", 10.0, "Logo visible.", vec!["LOGO"]),
            "logo",
            0.0,
        )
        .unwrap()];
        let policy = resolve_plan_policy(SemanticTemporalEditPlanOptions {
            padding_sec: Some(0.5),
            ..SemanticTemporalEditPlanOptions::default()
        });

        let ranges = group_matches_into_ranges(&matches, &policy, 10.0, Some(20.0));

        assert_eq!(ranges[0].timeline_start_sec, 10.0);
        assert_eq!(ranges[0].timeline_end_sec, 10.5);
    }

    #[test]
    fn blur_draft_marks_isolated_clip_resolution() {
        let matches = vec![match_observation(
            &observation("f0001", 10.0, "Logo visible.", vec!["LOGO"]),
            "logo",
            0.0,
        )
        .unwrap()];
        let policy = resolve_plan_policy(SemanticTemporalEditPlanOptions::default());
        let mut ranges = group_matches_into_ranges(&matches, &policy, 0.0, Some(20.0));
        let range = ranges.first_mut().unwrap();

        range.command_drafts = build_command_drafts(
            range,
            &SemanticTemporalEditAction::Blur,
            CommandDraftClipContext {
                sequence_id: "seq-1",
                track_id: "track-1",
                clip_id: "clip-1",
                clip_start: 0.0,
                clip_end: Some(20.0),
            },
            &policy,
        );

        assert!(range
            .command_drafts
            .iter()
            .any(|draft| draft.command_type == "AddEffect"
                && draft.requires_resolution == vec!["isolatedClipId"]));
    }

    #[test]
    fn spatial_targets_from_annotation_bboxes() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle = bundle(vec![observation(
            "f0001",
            10.0,
            "The product logo is visible.",
            vec!["LOGO"],
        )]);
        let path = temp_dir
            .path()
            .join(".openreelio")
            .join("analysis")
            .join("clips")
            .join("clip_test")
            .join("perception")
            .join("perception_test.json");
        crate::core::fs::atomic_write_json_pretty(&path, &bundle).unwrap();

        let mut annotation = AssetAnnotation::new("asset-1", "hash");
        annotation.set_objects(AnalysisResult::new(
            AnalysisProvider::GoogleCloud,
            vec![
                ObjectDetection::new(15.0, vec!["product logo".to_string()], 0.95)
                    .with_bounding_box(BoundingBox::new(0.1, 0.2, 0.3, 0.4)),
            ],
        ));
        AnnotationStore::new(temp_dir.path())
            .save(&annotation)
            .unwrap();

        let plan = plan_semantic_clip_edit(
            temp_dir.path(),
            "perception_test",
            "logo",
            SemanticTemporalEditAction::Blur,
            SemanticTemporalEditPlanOptions::default(),
        )
        .unwrap();

        let range = &plan.ranges[0];
        assert_eq!(range.spatial_targets.len(), 1);
        assert_eq!(range.spatial_targets[0].label, "product logo");
        assert!(range
            .command_drafts
            .iter()
            .any(|draft| draft.command_type == "AddMask"
                && draft.requires_resolution.contains(&"effectId".to_string())));
        assert!(range
            .warnings
            .iter()
            .any(|warning| warning.contains("Spatial annotation boxes are available")));
    }

    #[test]
    fn spatial_targets_match_multi_word_query_terms() {
        let matches = vec![match_observation(
            &observation("f0001", 10.0, "The product logo is visible.", vec!["LOGO"]),
            "product logo",
            0.0,
        )
        .unwrap()];
        let policy = resolve_plan_policy(SemanticTemporalEditPlanOptions::default());
        let mut ranges = group_matches_into_ranges(&matches, &policy, 0.0, Some(20.0));
        let mut annotation = AssetAnnotation::new("asset-1", "hash");
        annotation.set_objects(AnalysisResult::new(
            AnalysisProvider::GoogleCloud,
            vec![ObjectDetection::new(15.0, vec!["logo".to_string()], 0.95)
                .with_bounding_box(BoundingBox::new(0.1, 0.2, 0.3, 0.4))],
        ));

        ranges[0].spatial_targets =
            spatial_targets_for_range(&ranges[0], &annotation, "product logo", &policy);

        assert_eq!(ranges[0].spatial_targets.len(), 1);
        assert_eq!(ranges[0].spatial_targets[0].label, "logo");
    }

    #[test]
    fn highlight_strength_is_clamped_to_brightness_range() {
        let matches = vec![match_observation(
            &observation("f0001", 10.0, "Logo visible.", vec!["LOGO"]),
            "logo",
            0.0,
        )
        .unwrap()];
        let policy = resolve_plan_policy(SemanticTemporalEditPlanOptions {
            effect_strength: Some(20.0),
            ..SemanticTemporalEditPlanOptions::default()
        });
        let mut ranges = group_matches_into_ranges(&matches, &policy, 0.0, Some(20.0));

        ranges[0].command_drafts = build_command_drafts(
            &ranges[0],
            &SemanticTemporalEditAction::Highlight,
            CommandDraftClipContext {
                sequence_id: "seq-1",
                track_id: "track-1",
                clip_id: "clip-1",
                clip_start: 0.0,
                clip_end: Some(20.0),
            },
            &policy,
        );

        let add_effect = ranges[0]
            .command_drafts
            .iter()
            .find(|draft| draft.command_type == "AddEffect")
            .unwrap();
        assert_eq!(
            add_effect.payload["params"]["value"],
            serde_json::json!(1.0)
        );
    }

    #[test]
    fn plan_id_changes_when_spatial_options_change() {
        let mut options = SemanticTemporalEditPlanOptions::default();
        let base = build_plan_id(
            "perception_test",
            "logo",
            &SemanticTemporalEditAction::Blur,
            &resolve_plan_policy(options.clone()),
        );

        options.include_spatial_targets = false;
        let changed = build_plan_id(
            "perception_test",
            "logo",
            &SemanticTemporalEditAction::Blur,
            &resolve_plan_policy(options),
        );

        assert_ne!(base, changed);
    }

    #[test]
    fn no_match_quality_is_insufficient() {
        let quality = build_plan_quality(0, &[], &SemanticTemporalEditAction::Marker);

        assert_eq!(
            quality.status,
            SemanticTemporalEditQualityStatus::Insufficient
        );
        assert_eq!(quality.score, 0);
        assert!(!quality.recommended_actions.is_empty());
    }

    #[test]
    fn saves_bundle_and_plans_from_cache() {
        let temp_dir = tempfile::tempdir().unwrap();
        let bundle = bundle(vec![observation(
            "f0001",
            10.0,
            "The product logo is visible.",
            vec!["LOGO"],
        )]);
        let path = temp_dir
            .path()
            .join(".openreelio")
            .join("analysis")
            .join("clips")
            .join("clip_test")
            .join("perception")
            .join("perception_test.json");
        crate::core::fs::atomic_write_json_pretty(&path, &bundle).unwrap();

        let plan = plan_semantic_clip_edit(
            temp_dir.path(),
            "perception_test",
            "logo",
            SemanticTemporalEditAction::Marker,
            SemanticTemporalEditPlanOptions::default(),
        )
        .unwrap();

        assert_eq!(plan.ranges.len(), 1);
        assert_eq!(
            plan.quality.status,
            SemanticTemporalEditQualityStatus::Ready
        );
        assert_eq!(plan.ranges[0].command_drafts[0].command_type, "AddMarker");
    }
}
