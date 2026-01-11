//! Parallel Processing Module
//!
//! Provides multi-core utilization for parallel proxy generation, indexing, and rendering.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, Semaphore};

use crate::core::{CoreError, CoreResult};

/// Task priority levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskPriority {
    /// Lowest priority (background tasks)
    Low,
    /// Normal priority
    Normal,
    /// High priority (user-initiated)
    High,
    /// Critical priority (must complete ASAP)
    Critical,
}

impl TaskPriority {
    /// Numeric weight for scheduling
    pub fn weight(&self) -> u32 {
        match self {
            TaskPriority::Low => 1,
            TaskPriority::Normal => 2,
            TaskPriority::High => 4,
            TaskPriority::Critical => 8,
        }
    }
}

impl Default for TaskPriority {
    fn default() -> Self {
        TaskPriority::Normal
    }
}

/// Task status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Waiting to be executed
    Pending,
    /// Currently running
    Running,
    /// Completed successfully
    Completed,
    /// Failed with error
    Failed,
    /// Cancelled before completion
    Cancelled,
}

/// Task type for categorization
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    /// Proxy generation
    ProxyGeneration,
    /// Asset indexing
    Indexing,
    /// Video rendering
    Rendering,
    /// Audio processing
    AudioProcessing,
    /// AI inference
    AiInference,
    /// File I/O
    FileIO,
    /// General compute
    Compute,
}

/// Parallel task definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelTask {
    /// Unique task ID
    pub id: String,
    /// Task type
    pub task_type: TaskType,
    /// Priority level
    pub priority: TaskPriority,
    /// Current status
    pub status: TaskStatus,
    /// Progress (0.0 - 1.0)
    pub progress: f32,
    /// Error message if failed
    pub error: Option<String>,
    /// Creation timestamp
    pub created_at: i64,
    /// Start timestamp
    pub started_at: Option<i64>,
    /// Completion timestamp
    pub completed_at: Option<i64>,
    /// Additional metadata
    pub metadata: HashMap<String, String>,
}

impl ParallelTask {
    /// Creates a new task
    pub fn new(task_type: TaskType, priority: TaskPriority) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            task_type,
            priority,
            status: TaskStatus::Pending,
            progress: 0.0,
            error: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            started_at: None,
            completed_at: None,
            metadata: HashMap::new(),
        }
    }

    /// Sets metadata
    pub fn with_metadata(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.metadata.insert(key.into(), value.into());
        self
    }

    /// Marks task as running
    pub fn start(&mut self) {
        self.status = TaskStatus::Running;
        self.started_at = Some(chrono::Utc::now().timestamp_millis());
    }

    /// Updates progress
    pub fn set_progress(&mut self, progress: f32) {
        self.progress = progress.clamp(0.0, 1.0);
    }

    /// Marks task as completed
    pub fn complete(&mut self) {
        self.status = TaskStatus::Completed;
        self.progress = 1.0;
        self.completed_at = Some(chrono::Utc::now().timestamp_millis());
    }

    /// Marks task as failed
    pub fn fail(&mut self, error: impl Into<String>) {
        self.status = TaskStatus::Failed;
        self.error = Some(error.into());
        self.completed_at = Some(chrono::Utc::now().timestamp_millis());
    }

    /// Marks task as cancelled
    pub fn cancel(&mut self) {
        self.status = TaskStatus::Cancelled;
        self.completed_at = Some(chrono::Utc::now().timestamp_millis());
    }

    /// Elapsed time in milliseconds
    pub fn elapsed_ms(&self) -> Option<i64> {
        self.started_at.map(|start| {
            let end = self.completed_at.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            end - start
        })
    }
}

/// Configuration for parallel execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParallelConfig {
    /// Maximum concurrent tasks
    pub max_concurrent: usize,
    /// Per-type limits
    pub type_limits: HashMap<TaskType, usize>,
    /// Worker thread count (0 = auto)
    pub worker_count: usize,
    /// Task queue size
    pub queue_size: usize,
    /// Enable task stealing
    pub work_stealing: bool,
    /// Priority boost for starving tasks
    pub priority_boost: bool,
}

impl Default for ParallelConfig {
    fn default() -> Self {
        let cpu_count = num_cpus::get();
        Self {
            max_concurrent: cpu_count,
            type_limits: HashMap::new(),
            worker_count: 0, // Auto-detect
            queue_size: 1000,
            work_stealing: true,
            priority_boost: true,
        }
    }
}

impl ParallelConfig {
    /// Creates config for heavy workloads
    pub fn heavy_workload() -> Self {
        let cpu_count = num_cpus::get();
        let mut type_limits = HashMap::new();
        type_limits.insert(TaskType::Rendering, cpu_count / 2);
        type_limits.insert(TaskType::ProxyGeneration, cpu_count / 2);
        type_limits.insert(TaskType::AiInference, 2);

        Self {
            max_concurrent: cpu_count * 2,
            type_limits,
            queue_size: 5000,
            ..Default::default()
        }
    }

    /// Creates config for memory-constrained systems
    pub fn low_memory() -> Self {
        let cpu_count = num_cpus::get().max(2);
        Self {
            max_concurrent: cpu_count / 2,
            queue_size: 500,
            ..Default::default()
        }
    }
}

/// Worker pool statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PoolStats {
    /// Total tasks submitted
    pub total_submitted: u64,
    /// Tasks completed
    pub completed: u64,
    /// Tasks failed
    pub failed: u64,
    /// Tasks cancelled
    pub cancelled: u64,
    /// Currently running tasks
    pub running: usize,
    /// Tasks in queue
    pub queued: usize,
    /// Average task duration in ms
    pub avg_duration_ms: f64,
    /// Peak concurrent tasks
    pub peak_concurrent: usize,
}

/// Worker pool for managing parallel tasks
#[derive(Debug)]
pub struct WorkerPool {
    /// Configuration
    config: Arc<RwLock<ParallelConfig>>,
    /// Concurrency semaphore
    semaphore: Arc<Semaphore>,
    /// Type-specific semaphores
    type_semaphores: Arc<RwLock<HashMap<TaskType, Arc<Semaphore>>>>,
    /// Active tasks
    tasks: Arc<RwLock<HashMap<String, ParallelTask>>>,
    /// Statistics
    stats: Arc<RwLock<PoolStats>>,
    /// Running count (atomic for fast access)
    running_count: Arc<AtomicUsize>,
    /// Total duration accumulator
    total_duration_ms: Arc<AtomicU64>,
}

impl WorkerPool {
    /// Creates a new worker pool
    pub fn new() -> Self {
        let config = ParallelConfig::default();
        Self::with_config(config)
    }

    /// Creates with custom config
    pub fn with_config(config: ParallelConfig) -> Self {
        let semaphore = Arc::new(Semaphore::new(config.max_concurrent));

        let mut type_semaphores = HashMap::new();
        for (task_type, limit) in &config.type_limits {
            type_semaphores.insert(*task_type, Arc::new(Semaphore::new(*limit)));
        }

        Self {
            config: Arc::new(RwLock::new(config)),
            semaphore,
            type_semaphores: Arc::new(RwLock::new(type_semaphores)),
            tasks: Arc::new(RwLock::new(HashMap::new())),
            stats: Arc::new(RwLock::new(PoolStats::default())),
            running_count: Arc::new(AtomicUsize::new(0)),
            total_duration_ms: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Submits a task for execution
    pub async fn submit(&self, mut task: ParallelTask) -> CoreResult<String> {
        let task_id = task.id.clone();
        let task_type = task.task_type;

        // Check queue size
        {
            let config = self.config.read().await;
            let tasks = self.tasks.read().await;
            let pending_count = tasks.values().filter(|t| t.status == TaskStatus::Pending).count();
            if pending_count >= config.queue_size {
                return Err(CoreError::ResourceExhausted("Task queue is full".to_string()));
            }
        }

        // Add to tasks
        {
            let mut tasks = self.tasks.write().await;
            tasks.insert(task_id.clone(), task.clone());
        }

        // Update stats
        {
            let mut stats = self.stats.write().await;
            stats.total_submitted += 1;
            stats.queued += 1;
        }

        // Acquire permits and run
        let semaphore = self.semaphore.clone();
        let type_semaphores = self.type_semaphores.clone();
        let tasks = self.tasks.clone();
        let stats = self.stats.clone();
        let running_count = self.running_count.clone();
        let total_duration = self.total_duration_ms.clone();
        let task_id_clone = task_id.clone();

        tokio::spawn(async move {
            // Acquire global permit
            let _global_permit = semaphore.acquire().await.unwrap();

            // Acquire type-specific permit if configured
            let type_sems = type_semaphores.read().await;
            let _type_permit = if let Some(type_sem) = type_sems.get(&task_type) {
                Some(type_sem.acquire().await.unwrap())
            } else {
                None
            };
            drop(type_sems);

            // Update status to running
            {
                let mut tasks_guard = tasks.write().await;
                if let Some(t) = tasks_guard.get_mut(&task_id_clone) {
                    t.start();
                }
            }

            // Update stats
            {
                let mut stats_guard = stats.write().await;
                stats_guard.queued = stats_guard.queued.saturating_sub(1);
                stats_guard.running += 1;
                if stats_guard.running > stats_guard.peak_concurrent {
                    stats_guard.peak_concurrent = stats_guard.running;
                }
            }
            running_count.fetch_add(1, Ordering::SeqCst);

            // Simulate work (in real implementation, this would execute the actual task)
            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;

            // Mark as completed
            let duration = {
                let mut tasks_guard = tasks.write().await;
                if let Some(t) = tasks_guard.get_mut(&task_id_clone) {
                    t.complete();
                    t.elapsed_ms().unwrap_or(0) as u64
                } else {
                    0
                }
            };

            // Update stats
            total_duration.fetch_add(duration, Ordering::SeqCst);
            running_count.fetch_sub(1, Ordering::SeqCst);

            {
                let mut stats_guard = stats.write().await;
                stats_guard.completed += 1;
                stats_guard.running = stats_guard.running.saturating_sub(1);

                // Update average duration
                let total = total_duration.load(Ordering::SeqCst);
                let count = stats_guard.completed;
                if count > 0 {
                    stats_guard.avg_duration_ms = total as f64 / count as f64;
                }
            }
        });

        Ok(task_id)
    }

    /// Gets a task by ID
    pub async fn get_task(&self, task_id: &str) -> Option<ParallelTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned()
    }

    /// Gets all tasks
    pub async fn get_all_tasks(&self) -> Vec<ParallelTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().collect()
    }

    /// Gets tasks by status
    pub async fn get_tasks_by_status(&self, status: TaskStatus) -> Vec<ParallelTask> {
        let tasks = self.tasks.read().await;
        tasks.values().filter(|t| t.status == status).cloned().collect()
    }

    /// Gets tasks by type
    pub async fn get_tasks_by_type(&self, task_type: TaskType) -> Vec<ParallelTask> {
        let tasks = self.tasks.read().await;
        tasks.values().filter(|t| t.task_type == task_type).cloned().collect()
    }

    /// Cancels a task
    pub async fn cancel_task(&self, task_id: &str) -> CoreResult<()> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id).ok_or_else(|| {
            CoreError::NotFound(format!("Task not found: {}", task_id))
        })?;

        if task.status == TaskStatus::Pending || task.status == TaskStatus::Running {
            task.cancel();

            let mut stats = self.stats.write().await;
            stats.cancelled += 1;
            if task.status == TaskStatus::Running {
                stats.running = stats.running.saturating_sub(1);
            } else {
                stats.queued = stats.queued.saturating_sub(1);
            }
        }

        Ok(())
    }

    /// Cancels all pending tasks
    pub async fn cancel_all_pending(&self) -> usize {
        let mut tasks = self.tasks.write().await;
        let mut cancelled = 0;

        for task in tasks.values_mut() {
            if task.status == TaskStatus::Pending {
                task.cancel();
                cancelled += 1;
            }
        }

        let mut stats = self.stats.write().await;
        stats.cancelled += cancelled as u64;
        stats.queued = 0;

        cancelled
    }

    /// Removes completed tasks
    pub async fn cleanup_completed(&self) -> usize {
        let mut tasks = self.tasks.write().await;
        let before = tasks.len();

        tasks.retain(|_, t| {
            t.status != TaskStatus::Completed
                && t.status != TaskStatus::Failed
                && t.status != TaskStatus::Cancelled
        });

        before - tasks.len()
    }

    /// Gets pool statistics
    pub async fn get_stats(&self) -> PoolStats {
        self.stats.read().await.clone()
    }

    /// Gets current running count
    pub fn running_count(&self) -> usize {
        self.running_count.load(Ordering::SeqCst)
    }

    /// Checks if pool has capacity
    pub async fn has_capacity(&self) -> bool {
        let config = self.config.read().await;
        self.running_count.load(Ordering::SeqCst) < config.max_concurrent
    }

    /// Updates configuration
    pub async fn set_config(&self, config: ParallelConfig) {
        // Note: Changing max_concurrent requires recreating semaphore
        // This is a simplified implementation
        let mut cfg = self.config.write().await;
        *cfg = config;
    }
}

impl Default for WorkerPool {
    fn default() -> Self {
        Self::new()
    }
}

/// Parallel executor for batch operations
#[derive(Debug)]
pub struct ParallelExecutor {
    /// Worker pool
    pool: Arc<WorkerPool>,
}

impl ParallelExecutor {
    /// Creates a new executor
    pub fn new() -> Self {
        Self {
            pool: Arc::new(WorkerPool::new()),
        }
    }

    /// Creates with custom pool
    pub fn with_pool(pool: Arc<WorkerPool>) -> Self {
        Self { pool }
    }

    /// Gets the worker pool
    pub fn pool(&self) -> &Arc<WorkerPool> {
        &self.pool
    }

    /// Executes multiple tasks in parallel
    pub async fn execute_batch(
        &self,
        tasks: Vec<ParallelTask>,
    ) -> CoreResult<Vec<String>> {
        let mut task_ids = Vec::with_capacity(tasks.len());

        for task in tasks {
            let task_id = self.pool.submit(task).await?;
            task_ids.push(task_id);
        }

        Ok(task_ids)
    }

    /// Waits for all tasks to complete
    pub async fn wait_all(&self, task_ids: &[String], timeout_ms: u64) -> CoreResult<Vec<ParallelTask>> {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
        let mut results = Vec::with_capacity(task_ids.len());

        loop {
            let mut all_done = true;
            results.clear();

            for task_id in task_ids {
                if let Some(task) = self.pool.get_task(task_id).await {
                    results.push(task.clone());
                    if task.status == TaskStatus::Pending || task.status == TaskStatus::Running {
                        all_done = false;
                    }
                }
            }

            if all_done {
                return Ok(results);
            }

            if tokio::time::Instant::now() >= deadline {
                return Err(CoreError::Timeout("Waiting for tasks timed out".to_string()));
            }

            tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        }
    }

    /// Creates proxy generation tasks for multiple assets
    pub fn create_proxy_tasks(&self, asset_ids: &[String]) -> Vec<ParallelTask> {
        asset_ids
            .iter()
            .map(|id| {
                ParallelTask::new(TaskType::ProxyGeneration, TaskPriority::Normal)
                    .with_metadata("asset_id", id.clone())
            })
            .collect()
    }

    /// Creates indexing tasks for multiple assets
    pub fn create_indexing_tasks(&self, asset_ids: &[String]) -> Vec<ParallelTask> {
        asset_ids
            .iter()
            .map(|id| {
                ParallelTask::new(TaskType::Indexing, TaskPriority::Normal)
                    .with_metadata("asset_id", id.clone())
            })
            .collect()
    }

    /// Creates render tasks for timeline segments
    pub fn create_render_tasks(&self, segment_count: usize) -> Vec<ParallelTask> {
        (0..segment_count)
            .map(|i| {
                ParallelTask::new(TaskType::Rendering, TaskPriority::High)
                    .with_metadata("segment_index", i.to_string())
            })
            .collect()
    }
}

impl Default for ParallelExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // TaskPriority Tests
    // ========================================================================

    #[test]
    fn test_task_priority_ordering() {
        assert!(TaskPriority::Low < TaskPriority::Normal);
        assert!(TaskPriority::Normal < TaskPriority::High);
        assert!(TaskPriority::High < TaskPriority::Critical);
    }

    #[test]
    fn test_task_priority_weight() {
        assert_eq!(TaskPriority::Low.weight(), 1);
        assert_eq!(TaskPriority::Critical.weight(), 8);
    }

    // ========================================================================
    // ParallelTask Tests
    // ========================================================================

    #[test]
    fn test_parallel_task_creation() {
        let task = ParallelTask::new(TaskType::Rendering, TaskPriority::High);

        assert!(!task.id.is_empty());
        assert_eq!(task.task_type, TaskType::Rendering);
        assert_eq!(task.priority, TaskPriority::High);
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.progress, 0.0);
    }

    #[test]
    fn test_parallel_task_with_metadata() {
        let task = ParallelTask::new(TaskType::ProxyGeneration, TaskPriority::Normal)
            .with_metadata("asset_id", "asset_001")
            .with_metadata("format", "h264");

        assert_eq!(task.metadata.get("asset_id"), Some(&"asset_001".to_string()));
        assert_eq!(task.metadata.get("format"), Some(&"h264".to_string()));
    }

    #[test]
    fn test_parallel_task_lifecycle() {
        let mut task = ParallelTask::new(TaskType::Indexing, TaskPriority::Normal);

        assert_eq!(task.status, TaskStatus::Pending);
        assert!(task.started_at.is_none());

        task.start();
        assert_eq!(task.status, TaskStatus::Running);
        assert!(task.started_at.is_some());

        task.set_progress(0.5);
        assert_eq!(task.progress, 0.5);

        task.complete();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.progress, 1.0);
        assert!(task.completed_at.is_some());
    }

    #[test]
    fn test_parallel_task_failure() {
        let mut task = ParallelTask::new(TaskType::Rendering, TaskPriority::High);

        task.start();
        task.fail("Out of memory");

        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error, Some("Out of memory".to_string()));
    }

    #[test]
    fn test_parallel_task_cancel() {
        let mut task = ParallelTask::new(TaskType::ProxyGeneration, TaskPriority::Low);

        task.cancel();

        assert_eq!(task.status, TaskStatus::Cancelled);
        assert!(task.completed_at.is_some());
    }

    #[test]
    fn test_parallel_task_progress_clamping() {
        let mut task = ParallelTask::new(TaskType::Compute, TaskPriority::Normal);

        task.set_progress(1.5);
        assert_eq!(task.progress, 1.0);

        task.set_progress(-0.5);
        assert_eq!(task.progress, 0.0);
    }

    // ========================================================================
    // ParallelConfig Tests
    // ========================================================================

    #[test]
    fn test_parallel_config_default() {
        let config = ParallelConfig::default();

        assert!(config.max_concurrent >= 1);
        assert_eq!(config.worker_count, 0);
        assert!(config.work_stealing);
    }

    #[test]
    fn test_parallel_config_heavy_workload() {
        let config = ParallelConfig::heavy_workload();

        assert!(config.max_concurrent >= 2);
        assert!(!config.type_limits.is_empty());
    }

    #[test]
    fn test_parallel_config_low_memory() {
        let config = ParallelConfig::low_memory();

        assert!(config.max_concurrent >= 1);
        assert!(config.queue_size < ParallelConfig::default().queue_size);
    }

    // ========================================================================
    // WorkerPool Tests
    // ========================================================================

    #[tokio::test]
    async fn test_worker_pool_new() {
        let pool = WorkerPool::new();
        let stats = pool.get_stats().await;

        assert_eq!(stats.total_submitted, 0);
        assert_eq!(stats.running, 0);
    }

    #[tokio::test]
    async fn test_worker_pool_submit() {
        let pool = WorkerPool::new();
        let task = ParallelTask::new(TaskType::Compute, TaskPriority::Normal);

        let task_id = pool.submit(task).await.unwrap();
        assert!(!task_id.is_empty());

        let stats = pool.get_stats().await;
        assert_eq!(stats.total_submitted, 1);
    }

    #[tokio::test]
    async fn test_worker_pool_get_task() {
        let pool = WorkerPool::new();
        let task = ParallelTask::new(TaskType::Indexing, TaskPriority::High);
        let task_id = pool.submit(task).await.unwrap();

        // Wait a bit for task to be processed
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let retrieved = pool.get_task(&task_id).await;
        assert!(retrieved.is_some());
    }

    #[tokio::test]
    async fn test_worker_pool_get_tasks_by_status() {
        let pool = WorkerPool::new();

        // Submit a task
        let task = ParallelTask::new(TaskType::Rendering, TaskPriority::Normal);
        pool.submit(task).await.unwrap();

        // Wait for completion
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        let completed = pool.get_tasks_by_status(TaskStatus::Completed).await;
        assert!(!completed.is_empty());
    }

    #[tokio::test]
    async fn test_worker_pool_cleanup() {
        let pool = WorkerPool::new();

        // Submit and wait for task
        let task = ParallelTask::new(TaskType::Compute, TaskPriority::Normal);
        pool.submit(task).await.unwrap();
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        // Cleanup
        let cleaned = pool.cleanup_completed().await;
        assert_eq!(cleaned, 1);
    }

    #[tokio::test]
    async fn test_worker_pool_has_capacity() {
        let config = ParallelConfig {
            max_concurrent: 2,
            ..Default::default()
        };
        let pool = WorkerPool::with_config(config);

        assert!(pool.has_capacity().await);
    }

    // ========================================================================
    // ParallelExecutor Tests
    // ========================================================================

    #[tokio::test]
    async fn test_executor_new() {
        let executor = ParallelExecutor::new();
        let stats = executor.pool().get_stats().await;

        assert_eq!(stats.total_submitted, 0);
    }

    #[tokio::test]
    async fn test_executor_execute_batch() {
        let executor = ParallelExecutor::new();
        let tasks = vec![
            ParallelTask::new(TaskType::Compute, TaskPriority::Normal),
            ParallelTask::new(TaskType::Compute, TaskPriority::Normal),
        ];

        let task_ids = executor.execute_batch(tasks).await.unwrap();
        assert_eq!(task_ids.len(), 2);
    }

    #[tokio::test]
    async fn test_executor_wait_all() {
        let executor = ParallelExecutor::new();
        let tasks = vec![
            ParallelTask::new(TaskType::Compute, TaskPriority::Normal),
        ];

        let task_ids = executor.execute_batch(tasks).await.unwrap();
        let results = executor.wait_all(&task_ids, 1000).await.unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn test_executor_create_proxy_tasks() {
        let executor = ParallelExecutor::new();
        let asset_ids = vec!["asset_001".to_string(), "asset_002".to_string()];

        let tasks = executor.create_proxy_tasks(&asset_ids);

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].task_type, TaskType::ProxyGeneration);
        assert_eq!(tasks[0].metadata.get("asset_id"), Some(&"asset_001".to_string()));
    }

    #[tokio::test]
    async fn test_executor_create_render_tasks() {
        let executor = ParallelExecutor::new();
        let tasks = executor.create_render_tasks(4);

        assert_eq!(tasks.len(), 4);
        assert!(tasks.iter().all(|t| t.task_type == TaskType::Rendering));
        assert!(tasks.iter().all(|t| t.priority == TaskPriority::High));
    }
}
