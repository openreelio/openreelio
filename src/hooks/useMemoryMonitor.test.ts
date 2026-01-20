/**
 * useMemoryMonitor Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMemoryMonitor, formatBytes, calculateTrend, MemoryStats, CleanupResult } from './useMemoryMonitor';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = vi.mocked(invoke);

// Helper to flush pending promises
const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// =============================================================================
// Test Data
// =============================================================================

const mockMemoryStats = {
  poolStats: {
    totalBlocks: 100,
    allocatedBlocks: 50,
    totalSizeBytes: 1024 * 1024 * 100, // 100MB
    usedSizeBytes: 1024 * 1024 * 50, // 50MB
    allocationCount: 1000,
    releaseCount: 950,
    poolHits: 900,
    poolMisses: 100,
    hitRate: 0.9,
  },
  cacheStats: {
    entryCount: 200,
    totalSizeBytes: 1024 * 1024 * 20, // 20MB
    hits: 500,
    misses: 50,
    evictions: 25,
    hitRate: 0.91,
  },
  allocatedBytes: 1024 * 1024 * 70, // 70MB
  systemMemory: {
    totalBytes: 1024 * 1024 * 1024 * 16, // 16GB
    availableBytes: 1024 * 1024 * 1024 * 8, // 8GB
    usedBytes: 1024 * 1024 * 1024 * 8, // 8GB
    usagePercent: 50,
  },
};

const mockCleanupResult = {
  poolBytesFreed: 1024 * 1024 * 10, // 10MB
  cacheEntriesEvicted: 15,
  totalBytesFreed: 1024 * 1024 * 15, // 15MB
};

// =============================================================================
// Test Suite
// =============================================================================

describe('useMemoryMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(mockMemoryStats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial State', () => {
    it('should have null stats initially', () => {
      const { result } = renderHook(() =>
        useMemoryMonitor({ autoStart: false })
      );

      expect(result.current.stats).toBeNull();
      expect(result.current.isMonitoring).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.history).toHaveLength(0);
    });

    it('should auto-start when autoStart is true (default)', async () => {
      const { result, unmount } = renderHook(() => useMemoryMonitor());

      expect(result.current.isMonitoring).toBe(true);

      // Wait for initial fetch to complete
      await act(async () => {
        await flushPromises();
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_memory_stats');
      unmount();
    });
  });

  describe('Fetching Stats', () => {
    it('should fetch stats on start', async () => {
      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: false })
      );

      act(() => {
        result.current.start();
      });

      // Wait for fetch to complete
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.stats).not.toBeNull();
      expect(result.current.stats?.poolStats.hitRate).toBe(0.9);
      expect(result.current.stats?.cacheStats.entryCount).toBe(200);
      expect(result.current.stats?.allocatedBytes).toBe(1024 * 1024 * 70);
      unmount();
    });

    it('should update stats periodically', async () => {
      vi.useFakeTimers();
      const { unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, intervalMs: 1000 })
      );

      // Initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(mockInvoke).toHaveBeenCalledTimes(1);

      // Advance timer
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await flushPromises();
      });

      expect(mockInvoke).toHaveBeenCalledTimes(2);

      // Advance timer again
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await flushPromises();
      });

      expect(mockInvoke).toHaveBeenCalledTimes(3);
      unmount();
    });

    it('should handle fetch errors gracefully', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Backend unavailable'));

      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true })
      );

      // Wait for initial fetch to complete
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.error).toBe('Backend unavailable');
      expect(result.current.stats).toBeNull();
      unmount();
    });

    it('should manually refresh stats', async () => {
      const { result } = renderHook(() =>
        useMemoryMonitor({ autoStart: false })
      );

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.stats).not.toBeNull();
      expect(mockInvoke).toHaveBeenCalledWith('get_memory_stats');
    });
  });

  describe('Monitoring Control', () => {
    it('should stop monitoring', async () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, intervalMs: 1000 })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.isMonitoring).toBe(true);

      act(() => {
        result.current.stop();
      });

      expect(result.current.isMonitoring).toBe(false);

      // Clear mock count
      const invokeCallCount = mockInvoke.mock.calls.length;

      // Advance timer - should not fetch more
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await flushPromises();
      });

      // Call count should not have increased
      expect(mockInvoke.mock.calls.length).toBe(invokeCallCount);
      unmount();
    });

    it('should restart monitoring after stop', async () => {
      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: false, intervalMs: 1000 })
      );

      act(() => {
        result.current.start();
      });

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.isMonitoring).toBe(true);

      act(() => {
        result.current.stop();
      });

      expect(result.current.isMonitoring).toBe(false);

      act(() => {
        result.current.start();
      });

      expect(result.current.isMonitoring).toBe(true);
      unmount();
    });
  });

  describe('Memory Cleanup', () => {
    it('should trigger cleanup and refresh stats', async () => {
      mockInvoke
        .mockResolvedValueOnce(mockMemoryStats) // Initial fetch
        .mockResolvedValueOnce(mockCleanupResult) // Cleanup
        .mockResolvedValueOnce(mockMemoryStats); // Refresh after cleanup

      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.stats).not.toBeNull();

      let cleanupResult: CleanupResult | null = null;
      await act(async () => {
        cleanupResult = await result.current.cleanup();
      });

      expect(cleanupResult).not.toBeNull();
      expect(cleanupResult!.poolBytesFreed).toBe(1024 * 1024 * 10);
      expect(cleanupResult!.cacheEntriesEvicted).toBe(15);

      expect(mockInvoke).toHaveBeenCalledWith('trigger_memory_cleanup');
      unmount();
    });

    it('should handle cleanup errors', async () => {
      mockInvoke
        .mockResolvedValueOnce(mockMemoryStats) // Initial fetch
        .mockRejectedValueOnce(new Error('Cleanup failed')); // Cleanup

      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.stats).not.toBeNull();

      let cleanupResult;
      await act(async () => {
        cleanupResult = await result.current.cleanup();
      });

      expect(cleanupResult).toBeNull();
      expect(result.current.error).toBe('Cleanup failed');
      unmount();
    });
  });

  describe('History Tracking', () => {
    it('should accumulate history', async () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, intervalMs: 1000 })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.history).toHaveLength(1);

      // Advance and fetch more
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          vi.advanceTimersByTime(1000);
          await flushPromises();
        });
        expect(result.current.history).toHaveLength(i + 2);
      }

      expect(result.current.history).toHaveLength(6);
      unmount();
    });

    it('should limit history length', async () => {
      const { result } = renderHook(() =>
        useMemoryMonitor({ autoStart: false })
      );

      // Manually add many samples
      for (let i = 0; i < 70; i++) {
        await act(async () => {
          await result.current.refresh();
        });
      }

      // Should be limited to MAX_HISTORY_LENGTH (60)
      expect(result.current.history.length).toBeLessThanOrEqual(60);
    });
  });

  describe('JS Heap Stats', () => {
    it('should include JS heap when available', async () => {
      // Mock performance.memory
      const originalPerformance = global.performance;
      Object.defineProperty(global, 'performance', {
        value: {
          ...originalPerformance,
          memory: {
            usedJSHeapSize: 50 * 1024 * 1024, // 50MB
            totalJSHeapSize: 100 * 1024 * 1024, // 100MB
            jsHeapSizeLimit: 2048 * 1024 * 1024, // 2GB
          },
        },
        writable: true,
      });

      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, includeJSHeap: true })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.stats).not.toBeNull();
      expect(result.current.stats?.jsHeap).not.toBeNull();
      expect(result.current.stats?.jsHeap?.usedJSHeapSize).toBe(50 * 1024 * 1024);

      unmount();

      // Restore
      Object.defineProperty(global, 'performance', {
        value: originalPerformance,
        writable: true,
      });
    });

    it('should skip JS heap when disabled', async () => {
      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, includeJSHeap: false })
      );

      // Wait for initial fetch
      await act(async () => {
        await flushPromises();
      });

      expect(result.current.stats).not.toBeNull();
      expect(result.current.stats?.jsHeap).toBeNull();
      unmount();
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('formatBytes', () => {
  it('should format bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500.00 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
  });

  it('should handle decimal values', () => {
    expect(formatBytes(1024 * 512)).toBe('512.00 KB');
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.50 MB');
  });
});

describe('calculateTrend', () => {
  const createStats = (allocatedBytes: number): MemoryStats => ({
    poolStats: {
      totalBlocks: 0,
      allocatedBlocks: 0,
      totalSizeBytes: 0,
      usedSizeBytes: 0,
      allocationCount: 0,
      releaseCount: 0,
      poolHits: 0,
      poolMisses: 0,
      hitRate: 0,
    },
    cacheStats: {
      entryCount: 0,
      totalSizeBytes: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      hitRate: 0,
    },
    allocatedBytes,
    systemMemory: null,
    jsHeap: null,
    timestamp: Date.now(),
  });

  it('should return stable for insufficient history', () => {
    expect(calculateTrend([])).toBe('stable');
    expect(calculateTrend([createStats(100)])).toBe('stable');
    expect(calculateTrend([createStats(100), createStats(110)])).toBe('stable');
  });

  it('should detect increasing trend', () => {
    const history = [
      createStats(100),
      createStats(105),
      createStats(110),
      createStats(115),
      createStats(120),
    ];
    expect(calculateTrend(history)).toBe('increasing');
  });

  it('should detect decreasing trend', () => {
    const history = [
      createStats(120),
      createStats(115),
      createStats(110),
      createStats(105),
      createStats(100),
    ];
    expect(calculateTrend(history)).toBe('decreasing');
  });

  it('should return stable for minor fluctuations', () => {
    const history = [
      createStats(100),
      createStats(101),
      createStats(99),
      createStats(102),
      createStats(100),
    ];
    expect(calculateTrend(history)).toBe('stable');
  });

  it('should handle zero baseline without crashing', () => {
    const stable = [createStats(0), createStats(0), createStats(0), createStats(0), createStats(0)];
    expect(calculateTrend(stable)).toBe('stable');

    const increasing = [createStats(0), createStats(1), createStats(2), createStats(4), createStats(8)];
    expect(calculateTrend(increasing)).toBe('increasing');
  });
});
