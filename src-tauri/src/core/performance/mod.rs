//! Performance Optimization Module
//!
//! Provides GPU acceleration, multi-core utilization, memory optimization, and metrics.

pub mod gpu;
pub mod memory;
pub mod metrics;
pub mod parallel;

// Re-export main types
pub use gpu::{GpuAccelerator, GpuCapability, GpuConfig, GpuDevice, HardwareEncoder};
pub use memory::{CacheManager, MemoryConfig, MemoryPool, StreamingBuffer};
pub use metrics::{
    ExportMetrics, FrameMetrics, MemoryMetrics, MetricsCollector, MetricsConfig, PerformanceReport,
    PreviewMetrics, StartupMetrics, Timer,
};
pub use parallel::{ParallelConfig, ParallelExecutor, TaskPriority, WorkerPool};
