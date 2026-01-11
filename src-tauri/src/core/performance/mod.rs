//! Performance Optimization Module
//!
//! Provides GPU acceleration, multi-core utilization, and memory optimization.

pub mod gpu;
pub mod memory;
pub mod parallel;

// Re-export main types
pub use gpu::{GpuAccelerator, GpuCapability, GpuConfig, GpuDevice, HardwareEncoder};
pub use memory::{CacheManager, MemoryConfig, MemoryPool, StreamingBuffer};
pub use parallel::{ParallelConfig, ParallelExecutor, TaskPriority, WorkerPool};
