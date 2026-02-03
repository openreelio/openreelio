//! Shape Layers Module
//!
//! Provides data models for shape layers in video editing.
//! Shape layers are independent visual elements that can be placed on the timeline
//! with customizable fill, stroke, position, and effects.
//!
//! # Supported Shapes
//!
//! - **Rectangle**: Boxes with optional corner radius
//! - **Ellipse**: Circles and ovals
//! - **Line**: Straight lines with adjustable width
//! - **Polygon**: Multi-sided shapes (triangle, pentagon, hexagon, etc.)
//! - **Path**: Custom bezier curves
//!
//! # Architecture
//!
//! Shape layers are implemented as a special clip type that renders via FFmpeg's
//! drawing filters (`drawbox`, `geq`). The shape data is stored in `ShapeLayerData`
//! which contains all styling and positioning information.
//!
//! # Example
//!
//! ```rust,ignore
//! use openreelio_lib::core::shapes::{ShapeLayerData, ShapeType, ShapeFill, ShapeStroke};
//!
//! // Create a rounded rectangle with blue fill and white stroke
//! let shape = ShapeLayerData::rectangle()
//!     .with_size(0.3, 0.2)
//!     .with_corner_radius(0.02)
//!     .with_fill(ShapeFill::solid("#0066CC"))
//!     .with_stroke(ShapeStroke::new("#FFFFFF", 3.0));
//! ```

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Shape Types
// =============================================================================

/// Shape type enumeration
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShapeType {
    /// Rectangle shape
    Rectangle(RectangleShape),
    /// Ellipse/circle shape
    Ellipse(EllipseShape),
    /// Straight line
    Line(LineShape),
    /// Regular polygon (triangle, pentagon, etc.)
    Polygon(PolygonShape),
    /// Custom bezier path
    Path(PathShape),
}

impl Default for ShapeType {
    fn default() -> Self {
        Self::Rectangle(RectangleShape::default())
    }
}

impl ShapeType {
    /// Returns the type name as a string
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Rectangle(_) => "rectangle",
            Self::Ellipse(_) => "ellipse",
            Self::Line(_) => "line",
            Self::Polygon(_) => "polygon",
            Self::Path(_) => "path",
        }
    }

    /// Validates the shape
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Rectangle(r) => r.validate(),
            Self::Ellipse(e) => e.validate(),
            Self::Line(l) => l.validate(),
            Self::Polygon(p) => p.validate(),
            Self::Path(p) => p.validate(),
        }
    }
}

// =============================================================================
// Rectangle Shape
// =============================================================================

/// Rectangle shape data
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RectangleShape {
    /// Width as fraction of video width (0.0-1.0)
    pub width: f64,
    /// Height as fraction of video height (0.0-1.0)
    pub height: f64,
    /// Corner radius as fraction of minimum(width, height) (0.0-0.5)
    #[serde(default)]
    pub corner_radius: f64,
}

impl Default for RectangleShape {
    fn default() -> Self {
        Self {
            width: 0.3,
            height: 0.2,
            corner_radius: 0.0,
        }
    }
}

impl RectangleShape {
    /// Creates a new rectangle
    pub fn new(width: f64, height: f64) -> Self {
        Self {
            width: width.clamp(0.001, 1.0),
            height: height.clamp(0.001, 1.0),
            corner_radius: 0.0,
        }
    }

    /// Creates a square
    pub fn square(size: f64) -> Self {
        Self::new(size, size)
    }

    /// Sets the corner radius
    pub fn with_corner_radius(mut self, radius: f64) -> Self {
        self.corner_radius = radius.clamp(0.0, 0.5);
        self
    }

    /// Validates the rectangle
    pub fn validate(&self) -> Result<(), String> {
        if self.width <= 0.0 || self.width > 1.0 {
            return Err(format!("Invalid rectangle width: {}", self.width));
        }
        if self.height <= 0.0 || self.height > 1.0 {
            return Err(format!("Invalid rectangle height: {}", self.height));
        }
        if self.corner_radius < 0.0 || self.corner_radius > 0.5 {
            return Err(format!("Invalid corner radius: {}", self.corner_radius));
        }
        Ok(())
    }
}

// =============================================================================
// Ellipse Shape
// =============================================================================

/// Ellipse/circle shape data
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EllipseShape {
    /// Horizontal radius as fraction of video width
    pub radius_x: f64,
    /// Vertical radius as fraction of video height
    pub radius_y: f64,
}

impl Default for EllipseShape {
    fn default() -> Self {
        Self {
            radius_x: 0.15,
            radius_y: 0.15,
        }
    }
}

impl EllipseShape {
    /// Creates a new ellipse
    pub fn new(radius_x: f64, radius_y: f64) -> Self {
        Self {
            radius_x: radius_x.clamp(0.001, 0.5),
            radius_y: radius_y.clamp(0.001, 0.5),
        }
    }

    /// Creates a circle
    pub fn circle(radius: f64) -> Self {
        Self::new(radius, radius)
    }

    /// Validates the ellipse
    pub fn validate(&self) -> Result<(), String> {
        if self.radius_x <= 0.0 || self.radius_x > 0.5 {
            return Err(format!("Invalid ellipse radius_x: {}", self.radius_x));
        }
        if self.radius_y <= 0.0 || self.radius_y > 0.5 {
            return Err(format!("Invalid ellipse radius_y: {}", self.radius_y));
        }
        Ok(())
    }
}

// =============================================================================
// Line Shape
// =============================================================================

/// Line shape data
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LineShape {
    /// Start point X (normalized)
    pub start_x: f64,
    /// Start point Y (normalized)
    pub start_y: f64,
    /// End point X (normalized)
    pub end_x: f64,
    /// End point Y (normalized)
    pub end_y: f64,
}

impl Default for LineShape {
    fn default() -> Self {
        Self {
            start_x: 0.2,
            start_y: 0.5,
            end_x: 0.8,
            end_y: 0.5,
        }
    }
}

impl LineShape {
    /// Creates a new line
    pub fn new(start_x: f64, start_y: f64, end_x: f64, end_y: f64) -> Self {
        Self {
            start_x: start_x.clamp(0.0, 1.0),
            start_y: start_y.clamp(0.0, 1.0),
            end_x: end_x.clamp(0.0, 1.0),
            end_y: end_y.clamp(0.0, 1.0),
        }
    }

    /// Creates a horizontal line
    pub fn horizontal(y: f64, start_x: f64, end_x: f64) -> Self {
        Self::new(start_x, y, end_x, y)
    }

    /// Creates a vertical line
    pub fn vertical(x: f64, start_y: f64, end_y: f64) -> Self {
        Self::new(x, start_y, x, end_y)
    }

    /// Validates the line
    pub fn validate(&self) -> Result<(), String> {
        // All coordinates are clamped, so just check for degenerate line
        let dx = self.end_x - self.start_x;
        let dy = self.end_y - self.start_y;
        if dx.abs() < 0.0001 && dy.abs() < 0.0001 {
            return Err("Line has zero length".to_string());
        }
        Ok(())
    }
}

// =============================================================================
// Polygon Shape
// =============================================================================

/// Regular polygon shape data
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PolygonShape {
    /// Number of sides (3 = triangle, 5 = pentagon, etc.)
    pub sides: u32,
    /// Radius as fraction of video dimensions
    pub radius: f64,
    /// Rotation offset in degrees
    #[serde(default)]
    pub rotation_offset: f64,
}

impl Default for PolygonShape {
    fn default() -> Self {
        Self {
            sides: 6, // Hexagon
            radius: 0.15,
            rotation_offset: 0.0,
        }
    }
}

impl PolygonShape {
    /// Creates a new regular polygon
    pub fn new(sides: u32, radius: f64) -> Self {
        Self {
            sides: sides.clamp(3, 100),
            radius: radius.clamp(0.001, 0.5),
            rotation_offset: 0.0,
        }
    }

    /// Creates a triangle
    pub fn triangle(radius: f64) -> Self {
        Self::new(3, radius)
    }

    /// Creates a pentagon
    pub fn pentagon(radius: f64) -> Self {
        Self::new(5, radius)
    }

    /// Creates a hexagon
    pub fn hexagon(radius: f64) -> Self {
        Self::new(6, radius)
    }

    /// Creates a star shape (using doubled sides with alternating radius)
    pub fn star(points: u32, radius: f64) -> Self {
        Self {
            sides: points.clamp(3, 50) * 2,
            radius: radius.clamp(0.001, 0.5),
            rotation_offset: 0.0,
        }
    }

    /// Sets the rotation offset
    pub fn with_rotation(mut self, degrees: f64) -> Self {
        self.rotation_offset = degrees % 360.0;
        self
    }

    /// Validates the polygon
    pub fn validate(&self) -> Result<(), String> {
        if self.sides < 3 {
            return Err(format!(
                "Polygon must have at least 3 sides: {}",
                self.sides
            ));
        }
        if self.sides > 100 {
            return Err(format!("Too many polygon sides: {}", self.sides));
        }
        if self.radius <= 0.0 || self.radius > 0.5 {
            return Err(format!("Invalid polygon radius: {}", self.radius));
        }
        Ok(())
    }
}

// =============================================================================
// Path Shape
// =============================================================================

/// Point in a path
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathPoint {
    /// X coordinate (normalized)
    pub x: f64,
    /// Y coordinate (normalized)
    pub y: f64,
    /// Control point 1 X offset (for curves)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cp1_x: Option<f64>,
    /// Control point 1 Y offset
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cp1_y: Option<f64>,
    /// Control point 2 X offset (for curves)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cp2_x: Option<f64>,
    /// Control point 2 Y offset
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cp2_y: Option<f64>,
}

impl PathPoint {
    /// Creates a simple point (no control points)
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
            cp1_x: None,
            cp1_y: None,
            cp2_x: None,
            cp2_y: None,
        }
    }

    /// Creates a curve point with control handles
    pub fn curve(x: f64, y: f64, cp1_x: f64, cp1_y: f64, cp2_x: f64, cp2_y: f64) -> Self {
        Self {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
            cp1_x: Some(cp1_x),
            cp1_y: Some(cp1_y),
            cp2_x: Some(cp2_x),
            cp2_y: Some(cp2_y),
        }
    }
}

/// Custom bezier path shape
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PathShape {
    /// Path points
    pub points: Vec<PathPoint>,
    /// Whether the path is closed
    #[serde(default)]
    pub closed: bool,
}

impl Default for PathShape {
    fn default() -> Self {
        // Default: triangle path
        Self {
            points: vec![
                PathPoint::new(0.5, 0.2),
                PathPoint::new(0.3, 0.7),
                PathPoint::new(0.7, 0.7),
            ],
            closed: true,
        }
    }
}

impl PathShape {
    /// Creates a new path from points
    pub fn new(points: Vec<PathPoint>) -> Self {
        Self {
            points,
            closed: true,
        }
    }

    /// Sets whether the path is closed
    pub fn with_closed(mut self, closed: bool) -> Self {
        self.closed = closed;
        self
    }

    /// Validates the path
    pub fn validate(&self) -> Result<(), String> {
        if self.points.len() < 2 {
            return Err("Path must have at least 2 points".to_string());
        }
        if self.points.len() > 1000 {
            return Err("Path has too many points (max 1000)".to_string());
        }
        Ok(())
    }
}

// =============================================================================
// Shape Fill
// =============================================================================

/// Shape fill style
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShapeFill {
    /// No fill (transparent)
    None,
    /// Solid color fill
    Solid {
        /// Fill color in hex format
        color: String,
    },
    /// Linear gradient fill
    LinearGradient {
        /// Start color
        color_start: String,
        /// End color
        color_end: String,
        /// Gradient angle in degrees (0 = left to right)
        angle: f64,
    },
    /// Radial gradient fill
    RadialGradient {
        /// Center color
        color_center: String,
        /// Edge color
        color_edge: String,
    },
}

impl Default for ShapeFill {
    fn default() -> Self {
        Self::Solid {
            color: "#3366CC".to_string(),
        }
    }
}

impl ShapeFill {
    /// Creates a solid fill
    pub fn solid(color: impl Into<String>) -> Self {
        Self::Solid {
            color: color.into(),
        }
    }

    /// Creates no fill (transparent)
    pub fn none() -> Self {
        Self::None
    }

    /// Creates a linear gradient
    pub fn linear_gradient(
        color_start: impl Into<String>,
        color_end: impl Into<String>,
        angle: f64,
    ) -> Self {
        Self::LinearGradient {
            color_start: color_start.into(),
            color_end: color_end.into(),
            angle,
        }
    }

    /// Creates a radial gradient
    pub fn radial_gradient(color_center: impl Into<String>, color_edge: impl Into<String>) -> Self {
        Self::RadialGradient {
            color_center: color_center.into(),
            color_edge: color_edge.into(),
        }
    }

    /// Validates the fill
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::None => Ok(()),
            Self::Solid { color } => validate_hex_color(color),
            Self::LinearGradient {
                color_start,
                color_end,
                ..
            } => {
                validate_hex_color(color_start)?;
                validate_hex_color(color_end)
            }
            Self::RadialGradient {
                color_center,
                color_edge,
            } => {
                validate_hex_color(color_center)?;
                validate_hex_color(color_edge)
            }
        }
    }
}

// =============================================================================
// Shape Stroke
// =============================================================================

/// Shape stroke (outline) style
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShapeStroke {
    /// Stroke color in hex format
    pub color: String,
    /// Stroke width in pixels
    pub width: f64,
    /// Line cap style
    #[serde(default)]
    pub cap: StrokeCap,
    /// Line join style
    #[serde(default)]
    pub join: StrokeJoin,
    /// Dash pattern (empty = solid line)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dash_pattern: Vec<f64>,
}

impl Default for ShapeStroke {
    fn default() -> Self {
        Self {
            color: "#FFFFFF".to_string(),
            width: 2.0,
            cap: StrokeCap::Round,
            join: StrokeJoin::Round,
            dash_pattern: vec![],
        }
    }
}

impl ShapeStroke {
    /// Creates a new stroke
    pub fn new(color: impl Into<String>, width: f64) -> Self {
        Self {
            color: color.into(),
            width: width.clamp(0.1, 100.0),
            cap: StrokeCap::Round,
            join: StrokeJoin::Round,
            dash_pattern: vec![],
        }
    }

    /// Creates no stroke
    pub fn none() -> Self {
        Self {
            color: "#000000".to_string(),
            width: 0.0,
            ..Default::default()
        }
    }

    /// Sets the line cap
    pub fn with_cap(mut self, cap: StrokeCap) -> Self {
        self.cap = cap;
        self
    }

    /// Sets the line join
    pub fn with_join(mut self, join: StrokeJoin) -> Self {
        self.join = join;
        self
    }

    /// Sets a dash pattern
    pub fn with_dash(mut self, pattern: Vec<f64>) -> Self {
        self.dash_pattern = pattern;
        self
    }

    /// Validates the stroke
    pub fn validate(&self) -> Result<(), String> {
        if self.width < 0.0 {
            return Err(format!("Invalid stroke width: {}", self.width));
        }
        if self.width > 100.0 {
            return Err("Stroke width too large (max 100)".to_string());
        }
        validate_hex_color(&self.color)
    }

    /// Returns true if this is effectively no stroke
    pub fn is_none(&self) -> bool {
        self.width < 0.1
    }
}

/// Line cap style
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrokeCap {
    /// Flat cap (no extension)
    Butt,
    /// Rounded cap
    #[default]
    Round,
    /// Square cap (extends past endpoint)
    Square,
}

/// Line join style
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrokeJoin {
    /// Mitered join (sharp corners)
    Miter,
    /// Rounded join
    #[default]
    Round,
    /// Beveled join
    Bevel,
}

// =============================================================================
// Shape Position
// =============================================================================

/// Shape position using normalized coordinates
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShapePosition {
    /// X position (0.0 = left, 0.5 = center, 1.0 = right)
    pub x: f64,
    /// Y position (0.0 = top, 0.5 = center, 1.0 = bottom)
    pub y: f64,
}

impl Default for ShapePosition {
    fn default() -> Self {
        Self { x: 0.5, y: 0.5 }
    }
}

impl ShapePosition {
    /// Creates a position at the specified normalized coordinates
    pub fn new(x: f64, y: f64) -> Self {
        Self {
            x: x.clamp(0.0, 1.0),
            y: y.clamp(0.0, 1.0),
        }
    }

    /// Center position
    pub fn center() -> Self {
        Self { x: 0.5, y: 0.5 }
    }

    /// Converts to pixel coordinates
    pub fn to_pixels(&self, width: u32, height: u32) -> (i32, i32) {
        let x = (self.x * width as f64) as i32;
        let y = (self.y * height as f64) as i32;
        (x, y)
    }
}

// =============================================================================
// Shape Layer Data
// =============================================================================

/// Complete shape layer configuration
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShapeLayerData {
    /// The shape geometry
    pub shape: ShapeType,
    /// Fill style
    pub fill: ShapeFill,
    /// Stroke style
    pub stroke: ShapeStroke,
    /// Position on screen (center point)
    pub position: ShapePosition,
    /// Rotation in degrees
    #[serde(default)]
    pub rotation: f64,
    /// Opacity (0.0-1.0)
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    /// Layer name for UI
    #[serde(default)]
    pub name: String,
}

fn default_opacity() -> f64 {
    1.0
}

impl Default for ShapeLayerData {
    fn default() -> Self {
        Self {
            shape: ShapeType::default(),
            fill: ShapeFill::default(),
            stroke: ShapeStroke::default(),
            position: ShapePosition::default(),
            rotation: 0.0,
            opacity: 1.0,
            name: "Shape".to_string(),
        }
    }
}

impl ShapeLayerData {
    /// Creates a new shape layer with the given shape
    pub fn new(shape: ShapeType) -> Self {
        Self {
            shape,
            ..Default::default()
        }
    }

    /// Creates a rectangle shape layer
    pub fn rectangle() -> Self {
        Self::new(ShapeType::Rectangle(RectangleShape::default()))
    }

    /// Creates an ellipse shape layer
    pub fn ellipse() -> Self {
        Self::new(ShapeType::Ellipse(EllipseShape::default()))
    }

    /// Creates a circle shape layer
    pub fn circle(radius: f64) -> Self {
        Self::new(ShapeType::Ellipse(EllipseShape::circle(radius)))
    }

    /// Creates a polygon shape layer
    pub fn polygon(sides: u32, radius: f64) -> Self {
        Self::new(ShapeType::Polygon(PolygonShape::new(sides, radius)))
    }

    /// Creates a line shape layer
    pub fn line(start_x: f64, start_y: f64, end_x: f64, end_y: f64) -> Self {
        Self::new(ShapeType::Line(LineShape::new(
            start_x, start_y, end_x, end_y,
        )))
    }

    /// Sets the fill
    pub fn with_fill(mut self, fill: ShapeFill) -> Self {
        self.fill = fill;
        self
    }

    /// Sets a solid fill color
    pub fn with_fill_color(mut self, color: impl Into<String>) -> Self {
        self.fill = ShapeFill::solid(color);
        self
    }

    /// Sets the stroke
    pub fn with_stroke(mut self, stroke: ShapeStroke) -> Self {
        self.stroke = stroke;
        self
    }

    /// Sets the stroke color and width
    pub fn with_stroke_color(mut self, color: impl Into<String>, width: f64) -> Self {
        self.stroke = ShapeStroke::new(color, width);
        self
    }

    /// Sets the position
    pub fn with_position(mut self, x: f64, y: f64) -> Self {
        self.position = ShapePosition::new(x, y);
        self
    }

    /// Sets the rotation
    pub fn with_rotation(mut self, degrees: f64) -> Self {
        self.rotation = degrees % 360.0;
        self
    }

    /// Sets the opacity
    pub fn with_opacity(mut self, opacity: f64) -> Self {
        self.opacity = opacity.clamp(0.0, 1.0);
        self
    }

    /// Sets the layer name
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    /// Validates the shape layer
    pub fn validate(&self) -> Result<(), String> {
        self.shape.validate()?;
        self.fill.validate()?;
        self.stroke.validate()?;

        if !self.opacity.is_finite() || self.opacity < 0.0 || self.opacity > 1.0 {
            return Err(format!("Invalid opacity: {}", self.opacity));
        }

        if !self.rotation.is_finite() {
            return Err("Rotation must be a finite number".to_string());
        }

        Ok(())
    }
}

// =============================================================================
// Preset Shape Layers
// =============================================================================

impl ShapeLayerData {
    /// Creates a lower-third background bar
    pub fn lower_third_bar() -> Self {
        Self::new(ShapeType::Rectangle(RectangleShape::new(1.0, 0.12)))
            .with_position(0.5, 0.88)
            .with_fill(ShapeFill::solid("#000000CC"))
            .with_stroke(ShapeStroke::none())
            .with_name("Lower Third Bar")
    }

    /// Creates a callout box
    pub fn callout_box() -> Self {
        Self::new(ShapeType::Rectangle(
            RectangleShape::new(0.3, 0.15).with_corner_radius(0.02),
        ))
        .with_fill(ShapeFill::solid("#FFFFFF"))
        .with_stroke(ShapeStroke::new("#333333", 2.0))
        .with_name("Callout Box")
    }

    /// Creates a highlight circle
    pub fn highlight_circle() -> Self {
        Self::new(ShapeType::Ellipse(EllipseShape::circle(0.1)))
            .with_fill(ShapeFill::none())
            .with_stroke(ShapeStroke::new("#FF0000", 4.0))
            .with_name("Highlight Circle")
    }

    /// Creates an arrow pointer
    pub fn arrow() -> Self {
        Self::new(ShapeType::Polygon(
            PolygonShape::triangle(0.08).with_rotation(90.0),
        ))
        .with_fill(ShapeFill::solid("#FF6600"))
        .with_stroke(ShapeStroke::none())
        .with_name("Arrow")
    }

    /// Creates a divider line
    pub fn divider_line() -> Self {
        Self::line(0.1, 0.5, 0.9, 0.5)
            .with_fill(ShapeFill::none())
            .with_stroke(ShapeStroke::new("#CCCCCC", 2.0))
            .with_name("Divider")
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Validates hex color format
fn validate_hex_color(color: &str) -> Result<(), String> {
    let color = color.trim();
    if !color.starts_with('#') {
        return Err(format!("Color must start with #: {}", color));
    }

    let hex = &color[1..];
    let len = hex.len();

    if len != 3 && len != 4 && len != 6 && len != 8 {
        return Err(format!("Invalid color length: {}", color));
    }

    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid hex characters in color: {}", color));
    }

    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // Rectangle tests
    #[test]
    fn test_rectangle_default() {
        let rect = RectangleShape::default();
        assert!((rect.width - 0.3).abs() < 0.001);
        assert!((rect.height - 0.2).abs() < 0.001);
        assert!(rect.validate().is_ok());
    }

    #[test]
    fn test_rectangle_square() {
        let square = RectangleShape::square(0.2);
        assert_eq!(square.width, square.height);
    }

    #[test]
    fn test_rectangle_corner_radius() {
        let rect = RectangleShape::new(0.3, 0.2).with_corner_radius(0.1);
        assert!((rect.corner_radius - 0.1).abs() < 0.001);
    }

    // Ellipse tests
    #[test]
    fn test_ellipse_default() {
        let ellipse = EllipseShape::default();
        assert!(ellipse.validate().is_ok());
    }

    #[test]
    fn test_ellipse_circle() {
        let circle = EllipseShape::circle(0.1);
        assert_eq!(circle.radius_x, circle.radius_y);
    }

    // Line tests
    #[test]
    fn test_line_default() {
        let line = LineShape::default();
        assert!(line.validate().is_ok());
    }

    #[test]
    fn test_line_horizontal() {
        let line = LineShape::horizontal(0.5, 0.2, 0.8);
        assert_eq!(line.start_y, line.end_y);
    }

    #[test]
    fn test_line_vertical() {
        let line = LineShape::vertical(0.5, 0.2, 0.8);
        assert_eq!(line.start_x, line.end_x);
    }

    #[test]
    fn test_line_zero_length_invalid() {
        let line = LineShape::new(0.5, 0.5, 0.5, 0.5);
        assert!(line.validate().is_err());
    }

    // Polygon tests
    #[test]
    fn test_polygon_default() {
        let polygon = PolygonShape::default();
        assert_eq!(polygon.sides, 6); // Hexagon
        assert!(polygon.validate().is_ok());
    }

    #[test]
    fn test_polygon_triangle() {
        let triangle = PolygonShape::triangle(0.1);
        assert_eq!(triangle.sides, 3);
    }

    #[test]
    fn test_polygon_too_few_sides() {
        let polygon = PolygonShape::new(2, 0.1);
        assert_eq!(polygon.sides, 3); // Clamped
    }

    // Path tests
    #[test]
    fn test_path_default() {
        let path = PathShape::default();
        assert_eq!(path.points.len(), 3);
        assert!(path.closed);
        assert!(path.validate().is_ok());
    }

    #[test]
    fn test_path_too_few_points() {
        let path = PathShape::new(vec![PathPoint::new(0.5, 0.5)]);
        assert!(path.validate().is_err());
    }

    // Fill tests
    #[test]
    fn test_fill_solid() {
        let fill = ShapeFill::solid("#FF0000");
        assert!(fill.validate().is_ok());
    }

    #[test]
    fn test_fill_none() {
        let fill = ShapeFill::none();
        assert!(fill.validate().is_ok());
    }

    #[test]
    fn test_fill_gradient() {
        let fill = ShapeFill::linear_gradient("#FF0000", "#0000FF", 45.0);
        assert!(fill.validate().is_ok());
    }

    #[test]
    fn test_fill_invalid_color() {
        let fill = ShapeFill::solid("red");
        assert!(fill.validate().is_err());
    }

    // Stroke tests
    #[test]
    fn test_stroke_default() {
        let stroke = ShapeStroke::default();
        assert!(stroke.validate().is_ok());
    }

    #[test]
    fn test_stroke_none() {
        let stroke = ShapeStroke::none();
        assert!(stroke.is_none());
    }

    #[test]
    fn test_stroke_with_dash() {
        let stroke = ShapeStroke::new("#000000", 2.0).with_dash(vec![5.0, 3.0]);
        assert_eq!(stroke.dash_pattern.len(), 2);
    }

    // Shape layer tests
    #[test]
    fn test_shape_layer_default() {
        let layer = ShapeLayerData::default();
        assert!(layer.validate().is_ok());
    }

    #[test]
    fn test_shape_layer_rectangle() {
        let layer = ShapeLayerData::rectangle();
        assert!(matches!(layer.shape, ShapeType::Rectangle(_)));
    }

    #[test]
    fn test_shape_layer_ellipse() {
        let layer = ShapeLayerData::ellipse();
        assert!(matches!(layer.shape, ShapeType::Ellipse(_)));
    }

    #[test]
    fn test_shape_layer_circle() {
        let layer = ShapeLayerData::circle(0.1);
        if let ShapeType::Ellipse(e) = &layer.shape {
            assert_eq!(e.radius_x, e.radius_y);
        }
    }

    #[test]
    fn test_shape_layer_polygon() {
        let layer = ShapeLayerData::polygon(5, 0.1);
        if let ShapeType::Polygon(p) = &layer.shape {
            assert_eq!(p.sides, 5);
        }
    }

    #[test]
    fn test_shape_layer_builder() {
        let layer = ShapeLayerData::rectangle()
            .with_fill_color("#FF0000")
            .with_stroke_color("#FFFFFF", 3.0)
            .with_position(0.3, 0.7)
            .with_rotation(45.0)
            .with_opacity(0.8)
            .with_name("Test Shape");

        assert!((layer.position.x - 0.3).abs() < 0.001);
        assert!((layer.position.y - 0.7).abs() < 0.001);
        assert!((layer.rotation - 45.0).abs() < 0.001);
        assert!((layer.opacity - 0.8).abs() < 0.001);
        assert_eq!(layer.name, "Test Shape");
        assert!(layer.validate().is_ok());
    }

    // Preset tests
    #[test]
    fn test_preset_lower_third_bar() {
        let layer = ShapeLayerData::lower_third_bar();
        assert!(layer.validate().is_ok());
    }

    #[test]
    fn test_preset_callout_box() {
        let layer = ShapeLayerData::callout_box();
        assert!(layer.validate().is_ok());
    }

    #[test]
    fn test_preset_highlight_circle() {
        let layer = ShapeLayerData::highlight_circle();
        assert!(layer.validate().is_ok());
    }

    #[test]
    fn test_preset_arrow() {
        let layer = ShapeLayerData::arrow();
        assert!(layer.validate().is_ok());
    }

    #[test]
    fn test_preset_divider_line() {
        let layer = ShapeLayerData::divider_line();
        assert!(layer.validate().is_ok());
    }

    // Serialization tests
    #[test]
    fn test_shape_type_serialization() {
        let shape = ShapeType::Rectangle(RectangleShape::default());
        let json = serde_json::to_string(&shape).unwrap();
        assert!(json.contains("rectangle"));

        let parsed: ShapeType = serde_json::from_str(&json).unwrap();
        assert!(matches!(parsed, ShapeType::Rectangle(_)));
    }

    #[test]
    fn test_shape_layer_serialization() {
        let layer = ShapeLayerData::rectangle()
            .with_fill_color("#FF0000")
            .with_stroke_color("#FFFFFF", 2.0);

        let json = serde_json::to_string(&layer).unwrap();
        let parsed: ShapeLayerData = serde_json::from_str(&json).unwrap();

        assert!(parsed.validate().is_ok());
    }

    // Validation tests
    #[test]
    fn test_validate_hex_color_valid() {
        assert!(validate_hex_color("#FFF").is_ok());
        assert!(validate_hex_color("#FFFF").is_ok());
        assert!(validate_hex_color("#FFFFFF").is_ok());
        assert!(validate_hex_color("#FFFFFFFF").is_ok());
    }

    #[test]
    fn test_validate_hex_color_invalid() {
        assert!(validate_hex_color("FFF").is_err()); // Missing #
        assert!(validate_hex_color("#FF").is_err()); // Too short
        assert!(validate_hex_color("#GGGGG").is_err()); // Invalid chars
    }
}
