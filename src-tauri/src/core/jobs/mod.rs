//! Job System Module
//!
//! Handles background job execution for proxy generation, rendering, transcription, etc.

mod payloads;
mod worker;

pub use payloads::*;
pub use worker::*;

use serde::{Deserialize, Serialize};

use crate::core::JobId;

// =============================================================================
// Job Types
// =============================================================================

/// Job type enumeration
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobType {
    /// Generate proxy video for preview
    ProxyGeneration,
    /// Generate thumbnail images
    ThumbnailGeneration,
    /// Generate audio waveform
    WaveformGeneration,
    /// Index assets (shot detection, etc.)
    Indexing,
    /// Transcribe audio to text
    Transcription,
    /// Render preview segment
    PreviewRender,
    /// Final export render
    FinalRender,
    /// AI completion task
    AICompletion,
}

/// Job priority levels
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    /// Background tasks (lowest)
    Background = 0,
    /// Normal priority
    #[default]
    Normal = 1,
    /// Preview generation (higher)
    Preview = 2,
    /// User-requested tasks (highest)
    UserRequest = 3,
}

/// Job status
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobStatus {
    /// Waiting in queue
    #[default]
    Queued,
    /// Currently running
    Running {
        progress: f32,
        message: Option<String>,
    },
    /// Successfully completed
    Completed { result: serde_json::Value },
    /// Failed with error
    Failed { error: String },
    /// Cancelled by user
    Cancelled,
}

/// Job definition
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    /// Unique job ID
    pub id: JobId,
    /// Type of job
    pub job_type: JobType,
    /// Priority level
    pub priority: Priority,
    /// Current status
    pub status: JobStatus,
    /// Job payload
    pub payload: serde_json::Value,
    /// Creation timestamp
    pub created_at: String,
    /// Completion timestamp
    pub completed_at: Option<String>,
}

impl Job {
    /// Creates a new job
    pub fn new(job_type: JobType, payload: serde_json::Value) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            job_type,
            priority: Priority::default(),
            status: JobStatus::Queued,
            payload,
            created_at: chrono::Utc::now().to_rfc3339(),
            completed_at: None,
        }
    }

    /// Sets the priority
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = priority;
        self
    }

    /// Checks if job is running
    pub fn is_running(&self) -> bool {
        matches!(self.status, JobStatus::Running { .. })
    }

    /// Checks if job is completed (success or failure)
    pub fn is_done(&self) -> bool {
        matches!(
            self.status,
            JobStatus::Completed { .. } | JobStatus::Failed { .. } | JobStatus::Cancelled
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_job_creation() {
        let job = Job::new(
            JobType::ProxyGeneration,
            serde_json::json!({"assetId": "asset_001"}),
        );

        assert!(!job.id.is_empty());
        assert_eq!(job.job_type, JobType::ProxyGeneration);
        assert_eq!(job.priority, Priority::Normal);
        assert!(matches!(job.status, JobStatus::Queued));
    }

    #[test]
    fn test_job_priority() {
        let job = Job::new(JobType::FinalRender, serde_json::json!({}))
            .with_priority(Priority::UserRequest);

        assert_eq!(job.priority, Priority::UserRequest);
    }

    #[test]
    fn test_priority_ordering() {
        assert!(Priority::UserRequest > Priority::Preview);
        assert!(Priority::Preview > Priority::Normal);
        assert!(Priority::Normal > Priority::Background);
    }

    #[test]
    fn test_job_status_checks() {
        let mut job = Job::new(JobType::Transcription, serde_json::json!({}));

        assert!(!job.is_running());
        assert!(!job.is_done());

        job.status = JobStatus::Running {
            progress: 0.5,
            message: None,
        };
        assert!(job.is_running());
        assert!(!job.is_done());

        job.status = JobStatus::Completed {
            result: serde_json::json!({}),
        };
        assert!(!job.is_running());
        assert!(job.is_done());
    }
}
