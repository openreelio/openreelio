import { describe, expect, it } from 'vitest';
import type { Clip, Effect } from '@/types';
import { getClipTransitionEffect, isTransitionEffect } from './transitions';

const baseEffect: Effect = {
  id: 'effect-1',
  effectType: 'cross_dissolve',
  enabled: true,
  params: { duration: 1 },
  keyframes: {},
  order: 0,
};

const baseClip: Clip = {
  id: 'clip-1',
  assetId: 'asset-1',
  range: { sourceInSec: 0, sourceOutSec: 5 },
  place: { timelineInSec: 0, durationSec: 5 },
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: ['effect-1'],
  audio: { volumeDb: 0, pan: 0, muted: false },
};

describe('transitions utils', () => {
  it('should identify transition effects', () => {
    expect(isTransitionEffect(baseEffect)).toBe(true);
    expect(isTransitionEffect({ ...baseEffect, effectType: 'brightness' })).toBe(false);
  });

  it('should resolve the first transition effect on a clip', () => {
    const effects = new Map<string, Effect>([
      ['effect-1', baseEffect],
      ['effect-2', { ...baseEffect, id: 'effect-2', effectType: 'brightness' }],
    ]);

    expect(getClipTransitionEffect(baseClip, effects)).toEqual(baseEffect);
  });
});
