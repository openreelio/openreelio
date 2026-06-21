//! Source-to-timeline caption segment mapping.
//!
//! Speech-to-text transcription produces segment times that are relative to a
//! *source asset* (0 = start of the media file). When those segments are
//! imported as captions, they must be placed on the *timeline*. If the source
//! clip has been trimmed, moved, or sped up, source-relative times no longer
//! line up with timeline-relative times, so importing raw source times causes
//! the captions to drift away from the spoken audio.
//!
//! This module provides [`map_source_segments_to_timeline`], the Rust mirror of
//! the TypeScript agent-layer `mapSourceSegmentsToTimeline` helper. Both the GUI
//! core and the headless CLI use it so every caption-import path applies the same
//! mapping.
//!
//! # Mapping formula
//!
//! For a forward clip with constant speed:
//!
//! ```text
//! timeline_sec = clip.place.timeline_in_sec
//!              + (source_sec - clip.range.source_in_sec) / safe_speed
//! ```
//!
//! For a reversed clip, source coordinates are mirrored across the clip's source
//! out-point:
//!
//! ```text
//! timeline_sec = clip.place.timeline_in_sec
//!              + (clip.range.source_out_sec - source_sec) / safe_speed
//! ```
//!
//! where `safe_speed = clip.speed` when positive, otherwise `1.0`.
//!
//! # Rules
//!
//! - Clips with an **active time remap curve** are rejected: a constant-speed
//!   formula cannot represent variable-speed playback. Callers should fall back
//!   to a sequence-level (already timeline-relative) transcription instead.
//! - Segments whose start time falls outside `[source_in_sec, source_out_sec)`
//!   are **skipped** (counted in [`SourceToTimelineMapping::skipped_out_of_range`]).
//! - A segment's mapped end is **clamped** to the clip's timeline extent so that
//!   transcription spillover past the clip's out-point does not drift.
//! - A segment that maps to a non-positive timeline duration is skipped.

use crate::core::commands::GeneratedCaptionSegment;
use crate::core::timeline::Clip;
use crate::core::{CoreError, CoreResult};

/// Result of mapping source-relative segments onto the timeline.
#[derive(Clone, Debug, Default)]
pub struct SourceToTimelineMapping {
    /// Segments whose times were rewritten to timeline coordinates.
    pub segments: Vec<GeneratedCaptionSegment>,
    /// Number of input segments dropped because they fell outside the clip
    /// source range or collapsed to a non-positive duration after clamping.
    pub skipped_out_of_range: usize,
}

/// Maps source-relative caption segments onto the timeline using the placement
/// of `clip`.
///
/// Mirrors the TypeScript `mapSourceSegmentsToTimeline` Phase 1 logic. See the
/// module documentation for the formula and the skip/clamp/reject rules.
///
/// # Errors
///
/// Returns [`CoreError::ValidationError`] when `clip` has an active time remap
/// curve, because a constant-speed mapping cannot represent variable speed.
pub fn map_source_segments_to_timeline(
    segments: &[GeneratedCaptionSegment],
    clip: &Clip,
) -> CoreResult<SourceToTimelineMapping> {
    if clip.has_time_remap() {
        return Err(CoreError::ValidationError(format!(
            "Clip '{}' has an active time remap curve, so source times cannot be mapped \
             with a constant-speed formula. Transcribe the sequence audio mix to obtain \
             timeline-relative segments instead.",
            clip.id
        )));
    }

    let safe_speed = if clip.speed > 0.0 {
        clip.speed as f64
    } else {
        1.0
    };
    let source_in = clip.range.source_in_sec;
    let source_out = clip.range.source_out_sec;
    let timeline_in = clip.place.timeline_in_sec;
    let mut mapped = Vec::with_capacity(segments.len());
    let mut skipped_out_of_range = 0usize;

    for segment in segments {
        // Drop segments whose start falls outside the clip's source window.
        if segment.start_sec < source_in || segment.start_sec >= source_out {
            skipped_out_of_range += 1;
            continue;
        }

        let start_source = segment.start_sec;
        let end_source = segment.end_sec.min(source_out);
        if end_source <= start_source {
            skipped_out_of_range += 1;
            continue;
        }

        let to_timeline = |source_sec: f64| -> f64 {
            if clip.reverse {
                timeline_in + (source_out - source_sec) / safe_speed
            } else {
                timeline_in + (source_sec - source_in) / safe_speed
            }
        };

        let (start_timeline, end_timeline) = if clip.reverse {
            (to_timeline(end_source), to_timeline(start_source))
        } else {
            (to_timeline(start_source), to_timeline(end_source))
        };

        // Skip cues that collapse to a non-positive timeline duration after the
        // clamp. `<=` avoids a negated partial-ord comparison and treats NaN as
        // a skip.
        if end_timeline <= start_timeline {
            skipped_out_of_range += 1;
            continue;
        }

        let mut rewritten = segment.clone();
        rewritten.start_sec = start_timeline;
        rewritten.end_sec = end_timeline;
        mapped.push(rewritten);
    }

    Ok(SourceToTimelineMapping {
        segments: mapped,
        skipped_out_of_range,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::timeline::{ClipPlace, ClipRange, TimeRemapCurve, TimeRemapKeyframe};

    /// Builds a caption-free source clip with the given placement and range.
    fn source_clip(
        timeline_in: f64,
        duration: f64,
        source_in: f64,
        source_out: f64,
        speed: f32,
    ) -> Clip {
        let mut clip = Clip::new("video-asset");
        clip.place = ClipPlace::new(timeline_in, duration);
        clip.range = ClipRange::new(source_in, source_out);
        clip.speed = speed;
        clip
    }

    #[test]
    fn maps_constant_speed_with_timeline_offset() {
        // Clip placed at timeline 10s, showing source [5s, 15s) at 1x speed.
        let clip = source_clip(10.0, 10.0, 5.0, 15.0, 1.0);
        let segments = vec![GeneratedCaptionSegment::new(6.0, 7.0, "Hello")];

        let result = map_source_segments_to_timeline(&segments, &clip).unwrap();

        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.skipped_out_of_range, 0);
        // source 6s -> timeline 10 + (6 - 5) = 11s.
        assert!((result.segments[0].start_sec - 11.0).abs() < 1e-9);
        assert!((result.segments[0].end_sec - 12.0).abs() < 1e-9);
        assert_eq!(result.segments[0].text, "Hello");
    }

    #[test]
    fn maps_with_non_unit_speed() {
        // 2x speed: 1s of source spans 0.5s of timeline.
        let clip = source_clip(0.0, 5.0, 0.0, 10.0, 2.0);
        let segments = vec![GeneratedCaptionSegment::new(4.0, 6.0, "Fast")];

        let result = map_source_segments_to_timeline(&segments, &clip).unwrap();

        assert_eq!(result.segments.len(), 1);
        // source 4s -> timeline 0 + 4/2 = 2.0s; source 6s -> 3.0s.
        assert!((result.segments[0].start_sec - 2.0).abs() < 1e-9);
        assert!((result.segments[0].end_sec - 3.0).abs() < 1e-9);
    }

    #[test]
    fn maps_reverse_clip_source_range_to_forward_timeline_interval() {
        // Reversed source [0s, 10s) placed at timeline 20s. Source 8..10 is the
        // first two seconds of playback and therefore maps to timeline 20..22.
        let mut clip = source_clip(20.0, 10.0, 0.0, 10.0, 1.0);
        clip.reverse = true;
        let segments = vec![GeneratedCaptionSegment::new(8.0, 10.0, "Reverse start")];

        let result = map_source_segments_to_timeline(&segments, &clip).unwrap();

        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.skipped_out_of_range, 0);
        assert!((result.segments[0].start_sec - 20.0).abs() < 1e-9);
        assert!((result.segments[0].end_sec - 22.0).abs() < 1e-9);
    }

    #[test]
    fn clamps_end_to_clip_timeline_extent() {
        // Source window [0s, 4s) at 1x, clip ends on timeline at 4s.
        let clip = source_clip(0.0, 4.0, 0.0, 4.0, 1.0);
        // Segment starts in range but spills past the source out-point.
        let segments = vec![GeneratedCaptionSegment::new(3.0, 9.0, "Spill")];

        let result = map_source_segments_to_timeline(&segments, &clip).unwrap();

        assert_eq!(result.segments.len(), 1);
        assert!((result.segments[0].start_sec - 3.0).abs() < 1e-9);
        // End clamped to the clip's timeline out-point (4.0), not 9.0.
        assert!((result.segments[0].end_sec - 4.0).abs() < 1e-9);
    }

    #[test]
    fn skips_segments_outside_source_range() {
        let clip = source_clip(0.0, 5.0, 5.0, 10.0, 1.0);
        let segments = vec![
            GeneratedCaptionSegment::new(2.0, 3.0, "Before"), // start < source_in
            GeneratedCaptionSegment::new(6.0, 7.0, "Inside"),
            GeneratedCaptionSegment::new(10.0, 11.0, "AtOut"), // start == source_out (excluded)
        ];

        let result = map_source_segments_to_timeline(&segments, &clip).unwrap();

        assert_eq!(result.segments.len(), 1);
        assert_eq!(result.skipped_out_of_range, 2);
        assert_eq!(result.segments[0].text, "Inside");
    }

    #[test]
    fn rejects_clip_with_active_time_remap() {
        let mut clip = source_clip(0.0, 5.0, 0.0, 10.0, 1.0);
        clip.time_remap = Some(TimeRemapCurve::new(vec![
            TimeRemapKeyframe {
                timeline_time: 0.0,
                source_time: 0.0,
                interpolation: Default::default(),
            },
            TimeRemapKeyframe {
                timeline_time: 5.0,
                source_time: 10.0,
                interpolation: Default::default(),
            },
        ]));

        let segments = vec![GeneratedCaptionSegment::new(1.0, 2.0, "Remap")];
        let err = map_source_segments_to_timeline(&segments, &clip).unwrap_err();
        assert!(matches!(err, CoreError::ValidationError(_)));
    }
}
