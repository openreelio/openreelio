import { describe, expect, it } from 'vitest';
import { getClipTimelineDurationSec, isClipActiveAtTime } from './clipTiming';
import type { Clip } from '@/types';

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    label: 'Test Clip',
    place: {
      timelineInSec: 0,
      durationSec: 10,
    },
    range: {
      sourceInSec: 0,
      sourceOutSec: 10,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    speed: 1,
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

describe('isClipActiveAtTime', () => {
  it('should return true when an enabled clip spans the timeline position', () => {
    const clip = createClip({ enabled: true });

    expect(isClipActiveAtTime(clip, 5)).toBe(true);
  });

  it('should return false when the clip is disabled even if the time overlaps', () => {
    const clip = createClip({ enabled: false });

    expect(isClipActiveAtTime(clip, 5)).toBe(false);
  });
});

describe('getClipTimelineDurationSec', () => {
  it('should prefer explicit timeline duration to match backend clip duration rules', () => {
    const clip = createClip({
      speed: 2,
      range: {
        sourceInSec: 0,
        sourceOutSec: 8,
      },
      place: {
        timelineInSec: 0,
        durationSec: 10,
      },
    });

    expect(getClipTimelineDurationSec(clip)).toBe(10);
  });

  it('should fall back to speed-adjusted source duration when explicit duration is invalid', () => {
    const clip = createClip({
      speed: 2,
      range: {
        sourceInSec: 0,
        sourceOutSec: 8,
      },
      place: {
        timelineInSec: 0,
        durationSec: 0,
      },
    });

    expect(getClipTimelineDurationSec(clip)).toBe(4);
  });

  it('should derive duration safely when malformed clips are missing place data', () => {
    const clip = createClip({
      place: undefined as unknown as Clip['place'],
    });

    expect(getClipTimelineDurationSec(clip)).toBe(10);
    expect(isClipActiveAtTime(clip, 5)).toBe(false);
  });
});
