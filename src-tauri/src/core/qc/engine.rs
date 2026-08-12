//! QC Engine
//!
//! Main engine for running QC rules and managing results.
//! Supports batch checking, severity filtering, and auto-fix coordination.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::context::{QCContext, RenderMeasurements};
use super::rules::{
    AspectRatioRule, AudioLoudnessRule, AudioPeakRule, BlackFrameRule, CaptionSafeAreaRule,
    CheckCategory, CutRhythmRule, DurationRule, LicenseRule, QCRule, RuleConfig,
};
use super::structural::{
    CaptionOutOfBoundsRule, CaptionOverlapRule, CaptionReadingRateRule, ClipOrphanRule,
    MissingAssetRule, ShotLengthStatsRule, SilentClipRule, TimelineGapRule,
};
use super::violation::{QCViolation, Severity, ViolationFix};
use crate::core::project::ProjectState;
use crate::core::timeline::Sequence;
use crate::core::{CoreError, CoreResult};

/// QC severity filter for selecting which violations to report
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum QCSeverityFilter {
    /// All violations
    #[default]
    All,
    /// Only warnings and above
    WarningAndAbove,
    /// Only errors and above
    ErrorAndAbove,
    /// Only critical
    CriticalOnly,
}

impl QCSeverityFilter {
    /// Get the minimum severity for this filter
    pub fn min_severity(&self) -> Severity {
        match self {
            QCSeverityFilter::All => Severity::Info,
            QCSeverityFilter::WarningAndAbove => Severity::Warning,
            QCSeverityFilter::ErrorAndAbove => Severity::Error,
            QCSeverityFilter::CriticalOnly => Severity::Critical,
        }
    }

    /// Check if a severity passes this filter
    pub fn passes(&self, severity: Severity) -> bool {
        severity.meets_threshold(self.min_severity())
    }
}

/// Configuration for the QC engine
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QCEngineConfig {
    /// Severity filter for reporting
    pub severity_filter: QCSeverityFilter,
    /// Whether to stop on first critical violation
    pub stop_on_critical: bool,
    /// Rule-specific configurations (rule_name -> config)
    pub rule_configs: HashMap<String, RuleConfig>,
    /// Rules to skip entirely
    pub disabled_rules: Vec<String>,
}

impl QCEngineConfig {
    /// Creates a strict config that stops on critical issues
    pub fn strict() -> Self {
        Self {
            severity_filter: QCSeverityFilter::WarningAndAbove,
            stop_on_critical: true,
            ..Default::default()
        }
    }

    /// Creates a config for quick checks (errors only)
    pub fn quick() -> Self {
        Self {
            severity_filter: QCSeverityFilter::ErrorAndAbove,
            stop_on_critical: false,
            ..Default::default()
        }
    }

    /// Gets the config for a specific rule
    pub fn get_rule_config(&self, rule_name: &str) -> RuleConfig {
        self.rule_configs
            .get(rule_name)
            .cloned()
            .unwrap_or_default()
    }

    /// Sets the config for a specific rule
    pub fn set_rule_config(&mut self, rule_name: &str, config: RuleConfig) {
        self.rule_configs.insert(rule_name.to_string(), config);
    }

    /// Disables a rule
    pub fn disable_rule(&mut self, rule_name: &str) {
        if !self.disabled_rules.contains(&rule_name.to_string()) {
            self.disabled_rules.push(rule_name.to_string());
        }
    }

    /// Enables a previously disabled rule
    pub fn enable_rule(&mut self, rule_name: &str) {
        self.disabled_rules.retain(|r| r != rule_name);
    }

    /// Checks if a rule is enabled
    pub fn is_rule_enabled(&self, rule_name: &str) -> bool {
        !self.disabled_rules.contains(&rule_name.to_string())
    }
}

/// A rule that returned an error instead of a result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFailure {
    /// Name of the rule that failed
    pub rule_name: String,
    /// Error reported by the rule
    pub message: String,
}

/// What happened to a single rule during a check run
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleStatus {
    /// The rule ran to completion
    Ran,
    /// The rule was disabled or could not run against this context
    Skipped,
    /// The rule returned an error
    Errored,
}

/// Per-rule record of a check run
///
/// The violation list alone cannot distinguish "this check passed" from "this
/// check never ran", which is exactly the distinction an agent acting on the
/// report needs. One outcome is recorded for every registered rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleOutcome {
    /// Rule type name
    pub rule_name: String,
    /// Stable dotted check ID
    pub check_id: String,
    /// What the rule inspects
    pub category: CheckCategory,
    /// Whether the rule ran, was skipped, or failed
    pub status: RuleStatus,
    /// Why the rule was skipped, or the error it returned
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// QC check report
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QCReport {
    /// Sequence that was checked
    pub sequence_id: String,
    /// Timestamp of the check
    pub checked_at: chrono::DateTime<chrono::Utc>,
    /// Duration of the check in milliseconds
    pub duration_ms: u64,
    /// All violations found
    pub violations: Vec<QCViolation>,
    /// Count by severity
    pub severity_counts: HashMap<String, usize>,
    /// Rules that were skipped, either by configuration or for missing inputs
    pub skipped_rules: Vec<String>,
    /// Rules that failed to run
    ///
    /// A failed rule leaves part of the sequence unchecked, so the report can
    /// never be reported as passing while this list is non-empty.
    #[serde(default)]
    pub errored_rules: Vec<RuleFailure>,
    /// One record per registered rule, in registration order
    ///
    /// A run that ends early (`stopped_early`) stops recording at the rule that
    /// tripped `stop_on_critical`, so every rule after it has no outcome. A
    /// consumer mapping outcomes to check IDs must read `stopped_early` to tell
    /// "not reached" from "not registered".
    #[serde(default)]
    pub rule_outcomes: Vec<RuleOutcome>,
    /// Whether the check was stopped early
    pub stopped_early: bool,
    /// Overall pass/fail status
    pub passed: bool,
}

impl QCReport {
    /// Creates a new empty report
    fn new(sequence_id: String) -> Self {
        Self {
            sequence_id,
            checked_at: chrono::Utc::now(),
            duration_ms: 0,
            violations: Vec::new(),
            severity_counts: HashMap::new(),
            skipped_rules: Vec::new(),
            errored_rules: Vec::new(),
            rule_outcomes: Vec::new(),
            stopped_early: false,
            passed: true,
        }
    }

    /// Adds a violation and updates counts
    fn add_violation(&mut self, violation: QCViolation) {
        let severity_key = violation.severity.to_string();
        *self.severity_counts.entry(severity_key).or_insert(0) += 1;

        if violation.severity >= Severity::Error {
            self.passed = false;
        }

        self.violations.push(violation);
    }

    /// Records a rule failure and marks the report as not passing
    fn record_rule_failure(&mut self, rule_name: &str, message: String) {
        self.errored_rules.push(RuleFailure {
            rule_name: rule_name.to_string(),
            message,
        });
        self.passed = false;
    }

    /// Recomputes the derived counters and pass state from the violations
    ///
    /// Callers that re-grade violations after the run (see
    /// [`crate::core::qc::structural::crossref_black_ranges_with_gaps`]) must
    /// call this, otherwise the summary describes the pre-grading state.
    pub fn recompute(&mut self) {
        self.severity_counts.clear();
        self.passed = self.errored_rules.is_empty();

        for violation in &self.violations {
            *self
                .severity_counts
                .entry(violation.severity.to_string())
                .or_insert(0) += 1;

            if violation.severity >= Severity::Error {
                self.passed = false;
            }
        }
    }

    /// Returns the recorded outcome for a rule, when the run covered it
    pub fn outcome_for(&self, rule_name: &str) -> Option<&RuleOutcome> {
        self.rule_outcomes
            .iter()
            .find(|outcome| outcome.rule_name == rule_name)
    }

    /// Records that a rule ran to completion
    fn record_ran(&mut self, rule: &dyn QCRule) {
        self.rule_outcomes.push(RuleOutcome {
            rule_name: rule.name().to_string(),
            check_id: rule.check_id().to_string(),
            category: rule.category(),
            status: RuleStatus::Ran,
            reason: None,
        });
    }

    /// Records that a rule was skipped, and why
    fn record_skip(&mut self, rule: &dyn QCRule, reason: &str) {
        self.skipped_rules.push(rule.name().to_string());
        self.rule_outcomes.push(RuleOutcome {
            rule_name: rule.name().to_string(),
            check_id: rule.check_id().to_string(),
            category: rule.category(),
            status: RuleStatus::Skipped,
            reason: Some(reason.to_string()),
        });
    }

    /// Records that a rule returned an error
    fn record_error(&mut self, rule: &dyn QCRule, message: String) {
        self.rule_outcomes.push(RuleOutcome {
            rule_name: rule.name().to_string(),
            check_id: rule.check_id().to_string(),
            category: rule.category(),
            status: RuleStatus::Errored,
            reason: Some(message),
        });
    }

    /// Gets violations of a specific severity
    pub fn violations_by_severity(&self, severity: Severity) -> Vec<&QCViolation> {
        self.violations
            .iter()
            .filter(|v| v.severity == severity)
            .collect()
    }

    /// Gets all auto-fixable violations
    pub fn auto_fixable_violations(&self) -> Vec<&QCViolation> {
        self.violations.iter().filter(|v| v.auto_fixable).collect()
    }

    /// Gets count of violations for a severity
    pub fn count(&self, severity: Severity) -> usize {
        self.severity_counts
            .get(&severity.to_string())
            .copied()
            .unwrap_or(0)
    }

    /// Total number of violations
    pub fn total_violations(&self) -> usize {
        self.violations.len()
    }

    /// Generates a summary string
    pub fn summary(&self) -> String {
        let mut summary = format!(
            "QC Report: {} ({} violations - {} critical, {} error, {} warning, {} info)",
            if self.passed { "PASSED" } else { "FAILED" },
            self.total_violations(),
            self.count(Severity::Critical),
            self.count(Severity::Error),
            self.count(Severity::Warning),
            self.count(Severity::Info)
        );

        if !self.errored_rules.is_empty() {
            summary.push_str(&format!(" [{} rules errored]", self.errored_rules.len()));
        }

        summary
    }
}

/// Main QC Engine for running quality checks
pub struct QCEngine {
    /// Registered rules
    rules: Vec<Arc<dyn QCRule>>,
    /// Engine configuration
    config: Arc<RwLock<QCEngineConfig>>,
}

impl QCEngine {
    /// Creates a new QC engine with default rules
    pub fn new() -> Self {
        let mut engine = Self {
            rules: Vec::new(),
            config: Arc::new(RwLock::new(QCEngineConfig::default())),
        };

        // Register built-in rules
        engine.register_builtin_rules();

        engine
    }

    /// Creates a new QC engine with custom config
    pub fn with_config(config: QCEngineConfig) -> Self {
        let mut engine = Self {
            rules: Vec::new(),
            config: Arc::new(RwLock::new(config)),
        };

        engine.register_builtin_rules();

        engine
    }

    /// Registers all built-in rules
    fn register_builtin_rules(&mut self) {
        // Structural rules: readable from project state alone.
        self.register_rule(Arc::new(TimelineGapRule::new()));
        self.register_rule(Arc::new(ClipOrphanRule::new()));
        self.register_rule(Arc::new(MissingAssetRule::new()));
        self.register_rule(Arc::new(SilentClipRule::new()));
        self.register_rule(Arc::new(CaptionOverlapRule::new()));
        self.register_rule(Arc::new(CaptionReadingRateRule::new()));
        self.register_rule(Arc::new(CaptionOutOfBoundsRule::new()));
        self.register_rule(Arc::new(ShotLengthStatsRule::new()));
        self.register_rule(Arc::new(CaptionSafeAreaRule::new()));
        self.register_rule(Arc::new(CutRhythmRule::new()));
        self.register_rule(Arc::new(LicenseRule::new()));
        self.register_rule(Arc::new(AspectRatioRule::new()));
        self.register_rule(Arc::new(DurationRule::new()));

        // Rendered rules: need measurements from an exported file.
        self.register_rule(Arc::new(BlackFrameRule::new()));
        self.register_rule(Arc::new(AudioPeakRule::new()));
        self.register_rule(Arc::new(AudioLoudnessRule::new()));
    }

    /// Registers a custom rule
    pub fn register_rule(&mut self, rule: Arc<dyn QCRule>) {
        self.rules.push(rule);
    }

    /// Gets all registered rules
    pub fn rules(&self) -> &[Arc<dyn QCRule>] {
        &self.rules
    }

    /// Gets all registered rule names
    pub fn rule_names(&self) -> Vec<&str> {
        self.rules.iter().map(|r| r.name()).collect()
    }

    /// Gets the rule registered for a check ID
    pub fn get_rule_by_check_id(&self, check_id: &str) -> Option<&Arc<dyn QCRule>> {
        self.rules.iter().find(|rule| rule.check_id() == check_id)
    }

    /// Gets a rule by name
    pub fn get_rule(&self, name: &str) -> Option<&Arc<dyn QCRule>> {
        self.rules.iter().find(|r| r.name() == name)
    }

    /// Updates the engine configuration
    pub async fn set_config(&self, config: QCEngineConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    /// Gets a copy of the current configuration
    pub async fn get_config(&self) -> QCEngineConfig {
        self.config.read().await.clone()
    }

    /// Runs all enabled QC rules on a sequence
    ///
    /// The context is derived from the sequence alone, so rules that require
    /// rendered measurements are reported as skipped. Use
    /// [`QCEngine::check_with_measurements`] to run those rules.
    pub async fn check(&self, sequence: &Sequence, state: &ProjectState) -> CoreResult<QCReport> {
        let context = QCContext::from_sequence(sequence);
        self.check_with_context(sequence, state, &context).await
    }

    /// Runs all enabled QC rules with measurements from a rendered sequence
    pub async fn check_with_measurements(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        measurements: RenderMeasurements,
    ) -> CoreResult<QCReport> {
        let context = QCContext::from_sequence(sequence).with_measurements(measurements);
        self.check_with_context(sequence, state, &context).await
    }

    /// Runs all enabled QC rules against an explicit context
    pub async fn check_with_context(
        &self,
        sequence: &Sequence,
        state: &ProjectState,
        context: &QCContext,
    ) -> CoreResult<QCReport> {
        let start_time = std::time::Instant::now();
        let config = self.config.read().await;

        let mut report = QCReport::new(sequence.id.clone());

        for rule in &self.rules {
            let rule_name = rule.name();

            // Check if rule is disabled
            if !config.is_rule_enabled(rule_name) {
                report.record_skip(rule.as_ref(), "disabled by configuration");
                continue;
            }

            // Get rule-specific config
            let rule_config = config.get_rule_config(rule_name);
            if !rule_config.enabled {
                report.record_skip(rule.as_ref(), "disabled by rule configuration");
                continue;
            }

            // A rule missing its required inputs is skipped, never silently passed
            if let Some(reason) = rule.skip_reason(context) {
                tracing::debug!("Rule '{}' skipped: {}", rule_name, reason);
                report.record_skip(rule.as_ref(), &reason);
                continue;
            }

            // Run the rule
            match rule.check(sequence, state, &rule_config, context).await {
                Ok(violations) => {
                    report.record_ran(rule.as_ref());

                    for violation in violations {
                        // Apply severity filter
                        if config.severity_filter.passes(violation.severity) {
                            // Check for stop on critical
                            if config.stop_on_critical && violation.severity == Severity::Critical {
                                report.add_violation(violation);
                                report.stopped_early = true;
                                report.duration_ms = start_time.elapsed().as_millis() as u64;
                                return Ok(report);
                            }

                            report.add_violation(violation);
                        }
                    }
                }
                Err(e) => {
                    // Continue with other rules, but record the failure so the
                    // report cannot claim a check that never ran as passing
                    tracing::warn!("Rule '{}' failed: {}", rule_name, e);
                    report.record_rule_failure(rule_name, e.to_string());
                    report.record_error(rule.as_ref(), e.to_string());
                }
            }
        }

        report.duration_ms = start_time.elapsed().as_millis() as u64;
        Ok(report)
    }

    /// Runs a specific rule on a sequence with a context derived from it
    pub async fn check_rule(
        &self,
        rule_name: &str,
        sequence: &Sequence,
        state: &ProjectState,
    ) -> CoreResult<Vec<QCViolation>> {
        let context = QCContext::from_sequence(sequence);
        self.check_rule_with_context(rule_name, sequence, state, &context)
            .await
    }

    /// Runs a specific rule on a sequence against an explicit context
    ///
    /// Rules that cannot run against the context return no violations; callers
    /// that need to distinguish that from a clean result should consult
    /// [`QCRule::skip_reason`] or run the full engine.
    pub async fn check_rule_with_context(
        &self,
        rule_name: &str,
        sequence: &Sequence,
        state: &ProjectState,
        context: &QCContext,
    ) -> CoreResult<Vec<QCViolation>> {
        let rule = self
            .get_rule(rule_name)
            .ok_or_else(|| CoreError::NotFound(format!("QC rule not found: {}", rule_name)))?;

        let config = self.config.read().await;
        let rule_config = config.get_rule_config(rule_name);

        rule.check(sequence, state, &rule_config, context).await
    }

    /// Gets suggested fixes for all auto-fixable violations
    pub fn get_fixes(&self, report: &QCReport) -> Vec<(String, ViolationFix)> {
        report
            .violations
            .iter()
            .filter_map(|v| v.suggested_fix.clone().map(|fix| (v.id.clone(), fix)))
            .collect()
    }

    /// Applies all auto-fixes and returns the commands to execute
    pub fn apply_all_fixes(&self, report: &QCReport) -> Vec<serde_json::Value> {
        report
            .violations
            .iter()
            .filter_map(|v| v.suggested_fix.as_ref())
            .flat_map(|fix| fix.commands.clone())
            .collect()
    }
}

impl Default for QCEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{Clip, SequenceFormat, Track};
    use async_trait::async_trait;

    // ========================================================================
    // Test Fixtures
    // ========================================================================

    /// Rule that always fails, used to verify error reporting
    struct FailingRule;

    #[async_trait]
    impl QCRule for FailingRule {
        fn name(&self) -> &str {
            "FailingRule"
        }

        fn description(&self) -> &str {
            "Always returns an error"
        }

        fn default_severity(&self) -> Severity {
            Severity::Error
        }

        async fn check(
            &self,
            _sequence: &Sequence,
            _state: &ProjectState,
            _config: &RuleConfig,
            _context: &QCContext,
        ) -> CoreResult<Vec<QCViolation>> {
            Err(CoreError::Internal("rule exploded".to_string()))
        }
    }

    /// Builds a sequence with one 30s video clip, long enough to satisfy the
    /// duration rule so tests only observe the behavior under test.
    fn test_sequence() -> Sequence {
        let mut sequence = Sequence::new("QC Test", SequenceFormat::youtube_1080());
        let mut track = Track::new_video("V1");
        track.add_clip(Clip::with_range("asset_001", 0.0, 30.0));
        sequence.add_track(track);
        sequence
    }

    /// Builds an engine whose built-in rules are all disabled
    async fn engine_with_only(rule: Arc<dyn QCRule>) -> QCEngine {
        let mut engine = QCEngine::new();

        let mut config = QCEngineConfig::default();
        let builtin_names: Vec<String> = engine
            .rule_names()
            .into_iter()
            .map(|name| name.to_string())
            .collect();
        for name in builtin_names {
            config.disable_rule(&name);
        }

        engine.set_config(config).await;
        engine.register_rule(rule);
        engine
    }

    // ========================================================================
    // QCSeverityFilter Tests
    // ========================================================================

    #[test]
    fn test_severity_filter_all() {
        let filter = QCSeverityFilter::All;
        assert!(filter.passes(Severity::Info));
        assert!(filter.passes(Severity::Warning));
        assert!(filter.passes(Severity::Error));
        assert!(filter.passes(Severity::Critical));
    }

    #[test]
    fn test_severity_filter_warning_and_above() {
        let filter = QCSeverityFilter::WarningAndAbove;
        assert!(!filter.passes(Severity::Info));
        assert!(filter.passes(Severity::Warning));
        assert!(filter.passes(Severity::Error));
        assert!(filter.passes(Severity::Critical));
    }

    #[test]
    fn test_severity_filter_error_and_above() {
        let filter = QCSeverityFilter::ErrorAndAbove;
        assert!(!filter.passes(Severity::Info));
        assert!(!filter.passes(Severity::Warning));
        assert!(filter.passes(Severity::Error));
        assert!(filter.passes(Severity::Critical));
    }

    #[test]
    fn test_severity_filter_critical_only() {
        let filter = QCSeverityFilter::CriticalOnly;
        assert!(!filter.passes(Severity::Info));
        assert!(!filter.passes(Severity::Warning));
        assert!(!filter.passes(Severity::Error));
        assert!(filter.passes(Severity::Critical));
    }

    // ========================================================================
    // QCEngineConfig Tests
    // ========================================================================

    #[test]
    fn test_config_default() {
        let config = QCEngineConfig::default();
        assert_eq!(config.severity_filter, QCSeverityFilter::All);
        assert!(!config.stop_on_critical);
        assert!(config.rule_configs.is_empty());
        assert!(config.disabled_rules.is_empty());
    }

    #[test]
    fn test_config_strict() {
        let config = QCEngineConfig::strict();
        assert_eq!(config.severity_filter, QCSeverityFilter::WarningAndAbove);
        assert!(config.stop_on_critical);
    }

    #[test]
    fn test_config_quick() {
        let config = QCEngineConfig::quick();
        assert_eq!(config.severity_filter, QCSeverityFilter::ErrorAndAbove);
        assert!(!config.stop_on_critical);
    }

    #[test]
    fn test_config_disable_enable_rule() {
        let mut config = QCEngineConfig::default();

        assert!(config.is_rule_enabled("BlackFrameRule"));

        config.disable_rule("BlackFrameRule");
        assert!(!config.is_rule_enabled("BlackFrameRule"));

        config.enable_rule("BlackFrameRule");
        assert!(config.is_rule_enabled("BlackFrameRule"));
    }

    #[test]
    fn test_config_set_get_rule_config() {
        let mut config = QCEngineConfig::default();

        let mut rule_config = RuleConfig::default();
        rule_config.set_param("threshold", 0.1);

        config.set_rule_config("BlackFrameRule", rule_config);

        let retrieved = config.get_rule_config("BlackFrameRule");
        assert_eq!(retrieved.get_param::<f64>("threshold"), Some(0.1));

        // Non-existent rule should return default
        let default_config = config.get_rule_config("NonExistentRule");
        assert!(default_config.enabled);
    }

    // ========================================================================
    // QCReport Tests
    // ========================================================================

    #[test]
    fn test_report_new() {
        let report = QCReport::new("seq_001".to_string());
        assert_eq!(report.sequence_id, "seq_001");
        assert!(report.violations.is_empty());
        assert!(report.passed);
        assert!(!report.stopped_early);
    }

    #[test]
    fn test_report_add_violation() {
        let mut report = QCReport::new("seq_001".to_string());

        report.add_violation(QCViolation::new("TestRule", Severity::Warning, "Warning"));
        assert_eq!(report.total_violations(), 1);
        assert_eq!(report.count(Severity::Warning), 1);
        assert!(report.passed); // Warning doesn't fail

        report.add_violation(QCViolation::new("TestRule", Severity::Error, "Error"));
        assert_eq!(report.total_violations(), 2);
        assert_eq!(report.count(Severity::Error), 1);
        assert!(!report.passed); // Error fails
    }

    #[test]
    fn test_report_violations_by_severity() {
        let mut report = QCReport::new("seq_001".to_string());

        report.add_violation(QCViolation::new("Rule1", Severity::Warning, "Warn 1"));
        report.add_violation(QCViolation::new("Rule2", Severity::Error, "Error 1"));
        report.add_violation(QCViolation::new("Rule3", Severity::Warning, "Warn 2"));

        let warnings = report.violations_by_severity(Severity::Warning);
        assert_eq!(warnings.len(), 2);

        let errors = report.violations_by_severity(Severity::Error);
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn test_report_auto_fixable_violations() {
        let mut report = QCReport::new("seq_001".to_string());

        report.add_violation(QCViolation::new("Rule1", Severity::Warning, "Not fixable"));

        let fix = ViolationFix::new("Fix it", vec![]);
        report.add_violation(QCViolation::new("Rule2", Severity::Error, "Fixable").with_fix(fix));

        let fixable = report.auto_fixable_violations();
        assert_eq!(fixable.len(), 1);
    }

    #[test]
    fn test_report_summary() {
        let mut report = QCReport::new("seq_001".to_string());
        report.add_violation(QCViolation::new("Rule", Severity::Warning, "Warn"));
        report.add_violation(QCViolation::new("Rule", Severity::Error, "Error"));

        let summary = report.summary();
        assert!(summary.contains("FAILED"));
        assert!(summary.contains("2 violations"));
    }

    // ========================================================================
    // QCEngine Tests
    // ========================================================================

    #[test]
    fn test_engine_new() {
        let engine = QCEngine::new();
        assert!(!engine.rules.is_empty());
    }

    #[test]
    fn test_engine_rule_names() {
        let engine = QCEngine::new();
        let names = engine.rule_names();

        assert!(names.contains(&"BlackFrameRule"));
        assert!(names.contains(&"AudioPeakRule"));
        assert!(names.contains(&"CaptionSafeAreaRule"));
        assert!(names.contains(&"CutRhythmRule"));
        assert!(names.contains(&"LicenseRule"));
        assert!(names.contains(&"AspectRatioRule"));
        assert!(names.contains(&"DurationRule"));
    }

    #[test]
    fn test_engine_get_rule() {
        let engine = QCEngine::new();

        assert!(engine.get_rule("BlackFrameRule").is_some());
        assert!(engine.get_rule("NonExistentRule").is_none());
    }

    #[tokio::test]
    async fn test_engine_set_get_config() {
        let engine = QCEngine::new();

        let new_config = QCEngineConfig::strict();
        engine.set_config(new_config.clone()).await;

        let retrieved = engine.get_config().await;
        assert_eq!(retrieved.severity_filter, QCSeverityFilter::WarningAndAbove);
        assert!(retrieved.stop_on_critical);
    }

    #[test]
    fn test_engine_get_fixes() {
        let engine = QCEngine::new();
        let mut report = QCReport::new("seq_001".to_string());

        let fix = ViolationFix::new("Fix it", vec![serde_json::json!({"type": "Test"})]);
        report.add_violation(QCViolation::new("Rule", Severity::Warning, "Issue").with_fix(fix));

        let fixes = engine.get_fixes(&report);
        assert_eq!(fixes.len(), 1);
    }

    #[tokio::test]
    async fn test_engine_check_should_record_errored_rules_and_not_pass() {
        let engine = engine_with_only(Arc::new(FailingRule)).await;
        let sequence = test_sequence();
        let state = ProjectState::new("QC Test");

        let report = engine.check(&sequence, &state).await.expect("check runs");

        assert_eq!(report.errored_rules.len(), 1);
        assert_eq!(report.errored_rules[0].rule_name, "FailingRule");
        assert!(report.errored_rules[0].message.contains("rule exploded"));
        assert!(report.violations.is_empty());
        assert!(
            !report.passed,
            "a rule that never ran must not be reported as passing"
        );
        assert!(report.summary().contains("1 rules errored"));
    }

    #[tokio::test]
    async fn test_engine_check_should_skip_measurement_rules_without_measurements() {
        let engine = QCEngine::new();
        let sequence = test_sequence();
        let state = ProjectState::new("QC Test");

        let report = engine.check(&sequence, &state).await.expect("check runs");

        assert!(report.skipped_rules.contains(&"BlackFrameRule".to_string()));
        assert!(report.skipped_rules.contains(&"AudioPeakRule".to_string()));
        assert!(report.errored_rules.is_empty());
    }

    #[tokio::test]
    async fn test_engine_check_with_measurements_should_run_measurement_rules() {
        let engine = QCEngine::new();
        let sequence = test_sequence();
        let state = ProjectState::new("QC Test");

        let report = engine
            .check_with_measurements(
                &sequence,
                &state,
                RenderMeasurements {
                    black_ranges: vec![(0.0, 0.5)],
                    true_peak_dbtp: Some(-0.2),
                    ..Default::default()
                },
            )
            .await
            .expect("check runs");

        assert!(!report.skipped_rules.contains(&"BlackFrameRule".to_string()));
        assert!(!report.skipped_rules.contains(&"AudioPeakRule".to_string()));
        assert!(report
            .violations
            .iter()
            .any(|violation| violation.rule_name == "BlackFrameRule"));
        assert!(report
            .violations
            .iter()
            .any(|violation| violation.rule_name == "AudioPeakRule"));
    }

    #[test]
    fn test_engine_apply_all_fixes() {
        let engine = QCEngine::new();
        let mut report = QCReport::new("seq_001".to_string());

        let fix1 = ViolationFix::new("Fix 1", vec![serde_json::json!({"type": "Cmd1"})]);
        let fix2 = ViolationFix::new(
            "Fix 2",
            vec![
                serde_json::json!({"type": "Cmd2"}),
                serde_json::json!({"type": "Cmd3"}),
            ],
        );

        report
            .add_violation(QCViolation::new("Rule1", Severity::Warning, "Issue 1").with_fix(fix1));
        report
            .add_violation(QCViolation::new("Rule2", Severity::Warning, "Issue 2").with_fix(fix2));

        let commands = engine.apply_all_fixes(&report);
        assert_eq!(commands.len(), 3);
    }
}
