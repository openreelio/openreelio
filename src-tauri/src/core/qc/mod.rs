//! Quality Control (QC) System
//!
//! Automated quality control rules for video editing validation.
//! Provides rules engine, built-in rules, and auto-fix capabilities.

pub mod context;
pub mod engine;
pub mod measure;
pub mod rules;
pub mod structural;
pub mod verify;
pub mod violation;

/// Proves every fix a rule can suggest is a command the edit layer accepts.
#[cfg(test)]
mod fix_roundtrip_tests;

// Re-export main types
pub use context::{MeasuredStreams, MeasuredVideoStream, QCContext, RenderMeasurements};
pub use engine::{
    QCEngine, QCEngineConfig, QCReport, QCSeverityFilter, RuleFailure, RuleOutcome, RuleStatus,
};
pub use measure::{
    measure_rendered_file, measure_rendered_file_detailed, MeasureOptions, MeasurementReport,
};
pub use rules::{
    AspectRatioRule, AudioClippingRule, AudioLoudnessRule, AudioPeakRule, BlackFrameRule,
    CaptionSafeAreaRule, CheckCategory, CutRhythmRule, DurationRule, FrozenProgramRule,
    LicenseRule, MissingVideoStreamRule, QCRule, RenderDurationRule, RenderResolutionRule,
    RuleConfig,
};
pub use structural::{
    crossref_black_ranges_with_gaps, CaptionOutOfBoundsRule, CaptionOverlapRule,
    CaptionReadingRateRule, ClipOrphanRule, EmptySequenceRule, MissingAssetRule,
    ShotLengthStatsRule, SilentClipRule, TimelineGapRule,
};
pub use verify::{
    exit_code_for, CheckStatus, VerifyArgumentNames, VerifyError, VerifyErrorKind, VerifyPlan,
    VerifyReport, VerifyRequest, VerifyResult, DEFAULT_FAIL_ON, DEFAULT_MEASURE_TIMEOUT_SEC,
    EXIT_THRESHOLD_BREACHED, EXIT_TOOL_FAILURE, OPT_IN_CHECK_IDS,
};
pub use violation::{merged_span_duration_sec, QCViolation, Severity, TimeRange, ViolationFix};
