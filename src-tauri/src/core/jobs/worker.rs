//! Worker Pool Module
//!
//! Manages background workers for job execution.
//! Workers consume jobs from a channel and process them asynchronously,
//! emitting events via Tauri for progress updates.

use std::collections::BinaryHeap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Notify};

use crate::core::{
    ffmpeg::{FFmpegProgress, SharedFFmpegState},
    jobs::{Job, JobStatus, JobType},
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
pub(crate) struct QueueEntry {
    pub(crate) job: Job,
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
    /// Job queue (pub(crate) for worker access)
    pub(crate) queue: Arc<Mutex<BinaryHeap<QueueEntry>>>,
    /// Active jobs (pub(crate) for worker access)
    pub(crate) active_jobs: Arc<Mutex<std::collections::HashMap<JobId, Job>>>,
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

    fn validate_path_id_component(&self, id: &str, label: &str) -> Result<(), String> {
        if id.is_empty() {
            return Err(format!("{label} is empty"));
        }
        if id.contains("..") || id.contains('/') || id.contains('\\') || id.contains(':') {
            return Err(format!("Invalid {label}: contains path traversal characters"));
        }
        Ok(())
    }

    async fn validate_input_file_path(&self, path: &str, label: &str) -> Result<PathBuf, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(format!("{label} is empty"));
        }

        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Err(format!("{label} must be a local file path"));
        }

        let pb = PathBuf::from(trimmed);
        if !pb.is_absolute() {
            return Err(format!("{label} must be an absolute path: {}", pb.display()));
        }

        // Use async metadata to avoid blocking the async runtime
        let meta = tokio::fs::metadata(&pb)
            .await
            .map_err(|_| format!("{label} file not found: {}", pb.display()))?;
        if !meta.is_file() {
            return Err(format!("{label} is not a file: {}", pb.display()));
        }

        Ok(pb)
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

        self.validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = self.validate_input_file_path(input_path, "inputPath").await?;

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

        self.validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = self.validate_input_file_path(input_path, "inputPath").await?;

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

        self.validate_path_id_component(asset_id, "assetId")?;

        let input_path = job
            .payload
            .get("inputPath")
            .and_then(|v| v.as_str())
            .ok_or("Missing inputPath in payload")?;

        let input_path = self.validate_input_file_path(input_path, "inputPath").await?;

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

        self.validate_path_id_component(asset_id, "assetId")?;

        // Options may arrive either flattened or nested under `options`.
        let options = job.payload.get("options");

        let input_path = if let Some(path) = job.payload.get("inputPath").and_then(|v| v.as_str()) {
            self.validate_input_file_path(path, "inputPath").await?
                .to_string_lossy()
                .to_string()
        } else {
            // Fallback: resolve from currently open project
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

    /// Process preview render job (placeholder)
    async fn process_preview_render(&self, job: &Job) -> Result<serde_json::Value, String> {
        let sequence_id = job
            .payload
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .ok_or("Missing sequenceId in payload")?;

        // TODO: Implement preview rendering
        tracing::warn!(
            "Preview render not yet implemented for sequence {}",
            sequence_id
        );

        Err("Preview render not yet implemented".to_string())
    }

    /// Process final render job (placeholder - see start_render IPC)
    async fn process_final_render(&self, job: &Job) -> Result<serde_json::Value, String> {
        let sequence_id = job
            .payload
            .get("sequenceId")
            .and_then(|v| v.as_str())
            .ok_or("Missing sequenceId in payload")?;

        // Final render is handled by the start_render IPC command directly
        // This job type is for queuing renders in the background
        tracing::warn!(
            "Final render via job queue not yet implemented for sequence {}",
            sequence_id
        );

        Err("Use start_render IPC command for final render".to_string())
    }

    /// Process AI completion job (placeholder)
    async fn process_ai_completion(&self, job: &Job) -> Result<serde_json::Value, String> {
        let prompt = job
            .payload
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or("Missing prompt in payload")?;

        // TODO: Implement AI gateway integration (TASK-011)
        tracing::warn!("AI completion not yet implemented for prompt: {}", prompt);

        Err(
            "AI completion not yet implemented. AI gateway integration pending (TASK-011)"
                .to_string(),
        )
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
                            let mut queue_guard = queue_clone.lock().unwrap();
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
                                let mut active_guard = active_clone.lock().unwrap();
                                active_guard.insert(job.id.clone(), job.clone());
                            }

                            // Emit started event
                            let _ = app_clone.emit("job:started", serde_json::json!({
                                "jobId": &job.id,
                                "jobType": format!("{:?}", &job.job_type),
                            }));

                            tracing::info!(
                                "Worker {} processing job {}: {:?}",
                                worker_id,
                                job.id,
                                job.job_type
                            );

                            // Process the job
                            let result = processor.process(&mut job).await;

                            // Update job status based on result
                            match result {
                                Ok(result_value) => {
                                    job.status = JobStatus::Completed { result: result_value.clone() };
                                    job.completed_at = Some(chrono::Utc::now().to_rfc3339());

                                    processor.emit_completed(&job.id, &result_value);

                                    tracing::info!("Job {} completed successfully", job.id);
                                }
                                Err(error) => {
                                    job.status = JobStatus::Failed { error: error.clone() };
                                    job.completed_at = Some(chrono::Utc::now().to_rfc3339());

                                    processor.emit_failed(&job.id, &error);

                                    tracing::error!("Job {} failed: {}", job.id, error);
                                }
                            }

                            // Update job in active jobs
                            {
                                let mut active_guard = active_clone.lock().unwrap();
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
                            let mut queue_guard = queue_clone.lock().unwrap();
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
                                let mut active_guard = active_clone.lock().unwrap();
                                active_guard.insert(job.id.clone(), job.clone());
                            }

                            // Emit started event
                            let _ = app_clone.emit("job:started", serde_json::json!({
                                "jobId": &job.id,
                                "jobType": format!("{:?}", &job.job_type),
                            }));

                            tracing::info!(
                                "Worker {} processing job {}: {:?}",
                                worker_id,
                                job.id,
                                job.job_type
                            );

                            // Process the job
                            let result = processor.process(&mut job).await;

                            // Update job status based on result
                            match result {
                                Ok(result_value) => {
                                    job.status = JobStatus::Completed { result: result_value.clone() };
                                    job.completed_at = Some(chrono::Utc::now().to_rfc3339());

                                    processor.emit_completed(&job.id, &result_value);

                                    tracing::info!("Job {} completed successfully", job.id);
                                }
                                Err(error) => {
                                    job.status = JobStatus::Failed { error: error.clone() };
                                    job.completed_at = Some(chrono::Utc::now().to_rfc3339());

                                    processor.emit_failed(&job.id, &error);

                                    tracing::error!("Job {} failed: {}", job.id, error);
                                }
                            }

                            // Update job in active jobs
                            {
                                let mut active_guard = active_clone.lock().unwrap();
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
