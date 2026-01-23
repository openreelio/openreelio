//! Shot Detection Module
//!
//! Detects scene changes in video files using FFmpeg.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::db::IndexDb;
use crate::core::process::configure_tokio_command;
use crate::core::{AssetId, CoreError, CoreResult};

// =============================================================================
// Constants
// =============================================================================

/// Default scene change detection threshold (0.0 - 1.0).
/// Lower values detect more scene changes, higher values detect fewer.
/// 0.3 is a balanced default that works well for most video content.
pub const DEFAULT_SCENE_THRESHOLD: f64 = 0.3;

/// Default minimum shot duration in seconds.
/// Shots shorter than this will be merged with adjacent shots.
pub const DEFAULT_MIN_SHOT_DURATION: f64 = 0.5;

/// Default timeout for ffprobe operations (10 seconds).
/// This should be enough for most media files.
pub const DEFAULT_FFPROBE_TIMEOUT_SECS: u64 = 10;

/// Default timeout for ffmpeg scene detection (10 minutes).
/// Long videos may require extended processing time.
pub const DEFAULT_FFMPEG_TIMEOUT_SECS: u64 = 600;

/// Maximum number of scene cuts to process.
/// This prevents DoS attacks and unbounded memory growth when thresholds are too low.
/// 20,000 cuts is more than enough for any reasonable video (one cut every 3 seconds
/// for a 16-hour video).
pub const DEFAULT_MAX_SCENE_CUTS: usize = 20_000;

/// Number of recent FFmpeg output lines to keep for error reporting.
/// This provides context when scene detection fails.
pub const FFMPEG_OUTPUT_TAIL_SIZE: usize = 20;

// =============================================================================
// Shot Model
// =============================================================================

/// Represents a detected shot/scene in a video
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// Unique shot ID
    pub id: String,
    /// Asset ID this shot belongs to
    pub asset_id: AssetId,
    /// Start time in seconds
    pub start_sec: f64,
    /// End time in seconds
    pub end_sec: f64,
    /// Path to keyframe thumbnail (if generated)
    pub keyframe_path: Option<String>,
    /// Quality score (0.0 - 1.0)
    pub quality_score: Option<f64>,
    /// Tags/labels for this shot
    pub tags: Vec<String>,
}

impl Shot {
    /// Creates a new shot
    pub fn new(asset_id: &str, start_sec: f64, end_sec: f64) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            asset_id: asset_id.to_string(),
            start_sec,
            end_sec,
            keyframe_path: None,
            quality_score: None,
            tags: Vec::new(),
        }
    }

    /// Returns the duration of the shot in seconds
    pub fn duration(&self) -> f64 {
        self.end_sec - self.start_sec
    }

    /// Returns the midpoint time of the shot
    pub fn midpoint(&self) -> f64 {
        (self.start_sec + self.end_sec) / 2.0
    }
}

// =============================================================================
// Shot Detector Configuration
// =============================================================================

/// Configuration for shot detection
#[derive(Clone, Debug)]
pub struct ShotDetectorConfig {
    /// Scene change detection threshold (0.0 - 1.0)
    /// Lower values detect more scene changes
    pub threshold: f64,
    /// Minimum shot duration in seconds
    pub min_shot_duration: f64,
    /// Generate keyframe thumbnails
    pub generate_keyframes: bool,
    /// Keyframe output directory
    pub keyframe_dir: Option<String>,

    /// Optional path to ffmpeg binary.
    ///
    /// If not provided, the detector will fall back to resolving `ffmpeg` from PATH.
    pub ffmpeg_path: Option<PathBuf>,

    /// Optional path to ffprobe binary.
    ///
    /// If not provided, the detector will fall back to resolving `ffprobe` from PATH.
    pub ffprobe_path: Option<PathBuf>,

    /// Timeout for ffprobe duration detection.
    pub ffprobe_timeout: Duration,

    /// Timeout for ffmpeg scene detection.
    pub ffmpeg_timeout: Duration,

    /// Hard cap on the number of scene cuts we will accept from FFmpeg output.
    ///
    /// This prevents unbounded memory growth when thresholds are too low.
    pub max_scene_cuts: usize,
}

impl Default for ShotDetectorConfig {
    fn default() -> Self {
        Self {
            threshold: DEFAULT_SCENE_THRESHOLD,
            min_shot_duration: DEFAULT_MIN_SHOT_DURATION,
            generate_keyframes: false,
            keyframe_dir: None,
            ffmpeg_path: None,
            ffprobe_path: None,
            ffprobe_timeout: Duration::from_secs(DEFAULT_FFPROBE_TIMEOUT_SECS),
            ffmpeg_timeout: Duration::from_secs(DEFAULT_FFMPEG_TIMEOUT_SECS),
            max_scene_cuts: DEFAULT_MAX_SCENE_CUTS,
        }
    }
}

// =============================================================================
// Shot Detector
// =============================================================================

/// Detects shots/scenes in video files using FFmpeg
pub struct ShotDetector {
    config: ShotDetectorConfig,
}

impl ShotDetector {
    /// Creates a new shot detector with default configuration
    pub fn new() -> Self {
        Self {
            config: ShotDetectorConfig::default(),
        }
    }

    /// Creates a shot detector with custom configuration
    pub fn with_config(config: ShotDetectorConfig) -> Self {
        Self { config }
    }

    /// Validates the detector configuration
    fn validate_config(&self) -> CoreResult<()> {
        if !self.config.threshold.is_finite() {
            return Err(CoreError::ValidationError(
                "Scene detection threshold must be finite".to_string(),
            ));
        }
        if self.config.threshold < 0.0 || self.config.threshold > 1.0 {
            return Err(CoreError::ValidationError(format!(
                "Scene detection threshold must be between 0.0 and 1.0, got {}",
                self.config.threshold
            )));
        }

        if !self.config.min_shot_duration.is_finite() {
            return Err(CoreError::ValidationError(
                "Minimum shot duration must be finite".to_string(),
            ));
        }
        if self.config.min_shot_duration < 0.0 {
            return Err(CoreError::ValidationError(format!(
                "Minimum shot duration must be non-negative, got {}",
                self.config.min_shot_duration
            )));
        }

        if self.config.max_scene_cuts == 0 {
            return Err(CoreError::ValidationError(
                "Maximum scene cuts must be greater than 0".to_string(),
            ));
        }

        Ok(())
    }

    /// Detects shots in a video file
    pub async fn detect<P: AsRef<Path>>(&self, path: P, asset_id: &str) -> CoreResult<Vec<Shot>> {
        let path = path.as_ref();

        self.validate_config()?;

        tracing::debug!(
            "Shot detection detect(): asset_id={}, path={}, threshold={}, min_shot_duration={}",
            asset_id,
            path.to_string_lossy(),
            self.config.threshold,
            self.config.min_shot_duration
        );

        // Check if file exists
        if !path.exists() {
            return Err(CoreError::FileNotFound(path.to_string_lossy().to_string()));
        }

        if !path.is_file() {
            return Err(CoreError::ValidationError(format!(
                "Expected a file path, got a directory: {}",
                path.to_string_lossy()
            )));
        }

        // Get video duration first
        let duration = self.get_video_duration(path).await?;

        // Run FFmpeg scene detection
        let scene_times = self.run_scene_detection(path).await?;

        tracing::debug!(
            "Shot detection scene cuts: asset_id={}, cuts={}",
            asset_id,
            scene_times.len()
        );

        // Convert scene times to shots
        let shots = self.build_shots(asset_id, &scene_times, duration);

        tracing::debug!(
            "Shot detection built shots: asset_id={}, shots={}",
            asset_id,
            shots.len()
        );

        Ok(shots)
    }

    /// Gets the duration of a video file using FFprobe
    async fn get_video_duration<P: AsRef<Path>>(&self, path: P) -> CoreResult<f64> {
        let ffprobe_bin = self
            .config
            .ffprobe_path
            .as_deref()
            .unwrap_or_else(|| Path::new("ffprobe"));

        let mut cmd = Command::new(ffprobe_bin);
        configure_tokio_command(&mut cmd);
        cmd.args([
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path.as_ref())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let output = tokio::time::timeout(self.config.ffprobe_timeout, cmd.output())
            .await
            .map_err(|_| CoreError::Timeout("FFprobe duration probe timed out".to_string()))?
            .map_err(|e| CoreError::FFprobeError(format!("Failed to run ffprobe: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr_snippet = stderr.lines().take(10).collect::<Vec<_>>().join("\n");
            return Err(CoreError::FFprobeError(format!(
                "FFprobe failed to get duration. stderr:\n{}",
                stderr_snippet
            )));
        }

        let duration_str = String::from_utf8_lossy(&output.stdout);
        let duration: f64 = duration_str
            .trim()
            .parse()
            .map_err(|_| CoreError::FFprobeError("Failed to parse duration".to_string()))?;

        if !duration.is_finite() || duration <= 0.0 {
            return Err(CoreError::FFprobeError(format!(
                "Invalid duration returned by ffprobe: {}",
                duration
            )));
        }

        Ok(duration)
    }

    /// Runs FFmpeg scene detection and returns timestamps.
    ///
    /// This implementation streams stderr instead of buffering it all, to avoid
    /// unbounded memory usage on long videos or very low thresholds.
    async fn run_scene_detection<P: AsRef<Path>>(&self, path: P) -> CoreResult<Vec<f64>> {
        let path_ref = path.as_ref();
        if path_ref.as_os_str().is_empty() {
            return Err(CoreError::ValidationError(
                "Invalid path: empty path provided".to_string(),
            ));
        }

        let ffmpeg_bin = self
            .config
            .ffmpeg_path
            .as_deref()
            .unwrap_or_else(|| Path::new("ffmpeg"));

        let filter = format!("select='gt(scene,{})',showinfo", self.config.threshold);

        let mut cmd = Command::new(ffmpeg_bin);
        configure_tokio_command(&mut cmd);
        cmd.arg("-hide_banner")
            .arg("-nostdin")
            .arg("-i")
            .arg(path_ref)
            .arg("-filter:v")
            .arg(filter)
            .arg("-an")
            .arg("-f")
            .arg("null")
            .arg("-")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| CoreError::Internal(format!("Failed to spawn FFmpeg: {}", e)))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| CoreError::Internal("Failed to capture FFmpeg stderr".to_string()))?;

        let mut reader = BufReader::new(stderr).lines();
        let mut timestamps = Vec::new();
        let mut tail: Vec<String> = Vec::new();

        let start = std::time::Instant::now();
        let max_scene_cuts = self.config.max_scene_cuts;

        loop {
            if start.elapsed() > self.config.ffmpeg_timeout {
                let _ = child.kill().await;
                return Err(CoreError::Timeout(
                    "FFmpeg scene detection timed out".to_string(),
                ));
            }

            // Read stderr lines opportunistically (don't block forever so we can check child status).
            match tokio::time::timeout(std::time::Duration::from_millis(200), reader.next_line())
                .await
            {
                Ok(Ok(Some(line))) => {
                    if tail.len() >= 20 {
                        tail.remove(0);
                    }
                    tail.push(line.clone());

                    if line.contains("pts_time:") {
                        if let Some(time_str) = ShotDetector::extract_pts_time(&line) {
                            if let Ok(time) = time_str.parse::<f64>() {
                                if time.is_finite() {
                                    timestamps.push(time);
                                    if timestamps.len() > max_scene_cuts {
                                        let _ = child.kill().await;
                                        return Err(CoreError::ResourceExhausted(format!(
                                            "FFmpeg returned too many scene cuts (>{}). Refine threshold/min duration.",
                                            max_scene_cuts
                                        )));
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(Ok(None)) => {
                    // EOF on stderr
                }
                Ok(Err(e)) => {
                    let _ = child.kill().await;
                    return Err(CoreError::Internal(format!(
                        "Failed reading FFmpeg stderr: {}",
                        e
                    )));
                }
                Err(_) => {
                    // No stderr line available yet.
                }
            }

            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        return Err(CoreError::Internal(format!(
                            "FFmpeg scene detection failed (exit {}). stderr tail:\n{}",
                            status,
                            tail.join("\n")
                        )));
                    }
                    break;
                }
                Ok(None) => {
                    // Still running.
                }
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(CoreError::Internal(format!(
                        "Failed to poll FFmpeg process status: {}",
                        e
                    )));
                }
            }
        }

        timestamps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        timestamps.dedup_by(|a, b| (*a - *b).abs() < 0.000_001);

        Ok(timestamps)
    }

    /// Extracts pts_time value from FFmpeg showinfo output
    fn extract_pts_time(line: &str) -> Option<&str> {
        let pts_marker = "pts_time:";
        if let Some(start) = line.find(pts_marker) {
            let start = start + pts_marker.len();
            let rest = &line[start..];
            // Find end of number (space or other character)
            let end = rest.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-');
            match end {
                Some(end) => Some(&rest[..end]),
                None => Some(rest.trim()),
            }
        } else {
            None
        }
    }

    /// Builds shot list from scene change timestamps
    fn build_shots(&self, asset_id: &str, scene_times: &[f64], total_duration: f64) -> Vec<Shot> {
        let mut shots = Vec::new();

        // Add start time
        let mut boundaries: Vec<f64> = vec![0.0];
        boundaries.extend(
            scene_times
                .iter()
                .copied()
                .filter(|t| t.is_finite() && *t > 0.0 && *t < total_duration),
        );

        boundaries.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        boundaries.dedup_by(|a, b| (*a - *b).abs() < 0.000_001);

        // Ensure end time is included
        if boundaries
            .last()
            .map(|&t| t < total_duration)
            .unwrap_or(true)
        {
            boundaries.push(total_duration);
        }

        // Create shots from boundaries.
        // If a segment is shorter than min_shot_duration, merge it forward.
        if total_duration > 0.0 && total_duration <= self.config.min_shot_duration {
            shots.push(Shot::new(asset_id, 0.0, total_duration));
            return shots;
        }

        let mut shot_start = 0.0;
        for &boundary in boundaries.iter().skip(1) {
            let seg_end = boundary;
            let seg_duration = seg_end - shot_start;

            if seg_duration < self.config.min_shot_duration {
                // If this is the final boundary, merge it into the previous shot.
                if (seg_end - total_duration).abs() < 0.000_001 {
                    if let Some(last) = shots.last_mut() {
                        last.end_sec = total_duration;
                    } else if total_duration > 0.0 {
                        shots.push(Shot::new(asset_id, 0.0, total_duration));
                    }
                }
                continue;
            }

            shots.push(Shot::new(asset_id, shot_start, seg_end));
            shot_start = seg_end;
        }

        // If no shots created (e.g., single scene video), create one shot for entire duration
        if shots.is_empty() && total_duration > 0.0 {
            shots.push(Shot::new(asset_id, 0.0, total_duration));
        }

        shots
    }

    /// Saves detected shots to the index database
    pub fn save_to_db(&self, db: &IndexDb, shots: &[Shot]) -> CoreResult<()> {
        let conn = db.connection();

        if shots.is_empty() {
            return Ok(());
        }

        // Ensure all shots are for a single asset.
        let asset_id = shots[0].asset_id.clone();
        if shots.iter().any(|s| s.asset_id != asset_id) {
            return Err(CoreError::ValidationError(
                "save_to_db expects shots for a single asset_id".to_string(),
            ));
        }

        // Manual transaction: rusqlite's transaction API may require &mut Connection.
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| CoreError::Internal(format!("Failed to begin transaction: {}", e)))?;

        // Replace existing cache for this asset to avoid duplicates.
        conn.execute("DELETE FROM shots WHERE asset_id = ?", [&asset_id])
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK");
                CoreError::Internal(format!("Failed to clear existing shots: {}", e))
            })?;

        let mut stmt = conn
            .prepare(
                r#"
                INSERT OR REPLACE INTO shots (id, asset_id, start_sec, end_sec, keyframe_path, quality_score, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
            )
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK");
                CoreError::Internal(format!("Failed to prepare insert: {}", e))
            })?;

        for shot in shots {
            if !shot.start_sec.is_finite() || !shot.end_sec.is_finite() {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(CoreError::ValidationError(
                    "Shot has non-finite start/end times".to_string(),
                ));
            }
            if shot.start_sec < 0.0 || shot.end_sec <= shot.start_sec {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(CoreError::ValidationError(
                    "Shot has invalid time range".to_string(),
                ));
            }

            let tags_json = serde_json::to_string(&shot.tags).unwrap_or_else(|_| "[]".to_string());

            stmt.execute(rusqlite::params![
                shot.id,
                shot.asset_id,
                shot.start_sec,
                shot.end_sec,
                shot.keyframe_path,
                shot.quality_score,
                tags_json,
            ])
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK");
                CoreError::Internal(format!("Failed to save shot: {}", e))
            })?;
        }

        conn.execute_batch("COMMIT")
            .map_err(|e| CoreError::Internal(format!("Failed to commit transaction: {}", e)))?;

        Ok(())
    }

    /// Loads shots for an asset from the database
    pub fn load_from_db(db: &IndexDb, asset_id: &str) -> CoreResult<Vec<Shot>> {
        let conn = db.connection();

        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, asset_id, start_sec, end_sec, keyframe_path, quality_score, tags
                FROM shots
                WHERE asset_id = ?
                ORDER BY start_sec
                "#,
            )
            .map_err(|e| CoreError::Internal(format!("Failed to prepare query: {}", e)))?;

        let shots = stmt
            .query_map([asset_id], |row| {
                let tags_json: String = row.get(6)?;
                let tags: Vec<String> =
                    serde_json::from_str(&tags_json).unwrap_or_else(|_| Vec::new());

                Ok(Shot {
                    id: row.get(0)?,
                    asset_id: row.get(1)?,
                    start_sec: row.get(2)?,
                    end_sec: row.get(3)?,
                    keyframe_path: row.get(4)?,
                    quality_score: row.get(5)?,
                    tags,
                })
            })
            .map_err(|e| CoreError::Internal(format!("Failed to query shots: {}", e)))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| CoreError::Internal(format!("Failed to read shots: {}", e)))?;

        Ok(shots)
    }

    /// Checks if FFmpeg is available on the system
    pub fn is_ffmpeg_available() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

impl Default for ShotDetector {
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

    // -------------------------------------------------------------------------
    // Shot Model Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shot_creation() {
        let shot = Shot::new("asset_001", 0.0, 5.0);

        assert!(!shot.id.is_empty());
        assert_eq!(shot.asset_id, "asset_001");
        assert_eq!(shot.start_sec, 0.0);
        assert_eq!(shot.end_sec, 5.0);
        assert!(shot.keyframe_path.is_none());
        assert!(shot.tags.is_empty());
    }

    #[test]
    fn test_shot_duration() {
        let shot = Shot::new("asset_001", 2.5, 7.5);
        assert_eq!(shot.duration(), 5.0);
    }

    #[test]
    fn test_shot_midpoint() {
        let shot = Shot::new("asset_001", 0.0, 10.0);
        assert_eq!(shot.midpoint(), 5.0);
    }

    // -------------------------------------------------------------------------
    // Shot Detector Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shot_detector_default_config() {
        let detector = ShotDetector::new();

        assert_eq!(detector.config.threshold, 0.3);
        assert_eq!(detector.config.min_shot_duration, 0.5);
        assert!(!detector.config.generate_keyframes);
    }

    #[test]
    fn test_shot_detector_custom_config() {
        let config = ShotDetectorConfig {
            threshold: 0.5,
            min_shot_duration: 1.0,
            generate_keyframes: true,
            keyframe_dir: Some("/tmp/keyframes".to_string()),
            ..Default::default()
        };

        let detector = ShotDetector::with_config(config);

        assert_eq!(detector.config.threshold, 0.5);
        assert_eq!(detector.config.min_shot_duration, 1.0);
        assert!(detector.config.generate_keyframes);
    }

    #[test]
    fn test_build_shots_from_timestamps() {
        let detector = ShotDetector::new();
        let timestamps = vec![2.0, 5.0, 8.0];
        let total_duration = 10.0;

        let shots = detector.build_shots("asset_001", &timestamps, total_duration);

        assert_eq!(shots.len(), 4);
        assert_eq!(shots[0].start_sec, 0.0);
        assert_eq!(shots[0].end_sec, 2.0);
        assert_eq!(shots[1].start_sec, 2.0);
        assert_eq!(shots[1].end_sec, 5.0);
        assert_eq!(shots[2].start_sec, 5.0);
        assert_eq!(shots[2].end_sec, 8.0);
        assert_eq!(shots[3].start_sec, 8.0);
        assert_eq!(shots[3].end_sec, 10.0);
    }

    #[test]
    fn test_build_shots_filters_short_shots() {
        let config = ShotDetectorConfig {
            min_shot_duration: 2.0,
            ..Default::default()
        };
        let detector = ShotDetector::with_config(config);

        // Scene at 1.0, 2.5, 3.0 - only 1.5 second gap between 2.5 and 3.0
        let timestamps = vec![1.0, 2.5, 3.0];
        let total_duration = 10.0;

        let shots = detector.build_shots("asset_001", &timestamps, total_duration);

        // Short segments should be merged forward; no shot should be shorter than min.
        assert!(shots.iter().all(|s| s.duration() >= 2.0));
    }

    #[test]
    fn test_build_shots_empty_timestamps() {
        let detector = ShotDetector::new();
        let timestamps: Vec<f64> = vec![];
        let total_duration = 10.0;

        let shots = detector.build_shots("asset_001", &timestamps, total_duration);

        // Should create single shot for entire duration
        assert_eq!(shots.len(), 1);
        assert_eq!(shots[0].start_sec, 0.0);
        assert_eq!(shots[0].end_sec, 10.0);
    }

    #[test]
    fn test_extract_pts_time() {
        let line = "[Parsed_showinfo_1 @ 0x...] n:  42 pts:   125000 pts_time:5.208333 pos:12345";
        let pts_time = ShotDetector::extract_pts_time(line);
        assert_eq!(pts_time, Some("5.208333"));
    }

    #[test]
    fn test_extract_pts_time_no_match() {
        let line = "some other log line without pts_time";
        let pts_time = ShotDetector::extract_pts_time(line);
        assert!(pts_time.is_none());
    }

    // -------------------------------------------------------------------------
    // Database Integration Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_save_and_load_shots() {
        let db = IndexDb::in_memory().unwrap();
        let detector = ShotDetector::new();

        let shots = vec![
            Shot::new("asset_001", 0.0, 5.0),
            Shot::new("asset_001", 5.0, 10.0),
            Shot::new("asset_001", 10.0, 15.0),
        ];

        // Save shots
        detector.save_to_db(&db, &shots).unwrap();

        // Load shots
        let loaded = ShotDetector::load_from_db(&db, "asset_001").unwrap();

        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0].start_sec, 0.0);
        assert_eq!(loaded[1].start_sec, 5.0);
        assert_eq!(loaded[2].start_sec, 10.0);
    }

    #[test]
    fn test_load_shots_ordered_by_time() {
        let db = IndexDb::in_memory().unwrap();
        let detector = ShotDetector::new();

        // Insert in random order
        let shots = vec![
            Shot::new("asset_001", 10.0, 15.0),
            Shot::new("asset_001", 0.0, 5.0),
            Shot::new("asset_001", 5.0, 10.0),
        ];

        detector.save_to_db(&db, &shots).unwrap();

        // Should be ordered by start_sec
        let loaded = ShotDetector::load_from_db(&db, "asset_001").unwrap();

        assert_eq!(loaded[0].start_sec, 0.0);
        assert_eq!(loaded[1].start_sec, 5.0);
        assert_eq!(loaded[2].start_sec, 10.0);
    }

    #[test]
    fn test_load_shots_only_for_asset() {
        let db = IndexDb::in_memory().unwrap();
        let detector = ShotDetector::new();

        detector
            .save_to_db(
                &db,
                &[
                    Shot::new("asset_001", 0.0, 5.0),
                    Shot::new("asset_001", 5.0, 10.0),
                ],
            )
            .unwrap();
        detector
            .save_to_db(&db, &[Shot::new("asset_002", 0.0, 5.0)])
            .unwrap();

        let loaded = ShotDetector::load_from_db(&db, "asset_001").unwrap();
        assert_eq!(loaded.len(), 2);

        let loaded = ShotDetector::load_from_db(&db, "asset_002").unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn test_ffmpeg_availability_check() {
        // Just verify the function doesn't panic
        let _available = ShotDetector::is_ffmpeg_available();
    }

    #[tokio::test]
    async fn test_detect_file_not_found() {
        let detector = ShotDetector::new();
        let result = detector.detect("/nonexistent/video.mp4", "asset_001").await;

        assert!(matches!(result, Err(CoreError::FileNotFound(_))));
    }

    // -------------------------------------------------------------------------
    // Edge Case and Robustness Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_shot_with_zero_duration() {
        let shot = Shot::new("asset_001", 5.0, 5.0);
        assert_eq!(shot.duration(), 0.0);
        assert_eq!(shot.midpoint(), 5.0);
    }

    #[test]
    fn test_shot_with_negative_time_values() {
        // Negative time values should be handled gracefully
        let shot = Shot::new("asset_001", -1.0, 5.0);
        assert_eq!(shot.duration(), 6.0);
        assert_eq!(shot.midpoint(), 2.0);
    }

    #[test]
    fn test_build_shots_with_duplicate_timestamps() {
        let detector = ShotDetector::new();
        // Duplicate timestamps should not cause issues
        let timestamps = vec![2.0, 2.0, 5.0, 5.0, 8.0];
        let total_duration = 10.0;

        let shots = detector.build_shots("asset_001", &timestamps, total_duration);

        // Should handle duplicates gracefully (shots with zero duration are filtered by min_shot_duration)
        assert!(!shots.is_empty());
    }

    #[test]
    fn test_build_shots_with_timestamps_exceeding_duration() {
        let detector = ShotDetector::new();
        // Timestamps that exceed total duration - this can happen with FFmpeg output
        let timestamps = vec![2.0, 15.0, 20.0];
        let total_duration = 10.0;

        let shots = detector.build_shots("asset_001", &timestamps, total_duration);

        // Out-of-range timestamps should be ignored (clamped) and must not panic.
        assert!(!shots.is_empty());
        // First shot should be valid (0.0 to 2.0)
        assert_eq!(shots[0].start_sec, 0.0);
        assert_eq!(shots[0].end_sec, 2.0);
    }

    #[test]
    fn test_extract_pts_time_with_negative_value() {
        let line = "[Parsed_showinfo_1 @ 0x...] n:  42 pts:   -125000 pts_time:-5.208333 pos:12345";
        let pts_time = ShotDetector::extract_pts_time(line);
        assert_eq!(pts_time, Some("-5.208333"));
    }

    #[test]
    fn test_extract_pts_time_with_zero() {
        let line = "[Parsed_showinfo_1 @ 0x...] n:  0 pts:   0 pts_time:0 pos:0";
        let pts_time = ShotDetector::extract_pts_time(line);
        assert_eq!(pts_time, Some("0"));
    }

    #[test]
    fn test_shot_detector_config_boundary_values() {
        // Test with boundary threshold values
        let config_min = ShotDetectorConfig {
            threshold: 0.0,
            min_shot_duration: 0.0,
            generate_keyframes: false,
            keyframe_dir: None,
            ..Default::default()
        };
        let detector_min = ShotDetector::with_config(config_min);
        assert_eq!(detector_min.config.threshold, 0.0);

        let config_max = ShotDetectorConfig {
            threshold: 1.0,
            min_shot_duration: f64::MAX,
            generate_keyframes: false,
            keyframe_dir: None,
            ..Default::default()
        };
        let detector_max = ShotDetector::with_config(config_max);
        assert_eq!(detector_max.config.threshold, 1.0);
    }

    #[test]
    fn test_save_shot_with_special_characters_in_tags() {
        let db = IndexDb::in_memory().unwrap();
        let detector = ShotDetector::new();

        let mut shot = Shot::new("asset_001", 0.0, 5.0);
        shot.tags = vec![
            "tag with spaces".to_string(),
            "tag\"with\"quotes".to_string(),
            "tag\\with\\backslash".to_string(),
            "tag-with-dash".to_string(),
            "tag_with_underscore".to_string(),
        ];

        // Save should not panic
        detector.save_to_db(&db, &[shot.clone()]).unwrap();

        // Load and verify
        let loaded = ShotDetector::load_from_db(&db, "asset_001").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].tags, shot.tags);
    }

    #[test]
    fn test_empty_asset_id() {
        let db = IndexDb::in_memory().unwrap();

        // Empty asset_id should still work (though semantically questionable)
        let shot = Shot::new("", 0.0, 5.0);
        let detector = ShotDetector::new();
        detector.save_to_db(&db, &[shot]).unwrap();

        let loaded = ShotDetector::load_from_db(&db, "").unwrap();
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn test_very_large_time_values() {
        let shot = Shot::new("asset_001", 0.0, 86400.0 * 365.0); // One year in seconds
        assert!(shot.duration() > 0.0);
        assert!(shot.midpoint() > 0.0);
    }

    #[test]
    fn test_shot_upsert_behavior() {
        let db = IndexDb::in_memory().unwrap();
        let detector = ShotDetector::new();

        // Insert initial shot
        let shot1 = Shot::new("asset_001", 0.0, 5.0);
        let shot_id = shot1.id.clone();
        detector.save_to_db(&db, &[shot1]).unwrap();

        // Insert shot with same ID but different values (should update)
        let mut shot2 = Shot::new("asset_001", 10.0, 15.0);
        shot2.id = shot_id.clone();
        detector.save_to_db(&db, &[shot2]).unwrap();

        // Should only have one shot with the updated values
        let loaded = ShotDetector::load_from_db(&db, "asset_001").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, shot_id);
        assert_eq!(loaded[0].start_sec, 10.0);
        assert_eq!(loaded[0].end_sec, 15.0);
    }
}
