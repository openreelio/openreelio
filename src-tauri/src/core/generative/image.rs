//! Image Generation
//!
//! Parameters and results for AI image generation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Style presets for image generation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ImageStyle {
    /// Photorealistic style
    Photorealistic,
    /// Artistic/painterly style
    Artistic,
    /// Anime/manga style
    Anime,
    /// 3D render style
    Render3D,
    /// Cinematic style
    Cinematic,
    /// Comic book style
    Comic,
    /// Minimalist/simple style
    Minimalist,
    /// Abstract style
    Abstract,
    /// Vintage/retro style
    Vintage,
    /// Neon/cyberpunk style
    Neon,
    /// Watercolor style
    Watercolor,
    /// Oil painting style
    OilPainting,
    /// Pixel art style
    PixelArt,
    /// No specific style
    #[default]
    None,
}

impl std::fmt::Display for ImageStyle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImageStyle::Photorealistic => write!(f, "Photorealistic"),
            ImageStyle::Artistic => write!(f, "Artistic"),
            ImageStyle::Anime => write!(f, "Anime"),
            ImageStyle::Render3D => write!(f, "3D Render"),
            ImageStyle::Cinematic => write!(f, "Cinematic"),
            ImageStyle::Comic => write!(f, "Comic"),
            ImageStyle::Minimalist => write!(f, "Minimalist"),
            ImageStyle::Abstract => write!(f, "Abstract"),
            ImageStyle::Vintage => write!(f, "Vintage"),
            ImageStyle::Neon => write!(f, "Neon"),
            ImageStyle::Watercolor => write!(f, "Watercolor"),
            ImageStyle::OilPainting => write!(f, "Oil Painting"),
            ImageStyle::PixelArt => write!(f, "Pixel Art"),
            ImageStyle::None => write!(f, "None"),
        }
    }
}

impl ImageStyle {
    /// Returns all available styles
    pub fn all() -> Vec<ImageStyle> {
        vec![
            ImageStyle::Photorealistic,
            ImageStyle::Artistic,
            ImageStyle::Anime,
            ImageStyle::Render3D,
            ImageStyle::Cinematic,
            ImageStyle::Comic,
            ImageStyle::Minimalist,
            ImageStyle::Abstract,
            ImageStyle::Vintage,
            ImageStyle::Neon,
            ImageStyle::Watercolor,
            ImageStyle::OilPainting,
            ImageStyle::PixelArt,
            ImageStyle::None,
        ]
    }

    /// Returns the prompt modifier for this style
    pub fn prompt_modifier(&self) -> Option<&'static str> {
        match self {
            ImageStyle::Photorealistic => Some("photorealistic, high detail, 8k resolution"),
            ImageStyle::Artistic => Some("artistic, painterly, expressive brush strokes"),
            ImageStyle::Anime => Some("anime style, manga art, cel shaded"),
            ImageStyle::Render3D => Some("3D render, octane render, blender, CGI"),
            ImageStyle::Cinematic => Some("cinematic, dramatic lighting, film grain, movie still"),
            ImageStyle::Comic => Some("comic book style, bold lines, halftone dots"),
            ImageStyle::Minimalist => Some("minimalist, simple, clean lines, flat design"),
            ImageStyle::Abstract => Some("abstract art, non-representational, geometric"),
            ImageStyle::Vintage => Some("vintage, retro, faded colors, nostalgic"),
            ImageStyle::Neon => Some("neon lights, cyberpunk, glowing, synthwave"),
            ImageStyle::Watercolor => Some("watercolor painting, soft edges, flowing colors"),
            ImageStyle::OilPainting => Some("oil painting, textured canvas, classical"),
            ImageStyle::PixelArt => Some("pixel art, 16-bit, retro game style"),
            ImageStyle::None => None,
        }
    }
}

/// Parameters for image generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenerationParams {
    /// Main prompt describing the image
    pub prompt: String,
    /// Negative prompt (what to avoid)
    pub negative_prompt: Option<String>,
    /// Desired width
    pub width: Option<u32>,
    /// Desired height
    pub height: Option<u32>,
    /// Style preset
    pub style: ImageStyle,
    /// Number of images to generate
    pub count: u32,
    /// Quality level (provider-specific, typically "standard" or "hd")
    pub quality: Option<String>,
    /// Guidance scale / CFG (how closely to follow prompt)
    pub guidance_scale: Option<f32>,
    /// Random seed for reproducibility
    pub seed: Option<u64>,
    /// Model ID to use
    pub model_id: Option<String>,
    /// Reference image for img2img or style transfer
    pub reference_image: Option<Vec<u8>>,
    /// Strength of reference image influence (0.0 - 1.0)
    pub reference_strength: Option<f32>,
    /// Additional provider-specific parameters
    pub extra_params: HashMap<String, serde_json::Value>,
}

impl ImageGenerationParams {
    /// Creates new params with just a prompt
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            negative_prompt: None,
            width: None,
            height: None,
            style: ImageStyle::default(),
            count: 1,
            quality: None,
            guidance_scale: None,
            seed: None,
            model_id: None,
            reference_image: None,
            reference_strength: None,
            extra_params: HashMap::new(),
        }
    }

    /// Sets the negative prompt
    pub fn with_negative_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.negative_prompt = Some(prompt.into());
        self
    }

    /// Sets the dimensions
    pub fn with_size(mut self, width: u32, height: u32) -> Self {
        self.width = Some(width);
        self.height = Some(height);
        self
    }

    /// Sets vertical (Shorts) dimensions
    pub fn shorts_size(self) -> Self {
        self.with_size(1080, 1920)
    }

    /// Sets horizontal (YouTube) dimensions
    pub fn youtube_size(self) -> Self {
        self.with_size(1920, 1080)
    }

    /// Sets square dimensions
    pub fn square_size(self) -> Self {
        self.with_size(1024, 1024)
    }

    /// Sets the style
    pub fn with_style(mut self, style: ImageStyle) -> Self {
        self.style = style;
        self
    }

    /// Sets the count
    pub fn with_count(mut self, count: u32) -> Self {
        self.count = count.clamp(1, 10); // Clamp to reasonable range
        self
    }

    /// Sets the quality
    pub fn with_quality(mut self, quality: impl Into<String>) -> Self {
        self.quality = Some(quality.into());
        self
    }

    /// Sets HD quality
    pub fn hd(self) -> Self {
        self.with_quality("hd")
    }

    /// Sets the guidance scale
    pub fn with_guidance(mut self, scale: f32) -> Self {
        self.guidance_scale = Some(scale.clamp(1.0, 30.0));
        self
    }

    /// Sets the seed
    pub fn with_seed(mut self, seed: u64) -> Self {
        self.seed = Some(seed);
        self
    }

    /// Sets the model ID
    pub fn with_model(mut self, model_id: impl Into<String>) -> Self {
        self.model_id = Some(model_id.into());
        self
    }

    /// Sets a reference image for img2img
    pub fn with_reference(mut self, image: Vec<u8>, strength: f32) -> Self {
        self.reference_image = Some(image);
        self.reference_strength = Some(strength.clamp(0.0, 1.0));
        self
    }

    /// Builds the full prompt including style modifier
    pub fn full_prompt(&self) -> String {
        match self.style.prompt_modifier() {
            Some(modifier) => format!("{}, {}", self.prompt, modifier),
            None => self.prompt.clone(),
        }
    }

    /// Validates the parameters
    pub fn validate(&self) -> Result<(), String> {
        if self.prompt.trim().is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }

        if self.prompt.len() > 4000 {
            return Err("Prompt too long (max 4000 characters)".to_string());
        }

        if let Some(w) = self.width {
            if !(64..=4096).contains(&w) {
                return Err("Width must be between 64 and 4096".to_string());
            }
        }

        if let Some(h) = self.height {
            if !(64..=4096).contains(&h) {
                return Err("Height must be between 64 and 4096".to_string());
            }
        }

        Ok(())
    }
}

/// Result of image generation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenerationResult {
    /// Unique result ID
    pub id: String,
    /// Original prompt
    pub prompt: String,
    /// Generated image data
    #[serde(skip_serializing)] // Don't serialize binary data
    pub image_data: Vec<u8>,
    /// MIME type
    pub mime_type: String,
    /// Actual width
    pub width: u32,
    /// Actual height
    pub height: u32,
    /// Model that was used
    pub model_used: String,
    /// Generation time in milliseconds
    pub generation_time_ms: u64,
    /// Additional metadata
    pub metadata: HashMap<String, serde_json::Value>,
}

impl ImageGenerationResult {
    /// Returns the file extension based on MIME type
    pub fn file_extension(&self) -> &str {
        match self.mime_type.as_str() {
            "image/png" => "png",
            "image/jpeg" | "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "bin",
        }
    }

    /// Returns suggested filename
    pub fn suggested_filename(&self) -> String {
        let short_prompt: String = self
            .prompt
            .chars()
            .take(30)
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect::<String>()
            .trim()
            .replace(' ', "_");

        format!(
            "generated_{}_{}.{}",
            short_prompt,
            &self.id[..8],
            self.file_extension()
        )
    }

    /// Returns the aspect ratio
    pub fn aspect_ratio(&self) -> f32 {
        self.width as f32 / self.height as f32
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // ImageStyle Tests
    // ========================================================================

    #[test]
    fn test_style_default() {
        let style = ImageStyle::default();
        assert_eq!(style, ImageStyle::None);
    }

    #[test]
    fn test_style_display() {
        assert_eq!(ImageStyle::Photorealistic.to_string(), "Photorealistic");
        assert_eq!(ImageStyle::Anime.to_string(), "Anime");
        assert_eq!(ImageStyle::None.to_string(), "None");
    }

    #[test]
    fn test_style_all() {
        let all = ImageStyle::all();
        assert!(!all.is_empty());
        assert!(all.contains(&ImageStyle::Photorealistic));
        assert!(all.contains(&ImageStyle::None));
    }

    #[test]
    fn test_style_prompt_modifier() {
        assert!(ImageStyle::Cinematic.prompt_modifier().is_some());
        assert!(ImageStyle::Anime
            .prompt_modifier()
            .unwrap()
            .contains("anime"));
        assert!(ImageStyle::None.prompt_modifier().is_none());
    }

    #[test]
    fn test_style_serialization() {
        assert_eq!(
            serde_json::to_string(&ImageStyle::Photorealistic).unwrap(),
            "\"photorealistic\""
        );
        assert_eq!(
            serde_json::from_str::<ImageStyle>("\"anime\"").unwrap(),
            ImageStyle::Anime
        );
    }

    // ========================================================================
    // ImageGenerationParams Tests
    // ========================================================================

    #[test]
    fn test_params_new() {
        let params = ImageGenerationParams::new("A beautiful sunset");

        assert_eq!(params.prompt, "A beautiful sunset");
        assert_eq!(params.count, 1);
        assert!(params.negative_prompt.is_none());
    }

    #[test]
    fn test_params_builder() {
        let params = ImageGenerationParams::new("Test prompt")
            .with_negative_prompt("blurry, low quality")
            .with_size(1024, 1024)
            .with_style(ImageStyle::Cinematic)
            .with_count(4)
            .with_guidance(7.5)
            .with_seed(12345);

        assert_eq!(
            params.negative_prompt,
            Some("blurry, low quality".to_string())
        );
        assert_eq!(params.width, Some(1024));
        assert_eq!(params.height, Some(1024));
        assert_eq!(params.style, ImageStyle::Cinematic);
        assert_eq!(params.count, 4);
        assert_eq!(params.guidance_scale, Some(7.5));
        assert_eq!(params.seed, Some(12345));
    }

    #[test]
    fn test_params_preset_sizes() {
        let shorts = ImageGenerationParams::new("Test").shorts_size();
        assert_eq!(shorts.width, Some(1080));
        assert_eq!(shorts.height, Some(1920));

        let youtube = ImageGenerationParams::new("Test").youtube_size();
        assert_eq!(youtube.width, Some(1920));
        assert_eq!(youtube.height, Some(1080));

        let square = ImageGenerationParams::new("Test").square_size();
        assert_eq!(square.width, Some(1024));
        assert_eq!(square.height, Some(1024));
    }

    #[test]
    fn test_params_count_clamped() {
        let params = ImageGenerationParams::new("Test").with_count(100);
        assert_eq!(params.count, 10); // Clamped to max

        let params2 = ImageGenerationParams::new("Test").with_count(0);
        assert_eq!(params2.count, 1); // Clamped to min
    }

    #[test]
    fn test_params_full_prompt() {
        let params =
            ImageGenerationParams::new("A mountain landscape").with_style(ImageStyle::Cinematic);

        let full = params.full_prompt();
        assert!(full.contains("A mountain landscape"));
        assert!(full.contains("cinematic"));
    }

    #[test]
    fn test_params_full_prompt_no_style() {
        let params = ImageGenerationParams::new("Simple prompt");
        assert_eq!(params.full_prompt(), "Simple prompt");
    }

    #[test]
    fn test_params_validate_success() {
        let params = ImageGenerationParams::new("Valid prompt").with_size(1024, 1024);

        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_params_validate_empty_prompt() {
        let params = ImageGenerationParams::new("  ");
        let result = params.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_params_validate_invalid_size() {
        let params = ImageGenerationParams::new("Test").with_size(10, 1024);
        let result = params.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Width"));
    }

    // ========================================================================
    // ImageGenerationResult Tests
    // ========================================================================

    #[test]
    fn test_result_file_extension() {
        let mut result = ImageGenerationResult {
            id: "test".to_string(),
            prompt: "Test".to_string(),
            image_data: vec![],
            mime_type: "image/png".to_string(),
            width: 1024,
            height: 1024,
            model_used: "test".to_string(),
            generation_time_ms: 100,
            metadata: HashMap::new(),
        };

        assert_eq!(result.file_extension(), "png");

        result.mime_type = "image/jpeg".to_string();
        assert_eq!(result.file_extension(), "jpg");

        result.mime_type = "image/webp".to_string();
        assert_eq!(result.file_extension(), "webp");
    }

    #[test]
    fn test_result_suggested_filename() {
        let result = ImageGenerationResult {
            id: "01HZ123456789ABCDEF".to_string(),
            prompt: "A beautiful sunset over the ocean".to_string(),
            image_data: vec![],
            mime_type: "image/png".to_string(),
            width: 1024,
            height: 1024,
            model_used: "test".to_string(),
            generation_time_ms: 100,
            metadata: HashMap::new(),
        };

        let filename = result.suggested_filename();
        assert!(filename.starts_with("generated_"));
        assert!(filename.ends_with(".png"));
        assert!(filename.contains("01HZ1234"));
    }

    #[test]
    fn test_result_aspect_ratio() {
        let mut result = ImageGenerationResult {
            id: "test".to_string(),
            prompt: "Test".to_string(),
            image_data: vec![],
            mime_type: "image/png".to_string(),
            width: 1920,
            height: 1080,
            model_used: "test".to_string(),
            generation_time_ms: 100,
            metadata: HashMap::new(),
        };

        // 16:9
        let ar = result.aspect_ratio();
        assert!((ar - 1.777).abs() < 0.01);

        // 9:16 (vertical)
        result.width = 1080;
        result.height = 1920;
        let ar2 = result.aspect_ratio();
        assert!((ar2 - 0.5625).abs() < 0.01);
    }
}
