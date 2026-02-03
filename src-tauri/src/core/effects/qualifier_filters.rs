//! HSL Qualifier Filter Builder
//!
//! Implements selective color correction using HSL (Hue, Saturation, Luminance)
//! qualification. This enables DaVinci Resolve-style color grading where
//! adjustments are applied only to pixels matching specific color ranges.
//!
//! # Overview
//!
//! HSL Qualification works by:
//! 1. Selecting pixels based on their HSL values
//! 2. Creating a selection mask (alpha channel)
//! 3. Applying color adjustments to selected pixels only
//! 4. Blending the result with the original
//!
//! # Integration with Power Windows
//!
//! Qualifiers can be combined with spatial masks (Power Windows) for
//! region-specific color correction. The final selection is the intersection
//! of the HSL qualifier mask and the spatial mask.
//!
//! # FFmpeg Implementation
//!
//! Uses FFmpeg's `geq` (generic equation) filter to evaluate per-pixel
//! HSL conditions and create selection masks. The approach:
//!
//! 1. Split input into RGB and alpha paths
//! 2. Use `geq` with HSL conversion to generate selection mask
//! 3. Apply adjustments via `hue` filter
//! 4. Blend using `overlay` with the selection mask
//!
//! # Example
//!
//! ```ignore
//! use openreelio_lib::core::effects::qualifier_filters::*;
//!
//! let qualifier = QualifierParams {
//!     hue_center: 120.0,  // Green
//!     hue_width: 30.0,
//!     sat_min: 0.3,
//!     sat_max: 1.0,
//!     lum_min: 0.2,
//!     lum_max: 0.8,
//!     softness: 0.1,
//!     invert: false,
//! };
//!
//! let adjustments = ColorAdjustments {
//!     hue_shift: -30.0,  // Shift towards cyan
//!     sat_adjust: 0.2,
//!     lum_adjust: 0.1,
//! };
//!
//! let filter = build_qualifier_filter(&qualifier, &adjustments, 1920, 1080);
//! ```

use crate::core::masks::MaskGroup;

// =============================================================================
// Constants
// =============================================================================

/// Maximum softness blur radius in pixels
const MAX_SOFTNESS_RADIUS: i32 = 100;

/// Minimum value to avoid division by zero
const EPSILON: f64 = 0.0001;

/// Full scale for 8-bit values
const SCALE_8BIT: f64 = 255.0;

// =============================================================================
// Qualifier Parameters
// =============================================================================

/// Parameters for HSL-based pixel selection
#[derive(Clone, Debug, Default)]
pub struct QualifierParams {
    /// Center hue in degrees (0-360)
    /// 0/360 = Red, 60 = Yellow, 120 = Green, 180 = Cyan, 240 = Blue, 300 = Magenta
    pub hue_center: f64,

    /// Hue selection width in degrees (1-180)
    /// Wider values select more hues around the center
    pub hue_width: f64,

    /// Minimum saturation (0.0-1.0)
    pub sat_min: f64,

    /// Maximum saturation (0.0-1.0)
    pub sat_max: f64,

    /// Minimum luminance (0.0-1.0)
    pub lum_min: f64,

    /// Maximum luminance (0.0-1.0)
    pub lum_max: f64,

    /// Edge softness (0.0-1.0)
    /// Higher values create smoother transitions at selection edges
    pub softness: f64,

    /// Invert the selection (select non-matching pixels)
    pub invert: bool,
}

impl QualifierParams {
    /// Creates a new qualifier with default values (selects green)
    pub fn new() -> Self {
        Self {
            hue_center: 120.0, // Green
            hue_width: 30.0,
            sat_min: 0.2,
            sat_max: 1.0,
            lum_min: 0.0,
            lum_max: 1.0,
            softness: 0.1,
            invert: false,
        }
    }

    /// Creates a qualifier for selecting skin tones
    pub fn skin_tones() -> Self {
        Self {
            hue_center: 20.0, // Orange-red
            hue_width: 40.0,
            sat_min: 0.15,
            sat_max: 0.7,
            lum_min: 0.2,
            lum_max: 0.85,
            softness: 0.15,
            invert: false,
        }
    }

    /// Creates a qualifier for selecting sky/blue
    pub fn sky_blue() -> Self {
        Self {
            hue_center: 210.0, // Blue
            hue_width: 60.0,
            sat_min: 0.2,
            sat_max: 1.0,
            lum_min: 0.3,
            lum_max: 0.9,
            softness: 0.1,
            invert: false,
        }
    }

    /// Creates a qualifier for selecting foliage/green
    pub fn foliage() -> Self {
        Self {
            hue_center: 100.0, // Yellow-green
            hue_width: 80.0,
            sat_min: 0.15,
            sat_max: 1.0,
            lum_min: 0.1,
            lum_max: 0.85,
            softness: 0.1,
            invert: false,
        }
    }

    /// Validates the qualifier parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.hue_width < 1.0 || self.hue_width > 180.0 {
            return Err(format!("Invalid hue_width: {}", self.hue_width));
        }
        if self.sat_min < 0.0 || self.sat_min > 1.0 {
            return Err(format!("Invalid sat_min: {}", self.sat_min));
        }
        if self.sat_max < 0.0 || self.sat_max > 1.0 {
            return Err(format!("Invalid sat_max: {}", self.sat_max));
        }
        if self.sat_min > self.sat_max {
            return Err("sat_min cannot be greater than sat_max".to_string());
        }
        if self.lum_min < 0.0 || self.lum_min > 1.0 {
            return Err(format!("Invalid lum_min: {}", self.lum_min));
        }
        if self.lum_max < 0.0 || self.lum_max > 1.0 {
            return Err(format!("Invalid lum_max: {}", self.lum_max));
        }
        if self.lum_min > self.lum_max {
            return Err("lum_min cannot be greater than lum_max".to_string());
        }
        if self.softness < 0.0 || self.softness > 1.0 {
            return Err(format!("Invalid softness: {}", self.softness));
        }
        Ok(())
    }
}

// =============================================================================
// Color Adjustments
// =============================================================================

/// Color adjustments to apply to qualified pixels
#[derive(Clone, Debug, Default)]
pub struct ColorAdjustments {
    /// Hue rotation in degrees (-180 to 180)
    pub hue_shift: f64,

    /// Saturation adjustment (-1.0 to 1.0)
    /// Negative values desaturate, positive values increase saturation
    pub sat_adjust: f64,

    /// Luminance/brightness adjustment (-1.0 to 1.0)
    pub lum_adjust: f64,
}

impl ColorAdjustments {
    /// Returns true if all adjustments are effectively zero
    pub fn is_identity(&self) -> bool {
        self.hue_shift.abs() < EPSILON
            && self.sat_adjust.abs() < EPSILON
            && self.lum_adjust.abs() < EPSILON
    }

    /// Validates the adjustment parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.hue_shift < -180.0 || self.hue_shift > 180.0 {
            return Err(format!("Invalid hue_shift: {}", self.hue_shift));
        }
        if self.sat_adjust < -1.0 || self.sat_adjust > 1.0 {
            return Err(format!("Invalid sat_adjust: {}", self.sat_adjust));
        }
        if self.lum_adjust < -1.0 || self.lum_adjust > 1.0 {
            return Err(format!("Invalid lum_adjust: {}", self.lum_adjust));
        }
        Ok(())
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Builds an FFmpeg hue filter string from color adjustments
fn build_hue_filter(adjustments: &ColorAdjustments) -> String {
    let mut hue_parts = Vec::new();

    if adjustments.hue_shift.abs() > EPSILON {
        hue_parts.push(format!("h={:.2}", adjustments.hue_shift));
    }
    if adjustments.sat_adjust.abs() > EPSILON {
        let s_multiplier = (1.0 + adjustments.sat_adjust).max(0.0);
        hue_parts.push(format!("s={:.4}", s_multiplier));
    }
    if adjustments.lum_adjust.abs() > EPSILON {
        hue_parts.push(format!("b={:.4}", adjustments.lum_adjust));
    }

    if hue_parts.is_empty() {
        "null".to_string()
    } else {
        format!("hue={}", hue_parts.join(":"))
    }
}

/// Builds a softness blur filter suffix
fn build_softness_filter(softness: f64) -> String {
    if softness > EPSILON {
        let blur_radius = (softness * MAX_SOFTNESS_RADIUS as f64) as i32;
        let blur_radius = blur_radius.clamp(1, MAX_SOFTNESS_RADIUS);
        format!(",boxblur={}:{}", blur_radius, blur_radius)
    } else {
        String::new()
    }
}

// =============================================================================
// Qualifier Mask Generation
// =============================================================================

/// Generates an FFmpeg geq expression for HSL qualification
///
/// This creates an alpha channel where:
/// - 255 (opaque) = pixel matches HSL criteria
/// - 0 (transparent) = pixel does not match
///
/// # Arguments
///
/// * `params` - Qualifier parameters defining the selection
///
/// # Returns
///
/// FFmpeg geq alpha expression string
pub fn build_qualifier_alpha_expression(params: &QualifierParams) -> String {
    // Normalize hue center to 0-360 range
    let hue_center = params.hue_center.rem_euclid(360.0);
    let hue_width = params.hue_width.clamp(1.0, 180.0);
    let half_width = hue_width / 2.0;

    // Calculate hue bounds
    let hue_min = (hue_center - half_width).rem_euclid(360.0);
    let hue_max = (hue_center + half_width).rem_euclid(360.0);

    // Saturation bounds (0-1 scaled to 0-255 for geq)
    let sat_min = (params.sat_min.clamp(0.0, 1.0) * SCALE_8BIT) as i32;
    let sat_max = (params.sat_max.clamp(0.0, 1.0) * SCALE_8BIT) as i32;

    // Luminance bounds (0-1 scaled to 0-255 for geq)
    let lum_min = (params.lum_min.clamp(0.0, 1.0) * SCALE_8BIT) as i32;
    let lum_max = (params.lum_max.clamp(0.0, 1.0) * SCALE_8BIT) as i32;

    // FFmpeg geq operates on RGB, so we need to compute HSL from RGB
    // Using standard RGB to HSL conversion formulas
    //
    // R, G, B are pixel values (0-255)
    // We compute:
    //   max_rgb = max(R, G, B)
    //   min_rgb = min(R, G, B)
    //   L = (max_rgb + min_rgb) / 2
    //   S = (max_rgb - min_rgb) / (255 - abs(max_rgb + min_rgb - 255))
    //   H = complex formula based on which channel is max

    // Build the hue condition
    // For hue, we need to compute it from RGB in the geq expression
    // This is complex, so we use an approximation via the `hue` expression

    // Simplified approach: Use FFmpeg's built-in hue detection
    // geq can access lum(X,Y), cb(X,Y), cr(X,Y) for YCbCr
    // We'll compute approximate hue from Cb/Cr components

    // Cb and Cr relate to hue angle:
    // hue ≈ atan2(Cr - 128, Cb - 128) * 180 / PI + 180

    // Build hue condition
    let hue_condition = if (hue_max - hue_min).abs() < EPSILON {
        // Degenerate case: very narrow hue range
        "1".to_string()
    } else if hue_min > hue_max {
        // Wrap-around case (e.g., red hues spanning 350-10 degrees)
        // Hue is in range if >= hue_min OR <= hue_max
        format!(
            "gte(mod(atan2(cr(X,Y)-128,cb(X,Y)-128)*180/PI+180,360),{hue_min:.1})+\
             lte(mod(atan2(cr(X,Y)-128,cb(X,Y)-128)*180/PI+180,360),{hue_max:.1})",
            hue_min = hue_min,
            hue_max = hue_max
        )
    } else {
        // Normal case: hue is between min and max
        format!(
            "gte(mod(atan2(cr(X,Y)-128,cb(X,Y)-128)*180/PI+180,360),{hue_min:.1})*\
             lte(mod(atan2(cr(X,Y)-128,cb(X,Y)-128)*180/PI+180,360),{hue_max:.1})",
            hue_min = hue_min,
            hue_max = hue_max
        )
    };

    // Build saturation condition
    // Saturation ≈ sqrt(pow(cb(X,Y)-128,2) + pow(cr(X,Y)-128,2)) * 2
    // Normalized to 0-255 range approximately
    let sat_condition = format!(
        "gte(sqrt(pow(cb(X,Y)-128,2)+pow(cr(X,Y)-128,2))*2,{sat_min})*\
         lte(sqrt(pow(cb(X,Y)-128,2)+pow(cr(X,Y)-128,2))*2,{sat_max})",
        sat_min = sat_min,
        sat_max = sat_max
    );

    // Build luminance condition using lum(X,Y)
    let lum_condition = format!(
        "gte(lum(X,Y),{lum_min})*lte(lum(X,Y),{lum_max})",
        lum_min = lum_min,
        lum_max = lum_max
    );

    // Combine all conditions
    let combined = format!(
        "({hue})*({sat})*({lum})",
        hue = hue_condition,
        sat = sat_condition,
        lum = lum_condition
    );

    // Apply inversion if needed
    let alpha_expr = if params.invert {
        format!("if({},0,255)", combined)
    } else {
        format!("if({},255,0)", combined)
    };

    alpha_expr
}

/// Builds a complete FFmpeg filter for HSL-based selective color correction
///
/// # Arguments
///
/// * `params` - Qualifier parameters for pixel selection
/// * `adjustments` - Color adjustments to apply to selected pixels
/// * `width` - Video width in pixels
/// * `height` - Video height in pixels
///
/// # Returns
///
/// FFmpeg filter string for selective color correction
pub fn build_qualifier_filter(
    params: &QualifierParams,
    adjustments: &ColorAdjustments,
    _width: i32,
    _height: i32,
) -> String {
    // If no adjustments, return null filter
    if adjustments.is_identity() {
        return "null".to_string();
    }

    // Build the alpha expression for qualification
    let alpha_expr = build_qualifier_alpha_expression(params);

    // Build the color adjustment and softness filters
    let hue_filter = build_hue_filter(adjustments);
    let softness_filter = build_softness_filter(params.softness);

    // Complete filter:
    // split[orig][adj];
    // [adj]hue=h=30[adjusted];
    // [orig]geq=...:a='qualifier_expr'[masked];
    // [masked][adjusted]overlay=format=auto
    format!(
        "split[_qorig][_qadj];\
         [_qadj]{hue}[_qadjusted];\
         [_qorig]format=rgba,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{alpha}'{softness}[_qmasked];\
         [_qmasked][_qadjusted]overlay=format=auto",
        hue = hue_filter,
        alpha = alpha_expr,
        softness = softness_filter
    )
}

/// Builds a qualifier filter combined with a spatial mask (Power Window)
///
/// This creates a compound selection where pixels must:
/// 1. Match the HSL qualifier criteria
/// 2. Be within the spatial mask region
///
/// # Arguments
///
/// * `params` - Qualifier parameters
/// * `adjustments` - Color adjustments
/// * `mask_group` - Spatial masks to combine with
/// * `width` - Video width
/// * `height` - Video height
///
/// # Returns
///
/// FFmpeg filter string for combined qualifier + mask selection
pub fn build_qualified_mask_filter(
    params: &QualifierParams,
    adjustments: &ColorAdjustments,
    mask_group: &MaskGroup,
    width: i32,
    height: i32,
) -> String {
    use crate::core::effects::mask_filters::mask_group_to_alpha_expression;

    // If no adjustments, return null filter
    if adjustments.is_identity() {
        return "null".to_string();
    }

    // Build qualifier alpha expression
    let qualifier_alpha = build_qualifier_alpha_expression(params);

    // Build mask alpha expression
    let mask_alpha = if mask_group.is_empty() {
        "255".to_string() // No mask = full selection
    } else {
        mask_group_to_alpha_expression(mask_group, width, height)
    };

    // Combine qualifier and mask: intersection (both must be true)
    let combined_alpha = format!("min({},{})", qualifier_alpha, mask_alpha);

    // Build color adjustment and softness filters using helpers
    let hue_filter = build_hue_filter(adjustments);
    let softness_filter = build_softness_filter(params.softness);

    // Complete filter with combined mask
    format!(
        "split[_qmorig][_qmadj];\
         [_qmadj]{hue}[_qmadjusted];\
         [_qmorig]format=rgba,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{alpha}'{softness}[_qmmasked];\
         [_qmmasked][_qmadjusted]overlay=format=auto",
        hue = hue_filter,
        alpha = combined_alpha,
        softness = softness_filter
    )
}

/// Generates a preview of the qualifier selection mask
///
/// This creates a filter that shows the selection as a black/white matte,
/// useful for visualizing what pixels are being selected.
///
/// # Arguments
///
/// * `params` - Qualifier parameters
///
/// # Returns
///
/// FFmpeg filter string that outputs the selection mask as grayscale
pub fn build_qualifier_preview_filter(params: &QualifierParams) -> String {
    let alpha_expr = build_qualifier_alpha_expression(params);

    // Show selection as grayscale: white = selected, black = not selected
    format!(
        "format=rgba,geq=r='{alpha}':g='{alpha}':b='{alpha}':a='255'",
        alpha = alpha_expr
    )
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_qualifier_params_new() {
        let params = QualifierParams::new();
        assert_eq!(params.hue_center, 120.0);
        assert_eq!(params.hue_width, 30.0);
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_qualifier_params_skin_tones() {
        let params = QualifierParams::skin_tones();
        assert_eq!(params.hue_center, 20.0);
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_qualifier_params_sky_blue() {
        let params = QualifierParams::sky_blue();
        assert_eq!(params.hue_center, 210.0);
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_qualifier_params_foliage() {
        let params = QualifierParams::foliage();
        assert_eq!(params.hue_center, 100.0);
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_qualifier_params_validation() {
        let mut params = QualifierParams::new();

        // Invalid hue_width
        params.hue_width = 0.5;
        assert!(params.validate().is_err());
        params.hue_width = 30.0;

        // Invalid sat range
        params.sat_min = 0.8;
        params.sat_max = 0.2;
        assert!(params.validate().is_err());
        params.sat_min = 0.2;
        params.sat_max = 1.0;

        // Invalid lum range
        params.lum_min = 0.9;
        params.lum_max = 0.1;
        assert!(params.validate().is_err());
        params.lum_min = 0.0;
        params.lum_max = 1.0;

        // Invalid softness
        params.softness = 1.5;
        assert!(params.validate().is_err());
        params.softness = 0.1;

        // Valid
        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_color_adjustments_is_identity() {
        let zero = ColorAdjustments::default();
        assert!(zero.is_identity());

        let non_zero = ColorAdjustments {
            hue_shift: 30.0,
            sat_adjust: 0.0,
            lum_adjust: 0.0,
        };
        assert!(!non_zero.is_identity());
    }

    #[test]
    fn test_color_adjustments_validation() {
        let adj = ColorAdjustments {
            hue_shift: 200.0,
            ..Default::default()
        };
        assert!(adj.validate().is_err());

        let adj = ColorAdjustments {
            hue_shift: 30.0,
            sat_adjust: 2.0,
            ..Default::default()
        };
        assert!(adj.validate().is_err());

        let adj = ColorAdjustments {
            hue_shift: 30.0,
            sat_adjust: 0.2,
            lum_adjust: -2.0,
        };
        assert!(adj.validate().is_err());

        let adj = ColorAdjustments {
            hue_shift: 30.0,
            sat_adjust: 0.2,
            lum_adjust: 0.1,
        };
        assert!(adj.validate().is_ok());
    }

    #[test]
    fn test_build_qualifier_alpha_expression() {
        let params = QualifierParams::new();
        let expr = build_qualifier_alpha_expression(&params);

        assert!(expr.contains("gte("), "Should have greater-than checks");
        assert!(expr.contains("lte("), "Should have less-than checks");
        assert!(expr.contains("atan2"), "Should compute hue via atan2");
    }

    #[test]
    fn test_build_qualifier_alpha_expression_inverted() {
        let mut params = QualifierParams::new();
        params.invert = true;
        let expr = build_qualifier_alpha_expression(&params);

        // Inverted should swap 0 and 255
        assert!(
            expr.contains("if(") && expr.contains(",0,255)"),
            "Inverted should output 0 for matches"
        );
    }

    #[test]
    fn test_build_qualifier_alpha_wrap_around() {
        // Red hue that wraps around 0/360
        let params = QualifierParams {
            hue_center: 350.0,
            hue_width: 40.0, // 330-370 (wraps to 330-10)
            ..QualifierParams::new()
        };
        let expr = build_qualifier_alpha_expression(&params);

        // Wrap-around should use OR logic (addition in geq)
        assert!(
            expr.contains("+"),
            "Wrap-around hue should use OR logic: {}",
            expr
        );
    }

    #[test]
    fn test_build_qualifier_filter_identity() {
        let params = QualifierParams::new();
        let adjustments = ColorAdjustments::default(); // All zeros

        let filter = build_qualifier_filter(&params, &adjustments, 1920, 1080);
        assert_eq!(filter, "null", "Identity adjustments should return null");
    }

    #[test]
    fn test_build_qualifier_filter_with_hue_shift() {
        let params = QualifierParams::new();
        let adjustments = ColorAdjustments {
            hue_shift: 30.0,
            sat_adjust: 0.0,
            lum_adjust: 0.0,
        };

        let filter = build_qualifier_filter(&params, &adjustments, 1920, 1080);

        assert!(filter.contains("split"), "Should split input");
        assert!(filter.contains("hue=h=30"), "Should have hue shift");
        assert!(
            filter.contains("overlay"),
            "Should use overlay for blending"
        );
    }

    #[test]
    fn test_build_qualifier_filter_with_saturation() {
        let params = QualifierParams::new();
        let adjustments = ColorAdjustments {
            hue_shift: 0.0,
            sat_adjust: 0.5,
            lum_adjust: 0.0,
        };

        let filter = build_qualifier_filter(&params, &adjustments, 1920, 1080);

        assert!(
            filter.contains("s=1.5"),
            "Saturation +0.5 should multiply by 1.5"
        );
    }

    #[test]
    fn test_build_qualifier_filter_with_softness() {
        let mut params = QualifierParams::new();
        params.softness = 0.2;

        let adjustments = ColorAdjustments {
            hue_shift: 30.0,
            ..ColorAdjustments::default()
        };

        let filter = build_qualifier_filter(&params, &adjustments, 1920, 1080);

        assert!(
            filter.contains("boxblur"),
            "Softness should add blur: {}",
            filter
        );
    }

    #[test]
    fn test_build_qualified_mask_filter_empty_mask() {
        let params = QualifierParams::new();
        let adjustments = ColorAdjustments {
            hue_shift: 30.0,
            ..ColorAdjustments::default()
        };
        let mask_group = MaskGroup::new();

        let filter = build_qualified_mask_filter(&params, &adjustments, &mask_group, 1920, 1080);

        // With empty mask group, should still work (255 = full selection)
        assert!(filter.contains("split"), "Should split input");
        assert!(filter.contains("overlay"), "Should use overlay");
    }

    #[test]
    fn test_build_qualified_mask_filter_with_mask() {
        use crate::core::masks::{Mask, MaskShape, RectMask};

        let params = QualifierParams::new();
        let adjustments = ColorAdjustments {
            hue_shift: 30.0,
            ..ColorAdjustments::default()
        };

        let mut mask_group = MaskGroup::new();
        mask_group.add(Mask::new(MaskShape::Rectangle(RectMask::default())));

        let filter = build_qualified_mask_filter(&params, &adjustments, &mask_group, 1920, 1080);

        // Combined filter should have min() for intersection
        assert!(
            filter.contains("min("),
            "Combined mask should use min for intersection: {}",
            filter
        );
    }

    #[test]
    fn test_build_qualifier_preview_filter() {
        let params = QualifierParams::new();
        let filter = build_qualifier_preview_filter(&params);

        assert!(filter.contains("format=rgba"), "Should ensure RGBA format");
        assert!(
            filter.contains("r='") && filter.contains("g='") && filter.contains("b='"),
            "Should set RGB channels to alpha value"
        );
    }

    #[test]
    fn test_build_qualifier_filter_full_adjustments() {
        let params = QualifierParams::new();
        let adjustments = ColorAdjustments {
            hue_shift: -30.0,
            sat_adjust: 0.2,
            lum_adjust: -0.1,
        };

        let filter = build_qualifier_filter(&params, &adjustments, 1920, 1080);

        assert!(filter.contains("h=-30"), "Should have negative hue shift");
        assert!(filter.contains("s=1.2"), "Should have saturation boost");
        assert!(
            filter.contains("b=-0.1"),
            "Should have brightness reduction"
        );
    }
}
