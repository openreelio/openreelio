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

use crate::core::timeline::Transform;

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
    let base_scale = (canvas_width / source_width).min(canvas_height / source_height);
    let base_scale = if base_scale.is_finite() && base_scale > 0.0 {
        base_scale
    } else {
        warn_fallback("base scale", base_scale);
        1.0
    };

    let scale_x = sanitize_scale(transform.scale.x, "scale.x");
    let scale_y = sanitize_scale(transform.scale.y, "scale.y");

    // Both axes shrink by the same factor when the frame is too big to render,
    // because clamping them independently would silently restretch the picture:
    // a 100x scale on 16:9 would come out square.
    let ideal_width = source_width * base_scale * scale_x;
    let ideal_height = source_height * base_scale * scale_y;
    let shrink = uniform_shrink(
        ideal_width,
        ideal_height,
        frame_dimension_limit(canvas_width, canvas_height),
    );
    let scaled_width = align_dimension(ideal_width * shrink);
    let scaled_height = align_dimension(ideal_height * shrink);

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
}
