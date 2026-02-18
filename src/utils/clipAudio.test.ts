import { describe, expect, it } from 'vitest';
import type { Clip } from '@/types';
import {
  CLIP_AUDIO_MAX_VOLUME_DB,
  CLIP_AUDIO_MIN_VOLUME_DB,
  clampClipPan,
  clampClipVolumeDb,
  getClipFadeFactor,
  getClipTimelineDurationSec,
  normalizeClipFadeDurations,
} from './clipAudio';

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    range: {
      sourceInSec: 0,
      sourceOutSec: 10,
    },
    place: {
      timelineInSec: 0,
      durationSec: 10,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      pan: 0,
      muted: false,
      fadeInSec: 0,
      fadeOutSec: 0,
    },
    ...overrides,
  };
}

describe('clipAudio utils', () => {
  describe('clampClipVolumeDb', () => {
    it('clamps to configured volume bounds', () => {
      expect(clampClipVolumeDb(100)).toBe(CLIP_AUDIO_MAX_VOLUME_DB);
      expect(clampClipVolumeDb(-999)).toBe(CLIP_AUDIO_MIN_VOLUME_DB);
      expect(clampClipVolumeDb(-12)).toBe(-12);
    });
  });

  describe('clampClipPan', () => {
    it('clamps pan between -1 and 1', () => {
      expect(clampClipPan(2)).toBe(1);
      expect(clampClipPan(-5)).toBe(-1);
      expect(clampClipPan(0.25)).toBe(0.25);
    });
  });

  describe('getClipTimelineDurationSec', () => {
    it('returns speed-adjusted clip duration', () => {
      const clip = createClip({ speed: 2, range: { sourceInSec: 0, sourceOutSec: 8 } });
      expect(getClipTimelineDurationSec(clip)).toBe(4);
    });

    it('returns 0 for invalid clip duration', () => {
      const clip = createClip({ range: { sourceInSec: 10, sourceOutSec: 0 } });
      expect(getClipTimelineDurationSec(clip)).toBe(0);
    });
  });

  describe('normalizeClipFadeDurations', () => {
    it('keeps fade sum within clip duration', () => {
      expect(normalizeClipFadeDurations(8, 8, 10)).toEqual({ fadeInSec: 2, fadeOutSec: 8 });
      expect(normalizeClipFadeDurations(3, 2, 10)).toEqual({ fadeInSec: 3, fadeOutSec: 2 });
    });

    it('returns zero fades when clip duration is invalid', () => {
      expect(normalizeClipFadeDurations(2, 3, 0)).toEqual({ fadeInSec: 0, fadeOutSec: 0 });
      expect(normalizeClipFadeDurations(2, 3, Number.NaN)).toEqual({ fadeInSec: 0, fadeOutSec: 0 });
    });
  });

  describe('getClipFadeFactor', () => {
    it('returns expected fade factor near clip edges', () => {
      const clip = createClip({
        audio: {
          volumeDb: 0,
          pan: 0,
          muted: false,
          fadeInSec: 2,
          fadeOutSec: 2,
        },
      });

      expect(getClipFadeFactor(clip, 0)).toBe(0);
      expect(getClipFadeFactor(clip, 1)).toBeCloseTo(0.5, 2);
      expect(getClipFadeFactor(clip, 5)).toBe(1);
      expect(getClipFadeFactor(clip, 9)).toBeCloseTo(0.5, 2);
      expect(getClipFadeFactor(clip, 10)).toBe(0);
    });
  });
});
