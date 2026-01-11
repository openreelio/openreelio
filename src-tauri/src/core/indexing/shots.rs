//! Shot Detection Module
//!
//! Detects scene changes in video files using FFmpeg.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

use super::db::IndexDb;
use crate::core::{AssetId, CoreError, CoreResult};

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
}

impl Default for ShotDetectorConfig {
    fn default() -> Self {
        Self {
            threshold: 0.3,
            min_shot_duration: 0.5,
            generate_keyframes: false,
            keyframe_dir: None,
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

    /// Detects shots in a video file
    pub fn detect<P: AsRef<Path>>(&self, path: P, asset_id: &str) -> CoreResult<Vec<Shot>> {
        let path = path.as_ref();

        // Check if file exists
        if !path.exists() {
            return Err(CoreError::FileNotFound(path.to_string_lossy().to_string()));
        }

        // Get video duration first
        let duration = self.get_video_duration(path)?;

        // Run FFmpeg scene detection
        let scene_times = self.run_scene_detection(path)?;

        // Convert scene times to shots
        let shots = self.build_shots(asset_id, &scene_times, duration);

        Ok(shots)
    }

    /// Gets the duration of a video file using FFprobe
    fn get_video_duration<P: AsRef<Path>>(&self, path: P) -> CoreResult<f64> {
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "quiet",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
            ])
            .arg(path.as_ref())
            .output()
            .map_err(|e| CoreError::FFprobeError(format!("Failed to run ffprobe: {}", e)))?;

        if !output.status.success() {
            return Err(CoreError::FFprobeError(
                "FFprobe failed to get duration".to_string(),
            ));
        }

        let duration_str = String::from_utf8_lossy(&output.stdout);
        duration_str
            .trim()
            .parse()
            .map_err(|_| CoreError::FFprobeError("Failed to parse duration".to_string()))
    }

    /// Runs FFmpeg scene detection and returns timestamps
    fn run_scene_detection<P: AsRef<Path>>(&self, path: P) -> CoreResult<Vec<f64>> {
        let output = Command::new("ffmpeg")
            .args([
                "-i",
                path.as_ref().to_str().unwrap_or(""),
                "-filter:v",
                &format!("select='gt(scene,{})',showinfo", self.config.threshold),
                "-f",
                "null",
                "-",
            ])
            .output()
            .map_err(|e| CoreError::Internal(format!("Failed to run FFmpeg: {}", e)))?;

        // FFmpeg outputs scene info to stderr
        let stderr = String::from_utf8_lossy(&output.stderr);

        // Parse timestamps from showinfo output
        let mut timestamps = Vec::new();
        for line in stderr.lines() {
            if line.contains("pts_time:") {
                if let Some(time_str) = Self::extract_pts_time(line) {
                    if let Ok(time) = time_str.parse::<f64>() {
                        timestamps.push(time);
                    }
                }
            }
        }

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
        boundaries.extend(scene_times.iter().cloned());

        // Ensure end time is included
        if boundaries
            .last()
            .map(|&t| t < total_duration)
            .unwrap_or(true)
        {
            boundaries.push(total_duration);
        }

        // Create shots from boundaries
        for window in boundaries.windows(2) {
            let start = window[0];
            let end = window[1];

            // Filter by minimum duration
            if end - start >= self.config.min_shot_duration {
                shots.push(Shot::new(asset_id, start, end));
            }
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

        for shot in shots {
            let tags_json = serde_json::to_string(&shot.tags).unwrap_or_else(|_| "[]".to_string());

            conn.execute(
                r#"
                INSERT OR REPLACE INTO shots (id, asset_id, start_sec, end_sec, keyframe_path, quality_score, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                "#,
                rusqlite::params![
                    shot.id,
                    shot.asset_id,
                    shot.start_sec,
                    shot.end_sec,
                    shot.keyframe_path,
                    shot.quality_score,
                    tags_json,
                ],
            )
            .map_err(|e| CoreError::Internal(format!("Failed to save shot: {}", e)))?;
        }

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
        Command::new("ffmpeg")
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

        // Should filter out shot from 2.5 to 3.0 (only 0.5 seconds)
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

        let shots = vec![
            Shot::new("asset_001", 0.0, 5.0),
            Shot::new("asset_002", 0.0, 5.0),
            Shot::new("asset_001", 5.0, 10.0),
        ];

        detector.save_to_db(&db, &shots).unwrap();

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

    #[test]
    fn test_detect_file_not_found() {
        let detector = ShotDetector::new();
        let result = detector.detect("/nonexistent/video.mp4", "asset_001");

        assert!(matches!(result, Err(CoreError::FileNotFound(_))));
    }
}
