import { describe, expect, it } from 'vitest';
import { isClipActiveAtTime } from './clipTiming';
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
