//! FFmpeg Mask Filter Builder
//!
//! Converts mask shapes to FFmpeg filter expressions for selective effect application.
//!
//! This module provides:
//! - Mask shape to FFmpeg filter conversion
//! - Alpha channel manipulation for masking
//! - Support for feathering, inversion, and mask composition
//!
//! # FFmpeg Masking Approach
//!
//! Masks are implemented using FFmpeg's `geq` (generic equation) filter to generate
//! alpha channels. The general approach:
//!
//! 1. Create an alpha mask using geq expressions
//! 2. Apply feathering via boxblur on the alpha channel
//! 3. Composite the effect using alphamerge/overlay
//!
//! # Example
//!
//! ```ignore
//! use openreelio_lib::core::effects::mask_filters::{MaskFilterBuilder, mask_to_alpha_filter};
//! use openreelio_lib::core::masks::{Mask, MaskShape, RectMask};
//!
//! let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
//! let alpha_filter = mask_to_alpha_filter(&mask, 1920, 1080);
//! // Returns: "format=rgba,geq=a='if(...)'"
//! ```

use crate::core::masks::{
    BezierMask, EllipseMask, Mask, MaskBlendMode, MaskGroup, MaskShape, PolygonMask, RectMask,
};

// =============================================================================
// Constants
// =============================================================================

/// Maximum feather blur radius in pixels
const MAX_FEATHER_RADIUS: i32 = 200;

/// Minimum dimension for safe division
const MIN_DIMENSION: i32 = 1;

/// Alpha value for fully opaque (8-bit)
const ALPHA_OPAQUE: i32 = 255;

/// Alpha value for fully transparent (8-bit)
const ALPHA_TRANSPARENT: i32 = 0;

// =============================================================================
// Mask Filter Builder Trait
// =============================================================================

/// Trait for converting masks to FFmpeg filter expressions
pub trait MaskFilterBuilder {
    /// Generates an FFmpeg alpha channel expression
    ///
    /// # Arguments
    ///
    /// * `width` - Video width in pixels
    /// * `height` - Video height in pixels
    ///
    /// # Returns
    ///
    /// FFmpeg `geq` filter alpha expression
    fn to_alpha_expression(&self, width: i32, height: i32) -> String;
}

// =============================================================================
// Rectangle Mask Filter
// =============================================================================

impl MaskFilterBuilder for RectMask {
    fn to_alpha_expression(&self, width: i32, height: i32) -> String {
        let w = width.max(MIN_DIMENSION) as f64;
        let h = height.max(MIN_DIMENSION) as f64;

        // Convert normalized coordinates to pixel values
        let cx = self.x * w;
        let cy = self.y * h;
        let half_w = (self.width * w) / 2.0;
        let half_h = (self.height * h) / 2.0;

        // Calculate bounds
        let left = cx - half_w;
        let right = cx + half_w;
        let top = cy - half_h;
        let bottom = cy + half_h;

        if self.rotation.abs() < 0.001 {
            // No rotation: simple box test
            // geq expression: if(X >= left && X <= right && Y >= top && Y <= bottom, 255, 0)
            format!(
                "if(gte(X,{:.1})*lte(X,{:.1})*gte(Y,{:.1})*lte(Y,{:.1}),{},{})",
                left, right, top, bottom, ALPHA_OPAQUE, ALPHA_TRANSPARENT
            )
        } else {
            // With rotation: transform coordinates
            let cos_r = self.rotation.to_radians().cos();
            let sin_r = self.rotation.to_radians().sin();

            // Rotate point around center, then check bounds
            // dx = (X - cx) * cos + (Y - cy) * sin
            // dy = -(X - cx) * sin + (Y - cy) * cos
            format!(
                "if(lte(abs((X-{cx:.1})*{cos:.6}+(Y-{cy:.1})*{sin:.6}),{half_w:.1})*\
                 lte(abs(-(X-{cx:.1})*{sin:.6}+(Y-{cy:.1})*{cos:.6}),{half_h:.1}),{opaque},{transparent})",
                cx = cx,
                cy = cy,
                cos = cos_r,
                sin = sin_r,
                half_w = half_w,
                half_h = half_h,
                opaque = ALPHA_OPAQUE,
                transparent = ALPHA_TRANSPARENT
            )
        }
    }
}

// =============================================================================
// Ellipse Mask Filter
// =============================================================================

impl MaskFilterBuilder for EllipseMask {
    fn to_alpha_expression(&self, width: i32, height: i32) -> String {
        let w = width.max(MIN_DIMENSION) as f64;
        let h = height.max(MIN_DIMENSION) as f64;

        // Convert normalized coordinates to pixel values
        let cx = self.x * w;
        let cy = self.y * h;
        let rx = self.radius_x * w;
        let ry = self.radius_y * h;

        if self.rotation.abs() < 0.001 {
            // No rotation: standard ellipse equation
            // ((X - cx)^2 / rx^2) + ((Y - cy)^2 / ry^2) <= 1
            format!(
                "if(lte(pow((X-{cx:.1})/{rx:.1},2)+pow((Y-{cy:.1})/{ry:.1},2),1),{opaque},{transparent})",
                cx = cx,
                cy = cy,
                rx = rx.max(0.001),
                ry = ry.max(0.001),
                opaque = ALPHA_OPAQUE,
                transparent = ALPHA_TRANSPARENT
            )
        } else {
            // With rotation: transform coordinates first
            let cos_r = self.rotation.to_radians().cos();
            let sin_r = self.rotation.to_radians().sin();

            // Rotated ellipse test
            format!(
                "if(lte(\
                 pow(((X-{cx:.1})*{cos:.6}+(Y-{cy:.1})*{sin:.6})/{rx:.1},2)+\
                 pow((-(X-{cx:.1})*{sin:.6}+(Y-{cy:.1})*{cos:.6})/{ry:.1},2)\
                 ,1),{opaque},{transparent})",
                cx = cx,
                cy = cy,
                cos = cos_r,
                sin = sin_r,
                rx = rx.max(0.001),
                ry = ry.max(0.001),
                opaque = ALPHA_OPAQUE,
                transparent = ALPHA_TRANSPARENT
            )
        }
    }
}

// =============================================================================
// Polygon Mask Filter
// =============================================================================

impl MaskFilterBuilder for PolygonMask {
    fn to_alpha_expression(&self, width: i32, height: i32) -> String {
        let w = width.max(MIN_DIMENSION) as f64;
        let h = height.max(MIN_DIMENSION) as f64;

        if self.points.len() < 3 {
            return ALPHA_TRANSPARENT.to_string();
        }

        // Convert points to pixel coordinates
        let points: Vec<(f64, f64)> = self.points.iter().map(|p| (p.x * w, p.y * h)).collect();

        // Build point-in-polygon test using ray casting algorithm
        // For each edge, count crossings with horizontal ray from (X, Y) to (+inf, Y)
        build_polygon_crossing_expression(&points)
    }
}

/// Builds a point-in-polygon test using ray casting
fn build_polygon_crossing_expression(points: &[(f64, f64)]) -> String {
    // Ray casting algorithm: count edge crossings
    // If odd number of crossings, point is inside
    //
    // For each edge (p1, p2), check if:
    // 1. Y is between p1.y and p2.y (exclusive on one end)
    // 2. X is left of the edge intersection with Y
    //
    // We accumulate crossing count using addition

    let n = points.len();
    let mut crossing_terms = Vec::with_capacity(n);

    for i in 0..n {
        let (x1, y1) = points[i];
        let (x2, y2) = points[(i + 1) % n];

        // Skip horizontal edges (they don't contribute crossings)
        if (y2 - y1).abs() < 0.0001 {
            continue;
        }

        // Edge crossing condition:
        // ((y1 <= Y && Y < y2) || (y2 <= Y && Y < y1)) &&
        // X < x1 + (Y - y1) * (x2 - x1) / (y2 - y1)
        //
        // Simplified: gte(Y,min(y1,y2))*lt(Y,max(y1,y2))*lt(X,x1+(Y-y1)*(x2-x1)/(y2-y1))

        let y_min = y1.min(y2);
        let y_max = y1.max(y2);

        // Calculate slope for intersection
        let slope = (x2 - x1) / (y2 - y1);

        crossing_terms.push(format!(
            "gte(Y,{y_min:.1})*lt(Y,{y_max:.1})*lt(X,{x1:.1}+(Y-{y1:.1})*{slope:.6})",
            y_min = y_min,
            y_max = y_max,
            x1 = x1,
            y1 = y1,
            slope = slope
        ));
    }

    if crossing_terms.is_empty() {
        return ALPHA_TRANSPARENT.to_string();
    }

    // Sum all crossing terms, check if odd (mod 2 == 1)
    let sum_expr = crossing_terms.join("+");
    format!(
        "if(mod({sum},2),{opaque},{transparent})",
        sum = sum_expr,
        opaque = ALPHA_OPAQUE,
        transparent = ALPHA_TRANSPARENT
    )
}

// =============================================================================
// Bezier Mask Filter
// =============================================================================

impl MaskFilterBuilder for BezierMask {
    fn to_alpha_expression(&self, width: i32, height: i32) -> String {
        let w = width.max(MIN_DIMENSION) as f64;
        let h = height.max(MIN_DIMENSION) as f64;

        if self.points.len() < 2 {
            return ALPHA_TRANSPARENT.to_string();
        }

        // For bezier curves, we approximate by sampling points along the curve
        // and treating it as a polygon. This is a simplification but works well
        // for most cases.
        let samples_per_segment = 8; // Points to sample per bezier segment
        let mut polygon_points = Vec::new();

        let n = self.points.len();
        let segments = if self.closed { n } else { n - 1 };

        for i in 0..segments {
            let p0 = &self.points[i];
            let p1 = &self.points[(i + 1) % n];

            // Sample points along this bezier segment
            for t_idx in 0..samples_per_segment {
                let t = t_idx as f64 / samples_per_segment as f64;
                let (px, py) = evaluate_bezier_segment(p0, p1, t);
                polygon_points.push((px * w, py * h));
            }
        }

        // Add final point
        if !self.closed {
            let last = &self.points[n - 1];
            polygon_points.push((last.anchor.x * w, last.anchor.y * h));
        }

        if polygon_points.len() < 3 {
            return ALPHA_TRANSPARENT.to_string();
        }

        build_polygon_crossing_expression(&polygon_points)
    }
}

/// Evaluates a point on a cubic bezier segment
fn evaluate_bezier_segment(
    p0: &crate::core::masks::BezierPoint,
    p1: &crate::core::masks::BezierPoint,
    t: f64,
) -> (f64, f64) {
    // Get control points
    let x0 = p0.anchor.x;
    let y0 = p0.anchor.y;

    // Handle out of p0 (absolute position)
    let (c0x, c0y) = match &p0.handle_out {
        Some(h) => (x0 + h.x, y0 + h.y),
        None => (x0, y0),
    };

    // Handle in of p1 (absolute position)
    let x1 = p1.anchor.x;
    let y1 = p1.anchor.y;
    let (c1x, c1y) = match &p1.handle_in {
        Some(h) => (x1 + h.x, y1 + h.y),
        None => (x1, y1),
    };

    // Cubic bezier formula: B(t) = (1-t)^3*P0 + 3*(1-t)^2*t*C0 + 3*(1-t)*t^2*C1 + t^3*P1
    let t2 = t * t;
    let t3 = t2 * t;
    let mt = 1.0 - t;
    let mt2 = mt * mt;
    let mt3 = mt2 * mt;

    let px = mt3 * x0 + 3.0 * mt2 * t * c0x + 3.0 * mt * t2 * c1x + t3 * x1;
    let py = mt3 * y0 + 3.0 * mt2 * t * c0y + 3.0 * mt * t2 * c1y + t3 * y1;

    (px, py)
}

// =============================================================================
// MaskShape Filter
// =============================================================================

impl MaskFilterBuilder for MaskShape {
    fn to_alpha_expression(&self, width: i32, height: i32) -> String {
        match self {
            MaskShape::Rectangle(r) => r.to_alpha_expression(width, height),
            MaskShape::Ellipse(e) => e.to_alpha_expression(width, height),
            MaskShape::Polygon(p) => p.to_alpha_expression(width, height),
            MaskShape::Bezier(b) => b.to_alpha_expression(width, height),
        }
    }
}

// =============================================================================
// Full Mask Filter Generation
// =============================================================================

/// Generates a complete FFmpeg filter for a single mask
///
/// # Arguments
///
/// * `mask` - The mask to convert
/// * `width` - Video width in pixels
/// * `height` - Video height in pixels
///
/// # Returns
///
/// FFmpeg filter string that creates an alpha channel from the mask
pub fn mask_to_alpha_filter(mask: &Mask, width: i32, height: i32) -> String {
    if !mask.enabled {
        // Disabled mask: full alpha (everything visible)
        return format!("format=rgba,geq=a='{}'", ALPHA_OPAQUE);
    }

    let mut alpha_expr = mask.shape.to_alpha_expression(width, height);

    // Apply opacity
    if mask.opacity < 1.0 {
        let opacity_factor = (mask.opacity * ALPHA_OPAQUE as f64) as i32;
        alpha_expr = format!(
            "({expr})*{opacity}/{scale}",
            expr = alpha_expr,
            opacity = opacity_factor,
            scale = ALPHA_OPAQUE
        );
    }

    // Apply inversion
    if mask.inverted {
        alpha_expr = format!("({}-({}))", ALPHA_OPAQUE, alpha_expr);
    }

    // Build the filter
    let mut filter_parts = vec!["format=rgba".to_string()];

    // Main geq filter for alpha
    filter_parts.push(format!(
        "geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{}'",
        alpha_expr
    ));

    // Apply feathering via blur on alpha channel
    if mask.feather > 0.001 {
        let blur_radius = (mask.feather * MAX_FEATHER_RADIUS as f64) as i32;
        let blur_radius = blur_radius.clamp(1, MAX_FEATHER_RADIUS);

        // Use boxblur for feathering (applied to alpha channel via alphaextract/alphamerge)
        // Alternative approach: use gblur directly but it affects all channels
        filter_parts.push("split[rgb][alpha]".to_string());
        filter_parts.push(format!(
            "[alpha]alphaextract,boxblur={}:{}[softmask]",
            blur_radius, blur_radius
        ));
        filter_parts.push("[rgb][softmask]alphamerge".to_string());
    }

    filter_parts.join(",")
}

/// Generates FFmpeg filter for applying an effect through a mask
///
/// This creates a filter complex that:
/// 1. Splits the input
/// 2. Applies the effect to one branch
/// 3. Creates the mask alpha
/// 4. Composites the result
///
/// # Arguments
///
/// * `mask` - The mask to apply
/// * `effect_filter` - The FFmpeg filter string for the effect
/// * `width` - Video width
/// * `height` - Video height
/// * `input_label` - Input stream label
/// * `output_label` - Output stream label
///
/// # Returns
///
/// Complete FFmpeg filter_complex string
pub fn apply_effect_through_mask(
    mask: &Mask,
    effect_filter: &str,
    width: i32,
    height: i32,
    input_label: &str,
    output_label: &str,
) -> String {
    if !mask.enabled || effect_filter == "null" {
        return format!("[{input_label}]null[{output_label}]");
    }

    let alpha_filter = mask_to_alpha_filter(mask, width, height);

    // Filter graph:
    // [input] split [original][to_effect]
    // [to_effect] <effect> [effected]
    // [original] <mask_alpha> [masked]
    // [masked][effected] overlay [output]

    format!(
        "[{input}]split[_orig_{input}][_eff_{input}];\
         [{input}_eff]{effect}[_effected_{input}];\
         [_orig_{input}]{alpha},format=rgba[_masked_{input}];\
         [_masked_{input}][_effected_{input}]overlay=format=auto[{output}]",
        input = input_label,
        effect = effect_filter,
        alpha = alpha_filter,
        output = output_label
    )
}

/// Generates FFmpeg filter for a mask group (multiple masks combined)
///
/// # Arguments
///
/// * `group` - The mask group
/// * `width` - Video width
/// * `height` - Video height
///
/// # Returns
///
/// Combined alpha expression for all masks
pub fn mask_group_to_alpha_expression(group: &MaskGroup, width: i32, height: i32) -> String {
    if group.is_empty() {
        return ALPHA_OPAQUE.to_string();
    }

    let enabled_masks: Vec<&Mask> = group.masks.iter().filter(|m| m.enabled).collect();

    if enabled_masks.is_empty() {
        return ALPHA_OPAQUE.to_string();
    }

    if enabled_masks.len() == 1 {
        let mask = enabled_masks[0];
        let mut expr = mask.shape.to_alpha_expression(width, height);
        if mask.inverted {
            expr = format!("({}-({}))", ALPHA_OPAQUE, expr);
        }
        return expr;
    }

    // Combine multiple masks according to their blend modes
    let mut result_expr = String::new();

    for mask in enabled_masks {
        let mut mask_expr = mask.shape.to_alpha_expression(width, height);

        if mask.inverted {
            mask_expr = format!("({}-({}))", ALPHA_OPAQUE, mask_expr);
        }

        if result_expr.is_empty() {
            result_expr = mask_expr;
        } else {
            result_expr = combine_mask_expressions(&result_expr, &mask_expr, &mask.blend_mode);
        }
    }

    result_expr
}

/// Combines two mask alpha expressions according to blend mode
fn combine_mask_expressions(expr1: &str, expr2: &str, mode: &MaskBlendMode) -> String {
    match mode {
        MaskBlendMode::Add => {
            // Union: max of both alphas
            format!("max({},{})", expr1, expr2)
        }
        MaskBlendMode::Subtract => {
            // Subtract: expr1 minus expr2, clamped to 0
            format!("max(0,({})-({})", expr1, expr2)
        }
        MaskBlendMode::Intersect => {
            // Intersection: min of both alphas
            format!("min({},{})", expr1, expr2)
        }
        MaskBlendMode::Difference => {
            // XOR-like: areas that are in one but not both
            format!("abs(({})-({})", expr1, expr2)
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_WIDTH: i32 = 1920;
    const TEST_HEIGHT: i32 = 1080;

    #[test]
    fn test_rect_mask_no_rotation() {
        let rect = RectMask::new(0.5, 0.5, 0.5, 0.5);
        let expr = rect.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("gte(X,"), "Should have X lower bound check");
        assert!(expr.contains("lte(X,"), "Should have X upper bound check");
        assert!(expr.contains("gte(Y,"), "Should have Y lower bound check");
        assert!(expr.contains("lte(Y,"), "Should have Y upper bound check");
        assert!(expr.contains("255"), "Should produce opaque alpha");
        assert!(expr.contains(",0)"), "Should produce transparent outside");
    }

    #[test]
    fn test_rect_mask_with_rotation() {
        let rect = RectMask::new(0.5, 0.5, 0.5, 0.5).with_rotation(45.0);
        let expr = rect.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        // Rotated expression uses cos/sin transforms
        assert!(
            expr.contains("abs("),
            "Should use absolute value for rotated bounds"
        );
    }

    #[test]
    fn test_ellipse_mask_no_rotation() {
        let ellipse = EllipseMask::new(0.5, 0.5, 0.25, 0.25);
        let expr = ellipse.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(
            expr.contains("pow("),
            "Should use power function for ellipse equation"
        );
        assert!(
            expr.contains("lte("),
            "Should check if inside ellipse (<=1)"
        );
    }

    #[test]
    fn test_ellipse_circle() {
        let circle = EllipseMask::circle(0.5, 0.5, 0.25);
        let expr = circle.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("pow("), "Circle uses ellipse equation");
    }

    #[test]
    fn test_polygon_mask_triangle() {
        let polygon = PolygonMask::default(); // Default is a triangle
        let expr = polygon.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(
            expr.contains("mod("),
            "Should use modulo for crossing count parity"
        );
    }

    #[test]
    fn test_polygon_mask_regular_hexagon() {
        let hexagon = PolygonMask::regular(0.5, 0.5, 0.25, 6);
        let expr = hexagon.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("mod("), "Should use ray casting algorithm");
    }

    #[test]
    fn test_bezier_mask_basic() {
        let bezier = BezierMask::default();
        let expr = bezier.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        // Bezier is converted to polygon, so uses same algorithm
        assert!(
            expr.contains("mod("),
            "Bezier should use polygon ray casting"
        );
    }

    #[test]
    fn test_mask_to_alpha_filter_basic() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let filter = mask_to_alpha_filter(&mask, TEST_WIDTH, TEST_HEIGHT);

        assert!(
            filter.starts_with("format=rgba"),
            "Should start with format"
        );
        assert!(filter.contains("geq="), "Should contain geq filter");
    }

    #[test]
    fn test_mask_to_alpha_filter_with_feather() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default())).with_feather(0.1);
        let filter = mask_to_alpha_filter(&mask, TEST_WIDTH, TEST_HEIGHT);

        assert!(filter.contains("boxblur"), "Feathered mask should use blur");
        assert!(filter.contains("alphamerge"), "Should merge alpha back");
    }

    #[test]
    fn test_mask_to_alpha_filter_inverted() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default())).inverted();
        let filter = mask_to_alpha_filter(&mask, TEST_WIDTH, TEST_HEIGHT);

        // Inverted mask subtracts from 255
        assert!(
            filter.contains("255-("),
            "Inverted mask should subtract from max"
        );
    }

    #[test]
    fn test_mask_to_alpha_filter_disabled() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.enabled = false;
        let filter = mask_to_alpha_filter(&mask, TEST_WIDTH, TEST_HEIGHT);

        assert!(
            filter.contains("a='255'"),
            "Disabled mask should be fully opaque"
        );
    }

    #[test]
    fn test_mask_group_empty() {
        let group = MaskGroup::new();
        let expr = mask_group_to_alpha_expression(&group, TEST_WIDTH, TEST_HEIGHT);

        assert_eq!(expr, "255", "Empty group should be fully opaque");
    }

    #[test]
    fn test_mask_group_single_mask() {
        let mut group = MaskGroup::new();
        group.add(Mask::new(MaskShape::Rectangle(RectMask::default())));
        let expr = mask_group_to_alpha_expression(&group, TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("if("), "Single mask should have conditional");
    }

    #[test]
    fn test_mask_group_add_blend() {
        let mut group = MaskGroup::new();

        let mask1 = Mask::new(MaskShape::Rectangle(RectMask::new(0.25, 0.5, 0.3, 0.3)));
        let mut mask2 = Mask::new(MaskShape::Rectangle(RectMask::new(0.75, 0.5, 0.3, 0.3)));
        mask2.blend_mode = MaskBlendMode::Add;

        group.add(mask1);
        group.add(mask2);

        let expr = mask_group_to_alpha_expression(&group, TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("max("), "Add blend should use max()");
    }

    #[test]
    fn test_mask_group_subtract_blend() {
        let mut group = MaskGroup::new();

        let mask1 = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let mut mask2 = Mask::new(MaskShape::Ellipse(EllipseMask::default()));
        mask2.blend_mode = MaskBlendMode::Subtract;

        group.add(mask1);
        group.add(mask2);

        let expr = mask_group_to_alpha_expression(&group, TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("max(0,"), "Subtract should clamp to 0");
    }

    #[test]
    fn test_mask_group_intersect_blend() {
        let mut group = MaskGroup::new();

        let mask1 = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let mut mask2 = Mask::new(MaskShape::Ellipse(EllipseMask::default()));
        mask2.blend_mode = MaskBlendMode::Intersect;

        group.add(mask1);
        group.add(mask2);

        let expr = mask_group_to_alpha_expression(&group, TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("min("), "Intersect should use min()");
    }

    #[test]
    fn test_apply_effect_through_mask() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let filter = apply_effect_through_mask(
            &mask,
            "gblur=sigma=5",
            TEST_WIDTH,
            TEST_HEIGHT,
            "0:v",
            "out",
        );

        assert!(filter.contains("split"), "Should split input");
        assert!(
            filter.contains("overlay"),
            "Should use overlay for compositing"
        );
        assert!(filter.contains("gblur"), "Should contain the effect filter");
    }

    #[test]
    fn test_apply_effect_disabled_mask() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.enabled = false;
        let filter = apply_effect_through_mask(
            &mask,
            "gblur=sigma=5",
            TEST_WIDTH,
            TEST_HEIGHT,
            "0:v",
            "out",
        );

        assert!(filter.contains("null"), "Disabled mask should pass through");
    }

    #[test]
    fn test_apply_effect_null_filter() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let filter =
            apply_effect_through_mask(&mask, "null", TEST_WIDTH, TEST_HEIGHT, "0:v", "out");

        assert!(filter.contains("null"), "Null effect should pass through");
    }

    #[test]
    fn test_mask_shape_rectangle_via_enum() {
        let shape = MaskShape::Rectangle(RectMask::default());
        let expr = shape.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("gte(X,"), "Rectangle expression via enum");
    }

    #[test]
    fn test_mask_shape_ellipse_via_enum() {
        let shape = MaskShape::Ellipse(EllipseMask::default());
        let expr = shape.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert!(expr.contains("pow("), "Ellipse expression via enum");
    }

    #[test]
    fn test_invalid_polygon_too_few_points() {
        let polygon = PolygonMask::new(vec![
            crate::core::masks::Point2D::new(0.0, 0.0),
            crate::core::masks::Point2D::new(1.0, 1.0),
        ]);
        let expr = polygon.to_alpha_expression(TEST_WIDTH, TEST_HEIGHT);

        assert_eq!(expr, "0", "Invalid polygon should be fully transparent");
    }

    #[test]
    fn test_mask_opacity() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.opacity = 0.5;
        let filter = mask_to_alpha_filter(&mask, TEST_WIDTH, TEST_HEIGHT);

        // 0.5 * 255 = 127 (approximately)
        assert!(filter.contains("/255"), "Opacity should scale alpha");
    }

    #[test]
    fn test_min_dimension_safety() {
        let rect = RectMask::default();
        // Should not panic with zero dimensions
        let expr = rect.to_alpha_expression(0, 0);
        assert!(!expr.is_empty(), "Should handle zero dimensions safely");
    }
}
