//! Mask shape interpolation for animated mask paths.
//!
//! Provides linear interpolation between mask shapes of the same variant,
//! with step fallback for incompatible shape types.

use crate::core::effects::Easing;

use super::{
    BezierMask, BezierPoint, EllipseMask, GradientMask, MaskShape, Point2D, PolygonMask, RectMask,
};

/// Interpolates between two mask shapes at parameter `t` (0.0 = shape_a, 1.0 = shape_b).
///
/// Only interpolates between shapes of the same variant. For mismatched variants,
/// falls back to a discrete step (shape_a for t < 0.5, shape_b otherwise).
pub fn interpolate_mask_shape(shape_a: &MaskShape, shape_b: &MaskShape, t: f64) -> MaskShape {
    let t = t.clamp(0.0, 1.0);

    match (shape_a, shape_b) {
        (MaskShape::Rectangle(a), MaskShape::Rectangle(b)) => {
            MaskShape::Rectangle(lerp_rect(a, b, t))
        }
        (MaskShape::Ellipse(a), MaskShape::Ellipse(b)) => MaskShape::Ellipse(lerp_ellipse(a, b, t)),
        (MaskShape::Polygon(a), MaskShape::Polygon(b)) if a.points.len() == b.points.len() => {
            MaskShape::Polygon(lerp_polygon(a, b, t))
        }
        (MaskShape::Bezier(a), MaskShape::Bezier(b))
            if a.points.len() == b.points.len() && a.closed == b.closed =>
        {
            MaskShape::Bezier(lerp_bezier(a, b, t))
        }
        (MaskShape::Gradient(a), MaskShape::Gradient(b)) if a.gradient_type == b.gradient_type => {
            MaskShape::Gradient(lerp_gradient(a, b, t))
        }
        // Incompatible shapes: discrete step at midpoint
        _ => {
            if t < 0.5 {
                shape_a.clone()
            } else {
                shape_b.clone()
            }
        }
    }
}

/// Applies an easing function to a linear parameter t (0.0-1.0).
pub fn apply_easing(t: f64, easing: &Easing) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match easing {
        Easing::Linear => t,
        Easing::EaseIn => t * t,
        Easing::EaseOut => 1.0 - (1.0 - t) * (1.0 - t),
        Easing::EaseInOut => {
            if t < 0.5 {
                2.0 * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
            }
        }
        Easing::Step => {
            if t < 0.5 {
                0.0
            } else {
                1.0
            }
        }
        Easing::Hold => 0.0,
        Easing::CubicBezier => {
            // Default cubic bezier approximation (ease-in-out style)
            let t2 = t * t;
            let t3 = t2 * t;
            3.0 * t2 - 2.0 * t3
        }
    }
}

/// Translates a mask shape by a normalized delta (dx, dy).
///
/// Shifts all position-related coordinates by the given offset.
/// Used to apply tracking data deltas to a base mask shape.
pub fn translate_shape(shape: &MaskShape, dx: f64, dy: f64) -> MaskShape {
    match shape {
        MaskShape::Rectangle(r) => MaskShape::Rectangle(RectMask {
            x: r.x + dx,
            y: r.y + dy,
            width: r.width,
            height: r.height,
            corner_radius: r.corner_radius,
            rotation: r.rotation,
        }),
        MaskShape::Ellipse(e) => MaskShape::Ellipse(EllipseMask {
            x: e.x + dx,
            y: e.y + dy,
            radius_x: e.radius_x,
            radius_y: e.radius_y,
            rotation: e.rotation,
        }),
        MaskShape::Polygon(p) => MaskShape::Polygon(PolygonMask {
            points: p
                .points
                .iter()
                .map(|pt| Point2D::new(pt.x + dx, pt.y + dy))
                .collect(),
        }),
        MaskShape::Bezier(b) => MaskShape::Bezier(BezierMask {
            points: b
                .points
                .iter()
                .map(|bp| BezierPoint {
                    anchor: Point2D::new(bp.anchor.x + dx, bp.anchor.y + dy),
                    // Handles are relative to anchor, so they stay unchanged
                    handle_in: bp.handle_in.clone(),
                    handle_out: bp.handle_out.clone(),
                })
                .collect(),
            closed: b.closed,
        }),
        MaskShape::Gradient(g) => MaskShape::Gradient(GradientMask {
            start: Point2D::new(g.start.x + dx, g.start.y + dy),
            end: Point2D::new(g.end.x + dx, g.end.y + dy),
            gradient_type: g.gradient_type.clone(),
        }),
    }
}

// =============================================================================
// Per-shape linear interpolation
// =============================================================================

fn lerp_f64(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn lerp_point2d(a: &Point2D, b: &Point2D, t: f64) -> Point2D {
    Point2D::new(lerp_f64(a.x, b.x, t), lerp_f64(a.y, b.y, t))
}

fn lerp_optional_point(a: &Option<Point2D>, b: &Option<Point2D>, t: f64) -> Option<Point2D> {
    match (a, b) {
        (Some(pa), Some(pb)) => Some(lerp_point2d(pa, pb, t)),
        (Some(pa), None) => Some(lerp_point2d(pa, &Point2D::new(0.0, 0.0), t)),
        (None, Some(pb)) => Some(lerp_point2d(&Point2D::new(0.0, 0.0), pb, t)),
        (None, None) => None,
    }
}

fn lerp_rect(a: &RectMask, b: &RectMask, t: f64) -> RectMask {
    RectMask {
        x: lerp_f64(a.x, b.x, t),
        y: lerp_f64(a.y, b.y, t),
        width: lerp_f64(a.width, b.width, t),
        height: lerp_f64(a.height, b.height, t),
        corner_radius: lerp_f64(a.corner_radius, b.corner_radius, t),
        rotation: lerp_f64(a.rotation, b.rotation, t),
    }
}

fn lerp_ellipse(a: &EllipseMask, b: &EllipseMask, t: f64) -> EllipseMask {
    EllipseMask {
        x: lerp_f64(a.x, b.x, t),
        y: lerp_f64(a.y, b.y, t),
        radius_x: lerp_f64(a.radius_x, b.radius_x, t),
        radius_y: lerp_f64(a.radius_y, b.radius_y, t),
        rotation: lerp_f64(a.rotation, b.rotation, t),
    }
}

fn lerp_polygon(a: &PolygonMask, b: &PolygonMask, t: f64) -> PolygonMask {
    PolygonMask {
        points: a
            .points
            .iter()
            .zip(b.points.iter())
            .map(|(pa, pb)| lerp_point2d(pa, pb, t))
            .collect(),
    }
}

fn lerp_bezier(a: &BezierMask, b: &BezierMask, t: f64) -> BezierMask {
    BezierMask {
        points: a
            .points
            .iter()
            .zip(b.points.iter())
            .map(|(bp_a, bp_b)| BezierPoint {
                anchor: lerp_point2d(&bp_a.anchor, &bp_b.anchor, t),
                handle_in: lerp_optional_point(&bp_a.handle_in, &bp_b.handle_in, t),
                handle_out: lerp_optional_point(&bp_a.handle_out, &bp_b.handle_out, t),
            })
            .collect(),
        closed: a.closed,
    }
}

fn lerp_gradient(a: &GradientMask, b: &GradientMask, t: f64) -> GradientMask {
    GradientMask {
        start: lerp_point2d(&a.start, &b.start, t),
        end: lerp_point2d(&a.end, &b.end, t),
        gradient_type: a.gradient_type.clone(),
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1e-9;

    fn assert_approx(actual: f64, expected: f64, msg: &str) {
        assert!(
            (actual - expected).abs() < EPSILON,
            "{msg}: expected {expected}, got {actual}"
        );
    }

    // -------------------------------------------------------------------------
    // Feature: Rectangle interpolation
    // -------------------------------------------------------------------------

    #[test]
    fn should_interpolate_rectangle_positions_at_midpoint() {
        // Given two rectangles at different positions
        let a = RectMask::new(0.2, 0.2, 0.4, 0.3);
        let b = RectMask::new(0.8, 0.8, 0.6, 0.5);
        let shape_a = MaskShape::Rectangle(a);
        let shape_b = MaskShape::Rectangle(b);

        // When interpolating at t=0.5
        let result = interpolate_mask_shape(&shape_a, &shape_b, 0.5);

        // Then position should be the midpoint
        if let MaskShape::Rectangle(r) = result {
            assert_approx(r.x, 0.5, "x");
            assert_approx(r.y, 0.5, "y");
            assert_approx(r.width, 0.5, "width");
            assert_approx(r.height, 0.4, "height");
        } else {
            panic!("Expected Rectangle shape");
        }
    }

    #[test]
    fn should_return_shape_a_at_t_zero() {
        let a = RectMask::new(0.2, 0.3, 0.4, 0.5);
        let b = RectMask::new(0.8, 0.7, 0.6, 0.5);
        let result = interpolate_mask_shape(
            &MaskShape::Rectangle(a.clone()),
            &MaskShape::Rectangle(b),
            0.0,
        );
        if let MaskShape::Rectangle(r) = result {
            assert_approx(r.x, 0.2, "x at t=0");
            assert_approx(r.y, 0.3, "y at t=0");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_return_shape_b_at_t_one() {
        let a = RectMask::new(0.2, 0.3, 0.4, 0.5);
        let b = RectMask::new(0.8, 0.7, 0.6, 0.5);
        let result = interpolate_mask_shape(
            &MaskShape::Rectangle(a),
            &MaskShape::Rectangle(b.clone()),
            1.0,
        );
        if let MaskShape::Rectangle(r) = result {
            assert_approx(r.x, 0.8, "x at t=1");
            assert_approx(r.y, 0.7, "y at t=1");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_interpolate_rectangle_rotation_and_corner_radius() {
        let a = RectMask {
            corner_radius: 0.0,
            rotation: 0.0,
            ..RectMask::new(0.5, 0.5, 0.4, 0.4)
        };
        let b = RectMask {
            corner_radius: 0.2,
            rotation: 90.0,
            ..RectMask::new(0.5, 0.5, 0.4, 0.4)
        };
        let result =
            interpolate_mask_shape(&MaskShape::Rectangle(a), &MaskShape::Rectangle(b), 0.5);
        if let MaskShape::Rectangle(r) = result {
            assert_approx(r.corner_radius, 0.1, "corner_radius");
            assert_approx(r.rotation, 45.0, "rotation");
        } else {
            panic!("Expected Rectangle");
        }
    }

    // -------------------------------------------------------------------------
    // Feature: Ellipse interpolation
    // -------------------------------------------------------------------------

    #[test]
    fn should_interpolate_ellipse_positions_and_radii() {
        let a = EllipseMask::new(0.2, 0.2, 0.1, 0.1);
        let b = EllipseMask::new(0.8, 0.8, 0.3, 0.3);
        let result = interpolate_mask_shape(&MaskShape::Ellipse(a), &MaskShape::Ellipse(b), 0.5);
        if let MaskShape::Ellipse(e) = result {
            assert_approx(e.x, 0.5, "x");
            assert_approx(e.y, 0.5, "y");
            assert_approx(e.radius_x, 0.2, "radius_x");
            assert_approx(e.radius_y, 0.2, "radius_y");
        } else {
            panic!("Expected Ellipse");
        }
    }

    // -------------------------------------------------------------------------
    // Feature: Polygon interpolation
    // -------------------------------------------------------------------------

    #[test]
    fn should_interpolate_polygon_points_pairwise_when_counts_match() {
        let a = PolygonMask::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(0.5, 1.0),
        ]);
        let b = PolygonMask::new(vec![
            Point2D::new(0.2, 0.2),
            Point2D::new(0.8, 0.2),
            Point2D::new(0.5, 0.8),
        ]);
        let result = interpolate_mask_shape(&MaskShape::Polygon(a), &MaskShape::Polygon(b), 0.5);
        if let MaskShape::Polygon(p) = result {
            assert_eq!(p.points.len(), 3);
            assert_approx(p.points[0].x, 0.1, "p0.x");
            assert_approx(p.points[0].y, 0.1, "p0.y");
            assert_approx(p.points[1].x, 0.9, "p1.x");
            assert_approx(p.points[2].y, 0.9, "p2.y");
        } else {
            panic!("Expected Polygon");
        }
    }

    #[test]
    fn should_step_polygon_when_point_counts_differ() {
        let a = PolygonMask::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(0.5, 1.0),
        ]);
        let b = PolygonMask::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(1.0, 0.0),
            Point2D::new(1.0, 1.0),
            Point2D::new(0.0, 1.0),
        ]);
        // t < 0.5 => returns shape_a
        let result = interpolate_mask_shape(
            &MaskShape::Polygon(a.clone()),
            &MaskShape::Polygon(b.clone()),
            0.3,
        );
        if let MaskShape::Polygon(p) = result {
            assert_eq!(p.points.len(), 3);
        } else {
            panic!("Expected Polygon");
        }
        // t >= 0.5 => returns shape_b
        let result = interpolate_mask_shape(&MaskShape::Polygon(a), &MaskShape::Polygon(b), 0.7);
        if let MaskShape::Polygon(p) = result {
            assert_eq!(p.points.len(), 4);
        } else {
            panic!("Expected Polygon");
        }
    }

    // -------------------------------------------------------------------------
    // Feature: Bezier interpolation
    // -------------------------------------------------------------------------

    #[test]
    fn should_interpolate_bezier_anchors_and_handles() {
        let a = BezierMask::new(
            vec![
                BezierPoint::smooth(0.2, 0.2, 0.05, 0.0),
                BezierPoint::smooth(0.8, 0.2, 0.05, 0.0),
            ],
            false,
        );
        let b = BezierMask::new(
            vec![
                BezierPoint::smooth(0.2, 0.8, 0.1, 0.0),
                BezierPoint::smooth(0.8, 0.8, 0.1, 0.0),
            ],
            false,
        );
        let result = interpolate_mask_shape(&MaskShape::Bezier(a), &MaskShape::Bezier(b), 0.5);
        if let MaskShape::Bezier(bz) = result {
            assert_eq!(bz.points.len(), 2);
            assert_approx(bz.points[0].anchor.y, 0.5, "anchor y");
            // handle_out: lerp(0.05, 0.1, 0.5) = 0.075
            if let Some(h) = &bz.points[0].handle_out {
                assert_approx(h.x, 0.075, "handle_out x");
            } else {
                panic!("Expected handle_out");
            }
        } else {
            panic!("Expected Bezier");
        }
    }

    // -------------------------------------------------------------------------
    // Feature: Gradient interpolation
    // -------------------------------------------------------------------------

    #[test]
    fn should_interpolate_gradient_endpoints() {
        let a = GradientMask::linear(Point2D::new(0.0, 0.5), Point2D::new(0.5, 0.5));
        let b = GradientMask::linear(Point2D::new(0.5, 0.5), Point2D::new(1.0, 0.5));
        let result = interpolate_mask_shape(&MaskShape::Gradient(a), &MaskShape::Gradient(b), 0.5);
        if let MaskShape::Gradient(g) = result {
            assert_approx(g.start.x, 0.25, "start.x");
            assert_approx(g.end.x, 0.75, "end.x");
        } else {
            panic!("Expected Gradient");
        }
    }

    #[test]
    fn should_step_between_different_gradient_types() {
        let a = GradientMask::linear(Point2D::new(0.0, 0.5), Point2D::new(1.0, 0.5));
        let b = GradientMask::radial(Point2D::new(0.5, 0.5), Point2D::new(0.5, 0.0));
        let result = interpolate_mask_shape(&MaskShape::Gradient(a), &MaskShape::Gradient(b), 0.3);
        // Should be linear (a) since t < 0.5
        if let MaskShape::Gradient(g) = result {
            assert_approx(g.start.x, 0.0, "start.x is from a");
        } else {
            panic!("Expected Gradient");
        }
    }

    // -------------------------------------------------------------------------
    // Feature: Mismatched shape types
    // -------------------------------------------------------------------------

    #[test]
    fn should_step_between_different_shape_types() {
        let rect = MaskShape::Rectangle(RectMask::default());
        let ellipse = MaskShape::Ellipse(EllipseMask::default());

        // t < 0.5 => returns rect
        let result = interpolate_mask_shape(&rect, &ellipse, 0.3);
        assert_eq!(result.type_name(), "rectangle");

        // t >= 0.5 => returns ellipse
        let result = interpolate_mask_shape(&rect, &ellipse, 0.7);
        assert_eq!(result.type_name(), "ellipse");
    }

    // -------------------------------------------------------------------------
    // Feature: Easing functions
    // -------------------------------------------------------------------------

    #[test]
    fn should_apply_linear_easing_unchanged() {
        assert_approx(apply_easing(0.5, &Easing::Linear), 0.5, "linear");
    }

    #[test]
    fn should_apply_ease_in_quadratic() {
        assert_approx(apply_easing(0.5, &Easing::EaseIn), 0.25, "ease_in");
    }

    #[test]
    fn should_apply_ease_out_quadratic() {
        assert_approx(apply_easing(0.5, &Easing::EaseOut), 0.75, "ease_out");
    }

    #[test]
    fn should_apply_hold_easing_as_zero() {
        assert_approx(apply_easing(0.5, &Easing::Hold), 0.0, "hold");
        assert_approx(apply_easing(0.99, &Easing::Hold), 0.0, "hold at 0.99");
    }

    #[test]
    fn should_apply_step_easing_as_binary() {
        assert_approx(apply_easing(0.49, &Easing::Step), 0.0, "step before 0.5");
        assert_approx(apply_easing(0.5, &Easing::Step), 1.0, "step at 0.5");
    }

    #[test]
    fn should_clamp_t_to_valid_range() {
        assert_approx(apply_easing(-0.5, &Easing::Linear), 0.0, "negative clamped");
        assert_approx(apply_easing(1.5, &Easing::Linear), 1.0, "over-one clamped");
    }

    // -------------------------------------------------------------------------
    // Feature: Shape translation
    // -------------------------------------------------------------------------

    #[test]
    fn should_translate_rectangle_by_delta() {
        let shape = MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.4, 0.3));
        let translated = translate_shape(&shape, 0.1, -0.2);
        if let MaskShape::Rectangle(r) = translated {
            assert_approx(r.x, 0.6, "x");
            assert_approx(r.y, 0.3, "y");
            assert_approx(r.width, 0.4, "width unchanged");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_translate_polygon_all_points() {
        let shape = MaskShape::Polygon(PolygonMask::new(vec![
            Point2D::new(0.0, 0.0),
            Point2D::new(0.5, 0.0),
            Point2D::new(0.25, 0.5),
        ]));
        let translated = translate_shape(&shape, 0.1, 0.1);
        if let MaskShape::Polygon(p) = translated {
            assert_approx(p.points[0].x, 0.1, "p0.x");
            assert_approx(p.points[0].y, 0.1, "p0.y");
            assert_approx(p.points[1].x, 0.6, "p1.x");
        } else {
            panic!("Expected Polygon");
        }
    }

    #[test]
    fn should_translate_bezier_anchors_but_keep_handles_relative() {
        let shape = MaskShape::Bezier(BezierMask::new(
            vec![
                BezierPoint::smooth(0.5, 0.5, 0.1, 0.0),
                BezierPoint::corner(0.8, 0.8),
            ],
            false,
        ));
        let translated = translate_shape(&shape, 0.05, 0.05);
        if let MaskShape::Bezier(bz) = translated {
            assert_approx(bz.points[0].anchor.x, 0.55, "anchor.x");
            // Handles are relative, so they stay the same
            if let Some(h) = &bz.points[0].handle_out {
                assert_approx(h.x, 0.1, "handle stays relative");
            }
        } else {
            panic!("Expected Bezier");
        }
    }
}
