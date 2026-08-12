//! QC Execution Context
//!
//! Carries the sequence-level facts and the optional rendered measurements that
//! QC rules evaluate against. The context is built once per QC run and shared by
//! reference with every rule, so a single (expensive) measurement pass can serve
//! the whole rule set.

use serde::{Deserialize, Serialize};

use crate::core::timeline::Sequence;

/// Frame rate used when a sequence carries an unusable frame rate.
///
/// A zero or non-finite fps would poison every frame-tolerance calculation, so
/// the context falls back to the project-wide default instead of propagating it.
const FALLBACK_FPS: f64 = 30.0;

/// Measurements captured from a rendered version of the sequence.
///
/// Produced by the render measurement pass. Every field is optional or empty so
/// a partially successful pass still yields usable data; rules must read a
/// missing field as "not measured" rather than "measured as zero".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMeasurements {
    /// Detected black ranges as `(start_sec, end_sec)` timeline pairs
    pub black_ranges: Vec<(f64, f64)>,
    /// Detected frozen-image ranges as `(start_sec, end_sec)` timeline pairs
    pub freeze_ranges: Vec<(f64, f64)>,
    /// Detected silent ranges as `(start_sec, end_sec)` timeline pairs
    pub silence_ranges: Vec<(f64, f64)>,
    /// Integrated program loudness in LUFS
    pub integrated_lufs: Option<f64>,
    /// True peak in dBTP
    pub true_peak_dbtp: Option<f64>,
    /// Loudness range in LU
    pub loudness_range_lu: Option<f64>,
    /// Sample peak in dBFS (fallback when true peak is unavailable)
    pub sample_peak_db: Option<f64>,
    /// Flatness factor reported by the audio statistics pass
    pub flat_factor: Option<f64>,
}

/// Context handed to every QC rule for a single check run.
#[derive(Debug, Clone)]
pub struct QCContext {
    /// Effective sequence frame rate in frames per second (always positive)
    pub fps: f64,
    /// Canvas width in pixels
    pub canvas_width: u32,
    /// Canvas height in pixels
    pub canvas_height: u32,
    /// Measurements from a rendered version of the sequence, when available
    pub measurements: Option<RenderMeasurements>,
}

impl QCContext {
    /// Builds a context from a sequence without rendered measurements.
    pub fn from_sequence(sequence: &Sequence) -> Self {
        let fps = sequence.format.fps.as_f64();

        Self {
            fps: if fps.is_finite() && fps > 0.0 {
                fps
            } else {
                FALLBACK_FPS
            },
            canvas_width: sequence.format.canvas.width,
            canvas_height: sequence.format.canvas.height,
            measurements: None,
        }
    }

    /// Attaches rendered measurements to this context.
    pub fn with_measurements(mut self, measurements: RenderMeasurements) -> Self {
        self.measurements = Some(measurements);
        self
    }

    /// Returns the duration of a single frame in seconds.
    pub fn frame_duration_sec(&self) -> f64 {
        if self.fps.is_finite() && self.fps > 0.0 {
            1.0 / self.fps
        } else {
            1.0 / FALLBACK_FPS
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::SequenceFormat;

    #[test]
    fn test_context_derives_fps_and_canvas_from_sequence() {
        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let context = QCContext::from_sequence(&sequence);

        assert_eq!(context.fps, 30.0);
        assert_eq!(context.canvas_width, 1920);
        assert_eq!(context.canvas_height, 1080);
        assert!(context.measurements.is_none());
    }

    #[test]
    fn test_context_falls_back_when_fps_is_unusable() {
        let mut sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        sequence.format.fps.num = 0;

        let context = QCContext::from_sequence(&sequence);

        assert_eq!(context.fps, FALLBACK_FPS);
        assert!((context.frame_duration_sec() - 1.0 / FALLBACK_FPS).abs() < f64::EPSILON);
    }

    #[test]
    fn test_context_with_measurements() {
        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let measurements = RenderMeasurements {
            black_ranges: vec![(0.0, 0.5)],
            true_peak_dbtp: Some(-0.5),
            ..Default::default()
        };

        let context = QCContext::from_sequence(&sequence).with_measurements(measurements);

        let measured = context.measurements.expect("measurements attached");
        assert_eq!(measured.black_ranges, vec![(0.0, 0.5)]);
        assert_eq!(measured.true_peak_dbtp, Some(-0.5));
        assert!(measured.silence_ranges.is_empty());
    }
}
