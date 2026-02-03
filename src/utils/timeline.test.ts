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
  findNearestSnapPoint,
  findNearestSnapPointWithInfo,
  calculateClipDuration,
  calculateClipEndTime,
  isTimeWithinClip,
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

// =============================================================================
// Edge Case / Defensive Tests
// =============================================================================

describe('defensive: timeToPixel edge cases', () => {
  it('handles NaN inputs gracefully', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    expect(timeToPixel(NaN, scale)).toBe(0);
    expect(timeToPixel(5, { zoom: NaN, scrollX: 0 })).toBe(0);
    expect(timeToPixel(5, { zoom: 100, scrollX: NaN })).toBe(0);
  });

  it('handles Infinity inputs gracefully', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    expect(timeToPixel(Infinity, scale)).toBe(0);
    expect(timeToPixel(-Infinity, scale)).toBe(0);
    expect(timeToPixel(5, { zoom: Infinity, scrollX: 0 })).toBe(0);
  });

  it('handles very large numbers without overflow', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 0 };
    const result = timeToPixel(1e15, scale);
    expect(Number.isFinite(result)).toBe(true);
  });
});

describe('defensive: pixelToTime edge cases', () => {
  it('handles zero zoom (division by zero)', () => {
    expect(pixelToTime(500, { zoom: 0, scrollX: 0 })).toBe(0);
  });

  it('handles negative zoom', () => {
    expect(pixelToTime(500, { zoom: -100, scrollX: 0 })).toBe(0);
  });

  it('handles NaN inputs gracefully', () => {
    expect(pixelToTime(NaN, { zoom: 100, scrollX: 0 })).toBe(0);
    expect(pixelToTime(500, { zoom: NaN, scrollX: 0 })).toBe(0);
  });

  it('handles Infinity inputs gracefully', () => {
    expect(pixelToTime(Infinity, { zoom: 100, scrollX: 0 })).toBe(0);
  });
});

describe('defensive: snapToGrid edge cases', () => {
  it('handles NaN time', () => {
    const result = snapToGrid(NaN, 1);
    expect(Number.isNaN(result)).toBe(true); // NaN propagates
  });

  it('handles negative grid interval', () => {
    expect(snapToGrid(5.5, -1)).toBe(5.5); // Returns original
  });

  it('handles very small grid intervals', () => {
    const result = snapToGrid(1.00001, 0.0001);
    expect(result).toBeCloseTo(1.0, 4);
  });
});

describe('defensive: calculateClipBounds edge cases', () => {
  it('handles NaN inputs', () => {
    const bounds = calculateClipBounds({
      clipDuration: NaN,
      timelineStart: 0,
      timelineDuration: 60,
      sourceDuration: 30,
      sourceIn: 0,
    });

    expect(bounds.minTimelineIn).toBe(0);
    expect(bounds.maxTimelineIn).toBe(60); // 60 - 0 (NaN clamped to 0)
    expect(Number.isFinite(bounds.maxExtendRight)).toBe(true);
  });

  it('handles negative durations', () => {
    const bounds = calculateClipBounds({
      clipDuration: -5,
      timelineStart: 0,
      timelineDuration: 60,
      sourceDuration: 30,
      sourceIn: 0,
    });

    expect(bounds.maxTimelineIn).toBe(60); // Clamped to 0 then subtracted
    expect(bounds.maxExtendRight).toBe(30); // 30 - 0 - 0
  });

  it('handles clip duration exceeding timeline duration', () => {
    const bounds = calculateClipBounds({
      clipDuration: 100,
      timelineStart: 0,
      timelineDuration: 60,
      sourceDuration: 100,
      sourceIn: 0,
    });

    expect(bounds.maxTimelineIn).toBe(0); // Can't move clip
    expect(bounds.maxExtendRight).toBe(0); // Already at max
  });
});

describe('defensive: calculateDragDelta edge cases', () => {
  it('handles NaN delta', () => {
    const result = calculateDragDelta(NaN, 0, 5);
    // NaN + 0 = NaN, abs(NaN) = NaN, which is not < threshold
    expect(result.shouldUpdate).toBe(false);
  });

  it('handles negative threshold', () => {
    const result = calculateDragDelta(3, 0, -5);
    // Negative threshold treated as 0
    expect(result.shouldUpdate).toBe(true);
    expect(result.snappedDelta).toBe(3);
  });

  it('handles very large accumulated delta', () => {
    const result = calculateDragDelta(1, 1e10, 5);
    expect(result.shouldUpdate).toBe(true);
    expect(Number.isFinite(result.snappedDelta)).toBe(true);
  });
});

// =============================================================================
// Snap Point Tests
// =============================================================================

describe('findNearestSnapPoint', () => {
  it('finds nearest snap point within threshold', () => {
    const snapPoints = [0, 5, 10, 15, 20];
    expect(findNearestSnapPoint(4.8, snapPoints, 0.5)).toBe(5);
    expect(findNearestSnapPoint(4.4, snapPoints, 0.5)).toBe(4.4); // No snap
  });

  it('returns original time when no points are close', () => {
    const snapPoints = [0, 10, 20];
    expect(findNearestSnapPoint(5, snapPoints, 0.1)).toBe(5);
  });

  it('handles empty snap points array', () => {
    expect(findNearestSnapPoint(5, [], 1)).toBe(5);
  });

  it('handles exact match', () => {
    const snapPoints = [0, 5, 10];
    expect(findNearestSnapPoint(5, snapPoints, 0.1)).toBe(5);
  });
});

describe('findNearestSnapPointWithInfo', () => {
  it('returns detailed info for snapped point', () => {
    const snapPoints = [0, 5, 10];
    const result = findNearestSnapPointWithInfo(4.9, snapPoints, 0.2);

    expect(result.snapped).toBe(true);
    expect(result.time).toBe(5);
    expect(result.snapIndex).toBe(1);
  });

  it('returns snapped=false when no snap occurs', () => {
    const snapPoints = [0, 10];
    const result = findNearestSnapPointWithInfo(5, snapPoints, 0.1);

    expect(result.snapped).toBe(false);
    expect(result.time).toBe(5);
    expect(result.snapIndex).toBe(-1);
  });

  it('handles invalid threshold', () => {
    const result = findNearestSnapPointWithInfo(5, [0, 10], 0);
    expect(result.snapped).toBe(false);

    const result2 = findNearestSnapPointWithInfo(5, [0, 10], -1);
    expect(result2.snapped).toBe(false);
  });

  it('handles NaN in snap points array', () => {
    const snapPoints = [0, NaN, 5, 10];
    const result = findNearestSnapPointWithInfo(4.9, snapPoints, 0.2);

    expect(result.snapped).toBe(true);
    expect(result.time).toBe(5);
    expect(result.snapIndex).toBe(2); // Skips NaN at index 1
  });
});

// =============================================================================
// Clip Duration and Position Tests
// =============================================================================

describe('calculateClipDuration', () => {
  it('calculates duration at normal speed', () => {
    expect(calculateClipDuration(0, 10)).toBe(10);
    expect(calculateClipDuration(5, 15)).toBe(10);
  });

  it('calculates duration with speed multiplier', () => {
    expect(calculateClipDuration(0, 10, 2)).toBe(5); // 2x speed = half duration
    expect(calculateClipDuration(0, 10, 0.5)).toBe(20); // 0.5x speed = double duration
  });

  it('handles zero speed (edge case)', () => {
    const result = calculateClipDuration(0, 10, 0);
    expect(result).toBe(Infinity); // Division by zero
  });
});

describe('calculateClipEndTime', () => {
  it('calculates end time correctly', () => {
    expect(calculateClipEndTime(0, 0, 10)).toBe(10);
    expect(calculateClipEndTime(5, 0, 10)).toBe(15); // 5 + 10
    expect(calculateClipEndTime(5, 5, 15)).toBe(15); // 5 + (15-5)/1
  });

  it('calculates end time with speed', () => {
    expect(calculateClipEndTime(0, 0, 10, 2)).toBe(5); // 0 + 10/2
    expect(calculateClipEndTime(5, 0, 10, 0.5)).toBe(25); // 5 + 10/0.5
  });
});

describe('isTimeWithinClip', () => {
  it('returns true for times within clip (half-open interval)', () => {
    expect(isTimeWithinClip(0, 0, 0, 10)).toBe(true); // Start
    expect(isTimeWithinClip(5, 0, 0, 10)).toBe(true); // Middle
    expect(isTimeWithinClip(9.999, 0, 0, 10)).toBe(true); // Just before end
  });

  it('returns false for times outside clip', () => {
    expect(isTimeWithinClip(-1, 0, 0, 10)).toBe(false); // Before start
    expect(isTimeWithinClip(10, 0, 0, 10)).toBe(false); // At end (exclusive)
    expect(isTimeWithinClip(11, 0, 0, 10)).toBe(false); // After end
  });

  it('handles offset clips', () => {
    // Clip from timeline 5-15
    expect(isTimeWithinClip(4, 5, 0, 10)).toBe(false);
    expect(isTimeWithinClip(5, 5, 0, 10)).toBe(true);
    expect(isTimeWithinClip(10, 5, 0, 10)).toBe(true);
    expect(isTimeWithinClip(15, 5, 0, 10)).toBe(false);
  });

  it('handles speed changes', () => {
    // Clip at 0, source 0-10, 2x speed = timeline duration 5
    expect(isTimeWithinClip(0, 0, 0, 10, 2)).toBe(true);
    expect(isTimeWithinClip(4, 0, 0, 10, 2)).toBe(true);
    expect(isTimeWithinClip(5, 0, 0, 10, 2)).toBe(false); // End at 5
  });
});

// =============================================================================
// Concurrency / Race Condition Simulation Tests
// =============================================================================

describe('concurrent operations simulation', () => {
  it('handles rapid successive conversions', () => {
    const scale: TimelineScale = { zoom: 100, scrollX: 50 };
    const results: number[] = [];

    // Simulate rapid conversions
    for (let i = 0; i < 1000; i++) {
      const time = i * 0.1;
      const pixel = timeToPixel(time, scale);
      const backToTime = pixelToTime(pixel, scale);
      results.push(backToTime);
    }

    // Verify all roundtrips are accurate
    for (let i = 0; i < 1000; i++) {
      expect(results[i]).toBeCloseTo(i * 0.1, 10);
    }
  });

  it('handles alternating zoom levels', () => {
    const zooms = [10, 50, 100, 200, 500];
    const time = 5;

    for (const zoom of zooms) {
      const scale: TimelineScale = { zoom, scrollX: 0 };
      const pixel = timeToPixel(time, scale);
      const backToTime = pixelToTime(pixel, scale);
      expect(backToTime).toBeCloseTo(time, 10);
    }
  });
});

// =============================================================================
// Performance / Stress Tests
// =============================================================================

describe('performance stress tests', () => {
  it('handles large snap point arrays efficiently', () => {
    // Create large snap point array
    const snapPoints = Array.from({ length: 10000 }, (_, i) => i * 0.1);

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      findNearestSnapPoint(500.05, snapPoints, 0.1);
    }
    const elapsed = performance.now() - start;

    // Should complete in reasonable time (< 100ms for 100 iterations)
    expect(elapsed).toBeLessThan(100);
  });

  it('handles many drag delta calculations', () => {
    let accumulated = 0;
    const threshold = 5;

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const result = calculateDragDelta(Math.random() * 2, accumulated, threshold);
      accumulated = result.accumulatedDelta;
    }
    const elapsed = performance.now() - start;

    // Should complete in reasonable time (< 50ms)
    expect(elapsed).toBeLessThan(50);
  });
});
