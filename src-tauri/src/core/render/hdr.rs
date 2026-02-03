//! HDR (High Dynamic Range) Workflow Module
//!
//! Provides comprehensive HDR video support including:
//! - Color space and transfer function definitions
//! - HDR metadata structures (SMPTE ST 2086, CTA-861.3)
//! - Tonemapping filters for SDR preview
//! - HDR detection and analysis
//!
//! # Color Spaces
//!
//! OpenReelio supports these color spaces:
//! - **sRGB/Rec.709**: Standard SDR (Standard Dynamic Range)
//! - **Rec.2020**: Wide color gamut for HDR content
//! - **DCI-P3**: Cinema/Apple displays
//!
//! # Transfer Functions
//!
//! - **SDR Gamma** (2.2/2.4): Traditional gamma curve
//! - **PQ (ST 2084)**: Perceptual Quantizer for HDR10/Dolby Vision
//! - **HLG**: Hybrid Log-Gamma for broadcast HDR
//!
//! # Example
//!
//! ```rust,ignore
//! use openreelio_lib::core::render::hdr::*;
//!
//! // Create HDR10 metadata
//! let metadata = HdrMetadata::hdr10_default()
//!     .with_max_cll(1000)
//!     .with_max_fall(400)
//!     .with_mastering_display(MasteringDisplayInfo::p3_d65_1000());
//!
//! // Generate tonemapping filter for preview
//! let filter = build_tonemap_filter(TonemapMode::Reinhard, &metadata);
//! ```

use serde::{Deserialize, Serialize};
use specta::Type;

// =============================================================================
// Color Primaries
// =============================================================================

/// Color primaries (gamut) as defined by ITU-R BT.
/// Determines the range of colors that can be represented.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ColorPrimaries {
    /// BT.709 (sRGB) - Standard HD
    /// CIE 1931: R(0.64,0.33) G(0.30,0.60) B(0.15,0.06) W(0.3127,0.3290)
    #[default]
    Bt709,
    /// BT.2020 - Ultra HD / HDR
    /// CIE 1931: R(0.708,0.292) G(0.170,0.797) B(0.131,0.046) W(0.3127,0.3290)
    Bt2020,
    /// DCI-P3 (D65) - Digital Cinema / Apple displays
    /// CIE 1931: R(0.68,0.32) G(0.265,0.69) B(0.15,0.06) W(0.3127,0.3290)
    DciP3,
    /// DCI-P3 (Theater) - Original cinema D63 white point
    DciP3Theater,
    /// Display P3 - Apple's P3 variant with D65 white
    DisplayP3,
}

impl ColorPrimaries {
    /// Returns the FFmpeg color_primaries value
    pub fn ffmpeg_value(&self) -> &'static str {
        match self {
            Self::Bt709 => "bt709",
            Self::Bt2020 => "bt2020",
            Self::DciP3 | Self::DisplayP3 => "smpte432",
            Self::DciP3Theater => "smpte431",
        }
    }

    /// Returns true if this is a wide color gamut (WCG)
    pub fn is_wide_gamut(&self) -> bool {
        !matches!(self, Self::Bt709)
    }

    /// Returns the chromaticity coordinates for each primary
    /// Format: (red_x, red_y, green_x, green_y, blue_x, blue_y, white_x, white_y)
    pub fn chromaticity(&self) -> (f64, f64, f64, f64, f64, f64, f64, f64) {
        match self {
            Self::Bt709 => (0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290),
            Self::Bt2020 => (0.708, 0.292, 0.170, 0.797, 0.131, 0.046, 0.3127, 0.3290),
            Self::DciP3 | Self::DisplayP3 => (0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.3290),
            Self::DciP3Theater => (0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.314, 0.351),
        }
    }
}

// =============================================================================
// Transfer Characteristics
// =============================================================================

/// Transfer characteristics (EOTF/OETF) - the gamma/transfer function
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TransferCharacteristics {
    /// Standard gamma (2.2 approximation for sRGB)
    #[default]
    Srgb,
    /// BT.709 gamma (1/0.45 ≈ 2.22)
    Bt709,
    /// BT.2020 10-bit transfer (same as BT.709)
    Bt202010,
    /// BT.2020 12-bit transfer
    Bt202012,
    /// PQ (SMPTE ST 2084) - HDR10 and Dolby Vision
    /// Perceptual quantizer, designed for human vision
    Pq,
    /// HLG (Hybrid Log-Gamma) - ARIB STD-B67
    /// Backwards compatible with SDR displays
    Hlg,
    /// Linear light (gamma 1.0)
    Linear,
}

impl TransferCharacteristics {
    /// Returns the FFmpeg color_trc value
    pub fn ffmpeg_value(&self) -> &'static str {
        match self {
            Self::Srgb => "iec61966-2-1",
            Self::Bt709 | Self::Bt202010 => "bt709",
            Self::Bt202012 => "bt2020-12",
            Self::Pq => "smpte2084",
            Self::Hlg => "arib-std-b67",
            Self::Linear => "linear",
        }
    }

    /// Returns true if this is an HDR transfer function
    pub fn is_hdr(&self) -> bool {
        matches!(self, Self::Pq | Self::Hlg)
    }

    /// Returns the maximum luminance (nits) for this transfer
    /// SDR: ~100 nits, HDR: up to 10,000 nits
    pub fn max_luminance(&self) -> f64 {
        match self {
            Self::Pq => 10000.0,
            Self::Hlg => 1000.0, // Reference display
            _ => 100.0,          // SDR reference
        }
    }
}

// =============================================================================
// Matrix Coefficients
// =============================================================================

/// Color matrix coefficients for YUV/RGB conversion
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MatrixCoefficients {
    /// BT.709 (HD)
    #[default]
    Bt709,
    /// BT.2020 non-constant luminance
    Bt2020Ncl,
    /// BT.2020 constant luminance
    Bt2020Cl,
    /// Identity (RGB, no matrix)
    Identity,
}

impl MatrixCoefficients {
    /// Returns the FFmpeg colorspace value
    pub fn ffmpeg_value(&self) -> &'static str {
        match self {
            Self::Bt709 => "bt709",
            Self::Bt2020Ncl | Self::Bt2020Cl => "bt2020nc",
            Self::Identity => "rgb",
        }
    }
}

// =============================================================================
// Color Space (Combined)
// =============================================================================

/// Complete color space specification
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorSpace {
    /// Color primaries (gamut)
    pub primaries: ColorPrimaries,
    /// Transfer characteristics (gamma/EOTF)
    pub transfer: TransferCharacteristics,
    /// Matrix coefficients
    pub matrix: MatrixCoefficients,
}

impl ColorSpace {
    /// Standard sRGB/Rec.709 SDR
    pub fn sdr() -> Self {
        Self {
            primaries: ColorPrimaries::Bt709,
            transfer: TransferCharacteristics::Srgb,
            matrix: MatrixCoefficients::Bt709,
        }
    }

    /// BT.709 HD video
    pub fn bt709() -> Self {
        Self {
            primaries: ColorPrimaries::Bt709,
            transfer: TransferCharacteristics::Bt709,
            matrix: MatrixCoefficients::Bt709,
        }
    }

    /// HDR10 (BT.2020 + PQ)
    pub fn hdr10() -> Self {
        Self {
            primaries: ColorPrimaries::Bt2020,
            transfer: TransferCharacteristics::Pq,
            matrix: MatrixCoefficients::Bt2020Ncl,
        }
    }

    /// HLG HDR (BT.2020 + HLG)
    pub fn hlg() -> Self {
        Self {
            primaries: ColorPrimaries::Bt2020,
            transfer: TransferCharacteristics::Hlg,
            matrix: MatrixCoefficients::Bt2020Ncl,
        }
    }

    /// Display P3 (Apple displays)
    pub fn display_p3() -> Self {
        Self {
            primaries: ColorPrimaries::DisplayP3,
            transfer: TransferCharacteristics::Srgb,
            matrix: MatrixCoefficients::Bt709,
        }
    }

    /// Returns true if this is an HDR color space
    pub fn is_hdr(&self) -> bool {
        self.transfer.is_hdr()
    }

    /// Returns true if this is a wide color gamut
    pub fn is_wide_gamut(&self) -> bool {
        self.primaries.is_wide_gamut()
    }
}

// =============================================================================
// Mastering Display Info
// =============================================================================

/// Mastering display color volume metadata (SMPTE ST 2086)
/// Used for proper HDR display mapping
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MasteringDisplayInfo {
    /// Red primary X coordinate (0.0 - 1.0)
    pub red_x: f64,
    /// Red primary Y coordinate (0.0 - 1.0)
    pub red_y: f64,
    /// Green primary X coordinate (0.0 - 1.0)
    pub green_x: f64,
    /// Green primary Y coordinate (0.0 - 1.0)
    pub green_y: f64,
    /// Blue primary X coordinate (0.0 - 1.0)
    pub blue_x: f64,
    /// Blue primary Y coordinate (0.0 - 1.0)
    pub blue_y: f64,
    /// White point X coordinate (0.0 - 1.0)
    pub white_x: f64,
    /// White point Y coordinate (0.0 - 1.0)
    pub white_y: f64,
    /// Maximum luminance in cd/m² (nits)
    pub max_luminance: f64,
    /// Minimum luminance in cd/m² (nits)
    pub min_luminance: f64,
}

impl Default for MasteringDisplayInfo {
    fn default() -> Self {
        Self::bt2020_pq_1000()
    }
}

impl MasteringDisplayInfo {
    /// Creates mastering display info from color primaries
    pub fn from_primaries(primaries: ColorPrimaries, max_nits: f64, min_nits: f64) -> Self {
        let (rx, ry, gx, gy, bx, by, wx, wy) = primaries.chromaticity();
        Self {
            red_x: rx,
            red_y: ry,
            green_x: gx,
            green_y: gy,
            blue_x: bx,
            blue_y: by,
            white_x: wx,
            white_y: wy,
            max_luminance: max_nits,
            min_luminance: min_nits,
        }
    }

    /// BT.2020 primaries with 1000 nits peak (common HDR10)
    pub fn bt2020_pq_1000() -> Self {
        Self::from_primaries(ColorPrimaries::Bt2020, 1000.0, 0.0001)
    }

    /// BT.2020 primaries with 4000 nits peak (high-end HDR)
    pub fn bt2020_pq_4000() -> Self {
        Self::from_primaries(ColorPrimaries::Bt2020, 4000.0, 0.0001)
    }

    /// BT.2020 primaries with 10000 nits peak (reference)
    pub fn bt2020_pq_10000() -> Self {
        Self::from_primaries(ColorPrimaries::Bt2020, 10000.0, 0.0001)
    }

    /// P3-D65 primaries with 1000 nits (Apple-style HDR)
    pub fn p3_d65_1000() -> Self {
        Self::from_primaries(ColorPrimaries::DisplayP3, 1000.0, 0.0001)
    }

    /// DCI-P3 theater primaries with 48 nits (cinema)
    pub fn dci_p3_48() -> Self {
        Self::from_primaries(ColorPrimaries::DciP3Theater, 48.0, 0.005)
    }

    /// Returns the FFmpeg master-display string
    /// Format: G(gx,gy)B(bx,by)R(rx,ry)WP(wx,wy)L(max,min)
    pub fn ffmpeg_value(&self) -> String {
        // FFmpeg uses 50000 scale for chromaticity and 10000 for luminance
        const CHROMA_SCALE: f64 = 50000.0;
        const LUM_SCALE: f64 = 10000.0;

        format!(
            "G({},{})B({},{})R({},{})WP({},{})L({},{})",
            (self.green_x * CHROMA_SCALE) as i64,
            (self.green_y * CHROMA_SCALE) as i64,
            (self.blue_x * CHROMA_SCALE) as i64,
            (self.blue_y * CHROMA_SCALE) as i64,
            (self.red_x * CHROMA_SCALE) as i64,
            (self.red_y * CHROMA_SCALE) as i64,
            (self.white_x * CHROMA_SCALE) as i64,
            (self.white_y * CHROMA_SCALE) as i64,
            (self.max_luminance * LUM_SCALE) as i64,
            (self.min_luminance * LUM_SCALE) as i64
        )
    }
}

// =============================================================================
// HDR Metadata
// =============================================================================

/// Complete HDR metadata structure
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HdrMetadata {
    /// Color space specification
    pub color_space: ColorSpace,
    /// Maximum Content Light Level (MaxCLL) in cd/m²
    /// Peak brightness of the brightest pixel in the entire stream
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cll: Option<u32>,
    /// Maximum Frame-Average Light Level (MaxFALL) in cd/m²
    /// Peak brightness of the brightest frame average
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_fall: Option<u32>,
    /// Mastering display information
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mastering_display: Option<MasteringDisplayInfo>,
}

impl Default for HdrMetadata {
    fn default() -> Self {
        Self::sdr()
    }
}

impl HdrMetadata {
    /// Standard SDR metadata
    pub fn sdr() -> Self {
        Self {
            color_space: ColorSpace::sdr(),
            max_cll: None,
            max_fall: None,
            mastering_display: None,
        }
    }

    /// HDR10 default metadata
    pub fn hdr10_default() -> Self {
        Self {
            color_space: ColorSpace::hdr10(),
            max_cll: Some(1000),
            max_fall: Some(400),
            mastering_display: Some(MasteringDisplayInfo::bt2020_pq_1000()),
        }
    }

    /// HDR10 with custom peak brightness
    pub fn hdr10_with_peak(max_nits: u32) -> Self {
        Self {
            color_space: ColorSpace::hdr10(),
            max_cll: Some(max_nits),
            max_fall: Some(max_nits / 3),
            mastering_display: Some(MasteringDisplayInfo::from_primaries(
                ColorPrimaries::Bt2020,
                max_nits as f64,
                0.0001,
            )),
        }
    }

    /// HLG HDR metadata
    pub fn hlg_default() -> Self {
        Self {
            color_space: ColorSpace::hlg(),
            max_cll: None, // HLG doesn't use static metadata
            max_fall: None,
            mastering_display: None,
        }
    }

    /// Sets the MaxCLL value
    pub fn with_max_cll(mut self, nits: u32) -> Self {
        self.max_cll = Some(nits.clamp(1, 10000));
        self
    }

    /// Sets the MaxFALL value
    pub fn with_max_fall(mut self, nits: u32) -> Self {
        self.max_fall = Some(nits.clamp(1, 10000));
        self
    }

    /// Sets the mastering display information
    pub fn with_mastering_display(mut self, display: MasteringDisplayInfo) -> Self {
        self.mastering_display = Some(display);
        self
    }

    /// Returns true if this is HDR content
    pub fn is_hdr(&self) -> bool {
        self.color_space.is_hdr()
    }

    /// Returns FFmpeg arguments for HDR metadata
    pub fn ffmpeg_args(&self) -> Vec<String> {
        let mut args = vec![
            "-color_primaries".to_string(),
            self.color_space.primaries.ffmpeg_value().to_string(),
            "-color_trc".to_string(),
            self.color_space.transfer.ffmpeg_value().to_string(),
            "-colorspace".to_string(),
            self.color_space.matrix.ffmpeg_value().to_string(),
        ];

        // HDR10 static metadata (only for PQ)
        if matches!(self.color_space.transfer, TransferCharacteristics::Pq) {
            if let (Some(cll), Some(fall)) = (self.max_cll, self.max_fall) {
                // Content light level requires x265 params
                args.push("-x265-params".to_string());
                let mut x265_params =
                    format!("hdr-opt=1:repeat-headers=1:max-cll={},{}", cll, fall);

                if let Some(ref md) = self.mastering_display {
                    x265_params.push_str(&format!(":master-display={}", md.ffmpeg_value()));
                }

                args.push(x265_params);
            }
        }

        args
    }
}

// =============================================================================
// Tonemapping
// =============================================================================

/// Tonemapping algorithm for HDR to SDR conversion
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TonemapMode {
    /// No tonemapping (clip values)
    None,
    /// Reinhard global operator (simple, preserves highlights)
    #[default]
    Reinhard,
    /// Hable/Filmic curve (cinematic look)
    Hable,
    /// Mobius curve (smooth rolloff)
    Mobius,
    /// BT.2390 EETF (ITU recommended for broadcast)
    Bt2390,
}

impl TonemapMode {
    /// Returns the FFmpeg tonemap algorithm name
    pub fn ffmpeg_value(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Reinhard => "reinhard",
            Self::Hable => "hable",
            Self::Mobius => "mobius",
            Self::Bt2390 => "bt2390",
        }
    }
}

/// Tonemapping parameters
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TonemapParams {
    /// Tonemapping algorithm
    pub mode: TonemapMode,
    /// Target peak luminance in nits (typically 100 for SDR)
    pub target_peak: f64,
    /// Desaturation strength (0.0 = none, 1.0 = full)
    pub desat: f64,
    /// Desaturation exponent
    pub desat_exp: f64,
    /// Gamut mapping mode ("clip", "perceptual", "relative", "saturation")
    pub gamut: String,
}

impl Default for TonemapParams {
    fn default() -> Self {
        Self {
            mode: TonemapMode::Reinhard,
            target_peak: 100.0,
            desat: 0.75,
            desat_exp: 1.5,
            gamut: "relative".to_string(),
        }
    }
}

impl TonemapParams {
    /// Creates tonemapping params for preview (fast, decent quality)
    pub fn preview() -> Self {
        Self {
            mode: TonemapMode::Reinhard,
            target_peak: 100.0,
            desat: 0.5,
            desat_exp: 1.5,
            gamut: "clip".to_string(),
        }
    }

    /// Creates tonemapping params for high quality output
    pub fn high_quality() -> Self {
        Self {
            mode: TonemapMode::Bt2390,
            target_peak: 100.0,
            desat: 0.75,
            desat_exp: 1.5,
            gamut: "perceptual".to_string(),
        }
    }

    /// Creates tonemapping params for filmic look
    pub fn filmic() -> Self {
        Self {
            mode: TonemapMode::Hable,
            target_peak: 100.0,
            desat: 0.9,
            desat_exp: 2.0,
            gamut: "relative".to_string(),
        }
    }
}

/// Builds an FFmpeg filter chain for HDR to SDR tonemapping
///
/// # Arguments
///
/// * `params` - Tonemapping parameters
/// * `metadata` - Source HDR metadata (for luminance info)
///
/// # Returns
///
/// FFmpeg filter string for tonemapping
pub fn build_tonemap_filter(params: &TonemapParams, metadata: &HdrMetadata) -> String {
    if !metadata.is_hdr() {
        return String::new();
    }

    let source_peak = metadata.max_cll.unwrap_or(1000) as f64;
    let target_peak = params.target_peak;

    // Build the filter chain
    let mut filters = Vec::new();

    // 1. Convert to linear light
    filters.push(format!("zscale=t=linear:npl={}", source_peak));

    // 2. Apply tonemapping
    if params.mode != TonemapMode::None {
        filters.push(format!(
            "tonemap={}:peak={}:desat={}",
            params.mode.ffmpeg_value(),
            target_peak / source_peak,
            params.desat
        ));
    }

    // 3. Convert to target color space
    filters.push("zscale=p=bt709:t=bt709:m=bt709:r=tv".to_string());

    // 4. Format conversion to 8-bit
    filters.push("format=yuv420p".to_string());

    filters.join(",")
}

/// Builds a simple tonemapping filter for preview
/// Uses zscale for fast GPU-accelerated processing
pub fn build_preview_tonemap_filter(metadata: &HdrMetadata) -> String {
    if !metadata.is_hdr() {
        return String::new();
    }

    let params = TonemapParams::preview();
    build_tonemap_filter(&params, metadata)
}

// =============================================================================
// HDR Detection
// =============================================================================

/// Detected HDR information from a video file
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHdrInfo {
    /// Whether HDR was detected
    pub is_hdr: bool,
    /// Detected color primaries
    pub primaries: Option<ColorPrimaries>,
    /// Detected transfer function
    pub transfer: Option<TransferCharacteristics>,
    /// Detected bit depth
    pub bit_depth: Option<u8>,
    /// Detected MaxCLL (from stream metadata)
    pub max_cll: Option<u32>,
    /// Detected MaxFALL (from stream metadata)
    pub max_fall: Option<u32>,
    /// Whether mastering display info was found
    pub has_mastering_display: bool,
    /// HDR format name ("HDR10", "HLG", "Dolby Vision", "SDR")
    pub format_name: String,
}

impl DetectedHdrInfo {
    /// Creates SDR detection result
    pub fn sdr() -> Self {
        Self {
            is_hdr: false,
            format_name: "SDR".to_string(),
            ..Default::default()
        }
    }

    /// Creates HDR10 detection result
    pub fn hdr10(max_cll: Option<u32>, max_fall: Option<u32>) -> Self {
        Self {
            is_hdr: true,
            primaries: Some(ColorPrimaries::Bt2020),
            transfer: Some(TransferCharacteristics::Pq),
            bit_depth: Some(10),
            max_cll,
            max_fall,
            has_mastering_display: max_cll.is_some(),
            format_name: "HDR10".to_string(),
        }
    }

    /// Creates HLG detection result
    pub fn hlg() -> Self {
        Self {
            is_hdr: true,
            primaries: Some(ColorPrimaries::Bt2020),
            transfer: Some(TransferCharacteristics::Hlg),
            bit_depth: Some(10),
            format_name: "HLG".to_string(),
            ..Default::default()
        }
    }
}

/// Parses color primaries from FFprobe string
pub fn parse_color_primaries(value: &str) -> Option<ColorPrimaries> {
    match value.to_lowercase().as_str() {
        "bt709" => Some(ColorPrimaries::Bt709),
        "bt2020" => Some(ColorPrimaries::Bt2020),
        "smpte432" | "p3" => Some(ColorPrimaries::DisplayP3),
        "smpte431" => Some(ColorPrimaries::DciP3Theater),
        _ => None,
    }
}

/// Parses transfer characteristics from FFprobe string
pub fn parse_transfer_characteristics(value: &str) -> Option<TransferCharacteristics> {
    match value.to_lowercase().as_str() {
        "bt709" => Some(TransferCharacteristics::Bt709),
        "smpte2084" | "pq" => Some(TransferCharacteristics::Pq),
        "arib-std-b67" | "hlg" => Some(TransferCharacteristics::Hlg),
        "linear" => Some(TransferCharacteristics::Linear),
        "iec61966-2-1" | "srgb" => Some(TransferCharacteristics::Srgb),
        _ => None,
    }
}

/// Detects HDR information from FFprobe color metadata
pub fn detect_hdr_from_metadata(
    color_primaries: Option<&str>,
    color_transfer: Option<&str>,
    bits_per_raw_sample: Option<u8>,
    max_cll: Option<u32>,
    max_fall: Option<u32>,
) -> DetectedHdrInfo {
    let primaries = color_primaries.and_then(parse_color_primaries);
    let transfer = color_transfer.and_then(parse_transfer_characteristics);

    let is_hdr = transfer.map(|t| t.is_hdr()).unwrap_or(false);

    let format_name = if !is_hdr {
        "SDR".to_string()
    } else {
        match transfer {
            Some(TransferCharacteristics::Pq) => "HDR10".to_string(),
            Some(TransferCharacteristics::Hlg) => "HLG".to_string(),
            _ => "HDR".to_string(),
        }
    };

    DetectedHdrInfo {
        is_hdr,
        primaries,
        transfer,
        bit_depth: bits_per_raw_sample,
        max_cll,
        max_fall,
        has_mastering_display: max_cll.is_some(),
        format_name,
    }
}

// =============================================================================
// Color Space Conversion
// =============================================================================

/// Builds FFmpeg filter for color space conversion
pub fn build_colorspace_conversion_filter(
    source: &ColorSpace,
    target: &ColorSpace,
) -> Option<String> {
    // No conversion needed if same color space
    if source == target {
        return None;
    }

    // Use zscale for high quality conversion
    Some(format!(
        "zscale=p={}:t={}:m={}:r=tv",
        target.primaries.ffmpeg_value(),
        target.transfer.ffmpeg_value(),
        target.matrix.ffmpeg_value()
    ))
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Color Primaries Tests
    // =========================================================================

    #[test]
    fn test_color_primaries_default() {
        let primaries = ColorPrimaries::default();
        assert_eq!(primaries, ColorPrimaries::Bt709);
    }

    #[test]
    fn test_color_primaries_ffmpeg_values() {
        assert_eq!(ColorPrimaries::Bt709.ffmpeg_value(), "bt709");
        assert_eq!(ColorPrimaries::Bt2020.ffmpeg_value(), "bt2020");
        assert_eq!(ColorPrimaries::DisplayP3.ffmpeg_value(), "smpte432");
    }

    #[test]
    fn test_color_primaries_wide_gamut() {
        assert!(!ColorPrimaries::Bt709.is_wide_gamut());
        assert!(ColorPrimaries::Bt2020.is_wide_gamut());
        assert!(ColorPrimaries::DisplayP3.is_wide_gamut());
    }

    #[test]
    fn test_color_primaries_chromaticity() {
        let (rx, _ry, _gx, gy, _bx, _by, wx, _wy) = ColorPrimaries::Bt709.chromaticity();
        assert!((rx - 0.64).abs() < 0.001);
        assert!((gy - 0.60).abs() < 0.001);
        assert!((wx - 0.3127).abs() < 0.001);
    }

    // =========================================================================
    // Transfer Characteristics Tests
    // =========================================================================

    #[test]
    fn test_transfer_default() {
        let transfer = TransferCharacteristics::default();
        assert_eq!(transfer, TransferCharacteristics::Srgb);
    }

    #[test]
    fn test_transfer_ffmpeg_values() {
        assert_eq!(TransferCharacteristics::Pq.ffmpeg_value(), "smpte2084");
        assert_eq!(TransferCharacteristics::Hlg.ffmpeg_value(), "arib-std-b67");
        assert_eq!(TransferCharacteristics::Bt709.ffmpeg_value(), "bt709");
    }

    #[test]
    fn test_transfer_is_hdr() {
        assert!(!TransferCharacteristics::Srgb.is_hdr());
        assert!(!TransferCharacteristics::Bt709.is_hdr());
        assert!(TransferCharacteristics::Pq.is_hdr());
        assert!(TransferCharacteristics::Hlg.is_hdr());
    }

    #[test]
    fn test_transfer_max_luminance() {
        assert_eq!(TransferCharacteristics::Srgb.max_luminance(), 100.0);
        assert_eq!(TransferCharacteristics::Pq.max_luminance(), 10000.0);
        assert_eq!(TransferCharacteristics::Hlg.max_luminance(), 1000.0);
    }

    // =========================================================================
    // Color Space Tests
    // =========================================================================

    #[test]
    fn test_color_space_presets() {
        let sdr = ColorSpace::sdr();
        assert!(!sdr.is_hdr());
        assert!(!sdr.is_wide_gamut());

        let hdr10 = ColorSpace::hdr10();
        assert!(hdr10.is_hdr());
        assert!(hdr10.is_wide_gamut());

        let hlg = ColorSpace::hlg();
        assert!(hlg.is_hdr());
    }

    // =========================================================================
    // Mastering Display Info Tests
    // =========================================================================

    #[test]
    fn test_mastering_display_presets() {
        let md = MasteringDisplayInfo::bt2020_pq_1000();
        assert_eq!(md.max_luminance, 1000.0);

        let md_4000 = MasteringDisplayInfo::bt2020_pq_4000();
        assert_eq!(md_4000.max_luminance, 4000.0);
    }

    #[test]
    fn test_mastering_display_ffmpeg_value() {
        let md = MasteringDisplayInfo::bt2020_pq_1000();
        let ffmpeg = md.ffmpeg_value();

        // Check format (G, B, R, WP, L order for FFmpeg)
        assert!(ffmpeg.starts_with("G("));
        assert!(ffmpeg.contains("WP("));
        assert!(ffmpeg.contains("L("));
    }

    #[test]
    fn test_mastering_display_from_primaries() {
        let md = MasteringDisplayInfo::from_primaries(ColorPrimaries::Bt2020, 1000.0, 0.0001);
        assert_eq!(md.max_luminance, 1000.0);
        assert!((md.red_x - 0.708).abs() < 0.001);
    }

    // =========================================================================
    // HDR Metadata Tests
    // =========================================================================

    #[test]
    fn test_hdr_metadata_sdr() {
        let meta = HdrMetadata::sdr();
        assert!(!meta.is_hdr());
        assert!(meta.max_cll.is_none());
    }

    #[test]
    fn test_hdr_metadata_hdr10_default() {
        let meta = HdrMetadata::hdr10_default();
        assert!(meta.is_hdr());
        assert_eq!(meta.max_cll, Some(1000));
        assert_eq!(meta.max_fall, Some(400));
        assert!(meta.mastering_display.is_some());
    }

    #[test]
    fn test_hdr_metadata_with_custom_values() {
        let meta = HdrMetadata::hdr10_default()
            .with_max_cll(2000)
            .with_max_fall(800);

        assert_eq!(meta.max_cll, Some(2000));
        assert_eq!(meta.max_fall, Some(800));
    }

    #[test]
    fn test_hdr_metadata_clamps_values() {
        let meta = HdrMetadata::hdr10_default().with_max_cll(20000); // Exceeds 10000 limit

        assert_eq!(meta.max_cll, Some(10000));
    }

    #[test]
    fn test_hdr_metadata_ffmpeg_args() {
        let meta = HdrMetadata::hdr10_default();
        let args = meta.ffmpeg_args();

        assert!(args.contains(&"-color_primaries".to_string()));
        assert!(args.contains(&"bt2020".to_string()));
        assert!(args.contains(&"-color_trc".to_string()));
        assert!(args.contains(&"smpte2084".to_string()));
    }

    #[test]
    fn test_hdr_metadata_with_x265_params() {
        let meta = HdrMetadata::hdr10_default();
        let args = meta.ffmpeg_args();

        // Should have x265 params for HDR10 static metadata
        assert!(args.contains(&"-x265-params".to_string()));

        let x265_idx = args.iter().position(|s| s == "-x265-params").unwrap();
        let x265_params = &args[x265_idx + 1];
        assert!(x265_params.contains("max-cll=1000,400"));
        assert!(x265_params.contains("master-display="));
    }

    // =========================================================================
    // Tonemapping Tests
    // =========================================================================

    #[test]
    fn test_tonemap_mode_ffmpeg_values() {
        assert_eq!(TonemapMode::Reinhard.ffmpeg_value(), "reinhard");
        assert_eq!(TonemapMode::Hable.ffmpeg_value(), "hable");
        assert_eq!(TonemapMode::Bt2390.ffmpeg_value(), "bt2390");
    }

    #[test]
    fn test_tonemap_params_presets() {
        let preview = TonemapParams::preview();
        assert_eq!(preview.mode, TonemapMode::Reinhard);
        assert_eq!(preview.gamut, "clip");

        let hq = TonemapParams::high_quality();
        assert_eq!(hq.mode, TonemapMode::Bt2390);
        assert_eq!(hq.gamut, "perceptual");
    }

    #[test]
    fn test_build_tonemap_filter_sdr_returns_empty() {
        let params = TonemapParams::default();
        let meta = HdrMetadata::sdr();

        let filter = build_tonemap_filter(&params, &meta);
        assert!(filter.is_empty());
    }

    #[test]
    fn test_build_tonemap_filter_hdr() {
        let params = TonemapParams::default();
        let meta = HdrMetadata::hdr10_default();

        let filter = build_tonemap_filter(&params, &meta);
        assert!(!filter.is_empty());
        assert!(filter.contains("tonemap=reinhard"));
        assert!(filter.contains("zscale"));
    }

    #[test]
    fn test_build_preview_tonemap_filter() {
        let meta = HdrMetadata::hdr10_default();
        let filter = build_preview_tonemap_filter(&meta);

        assert!(!filter.is_empty());
        assert!(filter.contains("tonemap"));
    }

    // =========================================================================
    // HDR Detection Tests
    // =========================================================================

    #[test]
    fn test_detected_hdr_info_sdr() {
        let info = DetectedHdrInfo::sdr();
        assert!(!info.is_hdr);
        assert_eq!(info.format_name, "SDR");
    }

    #[test]
    fn test_detected_hdr_info_hdr10() {
        let info = DetectedHdrInfo::hdr10(Some(1000), Some(400));
        assert!(info.is_hdr);
        assert_eq!(info.format_name, "HDR10");
        assert_eq!(info.max_cll, Some(1000));
    }

    #[test]
    fn test_parse_color_primaries() {
        assert_eq!(parse_color_primaries("bt709"), Some(ColorPrimaries::Bt709));
        assert_eq!(
            parse_color_primaries("bt2020"),
            Some(ColorPrimaries::Bt2020)
        );
        assert_eq!(parse_color_primaries("unknown"), None);
    }

    #[test]
    fn test_parse_transfer_characteristics() {
        assert_eq!(
            parse_transfer_characteristics("smpte2084"),
            Some(TransferCharacteristics::Pq)
        );
        assert_eq!(
            parse_transfer_characteristics("arib-std-b67"),
            Some(TransferCharacteristics::Hlg)
        );
        assert_eq!(parse_transfer_characteristics("unknown"), None);
    }

    #[test]
    fn test_detect_hdr_from_metadata_sdr() {
        let info = detect_hdr_from_metadata(Some("bt709"), Some("bt709"), Some(8), None, None);

        assert!(!info.is_hdr);
        assert_eq!(info.format_name, "SDR");
    }

    #[test]
    fn test_detect_hdr_from_metadata_hdr10() {
        let info = detect_hdr_from_metadata(
            Some("bt2020"),
            Some("smpte2084"),
            Some(10),
            Some(1000),
            Some(400),
        );

        assert!(info.is_hdr);
        assert_eq!(info.format_name, "HDR10");
        assert_eq!(info.primaries, Some(ColorPrimaries::Bt2020));
        assert_eq!(info.transfer, Some(TransferCharacteristics::Pq));
    }

    #[test]
    fn test_detect_hdr_from_metadata_hlg() {
        let info =
            detect_hdr_from_metadata(Some("bt2020"), Some("arib-std-b67"), Some(10), None, None);

        assert!(info.is_hdr);
        assert_eq!(info.format_name, "HLG");
    }

    // =========================================================================
    // Color Space Conversion Tests
    // =========================================================================

    #[test]
    fn test_colorspace_conversion_same() {
        let cs = ColorSpace::sdr();
        let filter = build_colorspace_conversion_filter(&cs, &cs);
        assert!(filter.is_none());
    }

    #[test]
    fn test_colorspace_conversion_different() {
        let source = ColorSpace::hdr10();
        let target = ColorSpace::bt709();

        let filter = build_colorspace_conversion_filter(&source, &target);
        assert!(filter.is_some());
        assert!(filter.unwrap().contains("zscale"));
    }

    // =========================================================================
    // Serialization Tests
    // =========================================================================

    #[test]
    fn test_hdr_metadata_serialization() {
        let meta = HdrMetadata::hdr10_default();
        let json = serde_json::to_string(&meta).unwrap();
        let parsed: HdrMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(meta.max_cll, parsed.max_cll);
        assert_eq!(meta.color_space, parsed.color_space);
    }

    #[test]
    fn test_color_space_serialization() {
        let cs = ColorSpace::hdr10();
        let json = serde_json::to_string(&cs).unwrap();
        let parsed: ColorSpace = serde_json::from_str(&json).unwrap();

        assert_eq!(cs, parsed);
    }

    #[test]
    fn test_detected_hdr_info_serialization() {
        let info = DetectedHdrInfo::hdr10(Some(1000), Some(400));
        let json = serde_json::to_string(&info).unwrap();
        let parsed: DetectedHdrInfo = serde_json::from_str(&json).unwrap();

        assert_eq!(info.format_name, parsed.format_name);
        assert_eq!(info.max_cll, parsed.max_cll);
    }
}
