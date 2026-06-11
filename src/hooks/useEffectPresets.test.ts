import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@/types';
import { serializeEffectPresetKeyframes } from './useEffectPresets';

describe('useEffectPresets', () => {
  it('should serialize UI keyframe values to backend effect preset values', () => {
    const keyframes: Record<string, Keyframe[]> = {
      radius: [
        {
          timeOffset: 0,
          value: { type: 'float', value: 4 },
          easing: 'linear',
        },
        {
          timeOffset: 1,
          value: { type: 'float', value: 12 },
          easing: 'ease_out',
        },
      ],
    };

    expect(serializeEffectPresetKeyframes(keyframes)).toEqual({
      radius: [
        { timeOffset: 0, value: 4, easing: 'linear' },
        { timeOffset: 1, value: 12, easing: 'ease_out' },
      ],
    });
  });
});
