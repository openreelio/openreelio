//! FFmpeg Filter Builder
//!
//! Converts Effect instances into FFmpeg filter strings for video/audio processing.
//!
//! This module provides:
//! - Effect to FFmpeg filter conversion
//! - Filter graph composition for multiple effects
//! - Support for keyframe animation in filters
//!
//! # Example
//!
//! ```rust,ignore
//! use crate::core::effects::{Effect, EffectType, FilterBuilder};
//!
//! let effect = Effect::new(EffectType::GaussianBlur);
//! let filter = effect.to_filter_string("0:v", "out");
//! // Returns: "[0:v]gblur=sigma=5.0[out]"
//! ```

use super::{
    curve_points_to_ffmpeg, default_flat_curve, is_flat_identity_curve, is_identity_curve,
    parse_curve_points, parse_curve_points_with_fallback, sample_curve_at, CurvePoint, Effect,
    EffectType,
};

// =============================================================================
// Advanced Curve Helpers (Hue vs Hue, Hue vs Sat)
// =============================================================================

/// Map saturation delta to selectivecolor CMYK adjustments.
///
/// Adjusts the complementary color component to modify saturation:
/// - `delta > 0` → saturate (remove complement)
/// - `delta < 0` → desaturate (add complement)
fn sat_adjust_cmyk(range: &str, delta: f64) -> (f64, f64, f64) {
    // Invert: positive delta = more saturated = negative complement values
    let v = -delta;
    match range {
        "reds" => (v, 0.0, 0.0),               // Complement: cyan
        "yellows" => (v * 0.5, v * 0.5, 0.0),  // Complement: blue (C+M)
        "greens" => (0.0, v, 0.0),             // Complement: magenta
        "cyans" => (0.0, v * 0.5, v * 0.5),    // Complement: red (M+Y)
        "blues" => (0.0, 0.0, v),              // Complement: yellow
        "magentas" => (v * 0.5, 0.0, v * 0.5), // Complement: green (C+Y)
        _ => (0.0, 0.0, 0.0),
    }
}

/// Map hue shift delta to selectivecolor CMYK adjustments.
///
/// Shifts colors toward adjacent hues on the color wheel:
/// - `delta > 0` → clockwise (reds→yellows, yellows→greens, etc.)
/// - `delta < 0` → counter-clockwise (reds→magentas, yellows→reds, etc.)
///
/// Color wheel order: R → Y → G → C → B → M → R
fn hue_shift_cmyk(range: &str, delta: f64) -> (f64, f64, f64) {
    if delta >= 0.0 {
        // Clockwise: shift toward next hue neighbor
        match range {
            "reds" => (0.0, -delta, 0.0),    // R→Y: -M = +G
            "yellows" => (delta, 0.0, 0.0),  // Y→G: +C = -R
            "greens" => (0.0, 0.0, -delta),  // G→C: -Y = +B
            "cyans" => (0.0, delta, 0.0),    // C→B: +M = -G
            "blues" => (-delta, 0.0, 0.0),   // B→M: -C = +R
            "magentas" => (0.0, 0.0, delta), // M→R: +Y = -B
            _ => (0.0, 0.0, 0.0),
        }
    } else {
        // Counter-clockwise: shift toward previous hue neighbor
        let d = -delta; // positive magnitude
        match range {
            "reds" => (0.0, 0.0, -d),    // R→M: -Y = +B
            "yellows" => (0.0, d, 0.0),  // Y→R: +M = -G
            "greens" => (-d, 0.0, 0.0),  // G→Y: -C = +R
            "cyans" => (0.0, 0.0, d),    // C→G: +Y = -B
            "blues" => (0.0, -d, 0.0),   // B→C: -M = +G
            "magentas" => (d, 0.0, 0.0), // M→B: +C = -R
            _ => (0.0, 0.0, 0.0),
        }
    }
}

fn curve_points_sorted(points: &[CurvePoint]) -> Vec<&CurvePoint> {
    let mut sorted: Vec<&CurvePoint> = points.iter().collect();
    sorted.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    sorted
}

fn luma_sat_factor_expr(points: &[CurvePoint], luma_expr: &str) -> String {
    let sorted = curve_points_sorted(points);
    if sorted.is_empty() {
        return "1.000000".to_string();
    }

    let first = sorted[0];
    let last = sorted[sorted.len() - 1];
    let first_factor = first.y * 2.0;
    let last_factor = last.y * 2.0;

    let mut expr = format!("{last_factor:.6}");
    for pair in sorted.windows(2).rev() {
        let start = pair[0];
        let end = pair[1];
        let start_factor = start.y * 2.0;
        let dx = (end.x - start.x).max(1e-6);
        let slope = ((end.y - start.y) * 2.0) / dx;
        let segment = format!(
            "{start_factor:.6}+(({luma_expr})-{:.6})*{slope:.6}",
            start.x
        );
        expr = format!("if(lte({luma_expr}\\,{:.6})\\,{segment}\\,{expr})", end.x);
    }

    format!(
        "if(lte({luma_expr}\\,{:.6})\\,{first_factor:.6}\\,{expr})",
        first.x
    )
}

// =============================================================================
// FFmpeg Utility Functions
// =============================================================================

fn escape_ffmpeg_filter_value(raw: &str) -> String {
    // FFmpeg filtergraphs treat `:` and `,` as separators and `\` as an escape character.
    // Windows paths also contain `\` and `:` (drive letter), so we must escape them to
    // keep filter strings replayable and safe against filtergraph injection.
    raw.replace('\\', r"\\")
        .replace(':', r"\:")
        .replace(',', r"\,")
        .replace('\'', r"\'")
}

fn escape_drawtext_value(raw: &str) -> String {
    // drawtext expands `%{...}` expressions; treat user-provided text as literal.
    let normalized = raw
        // drawtext should not receive raw newlines/control chars via filter strings.
        // Normalize them to spaces to avoid filtergraph parsing ambiguity.
        .replace(['\r', '\n', '\t'], " ");

    escape_ffmpeg_filter_value(&normalized).replace('%', r"\%")
}

/// Converts a hex color string to FFmpeg color format.
///
/// FFmpeg accepts colors in various formats:
/// - Named colors: white, black, red, etc.
/// - Hex RGB: 0xRRGGBB or #RRGGBB
/// - Hex RGBA with alpha: color@alpha (e.g., white@0.5)
///
/// # Arguments
///
/// * `hex` - Hex color string like "#FFFFFF" or "#FF0000"
/// * `opacity` - Opacity value from 0.0 to 1.0
///
/// # Returns
///
/// FFmpeg-compatible color string with alpha (e.g., "0xFFFFFF@0.8")
fn hex_to_ffmpeg_color(hex: &str, opacity: f64) -> String {
    let hex_clean = hex.trim().trim_start_matches('#');

    // Parse RGB values
    let (r, g, b) = if hex_clean.len() == 3 {
        // Short hex: #RGB -> #RRGGBB
        let r = u8::from_str_radix(&hex_clean[0..1], 16).unwrap_or(255) * 17;
        let g = u8::from_str_radix(&hex_clean[1..2], 16).unwrap_or(255) * 17;
        let b = u8::from_str_radix(&hex_clean[2..3], 16).unwrap_or(255) * 17;
        (r, g, b)
    } else if hex_clean.len() >= 6 {
        let r = u8::from_str_radix(&hex_clean[0..2], 16).unwrap_or(255);
        let g = u8::from_str_radix(&hex_clean[2..4], 16).unwrap_or(255);
        let b = u8::from_str_radix(&hex_clean[4..6], 16).unwrap_or(255);
        (r, g, b)
    } else {
        // Invalid hex, default to white
        (255, 255, 255)
    };

    // FFmpeg color with alpha: 0xRRGGBB@alpha
    let opacity_clamped = opacity.clamp(0.0, 1.0);
    if (opacity_clamped - 1.0).abs() < 0.001 {
        // Full opacity, no alpha needed
        format!("0x{:02X}{:02X}{:02X}", r, g, b)
    } else {
        format!("0x{:02X}{:02X}{:02X}@{:.2}", r, g, b, opacity_clamped)
    }
}

// =============================================================================
// Traits
// =============================================================================

/// Trait for converting effects to FFmpeg filter strings
pub trait IntoFFmpegFilter {
    /// Converts the effect into an FFmpeg filter string
    ///
    /// # Arguments
    ///
    /// * `input_label` - The input stream label (e.g., "0:v", "in")
    /// * `output_label` - The output stream label (e.g., "out", "blurred")
    ///
    /// # Returns
    ///
    /// FFmpeg filter string in the format `[input]filter=params[output]`
    fn to_filter_string(&self, input_label: &str, output_label: &str) -> String;

    /// Returns the FFmpeg filter name for this effect
    fn filter_name(&self) -> &'static str;

    /// Returns true if this effect can be converted to an FFmpeg filter
    fn is_ffmpeg_compatible(&self) -> bool;

    /// Returns the filter body without input/output labels.
    /// Useful for xfade transitions which take two inputs.
    ///
    /// # Returns
    ///
    /// FFmpeg filter string like "xfade=transition=dissolve:duration=1.0:offset=0.0"
    fn to_filter_body(&self) -> String;
}

// =============================================================================
// Filter Builder Implementation
// =============================================================================

impl IntoFFmpegFilter for Effect {
    fn to_filter_string(&self, input_label: &str, output_label: &str) -> String {
        if !self.enabled || !self.is_ffmpeg_compatible() {
            // Pass-through: just copy input to output
            return format!("[{input_label}]null[{output_label}]");
        }

        let filter_body = self.build_filter_params();

        if filter_body.is_empty() {
            format!("[{input_label}]null[{output_label}]")
        } else {
            format!("[{input_label}]{filter_body}[{output_label}]")
        }
    }

    fn filter_name(&self) -> &'static str {
        match &self.effect_type {
            // Color effects
            EffectType::Brightness => "eq",
            EffectType::Contrast => "eq",
            EffectType::Saturation => "eq",
            EffectType::Hue => "hue",
            EffectType::ColorBalance => "colorbalance",
            EffectType::ColorWheels => "colorbalance",
            EffectType::Gamma => "eq",
            EffectType::Levels => "levels",
            EffectType::Curves => "curves",
            EffectType::TemperatureTint => "colorbalance",
            EffectType::Lut => "lut3d",

            // Transform effects
            EffectType::Crop => "crop",
            EffectType::Flip => "vflip",
            EffectType::Mirror => "hflip",
            EffectType::Rotate => "rotate",

            // Blur/Sharpen
            EffectType::GaussianBlur => "gblur",
            EffectType::BoxBlur => "boxblur",
            EffectType::MotionBlur => "avgblur",
            EffectType::RadialBlur => "avgblur", // FFmpeg doesn't have native radial blur
            EffectType::Sharpen => "unsharp",
            EffectType::UnsharpMask => "unsharp",

            // Stylize
            EffectType::Vignette => "vignette",
            EffectType::Glow => "gblur", // Implemented via blur + blend
            EffectType::FilmGrain => "noise",
            EffectType::ChromaticAberration => "rgbashift",
            EffectType::Noise => "noise",
            EffectType::Pixelate => "pixelize",
            EffectType::Posterize => "posterize",

            // Transitions
            EffectType::CrossDissolve => "xfade",
            EffectType::Fade => "fade",
            EffectType::Wipe => "xfade",
            EffectType::Slide => "xfade",
            EffectType::Zoom => "zoompan",

            // Audio effects
            EffectType::Volume => "volume",
            EffectType::Gain => "volume",
            EffectType::EqBand => "equalizer",
            EffectType::Compressor => "acompressor",
            EffectType::Limiter => "alimiter",
            EffectType::NoiseReduction => "anlmdn",
            EffectType::Reverb => "aecho",
            EffectType::Delay => "adelay",

            // Text (requires drawtext filter)
            EffectType::TextOverlay => "drawtext",
            EffectType::Subtitle => "subtitles",

            // Keying effects
            EffectType::ChromaKey => "chromakey",
            EffectType::LumaKey => "lumakey",

            // Compositing effects
            EffectType::BlendMode => "blend",
            EffectType::Opacity => "colorchannelmixer",

            // Advanced color grading
            EffectType::HSLQualifier => "hue",

            // Audio metering
            EffectType::LoudnessNormalize => "loudnorm",

            // AI effects - not directly supported in FFmpeg
            EffectType::BackgroundRemoval
            | EffectType::AutoReframe
            | EffectType::FaceBlur
            | EffectType::ObjectTracking => "null",

            // Custom effects
            EffectType::Custom(_) => "null",
        }
    }

    fn is_ffmpeg_compatible(&self) -> bool {
        !matches!(
            self.effect_type,
            EffectType::BackgroundRemoval
                | EffectType::AutoReframe
                | EffectType::FaceBlur
                | EffectType::ObjectTracking
                | EffectType::Custom(_)
        )
    }

    fn to_filter_body(&self) -> String {
        if !self.enabled || !self.is_ffmpeg_compatible() {
            return "null".to_string();
        }
        let body = self.build_filter_params();
        if body.is_empty() {
            "null".to_string()
        } else {
            body
        }
    }
}

// =============================================================================
// Filter Parameter Builders
// =============================================================================

impl Effect {
    /// Builds the FFmpeg filter parameters string
    fn build_filter_params(&self) -> String {
        match &self.effect_type {
            // Color effects
            EffectType::Brightness => self.build_brightness_filter(),
            EffectType::Contrast => self.build_contrast_filter(),
            EffectType::Saturation => self.build_saturation_filter(),
            EffectType::Hue => self.build_hue_filter(),
            EffectType::ColorWheels => self.build_color_wheels_filter(),
            EffectType::TemperatureTint => self.build_temperature_tint_filter(),
            EffectType::Curves => self.build_curves_filter(),
            EffectType::Gamma => self.build_gamma_filter(),

            // Transform effects
            EffectType::Flip => "vflip".to_string(),
            EffectType::Mirror => "hflip".to_string(),
            EffectType::Rotate => self.build_rotate_filter(),
            EffectType::Crop => self.build_crop_filter(),

            // Blur/Sharpen
            EffectType::GaussianBlur => self.build_gaussian_blur_filter(),
            EffectType::BoxBlur => self.build_box_blur_filter(),
            EffectType::Sharpen => self.build_sharpen_filter(),
            EffectType::UnsharpMask => self.build_unsharp_filter(),

            // Stylize
            EffectType::Vignette => self.build_vignette_filter(),
            EffectType::FilmGrain => self.build_film_grain_filter(),
            EffectType::Noise => self.build_noise_filter(),
            EffectType::Pixelate => self.build_pixelate_filter(),
            EffectType::Posterize => self.build_posterize_filter(),

            // Transitions
            EffectType::Fade => self.build_fade_filter(),
            EffectType::CrossDissolve => self.build_cross_dissolve_filter(),
            EffectType::Wipe => self.build_wipe_filter(),
            EffectType::Slide => self.build_slide_filter(),
            EffectType::Zoom => self.build_zoom_filter(),

            // Audio effects
            EffectType::Volume | EffectType::Gain => self.build_volume_filter(),
            EffectType::EqBand => self.build_equalizer_filter(),
            EffectType::Compressor => self.build_compressor_filter(),
            EffectType::Limiter => self.build_limiter_filter(),
            EffectType::Reverb => self.build_reverb_filter(),
            EffectType::Delay => self.build_delay_filter(),
            EffectType::NoiseReduction => self.build_noise_reduction_filter(),

            // Keying
            EffectType::ChromaKey => self.build_chromakey_filter(),
            EffectType::LumaKey => self.build_lumakey_filter(),

            // Compositing
            EffectType::Opacity => self.build_opacity_filter(),
            // Note: BlendMode requires two inputs and is handled specially in export pipeline
            EffectType::BlendMode => "null".to_string(),

            // Text
            EffectType::TextOverlay => self.build_drawtext_filter(),
            EffectType::Subtitle => self.build_subtitle_filter(),

            // Color grading
            EffectType::Lut => self.build_lut_filter(),

            // Advanced color grading
            EffectType::HSLQualifier => self.build_hsl_qualifier_filter(),

            // Audio metering
            EffectType::LoudnessNormalize => self.build_loudness_normalize_filter(),

            // Default: pass-through
            _ => "null".to_string(),
        }
    }

    // -------------------------------------------------------------------------
    // Color Effect Builders
    // -------------------------------------------------------------------------

    fn build_brightness_filter(&self) -> String {
        let value = self.get_float("value").unwrap_or(0.0);
        format!("eq=brightness={:.4}", value)
    }

    fn build_contrast_filter(&self) -> String {
        let value = self.get_float("value").unwrap_or(1.0);
        format!("eq=contrast={:.4}", value)
    }

    fn build_saturation_filter(&self) -> String {
        let value = self.get_float("value").unwrap_or(1.0);
        format!("eq=saturation={:.4}", value)
    }

    fn build_hue_filter(&self) -> String {
        let value = self.get_float("value").unwrap_or(0.0);
        // Hue rotation in radians (or degrees with 'd')
        format!("hue=h={:.4}", value)
    }

    fn build_gamma_filter(&self) -> String {
        let value = self.get_float("value").unwrap_or(1.0);
        format!("eq=gamma={:.4}", value)
    }

    /// Builds FFmpeg colorbalance filter for 3-way color correction.
    ///
    /// Color Wheels (Lift/Gamma/Gain) maps to FFmpeg's colorbalance filter:
    /// - Lift (shadows): rs, gs, bs parameters
    /// - Gamma (midtones): rm, gm, bm parameters
    /// - Gain (highlights): rh, gh, bh parameters
    ///
    /// Each parameter ranges from -1.0 to 1.0 where:
    /// - Negative values reduce the color channel
    /// - Positive values increase the color channel
    /// - 0.0 is neutral (no change)
    fn build_color_wheels_filter(&self) -> String {
        // Lift (shadows)
        let lift_r = self.get_float("lift_r").unwrap_or(0.0).clamp(-1.0, 1.0);
        let lift_g = self.get_float("lift_g").unwrap_or(0.0).clamp(-1.0, 1.0);
        let lift_b = self.get_float("lift_b").unwrap_or(0.0).clamp(-1.0, 1.0);

        // Gamma (midtones)
        let gamma_r = self.get_float("gamma_r").unwrap_or(0.0).clamp(-1.0, 1.0);
        let gamma_g = self.get_float("gamma_g").unwrap_or(0.0).clamp(-1.0, 1.0);
        let gamma_b = self.get_float("gamma_b").unwrap_or(0.0).clamp(-1.0, 1.0);

        // Gain (highlights)
        let gain_r = self.get_float("gain_r").unwrap_or(0.0).clamp(-1.0, 1.0);
        let gain_g = self.get_float("gain_g").unwrap_or(0.0).clamp(-1.0, 1.0);
        let gain_b = self.get_float("gain_b").unwrap_or(0.0).clamp(-1.0, 1.0);

        // Check if all values are at default (0.0) - return null for no-op
        let is_default = [
            lift_r, lift_g, lift_b, gamma_r, gamma_g, gamma_b, gain_r, gain_g, gain_b,
        ]
        .iter()
        .all(|v| v.abs() < 0.001);

        if is_default {
            return "null".to_string();
        }

        // Build colorbalance filter
        // rs=shadows_red, gs=shadows_green, bs=shadows_blue
        // rm=midtones_red, gm=midtones_green, bm=midtones_blue
        // rh=highlights_red, gh=highlights_green, bh=highlights_blue
        format!(
            "colorbalance=rs={:.4}:gs={:.4}:bs={:.4}:rm={:.4}:gm={:.4}:bm={:.4}:rh={:.4}:gh={:.4}:bh={:.4}",
            lift_r, lift_g, lift_b,
            gamma_r, gamma_g, gamma_b,
            gain_r, gain_g, gain_b
        )
    }

    /// Builds FFmpeg `colorbalance` filter for temperature/tint white balance.
    ///
    /// Temperature shifts the blue↔orange axis (cool↔warm):
    /// - Positive = warm (boost red, reduce blue)
    /// - Negative = cool (boost blue, reduce red)
    ///
    /// Tint shifts the green↔magenta axis:
    /// - Positive = magenta (reduce green)
    /// - Negative = green (boost green)
    ///
    /// Values are normalized from [-100, +100] to [-1.0, +1.0] and applied
    /// across shadows, midtones, and highlights with weighted distribution.
    fn build_temperature_tint_filter(&self) -> String {
        let temperature = self
            .get_float("temperature")
            .unwrap_or(0.0)
            .clamp(-100.0, 100.0);
        let tint = self.get_float("tint").unwrap_or(0.0).clamp(-100.0, 100.0);

        // No-op check: both at neutral
        if temperature.abs() < 0.01 && tint.abs() < 0.01 {
            return "null".to_string();
        }

        // Normalize to [-1.0, +1.0]
        let temp_norm = temperature / 100.0;
        let tint_norm = tint / 100.0;

        // Temperature: red and blue channels inversely proportional
        // Distribute across shadows (0.3), midtones (0.5), highlights (0.2)
        let rs = temp_norm * 0.3;
        let rm = temp_norm * 0.5;
        let rh = temp_norm * 0.2;
        let bs = -temp_norm * 0.3;
        let bm = -temp_norm * 0.5;
        let bh = -temp_norm * 0.2;

        // Tint: green channel (positive tint = magenta = reduce green)
        let gs = -tint_norm * 0.3;
        let gm = -tint_norm * 0.5;
        let gh = -tint_norm * 0.2;

        format!(
            "colorbalance=rs={:.4}:gs={:.4}:bs={:.4}:rm={:.4}:gm={:.4}:bm={:.4}:rh={:.4}:gh={:.4}:bh={:.4}",
            rs, gs, bs, rm, gm, bm, rh, gh, bh
        )
    }

    /// Build the complete curves filter chain: RGB curves + advanced curves.
    ///
    /// Returns chained filters separated by `,` (FFmpeg linear chain):
    /// - RGB curves via `curves` filter
    /// - Hue vs Sat via `selectivecolor` filter
    /// - Hue vs Hue via `selectivecolor` filter
    /// - Luma vs Sat via `geq` chroma scaling
    ///
    /// Returns `"null"` if all curves are identity (no-op).
    fn build_curves_filter(&self) -> String {
        let mut filters: Vec<String> = Vec::new();

        let rgb = self.build_rgb_curves_segment();
        if !rgb.is_empty() {
            filters.push(rgb);
        }

        let hvs = self.build_hue_vs_sat_segment();
        if !hvs.is_empty() {
            filters.push(hvs);
        }

        let hvh = self.build_hue_vs_hue_segment();
        if !hvh.is_empty() {
            filters.push(hvh);
        }

        let lvs = self.build_luma_vs_sat_segment();
        if !lvs.is_empty() {
            filters.push(lvs);
        }

        if filters.is_empty() {
            "null".to_string()
        } else {
            filters.join(",")
        }
    }

    fn parse_advanced_curve_param(&self, param_name: &str) -> Vec<CurvePoint> {
        self.get_string(param_name)
            .map(|json| parse_curve_points_with_fallback(&json, default_flat_curve()))
            .unwrap_or_else(default_flat_curve)
    }

    /// Build RGB curves segment: `curves=master='...':r='...':g='...':b='...'`
    ///
    /// Returns empty string if all four channels are identity.
    fn build_rgb_curves_segment(&self) -> String {
        let channels = [
            ("master_curve", "master"),
            ("red_curve", "r"),
            ("green_curve", "g"),
            ("blue_curve", "b"),
        ];

        let mut parts: Vec<String> = Vec::new();

        for (param_name, filter_name) in channels {
            let json = self.get_string(param_name).unwrap_or_default();
            let points = parse_curve_points(&json);
            if !is_identity_curve(&points) {
                parts.push(format!(
                    "{}='{}'",
                    filter_name,
                    curve_points_to_ffmpeg(&points)
                ));
            }
        }

        if parts.is_empty() {
            String::new()
        } else {
            format!("curves={}", parts.join(":"))
        }
    }

    /// Build Hue vs Sat segment using `selectivecolor` filter.
    ///
    /// Samples the curve at 6 hue positions and adjusts saturation by
    /// adding/removing the complementary color component per range.
    /// y=0.5 → no change, y<0.5 → desaturate, y>0.5 → saturate.
    fn build_hue_vs_sat_segment(&self) -> String {
        let points = self.parse_advanced_curve_param("hue_vs_sat_curve");
        if is_flat_identity_curve(&points) {
            return String::new();
        }

        let ranges: [(&str, f64); 6] = [
            ("reds", 0.0),
            ("yellows", 1.0 / 6.0),
            ("greens", 2.0 / 6.0),
            ("cyans", 0.5),
            ("blues", 4.0 / 6.0),
            ("magentas", 5.0 / 6.0),
        ];

        let mut parts = Vec::new();
        for (name, x_pos) in &ranges {
            let y = sample_curve_at(&points, *x_pos);
            let delta = (y - 0.5) * 2.0;
            if delta.abs() < 0.01 {
                continue;
            }

            let (c, m, yv) = sat_adjust_cmyk(name, delta);
            parts.push(format!("{}='{:.3} {:.3} {:.3} 0'", name, c, m, yv));
        }

        if parts.is_empty() {
            String::new()
        } else {
            format!("selectivecolor={}", parts.join(":"))
        }
    }

    /// Build Hue vs Hue segment using `selectivecolor` filter.
    ///
    /// Approximates hue rotation per hue range by shifting colors toward
    /// their neighbors on the color wheel via CMY adjustments.
    /// y=0.5 → no shift, y>0.5 → clockwise, y<0.5 → counter-clockwise.
    fn build_hue_vs_hue_segment(&self) -> String {
        let points = self.parse_advanced_curve_param("hue_vs_hue_curve");
        if is_flat_identity_curve(&points) {
            return String::new();
        }

        let ranges: [(&str, f64); 6] = [
            ("reds", 0.0),
            ("yellows", 1.0 / 6.0),
            ("greens", 2.0 / 6.0),
            ("cyans", 0.5),
            ("blues", 4.0 / 6.0),
            ("magentas", 5.0 / 6.0),
        ];

        let mut parts = Vec::new();
        for (name, x_pos) in &ranges {
            let y = sample_curve_at(&points, *x_pos);
            let delta = (y - 0.5) * 2.0;
            if delta.abs() < 0.01 {
                continue;
            }

            let (c, m, yv) = hue_shift_cmyk(name, delta);
            parts.push(format!("{}='{:.3} {:.3} {:.3} 0'", name, c, m, yv));
        }

        if parts.is_empty() {
            String::new()
        } else {
            format!("selectivecolor={}", parts.join(":"))
        }
    }

    /// Build Luma vs Sat segment using per-pixel chroma scaling in YUV space.
    ///
    /// Preserves per-luma behavior by scaling Cb/Cr around neutral chroma based on
    /// the sampled Luma vs Sat curve. y=0.5 → 1.0x (no change).
    fn build_luma_vs_sat_segment(&self) -> String {
        let points = self.parse_advanced_curve_param("luma_vs_sat_curve");
        if is_flat_identity_curve(&points) {
            return String::new();
        }

        let luma_expr = "lum(X,Y)/255";
        let factor_expr = luma_sat_factor_expr(&points, luma_expr);
        let cb_expr = format!("max(0,min(255,128+(cb(X,Y)-128)*({factor_expr})))");
        let cr_expr = format!("max(0,min(255,128+(cr(X,Y)-128)*({factor_expr})))");

        format!("format=yuv444p,geq=lum='lum(X,Y)':cb='{cb_expr}':cr='{cr_expr}'")
    }

    // -------------------------------------------------------------------------
    // Transform Effect Builders
    // -------------------------------------------------------------------------

    fn build_rotate_filter(&self) -> String {
        let angle = self.get_float("angle").unwrap_or(0.0);
        // Convert degrees to radians
        let radians = angle * std::f64::consts::PI / 180.0;
        format!("rotate={:.6}:c=black", radians)
    }

    fn build_crop_filter(&self) -> String {
        let width = self.get_float("width").unwrap_or(1920.0) as i64;
        let height = self.get_float("height").unwrap_or(1080.0) as i64;
        let x = self.get_float("x").unwrap_or(0.0) as i64;
        let y = self.get_float("y").unwrap_or(0.0) as i64;
        format!("crop={}:{}:{}:{}", width, height, x, y)
    }

    // -------------------------------------------------------------------------
    // Blur/Sharpen Effect Builders
    // -------------------------------------------------------------------------

    fn build_gaussian_blur_filter(&self) -> String {
        let radius = self.get_float("radius").unwrap_or(5.0);
        // gblur sigma is approximately radius/2 for similar visual appearance
        let sigma = radius.max(0.1);
        format!("gblur=sigma={:.4}", sigma)
    }

    fn build_box_blur_filter(&self) -> String {
        let radius = self.get_float("radius").unwrap_or(5.0) as i64;
        let radius = radius.max(1);
        format!("boxblur={}:{}", radius, radius)
    }

    fn build_sharpen_filter(&self) -> String {
        let amount = self.get_float("amount").unwrap_or(1.0);
        // unsharp format: luma_msize_x:luma_msize_y:luma_amount
        format!("unsharp=5:5:{:.4}", amount)
    }

    fn build_unsharp_filter(&self) -> String {
        let amount = self.get_float("amount").unwrap_or(1.0);
        let radius = self.get_float("radius").unwrap_or(5.0) as i64;
        let size = (radius * 2 + 1).clamp(3, 23); // Must be odd, 3-23
        format!("unsharp={}:{}:{:.4}", size, size, amount)
    }

    // -------------------------------------------------------------------------
    // Stylize Effect Builders
    // -------------------------------------------------------------------------

    fn build_vignette_filter(&self) -> String {
        let intensity = self.get_float("intensity").unwrap_or(0.5);
        let angle = intensity * std::f64::consts::PI / 4.0; // Map 0-1 to 0-PI/4
        format!("vignette=angle={:.4}", angle)
    }

    fn build_film_grain_filter(&self) -> String {
        let amount = self.get_float("amount").unwrap_or(10.0) as i64;
        format!("noise=alls={}:allf=t", amount.clamp(0, 100))
    }

    fn build_noise_filter(&self) -> String {
        let amount = self.get_float("amount").unwrap_or(10.0) as i64;
        format!("noise=alls={}", amount.clamp(0, 100))
    }

    fn build_pixelate_filter(&self) -> String {
        let size = self.get_float("size").unwrap_or(8.0) as i64;
        let size = size.clamp(2, 100);
        format!("pixelize={}:{}", size, size)
    }

    fn build_posterize_filter(&self) -> String {
        let levels = self.get_float("levels").unwrap_or(4.0) as i64;
        let bits = (levels as f64).log2().ceil() as i64;
        let bits = bits.clamp(1, 8);
        format!("posterize={}", bits)
    }

    // -------------------------------------------------------------------------
    // Transition Effect Builders
    // -------------------------------------------------------------------------

    fn build_fade_filter(&self) -> String {
        let duration = self.get_float("duration").unwrap_or(1.0);
        let fade_in = self.get_bool("fade_in").unwrap_or(true);

        if fade_in {
            format!("fade=t=in:st=0:d={:.4}", duration)
        } else {
            // For fade out, start_time specifies when the fade begins.
            // Caller should set start_time = clip_duration - fade_duration.
            let start_time = self.get_float("start_time").unwrap_or(0.0);
            format!("fade=t=out:st={:.4}:d={:.4}", start_time, duration)
        }
    }

    /// Builds FFmpeg xfade filter for cross dissolve transition.
    ///
    /// Parameters:
    /// - `duration`: Transition duration in seconds (default: 1.0)
    /// - `offset`: Time offset where transition begins (default: 0.0)
    fn build_cross_dissolve_filter(&self) -> String {
        let duration = self.get_float("duration").unwrap_or(1.0);
        let offset = self.get_float("offset").unwrap_or(0.0);

        format!(
            "xfade=transition=dissolve:duration={:.4}:offset={:.4}",
            duration, offset
        )
    }

    /// Builds FFmpeg xfade filter for wipe transition.
    ///
    /// Parameters:
    /// - `direction`: Wipe direction ("left", "right", "up", "down") (default: "left")
    /// - `duration`: Transition duration in seconds (default: 1.0)
    /// - `offset`: Time offset where transition begins (default: 0.0)
    fn build_wipe_filter(&self) -> String {
        let direction = self
            .get_param("direction")
            .and_then(|v| v.as_str())
            .unwrap_or("left");
        let duration = self.get_float("duration").unwrap_or(1.0);
        let offset = self.get_float("offset").unwrap_or(0.0);

        let transition = match direction {
            "right" => "wiperight",
            "up" => "wipeup",
            "down" => "wipedown",
            _ => "wipeleft", // default
        };

        format!(
            "xfade=transition={}:duration={:.4}:offset={:.4}",
            transition, duration, offset
        )
    }

    /// Builds FFmpeg xfade filter for slide transition.
    ///
    /// Parameters:
    /// - `direction`: Slide direction ("left", "right", "up", "down") (default: "left")
    /// - `duration`: Transition duration in seconds (default: 1.0)
    /// - `offset`: Time offset where transition begins (default: 0.0)
    fn build_slide_filter(&self) -> String {
        let direction = self
            .get_param("direction")
            .and_then(|v| v.as_str())
            .unwrap_or("left");
        let duration = self.get_float("duration").unwrap_or(1.0);
        let offset = self.get_float("offset").unwrap_or(0.0);

        let transition = match direction {
            "right" => "slideright",
            "up" => "slideup",
            "down" => "slidedown",
            _ => "slideleft", // default
        };

        format!(
            "xfade=transition={}:duration={:.4}:offset={:.4}",
            transition, duration, offset
        )
    }

    /// Builds FFmpeg zoompan filter for zoom effect.
    ///
    /// Parameters:
    /// - `zoom_type`: Zoom direction ("in", "out") (default: "in")
    /// - `duration`: Effect duration in seconds (default: 1.0)
    /// - `zoom_factor`: Maximum zoom level (default: 1.5)
    /// - `center_x`: Horizontal center (0.0-1.0) (default: 0.5)
    /// - `center_y`: Vertical center (0.0-1.0) (default: 0.5)
    /// - `fps`: Output framerate (default: 30)
    fn build_zoom_filter(&self) -> String {
        let zoom_type = self
            .get_param("zoom_type")
            .and_then(|v| v.as_str())
            .unwrap_or("in");
        let duration = self.get_float("duration").unwrap_or(1.0);
        let zoom_factor = self.get_float("zoom_factor").unwrap_or(1.5);
        let center_x = self.get_float("center_x").unwrap_or(0.5);
        let center_y = self.get_float("center_y").unwrap_or(0.5);
        let fps = self.get_float("fps").unwrap_or(30.0) as i64;

        // Guard against invalid duration or fps that would cause division by zero
        if !duration.is_finite() || duration <= 0.0 || fps <= 0 {
            return "null".to_string();
        }

        // Calculate total frames for the duration
        let total_frames = (duration * fps as f64) as i64;

        // Guard against zero total frames (edge case with very small duration)
        if total_frames <= 0 {
            return "null".to_string();
        }

        // Build zoom expression based on type
        // For zoom in: start at 1.0, end at zoom_factor
        // For zoom out: start at zoom_factor, end at 1.0
        let zoom_expr = match zoom_type {
            "out" => format!(
                "z='if(lte(zoom,1.0),{:.4},max(1.001,zoom-{:.6}))'",
                zoom_factor,
                (zoom_factor - 1.0) / total_frames as f64
            ),
            _ => format!(
                "z='min(zoom+{:.6},{:.4})'",
                (zoom_factor - 1.0) / total_frames as f64,
                zoom_factor
            ),
        };

        // Build x/y position expressions to keep centered
        // x and y are calculated based on zoom level to maintain center point
        let x_expr = format!("x='iw*{:.4}-(iw/zoom*{:.4})'", center_x, center_x);
        let y_expr = format!("y='ih*{:.4}-(ih/zoom*{:.4})'", center_y, center_y);

        format!(
            "zoompan={}:{}:{}:d={}:s=hd720:fps={}",
            zoom_expr, x_expr, y_expr, total_frames, fps
        )
    }

    // -------------------------------------------------------------------------
    // Audio Effect Builders
    // -------------------------------------------------------------------------

    fn build_volume_filter(&self) -> String {
        let level = self.get_float("level").unwrap_or(1.0);
        format!("volume={:.4}", level)
    }

    fn build_equalizer_filter(&self) -> String {
        let frequency = self.get_float("frequency").unwrap_or(1000.0);
        let width = self.get_float("width").unwrap_or(100.0);
        let gain = self.get_float("gain").unwrap_or(0.0);
        format!(
            "equalizer=f={}:width_type=h:width={}:g={}",
            frequency, width, gain
        )
    }

    fn build_compressor_filter(&self) -> String {
        let threshold = self.get_float("threshold").unwrap_or(0.5);
        let ratio = self.get_float("ratio").unwrap_or(4.0);
        let attack = self.get_float("attack").unwrap_or(5.0);
        let release = self.get_float("release").unwrap_or(50.0);
        format!(
            "acompressor=threshold={}:ratio={}:attack={}:release={}",
            threshold, ratio, attack, release
        )
    }

    fn build_limiter_filter(&self) -> String {
        let limit = self.get_float("limit").unwrap_or(1.0);
        let attack = self.get_float("attack").unwrap_or(5.0);
        let release = self.get_float("release").unwrap_or(50.0);
        format!(
            "alimiter=limit={}:attack={}:release={}",
            limit, attack, release
        )
    }

    fn build_reverb_filter(&self) -> String {
        let delay = self.get_float("delay").unwrap_or(500.0);
        let decay = self.get_float("decay").unwrap_or(0.5);
        format!("aecho=0.8:0.88:{}:{}", delay, decay)
    }

    fn build_delay_filter(&self) -> String {
        let delay_ms = self.get_float("delay").unwrap_or(500.0) as i64;
        format!("adelay={}|{}", delay_ms, delay_ms)
    }

    /// Builds FFmpeg anlmdn filter for audio noise reduction.
    ///
    /// Uses non-local means denoising algorithm which is effective for
    /// removing background noise while preserving speech quality.
    ///
    /// # Parameters
    ///
    /// - `strength`: Denoising strength (0.00001-0.0001, default: 0.00001)
    /// - `patch_size`: Patch size for comparison (odd 1-99, default: 7)
    /// - `research_size`: Research area size (odd 1-99, default: 15)
    fn build_noise_reduction_filter(&self) -> String {
        let algorithm = self
            .get_string("algorithm")
            .unwrap_or_else(|| "anlmdn".to_string());
        let strength = self.get_float("strength").unwrap_or(0.3).clamp(0.0, 1.0);

        match algorithm.as_str() {
            "afftdn" => {
                // Map strength (0-1) to noise reduction in dB (0-30)
                let nr = (strength * 30.0).round() as i32;
                let noise_floor = self.get_float("noise_floor").unwrap_or(-40.0);
                if noise_floor > -80.0 && noise_floor < 0.0 {
                    format!("afftdn=nr={}:nf={:.1}:nt=w", nr, noise_floor)
                } else {
                    format!("afftdn=nr={}", nr)
                }
            }
            "arnndn" => {
                // RNN-based denoise requires a model file
                let model_path = self.get_string("model_path").unwrap_or_default();
                if model_path.is_empty() {
                    // Fallback to anlmdn if no model path provided
                    self.build_anlmdn_filter(strength)
                } else {
                    let escaped = model_path.replace('\\', "/").replace('\'', "'\\''");
                    format!("arnndn=m='{}'", escaped)
                }
            }
            // Default: anlmdn (Non-Local Means)
            _ => self.build_anlmdn_filter(strength),
        }
    }

    /// Builds anlmdn filter string from normalized strength (0.0-1.0).
    fn build_anlmdn_filter(&self, strength: f64) -> String {
        // Map strength (0-1) to FFmpeg s parameter (0.0001 to 5.0)
        let s = 0.0001 + strength * 4.9999;
        // Patch size scales with strength (7-15, must be odd)
        let p_raw = (7.0_f64 + strength * 8.0).round() as i32;
        let p = if p_raw % 2 == 0 { p_raw + 1 } else { p_raw }.clamp(1, 99);
        // Research size from params
        let r_raw = (self.get_float("research_size").unwrap_or(15.0) as i32).clamp(1, 99);
        let r = if r_raw % 2 == 0 { r_raw + 1 } else { r_raw };
        format!("anlmdn=s={:.4}:p={}:r={}", s, p, r)
    }

    // -------------------------------------------------------------------------
    // Keying Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg chromakey filter for green/blue screen removal.
    ///
    /// # Parameters
    ///
    /// - `key_color`: Color to key out in hex format (default: "#00FF00" green)
    /// - `similarity`: Color similarity threshold 0.0-1.0 (default: 0.3)
    /// - `blend`: Edge blend/feather amount 0.0-1.0 (default: 0.1)
    /// - `spill_suppression`: Reduces color spill on edges 0.0-1.0 (default: 0.0)
    /// - `edge_feather`: Blurs the key mask edges 0.0-10.0 pixels (default: 0.0)
    fn build_chromakey_filter(&self) -> String {
        let key_color = self
            .get_string("key_color")
            .unwrap_or_else(|| "#00FF00".to_string());
        let similarity = self.get_float("similarity").unwrap_or(0.3).clamp(0.0, 1.0);
        let blend = self.get_float("blend").unwrap_or(0.1).clamp(0.0, 1.0);
        let spill_suppression = self
            .get_float("spill_suppression")
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let edge_feather = self
            .get_float("edge_feather")
            .unwrap_or(0.0)
            .clamp(0.0, 10.0);

        // Convert hex color to FFmpeg format (0xRRGGBB)
        let ffmpeg_color = if let Some(stripped) = key_color.strip_prefix('#') {
            format!("0x{}", stripped)
        } else {
            key_color
        };

        let mut filter = format!(
            "chromakey=color={}:similarity={}:blend={}",
            ffmpeg_color, similarity, blend
        );

        // Append spill suppression as colorbalance filter
        if spill_suppression > 0.0 {
            filter = format!("{},colorbalance=gm=-{}", filter, spill_suppression);
        }

        // Append edge feather targeting alpha channel only
        // boxblur=luma_r:luma_p:chroma_r:chroma_p:alpha_r:alpha_p
        if edge_feather > 0.0 {
            filter = format!("{},boxblur=0:1:0:1:{}:1", filter, edge_feather);
        }

        filter
    }

    /// Builds FFmpeg lumakey filter for luminance-based keying.
    ///
    /// # Parameters
    ///
    /// - `threshold`: Luminance threshold 0.0-1.0 (default: 0.1)
    /// - `tolerance`: Tolerance range 0.0-1.0 (default: 0.1)
    /// - `softness`: Edge softness 0.0-1.0 (default: 0.0)
    fn build_lumakey_filter(&self) -> String {
        let threshold = self.get_float("threshold").unwrap_or(0.1).clamp(0.0, 1.0);
        let tolerance = self.get_float("tolerance").unwrap_or(0.1).clamp(0.0, 1.0);
        let softness = self.get_float("softness").unwrap_or(0.0).clamp(0.0, 1.0);

        format!(
            "lumakey=threshold={}:tolerance={}:softness={}",
            threshold, tolerance, softness
        )
    }

    // -------------------------------------------------------------------------
    // Compositing Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg filter for opacity control.
    ///
    /// Uses colorchannelmixer to adjust alpha channel.
    ///
    /// # Parameters
    ///
    /// - `value`: Opacity from 0.0 (transparent) to 1.0 (opaque)
    fn build_opacity_filter(&self) -> String {
        let opacity = self.get_float("value").unwrap_or(1.0).clamp(0.0, 1.0);

        // If fully opaque, no filter needed
        if (opacity - 1.0).abs() < 0.001 {
            return "null".to_string();
        }

        // If fully transparent, return solid black
        if opacity < 0.001 {
            return "format=rgba,geq=a=0".to_string();
        }

        // Use colorchannelmixer to adjust alpha
        // aa=opacity sets the alpha channel multiplier
        format!("format=rgba,colorchannelmixer=aa={:.4}", opacity)
    }

    /// Builds FFmpeg blend filter string for two-input blending.
    ///
    /// Note: This returns just the blend filter parameters. The actual
    /// two-input blend filter needs to be constructed in the export pipeline
    /// as: [input1][input2]blend=all_mode=multiply[output]
    ///
    /// # Supported Modes (19 total)
    ///
    /// **Basic**: normal
    /// **Darken**: multiply, darken, color_burn, linear_burn
    /// **Lighten**: screen, add, lighten, color_dodge, linear_dodge
    /// **Contrast**: overlay, soft_light, hard_light, vivid_light, linear_light, pin_light
    /// **Component**: difference, exclusion, subtract
    pub fn build_blend_filter_params(&self) -> String {
        let mode = self
            .get_string("mode")
            .unwrap_or_else(|| "normal".to_string())
            .to_lowercase();
        let opacity = self.get_float("opacity").unwrap_or(1.0).clamp(0.0, 1.0);

        // Map mode names to FFmpeg blend mode names
        let ffmpeg_mode = match mode.as_str() {
            // Basic
            "normal" => "normal",
            // Darken group
            "multiply" => "multiply",
            "darken" => "darken",
            "color_burn" | "colorburn" => "burn",
            "linear_burn" | "linearburn" => "linearburn",
            // Lighten group
            "screen" => "screen",
            "add" | "linear_dodge" | "lineardodge" => "addition",
            "lighten" => "lighten",
            "color_dodge" | "colordodge" => "dodge",
            // Contrast group
            "overlay" => "overlay",
            "soft_light" | "softlight" => "softlight",
            "hard_light" | "hardlight" => "hardlight",
            "vivid_light" | "vividlight" => "vividlight",
            "linear_light" | "linearlight" => "linearlight",
            "pin_light" | "pinlight" => "pinlight",
            // Component group
            "difference" => "difference",
            "exclusion" => "exclusion",
            "subtract" => "subtract",
            _ => "normal",
        };

        format!("all_mode={}:all_opacity={:.4}", ffmpeg_mode, opacity)
    }

    // -------------------------------------------------------------------------
    // Advanced Color Grading Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg filter for HSL-based selective color correction.
    ///
    /// This implements true selective color correction where adjustments are
    /// applied only to pixels matching the HSL qualifier criteria.
    ///
    /// # Selection Parameters
    ///
    /// - `hue_center`: Center hue in degrees (0-360)
    /// - `hue_width`: Hue range width in degrees (1-180)
    /// - `sat_min`/`sat_max`: Saturation range (0.0-1.0)
    /// - `lum_min`/`lum_max`: Luminance range (0.0-1.0)
    /// - `softness`: Edge softness (0.0-1.0)
    /// - `invert`: Invert the selection
    ///
    /// # Adjustment Parameters
    ///
    /// - `hue_shift`: Hue rotation to apply (-180 to 180)
    /// - `sat_adjust`: Saturation adjustment (-1.0 to 1.0)
    /// - `lum_adjust`: Luminance adjustment (-1.0 to 1.0)
    ///
    /// # Implementation
    ///
    /// Uses FFmpeg's geq filter to create a per-pixel selection mask based on
    /// HSL values, then applies adjustments only to selected pixels via overlay.
    fn build_hsl_qualifier_filter(&self) -> String {
        use crate::core::effects::qualifier_filters::{
            build_qualifier_filter, ColorAdjustments, QualifierParams,
        };

        // Build qualifier parameters from effect params
        let params = QualifierParams {
            hue_center: self.get_float("hue_center").unwrap_or(120.0),
            hue_width: self
                .get_float("hue_width")
                .unwrap_or(30.0)
                .clamp(1.0, 180.0),
            sat_min: self.get_float("sat_min").unwrap_or(0.2).clamp(0.0, 1.0),
            sat_max: self.get_float("sat_max").unwrap_or(1.0).clamp(0.0, 1.0),
            lum_min: self.get_float("lum_min").unwrap_or(0.0).clamp(0.0, 1.0),
            lum_max: self.get_float("lum_max").unwrap_or(1.0).clamp(0.0, 1.0),
            softness: self.get_float("softness").unwrap_or(0.1).clamp(0.0, 1.0),
            invert: self.get_bool("invert").unwrap_or(false),
        };

        // Build color adjustments from effect params
        let adjustments = ColorAdjustments {
            hue_shift: self
                .get_float("hue_shift")
                .unwrap_or(0.0)
                .clamp(-180.0, 180.0),
            sat_adjust: self.get_float("sat_adjust").unwrap_or(0.0).clamp(-1.0, 1.0),
            lum_adjust: self.get_float("lum_adjust").unwrap_or(0.0).clamp(-1.0, 1.0),
        };

        // Use the qualifier filter builder
        // Note: width/height are not strictly needed for qualifier-only mode
        build_qualifier_filter(&params, &adjustments, 1920, 1080)
    }

    // -------------------------------------------------------------------------
    // Audio Metering Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg loudnorm filter for EBU R128 loudness normalization.
    ///
    /// This filter normalizes audio to broadcast standards like:
    /// - YouTube/Streaming: -14 LUFS
    /// - Broadcast TV: -24 LUFS (EBU R128)
    /// - Film: -27 LUFS
    ///
    /// # Parameters
    ///
    /// - `target_lufs`: Target integrated loudness (-70 to -5 LUFS)
    /// - `target_lra`: Target loudness range (1-50 LU)
    /// - `target_tp`: Target true peak (-9 to 0 dBTP)
    /// - `print_format`: Output format for stats ("summary", "json", "none")
    fn build_loudness_normalize_filter(&self) -> String {
        let target_lufs = self
            .get_float("target_lufs")
            .unwrap_or(-14.0)
            .clamp(-70.0, -5.0);
        let target_lra = self
            .get_float("target_lra")
            .unwrap_or(11.0)
            .clamp(1.0, 50.0);
        let target_tp = self.get_float("target_tp").unwrap_or(-1.0).clamp(-9.0, 0.0);
        let print_format = self
            .get_string("print_format")
            .unwrap_or_else(|| "summary".to_string());

        // Validate print format
        let format = match print_format.as_str() {
            "json" => "json",
            "none" => "none",
            _ => "summary",
        };

        format!(
            "loudnorm=I={:.1}:LRA={:.1}:TP={:.1}:print_format={}",
            target_lufs, target_lra, target_tp, format
        )
    }

    // -------------------------------------------------------------------------
    // Text Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg drawtext filter with comprehensive text styling.
    ///
    /// # Supported Parameters
    ///
    /// - `text`: Text content to display (required)
    /// - `font_family`: Font family name (default: "Arial")
    /// - `font_size`: Font size in points (default: 48)
    /// - `color`: Text color as hex string (default: "#FFFFFF")
    /// - `bold`: Enable bold weight (default: false)
    /// - `italic`: Enable italic style (default: false)
    /// - `alignment`: Text alignment ("left", "center", "right") (default: "center")
    /// - `x`: Normalized X position 0.0-1.0 (default: 0.5 = center)
    /// - `y`: Normalized Y position 0.0-1.0 (default: 0.5 = center)
    /// - `background_color`: Background box color as hex (optional)
    /// - `shadow_color`: Shadow color as hex (optional)
    /// - `shadow_x`: Shadow X offset in pixels (default: 2)
    /// - `shadow_y`: Shadow Y offset in pixels (default: 2)
    /// - `outline_color`: Outline/border color as hex (optional)
    /// - `outline_width`: Outline width in pixels (default: 2)
    /// - `opacity`: Text opacity 0.0-1.0 (default: 1.0)
    /// - `rotation`: Rotation angle in degrees (note: limited support in drawtext)
    ///
    /// # FFmpeg Filter Mapping
    ///
    /// The normalized x/y positions (0.0-1.0) are converted to FFmpeg expressions
    /// that calculate actual positions based on video dimensions (w, h) and
    /// text dimensions (text_w, text_h).
    fn build_drawtext_filter(&self) -> String {
        // Required: text content
        let text = self
            .get_param("text")
            .and_then(|v| v.as_str())
            .unwrap_or("Title");
        let escaped_text = escape_drawtext_value(text);

        // Font settings
        let font_family = self
            .get_param("font_family")
            .and_then(|v| v.as_str())
            .unwrap_or("Arial");
        let font_size = self.get_float("font_size").unwrap_or(48.0) as i64;

        // Text color with alpha
        let color_hex = self
            .get_param("color")
            .and_then(|v| v.as_str())
            .unwrap_or("#FFFFFF");
        let opacity = self.get_float("opacity").unwrap_or(1.0).clamp(0.0, 1.0);
        let fontcolor = hex_to_ffmpeg_color(color_hex, opacity);

        // Position (normalized 0.0-1.0 -> FFmpeg expression)
        let x_norm = self.get_float("x").unwrap_or(0.5).clamp(0.0, 1.0);
        let y_norm = self.get_float("y").unwrap_or(0.5).clamp(0.0, 1.0);

        // Alignment affects how x position is interpreted
        let alignment = self
            .get_param("alignment")
            .and_then(|v| v.as_str())
            .unwrap_or("center");

        // Calculate x expression based on alignment
        // For center: x = (w * x_norm) - (text_w / 2)
        // For left: x = (w * x_norm)
        // For right: x = (w * x_norm) - text_w
        let x_expr = match alignment {
            "left" => format!("(w*{:.4})", x_norm),
            "right" => format!("(w*{:.4})-text_w", x_norm),
            _ => format!("(w*{:.4})-(text_w/2)", x_norm), // center (default)
        };

        // Y expression: y = (h * y_norm) - (text_h / 2) for vertical centering
        let y_expr = format!("(h*{:.4})-(text_h/2)", y_norm);

        // Bold/italic are best expressed via fontconfig style (when available).
        // Avoid using non-standard drawtext options like `fontweight`/`fontstyle`.
        let bold = self.get_bool("bold").unwrap_or(false);
        let italic = self.get_bool("italic").unwrap_or(false);
        let mut font_value = font_family.to_string();
        if (bold || italic) && !font_value.to_lowercase().contains(":style=") {
            let style = match (bold, italic) {
                (true, true) => "Bold Italic",
                (true, false) => "Bold",
                (false, true) => "Italic",
                _ => "",
            };
            if !style.is_empty() {
                font_value = format!("{font_value}:style={style}");
            }
        }

        // Build the filter parameters
        let mut params = vec![
            format!("text='{}'", escaped_text),
            format!("font='{}'", escape_drawtext_value(&font_value)),
            format!("fontsize={}", font_size),
            format!("fontcolor={}", fontcolor),
            format!("x={}", x_expr),
            format!("y={}", y_expr),
        ];

        // Line height -> drawtext `line_spacing` (pixels).
        // drawtext uses absolute pixel spacing between lines; approximate using font size.
        if let Some(line_height) = self.get_float("line_height") {
            let lh = line_height.clamp(0.5, 5.0);
            let spacing_px = (((lh - 1.0) * (font_size as f64)).round() as i64).max(0);
            if spacing_px > 0 {
                params.push(format!("line_spacing={}", spacing_px));
            }
        }

        // Background box
        if let Some(bg_color) = self.get_param("background_color").and_then(|v| v.as_str()) {
            if !bg_color.is_empty() {
                let bg_ffmpeg = hex_to_ffmpeg_color(bg_color, opacity);
                let padding = self
                    .get_param("background_padding")
                    .and_then(|v| v.as_int())
                    .unwrap_or(10)
                    .clamp(0, 500);
                params.push("box=1".to_string());
                params.push(format!("boxcolor={}", bg_ffmpeg));
                params.push(format!("boxborderw={}", padding));
            }
        }

        // Shadow
        if let Some(shadow_color) = self.get_param("shadow_color").and_then(|v| v.as_str()) {
            let shadow_x = self
                .get_param("shadow_x")
                .and_then(|v| v.as_int())
                .unwrap_or(2);
            let shadow_y = self
                .get_param("shadow_y")
                .and_then(|v| v.as_int())
                .unwrap_or(2);
            let shadow_ffmpeg = hex_to_ffmpeg_color(shadow_color, opacity * 0.8);
            params.push(format!("shadowcolor={}", shadow_ffmpeg));
            params.push(format!("shadowx={}", shadow_x));
            params.push(format!("shadowy={}", shadow_y));
        }

        // Outline/border
        if let Some(outline_color) = self.get_param("outline_color").and_then(|v| v.as_str()) {
            let outline_width = self
                .get_param("outline_width")
                .and_then(|v| v.as_int())
                .unwrap_or(2);
            let outline_ffmpeg = hex_to_ffmpeg_color(outline_color, opacity);
            params.push(format!("borderw={}", outline_width));
            params.push(format!("bordercolor={}", outline_ffmpeg));
        }

        format!("drawtext={}", params.join(":"))
    }

    fn build_subtitle_filter(&self) -> String {
        let file = self
            .get_param("file")
            .and_then(|v| v.as_str())
            .unwrap_or("subtitles.srt");
        format!("subtitles='{}'", escape_ffmpeg_filter_value(file))
    }

    // -------------------------------------------------------------------------
    // Color Grading Effect Builders
    // -------------------------------------------------------------------------

    /// Builds FFmpeg lut3d filter for LUT-based color grading.
    ///
    /// Parameters:
    /// - `file`: Path to the LUT file (.cube, .3dl, etc.) (required)
    /// - `interp`: Interpolation method ("nearest", "trilinear", "tetrahedral") (default: "tetrahedral")
    /// - `intensity`: LUT intensity from 0.0-1.0 (optional, for future blend support)
    fn build_lut_filter(&self) -> String {
        let file = match self.get_param("file").and_then(|v| v.as_str()) {
            Some(f) if !f.is_empty() => f,
            _ => return "null".to_string(), // No file = no-op
        };

        let interp = self
            .get_param("interp")
            .and_then(|v| v.as_str())
            .unwrap_or("tetrahedral");

        // Validate interpolation method
        let valid_interp = match interp {
            "nearest" | "trilinear" | "tetrahedral" => interp,
            _ => "tetrahedral",
        };

        // Escape the file path for FFmpeg filter syntax
        let escaped_file = escape_ffmpeg_filter_value(file);

        format!("lut3d='{}':interp={}", escaped_file, valid_interp)
    }
}

// =============================================================================
// Filter Graph Composition
// =============================================================================

/// Composes multiple effects into a single FFmpeg filter complex string
pub struct FilterGraph {
    /// List of effects in order
    effects: Vec<Effect>,
}

impl FilterGraph {
    /// Creates a new empty filter graph
    pub fn new() -> Self {
        Self { effects: vec![] }
    }

    /// Adds an effect to the graph
    pub fn add_effect(&mut self, effect: Effect) {
        if effect.enabled && effect.is_ffmpeg_compatible() {
            self.effects.push(effect);
        }
    }

    /// Sorts effects by order
    pub fn sort_by_order(&mut self) {
        self.effects.sort_by_key(|e| e.order);
    }

    /// Returns true if the graph has any video effects
    pub fn has_video_effects(&self) -> bool {
        self.effects.iter().any(|e| e.is_video())
    }

    /// Returns true if the graph has any audio effects
    pub fn has_audio_effects(&self) -> bool {
        self.effects.iter().any(|e| e.is_audio())
    }

    /// Generates the FFmpeg filter_complex string for video effects
    ///
    /// # Arguments
    ///
    /// * `input_label` - Input stream label (e.g., "0:v")
    /// * `output_label` - Final output label (e.g., "vout")
    pub fn to_video_filter_complex(&self, input_label: &str, output_label: &str) -> String {
        let video_effects: Vec<&Effect> = self.effects.iter().filter(|e| e.is_video()).collect();

        if video_effects.is_empty() {
            return format!("[{input_label}]null[{output_label}]");
        }

        let mut filters = Vec::new();
        let mut current_label = input_label.to_string();

        for (i, effect) in video_effects.iter().enumerate() {
            let is_last = i == video_effects.len() - 1;
            let next_label = if is_last {
                output_label.to_string()
            } else {
                format!("v{}", i)
            };

            let filter = effect.to_filter_string(&current_label, &next_label);
            filters.push(filter);
            current_label = next_label;
        }

        filters.join(";")
    }

    /// Generates a time-scoped FFmpeg filter_complex string for video effects.
    ///
    /// Each filter is gated with `enable='between(t,start,end)'` so that the
    /// effects only apply during the given time window.  Used for adjustment
    /// layers whose effects must be restricted to the clip's timeline range.
    pub fn to_video_filter_complex_timed(
        &self,
        input_label: &str,
        output_label: &str,
        start_sec: f64,
        end_sec: f64,
    ) -> String {
        let video_effects: Vec<&Effect> = self.effects.iter().filter(|e| e.is_video()).collect();

        if video_effects.is_empty() {
            return format!("[{input_label}]null[{output_label}]");
        }

        let enable_clause = format!(
            ":enable='between(t,{:.6},{:.6})'",
            start_sec.max(0.0),
            end_sec.max(0.0)
        );

        let mut filters = Vec::new();
        let mut current_label = input_label.to_string();

        for (i, effect) in video_effects.iter().enumerate() {
            let is_last = i == video_effects.len() - 1;
            let next_label = if is_last {
                output_label.to_string()
            } else {
                format!("{}_{}", output_label, i)
            };

            let filter_body = effect.to_filter_body();
            if filter_body.is_empty() {
                filters.push(format!("[{current_label}]null[{next_label}]"));
            } else {
                filters.push(format!(
                    "[{current_label}]{filter_body}{enable_clause}[{next_label}]"
                ));
            }
            current_label = next_label;
        }

        filters.join(";")
    }

    /// Generates the FFmpeg filter_complex string for audio effects
    ///
    /// # Arguments
    ///
    /// * `input_label` - Input stream label (e.g., "0:a")
    /// * `output_label` - Final output label (e.g., "aout")
    pub fn to_audio_filter_complex(&self, input_label: &str, output_label: &str) -> String {
        let audio_effects: Vec<&Effect> = self.effects.iter().filter(|e| e.is_audio()).collect();

        if audio_effects.is_empty() {
            return format!("[{input_label}]anull[{output_label}]");
        }

        let mut filters = Vec::new();
        let mut current_label = input_label.to_string();

        for (i, effect) in audio_effects.iter().enumerate() {
            let is_last = i == audio_effects.len() - 1;
            let next_label = if is_last {
                output_label.to_string()
            } else {
                format!("a{}", i)
            };

            let filter = effect.to_filter_string(&current_label, &next_label);
            filters.push(filter);
            current_label = next_label;
        }

        filters.join(";")
    }

    /// Generates a combined filter_complex string for both video and audio
    pub fn to_filter_complex(
        &self,
        video_in: &str,
        video_out: &str,
        audio_in: &str,
        audio_out: &str,
    ) -> String {
        let video = self.to_video_filter_complex(video_in, video_out);
        let audio = self.to_audio_filter_complex(audio_in, audio_out);

        format!("{};{}", video, audio)
    }
}

impl Default for FilterGraph {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::effects::{curve_points_to_json, CurvePoint, EffectCategory, ParamValue};

    #[test]
    fn test_brightness_filter() {
        let mut effect = Effect::new(EffectType::Brightness);
        effect.set_param("value", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:v", "out");
        assert!(filter.contains("eq=brightness=0.5"));
        assert!(filter.starts_with("[0:v]"));
        assert!(filter.ends_with("[out]"));
    }

    #[test]
    fn test_gaussian_blur_filter() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.set_param("radius", ParamValue::Float(10.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("gblur=sigma=10"));
    }

    #[test]
    fn test_volume_filter() {
        let mut effect = Effect::new(EffectType::Volume);
        effect.set_param("level", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(filter.contains("volume=0.5"));
    }

    #[test]
    fn test_disabled_effect() {
        let mut effect = Effect::new(EffectType::GaussianBlur);
        effect.enabled = false;

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("null"));
    }

    #[test]
    fn test_filter_graph_single_effect() {
        let mut graph = FilterGraph::new();
        graph.add_effect(Effect::new(EffectType::GaussianBlur));

        let complex = graph.to_video_filter_complex("0:v", "vout");
        assert!(complex.contains("gblur"));
        assert!(complex.contains("[0:v]"));
        assert!(complex.contains("[vout]"));
    }

    #[test]
    fn test_filter_graph_multiple_effects() {
        let mut graph = FilterGraph::new();

        let mut blur = Effect::new(EffectType::GaussianBlur);
        blur.order = 0;
        graph.add_effect(blur);

        let mut brightness = Effect::new(EffectType::Brightness);
        brightness.order = 1;
        brightness.set_param("value", ParamValue::Float(0.2));
        graph.add_effect(brightness);

        graph.sort_by_order();
        let complex = graph.to_video_filter_complex("0:v", "vout");

        // Should chain: [0:v]blur[v0];[v0]brightness[vout]
        assert!(complex.contains("gblur"));
        assert!(complex.contains("eq=brightness"));
        assert!(complex.contains(";"));
    }

    #[test]
    fn test_filter_graph_mixed_audio_video() {
        let mut graph = FilterGraph::new();

        graph.add_effect(Effect::new(EffectType::GaussianBlur));
        graph.add_effect(Effect::new(EffectType::Volume));

        assert!(graph.has_video_effects());
        assert!(graph.has_audio_effects());

        let video = graph.to_video_filter_complex("0:v", "vout");
        let audio = graph.to_audio_filter_complex("0:a", "aout");

        assert!(video.contains("gblur"));
        assert!(audio.contains("volume"));
    }

    #[test]
    fn test_rotate_filter() {
        let mut effect = Effect::new(EffectType::Rotate);
        effect.set_param("angle", ParamValue::Float(90.0));

        let filter = effect.to_filter_string("in", "out");
        // 90 degrees = PI/2 radians ≈ 1.5708
        assert!(filter.contains("rotate="));
    }

    #[test]
    fn test_fade_in_filter() {
        let mut effect = Effect::new(EffectType::Fade);
        effect.set_param("duration", ParamValue::Float(2.0));
        effect.set_param("fade_in", ParamValue::Bool(true));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("fade=t=in"));
        assert!(filter.contains("d=2.0"));
    }

    #[test]
    fn test_fade_out_filter() {
        let mut effect = Effect::new(EffectType::Fade);
        effect.set_param("duration", ParamValue::Float(1.5));
        effect.set_param("fade_in", ParamValue::Bool(false));
        effect.set_param("start_time", ParamValue::Float(8.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("fade=t=out"));
        assert!(filter.contains("st=8.5"));
        assert!(filter.contains("d=1.5"));
    }

    #[test]
    fn test_fade_out_filter_default_start() {
        let mut effect = Effect::new(EffectType::Fade);
        effect.set_param("duration", ParamValue::Float(2.0));
        effect.set_param("fade_in", ParamValue::Bool(false));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("fade=t=out"));
        assert!(filter.contains("st=0.0"));
    }

    // =========================================================================
    // Enhanced Drawtext Filter Tests
    // =========================================================================

    #[test]
    fn test_drawtext_filter_basic() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Hello World".to_string()));
        effect.set_param("font_size", ParamValue::Float(32.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("drawtext"),
            "Expected drawtext filter, got: {}",
            filter
        );
        assert!(
            filter.contains("text='Hello World'"),
            "Expected text content, got: {}",
            filter
        );
        assert!(
            filter.contains("fontsize=32"),
            "Expected font size, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_normalized_position() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Centered".to_string()));
        effect.set_param("x", ParamValue::Float(0.5)); // center
        effect.set_param("y", ParamValue::Float(0.5)); // center

        let filter = effect.to_filter_string("in", "out");
        // Position should use FFmpeg expressions for centering
        assert!(
            filter.contains("x=(w*0.5"),
            "Expected x centering expression, got: {}",
            filter
        );
        assert!(
            filter.contains("y=(h*0.5"),
            "Expected y centering expression, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_alignment_left() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Left".to_string()));
        effect.set_param("alignment", ParamValue::String("left".to_string()));
        effect.set_param("x", ParamValue::Float(0.1));

        let filter = effect.to_filter_string("in", "out");
        // Left alignment: x = (w * x_norm) - format uses 4 decimal places
        assert!(
            filter.contains("x=(w*0.1000)"),
            "Expected left-aligned x, got: {}",
            filter
        );
        // Should NOT contain text_w subtraction for left alignment
        assert!(
            !filter.contains("-text_w"),
            "Unexpected text_w for left, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_alignment_right() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Right".to_string()));
        effect.set_param("alignment", ParamValue::String("right".to_string()));
        effect.set_param("x", ParamValue::Float(0.9));

        let filter = effect.to_filter_string("in", "out");
        // Right alignment: x = (w * x_norm) - text_w
        assert!(
            filter.contains("x=(w*0.9000)-text_w"),
            "Expected right-aligned x, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_alignment_center() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Center".to_string()));
        effect.set_param("alignment", ParamValue::String("center".to_string()));
        effect.set_param("x", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("in", "out");
        // Center alignment: x = (w * x_norm) - (text_w / 2) - format uses 4 decimal places
        assert!(
            filter.contains("x=(w*0.5000)-(text_w/2)"),
            "Expected centered x, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_font_family() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Custom Font".to_string()));
        effect.set_param("font_family", ParamValue::String("Helvetica".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("font='Helvetica'"),
            "Expected font family, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_color() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Red".to_string()));
        effect.set_param("color", ParamValue::String("#FF0000".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("fontcolor=0xFF0000"),
            "Expected red fontcolor, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_opacity() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Semi-transparent".to_string()));
        effect.set_param("color", ParamValue::String("#FFFFFF".to_string()));
        effect.set_param("opacity", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("fontcolor=0xFFFFFF@0.50"),
            "Expected opacity in color, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_bold() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Bold".to_string()));
        effect.set_param("bold", ParamValue::Bool(true));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("font='Arial\\:style=Bold'"),
            "Expected bold style in font pattern, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_italic() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Italic".to_string()));
        effect.set_param("italic", ParamValue::Bool(true));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("font='Arial\\:style=Italic'"),
            "Expected italic style in font pattern, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_escapes_newlines_and_percent_expressions() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param(
            "text",
            ParamValue::String("Line1\n%{eif\\:1\\:d}\rLine2".to_string()),
        );

        let filter = effect.to_filter_string("in", "out");
        assert!(
            !filter.contains('\n') && !filter.contains('\r'),
            "Expected no raw newlines in filter string, got: {}",
            filter
        );
        assert!(
            filter.contains("text='Line1 ")
                && filter.contains("\\%{")
                && filter.contains(" Line2'"),
            "Expected percent escape + control-char normalization, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_background_padding_maps_to_boxborderw() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Padded".to_string()));
        effect.set_param(
            "background_color",
            ParamValue::String("#000000".to_string()),
        );
        effect.set_param("background_padding", ParamValue::Int(24));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("boxborderw=24"),
            "Expected box padding from param, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_background() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("With BG".to_string()));
        effect.set_param(
            "background_color",
            ParamValue::String("#000000".to_string()),
        );

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("box=1"),
            "Expected box enabled, got: {}",
            filter
        );
        assert!(
            filter.contains("boxcolor=0x000000"),
            "Expected black boxcolor, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_shadow() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Shadow".to_string()));
        effect.set_param("shadow_color", ParamValue::String("#000000".to_string()));
        effect.set_param("shadow_x", ParamValue::Int(3));
        effect.set_param("shadow_y", ParamValue::Int(3));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("shadowcolor=0x000000"),
            "Expected shadow color, got: {}",
            filter
        );
        assert!(
            filter.contains("shadowx=3"),
            "Expected shadow x, got: {}",
            filter
        );
        assert!(
            filter.contains("shadowy=3"),
            "Expected shadow y, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_with_outline() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Outline".to_string()));
        effect.set_param("outline_color", ParamValue::String("#000000".to_string()));
        effect.set_param("outline_width", ParamValue::Int(4));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("borderw=4"),
            "Expected border width, got: {}",
            filter
        );
        assert!(
            filter.contains("bordercolor=0x000000"),
            "Expected border color, got: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_full_styling() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Full Style".to_string()));
        effect.set_param("font_family", ParamValue::String("Verdana".to_string()));
        effect.set_param("font_size", ParamValue::Float(64.0));
        effect.set_param("color", ParamValue::String("#FF5500".to_string()));
        effect.set_param("bold", ParamValue::Bool(true));
        effect.set_param("x", ParamValue::Float(0.5));
        effect.set_param("y", ParamValue::Float(0.8));
        effect.set_param("alignment", ParamValue::String("center".to_string()));
        effect.set_param(
            "background_color",
            ParamValue::String("#000080".to_string()),
        );
        effect.set_param("shadow_color", ParamValue::String("#333333".to_string()));
        effect.set_param("outline_color", ParamValue::String("#FFFFFF".to_string()));
        effect.set_param("outline_width", ParamValue::Int(2));

        let filter = effect.to_filter_string("in", "out");

        // Verify all components are present
        assert!(filter.contains("drawtext="), "Expected drawtext filter");
        assert!(filter.contains("text='Full Style'"), "Expected text");
        assert!(
            filter.contains("font='Verdana\\:style=Bold'"),
            "Expected bold style in font pattern, got: {filter}"
        );
        assert!(filter.contains("fontsize=64"), "Expected font size");
        assert!(filter.contains("fontcolor=0xFF5500"), "Expected color");
        assert!(filter.contains("box=1"), "Expected background box");
        assert!(filter.contains("shadowcolor="), "Expected shadow");
        assert!(filter.contains("borderw=2"), "Expected outline");
    }

    #[test]
    fn test_drawtext_escapes_special_characters() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param(
            "text",
            ParamValue::String("100% C:\\tmp\\foo:bar,baz 'q'".to_string()),
        );

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("text='100\\% C\\:\\\\tmp\\\\foo\\:bar\\,baz \\'q\\''"),
            "Unexpected drawtext escaping: {}",
            filter
        );
    }

    #[test]
    fn test_drawtext_default_values() {
        let effect = Effect::new(EffectType::TextOverlay);

        let filter = effect.to_filter_string("in", "out");
        // Default text should be "Title"
        assert!(
            filter.contains("text='Title'"),
            "Expected default text, got: {}",
            filter
        );
        // Default font should be Arial
        assert!(
            filter.contains("font='Arial'"),
            "Expected default font, got: {}",
            filter
        );
        // Default font size should be 48
        assert!(
            filter.contains("fontsize=48"),
            "Expected default font size, got: {}",
            filter
        );
        // Default color should be white
        assert!(
            filter.contains("fontcolor=0xFFFFFF"),
            "Expected white color, got: {}",
            filter
        );
    }

    #[test]
    fn test_hex_to_ffmpeg_color_full_hex() {
        assert_eq!(hex_to_ffmpeg_color("#FF0000", 1.0), "0xFF0000");
        assert_eq!(hex_to_ffmpeg_color("#00FF00", 1.0), "0x00FF00");
        assert_eq!(hex_to_ffmpeg_color("#0000FF", 1.0), "0x0000FF");
    }

    #[test]
    fn test_hex_to_ffmpeg_color_short_hex() {
        // Short hex #RGB should expand to #RRGGBB
        assert_eq!(hex_to_ffmpeg_color("#F00", 1.0), "0xFF0000");
        assert_eq!(hex_to_ffmpeg_color("#0F0", 1.0), "0x00FF00");
        assert_eq!(hex_to_ffmpeg_color("#00F", 1.0), "0x0000FF");
    }

    #[test]
    fn test_hex_to_ffmpeg_color_with_opacity() {
        assert_eq!(hex_to_ffmpeg_color("#FFFFFF", 0.5), "0xFFFFFF@0.50");
        assert_eq!(hex_to_ffmpeg_color("#000000", 0.75), "0x000000@0.75");
    }

    #[test]
    fn test_hex_to_ffmpeg_color_no_hash() {
        // Should work without # prefix
        assert_eq!(hex_to_ffmpeg_color("FF0000", 1.0), "0xFF0000");
    }

    #[test]
    fn test_subtitles_escapes_windows_paths() {
        let mut effect = Effect::new(EffectType::Subtitle);
        effect.set_param(
            "file",
            ParamValue::String("C:\\tmp\\subtitles.srt".to_string()),
        );

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("subtitles='C\\:\\\\tmp\\\\subtitles.srt'"),
            "Unexpected subtitles escaping: {}",
            filter
        );
    }

    #[test]
    fn test_incompatible_effect() {
        let effect = Effect::new(EffectType::BackgroundRemoval);

        assert!(!effect.is_ffmpeg_compatible());
        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("null"));
    }

    #[test]
    fn test_empty_filter_graph() {
        let graph = FilterGraph::new();

        let video = graph.to_video_filter_complex("0:v", "vout");
        let audio = graph.to_audio_filter_complex("0:a", "aout");

        assert!(video.contains("null"));
        assert!(audio.contains("anull"));
    }

    // =========================================================================
    // Transition Effect Tests (xfade)
    // =========================================================================

    #[test]
    fn test_cross_dissolve_filter() {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(1.0));
        effect.set_param("offset", ParamValue::Float(5.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=dissolve"),
            "Expected dissolve transition, got: {}",
            filter
        );
        assert!(
            filter.contains("duration=1.0"),
            "Expected duration=1.0, got: {}",
            filter
        );
        assert!(
            filter.contains("offset=5.0"),
            "Expected offset=5.0, got: {}",
            filter
        );
    }

    #[test]
    fn test_cross_dissolve_default_params() {
        let effect = Effect::new(EffectType::CrossDissolve);

        let filter = effect.to_filter_string("in", "out");
        // Default duration should be 1.0, offset should be 0.0
        assert!(filter.contains("xfade=transition=dissolve"));
        assert!(filter.contains("duration=1.0"));
        assert!(filter.contains("offset=0.0"));
    }

    #[test]
    fn test_wipe_left_filter() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("direction", ParamValue::String("left".to_string()));
        effect.set_param("duration", ParamValue::Float(0.5));
        effect.set_param("offset", ParamValue::Float(3.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=wipeleft"),
            "Expected wipeleft, got: {}",
            filter
        );
        assert!(filter.contains("duration=0.5"));
        assert!(filter.contains("offset=3.0"));
    }

    #[test]
    fn test_wipe_right_filter() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("direction", ParamValue::String("right".to_string()));
        effect.set_param("duration", ParamValue::Float(1.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=wiperight"),
            "Expected wiperight, got: {}",
            filter
        );
    }

    #[test]
    fn test_wipe_up_filter() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("direction", ParamValue::String("up".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=wipeup"),
            "Expected wipeup, got: {}",
            filter
        );
    }

    #[test]
    fn test_wipe_down_filter() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("direction", ParamValue::String("down".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=wipedown"),
            "Expected wipedown, got: {}",
            filter
        );
    }

    #[test]
    fn test_wipe_default_direction() {
        let effect = Effect::new(EffectType::Wipe);

        let filter = effect.to_filter_string("in", "out");
        // Default direction should be "left"
        assert!(
            filter.contains("xfade=transition=wipeleft"),
            "Expected default wipeleft, got: {}",
            filter
        );
    }

    #[test]
    fn test_slide_left_filter() {
        let mut effect = Effect::new(EffectType::Slide);
        effect.set_param("direction", ParamValue::String("left".to_string()));
        effect.set_param("duration", ParamValue::Float(0.75));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=slideleft"),
            "Expected slideleft, got: {}",
            filter
        );
        assert!(filter.contains("duration=0.75"));
    }

    #[test]
    fn test_slide_right_filter() {
        let mut effect = Effect::new(EffectType::Slide);
        effect.set_param("direction", ParamValue::String("right".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=slideright"),
            "Expected slideright, got: {}",
            filter
        );
    }

    #[test]
    fn test_slide_up_filter() {
        let mut effect = Effect::new(EffectType::Slide);
        effect.set_param("direction", ParamValue::String("up".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=slideup"),
            "Expected slideup, got: {}",
            filter
        );
    }

    #[test]
    fn test_slide_down_filter() {
        let mut effect = Effect::new(EffectType::Slide);
        effect.set_param("direction", ParamValue::String("down".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("xfade=transition=slidedown"),
            "Expected slidedown, got: {}",
            filter
        );
    }

    #[test]
    fn test_slide_default_direction() {
        let effect = Effect::new(EffectType::Slide);

        let filter = effect.to_filter_string("in", "out");
        // Default direction should be "left"
        assert!(
            filter.contains("xfade=transition=slideleft"),
            "Expected default slideleft, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_in_filter() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("zoom_type", ParamValue::String("in".to_string()));
        effect.set_param("duration", ParamValue::Float(2.0));
        effect.set_param("zoom_factor", ParamValue::Float(1.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("zoompan"),
            "Expected zoompan filter, got: {}",
            filter
        );
        assert!(
            filter.contains("z='"),
            "Expected zoom expression, got: {}",
            filter
        );
        assert!(
            filter.contains("d="),
            "Expected duration param, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_out_filter() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("zoom_type", ParamValue::String("out".to_string()));
        effect.set_param("duration", ParamValue::Float(1.5));
        effect.set_param("zoom_factor", ParamValue::Float(2.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("zoompan"));
        // Zoom out starts zoomed and ends at normal
        assert!(filter.contains("z='"));
    }

    #[test]
    fn test_zoom_default_params() {
        let effect = Effect::new(EffectType::Zoom);

        let filter = effect.to_filter_string("in", "out");
        // Default: zoom in, 1.0s duration, 1.5x factor
        assert!(filter.contains("zoompan"));
    }

    #[test]
    fn test_zoom_with_center() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("center_x", ParamValue::Float(0.75));
        effect.set_param("center_y", ParamValue::Float(0.25));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("zoompan"));
        // Should have x/y positioning
        assert!(
            filter.contains("x=") || filter.contains("x='"),
            "Expected x position, got: {}",
            filter
        );
        assert!(
            filter.contains("y=") || filter.contains("y='"),
            "Expected y position, got: {}",
            filter
        );
    }

    // =========================================================================
    // Edge Cases and Robustness Tests
    // =========================================================================

    #[test]
    fn test_wipe_invalid_direction_fallback() {
        let mut effect = Effect::new(EffectType::Wipe);
        effect.set_param("direction", ParamValue::String("invalid".to_string()));

        let filter = effect.to_filter_string("in", "out");
        // Should fallback to default "wipeleft"
        assert!(
            filter.contains("xfade=transition=wipeleft"),
            "Expected fallback to wipeleft, got: {}",
            filter
        );
    }

    #[test]
    fn test_slide_invalid_direction_fallback() {
        let mut effect = Effect::new(EffectType::Slide);
        effect.set_param("direction", ParamValue::String("diagonal".to_string()));

        let filter = effect.to_filter_string("in", "out");
        // Should fallback to default "slideleft"
        assert!(
            filter.contains("xfade=transition=slideleft"),
            "Expected fallback to slideleft, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_invalid_type_fallback() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("zoom_type", ParamValue::String("invalid".to_string()));

        let filter = effect.to_filter_string("in", "out");
        // Should fallback to zoom in (default)
        assert!(
            filter.contains("zoompan"),
            "Expected zoompan filter, got: {}",
            filter
        );
        // Zoom in increases zoom, so expression should contain 'min'
        assert!(
            filter.contains("min(zoom+"),
            "Expected zoom in expression, got: {}",
            filter
        );
    }

    #[test]
    fn test_xfade_with_zero_duration() {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("duration", ParamValue::Float(0.0));

        let filter = effect.to_filter_string("in", "out");
        // Should still generate valid filter with zero duration
        assert!(filter.contains("xfade=transition=dissolve"));
        assert!(filter.contains("duration=0.0"));
    }

    #[test]
    fn test_xfade_with_negative_offset() {
        let mut effect = Effect::new(EffectType::CrossDissolve);
        effect.set_param("offset", ParamValue::Float(-5.0));

        let filter = effect.to_filter_string("in", "out");
        // Should accept negative offset (FFmpeg handles validation)
        assert!(filter.contains("offset=-5.0"));
    }

    #[test]
    fn test_zoom_with_extreme_factor() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("zoom_factor", ParamValue::Float(10.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("zoompan"));
        // Should contain the extreme zoom factor in the expression
        assert!(
            filter.contains("10.0") || filter.contains("10."),
            "Expected zoom factor 10.0, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_custom_fps() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("fps", ParamValue::Float(60.0));
        effect.set_param("duration", ParamValue::Float(1.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("fps=60"));
        // Duration 1.0s at 60fps = 60 frames
        assert!(filter.contains("d=60"));
    }

    #[test]
    fn test_wipe_case_sensitive_direction() {
        let mut effect = Effect::new(EffectType::Wipe);
        // Using uppercase - should fallback to default
        effect.set_param("direction", ParamValue::String("LEFT".to_string()));

        let filter = effect.to_filter_string("in", "out");
        // Direction matching is case-sensitive, uppercase falls back to default
        assert!(
            filter.contains("xfade=transition=wipeleft"),
            "Expected case-sensitive fallback, got: {}",
            filter
        );
    }

    // =========================================================================
    // LUT Effect Tests
    // =========================================================================

    #[test]
    fn test_lut_filter_basic() {
        let mut effect = Effect::new(EffectType::Lut);
        effect.set_param("file", ParamValue::String("/path/to/lut.cube".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("lut3d="),
            "Expected lut3d filter, got: {}",
            filter
        );
        assert!(
            filter.contains("/path/to/lut.cube"),
            "Expected LUT file path, got: {}",
            filter
        );
    }

    #[test]
    fn test_lut_filter_with_intensity() {
        let mut effect = Effect::new(EffectType::Lut);
        effect.set_param(
            "file",
            ParamValue::String("/luts/cinematic.cube".to_string()),
        );
        effect.set_param("intensity", ParamValue::Float(0.75));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("lut3d="));
        // Intensity is applied via split/blend filter chain
    }

    #[test]
    fn test_lut_filter_with_windows_path() {
        let mut effect = Effect::new(EffectType::Lut);
        effect.set_param(
            "file",
            ParamValue::String("C:\\Users\\test\\luts\\color.cube".to_string()),
        );

        let filter = effect.to_filter_string("in", "out");
        // Windows path should be properly escaped for FFmpeg
        assert!(
            filter.contains("lut3d="),
            "Expected lut3d filter, got: {}",
            filter
        );
        // Colons and backslashes must be escaped
        assert!(
            filter.contains(r"C\:") || filter.contains(r"\\"),
            "Expected escaped Windows path, got: {}",
            filter
        );
    }

    #[test]
    fn test_lut_filter_with_interpolation() {
        let mut effect = Effect::new(EffectType::Lut);
        effect.set_param("file", ParamValue::String("/luts/film.cube".to_string()));
        effect.set_param("interp", ParamValue::String("trilinear".to_string()));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("lut3d="));
        assert!(
            filter.contains("interp=trilinear"),
            "Expected trilinear interpolation, got: {}",
            filter
        );
    }

    #[test]
    fn test_lut_filter_default_interpolation() {
        let mut effect = Effect::new(EffectType::Lut);
        effect.set_param("file", ParamValue::String("/luts/default.cube".to_string()));

        let filter = effect.to_filter_string("in", "out");
        // Default interpolation should be tetrahedral (best quality)
        assert!(
            filter.contains("interp=tetrahedral"),
            "Expected default tetrahedral interpolation, got: {}",
            filter
        );
    }

    #[test]
    fn test_lut_filter_no_file_returns_null() {
        let effect = Effect::new(EffectType::Lut);

        let filter = effect.to_filter_string("in", "out");
        // Without a file path, LUT should return null (no-op)
        assert!(
            filter.contains("null"),
            "Expected null filter for LUT without file, got: {}",
            filter
        );
    }

    // =========================================================================
    // Zoom Filter Edge Case Tests (Division by Zero Prevention)
    // =========================================================================

    #[test]
    fn test_zoom_with_zero_duration_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(0.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for zero duration, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_negative_duration_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(-1.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for negative duration, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_zero_fps_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("fps", ParamValue::Float(0.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for zero fps, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_negative_fps_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("fps", ParamValue::Float(-30.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for negative fps, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_nan_duration_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(f64::NAN));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for NaN duration, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_infinity_duration_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(f64::INFINITY));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("null"),
            "Expected null filter for infinite duration, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_very_small_duration_returns_null() {
        let mut effect = Effect::new(EffectType::Zoom);
        // Very small duration that results in 0 total frames at 30fps
        effect.set_param("duration", ParamValue::Float(0.001));
        effect.set_param("fps", ParamValue::Float(30.0));

        let filter = effect.to_filter_string("in", "out");
        // 0.001 * 30 = 0.03, cast to i64 = 0 frames
        assert!(
            filter.contains("null"),
            "Expected null filter for very small duration resulting in 0 frames, got: {}",
            filter
        );
    }

    #[test]
    fn test_zoom_with_valid_params_generates_filter() {
        let mut effect = Effect::new(EffectType::Zoom);
        effect.set_param("duration", ParamValue::Float(2.0));
        effect.set_param("fps", ParamValue::Float(30.0));
        effect.set_param("zoom_factor", ParamValue::Float(1.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("zoompan"),
            "Expected zoompan filter for valid params, got: {}",
            filter
        );
        assert!(
            filter.contains("d=60"),
            "Expected 60 frames (2s * 30fps), got: {}",
            filter
        );
    }

    // =========================================================================
    // Color Wheels (Lift/Gamma/Gain) Tests
    // =========================================================================

    #[test]
    fn test_color_wheels_default_returns_null() {
        let effect = Effect::new(EffectType::ColorWheels);

        let filter = effect.to_filter_string("in", "out");
        // All parameters at 0.0 should return null (no-op)
        assert!(
            filter.contains("null"),
            "Expected null filter for default color wheels, got: {}",
            filter
        );
    }

    #[test]
    fn test_color_wheels_lift_adjustment() {
        let mut effect = Effect::new(EffectType::ColorWheels);
        effect.set_param("lift_r", ParamValue::Float(0.3));
        effect.set_param("lift_g", ParamValue::Float(-0.2));
        effect.set_param("lift_b", ParamValue::Float(0.1));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("colorbalance"),
            "Expected colorbalance filter, got: {}",
            filter
        );
        assert!(
            filter.contains("rs=0.3000"),
            "Expected lift_r (rs) value, got: {}",
            filter
        );
        assert!(
            filter.contains("gs=-0.2000"),
            "Expected lift_g (gs) value, got: {}",
            filter
        );
        assert!(
            filter.contains("bs=0.1000"),
            "Expected lift_b (bs) value, got: {}",
            filter
        );
    }

    #[test]
    fn test_color_wheels_gamma_adjustment() {
        let mut effect = Effect::new(EffectType::ColorWheels);
        effect.set_param("gamma_r", ParamValue::Float(0.5));
        effect.set_param("gamma_g", ParamValue::Float(0.5));
        effect.set_param("gamma_b", ParamValue::Float(-0.3));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("colorbalance"),
            "Expected colorbalance filter, got: {}",
            filter
        );
        assert!(
            filter.contains("rm=0.5000"),
            "Expected gamma_r (rm) value, got: {}",
            filter
        );
        assert!(
            filter.contains("gm=0.5000"),
            "Expected gamma_g (gm) value, got: {}",
            filter
        );
        assert!(
            filter.contains("bm=-0.3000"),
            "Expected gamma_b (bm) value, got: {}",
            filter
        );
    }

    #[test]
    fn test_color_wheels_gain_adjustment() {
        let mut effect = Effect::new(EffectType::ColorWheels);
        effect.set_param("gain_r", ParamValue::Float(-0.4));
        effect.set_param("gain_g", ParamValue::Float(0.2));
        effect.set_param("gain_b", ParamValue::Float(0.6));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("colorbalance"),
            "Expected colorbalance filter, got: {}",
            filter
        );
        assert!(
            filter.contains("rh=-0.4000"),
            "Expected gain_r (rh) value, got: {}",
            filter
        );
        assert!(
            filter.contains("gh=0.2000"),
            "Expected gain_g (gh) value, got: {}",
            filter
        );
        assert!(
            filter.contains("bh=0.6000"),
            "Expected gain_b (bh) value, got: {}",
            filter
        );
    }

    #[test]
    fn test_color_wheels_full_adjustment() {
        let mut effect = Effect::new(EffectType::ColorWheels);
        // Lift
        effect.set_param("lift_r", ParamValue::Float(0.1));
        effect.set_param("lift_g", ParamValue::Float(0.2));
        effect.set_param("lift_b", ParamValue::Float(0.3));
        // Gamma
        effect.set_param("gamma_r", ParamValue::Float(-0.1));
        effect.set_param("gamma_g", ParamValue::Float(-0.2));
        effect.set_param("gamma_b", ParamValue::Float(-0.3));
        // Gain
        effect.set_param("gain_r", ParamValue::Float(0.4));
        effect.set_param("gain_g", ParamValue::Float(0.5));
        effect.set_param("gain_b", ParamValue::Float(0.6));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("colorbalance"),
            "Expected colorbalance filter, got: {}",
            filter
        );
        // Verify all 9 parameters are present
        assert!(filter.contains("rs=0.1000"));
        assert!(filter.contains("gs=0.2000"));
        assert!(filter.contains("bs=0.3000"));
        assert!(filter.contains("rm=-0.1000"));
        assert!(filter.contains("gm=-0.2000"));
        assert!(filter.contains("bm=-0.3000"));
        assert!(filter.contains("rh=0.4000"));
        assert!(filter.contains("gh=0.5000"));
        assert!(filter.contains("bh=0.6000"));
    }

    #[test]
    fn test_color_wheels_clamps_values() {
        let mut effect = Effect::new(EffectType::ColorWheels);
        // Values outside -1.0 to 1.0 range should be clamped
        effect.set_param("lift_r", ParamValue::Float(2.0)); // Should clamp to 1.0
        effect.set_param("lift_g", ParamValue::Float(-3.0)); // Should clamp to -1.0

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("rs=1.0000"),
            "Expected clamped rs=1.0000, got: {}",
            filter
        );
        assert!(
            filter.contains("gs=-1.0000"),
            "Expected clamped gs=-1.0000, got: {}",
            filter
        );
    }

    #[test]
    fn test_color_wheels_category() {
        let effect = Effect::new(EffectType::ColorWheels);
        assert_eq!(
            effect.category(),
            EffectCategory::Color,
            "ColorWheels should be in Color category"
        );
    }

    #[test]
    fn test_color_wheels_is_video_effect() {
        let effect = Effect::new(EffectType::ColorWheels);
        assert!(effect.is_video(), "ColorWheels should be a video effect");
        assert!(
            !effect.is_audio(),
            "ColorWheels should not be an audio effect"
        );
    }

    #[test]
    fn test_color_wheels_filter_name() {
        let effect = Effect::new(EffectType::ColorWheels);
        assert_eq!(
            effect.filter_name(),
            "colorbalance",
            "ColorWheels should use colorbalance filter"
        );
    }

    #[test]
    fn test_color_wheels_is_ffmpeg_compatible() {
        let effect = Effect::new(EffectType::ColorWheels);
        assert!(
            effect.is_ffmpeg_compatible(),
            "ColorWheels should be FFmpeg compatible"
        );
    }

    #[test]
    fn test_color_wheels_in_filter_graph() {
        let mut graph = FilterGraph::new();

        let mut color_wheels = Effect::new(EffectType::ColorWheels);
        color_wheels.set_param("lift_r", ParamValue::Float(0.2));
        color_wheels.set_param("gamma_g", ParamValue::Float(-0.1));
        color_wheels.set_param("gain_b", ParamValue::Float(0.3));

        graph.add_effect(color_wheels);

        let complex = graph.to_video_filter_complex("0:v", "vout");
        assert!(
            complex.contains("colorbalance"),
            "Expected colorbalance in filter graph, got: {}",
            complex
        );
    }

    // =========================================================================
    // Noise Reduction Tests
    // =========================================================================

    #[test]
    fn test_noise_reduction_default_params() {
        let effect = Effect::new(EffectType::NoiseReduction);

        assert_eq!(effect.get_string("algorithm"), Some("anlmdn".to_string()));
        assert_eq!(effect.get_float("strength"), Some(0.3));
        assert_eq!(effect.get_float("patch_size"), Some(7.0));
        assert_eq!(effect.get_float("research_size"), Some(15.0));
        assert_eq!(effect.get_float("noise_floor"), Some(-40.0));
    }

    #[test]
    fn test_noise_reduction_anlmdn_filter() {
        let effect = Effect::new(EffectType::NoiseReduction);

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(
            filter.contains("anlmdn"),
            "Expected anlmdn filter, got: {}",
            filter
        );
        assert!(
            filter.contains("s="),
            "Expected strength parameter, got: {}",
            filter
        );
        assert!(
            filter.contains("p="),
            "Expected patch_size parameter, got: {}",
            filter
        );
        assert!(
            filter.contains("r=15"),
            "Expected research_size parameter, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_anlmdn_strength_mapping() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("strength", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:a", "aout");
        // strength 0.5 → s = 0.0001 + 0.5 * 4.9999 = 2.5001
        assert!(
            filter.contains("s=2.5001"),
            "Expected mapped strength ~2.5, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_afftdn_filter() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("algorithm", ParamValue::String("afftdn".to_string()));
        effect.set_param("strength", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(
            filter.contains("afftdn"),
            "Expected afftdn filter, got: {}",
            filter
        );
        // strength 0.5 → nr = round(0.5 * 30) = 15
        assert!(
            filter.contains("nr=15"),
            "Expected nr=15 for strength 0.5, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_afftdn_with_noise_floor() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("algorithm", ParamValue::String("afftdn".to_string()));
        effect.set_param("strength", ParamValue::Float(0.8));
        effect.set_param("noise_floor", ParamValue::Float(-30.0));

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(
            filter.contains("nf=-30.0"),
            "Expected noise floor, got: {}",
            filter
        );
        assert!(
            filter.contains("nt=w"),
            "Expected windowed mode, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_arnndn_filter() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("algorithm", ParamValue::String("arnndn".to_string()));
        effect.set_param(
            "model_path",
            ParamValue::String("/models/rnnoise.onnx".to_string()),
        );

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(
            filter.contains("arnndn"),
            "Expected arnndn filter, got: {}",
            filter
        );
        assert!(
            filter.contains("m='/models/rnnoise.onnx'"),
            "Expected model path, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_arnndn_fallback_without_model() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("algorithm", ParamValue::String("arnndn".to_string()));
        // No model_path set (default empty)

        let filter = effect.to_filter_string("0:a", "aout");
        // Should fallback to anlmdn when no model path
        assert!(
            filter.contains("anlmdn"),
            "Should fallback to anlmdn without model, got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_ensures_odd_values() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        // Set even values - should be converted to odd
        effect.set_param("research_size", ParamValue::Float(20.0));

        let filter = effect.to_filter_string("0:a", "aout");
        assert!(
            filter.contains("r=21"),
            "Research size should be odd (20 -> 21), got: {}",
            filter
        );
    }

    #[test]
    fn test_noise_reduction_is_audio_effect() {
        let effect = Effect::new(EffectType::NoiseReduction);
        assert!(
            effect.is_audio(),
            "NoiseReduction should be an audio effect"
        );
        assert!(
            !effect.is_video(),
            "NoiseReduction should not be a video effect"
        );
    }

    #[test]
    fn test_noise_reduction_filter_name() {
        let effect = Effect::new(EffectType::NoiseReduction);
        assert_eq!(
            effect.filter_name(),
            "anlmdn",
            "NoiseReduction should use anlmdn filter"
        );
    }

    #[test]
    fn test_noise_reduction_strength_clamped() {
        let mut effect = Effect::new(EffectType::NoiseReduction);
        effect.set_param("strength", ParamValue::Float(2.0)); // Over 1.0

        let filter = effect.to_filter_string("0:a", "aout");
        // strength clamped to 1.0 → s = 0.0001 + 1.0 * 4.9999 = 5.0
        assert!(
            filter.contains("s=5.0000"),
            "Strength should be clamped to 1.0 range, got: {}",
            filter
        );
    }

    // =========================================================================
    // Chroma Key Tests
    // =========================================================================

    #[test]
    fn test_chromakey_default_params() {
        let effect = Effect::new(EffectType::ChromaKey);

        assert_eq!(effect.get_string("key_color"), Some("#00FF00".to_string()));
        assert_eq!(effect.get_float("similarity"), Some(0.3));
        assert_eq!(effect.get_float("blend"), Some(0.1));
    }

    #[test]
    fn test_chromakey_filter() {
        let effect = Effect::new(EffectType::ChromaKey);

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("chromakey"),
            "Expected chromakey filter, got: {}",
            filter
        );
        assert!(
            filter.contains("color=0x00FF00"),
            "Expected green key color, got: {}",
            filter
        );
        assert!(
            filter.contains("similarity=0.3"),
            "Expected similarity parameter, got: {}",
            filter
        );
        assert!(
            filter.contains("blend=0.1"),
            "Expected blend parameter, got: {}",
            filter
        );
    }

    #[test]
    fn test_chromakey_blue_screen() {
        let mut effect = Effect::new(EffectType::ChromaKey);
        effect.set_param("key_color", ParamValue::String("#0000FF".to_string()));
        effect.set_param("similarity", ParamValue::Float(0.4));
        effect.set_param("blend", ParamValue::Float(0.2));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("color=0x0000FF"),
            "Expected blue key color, got: {}",
            filter
        );
        assert!(
            filter.contains("similarity=0.4"),
            "Expected custom similarity, got: {}",
            filter
        );
        assert!(
            filter.contains("blend=0.2"),
            "Expected custom blend, got: {}",
            filter
        );
    }

    #[test]
    fn test_chromakey_is_video_effect() {
        let effect = Effect::new(EffectType::ChromaKey);
        assert!(effect.is_video(), "ChromaKey should be a video effect");
        assert!(
            !effect.is_audio(),
            "ChromaKey should not be an audio effect"
        );
    }

    #[test]
    fn test_chromakey_filter_name() {
        let effect = Effect::new(EffectType::ChromaKey);
        assert_eq!(
            effect.filter_name(),
            "chromakey",
            "ChromaKey should use chromakey filter"
        );
    }

    #[test]
    fn test_chromakey_category() {
        let effect = Effect::new(EffectType::ChromaKey);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::Keying,
            "ChromaKey should be in Keying category"
        );
    }

    #[test]
    fn test_chromakey_with_spill_suppression() {
        let mut effect = Effect::new(EffectType::ChromaKey);
        effect.set_param("spill_suppression", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("colorbalance=gm=-0.5"),
            "Filter should contain colorbalance for spill suppression, got: {}",
            filter
        );
    }

    #[test]
    fn test_chromakey_with_edge_feather() {
        let mut effect = Effect::new(EffectType::ChromaKey);
        effect.set_param("edge_feather", ParamValue::Float(2.5));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("boxblur=0:1:0:1:2.5:1"),
            "Filter should contain alpha-only boxblur for edge feather, got: {}",
            filter
        );
    }

    #[test]
    fn test_chromakey_defaults_unchanged() {
        let effect = Effect::new(EffectType::ChromaKey);

        let filter = effect.to_filter_string("0:v", "vout");
        // Default spill_suppression=0 and edge_feather=0 should not add extra filters
        assert!(
            !filter.contains("colorbalance"),
            "Default filter should not contain colorbalance, got: {}",
            filter
        );
        assert!(
            !filter.contains("boxblur"),
            "Default filter should not contain boxblur, got: {}",
            filter
        );
    }

    // =========================================================================
    // Luma Key Tests
    // =========================================================================

    #[test]
    fn test_lumakey_default_params() {
        let effect = Effect::new(EffectType::LumaKey);

        assert_eq!(effect.get_float("threshold"), Some(0.1));
        assert_eq!(effect.get_float("tolerance"), Some(0.1));
        assert_eq!(effect.get_float("softness"), Some(0.0));
    }

    #[test]
    fn test_lumakey_filter() {
        let effect = Effect::new(EffectType::LumaKey);

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("lumakey"),
            "Expected lumakey filter, got: {}",
            filter
        );
        assert!(
            filter.contains("threshold=0.1"),
            "Expected threshold parameter, got: {}",
            filter
        );
        assert!(
            filter.contains("tolerance=0.1"),
            "Expected tolerance parameter, got: {}",
            filter
        );
        assert!(
            filter.contains("softness=0"),
            "Expected softness parameter, got: {}",
            filter
        );
    }

    #[test]
    fn test_lumakey_custom_params() {
        let mut effect = Effect::new(EffectType::LumaKey);
        effect.set_param("threshold", ParamValue::Float(0.5));
        effect.set_param("tolerance", ParamValue::Float(0.3));
        effect.set_param("softness", ParamValue::Float(0.2));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("threshold=0.5"),
            "Expected custom threshold, got: {}",
            filter
        );
        assert!(
            filter.contains("tolerance=0.3"),
            "Expected custom tolerance, got: {}",
            filter
        );
        assert!(
            filter.contains("softness=0.2"),
            "Expected custom softness, got: {}",
            filter
        );
    }

    #[test]
    fn test_lumakey_is_video_effect() {
        let effect = Effect::new(EffectType::LumaKey);
        assert!(effect.is_video(), "LumaKey should be a video effect");
        assert!(!effect.is_audio(), "LumaKey should not be an audio effect");
    }

    #[test]
    fn test_lumakey_filter_name() {
        let effect = Effect::new(EffectType::LumaKey);
        assert_eq!(
            effect.filter_name(),
            "lumakey",
            "LumaKey should use lumakey filter"
        );
    }

    #[test]
    fn test_lumakey_category() {
        let effect = Effect::new(EffectType::LumaKey);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::Keying,
            "LumaKey should be in Keying category"
        );
    }

    #[test]
    fn test_lumakey_clamps_values() {
        let mut effect = Effect::new(EffectType::LumaKey);
        effect.set_param("threshold", ParamValue::Float(1.5)); // Too high
        effect.set_param("tolerance", ParamValue::Float(-0.5)); // Too low
        effect.set_param("softness", ParamValue::Float(2.0)); // Too high

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("threshold=1"),
            "Threshold should be clamped to 1.0, got: {}",
            filter
        );
        assert!(
            filter.contains("tolerance=0"),
            "Tolerance should be clamped to 0.0, got: {}",
            filter
        );
        assert!(
            filter.contains("softness=1"),
            "Softness should be clamped to 1.0, got: {}",
            filter
        );
    }

    // =========================================================================
    // Opacity Tests
    // =========================================================================

    #[test]
    fn test_opacity_default_params() {
        let effect = Effect::new(EffectType::Opacity);
        assert_eq!(effect.get_float("value"), Some(1.0));
    }

    #[test]
    fn test_opacity_full_returns_null() {
        let effect = Effect::new(EffectType::Opacity);

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("null"),
            "Full opacity should return null filter, got: {}",
            filter
        );
    }

    #[test]
    fn test_opacity_partial() {
        let mut effect = Effect::new(EffectType::Opacity);
        effect.set_param("value", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("colorchannelmixer"),
            "Partial opacity should use colorchannelmixer, got: {}",
            filter
        );
        assert!(
            filter.contains("aa=0.5"),
            "Should set alpha to 0.5, got: {}",
            filter
        );
    }

    #[test]
    fn test_opacity_zero() {
        let mut effect = Effect::new(EffectType::Opacity);
        effect.set_param("value", ParamValue::Float(0.0));

        let filter = effect.to_filter_string("0:v", "vout");
        assert!(
            filter.contains("geq=a=0"),
            "Zero opacity should set alpha to 0, got: {}",
            filter
        );
    }

    #[test]
    fn test_opacity_is_video_effect() {
        let effect = Effect::new(EffectType::Opacity);
        assert!(effect.is_video(), "Opacity should be a video effect");
        assert!(!effect.is_audio(), "Opacity should not be an audio effect");
    }

    #[test]
    fn test_opacity_category() {
        let effect = Effect::new(EffectType::Opacity);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::Compositing,
            "Opacity should be in Compositing category"
        );
    }

    // =========================================================================
    // Blend Mode Tests
    // =========================================================================

    #[test]
    fn test_blend_mode_default_params() {
        let effect = Effect::new(EffectType::BlendMode);
        assert_eq!(effect.get_string("mode"), Some("normal".to_string()));
        assert_eq!(effect.get_float("opacity"), Some(1.0));
    }

    #[test]
    fn test_blend_mode_filter_params() {
        let effect = Effect::new(EffectType::BlendMode);
        let params = effect.build_blend_filter_params();

        assert!(
            params.contains("all_mode=normal"),
            "Expected normal blend mode, got: {}",
            params
        );
        assert!(
            params.contains("all_opacity=1"),
            "Expected full opacity, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_multiply() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("multiply".to_string()));
        effect.set_param("opacity", ParamValue::Float(0.8));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=multiply"),
            "Expected multiply blend mode, got: {}",
            params
        );
        assert!(
            params.contains("all_opacity=0.8"),
            "Expected 0.8 opacity, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_screen() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("screen".to_string()));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=screen"),
            "Expected screen blend mode, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_overlay() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("overlay".to_string()));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=overlay"),
            "Expected overlay blend mode, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_add() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("add".to_string()));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=addition"),
            "Expected addition blend mode for 'add', got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_difference() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("difference".to_string()));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=difference"),
            "Expected difference blend mode, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_unknown_defaults_to_normal() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("invalid_mode".to_string()));

        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=normal"),
            "Unknown mode should default to normal, got: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_is_video_effect() {
        let effect = Effect::new(EffectType::BlendMode);
        assert!(effect.is_video(), "BlendMode should be a video effect");
        assert!(
            !effect.is_audio(),
            "BlendMode should not be an audio effect"
        );
    }

    #[test]
    fn test_blend_mode_category() {
        let effect = Effect::new(EffectType::BlendMode);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::Compositing,
            "BlendMode should be in Compositing category"
        );
    }

    #[test]
    fn test_blend_mode_filter_name() {
        let effect = Effect::new(EffectType::BlendMode);
        assert_eq!(
            effect.filter_name(),
            "blend",
            "BlendMode should use blend filter"
        );
    }

    #[test]
    fn test_blend_mode_color_burn() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("color_burn".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=burn"),
            "color_burn → burn: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_color_dodge() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("color_dodge".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=dodge"),
            "color_dodge → dodge: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_linear_burn() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("linear_burn".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=linearburn"),
            "linear_burn → linearburn: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_linear_dodge_maps_to_addition() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("linear_dodge".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=addition"),
            "linear_dodge → addition: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_vivid_light() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("vivid_light".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=vividlight"),
            "vivid_light → vividlight: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_linear_light() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("linear_light".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=linearlight"),
            "linear_light → linearlight: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_pin_light() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("pin_light".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=pinlight"),
            "pin_light → pinlight: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_exclusion() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("exclusion".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(
            params.contains("all_mode=exclusion"),
            "exclusion: {}",
            params
        );
    }

    #[test]
    fn test_blend_mode_subtract() {
        let mut effect = Effect::new(EffectType::BlendMode);
        effect.set_param("mode", ParamValue::String("subtract".to_string()));
        let params = effect.build_blend_filter_params();
        assert!(params.contains("all_mode=subtract"), "subtract: {}", params);
    }

    // =========================================================================
    // HSL Qualifier Tests
    // =========================================================================

    #[test]
    fn test_hsl_qualifier_default_params() {
        let effect = Effect::new(EffectType::HSLQualifier);

        // Verify default parameters
        assert_eq!(effect.get_float("hue_center"), Some(120.0));
        assert_eq!(effect.get_float("hue_width"), Some(30.0));
        assert_eq!(effect.get_float("sat_min"), Some(0.2));
        assert_eq!(effect.get_float("sat_max"), Some(1.0));
        assert_eq!(effect.get_float("lum_min"), Some(0.0));
        assert_eq!(effect.get_float("lum_max"), Some(1.0));
        assert_eq!(effect.get_float("softness"), Some(0.1));
        assert_eq!(effect.get_float("hue_shift"), Some(0.0));
        assert_eq!(effect.get_float("sat_adjust"), Some(0.0));
        assert_eq!(effect.get_float("lum_adjust"), Some(0.0));
        assert_eq!(effect.get_bool("invert"), Some(false));
    }

    #[test]
    fn test_hsl_qualifier_param_definitions() {
        let effect = Effect::new(EffectType::HSLQualifier);
        let defs = effect.param_definitions();

        // Should have 11 parameters
        assert_eq!(defs.len(), 11, "HSLQualifier should have 11 parameters");

        // Verify key parameter names exist
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"hue_center"));
        assert!(names.contains(&"hue_width"));
        assert!(names.contains(&"sat_min"));
        assert!(names.contains(&"sat_max"));
        assert!(names.contains(&"hue_shift"));
        assert!(names.contains(&"invert"));
    }

    #[test]
    fn test_hsl_qualifier_no_adjustment_returns_null() {
        let effect = Effect::new(EffectType::HSLQualifier);

        let filter = effect.to_filter_string("in", "out");
        // No adjustments (hue_shift, sat_adjust, lum_adjust all 0) -> null
        assert!(
            filter.contains("null"),
            "Expected null filter for no adjustments, got: {}",
            filter
        );
    }

    #[test]
    fn test_hsl_qualifier_with_hue_shift() {
        let mut effect = Effect::new(EffectType::HSLQualifier);
        effect.set_param("hue_shift", ParamValue::Float(30.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("hue=h=30"),
            "Expected hue shift in filter, got: {}",
            filter
        );
    }

    #[test]
    fn test_hsl_qualifier_with_saturation_adjust() {
        let mut effect = Effect::new(EffectType::HSLQualifier);
        effect.set_param("sat_adjust", ParamValue::Float(0.5));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("hue=s=1.5"),
            "Expected saturation multiplier 1.5, got: {}",
            filter
        );
    }

    #[test]
    fn test_hsl_qualifier_with_brightness_adjust() {
        let mut effect = Effect::new(EffectType::HSLQualifier);
        effect.set_param("lum_adjust", ParamValue::Float(0.2));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("hue=b=0.2"),
            "Expected brightness adjust, got: {}",
            filter
        );
    }

    #[test]
    fn test_hsl_qualifier_category() {
        let effect = Effect::new(EffectType::HSLQualifier);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::AdvancedColor,
            "HSLQualifier should be in AdvancedColor category"
        );
    }

    #[test]
    fn test_hsl_qualifier_filter_name() {
        let effect = Effect::new(EffectType::HSLQualifier);
        assert_eq!(
            effect.filter_name(),
            "hue",
            "HSLQualifier should use hue filter"
        );
    }

    #[test]
    fn test_hsl_qualifier_is_video() {
        let effect = Effect::new(EffectType::HSLQualifier);
        assert!(effect.is_video(), "HSLQualifier should be a video effect");
        assert!(!effect.is_audio());
    }

    #[test]
    fn test_hsl_qualifier_combined_adjustments() {
        let mut effect = Effect::new(EffectType::HSLQualifier);
        effect.set_param("hue_shift", ParamValue::Float(-45.0));
        effect.set_param("sat_adjust", ParamValue::Float(-0.3));

        let filter = effect.to_filter_string("in", "out");
        assert!(
            filter.contains("hue="),
            "Expected hue filter, got: {}",
            filter
        );
        assert!(
            filter.contains("h=-45"),
            "Expected hue shift -45, got: {}",
            filter
        );
        assert!(
            filter.contains("s=0.7"),
            "Expected saturation 0.7 (1.0 - 0.3), got: {}",
            filter
        );
    }

    // =========================================================================
    // Loudness Normalize Tests
    // =========================================================================

    #[test]
    fn test_loudness_normalize_default_params() {
        let effect = Effect::new(EffectType::LoudnessNormalize);

        // Verify default parameters (streaming standard)
        assert_eq!(effect.get_float("target_lufs"), Some(-14.0));
        assert_eq!(effect.get_float("target_lra"), Some(11.0));
        assert_eq!(effect.get_float("target_tp"), Some(-1.0));
    }

    #[test]
    fn test_loudness_normalize_param_definitions() {
        let effect = Effect::new(EffectType::LoudnessNormalize);
        let defs = effect.param_definitions();

        assert_eq!(defs.len(), 4, "LoudnessNormalize should have 4 parameters");

        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains(&"target_lufs"));
        assert!(names.contains(&"target_lra"));
        assert!(names.contains(&"target_tp"));
        assert!(names.contains(&"print_format"));
    }

    #[test]
    fn test_loudness_normalize_default_filter() {
        let effect = Effect::new(EffectType::LoudnessNormalize);

        let filter = effect.to_filter_string("0:a", "out");
        assert!(
            filter.contains("loudnorm"),
            "Expected loudnorm filter, got: {}",
            filter
        );
        assert!(
            filter.contains("I=-14.0"),
            "Expected -14 LUFS target, got: {}",
            filter
        );
        assert!(
            filter.contains("LRA=11.0"),
            "Expected 11 LU LRA, got: {}",
            filter
        );
        assert!(
            filter.contains("TP=-1.0"),
            "Expected -1 dBTP true peak, got: {}",
            filter
        );
    }

    #[test]
    fn test_loudness_normalize_broadcast_settings() {
        let mut effect = Effect::new(EffectType::LoudnessNormalize);
        // EBU R128 broadcast standard
        effect.set_param("target_lufs", ParamValue::Float(-24.0));
        effect.set_param("target_lra", ParamValue::Float(7.0));
        effect.set_param("target_tp", ParamValue::Float(-3.0));

        let filter = effect.to_filter_string("0:a", "out");
        assert!(
            filter.contains("I=-24.0"),
            "Expected -24 LUFS for broadcast, got: {}",
            filter
        );
        assert!(
            filter.contains("LRA=7.0"),
            "Expected 7 LU LRA, got: {}",
            filter
        );
        assert!(
            filter.contains("TP=-3.0"),
            "Expected -3 dBTP, got: {}",
            filter
        );
    }

    #[test]
    fn test_loudness_normalize_json_format() {
        let mut effect = Effect::new(EffectType::LoudnessNormalize);
        effect.set_param("print_format", ParamValue::String("json".to_string()));

        let filter = effect.to_filter_string("0:a", "out");
        assert!(
            filter.contains("print_format=json"),
            "Expected json format, got: {}",
            filter
        );
    }

    #[test]
    fn test_loudness_normalize_clamps_values() {
        let mut effect = Effect::new(EffectType::LoudnessNormalize);
        // Values outside valid range should be clamped
        effect.set_param("target_lufs", ParamValue::Float(-100.0)); // Below -70
        effect.set_param("target_tp", ParamValue::Float(5.0)); // Above 0

        let filter = effect.to_filter_string("0:a", "out");
        assert!(
            filter.contains("I=-70.0"),
            "Expected clamped LUFS -70, got: {}",
            filter
        );
        assert!(
            filter.contains("TP=0.0"),
            "Expected clamped TP 0, got: {}",
            filter
        );
    }

    #[test]
    fn test_loudness_normalize_category() {
        let effect = Effect::new(EffectType::LoudnessNormalize);
        assert_eq!(
            effect.category(),
            super::super::EffectCategory::Audio,
            "LoudnessNormalize should be in Audio category"
        );
    }

    #[test]
    fn test_loudness_normalize_is_audio() {
        let effect = Effect::new(EffectType::LoudnessNormalize);
        assert!(
            effect.is_audio(),
            "LoudnessNormalize should be an audio effect"
        );
        assert!(!effect.is_video());
    }

    #[test]
    fn test_loudness_normalize_filter_name() {
        let effect = Effect::new(EffectType::LoudnessNormalize);
        assert_eq!(
            effect.filter_name(),
            "loudnorm",
            "LoudnessNormalize should use loudnorm filter"
        );
    }

    // -------------------------------------------------------------------------
    // RGB Color Curves Filter Tests (BDD-style)
    // -------------------------------------------------------------------------

    #[test]
    fn should_produce_null_filter_when_all_curves_are_identity() {
        // Given a default Curves effect (all identity curves)
        let effect = Effect::new(EffectType::Curves);

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should be a no-op (null pass-through)
        assert_eq!(filter, "[0:v]null[out]");
    }

    #[test]
    fn should_produce_valid_filter_for_s_curve_contrast() {
        // Given a Curves effect with an S-curve on the master channel
        let mut effect = Effect::new(EffectType::Curves);
        let s_curve = vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(0.25, 0.15), // darken shadows
            CurvePoint::new(0.75, 0.85), // brighten highlights
            CurvePoint::new(1.0, 1.0),
        ];
        let json = curve_points_to_json(&s_curve);
        effect.set_param("master_curve", ParamValue::String(json));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should contain the curves filter with master channel
        assert!(
            filter.contains("curves=master='"),
            "Expected curves=master filter, got: {}",
            filter
        );
        assert!(
            filter.contains("0.2500/0.1500"),
            "Expected shadow point, got: {}",
            filter
        );
        assert!(
            filter.contains("0.7500/0.8500"),
            "Expected highlight point, got: {}",
            filter
        );
        // Other channels should NOT appear (they are identity)
        // Use `:r='` prefix to distinguish from `master='` which ends with `r='`
        assert!(!filter.contains(":r='"), "Red channel should not appear");
        assert!(!filter.contains(":g='"), "Green channel should not appear");
        assert!(!filter.contains(":b='"), "Blue channel should not appear");
    }

    #[test]
    fn should_apply_individual_channel_curves_independently() {
        // Given a Curves effect with only the red channel modified
        let mut effect = Effect::new(EffectType::Curves);
        let red_boost = vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(0.5, 0.7), // boost red midtones
            CurvePoint::new(1.0, 1.0),
        ];
        let json = curve_points_to_json(&red_boost);
        effect.set_param("red_curve", ParamValue::String(json));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then only the red channel should appear
        assert!(
            filter.contains("r='"),
            "Expected red channel in filter, got: {}",
            filter
        );
        assert!(
            filter.contains("0.5000/0.7000"),
            "Expected red midtone boost, got: {}",
            filter
        );
        // Master, green, blue should NOT appear
        assert!(
            !filter.contains("master='"),
            "Master should not appear: {}",
            filter
        );
        assert!(
            !filter.contains(":g='"),
            "Green should not appear: {}",
            filter
        );
        assert!(
            !filter.contains(":b='"),
            "Blue should not appear: {}",
            filter
        );
    }

    #[test]
    fn should_handle_all_channels_modified_simultaneously() {
        // Given a Curves effect with all four channels modified
        let mut effect = Effect::new(EffectType::Curves);
        let curve = vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(0.5, 0.6),
            CurvePoint::new(1.0, 1.0),
        ];
        let json = curve_points_to_json(&curve);
        effect.set_param("master_curve", ParamValue::String(json.clone()));
        effect.set_param("red_curve", ParamValue::String(json.clone()));
        effect.set_param("green_curve", ParamValue::String(json.clone()));
        effect.set_param("blue_curve", ParamValue::String(json));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then all four channels should appear
        assert!(filter.contains("master='"), "Missing master: {}", filter);
        assert!(filter.contains("r='"), "Missing red: {}", filter);
        assert!(filter.contains("g='"), "Missing green: {}", filter);
        assert!(filter.contains("b='"), "Missing blue: {}", filter);
        assert!(filter.starts_with("[0:v]curves="));
    }

    #[test]
    fn should_fallback_to_identity_for_malformed_curve_json() {
        // Given a Curves effect with a malformed red curve
        let mut effect = Effect::new(EffectType::Curves);
        effect.set_param(
            "red_curve",
            ParamValue::String("not valid json".to_string()),
        );

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then the malformed channel falls back to identity → null output
        // (all channels are identity: master=default, red=fallback-identity, g/b=default)
        assert_eq!(filter, "[0:v]null[out]");
    }

    #[test]
    fn should_report_curves_filter_name() {
        let effect = Effect::new(EffectType::Curves);
        assert_eq!(effect.filter_name(), "curves");
    }

    #[test]
    fn should_classify_curves_as_color_video_effect() {
        let effect = Effect::new(EffectType::Curves);
        assert!(effect.is_video());
        assert!(!effect.is_audio());
        assert!(effect.is_ffmpeg_compatible());
        assert_eq!(effect.category(), EffectCategory::Color);
    }

    // -------------------------------------------------------------------------
    // Advanced Curves Filter Tests (H/H, H/S, L/S) — BDD-style
    // -------------------------------------------------------------------------

    #[test]
    fn should_produce_null_filter_when_all_advanced_curves_are_flat_identity() {
        // Given a Curves effect with default params (all identity + all flat)
        let effect = Effect::new(EffectType::Curves);

        // Then the filter should be null (no processing needed)
        let filter = effect.to_filter_string("0:v", "out");
        assert_eq!(filter, "[0:v]null[out]");
    }

    #[test]
    fn should_treat_missing_advanced_curves_as_flat_identity() {
        // Given a legacy Curves effect saved before advanced curves existed
        let mut effect = Effect::new(EffectType::Curves);
        effect.params.remove("hue_vs_hue_curve");
        effect.params.remove("hue_vs_sat_curve");
        effect.params.remove("luma_vs_sat_curve");

        // Then it should remain a no-op instead of applying unintended color shifts
        let filter = effect.to_filter_string("0:v", "out");
        assert_eq!(filter, "[0:v]null[out]");
    }

    #[test]
    fn should_treat_malformed_advanced_curves_as_flat_identity() {
        // Given malformed advanced curve payloads
        let mut effect = Effect::new(EffectType::Curves);
        effect.set_param(
            "hue_vs_sat_curve",
            ParamValue::String("{not valid json}".to_string()),
        );
        effect.set_param("hue_vs_hue_curve", ParamValue::String("42".to_string()));
        effect.set_param("luma_vs_sat_curve", ParamValue::String("[]".to_string()));

        // Then malformed advanced curves should be treated as neutral
        let filter = effect.to_filter_string("0:v", "out");
        assert_eq!(filter, "[0:v]null[out]");
    }

    #[test]
    fn should_generate_selectivecolor_for_hue_vs_sat_curve() {
        // Given a Curves effect with H/S curve boosting red saturation
        let mut effect = Effect::new(EffectType::Curves);
        // Curve: reds (x=0) at y=0.8 (saturate), rest at y=0.5 (no change)
        let hvs_curve =
            serde_json::to_string(&vec![CurvePoint::new(0.0, 0.8), CurvePoint::new(1.0, 0.5)])
                .unwrap();
        effect.set_param("hue_vs_sat_curve", ParamValue::String(hvs_curve));

        // Then filter should include selectivecolor with reds adjustment
        let filter = effect.to_filter_string("0:v", "out");
        assert!(
            filter.contains("selectivecolor="),
            "Expected selectivecolor filter, got: {}",
            filter
        );
        assert!(
            filter.contains("reds="),
            "Expected reds range, got: {}",
            filter
        );
    }

    #[test]
    fn should_generate_selectivecolor_for_hue_vs_hue_curve() {
        // Given a Curves effect with H/H curve shifting reds clockwise toward yellow
        let mut effect = Effect::new(EffectType::Curves);
        // Curve: reds (x=0) at y=0.8 (clockwise shift), rest at y=0.5
        let hvh_curve =
            serde_json::to_string(&vec![CurvePoint::new(0.0, 0.8), CurvePoint::new(1.0, 0.5)])
                .unwrap();
        effect.set_param("hue_vs_hue_curve", ParamValue::String(hvh_curve));

        // Then filter should include selectivecolor for hue shifting
        let filter = effect.to_filter_string("0:v", "out");
        assert!(
            filter.contains("selectivecolor="),
            "Expected selectivecolor filter, got: {}",
            filter
        );
        assert!(
            filter.contains("reds="),
            "Expected reds range adjustment, got: {}",
            filter
        );
    }

    #[test]
    fn should_generate_per_luma_saturation_expression_for_luma_vs_sat_curve() {
        // Given a Curves effect with more saturation in shadows and less in highlights
        let mut effect = Effect::new(EffectType::Curves);
        let lvs_curve = serde_json::to_string(&vec![
            CurvePoint::new(0.0, 0.75),
            CurvePoint::new(1.0, 0.25),
        ])
        .unwrap();
        effect.set_param("luma_vs_sat_curve", ParamValue::String(lvs_curve));

        // Then the filter should preserve per-luma behavior instead of collapsing to one value
        let filter = effect.to_filter_string("0:v", "out");
        assert!(
            filter.contains("geq="),
            "Expected geq-based luma-selective saturation, got: {}",
            filter
        );
        assert!(
            filter.contains("lum(X,Y)/255"),
            "Expected luma-dependent expression, got: {}",
            filter
        );
        assert!(
            !filter.contains("eq=saturation="),
            "Expected luma-selective saturation instead of global eq saturation, got: {}",
            filter
        );
    }

    #[test]
    fn should_chain_rgb_curves_with_advanced_curves() {
        // Given a Curves effect with both master S-curve and H/S desaturation
        let mut effect = Effect::new(EffectType::Curves);

        // Master S-curve
        let s_curve = serde_json::to_string(&vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(0.25, 0.15),
            CurvePoint::new(0.75, 0.85),
            CurvePoint::new(1.0, 1.0),
        ])
        .unwrap();
        effect.set_param("master_curve", ParamValue::String(s_curve));

        // H/S: desaturate blues
        let hvs_curve = serde_json::to_string(&vec![
            CurvePoint::new(0.0, 0.5),
            CurvePoint::new(4.0 / 6.0, 0.2),
            CurvePoint::new(1.0, 0.5),
        ])
        .unwrap();
        effect.set_param("hue_vs_sat_curve", ParamValue::String(hvs_curve));

        // Then filter should chain curves and selectivecolor with comma
        let filter = effect.to_filter_string("0:v", "out");
        assert!(
            filter.contains("curves="),
            "Expected curves filter, got: {}",
            filter
        );
        assert!(
            filter.contains(",selectivecolor="),
            "Expected chained selectivecolor, got: {}",
            filter
        );
    }

    #[test]
    fn should_handle_hue_vs_hue_counter_clockwise_shift() {
        // Given a H/H curve that shifts reds counter-clockwise (toward magenta)
        let mut effect = Effect::new(EffectType::Curves);
        let hvh_curve =
            serde_json::to_string(&vec![CurvePoint::new(0.0, 0.2), CurvePoint::new(1.0, 0.5)])
                .unwrap();
        effect.set_param("hue_vs_hue_curve", ParamValue::String(hvh_curve));

        // Then filter should produce selectivecolor with negative delta for reds
        let filter = effect.to_filter_string("0:v", "out");
        assert!(
            filter.contains("selectivecolor="),
            "Expected selectivecolor, got: {}",
            filter
        );
        // Counter-clockwise reds → magenta: -Y component (negative y value)
        assert!(
            filter.contains("reds="),
            "Expected reds adjustment, got: {}",
            filter
        );
    }

    #[test]
    fn should_produce_desaturation_selectivecolor_for_low_hue_vs_sat() {
        // Given H/S curve that desaturates greens (y=0.2 at green position)
        let mut effect = Effect::new(EffectType::Curves);
        let hvs_curve = serde_json::to_string(&vec![
            CurvePoint::new(0.0, 0.5),
            CurvePoint::new(2.0 / 6.0, 0.2),
            CurvePoint::new(1.0, 0.5),
        ])
        .unwrap();
        effect.set_param("hue_vs_sat_curve", ParamValue::String(hvs_curve));

        let filter = effect.to_filter_string("0:v", "out");
        // Desaturation of greens → positive magenta value (add complement)
        assert!(
            filter.contains("greens="),
            "Expected greens adjustment, got: {}",
            filter
        );
    }

    // -------------------------------------------------------------------------
    // Temperature/Tint Filter Tests (BDD-style)
    // -------------------------------------------------------------------------

    #[test]
    fn should_create_default_temperature_tint_effect_with_neutral_values() {
        // Given a new TemperatureTint effect
        let effect = Effect::new(EffectType::TemperatureTint);

        // Then temperature and tint should both be 0.0 (neutral)
        assert_eq!(
            effect.get_float("temperature"),
            Some(0.0),
            "Default temperature should be 0.0"
        );
        assert_eq!(
            effect.get_float("tint"),
            Some(0.0),
            "Default tint should be 0.0"
        );
    }

    #[test]
    fn should_produce_null_filter_when_both_temperature_and_tint_are_zero() {
        // Given a TemperatureTint effect with default (neutral) values
        let effect = Effect::new(EffectType::TemperatureTint);

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should be a no-op (null pass-through)
        assert_eq!(
            filter, "[0:v]null[out]",
            "Neutral temperature/tint should produce null filter"
        );
    }

    #[test]
    fn should_produce_warm_colorbalance_filter_when_temperature_is_positive() {
        // Given a TemperatureTint effect with positive temperature (warm)
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(50.0));
        effect.set_param("tint", ParamValue::Float(0.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should contain colorbalance with positive red and negative blue
        assert!(
            filter.contains("colorbalance="),
            "Expected colorbalance filter, got: {}",
            filter
        );

        // Parse the filter to check red (positive) and blue (negative) values
        // temp_norm = 50/100 = 0.5
        // rs = 0.5 * 0.3 = 0.15, rm = 0.5 * 0.5 = 0.25, rh = 0.5 * 0.2 = 0.10
        assert!(
            filter.contains("rs=0.1500"),
            "Expected positive red shadows, got: {}",
            filter
        );
        assert!(
            filter.contains("rm=0.2500"),
            "Expected positive red midtones, got: {}",
            filter
        );
        // bs = -0.5 * 0.3 = -0.15, bm = -0.5 * 0.5 = -0.25
        assert!(
            filter.contains("bs=-0.1500"),
            "Expected negative blue shadows, got: {}",
            filter
        );
        assert!(
            filter.contains("bm=-0.2500"),
            "Expected negative blue midtones, got: {}",
            filter
        );
    }

    #[test]
    fn should_produce_cool_colorbalance_filter_when_temperature_is_negative() {
        // Given a TemperatureTint effect with negative temperature (cool)
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(-50.0));
        effect.set_param("tint", ParamValue::Float(0.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should contain colorbalance with negative red and positive blue
        // temp_norm = -0.5
        // rs = -0.5 * 0.3 = -0.15
        assert!(
            filter.contains("rs=-0.1500"),
            "Expected negative red shadows for cool, got: {}",
            filter
        );
        // bs = -(-0.5) * 0.3 = 0.15
        assert!(
            filter.contains("bs=0.1500"),
            "Expected positive blue shadows for cool, got: {}",
            filter
        );
        // bm = -(-0.5) * 0.5 = 0.25
        assert!(
            filter.contains("bm=0.2500"),
            "Expected positive blue midtones for cool, got: {}",
            filter
        );
    }

    #[test]
    fn should_produce_magenta_tint_when_tint_is_positive() {
        // Given a TemperatureTint effect with positive tint (magenta)
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(0.0));
        effect.set_param("tint", ParamValue::Float(50.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then green channels should be negative (reducing green = magenta shift)
        // tint_norm = 0.5, gs = -0.5 * 0.3 = -0.15, gm = -0.5 * 0.5 = -0.25
        assert!(
            filter.contains("gs=-0.1500"),
            "Expected negative green shadows for magenta, got: {}",
            filter
        );
        assert!(
            filter.contains("gm=-0.2500"),
            "Expected negative green midtones for magenta, got: {}",
            filter
        );
    }

    #[test]
    fn should_produce_green_tint_when_tint_is_negative() {
        // Given a TemperatureTint effect with negative tint (green)
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(0.0));
        effect.set_param("tint", ParamValue::Float(-50.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then green channels should be positive (boosting green)
        // tint_norm = -0.5, gs = -(-0.5) * 0.3 = 0.15, gm = -(-0.5) * 0.5 = 0.25
        assert!(
            filter.contains("gs=0.1500"),
            "Expected positive green shadows for green tint, got: {}",
            filter
        );
        assert!(
            filter.contains("gm=0.2500"),
            "Expected positive green midtones for green tint, got: {}",
            filter
        );
    }

    #[test]
    fn should_combine_temperature_and_tint_in_a_single_filter() {
        // Given a TemperatureTint effect with both temperature and tint set
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(50.0));
        effect.set_param("tint", ParamValue::Float(-30.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then it should produce a single colorbalance filter with both adjustments
        assert!(
            filter.contains("colorbalance="),
            "Expected colorbalance filter, got: {}",
            filter
        );

        // Temperature: warm (positive red, negative blue)
        // temp_norm = 0.5, rs = 0.15
        assert!(
            filter.contains("rs=0.1500"),
            "Expected warm red from temperature, got: {}",
            filter
        );
        // Tint: green (positive green)
        // tint_norm = -0.3, gs = -(-0.3) * 0.3 = 0.09
        assert!(
            filter.contains("gs=0.0900"),
            "Expected green tint adjustment, got: {}",
            filter
        );

        // Should be a single filter, not chained
        let filter_body = effect.to_filter_body();
        assert!(
            filter_body.starts_with("colorbalance="),
            "Filter body should be a single colorbalance"
        );
        assert!(
            !filter_body.contains(','),
            "Should not chain multiple filters"
        );
    }

    #[test]
    fn should_clamp_extreme_values_to_valid_range() {
        // Given a TemperatureTint effect with out-of-range temperature
        let mut effect = Effect::new(EffectType::TemperatureTint);
        effect.set_param("temperature", ParamValue::Float(200.0));
        effect.set_param("tint", ParamValue::Float(0.0));

        // When building the filter
        let filter = effect.to_filter_string("0:v", "out");

        // Then values should be clamped to 100 (temp_norm = 1.0)
        // rs = 1.0 * 0.3 = 0.30, rm = 1.0 * 0.5 = 0.50, rh = 1.0 * 0.2 = 0.20
        assert!(
            filter.contains("rs=0.3000"),
            "Expected clamped red shadows, got: {}",
            filter
        );
        assert!(
            filter.contains("rm=0.5000"),
            "Expected clamped red midtones, got: {}",
            filter
        );
        assert!(
            filter.contains("rh=0.2000"),
            "Expected clamped red highlights, got: {}",
            filter
        );
        // bs = -1.0 * 0.3 = -0.30
        assert!(
            filter.contains("bs=-0.3000"),
            "Expected clamped blue shadows, got: {}",
            filter
        );
    }
}
