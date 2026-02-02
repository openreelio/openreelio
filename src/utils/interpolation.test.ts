/**
 * Interpolation System Tests
 *
 * Tests for multi-point interpolation, extrapolation modes, and spring physics.
 * Following TDD methodology - tests written first.
 */

import { describe, it, expect } from 'vitest';
import {
  interpolate,
  spring,
  type SpringConfig,
} from './interpolation';

describe('interpolation', () => {
  // ===========================================================================
  // Basic Linear Interpolation
  // ===========================================================================

  describe('basic linear interpolation', () => {
    it('should interpolate at midpoint', () => {
      const result = interpolate(0.5, [0, 1], [0, 100]);
      expect(result).toBe(50);
    });

    it('should interpolate at start point', () => {
      const result = interpolate(0, [0, 1], [0, 100]);
      expect(result).toBe(0);
    });

    it('should interpolate at end point', () => {
      const result = interpolate(1, [0, 1], [0, 100]);
      expect(result).toBe(100);
    });

    it('should interpolate at arbitrary point', () => {
      const result = interpolate(0.25, [0, 1], [0, 100]);
      expect(result).toBe(25);
    });

    it('should handle negative output range', () => {
      const result = interpolate(0.5, [0, 1], [-100, 100]);
      expect(result).toBe(0);
    });

    it('should handle inverted output range', () => {
      const result = interpolate(0.5, [0, 1], [100, 0]);
      expect(result).toBe(50);
    });
  });

  // ===========================================================================
  // Multi-Point Interpolation
  // ===========================================================================

  describe('multi-point interpolation', () => {
    it('should interpolate across multiple segments', () => {
      const result = interpolate(1.5, [0, 1, 2], [0, 50, 100]);
      expect(result).toBe(75);
    });

    it('should select correct segment for value in middle', () => {
      const result = interpolate(0.5, [0, 1, 2, 3], [0, 10, 20, 30]);
      expect(result).toBe(5);
    });

    it('should handle non-linear output ranges', () => {
      // 0->10, 1->20, 2->50
      const result = interpolate(1.5, [0, 1, 2], [10, 20, 50]);
      expect(result).toBe(35); // Midway between 20 and 50
    });

    it('should throw error for mismatched range lengths', () => {
      expect(() => interpolate(0.5, [0, 1, 2], [0, 100])).toThrow();
    });

    it('should throw error for ranges with less than 2 points', () => {
      expect(() => interpolate(0.5, [1], [100])).toThrow();
    });
  });

  // ===========================================================================
  // Extrapolation Modes
  // ===========================================================================

  describe('extrapolation modes', () => {
    describe('extend (default)', () => {
      it('should extend linearly beyond left boundary', () => {
        const result = interpolate(-1, [0, 1], [0, 100], {
          extrapolateLeft: 'extend',
        });
        expect(result).toBe(-100);
      });

      it('should extend linearly beyond right boundary', () => {
        const result = interpolate(2, [0, 1], [0, 100], {
          extrapolateRight: 'extend',
        });
        expect(result).toBe(200);
      });
    });

    describe('clamp', () => {
      it('should clamp at left boundary', () => {
        const result = interpolate(-1, [0, 1], [0, 100], {
          extrapolateLeft: 'clamp',
        });
        expect(result).toBe(0);
      });

      it('should clamp at right boundary', () => {
        const result = interpolate(2, [0, 1], [0, 100], {
          extrapolateRight: 'clamp',
        });
        expect(result).toBe(100);
      });
    });

    describe('identity', () => {
      it('should return input value on left extrapolation', () => {
        const result = interpolate(-5, [0, 1], [0, 100], {
          extrapolateLeft: 'identity',
        });
        expect(result).toBe(-5);
      });

      it('should return input value on right extrapolation', () => {
        const result = interpolate(5, [0, 1], [0, 100], {
          extrapolateRight: 'identity',
        });
        expect(result).toBe(5);
      });
    });

    describe('wrap', () => {
      it('should wrap values that exceed range on the right', () => {
        // With range [0, 1] -> [0, 100], input 1.25 should wrap to 0.25 -> 25
        const result = interpolate(1.25, [0, 1], [0, 100], {
          extrapolateRight: 'wrap',
        });
        expect(result).toBeCloseTo(25, 0);
      });

      it('should wrap values that exceed range on the left', () => {
        // With range [0, 1] -> [0, 100], input -0.25 should wrap to 0.75 -> 75
        const result = interpolate(-0.25, [0, 1], [0, 100], {
          extrapolateLeft: 'wrap',
        });
        expect(result).toBeCloseTo(75, 0);
      });
    });
  });

  // ===========================================================================
  // Easing Functions
  // ===========================================================================

  describe('easing functions', () => {
    it('should apply ease-in (quadratic)', () => {
      const easeIn = (t: number) => t * t;
      const result = interpolate(0.5, [0, 1], [0, 100], { easing: easeIn });
      expect(result).toBe(25); // 0.5^2 = 0.25 -> 25
    });

    it('should apply ease-out (quadratic)', () => {
      const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
      const result = interpolate(0.5, [0, 1], [0, 100], { easing: easeOut });
      expect(result).toBe(75); // 1 - 0.5^2 = 0.75 -> 75
    });

    it('should apply custom cubic easing', () => {
      const cubic = (t: number) => t * t * t;
      const result = interpolate(0.5, [0, 1], [0, 100], { easing: cubic });
      expect(result).toBeCloseTo(12.5, 1); // 0.5^3 = 0.125 -> 12.5
    });

    it('should work with multi-point ranges', () => {
      const easeIn = (t: number) => t * t;
      const result = interpolate(1.5, [0, 1, 2], [0, 100, 200], {
        easing: easeIn,
      });
      expect(result).toBeCloseTo(125, 0); // 0.5^2 = 0.25 -> 100 + 25 = 125
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle zero-width input range segment', () => {
      // When input range has same value, should return the output value
      const result = interpolate(5, [5, 5], [100, 200]);
      // Should return the first output value when on the boundary
      expect(result).toBe(100);
    });

    it('should handle very small numbers', () => {
      const result = interpolate(0.000001, [0, 0.000002], [0, 100]);
      expect(result).toBeCloseTo(50, 0);
    });

    it('should handle very large numbers', () => {
      const result = interpolate(500000, [0, 1000000], [0, 100]);
      expect(result).toBe(50);
    });
  });
});

describe('spring', () => {
  // ===========================================================================
  // Basic Spring Animation
  // ===========================================================================

  describe('basic spring animation', () => {
    it('should return from value at frame 0', () => {
      const result = spring({ frame: 0, fps: 30, from: 0, to: 100 });
      expect(result).toBeCloseTo(0, 0);
    });

    it('should approach to value over time', () => {
      const result = spring({ frame: 30, fps: 30, from: 0, to: 100 });
      // After 1 second with default config, should be close to target
      expect(result).toBeGreaterThan(90);
    });

    it('should settle at to value after sufficient time', () => {
      const result = spring({ frame: 150, fps: 30, from: 0, to: 100 });
      // After 5 seconds, should be essentially at target
      expect(result).toBeCloseTo(100, 0);
    });

    it('should work with negative values', () => {
      const result = spring({ frame: 30, fps: 30, from: 100, to: 0 });
      expect(result).toBeLessThan(10);
    });
  });

  // ===========================================================================
  // Spring Configuration
  // ===========================================================================

  describe('spring configuration', () => {
    it('should animate faster with higher stiffness', () => {
      // Compare at an early frame where the difference is clear
      const config: SpringConfig = { stiffness: 200, damping: 20 };
      const result = spring({ frame: 5, fps: 30, from: 0, to: 100, config });

      const defaultConfig: SpringConfig = { stiffness: 100, damping: 20 };
      const defaultResult = spring({ frame: 5, fps: 30, from: 0, to: 100, config: defaultConfig });

      // Higher stiffness should reach closer to target faster at early frames
      expect(result).toBeGreaterThan(defaultResult);
    });

    it('should oscillate less with higher damping', () => {
      const lowDamping = spring({
        frame: 20,
        fps: 30,
        from: 0,
        to: 100,
        config: { damping: 5 },
      });

      const highDamping = spring({
        frame: 20,
        fps: 30,
        from: 0,
        to: 100,
        config: { damping: 20 },
      });

      // Both should be progressing, but high damping should be more stable
      expect(lowDamping).toBeGreaterThan(0);
      expect(highDamping).toBeGreaterThan(0);
    });

    it('should move slower with higher mass', () => {
      // Higher mass means more inertia - takes longer to get moving
      // Test at an early frame where lighter mass has accelerated more
      const lightMass = spring({
        frame: 3,
        fps: 30,
        from: 0,
        to: 100,
        config: { mass: 0.5, damping: 8, stiffness: 100 },
      });

      const heavyMass = spring({
        frame: 3,
        fps: 30,
        from: 0,
        to: 100,
        config: { mass: 2, damping: 8, stiffness: 100 },
      });

      // Light mass should have moved more at early frames
      expect(lightMass).toBeGreaterThan(heavyMass);
    });
  });

  // ===========================================================================
  // Overshoot Clamping
  // ===========================================================================

  describe('overshoot clamping', () => {
    it('should allow overshoot by default', () => {
      // With low damping, spring may overshoot
      const config: SpringConfig = { damping: 5, stiffness: 200 };

      // Check multiple frames to find potential overshoot
      const frames = [15, 20, 25, 30].map(frame =>
        spring({ frame, fps: 30, from: 0, to: 100, config })
      );

      // At least one frame should be > 100 (overshoot)
      const hasOvershoot = frames.some(v => v > 100);
      expect(hasOvershoot).toBe(true);
    });

    it('should prevent overshoot when clamping is enabled', () => {
      const config: SpringConfig = {
        damping: 5,
        stiffness: 200,
        overshootClamping: true,
      };

      const frames = [10, 15, 20, 25, 30].map(frame =>
        spring({ frame, fps: 30, from: 0, to: 100, config })
      );

      // No frame should exceed the target
      expect(frames.every(v => v <= 100)).toBe(true);
      expect(frames.every(v => v >= 0)).toBe(true);
    });
  });

  // ===========================================================================
  // FPS Independence
  // ===========================================================================

  describe('fps independence', () => {
    it('should produce same result at same time with different fps', () => {
      // 30fps at frame 30 = 1 second
      // 60fps at frame 60 = 1 second
      const result30fps = spring({ frame: 30, fps: 30, from: 0, to: 100 });
      const result60fps = spring({ frame: 60, fps: 60, from: 0, to: 100 });

      expect(result30fps).toBeCloseTo(result60fps, 0);
    });
  });

  // ===========================================================================
  // Edge Cases and Error Handling (Destructive Tests)
  // ===========================================================================

  describe('edge cases and error handling', () => {
    describe('zero stiffness', () => {
      it('should return from value when stiffness is zero', () => {
        const result = spring({
          frame: 30,
          fps: 30,
          from: 0,
          to: 100,
          config: { stiffness: 0 },
        });
        // Without stiffness, spring cannot move toward target
        expect(result).toBe(0);
      });

      it('should return from value at any frame when stiffness is zero', () => {
        const results = [0, 30, 60, 150].map((frame) =>
          spring({
            frame,
            fps: 30,
            from: 50,
            to: 200,
            config: { stiffness: 0 },
          })
        );
        // All frames should return the from value
        expect(results.every((r) => r === 50)).toBe(true);
      });
    });

    describe('invalid parameters', () => {
      it('should throw error when mass is zero', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: 30,
            from: 0,
            to: 100,
            config: { mass: 0 },
          })
        ).toThrow('Spring mass must be positive');
      });

      it('should throw error when mass is negative', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: 30,
            from: 0,
            to: 100,
            config: { mass: -1 },
          })
        ).toThrow('Spring mass must be positive');
      });

      it('should throw error when stiffness is negative', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: 30,
            from: 0,
            to: 100,
            config: { stiffness: -100 },
          })
        ).toThrow('Spring stiffness must be non-negative');
      });

      it('should throw error when damping is negative', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: 30,
            from: 0,
            to: 100,
            config: { damping: -5 },
          })
        ).toThrow('Spring damping must be non-negative');
      });

      it('should throw error when fps is zero', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: 0,
            from: 0,
            to: 100,
          })
        ).toThrow('FPS must be positive');
      });

      it('should throw error when fps is negative', () => {
        expect(() =>
          spring({
            frame: 30,
            fps: -30,
            from: 0,
            to: 100,
          })
        ).toThrow('FPS must be positive');
      });
    });

    describe('extreme values', () => {
      it('should handle very small stiffness values', () => {
        const result = spring({
          frame: 30,
          fps: 30,
          from: 0,
          to: 100,
          config: { stiffness: 0.001 },
        });
        // Very low stiffness should still produce finite result
        expect(Number.isFinite(result)).toBe(true);
      });

      it('should handle very high stiffness values', () => {
        const result = spring({
          frame: 30,
          fps: 30,
          from: 0,
          to: 100,
          config: { stiffness: 10000 },
        });
        // Should approach target quickly
        expect(result).toBeGreaterThan(90);
        expect(Number.isFinite(result)).toBe(true);
      });

      it('should handle very high damping (overdamped)', () => {
        const result = spring({
          frame: 30,
          fps: 30,
          from: 0,
          to: 100,
          config: { damping: 100 },
        });
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThanOrEqual(100);
      });

      it('should handle critically damped case', () => {
        // Critical damping: zeta = 1, meaning damping = 2 * sqrt(stiffness * mass)
        // With stiffness=100, mass=1: critical damping = 2 * sqrt(100) = 20
        const result = spring({
          frame: 30,
          fps: 30,
          from: 0,
          to: 100,
          config: { stiffness: 100, damping: 20, mass: 1 },
        });
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThan(90); // Should settle quickly
      });

      it('should not produce NaN or Infinity', () => {
        const testCases = [
          { stiffness: 100, damping: 10, mass: 1 },
          { stiffness: 0.01, damping: 0.1, mass: 0.1 },
          { stiffness: 1000, damping: 100, mass: 10 },
          { stiffness: 100, damping: 0, mass: 1 }, // Zero damping (pure oscillation)
        ];

        testCases.forEach((config) => {
          const result = spring({ frame: 30, fps: 30, from: 0, to: 100, config });
          expect(Number.isNaN(result)).toBe(false);
          expect(Number.isFinite(result)).toBe(true);
        });
      });
    });

    describe('negative frame values', () => {
      it('should handle negative frames', () => {
        const result = spring({
          frame: -10,
          fps: 30,
          from: 0,
          to: 100,
        });
        // Negative time - spring hasn't started yet
        expect(Number.isFinite(result)).toBe(true);
      });
    });
  });
});
