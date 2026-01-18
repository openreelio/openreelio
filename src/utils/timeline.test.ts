/**
 * Timeline Utility Tests
 *
 * TDD: Tests for timeline time/pixel conversion and snapping utilities
 * Based on react-timeline-editor patterns
 */

import { describe, it, expect } from 'vitest';
import {
  timeToPixel,
  pixelToTime,
  snapToGrid,
  clampTime,
  calculateClipBounds,
  calculateDragDelta,
  type TimelineScale,
} from './timeline';

// =============================================================================
// Time <-> Pixel Conversion Tests
// =============================================================================

describe('timeToPixel', () => {
  it('converts time to pixels at default zoom (100px/sec)', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    expect(timeToPixel(0, scale)).toBe(0);
    expect(timeToPixel(1, scale)).toBe(100);
    expect(timeToPixel(5, scale)).toBe(500);
    expect(timeToPixel(0.5, scale)).toBe(50);
  });

  it('converts time to pixels at different zoom levels', () => {
    expect(timeToPixel(1, { zoom: 50, scrollX: 0 })).toBe(50);
    expect(timeToPixel(1, { zoom: 200, scrollX: 0 })).toBe(200);
    expect(timeToPixel(2, { zoom: 150, scrollX: 0 })).toBe(300);
  });

  it('handles scroll offset correctly', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 50 };
    // scrollX is subtracted from result for viewport-relative positioning
    expect(timeToPixel(1, scale)).toBe(50); // 100 - 50
    expect(timeToPixel(0, scale)).toBe(-50); // 0 - 50
  });

  it('handles zero and negative times', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    expect(timeToPixel(0, scale)).toBe(0);
    expect(timeToPixel(-1, scale)).toBe(-100);
  });
});

describe('pixelToTime', () => {
  it('converts pixels to time at default zoom (100px/sec)', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    expect(pixelToTime(0, scale)).toBe(0);
    expect(pixelToTime(100, scale)).toBe(1);
    expect(pixelToTime(500, scale)).toBe(5);
    expect(pixelToTime(50, scale)).toBe(0.5);
  });

  it('converts pixels to time at different zoom levels', () => {
    expect(pixelToTime(50, { zoom: 50, scrollX: 0 })).toBe(1);
    expect(pixelToTime(200, { zoom: 200, scrollX: 0 })).toBe(1);
    expect(pixelToTime(300, { zoom: 150, scrollX: 0 })).toBe(2);
  });

  it('handles scroll offset correctly', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 50 };
    // scrollX is added to pixel for absolute timeline position
    expect(pixelToTime(50, scale)).toBe(1); // (50 + 50) / 100
    expect(pixelToTime(0, scale)).toBe(0.5); // (0 + 50) / 100
  });

  it('roundtrip conversion is accurate', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    const originalTime = 3.5;
    const pixel = timeToPixel(originalTime, scale);
    const convertedTime = pixelToTime(pixel, scale);
    expect(convertedTime).toBeCloseTo(originalTime, 10);
  });
});

// =============================================================================
// Grid Snapping Tests
// =============================================================================

describe('snapToGrid', () => {
  it('snaps to 1-second grid', () => {
    expect(snapToGrid(0.3, 1)).toBe(0);
    expect(snapToGrid(0.5, 1)).toBe(1);
    expect(snapToGrid(0.7, 1)).toBe(1);
    expect(snapToGrid(1.2, 1)).toBe(1);
    expect(snapToGrid(1.5, 1)).toBe(2);
  });

  it('snaps to 0.5-second grid', () => {
    expect(snapToGrid(0.2, 0.5)).toBe(0);
    expect(snapToGrid(0.25, 0.5)).toBe(0.5);
    expect(snapToGrid(0.3, 0.5)).toBe(0.5);
    expect(snapToGrid(0.7, 0.5)).toBe(0.5);
    expect(snapToGrid(0.8, 0.5)).toBe(1);
  });

  it('snaps to 0.1-second grid (frame-level)', () => {
    expect(snapToGrid(0.04, 0.1)).toBeCloseTo(0, 5);
    expect(snapToGrid(0.06, 0.1)).toBeCloseTo(0.1, 5);
    expect(snapToGrid(0.14, 0.1)).toBeCloseTo(0.1, 5);
    expect(snapToGrid(0.16, 0.1)).toBeCloseTo(0.2, 5);
  });

  it('handles zero and negative values', () => {
    expect(snapToGrid(0, 1)).toBe(0);
    expect(snapToGrid(-0.3, 1)).toBeCloseTo(0, 10);
    expect(snapToGrid(-0.7, 1)).toBe(-1);
  });

  it('returns original value when grid is 0', () => {
    expect(snapToGrid(1.234, 0)).toBe(1.234);
  });
});

// =============================================================================
// Time Clamping Tests
// =============================================================================

describe('clampTime', () => {
  it('clamps time within bounds', () => {
    expect(clampTime(5, 0, 10)).toBe(5);
    expect(clampTime(-1, 0, 10)).toBe(0);
    expect(clampTime(15, 0, 10)).toBe(10);
  });

  it('handles edge cases', () => {
    expect(clampTime(0, 0, 10)).toBe(0);
    expect(clampTime(10, 0, 10)).toBe(10);
  });

  it('uses default min of 0 and max of Infinity', () => {
    expect(clampTime(-5)).toBe(0);
    expect(clampTime(1000000)).toBe(1000000);
    expect(clampTime(5)).toBe(5);
  });
});

// =============================================================================
// Clip Bounds Calculation Tests
// =============================================================================

describe('calculateClipBounds', () => {
  it('calculates bounds for a clip with no constraints', () => {
    const bounds = calculateClipBounds({
      clipDuration: 10,
      timelineStart: 0,
      timelineDuration: 60,
      sourceDuration: 30,
      sourceIn: 0,
    });

    expect(bounds.minTimelineIn).toBe(0);
    expect(bounds.maxTimelineIn).toBe(50); // 60 - 10
    expect(bounds.maxExtendLeft).toBe(0); // sourceIn is 0
    expect(bounds.maxExtendRight).toBe(20); // 30 - 10
  });

  it('calculates bounds when clip has source offset', () => {
    const bounds = calculateClipBounds({
      clipDuration: 10,
      timelineStart: 5,
      timelineDuration: 60,
      sourceDuration: 30,
      sourceIn: 5,
    });

    expect(bounds.minTimelineIn).toBe(0);
    expect(bounds.maxTimelineIn).toBe(50);
    expect(bounds.maxExtendLeft).toBe(5); // Can extend left by 5 seconds
    expect(bounds.maxExtendRight).toBe(15); // 30 - 5 - 10
  });

  it('handles minimum duration constraint', () => {
    const bounds = calculateClipBounds({
      clipDuration: 1,
      timelineStart: 0,
      timelineDuration: 60,
      sourceDuration: 30,
      sourceIn: 0,
      minClipDuration: 0.5,
    });

    expect(bounds.minClipDuration).toBe(0.5);
  });
});

// =============================================================================
// Drag Delta Calculation Tests
// =============================================================================

describe('calculateDragDelta', () => {
  it('accumulates delta until threshold is reached', () => {
    const threshold = 5;

    // First small movement - not enough
    let result = calculateDragDelta(3, 0, threshold);
    expect(result.shouldUpdate).toBe(false);
    expect(result.accumulatedDelta).toBe(3);

    // Second movement - still not enough
    result = calculateDragDelta(1, 3, threshold);
    expect(result.shouldUpdate).toBe(false);
    expect(result.accumulatedDelta).toBe(4);

    // Third movement - crosses threshold
    result = calculateDragDelta(2, 4, threshold);
    expect(result.shouldUpdate).toBe(true);
    expect(result.snappedDelta).toBe(5);
    expect(result.accumulatedDelta).toBe(1); // Remainder
  });

  it('handles negative deltas', () => {
    const threshold = 5;

    let result = calculateDragDelta(-3, 0, threshold);
    expect(result.shouldUpdate).toBe(false);
    expect(result.accumulatedDelta).toBe(-3);

    result = calculateDragDelta(-3, -3, threshold);
    expect(result.shouldUpdate).toBe(true);
    expect(result.snappedDelta).toBe(-5);
    expect(result.accumulatedDelta).toBe(-1);
  });

  it('handles large single movement', () => {
    const threshold = 5;
    const result = calculateDragDelta(12, 0, threshold);

    expect(result.shouldUpdate).toBe(true);
    expect(result.snappedDelta).toBe(10); // 2 * threshold
    expect(result.accumulatedDelta).toBe(2); // Remainder
  });

  it('returns zero-based result when threshold is 0', () => {
    const result = calculateDragDelta(3, 0, 0);
    expect(result.shouldUpdate).toBe(true);
    expect(result.snappedDelta).toBe(3);
    expect(result.accumulatedDelta).toBe(0);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('timeline utils integration', () => {
  it('converts time to pixel and back accurately', () => {
    const scale: TimelineScale = { zoom: 120, scrollX: 30 };
    const times = [0, 1, 5.5, 10.123, 100];

    for (const time of times) {
      const pixel = timeToPixel(time, scale);
      const converted = pixelToTime(pixel, scale);
      expect(converted).toBeCloseTo(time, 10);
    }
  });

  it('works with typical video editing scenario', () => {
    // Simulate: 10-second clip at 5 seconds on timeline
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    const clipStart = 5;
    const clipDuration = 10;

    // Calculate pixel positions
    const leftPixel = timeToPixel(clipStart, scale);
    const widthPixel = clipDuration * scale.zoom;

    expect(leftPixel).toBe(500);
    expect(widthPixel).toBe(1000);

    // Drag clip by 150 pixels with snapping to 1-second grid
    const dragDeltaPixels = 150;
    const dragDeltaTime = dragDeltaPixels / scale.zoom;
    const newStart = snapToGrid(clipStart + dragDeltaTime, 1);

    expect(newStart).toBe(7); // 5 + 1.5 snapped to 7
  });
});
