//! Grouping for caption findings that repeat across a whole track.
//!
//! Caption checks are per-cue by nature, and a machine transcript produces
//! hundreds of cues that share one defect: every line of a talk anchored two
//! percent too low is one mistake, not forty-one. Reported one violation at a
//! time, each carrying a one-step fix, the report told an agent to run the
//! whole verify → fix → verify loop forty-one times to repair a single wrong
//! setting — and `autoFixable: true` on every one of them was a promise the
//! report could not keep.
//!
//! This module is the other shape: one violation per track, listing every cue
//! it covers, whose `suggestedFix` is a plan that repairs all of them at once.
//! `autoFixable` then means what it says — the steps here finish the job.
//!
//! # Why the cap
//!
//! A fix is executed as a single plan, and a plan of thousands of steps is one
//! all-or-nothing transaction whose failure says nothing about which cue broke
//! it. Beyond [`MAX_FIX_STEPS`] the findings are split across several
//! violations, each with a plan of its own, and each says which part it is.

use serde_json::{Map, Value};

use super::violation::{QCViolation, Severity, TimeRange, ViolationFix};

/// Most command steps one suggested fix will carry.
pub(crate) const MAX_FIX_STEPS: usize = 200;

/// One offending cue, before it is grouped with the others like it.
#[derive(Debug, Clone)]
pub(crate) struct CaptionFinding {
    /// Caption clip the finding is about
    pub clip_id: String,
    /// First timeline second of the cue
    pub start_sec: f64,
    /// Timeline second the cue ends on
    pub end_sec: f64,
    /// Machine-readable numbers behind this cue's finding
    pub metrics: Map<String, Value>,
    /// Commands that repair this cue, in order
    pub commands: Vec<Value>,
    /// Whether [`commands`](Self::commands) alone leave the cue correct
    ///
    /// False for a repair that only proposes something — a re-worded caption, a
    /// split line — which a human or a model still has to accept. The grouped
    /// violation is only `autoFixable` when every cue in it says true.
    pub resolved_by_commands: bool,
}

impl CaptionFinding {
    /// Builds a finding with no metrics and no fix.
    pub(crate) fn new(clip_id: impl Into<String>, start_sec: f64, end_sec: f64) -> Self {
        Self {
            clip_id: clip_id.into(),
            start_sec,
            end_sec,
            metrics: Map::new(),
            commands: Vec::new(),
            resolved_by_commands: false,
        }
    }

    /// Adds one machine-readable metric for this cue.
    pub(crate) fn with_metric(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.metrics.insert(key.to_string(), value.into());
        self
    }

    /// Attaches the commands that repair this cue.
    pub(crate) fn with_commands(mut self, commands: Vec<Value>, resolved: bool) -> Self {
        self.commands = commands;
        self.resolved_by_commands = resolved;
        self
    }

    /// This cue as it appears in the grouped violation's `cues` metric.
    fn as_metric(&self) -> Value {
        let mut entry = self.metrics.clone();
        entry.insert("clipId".to_string(), Value::from(self.clip_id.clone()));
        entry.insert(
            "startSec".to_string(),
            Value::from(round_sec(self.start_sec)),
        );
        entry.insert("endSec".to_string(), Value::from(round_sec(self.end_sec)));
        Value::Object(entry)
    }
}

/// Everything a group of findings shares.
pub(crate) struct CaptionGroup<'a> {
    /// Rule reporting the group
    pub rule_name: &'a str,
    /// Severity every cue in the group was graded at
    pub severity: Severity,
    /// Track the cues sit on — the grouping key
    pub track_id: &'a str,
    /// Prose shown under the message
    pub details: String,
    /// What the grouped fix does, in one line
    pub fix_description: String,
    /// Confidence carried by the grouped fix
    pub confidence: f32,
}

/// Rounds a time to milliseconds, so a metric reads as a time and not as float noise.
fn round_sec(value: f64) -> f64 {
    if value.is_finite() {
        (value * 1000.0).round() / 1000.0
    } else {
        0.0
    }
}

/// Groups per-cue findings into one violation per track, splitting at the cap.
///
/// `message` is handed the number of cues in the violation being built, because
/// a split group has to say how many cues *this* violation covers rather than
/// how many the track has.
///
/// Findings with no commands are still grouped and still listed: a check that
/// can describe a problem it cannot repair must say so, and dropping those cues
/// would make the report claim fewer problems than it found.
pub(crate) fn group_caption_findings(
    group: CaptionGroup<'_>,
    findings: Vec<CaptionFinding>,
    message: impl Fn(usize) -> String,
) -> Vec<QCViolation> {
    if findings.is_empty() {
        return Vec::new();
    }

    let chunks = split_at_step_cap(findings);
    let part_count = chunks.len();

    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| build_violation(&group, chunk, &message, index + 1, part_count))
        .collect()
}

/// Splits findings so no chunk's commands exceed [`MAX_FIX_STEPS`].
///
/// A single finding whose own commands exceed the cap still forms one chunk:
/// splitting a cue's repair in half would emit a plan that leaves it in a state
/// neither half describes.
fn split_at_step_cap(findings: Vec<CaptionFinding>) -> Vec<Vec<CaptionFinding>> {
    let mut chunks: Vec<Vec<CaptionFinding>> = Vec::new();
    let mut current: Vec<CaptionFinding> = Vec::new();
    let mut steps = 0usize;

    for finding in findings {
        let cost = finding.commands.len();
        if !current.is_empty() && steps + cost > MAX_FIX_STEPS {
            chunks.push(std::mem::take(&mut current));
            steps = 0;
        }
        steps += cost;
        current.push(finding);
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

/// Builds one grouped violation from a chunk of findings.
fn build_violation(
    group: &CaptionGroup<'_>,
    findings: Vec<CaptionFinding>,
    message: &impl Fn(usize) -> String,
    part: usize,
    part_count: usize,
) -> QCViolation {
    let start_sec = findings
        .iter()
        .map(|finding| finding.start_sec)
        .fold(f64::INFINITY, f64::min);
    let end_sec = findings
        .iter()
        .map(|finding| finding.end_sec)
        .fold(f64::NEG_INFINITY, f64::max);

    let commands: Vec<Value> = findings
        .iter()
        .flat_map(|finding| finding.commands.iter().cloned())
        .collect();
    // A group is only auto-fixable when its steps finish the job for every cue
    // in it. One cue that merely proposes something makes the whole group a
    // suggestion to read.
    let resolved = !commands.is_empty()
        && findings
            .iter()
            .all(|finding| finding.commands.is_empty() || finding.resolved_by_commands)
        && findings.iter().all(|finding| !finding.commands.is_empty());

    let cues: Vec<Value> = findings.iter().map(CaptionFinding::as_metric).collect();
    // The violation's own `timeRange` spans the first cue to the last, which is
    // the whole track for a defect that repeats across it — a range no agent
    // can usefully extract a frame from. The individual windows are what an
    // inspection loop needs, so they are published beside it under the name the
    // frame samplers already take.
    let time_ranges: Vec<Value> = findings
        .iter()
        .map(|finding| {
            serde_json::json!({
                "startSec": round_sec(finding.start_sec),
                "endSec": round_sec(finding.end_sec),
            })
        })
        .collect();
    let entities: Vec<String> = findings
        .iter()
        .map(|finding| finding.clip_id.clone())
        .collect();

    let mut violation = QCViolation::new(group.rule_name, group.severity, message(findings.len()))
        .with_entities(entities)
        .with_details(group.details.clone())
        .with_metric("cueCount", findings.len())
        .with_metric("trackId", group.track_id.to_string())
        .with_metric("timeRanges", Value::Array(time_ranges))
        .with_metric("cues", Value::Array(cues));

    if start_sec.is_finite() && end_sec.is_finite() {
        violation.location = Some(TimeRange::new(start_sec, end_sec));
    }

    if part_count > 1 {
        violation = violation
            .with_metric("part", part)
            .with_metric("partCount", part_count);
    }

    if !commands.is_empty() {
        violation = violation
            .with_fix(
                ViolationFix::new(group.fix_description.clone(), commands)
                    .with_confidence(group.confidence),
            )
            // `with_fix` assumes a fix finishes the job; here it may only
            // propose one, and a report that overstates that is worse than one
            // that carries no fix at all.
            .with_auto_fixable(resolved);
    }

    violation
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(index: usize, commands: usize, resolved: bool) -> CaptionFinding {
        let start = index as f64;
        CaptionFinding::new(format!("clip_{index}"), start, start + 1.0)
            .with_metric("index", index)
            .with_commands(
                (0..commands)
                    .map(|step| serde_json::json!({ "type": "UpdateCaption", "step": step }))
                    .collect(),
                resolved,
            )
    }

    fn group() -> CaptionGroup<'static> {
        CaptionGroup {
            rule_name: "TestRule",
            severity: Severity::Warning,
            track_id: "track_1",
            details: "details".to_string(),
            fix_description: "fix them all".to_string(),
            confidence: 0.9,
        }
    }

    /// Feature: Grouped caption findings
    /// Scenario: should report one violation covering every offending cue
    #[test]
    fn should_group_every_cue_into_one_violation() {
        let findings = (0..41).map(|index| finding(index, 1, true)).collect();

        let violations = group_caption_findings(group(), findings, |count| {
            format!("{count} caption(s) need moving")
        });

        assert_eq!(violations.len(), 1);
        let violation = &violations[0];
        assert_eq!(violation.message, "41 caption(s) need moving");
        assert_eq!(violation.affected_entities.len(), 41);
        assert_eq!(violation.metrics["cueCount"], 41);
        assert_eq!(
            violation.metrics["cues"]
                .as_array()
                .expect("cues is a list")
                .len(),
            41
        );
        let fix = violation.suggested_fix.as_ref().expect("a grouped fix");
        assert_eq!(fix.commands.len(), 41, "one step per offending cue");
        assert!(violation.auto_fixable);
        let location = violation.location.as_ref().expect("a span");
        assert_eq!(location.start_sec, 0.0);
        assert_eq!(location.end_sec, 41.0);
    }

    /// Feature: Grouped caption findings
    /// Scenario: should publish the window of every cue, not just the span
    ///
    /// The violation's own `timeRange` covers the first cue to the last, which
    /// for a defect repeating across a track is the whole track — nothing an
    /// agent can extract a useful frame from. The per-cue windows go beside it.
    #[test]
    fn should_publish_a_window_for_every_cue_beside_the_grouped_span() {
        let findings = (0..3).map(|index| finding(index, 1, true)).collect();

        let violations = group_caption_findings(group(), findings, |count| format!("{count} cues"));

        let violation = &violations[0];
        let location = violation.location.as_ref().expect("a span");
        assert_eq!((location.start_sec, location.end_sec), (0.0, 3.0));

        let ranges = violation.metrics["timeRanges"]
            .as_array()
            .expect("timeRanges is a list");
        assert_eq!(ranges.len(), 3, "one window per cue: {ranges:?}");
        assert_eq!(
            ranges[1],
            serde_json::json!({ "startSec": 1.0, "endSec": 2.0 })
        );
    }

    /// Feature: Grouped caption findings
    /// Scenario: should split a group whose plan would exceed the step cap
    #[test]
    fn should_split_when_the_plan_would_exceed_the_cap() {
        let findings = (0..MAX_FIX_STEPS + 10)
            .map(|index| finding(index, 1, true))
            .collect();

        let violations = group_caption_findings(group(), findings, |count| format!("{count} cues"));

        assert_eq!(violations.len(), 2);
        for violation in &violations {
            let fix = violation.suggested_fix.as_ref().expect("a fix");
            assert!(
                fix.commands.len() <= MAX_FIX_STEPS,
                "a plan must stay under the cap, got {}",
                fix.commands.len()
            );
            assert_eq!(violation.metrics["partCount"], 2);
        }
        assert_eq!(violations[0].metrics["part"], 1);
        assert_eq!(violations[1].metrics["part"], 2);
    }

    /// Feature: Honest auto-fixability
    /// Scenario: should not claim a group is auto-fixable when one cue is only
    /// a proposal
    #[test]
    fn should_not_claim_auto_fixable_when_one_cue_is_a_proposal() {
        let findings = vec![finding(0, 1, true), finding(1, 2, false)];

        let violations = group_caption_findings(group(), findings, |count| format!("{count} cues"));

        assert_eq!(violations.len(), 1);
        assert!(violations[0].suggested_fix.is_some());
        assert!(
            !violations[0].auto_fixable,
            "a group containing a proposal is not automatically fixable"
        );
    }

    /// Feature: Honest auto-fixability
    /// Scenario: should carry no fix when nothing can be repaired
    #[test]
    fn should_carry_no_fix_when_no_cue_has_commands() {
        let findings = vec![finding(0, 0, false), finding(1, 0, false)];

        let violations = group_caption_findings(group(), findings, |count| format!("{count} cues"));

        assert_eq!(violations.len(), 1);
        assert!(violations[0].suggested_fix.is_none());
        assert!(!violations[0].auto_fixable);
        assert_eq!(violations[0].metrics["cueCount"], 2);
    }

    /// Feature: Grouped caption findings
    /// Scenario: should report nothing for an empty group
    #[test]
    fn should_report_nothing_without_findings() {
        assert!(group_caption_findings(group(), Vec::new(), |count| format!("{count}")).is_empty());
    }
}
