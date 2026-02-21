/**
 * Tests for useVideoSync utility functions.
 *
 * These are pure domain logic functions that convert between
 * source media time and timeline time, accounting for clip speed.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateTimelineTime,
  isTimeInClip,
  getClipTimelineDuration,
} from './useVideoSync';
import type { Clip } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

function makeClip(overrides: Partial<{
  speed: number;
  sourceIn: number;
  sourceOut: number;
  timelineIn: number;
}>): Clip {
  const {
    speed = 1,
    sourceIn = 0,
    sourceOut = 10,
    timelineIn = 0,
  } = overrides;

  return {
    id: 'clip-1',
    assetId: 'asset-1',
    trackId: 'track-1',
    speed,
    range: {
      sourceInSec: sourceIn,
      sourceOutSec: sourceOut,
    },
    place: {
      timelineInSec: timelineIn,
    },
  } as unknown as Clip;
}

// =============================================================================
// calculateTimelineTime
// =============================================================================

describe('calculateTimelineTime', () => {
  it('should return timeline position for a normal speed clip', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 1 });
    // sourceTime 3 => offset 3 from sourceIn, at speed 1 => timeline 5 + 3 = 8
    expect(calculateTimelineTime(clip, 3)).toBe(8);
  });

  it('should account for clip speed > 1 (fast forward)', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 2 });
    // sourceTime 4 => offset 4 from sourceIn, at speed 2 => 4/2 = 2 => timeline 5 + 2 = 7
    expect(calculateTimelineTime(clip, 4)).toBe(7);
  });

  it('should account for clip speed < 1 (slow motion)', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 0.5 });
    // sourceTime 3 => offset 3, at speed 0.5 => 3/0.5 = 6 => timeline 5 + 6 = 11
    expect(calculateTimelineTime(clip, 3)).toBe(11);
  });

  it('should handle zero speed by falling back to speed=1', () => {
    const clip = makeClip({ speed: 0, timelineIn: 10, sourceIn: 0, sourceOut: 5 });
    // safeSpeed = 1, sourceTime 2 => offset 2 => timeline 10 + 2 = 12
    expect(calculateTimelineTime(clip, 2)).toBe(12);
  });

  it('should handle negative speed by falling back to speed=1', () => {
    const clip = makeClip({ speed: -1, timelineIn: 10, sourceIn: 0, sourceOut: 5 });
    expect(calculateTimelineTime(clip, 2)).toBe(12);
  });

  it('should handle sourceIn offset correctly', () => {
    const clip = makeClip({ timelineIn: 0, sourceIn: 5, sourceOut: 15, speed: 1 });
    // sourceTime 8 => offset from sourceIn = 3, at speed 1 => timeline 0 + 3 = 3
    expect(calculateTimelineTime(clip, 8)).toBe(3);
  });

  it('should return timelineIn when sourceTime equals sourceIn', () => {
    const clip = makeClip({ timelineIn: 20, sourceIn: 5, sourceOut: 15, speed: 1 });
    expect(calculateTimelineTime(clip, 5)).toBe(20);
  });
});

// =============================================================================
// isTimeInClip
// =============================================================================

describe('isTimeInClip', () => {
  it('should return true when timeline time is within clip range', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 1 });
    // clip occupies timeline [5, 15)
    expect(isTimeInClip(clip, 5)).toBe(true);
    expect(isTimeInClip(clip, 10)).toBe(true);
    expect(isTimeInClip(clip, 14.999)).toBe(true);
  });

  it('should return false at clip end (exclusive boundary)', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 1 });
    // clipEnd = 5 + 10/1 = 15, exclusive
    expect(isTimeInClip(clip, 15)).toBe(false);
  });

  it('should return false before clip start', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 1 });
    expect(isTimeInClip(clip, 4.999)).toBe(false);
  });

  it('should adjust range for speed > 1', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 2 });
    // clipDuration = 10/2 = 5, clipEnd = 5 + 5 = 10
    expect(isTimeInClip(clip, 5)).toBe(true);
    expect(isTimeInClip(clip, 9.999)).toBe(true);
    expect(isTimeInClip(clip, 10)).toBe(false);
  });

  it('should adjust range for speed < 1 (slow motion extends timeline)', () => {
    const clip = makeClip({ timelineIn: 5, sourceIn: 0, sourceOut: 10, speed: 0.5 });
    // clipDuration = 10/0.5 = 20, clipEnd = 5 + 20 = 25
    expect(isTimeInClip(clip, 24.999)).toBe(true);
    expect(isTimeInClip(clip, 25)).toBe(false);
  });

  it('should handle zero speed by falling back to speed=1', () => {
    const clip = makeClip({ timelineIn: 0, sourceIn: 0, sourceOut: 10, speed: 0 });
    // safeSpeed = 1, duration = 10, clipEnd = 10
    expect(isTimeInClip(clip, 5)).toBe(true);
    expect(isTimeInClip(clip, 10)).toBe(false);
  });
});

// =============================================================================
// getClipTimelineDuration
// =============================================================================

describe('getClipTimelineDuration', () => {
  it('should return source duration at normal speed', () => {
    const clip = makeClip({ sourceIn: 0, sourceOut: 10, speed: 1 });
    expect(getClipTimelineDuration(clip)).toBe(10);
  });

  it('should shorten duration when speed > 1', () => {
    const clip = makeClip({ sourceIn: 0, sourceOut: 10, speed: 2 });
    expect(getClipTimelineDuration(clip)).toBe(5);
  });

  it('should lengthen duration when speed < 1', () => {
    const clip = makeClip({ sourceIn: 0, sourceOut: 10, speed: 0.5 });
    expect(getClipTimelineDuration(clip)).toBe(20);
  });

  it('should handle zero speed by falling back to speed=1', () => {
    const clip = makeClip({ sourceIn: 2, sourceOut: 8, speed: 0 });
    expect(getClipTimelineDuration(clip)).toBe(6);
  });

  it('should handle negative speed by falling back to speed=1', () => {
    const clip = makeClip({ sourceIn: 2, sourceOut: 8, speed: -2 });
    expect(getClipTimelineDuration(clip)).toBe(6);
  });

  it('should handle sourceIn offset', () => {
    const clip = makeClip({ sourceIn: 5, sourceOut: 15, speed: 1 });
    expect(getClipTimelineDuration(clip)).toBe(10);
  });

  it('should return 0 when sourceIn equals sourceOut', () => {
    const clip = makeClip({ sourceIn: 5, sourceOut: 5, speed: 1 });
    expect(getClipTimelineDuration(clip)).toBe(0);
  });
});
