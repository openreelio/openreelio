//! Visual Frame Analysis Module
//!
//! Provides visual composition analysis for video shots using two paths (ADR-052):
//!
//! 1. **Vision API path**: Parses structured JSON responses from an AI gateway
//!    vision model into [`FrameAnalysis`] results with camera angle, subject
//!    position, and motion direction classification.
//!
//! 2. **Local fallback**: Uses FFmpeg scene-change detection to estimate
//!    visual complexity without any external API calls.
//!
//! Part of the reference video analysis pipeline (ADR-048, Group 4).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::{future::Future, pin::Pin};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::types::{
    CameraAngle, ContactSheetArtifact, FrameAnalysis, MotionDirection, SubjectPosition,
};
use crate::core::annotations::models::{KeyframeSelectionMethod, ShotResult};
use crate::core::process::configure_tokio_command;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Number of tail lines to keep from FFmpeg stderr for error reporting.
const STDERR_TAIL_SIZE: usize = 20;

/// Default visual complexity used when a shot's local analysis fails.
const DEFAULT_COMPLEXITY: f64 = 0.5;

/// Maximum number of keyframes to include in a contact sheet.
const CONTACT_SHEET_MAX_FRAMES: usize = 12;

/// Width of each contact-sheet cell.
const CONTACT_SHEET_CELL_WIDTH: usize = 320;

/// Height of each contact-sheet cell.
const CONTACT_SHEET_CELL_HEIGHT: usize = 180;

/// Minimum shot duration to attempt smarter thumbnail-based selection.
const SMART_KEYFRAME_MIN_DURATION_SEC: f64 = 1.2;

/// Minimum interior window duration for thumbnail selection.
const SMART_KEYFRAME_MIN_WINDOW_SEC: f64 = 0.5;

/// Edge guard ratio removed from start/end of each shot for thumbnail selection.
const SMART_KEYFRAME_EDGE_GUARD_RATIO: f64 = 0.1;

/// Minimum edge guard applied to each side of a shot.
const SMART_KEYFRAME_EDGE_GUARD_MIN_SEC: f64 = 0.15;

/// Maximum edge guard applied to each side of a shot.
const SMART_KEYFRAME_EDGE_GUARD_MAX_SEC: f64 = 0.75;

/// Minimum number of sampled frames for representative selection.
const SMART_KEYFRAME_MIN_SAMPLES: usize = 4;

/// Maximum number of sampled frames for representative selection.
const SMART_KEYFRAME_MAX_SAMPLES: usize = 12;

#[derive(Clone, Debug, PartialEq)]
pub struct ExtractedKeyframe {
    pub path: PathBuf,
    pub method: KeyframeSelectionMethod,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct RepresentativeWindow {
    start_sec: f64,
    duration_sec: f64,
    sample_count: usize,
}

// =============================================================================
// Vision API Response Schema
// =============================================================================

/// Top-level JSON envelope returned by the vision API.
#[derive(Debug, Deserialize)]
struct VisionApiResponse {
    frames: Vec<VisionApiFrame>,
}

/// Per-frame analysis entry within a vision API response.
#[derive(Debug, Deserialize)]
struct VisionApiFrame {
    shot_index: usize,
    #[serde(default)]
    camera_angle: Option<String>,
    #[serde(default)]
    subject_position: Option<String>,
    #[serde(default)]
    motion_direction: Option<String>,
    #[serde(default)]
    visual_complexity: Option<f64>,
}

// =============================================================================
// VisualAnalyzer
// =============================================================================

/// Visual frame analyzer supporting AI vision and FFmpeg fallback paths.
pub struct VisualAnalyzer {
    ffmpeg_path: PathBuf,
}

impl VisualAnalyzer {
    /// Creates a new visual analyzer with the given FFmpeg binary path.
    pub fn new(ffmpeg_path: PathBuf) -> Self {
        Self { ffmpeg_path }
    }

    /// Extracts one representative JPEG for each shot.
    ///
    /// For each shot in `shots`, a single frame is extracted and saved as
    /// `output_dir/<index>.jpg`. For sufficiently long shots, FFmpeg's
    /// `thumbnail` filter is applied over an interior window that avoids the
    /// cut edges. For short shots or failures, extraction falls back to the
    /// temporal midpoint. Already-existing
    /// (and non-empty) files are skipped to make the operation idempotent.
    ///
    /// Returns the ordered list of keyframe file paths and selection methods.
    pub async fn extract_keyframes(
        &self,
        video_path: &Path,
        shots: &[ShotResult],
        output_dir: &Path,
    ) -> CoreResult<Vec<ExtractedKeyframe>> {
        tokio::fs::create_dir_all(output_dir).await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to create keyframe output directory {}: {}",
                output_dir.display(),
                e
            ))
        })?;

        let mut keyframes = Vec::with_capacity(shots.len());

        for (index, shot) in shots.iter().enumerate() {
            let output_path = output_dir.join(format!("{}.jpg", index));
            let preferred_method = choose_keyframe_selection_method(shot);

            // Skip extraction if the file already exists and is non-empty
            if is_nonempty_file(&output_path) {
                tracing::debug!(
                    "Keyframe already exists, skipping: {}",
                    output_path.display()
                );
                keyframes.push(ExtractedKeyframe {
                    path: output_path,
                    method: preferred_method,
                });
                continue;
            }

            let extracted = match preferred_method {
                KeyframeSelectionMethod::Thumbnail => {
                    if let Some(window) = representative_window_for_shot(shot) {
                        match self
                            .extract_thumbnail_keyframe(video_path, window, &output_path)
                            .await
                        {
                            Ok(()) => ExtractedKeyframe {
                                path: output_path,
                                method: KeyframeSelectionMethod::Thumbnail,
                            },
                            Err(error) => {
                                tracing::warn!(
                                    "Thumbnail keyframe extraction failed for shot {}: {}. Falling back to midpoint.",
                                    index,
                                    error
                                );
                                self.extract_midpoint_keyframe(video_path, shot, &output_path)
                                    .await?;
                                ExtractedKeyframe {
                                    path: output_path,
                                    method: KeyframeSelectionMethod::Midpoint,
                                }
                            }
                        }
                    } else {
                        self.extract_midpoint_keyframe(video_path, shot, &output_path)
                            .await?;
                        ExtractedKeyframe {
                            path: output_path,
                            method: KeyframeSelectionMethod::Midpoint,
                        }
                    }
                }
                KeyframeSelectionMethod::Midpoint => {
                    self.extract_midpoint_keyframe(video_path, shot, &output_path)
                        .await?;
                    ExtractedKeyframe {
                        path: output_path,
                        method: KeyframeSelectionMethod::Midpoint,
                    }
                }
            };

            keyframes.push(extracted);
        }

        Ok(keyframes)
    }

    /// Generates a contact-sheet image from a sequence of extracted keyframes.
    pub async fn generate_contact_sheet(
        &self,
        keyframes: &[PathBuf],
        output_path: &Path,
    ) -> CoreResult<Option<ContactSheetArtifact>> {
        if keyframes.is_empty() {
            return Ok(None);
        }

        if is_nonempty_file(output_path) {
            let frame_count = keyframes.len().min(CONTACT_SHEET_MAX_FRAMES);
            let (columns, rows) = contact_sheet_layout(frame_count);
            return Ok(Some(ContactSheetArtifact {
                path: output_path.to_string_lossy().to_string(),
                frame_count,
                columns,
                rows,
            }));
        }

        let frame_count = keyframes.len().min(CONTACT_SHEET_MAX_FRAMES);
        let first_keyframe = keyframes.first().ok_or_else(|| {
            CoreError::Internal("Contact sheet requires at least one keyframe".to_string())
        })?;
        let keyframe_dir = first_keyframe.parent().ok_or_else(|| {
            CoreError::Internal("Keyframe path is missing a parent directory".to_string())
        })?;
        let all_in_same_dir = keyframes
            .iter()
            .take(frame_count)
            .all(|path| path.parent() == Some(keyframe_dir));
        if !all_in_same_dir {
            return Err(CoreError::AnalysisFailed(
                "Contact sheet generation requires keyframes from the same directory".to_string(),
            ));
        }

        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to create contact sheet output directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        let (columns, rows) = contact_sheet_layout(frame_count);
        let input_pattern = keyframe_dir.join("%d.jpg");
        let filter = format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,tile={cols}x{rows}:nb_frames={count}:padding=4:margin=2:color=black",
            w = CONTACT_SHEET_CELL_WIDTH,
            h = CONTACT_SHEET_CELL_HEIGHT,
            cols = columns,
            rows = rows,
            count = frame_count,
        );

        let mut cmd = Command::new(&self.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-y")
            .arg("-start_number")
            .arg("0")
            .arg("-i")
            .arg(&input_pattern)
            .arg("-frames:v")
            .arg("1")
            .arg("-vf")
            .arg(filter)
            .arg(output_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let output = cmd.output().await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to spawn FFmpeg for contact sheet generation: {}",
                e
            ))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr_tail(&stderr, STDERR_TAIL_SIZE);
            return Err(CoreError::AnalysisFailed(format!(
                "Contact sheet generation failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                tail
            )));
        }

        Ok(Some(ContactSheetArtifact {
            path: output_path.to_string_lossy().to_string(),
            frame_count,
            columns,
            rows,
        }))
    }

    async fn extract_midpoint_keyframe(
        &self,
        video_path: &Path,
        shot: &ShotResult,
        output_path: &Path,
    ) -> CoreResult<()> {
        let midpoint = (shot.start_sec + shot.end_sec) / 2.0;
        let mut cmd = Command::new(&self.ffmpeg_path);
        configure_tokio_command(&mut cmd);

        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-ss")
            .arg(format!("{:.3}", midpoint))
            .arg("-i")
            .arg(video_path)
            .arg("-vframes")
            .arg("1")
            .arg("-q:v")
            .arg("2")
            .arg(output_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let output = cmd.output().await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to spawn FFmpeg for midpoint keyframe extraction: {}",
                e
            ))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr_tail(&stderr, STDERR_TAIL_SIZE);
            return Err(CoreError::AnalysisFailed(format!(
                "Midpoint keyframe extraction failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                tail
            )));
        }

        Ok(())
    }

    async fn extract_thumbnail_keyframe(
        &self,
        video_path: &Path,
        window: RepresentativeWindow,
        output_path: &Path,
    ) -> CoreResult<()> {
        let fps = window.sample_count as f64 / window.duration_sec.max(0.001);
        let filter = format!("fps={:.6},thumbnail={}", fps, window.sample_count);

        let mut cmd = Command::new(&self.ffmpeg_path);
        configure_tokio_command(&mut cmd);
        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-ss")
            .arg(format!("{:.3}", window.start_sec))
            .arg("-t")
            .arg(format!("{:.3}", window.duration_sec))
            .arg("-i")
            .arg(video_path)
            .arg("-vf")
            .arg(filter)
            .arg("-frames:v")
            .arg("1")
            .arg("-q:v")
            .arg("2")
            .arg(output_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let output = cmd.output().await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to spawn FFmpeg for thumbnail keyframe extraction: {}",
                e
            ))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr_tail(&stderr, STDERR_TAIL_SIZE);
            return Err(CoreError::AnalysisFailed(format!(
                "Thumbnail keyframe extraction failed (exit {}): {}",
                output.status.code().unwrap_or(-1),
                tail
            )));
        }

        Ok(())
    }

    /// Extracts keyframes and delegates vision inference to a caller-provided function.
    pub async fn analyze_frames_vision<F>(
        &self,
        video_path: &Path,
        shots: &[ShotResult],
        output_dir: &Path,
        request_vision: F,
    ) -> CoreResult<Vec<FrameAnalysis>>
    where
        F: FnOnce(Vec<PathBuf>) -> Pin<Box<dyn Future<Output = CoreResult<String>> + Send>>,
    {
        let keyframes = self
            .extract_keyframes(video_path, shots, output_dir)
            .await?;
        let response =
            request_vision(keyframes.into_iter().map(|item| item.path).collect()).await?;
        Self::parse_vision_response(&response, shots.len())
    }

    /// Parses a JSON response from the vision API into [`FrameAnalysis`] results.
    ///
    /// The expected JSON format:
    /// ```json
    /// {
    ///   "frames": [
    ///     {
    ///       "shot_index": 0,
    ///       "camera_angle": "medium",
    ///       "subject_position": "center",
    ///       "motion_direction": "static",
    ///       "visual_complexity": 0.6
    ///     }
    ///   ]
    /// }
    /// ```
    ///
    /// - Validates `shot_index` bounds (must be `< shot_count`).
    /// - If fewer frames than `shot_count`, remaining shots are filled with
    ///   [`FrameAnalysis::local_fallback`] using [`DEFAULT_COMPLEXITY`].
    /// - Completely invalid JSON returns an error; individual frame issues
    ///   (e.g., unrecognized enum strings) are tolerated via Unknown defaults.
    pub fn parse_vision_response(
        response: &str,
        shot_count: usize,
    ) -> CoreResult<Vec<FrameAnalysis>> {
        let api_response: VisionApiResponse = serde_json::from_str(response)
            .map_err(|e| CoreError::AnalysisFailed(format!("Invalid vision API JSON: {}", e)))?;

        let mut results: Vec<Option<FrameAnalysis>> = vec![None; shot_count];

        for frame in &api_response.frames {
            if frame.shot_index >= shot_count {
                tracing::debug!(
                    "Vision API returned shot_index {} exceeding shot_count {}, skipping",
                    frame.shot_index,
                    shot_count
                );
                continue;
            }

            let camera_angle = frame
                .camera_angle
                .as_deref()
                .map(parse_camera_angle)
                .unwrap_or(CameraAngle::Unknown);

            let subject_position = frame
                .subject_position
                .as_deref()
                .map(parse_subject_position)
                .unwrap_or(SubjectPosition::Unknown);

            let motion_direction = frame
                .motion_direction
                .as_deref()
                .map(parse_motion_direction)
                .unwrap_or(MotionDirection::Unknown);

            let visual_complexity = frame
                .visual_complexity
                .unwrap_or(DEFAULT_COMPLEXITY)
                .clamp(0.0, 1.0);

            results[frame.shot_index] = Some(FrameAnalysis {
                shot_index: frame.shot_index,
                camera_angle,
                subject_position,
                motion_direction,
                visual_complexity,
            });
        }

        // Fill any missing slots with Unknown defaults
        let filled: Vec<FrameAnalysis> = results
            .into_iter()
            .enumerate()
            .map(|(i, opt)| {
                opt.unwrap_or_else(|| FrameAnalysis::local_fallback(i, DEFAULT_COMPLEXITY))
            })
            .collect();

        Ok(filled)
    }

    /// Analyzes shots locally using FFmpeg scene-change detection.
    ///
    /// For each shot, runs an FFmpeg pass to count scene changes within the
    /// shot's time range and derives a visual complexity score from the
    /// scene-change frequency. All enum fields (camera angle, subject position,
    /// motion direction) are set to `Unknown` because local analysis cannot
    /// determine these properties.
    ///
    /// If analysis of an individual shot fails, a default complexity of
    /// [`DEFAULT_COMPLEXITY`] is used instead of propagating the error.
    pub async fn analyze_frames_local(
        &self,
        video_path: &Path,
        shots: &[ShotResult],
    ) -> CoreResult<Vec<FrameAnalysis>> {
        let mut results = Vec::with_capacity(shots.len());

        for (index, shot) in shots.iter().enumerate() {
            let complexity = match self.estimate_complexity_for_shot(video_path, shot).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::debug!(
                        "Local visual analysis failed for shot {}, using default: {}",
                        index,
                        e
                    );
                    DEFAULT_COMPLEXITY
                }
            };

            results.push(FrameAnalysis::local_fallback(index, complexity));
        }

        Ok(results)
    }

    // =========================================================================
    // Private Helpers
    // =========================================================================

    /// Estimates visual complexity for a single shot by counting retained frames.
    ///
    /// Uses `ffmpeg -vf "mpdecimate,showinfo"` to drop near-duplicate frames
    /// and count the retained frames reported by `showinfo`. Complexity is
    /// calculated as:
    ///
    ///   `min(retained_frames / (duration * 2), 1.0)`
    async fn estimate_complexity_for_shot(
        &self,
        video_path: &Path,
        shot: &ShotResult,
    ) -> CoreResult<f64> {
        let duration = shot.end_sec - shot.start_sec;
        if duration <= 0.0 {
            return Ok(0.0);
        }

        let mut cmd = Command::new(&self.ffmpeg_path);
        configure_tokio_command(&mut cmd);

        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-ss")
            .arg(format!("{:.3}", shot.start_sec))
            .arg("-t")
            .arg(format!("{:.3}", duration))
            .arg("-i")
            .arg(video_path)
            .arg("-vf")
            .arg("mpdecimate,showinfo")
            .arg("-vsync")
            .arg("vfr")
            .arg("-f")
            .arg("null")
            .arg("-")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            CoreError::Internal(format!("Failed to spawn FFmpeg for visual analysis: {}", e))
        })?;

        let stderr_handle = child
            .stderr
            .take()
            .ok_or_else(|| CoreError::Internal("Failed to capture FFmpeg stderr".to_string()))?;

        let mut reader = BufReader::new(stderr_handle).lines();
        // Count frames retained by mpdecimate (not scene changes — mpdecimate
        // drops near-duplicate frames, so retained frames indicate visual change).
        let mut retained_frames: usize = 0;
        let mut tail_lines: Vec<String> = Vec::new();

        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed reading FFmpeg stderr: {}", e)))?
        {
            if is_showinfo_frame_line(&line) {
                retained_frames += 1;
            }
            // Keep a rolling window of tail lines for error reporting
            tail_lines.push(line);
            if tail_lines.len() > STDERR_TAIL_SIZE {
                tail_lines.remove(0);
            }
        }

        let status = child
            .wait()
            .await
            .map_err(|e| CoreError::Internal(format!("Failed to wait for FFmpeg: {}", e)))?;

        if !status.success() {
            let code = status.code().unwrap_or(-1);
            let tail = tail_lines.join("\n");
            return Err(CoreError::AnalysisFailed(format!(
                "Visual complexity analysis failed (exit {}): {}",
                code, tail
            )));
        }

        // visual_complexity = min(retained_frames / (duration * 2), 1.0)
        let complexity = (retained_frames as f64 / (duration * 2.0)).min(1.0);

        tracing::debug!(
            "Shot {:.3}-{:.3}s: {} retained frames, complexity={:.3}",
            shot.start_sec,
            shot.end_sec,
            retained_frames,
            complexity
        );

        Ok(complexity)
    }
}

// =============================================================================
// Free-standing Helpers
// =============================================================================

/// Checks whether a path refers to an existing, non-empty file.
fn is_nonempty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Returns the last `n` lines of a multi-line string.
fn stderr_tail(stderr: &str, n: usize) -> String {
    let lines: Vec<&str> = stderr.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Returns true when an FFmpeg stderr line corresponds to a retained frame from `showinfo`.
fn is_showinfo_frame_line(line: &str) -> bool {
    line.contains("Parsed_showinfo") && line.contains(" n:")
}

fn choose_keyframe_selection_method(shot: &ShotResult) -> KeyframeSelectionMethod {
    if representative_window_for_shot(shot).is_some() {
        KeyframeSelectionMethod::Thumbnail
    } else {
        KeyframeSelectionMethod::Midpoint
    }
}

fn representative_window_for_shot(shot: &ShotResult) -> Option<RepresentativeWindow> {
    let duration_sec = shot.duration();
    if duration_sec < SMART_KEYFRAME_MIN_DURATION_SEC {
        return None;
    }

    let edge_guard_sec = (duration_sec * SMART_KEYFRAME_EDGE_GUARD_RATIO).clamp(
        SMART_KEYFRAME_EDGE_GUARD_MIN_SEC,
        SMART_KEYFRAME_EDGE_GUARD_MAX_SEC,
    );
    let start_sec = shot.start_sec + edge_guard_sec;
    let end_sec = shot.end_sec - edge_guard_sec;
    let interior_duration_sec = (end_sec - start_sec).max(0.0);

    if interior_duration_sec < SMART_KEYFRAME_MIN_WINDOW_SEC {
        return None;
    }

    let sample_count = ((interior_duration_sec * 2.0).round() as usize)
        .clamp(SMART_KEYFRAME_MIN_SAMPLES, SMART_KEYFRAME_MAX_SAMPLES);

    Some(RepresentativeWindow {
        start_sec,
        duration_sec: interior_duration_sec,
        sample_count,
    })
}

/// Computes a compact grid layout for a contact sheet.
fn contact_sheet_layout(frame_count: usize) -> (usize, usize) {
    let frame_count = frame_count.max(1);
    let columns = (frame_count as f64).sqrt().ceil() as usize;
    let rows = ((frame_count as f64) / columns as f64).ceil() as usize;
    (columns.max(1), rows.max(1))
}

/// Parses a camera angle string from vision API response.
///
/// Converts snake_case strings to [`CameraAngle`] enum variants.
/// Unrecognized values map to [`CameraAngle::Unknown`].
fn parse_camera_angle(s: &str) -> CameraAngle {
    match s {
        "wide" => CameraAngle::Wide,
        "medium" => CameraAngle::Medium,
        "close" => CameraAngle::Close,
        "extreme_close" => CameraAngle::ExtremeClose,
        "unknown" => CameraAngle::Unknown,
        _ => {
            tracing::debug!("Unrecognized camera angle '{}', defaulting to Unknown", s);
            CameraAngle::Unknown
        }
    }
}

/// Parses a subject position string from vision API response.
///
/// Converts snake_case strings to [`SubjectPosition`] enum variants.
/// Unrecognized values map to [`SubjectPosition::Unknown`].
fn parse_subject_position(s: &str) -> SubjectPosition {
    match s {
        "center" => SubjectPosition::Center,
        "left" => SubjectPosition::Left,
        "right" => SubjectPosition::Right,
        "top" => SubjectPosition::Top,
        "bottom" => SubjectPosition::Bottom,
        "unknown" => SubjectPosition::Unknown,
        _ => {
            tracing::debug!(
                "Unrecognized subject position '{}', defaulting to Unknown",
                s
            );
            SubjectPosition::Unknown
        }
    }
}

/// Parses a motion direction string from vision API response.
///
/// Converts snake_case strings to [`MotionDirection`] enum variants.
/// Unrecognized values map to [`MotionDirection::Unknown`].
fn parse_motion_direction(s: &str) -> MotionDirection {
    match s {
        "static" => MotionDirection::Static,
        "pan_left" => MotionDirection::PanLeft,
        "pan_right" => MotionDirection::PanRight,
        "tilt_up" => MotionDirection::TiltUp,
        "tilt_down" => MotionDirection::TiltDown,
        "zoom_in" => MotionDirection::ZoomIn,
        "zoom_out" => MotionDirection::ZoomOut,
        "unknown" => MotionDirection::Unknown,
        _ => {
            tracing::debug!(
                "Unrecognized motion direction '{}', defaulting to Unknown",
                s
            );
            MotionDirection::Unknown
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // Vision API Response Parsing Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_valid_vision_api_response() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0,
                    "camera_angle": "wide",
                    "subject_position": "center",
                    "motion_direction": "static",
                    "visual_complexity": 0.3
                },
                {
                    "shot_index": 1,
                    "camera_angle": "medium",
                    "subject_position": "left",
                    "motion_direction": "pan_right",
                    "visual_complexity": 0.6
                },
                {
                    "shot_index": 2,
                    "camera_angle": "close",
                    "subject_position": "right",
                    "motion_direction": "zoom_in",
                    "visual_complexity": 0.9
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 3).unwrap();

        assert_eq!(results.len(), 3);

        assert_eq!(results[0].shot_index, 0);
        assert_eq!(results[0].camera_angle, CameraAngle::Wide);
        assert_eq!(results[0].subject_position, SubjectPosition::Center);
        assert_eq!(results[0].motion_direction, MotionDirection::Static);
        assert!((results[0].visual_complexity - 0.3).abs() < f64::EPSILON);

        assert_eq!(results[1].shot_index, 1);
        assert_eq!(results[1].camera_angle, CameraAngle::Medium);
        assert_eq!(results[1].subject_position, SubjectPosition::Left);
        assert_eq!(results[1].motion_direction, MotionDirection::PanRight);
        assert!((results[1].visual_complexity - 0.6).abs() < f64::EPSILON);

        assert_eq!(results[2].shot_index, 2);
        assert_eq!(results[2].camera_angle, CameraAngle::Close);
        assert_eq!(results[2].subject_position, SubjectPosition::Right);
        assert_eq!(results[2].motion_direction, MotionDirection::ZoomIn);
        assert!((results[2].visual_complexity - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn should_fill_missing_frames_with_unknown_defaults() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0,
                    "camera_angle": "wide",
                    "subject_position": "center",
                    "motion_direction": "static",
                    "visual_complexity": 0.4
                },
                {
                    "shot_index": 2,
                    "camera_angle": "close",
                    "subject_position": "left",
                    "motion_direction": "pan_left",
                    "visual_complexity": 0.8
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 4).unwrap();

        assert_eq!(results.len(), 4);

        // Shot 0: from API
        assert_eq!(results[0].camera_angle, CameraAngle::Wide);
        assert_eq!(results[0].subject_position, SubjectPosition::Center);

        // Shot 1: filled with Unknown defaults
        assert_eq!(results[1].shot_index, 1);
        assert_eq!(results[1].camera_angle, CameraAngle::Unknown);
        assert_eq!(results[1].subject_position, SubjectPosition::Unknown);
        assert_eq!(results[1].motion_direction, MotionDirection::Unknown);
        assert!((results[1].visual_complexity - DEFAULT_COMPLEXITY).abs() < f64::EPSILON);

        // Shot 2: from API
        assert_eq!(results[2].camera_angle, CameraAngle::Close);

        // Shot 3: filled with Unknown defaults
        assert_eq!(results[3].shot_index, 3);
        assert_eq!(results[3].camera_angle, CameraAngle::Unknown);
        assert_eq!(results[3].subject_position, SubjectPosition::Unknown);
        assert_eq!(results[3].motion_direction, MotionDirection::Unknown);
        assert!((results[3].visual_complexity - DEFAULT_COMPLEXITY).abs() < f64::EPSILON);
    }

    #[test]
    fn should_return_error_for_invalid_json() {
        let result = VisualAnalyzer::parse_vision_response("not valid json", 3);
        assert!(result.is_err());
    }

    #[test]
    fn should_parse_unknown_enum_values_gracefully() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0,
                    "camera_angle": "bird_eye",
                    "subject_position": "upper_third",
                    "motion_direction": "crane_up",
                    "visual_complexity": 0.5
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 1).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].camera_angle, CameraAngle::Unknown);
        assert_eq!(results[0].subject_position, SubjectPosition::Unknown);
        assert_eq!(results[0].motion_direction, MotionDirection::Unknown);
        assert!((results[0].visual_complexity - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn should_create_local_fallback_with_unknown_enums() {
        let shots = [
            ShotResult::new(0.0, 5.0, 0.9),
            ShotResult::new(5.0, 10.0, 0.85),
            ShotResult::new(10.0, 18.0, 0.7),
        ];

        let frames: Vec<FrameAnalysis> = shots
            .iter()
            .enumerate()
            .map(|(i, _)| FrameAnalysis::local_fallback(i, DEFAULT_COMPLEXITY))
            .collect();

        assert_eq!(frames.len(), 3);
        for (i, frame) in frames.iter().enumerate() {
            assert_eq!(frame.shot_index, i);
            assert_eq!(frame.camera_angle, CameraAngle::Unknown);
            assert_eq!(frame.subject_position, SubjectPosition::Unknown);
            assert_eq!(frame.motion_direction, MotionDirection::Unknown);
        }
    }

    #[test]
    fn should_generate_correct_keyframe_paths() {
        let output_dir = PathBuf::from("/tmp/test_keyframes");
        let expected_paths: Vec<PathBuf> = (0..5)
            .map(|i| output_dir.join(format!("{}.jpg", i)))
            .collect();

        assert_eq!(
            expected_paths[0],
            PathBuf::from("/tmp/test_keyframes/0.jpg")
        );
        assert_eq!(
            expected_paths[1],
            PathBuf::from("/tmp/test_keyframes/1.jpg")
        );
        assert_eq!(
            expected_paths[4],
            PathBuf::from("/tmp/test_keyframes/4.jpg")
        );
    }

    // -------------------------------------------------------------------------
    // Parser Helper Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_parse_all_camera_angle_variants() {
        assert_eq!(parse_camera_angle("wide"), CameraAngle::Wide);
        assert_eq!(parse_camera_angle("medium"), CameraAngle::Medium);
        assert_eq!(parse_camera_angle("close"), CameraAngle::Close);
        assert_eq!(
            parse_camera_angle("extreme_close"),
            CameraAngle::ExtremeClose
        );
        assert_eq!(parse_camera_angle("unknown"), CameraAngle::Unknown);
        assert_eq!(parse_camera_angle("aerial"), CameraAngle::Unknown);
    }

    #[test]
    fn should_parse_all_subject_position_variants() {
        assert_eq!(parse_subject_position("center"), SubjectPosition::Center);
        assert_eq!(parse_subject_position("left"), SubjectPosition::Left);
        assert_eq!(parse_subject_position("right"), SubjectPosition::Right);
        assert_eq!(parse_subject_position("top"), SubjectPosition::Top);
        assert_eq!(parse_subject_position("bottom"), SubjectPosition::Bottom);
        assert_eq!(parse_subject_position("unknown"), SubjectPosition::Unknown);
        assert_eq!(
            parse_subject_position("off_screen"),
            SubjectPosition::Unknown
        );
    }

    #[test]
    fn should_parse_all_motion_direction_variants() {
        assert_eq!(parse_motion_direction("static"), MotionDirection::Static);
        assert_eq!(parse_motion_direction("pan_left"), MotionDirection::PanLeft);
        assert_eq!(
            parse_motion_direction("pan_right"),
            MotionDirection::PanRight
        );
        assert_eq!(parse_motion_direction("tilt_up"), MotionDirection::TiltUp);
        assert_eq!(
            parse_motion_direction("tilt_down"),
            MotionDirection::TiltDown
        );
        assert_eq!(parse_motion_direction("zoom_in"), MotionDirection::ZoomIn);
        assert_eq!(parse_motion_direction("zoom_out"), MotionDirection::ZoomOut);
        assert_eq!(parse_motion_direction("unknown"), MotionDirection::Unknown);
        assert_eq!(
            parse_motion_direction("dolly_forward"),
            MotionDirection::Unknown
        );
    }

    // -------------------------------------------------------------------------
    // Edge Case Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_skip_out_of_bounds_shot_index_in_vision_response() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0,
                    "camera_angle": "wide",
                    "subject_position": "center",
                    "motion_direction": "static",
                    "visual_complexity": 0.5
                },
                {
                    "shot_index": 99,
                    "camera_angle": "close",
                    "subject_position": "left",
                    "motion_direction": "pan_left",
                    "visual_complexity": 0.9
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 2).unwrap();

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].camera_angle, CameraAngle::Wide);
        // Shot 1 was not in the response, so it should be filled with defaults
        assert_eq!(results[1].camera_angle, CameraAngle::Unknown);
    }

    #[test]
    fn should_clamp_visual_complexity_from_vision_response() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0,
                    "camera_angle": "wide",
                    "subject_position": "center",
                    "motion_direction": "static",
                    "visual_complexity": 1.5
                },
                {
                    "shot_index": 1,
                    "camera_angle": "medium",
                    "subject_position": "left",
                    "motion_direction": "static",
                    "visual_complexity": -0.3
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 2).unwrap();

        assert_eq!(results[0].visual_complexity, 1.0);
        assert_eq!(results[1].visual_complexity, 0.0);
    }

    #[test]
    fn should_handle_empty_frames_array() {
        let json = r#"{ "frames": [] }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 3).unwrap();

        assert_eq!(results.len(), 3);
        for (i, frame) in results.iter().enumerate() {
            assert_eq!(frame.shot_index, i);
            assert_eq!(frame.camera_angle, CameraAngle::Unknown);
            assert_eq!(frame.subject_position, SubjectPosition::Unknown);
            assert_eq!(frame.motion_direction, MotionDirection::Unknown);
        }
    }

    #[test]
    fn should_handle_missing_optional_fields_in_vision_frame() {
        let json = r#"{
            "frames": [
                {
                    "shot_index": 0
                }
            ]
        }"#;

        let results = VisualAnalyzer::parse_vision_response(json, 1).unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].camera_angle, CameraAngle::Unknown);
        assert_eq!(results[0].subject_position, SubjectPosition::Unknown);
        assert_eq!(results[0].motion_direction, MotionDirection::Unknown);
        assert!((results[0].visual_complexity - DEFAULT_COMPLEXITY).abs() < f64::EPSILON);
    }

    // -------------------------------------------------------------------------
    // Utility Tests
    // -------------------------------------------------------------------------

    #[test]
    fn should_detect_nonempty_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join("test.jpg");

        // Non-existent file
        assert!(!is_nonempty_file(&file_path));

        // Empty file
        std::fs::write(&file_path, b"").unwrap();
        assert!(!is_nonempty_file(&file_path));

        // Non-empty file
        std::fs::write(&file_path, b"JPEG data").unwrap();
        assert!(is_nonempty_file(&file_path));
    }

    #[test]
    fn should_extract_stderr_tail_lines() {
        let stderr = "line1\nline2\nline3\nline4\nline5";

        assert_eq!(stderr_tail(stderr, 2), "line4\nline5");
        assert_eq!(stderr_tail(stderr, 10), "line1\nline2\nline3\nline4\nline5");
        assert_eq!(stderr_tail("", 5), "");
    }

    #[test]
    fn should_detect_showinfo_frame_lines() {
        assert!(is_showinfo_frame_line(
            "[Parsed_showinfo_1 @ 0x123] n:   0 pts:      0 pts_time:0"
        ));
        assert!(!is_showinfo_frame_line("random ffmpeg stderr"));
    }

    #[test]
    fn should_compute_contact_sheet_layout() {
        assert_eq!(contact_sheet_layout(1), (1, 1));
        assert_eq!(contact_sheet_layout(2), (2, 1));
        assert_eq!(contact_sheet_layout(4), (2, 2));
        assert_eq!(contact_sheet_layout(5), (3, 2));
        assert_eq!(contact_sheet_layout(12), (4, 3));
    }

    #[test]
    fn should_choose_thumbnail_selection_for_longer_shots() {
        let shot = ShotResult::new(0.0, 5.0, 0.9);
        assert_eq!(
            choose_keyframe_selection_method(&shot),
            KeyframeSelectionMethod::Thumbnail
        );
    }

    #[test]
    fn should_choose_midpoint_selection_for_short_shots() {
        let shot = ShotResult::new(0.0, 0.8, 0.9);
        assert_eq!(
            choose_keyframe_selection_method(&shot),
            KeyframeSelectionMethod::Midpoint
        );
    }

    #[test]
    fn should_compute_guarded_representative_window() {
        let shot = ShotResult::new(10.0, 20.0, 0.9);
        let window = representative_window_for_shot(&shot).expect("window should exist");

        assert!(window.start_sec > 10.0);
        assert!(window.duration_sec < 10.0);
        assert!(window.sample_count >= SMART_KEYFRAME_MIN_SAMPLES);
        assert!(window.sample_count <= SMART_KEYFRAME_MAX_SAMPLES);
    }
}
