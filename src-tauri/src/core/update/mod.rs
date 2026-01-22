//! Auto-Update System
//!
//! Provides application update functionality using tauri-plugin-updater.
//!
//! Features:
//! - Check for updates on startup (configurable)
//! - Manual update check
//! - Download and install updates
//! - Progress tracking
//!
//! Update source: GitHub Releases

use serde::{Deserialize, Serialize};

/// Update status information
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Whether an update is available
    pub update_available: bool,
    /// Current app version
    pub current_version: String,
    /// Latest available version (if update available)
    pub latest_version: Option<String>,
    /// Release notes/changelog
    pub release_notes: Option<String>,
    /// Download URL
    pub download_url: Option<String>,
    /// Release date
    pub release_date: Option<String>,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            update_available: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            release_notes: None,
            download_url: None,
            release_date: None,
        }
    }
}

/// Update download progress
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// Downloaded bytes
    pub downloaded: u64,
    /// Total bytes to download
    pub total: Option<u64>,
    /// Progress percentage (0-100)
    pub percentage: Option<f64>,
}

/// Update check result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "status")]
pub enum UpdateCheckResult {
    /// Update is available
    #[serde(rename = "available")]
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    /// No update available (already on latest)
    #[serde(rename = "upToDate")]
    UpToDate { version: String },
    /// Error during check
    #[serde(rename = "error")]
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_update_status_default() {
        let status = UpdateStatus::default();
        assert!(!status.update_available);
        assert!(!status.current_version.is_empty());
        assert!(status.latest_version.is_none());
    }

    #[test]
    fn test_update_status_serialization() {
        let status = UpdateStatus {
            update_available: true,
            current_version: "0.1.0".to_string(),
            latest_version: Some("0.2.0".to_string()),
            release_notes: Some("Bug fixes".to_string()),
            download_url: Some("https://example.com/update".to_string()),
            release_date: Some("2024-01-01".to_string()),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("updateAvailable"));
        assert!(json.contains("currentVersion"));
        assert!(json.contains("0.2.0"));
    }

    #[test]
    fn test_update_check_result_available() {
        let result = UpdateCheckResult::Available {
            version: "0.2.0".to_string(),
            notes: Some("New features".to_string()),
            date: None,
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""status":"available""#));
        assert!(json.contains("0.2.0"));
    }

    #[test]
    fn test_update_check_result_up_to_date() {
        let result = UpdateCheckResult::UpToDate {
            version: "0.1.0".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""status":"upToDate""#));
    }

    #[test]
    fn test_update_check_result_error() {
        let result = UpdateCheckResult::Error {
            message: "Network error".to_string(),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains(r#""status":"error""#));
        assert!(json.contains("Network error"));
    }

    #[test]
    fn test_update_progress() {
        let progress = UpdateProgress {
            downloaded: 1024,
            total: Some(2048),
            percentage: Some(50.0),
        };

        let json = serde_json::to_string(&progress).unwrap();
        assert!(json.contains("1024"));
        assert!(json.contains("2048"));
        assert!(json.contains("50"));
    }
}
