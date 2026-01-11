//! Memory Optimization Module
//!
//! Provides memory pooling, caching, and streaming for efficient memory usage.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::core::{CoreError, CoreResult};

/// Memory allocation strategy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllocationStrategy {
    /// Allocate on demand
    OnDemand,
    /// Pre-allocate pools
    Pooled,
    /// Memory-mapped files
    MemoryMapped,
    /// Streaming (load on access)
    Streaming,
}

/// Cache eviction policy
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvictionPolicy {
    /// Least Recently Used
    Lru,
    /// Least Frequently Used
    Lfu,
    /// First In First Out
    Fifo,
    /// Time-based expiration
    TimeExpired,
    /// Random eviction
    Random,
}

impl Default for EvictionPolicy {
    fn default() -> Self {
        EvictionPolicy::Lru
    }
}

/// Memory configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryConfig {
    /// Maximum memory usage in bytes
    pub max_memory_bytes: u64,
    /// Maximum cache size in bytes
    pub max_cache_bytes: u64,
    /// Pool block sizes (in bytes)
    pub pool_block_sizes: Vec<usize>,
    /// Enable memory pooling
    pub pooling_enabled: bool,
    /// Enable streaming for large assets
    pub streaming_enabled: bool,
    /// Streaming threshold (bytes)
    pub streaming_threshold: u64,
    /// Cache eviction policy
    pub eviction_policy: EvictionPolicy,
    /// Cache entry TTL in seconds (0 = no expiration)
    pub cache_ttl_secs: u64,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            max_memory_bytes: 4 * 1024 * 1024 * 1024, // 4GB
            max_cache_bytes: 1024 * 1024 * 1024,      // 1GB
            pool_block_sizes: vec![
                64 * 1024,        // 64KB
                256 * 1024,       // 256KB
                1024 * 1024,      // 1MB
                4 * 1024 * 1024,  // 4MB
                16 * 1024 * 1024, // 16MB
            ],
            pooling_enabled: true,
            streaming_enabled: true,
            streaming_threshold: 100 * 1024 * 1024, // 100MB
            eviction_policy: EvictionPolicy::Lru,
            cache_ttl_secs: 300, // 5 minutes
        }
    }
}

impl MemoryConfig {
    /// Creates config for low-memory systems
    pub fn low_memory() -> Self {
        Self {
            max_memory_bytes: 1024 * 1024 * 1024, // 1GB
            max_cache_bytes: 256 * 1024 * 1024,   // 256MB
            streaming_threshold: 50 * 1024 * 1024, // 50MB
            ..Default::default()
        }
    }

    /// Creates config for high-memory systems
    pub fn high_memory() -> Self {
        Self {
            max_memory_bytes: 16 * 1024 * 1024 * 1024, // 16GB
            max_cache_bytes: 4 * 1024 * 1024 * 1024,   // 4GB
            streaming_threshold: 500 * 1024 * 1024,    // 500MB
            ..Default::default()
        }
    }
}

/// Memory block in pool
#[derive(Debug)]
struct PoolBlock {
    /// Block ID
    id: String,
    /// Block size
    size: usize,
    /// Data buffer
    data: Vec<u8>,
    /// Is currently allocated
    allocated: bool,
    /// Allocation count (for debugging)
    allocation_count: u64,
}

impl PoolBlock {
    fn new(size: usize) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            size,
            data: vec![0u8; size],
            allocated: false,
            allocation_count: 0,
        }
    }

    fn allocate(&mut self) -> &mut [u8] {
        self.allocated = true;
        self.allocation_count += 1;
        &mut self.data
    }

    fn release(&mut self) {
        self.allocated = false;
        // Optionally zero memory for security
        // self.data.fill(0);
    }
}

/// Pool statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PoolStats {
    /// Total blocks
    pub total_blocks: usize,
    /// Allocated blocks
    pub allocated_blocks: usize,
    /// Total pool size in bytes
    pub total_size_bytes: u64,
    /// Used size in bytes
    pub used_size_bytes: u64,
    /// Allocation count
    pub allocation_count: u64,
    /// Release count
    pub release_count: u64,
    /// Pool hits (reused blocks)
    pub pool_hits: u64,
    /// Pool misses (new allocations)
    pub pool_misses: u64,
}

/// Memory pool for efficient allocation
#[derive(Debug)]
pub struct MemoryPool {
    /// Configuration
    config: Arc<RwLock<MemoryConfig>>,
    /// Blocks organized by size
    pools: Arc<RwLock<HashMap<usize, Vec<PoolBlock>>>>,
    /// Statistics
    stats: Arc<RwLock<PoolStats>>,
    /// Total allocated bytes
    allocated_bytes: Arc<AtomicU64>,
}

impl MemoryPool {
    /// Creates a new memory pool
    pub fn new() -> Self {
        Self::with_config(MemoryConfig::default())
    }

    /// Creates with custom config
    pub fn with_config(config: MemoryConfig) -> Self {
        let mut pools = HashMap::new();
        for &size in &config.pool_block_sizes {
            pools.insert(size, Vec::new());
        }

        Self {
            config: Arc::new(RwLock::new(config)),
            pools: Arc::new(RwLock::new(pools)),
            stats: Arc::new(RwLock::new(PoolStats::default())),
            allocated_bytes: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Finds the best block size for requested size
    fn best_block_size(&self, requested: usize, block_sizes: &[usize]) -> Option<usize> {
        block_sizes.iter().find(|&&s| s >= requested).copied()
    }

    /// Allocates memory from pool
    pub async fn allocate(&self, size: usize) -> CoreResult<PoolAllocation> {
        let config = self.config.read().await;

        // Check memory limit
        let current = self.allocated_bytes.load(Ordering::SeqCst);
        if current + size as u64 > config.max_memory_bytes {
            return Err(CoreError::ResourceExhausted(format!(
                "Memory limit exceeded: {} + {} > {}",
                current, size, config.max_memory_bytes
            )));
        }

        // Find best block size
        let block_size = self.best_block_size(size, &config.pool_block_sizes);
        drop(config);

        if let Some(block_size) = block_size {
            let mut pools = self.pools.write().await;
            let mut stats = self.stats.write().await;

            if let Some(pool) = pools.get_mut(&block_size) {
                // Try to find a free block
                for block in pool.iter_mut() {
                    if !block.allocated {
                        block.allocate();
                        self.allocated_bytes.fetch_add(block_size as u64, Ordering::SeqCst);
                        stats.allocated_blocks += 1;
                        stats.used_size_bytes += block_size as u64;
                        stats.allocation_count += 1;
                        stats.pool_hits += 1;

                        return Ok(PoolAllocation {
                            block_id: block.id.clone(),
                            size: block_size,
                            actual_size: size,
                        });
                    }
                }

                // No free block, create new one
                let mut block = PoolBlock::new(block_size);
                let block_id = block.id.clone();
                block.allocate();
                pool.push(block);

                self.allocated_bytes.fetch_add(block_size as u64, Ordering::SeqCst);
                stats.total_blocks += 1;
                stats.allocated_blocks += 1;
                stats.total_size_bytes += block_size as u64;
                stats.used_size_bytes += block_size as u64;
                stats.allocation_count += 1;
                stats.pool_misses += 1;

                return Ok(PoolAllocation {
                    block_id,
                    size: block_size,
                    actual_size: size,
                });
            }
        }

        // Fallback: direct allocation (not pooled)
        let alloc_id = ulid::Ulid::new().to_string();
        self.allocated_bytes.fetch_add(size as u64, Ordering::SeqCst);

        let mut stats = self.stats.write().await;
        stats.allocation_count += 1;
        stats.pool_misses += 1;

        Ok(PoolAllocation {
            block_id: alloc_id,
            size,
            actual_size: size,
        })
    }

    /// Releases memory back to pool
    pub async fn release(&self, allocation: &PoolAllocation) {
        let mut pools = self.pools.write().await;

        for (block_size, pool) in pools.iter_mut() {
            if *block_size == allocation.size {
                for block in pool.iter_mut() {
                    if block.id == allocation.block_id {
                        block.release();
                        self.allocated_bytes.fetch_sub(allocation.size as u64, Ordering::SeqCst);

                        let mut stats = self.stats.write().await;
                        stats.allocated_blocks = stats.allocated_blocks.saturating_sub(1);
                        stats.used_size_bytes = stats.used_size_bytes.saturating_sub(allocation.size as u64);
                        stats.release_count += 1;
                        return;
                    }
                }
            }
        }

        // Not found in pools (was direct allocation)
        self.allocated_bytes.fetch_sub(allocation.size as u64, Ordering::SeqCst);
        let mut stats = self.stats.write().await;
        stats.release_count += 1;
    }

    /// Gets current allocated bytes
    pub fn allocated_bytes(&self) -> u64 {
        self.allocated_bytes.load(Ordering::SeqCst)
    }

    /// Gets pool statistics
    pub async fn get_stats(&self) -> PoolStats {
        self.stats.read().await.clone()
    }

    /// Clears all free blocks to reclaim memory
    pub async fn shrink(&self) -> usize {
        let mut pools = self.pools.write().await;
        let mut freed = 0;

        for (size, pool) in pools.iter_mut() {
            let before = pool.len();
            pool.retain(|b| b.allocated);
            let removed = before - pool.len();
            freed += removed * size;
        }

        let mut stats = self.stats.write().await;
        stats.total_blocks = pools.values().map(|p| p.len()).sum();
        stats.total_size_bytes = pools.iter().map(|(s, p)| *s as u64 * p.len() as u64).sum();

        freed
    }
}

impl Default for MemoryPool {
    fn default() -> Self {
        Self::new()
    }
}

/// Represents an allocation from the pool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolAllocation {
    /// Block ID
    pub block_id: String,
    /// Allocated block size
    pub size: usize,
    /// Actual requested size
    pub actual_size: usize,
}

impl PoolAllocation {
    /// Wasted space (padding)
    pub fn wasted_bytes(&self) -> usize {
        self.size - self.actual_size
    }
}

/// Cache entry metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    /// Entry key
    pub key: String,
    /// Size in bytes
    pub size: u64,
    /// Creation timestamp
    pub created_at: i64,
    /// Last access timestamp
    pub last_accessed_at: i64,
    /// Access count
    pub access_count: u64,
}

impl CacheEntry {
    fn new(key: &str, size: u64) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            key: key.to_string(),
            size,
            created_at: now,
            last_accessed_at: now,
            access_count: 1,
        }
    }

    fn access(&mut self) {
        self.last_accessed_at = chrono::Utc::now().timestamp_millis();
        self.access_count += 1;
    }

    fn age_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis() - self.created_at
    }
}

/// Cache statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CacheStats {
    /// Total entries
    pub entry_count: usize,
    /// Total size in bytes
    pub total_size_bytes: u64,
    /// Cache hits
    pub hits: u64,
    /// Cache misses
    pub misses: u64,
    /// Evictions
    pub evictions: u64,
    /// Hit rate (0.0 - 1.0)
    pub hit_rate: f64,
}

/// Cache manager for asset and render caching
#[derive(Debug)]
pub struct CacheManager {
    /// Configuration
    config: Arc<RwLock<MemoryConfig>>,
    /// Cache entries (key -> data)
    entries: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    /// Entry metadata
    metadata: Arc<RwLock<HashMap<String, CacheEntry>>>,
    /// Statistics
    stats: Arc<RwLock<CacheStats>>,
    /// Current size
    current_size: Arc<AtomicU64>,
}

impl CacheManager {
    /// Creates a new cache manager
    pub fn new() -> Self {
        Self::with_config(MemoryConfig::default())
    }

    /// Creates with custom config
    pub fn with_config(config: MemoryConfig) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            entries: Arc::new(RwLock::new(HashMap::new())),
            metadata: Arc::new(RwLock::new(HashMap::new())),
            stats: Arc::new(RwLock::new(CacheStats::default())),
            current_size: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Gets an entry from cache
    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        let entries = self.entries.read().await;

        if let Some(data) = entries.get(key) {
            // Update metadata
            let mut metadata = self.metadata.write().await;
            if let Some(entry) = metadata.get_mut(key) {
                entry.access();
            }

            // Update stats
            let mut stats = self.stats.write().await;
            stats.hits += 1;
            self.update_hit_rate(&mut stats);

            Some(data.clone())
        } else {
            let mut stats = self.stats.write().await;
            stats.misses += 1;
            self.update_hit_rate(&mut stats);

            None
        }
    }

    /// Puts an entry in cache
    pub async fn put(&self, key: &str, data: Vec<u8>) -> CoreResult<()> {
        let data_size = data.len() as u64;
        let config = self.config.read().await;

        // Check if single item exceeds cache size
        if data_size > config.max_cache_bytes {
            return Err(CoreError::ValidationError(
                "Data exceeds cache size limit".to_string()
            ));
        }

        // Evict if necessary
        while self.current_size.load(Ordering::SeqCst) + data_size > config.max_cache_bytes {
            drop(config);
            if !self.evict_one().await {
                break;
            }
        }

        // Insert new entry
        {
            let mut entries = self.entries.write().await;
            let mut metadata = self.metadata.write().await;

            // Remove old entry if exists
            if let Some(old_data) = entries.remove(key) {
                self.current_size.fetch_sub(old_data.len() as u64, Ordering::SeqCst);
                metadata.remove(key);
            }

            entries.insert(key.to_string(), data);
            metadata.insert(key.to_string(), CacheEntry::new(key, data_size));
            self.current_size.fetch_add(data_size, Ordering::SeqCst);
        }

        // Update stats
        let mut stats = self.stats.write().await;
        stats.entry_count = self.entries.read().await.len();
        stats.total_size_bytes = self.current_size.load(Ordering::SeqCst);

        Ok(())
    }

    /// Removes an entry from cache
    pub async fn remove(&self, key: &str) -> Option<Vec<u8>> {
        let mut entries = self.entries.write().await;
        let mut metadata = self.metadata.write().await;

        if let Some(data) = entries.remove(key) {
            metadata.remove(key);
            self.current_size.fetch_sub(data.len() as u64, Ordering::SeqCst);

            let mut stats = self.stats.write().await;
            stats.entry_count = entries.len();
            stats.total_size_bytes = self.current_size.load(Ordering::SeqCst);

            Some(data)
        } else {
            None
        }
    }

    /// Evicts one entry based on policy
    async fn evict_one(&self) -> bool {
        let config = self.config.read().await;
        let policy = config.eviction_policy;
        drop(config);

        let key_to_evict = {
            let metadata = self.metadata.read().await;
            if metadata.is_empty() {
                return false;
            }

            match policy {
                EvictionPolicy::Lru => {
                    metadata.values()
                        .min_by_key(|e| e.last_accessed_at)
                        .map(|e| e.key.clone())
                }
                EvictionPolicy::Lfu => {
                    metadata.values()
                        .min_by_key(|e| e.access_count)
                        .map(|e| e.key.clone())
                }
                EvictionPolicy::Fifo => {
                    metadata.values()
                        .min_by_key(|e| e.created_at)
                        .map(|e| e.key.clone())
                }
                EvictionPolicy::TimeExpired => {
                    metadata.values()
                        .max_by_key(|e| e.age_ms())
                        .map(|e| e.key.clone())
                }
                EvictionPolicy::Random => {
                    metadata.keys().next().cloned()
                }
            }
        };

        if let Some(key) = key_to_evict {
            self.remove(&key).await;

            let mut stats = self.stats.write().await;
            stats.evictions += 1;

            true
        } else {
            false
        }
    }

    /// Clears all cache entries
    pub async fn clear(&self) {
        let mut entries = self.entries.write().await;
        let mut metadata = self.metadata.write().await;

        entries.clear();
        metadata.clear();
        self.current_size.store(0, Ordering::SeqCst);

        let mut stats = self.stats.write().await;
        stats.entry_count = 0;
        stats.total_size_bytes = 0;
    }

    /// Gets cache statistics
    pub async fn get_stats(&self) -> CacheStats {
        self.stats.read().await.clone()
    }

    /// Checks if key exists in cache
    pub async fn contains(&self, key: &str) -> bool {
        self.entries.read().await.contains_key(key)
    }

    /// Gets current cache size
    pub fn current_size(&self) -> u64 {
        self.current_size.load(Ordering::SeqCst)
    }

    fn update_hit_rate(&self, stats: &mut CacheStats) {
        let total = stats.hits + stats.misses;
        if total > 0 {
            stats.hit_rate = stats.hits as f64 / total as f64;
        }
    }
}

impl Default for CacheManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Streaming buffer state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BufferState {
    /// Not loaded
    Empty,
    /// Loading in progress
    Loading,
    /// Loaded and ready
    Ready,
    /// Error occurred
    Error,
}

/// Streaming buffer for large assets
#[derive(Debug)]
pub struct StreamingBuffer {
    /// Buffer ID
    pub id: String,
    /// Source path or URL
    pub source: String,
    /// Total size in bytes
    pub total_size: u64,
    /// Buffer size (window)
    pub buffer_size: usize,
    /// Current position
    position: Arc<AtomicU64>,
    /// Current state
    state: Arc<RwLock<BufferState>>,
    /// Buffered data chunks (offset -> data)
    chunks: Arc<RwLock<HashMap<u64, Vec<u8>>>>,
    /// Chunk size
    chunk_size: usize,
    /// Maximum buffered chunks
    max_chunks: usize,
}

impl StreamingBuffer {
    /// Creates a new streaming buffer
    pub fn new(source: impl Into<String>, total_size: u64) -> Self {
        Self {
            id: ulid::Ulid::new().to_string(),
            source: source.into(),
            total_size,
            buffer_size: 16 * 1024 * 1024, // 16MB default
            position: Arc::new(AtomicU64::new(0)),
            state: Arc::new(RwLock::new(BufferState::Empty)),
            chunks: Arc::new(RwLock::new(HashMap::new())),
            chunk_size: 1024 * 1024, // 1MB chunks
            max_chunks: 32,
        }
    }

    /// Sets buffer size
    pub fn with_buffer_size(mut self, size: usize) -> Self {
        self.buffer_size = size;
        self
    }

    /// Gets current position
    pub fn position(&self) -> u64 {
        self.position.load(Ordering::SeqCst)
    }

    /// Sets current position
    pub fn set_position(&self, pos: u64) {
        let clamped = pos.min(self.total_size);
        self.position.store(clamped, Ordering::SeqCst);
    }

    /// Gets current state
    pub async fn state(&self) -> BufferState {
        *self.state.read().await
    }

    /// Reads data at current position
    pub async fn read(&self, length: usize) -> Option<Vec<u8>> {
        let pos = self.position();
        self.read_at(pos, length).await
    }

    /// Reads data at specific position
    pub async fn read_at(&self, offset: u64, length: usize) -> Option<Vec<u8>> {
        // Calculate which chunks we need
        let start_chunk = offset / self.chunk_size as u64;
        let end_chunk = (offset + length as u64) / self.chunk_size as u64;

        let chunks = self.chunks.read().await;

        // Check if all required chunks are loaded
        for chunk_idx in start_chunk..=end_chunk {
            let chunk_offset = chunk_idx * self.chunk_size as u64;
            if !chunks.contains_key(&chunk_offset) {
                // Chunk not loaded - in real impl, would trigger async load
                return None;
            }
        }

        // Assemble data from chunks
        let mut result = Vec::with_capacity(length);
        let mut remaining = length;
        let mut current_offset = offset;

        while remaining > 0 && current_offset < self.total_size {
            let chunk_offset = (current_offset / self.chunk_size as u64) * self.chunk_size as u64;
            if let Some(chunk_data) = chunks.get(&chunk_offset) {
                let offset_in_chunk = (current_offset - chunk_offset) as usize;
                let available = chunk_data.len() - offset_in_chunk;
                let to_read = remaining.min(available);

                result.extend_from_slice(&chunk_data[offset_in_chunk..offset_in_chunk + to_read]);
                remaining -= to_read;
                current_offset += to_read as u64;
            } else {
                break;
            }
        }

        if result.is_empty() {
            None
        } else {
            Some(result)
        }
    }

    /// Loads a chunk (mock implementation)
    pub async fn load_chunk(&self, chunk_offset: u64) -> CoreResult<()> {
        if chunk_offset >= self.total_size {
            return Err(CoreError::ValidationError("Offset beyond file size".to_string()));
        }

        // Mock data - in real implementation would read from file
        let actual_size = self.chunk_size.min((self.total_size - chunk_offset) as usize);
        let mock_data = vec![0u8; actual_size];

        let mut chunks = self.chunks.write().await;

        // Evict oldest chunk if at capacity
        while chunks.len() >= self.max_chunks {
            if let Some(key) = chunks.keys().next().cloned() {
                chunks.remove(&key);
            }
        }

        chunks.insert(chunk_offset, mock_data);

        let mut state = self.state.write().await;
        *state = BufferState::Ready;

        Ok(())
    }

    /// Prefetches chunks around position
    pub async fn prefetch(&self, center_offset: u64, count: usize) -> Vec<u64> {
        let mut offsets = Vec::with_capacity(count);
        let chunk_offset = (center_offset / self.chunk_size as u64) * self.chunk_size as u64;

        // Add chunks around the center position
        for i in 0..count {
            let offset = chunk_offset + (i as u64 * self.chunk_size as u64);
            if offset < self.total_size {
                offsets.push(offset);
            }
        }

        offsets
    }

    /// Clears all buffered data
    pub async fn clear(&self) {
        let mut chunks = self.chunks.write().await;
        chunks.clear();

        let mut state = self.state.write().await;
        *state = BufferState::Empty;
    }

    /// Gets buffered chunk count
    pub async fn buffered_chunks(&self) -> usize {
        self.chunks.read().await.len()
    }

    /// Gets buffered bytes
    pub async fn buffered_bytes(&self) -> u64 {
        let chunks = self.chunks.read().await;
        chunks.values().map(|c| c.len() as u64).sum()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // MemoryConfig Tests
    // ========================================================================

    #[test]
    fn test_memory_config_default() {
        let config = MemoryConfig::default();

        assert_eq!(config.max_memory_bytes, 4 * 1024 * 1024 * 1024);
        assert!(config.pooling_enabled);
        assert!(config.streaming_enabled);
    }

    #[test]
    fn test_memory_config_low_memory() {
        let config = MemoryConfig::low_memory();

        assert!(config.max_memory_bytes < MemoryConfig::default().max_memory_bytes);
        assert!(config.max_cache_bytes < MemoryConfig::default().max_cache_bytes);
    }

    #[test]
    fn test_memory_config_high_memory() {
        let config = MemoryConfig::high_memory();

        assert!(config.max_memory_bytes > MemoryConfig::default().max_memory_bytes);
        assert!(config.max_cache_bytes > MemoryConfig::default().max_cache_bytes);
    }

    // ========================================================================
    // PoolAllocation Tests
    // ========================================================================

    #[test]
    fn test_pool_allocation_wasted_bytes() {
        let alloc = PoolAllocation {
            block_id: "test".to_string(),
            size: 1024,
            actual_size: 800,
        };

        assert_eq!(alloc.wasted_bytes(), 224);
    }

    // ========================================================================
    // MemoryPool Tests
    // ========================================================================

    #[tokio::test]
    async fn test_memory_pool_new() {
        let pool = MemoryPool::new();
        let stats = pool.get_stats().await;

        assert_eq!(stats.total_blocks, 0);
        assert_eq!(pool.allocated_bytes(), 0);
    }

    #[tokio::test]
    async fn test_memory_pool_allocate() {
        let pool = MemoryPool::new();

        let alloc = pool.allocate(1000).await.unwrap();

        assert!(alloc.size >= 1000);
        assert_eq!(alloc.actual_size, 1000);
        assert!(pool.allocated_bytes() > 0);
    }

    #[tokio::test]
    async fn test_memory_pool_allocate_release() {
        let pool = MemoryPool::new();

        let alloc = pool.allocate(5000).await.unwrap();
        let allocated = pool.allocated_bytes();
        assert!(allocated > 0);

        pool.release(&alloc).await;
        assert_eq!(pool.allocated_bytes(), 0);
    }

    #[tokio::test]
    async fn test_memory_pool_reuse() {
        let pool = MemoryPool::new();

        // Allocate and release
        let alloc1 = pool.allocate(1000).await.unwrap();
        pool.release(&alloc1).await;

        // Allocate again - should reuse block
        let _alloc2 = pool.allocate(1000).await.unwrap();

        let stats = pool.get_stats().await;
        assert!(stats.pool_hits > 0);
    }

    #[tokio::test]
    async fn test_memory_pool_shrink() {
        let pool = MemoryPool::new();

        // Allocate and release
        let alloc = pool.allocate(1000).await.unwrap();
        pool.release(&alloc).await;

        // Shrink should free the unused block
        let freed = pool.shrink().await;
        assert!(freed > 0);
    }

    // ========================================================================
    // CacheEntry Tests
    // ========================================================================

    #[test]
    fn test_cache_entry_creation() {
        let entry = CacheEntry::new("test_key", 1024);

        assert_eq!(entry.key, "test_key");
        assert_eq!(entry.size, 1024);
        assert_eq!(entry.access_count, 1);
    }

    #[test]
    fn test_cache_entry_access() {
        let mut entry = CacheEntry::new("test", 100);
        let first_access = entry.last_accessed_at;

        std::thread::sleep(std::time::Duration::from_millis(10));
        entry.access();

        assert!(entry.last_accessed_at >= first_access);
        assert_eq!(entry.access_count, 2);
    }

    // ========================================================================
    // CacheManager Tests
    // ========================================================================

    #[tokio::test]
    async fn test_cache_manager_new() {
        let cache = CacheManager::new();
        let stats = cache.get_stats().await;

        assert_eq!(stats.entry_count, 0);
        assert_eq!(cache.current_size(), 0);
    }

    #[tokio::test]
    async fn test_cache_manager_put_get() {
        let cache = CacheManager::new();
        let data = vec![1, 2, 3, 4, 5];

        cache.put("key1", data.clone()).await.unwrap();
        let retrieved = cache.get("key1").await;

        assert_eq!(retrieved, Some(data));
    }

    #[tokio::test]
    async fn test_cache_manager_miss() {
        let cache = CacheManager::new();

        let result = cache.get("nonexistent").await;
        assert!(result.is_none());

        let stats = cache.get_stats().await;
        assert_eq!(stats.misses, 1);
    }

    #[tokio::test]
    async fn test_cache_manager_hit_stats() {
        let cache = CacheManager::new();
        cache.put("key1", vec![1, 2, 3]).await.unwrap();

        // First access
        cache.get("key1").await;
        cache.get("key1").await;

        let stats = cache.get_stats().await;
        assert_eq!(stats.hits, 2);
        assert!(stats.hit_rate > 0.0);
    }

    #[tokio::test]
    async fn test_cache_manager_remove() {
        let cache = CacheManager::new();
        cache.put("key1", vec![1, 2, 3]).await.unwrap();

        let removed = cache.remove("key1").await;
        assert!(removed.is_some());
        assert!(!cache.contains("key1").await);
    }

    #[tokio::test]
    async fn test_cache_manager_clear() {
        let cache = CacheManager::new();
        cache.put("key1", vec![1, 2, 3]).await.unwrap();
        cache.put("key2", vec![4, 5, 6]).await.unwrap();

        cache.clear().await;

        assert_eq!(cache.current_size(), 0);
        assert!(!cache.contains("key1").await);
    }

    #[tokio::test]
    async fn test_cache_manager_eviction() {
        let config = MemoryConfig {
            max_cache_bytes: 100,
            eviction_policy: EvictionPolicy::Lru,
            ..Default::default()
        };
        let cache = CacheManager::with_config(config);

        // Fill cache
        cache.put("key1", vec![0u8; 50]).await.unwrap();
        cache.put("key2", vec![0u8; 50]).await.unwrap();

        // This should trigger eviction
        cache.put("key3", vec![0u8; 50]).await.unwrap();

        let stats = cache.get_stats().await;
        assert!(stats.evictions > 0);
    }

    // ========================================================================
    // StreamingBuffer Tests
    // ========================================================================

    #[tokio::test]
    async fn test_streaming_buffer_new() {
        let buffer = StreamingBuffer::new("/path/to/file", 1024 * 1024);

        assert_eq!(buffer.total_size, 1024 * 1024);
        assert_eq!(buffer.position(), 0);
        assert_eq!(buffer.state().await, BufferState::Empty);
    }

    #[tokio::test]
    async fn test_streaming_buffer_position() {
        let buffer = StreamingBuffer::new("source", 1000);

        buffer.set_position(500);
        assert_eq!(buffer.position(), 500);

        // Clamp to total size
        buffer.set_position(2000);
        assert_eq!(buffer.position(), 1000);
    }

    #[tokio::test]
    async fn test_streaming_buffer_load_chunk() {
        let buffer = StreamingBuffer::new("source", 10 * 1024 * 1024);

        buffer.load_chunk(0).await.unwrap();

        assert_eq!(buffer.state().await, BufferState::Ready);
        assert_eq!(buffer.buffered_chunks().await, 1);
    }

    #[tokio::test]
    async fn test_streaming_buffer_read_at() {
        let buffer = StreamingBuffer::new("source", 10 * 1024 * 1024);

        // Load chunk first
        buffer.load_chunk(0).await.unwrap();

        // Read from loaded chunk
        let data = buffer.read_at(0, 100).await;
        assert!(data.is_some());
        assert_eq!(data.unwrap().len(), 100);
    }

    #[tokio::test]
    async fn test_streaming_buffer_prefetch() {
        let buffer = StreamingBuffer::new("source", 100 * 1024 * 1024);

        let offsets = buffer.prefetch(0, 4).await;

        assert_eq!(offsets.len(), 4);
        assert!(offsets.iter().all(|&o| o < buffer.total_size));
    }

    #[tokio::test]
    async fn test_streaming_buffer_clear() {
        let buffer = StreamingBuffer::new("source", 10 * 1024 * 1024);

        buffer.load_chunk(0).await.unwrap();
        buffer.load_chunk(1024 * 1024).await.unwrap();

        assert_eq!(buffer.buffered_chunks().await, 2);

        buffer.clear().await;

        assert_eq!(buffer.buffered_chunks().await, 0);
        assert_eq!(buffer.state().await, BufferState::Empty);
    }
}
