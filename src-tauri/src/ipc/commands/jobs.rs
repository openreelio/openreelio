//! Job queue and performance/memory commands
//!
//! Tauri IPC commands for managing background jobs, memory stats,
//! and performance monitoring.

use specta::Type;
use tauri::State;

use crate::core::{
    jobs::{Job, JobStatus, JobType, Priority, ValidatedJobPayload},
    performance::memory::{CacheStats, PoolStats},
};
use crate::AppState;

// =============================================================================
// Job DTOs
// =============================================================================

/// Background job information.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JobInfoDto {
    /// Unique job ID
    pub id: String,
    /// Job type (e.g., "proxy_generation", "transcription")
    pub job_type: String,
    /// Priority level ("background", "normal", "preview", "user_request")
    pub priority: String,
    /// Current job status
    pub status: JobStatusDto,
    /// ISO 8601 creation timestamp
    pub created_at: String,
    /// ISO 8601 completion timestamp (if completed)
    pub completed_at: Option<String>,
}

/// Job execution status.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobStatusDto {
    /// Job is waiting in queue
    Queued,
    /// Job is currently executing
    Running {
        /// Progress percentage (0.0 - 1.0)
        progress: f32,
        /// Optional status message
        message: Option<String>,
    },
    /// Job completed successfully
    Completed {
        /// Result data
        result: serde_json::Value,
    },
    /// Job failed with error
    Failed {
        /// Error message
        error: String,
    },
    /// Job was cancelled by user
    Cancelled,
}

impl From<&Job> for JobInfoDto {
    fn from(job: &Job) -> Self {
        let job_type = match job.job_type {
            JobType::ProxyGeneration => "proxy_generation",
            JobType::ThumbnailGeneration => "thumbnail_generation",
            JobType::WaveformGeneration => "waveform_generation",
            JobType::Indexing => "indexing",
            JobType::Transcription => "transcription",
            JobType::PreviewRender => "preview_render",
            JobType::FinalRender => "final_render",
            JobType::AICompletion => "ai_completion",
            JobType::AudioProfiling => "audio_profiling",
            JobType::ContentSegmentation => "content_segmentation",
            JobType::VisualAnalysis => "visual_analysis",
            JobType::VideoAnalysis => "video_analysis",
        };

        let priority = match job.priority {
            Priority::Background => "background",
            Priority::Normal => "normal",
            Priority::Preview => "preview",
            Priority::UserRequest => "user_request",
        };

        let status = match &job.status {
            JobStatus::Queued => JobStatusDto::Queued,
            JobStatus::Running { progress, message } => JobStatusDto::Running {
                progress: *progress,
                message: message.clone(),
            },
            JobStatus::Completed { result } => JobStatusDto::Completed {
                result: result.clone(),
            },
            JobStatus::Failed { error } => JobStatusDto::Failed {
                error: error.clone(),
            },
            JobStatus::Cancelled => JobStatusDto::Cancelled,
        };

        Self {
            id: job.id.clone(),
            job_type: job_type.to_string(),
            priority: priority.to_string(),
            status,
            created_at: job.created_at.clone(),
            completed_at: job.completed_at.clone(),
        }
    }
}

// =============================================================================
// Memory DTOs
// =============================================================================

/// Memory usage statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatsDto {
    /// Memory pool statistics
    pub pool_stats: PoolStatsDto,
    /// Cache statistics
    pub cache_stats: CacheStatsDto,
    /// Total allocated bytes (Rust side)
    pub allocated_bytes: u64,
    /// System memory info (if available)
    pub system_memory: Option<SystemMemoryDto>,
}

/// Memory pool statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatsDto {
    /// Total number of memory blocks in pool
    pub total_blocks: usize,
    /// Number of currently allocated blocks
    pub allocated_blocks: usize,
    /// Total pool size in bytes
    pub total_size_bytes: u64,
    /// Currently used size in bytes
    pub used_size_bytes: u64,
    /// Total allocation requests
    pub allocation_count: u64,
    /// Total release operations
    pub release_count: u64,
    /// Allocations served from pool
    pub pool_hits: u64,
    /// Allocations that required new allocation
    pub pool_misses: u64,
    /// Hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

impl From<PoolStats> for PoolStatsDto {
    fn from(stats: PoolStats) -> Self {
        let total = stats.pool_hits + stats.pool_misses;
        let hit_rate = if total > 0 {
            stats.pool_hits as f64 / total as f64
        } else {
            0.0
        };

        Self {
            total_blocks: stats.total_blocks,
            allocated_blocks: stats.allocated_blocks,
            total_size_bytes: stats.total_size_bytes,
            used_size_bytes: stats.used_size_bytes,
            allocation_count: stats.allocation_count,
            release_count: stats.release_count,
            pool_hits: stats.pool_hits,
            pool_misses: stats.pool_misses,
            hit_rate,
        }
    }
}

/// Cache usage statistics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CacheStatsDto {
    /// Number of entries in cache
    pub entry_count: usize,
    /// Total cache size in bytes
    pub total_size_bytes: u64,
    /// Cache hit count
    pub hits: u64,
    /// Cache miss count
    pub misses: u64,
    /// Number of evicted entries
    pub evictions: u64,
    /// Cache hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

impl From<CacheStats> for CacheStatsDto {
    fn from(stats: CacheStats) -> Self {
        Self {
            entry_count: stats.entry_count,
            total_size_bytes: stats.total_size_bytes,
            hits: stats.hits,
            misses: stats.misses,
            evictions: stats.evictions,
            hit_rate: stats.hit_rate,
        }
    }
}

/// System memory information.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemoryDto {
    /// Total physical memory in bytes
    pub total_bytes: u64,
    /// Available memory in bytes
    pub available_bytes: u64,
    /// Used memory in bytes
    pub used_bytes: u64,
    /// Usage percentage (0-100)
    pub usage_percent: f64,
}

/// Result of memory cleanup operation.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCleanupResult {
    /// Bytes freed from pool shrink
    pub pool_bytes_freed: u64,
    /// Cache entries evicted
    pub cache_entries_evicted: usize,
    /// Total bytes freed
    pub total_bytes_freed: u64,
}

// =============================================================================
// Helper Functions
// =============================================================================

fn parse_job_type(job_type: &str) -> Result<JobType, String> {
    match job_type {
        // snake_case (legacy)
        "proxy_generation" => Ok(JobType::ProxyGeneration),
        "thumbnail_generation" => Ok(JobType::ThumbnailGeneration),
        "waveform_generation" => Ok(JobType::WaveformGeneration),
        "indexing" => Ok(JobType::Indexing),
        "transcription" => Ok(JobType::Transcription),
        "preview_render" => Ok(JobType::PreviewRender),
        "final_render" => Ok(JobType::FinalRender),
        "ai_completion" => Ok(JobType::AICompletion),

        // camelCase (serde-friendly)
        "proxyGeneration" => Ok(JobType::ProxyGeneration),
        "thumbnailGeneration" => Ok(JobType::ThumbnailGeneration),
        "waveformGeneration" => Ok(JobType::WaveformGeneration),
        "previewRender" => Ok(JobType::PreviewRender),
        "finalRender" => Ok(JobType::FinalRender),
        "aiCompletion" => Ok(JobType::AICompletion),

        other => Err(format!("Unknown job type: {other}")),
    }
}

fn parse_priority(priority: Option<&str>) -> Result<Priority, String> {
    match priority {
        Some("background") => Ok(Priority::Background),
        Some("normal") | None => Ok(Priority::Normal),
        Some("preview") => Ok(Priority::Preview),
        Some("user_request") => Ok(Priority::UserRequest),

        // camelCase alias
        Some("userRequest") => Ok(Priority::UserRequest),

        Some(other) => Err(format!("Unknown priority: {other}")),
    }
}

/// Gets system memory information
///
/// Returns None since sysinfo is not currently enabled.
/// To enable system memory info, add sysinfo as a dependency and feature.
fn get_system_memory_info() -> Option<SystemMemoryDto> {
    // sysinfo crate is not currently enabled as a dependency
    // Return None to indicate system memory info is unavailable
    None
}

// =============================================================================
// Job Commands
// =============================================================================

/// Gets all jobs from the worker pool (both active and queued)
#[tauri::command]
#[specta::specta]
pub async fn get_jobs(state: State<'_, AppState>) -> Result<Vec<JobInfoDto>, String> {
    let pool = state.job_pool.lock().await;

    // Get all jobs (active + queued)
    let all_jobs: Vec<JobInfoDto> = pool.all_jobs().iter().map(JobInfoDto::from).collect();

    tracing::debug!(
        "get_jobs: {} total ({} active, {} queued)",
        all_jobs.len(),
        pool.active_jobs().len(),
        pool.queue_len()
    );

    Ok(all_jobs)
}

/// Submits a new job to the worker pool
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state, payload), fields(job_type = %job_type))]
pub async fn submit_job(
    job_type: String,
    priority: Option<String>,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let job_type_enum = parse_job_type(&job_type)?;
    let priority_enum = parse_priority(priority.as_deref())?;

    // Strict payload validation (IPC is a trust boundary)
    let validated_payload = ValidatedJobPayload::parse(&job_type_enum, payload)?;
    let job = Job::new(job_type_enum, validated_payload.into_value()).with_priority(priority_enum);

    let pool = state.job_pool.lock().await;

    let job_id = pool.submit(job).map_err(|e| e.to_string())?;

    tracing::info!("Submitted job: {} (type: {})", job_id, job_type);

    Ok(job_id)
}

/// Gets a specific job by ID
#[tauri::command]
#[specta::specta]
pub async fn get_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Option<JobInfoDto>, String> {
    let pool = state.job_pool.lock().await;

    Ok(pool.get_job(&job_id).as_ref().map(JobInfoDto::from))
}

/// Cancels a job by ID
#[tauri::command]
#[specta::specta]
pub async fn cancel_job(job_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    let pool = state.job_pool.lock().await;

    let cancelled = pool.cancel(&job_id);

    if cancelled {
        tracing::info!("Cancelled job: {}", job_id);
    } else {
        tracing::debug!("Job not found or already completed: {}", job_id);
    }

    Ok(cancelled)
}

/// Gets the current queue statistics
#[tauri::command]
#[specta::specta]
pub async fn get_job_stats(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let pool = state.job_pool.lock().await;

    let active_jobs = pool.active_jobs();
    let running_count = active_jobs.iter().filter(|j| j.is_running()).count();
    let pending_count = pool.queue_len();

    Ok(serde_json::json!({
        "queueLength": pending_count,
        "activeCount": active_jobs.len(),
        "runningCount": running_count,
        "numWorkers": pool.num_workers(),
    }))
}

// =============================================================================
// Memory Commands
// =============================================================================

/// Gets memory statistics from the backend
#[tauri::command]
#[specta::specta]
pub async fn get_memory_stats(state: State<'_, AppState>) -> Result<MemoryStatsDto, String> {
    let memory_state = state.memory_pool.lock().await;
    let cache_state = state.cache_manager.lock().await;

    let pool_stats = memory_state.get_stats().await;
    let cache_stats = cache_state.get_stats().await;
    let allocated_bytes = memory_state.allocated_bytes();

    // Get system memory info
    let system_memory = get_system_memory_info();

    Ok(MemoryStatsDto {
        pool_stats: PoolStatsDto::from(pool_stats),
        cache_stats: CacheStatsDto::from(cache_stats),
        allocated_bytes,
        system_memory,
    })
}

/// Triggers memory cleanup (shrink pools, evict expired cache)
#[tauri::command]
#[specta::specta]
pub async fn trigger_memory_cleanup(
    state: State<'_, AppState>,
) -> Result<MemoryCleanupResult, String> {
    let memory_state = state.memory_pool.lock().await;
    let cache_state = state.cache_manager.lock().await;

    // Shrink memory pool (free unused blocks)
    let pool_bytes_freed = memory_state.shrink().await as u64;

    // Get cache stats before eviction
    let cache_before = cache_state.get_stats().await;

    // Evict expired cache entries based on TTL
    let cache_entries_evicted = cache_state.evict_expired().await;

    // Calculate bytes freed from cache
    let cache_after = cache_state.get_stats().await;
    let cache_bytes_freed = cache_before
        .total_size_bytes
        .saturating_sub(cache_after.total_size_bytes);

    let total_bytes_freed = pool_bytes_freed + cache_bytes_freed;

    tracing::info!(
        "Memory cleanup: pool freed {} bytes, cache evicted {} entries ({} bytes)",
        pool_bytes_freed,
        cache_entries_evicted,
        cache_bytes_freed
    );

    Ok(MemoryCleanupResult {
        pool_bytes_freed,
        cache_entries_evicted,
        total_bytes_freed,
    })
}
