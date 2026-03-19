/**
 * useAudioKeyframes Utility Function Tests
 *
 * Unit tests for the pure coordinate conversion and interpolation functions
 * exported from useAudioKeyframes.ts. These functions convert between dB/time
 * domains and pixel coordinates for the rubber band UI.
 */

import { describe, it, expect } from 'vitest';
import {
  dbToY,
  yToDb,
  timeToX,
  xToTime,
  interpolateKeyframes,
} from './useAudioKeyframes';
import type { AudioKeyframe } from '@/types';

// =============================================================================
// Constants (mirrored from source for clarity)
// =============================================================================

const TRACK_HEIGHT = 40;
const PADDING_TOP = 6;
const PADDING_BOTTOM = 6;
const MAX_DB = 6;
const MIN_DB = -60;
const AVAILABLE = TRACK_HEIGHT - PADDING_TOP - PADDING_BOTTOM; // 28

// =============================================================================
// dbToY
// =============================================================================

describe('dbToY', () => {
  it('should return top padding when value is max volume (6 dB)', () => {
    const y = dbToY(MAX_DB, TRACK_HEIGHT);
    expect(y).toBe(PADDING_TOP);
  });

  it('should return bottom edge when value is min volume (-60 dB)', () => {
    const y = dbToY(MIN_DB, TRACK_HEIGHT);
    expect(y).toBe(PADDING_TOP + AVAILABLE);
  });

  it('should place 0 dB in the upper portion of the track', () => {
    const y = dbToY(0, TRACK_HEIGHT);
    // normalized = (6 - 0) / (6 - (-60)) = 6/66 ~= 0.0909
    const expected = PADDING_TOP + (6 / 66) * AVAILABLE;
    expect(y).toBeCloseTo(expected, 5);
  });

  it('should clamp values above max dB to top padding', () => {
    const y = dbToY(20, TRACK_HEIGHT);
    expect(y).toBe(PADDING_TOP);
  });

  it('should clamp values below min dB to bottom edge', () => {
    const y = dbToY(-100, TRACK_HEIGHT);
    expect(y).toBe(PADDING_TOP + AVAILABLE);
  });

  it('should handle a track height where available space is very small', () => {
    // trackHeight = 13 => available = 13 - 6 - 6 = 1
    const y = dbToY(0, 13);
    expect(y).toBeGreaterThanOrEqual(PADDING_TOP);
    expect(y).toBeLessThanOrEqual(13 - PADDING_BOTTOM);
  });

  it('should ensure available is at least 1 when track height is tiny', () => {
    // trackHeight = 10 => raw available = -2, clamped to 1
    const yMax = dbToY(MAX_DB, 10);
    const yMin = dbToY(MIN_DB, 10);
    expect(yMax).toBe(PADDING_TOP);
    expect(yMin).toBe(PADDING_TOP + 1);
  });
});

// =============================================================================
// yToDb
// =============================================================================

describe('yToDb', () => {
  it('should return max dB at top padding position', () => {
    const db = yToDb(PADDING_TOP, TRACK_HEIGHT);
    expect(db).toBe(MAX_DB);
  });

  it('should return min dB at bottom edge position', () => {
    const db = yToDb(PADDING_TOP + AVAILABLE, TRACK_HEIGHT);
    expect(db).toBe(MIN_DB);
  });

  it('should round-trip with dbToY for 0 dB', () => {
    const y = dbToY(0, TRACK_HEIGHT);
    const db = yToDb(y, TRACK_HEIGHT);
    expect(db).toBeCloseTo(0, 1);
  });

  it('should round-trip with dbToY for -12 dB', () => {
    const y = dbToY(-12, TRACK_HEIGHT);
    const db = yToDb(y, TRACK_HEIGHT);
    expect(db).toBeCloseTo(-12, 1);
  });

  it('should round-trip with dbToY for -30 dB', () => {
    const y = dbToY(-30, TRACK_HEIGHT);
    const db = yToDb(y, TRACK_HEIGHT);
    expect(db).toBeCloseTo(-30, 1);
  });

  it('should clamp y above the track to max dB', () => {
    const db = yToDb(0, TRACK_HEIGHT);
    expect(db).toBe(MAX_DB);
  });

  it('should clamp y below the track to min dB', () => {
    const db = yToDb(100, TRACK_HEIGHT);
    expect(db).toBe(MIN_DB);
  });

  it('should return a value rounded to one decimal place', () => {
    const db = yToDb(20, TRACK_HEIGHT);
    const decimalPlaces = (db.toString().split('.')[1] ?? '').length;
    expect(decimalPlaces).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// timeToX
// =============================================================================

describe('timeToX', () => {
  it('should return 0 for time offset 0', () => {
    expect(timeToX(0, 10, 500)).toBe(0);
  });

  it('should return full width for time equal to clip duration', () => {
    expect(timeToX(10, 10, 500)).toBe(500);
  });

  it('should return half width for time at midpoint', () => {
    expect(timeToX(5, 10, 500)).toBe(250);
  });

  it('should return 0 when clip duration is zero', () => {
    expect(timeToX(5, 0, 500)).toBe(0);
  });

  it('should return 0 when clip duration is negative', () => {
    expect(timeToX(5, -1, 500)).toBe(0);
  });

  it('should handle fractional time offsets', () => {
    const x = timeToX(2.5, 10, 200);
    expect(x).toBe(50);
  });
});

// =============================================================================
// xToTime
// =============================================================================

describe('xToTime', () => {
  it('should return 0 for x position 0', () => {
    expect(xToTime(0, 10, 500)).toBe(0);
  });

  it('should return clip duration for x at full width', () => {
    expect(xToTime(500, 10, 500)).toBe(10);
  });

  it('should return midpoint time for x at half width', () => {
    expect(xToTime(250, 10, 500)).toBe(5);
  });

  it('should return 0 when width is zero', () => {
    expect(xToTime(100, 10, 0)).toBe(0);
  });

  it('should return 0 when width is negative', () => {
    expect(xToTime(100, 10, -1)).toBe(0);
  });

  it('should clamp negative x to 0', () => {
    expect(xToTime(-50, 10, 500)).toBe(0);
  });

  it('should clamp x beyond width to clip duration', () => {
    expect(xToTime(600, 10, 500)).toBe(10);
  });

  it('should round-trip with timeToX for a midpoint value', () => {
    const x = timeToX(3.5, 10, 400);
    const time = xToTime(x, 10, 400);
    expect(time).toBeCloseTo(3.5, 2);
  });

  it('should round result to millisecond precision', () => {
    // x=1 on width=3 duration=10 => raw time = 3.33333...
    const time = xToTime(1, 10, 3);
    const decimals = (time.toString().split('.')[1] ?? '').length;
    expect(decimals).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
// interpolateKeyframes
// =============================================================================

describe('interpolateKeyframes', () => {
  it('should return 0 for an empty keyframe array', () => {
    expect(interpolateKeyframes([], 5)).toBe(0);
  });

  it('should return the single keyframe value regardless of time offset', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 2, valueDb: -6, interpolation: 'linear' },
    ];
    expect(interpolateKeyframes(kf, 0)).toBe(-6);
    expect(interpolateKeyframes(kf, 2)).toBe(-6);
    expect(interpolateKeyframes(kf, 10)).toBe(-6);
  });

  it('should return first keyframe value when time is before all keyframes', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 2, valueDb: -6, interpolation: 'linear' },
      { timeOffset: 8, valueDb: -12, interpolation: 'linear' },
    ];
    expect(interpolateKeyframes(kf, 0)).toBe(-6);
    expect(interpolateKeyframes(kf, 1)).toBe(-6);
  });

  it('should return last keyframe value when time is after all keyframes', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 2, valueDb: -6, interpolation: 'linear' },
      { timeOffset: 8, valueDb: -12, interpolation: 'linear' },
    ];
    expect(interpolateKeyframes(kf, 8)).toBe(-12);
    expect(interpolateKeyframes(kf, 15)).toBe(-12);
  });

  it('should linearly interpolate between two keyframes at the midpoint', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 0, valueDb: 0, interpolation: 'linear' },
      { timeOffset: 10, valueDb: -20, interpolation: 'linear' },
    ];
    // Midpoint (t=5): 0 + 0.5 * (-20 - 0) = -10
    expect(interpolateKeyframes(kf, 5)).toBe(-10);
  });

  it('should linearly interpolate at a quarter point', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 0, valueDb: 0, interpolation: 'linear' },
      { timeOffset: 10, valueDb: -20, interpolation: 'linear' },
    ];
    // t=2.5: 0 + 0.25 * (-20) = -5
    expect(interpolateKeyframes(kf, 2.5)).toBe(-5);
  });

  it('should hold the current keyframe value with hold interpolation', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 0, valueDb: 0, interpolation: 'hold' },
      { timeOffset: 10, valueDb: -20, interpolation: 'linear' },
    ];
    // At any point between 0 and 10, hold returns 0 (the current kf value)
    expect(interpolateKeyframes(kf, 0)).toBe(0);
    expect(interpolateKeyframes(kf, 5)).toBe(0);
    expect(interpolateKeyframes(kf, 9.99)).toBe(0);
    // At t=10, returns second keyframe value
    expect(interpolateKeyframes(kf, 10)).toBe(-20);
  });

  it('should interpolate correctly across three keyframes', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 0, valueDb: 0, interpolation: 'linear' },
      { timeOffset: 5, valueDb: -12, interpolation: 'linear' },
      { timeOffset: 10, valueDb: 0, interpolation: 'linear' },
    ];
    expect(interpolateKeyframes(kf, 0)).toBe(0);
    expect(interpolateKeyframes(kf, 5)).toBe(-12);
    expect(interpolateKeyframes(kf, 10)).toBe(0);
    // Between first and second: t=2.5 => 0 + 0.5*(-12) = -6
    expect(interpolateKeyframes(kf, 2.5)).toBe(-6);
    // Between second and third: t=7.5 => -12 + 0.5*(0 - (-12)) = -6
    expect(interpolateKeyframes(kf, 7.5)).toBe(-6);
  });

  it('should handle keyframes at the same time offset', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 5, valueDb: 0, interpolation: 'linear' },
      { timeOffset: 5, valueDb: -10, interpolation: 'linear' },
    ];
    // timeOffset (5) <= keyframes[0].timeOffset (5) triggers first guard,
    // returning first keyframe value
    expect(interpolateKeyframes(kf, 5)).toBe(0);
  });

  it('should return exact keyframe values at keyframe time offsets', () => {
    const kf: AudioKeyframe[] = [
      { timeOffset: 0, valueDb: 6, interpolation: 'linear' },
      { timeOffset: 3, valueDb: -30, interpolation: 'linear' },
      { timeOffset: 7, valueDb: -6, interpolation: 'linear' },
    ];
    expect(interpolateKeyframes(kf, 0)).toBe(6);
    expect(interpolateKeyframes(kf, 3)).toBe(-30);
    expect(interpolateKeyframes(kf, 7)).toBe(-6);
  });
});
