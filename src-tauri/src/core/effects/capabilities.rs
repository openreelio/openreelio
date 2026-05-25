//! Effect runtime capability contract.
//!
//! This module is the single place that states whether an effect is safe to use
//! in preview, final export, and render-cache paths. Render/export validation
//! should consult this contract before any renderer falls back to a no-op.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::EffectType;

/// Runtime support for an effect in a specific renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectRuntimeSupport {
    /// The renderer is expected to produce the effect.
    Supported,
    /// The renderer does not currently produce the effect.
    Unsupported,
}

impl EffectRuntimeSupport {
    pub fn is_supported(self) -> bool {
        matches!(self, Self::Supported)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Capability contract for one effect type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectCapability {
    pub preview: EffectRuntimeSupport,
    pub export: EffectRuntimeSupport,
    pub render_cache: EffectRuntimeSupport,
    pub ffmpeg_filter: Option<&'static str>,
    pub export_reason: Option<&'static str>,
    pub preview_reason: Option<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EffectCapabilityDto {
    pub effect_type: String,
    pub preview: String,
    pub export: String,
    pub render_cache: String,
    pub ffmpeg_filter: Option<String>,
    pub export_reason: Option<String>,
    pub preview_reason: Option<String>,
}

impl EffectCapability {
    const fn export_supported(filter: &'static str) -> Self {
        Self {
            preview: EffectRuntimeSupport::Unsupported,
            export: EffectRuntimeSupport::Supported,
            render_cache: EffectRuntimeSupport::Supported,
            ffmpeg_filter: Some(filter),
            export_reason: None,
            preview_reason: Some(
                "This effect is not implemented by the interactive preview renderer yet.",
            ),
        }
    }

    const fn preview_and_export_supported(filter: &'static str) -> Self {
        Self {
            preview: EffectRuntimeSupport::Supported,
            export: EffectRuntimeSupport::Supported,
            render_cache: EffectRuntimeSupport::Supported,
            ffmpeg_filter: Some(filter),
            export_reason: None,
            preview_reason: None,
        }
    }

    const fn unsupported(export_reason: &'static str) -> Self {
        Self {
            preview: EffectRuntimeSupport::Unsupported,
            export: EffectRuntimeSupport::Unsupported,
            render_cache: EffectRuntimeSupport::Unsupported,
            ffmpeg_filter: None,
            export_reason: Some(export_reason),
            preview_reason: Some(
                "This effect requires a dedicated renderer that is not available yet.",
            ),
        }
    }
}

/// Returns the runtime capability for an effect type.
pub fn effect_capability(effect_type: &EffectType) -> EffectCapability {
    match effect_type {
        // Color effects
        EffectType::Brightness => EffectCapability::export_supported("eq"),
        EffectType::Contrast => EffectCapability::export_supported("eq"),
        EffectType::Saturation => EffectCapability::export_supported("eq"),
        EffectType::Hue => EffectCapability::export_supported("hue"),
        EffectType::ColorBalance => EffectCapability::export_supported("colorbalance"),
        EffectType::ColorWheels => EffectCapability::export_supported("colorbalance"),
        EffectType::Gamma => EffectCapability::export_supported("eq"),
        EffectType::Levels => EffectCapability::export_supported("levels"),
        EffectType::Curves => EffectCapability::export_supported("curves"),
        EffectType::TemperatureTint => EffectCapability::export_supported("colorbalance"),
        EffectType::Lut => EffectCapability::export_supported("lut3d"),

        // Transform effects
        EffectType::Crop => EffectCapability::export_supported("crop"),
        EffectType::Flip => EffectCapability::export_supported("vflip"),
        EffectType::Mirror => EffectCapability::export_supported("hflip"),
        EffectType::Rotate => EffectCapability::export_supported("rotate"),
        EffectType::Stabilize => EffectCapability::export_supported("vidstabtransform"),

        // Blur/sharpen
        EffectType::GaussianBlur => EffectCapability::export_supported("gblur"),
        EffectType::BoxBlur => EffectCapability::export_supported("boxblur"),
        EffectType::MotionBlur => EffectCapability::export_supported("avgblur"),
        EffectType::RadialBlur => EffectCapability::export_supported("avgblur"),
        EffectType::Sharpen => EffectCapability::export_supported("unsharp"),
        EffectType::UnsharpMask => EffectCapability::export_supported("unsharp"),

        // Stylize
        EffectType::Vignette => EffectCapability::export_supported("vignette"),
        EffectType::Glow => EffectCapability::export_supported("gblur"),
        EffectType::FilmGrain => EffectCapability::export_supported("noise"),
        EffectType::ChromaticAberration => EffectCapability::export_supported("rgbashift"),
        EffectType::Noise => EffectCapability::export_supported("noise"),
        EffectType::Pixelate => EffectCapability::export_supported("pixelize"),
        EffectType::Posterize => EffectCapability::export_supported("posterize"),

        // Transitions
        EffectType::CrossDissolve => EffectCapability::export_supported("xfade"),
        EffectType::Fade => EffectCapability::export_supported("fade"),
        EffectType::Wipe => EffectCapability::export_supported("xfade"),
        EffectType::Slide => EffectCapability::export_supported("xfade"),
        EffectType::Zoom => EffectCapability::export_supported("zoompan"),

        // Audio
        EffectType::Volume => EffectCapability::export_supported("volume"),
        EffectType::Gain => EffectCapability::export_supported("volume"),
        EffectType::EqBand => EffectCapability::export_supported("equalizer"),
        EffectType::Compressor => EffectCapability::export_supported("acompressor"),
        EffectType::Limiter => EffectCapability::export_supported("alimiter"),
        EffectType::NoiseReduction => EffectCapability::export_supported("anlmdn"),
        EffectType::Reverb => EffectCapability::export_supported("aecho"),
        EffectType::Delay => EffectCapability::export_supported("adelay"),
        EffectType::LoudnessNormalize => EffectCapability::export_supported("loudnorm"),

        // Text
        EffectType::TextOverlay => EffectCapability::preview_and_export_supported("drawtext"),
        EffectType::Subtitle => EffectCapability::export_supported("subtitles"),

        // Keying/compositing
        EffectType::ChromaKey => EffectCapability::export_supported("chromakey"),
        EffectType::LumaKey => EffectCapability::export_supported("lumakey"),
        EffectType::BlendMode => EffectCapability::export_supported("blend"),
        EffectType::Opacity => EffectCapability::export_supported("colorchannelmixer"),

        // Advanced color
        EffectType::HSLQualifier => EffectCapability::export_supported("hue"),

        // AI
        EffectType::AutoReframe => EffectCapability::export_supported("crop"),
        EffectType::BackgroundRemoval => EffectCapability::unsupported(
            "Background removal requires generated alpha/matte assets before final export.",
        ),
        EffectType::FaceBlur => EffectCapability::unsupported(
            "Face blur requires detection/tracking data to be baked before final export.",
        ),
        EffectType::ObjectTracking => EffectCapability::unsupported(
            "Object tracking is analysis data, not a final render filter.",
        ),

        // Custom
        EffectType::Custom(_) => EffectCapability::unsupported(
            "Custom effects need an explicit renderer adapter before final export.",
        ),
    }
}

/// Returns true when the final renderer is expected to produce this effect.
pub fn effect_type_supports_export(effect_type: &EffectType) -> bool {
    effect_capability(effect_type).export.is_supported()
}

pub fn effect_capability_dto(effect_type: &EffectType) -> EffectCapabilityDto {
    let capability = effect_capability(effect_type);

    EffectCapabilityDto {
        effect_type: effect_type_key(effect_type),
        preview: capability.preview.as_str().to_string(),
        export: capability.export.as_str().to_string(),
        render_cache: capability.render_cache.as_str().to_string(),
        ffmpeg_filter: capability.ffmpeg_filter.map(str::to_string),
        export_reason: capability.export_reason.map(str::to_string),
        preview_reason: capability.preview_reason.map(str::to_string),
    }
}

pub fn all_effect_capabilities() -> Vec<EffectCapabilityDto> {
    all_known_effect_types()
        .iter()
        .map(effect_capability_dto)
        .collect()
}

fn all_known_effect_types() -> Vec<EffectType> {
    vec![
        EffectType::Brightness,
        EffectType::Contrast,
        EffectType::Saturation,
        EffectType::Hue,
        EffectType::ColorBalance,
        EffectType::ColorWheels,
        EffectType::Gamma,
        EffectType::Levels,
        EffectType::Curves,
        EffectType::TemperatureTint,
        EffectType::Lut,
        EffectType::Crop,
        EffectType::Flip,
        EffectType::Mirror,
        EffectType::Rotate,
        EffectType::Stabilize,
        EffectType::GaussianBlur,
        EffectType::BoxBlur,
        EffectType::MotionBlur,
        EffectType::RadialBlur,
        EffectType::Sharpen,
        EffectType::UnsharpMask,
        EffectType::Vignette,
        EffectType::Glow,
        EffectType::FilmGrain,
        EffectType::ChromaticAberration,
        EffectType::Noise,
        EffectType::Pixelate,
        EffectType::Posterize,
        EffectType::CrossDissolve,
        EffectType::Fade,
        EffectType::Wipe,
        EffectType::Slide,
        EffectType::Zoom,
        EffectType::Volume,
        EffectType::Gain,
        EffectType::EqBand,
        EffectType::Compressor,
        EffectType::Limiter,
        EffectType::NoiseReduction,
        EffectType::Reverb,
        EffectType::Delay,
        EffectType::LoudnessNormalize,
        EffectType::TextOverlay,
        EffectType::Subtitle,
        EffectType::ChromaKey,
        EffectType::LumaKey,
        EffectType::BlendMode,
        EffectType::Opacity,
        EffectType::HSLQualifier,
        EffectType::AutoReframe,
        EffectType::BackgroundRemoval,
        EffectType::FaceBlur,
        EffectType::ObjectTracking,
    ]
}

fn effect_type_key(effect_type: &EffectType) -> String {
    match effect_type {
        EffectType::Brightness => "brightness",
        EffectType::Contrast => "contrast",
        EffectType::Saturation => "saturation",
        EffectType::Hue => "hue",
        EffectType::ColorBalance => "color_balance",
        EffectType::ColorWheels => "color_wheels",
        EffectType::Gamma => "gamma",
        EffectType::Levels => "levels",
        EffectType::Curves => "curves",
        EffectType::TemperatureTint => "temperature_tint",
        EffectType::Lut => "lut",
        EffectType::Crop => "crop",
        EffectType::Flip => "flip",
        EffectType::Mirror => "mirror",
        EffectType::Rotate => "rotate",
        EffectType::GaussianBlur => "gaussian_blur",
        EffectType::BoxBlur => "box_blur",
        EffectType::MotionBlur => "motion_blur",
        EffectType::RadialBlur => "radial_blur",
        EffectType::Sharpen => "sharpen",
        EffectType::UnsharpMask => "unsharp_mask",
        EffectType::Vignette => "vignette",
        EffectType::Glow => "glow",
        EffectType::FilmGrain => "film_grain",
        EffectType::ChromaticAberration => "chromatic_aberration",
        EffectType::Noise => "noise",
        EffectType::Pixelate => "pixelate",
        EffectType::Posterize => "posterize",
        EffectType::CrossDissolve => "cross_dissolve",
        EffectType::Fade => "fade",
        EffectType::Wipe => "wipe",
        EffectType::Slide => "slide",
        EffectType::Zoom => "zoom",
        EffectType::Volume => "volume",
        EffectType::Gain => "gain",
        EffectType::EqBand => "eq_band",
        EffectType::Compressor => "compressor",
        EffectType::Limiter => "limiter",
        EffectType::NoiseReduction => "noise_reduction",
        EffectType::Reverb => "reverb",
        EffectType::Delay => "delay",
        EffectType::TextOverlay => "text_overlay",
        EffectType::Subtitle => "subtitle",
        EffectType::ChromaKey => "chroma_key",
        EffectType::LumaKey => "luma_key",
        EffectType::BlendMode => "blend_mode",
        EffectType::Opacity => "opacity",
        EffectType::HSLQualifier => "hsl_qualifier",
        EffectType::LoudnessNormalize => "loudness_normalize",
        EffectType::Stabilize => "stabilize",
        EffectType::BackgroundRemoval => "background_removal",
        EffectType::AutoReframe => "auto_reframe",
        EffectType::FaceBlur => "face_blur",
        EffectType::ObjectTracking => "object_tracking",
        EffectType::Custom(name) => return format!("custom:{name}"),
    }
    .to_string()
}

/// Returns a stable, user-readable label for validation messages.
pub fn effect_type_label(effect_type: &EffectType) -> String {
    match effect_type {
        EffectType::Brightness => "Brightness",
        EffectType::Contrast => "Contrast",
        EffectType::Saturation => "Saturation",
        EffectType::Hue => "Hue",
        EffectType::ColorBalance => "Color Balance",
        EffectType::ColorWheels => "Color Wheels",
        EffectType::Gamma => "Gamma",
        EffectType::Levels => "Levels",
        EffectType::Curves => "Curves",
        EffectType::TemperatureTint => "Temperature / Tint",
        EffectType::Lut => "LUT",
        EffectType::Crop => "Crop",
        EffectType::Flip => "Flip",
        EffectType::Mirror => "Mirror",
        EffectType::Rotate => "Rotate",
        EffectType::GaussianBlur => "Gaussian Blur",
        EffectType::BoxBlur => "Box Blur",
        EffectType::MotionBlur => "Motion Blur",
        EffectType::RadialBlur => "Radial Blur",
        EffectType::Sharpen => "Sharpen",
        EffectType::UnsharpMask => "Unsharp Mask",
        EffectType::Vignette => "Vignette",
        EffectType::Glow => "Glow",
        EffectType::FilmGrain => "Film Grain",
        EffectType::ChromaticAberration => "Chromatic Aberration",
        EffectType::Noise => "Noise",
        EffectType::Pixelate => "Pixelate",
        EffectType::Posterize => "Posterize",
        EffectType::CrossDissolve => "Cross Dissolve",
        EffectType::Fade => "Fade",
        EffectType::Wipe => "Wipe",
        EffectType::Slide => "Slide",
        EffectType::Zoom => "Zoom",
        EffectType::Volume => "Volume",
        EffectType::Gain => "Gain",
        EffectType::EqBand => "EQ Band",
        EffectType::Compressor => "Compressor",
        EffectType::Limiter => "Limiter",
        EffectType::NoiseReduction => "Noise Reduction",
        EffectType::Reverb => "Reverb",
        EffectType::Delay => "Delay",
        EffectType::TextOverlay => "Text Overlay",
        EffectType::Subtitle => "Subtitle",
        EffectType::ChromaKey => "Chroma Key",
        EffectType::LumaKey => "Luma Key",
        EffectType::BlendMode => "Blend Mode",
        EffectType::Opacity => "Opacity",
        EffectType::HSLQualifier => "HSL Qualifier",
        EffectType::LoudnessNormalize => "Loudness Normalize",
        EffectType::Stabilize => "Stabilize",
        EffectType::BackgroundRemoval => "Background Removal",
        EffectType::AutoReframe => "Auto Reframe",
        EffectType::FaceBlur => "Face Blur",
        EffectType::ObjectTracking => "Object Tracking",
        EffectType::Custom(name) => return format!("Custom ({name})"),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_marks_ai_setup_effects_as_not_exportable() {
        for effect_type in [
            EffectType::BackgroundRemoval,
            EffectType::FaceBlur,
            EffectType::ObjectTracking,
        ] {
            let capability = effect_capability(&effect_type);
            assert!(!capability.export.is_supported());
            assert!(!capability.render_cache.is_supported());
            assert!(capability.export_reason.is_some());
        }
    }

    #[test]
    fn capability_keeps_text_overlay_as_preview_and_export_supported() {
        let capability = effect_capability(&EffectType::TextOverlay);

        assert!(capability.preview.is_supported());
        assert!(capability.export.is_supported());
        assert_eq!(capability.ffmpeg_filter, Some("drawtext"));
    }

    #[test]
    fn all_effect_capabilities_exports_frontend_keys() {
        let capabilities = all_effect_capabilities();

        assert!(capabilities.iter().any(|capability| {
            capability.effect_type == "text_overlay"
                && capability.preview == "supported"
                && capability.export == "supported"
        }));
        assert!(capabilities.iter().any(|capability| {
            capability.effect_type == "background_removal" && capability.export == "unsupported"
        }));
    }
}
