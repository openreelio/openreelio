//! Worker Pool Module
//!
//! Manages background workers for job execution.
//! Workers consume jobs from a channel and process them asynchronously,
//! emitting events via Tauri for progress updates.

use std::collections::BinaryHeap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard, PoisonError,
};

use tauri::Emitter;
#[cfg(not(test))]
use tauri::Manager;
use tokio::sync::{mpsc, oneshot, Notify};

use crate::core::{
    ffmpeg::{FFmpegProgress, SharedFFmpegState},
    fs::{validate_local_input_path_async, validate_path_id_component},
    jobs::{Job, JobStatus, JobType},
    CoreResult, JobId,
};

// =============================================================================
// Mutex Helpers
// =============================================================================

/// Acquires a mutex lock, recovering from poisoning if necessary.
///
/// In a video editing application, we prefer to continue operating with potentially
/// stale state rather than panicking. If a thread panics while holding the lock,
/// we log the event and recover the data.
///
/// This is safe because:
/// 1. The job queue is transient (jobs can be resubmitted)
/// 2. Individual job failures don't corrupt the overall system
/// 3. User experience is better with graceful degradation
fn acquire_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            tracing::warn!(
                "Mutex was poisoned (likely due to a panic in another thread). \
                 Recovering data - some jobs may need to be resubmitted."
            );
            poisoned.into_inner()
        }
    }
}

/// Attempts to acquire a mutex lock, returning an error string if poisoned.
///
/// Use this variant when you want to propagate the error rather than recover.
#[allow(dead_code)]
fn try_acquire_lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e: PoisonError<_>| {
        tracing::error!("Mutex poisoned: {:?}", e);
        "Internal error: mutex poisoned".to_string()
    })
}

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
pub(crate) struct QueueEntry {
    pub(crate) job: Job,
    pub(crate) enqueue_seq: u64,
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
        // Higher priority first; FIFO within same priority.
        self.job
            .priority
            .cmp(&other.job.priority)
            .then_with(|| other.enqueue_seq.cmp(&self.enqueue_seq))
    }
}

fn job_type_wire_value(job_type: &JobType) -> String {
    serde_json::to_value(job_type)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| format!("{:?}", job_type))
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
    /// Job queue (pub(crate) for worker access)
    pub(crate) queue: Arc<Mutex<BinaryHeap<QueueEntry>>>,
    /// Active jobs (pub(crate) for worker access)
    pub(crate) active_jobs: Arc<Mutex<std::collections::HashMap<JobId, Job>>>,
    /// Monotonic sequence for FIFO ordering within a priority.
    enqueue_seq: AtomicU64,
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
            enqueue_seq: AtomicU64::new(0),
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
        let enqueue_seq = self.enqueue_seq.fetch_add(1, Ordering::Relaxed);

        {
            let mut queue = acquire_lock(&self.queue);
            if queue.len() >= self.config.max_queue_size {
                return Err(crate::core::CoreError::Internal(
                    "Job queue is full".to_string(),
                ));
            }
            queue.push(QueueEntry { job, enqueue_seq });
        }

        Ok(job_id)
    }

    /// Gets the current queue length
    pub fn queue_len(&self) -> usize {
        acquire_lock(&self.queue).len()
    }

    /// Gets all active jobs
    pub fn active_jobs(&self) -> Vec<Job> {
        acquire_lock(&self.active_jobs).values().cloned().collect()
    }

    /// Gets all queued jobs (waiting to be processed)
    pub fn queued_jobs(&self) -> Vec<Job> {
        acquire_lock(&self.queue)
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
        if let Some(job) = acquire_lock(&self.active_jobs).get(job_id) {
            return Some(job.clone());
        }

        // Check queue
        let queue = acquire_lock(&self.queue);
        queue
            .iter()
            .find(|e| e.job.id == job_id)
            .map(|e| e.job.clone())
    }

    /// Cancels a job
    pub fn cancel(&self, job_id: &str) -> bool {
        // Remove from queue if present
        {
            let mut queue = acquire_lock(&self.queue);
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
        if let Some(job) = acquire_lock(&self.active_jobs).get_mut(job_id) {
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

    /// Spawns background workers to process jobs.
    ///
    /// This method starts async tasks that consume jobs from the queue.
    /// Workers will run until the shutdown signal is triggered.
    ///
    /// # Arguments
    /// * `ffmpeg_state` - Shared FFmpeg state for video operations
    /// * `app_handle` - Tauri app handle for emitting events
    /// * `cache_dir` - Directory for cached files (thumbnails, proxies, etc.)
    /// * `shutdown` - Notify signal to stop workers gracefully
    ///
    /// # Returns
    /// Vector of task handles for the spawned workers.
    pub fn spawn_workers(
        &self,
        ffmpeg_state: SharedFFmpegState,
        app_handle: tauri::AppHandle,
        cache_dir: std::path::PathBuf,
        shutdown: Arc<Notify>,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        start_workers(self, ffmpeg_state, app_handle, cache_dir, shutdown)
    }
}

impl Default for WorkerPool {
    fn default() -> Self {
        Self::with_defaults()
    }
}

// =============================================================================
// Job Processor
// =============================================================================

/// Job processor handles the actual execution of jobs.
/// It holds references to FFmpeg and emits events via Tauri.
pub struct JobProcessor {
    /// FFmpeg state for video operations
    ffmpeg_state: SharedFFmpegState,
    /// Tauri app handle for emitting events
    app_handle: tauri::AppHandle,
    /// Cache directory for generated files
    cache_dir: PathBuf,
}

impl JobProcessor {
    /// Creates a new job processor
    pub fn new(
        ffmpeg_state: SharedFFmpegState,
        app_handle: tauri::AppHandle,
        cache_dir: PathBuf,
    ) -> Self {
        Self {
            ffmpeg_state,
            app_handle,
            cache_dir,
        }
    }

    /// Process a single job
    pub async fn process(&self, job: &mut Job) -> Result<serde_json::Value, String> {
        tracing::info!("Processing job {}: {:?}", job.id, job.job_type);

        match &job.job_type {
            JobType::ThumbnailGeneration => self.process_thumbnail(job).await,
            JobType::ProxyGeneration => self.process_proxy(job).await,
            JobType::WaveformGeneration => self.process_waveform(job).await,
            JobType::Transcription => self.process_transcription(job).await,
            JobType::Indexing => self.process_indexing(job).await,
            JobType::PreviewRender => self.process_preview_render(job).await,
            JobType::FinalRender => self.process_final_render(job).await,
            JobType::AICompletion => self.process_ai_completion(job).await,
        }
    }

    /// Emit job progress event
    #[allow(dead_code)]
    fn emit_progress(&self, job_id: &str, progress: f32, message: Option<&str>) {
        let _ = self.app_handle.emit(
            "job:progress",
            serde_json::json!({
                "jobId": job_id,
                "progress": progress,
                "message": message,
            }),
        );
    }

    /// Emit job completion event
    fn emit_completed(&self, job_id: &str, result: &serde_json::Value) {
        let _ = self.app_handle.emit(
            "job:completed",
            serde_json::json!({
                "jobId": job_id,
                "result": result,
            }),
        );
    }

    /// Emit job failure event
    fn emit_failed(&self, job_id: &str, error: &str) {
        let _ = self.app_handle.emit(
            "job:failed",
            serde_json::json!({
                "jobId": job_id,
                "error": error,
            }),
        );
    }

    /// Process thumbnail generation job
    async fn process_thumbnail(&self, job: &Job) -> Result<serde_json::Value, String> {
        let asset_id = job
            .payload
            .get("assetId")
            .and_then(|v| v.as_str())
            .ok_or("Missing assetId in payload")?;

        validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = validate_local_input_path_async(input_path, "inputPath").await?;

        let width = job
            .payload
            .get("width")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        let height = job
            .payload
            .get("height")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        // Create output path
        let output_dir = self.cache_dir.join("thumbnails");
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;

        let output_path = output_dir.join(format!("{}.jpg", asset_id));

        // Get FFmpeg runner
        let state = self.ffmpeg_state.read().await;
        let runner = state.runner().ok_or("FFmpeg not available")?;

        // Generate thumbnail
        let size = match (width, height) {
            (Some(w), Some(h)) => Some((w, h)),
            _ => Some((320, 180)), // Default thumbnail size
        };

        runner
            .generate_thumbnail(&input_path, &output_path, size)
            .await
            .map_err(|e| format!("Thumbnail generation failed: {}", e))?;

        Ok(serde_json::json!({
            "assetId": asset_id,
            "thumbnailPath": output_path.to_string_lossy(),
        }))
    }

    /// Process proxy video generation job
    ///
    /// Emits events:
    /// - `asset:proxy-generating` when starting
    /// - `asset:proxy-ready` on success with { assetId, proxyPath, proxyUrl }
    /// - `asset:proxy-failed` on failure with { assetId, error }
    async fn process_proxy(&self, job: &Job) -> Result<serde_json::Value, String> {
        let asset_id = job
            .payload
            .get("assetId")
            .and_then(|v| v.as_str())
            .ok_or("Missing assetId in payload")?;

        validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = validate_local_input_path_async(input_path, "inputPath").await?;

        // Emit generating event
        let _ = self.app_handle.emit(
            "asset:proxy-generating",
            serde_json::json!({
                "assetId": asset_id,
                "jobId": job.id,
            }),
        );

        // Create output path
        let output_dir = self.cache_dir.join("proxies");
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create proxy directory: {}", e))?;

        let output_path = output_dir.join(format!("{}.mp4", asset_id));

        // Get FFmpeg runner
        let state = self.ffmpeg_state.read().await;
        let runner = state.runner().ok_or("FFmpeg not available")?;

        // Create progress channel for FFmpeg progress updates
        let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel::<FFmpegProgress>(32);
        let app_handle = self.app_handle.clone();
        let job_id = job.id.clone();
        let asset_id_for_progress = asset_id.to_string();

        // Spawn progress reporter
        let progress_task = tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                let _ = app_handle.emit(
                    "job:progress",
                    serde_json::json!({
                        "jobId": job_id,
                        "assetId": asset_id_for_progress,
                        "progress": progress.percent / 100.0,
                        "message": format!("Encoding: {:.1}%", progress.percent),
                        "fps": progress.fps,
                        "etaSeconds": progress.eta_seconds,
                    }),
                );
            }
        });

        // Generate proxy with progress
        let result = runner
            .generate_proxy(&input_path, &output_path, Some(progress_tx))
            .await;

        // Wait for progress reporter to finish
        let _ = progress_task.await;

        match result {
            Ok(()) => {
                // Return the raw file path - frontend will use convertFileSrc() to
                // convert it to a proper Tauri asset protocol URL
                let proxy_path_str = output_path.to_string_lossy().to_string();

                // Emit proxy ready event for frontend to update state
                // Note: proxyUrl is the raw file path, frontend handles conversion
                let _ = self.app_handle.emit(
                    "asset:proxy-ready",
                    serde_json::json!({
                        "assetId": asset_id,
                        "proxyPath": proxy_path_str,
                        "proxyUrl": proxy_path_str,
                    }),
                );

                tracing::info!(
                    "Proxy generation completed for asset {}: {}",
                    asset_id,
                    output_path.display()
                );

                Ok(serde_json::json!({
                    "assetId": asset_id,
                    "proxyPath": proxy_path_str,
                    "proxyUrl": proxy_path_str,
                }))
            }
            Err(e) => {
                let error_msg = format!("Proxy generation failed: {}", e);

                // Emit proxy failed event
                let _ = self.app_handle.emit(
                    "asset:proxy-failed",
                    serde_json::json!({
                        "assetId": asset_id,
                        "error": error_msg,
                    }),
                );

                Err(error_msg)
            }
        }
    }

    /// Process waveform generation job
    ///
    /// Generates audio waveform peak data as JSON for timeline visualization.
    /// Emits events:
    /// - `waveform-generating` when starting
    /// - `waveform-complete` on success with { assetId, samplesPerSecond, peakCount, durationSec }
    /// - `waveform-error` on failure with { assetId, error }
    async fn process_waveform(&self, job: &Job) -> Result<serde_json::Value, String> {
        use tauri::Emitter;

        let asset_id = job
            .payload
            .get("assetId")
            .and_then(|v| v.as_str())
            .ok_or("Missing assetId in payload")?;

        validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = validate_local_input_path_async(input_path, "inputPath").await?;

        let samples_per_second = job
            .payload
            .get("samplesPerSecond")
            .and_then(|v| v.as_u64())
            .unwrap_or(100) as u32;

        // Emit generating event
        let _ = self.app_handle.emit(
            "waveform-generating",
            serde_json::json!({
                "assetId": asset_id,
                "jobId": job.id,
            }),
        );

        // Create output path for JSON waveform
        let output_dir = self.cache_dir.join("waveforms");
        std::fs::create_dir_all(&output_dir)
            .map_err(|e| format!("Failed to create waveform directory: {}", e))?;

        let output_path = output_dir.join(format!("{}.json", asset_id));

        // Get FFmpeg runner
        let state = self.ffmpeg_state.read().await;
        let runner = state.runner().ok_or("FFmpeg not available")?;

        // Generate waveform as JSON
        match runner
            .generate_waveform_json(&input_path, &output_path, samples_per_second)
            .await
        {
            Ok(waveform) => {
                // Emit completion event
                let _ = self.app_handle.emit(
                    "waveform-complete",
                    serde_json::json!({
                        "assetId": asset_id,
                        "samplesPerSecond": waveform.samples_per_second,
                        "peakCount": waveform.peaks.len(),
                        "durationSec": waveform.duration_sec,
                        "waveformPath": output_path.to_string_lossy(),
                    }),
                );

                tracing::info!(
                    "Waveform generation completed for asset {}: {} peaks",
                    asset_id,
                    waveform.peaks.len()
                );

                Ok(serde_json::json!({
                    "assetId": asset_id,
                    "waveformPath": output_path.to_string_lossy(),
                    "samplesPerSecond": waveform.samples_per_second,
                    "peakCount": waveform.peaks.len(),
                    "durationSec": waveform.duration_sec,
                }))
            }
            Err(e) => {
                let error_msg = format!("Waveform generation failed: {}", e);

                // Emit error event
                let _ = self.app_handle.emit(
                    "waveform-error",
                    serde_json::json!({
                        "assetId": asset_id,
                        "error": error_msg,
                    }),
                );

                Err(error_msg)
            }
        }
    }

    /// Process transcription job using Whisper
    async fn process_transcription(&self, job: &Job) -> Result<serde_json::Value, String> {
        use crate::core::captions::{
            audio::extract_audio_for_transcription_async,
            whisper::{
                default_models_dir, is_whisper_available, TranscriptionOptions, WhisperEngine,
                WhisperModel,
            },
        };

        let asset_id = job
            .payload
            .get("assetId")
            .and_then(|v| v.as_str())
            .ok_or("Missing assetId in payload")?;

        validate_path_id_component(asset_id, "assetId")?;

        // Options may arrive either flattened or nested under `options`.
        let options = job.payload.get("options");

        let input_path = if let Some(path) = job.payload.get("inputPath").and_then(|v| v.as_str()) {
            validate_local_input_path_async(path, "inputPath")
                .await?
                .to_string_lossy()
                .to_string()
        } else {
            // Fallback: resolve from currently open project (requires AppState).
            #[cfg(test)]
            {
                return Err("inputPath is required in unit tests".to_string());
            }

            #[cfg(not(test))]
            {
                let app_state = self.app_handle.state::<crate::AppState>();
                let guard = app_state.project.lock().await;
                let project = guard.as_ref().ok_or_else(|| {
                    "No project open; cannot resolve transcription input path".to_string()
                })?;
                let asset = project
                    .state
                    .assets
                    .get(asset_id)
                    .ok_or_else(|| format!("Asset not found: {}", asset_id))?;
                asset.uri.clone()
            }
        };

        let model_name = job
            .payload
            .get("model")
            .and_then(|v| v.as_str())
            .or_else(|| options.and_then(|o| o.get("model").and_then(|v| v.as_str())))
            .unwrap_or("base");

        let language = job
            .payload
            .get("language")
            .and_then(|v| v.as_str())
            .or_else(|| options.and_then(|o| o.get("language").and_then(|v| v.as_str())))
            .map(|s| s.to_string());

        let translate = job
            .payload
            .get("translate")
            .and_then(|v| v.as_bool())
            .or_else(|| options.and_then(|o| o.get("translate").and_then(|v| v.as_bool())))
            .unwrap_or(false);

        // Check if whisper is available
        if !is_whisper_available() {
            return Err("Whisper feature not enabled. Rebuild with --features whisper".to_string());
        }

        tracing::info!(
            "Starting transcription for asset {} using {} model",
            asset_id,
            model_name
        );

        // Emit initial progress
        let _ = self.app_handle.emit(
            "job-progress",
            serde_json::json!({
                "jobId": job.id,
                "progress": 0.1,
                "message": "Extracting audio...",
            }),
        );

        // Get FFmpeg path from runner
        let ffmpeg_path: Option<String> = {
            let guard = self.ffmpeg_state.read().await;
            guard
                .info()
                .and_then(|i| i.ffmpeg_path.to_str().map(|s| s.to_string()))
        };

        // Create temp directory for audio
        let temp_dir = std::env::temp_dir().join("openreelio_transcription");
        std::fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temp directory: {}", e))?;

        let audio_path = temp_dir.join(format!("{}_{}.wav", asset_id, uuid::Uuid::new_v4()));
        struct TempFileGuard(std::path::PathBuf);
        impl Drop for TempFileGuard {
            fn drop(&mut self) {
                if self.0.exists() {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
        }
        let _temp_guard = TempFileGuard(audio_path.clone());

        let input = std::path::Path::new(&input_path);

        // Extract audio for transcription
        extract_audio_for_transcription_async(input, &audio_path, ffmpeg_path.as_deref())
            .await
            .map_err(|e| format!("Failed to extract audio: {}", e))?;

        // Emit progress after audio extraction
        let _ = self.app_handle.emit(
            "job-progress",
            serde_json::json!({
                "jobId": job.id,
                "progress": 0.3,
                "message": "Loading Whisper model...",
            }),
        );

        // Parse model size
        let model_size: WhisperModel = model_name
            .parse()
            .map_err(|_| format!("Unknown model size: {}", model_name))?;

        // Get model path
        let models_dir = default_models_dir();
        let model_path = models_dir.join(model_size.filename());

        if !model_path.exists() {
            return Err(format!(
                "Whisper model not found at {}. Please download the model first.",
                model_path.display()
            ));
        }

        // Load whisper engine (this is CPU-intensive, so we'll use spawn_blocking)
        let model_path_clone = model_path.clone();
        let engine = tokio::task::spawn_blocking(move || WhisperEngine::new(&model_path_clone))
            .await
            .map_err(|e| format!("Task join error: {}", e))?
            .map_err(|e| format!("Failed to load Whisper model: {}", e))?;

        // Emit progress after model loading
        let _ = self.app_handle.emit(
            "job-progress",
            serde_json::json!({
                "jobId": job.id,
                "progress": 0.5,
                "message": "Transcribing audio...",
            }),
        );

        // Configure transcription options
        let options = TranscriptionOptions {
            language,
            translate,
            threads: 0, // Auto-detect
            initial_prompt: None,
        };

        // Run transcription (CPU-intensive)
        let audio_path_clone = audio_path.clone();
        let result = tokio::task::spawn_blocking(move || {
            engine.transcribe_file(&audio_path_clone, &options)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
        .map_err(|e| format!("Transcription failed: {}", e))?;

        // Emit progress after transcription
        let _ = self.app_handle.emit(
            "job-progress",
            serde_json::json!({
                "jobId": job.id,
                "progress": 0.9,
                "message": "Processing results...",
            }),
        );

        // Convert segments to JSON
        let segments: Vec<serde_json::Value> = result
            .segments
            .iter()
            .map(|s| {
                serde_json::json!({
                    "startTime": s.start_time,
                    "endTime": s.end_time,
                    "text": s.text,
                })
            })
            .collect();

        tracing::info!(
            "Transcription completed for asset {}: {} segments, {:.1}s duration",
            asset_id,
            result.segments.len(),
            result.duration
        );

        // Emit completion event
        let _ = self.app_handle.emit(
            "transcription-complete",
            serde_json::json!({
                "jobId": job.id,
                "assetId": asset_id,
                "segmentCount": result.segments.len(),
                "duration": result.duration,
                "language": result.language,
            }),
        );

        Ok(serde_json::json!({
            "assetId": asset_id,
            "language": result.language,
            "duration": result.duration,
            "segmentCount": result.segments.len(),
            "segments": segments,
            "fullText": result.full_text(),
        }))
    }

    /// Process indexing job using Meilisearch
    async fn process_indexing(&self, job: &Job) -> Result<serde_json::Value, String> {
        #[cfg(test)]
        {
            let _ = job;
            Err("Search indexing requires AppState and is disabled in unit tests".to_string())
        }

        #[cfg(not(test))]
        {
            use crate::core::search::meilisearch::{
                indexer::{AssetDocument, TranscriptDocument},
                is_meilisearch_available,
            };

            let asset_id = job
                .payload
                .get("assetId")
                .and_then(|v| v.as_str())
                .ok_or("Missing assetId in payload")?;

            // Check if Meilisearch is available
            if !is_meilisearch_available() {
                tracing::warn!(
                    "Meilisearch feature not enabled, skipping indexing for asset {}",
                    asset_id
                );
                return Ok(serde_json::json!({
                    "assetId": asset_id,
                    "indexed": false,
                    "message": "Meilisearch feature not enabled",
                }));
            }

            // Get asset metadata from payload
            let asset_name = job
                .payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");

            let asset_path = job
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let asset_kind = job
                .payload
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");

            let duration = job.payload.get("duration").and_then(|v| v.as_f64());

            let project_id = job.payload.get("projectId").and_then(|v| v.as_str());

            // Check for transcript segments to index
            let transcript_segments: Vec<serde_json::Value> = job
                .payload
                .get("transcriptSegments")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            tracing::info!(
                "Indexing asset {} with {} transcript segments",
                asset_id,
                transcript_segments.len()
            );

            // Emit progress
            let _ = self.app_handle.emit(
                "job-progress",
                serde_json::json!({
                    "jobId": job.id,
                    "progress": 0.3,
                    "message": "Building index documents...",
                }),
            );

            // Build asset document
            let mut asset_doc = AssetDocument::new(asset_id, asset_name, asset_path, asset_kind);
            if let Some(dur) = duration {
                asset_doc = asset_doc.with_duration(dur);
            }
            if let Some(proj_id) = project_id {
                asset_doc = asset_doc.with_project_id(proj_id);
            }

            // Build transcript documents
            let transcript_docs: Vec<TranscriptDocument> = transcript_segments
                .iter()
                .enumerate()
                .filter_map(|(i, seg)| {
                    let text = seg.get("text")?.as_str()?;
                    let start = seg.get("startTime").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let end = seg.get("endTime").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let language = seg.get("language").and_then(|v| v.as_str());

                    let segment_id = format!("{}_{}", asset_id, i);
                    let mut doc = TranscriptDocument::new(&segment_id, asset_id, text, start, end);
                    if let Some(lang) = language {
                        doc = doc.with_language(lang);
                    }
                    Some(doc)
                })
                .collect();

            // Perform actual indexing via the shared Meilisearch service
            let app_state = self.app_handle.state::<crate::AppState>();
            let service = {
                let guard = app_state.search_service.lock().await;
                guard.clone().ok_or_else(|| {
                    "Search service not initialized. Ensure Meilisearch is enabled and started"
                        .to_string()
                })?
            };

            // Ensure sidecar + indexer are ready (lazy startup)
            service.ensure_ready().await?;

            // Index documents
            service.index_asset(&asset_doc).await?;
            service
                .index_transcripts(asset_id, &transcript_docs)
                .await?;

            let _ = self.app_handle.emit(
                "job-progress",
                serde_json::json!({
                    "jobId": job.id,
                    "progress": 0.9,
                    "message": "Finalizing index...",
                }),
            );

            tracing::info!(
                "Indexed asset {} and {} transcript segments",
                asset_id,
                transcript_docs.len()
            );

            // Emit completion event
            let _ = self.app_handle.emit(
                "indexing-complete",
                serde_json::json!({
                    "jobId": job.id,
                    "assetId": asset_id,
                    "transcriptCount": transcript_docs.len(),
                }),
            );

            Ok(serde_json::json!({
                "assetId": asset_id,
                "indexed": true,
                "assetDocument": serde_json::to_value(&asset_doc).unwrap_or_default(),
                "transcriptCount": transcript_docs.len(),
                "message": "Indexed in Meilisearch",
            }))
        }
    }

    /// Process preview render job.
    ///
    /// Renders a preview segment of the timeline with optimized settings for fast playback.
    /// This is used for timeline preview during editing, not final export.
    ///
    /// # Payload
    ///
    /// * `sequenceId` (required) - ID of the sequence to render
    /// * `startTime` (optional) - Start time in seconds for range preview
    /// * `endTime` (optional) - End time in seconds for range preview
    ///
    /// # Events
    ///
    /// * `preview:rendering` - Emitted when preview render starts
    /// * `preview:progress` - Emitted with progress updates
    /// * `preview:complete` - Emitted on successful completion
    /// * `preview:failed` - Emitted on failure
    async fn process_preview_render(&self, job: &Job) -> Result<serde_json::Value, String> {
        #[cfg(not(test))]
        use crate::core::render::{ExportEngine, ExportSettings};

        // Validate required payload fields
        let sequence_id = job
            .payload
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .ok_or("Missing sequenceId in payload")?;

        validate_path_id_component(sequence_id, "sequenceId")?;

        // Parse optional time range
        let start_time = job.payload.get("startTime").and_then(|v| v.as_f64());
        let end_time = job.payload.get("endTime").and_then(|v| v.as_f64());

        // Validate time range if both specified
        if let (Some(start), Some(end)) = (start_time, end_time) {
            if start >= end {
                return Err(format!(
                    "Invalid time range: start ({}) must be less than end ({})",
                    start, end
                ));
            }
            if start < 0.0 {
                return Err("startTime cannot be negative".to_string());
            }
        }

        tracing::info!(
            "Starting preview render for sequence {} (range: {:?} - {:?})",
            sequence_id,
            start_time,
            end_time
        );

        // Emit rendering start event
        let _ = self.app_handle.emit(
            "preview:rendering",
            serde_json::json!({
                "jobId": job.id,
                "sequenceId": sequence_id,
                "startTime": start_time,
                "endTime": end_time,
            }),
        );

        #[cfg(test)]
        {
            Err("Preview render requires AppState and is disabled in unit tests".to_string())
        }

        #[cfg(not(test))]
        {
            let (sequence, assets, effects) = {
                // Get project state from AppState
                let app_state = self.app_handle.state::<crate::AppState>();
                let guard = app_state.project.lock().await;
                let project = guard.as_ref().ok_or("No project open")?;

                // Find the sequence
                let sequence = project
                    .state
                    .sequences
                    .get(sequence_id)
                    .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?;

                // Clone required data to release the lock
                let sequence = sequence.clone();
                let assets = project.state.assets.clone();
                let effects = project.state.effects.clone();
                (sequence, assets, effects)
            };

            // Check if sequence has clips
            let total_clips: usize = sequence.tracks.iter().map(|t| t.clips.len()).sum();
            if total_clips == 0 {
                let error = "Sequence has no clips to render";
                let _ = self.app_handle.emit(
                    "preview:failed",
                    serde_json::json!({
                        "jobId": job.id,
                        "sequenceId": sequence_id,
                        "error": error,
                    }),
                );
                return Err(error.to_string());
            }

            // Create output path in cache directory
            let output_dir = self.cache_dir.join("previews");
            std::fs::create_dir_all(&output_dir)
                .map_err(|e| format!("Failed to create preview directory: {}", e))?;

            let output_filename = format!(
                "{}_{}.mp4",
                sequence_id,
                chrono::Utc::now().timestamp_millis()
            );
            let output_path = output_dir.join(&output_filename);

            // Create preview-optimized export settings
            let settings = ExportSettings::preview(output_path.clone(), start_time, end_time);

            // Get FFmpeg runner
            let state = self.ffmpeg_state.read().await;
            let runner = state.runner().ok_or("FFmpeg not available")?;

            // Create export engine
            let export_engine = ExportEngine::new(runner.clone());

            // Create progress channel
            let (progress_tx, mut progress_rx) =
                tokio::sync::mpsc::channel::<crate::core::render::ExportProgress>(32);

            let app_handle = self.app_handle.clone();
            let job_id = job.id.clone();
            let seq_id = sequence_id.to_string();

            // Spawn progress reporter task
            let progress_task = tokio::spawn(async move {
                while let Some(progress) = progress_rx.recv().await {
                    let _ = app_handle.emit(
                        "preview:progress",
                        serde_json::json!({
                            "jobId": job_id,
                            "sequenceId": seq_id,
                            "frame": progress.frame,
                            "totalFrames": progress.total_frames,
                            "percent": progress.percent,
                            "fps": progress.fps,
                            "etaSeconds": progress.eta_seconds,
                            "message": progress.message,
                        }),
                    );
                }
            });

            // Execute preview render
            let result = export_engine
                .export_sequence_with_effects(
                    &sequence,
                    &assets,
                    &effects,
                    &settings,
                    Some(progress_tx),
                )
                .await;

            // Wait for progress reporter to finish
            let _ = progress_task.await;

            match result {
                Ok(export_result) => {
                    let preview_path = export_result.output_path.to_string_lossy().to_string();

                    // Emit completion event
                    let _ = self.app_handle.emit(
                        "preview:complete",
                        serde_json::json!({
                            "jobId": job.id,
                            "sequenceId": sequence_id,
                            "previewPath": preview_path,
                            "durationSec": export_result.duration_sec,
                            "fileSizeBytes": export_result.file_size,
                            "encodingTimeSec": export_result.encoding_time_sec,
                        }),
                    );

                    tracing::info!(
                        "Preview render completed for sequence {}: {} ({} bytes, {:.1}s encoding)",
                        sequence_id,
                        preview_path,
                        export_result.file_size,
                        export_result.encoding_time_sec
                    );

                    Ok(serde_json::json!({
                        "sequenceId": sequence_id,
                        "previewPath": preview_path,
                        "durationSec": export_result.duration_sec,
                        "fileSizeBytes": export_result.file_size,
                        "encodingTimeSec": export_result.encoding_time_sec,
                    }))
                }
                Err(e) => {
                    let error_msg = format!("Preview render failed: {}", e);

                    // Emit failure event
                    let _ = self.app_handle.emit(
                        "preview:failed",
                        serde_json::json!({
                            "jobId": job.id,
                            "sequenceId": sequence_id,
                            "error": error_msg,
                        }),
                    );

                    tracing::error!("Preview render failed for sequence {}: {}", sequence_id, e);
                    Err(error_msg)
                }
            }
        }
    }

    /// Process final render job.
    ///
    /// Executes the final export pipeline for a sequence.
    ///
    /// # Payload
    ///
    /// * `sequenceId` (required) - ID of the sequence to render
    /// * `outputPath` (required) - Destination path
    /// * `preset` (optional) - Export preset name (default: "youtube_1080p")
    ///
    /// # Events
    ///
    /// * `render:progress` - Emitted with detailed progress
    /// * `render:complete` - Emitted on success
    /// * `render:failed` - Emitted on failure
    async fn process_final_render(&self, job: &Job) -> Result<serde_json::Value, String> {
        #[cfg(not(test))]
        use crate::core::{
            fs::{default_export_allowed_roots, validate_scoped_output_path},
            render::{validate_export_settings, ExportEngine, ExportPreset, ExportSettings},
        };

        // Validate required payload fields
        let sequence_id = job
            .payload
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .ok_or("Missing sequenceId in payload")?;

        validate_path_id_component(sequence_id, "sequenceId")?;

        let output_path_str = job
            .payload
            .get("outputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing outputPath in payload")?;

        let preset_name = job
            .payload
            .get("preset")
            .and_then(|v| v.as_str())
            .unwrap_or("youtube_1080p");

        tracing::info!(
            "Starting final render for sequence {} to {} (preset: {})",
            sequence_id,
            output_path_str,
            preset_name
        );

        #[cfg(test)]
        {
            Err("Final render requires AppState and is disabled in unit tests".to_string())
        }

        #[cfg(not(test))]
        {
            // 1. Get project state and validate inputs
            let (sequence, assets, effects, project_path) = {
                let app_state = self.app_handle.state::<crate::AppState>();
                let guard = app_state.project.lock().await;
                let project = guard.as_ref().ok_or("No project open")?;

                let sequence = project
                    .state
                    .sequences
                    .get(sequence_id)
                    .ok_or_else(|| format!("Sequence not found: {}", sequence_id))?
                    .clone();

                // Clone needed data to release lock quickly
                (
                    sequence,
                    project.state.assets.clone(),
                    project.state.effects.clone(),
                    project.path.clone(),
                )
            };

            // 2. Validate output path security
            // Use same logic as IPC command: restrict to user dirs + project dir
            let roots = default_export_allowed_roots(&project_path);
            let root_refs: Vec<&std::path::Path> = roots.iter().map(|p| p.as_path()).collect();

            let validated_output_path =
                validate_scoped_output_path(output_path_str, "outputPath", &root_refs)?;

            // 3. Configure Export Settings
            let export_preset = match preset_name.to_lowercase().as_str() {
                "youtube_1080p" | "youtube1080p" => ExportPreset::Youtube1080p,
                "youtube_4k" | "youtube4k" => ExportPreset::Youtube4k,
                "youtube_shorts" | "youtubeshorts" => ExportPreset::YoutubeShorts,
                "twitter" => ExportPreset::Twitter,
                "instagram" => ExportPreset::Instagram,
                "webm" | "webm_vp9" => ExportPreset::WebmVp9,
                "prores" => ExportPreset::ProRes,
                _ => ExportPreset::Youtube1080p,
            };

            let settings =
                ExportSettings::from_preset(export_preset, validated_output_path.clone());

            // 4. Validate export feasibility
            let validation = validate_export_settings(&sequence, &assets, &settings);
            if !validation.is_valid {
                let error_msg = validation.errors.join("; ");
                let _ = self.app_handle.emit(
                    "render:failed",
                    serde_json::json!({
                        "jobId": job.id,
                        "sequenceId": sequence_id,
                        "error": error_msg,
                    }),
                );
                return Err(format!("Export validation failed: {}", error_msg));
            }

            // 5. Setup Engine and Progress
            let state = self.ffmpeg_state.read().await;
            let runner = state.runner().ok_or("FFmpeg not available")?;
            let export_engine = ExportEngine::new(runner.clone());

            let (progress_tx, mut progress_rx) =
                tokio::sync::mpsc::channel::<crate::core::render::ExportProgress>(32);

            let app_handle = self.app_handle.clone();
            let job_id = job.id.clone();
            let seq_id = sequence_id.to_string();

            // Spawn progress forwarder
            let progress_task = tokio::spawn(async move {
                while let Some(progress) = progress_rx.recv().await {
                    let _ = app_handle.emit(
                        "render:progress",
                        serde_json::json!({
                            "jobId": job_id,
                            "sequenceId": seq_id,
                            "frame": progress.frame,
                            "totalFrames": progress.total_frames,
                            "percent": progress.percent,
                            "fps": progress.fps,
                            "etaSeconds": progress.eta_seconds,
                            "message": progress.message,
                        }),
                    );
                }
            });

            // 6. Execute Export
            let result = export_engine
                .export_sequence_with_effects(
                    &sequence,
                    &assets,
                    &effects,
                    &settings,
                    Some(progress_tx),
                )
                .await;

            let _ = progress_task.await;

            match result {
                Ok(export_result) => {
                    let output_str = export_result.output_path.to_string_lossy().to_string();

                    let _ = self.app_handle.emit(
                        "render:complete",
                        serde_json::json!({
                            "jobId": job.id,
                            "sequenceId": sequence_id,
                            "outputPath": output_str,
                            "durationSec": export_result.duration_sec,
                            "fileSizeBytes": export_result.file_size,
                            "encodingTimeSec": export_result.encoding_time_sec,
                        }),
                    );

                    tracing::info!(
                        "Final render success: {} ({:.1}s)",
                        output_str,
                        export_result.encoding_time_sec
                    );

                    Ok(serde_json::json!({
                        "outputPath": output_str,
                        "durationSec": export_result.duration_sec,
                        "fileSizeBytes": export_result.file_size,
                        "encodingTimeSec": export_result.encoding_time_sec,
                    }))
                }
                Err(e) => {
                    let error_msg = format!("Export failed: {}", e);
                    let _ = self.app_handle.emit(
                        "render:failed",
                        serde_json::json!({
                            "jobId": job.id,
                            "sequenceId": sequence_id,
                            "error": error_msg,
                        }),
                    );
                    tracing::error!("Final render failed: {}", error_msg);
                    Err(error_msg)
                }
            }
        }
    }

    /// Process AI completion job
    ///
    /// Connects to the AI Gateway to generate an EditScript from a user prompt.
    /// Emits events:
    /// - `ai:generating` when starting
    /// - `ai:completed` on success with the generated edit script
    /// - `ai:failed` on failure with error message
    async fn process_ai_completion(&self, job: &Job) -> Result<serde_json::Value, String> {
        #[cfg(not(test))]
        use crate::core::ai::EditContext;

        let prompt = job
            .payload
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or("Missing prompt in payload")?;

        // Emit generating event
        let _ = self.app_handle.emit(
            "ai:generating",
            serde_json::json!({
                "jobId": job.id,
                "prompt": prompt,
            }),
        );

        #[cfg(test)]
        {
            Err("AI completion jobs require AppState and are disabled in unit tests".to_string())
        }

        #[cfg(not(test))]
        {
            // Get the AppState to access AI Gateway
            let app_state = self.app_handle.state::<crate::AppState>();
            let gateway = app_state.ai_gateway.lock().await;

            // Check if AI provider is configured
            if !gateway.is_configured().await {
                let error = "No AI provider configured. Configure an AI provider in Settings.";
                let _ = self.app_handle.emit(
                    "ai:failed",
                    serde_json::json!({
                        "jobId": job.id,
                        "error": error,
                    }),
                );
                return Err(error.to_string());
            }

            // Check if provider is available
            if !gateway.has_provider().await {
                let error = "AI provider not reachable. Use 'Test connection' in Settings to verify connectivity.";
                let _ = self.app_handle.emit(
                    "ai:failed",
                    serde_json::json!({
                        "jobId": job.id,
                        "error": error,
                    }),
                );
                return Err(error.to_string());
            }

            // Build EditContext from job payload
            let timeline_duration = job
                .payload
                .get("timelineDuration")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            let asset_ids: Vec<String> = job
                .payload
                .get("assetIds")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let track_ids: Vec<String> = job
                .payload
                .get("trackIds")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let selected_clips: Vec<String> = job
                .payload
                .get("selectedClips")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();

            let playhead_position = job
                .payload
                .get("playheadPosition")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);

            let transcript_context = job
                .payload
                .get("transcriptContext")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let mut edit_context = EditContext::new()
                .with_duration(timeline_duration)
                .with_assets(asset_ids)
                .with_tracks(track_ids)
                .with_selection(selected_clips)
                .with_playhead(playhead_position);

            if let Some(ref transcript) = transcript_context {
                edit_context = edit_context.with_transcript(transcript);
            }

            tracing::info!(
                "Processing AI completion job {} with prompt: {}",
                job.id,
                prompt
            );

            // Generate edit script using the AI gateway
            match gateway.generate_edit_script(prompt, &edit_context).await {
                Ok(edit_script) => {
                    // Convert EditScript to JSON using derived Serialize
                    let script_json = serde_json::to_value(&edit_script)
                        .map_err(|e| format!("Failed to serialize EditScript: {}", e))?;

                    // Emit completion event
                    let _ = self.app_handle.emit(
                        "ai:completed",
                        serde_json::json!({
                            "jobId": job.id,
                            "editScript": script_json,
                        }),
                    );

                    tracing::info!(
                        "AI completion job {} succeeded with {} commands",
                        job.id,
                        edit_script.commands.len()
                    );

                    Ok(serde_json::json!({
                        "prompt": prompt,
                        "editScript": script_json,
                        "commandCount": edit_script.commands.len(),
                    }))
                }
                Err(e) => {
                    let error_msg = format!("AI generation failed: {}", e);

                    // Emit failure event
                    let _ = self.app_handle.emit(
                        "ai:failed",
                        serde_json::json!({
                            "jobId": job.id,
                            "error": error_msg,
                        }),
                    );

                    tracing::error!("AI completion job {} failed: {}", job.id, error_msg);
                    Err(error_msg)
                }
            }
        }
    }
}

// =============================================================================
// Worker Runner
// =============================================================================

/// Starts the worker pool with actual job processing using Arc references.
///
/// This variant accepts the Arc references directly, useful when you need to
/// clone them before spawning async tasks (e.g., in Tauri setup).
///
/// # Arguments
/// * `queue` - Arc to the job queue
/// * `active_jobs` - Arc to active jobs map
/// * `num_workers` - Number of worker tasks to spawn
/// * `ffmpeg_state` - Shared FFmpeg state for video operations
/// * `app_handle` - Tauri app handle for emitting events
/// * `cache_dir` - Directory for cached files (thumbnails, proxies, etc.)
/// * `shutdown` - Notify signal to stop workers gracefully
#[allow(dead_code)]
pub(crate) fn start_workers_with_arcs(
    queue: Arc<Mutex<BinaryHeap<QueueEntry>>>,
    active_jobs: Arc<Mutex<std::collections::HashMap<JobId, Job>>>,
    num_workers: usize,
    ffmpeg_state: SharedFFmpegState,
    app_handle: tauri::AppHandle,
    cache_dir: PathBuf,
    shutdown: Arc<Notify>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let mut handles = Vec::with_capacity(num_workers);

    for worker_id in 0..num_workers {
        let queue_clone = Arc::clone(&queue);
        let active_clone = Arc::clone(&active_jobs);
        let ffmpeg_clone = Arc::clone(&ffmpeg_state);
        let app_clone = app_handle.clone();
        let cache_clone = cache_dir.clone();
        let shutdown_clone = Arc::clone(&shutdown);

        let handle = tokio::spawn(async move {
            let processor = JobProcessor::new(ffmpeg_clone, app_clone.clone(), cache_clone);

            tracing::info!("Worker {} started", worker_id);

            loop {
                // Check for shutdown
                tokio::select! {
                    _ = shutdown_clone.notified() => {
                        tracing::info!("Worker {} shutting down", worker_id);
                        break;
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                        // Try to get a job from the queue
                        let job_opt = {
                            let mut queue_guard = acquire_lock(&queue_clone);
                            queue_guard.pop().map(|entry| entry.job)
                        };

                        if let Some(mut job) = job_opt {
                            // Update status to running
                            job.status = JobStatus::Running {
                                progress: 0.0,
                                message: Some("Starting...".to_string()),
                            };

                            // Move to active jobs
                            {
                                let mut active_guard = acquire_lock(&active_clone);
                                active_guard.insert(job.id.clone(), job.clone());
                            }

                            // Emit started event
                            let _ = app_clone.emit("job:started", serde_json::json!({
                                "jobId": &job.id,
                                "jobType": job_type_wire_value(&job.job_type),
                            }));

                            tracing::info!(
                                "Worker {} processing job {}: {:?}",
                                worker_id,
                                job.id,
                                job.job_type
                            );

                            // Process the job
                            let result = processor.process(&mut job).await;

                            let completed_at = chrono::Utc::now().to_rfc3339();
                            let was_cancelled = {
                                let active_guard = acquire_lock(&active_clone);
                                active_guard
                                    .get(&job.id)
                                    .is_some_and(|active| matches!(active.status, JobStatus::Cancelled))
                            };

                            // Update job status based on result (but do not override cancellation).
                            if was_cancelled {
                                job.status = JobStatus::Cancelled;
                                job.completed_at = Some(completed_at);
                                tracing::info!("Job {} was cancelled during processing", job.id);
                            } else {
                                match result {
                                    Ok(result_value) => {
                                        job.status = JobStatus::Completed {
                                            result: result_value.clone(),
                                        };
                                        job.completed_at = Some(completed_at);

                                        processor.emit_completed(&job.id, &result_value);

                                        tracing::info!("Job {} completed successfully", job.id);
                                    }
                                    Err(error) => {
                                        job.status = JobStatus::Failed { error: error.clone() };
                                        job.completed_at = Some(completed_at);

                                        processor.emit_failed(&job.id, &error);

                                        tracing::error!("Job {} failed: {}", job.id, error);
                                    }
                                }
                            }

                            // Update job in active jobs
                            {
                                let mut active_guard = acquire_lock(&active_clone);
                                active_guard.insert(job.id.clone(), job);
                            }
                        }
                    }
                }
            }
        });

        handles.push(handle);
    }

    handles
}

/// Starts the worker pool with actual job processing.
///
/// This function spawns `num_workers` async tasks that consume jobs from the
/// worker pool's queue and process them using the provided processor.
///
/// # Arguments
/// * `pool` - The worker pool containing the job queue
/// * `ffmpeg_state` - Shared FFmpeg state for video operations
/// * `app_handle` - Tauri app handle for emitting events
/// * `cache_dir` - Directory for cached files (thumbnails, proxies, etc.)
/// * `shutdown` - Notify signal to stop workers gracefully
pub fn start_workers(
    pool: &WorkerPool,
    ffmpeg_state: SharedFFmpegState,
    app_handle: tauri::AppHandle,
    cache_dir: PathBuf,
    shutdown: Arc<Notify>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let num_workers = pool.num_workers();

    // Clone the Arc references to queue and active_jobs for workers
    let queue = Arc::clone(&pool.queue);
    let active_jobs = Arc::clone(&pool.active_jobs);

    let mut handles = Vec::with_capacity(num_workers);

    for worker_id in 0..num_workers {
        let queue_clone = Arc::clone(&queue);
        let active_clone = Arc::clone(&active_jobs);
        let ffmpeg_clone = Arc::clone(&ffmpeg_state);
        let app_clone = app_handle.clone();
        let cache_clone = cache_dir.clone();
        let shutdown_clone = Arc::clone(&shutdown);

        let handle = tokio::spawn(async move {
            let processor = JobProcessor::new(ffmpeg_clone, app_clone.clone(), cache_clone);

            tracing::info!("Worker {} started", worker_id);

            loop {
                // Check for shutdown
                tokio::select! {
                    _ = shutdown_clone.notified() => {
                        tracing::info!("Worker {} shutting down", worker_id);
                        break;
                    }
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                        // Try to get a job from the queue
                        let job_opt = {
                            let mut queue_guard = acquire_lock(&queue_clone);
                            queue_guard.pop().map(|entry| entry.job)
                        };

                        if let Some(mut job) = job_opt {
                            // Update status to running
                            job.status = JobStatus::Running {
                                progress: 0.0,
                                message: Some("Starting...".to_string()),
                            };

                            // Move to active jobs
                            {
                                let mut active_guard = acquire_lock(&active_clone);
                                active_guard.insert(job.id.clone(), job.clone());
                            }

                            // Emit started event
                            let _ = app_clone.emit("job:started", serde_json::json!({
                                "jobId": &job.id,
                                "jobType": job_type_wire_value(&job.job_type),
                            }));

                            tracing::info!(
                                "Worker {} processing job {}: {:?}",
                                worker_id,
                                job.id,
                                job.job_type
                            );

                            // Process the job
                            let result = processor.process(&mut job).await;

                            let completed_at = chrono::Utc::now().to_rfc3339();
                            let was_cancelled = {
                                let active_guard = acquire_lock(&active_clone);
                                active_guard
                                    .get(&job.id)
                                    .is_some_and(|active| matches!(active.status, JobStatus::Cancelled))
                            };

                            // Update job status based on result (but do not override cancellation).
                            if was_cancelled {
                                job.status = JobStatus::Cancelled;
                                job.completed_at = Some(completed_at);
                                tracing::info!("Job {} was cancelled during processing", job.id);
                            } else {
                                match result {
                                    Ok(result_value) => {
                                        job.status = JobStatus::Completed {
                                            result: result_value.clone(),
                                        };
                                        job.completed_at = Some(completed_at);

                                        processor.emit_completed(&job.id, &result_value);

                                        tracing::info!("Job {} completed successfully", job.id);
                                    }
                                    Err(error) => {
                                        job.status = JobStatus::Failed { error: error.clone() };
                                        job.completed_at = Some(completed_at);

                                        processor.emit_failed(&job.id, &error);

                                        tracing::error!("Job {} failed: {}", job.id, error);
                                    }
                                }
                            }

                            // Update job in active jobs
                            {
                                let mut active_guard = acquire_lock(&active_clone);
                                active_guard.insert(job.id.clone(), job);
                            }
                        }
                    }
                }
            }
        });

        handles.push(handle);
    }

    handles
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
        let queue = acquire_lock(&pool.queue);
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

    // -------------------------------------------------------------------------
    // PreviewRender Job Tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_preview_render_job_creation() {
        let job = Job::new(
            JobType::PreviewRender,
            serde_json::json!({
                "sequenceId": "seq_001",
                "startTime": 0.0,
                "endTime": 10.0,
            }),
        );

        assert_eq!(job.job_type, JobType::PreviewRender);
        assert!(job.payload.get("sequenceId").is_some());
        assert_eq!(
            job.payload.get("sequenceId").unwrap().as_str().unwrap(),
            "seq_001"
        );
    }

    #[test]
    fn test_preview_render_job_with_priority() {
        let job = Job::new(
            JobType::PreviewRender,
            serde_json::json!({ "sequenceId": "seq_001" }),
        )
        .with_priority(Priority::Preview);

        assert_eq!(job.priority, Priority::Preview);
    }

    #[test]
    fn test_preview_render_job_payload_parsing() {
        // Test with full payload
        let full_payload = serde_json::json!({
            "sequenceId": "seq_001",
            "startTime": 5.0,
            "endTime": 15.0,
        });

        let job = Job::new(JobType::PreviewRender, full_payload.clone());

        let sequence_id = job.payload.get("sequenceId").and_then(|v| v.as_str());
        let start_time = job.payload.get("startTime").and_then(|v| v.as_f64());
        let end_time = job.payload.get("endTime").and_then(|v| v.as_f64());

        assert_eq!(sequence_id, Some("seq_001"));
        assert_eq!(start_time, Some(5.0));
        assert_eq!(end_time, Some(15.0));
    }

    #[test]
    fn test_preview_render_job_payload_optional_fields() {
        // Test with minimal payload (only required fields)
        let minimal_payload = serde_json::json!({
            "sequenceId": "seq_002",
        });

        let job = Job::new(JobType::PreviewRender, minimal_payload);

        let sequence_id = job.payload.get("sequenceId").and_then(|v| v.as_str());
        let start_time = job.payload.get("startTime").and_then(|v| v.as_f64());
        let end_time = job.payload.get("endTime").and_then(|v| v.as_f64());

        assert_eq!(sequence_id, Some("seq_002"));
        assert_eq!(start_time, None); // Optional, not provided
        assert_eq!(end_time, None); // Optional, not provided
    }

    #[test]
    fn test_preview_render_job_submission() {
        let pool = WorkerPool::with_defaults();

        let job = Job::new(
            JobType::PreviewRender,
            serde_json::json!({ "sequenceId": "seq_001" }),
        )
        .with_priority(Priority::Preview);

        let job_id = pool.submit(job).unwrap();
        assert!(!job_id.is_empty());

        let found = pool.get_job(&job_id);
        assert!(found.is_some());
        assert_eq!(found.unwrap().job_type, JobType::PreviewRender);
    }
}

// =============================================================================
// Preview Render Settings Tests (in export.rs tests, but related)
// =============================================================================

#[cfg(test)]
mod preview_settings_tests {
    use crate::core::render::ExportSettings;
    use std::path::PathBuf;

    #[test]
    fn test_preview_settings_default_values() {
        let settings = ExportSettings::preview(PathBuf::from("/tmp/preview.mp4"), None, None);

        // Verify preview-optimized defaults
        assert_eq!(settings.width, Some(1280));
        assert_eq!(settings.height, Some(720));
        assert_eq!(settings.video_bitrate, Some("2M".to_string()));
        assert_eq!(settings.audio_bitrate, Some("128k".to_string()));
        assert_eq!(settings.crf, Some(28)); // Higher CRF for faster encoding
        assert!(!settings.two_pass); // Single pass for speed
    }

    #[test]
    fn test_preview_settings_with_time_range() {
        let settings =
            ExportSettings::preview(PathBuf::from("/tmp/preview.mp4"), Some(5.0), Some(15.0));

        assert_eq!(settings.start_time, Some(5.0));
        assert_eq!(settings.end_time, Some(15.0));
    }

    #[test]
    fn test_preview_settings_without_time_range() {
        let settings = ExportSettings::preview(PathBuf::from("/tmp/preview.mp4"), None, None);

        assert_eq!(settings.start_time, None);
        assert_eq!(settings.end_time, None);
    }

    #[test]
    fn test_preview_settings_output_path() {
        let output_path = PathBuf::from("/cache/previews/seq_001_preview.mp4");
        let settings = ExportSettings::preview(output_path.clone(), None, None);

        assert_eq!(settings.output_path, output_path);
    }
}
