/**
 * useKeyframeAnimation Hook Tests
 *
 * Tests for the hook that calculates animated parameter values
 * based on keyframes and current playhead time.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyframeAnimation, useAnimatedEffect } from './useKeyframeAnimation';
import type { Effect, Keyframe, ParamValue } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

const createKeyframe = (
  timeOffset: number,
  value: number,
  easing: Keyframe['easing'] = 'linear'
): Keyframe => ({
  timeOffset,
  value: { type: 'float', value },
  easing,
});

const createEffect = (
  params: Record<string, number>,
  keyframes: Record<string, Keyframe[]> = {}
): Effect => ({
  id: 'effect_001',
  effectType: 'brightness',
  enabled: true,
  params,
  keyframes,
  order: 0,
});

// =============================================================================
// useKeyframeAnimation Tests
// =============================================================================

describe('useKeyframeAnimation', () => {
  describe('basic functionality', () => {
    it('should return static value when no keyframes', () => {
      const keyframes: Keyframe[] = [];
      const defaultValue: ParamValue = { type: 'float', value: 0.5 };

      const { result } = renderHook(() =>
        useKeyframeAnimation(keyframes, 0, defaultValue)
      );

      expect(result.current).toBe(0.5);
    });

    it('should interpolate value based on time', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result: result1 } = renderHook(() =>
        useKeyframeAnimation(keyframes, 0.5)
      );
      expect(result1.current).toBe(50);

      const { result: result2 } = renderHook(() =>
        useKeyframeAnimation(keyframes, 0.25)
      );
      expect(result2.current).toBe(25);
    });

    it('should update when time changes', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result, rerender } = renderHook(
        ({ time }) => useKeyframeAnimation(keyframes, time),
        { initialProps: { time: 0 } }
      );

      expect(result.current).toBe(0);

      rerender({ time: 0.5 });
      expect(result.current).toBe(50);

      rerender({ time: 1 });
      expect(result.current).toBe(100);
    });
  });

  describe('memoization', () => {
    it('should return same reference for same inputs', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result, rerender } = renderHook(
        ({ keyframes, time }) => useKeyframeAnimation(keyframes, time),
        { initialProps: { keyframes, time: 0.5 } }
      );

      const firstResult = result.current;
      rerender({ keyframes, time: 0.5 });
      const secondResult = result.current;

      // Primitive values are compared by value
      expect(firstResult).toBe(secondResult);
    });
  });
});

// =============================================================================
// useAnimatedEffect Tests
// =============================================================================

describe('useAnimatedEffect', () => {
  describe('basic functionality', () => {
    it('should return static params when no keyframes', () => {
      const effect = createEffect({ brightness: 0.5, contrast: 1.0 });

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0)
      );

      expect(result.current.brightness).toBe(0.5);
      expect(result.current.contrast).toBe(1.0);
    });

    it('should animate single parameter with keyframes', () => {
      const effect = createEffect(
        { brightness: 0 },
        {
          brightness: [
            createKeyframe(0, 0),
            createKeyframe(1, 1),
          ],
        }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      expect(result.current.brightness).toBe(0.5);
    });

    it('should animate multiple parameters independently', () => {
      const effect = createEffect(
        { brightness: 0, contrast: 0 },
        {
          brightness: [
            createKeyframe(0, 0),
            createKeyframe(2, 100),
          ],
          contrast: [
            createKeyframe(0, 0),
            createKeyframe(1, 50),
          ],
        }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 1)
      );

      // brightness: at t=1, 50% through 0->100 = 50
      expect(result.current.brightness).toBe(50);
      // contrast: at t=1, 100% through 0->50 = 50
      expect(result.current.contrast).toBe(50);
    });

    it('should mix static and animated parameters', () => {
      const effect = createEffect(
        { brightness: 0, contrast: 0.5, saturation: 1.0 },
        {
          brightness: [
            createKeyframe(0, 0),
            createKeyframe(1, 100),
          ],
          // contrast has no keyframes, uses static value
          // saturation has no keyframes, uses static value
        }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      expect(result.current.brightness).toBe(50); // Animated
      expect(result.current.contrast).toBe(0.5);  // Static
      expect(result.current.saturation).toBe(1.0); // Static
    });
  });

  describe('time offset', () => {
    it('should respect effect start time offset', () => {
      const effect = createEffect(
        { brightness: 0 },
        {
          brightness: [
            createKeyframe(0, 0),
            createKeyframe(1, 100),
          ],
        }
      );

      // Effect starts at 5 seconds on timeline
      const effectStartTime = 5;

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 5.5, { effectStartTime })
      );

      // At timeline time 5.5, effect time is 0.5
      expect(result.current.brightness).toBe(50);
    });
  });

  describe('disabled effect', () => {
    it('should return static params when effect is disabled', () => {
      const effect: Effect = {
        ...createEffect(
          { brightness: 0 },
          {
            brightness: [
              createKeyframe(0, 0),
              createKeyframe(1, 100),
            ],
          }
        ),
        enabled: false,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      // Returns static params, not animated
      expect(result.current.brightness).toBe(0);
    });
  });

  describe('memoization', () => {
    it('should return same reference for same inputs', () => {
      const effect = createEffect(
        { brightness: 0.5 },
        {
          brightness: [
            createKeyframe(0, 0),
            createKeyframe(1, 100),
          ],
        }
      );

      const { result, rerender } = renderHook(
        ({ effect, time }) => useAnimatedEffect(effect, time),
        { initialProps: { effect, time: 0.5 } }
      );

      const firstResult = result.current;
      rerender({ effect, time: 0.5 });
      const secondResult = result.current;

      expect(firstResult).toBe(secondResult);
    });
  });
});

// =============================================================================
// Destructive / Edge Case Tests
// =============================================================================

describe('Security and Edge Cases', () => {
  describe('invalid time inputs', () => {
    it('should handle NaN time gracefully', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result } = renderHook(() =>
        useKeyframeAnimation(keyframes, NaN)
      );

      // Should not return NaN
      expect(Number.isFinite(result.current as number)).toBe(true);
    });

    it('should handle Infinity time gracefully', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result } = renderHook(() =>
        useKeyframeAnimation(keyframes, Infinity)
      );

      // Should return last keyframe value
      expect(result.current).toBe(100);
    });
  });

  describe('empty and null handling', () => {
    it('should handle empty effect params', () => {
      const effect = createEffect({}, {});

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      expect(result.current).toEqual({});
    });

    it('should handle effect with undefined keyframes', () => {
      const effect: Effect = {
        id: 'effect_001',
        effectType: 'brightness',
        enabled: true,
        params: { value: 0.5 },
        keyframes: undefined as unknown as Record<string, Keyframe[]>,
        order: 0,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      // Should not crash
      expect(result.current).toBeDefined();
    });
  });

  describe('rapid updates simulation', () => {
    it('should handle rapid time changes without memory leaks', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result, rerender } = renderHook(
        ({ time }) => useKeyframeAnimation(keyframes, time),
        { initialProps: { time: 0 } }
      );

      // Simulate 60fps playback for 1 second
      for (let i = 0; i < 60; i++) {
        rerender({ time: i / 60 });
        expect(Number.isFinite(result.current as number)).toBe(true);
      }
    });

    it('should handle effect ID changes mid-animation', () => {
      const effect1 = createEffect(
        { brightness: 0 },
        { brightness: [createKeyframe(0, 0), createKeyframe(1, 100)] }
      );

      const effect2: Effect = {
        ...createEffect(
          { brightness: 0 },
          { brightness: [createKeyframe(0, 50), createKeyframe(1, 150)] }
        ),
        id: 'effect_002',
      };

      const { result, rerender } = renderHook(
        ({ effect, time }) => useAnimatedEffect(effect, time),
        { initialProps: { effect: effect1, time: 0.5 } }
      );

      expect(result.current.brightness).toBe(50);

      // Switch to different effect mid-animation
      rerender({ effect: effect2, time: 0.5 });

      expect(result.current.brightness).toBe(100); // 50 + (150-50)*0.5
    });
  });

  describe('disabled state transitions', () => {
    it('should handle toggling enabled state', () => {
      const effect = createEffect(
        { brightness: 0 },
        { brightness: [createKeyframe(0, 0), createKeyframe(1, 100)] }
      );

      const { result, rerender } = renderHook(
        ({ effect, time }) => useAnimatedEffect(effect, time),
        { initialProps: { effect, time: 0.5 } }
      );

      expect(result.current.brightness).toBe(50);

      // Disable effect
      const disabledEffect = { ...effect, enabled: false };
      rerender({ effect: disabledEffect, time: 0.5 });

      // Should return static value when disabled
      expect(result.current.brightness).toBe(0);

      // Re-enable effect
      rerender({ effect, time: 0.5 });
      expect(result.current.brightness).toBe(50);
    });
  });

  describe('effect start time offset', () => {
    it('should handle negative effect start time', () => {
      const effect = createEffect(
        { brightness: 0 },
        { brightness: [createKeyframe(0, 0), createKeyframe(1, 100)] }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5, { effectStartTime: -1 })
      );

      // Local time = 0.5 - (-1) = 1.5, after last keyframe
      expect(result.current.brightness).toBe(100);
    });

    it('should handle very large effect start time', () => {
      const effect = createEffect(
        { brightness: 0 },
        { brightness: [createKeyframe(0, 0), createKeyframe(1, 100)] }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 100, { effectStartTime: 1000 })
      );

      // Local time = 100 - 1000 = -900, before first keyframe
      expect(result.current.brightness).toBe(0);
    });

    it('should handle NaN effect start time', () => {
      const effect = createEffect(
        { brightness: 0 },
        { brightness: [createKeyframe(0, 0), createKeyframe(1, 100)] }
      );

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5, { effectStartTime: NaN })
      );

      // Should treat NaN as 0
      expect(result.current.brightness).toBe(50);
    });
  });

  describe('keyframes array mutation safety', () => {
    it('should not be affected by keyframes array mutation after hook call', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      const { result, rerender } = renderHook(
        ({ keyframes, time }) => useKeyframeAnimation(keyframes, time),
        { initialProps: { keyframes, time: 0.5 } }
      );

      expect(result.current).toBe(50);

      // Mutate the original array (bad practice, but should be safe)
      keyframes.push(createKeyframe(2, 200));

      // Rerender with same reference should still work
      rerender({ keyframes, time: 0.5 });

      // Result may change due to new keyframe, but should not crash
      expect(Number.isFinite(result.current as number)).toBe(true);
    });
  });

  describe('interpolation failure fallback', () => {
    it('should fallback to static value when interpolation returns undefined', () => {
      const effect: Effect = {
        id: 'effect_001',
        effectType: 'brightness',
        enabled: true,
        params: { value: 0.75 },
        keyframes: {
          // Empty keyframes array should trigger fallback
          value: [],
        },
        order: 0,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      // Should return static value since keyframes is empty
      expect(result.current.value).toBe(0.75);
    });

    it('should handle keyframes with corrupted values', () => {
      const effect: Effect = {
        id: 'effect_001',
        effectType: 'brightness',
        enabled: true,
        params: { value: 0.5 },
        keyframes: {
          value: [
            { timeOffset: 0, value: null as unknown as ParamValue, easing: 'linear' },
            createKeyframe(1, 100),
          ],
        },
        order: 0,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      // Should not crash, may return interpolated or fallback value
      expect(result.current.value).toBeDefined();
    });
  });

  describe('parameter name edge cases', () => {
    it('should handle parameter names with special characters', () => {
      const effect: Effect = {
        id: 'effect_001',
        effectType: 'brightness',
        enabled: true,
        params: { 'param.with.dots': 0.5, 'param-with-dashes': 0.3 },
        keyframes: {},
        order: 0,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      expect(result.current['param.with.dots']).toBe(0.5);
      expect(result.current['param-with-dashes']).toBe(0.3);
    });

    it('should handle empty parameter name', () => {
      const effect: Effect = {
        id: 'effect_001',
        effectType: 'brightness',
        enabled: true,
        params: { '': 0.5 },
        keyframes: {},
        order: 0,
      };

      const { result } = renderHook(() =>
        useAnimatedEffect(effect, 0.5)
      );

      // Empty key is valid in JS objects
      expect(result.current['']).toBe(0.5);
    });
  });

  describe('stable reference optimization', () => {
    it('should maintain reference stability when time changes but values do not', () => {
      const effect = createEffect(
        { brightness: 0 },
        {
          brightness: [
            createKeyframe(0, 100),
            createKeyframe(10, 100), // Same value throughout!
          ],
        }
      );

      const { result, rerender } = renderHook(
        ({ time }) => useAnimatedEffect(effect, time),
        { initialProps: { time: 0 } }
      );

      const firstResult = result.current;

      // Time changes but interpolated value stays the same (100)
      rerender({ time: 5 });
      const secondResult = result.current;

      // Should return same reference since value hasn't changed
      expect(firstResult).toBe(secondResult);
    });
  });
});
