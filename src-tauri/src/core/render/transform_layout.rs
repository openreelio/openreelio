//! Geometry for per-clip visual transforms in the final render.
//!
//! The preview draws a transformed clip onto a 2D canvas; the export draws the
//! same clip with an FFmpeg `scale` -> `rotate` -> `overlay` chain. Both have to
//! land the picture in the same place, so the placement arithmetic lives here,
//! once, as pure functions with no FFmpeg strings and no timeline traversal.
//!
//! # The contract shared with the preview
//!
//! `TimelinePreviewPlayer.drawVisualWithClipTransform` fits the source into the
//! canvas (`baseScale = min(canvasW / sourceW, canvasH / sourceH)`), multiplies
//! by the clip's scale, translates to `position * canvas`, rotates, and draws the
//! scaled image at `(-anchor.x * scaledW, -anchor.y * scaledH)`.
//!
//! Two consequences fall out of that draw call, and both are load-bearing here:
//!
//! 1. The **anchor**, not the picture's centre, is what `position` pins to the
//!    canvas. `anchor = (0, 0)` puts the picture's top-left corner at `position`.
//! 2. Rotation happens about that same anchor point, because the canvas rotates
//!    the coordinate system before the image is drawn into it.
//!
//! FFmpeg has no notion of an anchor: `rotate` spins about the input's centre and
//! `overlay` positions by top-left corner. Bridging the two is the whole job of
//! [`compute_clip_transform_layout`] — it rotates the centre-relative-to-anchor
//! offset by the same angle and folds the result into the overlay corner.
//!
//! # Coordinate conventions
//!
//! Canvas Y grows downward, and a positive angle is a clockwise turn on screen.
//! Both `ctx.rotate` and FFmpeg's `rotate` filter agree on this, so the same
//! matrix serves both:
//!
//! ```text
//! R(t) * (x, y) = (x*cos(t) - y*sin(t), x*sin(t) + y*cos(t))
//! ```

use crate::core::timeline::{Clip, KeyframeInterpolation, Transform};
use crate::core::Point2D;

/// Smallest scale factor a clip may render at.
///
/// Mirrors the clamp `SetClipTransformCommand::sanitize_transform` applies, so a
/// transform that arrived through a command and one that arrived by editing
/// project JSON by hand render identically.
const MIN_SCALE: f64 = 0.01;

/// Largest scale factor a clip may render at. Also mirrors the command clamp.
const MAX_SCALE: f64 = 100.0;

/// Video filters and encoders want even dimensions at every stage of the graph.
const DIMENSION_ALIGNMENT: f64 = 2.0;

/// Hard ceiling on any intermediate frame dimension.
///
/// This is FFmpeg's own limit; the canvas-relative cap below bites long before
/// it does, so this only backstops arithmetic that went somewhere unexpected.
const MAX_DIMENSION: f64 = 32_766.0;

/// How much larger than the canvas diagonal a scaled frame is allowed to get.
///
/// Once a frame is this big, every extra pixel is off-canvas no matter where the
/// anchor puts it: the canvas diagonal bounds the distance from any on-screen
/// point to any canvas corner, so a frame twice that across already covers the
/// canvas from any placement the layout can produce. Letting the scale run free
/// instead costs real memory — `scale=17` on 1080p is already ~900 MB a frame.
const MAX_CANVAS_DIAGONAL_MULTIPLE: f64 = 2.0;

/// Below this the rotation is a no-op and the graph omits the `rotate` filter.
const ROTATION_EPSILON_RAD: f64 = 1e-9;

/// Below this the clip is fully opaque and the graph omits the alpha filter.
const OPACITY_EPSILON: f64 = 1e-4;

/// Trig results this close to zero are floating-point residue of a right angle.
///
/// `cos(PI / 2)` is 6.1e-17, not 0. Left alone that residue rounds a quarter
/// turn's bounding box up by a whole pixel and drags the overlay corner with it,
/// so a clip that should sit flush ends up a pixel off.
const TRIG_SNAP_EPSILON: f64 = 1e-12;

/// Slack allowed when rounding a bounding box up, in pixels.
///
/// Ceiling an exact dimension that arrived a whisker above itself would add two
/// pixels of transparent margin. A micron of tolerance costs no coverage.
const DIMENSION_CEIL_TOLERANCE: f64 = 1e-6;

/// Where and how large a transformed clip renders on the output canvas.
///
/// Every field is already rounded to what FFmpeg will actually be told, so the
/// overlay position is computed against the *rounded* frame sizes rather than
/// against the ideal ones. That keeps the composite self-consistent even when
/// even-alignment nudges a dimension by a pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ClipTransformLayout {
    /// Width the source is scaled to before rotation (even, >= 2).
    pub scaled_width: u32,
    /// Height the source is scaled to before rotation (even, >= 2).
    pub scaled_height: u32,
    /// Clockwise rotation in radians. Zero when the clip is not rotated.
    pub rotation_rad: f64,
    /// Width of the axis-aligned box the rotated frame needs (even).
    pub bounding_width: u32,
    /// Height of the axis-aligned box the rotated frame needs (even).
    pub bounding_height: u32,
    /// X of the frame's top-left corner on the canvas. May be negative.
    pub overlay_x: i32,
    /// Y of the frame's top-left corner on the canvas. May be negative.
    pub overlay_y: i32,
    /// Alpha the frame composites with, clamped to `0.0..=1.0`.
    pub opacity: f64,
}

impl ClipTransformLayout {
    /// Whether the graph needs a `rotate` filter for this clip.
    pub(super) fn is_rotated(&self) -> bool {
        self.rotation_rad.abs() > ROTATION_EPSILON_RAD
    }

    /// Whether the graph needs an alpha filter for this clip.
    pub(super) fn is_translucent(&self) -> bool {
        self.opacity < 1.0 - OPACITY_EPSILON
    }
}

/// Places a transformed clip on the output canvas.
///
/// `source_width`/`source_height` are the pixel dimensions of the decoded media,
/// which is what the preview measures too. Non-finite or out-of-range transform
/// components fall back to their identity values with a warning rather than
/// poisoning the filtergraph with `NaN`.
pub(super) fn compute_clip_transform_layout(
    source_width: u32,
    source_height: u32,
    canvas_width: u32,
    canvas_height: u32,
    transform: &Transform,
    opacity: f32,
) -> ClipTransformLayout {
    let source_width = f64::from(source_width.max(1));
    let source_height = f64::from(source_height.max(1));
    let canvas_width = f64::from(canvas_width.max(1));
    let canvas_height = f64::from(canvas_height.max(1));

    // The preview fits the source inside the canvas before applying the clip's
    // own scale, so an identity transform is a letterboxed fit and nothing else.
    let base_scale = contain_fit_scale(source_width, source_height, canvas_width, canvas_height);

    let scale_x = sanitize_scale(transform.scale.x, "scale.x");
    let scale_y = sanitize_scale(transform.scale.y, "scale.y");

    let (scaled_width, scaled_height) = scaled_frame_dimensions(
        source_width,
        source_height,
        canvas_width,
        canvas_height,
        base_scale,
        scale_x,
        scale_y,
    );

    let rotation_deg = sanitize_finite(transform.rotation_deg, 0.0, "rotation");
    let rotation_rad = rotation_deg.to_radians();
    let (sin, cos) = if rotation_rad.abs() > ROTATION_EPSILON_RAD {
        let (sin, cos) = rotation_rad.sin_cos();
        (snap_trig(sin), snap_trig(cos))
    } else {
        (0.0, 1.0)
    };

    // The axis-aligned box a rotated rectangle sweeps out. `rotate` is told these
    // as `ow`/`oh`, so nothing gets clipped by its own rotation.
    let width = f64::from(scaled_width);
    let height = f64::from(scaled_height);
    let bounding_width = align_dimension_up((width * cos).abs() + (height * sin).abs());
    let bounding_height = align_dimension_up((width * sin).abs() + (height * cos).abs());

    let anchor_x = sanitize_normalized(transform.anchor.x, "anchor.x");
    let anchor_y = sanitize_normalized(transform.anchor.y, "anchor.y");
    let position_x = sanitize_normalized(transform.position.x, "position.x");
    let position_y = sanitize_normalized(transform.position.y, "position.y");

    // Offset from the anchor to the picture's centre, in the clip's own
    // (unrotated) frame. The canvas rotates around the anchor, so this offset
    // rotates with the picture.
    let centre_from_anchor_x = (0.5 - anchor_x) * width;
    let centre_from_anchor_y = (0.5 - anchor_y) * height;
    let rotated_x = centre_from_anchor_x * cos - centre_from_anchor_y * sin;
    let rotated_y = centre_from_anchor_x * sin + centre_from_anchor_y * cos;

    // `rotate` keeps the input centre at the output centre, and `overlay` places
    // by top-left corner, so the corner is the picture centre less half the box.
    //
    // The corner is snapped to an even pixel because `overlay` in a chroma-
    // subsampled format floors both offsets to the subsampling grid anyway
    // (x=101 lands at 100, x=-51 at -52). Rounding here makes the number the
    // graph carries the number FFmpeg acts on, so the placement error is a
    // symmetric half-pixel instead of a one-sided whole one.
    let centre_x = position_x * canvas_width + rotated_x;
    let centre_y = position_y * canvas_height + rotated_y;
    let overlay_x = round_to_even_i32(centre_x - f64::from(bounding_width) / 2.0);
    let overlay_y = round_to_even_i32(centre_y - f64::from(bounding_height) / 2.0);

    ClipTransformLayout {
        scaled_width,
        scaled_height,
        rotation_rad: if rotation_rad.abs() > ROTATION_EPSILON_RAD {
            rotation_rad
        } else {
            0.0
        },
        bounding_width,
        bounding_height,
        overlay_x,
        overlay_y,
        opacity: sanitize_opacity(opacity),
    }
}

/// The contain-fit factor that maps the source onto the canvas at scale 1.
///
/// Shared by the static layout and the animated one so an identity transform is
/// a letterboxed fit in both.
fn contain_fit_scale(
    source_width: f64,
    source_height: f64,
    canvas_width: f64,
    canvas_height: f64,
) -> f64 {
    let base_scale = (canvas_width / source_width).min(canvas_height / source_height);
    if base_scale.is_finite() && base_scale > 0.0 {
        base_scale
    } else {
        warn_fallback("base scale", base_scale);
        1.0
    }
}

/// The even pixel dimensions a clip's picture is scaled to before rotation.
///
/// Both axes shrink by the same factor when the frame is too big to render,
/// because clamping them independently would silently restretch the picture: a
/// 100x scale on 16:9 would come out square.
fn scaled_frame_dimensions(
    source_width: f64,
    source_height: f64,
    canvas_width: f64,
    canvas_height: f64,
    base_scale: f64,
    scale_x: f64,
    scale_y: f64,
) -> (u32, u32) {
    let ideal_width = source_width * base_scale * scale_x;
    let ideal_height = source_height * base_scale * scale_y;
    let shrink = uniform_shrink(
        ideal_width,
        ideal_height,
        frame_dimension_limit(canvas_width, canvas_height),
    );
    (
        align_dimension(ideal_width * shrink),
        align_dimension(ideal_height * shrink),
    )
}

fn sanitize_scale(value: f64, field: &str) -> f64 {
    if !value.is_finite() {
        warn_fallback(field, value);
        return 1.0;
    }
    value.clamp(MIN_SCALE, MAX_SCALE)
}

fn sanitize_normalized(value: f64, field: &str) -> f64 {
    if !value.is_finite() {
        warn_fallback(field, value);
        return 0.5;
    }
    value.clamp(0.0, 1.0)
}

fn sanitize_finite(value: f64, fallback: f64, field: &str) -> f64 {
    if value.is_finite() {
        value
    } else {
        warn_fallback(field, value);
        fallback
    }
}

fn sanitize_opacity(opacity: f32) -> f64 {
    let opacity = f64::from(opacity);
    if !opacity.is_finite() {
        warn_fallback("opacity", opacity);
        return 1.0;
    }
    opacity.clamp(0.0, 1.0)
}

fn warn_fallback(field: &str, value: f64) {
    tracing::warn!(
        field,
        value,
        "Clip transform component is not finite; rendering with its identity value"
    );
}

/// Rounds to the nearest even pixel count within the renderable range.
fn align_dimension(value: f64) -> u32 {
    align_with(value, f64::round)
}

/// Rounds up to the next even pixel count within the renderable range.
fn align_dimension_up(value: f64) -> u32 {
    align_with(value - DIMENSION_CEIL_TOLERANCE, f64::ceil)
}

fn snap_trig(value: f64) -> f64 {
    if value.abs() < TRIG_SNAP_EPSILON {
        0.0
    } else {
        value
    }
}

fn align_with(value: f64, round: fn(f64) -> f64) -> u32 {
    if !value.is_finite() {
        warn_fallback("dimension", value);
        return DIMENSION_ALIGNMENT as u32;
    }
    let aligned = round(value / DIMENSION_ALIGNMENT) * DIMENSION_ALIGNMENT;
    aligned.clamp(DIMENSION_ALIGNMENT, MAX_DIMENSION) as u32
}

/// The largest a scaled frame may get before the extra pixels are all off-canvas.
fn frame_dimension_limit(canvas_width: f64, canvas_height: f64) -> f64 {
    let diagonal = canvas_width.hypot(canvas_height);
    if !diagonal.is_finite() || diagonal <= 0.0 {
        return MAX_DIMENSION;
    }
    (diagonal * MAX_CANVAS_DIAGONAL_MULTIPLE).clamp(DIMENSION_ALIGNMENT, MAX_DIMENSION)
}

/// The single factor that brings both axes inside `limit` without reshaping them.
fn uniform_shrink(width: f64, height: f64, limit: f64) -> f64 {
    let mut factor = 1.0_f64;
    for extent in [width, height] {
        if extent.is_finite() && extent > limit {
            factor = factor.min(limit / extent);
        }
    }
    if factor.is_finite() && factor > 0.0 {
        factor
    } else {
        1.0
    }
}

fn round_to_even_i32(value: f64) -> i32 {
    if !value.is_finite() {
        warn_fallback("overlay offset", value);
        return 0;
    }
    let even = (value / DIMENSION_ALIGNMENT).round() * DIMENSION_ALIGNMENT;
    even.clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

// =============================================================================
// Animated motion
// =============================================================================

/// One motion keyframe resolved to the geometry the graph animates through.
///
/// The frame dimensions are the *same* numbers [`compute_clip_transform_layout`]
/// would emit for this keyframe's transform, so an animated clip and a clip
/// pinned at one of its keyframes agree exactly at that instant.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct MotionKeyframeLayout {
    /// Seconds from the start of the clip's *branch*, head handle included.
    pub time_sec: f64,
    /// Width the source is scaled to at this keyframe (even, >= 2).
    pub scaled_width: u32,
    /// Height the source is scaled to at this keyframe (even, >= 2).
    pub scaled_height: u32,
    /// Sanitised normalised position the anchor is pinned to.
    pub position_x: f64,
    pub position_y: f64,
    /// Sanitised normalised anchor point.
    pub anchor_x: f64,
    pub anchor_y: f64,
    /// Clockwise rotation in radians at this keyframe.
    pub rotation_rad: f64,
    /// Whether the segment that *starts* here holds instead of interpolating.
    pub hold: bool,
}

/// A clip's motion keyframes resolved against one canvas.
///
/// Empty-keyframe clips never produce one of these: they are static by
/// definition and take the ordinary layout path.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct ClipMotionTrack {
    pub keyframes: Vec<MotionKeyframeLayout>,
}

/// Whether a clip's motion keyframes are motion this render can animate.
///
/// This is the single predicate behind all three decisions that have to agree:
/// whether the clip is composited at all, whether the composite is the animated
/// one, and whether the export warns that the motion is not rendered. It reads
/// only the stored transforms, so it needs no canvas or source dimensions and
/// validation can ask it as cheaply as the graph builder can.
///
/// Motion qualifies when it has at least two usable keyframes, those keyframes
/// actually move the picture, and none of them turns it. Rotation is excluded
/// because `rotate` never re-configures when its input size changes: an animated
/// `scale` feeding it freezes the picture at its first frame's size, silently.
/// Such a clip keeps the static composite and the warning that goes with it.
pub(super) fn clip_motion_renders_animated(clip: &Clip) -> bool {
    let keyframes = sorted_valid_motion_keyframes(clip);
    let Some((_, first, _)) = keyframes.first() else {
        return false;
    };
    if keyframes.len() < 2 {
        return false;
    }
    if keyframes
        .iter()
        .any(|(_, transform, _)| transform.rotation_deg.abs() > f64::EPSILON)
    {
        return false;
    }
    keyframes.iter().any(|(_, transform, _)| {
        (transform.position.x - first.position.x).abs() > f64::EPSILON
            || (transform.position.y - first.position.y).abs() > f64::EPSILON
            || (transform.scale.x - first.scale.x).abs() > f64::EPSILON
            || (transform.scale.y - first.scale.y).abs() > f64::EPSILON
            || (transform.anchor.x - first.anchor.x).abs() > f64::EPSILON
            || (transform.anchor.y - first.anchor.y).abs() > f64::EPSILON
    })
}

/// The alpha a clip composites with, sanitised the way the static layout does.
///
/// The animated path has no [`ClipTransformLayout`] to read `opacity` off, but it
/// still has to attenuate on exactly the same terms, so both go through this.
pub(super) fn render_opacity(opacity: f32) -> f64 {
    sanitize_opacity(opacity)
}

/// Whether that alpha is far enough from opaque to be worth a filter.
pub(super) fn opacity_needs_alpha_filter(opacity: f64) -> bool {
    opacity < 1.0 - OPACITY_EPSILON
}

/// Normalises a keyframe transform the way the preview does.
///
/// Mirrors `normalizeTransform` in `src/utils/clipMotion.ts`: every component
/// falls back to its identity when it is not finite, and scale additionally has
/// a lower clamp. Deliberately *not* the export's own sanitiser — this is the
/// transform the preview shows, and the export's clamps are applied afterwards
/// by the layout stage, exactly as they are for a static `clip.transform`.
fn normalize_motion_transform(transform: &Transform) -> Transform {
    Transform {
        position: Point2D {
            x: finite_or(transform.position.x, 0.5),
            y: finite_or(transform.position.y, 0.5),
        },
        scale: Point2D {
            x: finite_or(transform.scale.x, 1.0).max(MIN_SCALE),
            y: finite_or(transform.scale.y, 1.0).max(MIN_SCALE),
        },
        rotation_deg: finite_or(transform.rotation_deg, 0.0),
        anchor: Point2D {
            x: finite_or(transform.anchor.x, 0.5),
            y: finite_or(transform.anchor.y, 0.5),
        },
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// A clip's motion keyframes, filtered and ordered the way the preview reads them.
///
/// Mirrors `sortedValidKeyframes` in `src/utils/clipMotion.ts`: a keyframe with a
/// non-finite or negative `timeOffset` is dropped, and the rest are sorted by
/// time. The sort is stable, so keyframes sharing a time keep their stored order
/// just as `Array.prototype.sort` keeps it.
fn sorted_valid_motion_keyframes(clip: &Clip) -> Vec<(f64, Transform, bool)> {
    let mut keyframes: Vec<(f64, Transform, bool)> = clip
        .motion_keyframes
        .iter()
        .filter(|keyframe| keyframe.time_offset.is_finite() && keyframe.time_offset >= 0.0)
        .map(|keyframe| {
            (
                keyframe.time_offset,
                normalize_motion_transform(&keyframe.transform),
                matches!(keyframe.interpolation, KeyframeInterpolation::Hold),
            )
        })
        .collect();
    keyframes.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    keyframes
}

/// The transform the preview shows for a clip at `clip_time_sec` into it.
///
/// This is the executable specification the emitted FFmpeg expression is checked
/// against, not a step the render itself takes: the graph carries a closed-form
/// piecewise-linear expression instead of sampling per frame. It exists so the
/// two can be compared at arbitrary times — see
/// `the_emitted_curve_tracks_the_preview_sampler`.
///
/// The Rust twin of `getClipMotionTransformAtTime` in `src/utils/clipMotion.ts`,
/// down to the clamp-hold outside the keyframe range and the linear blend
/// between them. `clip_time_sec` is clip-relative *timeline* seconds — the
/// preview computes it as `max(0, timelineTime - clip.place.timelineInSec)`.
///
/// Note that only `Hold` short-circuits: a `Bezier` keyframe interpolates
/// linearly, because the preview compares against the literal string `'hold'`
/// and lets every other interpolation fall through to `interpolateTransform`.
#[cfg(test)]
pub(super) fn clip_motion_transform_at(clip: &Clip, clip_time_sec: f64) -> Transform {
    let keyframes = sorted_valid_motion_keyframes(clip);
    let Some((first_time, first_transform, _)) = keyframes.first() else {
        return normalize_motion_transform(&clip.transform);
    };

    let clip_time = clip_time_sec.max(0.0);
    if clip_time <= *first_time {
        return first_transform.clone();
    }

    let (last_time, last_transform, _) = &keyframes[keyframes.len() - 1];
    if clip_time >= *last_time {
        return last_transform.clone();
    }

    for window in keyframes.windows(2) {
        let (start_time, start_transform, hold) = &window[0];
        let (end_time, end_transform, _) = &window[1];
        if clip_time < *start_time || clip_time > *end_time {
            continue;
        }
        if *hold {
            return start_transform.clone();
        }
        let duration = end_time - start_time;
        let progress = if duration > 0.0 {
            (clip_time - start_time) / duration
        } else {
            0.0
        };
        return interpolate_transform(start_transform, end_transform, progress);
    }

    normalize_motion_transform(&clip.transform)
}

/// Blends two transforms component-wise.
///
/// Mirrors `interpolateTransform`: every scalar is a plain linear blend and the
/// progress is clamped to `0..=1`. Rotation blends in degrees without taking the
/// shortest way round, so 350 -> 10 sweeps backwards through zero in the export
/// exactly as it does in the preview.
#[cfg(test)]
fn interpolate_transform(start: &Transform, end: &Transform, progress: f64) -> Transform {
    let progress = progress.clamp(0.0, 1.0);
    let lerp = |from: f64, to: f64| from + (to - from) * progress;
    Transform {
        position: Point2D {
            x: lerp(start.position.x, end.position.x),
            y: lerp(start.position.y, end.position.y),
        },
        scale: Point2D {
            x: lerp(start.scale.x, end.scale.x),
            y: lerp(start.scale.y, end.scale.y),
        },
        rotation_deg: lerp(start.rotation_deg, end.rotation_deg),
        anchor: Point2D {
            x: lerp(start.anchor.x, end.anchor.x),
            y: lerp(start.anchor.y, end.anchor.y),
        },
    }
}

/// Resolves a clip's motion keyframes into per-keyframe render geometry.
///
/// `head_sec` is the transition handle in front of the clip. The graph measures
/// time from the start of the *branch* — `build_video_trim_filter` ends every
/// branch with `setpts=PTS-STARTPTS` — and the branch starts `head_sec` before
/// the clip does, so every keyframe time shifts by it. This is the same move
/// `anchor_auto_reframe_keyframes` makes for the auto-reframe crop expression.
///
/// Returns `None` for a clip with no usable keyframes, which is the signal to
/// take the ordinary static layout path.
pub(super) fn resolve_clip_motion_track(
    source_width: u32,
    source_height: u32,
    canvas_width: u32,
    canvas_height: u32,
    clip: &Clip,
    head_sec: f64,
) -> Option<ClipMotionTrack> {
    let keyframes = sorted_valid_motion_keyframes(clip);
    if keyframes.is_empty() {
        return None;
    }

    let source_width = f64::from(source_width.max(1));
    let source_height = f64::from(source_height.max(1));
    let canvas_width = f64::from(canvas_width.max(1));
    let canvas_height = f64::from(canvas_height.max(1));
    let base_scale = contain_fit_scale(source_width, source_height, canvas_width, canvas_height);
    let head_sec = if head_sec.is_finite() && head_sec > 0.0 {
        head_sec
    } else {
        0.0
    };

    let resolved = keyframes
        .into_iter()
        .map(|(time_offset, transform, hold)| {
            let (scaled_width, scaled_height) = scaled_frame_dimensions(
                source_width,
                source_height,
                canvas_width,
                canvas_height,
                base_scale,
                sanitize_scale(transform.scale.x, "scale.x"),
                sanitize_scale(transform.scale.y, "scale.y"),
            );
            MotionKeyframeLayout {
                time_sec: time_offset + head_sec,
                scaled_width,
                scaled_height,
                position_x: sanitize_normalized(transform.position.x, "position.x"),
                position_y: sanitize_normalized(transform.position.y, "position.y"),
                anchor_x: sanitize_normalized(transform.anchor.x, "anchor.x"),
                anchor_y: sanitize_normalized(transform.anchor.y, "anchor.y"),
                rotation_rad: sanitize_finite(transform.rotation_deg, 0.0, "rotation").to_radians(),
                hold,
            }
        })
        .collect();

    Some(ClipMotionTrack {
        keyframes: resolved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Point2D;

    const CANVAS_W: u32 = 1920;
    const CANVAS_H: u32 = 1080;

    /// A 16:9 source fills a 16:9 canvas exactly, which keeps the hand-computed
    /// expectations below free of letterbox arithmetic.
    const SOURCE_W: u32 = 1280;
    const SOURCE_H: u32 = 720;

    fn layout(transform: Transform, opacity: f32) -> ClipTransformLayout {
        compute_clip_transform_layout(SOURCE_W, SOURCE_H, CANVAS_W, CANVAS_H, &transform, opacity)
    }

    /// Feature: Transform layout
    /// Scenario: an untouched clip fills the canvas the way the old graph did
    #[test]
    fn should_fill_the_canvas_when_the_transform_is_identity() {
        let result = layout(Transform::default(), 1.0);

        // baseScale = min(1920/1280, 1080/720) = 1.5 -> 1920x1080 at the origin.
        assert_eq!(result.scaled_width, 1920);
        assert_eq!(result.scaled_height, 1080);
        assert_eq!(result.bounding_width, 1920);
        assert_eq!(result.bounding_height, 1080);
        assert_eq!(result.overlay_x, 0);
        assert_eq!(result.overlay_y, 0);
        assert!(!result.is_rotated());
        assert!(!result.is_translucent());
    }

    /// Feature: Transform layout
    /// Scenario: a letterboxed source keeps its aspect ratio
    #[test]
    fn should_letterbox_a_source_narrower_than_the_canvas() {
        // 4:3 into 16:9: baseScale = min(1920/640, 1080/480) = 2.25 -> 1440x1080,
        // centred, so 240px of black either side.
        let result =
            compute_clip_transform_layout(640, 480, CANVAS_W, CANVAS_H, &Transform::default(), 1.0);

        assert_eq!(result.scaled_width, 1440);
        assert_eq!(result.scaled_height, 1080);
        assert_eq!(result.overlay_x, 240);
        assert_eq!(result.overlay_y, 0);
    }

    /// Feature: Transform layout
    /// Scenario: moving a clip shifts it by the same fraction of the canvas
    #[test]
    fn should_translate_by_the_normalized_position_delta() {
        let transform = Transform {
            position: Point2D::new(0.25, 0.75),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // Centre moves to (480, 810); the frame is still 1920x1080.
        assert_eq!(result.scaled_width, 1920);
        assert_eq!(result.scaled_height, 1080);
        assert_eq!(result.overlay_x, 480 - 960);
        assert_eq!(result.overlay_y, 810 - 540);
    }

    /// Feature: Transform layout
    /// Scenario: a half-scale clip stays centred on the canvas
    #[test]
    fn should_keep_a_half_scale_clip_centred() {
        let transform = Transform {
            scale: Point2D::new(0.5, 0.5),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        assert_eq!(result.scaled_width, 960);
        assert_eq!(result.scaled_height, 540);
        assert_eq!(result.overlay_x, 960 - 480);
        assert_eq!(result.overlay_y, 540 - 270);
    }

    /// Feature: Transform layout
    /// Scenario: a quarter-turn about the centre swaps the frame's extents
    #[test]
    fn should_swap_extents_for_a_quarter_turn_about_the_centre() {
        let transform = Transform {
            rotation_deg: 90.0,
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // The picture is still scaled to 1920x1080; its bounding box is 1080x1920.
        assert_eq!(result.scaled_width, 1920);
        assert_eq!(result.scaled_height, 1080);
        assert_eq!(result.bounding_width, 1080);
        assert_eq!(result.bounding_height, 1920);
        // Rotating about the centre leaves the centre where it was.
        assert_eq!(result.overlay_x, 960 - 540);
        assert_eq!(result.overlay_y, 540 - 960);
        assert!(result.is_rotated());
    }

    /// Feature: Transform layout
    /// Scenario: rotation pivots about the anchor, not about the picture centre
    ///
    /// With the anchor at the top-left corner and the position at the canvas
    /// centre, that corner stays pinned at (960, 540) and the picture swings
    /// clockwise below and to the left of it.
    #[test]
    fn should_pivot_about_a_corner_anchor() {
        let transform = Transform {
            anchor: Point2D::new(0.0, 0.0),
            scale: Point2D::new(0.5, 0.5),
            rotation_deg: 90.0,
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // Scaled frame is 960x540; its bounding box after a quarter turn is 540x960.
        assert_eq!(result.scaled_width, 960);
        assert_eq!(result.scaled_height, 540);
        assert_eq!(result.bounding_width, 540);
        assert_eq!(result.bounding_height, 960);

        // Centre-from-anchor is (480, 270) unrotated. A clockwise quarter turn
        // sends (x, y) to (-y, x), so it becomes (-270, 480): the picture centre
        // lands at (960 - 270, 540 + 480) = (690, 1020).
        assert_eq!(result.overlay_x, 690 - 270);
        assert_eq!(result.overlay_y, 1020 - 480);
    }

    /// Feature: Transform layout
    /// Scenario: a 45 degree turn needs a bounding box wider than the picture
    #[test]
    fn should_size_the_bounding_box_for_a_diagonal_turn() {
        let transform = Transform {
            scale: Point2D::new(0.5, 0.5),
            rotation_deg: 45.0,
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // 960x540 turned 45 degrees: (960 + 540) / sqrt(2) = 1060.66 both ways,
        // rounded up to the next even pixel.
        assert_eq!(result.scaled_width, 960);
        assert_eq!(result.scaled_height, 540);
        assert_eq!(result.bounding_width, 1062);
        assert_eq!(result.bounding_height, 1062);
        // Rotation about the centre anchor keeps the centre at the canvas centre.
        // The ideal corner is (429, 9); both snap up to the next even pixel.
        assert_eq!(result.overlay_x, 430);
        assert_eq!(result.overlay_y, 10);
    }

    /// Feature: Transform layout
    /// Scenario: non-uniform scale and rotation compose without losing either
    #[test]
    fn should_compose_non_uniform_scale_with_rotation() {
        let transform = Transform {
            scale: Point2D::new(0.5, 0.25),
            rotation_deg: 90.0,
            position: Point2D::new(0.25, 0.5),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // 1920*0.5 x 1080*0.25 = 960x270, quarter-turned to a 270x960 box.
        assert_eq!(result.scaled_width, 960);
        assert_eq!(result.scaled_height, 270);
        assert_eq!(result.bounding_width, 270);
        assert_eq!(result.bounding_height, 960);
        // Centre anchor, so the picture centre sits at (0.25 * 1920, 540). The
        // ideal corner x is 345, which snaps up to the next even pixel.
        assert_eq!(result.overlay_x, 346);
        assert_eq!(result.overlay_y, 540 - 480);
    }

    /// Feature: Transform layout
    /// Scenario: opacity is carried through and clamped
    #[test]
    fn should_clamp_opacity_into_the_renderable_range() {
        assert!((layout(Transform::default(), 0.5).opacity - 0.5).abs() < 1e-9);
        assert!((layout(Transform::default(), 2.0).opacity - 1.0).abs() < 1e-9);
        assert!((layout(Transform::default(), -1.0).opacity - 0.0).abs() < 1e-9);
        assert!(layout(Transform::default(), 0.5).is_translucent());
        assert!(!layout(Transform::default(), 1.0).is_translucent());
    }

    /// Feature: Transform layout
    /// Scenario: a corrupt transform renders as identity instead of poisoning the graph
    ///
    /// Commands sanitize these, but a project file edited by hand does not go
    /// through a command. `NaN` reaching the filtergraph would make FFmpeg fail
    /// on a string it cannot parse.
    #[test]
    fn should_fall_back_to_identity_for_non_finite_components() {
        let transform = Transform {
            scale: Point2D::new(f64::NAN, f64::INFINITY),
            rotation_deg: f64::NAN,
            position: Point2D::new(f64::NAN, 0.5),
            anchor: Point2D::new(0.5, f64::NEG_INFINITY),
        };

        let result = layout(transform, f32::NAN);

        assert_eq!(result.scaled_width, 1920);
        assert_eq!(result.scaled_height, 1080);
        assert_eq!(result.overlay_x, 0);
        assert_eq!(result.overlay_y, 0);
        assert!(!result.is_rotated());
        assert!(!result.is_translucent());
    }

    /// Feature: Transform layout
    /// Scenario: an absurd scale is clamped without reshaping the picture
    ///
    /// Clamping each axis at its own ceiling used to turn a 16:9 source square,
    /// so a 100x zoom rendered stretched as well as enormous.
    #[test]
    fn should_clamp_dimensions_uniformly_when_the_scale_is_absurd() {
        let transform = Transform {
            scale: Point2D::new(1000.0, 1000.0),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // Scale clamps to 100x -> 192000x108000, then one shrink factor brings the
        // long axis down to twice the canvas diagonal (2 * hypot(1920, 1080)).
        assert_eq!(result.scaled_width, 4406);
        assert_eq!(result.scaled_height, 2478);

        let source_aspect = f64::from(SOURCE_W) / f64::from(SOURCE_H);
        let clamped_aspect = f64::from(result.scaled_width) / f64::from(result.scaled_height);
        assert!(
            (clamped_aspect - source_aspect).abs() < 0.01,
            "clamping must preserve the aspect ratio: {clamped_aspect} vs {source_aspect}"
        );
    }

    /// Feature: Transform layout
    /// Scenario: a clamped frame is still placed where the anchor says it should be
    ///
    /// The overlay corner is derived from the post-clamp size, so the visible
    /// region a viewer sees is the one the anchor and position asked for.
    #[test]
    fn should_place_a_clamped_frame_from_its_post_clamp_size() {
        let transform = Transform {
            scale: Point2D::new(1000.0, 1000.0),
            anchor: Point2D::new(0.0, 0.0),
            position: Point2D::new(0.5, 0.5),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        // Anchor at the top-left corner, position at the canvas centre: the corner
        // is pinned to (960, 540) and the rest of the frame runs down and right.
        assert_eq!(result.scaled_width, 4406);
        assert_eq!(result.scaled_height, 2478);
        assert_eq!(result.overlay_x, 960);
        assert_eq!(result.overlay_y, 540);
    }

    /// Feature: Transform layout
    /// Scenario: overlay offsets land on the grid `overlay` actually snaps to
    ///
    /// `overlay` floors x and y to the chroma subsampling grid in yuv420, so an
    /// odd number in the graph is a number FFmpeg silently changes.
    #[test]
    fn should_emit_even_overlay_offsets() {
        for (position_x, position_y) in [
            (0.0, 0.0),
            (0.137, 0.911),
            (0.5, 0.5),
            (0.333, 0.666),
            (1.0, 1.0),
        ] {
            let transform = Transform {
                position: Point2D::new(position_x, position_y),
                scale: Point2D::new(0.3137, 0.7123),
                rotation_deg: 37.0,
                ..Transform::default()
            };

            let result = layout(transform, 1.0);

            assert_eq!(
                result.overlay_x % 2,
                0,
                "overlay_x {} is odd at position {position_x}",
                result.overlay_x
            );
            assert_eq!(
                result.overlay_y % 2,
                0,
                "overlay_y {} is odd at position {position_y}",
                result.overlay_y
            );
        }
    }

    /// Feature: Transform layout
    /// Scenario: a vanishingly small scale still produces an encodable frame
    #[test]
    fn should_keep_a_tiny_clip_at_a_minimum_even_size() {
        let transform = Transform {
            scale: Point2D::new(0.0, 0.0),
            ..Transform::default()
        };

        let result = layout(transform, 1.0);

        assert_eq!(result.scaled_width, 20); // 1920 * 0.01, the command's floor
        assert_eq!(result.scaled_height, 10); // 1080 * 0.01 = 10.8 -> nearest even
    }

    // -------------------------------------------------------------------------
    // Motion keyframes: parity with the preview's sampler
    // -------------------------------------------------------------------------

    fn keyframe(
        time_offset: f64,
        transform: Transform,
        interpolation: KeyframeInterpolation,
    ) -> crate::core::timeline::TransformKeyframe {
        crate::core::timeline::TransformKeyframe {
            time_offset,
            transform,
            interpolation,
        }
    }

    fn moved(position: (f64, f64), scale: (f64, f64), rotation_deg: f64) -> Transform {
        Transform {
            position: Point2D::new(position.0, position.1),
            scale: Point2D::new(scale.0, scale.1),
            rotation_deg,
            anchor: Point2D::center(),
        }
    }

    fn clip_with_motion(keyframes: Vec<crate::core::timeline::TransformKeyframe>) -> Clip {
        let mut clip = Clip::new("asset").with_source_range(0.0, 4.0).place_at(0.0);
        clip.motion_keyframes = keyframes;
        clip
    }

    /// Feature: Keyframed motion semantics
    /// Scenario: the export samples the curve the preview drew
    ///
    /// `getClipMotionTransformAtTime` holds the first value before the first
    /// keyframe and the last value after the last, blends linearly in between,
    /// and short-circuits a `hold` segment to its start value. Diverging on any
    /// of those would export a move the editor never watched.
    #[test]
    fn motion_sampling_matches_the_preview_semantics() {
        let clip = clip_with_motion(vec![
            keyframe(
                1.0,
                moved((0.2, 0.5), (0.5, 0.5), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                3.0,
                moved((0.6, 0.5), (1.5, 1.5), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);

        // Clamp-hold before the first keyframe, including at negative times.
        for time in [-5.0, 0.0, 0.999, 1.0] {
            let sampled = clip_motion_transform_at(&clip, time);
            assert!(
                (sampled.position.x - 0.2).abs() < 1e-12 && (sampled.scale.x - 0.5).abs() < 1e-12,
                "before the first keyframe the first value holds, at t={time}"
            );
        }

        // Clamp-hold after the last keyframe.
        for time in [3.0, 9.0] {
            let sampled = clip_motion_transform_at(&clip, time);
            assert!(
                (sampled.position.x - 0.6).abs() < 1e-12 && (sampled.scale.x - 1.5).abs() < 1e-12,
                "after the last keyframe the last value holds, at t={time}"
            );
        }

        // Linear in between: halfway is the midpoint of both components.
        let middle = clip_motion_transform_at(&clip, 2.0);
        assert!(
            (middle.position.x - 0.4).abs() < 1e-12,
            "position must blend linearly: {}",
            middle.position.x
        );
        assert!(
            (middle.scale.x - 1.0).abs() < 1e-12,
            "scale must blend linearly: {}",
            middle.scale.x
        );
    }

    /// Feature: Keyframed motion semantics
    /// Scenario: only `hold` short-circuits; bezier still blends linearly
    ///
    /// The preview compares the interpolation against the literal `'hold'` and
    /// lets everything else fall through to `interpolateTransform`, so a bezier
    /// keyframe blends linearly there. The export has to agree, or a project
    /// carrying bezier motion would render a curve the preview never showed.
    #[test]
    fn only_hold_interpolation_freezes_a_motion_segment() {
        let held = clip_with_motion(vec![
            keyframe(
                0.0,
                moved((0.2, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Hold,
            ),
            keyframe(
                2.0,
                moved((0.8, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);
        assert!(
            (clip_motion_transform_at(&held, 1.0).position.x - 0.2).abs() < 1e-12,
            "a hold segment must stay at its start value"
        );

        let bezier = clip_with_motion(vec![
            keyframe(
                0.0,
                moved((0.2, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Bezier {
                    cp1x: 0.4,
                    cp1y: 0.0,
                    cp2x: 0.6,
                    cp2y: 1.0,
                },
            ),
            keyframe(
                2.0,
                moved((0.8, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);
        assert!(
            (clip_motion_transform_at(&bezier, 1.0).position.x - 0.5).abs() < 1e-12,
            "a bezier segment blends linearly, exactly as the preview does"
        );
    }

    /// Feature: Keyframed motion semantics
    /// Scenario: unusable keyframes are dropped and the rest are ordered
    ///
    /// Mirrors `sortedValidKeyframes`: a non-finite or negative `timeOffset` is
    /// not a keyframe, and stored order is not sort order.
    #[test]
    fn motion_keyframes_are_filtered_and_sorted_like_the_preview() {
        let clip = clip_with_motion(vec![
            keyframe(
                3.0,
                moved((0.9, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                -1.0,
                moved((0.0, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                f64::NAN,
                moved((0.1, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                1.0,
                moved((0.1, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);

        let track = resolve_clip_motion_track(1280, 720, 1920, 1080, &clip, 0.0).expect("track");
        assert_eq!(
            track.keyframes.len(),
            2,
            "the negative and non-finite keyframes must be dropped"
        );
        assert!(
            track.keyframes[0].time_sec < track.keyframes[1].time_sec,
            "the surviving keyframes must be in time order"
        );
        assert!(
            (clip_motion_transform_at(&clip, 0.0).position.x - 0.1).abs() < 1e-12,
            "the earliest surviving keyframe is what holds before the curve starts"
        );
    }

    /// Feature: Keyframed motion in the export
    /// Scenario: the emitted curve tracks the preview's sampler
    ///
    /// The graph carries a closed-form piecewise-linear expression, while the
    /// preview samples per frame. This pins the two together: at a spread of
    /// times, linearly interpolating the *keyframe frame sizes* the graph
    /// animates through must land on the size the static layout would give the
    /// transform the preview shows at that instant.
    #[test]
    fn the_emitted_curve_tracks_the_preview_sampler() {
        const SOURCE: (u32, u32) = (1280, 720);
        const CANVAS: (u32, u32) = (1920, 1080);

        let clip = clip_with_motion(vec![
            keyframe(
                0.0,
                moved((0.3, 0.4), (0.5, 0.5), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                2.0,
                moved((0.5, 0.5), (1.2, 0.9), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                4.0,
                moved((0.8, 0.6), (0.7, 1.4), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);
        let track = resolve_clip_motion_track(SOURCE.0, SOURCE.1, CANVAS.0, CANVAS.1, &clip, 0.0)
            .expect("track");

        for step in 0..=40 {
            let time = f64::from(step) * 0.1;

            // What the graph computes: a linear blend of the keyframe sizes.
            let curve = track
                .keyframes
                .windows(2)
                .find(|pair| time >= pair[0].time_sec && time <= pair[1].time_sec)
                .map(|pair| {
                    let span = pair[1].time_sec - pair[0].time_sec;
                    let progress = if span > 0.0 {
                        (time - pair[0].time_sec) / span
                    } else {
                        0.0
                    };
                    let blend = |from: u32, to: u32| {
                        f64::from(from) + (f64::from(to) - f64::from(from)) * progress
                    };
                    (
                        blend(pair[0].scaled_width, pair[1].scaled_width),
                        blend(pair[0].scaled_height, pair[1].scaled_height),
                    )
                })
                .expect("a segment covers every sampled time");

            // What the preview shows, put through the ordinary static layout.
            let sampled = clip_motion_transform_at(&clip, time);
            let layout = compute_clip_transform_layout(
                SOURCE.0, SOURCE.1, CANVAS.0, CANVAS.1, &sampled, 1.0,
            );

            // The only gap is the static layout's even-pixel alignment, which
            // rounds each endpoint before the blend rather than after it.
            assert!(
                (curve.0 - f64::from(layout.scaled_width)).abs() <= 2.0,
                "width diverges from the preview at t={time}: curve {} vs preview {}",
                curve.0,
                layout.scaled_width
            );
            assert!(
                (curve.1 - f64::from(layout.scaled_height)).abs() <= 2.0,
                "height diverges from the preview at t={time}: curve {} vs preview {}",
                curve.1,
                layout.scaled_height
            );
        }
    }

    /// Feature: Keyframed motion across a transition handle
    /// Scenario: the head handle shifts every keyframe into branch time
    #[test]
    fn a_head_handle_shifts_every_motion_keyframe() {
        let clip = clip_with_motion(vec![
            keyframe(
                0.0,
                moved((0.3, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
            keyframe(
                2.0,
                moved((0.7, 0.5), (1.0, 1.0), 0.0),
                KeyframeInterpolation::Linear,
            ),
        ]);

        let bare = resolve_clip_motion_track(1280, 720, 1920, 1080, &clip, 0.0).expect("track");
        assert_eq!(bare.keyframes[0].time_sec, 0.0);
        assert_eq!(bare.keyframes[1].time_sec, 2.0);

        let handled = resolve_clip_motion_track(1280, 720, 1920, 1080, &clip, 0.75).expect("track");
        assert_eq!(handled.keyframes[0].time_sec, 0.75);
        assert_eq!(handled.keyframes[1].time_sec, 2.75);

        let negative =
            resolve_clip_motion_track(1280, 720, 1920, 1080, &clip, -1.0).expect("track");
        assert_eq!(
            negative.keyframes[0].time_sec, 0.0,
            "a nonsensical handle must not drag the curve backwards"
        );
    }
}
