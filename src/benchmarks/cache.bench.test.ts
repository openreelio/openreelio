/**
 * Cache Performance Benchmarks
 *
 * Performance tests for caching systems including:
 * - Waveform cache LRU operations
 * - Priority queue operations
 * - Large cache operations
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { useWaveformCacheStore } from '@/stores/waveformCacheStore';

// =============================================================================
// Test Utilities
// =============================================================================

/** Measure execution time in milliseconds */
function measureTime(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** Calculate statistics for an array of numbers */
function calculateStats(values: number[]): {
  mean: number;
  median: number;
  min: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  return { mean, median, min, max };
}

const getStore = () => useWaveformCacheStore.getState();

// =============================================================================
// Benchmark Tests
// =============================================================================

describe('Waveform Cache Performance Benchmarks', () => {
  beforeEach(() => {
    act(() => {
      getStore().clearCache();
      getStore().resetStats();
      getStore().setMaxCacheSize(1000);
    });
  });

  describe('Cache Operations', () => {
    it('should add entries quickly', () => {
      const times: number[] = [];
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const time = measureTime(() => {
          act(() => {
            getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
          });
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('Cache add operations:');
      console.log(`  Total entries: ${iterations}`);
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Median: ${stats.median.toFixed(3)}ms`);
      console.log(`  Max: ${stats.max.toFixed(3)}ms`);

      // Each add should be under 1ms
      expect(stats.median).toBeLessThan(1);
    });

    it('should retrieve entries quickly', () => {
      // Pre-fill cache
      act(() => {
        for (let i = 0; i < 500; i++) {
          getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
        }
      });

      const times: number[] = [];
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const assetIndex = Math.floor(Math.random() * 500);
        const time = measureTime(() => {
          getStore().getFromCache(`asset-${assetIndex}`, 1920, 100);
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('Cache get operations (500 entry cache):');
      console.log(`  Iterations: ${iterations}`);
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Median: ${stats.median.toFixed(3)}ms`);

      // Each get should be very fast
      expect(stats.median).toBeLessThan(0.5);
    });

    it('should handle cache misses efficiently', () => {
      const times: number[] = [];
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const time = measureTime(() => {
          getStore().getFromCache(`nonexistent-${i}`, 1920, 100);
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('Cache miss operations:');
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Median: ${stats.median.toFixed(3)}ms`);

      // Cache misses should be fast too
      expect(stats.median).toBeLessThan(0.5);
    });
  });

  describe('LRU Eviction', () => {
    it('should perform LRU eviction efficiently', () => {
      // Set small cache size
      act(() => {
        getStore().setMaxCacheSize(100);
      });

      const times: number[] = [];

      // Fill cache and trigger evictions
      for (let i = 0; i < 200; i++) {
        const time = measureTime(() => {
          act(() => {
            getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
          });
        });
        times.push(time);
      }

      // Times after cache is full (when eviction occurs)
      const evictionTimes = times.slice(100);
      const stats = calculateStats(evictionTimes);

      console.log('LRU eviction performance:');
      console.log(`  Evictions: ${evictionTimes.length}`);
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Max: ${stats.max.toFixed(3)}ms`);

      // Eviction should not significantly impact performance
      expect(stats.max).toBeLessThan(5);
    });
  });

  describe('Priority Queue', () => {
    it('should queue requests efficiently', () => {
      const times: number[] = [];
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const priority = ['high', 'normal', 'low'][i % 3] as 'high' | 'normal' | 'low';
        const time = measureTime(() => {
          act(() => {
            getStore().queueRequest({
              assetId: `asset-${i}`,
              inputPath: `/path/${i}.mp3`,
              width: 1920,
              height: 100,
              priority,
            });
          });
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('Queue request operations:');
      console.log(`  Total requests: ${iterations}`);
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Max: ${stats.max.toFixed(3)}ms`);

      // Queue operations should be fast
      expect(stats.median).toBeLessThan(1);
    });

    it('should maintain priority order efficiently', () => {
      // Clear any existing requests
      act(() => {
        getStore().clearCache();
      });

      // Add many requests with mixed priorities
      act(() => {
        for (let i = 0; i < 100; i++) {
          const priority = i % 3 === 0 ? 'high' : i % 3 === 1 ? 'normal' : 'low';
          getStore().queueRequest({
            assetId: `asset-${i}`,
            inputPath: `/path/${i}.mp3`,
            width: 1920,
            height: 100,
            priority: priority as 'high' | 'normal' | 'low',
          });
        }
      });

      const requests = getStore().pendingRequests;

      // Verify high priority items come first
      let lastPriorityValue = 0;
      const priorityOrder = { high: 0, normal: 1, low: 2 };

      for (const request of requests) {
        const currentPriority = priorityOrder[request.priority];
        expect(currentPriority).toBeGreaterThanOrEqual(lastPriorityValue);
        lastPriorityValue = currentPriority;
      }
    });
  });

  describe('Bulk Operations', () => {
    it('should handle bulk cache clearing efficiently', () => {
      // Fill cache with many entries
      act(() => {
        for (let i = 0; i < 1000; i++) {
          getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
        }
      });

      expect(getStore().cacheSize).toBe(1000);

      const clearTime = measureTime(() => {
        act(() => {
          getStore().clearCache();
        });
      });

      console.log('Bulk cache clear (1000 entries):');
      console.log(`  Time: ${clearTime.toFixed(3)}ms`);

      expect(clearTime).toBeLessThan(10);
      expect(getStore().cacheSize).toBe(0);
    });
  });
});

describe('Statistics Tracking Performance', () => {
  beforeEach(() => {
    act(() => {
      getStore().clearCache();
      getStore().resetStats();
    });
  });

  it('should track statistics with minimal overhead', () => {
    const iterations = 1000;

    // Measure operations with stats tracking
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const time = measureTime(() => {
        act(() => {
          getStore().addToCache(`asset-${i}`, 1920, 100, `/path/${i}.png`);
          getStore().getFromCache(`asset-${i}`, 1920, 100);
          getStore().getFromCache(`nonexistent-${i}`, 1920, 100);
        });
      });
      times.push(time);
    }

    const stats = calculateStats(times);

    console.log('Operations with stats tracking:');
    console.log(`  Mean per iteration: ${stats.mean.toFixed(3)}ms`);

    // Stats tracking should add minimal overhead
    expect(stats.mean).toBeLessThan(2);

    // Verify stats are being tracked
    expect(getStore().stats.cacheHits).toBe(iterations);
    expect(getStore().stats.cacheMisses).toBe(iterations);
  });
});
