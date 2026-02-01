//! OpenReelio Core Type Definitions
//!
//! Defines fundamental types used throughout the project.
//! All types are exported to TypeScript via tauri-specta.

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::warn;

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

/// Bin (folder) unique identifier (ULID)
pub type BinId = String;

// =============================================================================
// Time Types
// =============================================================================

/// Time in seconds (floating point)
pub type TimeSec = f64;

/// Time in frames (integer)
pub type Frame = i64;

/// Ratio (for fps, aspect ratio, etc.)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct Ratio {
    /// Numerator
    pub num: i32,
    /// Denominator
    pub den: i32,
}

impl Ratio {
    /// Creates a new ratio with validation
    pub fn new(num: i32, den: i32) -> Self {
        if den == 0 {
            warn!("Ratio created with zero denominator, defaulting to 1");
            return Self { num, den: 1 };
        }
        Self { num, den }
    }

    /// Converts to floating point value
    pub fn as_f64(&self) -> f64 {
        if self.den == 0 {
            return 0.0;
        }
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
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
        Self {
            r: r.clamp(0.0, 1.0),
            g: g.clamp(0.0, 1.0),
            b: b.clamp(0.0, 1.0),
            a: None,
        }
    }

    pub fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self {
            r: r.clamp(0.0, 1.0),
            g: g.clamp(0.0, 1.0),
            b: b.clamp(0.0, 1.0),
            a: Some(a.clamp(0.0, 1.0)),
        }
    }

    pub fn white() -> Self {
        Self::rgb(1.0, 1.0, 1.0)
    }

    pub fn black() -> Self {
        Self::rgb(0.0, 0.0, 0.0)
    }

    /// Parses a hex color string (e.g. `#RRGGBB`, `#RRGGBBAA`, `#RGB`, `#RGBA`).
    pub fn try_from_hex(hex: &str) -> Result<Self, String> {
        let hex = hex.trim().trim_start_matches('#');
        let len = hex.len();

        if len != 3 && len != 4 && len != 6 && len != 8 {
            return Err(format!("Invalid hex color length: {}", len));
        }

        let parse_channel = |s: &str| -> Result<f32, String> {
            u8::from_str_radix(s, 16)
                .map(|v| v as f32 / 255.0)
                .map_err(|e| e.to_string())
        };

        // Handle short hex (3 or 4 chars) by expanding them (e.g. F -> FF)
        if len == 3 || len == 4 {
            let r_str = &hex[0..1];
            let g_str = &hex[1..2];
            let b_str = &hex[2..3];

            // Expand "F" to "FF"
            let r = u8::from_str_radix(r_str, 16).map_err(|e| e.to_string())?;
            let g = u8::from_str_radix(g_str, 16).map_err(|e| e.to_string())?;
            let b = u8::from_str_radix(b_str, 16).map_err(|e| e.to_string())?;

            let r = (r * 17) as f32 / 255.0; // 0xF * 17 = 0xFF (255)
            let g = (g * 17) as f32 / 255.0;
            let b = (b * 17) as f32 / 255.0;

            if len == 4 {
                let a_str = &hex[3..4];
                let a = u8::from_str_radix(a_str, 16).map_err(|e| e.to_string())?;
                let a = (a * 17) as f32 / 255.0;
                return Ok(Self::rgba(r, g, b, a));
            } else {
                return Ok(Self::rgb(r, g, b));
            }
        }

        // Handle full hex (6 or 8 chars)
        let r = parse_channel(&hex[0..2])?;
        let g = parse_channel(&hex[2..4])?;
        let b = parse_channel(&hex[4..6])?;

        if len == 8 {
            let a = parse_channel(&hex[6..8])?;
            Ok(Self::rgba(r, g, b, a))
        } else {
            Ok(Self::rgb(r, g, b))
        }
    }

    /// Parses a hex color string, falling back to black on invalid input.
    pub fn from_hex(hex: &str) -> Self {
        match Self::try_from_hex(hex) {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    "Failed to parse hex color '{}': {}, defaulting to black",
                    hex, e
                );
                Self::black()
            }
        }
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start_sec: TimeSec,
    pub end_sec: TimeSec,
}

impl TimeRange {
    pub fn new(start_sec: TimeSec, end_sec: TimeSec) -> Self {
        if start_sec > end_sec {
            warn!(
                "TimeRange created with start > end ({} > {}), swapping",
                start_sec, end_sec
            );
            return Self {
                start_sec: end_sec,
                end_sec: start_sec,
            };
        }
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
