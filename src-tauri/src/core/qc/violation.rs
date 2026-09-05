//! QC Violation Types
//!
//! Defines violations, severity levels, and auto-fix suggestions.

use serde::{Deserialize, Serialize};

/// Time range for locating violations
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeRange {
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
}

impl TimeRange {
    /// Creates a new time range
    pub fn new(start_sec: f64, end_sec: f64) -> Self {
        Self { start_sec, end_sec }
    }

    /// Duration of this range in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Check if this range contains a specific time
    pub fn contains(&self, time_sec: f64) -> bool {
        time_sec >= self.start_sec && time_sec <= self.end_sec
    }

    /// Check if this range overlaps with another
    pub fn overlaps(&self, other: &TimeRange) -> bool {
        self.start_sec < other.end_sec && self.end_sec > other.start_sec
    }

    /// Merge two overlapping ranges
    pub fn merge(&self, other: &TimeRange) -> Option<TimeRange> {
        if self.overlaps(other) {
            Some(TimeRange::new(
                self.start_sec.min(other.start_sec),
                self.end_sec.max(other.end_sec),
            ))
        } else {
            None
        }
    }
}

/// Returns how much time a set of `(start, end)` spans covers in total.
///
/// Overlapping spans are merged first, so a signal reported twice — once per
/// detector, or once per violation — cannot inflate the coverage past the
/// program it is measured against. Degenerate and non-finite spans are ignored.
///
/// This is the shared basis for every "how much of the program is X" grade
/// (black, frozen), which must be answered for the program as a whole rather
/// than one span at a time.
pub fn merged_span_duration_sec(spans: &[(f64, f64)]) -> f64 {
    let mut usable: Vec<(f64, f64)> = spans
        .iter()
        .copied()
        .filter(|(start, end)| start.is_finite() && end.is_finite() && end > start)
        .collect();

    usable.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut total = 0.0;
    let mut current: Option<(f64, f64)> = None;

    for (start, end) in usable {
        match current {
            Some((open_start, open_end)) if start <= open_end => {
                current = Some((open_start, open_end.max(end)));
            }
            Some((open_start, open_end)) => {
                total += open_end - open_start;
                current = Some((start, end));
            }
            None => current = Some((start, end)),
        }
    }

    if let Some((open_start, open_end)) = current {
        total += open_end - open_start;
    }

    total
}

/// Severity level of a QC violation
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Informational - suggestion for improvement
    Info,
    /// Warning - potential issue, review recommended
    Warning,
    /// Error - definite issue that should be fixed
    Error,
    /// Critical - blocking issue that must be fixed
    Critical,
}

impl Severity {
    /// Convert to numeric level for comparison
    pub fn level(&self) -> u8 {
        match self {
            Severity::Info => 0,
            Severity::Warning => 1,
            Severity::Error => 2,
            Severity::Critical => 3,
        }
    }

    /// Check if this severity meets or exceeds a threshold
    pub fn meets_threshold(&self, threshold: Severity) -> bool {
        self.level() >= threshold.level()
    }
}

impl std::fmt::Display for Severity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Severity::Info => write!(f, "INFO"),
            Severity::Warning => write!(f, "WARNING"),
            Severity::Error => write!(f, "ERROR"),
            Severity::Critical => write!(f, "CRITICAL"),
        }
    }
}

/// Suggested fix for a violation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViolationFix {
    /// Description of the fix
    pub description: String,
    /// Commands to execute (as JSON, maps to EditScript commands)
    pub commands: Vec<serde_json::Value>,
    /// Estimated confidence that this fix is correct (0.0 - 1.0)
    pub confidence: f32,
}

impl ViolationFix {
    /// Creates a new fix suggestion
    pub fn new(description: impl Into<String>, commands: Vec<serde_json::Value>) -> Self {
        Self {
            description: description.into(),
            commands,
            confidence: 0.8,
        }
    }

    /// Sets the confidence level
    pub fn with_confidence(mut self, confidence: f32) -> Self {
        self.confidence = confidence.clamp(0.0, 1.0);
        self
    }
}

/// A QC violation found during checking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QCViolation {
    /// Unique violation ID
    pub id: String,
    /// Name of the rule that found this violation
    pub rule_name: String,
    /// Severity level
    pub severity: Severity,
    /// Location in the timeline
    pub location: Option<TimeRange>,
    /// Human-readable message explaining the issue
    pub message: String,
    /// Detailed description (optional)
    pub details: Option<String>,
    /// Affected entity IDs (clip_id, track_id, etc.)
    pub affected_entities: Vec<String>,
    /// Machine-readable measurements behind this violation
    ///
    /// Keeps numbers out of prose: an agent reading the report can act on
    /// `{"gapSec": 1.5}` without parsing [`QCViolation::message`].
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub metrics: std::collections::BTreeMap<String, serde_json::Value>,
    /// Whether this violation can be automatically fixed
    pub auto_fixable: bool,
    /// Suggested fix (if available)
    pub suggested_fix: Option<ViolationFix>,
}

impl QCViolation {
    /// Creates a new violation
    pub fn new(
        rule_name: impl Into<String>,
        severity: Severity,
        message: impl Into<String>,
    ) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            rule_name: rule_name.into(),
            severity,
            location: None,
            message: message.into(),
            details: None,
            affected_entities: Vec::new(),
            metrics: std::collections::BTreeMap::new(),
            auto_fixable: false,
            suggested_fix: None,
        }
    }

    /// Sets the time range location
    pub fn with_location(mut self, start_sec: f64, end_sec: f64) -> Self {
        self.location = Some(TimeRange::new(start_sec, end_sec));
        self
    }

    /// Sets detailed description
    pub fn with_details(mut self, details: impl Into<String>) -> Self {
        self.details = Some(details.into());
        self
    }

    /// Adds affected entity IDs
    pub fn with_entities(mut self, entities: Vec<String>) -> Self {
        self.affected_entities = entities;
        self
    }

    /// Adds a single machine-readable metric
    pub fn with_metric(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        self.metrics.insert(key.into(), value.into());
        self
    }

    /// Sets the suggested fix
    pub fn with_fix(mut self, fix: ViolationFix) -> Self {
        self.auto_fixable = true;
        self.suggested_fix = Some(fix);
        self
    }

    /// Overrides whether the attached fix finishes the job on its own.
    ///
    /// [`with_fix`](Self::with_fix) assumes it does, which is true of every fix
    /// that only changes a setting. It is not true of a fix that *proposes*
    /// something — re-worded caption text, a line split at a guessed word
    /// boundary — and a report claiming otherwise sends an agent to apply an
    /// edit nobody agreed to. Call this after `with_fix`; on a violation with
    /// no fix, `true` is ignored, because a violation cannot be automatically
    /// fixed by commands it does not carry.
    pub fn with_auto_fixable(mut self, auto_fixable: bool) -> Self {
        self.auto_fixable = auto_fixable && self.suggested_fix.is_some();
        self
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // Span coverage
    // ========================================================================

    #[test]
    fn test_merged_span_duration_should_sum_disjoint_spans() {
        let total = merged_span_duration_sec(&[(0.0, 2.0), (4.0, 6.0), (8.0, 10.0)]);

        assert!((total - 6.0).abs() < 1e-9);
    }

    #[test]
    fn test_merged_span_duration_should_count_overlapping_spans_once() {
        let total = merged_span_duration_sec(&[(0.0, 5.0), (3.0, 8.0), (7.5, 9.0)]);

        assert!((total - 9.0).abs() < 1e-9, "got {total}");
    }

    #[test]
    fn test_merged_span_duration_should_ignore_degenerate_spans() {
        let total = merged_span_duration_sec(&[
            (5.0, 5.0),
            (6.0, 4.0),
            (f64::NAN, 3.0),
            (1.0, f64::INFINITY),
            (0.0, 1.0),
        ]);

        assert!((total - 1.0).abs() < 1e-9, "got {total}");
    }

    // ========================================================================
    // TimeRange Tests
    // ========================================================================

    #[test]
    fn test_time_range_creation() {
        let range = TimeRange::new(5.0, 15.0);
        assert_eq!(range.start_sec, 5.0);
        assert_eq!(range.end_sec, 15.0);
    }

    #[test]
    fn test_time_range_duration() {
        let range = TimeRange::new(5.0, 15.0);
        assert_eq!(range.duration(), 10.0);
    }

    #[test]
    fn test_time_range_contains() {
        let range = TimeRange::new(5.0, 15.0);

        assert!(!range.contains(4.9));
        assert!(range.contains(5.0));
        assert!(range.contains(10.0));
        assert!(range.contains(15.0));
        assert!(!range.contains(15.1));
    }

    #[test]
    fn test_time_range_overlaps() {
        let range1 = TimeRange::new(5.0, 15.0);
        let range2 = TimeRange::new(10.0, 20.0);
        let range3 = TimeRange::new(16.0, 25.0);

        assert!(range1.overlaps(&range2));
        assert!(range2.overlaps(&range1));
        assert!(!range1.overlaps(&range3));
        assert!(range2.overlaps(&range3));
    }

    #[test]
    fn test_time_range_merge() {
        let range1 = TimeRange::new(5.0, 15.0);
        let range2 = TimeRange::new(10.0, 20.0);
        let range3 = TimeRange::new(25.0, 30.0);

        let merged = range1.merge(&range2);
        assert!(merged.is_some());
        let merged = merged.unwrap();
        assert_eq!(merged.start_sec, 5.0);
        assert_eq!(merged.end_sec, 20.0);

        assert!(range1.merge(&range3).is_none());
    }

    // ========================================================================
    // Severity Tests
    // ========================================================================

    #[test]
    fn test_severity_ordering() {
        assert!(Severity::Info < Severity::Warning);
        assert!(Severity::Warning < Severity::Error);
        assert!(Severity::Error < Severity::Critical);
    }

    #[test]
    fn test_severity_level() {
        assert_eq!(Severity::Info.level(), 0);
        assert_eq!(Severity::Warning.level(), 1);
        assert_eq!(Severity::Error.level(), 2);
        assert_eq!(Severity::Critical.level(), 3);
    }

    #[test]
    fn test_severity_meets_threshold() {
        assert!(Severity::Error.meets_threshold(Severity::Warning));
        assert!(Severity::Error.meets_threshold(Severity::Error));
        assert!(!Severity::Warning.meets_threshold(Severity::Error));
    }

    #[test]
    fn test_severity_display() {
        assert_eq!(Severity::Info.to_string(), "INFO");
        assert_eq!(Severity::Warning.to_string(), "WARNING");
        assert_eq!(Severity::Error.to_string(), "ERROR");
        assert_eq!(Severity::Critical.to_string(), "CRITICAL");
    }

    #[test]
    fn test_severity_serialization() {
        assert_eq!(
            serde_json::to_string(&Severity::Error).unwrap(),
            "\"error\""
        );
        assert_eq!(
            serde_json::from_str::<Severity>("\"warning\"").unwrap(),
            Severity::Warning
        );
    }

    // ========================================================================
    // ViolationFix Tests
    // ========================================================================

    #[test]
    fn test_violation_fix_creation() {
        let fix = ViolationFix::new("Trim black frames", vec![]);
        assert_eq!(fix.description, "Trim black frames");
        assert_eq!(fix.confidence, 0.8);
    }

    #[test]
    fn test_violation_fix_with_confidence() {
        let fix = ViolationFix::new("Add transition", vec![]).with_confidence(0.95);
        assert_eq!(fix.confidence, 0.95);
    }

    #[test]
    fn test_violation_fix_confidence_clamped() {
        let fix1 = ViolationFix::new("Fix", vec![]).with_confidence(1.5);
        assert_eq!(fix1.confidence, 1.0);

        let fix2 = ViolationFix::new("Fix", vec![]).with_confidence(-0.5);
        assert_eq!(fix2.confidence, 0.0);
    }

    // ========================================================================
    // QCViolation Tests
    // ========================================================================

    #[test]
    fn test_violation_creation() {
        let violation = QCViolation::new(
            "BlackFrameRule",
            Severity::Warning,
            "Black frame detected at start",
        );

        assert!(!violation.id.is_empty());
        assert_eq!(violation.rule_name, "BlackFrameRule");
        assert_eq!(violation.severity, Severity::Warning);
        assert_eq!(violation.message, "Black frame detected at start");
        assert!(!violation.auto_fixable);
    }

    #[test]
    fn test_violation_with_location() {
        let violation =
            QCViolation::new("TestRule", Severity::Error, "Issue found").with_location(10.0, 15.0);

        let loc = violation.location.unwrap();
        assert_eq!(loc.start_sec, 10.0);
        assert_eq!(loc.end_sec, 15.0);
    }

    #[test]
    fn test_violation_with_details() {
        let violation = QCViolation::new("TestRule", Severity::Info, "Issue")
            .with_details("More detailed explanation");

        assert_eq!(violation.details.unwrap(), "More detailed explanation");
    }

    #[test]
    fn test_violation_with_entities() {
        let violation = QCViolation::new("TestRule", Severity::Warning, "Issue")
            .with_entities(vec!["clip_001".to_string(), "clip_002".to_string()]);

        assert_eq!(violation.affected_entities.len(), 2);
        assert!(violation
            .affected_entities
            .contains(&"clip_001".to_string()));
    }

    #[test]
    fn test_violation_with_fix() {
        let fix = ViolationFix::new(
            "Remove black frames",
            vec![serde_json::json!({"type": "TrimClip", "clipId": "clip_001", "newStart": 0.5})],
        );

        let violation =
            QCViolation::new("BlackFrameRule", Severity::Warning, "Black frames").with_fix(fix);

        assert!(violation.auto_fixable);
        assert!(violation.suggested_fix.is_some());
    }

    #[test]
    fn test_violation_fix_can_be_marked_as_a_proposal() {
        let violation = QCViolation::new("TestRule", Severity::Warning, "Issue")
            .with_fix(ViolationFix::new("Split the line", vec![]))
            .with_auto_fixable(false);

        assert!(!violation.auto_fixable);
        assert!(
            violation.suggested_fix.is_some(),
            "a proposal is still worth showing"
        );
    }

    #[test]
    fn test_violation_cannot_claim_auto_fixability_without_a_fix() {
        let violation =
            QCViolation::new("TestRule", Severity::Warning, "Issue").with_auto_fixable(true);

        assert!(!violation.auto_fixable);
    }

    #[test]
    fn test_violation_serialization() {
        let violation = QCViolation::new("TestRule", Severity::Error, "Test message")
            .with_location(0.0, 5.0)
            .with_entities(vec!["clip_001".to_string()]);

        let json = serde_json::to_string(&violation).unwrap();
        let parsed: QCViolation = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.rule_name, "TestRule");
        assert_eq!(parsed.severity, Severity::Error);
        assert!(parsed.location.is_some());
    }
}
