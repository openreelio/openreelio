//! Template Models
//!
//! Core data structures for video templates.

use serde::{Deserialize, Serialize};

use super::sections::{TemplateSection, TemplateStyle};
use crate::core::timeline::SequenceFormat;

/// Template category for organization
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateCategory {
    /// Short-form vertical video (TikTok, Reels, Shorts)
    Shorts,
    /// Long-form video (YouTube, Vimeo)
    LongForm,
    /// Social media content
    Social,
    /// Promotional/advertising
    Promo,
    /// Educational/tutorial
    Educational,
    /// News/journalism
    News,
    /// Entertainment/comedy
    Entertainment,
    /// Documentary style
    Documentary,
    /// Vlog style
    Vlog,
    /// Custom category
    Custom(String),
}

impl Default for TemplateCategory {
    fn default() -> Self {
        TemplateCategory::Shorts
    }
}

impl std::fmt::Display for TemplateCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateCategory::Shorts => write!(f, "Shorts"),
            TemplateCategory::LongForm => write!(f, "Long Form"),
            TemplateCategory::Social => write!(f, "Social"),
            TemplateCategory::Promo => write!(f, "Promo"),
            TemplateCategory::Educational => write!(f, "Educational"),
            TemplateCategory::News => write!(f, "News"),
            TemplateCategory::Entertainment => write!(f, "Entertainment"),
            TemplateCategory::Documentary => write!(f, "Documentary"),
            TemplateCategory::Vlog => write!(f, "Vlog"),
            TemplateCategory::Custom(name) => write!(f, "{}", name),
        }
    }
}

/// Template format specification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateFormat {
    /// Canvas width
    pub width: u32,
    /// Canvas height
    pub height: u32,
    /// Frame rate (numerator)
    pub fps_num: i32,
    /// Frame rate (denominator)
    pub fps_den: i32,
    /// Audio sample rate
    pub audio_sample_rate: u32,
}

impl TemplateFormat {
    /// Creates a vertical Shorts format (1080x1920, 30fps)
    pub fn shorts_1080() -> Self {
        Self {
            width: 1080,
            height: 1920,
            fps_num: 30,
            fps_den: 1,
            audio_sample_rate: 48000,
        }
    }

    /// Creates a horizontal YouTube format (1920x1080, 30fps)
    pub fn youtube_1080() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            audio_sample_rate: 48000,
        }
    }

    /// Creates a 4K format (3840x2160, 30fps)
    pub fn youtube_4k() -> Self {
        Self {
            width: 3840,
            height: 2160,
            fps_num: 30,
            fps_den: 1,
            audio_sample_rate: 48000,
        }
    }

    /// Creates a square format (1080x1080, 30fps)
    pub fn square_1080() -> Self {
        Self {
            width: 1080,
            height: 1080,
            fps_num: 30,
            fps_den: 1,
            audio_sample_rate: 48000,
        }
    }

    /// Converts to sequence format
    pub fn to_sequence_format(&self) -> SequenceFormat {
        SequenceFormat::new(
            self.width,
            self.height,
            self.fps_num,
            self.fps_den,
            self.audio_sample_rate,
        )
    }

    /// Returns the aspect ratio as a string
    pub fn aspect_ratio(&self) -> String {
        let gcd = gcd(self.width, self.height);
        format!("{}:{}", self.width / gcd, self.height / gcd)
    }

    /// Returns whether this is a vertical format
    pub fn is_vertical(&self) -> bool {
        self.height > self.width
    }

    /// Returns whether this is a horizontal format
    pub fn is_horizontal(&self) -> bool {
        self.width > self.height
    }

    /// Returns whether this is a square format
    pub fn is_square(&self) -> bool {
        self.width == self.height
    }
}

impl Default for TemplateFormat {
    fn default() -> Self {
        Self::shorts_1080()
    }
}

/// Greatest common divisor for aspect ratio calculation
fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Template metadata for display and search
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TemplateMetadata {
    /// Author name
    pub author: Option<String>,
    /// Creation date
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Last updated date
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Version string
    pub version: String,
    /// Tags for search
    pub tags: Vec<String>,
    /// Thumbnail URI
    pub thumbnail_uri: Option<String>,
    /// Preview video URI
    pub preview_uri: Option<String>,
    /// Usage count (for popularity)
    pub usage_count: u64,
    /// Rating (0.0 - 5.0)
    pub rating: Option<f32>,
}

impl TemplateMetadata {
    /// Creates new metadata with current timestamp
    pub fn new() -> Self {
        Self {
            version: "1.0.0".to_string(),
            created_at: Some(chrono::Utc::now()),
            updated_at: Some(chrono::Utc::now()),
            ..Default::default()
        }
    }

    /// Adds a tag
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Sets the author
    pub fn with_author(mut self, author: impl Into<String>) -> Self {
        self.author = Some(author.into());
        self
    }

    /// Increments usage count
    pub fn increment_usage(&mut self) {
        self.usage_count += 1;
        self.updated_at = Some(chrono::Utc::now());
    }
}

/// Main template structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    /// Unique template ID
    pub id: String,
    /// Display name
    pub name: String,
    /// Description
    pub description: String,
    /// Category
    pub category: TemplateCategory,
    /// Output format
    pub format: TemplateFormat,
    /// Template sections (structure)
    pub sections: Vec<TemplateSection>,
    /// Visual style settings
    pub style: TemplateStyle,
    /// Metadata
    pub metadata: TemplateMetadata,
    /// Target duration range (min, max) in seconds
    pub duration_range: (f64, f64),
    /// Whether this template is built-in
    pub builtin: bool,
}

impl Template {
    /// Creates a new template
    pub fn new(name: impl Into<String>, category: TemplateCategory) -> Self {
        let name = name.into();
        Self {
            id: ulid::Ulid::new().to_string(),
            name: name.clone(),
            description: String::new(),
            category,
            format: TemplateFormat::default(),
            sections: Vec::new(),
            style: TemplateStyle::default(),
            metadata: TemplateMetadata::new(),
            duration_range: (15.0, 60.0), // Default Shorts range
            builtin: false,
        }
    }

    /// Sets the description
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = desc.into();
        self
    }

    /// Sets the format
    pub fn with_format(mut self, format: TemplateFormat) -> Self {
        self.format = format;
        self
    }

    /// Adds a section
    pub fn with_section(mut self, section: TemplateSection) -> Self {
        self.sections.push(section);
        self
    }

    /// Sets the style
    pub fn with_style(mut self, style: TemplateStyle) -> Self {
        self.style = style;
        self
    }

    /// Sets the duration range
    pub fn with_duration_range(mut self, min_sec: f64, max_sec: f64) -> Self {
        self.duration_range = (min_sec, max_sec);
        self
    }

    /// Marks as built-in
    pub fn as_builtin(mut self) -> Self {
        self.builtin = true;
        self
    }

    /// Returns total minimum duration based on sections
    pub fn min_duration(&self) -> f64 {
        self.sections.iter().map(|s| s.duration_range.0).sum()
    }

    /// Returns total maximum duration based on sections
    pub fn max_duration(&self) -> f64 {
        self.sections.iter().map(|s| s.duration_range.1).sum()
    }

    /// Returns count of required sections
    pub fn required_section_count(&self) -> usize {
        self.sections.iter().filter(|s| s.required).count()
    }

    /// Returns count of optional sections
    pub fn optional_section_count(&self) -> usize {
        self.sections.iter().filter(|s| !s.required).count()
    }

    /// Validates the template structure
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() {
            return Err("Template name cannot be empty".to_string());
        }

        if self.sections.is_empty() {
            return Err("Template must have at least one section".to_string());
        }

        // Check duration consistency
        let section_min = self.min_duration();
        let section_max = self.max_duration();

        if section_min > self.duration_range.1 {
            return Err(format!(
                "Section minimum duration ({:.1}s) exceeds template maximum ({:.1}s)",
                section_min, self.duration_range.1
            ));
        }

        if section_max < self.duration_range.0 {
            return Err(format!(
                "Section maximum duration ({:.1}s) is less than template minimum ({:.1}s)",
                section_max, self.duration_range.0
            ));
        }

        // Validate each section
        for (i, section) in self.sections.iter().enumerate() {
            if let Err(e) = section.validate() {
                return Err(format!("Section {} error: {}", i + 1, e));
            }
        }

        Ok(())
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::template::sections::ContentType;

    // ========================================================================
    // TemplateCategory Tests
    // ========================================================================

    #[test]
    fn test_category_default() {
        let category = TemplateCategory::default();
        assert_eq!(category, TemplateCategory::Shorts);
    }

    #[test]
    fn test_category_display() {
        assert_eq!(TemplateCategory::Shorts.to_string(), "Shorts");
        assert_eq!(TemplateCategory::Educational.to_string(), "Educational");
        assert_eq!(
            TemplateCategory::Custom("MyCategory".to_string()).to_string(),
            "MyCategory"
        );
    }

    #[test]
    fn test_category_serialization() {
        assert_eq!(
            serde_json::to_string(&TemplateCategory::Shorts).unwrap(),
            "\"shorts\""
        );
        assert_eq!(
            serde_json::from_str::<TemplateCategory>("\"educational\"").unwrap(),
            TemplateCategory::Educational
        );
    }

    // ========================================================================
    // TemplateFormat Tests
    // ========================================================================

    #[test]
    fn test_format_shorts() {
        let format = TemplateFormat::shorts_1080();
        assert_eq!(format.width, 1080);
        assert_eq!(format.height, 1920);
        assert!(format.is_vertical());
        assert!(!format.is_horizontal());
    }

    #[test]
    fn test_format_youtube() {
        let format = TemplateFormat::youtube_1080();
        assert_eq!(format.width, 1920);
        assert_eq!(format.height, 1080);
        assert!(format.is_horizontal());
        assert!(!format.is_vertical());
    }

    #[test]
    fn test_format_square() {
        let format = TemplateFormat::square_1080();
        assert!(format.is_square());
        assert!(!format.is_vertical());
        assert!(!format.is_horizontal());
    }

    #[test]
    fn test_format_aspect_ratio() {
        let shorts = TemplateFormat::shorts_1080();
        assert_eq!(shorts.aspect_ratio(), "9:16");

        let youtube = TemplateFormat::youtube_1080();
        assert_eq!(youtube.aspect_ratio(), "16:9");

        let square = TemplateFormat::square_1080();
        assert_eq!(square.aspect_ratio(), "1:1");
    }

    #[test]
    fn test_format_to_sequence_format() {
        let format = TemplateFormat::shorts_1080();
        let seq_format = format.to_sequence_format();

        assert_eq!(seq_format.canvas.width, 1080);
        assert_eq!(seq_format.canvas.height, 1920);
    }

    // ========================================================================
    // TemplateMetadata Tests
    // ========================================================================

    #[test]
    fn test_metadata_new() {
        let meta = TemplateMetadata::new();
        assert_eq!(meta.version, "1.0.0");
        assert!(meta.created_at.is_some());
        assert_eq!(meta.usage_count, 0);
    }

    #[test]
    fn test_metadata_with_tag() {
        let meta = TemplateMetadata::new()
            .with_tag("shorts")
            .with_tag("trending");

        assert_eq!(meta.tags.len(), 2);
        assert!(meta.tags.contains(&"shorts".to_string()));
    }

    #[test]
    fn test_metadata_with_author() {
        let meta = TemplateMetadata::new().with_author("OpenReelio Team");
        assert_eq!(meta.author, Some("OpenReelio Team".to_string()));
    }

    #[test]
    fn test_metadata_increment_usage() {
        let mut meta = TemplateMetadata::new();
        assert_eq!(meta.usage_count, 0);

        meta.increment_usage();
        assert_eq!(meta.usage_count, 1);

        meta.increment_usage();
        assert_eq!(meta.usage_count, 2);
    }

    // ========================================================================
    // Template Tests
    // ========================================================================

    #[test]
    fn test_template_new() {
        let template = Template::new("My Template", TemplateCategory::Shorts);

        assert!(!template.id.is_empty());
        assert_eq!(template.name, "My Template");
        assert_eq!(template.category, TemplateCategory::Shorts);
        assert!(!template.builtin);
    }

    #[test]
    fn test_template_builder_pattern() {
        let template = Template::new("Test", TemplateCategory::Educational)
            .with_description("A test template")
            .with_format(TemplateFormat::youtube_1080())
            .with_duration_range(60.0, 300.0)
            .as_builtin();

        assert_eq!(template.description, "A test template");
        assert_eq!(template.format.width, 1920);
        assert_eq!(template.duration_range, (60.0, 300.0));
        assert!(template.builtin);
    }

    #[test]
    fn test_template_with_sections() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(TemplateSection::new("Hook", ContentType::Video).with_required(true))
            .with_section(TemplateSection::new("Main", ContentType::Video).with_required(true))
            .with_section(TemplateSection::new("CTA", ContentType::Video).with_required(false));

        assert_eq!(template.sections.len(), 3);
        assert_eq!(template.required_section_count(), 2);
        assert_eq!(template.optional_section_count(), 1);
    }

    #[test]
    fn test_template_duration_calculations() {
        let template = Template::new("Test", TemplateCategory::Shorts)
            .with_section(
                TemplateSection::new("Hook", ContentType::Video).with_duration_range(3.0, 5.0),
            )
            .with_section(
                TemplateSection::new("Main", ContentType::Video).with_duration_range(10.0, 30.0),
            )
            .with_section(
                TemplateSection::new("CTA", ContentType::Video).with_duration_range(2.0, 5.0),
            );

        assert_eq!(template.min_duration(), 15.0);
        assert_eq!(template.max_duration(), 40.0);
    }

    #[test]
    fn test_template_validate_success() {
        let template = Template::new("Valid Template", TemplateCategory::Shorts).with_section(
            TemplateSection::new("Hook", ContentType::Video).with_duration_range(3.0, 5.0),
        );

        assert!(template.validate().is_ok());
    }

    #[test]
    fn test_template_validate_empty_name() {
        let mut template = Template::new("Test", TemplateCategory::Shorts);
        template.name = String::new();

        let result = template.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name"));
    }

    #[test]
    fn test_template_validate_no_sections() {
        let template = Template::new("Test", TemplateCategory::Shorts);

        let result = template.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("section"));
    }

    #[test]
    fn test_template_serialization() {
        let template = Template::new("Test Template", TemplateCategory::Shorts)
            .with_description("A test template")
            .with_section(TemplateSection::new("Hook", ContentType::Video));

        let json = serde_json::to_string(&template).unwrap();
        let parsed: Template = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.name, "Test Template");
        assert_eq!(parsed.description, "A test template");
        assert_eq!(parsed.sections.len(), 1);
    }
}
