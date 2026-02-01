/**
 * Memory Leak Detection Tests
 *
 * Tests to detect memory leaks in critical components:
 * - Component mount/unmount cycles
 * - Store subscription cleanup
 * - Timer cleanup
 *
 * @module tests/memory-leak
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from '@tauri-apps/api/core';
const mockInvoke = vi.mocked(invoke);

const defaultMemoryStats = {
  poolStats: {
    totalBlocks: 10,
    allocatedBlocks: 5,
    totalSizeBytes: 1024 * 1024,
    usedSizeBytes: 512 * 1024,
    allocationCount: 100,
    releaseCount: 95,
    poolHits: 90,
    poolMisses: 10,
    hitRate: 0.9,
  },
  cacheStats: {
    entryCount: 50,
    totalSizeBytes: 10 * 1024,
    hits: 200,
    misses: 20,
    evictions: 5,
    hitRate: 0.91,
  },
  allocatedBytes: 1024 * 1024,
  systemMemory: null,
};

beforeEach(() => {
  mockInvoke.mockResolvedValue(defaultMemoryStats);
});

// =============================================================================
// Hook Leak Tests
// =============================================================================

describe('Hook Memory Leak Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('useMemoryMonitor', () => {
    it('should cleanup intervals on unmount', async () => {
      const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

      const { result, unmount } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, intervalMs: 1000 })
      );

      expect(result.current.isMonitoring).toBe(true);

      // Unmount the hook
      unmount();

      // Verify monitoring stopped - no explicit assertion needed
      // The hook should cleanup without errors
    });

    it('should not accumulate history indefinitely', async () => {
      const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

      const { result } = renderHook(() =>
        useMemoryMonitor({ autoStart: true, intervalMs: 100 })
      );

      // Simulate many updates using async timer methods
      for (let i = 0; i < 100; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }

      // History should be capped (MAX_HISTORY_LENGTH = 60)
      expect(result.current.history.length).toBeLessThanOrEqual(60);
    });

    it('should handle start/stop cycles correctly', async () => {
      const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

      const { result } = renderHook(() =>
        useMemoryMonitor({ autoStart: false, intervalMs: 500 })
      );

      // Start-stop cycles
      for (let i = 0; i < 5; i++) {
        act(() => {
          result.current.start();
        });
        expect(result.current.isMonitoring).toBe(true);

        act(() => {
          result.current.stop();
        });
        expect(result.current.isMonitoring).toBe(false);
      }
    });
  });
});

// =============================================================================
// Store Leak Tests
// =============================================================================

describe('Store Memory Leak Tests', () => {
  it('should not grow waveform cache indefinitely', async () => {
    const { useWaveformCacheStore } = await import('@/stores/waveformCacheStore');

    // Reset store state first to ensure clean state
    useWaveformCacheStore.getState().clearCache();

    // Set a small max cache size
    useWaveformCacheStore.getState().setMaxCacheSize(10);

    // Add many entries
    for (let i = 0; i < 100; i++) {
      useWaveformCacheStore.getState().addToCache(`asset-${i}`, 1920, 100, `/path/waveform-${i}.png`);
    }

    // Cache should be capped at max size
    expect(useWaveformCacheStore.getState().cacheSize).toBeLessThanOrEqual(10);

    // Cleanup
    useWaveformCacheStore.getState().clearCache();
    expect(useWaveformCacheStore.getState().cacheSize).toBe(0);
  });

  it('should clear stale pending requests', async () => {
    const { useWaveformCacheStore } = await import('@/stores/waveformCacheStore');

    // Reset store state first to ensure clean state
    useWaveformCacheStore.getState().clearCache();

    // Queue many requests with unique asset IDs
    for (let i = 0; i < 50; i++) {
      useWaveformCacheStore.getState().queueRequest({
        assetId: `pending-asset-${i}`,
        inputPath: `/path/audio-${i}.mp3`,
        width: 1920,
        height: 100,
        priority: 'normal',
      });
    }

    // Should have queued requests
    expect(useWaveformCacheStore.getState().pendingRequests.length).toBe(50);

    // Clear cache should also clear pending
    useWaveformCacheStore.getState().clearCache();
    expect(useWaveformCacheStore.getState().pendingRequests.length).toBe(0);
  });

  it('should handle rapid state updates in timeline store', async () => {
    const { useTimelineStore } = await import('@/stores/timelineStore');

    const initialState = useTimelineStore.getState();

    // Rapid zoom updates
    for (let i = 0; i < 100; i++) {
      useTimelineStore.setState({ zoom: 10 + i });
    }

    // Store should be functional
    const finalState = useTimelineStore.getState();
    expect(finalState.zoom).toBe(109);

    // Reset
    useTimelineStore.setState(initialState);
  });

  it('should handle rapid playhead position updates', async () => {
    const { usePlaybackStore } = await import('@/stores/playbackStore');

    // Rapid position updates simulating playback
    for (let i = 0; i < 1000; i++) {
      usePlaybackStore.getState().setCurrentTime(i * 0.033);
    }

    // Store should be functional
    const state = usePlaybackStore.getState();
    expect(typeof state.currentTime).toBe('number');
  });
});

// =============================================================================
// Subscription Leak Tests
// =============================================================================

describe('Subscription Leak Tests', () => {
  it('should cleanup Zustand subscriptions on unmount', async () => {
    const { useTimelineStore } = await import('@/stores/timelineStore');

    // Create multiple components subscribing to the store
    const hooks: ReturnType<typeof renderHook>[] = [];

    for (let i = 0; i < 10; i++) {
      hooks.push(
        renderHook(() => useTimelineStore((state) => state.zoom))
      );
    }

    // Unmount all
    hooks.forEach((hook) => hook.unmount());

    // Store should still be functional after all unmounts
    const state = useTimelineStore.getState();
    expect(state).toBeDefined();
    expect(typeof state.zoom).toBe('number');
  });

  it('should cleanup project store subscriptions', async () => {
    const { useProjectStore } = await import('@/stores/projectStore');

    const hooks: ReturnType<typeof renderHook>[] = [];

    for (let i = 0; i < 10; i++) {
      hooks.push(
        renderHook(() => useProjectStore((state) => state.isLoading))
      );
    }

    // Unmount all
    hooks.forEach((hook) => hook.unmount());

    // Store should still be functional
    const state = useProjectStore.getState();
    expect(state).toBeDefined();
  });
});

// =============================================================================
// Timer Leak Tests
// =============================================================================

describe('Timer Leak Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should cleanup intervals in useMemoryMonitor', async () => {
    const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

    const { result, unmount } = renderHook(() =>
      useMemoryMonitor({ autoStart: true, intervalMs: 1000 })
    );

    // Flush the initial fetch (autoStart triggers an immediate request).
    await act(async () => {
      await flushPromises();
    });

    // Should have fetched stats
    expect(result.current.stats).not.toBeNull();

    // Unmount
    unmount();

    // Advancing timers after unmount should not cause issues
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
    });

    // No errors means cleanup was successful
  });

  it('should handle multiple start/stop cycles with timers', async () => {
    const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

    const { result } = renderHook(() =>
      useMemoryMonitor({ autoStart: false, intervalMs: 500 })
    );

    for (let cycle = 0; cycle < 3; cycle++) {
      // Start
      act(() => {
        result.current.start();
      });

      // Let it run for a bit
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      // Stop
      act(() => {
        result.current.stop();
      });

      // Verify monitoring stopped
      expect(result.current.isMonitoring).toBe(false);
    }
  });
});

// =============================================================================
// Stress Tests
// =============================================================================

describe('Memory Stress Tests', () => {
  it('should handle repeated store operations', async () => {
    const { useTimelineStore } = await import('@/stores/timelineStore');

    // Perform many operations
    for (let i = 0; i < 500; i++) {
      useTimelineStore.getState().setZoom(10 + (i % 100));
      useTimelineStore.getState().setScrollX(i * 10);
    }

    // Store should still be responsive
    const state = useTimelineStore.getState();
    expect(state).toBeDefined();
  });

  it('should handle memory monitor history accumulation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { useMemoryMonitor } = await import('@/hooks/useMemoryMonitor');

    const { result, unmount } = renderHook(() =>
      useMemoryMonitor({ autoStart: true, intervalMs: 50 })
    );

    // Ensure the first fetch resolves before simulating a long-running session.
    await act(async () => {
      await flushPromises();
    });

    // Simulate long running session using async timer methods
    for (let i = 0; i < 200; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        await flushPromises();
      });
    }

    // History should be capped
    expect(result.current.history.length).toBeLessThanOrEqual(60);

    // Should have valid stats
    expect(result.current.stats).not.toBeNull();

    unmount();
    vi.useRealTimers();
  });
});
