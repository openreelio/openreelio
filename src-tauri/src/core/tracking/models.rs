/// Data models for point tracking.
///
/// These types represent tracked point positions, tracking results,
/// and configuration parameters for the NCC template matching algorithm.
use serde::{Deserialize, Serialize};
use specta::Type;

/// A single tracked point position at a specific frame.
///
/// Coordinates are normalized to 0.0–1.0 range relative to video dimensions.
#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackPointData {
    /// Frame index (0-based).
    pub frame: usize,
    /// Horizontal position, normalized 0.0 (left) to 1.0 (right).
    pub x: f64,
    /// Vertical position, normalized 0.0 (top) to 1.0 (bottom).
    pub y: f64,
    /// Tracking confidence score from NCC matching, 0.0 to 1.0.
    pub confidence: f64,
}

/// Complete result of a point tracking operation.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrackingResultData {
    /// Tracked positions for each frame.
    pub points: Vec<TrackPointData>,
    /// First frame that was tracked (inclusive).
    pub start_frame: usize,
    /// Last frame that was tracked (inclusive).
    pub end_frame: usize,
    /// Original click position X (normalized).
    pub origin_x: f64,
    /// Original click position Y (normalized).
    pub origin_y: f64,
    /// Template patch size used for matching (in pixels at working resolution).
    pub template_size: u32,
    /// Search area size used for matching (in pixels at working resolution).
    pub search_area_size: u32,
}

/// Configuration parameters for the tracking algorithm.
#[derive(Clone, Debug)]
pub struct TrackingConfig {
    /// Size of the template patch in pixels (square). Default: 25.
    pub template_size: u32,
    /// Size of the search area in pixels (square). Default: 100.
    pub search_area_size: u32,
    /// Minimum confidence threshold below which tracking stops. Default: 0.75.
    pub confidence_threshold: f64,
    /// Number of frames between template updates (drift correction). Default: 30.
    pub template_refresh_interval: u32,
    /// Minimum confidence required to update the template. Default: 0.8.
    pub template_refresh_min_confidence: f64,
}

impl Default for TrackingConfig {
    fn default() -> Self {
        Self {
            template_size: 25,
            search_area_size: 100,
            confidence_threshold: 0.75,
            template_refresh_interval: 30,
            template_refresh_min_confidence: 0.8,
        }
    }
}

/// Working resolution for tracking analysis.
/// Frames are downscaled to this height to balance accuracy and speed.
pub const TRACKING_WORKING_HEIGHT: u32 = 480;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_point_data_json_round_trip() {
        let point = TrackPointData {
            frame: 42,
            x: 0.5,
            y: 0.3,
            confidence: 0.95,
        };
        let json = serde_json::to_string(&point).unwrap();
        let restored: TrackPointData = serde_json::from_str(&json).unwrap();
        assert_eq!(point, restored);
    }

    #[test]
    fn tracking_result_data_json_round_trip() {
        let result = TrackingResultData {
            points: vec![
                TrackPointData {
                    frame: 0,
                    x: 0.5,
                    y: 0.5,
                    confidence: 1.0,
                },
                TrackPointData {
                    frame: 1,
                    x: 0.51,
                    y: 0.49,
                    confidence: 0.98,
                },
            ],
            start_frame: 0,
            end_frame: 1,
            origin_x: 0.5,
            origin_y: 0.5,
            template_size: 25,
            search_area_size: 100,
        };
        let json = serde_json::to_string(&result).unwrap();
        let restored: TrackingResultData = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.points.len(), 2);
        assert_eq!(restored.start_frame, 0);
        assert_eq!(restored.end_frame, 1);
    }

    #[test]
    fn tracking_config_default_values() {
        let config = TrackingConfig::default();
        assert_eq!(config.template_size, 25);
        assert_eq!(config.search_area_size, 100);
        assert!((config.confidence_threshold - 0.75).abs() < f64::EPSILON);
        assert_eq!(config.template_refresh_interval, 30);
    }
}
