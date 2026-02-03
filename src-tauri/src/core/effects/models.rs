//! Effect Model Definitions
//!
//! Defines Effect types and parameters for video/audio processing.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::core::masks::MaskGroup;
use crate::core::EffectId;

// =============================================================================
// Effect Types
// =============================================================================

/// Categories of effects
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectCategory {
    /// Color adjustments (brightness, contrast, saturation, etc.)
    Color,
    /// Transform effects (flip, mirror, crop)
    Transform,
    /// Blur and sharpen effects
    BlurSharpen,
    /// Stylize effects (glow, vignette, etc.)
    Stylize,
    /// Transition effects
    Transition,
    /// Audio effects
    Audio,
    /// Text overlay effects
    Text,
    /// Keying effects (chroma key, luma key)
    Keying,
    /// Compositing effects (blend mode, opacity)
    Compositing,
    /// Advanced color grading (HSL qualifier, color match)
    AdvancedColor,
    /// AI-powered effects
    Ai,
    /// Custom/plugin effects
    Custom,
}

/// Predefined effect types
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectType {
    // Color effects
    Brightness,
    Contrast,
    Saturation,
    Hue,
    ColorBalance,
    ColorWheels, // Lift/Gamma/Gain (3-way color corrector)
    Gamma,
    Levels,
    Curves,
    Lut,

    // Transform effects
    Crop,
    Flip,
    Mirror,
    Rotate,

    // Blur/Sharpen
    GaussianBlur,
    BoxBlur,
    MotionBlur,
    RadialBlur,
    Sharpen,
    UnsharpMask,

    // Stylize
    Vignette,
    Glow,
    FilmGrain,
    ChromaticAberration,
    Noise,
    Pixelate,
    Posterize,

    // Transitions
    CrossDissolve,
    Fade,
    Wipe,
    Slide,
    Zoom,

    // Audio
    Volume,
    Gain,
    EqBand,
    Compressor,
    Limiter,
    NoiseReduction,
    Reverb,
    Delay,

    // Text
    TextOverlay,
    Subtitle,

    // Keying
    ChromaKey,
    LumaKey,

    // Compositing
    BlendMode,
    Opacity,

    // Advanced Color Grading
    HSLQualifier,

    // Audio Metering
    LoudnessNormalize,

    // AI
    BackgroundRemoval,
    AutoReframe,
    FaceBlur,
    ObjectTracking,

    // Custom
    Custom(String),
}

impl EffectType {
    /// Returns the category for this effect type
    pub fn category(&self) -> EffectCategory {
        match self {
            Self::Brightness
            | Self::Contrast
            | Self::Saturation
            | Self::Hue
            | Self::ColorBalance
            | Self::ColorWheels
            | Self::Gamma
            | Self::Levels
            | Self::Curves
            | Self::Lut => EffectCategory::Color,

            Self::Crop | Self::Flip | Self::Mirror | Self::Rotate => EffectCategory::Transform,

            Self::GaussianBlur
            | Self::BoxBlur
            | Self::MotionBlur
            | Self::RadialBlur
            | Self::Sharpen
            | Self::UnsharpMask => EffectCategory::BlurSharpen,

            Self::Vignette
            | Self::Glow
            | Self::FilmGrain
            | Self::ChromaticAberration
            | Self::Noise
            | Self::Pixelate
            | Self::Posterize => EffectCategory::Stylize,

            Self::CrossDissolve | Self::Fade | Self::Wipe | Self::Slide | Self::Zoom => {
                EffectCategory::Transition
            }

            Self::Volume
            | Self::Gain
            | Self::EqBand
            | Self::Compressor
            | Self::Limiter
            | Self::NoiseReduction
            | Self::Reverb
            | Self::Delay => EffectCategory::Audio,

            Self::TextOverlay | Self::Subtitle => EffectCategory::Text,

            Self::ChromaKey | Self::LumaKey => EffectCategory::Keying,

            Self::BlendMode | Self::Opacity => EffectCategory::Compositing,

            Self::HSLQualifier => EffectCategory::AdvancedColor,

            Self::LoudnessNormalize => EffectCategory::Audio,

            Self::BackgroundRemoval | Self::AutoReframe | Self::FaceBlur | Self::ObjectTracking => {
                EffectCategory::Ai
            }

            Self::Custom(_) => EffectCategory::Custom,
        }
    }

    /// Returns true if this is an audio effect
    pub fn is_audio(&self) -> bool {
        matches!(self.category(), EffectCategory::Audio)
    }

    /// Returns true if this is a video effect
    pub fn is_video(&self) -> bool {
        !self.is_audio()
    }
}

// =============================================================================
// Effect Parameters
// =============================================================================

/// Effect parameter value types
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Float(f64),
    Int(i64),
    Bool(bool),
    String(String),
    Color([f32; 4]), // RGBA
    Point([f64; 2]), // x, y
    Range([f64; 2]), // min, max
}

impl ParamValue {
    /// Attempts to get as f64
    pub fn as_float(&self) -> Option<f64> {
        match self {
            Self::Float(v) => Some(*v),
            Self::Int(v) => Some(*v as f64),
            _ => None,
        }
    }

    /// Attempts to get as i64
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(v) => Some(*v),
            Self::Float(v) => Some(*v as i64),
            _ => None,
        }
    }

    /// Attempts to get as bool
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(v) => Some(*v),
            _ => None,
        }
    }

    /// Attempts to get as string reference
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
}

/// Parameter definition with constraints
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    /// Parameter name
    pub name: String,
    /// Display label
    pub label: String,
    /// Default value
    pub default: ParamValue,
    /// Minimum value (for numeric types)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Maximum value (for numeric types)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Step size for UI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
}

impl ParamDef {
    /// Creates a new float parameter definition
    pub fn float(name: &str, label: &str, default: f64, min: f64, max: f64) -> Self {
        Self {
            name: name.to_string(),
            label: label.to_string(),
            default: ParamValue::Float(default),
            min: Some(min),
            max: Some(max),
            step: None,
        }
    }

    /// Creates a new boolean parameter definition
    pub fn boolean(name: &str, label: &str, default: bool) -> Self {
        Self {
            name: name.to_string(),
            label: label.to_string(),
            default: ParamValue::Bool(default),
            min: None,
            max: None,
            step: None,
        }
    }

    /// Creates a new string parameter definition
    pub fn string(name: &str, label: &str, default: &str) -> Self {
        Self {
            name: name.to_string(),
            label: label.to_string(),
            default: ParamValue::String(default.to_string()),
            min: None,
            max: None,
            step: None,
        }
    }

    /// Validates a value against this definition
    pub fn validate(&self, value: &ParamValue) -> Result<(), String> {
        if let Some(val) = value.as_float() {
            if let Some(min) = self.min {
                if val < min {
                    return Err(format!(
                        "Parameter '{}' value {} is below minimum {}",
                        self.name, val, min
                    ));
                }
            }
            if let Some(max) = self.max {
                if val > max {
                    return Err(format!(
                        "Parameter '{}' value {} is above maximum {}",
                        self.name, val, max
                    ));
                }
            }
        }
        Ok(())
    }
}

// =============================================================================
// Keyframe Animation
// =============================================================================

/// Easing function for keyframe interpolation
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
    CubicBezier,
    Step,
    Hold,
}

/// A keyframe for parameter animation
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    /// Time offset from effect start (seconds)
    pub time_offset: f64,
    /// Parameter value at this keyframe
    pub value: ParamValue,
    /// Easing to next keyframe
    #[serde(default)]
    pub easing: Easing,
}

impl Keyframe {
    /// Creates a new keyframe
    pub fn new(time_offset: f64, value: ParamValue) -> Self {
        Self {
            time_offset,
            value,
            easing: Easing::Linear,
        }
    }

    /// Creates a keyframe with easing
    pub fn with_easing(time_offset: f64, value: ParamValue, easing: Easing) -> Self {
        Self {
            time_offset,
            value,
            easing,
        }
    }
}

// =============================================================================
// Effect Instance
// =============================================================================

/// An effect instance applied to a clip
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    /// Unique identifier
    pub id: EffectId,
    /// Effect type
    pub effect_type: EffectType,
    /// Whether the effect is enabled
    pub enabled: bool,
    /// Effect parameters (static values)
    pub params: HashMap<String, ParamValue>,
    /// Keyframed parameters
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub keyframes: HashMap<String, Vec<Keyframe>>,
    /// Effect order/priority (lower = first)
    pub order: u32,
    /// Masks (Power Windows) for selective effect application
    #[serde(default, skip_serializing_if = "MaskGroup::is_empty")]
    pub masks: MaskGroup,
}

impl Effect {
    /// Creates a new effect with default parameters
    pub fn new(effect_type: EffectType) -> Self {
        let params = Self::default_params(&effect_type);
        Self {
            id: ulid::Ulid::new().to_string(),
            effect_type,
            enabled: true,
            params,
            keyframes: HashMap::new(),
            order: 0,
            masks: MaskGroup::new(),
        }
    }

    /// Creates an effect with a specific ID
    pub fn with_id(id: &str, effect_type: EffectType) -> Self {
        let params = Self::default_params(&effect_type);
        Self {
            id: id.to_string(),
            effect_type,
            enabled: true,
            params,
            keyframes: HashMap::new(),
            order: 0,
            masks: MaskGroup::new(),
        }
    }

    /// Returns default parameters for an effect type
    pub fn default_params(effect_type: &EffectType) -> HashMap<String, ParamValue> {
        let mut params = HashMap::new();

        match effect_type {
            EffectType::Brightness => {
                params.insert("value".to_string(), ParamValue::Float(0.0));
            }
            EffectType::Contrast => {
                params.insert("value".to_string(), ParamValue::Float(1.0));
            }
            EffectType::Saturation => {
                params.insert("value".to_string(), ParamValue::Float(1.0));
            }
            EffectType::GaussianBlur => {
                params.insert("radius".to_string(), ParamValue::Float(5.0));
            }
            EffectType::Vignette => {
                params.insert("intensity".to_string(), ParamValue::Float(0.5));
                params.insert("radius".to_string(), ParamValue::Float(0.8));
            }
            EffectType::ColorWheels => {
                // Lift (shadows) - affects dark regions
                params.insert("lift_r".to_string(), ParamValue::Float(0.0));
                params.insert("lift_g".to_string(), ParamValue::Float(0.0));
                params.insert("lift_b".to_string(), ParamValue::Float(0.0));
                // Gamma (midtones) - affects mid-range luminance
                params.insert("gamma_r".to_string(), ParamValue::Float(0.0));
                params.insert("gamma_g".to_string(), ParamValue::Float(0.0));
                params.insert("gamma_b".to_string(), ParamValue::Float(0.0));
                // Gain (highlights) - affects bright regions
                params.insert("gain_r".to_string(), ParamValue::Float(0.0));
                params.insert("gain_g".to_string(), ParamValue::Float(0.0));
                params.insert("gain_b".to_string(), ParamValue::Float(0.0));
            }
            EffectType::Volume => {
                params.insert("level".to_string(), ParamValue::Float(1.0));
            }
            EffectType::Fade => {
                params.insert("duration".to_string(), ParamValue::Float(1.0));
                params.insert("fade_in".to_string(), ParamValue::Bool(true));
            }
            EffectType::NoiseReduction => {
                // anlmdn filter params (non-local means denoise)
                params.insert("strength".to_string(), ParamValue::Float(0.00001)); // s parameter
                params.insert("patch_size".to_string(), ParamValue::Float(7.0)); // p parameter (odd 1-99)
                params.insert("research_size".to_string(), ParamValue::Float(15.0));
                // r parameter (odd 1-99)
            }
            EffectType::ChromaKey => {
                // chromakey filter params
                params.insert(
                    "key_color".to_string(),
                    ParamValue::String("#00FF00".to_string()),
                ); // Green screen default
                params.insert("similarity".to_string(), ParamValue::Float(0.3)); // Color similarity threshold (0.0-1.0)
                params.insert("blend".to_string(), ParamValue::Float(0.1)); // Blend/feather amount (0.0-1.0)
            }
            EffectType::LumaKey => {
                // lumakey filter params
                params.insert("threshold".to_string(), ParamValue::Float(0.1)); // Luminance threshold (0.0-1.0)
                params.insert("tolerance".to_string(), ParamValue::Float(0.1)); // Tolerance range (0.0-1.0)
                params.insert("softness".to_string(), ParamValue::Float(0.0)); // Edge softness (0.0-1.0)
            }
            EffectType::BlendMode => {
                // blend filter params - blend modes: normal, multiply, screen, overlay, add, subtract, difference
                params.insert("mode".to_string(), ParamValue::String("normal".to_string()));
                params.insert("opacity".to_string(), ParamValue::Float(1.0)); // Overall opacity 0.0-1.0
            }
            EffectType::Opacity => {
                // Simple opacity control
                params.insert("value".to_string(), ParamValue::Float(1.0)); // 0.0 = transparent, 1.0 = opaque
            }
            EffectType::HSLQualifier => {
                // HSL Qualifier for selective color correction
                // Hue selection
                params.insert("hue_center".to_string(), ParamValue::Float(120.0)); // Center hue in degrees (0-360, 120=green)
                params.insert("hue_width".to_string(), ParamValue::Float(30.0)); // Hue range width in degrees
                                                                                 // Saturation range
                params.insert("sat_min".to_string(), ParamValue::Float(0.2)); // Minimum saturation (0.0-1.0)
                params.insert("sat_max".to_string(), ParamValue::Float(1.0)); // Maximum saturation (0.0-1.0)
                                                                              // Luminance range
                params.insert("lum_min".to_string(), ParamValue::Float(0.0)); // Minimum luminance (0.0-1.0)
                params.insert("lum_max".to_string(), ParamValue::Float(1.0)); // Maximum luminance (0.0-1.0)
                                                                              // Softness/feather
                params.insert("softness".to_string(), ParamValue::Float(0.1)); // Edge softness (0.0-1.0)
                                                                               // Adjustment values to apply to qualified region
                params.insert("hue_shift".to_string(), ParamValue::Float(0.0)); // Hue rotation (-180 to 180)
                params.insert("sat_adjust".to_string(), ParamValue::Float(0.0)); // Saturation adjustment (-1.0 to 1.0)
                params.insert("lum_adjust".to_string(), ParamValue::Float(0.0)); // Luminance adjustment (-1.0 to 1.0)
                params.insert("invert".to_string(), ParamValue::Bool(false)); // Invert selection
            }
            EffectType::LoudnessNormalize => {
                // EBU R128 loudness normalization
                params.insert("target_lufs".to_string(), ParamValue::Float(-14.0)); // Target integrated loudness (-70 to -5 LUFS)
                params.insert("target_lra".to_string(), ParamValue::Float(11.0)); // Target loudness range (1-50 LU)
                params.insert("target_tp".to_string(), ParamValue::Float(-1.0)); // Target true peak (-9 to 0 dBTP)
                params.insert(
                    "print_format".to_string(),
                    ParamValue::String("summary".to_string()),
                ); // Output format
            }
            _ => {}
        }

        params
    }

    /// Returns parameter definitions for this effect type
    pub fn param_definitions(&self) -> Vec<ParamDef> {
        match &self.effect_type {
            EffectType::Brightness => {
                vec![ParamDef::float("value", "Brightness", 0.0, -1.0, 1.0)]
            }
            EffectType::Contrast => {
                vec![ParamDef::float("value", "Contrast", 1.0, 0.0, 3.0)]
            }
            EffectType::Saturation => {
                vec![ParamDef::float("value", "Saturation", 1.0, 0.0, 3.0)]
            }
            EffectType::GaussianBlur => {
                vec![ParamDef::float("radius", "Radius", 5.0, 0.0, 100.0)]
            }
            EffectType::Vignette => vec![
                ParamDef::float("intensity", "Intensity", 0.5, 0.0, 1.0),
                ParamDef::float("radius", "Radius", 0.8, 0.0, 2.0),
            ],
            EffectType::Volume => {
                vec![ParamDef::float("level", "Volume", 1.0, 0.0, 2.0)]
            }
            EffectType::Fade => vec![
                ParamDef::float("duration", "Duration", 1.0, 0.0, 10.0),
                ParamDef::boolean("fade_in", "Fade In", true),
            ],
            EffectType::ColorWheels => vec![
                // Lift (shadows)
                ParamDef::float("lift_r", "Lift Red", 0.0, -1.0, 1.0),
                ParamDef::float("lift_g", "Lift Green", 0.0, -1.0, 1.0),
                ParamDef::float("lift_b", "Lift Blue", 0.0, -1.0, 1.0),
                // Gamma (midtones)
                ParamDef::float("gamma_r", "Gamma Red", 0.0, -1.0, 1.0),
                ParamDef::float("gamma_g", "Gamma Green", 0.0, -1.0, 1.0),
                ParamDef::float("gamma_b", "Gamma Blue", 0.0, -1.0, 1.0),
                // Gain (highlights)
                ParamDef::float("gain_r", "Gain Red", 0.0, -1.0, 1.0),
                ParamDef::float("gain_g", "Gain Green", 0.0, -1.0, 1.0),
                ParamDef::float("gain_b", "Gain Blue", 0.0, -1.0, 1.0),
            ],
            EffectType::NoiseReduction => vec![
                // anlmdn (non-local means denoise) parameters
                ParamDef::float("strength", "Strength", 0.00001, 0.00001, 0.0001),
                ParamDef::float("patch_size", "Patch Size", 7.0, 1.0, 99.0),
                ParamDef::float("research_size", "Research Size", 15.0, 1.0, 99.0),
            ],
            EffectType::ChromaKey => vec![
                // chromakey parameters
                ParamDef::string("key_color", "Key Color", "#00FF00"),
                ParamDef::float("similarity", "Similarity", 0.3, 0.0, 1.0),
                ParamDef::float("blend", "Blend", 0.1, 0.0, 1.0),
            ],
            EffectType::LumaKey => vec![
                // lumakey parameters
                ParamDef::float("threshold", "Threshold", 0.1, 0.0, 1.0),
                ParamDef::float("tolerance", "Tolerance", 0.1, 0.0, 1.0),
                ParamDef::float("softness", "Softness", 0.0, 0.0, 1.0),
            ],
            EffectType::BlendMode => vec![
                // blend mode parameters
                ParamDef::string("mode", "Blend Mode", "normal"),
                ParamDef::float("opacity", "Opacity", 1.0, 0.0, 1.0),
            ],
            EffectType::Opacity => vec![
                // opacity parameter
                ParamDef::float("value", "Opacity", 1.0, 0.0, 1.0),
            ],
            EffectType::HSLQualifier => vec![
                // Hue selection
                ParamDef::float("hue_center", "Hue Center", 120.0, 0.0, 360.0),
                ParamDef::float("hue_width", "Hue Width", 30.0, 1.0, 180.0),
                // Saturation range
                ParamDef::float("sat_min", "Saturation Min", 0.2, 0.0, 1.0),
                ParamDef::float("sat_max", "Saturation Max", 1.0, 0.0, 1.0),
                // Luminance range
                ParamDef::float("lum_min", "Luminance Min", 0.0, 0.0, 1.0),
                ParamDef::float("lum_max", "Luminance Max", 1.0, 0.0, 1.0),
                // Softness
                ParamDef::float("softness", "Softness", 0.1, 0.0, 1.0),
                // Adjustments
                ParamDef::float("hue_shift", "Hue Shift", 0.0, -180.0, 180.0),
                ParamDef::float("sat_adjust", "Saturation Adjust", 0.0, -1.0, 1.0),
                ParamDef::float("lum_adjust", "Luminance Adjust", 0.0, -1.0, 1.0),
                // Invert
                ParamDef::boolean("invert", "Invert Selection", false),
            ],
            EffectType::LoudnessNormalize => vec![
                // EBU R128 loudness normalization parameters
                ParamDef::float("target_lufs", "Target LUFS", -14.0, -70.0, -5.0),
                ParamDef::float("target_lra", "Target LRA", 11.0, 1.0, 50.0),
                ParamDef::float("target_tp", "Target True Peak", -1.0, -9.0, 0.0),
                ParamDef::string("print_format", "Print Format", "summary"),
            ],
            _ => vec![],
        }
    }

    /// Sets a parameter value
    pub fn set_param(&mut self, name: &str, value: ParamValue) {
        self.params.insert(name.to_string(), value);
    }

    /// Gets a parameter value
    pub fn get_param(&self, name: &str) -> Option<&ParamValue> {
        self.params.get(name)
    }

    /// Gets a parameter value as f64
    pub fn get_float(&self, name: &str) -> Option<f64> {
        self.params.get(name).and_then(|v| v.as_float())
    }

    /// Gets a parameter value as bool
    pub fn get_bool(&self, name: &str) -> Option<bool> {
        self.params.get(name).and_then(|v| v.as_bool())
    }

    /// Gets a parameter value as String
    pub fn get_string(&self, name: &str) -> Option<String> {
        self.params
            .get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// Validates all parameters
    pub fn validate(&self) -> Result<(), String> {
        let defs = self.param_definitions();

        for def in &defs {
            if let Some(value) = self.params.get(&def.name) {
                def.validate(value)?;
            }
        }

        Ok(())
    }

    /// Adds a keyframe for a parameter
    pub fn add_keyframe(&mut self, param_name: &str, keyframe: Keyframe) -> Result<(), String> {
        if !keyframe.time_offset.is_finite() || keyframe.time_offset < 0.0 {
            warn!(
                param_name = param_name,
                time_offset = keyframe.time_offset,
                "Rejected invalid keyframe time_offset"
            );
            return Err("Keyframe timeOffset must be finite and non-negative".to_string());
        }

        let keyframes = self.keyframes.entry(param_name.to_string()).or_default();
        keyframes.push(keyframe);
        // total_cmp provides a total ordering for floats (including -0.0 and NaNs).
        // We still validate time_offset above to reject non-finite inputs.
        keyframes.sort_by(|a, b| a.time_offset.total_cmp(&b.time_offset));
        Ok(())
    }

    /// Gets the interpolated value at a specific time
    pub fn get_value_at(&self, param_name: &str, time_offset: f64) -> Option<ParamValue> {
        // Check keyframes first
        if let Some(keyframes) = self.keyframes.get(param_name) {
            if !keyframes.is_empty() {
                return Some(self.interpolate_keyframes(keyframes, time_offset));
            }
        }

        // Fall back to static value
        self.params.get(param_name).cloned()
    }

    /// Interpolates between keyframes (linear for now)
    fn interpolate_keyframes(&self, keyframes: &[Keyframe], time_offset: f64) -> ParamValue {
        if keyframes.is_empty() {
            warn!("Interpolate called with empty keyframes; defaulting to 0.0");
            return ParamValue::Float(0.0);
        }

        if !time_offset.is_finite() {
            warn!(
                time_offset = time_offset,
                "Non-finite time_offset provided to interpolate; defaulting to first keyframe"
            );
            return keyframes[0].value.clone();
        }

        // If there are multiple keyframes at the exact same time, pick the last one.
        // This makes updates deterministic and avoids surprising "stale" values.
        if time_offset == keyframes[0].time_offset {
            if let Some(kf) = keyframes
                .iter()
                .take_while(|kf| kf.time_offset == time_offset)
                .last()
            {
                return kf.value.clone();
            }
        }

        // Before first keyframe
        if time_offset <= keyframes[0].time_offset {
            return keyframes[0].value.clone();
        }

        // After last keyframe
        if time_offset >= keyframes.last().unwrap().time_offset {
            return keyframes.last().unwrap().value.clone();
        }

        // Find surrounding keyframes
        for i in 0..keyframes.len() - 1 {
            let kf1 = &keyframes[i];
            let kf2 = &keyframes[i + 1];

            if time_offset >= kf1.time_offset && time_offset <= kf2.time_offset {
                // Linear interpolation
                let denom = kf2.time_offset - kf1.time_offset;
                if denom <= 0.0 {
                    // Duplicate keyframes or invalid ordering; treat as a step to the next value.
                    return kf2.value.clone();
                }
                let t = ((time_offset - kf1.time_offset) / denom).clamp(0.0, 1.0);

                match (&kf1.value, &kf2.value) {
                    (ParamValue::Float(v1), ParamValue::Float(v2)) => {
                        return ParamValue::Float(v1 + (v2 - v1) * t);
                    }
                    (ParamValue::Int(v1), ParamValue::Int(v2)) => {
                        return ParamValue::Int((*v1 as f64 + (*v2 - *v1) as f64 * t) as i64);
                    }
                    _ => return kf1.value.clone(), // Non-interpolatable, use earlier value
                }
            }
        }

        keyframes.last().unwrap().value.clone()
    }

    /// Returns the category of this effect
    pub fn category(&self) -> EffectCategory {
        self.effect_type.category()
    }

    /// Returns true if this is an audio effect
    pub fn is_audio(&self) -> bool {
        self.effect_type.is_audio()
    }

    /// Returns true if this is a video effect
    pub fn is_video(&self) -> bool {
        self.effect_type.is_video()
    }

    /// Creates a copy of the effect with all keyframed parameters resolved at a specific time.
    /// Useful for FFmpeg export where we need static values.
    ///
    /// # Arguments
    ///
    /// * `time_offset` - Time offset in seconds from effect start
    ///
    /// # Returns
    ///
    /// A new Effect with params containing interpolated values, keyframes cleared
    pub fn with_params_at_time(&self, time_offset: f64) -> Self {
        let mut resolved = self.clone();

        // Resolve all keyframed parameters to their interpolated values
        for (param_name, keyframes) in &self.keyframes {
            if !keyframes.is_empty() {
                let interpolated = self.interpolate_keyframes(keyframes, time_offset);
                resolved.params.insert(param_name.clone(), interpolated);
            }
        }

        // Clear keyframes since we've resolved them
        resolved.keyframes.clear();

        resolved
    }

    /// Returns true if this effect has any keyframes
    pub fn has_keyframes(&self) -> bool {
        self.keyframes.values().any(|kfs| !kfs.is_empty())
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Effect Type Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_type_category() {
        assert_eq!(EffectType::Brightness.category(), EffectCategory::Color);
        assert_eq!(
            EffectType::GaussianBlur.category(),
            EffectCategory::BlurSharpen
        );
        assert_eq!(EffectType::Volume.category(), EffectCategory::Audio);
        assert_eq!(EffectType::Fade.category(), EffectCategory::Transition);
        assert_eq!(EffectType::TextOverlay.category(), EffectCategory::Text);
        assert_eq!(EffectType::FaceBlur.category(), EffectCategory::Ai);
        assert_eq!(
            EffectType::Custom("my_effect".to_string()).category(),
            EffectCategory::Custom
        );
    }

    #[test]
    fn test_effect_type_is_audio() {
        assert!(EffectType::Volume.is_audio());
        assert!(EffectType::Gain.is_audio());
        assert!(EffectType::Reverb.is_audio());
        assert!(!EffectType::Brightness.is_audio());
        assert!(!EffectType::GaussianBlur.is_audio());
    }

    #[test]
    fn keyframes_reject_non_finite_or_negative_times() {
        let mut effect = Effect::new(EffectType::GaussianBlur);

        assert!(effect
            .add_keyframe("radius", Keyframe::new(-1.0, ParamValue::Float(1.0)))
            .is_err());
        assert!(effect
            .add_keyframe("radius", Keyframe::new(f64::NAN, ParamValue::Float(1.0)))
            .is_err());
        assert!(effect
            .add_keyframe(
                "radius",
                Keyframe::new(f64::INFINITY, ParamValue::Float(1.0))
            )
            .is_err());
    }

    #[test]
    fn keyframes_interpolation_handles_duplicate_offsets() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect
            .add_keyframe("radius", Keyframe::new(1.0, ParamValue::Float(10.0)))
            .unwrap();
        effect
            .add_keyframe("radius", Keyframe::new(1.0, ParamValue::Float(20.0)))
            .unwrap();

        // Duplicate offsets should not divide-by-zero; treat as a step.
        let v = effect
            .get_value_at("radius", 1.0)
            .unwrap()
            .as_float()
            .unwrap();
        assert_eq!(v, 20.0);
    }

    #[test]
    fn keyframes_interpolation_handles_nan_time_offset() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect
            .add_keyframe("radius", Keyframe::new(0.0, ParamValue::Float(5.0)))
            .unwrap();
        effect
            .add_keyframe("radius", Keyframe::new(2.0, ParamValue::Float(15.0)))
            .unwrap();

        let v = effect
            .get_value_at("radius", f64::NAN)
            .unwrap()
            .as_float()
            .unwrap();
        assert_eq!(v, 5.0);
    }

    #[test]
    fn test_effect_type_is_video() {
        assert!(EffectType::Brightness.is_video());
        assert!(EffectType::GaussianBlur.is_video());
        assert!(EffectType::Vignette.is_video());
        assert!(!EffectType::Volume.is_video());
        assert!(!EffectType::Gain.is_video());
    }

    // -------------------------------------------------------------------------
    // Effect Creation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_creation() {
        let effect = Effect::new(EffectType::GaussianBlur);

        assert!(!effect.id.is_empty());
        assert_eq!(effect.effect_type, EffectType::GaussianBlur);
        assert!(effect.enabled);
        assert_eq!(effect.order, 0);
    }

    #[test]
    fn test_effect_with_id() {
        let effect = Effect::with_id("effect_001", EffectType::Brightness);

        assert_eq!(effect.id, "effect_001");
        assert_eq!(effect.effect_type, EffectType::Brightness);
    }

    #[test]
    fn test_effect_default_params() {
        let blur = Effect::new(EffectType::GaussianBlur);
        assert_eq!(blur.get_float("radius"), Some(5.0));

        let brightness = Effect::new(EffectType::Brightness);
        assert_eq!(brightness.get_float("value"), Some(0.0));

        let contrast = Effect::new(EffectType::Contrast);
        assert_eq!(contrast.get_float("value"), Some(1.0));

        let vignette = Effect::new(EffectType::Vignette);
        assert_eq!(vignette.get_float("intensity"), Some(0.5));
        assert_eq!(vignette.get_float("radius"), Some(0.8));

        let fade = Effect::new(EffectType::Fade);
        assert_eq!(fade.get_float("duration"), Some(1.0));
        assert_eq!(fade.get_bool("fade_in"), Some(true));
    }

    #[test]
    fn test_color_wheels_default_params() {
        let color_wheels = Effect::new(EffectType::ColorWheels);

        // Lift (shadows) defaults
        assert_eq!(color_wheels.get_float("lift_r"), Some(0.0));
        assert_eq!(color_wheels.get_float("lift_g"), Some(0.0));
        assert_eq!(color_wheels.get_float("lift_b"), Some(0.0));

        // Gamma (midtones) defaults
        assert_eq!(color_wheels.get_float("gamma_r"), Some(0.0));
        assert_eq!(color_wheels.get_float("gamma_g"), Some(0.0));
        assert_eq!(color_wheels.get_float("gamma_b"), Some(0.0));

        // Gain (highlights) defaults
        assert_eq!(color_wheels.get_float("gain_r"), Some(0.0));
        assert_eq!(color_wheels.get_float("gain_g"), Some(0.0));
        assert_eq!(color_wheels.get_float("gain_b"), Some(0.0));
    }

    #[test]
    fn test_color_wheels_param_definitions() {
        let color_wheels = Effect::new(EffectType::ColorWheels);
        let defs = color_wheels.param_definitions();

        // Should have 9 parameters (3 for each of lift, gamma, gain)
        assert_eq!(defs.len(), 9, "ColorWheels should have 9 parameters");

        // Verify parameter names
        let param_names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(param_names.contains(&"lift_r"));
        assert!(param_names.contains(&"lift_g"));
        assert!(param_names.contains(&"lift_b"));
        assert!(param_names.contains(&"gamma_r"));
        assert!(param_names.contains(&"gamma_g"));
        assert!(param_names.contains(&"gamma_b"));
        assert!(param_names.contains(&"gain_r"));
        assert!(param_names.contains(&"gain_g"));
        assert!(param_names.contains(&"gain_b"));

        // Verify range constraints (-1.0 to 1.0)
        for def in &defs {
            assert_eq!(def.min, Some(-1.0), "Min should be -1.0 for {}", def.name);
            assert_eq!(def.max, Some(1.0), "Max should be 1.0 for {}", def.name);
        }
    }

    #[test]
    fn test_color_wheels_category() {
        assert_eq!(EffectType::ColorWheels.category(), EffectCategory::Color);
    }

    #[test]
    fn test_color_wheels_is_video() {
        assert!(EffectType::ColorWheels.is_video());
        assert!(!EffectType::ColorWheels.is_audio());
    }

    // -------------------------------------------------------------------------
    // Parameter Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_set_param() {
        let mut effect = Effect::new(EffectType::GaussianBlur);

        effect.set_param("radius", ParamValue::Float(10.0));
        assert_eq!(effect.get_float("radius"), Some(10.0));
    }

    #[test]
    fn test_param_value_conversions() {
        let float_val = ParamValue::Float(std::f64::consts::PI);
        assert_eq!(float_val.as_float(), Some(std::f64::consts::PI));
        assert_eq!(float_val.as_int(), Some(3));
        assert_eq!(float_val.as_bool(), None);

        let int_val = ParamValue::Int(42);
        assert_eq!(int_val.as_int(), Some(42));
        assert_eq!(int_val.as_float(), Some(42.0));

        let bool_val = ParamValue::Bool(true);
        assert_eq!(bool_val.as_bool(), Some(true));
        assert_eq!(bool_val.as_float(), None);

        let str_val = ParamValue::String("test".to_string());
        assert_eq!(str_val.as_str(), Some("test"));
        assert_eq!(str_val.as_float(), None);
    }

    // -------------------------------------------------------------------------
    // Validation Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_validate_success() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.set_param("radius", ParamValue::Float(5.0));

        assert!(effect.validate().is_ok());
    }

    #[test]
    fn test_effect_validate_below_min() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.set_param("radius", ParamValue::Float(-1.0));

        let result = effect.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("below minimum"));
    }

    #[test]
    fn test_effect_validate_above_max() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.set_param("radius", ParamValue::Float(150.0));

        let result = effect.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("above maximum"));
    }

    #[test]
    fn test_param_def_validation() {
        let def = ParamDef::float("radius", "Radius", 5.0, 0.0, 100.0);

        assert!(def.validate(&ParamValue::Float(50.0)).is_ok());
        assert!(def.validate(&ParamValue::Float(0.0)).is_ok());
        assert!(def.validate(&ParamValue::Float(100.0)).is_ok());

        assert!(def.validate(&ParamValue::Float(-1.0)).is_err());
        assert!(def.validate(&ParamValue::Float(101.0)).is_err());
    }

    // -------------------------------------------------------------------------
    // Keyframe Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_keyframe_creation() {
        let kf = Keyframe::new(0.0, ParamValue::Float(0.0));
        assert_eq!(kf.time_offset, 0.0);
        assert_eq!(kf.value.as_float(), Some(0.0));
        assert_eq!(kf.easing, Easing::Linear);
    }

    #[test]
    fn test_keyframe_with_easing() {
        let kf = Keyframe::with_easing(1.0, ParamValue::Float(1.0), Easing::EaseInOut);
        assert_eq!(kf.time_offset, 1.0);
        assert_eq!(kf.easing, Easing::EaseInOut);
    }

    #[test]
    fn test_effect_add_keyframe() {
        let mut effect = Effect::new(EffectType::GaussianBlur);

        effect
            .add_keyframe("radius", Keyframe::new(0.0, ParamValue::Float(0.0)))
            .unwrap();
        effect
            .add_keyframe("radius", Keyframe::new(2.0, ParamValue::Float(20.0)))
            .unwrap();
        effect
            .add_keyframe("radius", Keyframe::new(1.0, ParamValue::Float(10.0)))
            .unwrap();

        // Should be sorted by time
        let keyframes = &effect.keyframes["radius"];
        assert_eq!(keyframes.len(), 3);
        assert_eq!(keyframes[0].time_offset, 0.0);
        assert_eq!(keyframes[1].time_offset, 1.0);
        assert_eq!(keyframes[2].time_offset, 2.0);
    }

    #[test]
    fn test_effect_interpolate_keyframes() {
        let mut effect = Effect::new(EffectType::GaussianBlur);

        effect
            .add_keyframe("radius", Keyframe::new(0.0, ParamValue::Float(0.0)))
            .unwrap();
        effect
            .add_keyframe("radius", Keyframe::new(2.0, ParamValue::Float(20.0)))
            .unwrap();

        // At start
        assert_eq!(
            effect.get_value_at("radius", 0.0).unwrap().as_float(),
            Some(0.0)
        );

        // At middle
        assert_eq!(
            effect.get_value_at("radius", 1.0).unwrap().as_float(),
            Some(10.0)
        );

        // At end
        assert_eq!(
            effect.get_value_at("radius", 2.0).unwrap().as_float(),
            Some(20.0)
        );

        // Beyond end
        assert_eq!(
            effect.get_value_at("radius", 3.0).unwrap().as_float(),
            Some(20.0)
        );

        // Before start
        assert_eq!(
            effect.get_value_at("radius", -1.0).unwrap().as_float(),
            Some(0.0)
        );
    }

    #[test]
    fn test_effect_get_value_at_static() {
        let effect = Effect::new(EffectType::GaussianBlur);

        // No keyframes, should return static value
        assert_eq!(
            effect.get_value_at("radius", 0.0).unwrap().as_float(),
            Some(5.0)
        );
    }

    // -------------------------------------------------------------------------
    // Serialization Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_serialization() {
        let effect = Effect::with_id("effect_test", EffectType::GaussianBlur);

        let json = serde_json::to_string(&effect).unwrap();
        let parsed: Effect = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "effect_test");
        assert_eq!(parsed.effect_type, EffectType::GaussianBlur);
        assert!(parsed.enabled);
    }

    #[test]
    fn test_effect_with_keyframes_serialization() {
        let mut effect = Effect::new(EffectType::Brightness);
        effect
            .add_keyframe("value", Keyframe::new(0.0, ParamValue::Float(0.0)))
            .unwrap();
        effect
            .add_keyframe("value", Keyframe::new(1.0, ParamValue::Float(0.5)))
            .unwrap();

        let json = serde_json::to_string(&effect).unwrap();
        let parsed: Effect = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.keyframes["value"].len(), 2);
    }

    #[test]
    fn test_effect_type_serialization() {
        let effect_type = EffectType::GaussianBlur;
        let json = serde_json::to_string(&effect_type).unwrap();
        assert_eq!(json, "\"gaussian_blur\"");

        let parsed: EffectType = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, EffectType::GaussianBlur);
    }

    #[test]
    fn test_custom_effect_type_serialization() {
        let effect_type = EffectType::Custom("my_plugin_effect".to_string());
        let json = serde_json::to_string(&effect_type).unwrap();

        let parsed: EffectType = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, EffectType::Custom("my_plugin_effect".to_string()));
    }

    // -------------------------------------------------------------------------
    // Category Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_effect_category() {
        let blur = Effect::new(EffectType::GaussianBlur);
        assert_eq!(blur.category(), EffectCategory::BlurSharpen);

        let volume = Effect::new(EffectType::Volume);
        assert_eq!(volume.category(), EffectCategory::Audio);
    }

    #[test]
    fn test_effect_is_audio_video() {
        let blur = Effect::new(EffectType::GaussianBlur);
        assert!(blur.is_video());
        assert!(!blur.is_audio());

        let volume = Effect::new(EffectType::Volume);
        assert!(volume.is_audio());
        assert!(!volume.is_video());
    }
}
