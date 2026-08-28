//! The stretch of timeline one render covers, snapped to the output frame grid.
//!
//! An export can be asked for a range rather than for the whole sequence — the
//! preview cache asks for one per segment, and a range export asks for the one
//! the user selected. Historically that range was applied on the *output* side
//! of FFmpeg (`-ss` before the output file): the builder emitted the whole
//! timeline's graph, FFmpeg decoded it from zero and threw away everything
//! before the range.
//!
//! This type is the first half of turning that into a graph whose own clock
//! starts at the window. Every absolute timeline anchor the builder emits —
//! a black gap, an `adelay`, a caption's `enable` — is rebased through
//! [`RenderWindow::rebase`], and the segment that straddles the window's start
//! drops the frames in front of it. The result is a graph that begins at `t=0`
//! on the window's first frame, so no output-side seek is needed.
//!
//! # Why the bounds are snapped
//!
//! Every frame count in the render pipeline is `round(t * fps)` (see
//! [`clip_stream_frames`](super::transition_stitch::clip_stream_frames) and
//! `span_frames`). A window bound that does not sit on that grid would make the
//! head frame drop disagree with the fold arithmetic by up to a frame, and the
//! window would come out one frame out of phase. The caller is not trusted to
//! hand over a snapped bound — the preview cache computes one by subtracting a
//! transition reach that need not be a whole number of output frames — so the
//! snap happens here, against the *output* frame rate rather than the sequence's
//! (a preview profile overrides fps, and the graph is built at the override).

/// Fallback frame rate for a window whose caller supplied an unusable one.
///
/// Mirrors [`output_video_fps`](super::export::output_video_fps), which is the
/// only source this type is ever constructed from in the render path.
const FALLBACK_FPS: f64 = 30.0;

/// The frames of timeline one render writes, in output-frame coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct RenderWindow {
    /// First output frame of the window, counted from the timeline's origin.
    start_frame: i64,
    /// One past the last output frame of the window.
    end_frame: i64,
    /// Output frame rate the two counts were derived against.
    fps: f64,
    /// Whether the caller asked for a range at all.
    ///
    /// A render with no range gets a window covering the whole timeline *and*
    /// this flag cleared, which is what keeps a full export emitting the exact
    /// argument list and filtergraph it always has.
    ranged: bool,
}

impl RenderWindow {
    /// The window a render of `timeline_end_sec` over this range covers.
    ///
    /// `start_time`/`end_time` are the caller's request in timeline seconds;
    /// both `None` means the whole timeline. The range is clamped into the
    /// timeline and snapped to the output frame grid, and is guaranteed to be at
    /// least one frame long so the graph can never be asked for no picture.
    pub(super) fn resolve(
        timeline_end_sec: f64,
        start_time: Option<f64>,
        end_time: Option<f64>,
        fps: f64,
    ) -> Self {
        let fps = if fps.is_finite() && fps > 0.0 {
            fps
        } else {
            FALLBACK_FPS
        };
        let timeline_end_sec = if timeline_end_sec.is_finite() {
            timeline_end_sec.max(0.0)
        } else {
            0.0
        };
        let timeline_end_frame = (timeline_end_sec * fps).round() as i64;

        let ranged = start_time.is_some() || end_time.is_some();

        let requested_start = start_time.filter(|value| value.is_finite()).unwrap_or(0.0);
        let requested_end = end_time
            .filter(|value| value.is_finite())
            .unwrap_or(timeline_end_sec);

        let start_frame =
            ((requested_start.max(0.0) * fps).round() as i64).clamp(0, timeline_end_frame.max(0));
        let end_frame =
            ((requested_end.max(0.0) * fps).round() as i64).clamp(0, timeline_end_frame.max(0));

        // A window has to hold at least one frame: the whole graph downstream —
        // the concat, the black tail, `-t` — is written against a length that is
        // never zero, and an empty range would otherwise be answered with a file
        // holding no picture and no error.
        let end_frame = end_frame.max(start_frame + 1);

        Self {
            start_frame,
            end_frame,
            fps,
            ranged,
        }
    }

    /// Whether the caller asked for a range rather than the whole timeline.
    ///
    /// The builder shapes the graph to the window only when this is true, so a
    /// full export keeps producing the byte-identical arguments it always did.
    pub(super) fn is_ranged(&self) -> bool {
        self.ranged
    }

    /// First second of the window, on the output frame grid.
    pub(super) fn start_sec(&self) -> f64 {
        self.start_frame as f64 / self.fps
    }

    /// One frame past the last second of the window, on the output frame grid.
    pub(super) fn end_sec(&self) -> f64 {
        self.end_frame as f64 / self.fps
    }

    /// How long the render this window describes is, in seconds.
    pub(super) fn len_sec(&self) -> f64 {
        (self.end_frame - self.start_frame) as f64 / self.fps
    }

    /// How many output frames the render this window describes writes.
    pub(super) fn len_frames(&self) -> i64 {
        self.end_frame - self.start_frame
    }

    /// First output frame of the window, counted from the timeline's origin.
    pub(super) fn start_frame(&self) -> i64 {
        self.start_frame
    }

    /// Which output frame an absolute timeline position falls on.
    ///
    /// `round`, not `floor`, because every other frame count in the pipeline
    /// rounds — a floor here would disagree with the transition and composite
    /// folds by a frame on any boundary that is not already on the grid.
    pub(super) fn frame_at(&self, timeline_sec: f64) -> i64 {
        if !timeline_sec.is_finite() {
            return 0;
        }
        (timeline_sec * self.fps).round() as i64
    }

    /// An absolute timeline position expressed in window-local seconds.
    ///
    /// Negative for anything in front of the window, which is meaningful: an
    /// `enable` expression that started before the window is already true on its
    /// first frame, and the filter builders clamp such a bound themselves.
    pub(super) fn rebase(&self, timeline_sec: f64) -> f64 {
        timeline_sec - self.start_sec()
    }

    /// Whether an absolute timeline span contributes any frame to this window.
    ///
    /// Half-open in frames, matching how a span's frames are counted everywhere
    /// else: a clip whose last frame is the one before the window's first
    /// contributes nothing and is not "covered".
    pub(super) fn covers(&self, start_sec: f64, end_sec: f64) -> bool {
        let start = self.frame_at(start_sec);
        let end = self.frame_at(end_sec);
        end > self.start_frame && start < self.end_frame
    }

    /// The `-t` value for this window, formatted so it cannot round *up*.
    ///
    /// [`format_speed_number`](super::export::format_speed_number) rounds to six
    /// decimals, and rounding up can push the duration past the next frame's
    /// presentation time — `5/30` formats as `0.166667`, which is greater than
    /// the sixth frame's PTS of `0.1666666…`, so FFmpeg would write six frames
    /// where the window holds five. Truncating onto the same six-decimal grid
    /// can only ever move the bound *earlier*, and the nearest frame boundary
    /// below is a whole frame away, so nothing that belongs in the window is
    /// lost.
    pub(super) fn output_duration_arg(&self) -> String {
        let truncated = (self.len_sec() * 1_000_000.0).floor() / 1_000_000.0;
        super::export::format_speed_number(truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FPS: f64 = 30.0;

    /// Feature: Windowed render
    /// Scenario: a render with no range covers the whole timeline
    #[test]
    fn should_cover_the_whole_timeline_when_no_range_is_asked_for() {
        let window = RenderWindow::resolve(10.0, None, None, FPS);

        assert!(!window.is_ranged());
        assert_eq!(window.start_frame(), 0);
        assert_eq!(window.start_frame() + window.len_frames(), 300);
        assert!((window.len_sec() - 10.0).abs() < 1e-9);
        assert!((window.rebase(4.0) - 4.0).abs() < 1e-9);
    }

    /// Feature: Windowed render
    /// Scenario: an off-grid bound snaps onto the output frame grid
    ///
    /// The preview cache subtracts a transition reach that need not be a whole
    /// number of output frames, so the builder is handed half-frame bounds.
    #[test]
    fn should_snap_an_off_grid_bound_to_the_nearest_output_frame() {
        let window = RenderWindow::resolve(10.0, Some(2.017), Some(4.004), FPS);

        // 2.017 * 30 = 60.51 -> 61; 4.004 * 30 = 120.12 -> 120.
        assert_eq!(window.start_frame(), 61);
        assert_eq!(window.start_frame() + window.len_frames(), 120);
        assert!((window.start_sec() - 61.0 / 30.0).abs() < 1e-12);
        assert_eq!(window.len_frames(), 59);
    }

    /// Feature: Windowed render
    /// Scenario: a range is clamped into the timeline it is asked of
    #[test]
    fn should_clamp_a_range_that_reaches_past_the_timeline() {
        let window = RenderWindow::resolve(5.0, Some(-3.0), Some(40.0), FPS);

        assert_eq!(window.start_frame(), 0);
        assert_eq!(window.start_frame() + window.len_frames(), 150);
    }

    /// Feature: Windowed render
    /// Scenario: an empty range still holds a frame
    #[test]
    fn should_hold_at_least_one_frame_when_the_range_is_empty() {
        let window = RenderWindow::resolve(5.0, Some(2.0), Some(2.0), FPS);

        assert_eq!(window.len_frames(), 1);
    }

    /// Feature: Windowed render
    /// Scenario: the duration argument never rounds past the next frame
    #[test]
    fn should_format_a_duration_argument_that_cannot_gain_a_frame() {
        let window = RenderWindow::resolve(5.0, Some(0.0), Some(5.0 / 30.0), FPS);

        assert_eq!(window.len_frames(), 5);
        let formatted: f64 = window
            .output_duration_arg()
            .parse()
            .expect("the duration argument must be a number");
        assert!(
            formatted < 5.0 / 30.0,
            "a duration of {formatted} would let the sixth frame through"
        );
        assert!(
            formatted > 4.0 / 30.0,
            "a duration of {formatted} would drop the fifth frame"
        );
    }

    /// Feature: Windowed render
    /// Scenario: a span that ends on the window's first frame is outside it
    #[test]
    fn should_not_cover_a_span_that_ends_where_the_window_starts() {
        let window = RenderWindow::resolve(10.0, Some(2.0), Some(4.0), FPS);

        assert!(!window.covers(0.0, 2.0));
        assert!(window.covers(0.0, 2.5));
        assert!(!window.covers(4.0, 6.0));
        assert!(window.covers(3.5, 6.0));
    }
}
