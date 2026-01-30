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

use super::{Effect, EffectType};

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
    escape_ffmpeg_filter_value(raw).replace('%', r"\%")
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
            EffectType::Gamma => "eq",
            EffectType::Levels => "levels",
            EffectType::Curves => "curves",
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

            // Text
            EffectType::TextOverlay => self.build_drawtext_filter(),
            EffectType::Subtitle => self.build_subtitle_filter(),

            // Color grading
            EffectType::Lut => self.build_lut_filter(),

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

        // Calculate total frames for the duration
        let total_frames = (duration * fps as f64) as i64;

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

    // -------------------------------------------------------------------------
    // Text Effect Builders
    // -------------------------------------------------------------------------

    fn build_drawtext_filter(&self) -> String {
        let text = self
            .get_param("text")
            .and_then(|v| v.as_str())
            .unwrap_or("Text");
        let font_size = self.get_float("font_size").unwrap_or(48.0) as i64;
        let x = self.get_float("x").unwrap_or(0.0) as i64;
        let y = self.get_float("y").unwrap_or(0.0) as i64;

        let escaped_text = escape_drawtext_value(text);

        format!(
            "drawtext=text='{}':fontsize={}:x={}:y={}:fontcolor=white",
            escaped_text, font_size, x, y
        )
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
    use crate::core::effects::ParamValue;

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

    #[test]
    fn test_drawtext_filter() {
        let mut effect = Effect::new(EffectType::TextOverlay);
        effect.set_param("text", ParamValue::String("Hello World".to_string()));
        effect.set_param("font_size", ParamValue::Float(32.0));
        effect.set_param("x", ParamValue::Float(100.0));
        effect.set_param("y", ParamValue::Float(50.0));

        let filter = effect.to_filter_string("in", "out");
        assert!(filter.contains("drawtext"));
        assert!(filter.contains("text='Hello World'"));
        assert!(filter.contains("fontsize=32"));
    }

    #[test]
    fn test_drawtext_escapes_special_characters_and_disables_percent_expansion() {
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
}
