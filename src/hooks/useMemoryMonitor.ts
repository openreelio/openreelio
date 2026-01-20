/**
 * useMemoryMonitor Hook
 *
 * Monitors memory usage from both backend (Rust) and frontend (JS).
 * Provides real-time stats for memory pools, caches, and system memory.
 *
 * @module hooks/useMemoryMonitor
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

// =============================================================================
// Types
// =============================================================================

/** Pool statistics from backend memory pool */
export interface PoolStats {
  totalBlocks: number;
  allocatedBlocks: number;
  totalSizeBytes: number;
  usedSizeBytes: number;
  allocationCount: number;
  releaseCount: number;
  poolHits: number;
  poolMisses: number;
  hitRate: number;
}

/** Cache statistics from backend cache manager */
export interface CacheStats {
  entryCount: number;
  totalSizeBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

/** System memory information */
export interface SystemMemory {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usagePercent: number;
}

/** JavaScript heap memory info (Chrome/Chromium only) */
export interface JSHeapStats {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  usagePercent: number;
}

/** Complete memory statistics */
export interface MemoryStats {
  /** Backend pool statistics */
  poolStats: PoolStats;
  /** Backend cache statistics */
  cacheStats: CacheStats;
  /** Total allocated bytes in Rust */
  allocatedBytes: number;
  /** System memory info (if available) */
  systemMemory: SystemMemory | null;
  /** JS heap info (Chrome/WebView only) */
  jsHeap: JSHeapStats | null;
  /** Timestamp of this measurement */
  timestamp: number;
}

/** Memory cleanup result */
export interface CleanupResult {
  poolBytesFreed: number;
  cacheEntriesEvicted: number;
  totalBytesFreed: number;
}

/** Hook configuration options */
export interface UseMemoryMonitorOptions {
  /** Polling interval in milliseconds (default: 5000) */
  intervalMs?: number;
  /** Whether to start monitoring immediately (default: true) */
  autoStart?: boolean;
  /** Whether to include JS heap stats (default: true) */
  includeJSHeap?: boolean;
}

/** Hook return type */
export interface UseMemoryMonitorResult {
  /** Current memory statistics */
  stats: MemoryStats | null;
  /** Whether monitoring is active */
  isMonitoring: boolean;
  /** Whether a fetch is in progress */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Start monitoring */
  start: () => void;
  /** Stop monitoring */
  stop: () => void;
  /** Manually refresh stats */
  refresh: () => Promise<void>;
  /** Trigger memory cleanup */
  cleanup: () => Promise<CleanupResult | null>;
  /** History of stats (last N samples) */
  history: MemoryStats[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_INTERVAL_MS = 5000;
const MAX_HISTORY_LENGTH = 60; // Keep last 5 minutes at 5s intervals

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get JS heap memory info (Chrome/Chromium only)
 */
function getJSHeapStats(): JSHeapStats | null {
  // performance.memory is only available in Chrome/Chromium
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };

  if (perf.memory) {
    const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = perf.memory;
    return {
      usedJSHeapSize,
      totalJSHeapSize,
      jsHeapSizeLimit,
      usagePercent: jsHeapSizeLimit > 0 ? (usedJSHeapSize / jsHeapSizeLimit) * 100 : 0,
    };
  }

  return null;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Calculate memory trend (increasing, decreasing, stable)
 */
export function calculateTrend(history: MemoryStats[]): 'increasing' | 'decreasing' | 'stable' {
  if (history.length < 3) return 'stable';

  const recent = history.slice(-5);
  const values = recent.map((s) => s.allocatedBytes);
  const first = values[0];
  const last = values[values.length - 1];

  const baseline = first > 0 ? first : 1;
  const changePercent = ((last - first) / baseline) * 100;

  if (changePercent > 5) return 'increasing';
  if (changePercent < -5) return 'decreasing';
  return 'stable';
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Monitor memory usage from both backend and frontend
 *
 * @param options - Configuration options
 * @returns Memory monitoring state and controls
 *
 * @example
 * ```tsx
 * const { stats, isMonitoring, start, stop, cleanup } = useMemoryMonitor({
 *   intervalMs: 5000,
 *   autoStart: true,
 * });
 *
 * if (stats) {
 *   console.log('Pool hit rate:', stats.poolStats.hitRate);
 *   console.log('Cache entries:', stats.cacheStats.entryCount);
 * }
 * ```
 */
export function useMemoryMonitor(options: UseMemoryMonitorOptions = {}): UseMemoryMonitorResult {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    autoStart = true,
    includeJSHeap = true,
  } = options;

  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<MemoryStats[]>([]);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Fetch current memory stats from backend
   */
  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const backendStats = await invoke<{
        poolStats: PoolStats;
        cacheStats: CacheStats;
        allocatedBytes: number;
        systemMemory: SystemMemory | null;
      }>('get_memory_stats');

      const newStats: MemoryStats = {
        poolStats: backendStats.poolStats,
        cacheStats: backendStats.cacheStats,
        allocatedBytes: backendStats.allocatedBytes,
        systemMemory: backendStats.systemMemory,
        jsHeap: includeJSHeap ? getJSHeapStats() : null,
        timestamp: Date.now(),
      };

      setStats(newStats);
      setHistory((prev) => {
        const updated = [...prev, newStats];
        // Keep only last N samples
        if (updated.length > MAX_HISTORY_LENGTH) {
          return updated.slice(-MAX_HISTORY_LENGTH);
        }
        return updated;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [includeJSHeap]);

  /**
   * Start monitoring
   */
  const start = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    setIsMonitoring(true);
    void fetchStats(); // Initial fetch

    intervalRef.current = setInterval(() => {
      void fetchStats();
    }, intervalMs);
  }, [fetchStats, intervalMs]);

  /**
   * Stop monitoring
   */
  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsMonitoring(false);
  }, []);

  /**
   * Trigger memory cleanup
   */
  const cleanup = useCallback(async (): Promise<CleanupResult | null> => {
    try {
      const result = await invoke<CleanupResult>('trigger_memory_cleanup');

      // Refresh stats after cleanup
      await fetchStats();

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      return null;
    }
  }, [fetchStats]);

  // Auto-start on mount if enabled
  useEffect(() => {
    if (autoStart) {
      start();
    }

    return () => {
      stop();
    };
  }, [autoStart, start, stop]);

  return {
    stats,
    isMonitoring,
    isLoading,
    error,
    start,
    stop,
    refresh: fetchStats,
    cleanup,
    history,
  };
}

export default useMemoryMonitor;
