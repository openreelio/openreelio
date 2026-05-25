//! Canonical timeline clock helpers.
//!
//! Timeline state still stores seconds for compatibility, but render paths should
//! use this clock whenever they convert between user-facing time and frame
//! boundaries.

use crate::core::{Frame, Ratio, TimeSec};

const DEFAULT_FPS_NUM: i32 = 30;
const DEFAULT_FPS_DEN: i32 = 1;
const FRAME_ALIGNMENT_EPSILON_SEC: f64 = 1e-7;

/// Sequence clock backed by an exact rational frame rate.
#[derive(Clone, Debug, PartialEq)]
pub struct TimelineClock {
    fps: Ratio,
}

impl TimelineClock {
    /// Creates a clock from a frame-rate ratio. Invalid values fall back to 30fps.
    pub fn new(fps: Ratio) -> Self {
        if fps.num <= 0 || fps.den <= 0 {
            return Self {
                fps: Ratio::new(DEFAULT_FPS_NUM, DEFAULT_FPS_DEN),
            };
        }

        Self { fps }
    }

    /// Returns the exact frame-rate ratio.
    pub fn fps(&self) -> &Ratio {
        &self.fps
    }

    /// Returns the frame rate as seconds math needs it.
    pub fn frames_per_second(&self) -> f64 {
        self.fps.num as f64 / self.fps.den as f64
    }

    /// Converts seconds to the nearest integer frame.
    pub fn seconds_to_nearest_frame(&self, seconds: TimeSec) -> Frame {
        if !seconds.is_finite() {
            return 0;
        }

        ((seconds.max(0.0) * self.fps.num as f64) / self.fps.den as f64).round() as Frame
    }

    /// Converts seconds to the containing frame by flooring toward zero.
    pub fn seconds_to_floor_frame(&self, seconds: TimeSec) -> Frame {
        if !seconds.is_finite() {
            return 0;
        }

        ((seconds.max(0.0) * self.fps.num as f64) / self.fps.den as f64).floor() as Frame
    }

    /// Converts a frame index to seconds.
    pub fn frame_to_seconds(&self, frame: Frame) -> TimeSec {
        (frame.max(0) as f64 * self.fps.den as f64) / self.fps.num as f64
    }

    /// Snaps a second value to the nearest frame boundary.
    pub fn snap_seconds_to_frame(&self, seconds: TimeSec) -> TimeSec {
        self.frame_to_seconds(self.seconds_to_nearest_frame(seconds))
    }

    /// Returns true when a second value is already on a frame boundary.
    pub fn is_frame_aligned(&self, seconds: TimeSec) -> bool {
        if !seconds.is_finite() {
            return false;
        }

        (seconds - self.snap_seconds_to_frame(seconds)).abs() <= FRAME_ALIGNMENT_EPSILON_SEC
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_seconds_to_frames_at_integer_fps() {
        let clock = TimelineClock::new(Ratio::new(30, 1));

        assert_eq!(clock.seconds_to_nearest_frame(1.0), 30);
        assert_eq!(clock.frame_to_seconds(45), 1.5);
        assert!(clock.is_frame_aligned(1.5));
        assert!(!clock.is_frame_aligned(1.51));
    }

    #[test]
    fn preserves_fractional_ntsc_frame_rate() {
        let clock = TimelineClock::new(Ratio::new(30000, 1001));

        assert_eq!(clock.seconds_to_nearest_frame(1001.0 / 30000.0), 1);
        assert!((clock.frame_to_seconds(1) - (1001.0 / 30000.0)).abs() < 1e-12);
        assert!(clock.is_frame_aligned(1001.0 / 30000.0));
    }

    #[test]
    fn invalid_fps_falls_back_to_thirty() {
        let clock = TimelineClock::new(Ratio::new(0, 1));

        assert_eq!(clock.fps().num, 30);
        assert_eq!(clock.fps().den, 1);
        assert_eq!(clock.seconds_to_nearest_frame(1.0), 30);
    }
}
