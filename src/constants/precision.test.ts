/**
 * Precision Constants Tests
 */

import { describe, it, expect } from 'vitest';
import {
  PRECISION,
  SYNC_THRESHOLDS,
  SNAP_THRESHOLDS,
  isApproximatelyEqual,
  isTimeEqual,
  isWithinFrame,
  calculateSnapThreshold,
  calculateSnapReleaseThreshold,
} from './precision';

describe('PRECISION constants', () => {
  it('should have TIME_EPSILON at 1 microsecond', () => {
    expect(PRECISION.TIME_EPSILON).toBe(1e-6);
  });

  it('should have SNAP_EPSILON equal to TIME_EPSILON', () => {
    expect(PRECISION.SNAP_EPSILON).toBe(PRECISION.TIME_EPSILON);
  });

  it('should have FRAME_EPSILON at 1 millisecond', () => {
    expect(PRECISION.FRAME_EPSILON).toBe(0.001);
  });
});

describe('SYNC_THRESHOLDS constants', () => {
  it('should have SEEK_THRESHOLD at 1 frame (33ms)', () => {
    expect(SYNC_THRESHOLDS.SEEK_THRESHOLD).toBe(0.033);
  });

  it('should have AUDIO_SYNC_THRESHOLD at 100ms', () => {
    expect(SYNC_THRESHOLDS.AUDIO_SYNC_THRESHOLD).toBe(0.1);
  });
});

describe('SNAP_THRESHOLDS constants', () => {
  it('should have MIN_THRESHOLD at 50ms', () => {
    expect(SNAP_THRESHOLDS.MIN_THRESHOLD).toBe(0.05);
  });

  it('should have MAX_THRESHOLD at 500ms', () => {
    expect(SNAP_THRESHOLDS.MAX_THRESHOLD).toBe(0.5);
  });

  it('should have HYSTERESIS_MULTIPLIER at 1.5', () => {
    expect(SNAP_THRESHOLDS.HYSTERESIS_MULTIPLIER).toBe(1.5);
  });
});

describe('isApproximatelyEqual', () => {
  it('should return true for equal numbers', () => {
    expect(isApproximatelyEqual(5.0, 5.0)).toBe(true);
  });

  it('should return true for numbers within epsilon', () => {
    expect(isApproximatelyEqual(5.0, 5.0 + 1e-7)).toBe(true);
  });

  it('should return false for numbers outside epsilon', () => {
    expect(isApproximatelyEqual(5.0, 5.001)).toBe(false);
  });

  it('should return false for NaN values', () => {
    expect(isApproximatelyEqual(NaN, 5.0)).toBe(false);
    expect(isApproximatelyEqual(5.0, NaN)).toBe(false);
    expect(isApproximatelyEqual(NaN, NaN)).toBe(false);
  });

  it('should return false for Infinity values', () => {
    expect(isApproximatelyEqual(Infinity, 5.0)).toBe(false);
    expect(isApproximatelyEqual(-Infinity, 5.0)).toBe(false);
  });

  it('should accept custom epsilon', () => {
    expect(isApproximatelyEqual(5.0, 5.1, 0.2)).toBe(true);
    expect(isApproximatelyEqual(5.0, 5.3, 0.2)).toBe(false);
  });
});

describe('isTimeEqual', () => {
  it('should use TIME_EPSILON for comparison', () => {
    expect(isTimeEqual(1.0, 1.0 + 1e-7)).toBe(true);
    expect(isTimeEqual(1.0, 1.001)).toBe(false);
  });
});

describe('isWithinFrame', () => {
  it('should use FRAME_EPSILON (1ms) for comparison', () => {
    expect(isWithinFrame(1.0, 1.0005)).toBe(true);
    expect(isWithinFrame(1.0, 1.002)).toBe(false);
  });
});

describe('calculateSnapThreshold', () => {
  it('should clamp to MIN_THRESHOLD at high zoom', () => {
    // At zoom 1000, raw = 10/1000 = 0.01, but MIN = 0.05
    expect(calculateSnapThreshold(1000)).toBe(SNAP_THRESHOLDS.MIN_THRESHOLD);
  });

  it('should clamp to MAX_THRESHOLD at low zoom', () => {
    // At zoom 1, raw = 10/1 = 10, but MAX = 0.5
    expect(calculateSnapThreshold(1)).toBe(SNAP_THRESHOLDS.MAX_THRESHOLD);
  });

  it('should return raw value when within bounds', () => {
    // At zoom 100, raw = 10/100 = 0.1, which is within [0.05, 0.5]
    expect(calculateSnapThreshold(100)).toBe(0.1);
  });

  it('should scale inversely with zoom', () => {
    const threshold50 = calculateSnapThreshold(50);
    const threshold200 = calculateSnapThreshold(200);
    expect(threshold50).toBeGreaterThan(threshold200);
  });

  it('should return MAX_THRESHOLD for zero zoom', () => {
    expect(calculateSnapThreshold(0)).toBe(SNAP_THRESHOLDS.MAX_THRESHOLD);
  });

  it('should return MAX_THRESHOLD for negative zoom', () => {
    expect(calculateSnapThreshold(-100)).toBe(SNAP_THRESHOLDS.MAX_THRESHOLD);
  });

  it('should return MAX_THRESHOLD for NaN zoom', () => {
    expect(calculateSnapThreshold(NaN)).toBe(SNAP_THRESHOLDS.MAX_THRESHOLD);
  });

  it('should return MAX_THRESHOLD for Infinity zoom', () => {
    expect(calculateSnapThreshold(Infinity)).toBe(SNAP_THRESHOLDS.MAX_THRESHOLD);
  });
});

describe('calculateSnapReleaseThreshold', () => {
  it('should return threshold * HYSTERESIS_MULTIPLIER', () => {
    const snapThreshold = 0.1;
    const releaseThreshold = calculateSnapReleaseThreshold(snapThreshold);
    expect(releaseThreshold).toBeCloseTo(0.15, 10); // 0.1 * 1.5 (use toBeCloseTo for floating-point)
  });

  it('should always be larger than snap threshold', () => {
    const snapThreshold = 0.1;
    const releaseThreshold = calculateSnapReleaseThreshold(snapThreshold);
    expect(releaseThreshold).toBeGreaterThan(snapThreshold);
  });
});
