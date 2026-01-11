//! OpenReelio Core Type Definitions
//!
//! Defines fundamental types used throughout the project.

use serde::{Deserialize, Serialize};

// =============================================================================
// ID Types
// =============================================================================

/// Asset unique identifier (ULID)
pub type AssetId = String;

/// Clip unique identifier (ULID)
pub type ClipId = String;

/// Track unique identifier (ULID)
pub type TrackId = String;

/// Effect unique identifier (ULID)
pub type EffectId = String;

/// Caption unique identifier (ULID)
pub type CaptionId = String;

/// Operation unique identifier (ULID)
pub type OpId = String;

/// Job unique identifier (ULID)
pub type JobId = String;

/// Sequence unique identifier (ULID)
pub type SequenceId = String;

/// Plugin unique identifier (ULID)
pub type PluginId = String;

// =============================================================================
// Time Types
// =============================================================================

/// Time in seconds (floating point)
pub type TimeSec = f64;

/// Time in frames (integer)
pub type Frame = i64;

/// Ratio (for fps, aspect ratio, etc.)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ratio {
    /// Numerator
    pub num: i32,
    /// Denominator
    pub den: i32,
}

impl Ratio {
    /// Creates a new ratio
    pub fn new(num: i32, den: i32) -> Self {
        Self { num, den }
    }

    /// Converts to floating point value
    pub fn as_f64(&self) -> f64 {
        self.num as f64 / self.den as f64
    }
}

impl Default for Ratio {
    fn default() -> Self {
        Self { num: 30, den: 1 } // Default 30fps
    }
}

// =============================================================================
// Spatial Types
// =============================================================================

/// 2D coordinates (normalized or pixel)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

impl Point2D {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Returns center coordinates
    pub fn center() -> Self {
        Self { x: 0.5, y: 0.5 }
    }
}

impl Default for Point2D {
    fn default() -> Self {
        Self::center()
    }
}

/// 2D size
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Size2D {
    pub width: u32,
    pub height: u32,
}

impl Size2D {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }
}

/// Color (RGBA)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Color {
    /// Red (0.0 ~ 1.0)
    pub r: f32,
    /// Green (0.0 ~ 1.0)
    pub g: f32,
    /// Blue (0.0 ~ 1.0)
    pub b: f32,
    /// Alpha (0.0 ~ 1.0, optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a: Option<f32>,
}

impl Color {
    pub fn rgb(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b, a: None }
    }

    pub fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a: Some(a) }
    }

    pub fn white() -> Self {
        Self::rgb(1.0, 1.0, 1.0)
    }

    pub fn black() -> Self {
        Self::rgb(0.0, 0.0, 0.0)
    }
}

impl Default for Color {
    fn default() -> Self {
        Self::white()
    }
}

// =============================================================================
// Time Range
// =============================================================================

/// Time range
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_sec: TimeSec,
    pub end_sec: TimeSec,
}

impl TimeRange {
    pub fn new(start_sec: TimeSec, end_sec: TimeSec) -> Self {
        Self { start_sec, end_sec }
    }

    /// Returns duration in seconds
    pub fn duration(&self) -> TimeSec {
        self.end_sec - self.start_sec
    }

    /// Checks if a given time is within range
    pub fn contains(&self, time: TimeSec) -> bool {
        time >= self.start_sec && time <= self.end_sec
    }

    /// Checks if two ranges overlap
    pub fn overlaps(&self, other: &TimeRange) -> bool {
        self.start_sec < other.end_sec && self.end_sec > other.start_sec
    }
}
