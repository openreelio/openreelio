//! Mask System Module
//!
//! Provides shape-based masking for selective effects application.
//! Supports rectangle, ellipse, polygon, bezier curve, and gradient masks.
//!
//! # Example
//!
//! ```ignore
//! use openreelio_lib::core::masks::{Mask, MaskShape, RectMask};
//!
//! let rect_mask = Mask::new(MaskShape::Rectangle(RectMask {
//!     x: 0.25,
//!     y: 0.25,
//!     width: 0.5,
//!     height: 0.5,
//!     corner_radius: 0.0,
//!     rotation: 0.0,
//! }));
//! ```

pub mod interpolation;

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::core::effects::Easing;
use crate::core::MaskId;

/// Generates a new unique mask ID
fn generate_mask_id() -> MaskId {
    Ulid::new().to_string()
}

// =============================================================================
// Mask Shape Types
// =============================================================================

/// A 2D point with normalized coordinates (0.0-1.0)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point2D {
    /// X coordinate (0.0 = left, 1.0 = right)
    pub x: f64,
    /// Y coordinate (0.0 = top, 1.0 = bottom)
    pub y: f64,
}

impl Point2D {
    /// Creates a new point
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Creates a centered point
    pub fn center() -> Self {
        Self { x: 0.5, y: 0.5 }
    }

    /// Clamps coordinates to valid range
    pub fn clamp(&self) -> Self {
        Self {
            x: self.x.clamp(0.0, 1.0),
            y: self.y.clamp(0.0, 1.0),
        }
    }
}

impl Default for Point2D {
    fn default() -> Self {
        Self::center()
    }
}

/// Rectangle mask shape
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectMask {
    /// Center X (normalized 0.0-1.0)
    pub x: f64,
    /// Center Y (normalized 0.0-1.0)
    pub y: f64,
    /// Width (normalized 0.0-1.0)
    pub width: f64,
    /// Height (normalized 0.0-1.0)
    pub height: f64,
    /// Corner radius for rounded rectangles (normalized)
    #[serde(default)]
    pub corner_radius: f64,
    /// Rotation in degrees
    #[serde(default)]
    pub rotation: f64,
}

impl Default for RectMask {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            width: 0.5,
            height: 0.5,
            corner_radius: 0.0,
            rotation: 0.0,
        }
    }
}

impl RectMask {
    /// Creates a new rectangle mask
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
            corner_radius: 0.0,
            rotation: 0.0,
        }
    }

    /// Sets corner radius
    pub fn with_corner_radius(mut self, radius: f64) -> Self {
        self.corner_radius = radius.clamp(0.0, 1.0);
        self
    }

    /// Sets rotation
    pub fn with_rotation(mut self, degrees: f64) -> Self {
        self.rotation = degrees;
        self
    }

    /// Validates the rectangle parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.width <= 0.0 || self.width > 2.0 {
            return Err(format!("Invalid width: {}", self.width));
        }
        if self.height <= 0.0 || self.height > 2.0 {
            return Err(format!("Invalid height: {}", self.height));
        }
        Ok(())
    }
}

/// Ellipse mask shape
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EllipseMask {
    /// Center X (normalized 0.0-1.0)
    pub x: f64,
    /// Center Y (normalized 0.0-1.0)
    pub y: f64,
    /// Horizontal radius (normalized)
    pub radius_x: f64,
    /// Vertical radius (normalized)
    pub radius_y: f64,
    /// Rotation in degrees
    #[serde(default)]
    pub rotation: f64,
}

impl Default for EllipseMask {
    fn default() -> Self {
        Self {
            x: 0.5,
            y: 0.5,
            radius_x: 0.25,
            radius_y: 0.25,
            rotation: 0.0,
        }
    }
}

impl EllipseMask {
    /// Creates a new ellipse mask
    pub fn new(x: f64, y: f64, radius_x: f64, radius_y: f64) -> Self {
        Self {
            x,
            y,
            radius_x,
            radius_y,
            rotation: 0.0,
        }
    }

    /// Creates a circle mask
    pub fn circle(x: f64, y: f64, radius: f64) -> Self {
        Self {
            x,
            y,
            radius_x: radius,
            radius_y: radius,
            rotation: 0.0,
        }
    }

    /// Validates the ellipse parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.radius_x <= 0.0 {
            return Err(format!("Invalid radius_x: {}", self.radius_x));
        }
        if self.radius_y <= 0.0 {
            return Err(format!("Invalid radius_y: {}", self.radius_y));
        }
        Ok(())
    }
}

/// Polygon mask shape (closed path of points)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolygonMask {
    /// Polygon vertices (minimum 3)
    pub points: Vec<Point2D>,
}

impl Default for PolygonMask {
    fn default() -> Self {
        // Default triangle
        Self {
            points: vec![
                Point2D::new(0.5, 0.25),
                Point2D::new(0.25, 0.75),
                Point2D::new(0.75, 0.75),
            ],
        }
    }
}

impl PolygonMask {
    /// Creates a new polygon mask
    pub fn new(points: Vec<Point2D>) -> Self {
        Self { points }
    }

    /// Creates a regular polygon with n sides
    pub fn regular(center_x: f64, center_y: f64, radius: f64, sides: usize) -> Self {
        let mut points = Vec::with_capacity(sides);
        for i in 0..sides {
            let angle = (i as f64 / sides as f64) * 2.0 * std::f64::consts::PI
                - std::f64::consts::FRAC_PI_2;
            points.push(Point2D::new(
                center_x + radius * angle.cos(),
                center_y + radius * angle.sin(),
            ));
        }
        Self { points }
    }

    /// Validates the polygon
    pub fn validate(&self) -> Result<(), String> {
        if self.points.len() < 3 {
            return Err(format!(
                "Polygon requires at least 3 points, got {}",
                self.points.len()
            ));
        }
        Ok(())
    }
}

/// Bezier control point for curve masks
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BezierPoint {
    /// Anchor point
    pub anchor: Point2D,
    /// Control point for incoming tangent (relative to anchor)
    #[serde(default)]
    pub handle_in: Option<Point2D>,
    /// Control point for outgoing tangent (relative to anchor)
    #[serde(default)]
    pub handle_out: Option<Point2D>,
}

impl BezierPoint {
    /// Creates a new bezier point without handles (corner)
    pub fn corner(x: f64, y: f64) -> Self {
        Self {
            anchor: Point2D::new(x, y),
            handle_in: None,
            handle_out: None,
        }
    }

    /// Creates a bezier point with symmetric handles (smooth)
    pub fn smooth(x: f64, y: f64, handle_x: f64, handle_y: f64) -> Self {
        Self {
            anchor: Point2D::new(x, y),
            handle_in: Some(Point2D::new(-handle_x, -handle_y)),
            handle_out: Some(Point2D::new(handle_x, handle_y)),
        }
    }
}

/// Bezier curve mask shape
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BezierMask {
    /// Bezier control points
    pub points: Vec<BezierPoint>,
    /// Whether the path is closed
    #[serde(default = "default_true")]
    pub closed: bool,
}

fn default_true() -> bool {
    true
}

impl Default for BezierMask {
    fn default() -> Self {
        Self {
            points: vec![
                BezierPoint::corner(0.25, 0.25),
                BezierPoint::corner(0.75, 0.25),
                BezierPoint::corner(0.75, 0.75),
                BezierPoint::corner(0.25, 0.75),
            ],
            closed: true,
        }
    }
}

impl BezierMask {
    /// Creates a new bezier mask
    pub fn new(points: Vec<BezierPoint>, closed: bool) -> Self {
        Self { points, closed }
    }

    /// Validates the bezier mask
    pub fn validate(&self) -> Result<(), String> {
        if self.points.len() < 2 {
            return Err(format!(
                "Bezier path requires at least 2 points, got {}",
                self.points.len()
            ));
        }
        Ok(())
    }
}

// =============================================================================
// Gradient Mask
// =============================================================================

/// Gradient type for gradient masks
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GradientType {
    /// Linear gradient along a line between start and end points
    #[default]
    Linear,
    /// Radial gradient emanating from start point with radius to end point
    Radial,
}

/// Gradient mask shape for soft power windows
///
/// Creates a smooth alpha transition between fully opaque and fully transparent.
/// For linear gradients: alpha varies along the perpendicular to the start→end line.
/// For radial gradients: alpha varies with distance from the start point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradientMask {
    /// Start point of the gradient (normalized 0.0-1.0)
    pub start: Point2D,
    /// End point of the gradient (normalized 0.0-1.0)
    pub end: Point2D,
    /// Gradient type (linear or radial)
    #[serde(default)]
    pub gradient_type: GradientType,
}

impl Default for GradientMask {
    fn default() -> Self {
        Self {
            start: Point2D::new(0.25, 0.5),
            end: Point2D::new(0.75, 0.5),
            gradient_type: GradientType::Linear,
        }
    }
}

impl GradientMask {
    /// Creates a new linear gradient mask
    pub fn linear(start: Point2D, end: Point2D) -> Self {
        Self {
            start,
            end,
            gradient_type: GradientType::Linear,
        }
    }

    /// Creates a new radial gradient mask
    pub fn radial(center: Point2D, edge: Point2D) -> Self {
        Self {
            start: center,
            end: edge,
            gradient_type: GradientType::Radial,
        }
    }

    /// Validates the gradient mask
    pub fn validate(&self) -> Result<(), String> {
        let dx = self.end.x - self.start.x;
        let dy = self.end.y - self.start.y;
        let dist_sq = dx * dx + dy * dy;
        if dist_sq < 1e-10 {
            return Err("Gradient start and end points must be different".to_string());
        }
        Ok(())
    }
}

// =============================================================================
// Mask Shape Enum
// =============================================================================

/// Mask shape types
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MaskShape {
    /// Rectangle mask
    Rectangle(RectMask),
    /// Ellipse/circle mask
    Ellipse(EllipseMask),
    /// Polygon mask (closed path)
    Polygon(PolygonMask),
    /// Bezier curve mask
    Bezier(BezierMask),
    /// Gradient mask (linear or radial soft transition)
    Gradient(GradientMask),
}

impl Default for MaskShape {
    fn default() -> Self {
        Self::Rectangle(RectMask::default())
    }
}

impl MaskShape {
    /// Validates the mask shape
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Rectangle(r) => r.validate(),
            Self::Ellipse(e) => e.validate(),
            Self::Polygon(p) => p.validate(),
            Self::Bezier(b) => b.validate(),
            Self::Gradient(g) => g.validate(),
        }
    }

    /// Returns the shape type name
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Rectangle(_) => "rectangle",
            Self::Ellipse(_) => "ellipse",
            Self::Polygon(_) => "polygon",
            Self::Bezier(_) => "bezier",
            Self::Gradient(_) => "gradient",
        }
    }
}

// =============================================================================
// Mask Properties
// =============================================================================

/// Blend mode for mask edges
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MaskBlendMode {
    /// Add to existing mask
    #[default]
    Add,
    /// Subtract from existing mask
    Subtract,
    /// Intersect with existing mask
    Intersect,
    /// Difference with existing mask
    Difference,
}

/// A keyframe for mask shape animation.
///
/// Stores a complete mask shape snapshot at a point in time, enabling
/// smooth interpolation between shapes across the clip duration.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskKeyframe {
    /// Time offset from clip start (seconds)
    pub time_offset: f64,
    /// Complete mask shape at this keyframe
    pub shape: MaskShape,
    /// Easing function to next keyframe
    #[serde(default)]
    pub easing: Easing,
}

impl MaskKeyframe {
    /// Creates a new mask keyframe with linear easing
    pub fn new(time_offset: f64, shape: MaskShape) -> Self {
        Self {
            time_offset,
            shape,
            easing: Easing::Linear,
        }
    }

    /// Creates a mask keyframe with specified easing
    pub fn with_easing(time_offset: f64, shape: MaskShape, easing: Easing) -> Self {
        Self {
            time_offset,
            shape,
            easing,
        }
    }
}

/// Mask instance with all properties
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    /// Unique identifier
    pub id: MaskId,
    /// Display name
    pub name: String,
    /// Mask shape
    pub shape: MaskShape,
    /// Whether mask is inverted
    #[serde(default)]
    pub inverted: bool,
    /// Feather amount (edge softness, normalized 0.0-1.0)
    #[serde(default)]
    pub feather: f64,
    /// Mask opacity (0.0-1.0)
    #[serde(default = "default_one")]
    pub opacity: f64,
    /// Expansion/contraction (-1.0 to 1.0)
    #[serde(default)]
    pub expansion: f64,
    /// Blend mode with other masks
    #[serde(default)]
    pub blend_mode: MaskBlendMode,
    /// Whether mask is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Whether mask is locked from editing
    #[serde(default)]
    pub locked: bool,
    /// Shape keyframes for animation over time
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyframes: Vec<MaskKeyframe>,
    /// Reference to tracking effect ID that drives this mask's animation
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_source_id: Option<String>,
}

fn default_one() -> f64 {
    1.0
}

impl Mask {
    /// Creates a new mask with default properties
    pub fn new(shape: MaskShape) -> Self {
        let id = generate_mask_id();
        let short = id.get(..4).unwrap_or(&id);
        Self {
            name: format!("Mask {short}"),
            id,
            shape,
            inverted: false,
            feather: 0.0,
            opacity: 1.0,
            expansion: 0.0,
            blend_mode: MaskBlendMode::Add,
            enabled: true,
            locked: false,
            keyframes: Vec::new(),
            tracking_source_id: None,
        }
    }

    /// Creates a mask with a specific ID
    pub fn with_id(id: MaskId, shape: MaskShape) -> Self {
        let short = id.get(..4).unwrap_or(&id);
        Self {
            name: format!("Mask {short}"),
            id,
            shape,
            inverted: false,
            feather: 0.0,
            opacity: 1.0,
            expansion: 0.0,
            blend_mode: MaskBlendMode::Add,
            enabled: true,
            locked: false,
            keyframes: Vec::new(),
            tracking_source_id: None,
        }
    }

    /// Sets the mask name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    /// Sets feather amount
    pub fn with_feather(mut self, feather: f64) -> Self {
        self.feather = feather.clamp(0.0, 1.0);
        self
    }

    /// Sets inversion
    pub fn inverted(mut self) -> Self {
        self.inverted = true;
        self
    }

    /// Returns the interpolated shape at a given time offset.
    ///
    /// If no keyframes exist, returns the base shape.
    /// If time is before all keyframes, returns the first keyframe's shape.
    /// If time is after all keyframes, returns the last keyframe's shape.
    /// Otherwise interpolates between the surrounding keyframes.
    pub fn shape_at_time(&self, time_offset: f64) -> MaskShape {
        if self.keyframes.is_empty() {
            return self.shape.clone();
        }

        let kfs = &self.keyframes;

        // Before first keyframe
        if time_offset <= kfs[0].time_offset {
            return kfs[0].shape.clone();
        }

        // After last keyframe
        if time_offset >= kfs[kfs.len() - 1].time_offset {
            return kfs[kfs.len() - 1].shape.clone();
        }

        // Find surrounding keyframes
        for i in 0..kfs.len() - 1 {
            let kf_a = &kfs[i];
            let kf_b = &kfs[i + 1];
            if time_offset >= kf_a.time_offset && time_offset <= kf_b.time_offset {
                let duration = kf_b.time_offset - kf_a.time_offset;
                if duration <= 0.0 {
                    return kf_a.shape.clone();
                }
                let raw_t = (time_offset - kf_a.time_offset) / duration;
                let t = interpolation::apply_easing(raw_t, &kf_a.easing);
                return interpolation::interpolate_mask_shape(&kf_a.shape, &kf_b.shape, t);
            }
        }

        // Fallback (should not reach)
        self.shape.clone()
    }

    /// Inserts or replaces a keyframe at the given time offset (sorted by time).
    ///
    /// Returns the previous keyframe at that time if one existed (within tolerance).
    pub fn set_keyframe(&mut self, keyframe: MaskKeyframe) -> Option<MaskKeyframe> {
        const TIME_TOLERANCE: f64 = 0.001;
        let time = keyframe.time_offset;

        // Replace existing keyframe at the same time
        if let Some(pos) = self
            .keyframes
            .iter()
            .position(|kf| (kf.time_offset - time).abs() < TIME_TOLERANCE)
        {
            let old = std::mem::replace(&mut self.keyframes[pos], keyframe);
            return Some(old);
        }

        // Insert in sorted order
        let insert_pos = self
            .keyframes
            .iter()
            .position(|kf| kf.time_offset > time)
            .unwrap_or(self.keyframes.len());
        self.keyframes.insert(insert_pos, keyframe);
        None
    }

    /// Removes a keyframe at the given time offset (within tolerance).
    ///
    /// Returns the removed keyframe if found.
    pub fn remove_keyframe(&mut self, time_offset: f64) -> Option<MaskKeyframe> {
        const TIME_TOLERANCE: f64 = 0.001;
        if let Some(pos) = self
            .keyframes
            .iter()
            .position(|kf| (kf.time_offset - time_offset).abs() < TIME_TOLERANCE)
        {
            Some(self.keyframes.remove(pos))
        } else {
            None
        }
    }

    /// Returns true if this mask has animation keyframes
    pub fn is_animated(&self) -> bool {
        !self.keyframes.is_empty()
    }

    /// Generates mask keyframes from tracking data.
    ///
    /// Each tracked point's position delta (relative to the tracking origin)
    /// is applied as a translation to the mask's base shape.
    /// This drives the mask to follow the tracked object across frames.
    pub fn apply_tracking_data(
        &mut self,
        tracking_points: &[crate::core::tracking::models::TrackPointData],
        origin_x: f64,
        origin_y: f64,
        fps: f64,
        tracking_source_id: String,
    ) {
        use crate::core::tracking::models::TrackPointData;

        let keyframes: Vec<MaskKeyframe> = tracking_points
            .iter()
            .map(|pt: &TrackPointData| {
                let dx = pt.x - origin_x;
                let dy = pt.y - origin_y;
                let time = pt.frame as f64 / fps;
                let translated = interpolation::translate_shape(&self.shape, dx, dy);
                MaskKeyframe::new(time, translated)
            })
            .collect();

        self.keyframes = keyframes;
        self.tracking_source_id = Some(tracking_source_id);
    }

    /// Clears tracking link and all generated keyframes
    pub fn clear_tracking(&mut self) {
        self.keyframes.clear();
        self.tracking_source_id = None;
    }

    /// Validates the mask
    pub fn validate(&self) -> Result<(), String> {
        self.shape.validate()?;

        if self.feather < 0.0 || self.feather > 1.0 {
            return Err(format!("Invalid feather value: {}", self.feather));
        }
        if self.opacity < 0.0 || self.opacity > 1.0 {
            return Err(format!("Invalid opacity value: {}", self.opacity));
        }
        if self.expansion < -1.0 || self.expansion > 1.0 {
            return Err(format!("Invalid expansion value: {}", self.expansion));
        }

        // Validate keyframes are sorted by time
        for window in self.keyframes.windows(2) {
            if window[1].time_offset < window[0].time_offset {
                return Err("Mask keyframes must be sorted by time_offset".to_string());
            }
        }
        for kf in &self.keyframes {
            kf.shape.validate()?;
        }

        Ok(())
    }
}

// =============================================================================
// Mask Group (for combining multiple masks)
// =============================================================================

/// A group of masks that can be applied together
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskGroup {
    /// Masks in this group (applied in order)
    pub masks: Vec<Mask>,
}

impl MaskGroup {
    /// Creates an empty mask group
    pub fn new() -> Self {
        Self { masks: Vec::new() }
    }

    /// Adds a mask to the group
    pub fn add(&mut self, mask: Mask) {
        self.masks.push(mask);
    }

    /// Removes a mask by ID
    pub fn remove(&mut self, id: &MaskId) -> Option<Mask> {
        if let Some(pos) = self.masks.iter().position(|m| &m.id == id) {
            Some(self.masks.remove(pos))
        } else {
            None
        }
    }

    /// Gets a mask by ID
    pub fn get(&self, id: &MaskId) -> Option<&Mask> {
        self.masks.iter().find(|m| &m.id == id)
    }

    /// Gets a mutable mask by ID
    pub fn get_mut(&mut self, id: &MaskId) -> Option<&mut Mask> {
        self.masks.iter_mut().find(|m| &m.id == id)
    }

    /// Returns the number of masks
    pub fn len(&self) -> usize {
        self.masks.len()
    }

    /// Returns true if there are no masks
    pub fn is_empty(&self) -> bool {
        self.masks.is_empty()
    }

    /// Returns true if any mask in the group is enabled
    pub fn has_enabled_masks(&self) -> bool {
        self.masks.iter().any(|m| m.enabled)
    }

    /// Returns the maximum feather value across all enabled masks
    pub fn max_feather(&self) -> f64 {
        self.masks
            .iter()
            .filter(|m| m.enabled)
            .map(|m| m.feather)
            .fold(0.0_f64, f64::max)
    }

    /// Validates all masks in the group
    pub fn validate(&self) -> Result<(), String> {
        for mask in &self.masks {
            mask.validate()?;
        }
        Ok(())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point2d_new() {
        let point = Point2D::new(0.25, 0.75);
        assert_eq!(point.x, 0.25);
        assert_eq!(point.y, 0.75);
    }

    #[test]
    fn test_point2d_center() {
        let point = Point2D::center();
        assert_eq!(point.x, 0.5);
        assert_eq!(point.y, 0.5);
    }

    #[test]
    fn test_point2d_clamp() {
        let point = Point2D::new(-0.5, 1.5);
        let clamped = point.clamp();
        assert_eq!(clamped.x, 0.0);
        assert_eq!(clamped.y, 1.0);
    }

    #[test]
    fn test_rect_mask_default() {
        let rect = RectMask::default();
        assert_eq!(rect.x, 0.5);
        assert_eq!(rect.y, 0.5);
        assert_eq!(rect.width, 0.5);
        assert_eq!(rect.height, 0.5);
        assert_eq!(rect.corner_radius, 0.0);
        assert_eq!(rect.rotation, 0.0);
    }

    #[test]
    fn test_rect_mask_validate() {
        let valid = RectMask::new(0.5, 0.5, 0.5, 0.5);
        assert!(valid.validate().is_ok());

        let invalid_width = RectMask::new(0.5, 0.5, 0.0, 0.5);
        assert!(invalid_width.validate().is_err());

        let invalid_height = RectMask::new(0.5, 0.5, 0.5, -0.1);
        assert!(invalid_height.validate().is_err());
    }

    #[test]
    fn test_rect_mask_with_corner_radius() {
        let rect = RectMask::default().with_corner_radius(0.1);
        assert_eq!(rect.corner_radius, 0.1);

        // Test clamping
        let rect_clamped = RectMask::default().with_corner_radius(2.0);
        assert_eq!(rect_clamped.corner_radius, 1.0);
    }

    #[test]
    fn test_ellipse_mask_default() {
        let ellipse = EllipseMask::default();
        assert_eq!(ellipse.x, 0.5);
        assert_eq!(ellipse.y, 0.5);
        assert_eq!(ellipse.radius_x, 0.25);
        assert_eq!(ellipse.radius_y, 0.25);
    }

    #[test]
    fn test_ellipse_mask_circle() {
        let circle = EllipseMask::circle(0.5, 0.5, 0.3);
        assert_eq!(circle.radius_x, 0.3);
        assert_eq!(circle.radius_y, 0.3);
    }

    #[test]
    fn test_ellipse_mask_validate() {
        let valid = EllipseMask::default();
        assert!(valid.validate().is_ok());

        let invalid = EllipseMask::new(0.5, 0.5, 0.0, 0.25);
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn test_polygon_mask_default() {
        let polygon = PolygonMask::default();
        assert_eq!(polygon.points.len(), 3);
    }

    #[test]
    fn test_polygon_mask_regular() {
        let hexagon = PolygonMask::regular(0.5, 0.5, 0.25, 6);
        assert_eq!(hexagon.points.len(), 6);
    }

    #[test]
    fn test_polygon_mask_validate() {
        let valid = PolygonMask::default();
        assert!(valid.validate().is_ok());

        let invalid = PolygonMask::new(vec![Point2D::new(0.0, 0.0), Point2D::new(1.0, 1.0)]);
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn test_bezier_point_corner() {
        let point = BezierPoint::corner(0.5, 0.5);
        assert!(point.handle_in.is_none());
        assert!(point.handle_out.is_none());
    }

    #[test]
    fn test_bezier_point_smooth() {
        let point = BezierPoint::smooth(0.5, 0.5, 0.1, 0.0);
        assert!(point.handle_in.is_some());
        assert!(point.handle_out.is_some());
    }

    #[test]
    fn test_bezier_mask_validate() {
        let valid = BezierMask::default();
        assert!(valid.validate().is_ok());

        let invalid = BezierMask::new(vec![BezierPoint::corner(0.5, 0.5)], true);
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn test_gradient_mask_default() {
        let gradient = GradientMask::default();
        assert_eq!(gradient.start.x, 0.25);
        assert_eq!(gradient.end.x, 0.75);
        assert_eq!(gradient.gradient_type, GradientType::Linear);
    }

    #[test]
    fn test_gradient_mask_linear_factory() {
        let gradient = GradientMask::linear(Point2D::new(0.0, 0.5), Point2D::new(1.0, 0.5));
        assert_eq!(gradient.gradient_type, GradientType::Linear);
        assert_eq!(gradient.start.x, 0.0);
        assert_eq!(gradient.end.x, 1.0);
    }

    #[test]
    fn test_gradient_mask_radial_factory() {
        let gradient = GradientMask::radial(Point2D::new(0.5, 0.5), Point2D::new(0.5, 0.0));
        assert_eq!(gradient.gradient_type, GradientType::Radial);
    }

    #[test]
    fn test_gradient_mask_validate_valid() {
        let gradient = GradientMask::default();
        assert!(gradient.validate().is_ok());
    }

    #[test]
    fn test_gradient_mask_validate_same_points_rejected() {
        let gradient = GradientMask::linear(Point2D::new(0.5, 0.5), Point2D::new(0.5, 0.5));
        assert!(
            gradient.validate().is_err(),
            "Same start and end points should be rejected"
        );
    }

    #[test]
    fn test_gradient_mask_serialization() {
        let gradient = GradientMask::default();
        let shape = MaskShape::Gradient(gradient);
        let json = serde_json::to_string(&shape).unwrap();
        assert!(json.contains("\"type\":\"gradient\""));
        assert!(json.contains("\"gradientType\":\"linear\""));

        let deserialized: MaskShape = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.type_name(), "gradient");
    }

    #[test]
    fn test_mask_shape_type_name() {
        assert_eq!(
            MaskShape::Rectangle(RectMask::default()).type_name(),
            "rectangle"
        );
        assert_eq!(
            MaskShape::Ellipse(EllipseMask::default()).type_name(),
            "ellipse"
        );
        assert_eq!(
            MaskShape::Polygon(PolygonMask::default()).type_name(),
            "polygon"
        );
        assert_eq!(
            MaskShape::Bezier(BezierMask::default()).type_name(),
            "bezier"
        );
        assert_eq!(
            MaskShape::Gradient(GradientMask::default()).type_name(),
            "gradient"
        );
    }

    #[test]
    fn test_mask_new() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        assert!(!mask.inverted);
        assert_eq!(mask.feather, 0.0);
        assert_eq!(mask.opacity, 1.0);
        assert!(mask.enabled);
    }

    #[test]
    fn test_mask_with_feather() {
        let mask = Mask::new(MaskShape::default()).with_feather(0.5);
        assert_eq!(mask.feather, 0.5);

        // Test clamping
        let mask_clamped = Mask::new(MaskShape::default()).with_feather(2.0);
        assert_eq!(mask_clamped.feather, 1.0);
    }

    #[test]
    fn test_mask_inverted() {
        let mask = Mask::new(MaskShape::default()).inverted();
        assert!(mask.inverted);
    }

    #[test]
    fn test_mask_validate() {
        let valid = Mask::new(MaskShape::default());
        assert!(valid.validate().is_ok());

        let mut invalid = Mask::new(MaskShape::default());
        invalid.feather = 2.0;
        assert!(invalid.validate().is_err());

        let mut invalid_opacity = Mask::new(MaskShape::default());
        invalid_opacity.opacity = -0.5;
        assert!(invalid_opacity.validate().is_err());
    }

    #[test]
    fn test_mask_group_operations() {
        let mut group = MaskGroup::new();
        assert!(group.is_empty());

        let mask1 = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let mask1_id = mask1.id.clone();
        group.add(mask1);

        assert_eq!(group.len(), 1);
        assert!(!group.is_empty());

        assert!(group.get(&mask1_id).is_some());

        let removed = group.remove(&mask1_id);
        assert!(removed.is_some());
        assert!(group.is_empty());
    }

    #[test]
    fn test_mask_serialization() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()))
            .with_name("Test Mask")
            .with_feather(0.1);

        let json = serde_json::to_string(&mask).unwrap();
        let deserialized: Mask = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.name, "Test Mask");
        assert_eq!(deserialized.feather, 0.1);
    }

    #[test]
    fn test_mask_shape_serialization() {
        let rect_shape = MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.4, 0.3));
        let json = serde_json::to_string(&rect_shape).unwrap();
        assert!(json.contains("\"type\":\"rectangle\""));

        let ellipse_shape = MaskShape::Ellipse(EllipseMask::circle(0.5, 0.5, 0.2));
        let json = serde_json::to_string(&ellipse_shape).unwrap();
        assert!(json.contains("\"type\":\"ellipse\""));
    }

    // =========================================================================
    // BDD Tests: Animated Mask Paths (TASK-S39-002)
    // =========================================================================

    const EPSILON: f64 = 1e-6;

    fn approx_eq(a: f64, b: f64, msg: &str) {
        assert!((a - b).abs() < EPSILON, "{msg}: expected {b}, got {a}");
    }

    // -- Feature: shape_at_time returns correct interpolated shape --

    #[test]
    fn should_return_base_shape_when_no_keyframes_exist() {
        // Given a mask with no keyframes
        let mask = Mask::new(MaskShape::Rectangle(RectMask::new(0.3, 0.3, 0.4, 0.4)));

        // When calling shape_at_time at any time
        let shape = mask.shape_at_time(1.0);

        // Then the base shape should be returned
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.3, "base x");
            approx_eq(r.y, 0.3, "base y");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_return_first_keyframe_shape_before_first_keyframe_time() {
        // Given a mask with keyframes starting at t=1.0
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.keyframes = vec![
            MaskKeyframe::new(1.0, MaskShape::Rectangle(RectMask::new(0.3, 0.3, 0.4, 0.4))),
            MaskKeyframe::new(3.0, MaskShape::Rectangle(RectMask::new(0.7, 0.7, 0.4, 0.4))),
        ];

        // When calling shape_at_time before the first keyframe
        let shape = mask.shape_at_time(0.0);

        // Then the first keyframe shape should be returned
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.3, "first kf x");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_return_last_keyframe_shape_after_last_keyframe_time() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.keyframes = vec![
            MaskKeyframe::new(0.0, MaskShape::Rectangle(RectMask::new(0.3, 0.3, 0.4, 0.4))),
            MaskKeyframe::new(2.0, MaskShape::Rectangle(RectMask::new(0.7, 0.7, 0.4, 0.4))),
        ];

        let shape = mask.shape_at_time(5.0);

        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.7, "last kf x");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_interpolate_between_keyframes_at_midpoint() {
        // Given a mask with two rectangle keyframes
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.keyframes = vec![
            MaskKeyframe::new(0.0, MaskShape::Rectangle(RectMask::new(0.2, 0.2, 0.4, 0.4))),
            MaskKeyframe::new(2.0, MaskShape::Rectangle(RectMask::new(0.8, 0.8, 0.4, 0.4))),
        ];

        // When calling shape_at_time at the midpoint
        let shape = mask.shape_at_time(1.0);

        // Then the position should be interpolated
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.5, "interpolated x");
            approx_eq(r.y, 0.5, "interpolated y");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_interpolate_with_three_keyframes() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.keyframes = vec![
            MaskKeyframe::new(0.0, MaskShape::Rectangle(RectMask::new(0.0, 0.5, 0.4, 0.4))),
            MaskKeyframe::new(1.0, MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.4, 0.4))),
            MaskKeyframe::new(2.0, MaskShape::Rectangle(RectMask::new(1.0, 0.5, 0.4, 0.4))),
        ];

        // Between kf0 and kf1
        let shape = mask.shape_at_time(0.5);
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.25, "first segment midpoint");
        } else {
            panic!("Expected Rectangle");
        }

        // Between kf1 and kf2
        let shape = mask.shape_at_time(1.5);
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.75, "second segment midpoint");
        } else {
            panic!("Expected Rectangle");
        }
    }

    #[test]
    fn should_apply_easing_to_interpolation() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.keyframes = vec![
            MaskKeyframe::with_easing(
                0.0,
                MaskShape::Rectangle(RectMask::new(0.0, 0.5, 0.4, 0.4)),
                crate::core::effects::Easing::EaseIn,
            ),
            MaskKeyframe::new(2.0, MaskShape::Rectangle(RectMask::new(1.0, 0.5, 0.4, 0.4))),
        ];

        // EaseIn at t=0.5 (midpoint): raw_t=0.5, eased = 0.5^2 = 0.25
        let shape = mask.shape_at_time(1.0);
        if let MaskShape::Rectangle(r) = shape {
            approx_eq(r.x, 0.25, "ease-in at midpoint");
        } else {
            panic!("Expected Rectangle");
        }
    }

    // -- Feature: set_keyframe management --

    #[test]
    fn should_insert_keyframe_in_sorted_order() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));

        mask.set_keyframe(MaskKeyframe::new(
            2.0,
            MaskShape::Rectangle(RectMask::new(0.8, 0.5, 0.4, 0.4)),
        ));
        mask.set_keyframe(MaskKeyframe::new(
            0.0,
            MaskShape::Rectangle(RectMask::new(0.2, 0.5, 0.4, 0.4)),
        ));
        mask.set_keyframe(MaskKeyframe::new(
            1.0,
            MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.4, 0.4)),
        ));

        assert_eq!(mask.keyframes.len(), 3);
        approx_eq(mask.keyframes[0].time_offset, 0.0, "first kf time");
        approx_eq(mask.keyframes[1].time_offset, 1.0, "second kf time");
        approx_eq(mask.keyframes[2].time_offset, 2.0, "third kf time");
    }

    #[test]
    fn should_replace_keyframe_at_same_time() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.set_keyframe(MaskKeyframe::new(
            1.0,
            MaskShape::Rectangle(RectMask::new(0.3, 0.5, 0.4, 0.4)),
        ));

        let old = mask.set_keyframe(MaskKeyframe::new(
            1.0,
            MaskShape::Rectangle(RectMask::new(0.7, 0.5, 0.4, 0.4)),
        ));

        assert!(old.is_some(), "Should return replaced keyframe");
        assert_eq!(mask.keyframes.len(), 1, "Should not duplicate");
        if let MaskShape::Rectangle(r) = &mask.keyframes[0].shape {
            approx_eq(r.x, 0.7, "new x");
        }
    }

    // -- Feature: remove_keyframe --

    #[test]
    fn should_remove_keyframe_at_time() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.set_keyframe(MaskKeyframe::new(
            0.0,
            MaskShape::Rectangle(RectMask::default()),
        ));
        mask.set_keyframe(MaskKeyframe::new(
            1.0,
            MaskShape::Rectangle(RectMask::default()),
        ));

        let removed = mask.remove_keyframe(1.0);
        assert!(removed.is_some());
        assert_eq!(mask.keyframes.len(), 1);
    }

    #[test]
    fn should_return_none_when_removing_nonexistent_keyframe() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let removed = mask.remove_keyframe(5.0);
        assert!(removed.is_none());
    }

    // -- Feature: is_animated --

    #[test]
    fn should_report_not_animated_without_keyframes() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        assert!(!mask.is_animated());
    }

    #[test]
    fn should_report_animated_with_keyframes() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.set_keyframe(MaskKeyframe::new(
            0.0,
            MaskShape::Rectangle(RectMask::default()),
        ));
        assert!(mask.is_animated());
    }

    // -- Feature: tracking data to mask keyframes --

    #[test]
    fn should_generate_keyframes_from_tracking_data() {
        use crate::core::tracking::models::TrackPointData;

        // Given a base rectangle mask at (0.5, 0.5)
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.3, 0.3)));

        // And tracking data with 3 points moving right
        let tracking = vec![
            TrackPointData {
                frame: 0,
                x: 0.5,
                y: 0.5,
                confidence: 1.0,
            },
            TrackPointData {
                frame: 15,
                x: 0.55,
                y: 0.5,
                confidence: 0.95,
            },
            TrackPointData {
                frame: 30,
                x: 0.6,
                y: 0.5,
                confidence: 0.9,
            },
        ];

        // When applying tracking data at 30fps
        mask.apply_tracking_data(&tracking, 0.5, 0.5, 30.0, "track-001".to_string());

        // Then 3 keyframes should be created
        assert_eq!(mask.keyframes.len(), 3);
        assert_eq!(mask.tracking_source_id.as_deref(), Some("track-001"));

        // First keyframe: no delta (origin), t=0.0
        approx_eq(mask.keyframes[0].time_offset, 0.0, "kf0 time");
        if let MaskShape::Rectangle(r) = &mask.keyframes[0].shape {
            approx_eq(r.x, 0.5, "kf0 x (no delta)");
        }

        // Second keyframe: dx=0.05, t=0.5s
        approx_eq(mask.keyframes[1].time_offset, 0.5, "kf1 time");
        if let MaskShape::Rectangle(r) = &mask.keyframes[1].shape {
            approx_eq(r.x, 0.55, "kf1 x (shifted)");
        }

        // Third keyframe: dx=0.1, t=1.0s
        approx_eq(mask.keyframes[2].time_offset, 1.0, "kf2 time");
        if let MaskShape::Rectangle(r) = &mask.keyframes[2].shape {
            approx_eq(r.x, 0.6, "kf2 x (shifted)");
        }
    }

    #[test]
    fn should_clear_tracking_data() {
        use crate::core::tracking::models::TrackPointData;

        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::new(0.5, 0.5, 0.3, 0.3)));
        let tracking = vec![TrackPointData {
            frame: 0,
            x: 0.5,
            y: 0.5,
            confidence: 1.0,
        }];
        mask.apply_tracking_data(&tracking, 0.5, 0.5, 30.0, "track-002".to_string());
        assert!(mask.is_animated());

        mask.clear_tracking();
        assert!(!mask.is_animated());
        assert!(mask.tracking_source_id.is_none());
    }

    // -- Feature: MaskKeyframe serialization --

    #[test]
    fn should_serialize_mask_keyframe_round_trip() {
        let kf = MaskKeyframe::with_easing(
            1.5,
            MaskShape::Ellipse(EllipseMask::circle(0.5, 0.5, 0.2)),
            crate::core::effects::Easing::EaseInOut,
        );
        let json = serde_json::to_string(&kf).unwrap();
        let restored: MaskKeyframe = serde_json::from_str(&json).unwrap();
        approx_eq(restored.time_offset, 1.5, "time_offset");
        assert_eq!(restored.easing, crate::core::effects::Easing::EaseInOut);
        assert_eq!(restored.shape.type_name(), "ellipse");
    }

    #[test]
    fn should_serialize_animated_mask_with_keyframes() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        mask.set_keyframe(MaskKeyframe::new(
            0.0,
            MaskShape::Rectangle(RectMask::new(0.2, 0.2, 0.4, 0.4)),
        ));
        mask.set_keyframe(MaskKeyframe::new(
            2.0,
            MaskShape::Rectangle(RectMask::new(0.8, 0.8, 0.4, 0.4)),
        ));

        let json = serde_json::to_string(&mask).unwrap();
        assert!(
            json.contains("\"keyframes\""),
            "JSON should contain keyframes"
        );

        let restored: Mask = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.keyframes.len(), 2);
    }

    #[test]
    fn should_omit_empty_keyframes_in_serialization() {
        let mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        let json = serde_json::to_string(&mask).unwrap();
        assert!(
            !json.contains("\"keyframes\""),
            "Empty keyframes should be omitted"
        );
        assert!(
            !json.contains("\"trackingSourceId\""),
            "None trackingSourceId should be omitted"
        );
    }

    // -- Feature: validate animated mask --

    #[test]
    fn should_validate_keyframe_sort_order() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        // Manually insert unsorted keyframes (bypassing set_keyframe)
        mask.keyframes = vec![
            MaskKeyframe::new(2.0, MaskShape::Rectangle(RectMask::default())),
            MaskKeyframe::new(1.0, MaskShape::Rectangle(RectMask::default())),
        ];
        assert!(
            mask.validate().is_err(),
            "Unsorted keyframes should fail validation"
        );
    }

    #[test]
    fn should_validate_keyframe_shapes() {
        let mut mask = Mask::new(MaskShape::Rectangle(RectMask::default()));
        // Invalid polygon (less than 3 points) inside keyframe
        mask.keyframes = vec![MaskKeyframe::new(
            0.0,
            MaskShape::Polygon(PolygonMask::new(vec![
                Point2D::new(0.0, 0.0),
                Point2D::new(1.0, 1.0),
            ])),
        )];
        assert!(
            mask.validate().is_err(),
            "Invalid keyframe shape should fail validation"
        );
    }
}
