//! Quality Control (QC) System
//!
//! Automated quality control rules for video editing validation.
//! Provides rules engine, built-in rules, and auto-fix capabilities.

pub mod context;
pub mod engine;
pub mod measure;
pub mod rules;
pub mod structural;
pub mod violation;

// Re-export main types
pub use context::{QCContext, RenderMeasurements};
pub use engine::{
    QCEngine, QCEngineConfig, QCReport, QCSeverityFilter, RuleFailure, RuleOutcome, RuleStatus,
};
pub use measure::{
    measure_rendered_file, measure_rendered_file_detailed, MeasureOptions, MeasurementReport,
};
pub use rules::{
    AspectRatioRule, AudioLoudnessRule, AudioPeakRule, BlackFrameRule, CaptionSafeAreaRule,
    CheckCategory, CutRhythmRule, DurationRule, LicenseRule, QCRule, RuleConfig,
};
pub use structural::{
    crossref_black_ranges_with_gaps, CaptionOutOfBoundsRule, CaptionOverlapRule,
    CaptionReadingRateRule, ClipOrphanRule, MissingAssetRule, ShotLengthStatsRule, SilentClipRule,
    TimelineGapRule,
};
pub use violation::{QCViolation, Severity, TimeRange, ViolationFix};
