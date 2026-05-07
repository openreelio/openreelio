/// NCC (Normalized Cross-Correlation) point tracking algorithm.
///
/// Tracks a user-selected point across video frames using template matching.
/// FFmpeg extracts frames as raw grayscale via pipe, then pure Rust performs
/// the NCC computation per frame.
use std::path::Path;

use super::error::TrackingError;
use super::models::{TrackPointData, TrackingConfig, TrackingResultData, TRACKING_WORKING_HEIGHT};

/// Parameters for the NCC match search.
pub struct NccMatchParams<'a> {
    pub frame: &'a [u8],
    pub frame_width: u32,
    pub frame_height: u32,
    pub template: &'a [u8],
    pub template_width: u32,
    pub template_height: u32,
    pub search_cx: u32,
    pub search_cy: u32,
    pub search_size: u32,
}

/// Input parameters for the high-level `track_point` function.
pub struct TrackPointInput<'a> {
    pub ffmpeg_path: &'a Path,
    pub video_path: &'a Path,
    pub start_frame: usize,
    pub origin_x: f64,
    pub origin_y: f64,
    pub video_width: u32,
    pub video_height: u32,
    pub fps: f64,
    /// Source start time for the clip segment being tracked.
    pub clip_source_in_sec: f64,
    /// Total number of frames available in the clip segment.
    pub clip_total_frames: usize,
}

/// Input parameters for the `track_frames` function.
pub struct TrackFramesInput<'a> {
    pub frames: &'a [Vec<u8>],
    pub frame_width: u32,
    pub frame_height: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub start_frame_index: usize,
}

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/// Compute working resolution maintaining aspect ratio.
/// Returns (width, height) where height = TRACKING_WORKING_HEIGHT.
pub fn compute_working_resolution(src_width: u32, src_height: u32) -> (u32, u32) {
    if src_height == 0 || src_width == 0 {
        return (TRACKING_WORKING_HEIGHT, TRACKING_WORKING_HEIGHT);
    }
    let aspect = src_width as f64 / src_height as f64;
    let h = TRACKING_WORKING_HEIGHT;
    // Width must be even for FFmpeg rawvideo.
    let raw_w = (h as f64 * aspect).min(u32::MAX as f64) as u32;
    let w = (raw_w + 1) & !1;
    (w, h)
}

/// Extract all frames in a time range as raw grayscale bytes via FFmpeg pipe.
///
/// Each frame is `width * height` bytes (8-bit grayscale).
pub async fn extract_frames_grayscale(
    ffmpeg_path: &Path,
    video_path: &Path,
    start_sec: f64,
    duration_sec: f64,
    width: u32,
    height: u32,
) -> Result<Vec<Vec<u8>>, TrackingError> {
    let frame_bytes = (width * height) as usize;

    let mut cmd = tokio::process::Command::new(ffmpeg_path);
    crate::core::process::configure_tokio_command(&mut cmd);

    let output = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            &format!("{start_sec:.6}"),
            "-i",
        ])
        .arg(video_path)
        .args([
            "-t",
            &format!("{duration_sec:.6}"),
            "-vf",
            &format!("scale={width}:{height},format=gray"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| TrackingError::FFmpeg(format!("Failed to spawn FFmpeg: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrackingError::FFmpeg(format!(
            "FFmpeg frame extraction failed: {stderr}"
        )));
    }

    let raw = output.stdout;
    if raw.len() < frame_bytes {
        return Err(TrackingError::FFmpeg(
            "No frames extracted from video".to_string(),
        ));
    }

    let frame_count = raw.len() / frame_bytes;
    let frames: Vec<Vec<u8>> = (0..frame_count)
        .map(|i| raw[i * frame_bytes..(i + 1) * frame_bytes].to_vec())
        .collect();

    Ok(frames)
}

// ---------------------------------------------------------------------------
// Template extraction
// ---------------------------------------------------------------------------

/// Crop a square template patch from a grayscale frame.
///
/// Clamps to frame boundaries when the template would extend outside the frame.
/// Returns `(template_pixels, actual_w, actual_h, crop_x0, crop_y0)` so that
/// callers know where the tracked point sits within the extracted patch.
pub fn extract_template(
    frame: &[u8],
    frame_width: u32,
    frame_height: u32,
    center_x: u32,
    center_y: u32,
    size: u32,
) -> (Vec<u8>, u32, u32, u32, u32) {
    let half = size / 2;

    // Clamp to frame bounds
    let x0 = center_x.saturating_sub(half);
    let y0 = center_y.saturating_sub(half);
    let x1 = (x0 + size).min(frame_width);
    let y1 = (y0 + size).min(frame_height);
    let actual_w = x1 - x0;
    let actual_h = y1 - y0;

    let mut template = Vec::with_capacity((actual_w * actual_h) as usize);
    for row in y0..y1 {
        let start = (row * frame_width + x0) as usize;
        let end = start + actual_w as usize;
        if end <= frame.len() {
            template.extend_from_slice(&frame[start..end]);
        }
    }

    (template, actual_w, actual_h, x0, y0)
}

// ---------------------------------------------------------------------------
// NCC matching
// ---------------------------------------------------------------------------

/// Normalized Cross-Correlation match.
///
/// Searches for the template within a square search window centered at
/// (`search_cx`, `search_cy`). Returns `(best_x, best_y, confidence)`
/// where x,y are the center position of the best match.
pub fn ncc_match(params: &NccMatchParams<'_>) -> (u32, u32, f64) {
    let NccMatchParams {
        frame,
        frame_width,
        frame_height,
        template,
        template_width,
        template_height,
        search_cx,
        search_cy,
        search_size,
    } = params;
    let (frame_width, frame_height) = (*frame_width, *frame_height);
    let (template_width, template_height) = (*template_width, *template_height);
    let (search_cx, search_cy, search_size) = (*search_cx, *search_cy, *search_size);

    let half_search = search_size / 2;
    let half_tw = template_width / 2;
    let half_th = template_height / 2;

    // Convert search center to top-left offset for template placement.
    // The search center is the expected center of the match, but we iterate
    // over top-left positions, so offset by half the template size.
    let center_tl_x = search_cx.saturating_sub(half_tw);
    let center_tl_y = search_cy.saturating_sub(half_th);

    // Search window bounds (top-left corner of template placement)
    let sx0 = center_tl_x.saturating_sub(half_search) as i32;
    let sy0 = center_tl_y.saturating_sub(half_search) as i32;
    let sx1 = ((center_tl_x + half_search) as i32).min(frame_width as i32 - template_width as i32);
    let sy1 =
        ((center_tl_y + half_search) as i32).min(frame_height as i32 - template_height as i32);

    if sx1 < sx0 || sy1 < sy0 {
        return (search_cx, search_cy, 0.0);
    }

    // Precompute template mean and norm
    let tpl_len = template.len() as f64;
    let tpl_sum: f64 = template.iter().map(|&v| v as f64).sum();
    let tpl_mean = tpl_sum / tpl_len;
    let tpl_norm: f64 = template
        .iter()
        .map(|&v| {
            let d = v as f64 - tpl_mean;
            d * d
        })
        .sum::<f64>()
        .sqrt();

    if tpl_norm < 1e-10 {
        // Uniform template — cannot match meaningfully
        return (search_cx, search_cy, 0.0);
    }

    let mut best_x = search_cx;
    let mut best_y = search_cy;
    let mut best_ncc: f64 = -1.0;

    for sy in sy0..=sy1 {
        for sx in sx0..=sx1 {
            let sx_u = sx as u32;
            let sy_u = sy as u32;

            // Compute NCC at this position
            let mut region_sum: f64 = 0.0;
            let mut region_sq_sum: f64 = 0.0;
            let mut cross_sum: f64 = 0.0;
            let mut count: usize = 0;

            for ty in 0..template_height {
                let fy = sy_u + ty;
                if fy >= frame_height {
                    break;
                }
                for tx in 0..template_width {
                    let fx = sx_u + tx;
                    if fx >= frame_width {
                        break;
                    }
                    let fi = (fy * frame_width + fx) as usize;
                    let ti = (ty * template_width + tx) as usize;
                    if fi < frame.len() && ti < template.len() {
                        let fv = frame[fi] as f64;
                        let tv = template[ti] as f64;
                        region_sum += fv;
                        region_sq_sum += fv * fv;
                        cross_sum += fv * tv;
                        count += 1;
                    }
                }
            }

            if count == 0 || count < template.len() {
                // Partial overlap — NCC formula requires full template coverage
                continue;
            }

            let n = count as f64;
            let region_mean = region_sum / n;
            let region_norm = (region_sq_sum - region_sum * region_mean).max(0.0).sqrt();

            if region_norm < 1e-10 {
                continue;
            }

            let ncc = (cross_sum - region_sum * tpl_mean) / (region_norm * tpl_norm);

            if ncc > best_ncc {
                best_ncc = ncc;
                best_x = sx_u + half_tw;
                best_y = sy_u + half_th;
            }
        }
    }

    (best_x, best_y, best_ncc.clamp(0.0, 1.0))
}

// ---------------------------------------------------------------------------
// Main tracking function
// ---------------------------------------------------------------------------

const MAX_TRACKING_BUFFER_BYTES: usize = 512 * 1024 * 1024;

fn estimate_tracking_buffer_bytes(width: u32, height: u32, frame_count: usize) -> Option<usize> {
    let frame_bytes = (width as usize).checked_mul(height as usize)?;
    frame_bytes.checked_mul(frame_count)
}

fn compute_tracking_window(
    input: &TrackPointInput<'_>,
    work_w: u32,
    work_h: u32,
) -> Result<(f64, f64), TrackingError> {
    if input.clip_total_frames == 0 {
        return Err(TrackingError::InvalidInput(
            "Clip must contain at least one frame".to_string(),
        ));
    }
    if input.start_frame >= input.clip_total_frames {
        return Err(TrackingError::InvalidInput(format!(
            "Start frame {} is out of range for {} clip frames",
            input.start_frame, input.clip_total_frames
        )));
    }

    let frames_to_track = input.clip_total_frames - input.start_frame;
    if let Some(required_bytes) = estimate_tracking_buffer_bytes(work_w, work_h, frames_to_track) {
        if required_bytes > MAX_TRACKING_BUFFER_BYTES {
            return Err(TrackingError::InvalidInput(format!(
                "Tracking range is too large ({} frames at {}x{} exceeds {} MB). Trim the clip or start later.",
                frames_to_track,
                work_w,
                work_h,
                MAX_TRACKING_BUFFER_BYTES / (1024 * 1024)
            )));
        }
    }

    let start_sec = input.clip_source_in_sec + input.start_frame as f64 / input.fps;
    let duration_sec = frames_to_track as f64 / input.fps;
    Ok((start_sec, duration_sec))
}

/// Track a point across video frames.
///
/// Extracts frames via FFmpeg, then uses NCC template matching to follow
/// the selected point. Reports progress through the optional channel.
pub async fn track_point(
    input: &TrackPointInput<'_>,
    config: &TrackingConfig,
    progress_tx: Option<&tokio::sync::mpsc::Sender<f32>>,
) -> Result<TrackingResultData, TrackingError> {
    let TrackPointInput {
        ffmpeg_path,
        video_path,
        start_frame,
        origin_x,
        origin_y,
        video_width,
        video_height,
        fps,
        ..
    } = input;

    // Validate inputs
    let valid_range = 0.0..=1.0;
    if !valid_range.contains(origin_x) || !valid_range.contains(origin_y) {
        return Err(TrackingError::InvalidInput(
            "Origin coordinates must be in 0.0–1.0 range".to_string(),
        ));
    }
    if *fps <= 0.0 {
        return Err(TrackingError::InvalidInput("FPS must be > 0".to_string()));
    }
    if input.clip_source_in_sec < 0.0 {
        return Err(TrackingError::InvalidInput(
            "Clip source start must be >= 0".to_string(),
        ));
    }

    // Compute working resolution
    let (work_w, work_h) = compute_working_resolution(*video_width, *video_height);

    // Extract frames for the visible clip window, not the entire source asset.
    let (start_sec, duration_sec) = compute_tracking_window(input, work_w, work_h)?;

    let frames = extract_frames_grayscale(
        ffmpeg_path,
        video_path,
        start_sec,
        duration_sec,
        work_w,
        work_h,
    )
    .await?;

    if frames.is_empty() {
        return Err(TrackingError::FFmpeg(
            "No frames extracted for tracking".to_string(),
        ));
    }

    // Move CPU-heavy tracking to a dedicated thread to avoid
    // blocking the Tokio executor (worker separation principle).
    let tf_origin_x = *origin_x;
    let tf_origin_y = *origin_y;
    let tf_start_frame = *start_frame;
    let config_clone = config.clone();
    let progress_tx_owned = progress_tx.cloned();

    tokio::task::spawn_blocking(move || {
        let tf_input = TrackFramesInput {
            frames: &frames,
            frame_width: work_w,
            frame_height: work_h,
            origin_x: tf_origin_x,
            origin_y: tf_origin_y,
            start_frame_index: tf_start_frame,
        };
        track_frames(&tf_input, &config_clone, progress_tx_owned.as_ref())
    })
    .await
    .map_err(|e| TrackingError::InvalidInput(format!("Tracking task panicked: {e}")))?
}

/// Track a point across pre-extracted grayscale frames.
///
/// This is separated from `track_point` to enable testing with synthetic frames.
/// This function is intentionally synchronous (CPU-bound NCC computation).
/// Callers in async contexts should wrap with `spawn_blocking`.
pub fn track_frames(
    input: &TrackFramesInput<'_>,
    config: &TrackingConfig,
    progress_tx: Option<&tokio::sync::mpsc::Sender<f32>>,
) -> Result<TrackingResultData, TrackingError> {
    let TrackFramesInput {
        frames,
        frame_width,
        frame_height,
        origin_x,
        origin_y,
        start_frame_index,
    } = input;
    let (frame_width, frame_height) = (*frame_width, *frame_height);
    let (origin_x, origin_y) = (*origin_x, *origin_y);
    let start_frame_index = *start_frame_index;

    if frames.is_empty() {
        return Err(TrackingError::InvalidInput(
            "No frames provided".to_string(),
        ));
    }

    // Convert normalized coords to pixel coords at working resolution
    let mut cx = (origin_x * frame_width as f64).round() as u32;
    let mut cy = (origin_y * frame_height as f64).round() as u32;
    cx = cx.min(frame_width.saturating_sub(1));
    cy = cy.min(frame_height.saturating_sub(1));

    // Extract initial template
    let (mut template, mut tpl_w, mut tpl_h, tpl_x0, tpl_y0) = extract_template(
        &frames[0],
        frame_width,
        frame_height,
        cx,
        cy,
        config.template_size,
    );
    // Offset of the tracked point within the template patch.
    // When the template is fully inside the frame this equals (tpl_w/2, tpl_h/2),
    // but near edges the crop is asymmetric so we must track the real offset.
    let mut point_in_tpl_x = cx - tpl_x0;
    let mut point_in_tpl_y = cy - tpl_y0;

    let mut points = Vec::with_capacity(frames.len());

    // First frame: the origin point itself
    points.push(TrackPointData {
        frame: start_frame_index,
        x: origin_x,
        y: origin_y,
        confidence: 1.0,
    });

    let total = frames.len();
    let mut last_tracked_frame_in_loop: usize = 0;

    for (i, frame) in frames.iter().enumerate().skip(1) {
        // NCC match
        let (bx, by, conf) = ncc_match(&NccMatchParams {
            frame,
            frame_width,
            frame_height,
            template: &template,
            template_width: tpl_w,
            template_height: tpl_h,
            search_cx: cx,
            search_cy: cy,
            search_size: config.search_area_size,
        });

        // Check confidence threshold
        if conf < config.confidence_threshold {
            // Tracking lost — record last good point and stop
            last_tracked_frame_in_loop = i.saturating_sub(1);
            break;
        }

        // Correct NCC center result for asymmetric template crops near edges.
        // ncc_match returns (top_left_x + half_tw, top_left_y + half_th) which
        // equals the center of the matched patch. The actual tracked point may
        // be offset from that center when the template was cropped at a boundary.
        let half_tw = tpl_w / 2;
        let half_th = tpl_h / 2;
        let corrected_x = (bx as i32 - half_tw as i32 + point_in_tpl_x as i32)
            .max(0)
            .min(frame_width as i32 - 1) as u32;
        let corrected_y = (by as i32 - half_th as i32 + point_in_tpl_y as i32)
            .max(0)
            .min(frame_height as i32 - 1) as u32;

        // Record tracked position (normalized)
        let norm_x = corrected_x as f64 / frame_width as f64;
        let norm_y = corrected_y as f64 / frame_height as f64;
        points.push(TrackPointData {
            frame: start_frame_index + i,
            x: norm_x,
            y: norm_y,
            confidence: conf,
        });

        // Update search center for next frame
        cx = corrected_x;
        cy = corrected_y;
        last_tracked_frame_in_loop = i;

        // Template drift correction: refresh template periodically
        if config.template_refresh_interval > 0
            && (i as u32).is_multiple_of(config.template_refresh_interval)
            && conf >= config.template_refresh_min_confidence
        {
            let (new_tpl, new_w, new_h, rx0, ry0) = extract_template(
                frame,
                frame_width,
                frame_height,
                cx,
                cy,
                config.template_size,
            );
            template = new_tpl;
            tpl_w = new_w;
            tpl_h = new_h;
            point_in_tpl_x = cx - rx0;
            point_in_tpl_y = cy - ry0;
        }

        // Report progress
        if let Some(tx) = &progress_tx {
            let progress = (i as f32 + 1.0) / total as f32 * 100.0;
            let _ = tx.try_send(progress);
        }
    }

    let end_frame = start_frame_index + last_tracked_frame_in_loop;

    Ok(TrackingResultData {
        points,
        start_frame: start_frame_index,
        end_frame,
        origin_x,
        origin_y,
        template_size: config.template_size,
        search_area_size: config.search_area_size,
    })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helpers: create synthetic grayscale frames for testing
    // -----------------------------------------------------------------------

    /// Create a uniform gray frame.
    fn uniform_frame(width: u32, height: u32, value: u8) -> Vec<u8> {
        vec![value; (width * height) as usize]
    }

    /// Create a frame with a bright square dot at the given center position.
    fn frame_with_dot(width: u32, height: u32, cx: u32, cy: u32, dot_size: u32) -> Vec<u8> {
        let mut frame = vec![30u8; (width * height) as usize]; // dark background
        let half = dot_size / 2;
        let x0 = cx.saturating_sub(half);
        let y0 = cy.saturating_sub(half);
        let x1 = (x0 + dot_size).min(width);
        let y1 = (y0 + dot_size).min(height);
        for row in y0..y1 {
            for col in x0..x1 {
                frame[(row * width + col) as usize] = 220; // bright dot
            }
        }
        frame
    }

    // -----------------------------------------------------------------------
    // BDD: Template extraction
    // -----------------------------------------------------------------------

    #[test]
    fn should_extract_template_at_center_of_frame() {
        // Given a 100x100 frame with a bright dot at (50,50)
        let frame = frame_with_dot(100, 100, 50, 50, 10);
        // When extracting a 10x10 template centered at (50,50)
        let (tpl, w, h, x0, y0) = extract_template(&frame, 100, 100, 50, 50, 10);
        // Then the template should be 10x10
        assert_eq!(w, 10);
        assert_eq!(h, 10);
        assert_eq!(x0, 45);
        assert_eq!(y0, 45);
        assert_eq!(tpl.len(), 100);
        // And it should contain the bright dot pixels
        assert!(tpl.contains(&220), "Template should contain bright pixels");
    }

    #[test]
    fn should_clamp_template_at_frame_edge() {
        // Given a 100x100 frame
        let frame = uniform_frame(100, 100, 128);
        // When extracting a 20x20 template at corner (0,0)
        let (tpl, w, h, _x0, _y0) = extract_template(&frame, 100, 100, 0, 0, 20);
        // Then template should be clamped to valid region (10x10 since half=10, 0-10)
        assert!(w <= 20);
        assert!(h <= 20);
        assert_eq!(tpl.len(), (w * h) as usize);
    }

    #[test]
    fn should_clamp_template_at_bottom_right_edge() {
        // Given a 100x100 frame
        let frame = uniform_frame(100, 100, 128);
        // When extracting a 20x20 template near bottom-right (99,99)
        let (tpl, w, h, _x0, _y0) = extract_template(&frame, 100, 100, 99, 99, 20);
        // Then template should be clamped but non-empty
        assert!(w > 0);
        assert!(h > 0);
        assert_eq!(tpl.len(), (w * h) as usize);
    }

    // -----------------------------------------------------------------------
    // BDD: NCC matching
    // -----------------------------------------------------------------------

    #[test]
    fn should_find_exact_match_position() {
        // Given a 200x200 frame with a bright 8px dot at (80,60)
        // Template is 20x20, so it captures the dot plus surrounding dark area
        let frame = frame_with_dot(200, 200, 80, 60, 8);
        // And a 20x20 template extracted from that position (captures dot + background)
        let (tpl, tw, th, _, _) = extract_template(&frame, 200, 200, 80, 60, 20);
        // When running NCC match with search area 50
        let (bx, by, conf) = ncc_match(&NccMatchParams {
            frame: &frame,
            frame_width: 200,
            frame_height: 200,
            template: &tpl,
            template_width: tw,
            template_height: th,
            search_cx: 80,
            search_cy: 60,
            search_size: 50,
        });
        // Then the best match should be at (80,60) with high confidence
        assert_eq!(bx, 80, "X should match origin");
        assert_eq!(by, 60, "Y should match origin");
        assert!(conf > 0.95, "Confidence should be > 0.95, got {conf}");
    }

    #[test]
    fn should_find_shifted_dot() {
        // Given a 20x20 template from dot at (80,60) — larger than the 8px dot
        let frame_orig = frame_with_dot(200, 200, 80, 60, 8);
        let (tpl, tw, th, _, _) = extract_template(&frame_orig, 200, 200, 80, 60, 20);
        // And a new frame where the dot moved to (90,65)
        let frame_moved = frame_with_dot(200, 200, 90, 65, 8);
        // When matching in the new frame searching around (80,60) with large area
        let (bx, by, conf) = ncc_match(&NccMatchParams {
            frame: &frame_moved,
            frame_width: 200,
            frame_height: 200,
            template: &tpl,
            template_width: tw,
            template_height: th,
            search_cx: 85,
            search_cy: 62,
            search_size: 60,
        });
        // Then it should find the dot at the new position
        assert!(
            (bx as i32 - 90).unsigned_abs() <= 1,
            "X should be near 90, got {bx}"
        );
        assert!(
            (by as i32 - 65).unsigned_abs() <= 1,
            "Y should be near 65, got {by}"
        );
        assert!(conf > 0.8, "Confidence should be > 0.8, got {conf}");
    }

    #[test]
    fn should_report_low_confidence_for_absent_pattern() {
        // Given a uniform gray frame (no distinctive features)
        let frame = uniform_frame(200, 200, 128);
        // And a template with a distinctive bright dot (dot=8px, template=20px)
        let tpl_frame = frame_with_dot(200, 200, 100, 100, 8);
        let (tpl, tw, th, _, _) = extract_template(&tpl_frame, 200, 200, 100, 100, 20);
        // When running NCC match on the uniform frame
        let (_bx, _by, conf) = ncc_match(&NccMatchParams {
            frame: &frame,
            frame_width: 200,
            frame_height: 200,
            template: &tpl,
            template_width: tw,
            template_height: th,
            search_cx: 100,
            search_cy: 100,
            search_size: 50,
        });
        // Then confidence should be very low (uniform region = near-zero NCC)
        assert!(
            conf < 0.3,
            "Confidence should be < 0.3 for absent pattern, got {conf}"
        );
    }

    // -----------------------------------------------------------------------
    // BDD: Full tracking pipeline (with synthetic frames)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn should_track_moving_dot_across_frames() {
        // Given a sequence of 5 frames with a dot moving right
        let frames: Vec<Vec<u8>> = (0..5)
            .map(|i| frame_with_dot(200, 200, 80 + i * 5, 60, 10))
            .collect();
        // When tracking starting from the dot at (80,60) = normalized (0.4, 0.3)
        let config = TrackingConfig {
            template_size: 15,
            search_area_size: 40,
            confidence_threshold: 0.5,
            ..Default::default()
        };
        let result = track_frames(
            &TrackFramesInput {
                frames: &frames,
                frame_width: 200,
                frame_height: 200,
                origin_x: 0.4,
                origin_y: 0.3,
                start_frame_index: 0,
            },
            &config,
            None,
        )
        .expect("Tracking should succeed");
        // Then we should get a TrackPoint for each frame
        assert_eq!(result.points.len(), 5, "Should have 5 tracked points");
        // And each point should have normalized coordinates
        for pt in &result.points {
            assert!((0.0..=1.0).contains(&pt.x), "X should be normalized");
            assert!((0.0..=1.0).contains(&pt.y), "Y should be normalized");
            assert!(
                (0.0..=1.0).contains(&pt.confidence),
                "Confidence should be 0-1"
            );
        }
        // And the X position should increase across frames (dot moving right)
        for i in 1..result.points.len() {
            assert!(
                result.points[i].x >= result.points[i - 1].x - 0.02,
                "X should generally increase: frame {} x={} < frame {} x={}",
                i,
                result.points[i].x,
                i - 1,
                result.points[i - 1].x
            );
        }
    }

    #[tokio::test]
    async fn should_stop_tracking_when_confidence_drops() {
        // Given 5 frames where dot exists for first 3, then disappears
        let mut frames: Vec<Vec<u8>> = (0..3)
            .map(|i| frame_with_dot(200, 200, 80 + i * 3, 60, 10))
            .collect();
        // Frames 3-4: uniform gray (dot disappears)
        frames.push(uniform_frame(200, 200, 128));
        frames.push(uniform_frame(200, 200, 128));

        // When tracking with high confidence threshold
        let config = TrackingConfig {
            template_size: 15,
            search_area_size: 40,
            confidence_threshold: 0.7,
            ..Default::default()
        };
        let result = track_frames(
            &TrackFramesInput {
                frames: &frames,
                frame_width: 200,
                frame_height: 200,
                origin_x: 0.4,
                origin_y: 0.3,
                start_frame_index: 0,
            },
            &config,
            None,
        )
        .expect("Tracking should succeed");
        // Then tracking should stop before frame 4 (where dot vanishes)
        assert!(
            result.points.len() < 5,
            "Should stop early, got {} points",
            result.points.len()
        );
        // And all tracked points should have confidence above threshold
        for pt in &result.points {
            assert!(
                pt.confidence >= config.confidence_threshold || pt.frame == 0,
                "Frame {} confidence {} should be >= threshold",
                pt.frame,
                pt.confidence
            );
        }
    }

    #[tokio::test]
    async fn should_report_progress_during_tracking() {
        // Given 10 frames with a moving dot
        let frames: Vec<Vec<u8>> = (0..10)
            .map(|i| frame_with_dot(200, 200, 80 + i * 2, 60, 10))
            .collect();
        let config = TrackingConfig {
            template_size: 15,
            search_area_size: 40,
            confidence_threshold: 0.5,
            ..Default::default()
        };
        // And a progress channel
        let (tx, mut rx) = tokio::sync::mpsc::channel::<f32>(20);
        // When tracking
        let _ = track_frames(
            &TrackFramesInput {
                frames: &frames,
                frame_width: 200,
                frame_height: 200,
                origin_x: 0.4,
                origin_y: 0.3,
                start_frame_index: 0,
            },
            &config,
            Some(&tx),
        )
        .expect("Tracking should succeed");
        drop(tx); // Close sender so receiver can drain
                  // Then progress values should have been reported
        let mut progress_values = Vec::new();
        while let Ok(v) = rx.try_recv() {
            progress_values.push(v);
        }
        assert!(
            !progress_values.is_empty(),
            "Should receive progress updates"
        );
        // And last progress should approach 100
        if let Some(&last) = progress_values.last() {
            assert!(last > 50.0, "Final progress should be > 50%, got {last}");
        }
    }

    #[tokio::test]
    async fn should_reject_invalid_origin_coordinates() {
        // Given invalid origin coordinates
        let config = TrackingConfig::default();
        let path = Path::new("dummy");
        // When calling track_point with x > 1.0
        let result = track_point(
            &TrackPointInput {
                ffmpeg_path: path,
                video_path: path,
                start_frame: 0,
                origin_x: 1.5,
                origin_y: 0.5,
                video_width: 100,
                video_height: 100,
                fps: 30.0,
                clip_source_in_sec: 0.0,
                clip_total_frames: 10,
            },
            &config,
            None,
        )
        .await;
        // Then it should return an error
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("0.0–1.0 range"));
    }

    #[tokio::test]
    async fn should_reject_start_frame_out_of_range() {
        let config = TrackingConfig::default();
        let path = Path::new("dummy");

        let result = track_point(
            &TrackPointInput {
                ffmpeg_path: path,
                video_path: path,
                start_frame: 10,
                origin_x: 0.5,
                origin_y: 0.5,
                video_width: 100,
                video_height: 100,
                fps: 30.0,
                clip_source_in_sec: 0.0,
                clip_total_frames: 10,
            },
            &config,
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("out of range"));
    }

    // -----------------------------------------------------------------------
    // Unit: working resolution computation
    // -----------------------------------------------------------------------

    #[test]
    fn should_compute_working_resolution_16_9() {
        let (w, h) = compute_working_resolution(1920, 1080);
        assert_eq!(h, TRACKING_WORKING_HEIGHT);
        // 1920/1080 * 480 ≈ 854 → even = 854
        assert!(w > 800 && w < 900, "Width should be ~854, got {w}");
        assert_eq!(w % 2, 0, "Width should be even");
    }

    #[test]
    fn should_handle_zero_dimensions() {
        let (w, h) = compute_working_resolution(0, 0);
        assert_eq!(w, TRACKING_WORKING_HEIGHT);
        assert_eq!(h, TRACKING_WORKING_HEIGHT);
    }

    #[test]
    fn should_offset_tracking_window_by_clip_source_in() {
        let path = Path::new("dummy");
        let input = TrackPointInput {
            ffmpeg_path: path,
            video_path: path,
            start_frame: 30,
            origin_x: 0.5,
            origin_y: 0.5,
            video_width: 1920,
            video_height: 1080,
            fps: 30.0,
            clip_source_in_sec: 5.0,
            clip_total_frames: 300,
        };

        let (work_w, work_h) = compute_working_resolution(input.video_width, input.video_height);
        let (start_sec, duration_sec) =
            compute_tracking_window(&input, work_w, work_h).expect("window should resolve");

        assert!((start_sec - 6.0).abs() < 1e-9);
        assert!((duration_sec - 9.0).abs() < 1e-9);
    }

    #[test]
    fn should_reject_excessive_tracking_buffer_size() {
        let path = Path::new("dummy");
        let input = TrackPointInput {
            ffmpeg_path: path,
            video_path: path,
            start_frame: 0,
            origin_x: 0.5,
            origin_y: 0.5,
            video_width: 3840,
            video_height: 2160,
            fps: 30.0,
            clip_source_in_sec: 0.0,
            clip_total_frames: 10_000,
        };

        let (work_w, work_h) = compute_working_resolution(input.video_width, input.video_height);
        let error =
            compute_tracking_window(&input, work_w, work_h).expect_err("window should fail");

        assert!(error.to_string().contains("Tracking range is too large"));
    }
}
