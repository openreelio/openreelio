//! Performance Optimization Module
//!
//! Provides GPU acceleration, multi-core utilization, and memory optimization.

pub mod gpu;
pub mod parallel;
pub mod memory;

// Re-export main types
pub use gpu::{GpuAccelerator, GpuCapability, GpuConfig, GpuDevice, HardwareEncoder};
pub use parallel::{ParallelExecutor, ParallelConfig, TaskPriority, WorkerPool};
pub use memory::{MemoryPool, MemoryConfig, CacheManager, StreamingBuffer};
