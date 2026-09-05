//! QC Execution Context
//!
//! Carries the sequence-level facts and the optional rendered measurements that
//! QC rules evaluate against. The context is built once per QC run and shared by
//! reference with every rule, so a single (expensive) measurement pass can serve
//! the whole rule set.

use serde::{Deserialize, Serialize};

use super::caption_contrast::{CaptionBandSample, CaptionSampleCoverage};
use crate::core::timeline::Sequence;

/// Frame rate used when a sequence carries an unusable frame rate.
///
/// A zero or non-finite fps would poison every frame-tolerance calculation, so
/// the context falls back to the project-wide default instead of propagating it.
const FALLBACK_FPS: f64 = 30.0;

/// Picture properties of the measured file's video stream.
///
/// Read from the container by the probe that opens the measurement pass, so
/// these describe the file that was written rather than the settings it was
/// asked for.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredVideoStream {
    /// Coded width in pixels
    pub width: u32,
    /// Coded height in pixels
    pub height: u32,
    /// Frame rate reported by the container, in frames per second
    pub fps: f64,
}

impl MeasuredVideoStream {
    /// Returns the display aspect ratio, or `None` for an unusable frame size.
    pub fn aspect_ratio(&self) -> Option<f64> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        Some(f64::from(self.width) / f64::from(self.height))
    }
}

/// The stream table the probe found in the measured file.
///
/// Recorded because an empty detection list cannot express "there was nothing
/// to detect": a render with no video stream at all reports no black frames
/// and no freezes, which is indistinguishable from a clean picture unless the
/// stream table is carried alongside.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredStreams {
    /// Picture properties, or `None` when the file carries no video stream
    pub video: Option<MeasuredVideoStream>,
    /// Whether the file carries an audio stream
    pub has_audio: bool,
}

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
    /// Duration of the measured file in seconds, as reported by the probe
    ///
    /// Carried alongside the pixel and loudness figures so a rule can ask
    /// whether the file that was measured is the sequence at all: a stale or
    /// truncated render measures perfectly well and is still not the
    /// deliverable.
    pub file_duration_sec: Option<f64>,
    /// Streams the probe found in the measured file
    ///
    /// `None` means no stream table was recorded — measurements assembled by
    /// hand, or by a pass older than this field — which is not the same as
    /// "the file carries no streams". A rule that grades stream presence must
    /// skip rather than judge while this is `None`.
    #[serde(default)]
    pub streams: Option<MeasuredStreams>,
    /// Luminance readings taken in the band each caption cue occupies.
    ///
    /// Empty when nothing was sampled, which is not the same as "every caption
    /// is legible": a cue whose style already carries a box or an outline is
    /// never decoded, because the mitigation settles the question before a
    /// pixel is read. See [`crate::core::qc::caption_contrast`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub caption_band_samples: Vec<CaptionBandSample>,
    /// How much of the caption work the sampling pass actually got done.
    ///
    /// `None` means no sampling pass ran, which is not the same as "there was
    /// nothing to sample": a run with a rendered file records the counts even
    /// when every decode failed, so the rule can report unmeasured cues rather
    /// than let an empty sample list read as a clean result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_band_coverage: Option<CaptionSampleCoverage>,
}

impl RenderMeasurements {
    /// Returns the measured video stream, when the probe recorded one.
    pub fn video_stream(&self) -> Option<&MeasuredVideoStream> {
        self.streams
            .as_ref()
            .and_then(|streams| streams.video.as_ref())
    }

    /// Returns whether the measured file carries a video stream.
    ///
    /// `None` means the stream table was never recorded, which no rule may
    /// read as "there is no video".
    pub fn has_video_stream(&self) -> Option<bool> {
        self.streams.map(|streams| streams.video.is_some())
    }
}

/// The stretch of timeline a measured file was declared to hold.
///
/// A partial render — `render start --proxy --start 10 --end 40` — is a
/// perfectly good thing to measure, but nothing in the file says which seconds
/// of the timeline it is. The caller declares that, and every rendered rule
/// grades the file against this window instead of against the whole sequence:
/// without it a 30-second excerpt of a 90-second edit reads as a truncated
/// render of the deliverable.
///
/// Detection times are translated into timeline seconds before the rules see
/// them (see [`crate::core::qc::verify`]), so a rule reads one clock only.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredWindow {
    /// First timeline second the file holds
    pub start_sec: f64,
    /// Timeline second the file ends on
    pub end_sec: f64,
}

impl MeasuredWindow {
    /// Builds a window, or `None` when the pair does not describe a real span.
    ///
    /// Surfaces validate their own arguments and refuse in their own words;
    /// this is the last guard, so an unusable pair can never reach a rule as a
    /// negative or infinite program length.
    pub fn new(start_sec: f64, end_sec: f64) -> Option<Self> {
        if !start_sec.is_finite() || !end_sec.is_finite() || end_sec <= start_sec {
            return None;
        }
        Some(Self { start_sec, end_sec })
    }

    /// Length of the window in seconds.
    pub fn duration_sec(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Returns the window clipped to a program that ends at `output_duration`.
    ///
    /// A caller may declare a window that runs past the end of the edit — the
    /// render then simply stops early — so the length a correct file is
    /// expected to have is the overlap, not the declaration.
    pub fn clipped_to(&self, output_duration_sec: f64) -> Self {
        if !output_duration_sec.is_finite() || output_duration_sec <= 0.0 {
            return *self;
        }
        Self {
            start_sec: self.start_sec.clamp(0.0, output_duration_sec),
            end_sec: self.end_sec.clamp(0.0, output_duration_sec),
        }
    }
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
    /// The timeline stretch the measured file holds, for a partial render
    ///
    /// `None` means the file is expected to be the whole output from timeline
    /// zero, which is what every rendered rule assumed before partial renders
    /// could be verified at all.
    pub measured_window: Option<MeasuredWindow>,
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
            measured_window: None,
        }
    }

    /// Attaches rendered measurements to this context.
    pub fn with_measurements(mut self, measurements: RenderMeasurements) -> Self {
        self.measurements = Some(measurements);
        self
    }

    /// Declares which timeline seconds the measured file holds.
    pub fn with_measured_window(mut self, window: Option<MeasuredWindow>) -> Self {
        self.measured_window = window;
        self
    }

    /// Returns the timeline span the measured file is graded against.
    ///
    /// The declared window clipped to the program for a partial render, and
    /// the whole output otherwise. Rules use it for both halves of the same
    /// question: how long the file should be, and which span a finding about
    /// "the program" covers.
    pub fn measured_span(&self, output_duration_sec: f64) -> (f64, f64) {
        match self.measured_window {
            Some(window) => {
                let clipped = window.clipped_to(output_duration_sec);
                (clipped.start_sec, clipped.end_sec)
            }
            None => (0.0, output_duration_sec),
        }
    }

    /// Returns the running time a correct file covering this run would have.
    pub fn expected_file_duration_sec(&self, output_duration_sec: f64) -> f64 {
        let (start, end) = self.measured_span(output_duration_sec);
        (end - start).max(0.0)
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

    /// Feature: Partial renders
    /// Scenario: should grade a whole-sequence run against the whole sequence
    #[test]
    fn test_context_without_a_window_spans_the_whole_output() {
        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let context = QCContext::from_sequence(&sequence);

        assert_eq!(context.measured_span(90.0), (0.0, 90.0));
        assert_eq!(context.expected_file_duration_sec(90.0), 90.0);
    }

    /// Feature: Partial renders
    /// Scenario: should grade a declared window against the window's length
    #[test]
    fn test_context_with_a_window_spans_only_the_window() {
        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let context = QCContext::from_sequence(&sequence)
            .with_measured_window(MeasuredWindow::new(10.0, 40.0));

        assert_eq!(context.measured_span(90.0), (10.0, 40.0));
        assert_eq!(context.expected_file_duration_sec(90.0), 30.0);
    }

    /// Feature: Partial renders
    /// Scenario: should expect only the seconds the edit actually has
    ///
    /// A caller may ask for more timeline than exists; the render stops at the
    /// end of the program, so the expected length is the overlap.
    #[test]
    fn test_window_is_clipped_to_the_program() {
        let sequence = Sequence::new("Test", SequenceFormat::youtube_1080());
        let context = QCContext::from_sequence(&sequence)
            .with_measured_window(MeasuredWindow::new(10.0, 40.0));

        assert_eq!(context.measured_span(25.0), (10.0, 25.0));
        assert_eq!(context.expected_file_duration_sec(25.0), 15.0);
    }

    /// Feature: Partial renders
    /// Scenario: should refuse a pair that describes no span
    #[test]
    fn test_window_rejects_a_pair_that_is_not_a_span() {
        assert!(MeasuredWindow::new(5.0, 2.0).is_none());
        assert!(MeasuredWindow::new(2.0, 2.0).is_none());
        assert!(MeasuredWindow::new(f64::NAN, 2.0).is_none());
        assert!(MeasuredWindow::new(0.0, f64::INFINITY).is_none());
        assert!(MeasuredWindow::new(0.0, 1.0).is_some());
    }
}
