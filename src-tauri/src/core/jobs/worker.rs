//! Worker Pool Module
//!
//! Manages background workers for job execution.

use std::collections::BinaryHeap;
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot};

use crate::core::{
    jobs::{Job, JobStatus},
    CoreResult, JobId,
};

// =============================================================================
// Job Handle
// =============================================================================

/// Handle to a submitted job for cancellation and status updates
#[derive(Debug)]
pub struct JobHandle {
    /// Job ID
    pub id: JobId,
    /// Cancel sender
    cancel_tx: Option<oneshot::Sender<()>>,
}

impl JobHandle {
    /// Creates a new job handle
    pub fn new(id: &str, cancel_tx: oneshot::Sender<()>) -> Self {
        Self {
            id: id.to_string(),
            cancel_tx: Some(cancel_tx),
        }
    }

    /// Cancels the job
    pub fn cancel(mut self) -> bool {
        if let Some(tx) = self.cancel_tx.take() {
            tx.send(()).is_ok()
        } else {
            false
        }
    }
}

// =============================================================================
// Priority Queue Entry
// =============================================================================

/// Entry in the priority queue
#[derive(Debug, Clone)]
struct QueueEntry {
    job: Job,
}

impl PartialEq for QueueEntry {
    fn eq(&self, other: &Self) -> bool {
        self.job.id == other.job.id
    }
}

impl Eq for QueueEntry {}

impl PartialOrd for QueueEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for QueueEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Higher priority first
        self.job.priority.cmp(&other.job.priority)
    }
}

// =============================================================================
// Worker Pool Configuration
// =============================================================================

/// Worker pool configuration
#[derive(Clone, Debug)]
pub struct WorkerPoolConfig {
    /// Number of worker threads
    pub num_workers: usize,
    /// Maximum queue size
    pub max_queue_size: usize,
}

impl Default for WorkerPoolConfig {
    fn default() -> Self {
        Self {
            num_workers: num_cpus::get().max(2),
            max_queue_size: 1000,
        }
    }
}

// =============================================================================
// Worker Pool
// =============================================================================

/// Job update event
#[derive(Clone, Debug)]
pub enum JobEvent {
    /// Job status changed
    StatusChanged { job_id: JobId, status: JobStatus },
    /// Job completed
    Completed {
        job_id: JobId,
        result: serde_json::Value,
    },
    /// Job failed
    Failed { job_id: JobId, error: String },
}

/// Manages background workers for job execution
pub struct WorkerPool {
    /// Configuration
    config: WorkerPoolConfig,
    /// Job queue
    queue: Arc<Mutex<BinaryHeap<QueueEntry>>>,
    /// Active jobs
    active_jobs: Arc<Mutex<std::collections::HashMap<JobId, Job>>>,
    /// Event sender
    event_tx: mpsc::UnboundedSender<JobEvent>,
    /// Event receiver
    event_rx: Option<mpsc::UnboundedReceiver<JobEvent>>,
}

impl WorkerPool {
    /// Creates a new worker pool
    pub fn new(config: WorkerPoolConfig) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Self {
            config,
            queue: Arc::new(Mutex::new(BinaryHeap::new())),
            active_jobs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            event_tx,
            event_rx: Some(event_rx),
        }
    }

    /// Creates a worker pool with default configuration
    pub fn with_defaults() -> Self {
        Self::new(WorkerPoolConfig::default())
    }

    /// Submits a job to the queue
    pub fn submit(&self, job: Job) -> CoreResult<JobId> {
        let job_id = job.id.clone();

        {
            let mut queue = self.queue.lock().unwrap();
            if queue.len() >= self.config.max_queue_size {
                return Err(crate::core::CoreError::Internal(
                    "Job queue is full".to_string(),
                ));
            }
            queue.push(QueueEntry { job });
        }

        Ok(job_id)
    }

    /// Gets the current queue length
    pub fn queue_len(&self) -> usize {
        self.queue.lock().unwrap().len()
    }

    /// Gets all active jobs
    pub fn active_jobs(&self) -> Vec<Job> {
        self.active_jobs.lock().unwrap().values().cloned().collect()
    }

    /// Gets all queued jobs (waiting to be processed)
    pub fn queued_jobs(&self) -> Vec<Job> {
        self.queue
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.job.clone())
            .collect()
    }

    /// Gets all jobs (both active and queued)
    pub fn all_jobs(&self) -> Vec<Job> {
        let mut jobs = self.active_jobs();
        jobs.extend(self.queued_jobs());
        jobs
    }

    /// Gets a job by ID
    pub fn get_job(&self, job_id: &str) -> Option<Job> {
        // Check active jobs
        if let Some(job) = self.active_jobs.lock().unwrap().get(job_id) {
            return Some(job.clone());
        }

        // Check queue
        let queue = self.queue.lock().unwrap();
        queue
            .iter()
            .find(|e| e.job.id == job_id)
            .map(|e| e.job.clone())
    }

    /// Cancels a job
    pub fn cancel(&self, job_id: &str) -> bool {
        // Remove from queue if present
        {
            let mut queue = self.queue.lock().unwrap();
            let initial_len = queue.len();
            let entries: Vec<_> = queue.drain().filter(|e| e.job.id != job_id).collect();
            for entry in entries {
                queue.push(entry);
            }
            if queue.len() < initial_len {
                return true;
            }
        }

        // Mark as cancelled in active jobs
        if let Some(job) = self.active_jobs.lock().unwrap().get_mut(job_id) {
            job.status = JobStatus::Cancelled;
            let _ = self.event_tx.send(JobEvent::StatusChanged {
                job_id: job_id.to_string(),
                status: JobStatus::Cancelled,
            });
            return true;
        }

        false
    }

    /// Takes the event receiver (can only be called once)
    pub fn take_event_receiver(&mut self) -> Option<mpsc::UnboundedReceiver<JobEvent>> {
        self.event_rx.take()
    }

    /// Gets the number of configured workers
    pub fn num_workers(&self) -> usize {
        self.config.num_workers
    }
}

impl Default for WorkerPool {
    fn default() -> Self {
        Self::with_defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::jobs::{JobType, Priority};

    #[test]
    fn test_worker_pool_creation() {
        let pool = WorkerPool::with_defaults();
        assert!(pool.num_workers() >= 2);
        assert_eq!(pool.queue_len(), 0);
    }

    #[test]
    fn test_job_submission() {
        let pool = WorkerPool::with_defaults();

        let job = Job::new(JobType::ProxyGeneration, serde_json::json!({}));
        let job_id = pool.submit(job).unwrap();

        assert!(!job_id.is_empty());
        assert_eq!(pool.queue_len(), 1);
    }

    #[test]
    fn test_job_cancellation() {
        let pool = WorkerPool::with_defaults();

        let job = Job::new(JobType::Transcription, serde_json::json!({}));
        let job_id = pool.submit(job).unwrap();

        assert!(pool.cancel(&job_id));
        assert_eq!(pool.queue_len(), 0);
    }

    #[test]
    fn test_priority_queue_ordering() {
        let pool = WorkerPool::with_defaults();

        // Submit jobs with different priorities
        let low =
            Job::new(JobType::Indexing, serde_json::json!({})).with_priority(Priority::Background);
        let high = Job::new(JobType::FinalRender, serde_json::json!({}))
            .with_priority(Priority::UserRequest);

        pool.submit(low).unwrap();
        pool.submit(high).unwrap();

        // Check that high priority job is first
        let queue = pool.queue.lock().unwrap();
        let first = queue.peek().unwrap();
        assert_eq!(first.job.priority, Priority::UserRequest);
    }

    #[test]
    fn test_get_job() {
        let pool = WorkerPool::with_defaults();

        let job = Job::new(
            JobType::ThumbnailGeneration,
            serde_json::json!({"assetId": "test"}),
        );
        let job_id = job.id.clone();
        pool.submit(job).unwrap();

        let found = pool.get_job(&job_id);
        assert!(found.is_some());
        assert_eq!(found.unwrap().job_type, JobType::ThumbnailGeneration);

        assert!(pool.get_job("nonexistent").is_none());
    }
}
