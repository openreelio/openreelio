/**
 * Keyframe Interpolation Tests
 *
 * Tests for keyframe value interpolation with various easing functions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import {
  interpolateValue,
  getValueAtTime,
  easingFunctions,
  type InterpolationOptions,
} from './keyframeInterpolation';
import type { Keyframe, ParamValue } from '@/types';

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

// =============================================================================
// Easing Function Tests
// =============================================================================

describe('easingFunctions', () => {
  describe('linear', () => {
    it('should return same value as input', () => {
      expect(easingFunctions.linear(0)).toBe(0);
      expect(easingFunctions.linear(0.5)).toBe(0.5);
      expect(easingFunctions.linear(1)).toBe(1);
    });
  });

  describe('ease_in', () => {
    it('should start slow and accelerate', () => {
      expect(easingFunctions.ease_in(0)).toBe(0);
      expect(easingFunctions.ease_in(1)).toBe(1);
      // Should be less than linear at midpoint
      expect(easingFunctions.ease_in(0.5)).toBeLessThan(0.5);
    });
  });

  describe('ease_out', () => {
    it('should start fast and decelerate', () => {
      expect(easingFunctions.ease_out(0)).toBe(0);
      expect(easingFunctions.ease_out(1)).toBe(1);
      // Should be greater than linear at midpoint
      expect(easingFunctions.ease_out(0.5)).toBeGreaterThan(0.5);
    });
  });

  describe('ease_in_out', () => {
    it('should start slow, accelerate, then decelerate', () => {
      expect(easingFunctions.ease_in_out(0)).toBe(0);
      expect(easingFunctions.ease_in_out(1)).toBe(1);
      // Midpoint should be exactly 0.5 for symmetric easing
      expect(easingFunctions.ease_in_out(0.5)).toBeCloseTo(0.5, 5);
    });
  });

  describe('step', () => {
    it('should return 0 until the end, then 1', () => {
      expect(easingFunctions.step(0)).toBe(0);
      expect(easingFunctions.step(0.5)).toBe(0);
      expect(easingFunctions.step(0.99)).toBe(0);
      expect(easingFunctions.step(1)).toBe(1);
    });
  });

  describe('hold', () => {
    it('should return 0 always (hold previous value)', () => {
      expect(easingFunctions.hold(0)).toBe(0);
      expect(easingFunctions.hold(0.5)).toBe(0);
      expect(easingFunctions.hold(1)).toBe(0);
    });
  });

  describe('cubic_bezier', () => {
    it('should return linear interpolation for default bezier', () => {
      // Default cubic bezier is linear-ish
      expect(easingFunctions.cubic_bezier(0)).toBe(0);
      expect(easingFunctions.cubic_bezier(1)).toBe(1);
    });
  });
});

// =============================================================================
// Value Interpolation Tests
// =============================================================================

describe('interpolateValue', () => {
  describe('float values', () => {
    it('should interpolate between two float values', () => {
      const from: ParamValue = { type: 'float', value: 0 };
      const to: ParamValue = { type: 'float', value: 100 };

      expect(interpolateValue(from, to, 0)).toBe(0);
      expect(interpolateValue(from, to, 0.5)).toBe(50);
      expect(interpolateValue(from, to, 1)).toBe(100);
    });

    it('should handle negative values', () => {
      const from: ParamValue = { type: 'float', value: -50 };
      const to: ParamValue = { type: 'float', value: 50 };

      expect(interpolateValue(from, to, 0.5)).toBe(0);
    });
  });

  describe('int values', () => {
    it('should interpolate and round to nearest integer', () => {
      const from: ParamValue = { type: 'int', value: 0 };
      const to: ParamValue = { type: 'int', value: 10 };

      expect(interpolateValue(from, to, 0.25)).toBe(3); // 2.5 rounded
      expect(interpolateValue(from, to, 0.5)).toBe(5);
    });
  });

  describe('bool values', () => {
    it('should return from value until t >= 0.5, then to value', () => {
      const from: ParamValue = { type: 'bool', value: false };
      const to: ParamValue = { type: 'bool', value: true };

      expect(interpolateValue(from, to, 0)).toBe(false);
      expect(interpolateValue(from, to, 0.49)).toBe(false);
      expect(interpolateValue(from, to, 0.5)).toBe(true);
      expect(interpolateValue(from, to, 1)).toBe(true);
    });
  });

  describe('string values', () => {
    it('should return from value until t >= 0.5, then to value', () => {
      const from: ParamValue = { type: 'string', value: 'hello' };
      const to: ParamValue = { type: 'string', value: 'world' };

      expect(interpolateValue(from, to, 0.4)).toBe('hello');
      expect(interpolateValue(from, to, 0.6)).toBe('world');
    });
  });

  describe('color values', () => {
    it('should interpolate RGBA components', () => {
      const from: ParamValue = { type: 'color', value: [0, 0, 0, 255] };
      const to: ParamValue = { type: 'color', value: [255, 255, 255, 255] };

      const result = interpolateValue(from, to, 0.5);
      expect(result).toEqual([128, 128, 128, 255]);
    });
  });

  describe('point values', () => {
    it('should interpolate x and y components', () => {
      const from: ParamValue = { type: 'point', value: [0, 0] };
      const to: ParamValue = { type: 'point', value: [100, 200] };

      const result = interpolateValue(from, to, 0.5);
      expect(result).toEqual([50, 100]);
    });
  });

  describe('range values', () => {
    it('should interpolate min and max components', () => {
      const from: ParamValue = { type: 'range', value: [0, 100] };
      const to: ParamValue = { type: 'range', value: [50, 200] };

      const result = interpolateValue(from, to, 0.5);
      expect(result).toEqual([25, 150]);
    });
  });
});

// =============================================================================
// getValueAtTime Tests
// =============================================================================

describe('getValueAtTime', () => {
  describe('basic interpolation', () => {
    it('should return first keyframe value before first keyframe', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(1, 0),
        createKeyframe(2, 100),
      ];

      expect(getValueAtTime(keyframes, 0)).toBe(0);
      expect(getValueAtTime(keyframes, 0.5)).toBe(0);
    });

    it('should return last keyframe value after last keyframe', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(1, 0),
        createKeyframe(2, 100),
      ];

      expect(getValueAtTime(keyframes, 3)).toBe(100);
      expect(getValueAtTime(keyframes, 10)).toBe(100);
    });

    it('should interpolate between keyframes', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      expect(getValueAtTime(keyframes, 0.5)).toBe(50);
    });

    it('should return exact keyframe value at keyframe time', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 50),
        createKeyframe(2, 100),
      ];

      expect(getValueAtTime(keyframes, 0)).toBe(0);
      expect(getValueAtTime(keyframes, 1)).toBe(50);
      expect(getValueAtTime(keyframes, 2)).toBe(100);
    });
  });

  describe('with easing', () => {
    it('should apply ease_in easing', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0, 'ease_in'),
        createKeyframe(1, 100),
      ];

      const value = getValueAtTime(keyframes, 0.5);
      // ease_in should produce a value less than 50 at midpoint
      expect(value).toBeLessThan(50);
    });

    it('should apply ease_out easing', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0, 'ease_out'),
        createKeyframe(1, 100),
      ];

      const value = getValueAtTime(keyframes, 0.5);
      // ease_out should produce a value greater than 50 at midpoint
      expect(value).toBeGreaterThan(50);
    });

    it('should apply step easing', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0, 'step'),
        createKeyframe(1, 100),
      ];

      expect(getValueAtTime(keyframes, 0)).toBe(0);
      expect(getValueAtTime(keyframes, 0.5)).toBe(0);
      expect(getValueAtTime(keyframes, 0.99)).toBe(0);
      expect(getValueAtTime(keyframes, 1)).toBe(100);
    });

    it('should apply hold easing', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0, 'hold'),
        createKeyframe(1, 100),
      ];

      // Hold keeps the value constant until the next keyframe is reached exactly
      expect(getValueAtTime(keyframes, 0)).toBe(0);
      expect(getValueAtTime(keyframes, 0.5)).toBe(0);
      expect(getValueAtTime(keyframes, 0.99)).toBe(0);
      // At exactly keyframe time, return that keyframe's value
      expect(getValueAtTime(keyframes, 1)).toBe(100);
    });
  });

  describe('edge cases', () => {
    it('should handle empty keyframes array', () => {
      expect(getValueAtTime([], 0)).toBeUndefined();
    });

    it('should handle single keyframe', () => {
      const keyframes: Keyframe[] = [createKeyframe(1, 50)];

      expect(getValueAtTime(keyframes, 0)).toBe(50);
      expect(getValueAtTime(keyframes, 1)).toBe(50);
      expect(getValueAtTime(keyframes, 2)).toBe(50);
    });

    it('should handle unsorted keyframes', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(2, 100),
        createKeyframe(0, 0),
        createKeyframe(1, 50),
      ];

      expect(getValueAtTime(keyframes, 0.5)).toBe(25);
      expect(getValueAtTime(keyframes, 1.5)).toBe(75);
    });
  });

  describe('multiple segments', () => {
    it('should interpolate correctly across multiple keyframe segments', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
        createKeyframe(2, 50),
        createKeyframe(3, 200),
      ];

      expect(getValueAtTime(keyframes, 0.5)).toBe(50);   // 0 -> 100
      expect(getValueAtTime(keyframes, 1.5)).toBe(75);   // 100 -> 50
      expect(getValueAtTime(keyframes, 2.5)).toBe(125);  // 50 -> 200
    });
  });

  describe('with default value', () => {
    it('should return default value for empty keyframes', () => {
      const options: InterpolationOptions = { defaultValue: 42 };
      expect(getValueAtTime([], 0, options)).toBe(42);
    });
  });
});

// =============================================================================
// Destructive / Edge Case Tests
// =============================================================================

describe('Security and Edge Cases', () => {
  describe('NaN and Infinity handling', () => {
    it('should handle NaN time input gracefully', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];
      // NaN should be treated as 0
      const result = getValueAtTime(keyframes, NaN);
      expect(result).toBe(0);
    });

    it('should handle Infinity time input gracefully', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];
      // Infinity should return last keyframe value
      expect(getValueAtTime(keyframes, Infinity)).toBe(100);
      expect(getValueAtTime(keyframes, -Infinity)).toBe(0);
    });

    it('should handle NaN in keyframe values', () => {
      const keyframes: Keyframe[] = [
        { timeOffset: 0, value: { type: 'float', value: NaN }, easing: 'linear' },
        createKeyframe(1, 100),
      ];
      const result = getValueAtTime(keyframes, 0.5);
      // Should not propagate NaN
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle Infinity in keyframe values', () => {
      const keyframes: Keyframe[] = [
        { timeOffset: 0, value: { type: 'float', value: Infinity }, easing: 'linear' },
        createKeyframe(1, 100),
      ];
      const result = getValueAtTime(keyframes, 0.5);
      // Should not propagate Infinity
      expect(Number.isFinite(result as number)).toBe(true);
    });
  });

  describe('zero-duration segments', () => {
    it('should handle keyframes at same time offset', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(1, 0),
        createKeyframe(1, 100), // Same time!
      ];
      // Should not cause division by zero
      const result = getValueAtTime(keyframes, 1);
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle very small duration segments', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(0.0000001, 100),
      ];
      const result = getValueAtTime(keyframes, 0.00000005);
      expect(Number.isFinite(result as number)).toBe(true);
    });
  });

  describe('type mismatch handling', () => {
    it('should handle mismatched types between keyframes', () => {
      const from: ParamValue = { type: 'float', value: 0 };
      const to: ParamValue = { type: 'int', value: 100 };

      // Should not crash, returns from value
      const result = interpolateValue(from, to, 0.5);
      expect(result).toBe(0);
    });

    it('should handle corrupted color arrays', () => {
      const from: ParamValue = { type: 'color', value: [0, 0, 0] as unknown as [number, number, number, number] };
      const to: ParamValue = { type: 'color', value: [255, 255, 255, 255] };

      // Should not crash with invalid array length
      const result = interpolateValue(from, to, 0.5);
      expect(result).toBeDefined();
    });
  });

  describe('extreme values', () => {
    it('should handle very large time values', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1e10, 100),
      ];
      const result = getValueAtTime(keyframes, 5e9);
      expect(result).toBe(50);
    });

    it('should handle negative time values', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(-10, 0),
        createKeyframe(0, 50),
        createKeyframe(10, 100),
      ];
      expect(getValueAtTime(keyframes, -5)).toBe(25);
      expect(getValueAtTime(keyframes, -100)).toBe(0); // Before first keyframe
    });

    it('should handle color component overflow', () => {
      const from: ParamValue = { type: 'color', value: [200, 200, 200, 255] };
      const to: ParamValue = { type: 'color', value: [300, 300, 300, 300] }; // Invalid

      const result = interpolateValue(from, to, 0.5) as [number, number, number, number];
      // Should clamp to valid range
      result.forEach((component) => {
        expect(component).toBeLessThanOrEqual(255);
        expect(component).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('performance edge cases', () => {
    it('should handle large keyframe arrays efficiently', () => {
      // Create 1000 keyframes
      const keyframes: Keyframe[] = Array.from({ length: 1000 }, (_, i) =>
        createKeyframe(i * 0.1, i * 10)
      );

      const startTime = performance.now();
      for (let i = 0; i < 1000; i++) {
        getValueAtTime(keyframes, i * 0.05);
      }
      const elapsed = performance.now() - startTime;

      // Should complete in reasonable time (< 100ms for 1000 lookups)
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('concurrent access simulation', () => {
    it('should handle rapid sequential calls with same keyframes', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
      ];

      // Simulate rapid calls (like during playback)
      const results: number[] = [];
      for (let t = 0; t <= 1; t += 0.001) {
        results.push(getValueAtTime(keyframes, t) as number);
      }

      // All results should be valid
      results.forEach((r) => {
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(100);
      });
    });
  });

  describe('malformed ParamValue handling', () => {
    it('should handle ParamValue with missing value property', () => {
      const from = { type: 'float' } as unknown as ParamValue;
      const to: ParamValue = { type: 'float', value: 100 };

      // Should not crash, should return safe fallback
      const result = interpolateValue(from, to, 0.5);
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle ParamValue with null value', () => {
      const from: ParamValue = { type: 'float', value: null as unknown as number };
      const to: ParamValue = { type: 'float', value: 100 };

      const result = interpolateValue(from, to, 0.5);
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle ParamValue with wrong type in value field', () => {
      const from: ParamValue = { type: 'float', value: 'not a number' as unknown as number };
      const to: ParamValue = { type: 'float', value: 100 };

      const result = interpolateValue(from, to, 0.5);
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle completely corrupted keyframe', () => {
      const keyframes: Keyframe[] = [
        { timeOffset: 0, value: null as unknown as ParamValue, easing: 'linear' },
        createKeyframe(1, 100),
      ];

      // Should not crash
      const result = getValueAtTime(keyframes, 0.5);
      expect(result).toBeDefined();
    });
  });

  describe('binary search edge cases', () => {
    it('should correctly find segment at exact boundary between keyframes', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1, 100),
        createKeyframe(2, 200),
      ];

      // Exactly at the boundary
      expect(getValueAtTime(keyframes, 1)).toBe(100);
    });

    it('should handle two keyframes with same time offset', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(0.5, 50),
        createKeyframe(0.5, 75), // Duplicate time!
        createKeyframe(1, 100),
      ];

      // Should not crash, result depends on sort stability
      const result = getValueAtTime(keyframes, 0.5);
      expect(result).toBeDefined();
      expect(Number.isFinite(result as number)).toBe(true);
    });

    it('should handle time exactly between first two keyframes with many keyframes', () => {
      const keyframes: Keyframe[] = Array.from({ length: 100 }, (_, i) =>
        createKeyframe(i, i * 10)
      );

      // Exactly between keyframe 0 and 1
      expect(getValueAtTime(keyframes, 0.5)).toBe(5);
    });

    it('should handle time exactly between last two keyframes with many keyframes', () => {
      const keyframes: Keyframe[] = Array.from({ length: 100 }, (_, i) =>
        createKeyframe(i, i * 10)
      );

      // Exactly between keyframe 98 and 99
      expect(getValueAtTime(keyframes, 98.5)).toBe(985);
    });
  });

  describe('floating-point precision edge cases', () => {
    it('should handle 0.1 + 0.2 floating point precision issue', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(0.3, 30), // Note: 0.1 + 0.2 !== 0.3 in JS
        createKeyframe(1, 100),
      ];

      // Should handle floating point comparison correctly
      const result = getValueAtTime(keyframes, 0.1 + 0.2);
      expect(Number.isFinite(result as number)).toBe(true);
      expect(result).toBeCloseTo(30, 1);
    });

    it('should handle very small time differences', () => {
      const keyframes: Keyframe[] = [
        createKeyframe(0, 0),
        createKeyframe(1e-10, 100),
      ];

      expect(getValueAtTime(keyframes, 0)).toBe(0);
      expect(getValueAtTime(keyframes, 1e-10)).toBe(100);
    });
  });

  describe('easing function robustness', () => {
    it('should handle unknown easing function gracefully', () => {
      const keyframes: Keyframe[] = [
        { timeOffset: 0, value: { type: 'float', value: 0 }, easing: 'unknown_easing' as Keyframe['easing'] },
        createKeyframe(1, 100),
      ];

      // Should fall back to linear
      const result = getValueAtTime(keyframes, 0.5);
      expect(result).toBeCloseTo(50, 1);
    });

    it('should handle all easing types without crashing', () => {
      const easings: Keyframe['easing'][] = [
        'linear', 'ease_in', 'ease_out', 'ease_in_out', 'step', 'hold', 'cubic_bezier'
      ];

      for (const easing of easings) {
        const keyframes: Keyframe[] = [
          { timeOffset: 0, value: { type: 'float', value: 0 }, easing },
          createKeyframe(1, 100),
        ];

        const result = getValueAtTime(keyframes, 0.5);
        expect(Number.isFinite(result as number)).toBe(true);
      }
    });
  });

  describe('array type validation', () => {
    it('should handle color with wrong array length', () => {
      const from: ParamValue = { type: 'color', value: [0, 0] as unknown as [number, number, number, number] };
      const to: ParamValue = { type: 'color', value: [255, 255, 255, 255] };

      const result = interpolateValue(from, to, 0.5);
      // Should return a valid fallback color
      expect(Array.isArray(result)).toBe(true);
      expect((result as number[]).length).toBe(4);
    });

    it('should handle point with wrong array length', () => {
      const from: ParamValue = { type: 'point', value: [0] as unknown as [number, number] };
      const to: ParamValue = { type: 'point', value: [100, 200] };

      const result = interpolateValue(from, to, 0.5);
      expect(Array.isArray(result)).toBe(true);
      expect((result as number[]).length).toBe(2);
    });

    it('should handle range with wrong array length', () => {
      const from: ParamValue = { type: 'range', value: [0, 1, 2] as unknown as [number, number] };
      const to: ParamValue = { type: 'range', value: [50, 100] };

      const result = interpolateValue(from, to, 0.5);
      expect(Array.isArray(result)).toBe(true);
      expect((result as number[]).length).toBe(2);
    });

    it('should handle arrays with NaN elements', () => {
      const from: ParamValue = { type: 'color', value: [NaN, 0, 0, 255] };
      const to: ParamValue = { type: 'color', value: [255, 255, 255, 255] };

      const result = interpolateValue(from, to, 0.5) as number[];
      // All components should be valid numbers
      result.forEach((component) => {
        expect(Number.isFinite(component)).toBe(true);
      });
    });
  });
});
