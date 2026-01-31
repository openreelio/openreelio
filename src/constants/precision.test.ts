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
  snapTimeToFrame,
  floorTimeToFrame,
  ceilTimeToFrame,
  timeToFrame,
  frameToTime,
  DEFAULT_FPS,
  getFrameEpsilon,
  getSeekThreshold,
  getExternalSeekThreshold,
  formatTimecode,
  formatTimestamp,
  formatTimestampMs,
  parseTimecode,
  timeToTimecode,
  timecodeToTime,
} from './precision';

describe('PRECISION constants', () => {
  it('should have TIME_EPSILON at 1 millisecond (updated from microsecond)', () => {
    expect(PRECISION.TIME_EPSILON).toBe(0.001);
  });

  it('should have SNAP_EPSILON equal to TIME_EPSILON', () => {
    expect(PRECISION.SNAP_EPSILON).toBe(PRECISION.TIME_EPSILON);
  });

  it('should have FRAME_EPSILON at 1 millisecond', () => {
    expect(PRECISION.FRAME_EPSILON).toBe(0.001);
  });

  it('should have SUB_FRAME_EPSILON at ~8ms', () => {
    expect(PRECISION.SUB_FRAME_EPSILON).toBe(0.008);
  });
});

describe('SYNC_THRESHOLDS constants', () => {
  it('should have SEEK_THRESHOLD at 1 frame (33ms)', () => {
    expect(SYNC_THRESHOLDS.SEEK_THRESHOLD).toBe(0.033);
  });

  it('should have AUDIO_SYNC_THRESHOLD at 50ms', () => {
    expect(SYNC_THRESHOLDS.AUDIO_SYNC_THRESHOLD).toBe(0.05);
  });

  it('should have DRIFT_WARNING_THRESHOLD at 100ms', () => {
    expect(SYNC_THRESHOLDS.DRIFT_WARNING_THRESHOLD).toBe(0.1);
  });

  it('should have MAX_DRIFT_THRESHOLD at 300ms', () => {
    expect(SYNC_THRESHOLDS.MAX_DRIFT_THRESHOLD).toBe(0.3);
  });

  it('should have EXTERNAL_SEEK_THRESHOLD at 100ms', () => {
    expect(SYNC_THRESHOLDS.EXTERNAL_SEEK_THRESHOLD).toBe(0.1);
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
    expect(isApproximatelyEqual(5.0, 5.0 + 0.0005)).toBe(true);
  });

  it('should return false for numbers outside epsilon', () => {
    expect(isApproximatelyEqual(5.0, 5.002)).toBe(false);
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
    expect(isTimeEqual(1.0, 1.0 + 0.0005)).toBe(true);
    expect(isTimeEqual(1.0, 1.002)).toBe(false);
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

// =============================================================================
// Frame-Accurate Seeking Tests
// =============================================================================

describe('DEFAULT_FPS', () => {
  it('should be 30', () => {
    expect(DEFAULT_FPS).toBe(30);
  });
});

describe('snapTimeToFrame', () => {
  it('should snap to nearest frame at 30fps', () => {
    // Frame at 30fps: 0, 0.0333..., 0.0666..., etc.
    // 0.04 is closer to frame 1 (0.0333) than frame 2 (0.0666)
    const result = snapTimeToFrame(0.04, 30);
    expect(result).toBeCloseTo(1 / 30, 10);
  });

  it('should snap to frame boundary exactly when on it', () => {
    const result = snapTimeToFrame(1.0, 30);
    expect(result).toBe(1.0);
  });

  it('should snap forward when exactly between frames', () => {
    // At 30fps, frame 1 = 0.0333..., frame 2 = 0.0666...
    // Midpoint = 0.05
    const result = snapTimeToFrame(0.05, 30);
    // Math.round(0.05 * 30) = Math.round(1.5) = 2
    expect(result).toBeCloseTo(2 / 30, 10);
  });

  it('should handle different FPS values', () => {
    // At 24fps, frame duration = 0.0416...
    const result = snapTimeToFrame(1.5, 24);
    // 1.5 * 24 = 36 frames exactly
    expect(result).toBeCloseTo(36 / 24, 10);
  });

  it('should return 0 for 0 time', () => {
    expect(snapTimeToFrame(0, 30)).toBe(0);
  });

  it('should handle NaN time gracefully', () => {
    const result = snapTimeToFrame(NaN, 30);
    expect(result).toBe(0);
  });

  it('should handle NaN fps gracefully', () => {
    const result = snapTimeToFrame(1.5, NaN);
    expect(result).toBe(1.5);
  });

  it('should handle zero fps gracefully', () => {
    const result = snapTimeToFrame(1.5, 0);
    expect(result).toBe(1.5);
  });

  it('should handle negative fps gracefully', () => {
    const result = snapTimeToFrame(1.5, -30);
    expect(result).toBe(1.5);
  });

  it('should use DEFAULT_FPS when fps not provided', () => {
    const withDefault = snapTimeToFrame(1.5);
    const withExplicit = snapTimeToFrame(1.5, DEFAULT_FPS);
    expect(withDefault).toBe(withExplicit);
  });
});

describe('floorTimeToFrame', () => {
  it('should round down to previous frame', () => {
    // 0.04 at 30fps should floor to frame 1 (0.0333...)
    const result = floorTimeToFrame(0.04, 30);
    expect(result).toBeCloseTo(1 / 30, 10);
  });

  it('should stay on frame when exactly on boundary', () => {
    const result = floorTimeToFrame(1.0, 30);
    expect(result).toBe(1.0);
  });

  it('should floor to 0 for small values', () => {
    const result = floorTimeToFrame(0.01, 30);
    expect(result).toBe(0);
  });

  it('should handle invalid inputs gracefully', () => {
    expect(floorTimeToFrame(NaN, 30)).toBe(0);
    expect(floorTimeToFrame(1.5, 0)).toBe(1.5);
    expect(floorTimeToFrame(1.5, -30)).toBe(1.5);
  });
});

describe('ceilTimeToFrame', () => {
  it('should round up to next frame', () => {
    // 0.04 at 30fps should ceil to frame 2 (0.0666...)
    const result = ceilTimeToFrame(0.04, 30);
    expect(result).toBeCloseTo(2 / 30, 10);
  });

  it('should stay on frame when exactly on boundary', () => {
    const result = ceilTimeToFrame(1.0, 30);
    expect(result).toBe(1.0);
  });

  it('should ceil to frame 1 for small positive values', () => {
    const result = ceilTimeToFrame(0.01, 30);
    expect(result).toBeCloseTo(1 / 30, 10);
  });

  it('should handle invalid inputs gracefully', () => {
    expect(ceilTimeToFrame(NaN, 30)).toBe(0);
    expect(ceilTimeToFrame(1.5, 0)).toBe(1.5);
    expect(ceilTimeToFrame(1.5, -30)).toBe(1.5);
  });
});

describe('timeToFrame', () => {
  it('should convert time to frame number', () => {
    expect(timeToFrame(1.0, 30)).toBe(30);
    expect(timeToFrame(2.5, 30)).toBe(75);
  });

  it('should floor to previous frame', () => {
    // 1.5 seconds at 30fps = 45 frames, 1.51 = floor(45.3) = 45
    expect(timeToFrame(1.51, 30)).toBe(45);
  });

  it('should return 0 for 0 time', () => {
    expect(timeToFrame(0, 30)).toBe(0);
  });

  it('should handle invalid inputs gracefully', () => {
    expect(timeToFrame(NaN, 30)).toBe(0);
    expect(timeToFrame(1.5, 0)).toBe(0);
    expect(timeToFrame(1.5, NaN)).toBe(0);
  });
});

describe('frameToTime', () => {
  it('should convert frame number to time', () => {
    expect(frameToTime(30, 30)).toBe(1.0);
    expect(frameToTime(75, 30)).toBe(2.5);
  });

  it('should return 0 for frame 0', () => {
    expect(frameToTime(0, 30)).toBe(0);
  });

  it('should handle invalid inputs gracefully', () => {
    expect(frameToTime(NaN, 30)).toBe(0);
    expect(frameToTime(30, 0)).toBe(0);
    expect(frameToTime(30, NaN)).toBe(0);
  });
});

describe('frame conversion round-trip', () => {
  it('should round-trip from time to frame and back', () => {
    const originalTime = 2.5; // 75 frames at 30fps
    const frame = timeToFrame(originalTime, 30);
    const roundTrip = frameToTime(frame, 30);
    expect(roundTrip).toBe(originalTime);
  });

  it('should round-trip from frame to time and back', () => {
    const originalFrame = 90; // 3.0 seconds at 30fps
    const time = frameToTime(originalFrame, 30);
    const roundTrip = timeToFrame(time, 30);
    expect(roundTrip).toBe(originalFrame);
  });
});

// =============================================================================
// FPS-Aware Utility Tests
// =============================================================================

describe('getFrameEpsilon', () => {
  it('should return half frame duration at 30fps', () => {
    const epsilon = getFrameEpsilon(30);
    expect(epsilon).toBeCloseTo(0.5 / 30, 6);
  });

  it('should return half frame duration at 60fps', () => {
    const epsilon = getFrameEpsilon(60);
    expect(epsilon).toBeCloseTo(0.5 / 60, 6);
  });

  it('should return default for invalid fps', () => {
    expect(getFrameEpsilon(0)).toBe(PRECISION.FRAME_EPSILON);
    expect(getFrameEpsilon(-30)).toBe(PRECISION.FRAME_EPSILON);
    expect(getFrameEpsilon(NaN)).toBe(PRECISION.FRAME_EPSILON);
  });
});

describe('getSeekThreshold', () => {
  it('should return one frame duration at 30fps', () => {
    const threshold = getSeekThreshold(30);
    expect(threshold).toBeCloseTo(1 / 30, 6);
  });

  it('should return one frame duration at 24fps', () => {
    const threshold = getSeekThreshold(24);
    expect(threshold).toBeCloseTo(1 / 24, 6);
  });

  it('should return default for invalid fps', () => {
    expect(getSeekThreshold(0)).toBe(SYNC_THRESHOLDS.SEEK_THRESHOLD);
    expect(getSeekThreshold(-30)).toBe(SYNC_THRESHOLDS.SEEK_THRESHOLD);
  });
});

describe('getExternalSeekThreshold', () => {
  it('should return 3 frames duration at 30fps', () => {
    const threshold = getExternalSeekThreshold(30);
    expect(threshold).toBeCloseTo(3 / 30, 6);
  });

  it('should return 3 frames duration at 60fps', () => {
    const threshold = getExternalSeekThreshold(60);
    expect(threshold).toBeCloseTo(3 / 60, 6);
  });

  it('should return default for invalid fps', () => {
    expect(getExternalSeekThreshold(0)).toBe(SYNC_THRESHOLDS.EXTERNAL_SEEK_THRESHOLD);
  });
});

// =============================================================================
// Timecode Utility Tests
// =============================================================================

describe('timeToTimecode', () => {
  it('should convert 0 to 00:00:00:00', () => {
    const tc = timeToTimecode(0, 30);
    expect(tc).toEqual({ hours: 0, minutes: 0, seconds: 0, frames: 0 });
  });

  it('should convert 1 second to 00:00:01:00 at 30fps', () => {
    const tc = timeToTimecode(1, 30);
    expect(tc).toEqual({ hours: 0, minutes: 0, seconds: 1, frames: 0 });
  });

  it('should convert 1.5 seconds to 00:00:01:15 at 30fps', () => {
    const tc = timeToTimecode(1.5, 30);
    expect(tc).toEqual({ hours: 0, minutes: 0, seconds: 1, frames: 15 });
  });

  it('should convert 3661.5 seconds (1:01:01.5) to 01:01:01:15 at 30fps', () => {
    const tc = timeToTimecode(3661.5, 30);
    expect(tc).toEqual({ hours: 1, minutes: 1, seconds: 1, frames: 15 });
  });

  it('should handle 24fps correctly', () => {
    const tc = timeToTimecode(1.5, 24);
    expect(tc).toEqual({ hours: 0, minutes: 0, seconds: 1, frames: 12 });
  });

  it('should handle invalid input', () => {
    expect(timeToTimecode(NaN, 30)).toEqual({ hours: 0, minutes: 0, seconds: 0, frames: 0 });
    expect(timeToTimecode(-5, 30)).toEqual({ hours: 0, minutes: 0, seconds: 0, frames: 0 });
    expect(timeToTimecode(5, 0)).toEqual({ hours: 0, minutes: 0, seconds: 0, frames: 0 });
  });
});

describe('timecodeToTime', () => {
  it('should convert 00:00:00:00 to 0', () => {
    const time = timecodeToTime({ hours: 0, minutes: 0, seconds: 0, frames: 0 }, 30);
    expect(time).toBe(0);
  });

  it('should convert 00:00:01:15 to 1.5 at 30fps', () => {
    const time = timecodeToTime({ hours: 0, minutes: 0, seconds: 1, frames: 15 }, 30);
    expect(time).toBe(1.5);
  });

  it('should convert 01:01:01:15 to 3661.5 at 30fps', () => {
    const time = timecodeToTime({ hours: 1, minutes: 1, seconds: 1, frames: 15 }, 30);
    expect(time).toBe(3661.5);
  });

  it('should handle invalid fps', () => {
    expect(timecodeToTime({ hours: 0, minutes: 0, seconds: 1, frames: 0 }, 0)).toBe(0);
    expect(timecodeToTime({ hours: 0, minutes: 0, seconds: 1, frames: 0 }, -30)).toBe(0);
  });
});

describe('timecode round-trip', () => {
  it('should round-trip accurately', () => {
    const originalTime = 3661.5;
    const tc = timeToTimecode(originalTime, 30);
    const roundTrip = timecodeToTime(tc, 30);
    expect(roundTrip).toBe(originalTime);
  });
});

describe('formatTimecode', () => {
  it('should format to HH:MM:SS:FF by default', () => {
    expect(formatTimecode(3661.5, 30)).toBe('01:01:01:15');
  });

  it('should handle 0 time', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
  });

  it('should work with different fps', () => {
    expect(formatTimecode(1.5, 24)).toBe('00:00:01:12');
  });

  it('should hide hours when showHours is false and hours is 0', () => {
    expect(formatTimecode(61.5, 30, { showHours: false })).toBe('01:01:15');
  });

  it('should show hours when non-zero even if showHours is false', () => {
    const result = formatTimecode(3661.5, 30, { showHours: false });
    expect(result).toBe('01:01:01:15');
  });

  it('should use custom separator', () => {
    expect(formatTimecode(61.5, 30, { separator: '-' })).toBe('00-01-01-15');
  });

  it('should use custom frame separator', () => {
    expect(formatTimecode(61.5, 30, { frameSeparator: ';' })).toBe('00:01:01;15');
  });
});

describe('formatTimestamp', () => {
  it('should format to MM:SS by default', () => {
    expect(formatTimestamp(125.5)).toBe('02:05');
  });

  it('should format to HH:MM:SS when hours present', () => {
    expect(formatTimestamp(3661.5)).toBe('1:01:01');
  });

  it('should show hours when showHours is true', () => {
    expect(formatTimestamp(125.5, true)).toBe('0:02:05');
  });

  it('should handle 0 time', () => {
    expect(formatTimestamp(0)).toBe('00:00');
  });

  it('should handle invalid time', () => {
    expect(formatTimestamp(NaN)).toBe('00:00');
    expect(formatTimestamp(-5)).toBe('00:00');
  });
});

describe('formatTimestampMs', () => {
  it('should format with milliseconds', () => {
    expect(formatTimestampMs(125.567)).toBe('02:05.567');
  });

  it('should respect precision parameter', () => {
    expect(formatTimestampMs(125.567891, false, 2)).toBe('02:05.57');
  });

  it('should show hours when needed', () => {
    expect(formatTimestampMs(3661.5, true)).toBe('1:01:01.500');
  });
});

describe('parseTimecode', () => {
  it('should parse HH:MM:SS:FF format', () => {
    const time = parseTimecode('01:02:03:15', 30);
    expect(time).toBeCloseTo(3723.5, 2);
  });

  it('should parse MM:SS:FF format', () => {
    const time = parseTimecode('02:03:15', 30);
    expect(time).toBeCloseTo(123.5, 2);
  });

  it('should parse SS:FF format', () => {
    const time = parseTimecode('03:15', 30);
    expect(time).toBeCloseTo(3.5, 2);
  });

  it('should handle semicolon separator (drop-frame notation)', () => {
    const time = parseTimecode('01;02;03;15', 30);
    expect(time).toBeCloseTo(3723.5, 2);
  });

  it('should return null for invalid input', () => {
    expect(parseTimecode('', 30)).toBeNull();
    expect(parseTimecode('invalid', 30)).toBeNull();
    expect(parseTimecode('01:02:03:40', 30)).toBeNull(); // frames >= fps
    expect(parseTimecode('01:70:03:15', 30)).toBeNull(); // minutes >= 60
    expect(parseTimecode('01:02:03:15', 0)).toBeNull(); // invalid fps
  });

  it('should round-trip with formatTimecode', () => {
    const originalTime = 3723.5;
    const formatted = formatTimecode(originalTime, 30);
    const parsed = parseTimecode(formatted, 30);
    expect(parsed).toBeCloseTo(originalTime, 2);
  });
});
