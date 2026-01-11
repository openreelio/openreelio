//! Quality Control (QC) System
//!
//! Automated quality control rules for video editing validation.
//! Provides rules engine, built-in rules, and auto-fix capabilities.

pub mod engine;
pub mod rules;
pub mod violation;

// Re-export main types
pub use engine::{QCEngine, QCEngineConfig, QCReport, QCSeverityFilter};
pub use rules::{
    AspectRatioRule, AudioPeakRule, BlackFrameRule, CaptionSafeAreaRule, CutRhythmRule,
    DurationRule, LicenseRule, QCRule, RuleConfig,
};
pub use violation::{QCViolation, Severity, TimeRange, ViolationFix};
