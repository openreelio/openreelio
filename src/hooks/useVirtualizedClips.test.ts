/**
 * useVirtualizedClips Hook Tests
 *
 * Tests for horizontal timeline virtualization including:
 * - Viewport-based clip filtering
 * - Buffer zone handling
 * - Position and dimension calculations
 * - Edge cases (no clips, single clip, overlapping clips)
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  useVirtualizedClips,
  sortClipsByPosition,
  calculateTimelineExtent,
  type VirtualizationConfig,
} from './useVirtualizedClips';
import type { Clip } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockClip = (
  id: string,
  timelineInSec: number,
  sourceInSec: number = 0,
  sourceOutSec: number = 10,
  speed: number = 1
): Clip => ({
  id,
  assetId: `asset-${id}`,
  place: {
    timelineInSec,
    durationSec: (sourceOutSec - sourceInSec) / speed,
  },
  range: {
    sourceInSec,
    sourceOutSec,
  },
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0, y: 0 },
  },
  opacity: 1,
  speed,
  effects: [],
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
  },
});

const defaultConfig: VirtualizationConfig = {
  zoom: 100, // 100 pixels per second
  scrollX: 0,
  viewportWidth: 1000, // 1000px viewport = 10 seconds at zoom 100
  bufferPx: 200,
};

// =============================================================================
// Tests
// =============================================================================

describe('useVirtualizedClips', () => {
  // ===========================================================================
  // Basic Functionality
  // ===========================================================================

  describe('basic functionality', () => {
    it('should return empty array for no clips', () => {
      const { result } = renderHook(() =>
        useVirtualizedClips([], defaultConfig)
      );

      expect(result.current.visibleClips).toEqual([]);
      expect(result.current.totalClips).toBe(0);
      expect(result.current.renderedClips).toBe(0);
      expect(result.current.isVirtualized).toBe(false);
    });

    it('should return all clips when all are visible', () => {
      const clips = [
        createMockClip('1', 0, 0, 5), // 0-5 seconds
        createMockClip('2', 5, 0, 5), // 5-10 seconds
      ];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, defaultConfig)
      );

      expect(result.current.visibleClips).toHaveLength(2);
      expect(result.current.totalClips).toBe(2);
      expect(result.current.renderedClips).toBe(2);
      expect(result.current.isVirtualized).toBe(false);
    });

    it('should filter out clips outside viewport', () => {
      const clips = [
        createMockClip('1', 0, 0, 5), // Visible: 0-5 seconds
        createMockClip('2', 20, 0, 5), // Outside: 20-25 seconds
        createMockClip('3', 5, 0, 5), // Visible: 5-10 seconds
      ];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, defaultConfig)
      );

      expect(result.current.visibleClips).toHaveLength(2);
      expect(result.current.isVirtualized).toBe(true);
      expect(result.current.visibleClips.map((c) => c.id)).toEqual(['1', '3']);
    });
  });

  // ===========================================================================
  // Position Calculations
  // ===========================================================================

  describe('position calculations', () => {
    it('should compute correct leftPx based on zoom', () => {
      const clips = [createMockClip('1', 5, 0, 10)]; // Starts at 5 seconds

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, { ...defaultConfig, zoom: 100 })
      );

      expect(result.current.visibleClips[0].leftPx).toBe(500); // 5 * 100
    });

    it('should compute correct widthPx based on zoom and speed', () => {
      // Clip with sourceIn=0, sourceOut=10, speed=1 -> duration=10s
      const clips = [createMockClip('1', 0, 0, 10, 1)];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, { ...defaultConfig, zoom: 100 })
      );

      expect(result.current.visibleClips[0].widthPx).toBe(1000); // 10 * 100
    });

    it('should account for speed in width calculation', () => {
      // Clip with sourceIn=0, sourceOut=10, speed=2 -> duration=5s
      const clips = [createMockClip('1', 0, 0, 10, 2)];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, { ...defaultConfig, zoom: 100 })
      );

      expect(result.current.visibleClips[0].widthPx).toBe(500); // 5 * 100
    });

    it('should enforce minimum clip width', () => {
      // Very short clip that would be less than 4px
      const clips = [createMockClip('1', 0, 0, 0.01, 1)]; // 0.01s = 1px at zoom 100

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, { ...defaultConfig, zoom: 100 })
      );

      expect(result.current.visibleClips[0].widthPx).toBe(4); // Minimum width
    });

    it('should include durationSec in output', () => {
      const clips = [createMockClip('1', 0, 5, 15, 1)]; // duration = 10s

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, defaultConfig)
      );

      expect(result.current.visibleClips[0].durationSec).toBe(10);
    });
  });

  // ===========================================================================
  // Scroll and Viewport
  // ===========================================================================

  describe('scroll and viewport', () => {
    it('should include clips in buffer zone before viewport', () => {
      const clips = [
        createMockClip('1', -3, 0, 5), // -3 to 2 seconds (in buffer before 0)
        createMockClip('2', 0, 0, 5), // 0-5 seconds (visible)
      ];

      const config: VirtualizationConfig = {
        ...defaultConfig,
        scrollX: 0,
        bufferPx: 400, // 4 seconds buffer
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      expect(result.current.visibleClips).toHaveLength(2);
    });

    it('should include clips in buffer zone after viewport', () => {
      const clips = [
        createMockClip('1', 5, 0, 5), // 5-10 seconds (visible)
        createMockClip('2', 12, 0, 5), // 12-17 seconds (in buffer after 10)
      ];

      const config: VirtualizationConfig = {
        ...defaultConfig,
        scrollX: 0,
        viewportWidth: 1000, // Shows 0-10 seconds
        bufferPx: 500, // 5 seconds buffer after
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      expect(result.current.visibleClips).toHaveLength(2);
    });

    it('should update visible clips when scrolling', () => {
      const clips = [
        createMockClip('1', 0, 0, 5), // 0-5 seconds
        createMockClip('2', 10, 0, 5), // 10-15 seconds
        createMockClip('3', 20, 0, 5), // 20-25 seconds
      ];

      // Initial: scroll at 0, viewport shows 0-10s + 2s buffer
      const { result, rerender } = renderHook(
        ({ config }) => useVirtualizedClips(clips, config),
        { initialProps: { config: { ...defaultConfig, bufferPx: 200 } } }
      );

      expect(result.current.visibleClips.map((c) => c.id)).toEqual(['1', '2']);

      // Scroll to 15 seconds (1500px)
      rerender({
        config: { ...defaultConfig, scrollX: 1500, bufferPx: 200 },
      });

      expect(result.current.visibleClips.map((c) => c.id)).toEqual(['2', '3']);
    });

    it('should handle viewport resize', () => {
      const clips = [
        createMockClip('1', 0, 0, 5),
        createMockClip('2', 10, 0, 5),
        createMockClip('3', 20, 0, 5),
      ];

      const { result, rerender } = renderHook(
        ({ config }) => useVirtualizedClips(clips, config),
        { initialProps: { config: { ...defaultConfig, viewportWidth: 500 } } }
      );

      // Small viewport: only first clip and maybe second in buffer
      const initialVisible = result.current.visibleClips.length;

      // Expand viewport
      rerender({
        config: { ...defaultConfig, viewportWidth: 2500 },
      });

      expect(result.current.visibleClips.length).toBeGreaterThanOrEqual(
        initialVisible
      );
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle clip exactly at viewport boundary', () => {
      const clips = [
        createMockClip('1', 10, 0, 5), // Starts exactly at right edge of viewport
      ];

      const config: VirtualizationConfig = {
        ...defaultConfig,
        scrollX: 0,
        viewportWidth: 1000, // 0-10 seconds visible
        bufferPx: 0, // No buffer
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      // Clip starts at 10s, viewport ends at 10s - clip should NOT be visible
      expect(result.current.visibleClips).toHaveLength(0);
    });

    it('should include clip partially in viewport', () => {
      const clips = [
        createMockClip('1', 8, 0, 5), // 8-13 seconds (partially visible)
      ];

      const config: VirtualizationConfig = {
        ...defaultConfig,
        scrollX: 0,
        viewportWidth: 1000, // 0-10 seconds
        bufferPx: 0,
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      expect(result.current.visibleClips).toHaveLength(1);
    });

    it('should handle overlapping clips', () => {
      const clips = [
        createMockClip('1', 0, 0, 10), // 0-10 seconds
        createMockClip('2', 5, 0, 10), // 5-15 seconds (overlapping)
        createMockClip('3', 8, 0, 5), // 8-13 seconds (overlapping both)
      ];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, defaultConfig)
      );

      expect(result.current.visibleClips).toHaveLength(3);
    });

    it('should handle very high zoom levels', () => {
      const clips = [createMockClip('1', 0, 0, 1)]; // 1 second clip

      const config: VirtualizationConfig = {
        ...defaultConfig,
        zoom: 10000, // 10000 pixels per second
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      expect(result.current.visibleClips[0].widthPx).toBe(10000);
    });

    it('should handle very low zoom levels', () => {
      const clips = [
        createMockClip('1', 0, 0, 60), // 60 second clip (0-60s = 0-600px at zoom 10)
        createMockClip('2', 80, 0, 60), // 60 second clip (80-140s = 800-1400px at zoom 10)
      ];

      const config: VirtualizationConfig = {
        zoom: 10, // 10 pixels per second (very zoomed out)
        scrollX: 0,
        viewportWidth: 1000, // Shows 0-1000px = 0-100 seconds
        bufferPx: 500, // 500px buffer = 50 seconds
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      // viewport: 0-1000px, buffer: -500 to 1500px = -50 to 150 seconds
      // clip1: 0-600px (visible), clip2: 800-1400px (visible in buffer)
      expect(result.current.visibleClips).toHaveLength(2);
    });

    it('should handle negative timeline positions', () => {
      const clips = [
        createMockClip('1', -5, 0, 10), // -5 to 5 seconds
      ];

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, defaultConfig)
      );

      expect(result.current.visibleClips).toHaveLength(1);
      expect(result.current.visibleClips[0].leftPx).toBe(-500);
    });
  });

  // ===========================================================================
  // Performance Characteristics
  // ===========================================================================

  describe('performance characteristics', () => {
    it('should efficiently filter large clip arrays', () => {
      // Create 1000 clips spread across a wide timeline
      const clips = Array.from({ length: 1000 }, (_, i) =>
        createMockClip(`clip-${i}`, i * 5, 0, 4) // 4 second clips every 5 seconds
      );

      const config: VirtualizationConfig = {
        zoom: 100,
        scrollX: 0,
        viewportWidth: 1000, // Only 10 seconds visible
        bufferPx: 200,
      };

      const { result } = renderHook(() =>
        useVirtualizedClips(clips, config)
      );

      // Should only render clips in viewport + buffer (~3-4 clips)
      expect(result.current.renderedClips).toBeLessThan(10);
      expect(result.current.isVirtualized).toBe(true);
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('sortClipsByPosition', () => {
  it('should sort clips by leftPx', () => {
    const clips = [
      { ...createMockClip('3', 10, 0, 5), leftPx: 1000, widthPx: 500, durationSec: 5 },
      { ...createMockClip('1', 0, 0, 5), leftPx: 0, widthPx: 500, durationSec: 5 },
      { ...createMockClip('2', 5, 0, 5), leftPx: 500, widthPx: 500, durationSec: 5 },
    ];

    const sorted = sortClipsByPosition(clips);

    expect(sorted.map((c) => c.id)).toEqual(['1', '2', '3']);
  });

  it('should not mutate original array', () => {
    const clips = [
      { ...createMockClip('2', 5, 0, 5), leftPx: 500, widthPx: 500, durationSec: 5 },
      { ...createMockClip('1', 0, 0, 5), leftPx: 0, widthPx: 500, durationSec: 5 },
    ];

    const original = [...clips];
    sortClipsByPosition(clips);

    expect(clips).toEqual(original);
  });
});

describe('calculateTimelineExtent', () => {
  it('should return zeros for empty clip array', () => {
    const result = calculateTimelineExtent([]);

    expect(result).toEqual({
      minTimeSec: 0,
      maxTimeSec: 0,
      totalDurationSec: 0,
    });
  });

  it('should calculate extent for single clip', () => {
    const clips = [createMockClip('1', 5, 0, 10)]; // 5-15 seconds

    const result = calculateTimelineExtent(clips);

    expect(result).toEqual({
      minTimeSec: 5,
      maxTimeSec: 15,
      totalDurationSec: 10,
    });
  });

  it('should calculate extent for multiple clips', () => {
    const clips = [
      createMockClip('1', 0, 0, 5), // 0-5 seconds
      createMockClip('2', 10, 0, 10), // 10-20 seconds
      createMockClip('3', 5, 0, 3), // 5-8 seconds
    ];

    const result = calculateTimelineExtent(clips);

    expect(result).toEqual({
      minTimeSec: 0,
      maxTimeSec: 20,
      totalDurationSec: 20,
    });
  });

  it('should account for speed in duration calculation', () => {
    const clips = [createMockClip('1', 0, 0, 10, 2)]; // 0-5 seconds (10s at 2x speed)

    const result = calculateTimelineExtent(clips);

    expect(result.maxTimeSec).toBe(5);
  });
});
