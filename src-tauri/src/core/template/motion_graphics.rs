//! Motion Graphics Template System
//!
//! Provides reusable templates for common motion graphics elements like
//! lower thirds, title cards, callouts, and transitions.
//!
//! # Overview
//!
//! Templates combine shapes and text into pre-designed compositions that
//! users can customize with their own content while maintaining professional
//! design standards.
//!
//! # Template Categories
//!
//! - **Lower Thirds**: Name/title overlays for speakers, locations
//! - **Title Cards**: Full-screen or partial titles for sections
//! - **Callouts**: Annotation boxes for highlighting content
//! - **End Screens**: Subscribe, social media, call-to-action overlays
//! - **Transitions**: Wipes, reveals with shapes
//!
//! # Example
//!
//! ```rust,ignore
//! use openreelio_lib::core::template::motion_graphics::*;
//!
//! // Create a lower third from template
//! let template = MotionGraphicsTemplate::lower_third_simple();
//! let instance = template.instantiate()
//!     .with_text("primary", "John Smith")
//!     .with_text("secondary", "CEO, Acme Corp")
//!     .with_color("accent", "#FF6600");
//! ```

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

use crate::core::shapes::{
    EllipseShape, RectangleShape, ShapeFill, ShapeLayerData, ShapeStroke, ShapeType,
};
use crate::core::text::{TextClipData, TextPosition, TextShadow, TextStyle};

// =============================================================================
// Template Categories
// =============================================================================

/// Template category for organization
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TemplateCategory {
    /// Lower third overlays (name, title, location)
    LowerThird,
    /// Title cards and section headers
    TitleCard,
    /// Callout and annotation boxes
    Callout,
    /// End screens and CTAs
    EndScreen,
    /// Shape-based transitions
    Transition,
    /// Custom user templates
    #[default]
    Custom,
}

// =============================================================================
// Template Parameter Types
// =============================================================================

/// Parameter type for template customization
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TemplateParamType {
    /// Text content parameter
    Text {
        default: String,
        max_length: Option<usize>,
        placeholder: String,
    },
    /// Color parameter (hex format)
    Color { default: String, label: String },
    /// Number parameter
    Number {
        default: f64,
        min: f64,
        max: f64,
        step: f64,
        label: String,
    },
    /// Boolean toggle
    Toggle { default: bool, label: String },
    /// Choice from options
    Choice {
        default: String,
        options: Vec<String>,
        label: String,
    },
}

impl TemplateParamType {
    /// Creates a text parameter
    pub fn text(default: impl Into<String>, placeholder: impl Into<String>) -> Self {
        Self::Text {
            default: default.into(),
            max_length: None,
            placeholder: placeholder.into(),
        }
    }

    /// Creates a color parameter
    pub fn color(default: impl Into<String>, label: impl Into<String>) -> Self {
        Self::Color {
            default: default.into(),
            label: label.into(),
        }
    }

    /// Creates a number parameter
    pub fn number(default: f64, min: f64, max: f64, label: impl Into<String>) -> Self {
        Self::Number {
            default,
            min,
            max,
            step: 1.0,
            label: label.into(),
        }
    }

    /// Creates a toggle parameter
    pub fn toggle(default: bool, label: impl Into<String>) -> Self {
        Self::Toggle {
            default,
            label: label.into(),
        }
    }
}

/// Parameter definition in a template
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateParam {
    /// Unique parameter ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Parameter type and constraints
    pub param_type: TemplateParamType,
    /// Group for UI organization
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

impl TemplateParam {
    /// Creates a new template parameter
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        param_type: TemplateParamType,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            param_type,
            group: None,
        }
    }

    /// Sets the parameter group
    pub fn with_group(mut self, group: impl Into<String>) -> Self {
        self.group = Some(group.into());
        self
    }
}

// =============================================================================
// Template Element
// =============================================================================

/// Element type in a template
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TemplateElement {
    /// Shape element
    Shape {
        id: String,
        data: ShapeLayerData,
        /// Parameter bindings: param_id -> property path
        bindings: HashMap<String, String>,
    },
    /// Text element
    Text {
        id: String,
        data: TextClipData,
        /// Parameter bindings: param_id -> property path
        bindings: HashMap<String, String>,
    },
}

impl TemplateElement {
    /// Creates a shape element
    pub fn shape(id: impl Into<String>, data: ShapeLayerData) -> Self {
        Self::Shape {
            id: id.into(),
            data,
            bindings: HashMap::new(),
        }
    }

    /// Creates a text element
    pub fn text(id: impl Into<String>, data: TextClipData) -> Self {
        Self::Text {
            id: id.into(),
            data,
            bindings: HashMap::new(),
        }
    }

    /// Adds a parameter binding
    pub fn with_binding(
        mut self,
        param_id: impl Into<String>,
        property: impl Into<String>,
    ) -> Self {
        match &mut self {
            Self::Shape { bindings, .. } | Self::Text { bindings, .. } => {
                bindings.insert(param_id.into(), property.into());
            }
        }
        self
    }

    /// Gets the element ID
    pub fn id(&self) -> &str {
        match self {
            Self::Shape { id, .. } | Self::Text { id, .. } => id,
        }
    }
}

// =============================================================================
// Motion Graphics Template
// =============================================================================

/// Complete motion graphics template definition
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MotionGraphicsTemplate {
    /// Unique template ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Description
    #[serde(default)]
    pub description: String,
    /// Template category
    pub category: TemplateCategory,
    /// Template version
    #[serde(default = "default_version")]
    pub version: String,
    /// Author/creator
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Customizable parameters
    #[serde(default)]
    pub parameters: Vec<TemplateParam>,
    /// Template elements (shapes, text)
    #[serde(default)]
    pub elements: Vec<TemplateElement>,
    /// Default duration in seconds
    #[serde(default = "default_duration")]
    pub default_duration: f64,
    /// Thumbnail/preview path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    /// Tags for search
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_version() -> String {
    "1.0.0".to_string()
}

fn default_duration() -> f64 {
    5.0
}

impl Default for MotionGraphicsTemplate {
    fn default() -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            name: "Untitled Template".to_string(),
            description: String::new(),
            category: TemplateCategory::Custom,
            version: default_version(),
            author: None,
            parameters: vec![],
            elements: vec![],
            default_duration: default_duration(),
            thumbnail: None,
            tags: vec![],
        }
    }
}

impl MotionGraphicsTemplate {
    /// Creates a new empty template
    pub fn new(name: impl Into<String>, category: TemplateCategory) -> Self {
        Self {
            name: name.into(),
            category,
            ..Default::default()
        }
    }

    /// Sets the description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = desc.into();
        self
    }

    /// Adds a parameter
    pub fn with_param(mut self, param: TemplateParam) -> Self {
        self.parameters.push(param);
        self
    }

    /// Adds an element
    pub fn with_element(mut self, element: TemplateElement) -> Self {
        self.elements.push(element);
        self
    }

    /// Sets the default duration
    pub fn with_duration(mut self, seconds: f64) -> Self {
        self.default_duration = seconds.max(0.1);
        self
    }

    /// Adds tags
    pub fn with_tags(mut self, tags: Vec<&str>) -> Self {
        self.tags = tags.into_iter().map(|s| s.to_string()).collect();
        self
    }

    /// Creates an instance of this template with default values
    pub fn instantiate(&self) -> TemplateInstance {
        let mut values = HashMap::new();

        for param in &self.parameters {
            let default_value = match &param.param_type {
                TemplateParamType::Text { default, .. } => TemplateValue::Text(default.clone()),
                TemplateParamType::Color { default, .. } => TemplateValue::Color(default.clone()),
                TemplateParamType::Number { default, .. } => TemplateValue::Number(*default),
                TemplateParamType::Toggle { default, .. } => TemplateValue::Boolean(*default),
                TemplateParamType::Choice { default, .. } => TemplateValue::Text(default.clone()),
            };
            values.insert(param.id.clone(), default_value);
        }

        TemplateInstance {
            template_id: self.id.clone(),
            values,
            duration: self.default_duration,
        }
    }

    /// Validates the template
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("Template name cannot be empty".to_string());
        }

        if self.elements.is_empty() {
            return Err("Template must have at least one element".to_string());
        }

        // Check for duplicate parameter IDs
        let mut param_ids = std::collections::HashSet::new();
        for param in &self.parameters {
            if !param_ids.insert(&param.id) {
                return Err(format!("Duplicate parameter ID: {}", param.id));
            }
        }

        // Check for duplicate element IDs
        let mut element_ids = std::collections::HashSet::new();
        for element in &self.elements {
            if !element_ids.insert(element.id()) {
                return Err(format!("Duplicate element ID: {}", element.id()));
            }
        }

        Ok(())
    }
}

// =============================================================================
// Template Instance
// =============================================================================

/// Value types for template parameters
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum TemplateValue {
    Text(String),
    Color(String),
    Number(f64),
    Boolean(bool),
}

/// An instance of a template with customized values
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInstance {
    /// Reference to the template
    pub template_id: String,
    /// Customized parameter values
    pub values: HashMap<String, TemplateValue>,
    /// Instance duration
    pub duration: f64,
}

impl TemplateInstance {
    /// Sets a text value
    pub fn with_text(mut self, param_id: impl Into<String>, value: impl Into<String>) -> Self {
        self.values
            .insert(param_id.into(), TemplateValue::Text(value.into()));
        self
    }

    /// Sets a color value
    pub fn with_color(mut self, param_id: impl Into<String>, value: impl Into<String>) -> Self {
        self.values
            .insert(param_id.into(), TemplateValue::Color(value.into()));
        self
    }

    /// Sets a number value
    pub fn with_number(mut self, param_id: impl Into<String>, value: f64) -> Self {
        self.values
            .insert(param_id.into(), TemplateValue::Number(value));
        self
    }

    /// Sets a boolean value
    pub fn with_boolean(mut self, param_id: impl Into<String>, value: bool) -> Self {
        self.values
            .insert(param_id.into(), TemplateValue::Boolean(value));
        self
    }

    /// Sets the duration
    pub fn with_duration(mut self, seconds: f64) -> Self {
        self.duration = seconds.max(0.1);
        self
    }

    /// Gets a text value
    pub fn get_text(&self, param_id: &str) -> Option<&str> {
        match self.values.get(param_id) {
            Some(TemplateValue::Text(s)) | Some(TemplateValue::Color(s)) => Some(s),
            _ => None,
        }
    }

    /// Gets a number value
    pub fn get_number(&self, param_id: &str) -> Option<f64> {
        match self.values.get(param_id) {
            Some(TemplateValue::Number(n)) => Some(*n),
            _ => None,
        }
    }

    /// Gets a boolean value
    pub fn get_boolean(&self, param_id: &str) -> Option<bool> {
        match self.values.get(param_id) {
            Some(TemplateValue::Boolean(b)) => Some(*b),
            _ => None,
        }
    }
}

// =============================================================================
// Built-in Templates
// =============================================================================

impl MotionGraphicsTemplate {
    /// Simple lower third with name and title
    pub fn lower_third_simple() -> Self {
        Self::new("Simple Lower Third", TemplateCategory::LowerThird)
            .with_description("Clean lower third with name and title on a semi-transparent bar")
            .with_tags(vec!["lower third", "name", "title", "simple", "clean"])
            .with_duration(5.0)
            .with_param(
                TemplateParam::new(
                    "primary_text",
                    "Name",
                    TemplateParamType::text("John Smith", "Enter name"),
                )
                .with_group("Content"),
            )
            .with_param(
                TemplateParam::new(
                    "secondary_text",
                    "Title",
                    TemplateParamType::text("CEO, Acme Corp", "Enter title"),
                )
                .with_group("Content"),
            )
            .with_param(
                TemplateParam::new(
                    "bg_color",
                    "Background Color",
                    TemplateParamType::color("#000000CC", "Background"),
                )
                .with_group("Style"),
            )
            .with_param(
                TemplateParam::new(
                    "text_color",
                    "Text Color",
                    TemplateParamType::color("#FFFFFF", "Text"),
                )
                .with_group("Style"),
            )
            .with_param(
                TemplateParam::new(
                    "accent_color",
                    "Accent Color",
                    TemplateParamType::color("#FF6600", "Accent"),
                )
                .with_group("Style"),
            )
            // Background bar
            .with_element(
                TemplateElement::shape(
                    "bg_bar",
                    ShapeLayerData::new(ShapeType::Rectangle(RectangleShape::new(0.4, 0.1)))
                        .with_position(0.25, 0.85)
                        .with_fill(ShapeFill::solid("#000000CC"))
                        .with_stroke(ShapeStroke::none()),
                )
                .with_binding("bg_color", "fill.color"),
            )
            // Accent line
            .with_element(
                TemplateElement::shape(
                    "accent_line",
                    ShapeLayerData::new(ShapeType::Rectangle(RectangleShape::new(0.005, 0.08)))
                        .with_position(0.06, 0.85)
                        .with_fill(ShapeFill::solid("#FF6600"))
                        .with_stroke(ShapeStroke::none()),
                )
                .with_binding("accent_color", "fill.color"),
            )
            // Primary text (name)
            .with_element(
                TemplateElement::text(
                    "primary",
                    TextClipData::new("John Smith")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(42)
                                .with_bold(true)
                                .with_color("#FFFFFF"),
                        )
                        .with_position(TextPosition::new(0.08, 0.82)),
                )
                .with_binding("primary_text", "content")
                .with_binding("text_color", "style.color"),
            )
            // Secondary text (title)
            .with_element(
                TemplateElement::text(
                    "secondary",
                    TextClipData::new("CEO, Acme Corp")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(28)
                                .with_color("#CCCCCC"),
                        )
                        .with_position(TextPosition::new(0.08, 0.88)),
                )
                .with_binding("secondary_text", "content"),
            )
    }

    /// Modern lower third with animated accent
    pub fn lower_third_modern() -> Self {
        Self::new("Modern Lower Third", TemplateCategory::LowerThird)
            .with_description("Modern design with gradient accent bar")
            .with_tags(vec!["lower third", "modern", "gradient", "professional"])
            .with_duration(5.0)
            .with_param(TemplateParam::new(
                "name",
                "Name",
                TemplateParamType::text("Jane Doe", "Enter name"),
            ))
            .with_param(TemplateParam::new(
                "role",
                "Role/Title",
                TemplateParamType::text("Product Designer", "Enter role"),
            ))
            .with_param(TemplateParam::new(
                "primary_color",
                "Primary Color",
                TemplateParamType::color("#3366FF", "Primary"),
            ))
            .with_param(TemplateParam::new(
                "secondary_color",
                "Secondary Color",
                TemplateParamType::color("#00CCFF", "Secondary"),
            ))
            // Gradient bar
            .with_element(
                TemplateElement::shape(
                    "gradient_bar",
                    ShapeLayerData::new(ShapeType::Rectangle(RectangleShape::new(0.35, 0.004)))
                        .with_position(0.2, 0.84)
                        .with_fill(ShapeFill::linear_gradient("#3366FF", "#00CCFF", 0.0))
                        .with_stroke(ShapeStroke::none()),
                )
                .with_binding("primary_color", "fill.colorStart")
                .with_binding("secondary_color", "fill.colorEnd"),
            )
            // Name text
            .with_element(
                TemplateElement::text(
                    "name_text",
                    TextClipData::new("Jane Doe")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(48)
                                .with_bold(true)
                                .with_color("#FFFFFF"),
                        )
                        .with_position(TextPosition::new(0.04, 0.80))
                        .with_shadow(TextShadow::soft()),
                )
                .with_binding("name", "content"),
            )
            // Role text
            .with_element(
                TemplateElement::text(
                    "role_text",
                    TextClipData::new("Product Designer")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(32)
                                .with_color("#AAAAAA"),
                        )
                        .with_position(TextPosition::new(0.04, 0.88)),
                )
                .with_binding("role", "content"),
            )
    }

    /// Centered title card
    pub fn title_card_centered() -> Self {
        Self::new("Centered Title", TemplateCategory::TitleCard)
            .with_description("Full-screen centered title with optional subtitle")
            .with_tags(vec!["title", "centered", "intro", "chapter"])
            .with_duration(4.0)
            .with_param(TemplateParam::new(
                "title",
                "Title",
                TemplateParamType::text("Chapter One", "Enter title"),
            ))
            .with_param(TemplateParam::new(
                "subtitle",
                "Subtitle",
                TemplateParamType::text("The Beginning", "Enter subtitle (optional)"),
            ))
            .with_param(TemplateParam::new(
                "bg_opacity",
                "Background Opacity",
                TemplateParamType::number(0.7, 0.0, 1.0, "Opacity"),
            ))
            // Background overlay
            .with_element(
                TemplateElement::shape(
                    "bg_overlay",
                    ShapeLayerData::new(ShapeType::Rectangle(RectangleShape::new(1.0, 1.0)))
                        .with_position(0.5, 0.5)
                        .with_fill(ShapeFill::solid("#000000"))
                        .with_opacity(0.7)
                        .with_stroke(ShapeStroke::none()),
                )
                .with_binding("bg_opacity", "opacity"),
            )
            // Main title
            .with_element(
                TemplateElement::text(
                    "main_title",
                    TextClipData::new("Chapter One")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(96)
                                .with_bold(true)
                                .with_color("#FFFFFF"),
                        )
                        .with_position(TextPosition::center()),
                )
                .with_binding("title", "content"),
            )
            // Subtitle
            .with_element(
                TemplateElement::text(
                    "sub_title",
                    TextClipData::new("The Beginning")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(36)
                                .with_color("#AAAAAA"),
                        )
                        .with_position(TextPosition::new(0.5, 0.58)),
                )
                .with_binding("subtitle", "content"),
            )
    }

    /// Callout box for annotations
    pub fn callout_box() -> Self {
        Self::new("Callout Box", TemplateCategory::Callout)
            .with_description("Annotation box for highlighting information")
            .with_tags(vec!["callout", "annotation", "box", "highlight"])
            .with_duration(4.0)
            .with_param(TemplateParam::new(
                "text",
                "Callout Text",
                TemplateParamType::text("Important information here", "Enter text"),
            ))
            .with_param(TemplateParam::new(
                "position_x",
                "X Position",
                TemplateParamType::number(0.7, 0.0, 1.0, "X Position"),
            ))
            .with_param(TemplateParam::new(
                "position_y",
                "Y Position",
                TemplateParamType::number(0.3, 0.0, 1.0, "Y Position"),
            ))
            .with_param(TemplateParam::new(
                "bg_color",
                "Background",
                TemplateParamType::color("#FFFFFF", "Background"),
            ))
            .with_param(TemplateParam::new(
                "border_color",
                "Border",
                TemplateParamType::color("#333333", "Border"),
            ))
            // Callout background
            .with_element(
                TemplateElement::shape(
                    "callout_bg",
                    ShapeLayerData::new(ShapeType::Rectangle(
                        RectangleShape::new(0.25, 0.1).with_corner_radius(0.01),
                    ))
                    .with_position(0.7, 0.3)
                    .with_fill(ShapeFill::solid("#FFFFFF"))
                    .with_stroke(ShapeStroke::new("#333333", 2.0)),
                )
                .with_binding("position_x", "position.x")
                .with_binding("position_y", "position.y")
                .with_binding("bg_color", "fill.color")
                .with_binding("border_color", "stroke.color"),
            )
            // Callout text
            .with_element(
                TemplateElement::text(
                    "callout_text",
                    TextClipData::new("Important information here")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(24)
                                .with_color("#333333"),
                        )
                        .with_position(TextPosition::new(0.7, 0.3)),
                )
                .with_binding("text", "content")
                .with_binding("position_x", "position.x")
                .with_binding("position_y", "position.y"),
            )
    }

    /// End screen with subscribe CTA
    pub fn end_screen_subscribe() -> Self {
        Self::new("Subscribe End Screen", TemplateCategory::EndScreen)
            .with_description("End screen with subscribe button and social links")
            .with_tags(vec!["end screen", "subscribe", "youtube", "cta"])
            .with_duration(10.0)
            .with_param(TemplateParam::new(
                "channel_name",
                "Channel Name",
                TemplateParamType::text("My Channel", "Enter channel name"),
            ))
            .with_param(TemplateParam::new(
                "cta_text",
                "Call to Action",
                TemplateParamType::text("Subscribe for more!", "Enter CTA text"),
            ))
            .with_param(TemplateParam::new(
                "button_color",
                "Button Color",
                TemplateParamType::color("#FF0000", "Button"),
            ))
            // Background
            .with_element(TemplateElement::shape(
                "bg",
                ShapeLayerData::new(ShapeType::Rectangle(RectangleShape::new(1.0, 1.0)))
                    .with_position(0.5, 0.5)
                    .with_fill(ShapeFill::solid("#1A1A1A"))
                    .with_stroke(ShapeStroke::none()),
            ))
            // Subscribe button
            .with_element(
                TemplateElement::shape(
                    "subscribe_btn",
                    ShapeLayerData::new(ShapeType::Rectangle(
                        RectangleShape::new(0.2, 0.08).with_corner_radius(0.01),
                    ))
                    .with_position(0.5, 0.6)
                    .with_fill(ShapeFill::solid("#FF0000"))
                    .with_stroke(ShapeStroke::none()),
                )
                .with_binding("button_color", "fill.color"),
            )
            // Channel name
            .with_element(
                TemplateElement::text(
                    "channel",
                    TextClipData::new("My Channel")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(64)
                                .with_bold(true)
                                .with_color("#FFFFFF"),
                        )
                        .with_position(TextPosition::new(0.5, 0.35)),
                )
                .with_binding("channel_name", "content"),
            )
            // Subscribe text
            .with_element(TemplateElement::text(
                "subscribe_text",
                TextClipData::new("SUBSCRIBE")
                    .with_style(
                        TextStyle::default()
                            .with_font_size(28)
                            .with_bold(true)
                            .with_color("#FFFFFF"),
                    )
                    .with_position(TextPosition::new(0.5, 0.6)),
            ))
            // CTA text
            .with_element(
                TemplateElement::text(
                    "cta",
                    TextClipData::new("Subscribe for more!")
                        .with_style(
                            TextStyle::default()
                                .with_font_size(32)
                                .with_color("#CCCCCC"),
                        )
                        .with_position(TextPosition::new(0.5, 0.75)),
                )
                .with_binding("cta_text", "content"),
            )
    }

    /// Highlight circle for annotations
    pub fn highlight_circle() -> Self {
        Self::new("Highlight Circle", TemplateCategory::Callout)
            .with_description("Animated circle to highlight areas of the screen")
            .with_tags(vec!["highlight", "circle", "annotation", "focus"])
            .with_duration(3.0)
            .with_param(TemplateParam::new(
                "position_x",
                "X Position",
                TemplateParamType::number(0.5, 0.0, 1.0, "X"),
            ))
            .with_param(TemplateParam::new(
                "position_y",
                "Y Position",
                TemplateParamType::number(0.5, 0.0, 1.0, "Y"),
            ))
            .with_param(TemplateParam::new(
                "size",
                "Size",
                TemplateParamType::number(0.1, 0.02, 0.3, "Radius"),
            ))
            .with_param(TemplateParam::new(
                "color",
                "Color",
                TemplateParamType::color("#FF0000", "Circle Color"),
            ))
            .with_param(TemplateParam::new(
                "stroke_width",
                "Stroke Width",
                TemplateParamType::number(4.0, 1.0, 20.0, "Width"),
            ))
            // Highlight circle
            .with_element(
                TemplateElement::shape(
                    "circle",
                    ShapeLayerData::new(ShapeType::Ellipse(EllipseShape::circle(0.1)))
                        .with_position(0.5, 0.5)
                        .with_fill(ShapeFill::none())
                        .with_stroke(ShapeStroke::new("#FF0000", 4.0)),
                )
                .with_binding("position_x", "position.x")
                .with_binding("position_y", "position.y")
                .with_binding("size", "shape.radiusX")
                .with_binding("size", "shape.radiusY")
                .with_binding("color", "stroke.color")
                .with_binding("stroke_width", "stroke.width"),
            )
    }
}

// =============================================================================
// Template Library
// =============================================================================

/// Collection of templates organized by category
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TemplateLibrary {
    /// All templates in the library
    pub templates: Vec<MotionGraphicsTemplate>,
}

impl TemplateLibrary {
    /// Creates a new empty library
    pub fn new() -> Self {
        Self { templates: vec![] }
    }

    /// Creates a library with built-in templates
    pub fn with_builtins() -> Self {
        Self {
            templates: vec![
                MotionGraphicsTemplate::lower_third_simple(),
                MotionGraphicsTemplate::lower_third_modern(),
                MotionGraphicsTemplate::title_card_centered(),
                MotionGraphicsTemplate::callout_box(),
                MotionGraphicsTemplate::end_screen_subscribe(),
                MotionGraphicsTemplate::highlight_circle(),
            ],
        }
    }

    /// Adds a template to the library
    pub fn add(&mut self, template: MotionGraphicsTemplate) {
        self.templates.push(template);
    }

    /// Gets a template by ID
    pub fn get(&self, id: &str) -> Option<&MotionGraphicsTemplate> {
        self.templates.iter().find(|t| t.id == id)
    }

    /// Gets templates by category
    pub fn by_category(&self, category: TemplateCategory) -> Vec<&MotionGraphicsTemplate> {
        self.templates
            .iter()
            .filter(|t| t.category == category)
            .collect()
    }

    /// Searches templates by tag
    pub fn search(&self, query: &str) -> Vec<&MotionGraphicsTemplate> {
        let query_lower = query.to_lowercase();
        self.templates
            .iter()
            .filter(|t| {
                t.name.to_lowercase().contains(&query_lower)
                    || t.description.to_lowercase().contains(&query_lower)
                    || t.tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&query_lower))
            })
            .collect()
    }

    /// Gets the number of templates
    pub fn len(&self) -> usize {
        self.templates.len()
    }

    /// Returns true if the library is empty
    pub fn is_empty(&self) -> bool {
        self.templates.is_empty()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_template_param_text() {
        let param = TemplateParam::new(
            "name",
            "Name",
            TemplateParamType::text("John", "Enter name"),
        );
        assert_eq!(param.id, "name");
        assert_eq!(param.name, "Name");
    }

    #[test]
    fn test_template_param_color() {
        let param = TemplateParam::new(
            "color",
            "Color",
            TemplateParamType::color("#FF0000", "Pick color"),
        );
        assert_eq!(param.id, "color");
    }

    #[test]
    fn test_template_param_with_group() {
        let param = TemplateParam::new("test", "Test", TemplateParamType::toggle(true, "Enable"))
            .with_group("Settings");
        assert_eq!(param.group, Some("Settings".to_string()));
    }

    #[test]
    fn test_template_element_shape() {
        let element = TemplateElement::shape("rect", ShapeLayerData::rectangle())
            .with_binding("color", "fill.color");

        assert_eq!(element.id(), "rect");
        if let TemplateElement::Shape { bindings, .. } = &element {
            assert!(bindings.contains_key("color"));
        }
    }

    #[test]
    fn test_template_element_text() {
        let element = TemplateElement::text("title", TextClipData::new("Hello"))
            .with_binding("content", "content");

        assert_eq!(element.id(), "title");
    }

    #[test]
    fn test_template_default() {
        let template = MotionGraphicsTemplate::default();
        assert_eq!(template.name, "Untitled Template");
        assert_eq!(template.category, TemplateCategory::Custom);
    }

    #[test]
    fn test_template_builder() {
        let template = MotionGraphicsTemplate::new("Test", TemplateCategory::LowerThird)
            .with_description("Test description")
            .with_duration(3.0)
            .with_tags(vec!["test", "demo"]);

        assert_eq!(template.name, "Test");
        assert_eq!(template.category, TemplateCategory::LowerThird);
        assert_eq!(template.description, "Test description");
        assert_eq!(template.default_duration, 3.0);
        assert_eq!(template.tags.len(), 2);
    }

    #[test]
    fn test_template_validate_success() {
        let template = MotionGraphicsTemplate::new("Test", TemplateCategory::Custom)
            .with_element(TemplateElement::shape("s1", ShapeLayerData::rectangle()));

        assert!(template.validate().is_ok());
    }

    #[test]
    fn test_template_validate_no_elements() {
        let template = MotionGraphicsTemplate::new("Test", TemplateCategory::Custom);
        assert!(template.validate().is_err());
    }

    #[test]
    fn test_template_validate_duplicate_param_ids() {
        let template = MotionGraphicsTemplate::new("Test", TemplateCategory::Custom)
            .with_param(TemplateParam::new(
                "p1",
                "P1",
                TemplateParamType::text("", ""),
            ))
            .with_param(TemplateParam::new(
                "p1",
                "P1 Dup",
                TemplateParamType::text("", ""),
            ))
            .with_element(TemplateElement::shape("s1", ShapeLayerData::rectangle()));

        let result = template.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Duplicate parameter"));
    }

    #[test]
    fn test_template_instantiate() {
        let template = MotionGraphicsTemplate::new("Test", TemplateCategory::Custom)
            .with_param(TemplateParam::new(
                "name",
                "Name",
                TemplateParamType::text("Default", ""),
            ))
            .with_element(TemplateElement::shape("s1", ShapeLayerData::rectangle()));

        let instance = template.instantiate();
        assert_eq!(instance.template_id, template.id);
        assert!(instance.values.contains_key("name"));
    }

    #[test]
    fn test_template_instance_with_values() {
        let template = MotionGraphicsTemplate::lower_third_simple();
        let instance = template
            .instantiate()
            .with_text("primary_text", "Alice")
            .with_color("accent_color", "#00FF00")
            .with_duration(7.0);

        assert_eq!(instance.get_text("primary_text"), Some("Alice"));
        assert_eq!(instance.get_text("accent_color"), Some("#00FF00"));
        assert_eq!(instance.duration, 7.0);
    }

    #[test]
    fn test_builtin_lower_third_simple() {
        let template = MotionGraphicsTemplate::lower_third_simple();
        assert!(template.validate().is_ok());
        assert_eq!(template.category, TemplateCategory::LowerThird);
        assert!(!template.parameters.is_empty());
        assert!(!template.elements.is_empty());
    }

    #[test]
    fn test_builtin_lower_third_modern() {
        let template = MotionGraphicsTemplate::lower_third_modern();
        assert!(template.validate().is_ok());
    }

    #[test]
    fn test_builtin_title_card() {
        let template = MotionGraphicsTemplate::title_card_centered();
        assert!(template.validate().is_ok());
        assert_eq!(template.category, TemplateCategory::TitleCard);
    }

    #[test]
    fn test_builtin_callout_box() {
        let template = MotionGraphicsTemplate::callout_box();
        assert!(template.validate().is_ok());
        assert_eq!(template.category, TemplateCategory::Callout);
    }

    #[test]
    fn test_builtin_end_screen() {
        let template = MotionGraphicsTemplate::end_screen_subscribe();
        assert!(template.validate().is_ok());
        assert_eq!(template.category, TemplateCategory::EndScreen);
    }

    #[test]
    fn test_builtin_highlight_circle() {
        let template = MotionGraphicsTemplate::highlight_circle();
        assert!(template.validate().is_ok());
    }

    #[test]
    fn test_template_library_empty() {
        let library = TemplateLibrary::new();
        assert!(library.is_empty());
        assert_eq!(library.len(), 0);
    }

    #[test]
    fn test_template_library_with_builtins() {
        let library = TemplateLibrary::with_builtins();
        assert!(!library.is_empty());
        assert!(library.len() >= 6);
    }

    #[test]
    fn test_template_library_add() {
        let mut library = TemplateLibrary::new();
        library.add(MotionGraphicsTemplate::lower_third_simple());
        assert_eq!(library.len(), 1);
    }

    #[test]
    fn test_template_library_get() {
        let library = TemplateLibrary::with_builtins();
        let template = library.templates.first().unwrap();
        let found = library.get(&template.id);
        assert!(found.is_some());
        assert_eq!(found.unwrap().id, template.id);
    }

    #[test]
    fn test_template_library_by_category() {
        let library = TemplateLibrary::with_builtins();
        let lower_thirds = library.by_category(TemplateCategory::LowerThird);
        assert!(lower_thirds.len() >= 2);
    }

    #[test]
    fn test_template_library_search() {
        let library = TemplateLibrary::with_builtins();

        let results = library.search("lower third");
        assert!(!results.is_empty());

        let results = library.search("subscribe");
        assert!(!results.is_empty());
    }

    #[test]
    fn test_template_serialization() {
        let template = MotionGraphicsTemplate::lower_third_simple();
        let json = serde_json::to_string(&template).unwrap();
        let parsed: MotionGraphicsTemplate = serde_json::from_str(&json).unwrap();

        assert_eq!(template.name, parsed.name);
        assert_eq!(template.parameters.len(), parsed.parameters.len());
        assert_eq!(template.elements.len(), parsed.elements.len());
    }

    #[test]
    fn test_template_instance_serialization() {
        let template = MotionGraphicsTemplate::lower_third_simple();
        let instance = template.instantiate().with_text("primary_text", "Test");

        let json = serde_json::to_string(&instance).unwrap();
        let parsed: TemplateInstance = serde_json::from_str(&json).unwrap();

        assert_eq!(instance.template_id, parsed.template_id);
        assert_eq!(
            instance.get_text("primary_text"),
            parsed.get_text("primary_text")
        );
    }
}
