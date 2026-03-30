//! Color Match (Auto Shot Matching) Module
//!
//! Analyzes color characteristics of video frames and computes corrections
//! to match a target clip's look to a reference clip using histogram matching.
//!
//! ## Algorithm
//!
//! 1. Extract representative frames from reference and target clips
//! 2. Compute color profiles (RGB histograms, average color, white point)
//! 3. Apply histogram specification to generate per-channel transfer curves
//! 4. Output curves as `CurvePoint` vectors compatible with the Curves effect
//!
//! ## FFmpeg Integration
//!
//! Color statistics are extracted using FFmpeg's `signalstats` and `split/histogram`
//! filters, parsing the metadata output to build per-channel histograms.

use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::debug;

use crate::core::effects::CurvePoint;
use crate::core::process::configure_tokio_command;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Number of bins in each RGB histogram channel.
const HISTOGRAM_BINS: usize = 256;

/// Number of control points to sample from the transfer function for the curve.
/// More points = more faithful reproduction, but diminishing returns past ~12.
const CURVE_SAMPLE_COUNT: usize = 12;

/// Minimum meaningful pixel count in a histogram bin to consider it non-empty.
const MIN_PIXEL_THRESHOLD: f64 = 1.0;

/// Smoothing window radius for the transfer function.
/// Prevents jagged curves from noisy histogram data.
const SMOOTHING_RADIUS: usize = 3;

// =============================================================================
// Color Profile
// =============================================================================

/// Color characteristics extracted from a single video frame.
///
/// Each channel histogram has 256 bins representing pixel intensity counts
/// for values 0–255.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ColorProfile {
    /// Red channel histogram (256 bins)
    pub histogram_r: Vec<f64>,
    /// Green channel histogram (256 bins)
    pub histogram_g: Vec<f64>,
    /// Blue channel histogram (256 bins)
    pub histogram_b: Vec<f64>,
    /// Average color (R, G, B) normalized to 0.0–255.0
    pub avg_color: [f64; 3],
    /// Estimated white point (R, G, B) from the brightest meaningful region
    pub white_point: [f64; 3],
    /// Mean luminance (0.0–255.0)
    pub brightness: f64,
    /// Mean saturation (0.0–1.0)
    pub saturation: f64,
}

impl ColorProfile {
    /// Creates an empty profile with zeroed histograms.
    fn empty() -> Self {
        Self {
            histogram_r: vec![0.0; HISTOGRAM_BINS],
            histogram_g: vec![0.0; HISTOGRAM_BINS],
            histogram_b: vec![0.0; HISTOGRAM_BINS],
            avg_color: [0.0; 3],
            white_point: [255.0; 3],
            brightness: 0.0,
            saturation: 0.0,
        }
    }
}

// =============================================================================
// Color Correction
// =============================================================================

/// Computed color correction to transform a target to match a reference.
///
/// Each curve maps input intensity (0.0–1.0) to output intensity (0.0–1.0)
/// for the respective channel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ColorCorrection {
    /// Red channel transfer curve
    pub red_curve: Vec<CurvePoint>,
    /// Green channel transfer curve
    pub green_curve: Vec<CurvePoint>,
    /// Blue channel transfer curve
    pub blue_curve: Vec<CurvePoint>,
    /// Brightness offset (-1.0 to 1.0, 0 = no change)
    pub brightness_offset: f64,
    /// Saturation multiplier (1.0 = no change)
    pub saturation_multiplier: f64,
    /// Temperature shift estimate (negative = cooler, positive = warmer)
    pub temperature_shift: f64,
}

// =============================================================================
// Histogram Analysis
// =============================================================================

/// Computes the cumulative distribution function (CDF) from a histogram.
///
/// The CDF is normalized to [0.0, 1.0]. Empty histograms produce a linear ramp.
fn compute_cdf(histogram: &[f64]) -> Vec<f64> {
    if histogram.is_empty() {
        return Vec::new();
    }

    let total: f64 = histogram.iter().sum();
    if total < MIN_PIXEL_THRESHOLD {
        // Degenerate case: return linear identity mapping
        let denom = histogram.len().saturating_sub(1).max(1) as f64;
        return (0..histogram.len())
            .map(|i| i as f64 / denom)
            .collect();
    }

    let mut cdf = Vec::with_capacity(histogram.len());
    let mut cumulative = 0.0;
    for &count in histogram {
        cumulative += count;
        cdf.push(cumulative / total);
    }
    cdf
}

/// Generates a transfer function by matching two CDFs (histogram specification).
///
/// For each input intensity `i` in the target, finds the output intensity `j`
/// in the reference such that `CDF_ref(j) ≈ CDF_target(i)`.
///
/// Returns a 256-element lookup table mapping target intensity → reference intensity.
fn histogram_match_transfer(target_hist: &[f64], reference_hist: &[f64]) -> Vec<f64> {
    let cdf_target = compute_cdf(target_hist);
    let cdf_reference = compute_cdf(reference_hist);
    let n = cdf_target.len().min(cdf_reference.len());

    let mut transfer = vec![0.0; n];

    for i in 0..n {
        let target_val = cdf_target[i];

        // Binary search for the closest CDF value in reference
        let mut best_j = 0;
        let mut best_diff = f64::MAX;

        for (j, &cdf_ref_val) in cdf_reference.iter().enumerate().take(n) {
            let diff = (cdf_ref_val - target_val).abs();
            if diff < best_diff {
                best_diff = diff;
                best_j = j;
            }
            // CDF is monotonically increasing — once we pass the target, stop early
            if cdf_ref_val > target_val && diff > best_diff {
                break;
            }
        }

        transfer[i] = best_j as f64;
    }

    transfer
}

/// Applies moving-average smoothing to a transfer function.
///
/// Prevents the resulting curve from having abrupt jumps caused by
/// sparse histogram bins.
fn smooth_transfer(transfer: &[f64], radius: usize) -> Vec<f64> {
    let n = transfer.len();
    let mut smoothed = Vec::with_capacity(n);

    for i in 0..n {
        let start = i.saturating_sub(radius);
        let end = (i + radius + 1).min(n);
        let window = &transfer[start..end];
        let avg = window.iter().sum::<f64>() / window.len() as f64;
        smoothed.push(avg);
    }

    smoothed
}

/// Samples a 256-element transfer function into a set of `CurvePoint` values.
///
/// Selects evenly spaced sample points plus the endpoints, yielding
/// a compact curve representation suitable for the Curves effect.
fn sample_curve_points(transfer: &[f64], sample_count: usize) -> Vec<CurvePoint> {
    let n = transfer.len();
    if n == 0 {
        return vec![CurvePoint::new(0.0, 0.0), CurvePoint::new(1.0, 1.0)];
    }

    let max_val = (n - 1) as f64;
    let mut points = Vec::with_capacity(sample_count);

    for s in 0..sample_count {
        let t = s as f64 / (sample_count - 1).max(1) as f64;
        let index = (t * max_val).round() as usize;
        let clamped_index = index.min(n - 1);

        let x = clamped_index as f64 / max_val;
        let y = transfer[clamped_index] / max_val;

        points.push(CurvePoint::new(x, y));
    }

    // Ensure endpoints are always present
    if let Some(first) = points.first_mut() {
        first.x = 0.0;
    }
    if let Some(last) = points.last_mut() {
        last.x = 1.0;
    }

    points
}

/// Checks whether a curve is effectively an identity (no-op) curve.
///
/// Returns true if all points are within `threshold` of the diagonal.
pub fn is_identity_curve(points: &[CurvePoint], threshold: f64) -> bool {
    points.iter().all(|p| (p.y - p.x).abs() <= threshold)
}

// =============================================================================
// Color Correction Computation
// =============================================================================

/// Computes the color correction needed to match a target profile to a reference.
///
/// The correction consists of per-channel transfer curves (via histogram matching)
/// plus brightness, saturation, and temperature shift estimates.
pub fn compute_color_correction(
    reference: &ColorProfile,
    target: &ColorProfile,
) -> ColorCorrection {
    // Per-channel histogram matching → transfer curves
    let transfer_r = histogram_match_transfer(&target.histogram_r, &reference.histogram_r);
    let transfer_g = histogram_match_transfer(&target.histogram_g, &reference.histogram_g);
    let transfer_b = histogram_match_transfer(&target.histogram_b, &reference.histogram_b);

    // Smooth the transfer functions to avoid jagged curves
    let smooth_r = smooth_transfer(&transfer_r, SMOOTHING_RADIUS);
    let smooth_g = smooth_transfer(&transfer_g, SMOOTHING_RADIUS);
    let smooth_b = smooth_transfer(&transfer_b, SMOOTHING_RADIUS);

    // Sample into CurvePoint vectors
    let red_curve = sample_curve_points(&smooth_r, CURVE_SAMPLE_COUNT);
    let green_curve = sample_curve_points(&smooth_g, CURVE_SAMPLE_COUNT);
    let blue_curve = sample_curve_points(&smooth_b, CURVE_SAMPLE_COUNT);

    // Brightness offset: difference in mean luminance, normalized to [-1, 1]
    let brightness_offset = (reference.brightness - target.brightness) / 255.0;

    // Saturation multiplier: ratio of mean saturations
    let saturation_multiplier = if target.saturation > 0.001 {
        (reference.saturation / target.saturation).clamp(0.2, 5.0)
    } else {
        1.0
    };

    // Temperature shift: estimated from white point red/blue ratio difference
    // Positive = warmer (more red), negative = cooler (more blue)
    let ref_temp = reference.white_point[0] - reference.white_point[2]; // R - B
    let target_temp = target.white_point[0] - target.white_point[2];
    let temperature_shift = ((ref_temp - target_temp) / 255.0).clamp(-1.0, 1.0);

    ColorCorrection {
        red_curve,
        green_curve,
        blue_curve,
        brightness_offset,
        saturation_multiplier,
        temperature_shift,
    }
}

// =============================================================================
// Frame Color Analysis (FFmpeg)
// =============================================================================

/// Analyzes the color profile of a video frame using FFmpeg.
///
/// Extracts RGB histograms, average color, white point, brightness,
/// and saturation from the frame at the given path.
///
/// The frame should already be extracted as an image file (JPEG/PNG).
pub async fn analyze_frame_color(
    ffmpeg_path: &Path,
    frame_path: &Path,
) -> CoreResult<ColorProfile> {
    if !frame_path.exists() {
        return Err(CoreError::ValidationError(format!(
            "Frame file does not exist: {}",
            frame_path.display()
        )));
    }

    // Run FFmpeg with signalstats filter to get per-frame color metrics
    let signalstats = run_signalstats(ffmpeg_path, frame_path).await?;

    // Run FFmpeg to extract per-channel histograms
    let histograms = run_histogram_extraction(ffmpeg_path, frame_path).await?;

    let mut profile = ColorProfile::empty();
    profile.histogram_r = histograms.0;
    profile.histogram_g = histograms.1;
    profile.histogram_b = histograms.2;

    // Parse signalstats output for color metrics
    profile.avg_color = signalstats.avg_color;
    profile.brightness = signalstats.brightness;
    profile.saturation = signalstats.saturation;

    // Estimate white point from histogram: top 1% percentile per channel
    profile.white_point = [
        estimate_percentile(&profile.histogram_r, 0.99),
        estimate_percentile(&profile.histogram_g, 0.99),
        estimate_percentile(&profile.histogram_b, 0.99),
    ];

    Ok(profile)
}

/// Intermediate signalstats parsing result.
struct SignalStatsResult {
    avg_color: [f64; 3],
    brightness: f64,
    saturation: f64,
}

/// Runs FFmpeg signalstats filter to extract color metrics.
async fn run_signalstats(ffmpeg_path: &Path, frame_path: &Path) -> CoreResult<SignalStatsResult> {
    let mut cmd = Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);

    let output = cmd
        .args([
            "-hide_banner",
            "-i",
            &frame_path.to_string_lossy(),
            "-vf",
            "signalstats=stat=tout+vrep+brng,metadata=mode=print",
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to run signalstats: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CoreError::Internal(format!(
            "signalstats failed for {}: {}",
            frame_path.display(),
            stderr.trim()
        )));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_signalstats_output(&stderr)
}

/// Parses FFmpeg signalstats metadata output.
fn parse_signalstats_output(output: &str) -> CoreResult<SignalStatsResult> {
    let mut avg_y = 128.0_f64;
    let mut avg_u = 128.0_f64;
    let mut avg_v = 128.0_f64;
    let mut saturation = 0.0_f64;

    for line in output.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("lavfi.signalstats.YAVG=") {
            avg_y = val.trim().parse().unwrap_or(128.0);
        } else if let Some(val) = line.strip_prefix("lavfi.signalstats.UAVG=") {
            avg_u = val.trim().parse().unwrap_or(128.0);
        } else if let Some(val) = line.strip_prefix("lavfi.signalstats.VAVG=") {
            avg_v = val.trim().parse().unwrap_or(128.0);
        } else if let Some(val) = line.strip_prefix("lavfi.signalstats.SATAVG=") {
            saturation = val.trim().parse().unwrap_or(0.0);
        }
    }

    // Convert YUV averages to approximate RGB
    let avg_color = yuv_to_rgb(avg_y, avg_u, avg_v);

    // Normalize saturation to 0.0–1.0 (FFmpeg reports 0–~181 for BT.601)
    let normalized_sat = (saturation / 181.0).clamp(0.0, 1.0);

    Ok(SignalStatsResult {
        avg_color,
        brightness: avg_y,
        saturation: normalized_sat,
    })
}

/// Converts YUV (BT.601) to RGB.
fn yuv_to_rgb(y: f64, u: f64, v: f64) -> [f64; 3] {
    let r = (y + 1.402 * (v - 128.0)).clamp(0.0, 255.0);
    let g = (y - 0.344136 * (u - 128.0) - 0.714136 * (v - 128.0)).clamp(0.0, 255.0);
    let b = (y + 1.772 * (u - 128.0)).clamp(0.0, 255.0);
    [r, g, b]
}

/// Runs FFmpeg to extract per-channel RGB histograms from a frame.
///
/// Uses the `histogram` filter in `levels` mode with metadata output
/// to read pixel count per intensity level per channel.
async fn run_histogram_extraction(
    ffmpeg_path: &Path,
    frame_path: &Path,
) -> CoreResult<(Vec<f64>, Vec<f64>, Vec<f64>)> {
    let mut cmd = Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);

    // Use format=gbrp to split channels, then extract histogram metadata
    let output = cmd
        .args([
            "-hide_banner",
            "-i",
            &frame_path.to_string_lossy(),
            "-vf",
            "format=gbrp,histogram=level_height=256:display_mode=stack,metadata=mode=print",
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to extract histograms: {}", e)))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_histogram_from_signalstats(ffmpeg_path, frame_path, &stderr).await
}

/// Falls back to computing histograms via per-channel averages if metadata isn't available.
///
/// Uses FFmpeg `extractplanes` + `stats_file` to get per-pixel distributions.
/// As a practical fallback, synthesizes histograms from signalstats percentile data.
async fn parse_histogram_from_signalstats(
    ffmpeg_path: &Path,
    frame_path: &Path,
    _metadata_output: &str,
) -> CoreResult<(Vec<f64>, Vec<f64>, Vec<f64>)> {
    // Use rawvideo + pipe to read actual pixel values
    let mut cmd = Command::new(ffmpeg_path);
    configure_tokio_command(&mut cmd);

    let output = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &frame_path.to_string_lossy(),
            "-vf",
            "format=rgb24",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| CoreError::Internal(format!("Failed to extract raw pixels: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CoreError::Internal(format!(
            "Raw pixel extraction failed: {}",
            stderr
        )));
    }

    compute_histograms_from_raw_rgb(&output.stdout)
}

/// Computes RGB histograms from raw RGB24 pixel data.
///
/// Each pixel is 3 consecutive bytes: R, G, B.
fn compute_histograms_from_raw_rgb(
    raw_data: &[u8],
) -> CoreResult<(Vec<f64>, Vec<f64>, Vec<f64>)> {
    let mut hist_r = vec![0.0_f64; HISTOGRAM_BINS];
    let mut hist_g = vec![0.0_f64; HISTOGRAM_BINS];
    let mut hist_b = vec![0.0_f64; HISTOGRAM_BINS];

    if raw_data.len() < 3 {
        debug!("Raw pixel data too small ({} bytes), returning empty histograms", raw_data.len());
        return Ok((hist_r, hist_g, hist_b));
    }

    for pixel in raw_data.chunks_exact(3) {
        hist_r[pixel[0] as usize] += 1.0;
        hist_g[pixel[1] as usize] += 1.0;
        hist_b[pixel[2] as usize] += 1.0;
    }

    Ok((hist_r, hist_g, hist_b))
}

/// Estimates the intensity value at a given percentile from a histogram.
fn estimate_percentile(histogram: &[f64], percentile: f64) -> f64 {
    let total: f64 = histogram.iter().sum();
    if total < MIN_PIXEL_THRESHOLD {
        return 128.0;
    }

    let target = total * percentile;
    let mut cumulative = 0.0;

    for (i, &count) in histogram.iter().enumerate() {
        cumulative += count;
        if cumulative >= target {
            return i as f64;
        }
    }

    255.0
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // BDD: Histogram CDF computation
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_normalized_cdf_from_histogram() {
        // Given a simple histogram with known distribution
        let mut histogram = vec![0.0; 256];
        histogram[0] = 100.0; // 100 black pixels
        histogram[128] = 100.0; // 100 mid-gray pixels
        histogram[255] = 100.0; // 100 white pixels

        // When computing the CDF
        let cdf = compute_cdf(&histogram);

        // Then the CDF should be monotonically increasing and end at 1.0
        assert_eq!(cdf.len(), 256);
        assert!((cdf[0] - 1.0 / 3.0).abs() < 0.01, "CDF at 0 should be ~0.333");
        assert!((cdf[128] - 2.0 / 3.0).abs() < 0.01, "CDF at 128 should be ~0.667");
        assert!((cdf[255] - 1.0).abs() < 0.001, "CDF at 255 should be 1.0");

        // CDF should be non-decreasing
        for i in 1..cdf.len() {
            assert!(cdf[i] >= cdf[i - 1], "CDF must be non-decreasing at index {}", i);
        }
    }

    #[test]
    fn should_return_identity_cdf_for_empty_histogram() {
        // Given an empty histogram (all zeros)
        let histogram = vec![0.0; 256];

        // When computing the CDF
        let cdf = compute_cdf(&histogram);

        // Then it should be a linear ramp (identity mapping)
        assert_eq!(cdf.len(), 256);
        assert!((cdf[0] - 0.0).abs() < 0.01);
        assert!((cdf[255] - 1.0).abs() < 0.01);
    }

    // -------------------------------------------------------------------------
    // BDD: Histogram matching transfer function
    // -------------------------------------------------------------------------

    #[test]
    fn should_produce_identity_transfer_for_identical_histograms() {
        // Given two identical uniform histograms
        let histogram = vec![10.0; 256];

        // When computing the transfer function
        let transfer = histogram_match_transfer(&histogram, &histogram);

        // Then the transfer should be approximately identity (i → i)
        for (i, &val) in transfer.iter().enumerate() {
            assert!(
                (val - i as f64).abs() <= 1.0,
                "Transfer at {} should be ~{}, got {}",
                i,
                i,
                val
            );
        }
    }

    #[test]
    fn should_shift_dark_target_toward_bright_reference() {
        // Given a dark target (concentrated at low values) and bright reference
        let mut target_hist = vec![0.0; 256];
        for i in 0..64 {
            target_hist[i] = 100.0;
        }

        let mut reference_hist = vec![0.0; 256];
        for i in 192..256 {
            reference_hist[i] = 100.0;
        }

        // When computing the transfer function
        let transfer = histogram_match_transfer(&target_hist, &reference_hist);

        // Then dark input values should map to bright output values
        assert!(
            transfer[32] > 128.0,
            "Dark input should map to bright output, got {}",
            transfer[32]
        );
    }

    #[test]
    fn should_compress_wide_target_to_narrow_reference() {
        // Given a wide-range target and narrow-range reference
        let target_hist = vec![10.0; 256]; // Uniform across full range

        let mut reference_hist = vec![0.0; 256];
        for i in 100..156 {
            reference_hist[i] = 46.0; // Concentrated in mid-range
        }

        // When computing the transfer function
        let transfer = histogram_match_transfer(&target_hist, &reference_hist);

        // Then the midpoint should map into the reference range (100–155)
        let mid_val = transfer[128];
        assert!(
            (100.0..=155.0).contains(&mid_val),
            "Midpoint should map into reference range [100,155], got {}",
            mid_val
        );

        // The output range should be much smaller than the input range
        let min_out = transfer.iter().copied().fold(f64::MAX, f64::min);
        let max_out = transfer.iter().copied().fold(f64::MIN, f64::max);
        let output_range = max_out - min_out;
        assert!(
            output_range < 200.0,
            "Output range should be compressed (< 200), got {}",
            output_range
        );
    }

    // -------------------------------------------------------------------------
    // BDD: Transfer function smoothing
    // -------------------------------------------------------------------------

    #[test]
    fn should_smooth_transfer_function_without_changing_trend() {
        // Given a transfer function with a spike
        let mut transfer = vec![0.0; 256];
        for (i, val) in transfer.iter_mut().enumerate() {
            *val = i as f64;
        }
        transfer[128] = 200.0; // Spike at midpoint

        // When smoothing
        let smoothed = smooth_transfer(&transfer, SMOOTHING_RADIUS);

        // Then the spike should be attenuated
        assert!(
            smoothed[128] < 200.0,
            "Spike should be smoothed, got {}",
            smoothed[128]
        );
        // But the general trend should be preserved
        assert!(smoothed[0] < smoothed[127]);
        assert!(smoothed[200] > smoothed[100]);
    }

    // -------------------------------------------------------------------------
    // BDD: Curve point sampling
    // -------------------------------------------------------------------------

    #[test]
    fn should_sample_identity_curve_from_identity_transfer() {
        // Given an identity transfer function
        let transfer: Vec<f64> = (0..256).map(|i| i as f64).collect();

        // When sampling curve points
        let points = sample_curve_points(&transfer, CURVE_SAMPLE_COUNT);

        // Then all points should be on the diagonal (y ≈ x)
        assert_eq!(points.len(), CURVE_SAMPLE_COUNT);
        assert!(
            is_identity_curve(&points, 0.02),
            "Sampled points should form an identity curve"
        );
    }

    #[test]
    fn should_always_include_endpoints() {
        // Given any transfer function
        let transfer: Vec<f64> = (0..256).map(|i| (i as f64).sqrt() * 16.0).collect();

        // When sampling
        let points = sample_curve_points(&transfer, 8);

        // Then first point x=0.0 and last point x=1.0
        assert_eq!(points.first().unwrap().x, 0.0);
        assert_eq!(points.last().unwrap().x, 1.0);
    }

    // -------------------------------------------------------------------------
    // BDD: Color correction computation
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_identity_correction_for_identical_profiles() {
        // Given two identical color profiles
        let profile = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [128.0, 128.0, 128.0],
            white_point: [240.0, 240.0, 240.0],
            brightness: 128.0,
            saturation: 0.5,
        };

        // When computing the correction
        let correction = compute_color_correction(&profile, &profile);

        // Then curves should be near-identity and offsets near zero
        assert!(
            is_identity_curve(&correction.red_curve, 0.05),
            "Red curve should be near-identity"
        );
        assert!(
            is_identity_curve(&correction.green_curve, 0.05),
            "Green curve should be near-identity"
        );
        assert!(
            is_identity_curve(&correction.blue_curve, 0.05),
            "Blue curve should be near-identity"
        );
        assert!(
            correction.brightness_offset.abs() < 0.01,
            "Brightness offset should be ~0"
        );
        assert!(
            (correction.saturation_multiplier - 1.0).abs() < 0.01,
            "Saturation multiplier should be ~1.0"
        );
    }

    #[test]
    fn should_detect_warm_to_cool_temperature_shift() {
        // Given a warm reference (more red) and cool target (more blue)
        let reference = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [180.0, 128.0, 80.0],
            white_point: [250.0, 230.0, 200.0], // Warm white
            brightness: 128.0,
            saturation: 0.5,
        };

        let target = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [80.0, 128.0, 180.0],
            white_point: [200.0, 230.0, 250.0], // Cool white
            brightness: 128.0,
            saturation: 0.5,
        };

        // When computing correction
        let correction = compute_color_correction(&reference, &target);

        // Then temperature shift should be positive (warming the cool target)
        assert!(
            correction.temperature_shift > 0.0,
            "Should detect need to warm target, got {}",
            correction.temperature_shift
        );
    }

    #[test]
    fn should_detect_brightness_difference() {
        // Given a bright reference and dark target
        let reference = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [200.0, 200.0, 200.0],
            white_point: [255.0, 255.0, 255.0],
            brightness: 200.0,
            saturation: 0.5,
        };

        let target = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [60.0, 60.0, 60.0],
            white_point: [180.0, 180.0, 180.0],
            brightness: 60.0,
            saturation: 0.5,
        };

        // When computing correction
        let correction = compute_color_correction(&reference, &target);

        // Then brightness offset should be positive (brighten the target)
        assert!(
            correction.brightness_offset > 0.3,
            "Should detect need to brighten target, got {}",
            correction.brightness_offset
        );
    }

    #[test]
    fn should_detect_saturation_difference() {
        // Given a saturated reference and desaturated target
        let reference = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [128.0, 128.0, 128.0],
            white_point: [240.0, 240.0, 240.0],
            brightness: 128.0,
            saturation: 0.8,
        };

        let target = ColorProfile {
            histogram_r: vec![10.0; 256],
            histogram_g: vec![10.0; 256],
            histogram_b: vec![10.0; 256],
            avg_color: [128.0, 128.0, 128.0],
            white_point: [240.0, 240.0, 240.0],
            brightness: 128.0,
            saturation: 0.3,
        };

        // When computing correction
        let correction = compute_color_correction(&reference, &target);

        // Then saturation multiplier should be > 1 (increase saturation)
        assert!(
            correction.saturation_multiplier > 2.0,
            "Should detect need to increase saturation, got {}",
            correction.saturation_multiplier
        );
    }

    // -------------------------------------------------------------------------
    // BDD: Raw pixel histogram computation
    // -------------------------------------------------------------------------

    #[test]
    fn should_compute_histograms_from_raw_rgb_data() {
        // Given raw RGB24 data: 2 pixels — (255, 0, 0) red and (0, 0, 255) blue
        let raw = vec![255, 0, 0, 0, 0, 255];

        // When computing histograms
        let (hist_r, hist_g, hist_b) = compute_histograms_from_raw_rgb(&raw).unwrap();

        // Then red histogram should have counts at 0 and 255
        assert_eq!(hist_r[255], 1.0);
        assert_eq!(hist_r[0], 1.0);

        // Green should only have counts at 0
        assert_eq!(hist_g[0], 2.0);

        // Blue should have counts at 0 and 255
        assert_eq!(hist_b[0], 1.0);
        assert_eq!(hist_b[255], 1.0);
    }

    #[test]
    fn should_handle_empty_raw_data_gracefully() {
        // Given empty raw data
        let raw: Vec<u8> = vec![];

        // When computing histograms
        let (hist_r, hist_g, hist_b) = compute_histograms_from_raw_rgb(&raw).unwrap();

        // Then all histograms should be zero
        assert_eq!(hist_r.iter().sum::<f64>(), 0.0);
        assert_eq!(hist_g.iter().sum::<f64>(), 0.0);
        assert_eq!(hist_b.iter().sum::<f64>(), 0.0);
    }

    // -------------------------------------------------------------------------
    // BDD: Signalstats parsing
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_signalstats_metadata_output() {
        // Given typical FFmpeg signalstats metadata output
        let output = "\
            [Parsed_metadata_0 @ 0x1234] frame:0 pts:0 pts_time:0.000000\n\
            lavfi.signalstats.YAVG=150.5\n\
            lavfi.signalstats.UAVG=120.0\n\
            lavfi.signalstats.VAVG=140.0\n\
            lavfi.signalstats.SATAVG=90.5\n\
        ";

        // When parsing
        let result = parse_signalstats_output(output).unwrap();

        // Then brightness should match YAVG
        assert!((result.brightness - 150.5).abs() < 0.1);

        // And saturation should be normalized
        assert!(result.saturation > 0.0 && result.saturation < 1.0);

        // And avg_color should be derived from YUV→RGB conversion
        assert_eq!(result.avg_color.len(), 3);
        assert!(result.avg_color[0] >= 0.0 && result.avg_color[0] <= 255.0);
    }

    #[test]
    fn should_handle_missing_signalstats_fields() {
        // Given partial signalstats output
        let output = "lavfi.signalstats.YAVG=100.0\n";

        // When parsing
        let result = parse_signalstats_output(output).unwrap();

        // Then missing fields should use defaults
        assert!((result.brightness - 100.0).abs() < 0.1);
        assert_eq!(result.saturation, 0.0); // SATAVG defaulted to 0
    }

    // -------------------------------------------------------------------------
    // BDD: YUV to RGB conversion
    // -------------------------------------------------------------------------

    #[test]
    fn should_convert_neutral_gray_yuv_to_rgb() {
        // Given neutral gray in YUV (Y=128, U=128, V=128)
        let [r, g, b] = yuv_to_rgb(128.0, 128.0, 128.0);

        // Then RGB should be approximately gray (128, 128, 128)
        assert!((r - 128.0).abs() < 1.0, "R should be ~128, got {}", r);
        assert!((g - 128.0).abs() < 1.0, "G should be ~128, got {}", g);
        assert!((b - 128.0).abs() < 1.0, "B should be ~128, got {}", b);
    }

    // -------------------------------------------------------------------------
    // BDD: Percentile estimation
    // -------------------------------------------------------------------------

    #[test]
    fn should_estimate_correct_percentile_from_histogram() {
        // Given a histogram with known distribution
        let mut histogram = vec![0.0; 256];
        for i in 0..256 {
            histogram[i] = 1.0; // Uniform
        }

        // When estimating 50th percentile
        let p50 = estimate_percentile(&histogram, 0.50);

        // Then it should be approximately 127-128
        assert!(
            (p50 - 127.0).abs() <= 1.0,
            "50th percentile should be ~127, got {}",
            p50
        );

        // 99th percentile should be near 255
        let p99 = estimate_percentile(&histogram, 0.99);
        assert!(
            p99 >= 250.0,
            "99th percentile should be >= 250, got {}",
            p99
        );
    }
}
