//! Mask System Module
//!
//! Provides shape-based masking for selective effects application.
//! Supports rectangle, ellipse, polygon, and bezier curve masks.
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

use serde::{Deserialize, Serialize};
use ulid::Ulid;

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
        }
    }

    /// Returns the shape type name
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Rectangle(_) => "rectangle",
            Self::Ellipse(_) => "ellipse",
            Self::Polygon(_) => "polygon",
            Self::Bezier(_) => "bezier",
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
}

fn default_one() -> f64 {
    1.0
}

impl Mask {
    /// Creates a new mask with default properties
    pub fn new(shape: MaskShape) -> Self {
        let id = generate_mask_id();
        Self {
            name: format!("Mask {}", &id[..4]),
            id,
            shape,
            inverted: false,
            feather: 0.0,
            opacity: 1.0,
            expansion: 0.0,
            blend_mode: MaskBlendMode::Add,
            enabled: true,
            locked: false,
        }
    }

    /// Creates a mask with a specific ID
    pub fn with_id(id: MaskId, shape: MaskShape) -> Self {
        Self {
            name: format!("Mask {}", &id[..4]),
            id,
            shape,
            inverted: false,
            feather: 0.0,
            opacity: 1.0,
            expansion: 0.0,
            blend_mode: MaskBlendMode::Add,
            enabled: true,
            locked: false,
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
}
