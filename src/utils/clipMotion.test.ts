import { describe, expect, it } from 'vitest';
import type { Clip } from '@/types';
import {
  getClipMaxMotionScale,
  getClipMotionTransformAtTime,
  hasActiveMotionKeyframes,
} from './clipMotion';

function createClip(): Clip {
  return {
    id: 'clip-motion',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 10 },
    place: { timelineInSec: 5, durationSec: 10 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  };
}

describe('clipMotion', () => {
  it('should return static transform when no motion keyframes exist', () => {
    const clip = createClip();

    expect(getClipMotionTransformAtTime(clip, 7)).toEqual(clip.transform);
  });

  it('should interpolate transform keyframes relative to clip start', () => {
    const clip = createClip();
    clip.motionKeyframes = [
      {
        timeOffset: 0,
        interpolation: 'linear',
        transform: {
          ...clip.transform,
          position: { x: 0.4, y: 0.5 },
          scale: { x: 1, y: 1 },
        },
      },
      {
        timeOffset: 10,
        interpolation: 'linear',
        transform: {
          ...clip.transform,
          position: { x: 0.6, y: 0.5 },
          scale: { x: 1.4, y: 1.4 },
        },
      },
    ];

    const transform = getClipMotionTransformAtTime(clip, 10);

    expect(transform.position.x).toBeCloseTo(0.5);
    expect(transform.position.y).toBeCloseTo(0.5);
    expect(transform.scale.x).toBeCloseTo(1.2);
    expect(transform.scale.y).toBeCloseTo(1.2);
  });

  describe('hasActiveMotionKeyframes', () => {
    it('should report false when the clip has no keyframes', () => {
      expect(hasActiveMotionKeyframes(createClip())).toBe(false);
    });

    it('should report true when at least one keyframe drives the sampler', () => {
      const clip = createClip();
      clip.motionKeyframes = [
        { timeOffset: 0, interpolation: 'linear', transform: clip.transform },
      ];

      expect(hasActiveMotionKeyframes(clip)).toBe(true);
    });

    it('should report false when every keyframe is discarded by the sampler', () => {
      const clip = createClip();
      clip.motionKeyframes = [
        { timeOffset: Number.NaN, interpolation: 'linear', transform: clip.transform },
        { timeOffset: -1, interpolation: 'linear', transform: clip.transform },
      ];

      // The sampler falls back to the static transform for these, so nothing is
      // actually keyframed and the transform stays directly editable.
      expect(hasActiveMotionKeyframes(clip)).toBe(false);
      expect(getClipMotionTransformAtTime(clip, 7)).toEqual(clip.transform);
    });
  });
  describe('getClipMaxMotionScale', () => {
    it('should report the static transform scale when the clip has no keyframes', () => {
      const clip = createClip();
      clip.transform.scale = { x: 1.75, y: 1.25 };

      expect(getClipMaxMotionScale(clip)).toBe(1.75);
    });

    it('should report the widest keyframe rather than the scale at any instant', () => {
      // Callers size a decode box off this, and a box that tracked the
      // instantaneous scale would change on every rendered frame.
      const clip = createClip();
      clip.motionKeyframes = [
        {
          timeOffset: 0,
          interpolation: 'linear',
          transform: { ...clip.transform, scale: { x: 1, y: 1 } },
        },
        {
          timeOffset: 5,
          interpolation: 'linear',
          transform: { ...clip.transform, scale: { x: 2.5, y: 2.5 } },
        },
        {
          timeOffset: 10,
          interpolation: 'linear',
          transform: { ...clip.transform, scale: { x: 1.2, y: 1.2 } },
        },
      ];

      expect(getClipMaxMotionScale(clip)).toBe(2.5);
    });

    it('should take the larger of the two axes', () => {
      const clip = createClip();
      clip.motionKeyframes = [
        {
          timeOffset: 0,
          interpolation: 'linear',
          transform: { ...clip.transform, scale: { x: 1, y: 3 } },
        },
      ];

      expect(getClipMaxMotionScale(clip)).toBe(3);
    });

    it('should fall back to the static transform when every keyframe is discarded', () => {
      const clip = createClip();
      clip.transform.scale = { x: 1.5, y: 1.5 };
      clip.motionKeyframes = [
        {
          timeOffset: Number.NaN,
          interpolation: 'linear',
          transform: { ...clip.transform, scale: { x: 9, y: 9 } },
        },
      ];

      expect(getClipMaxMotionScale(clip)).toBe(1.5);
    });
  });
});
