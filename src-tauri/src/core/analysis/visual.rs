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

use super::types::{CameraAngle, FrameAnalysis, MotionDirection, SubjectPosition};
use crate::core::annotations::models::ShotResult;
use crate::core::process::configure_tokio_command;
use crate::core::{CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Number of tail lines to keep from FFmpeg stderr for error reporting.
const STDERR_TAIL_SIZE: usize = 20;

/// Default visual complexity used when a shot's local analysis fails.
const DEFAULT_COMPLEXITY: f64 = 0.5;

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

    /// Extracts a keyframe JPEG for each shot at the midpoint of the shot.
    ///
    /// For each shot in `shots`, a single frame is extracted at the temporal
    /// midpoint and saved as `output_dir/<index>.jpg`. Already-existing
    /// (and non-empty) files are skipped to make the operation idempotent.
    ///
    /// Returns the ordered list of keyframe file paths.
    pub async fn extract_keyframes(
        &self,
        video_path: &Path,
        shots: &[ShotResult],
        output_dir: &Path,
    ) -> CoreResult<Vec<PathBuf>> {
        tokio::fs::create_dir_all(output_dir).await.map_err(|e| {
            CoreError::Internal(format!(
                "Failed to create keyframe output directory {}: {}",
                output_dir.display(),
                e
            ))
        })?;

        let mut paths = Vec::with_capacity(shots.len());

        for (index, shot) in shots.iter().enumerate() {
            let midpoint = (shot.start_sec + shot.end_sec) / 2.0;
            let output_path = output_dir.join(format!("{}.jpg", index));

            // Skip extraction if the file already exists and is non-empty
            if is_nonempty_file(&output_path) {
                tracing::debug!(
                    "Keyframe already exists, skipping: {}",
                    output_path.display()
                );
                paths.push(output_path);
                continue;
            }

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
                .arg(&output_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped());

            let output = cmd.output().await.map_err(|e| {
                CoreError::Internal(format!(
                    "Failed to spawn FFmpeg for keyframe extraction: {}",
                    e
                ))
            })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let tail = stderr_tail(&stderr, STDERR_TAIL_SIZE);
                return Err(CoreError::AnalysisFailed(format!(
                    "Keyframe extraction failed for shot {} (exit {}): {}",
                    index,
                    output.status.code().unwrap_or(-1),
                    tail
                )));
            }

            tracing::debug!(
                "Extracted keyframe for shot {} at {:.3}s -> {}",
                index,
                midpoint,
                output_path.display()
            );

            paths.push(output_path);
        }

        Ok(paths)
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
        let response = request_vision(keyframes).await?;
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
}
