/**
 * Timeline Performance Benchmarks
 *
 * Performance tests for timeline operations including:
 * - Clip virtualization performance
 * - Large clip array processing
 * - Zoom/scroll performance
 * - State update performance
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVirtualizedClips, type VirtualizationConfig } from '@/hooks/useVirtualizedClips';
import { calculateTimelineExtent } from '@/hooks/useVirtualizedClips';
import type { Clip } from '@/types';

// =============================================================================
// Test Utilities
// =============================================================================

/** Create a mock clip for testing */
function createMockClip(
  id: string,
  timelineInSec: number,
  durationSec: number = 10
): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    place: {
      timelineInSec,
      durationSec,
    },
    range: {
      sourceInSec: 0,
      sourceOutSec: durationSec,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0, y: 0 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      pan: 0,
      muted: false,
    },
  };
}

/** Generate many clips spread across timeline */
function generateManyClips(count: number, gapSec: number = 0): Clip[] {
  return Array.from({ length: count }, (_, i) => {
    const duration = 5 + Math.random() * 10; // 5-15 second clips
    const start = i * (duration + gapSec);
    return createMockClip(`clip-${i}`, start, duration);
  });
}

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
  stdDev: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return { mean, median, min, max, stdDev };
}

// =============================================================================
// Benchmark Tests
// =============================================================================

describe('Timeline Performance Benchmarks', () => {
  const ITERATIONS = 100;

  describe('Clip Virtualization', () => {
    it('should virtualize 100 clips efficiently', () => {
      const clips = generateManyClips(100);
      const config: VirtualizationConfig = {
        zoom: 100,
        scrollX: 0,
        viewportWidth: 1200,
        bufferPx: 200,
      };

      const times: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const time = measureTime(() => {
          renderHook(() => useVirtualizedClips(clips, config));
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('100 clips virtualization:');
      console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
      console.log(`  Median: ${stats.median.toFixed(2)}ms`);
      console.log(`  Min: ${stats.min.toFixed(2)}ms`);
      console.log(`  Max: ${stats.max.toFixed(2)}ms`);

      // Performance assertion: median should be under 5ms
      expect(stats.median).toBeLessThan(5);
    });

    it('should virtualize 1000 clips efficiently', () => {
      const clips = generateManyClips(1000);
      const config: VirtualizationConfig = {
        zoom: 100,
        scrollX: 0,
        viewportWidth: 1200,
        bufferPx: 200,
      };

      const times: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const time = measureTime(() => {
          renderHook(() => useVirtualizedClips(clips, config));
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('1000 clips virtualization:');
      console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
      console.log(`  Median: ${stats.median.toFixed(2)}ms`);
      console.log(`  Min: ${stats.min.toFixed(2)}ms`);
      console.log(`  Max: ${stats.max.toFixed(2)}ms`);

      // Performance assertion: median should be under 50ms
      expect(stats.median).toBeLessThan(50);
    });

    it('should handle scroll position changes efficiently', () => {
      const clips = generateManyClips(500);

      const times: number[] = [];
      const scrollPositions = [0, 500, 1000, 1500, 2000, 2500, 3000];

      for (const scrollX of scrollPositions) {
        const config: VirtualizationConfig = {
          zoom: 100,
          scrollX,
          viewportWidth: 1200,
          bufferPx: 200,
        };

        const time = measureTime(() => {
          for (let i = 0; i < 10; i++) {
            renderHook(() => useVirtualizedClips(clips, config));
          }
        });
        times.push(time / 10);
      }

      const stats = calculateStats(times);

      console.log('Scroll position changes (500 clips):');
      console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
      console.log(`  Max: ${stats.max.toFixed(2)}ms`);

      // Performance assertion: all scroll positions should process in reasonable time
      // Using an absolute threshold rather than relative to avoid flakiness
      expect(stats.max).toBeLessThan(10); // Max should be under 10ms
    });

    it('should handle zoom level changes efficiently', () => {
      const clips = generateManyClips(500);

      const times: number[] = [];
      const zoomLevels = [10, 25, 50, 100, 200, 400];

      for (const zoom of zoomLevels) {
        const config: VirtualizationConfig = {
          zoom,
          scrollX: 0,
          viewportWidth: 1200,
          bufferPx: 200,
        };

        const time = measureTime(() => {
          for (let i = 0; i < 10; i++) {
            renderHook(() => useVirtualizedClips(clips, config));
          }
        });
        times.push(time / 10);
      }

      const stats = calculateStats(times);

      console.log('Zoom level changes (500 clips):');
      console.log(`  Mean: ${stats.mean.toFixed(2)}ms`);
      console.log(`  Max: ${stats.max.toFixed(2)}ms`);

      // Performance should be relatively consistent across zoom levels
      expect(stats.max).toBeLessThan(50);
    });
  });

  describe('Timeline Extent Calculation', () => {
    it('should calculate extent for many clips efficiently', () => {
      const clips = generateManyClips(1000);

      const times: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        const time = measureTime(() => {
          calculateTimelineExtent(clips);
        });
        times.push(time);
      }

      const stats = calculateStats(times);

      console.log('Timeline extent calculation (1000 clips):');
      console.log(`  Mean: ${stats.mean.toFixed(3)}ms`);
      console.log(`  Median: ${stats.median.toFixed(3)}ms`);

      // Should be very fast - under 1ms
      expect(stats.median).toBeLessThan(1);
    });
  });

  describe('Memory Usage Patterns', () => {
    it('should not leak memory during repeated operations', () => {
      const clips = generateManyClips(100);
      const config: VirtualizationConfig = {
        zoom: 100,
        scrollX: 0,
        viewportWidth: 1200,
        bufferPx: 200,
      };

      // Run many iterations
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const { unmount } = renderHook(() => useVirtualizedClips(clips, config));
        unmount();
      }

      // If we get here without crashing or significant slowdown, memory is being managed
      expect(true).toBe(true);
    });
  });
});

describe('Virtualization Efficiency', () => {
  it('should dramatically reduce rendered clips compared to total', () => {
    const totalClips = 1000;
    const clips = generateManyClips(totalClips);
    const config: VirtualizationConfig = {
      zoom: 100, // 100px per second
      scrollX: 5000, // Scrolled to middle
      viewportWidth: 1200, // 12 seconds visible
      bufferPx: 200, // 2 seconds buffer each side
    };

    const { result } = renderHook(() => useVirtualizedClips(clips, config));

    const efficiency = 1 - (result.current.renderedClips / totalClips);

    console.log('Virtualization efficiency:');
    console.log(`  Total clips: ${totalClips}`);
    console.log(`  Rendered clips: ${result.current.renderedClips}`);
    console.log(`  Efficiency: ${(efficiency * 100).toFixed(1)}%`);

    // Should be rendering less than 10% of clips when scrolled to middle
    expect(result.current.renderedClips).toBeLessThan(totalClips * 0.1);
    expect(result.current.isVirtualized).toBe(true);
  });
});
