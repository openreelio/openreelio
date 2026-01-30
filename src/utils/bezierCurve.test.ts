/**
 * Bezier Curve Utility Tests
 *
 * Tests for cubic Bezier curve evaluation used in keyframe easing.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateCubicBezier,
  createBezierEasing,
  BEZIER_PRESETS,
  isValidBezierPoints,
  clampBezierPoints,
} from './bezierCurve';

// =============================================================================
// Type Tests
// =============================================================================

describe('isValidBezierPoints', () => {
  it('should return true for valid control points', () => {
    expect(isValidBezierPoints([0.25, 0.1, 0.25, 1.0])).toBe(true);
  });

  it('should return true for extreme but valid points', () => {
    expect(isValidBezierPoints([0, 0, 1, 1])).toBe(true);
    expect(isValidBezierPoints([0.5, -0.5, 0.5, 1.5])).toBe(true); // Y can be outside 0-1
  });

  it('should return false for non-array input', () => {
    expect(isValidBezierPoints(null)).toBe(false);
    expect(isValidBezierPoints(undefined)).toBe(false);
    expect(isValidBezierPoints('0.25,0.1,0.25,1.0')).toBe(false);
    expect(isValidBezierPoints({ x1: 0.25 })).toBe(false);
  });

  it('should return false for wrong array length', () => {
    expect(isValidBezierPoints([0.25, 0.1])).toBe(false);
    expect(isValidBezierPoints([0.25, 0.1, 0.25])).toBe(false);
    expect(isValidBezierPoints([0.25, 0.1, 0.25, 1.0, 0.5])).toBe(false);
  });

  it('should return false for non-numeric values', () => {
    expect(isValidBezierPoints(['0.25', 0.1, 0.25, 1.0])).toBe(false);
    expect(isValidBezierPoints([NaN, 0.1, 0.25, 1.0])).toBe(false);
    expect(isValidBezierPoints([0.25, Infinity, 0.25, 1.0])).toBe(false);
  });

  it('should return false for x values outside 0-1 range', () => {
    expect(isValidBezierPoints([-0.1, 0.1, 0.25, 1.0])).toBe(false);
    expect(isValidBezierPoints([0.25, 0.1, 1.1, 1.0])).toBe(false);
  });
});

describe('clampBezierPoints', () => {
  it('should clamp x values to 0-1 range', () => {
    expect(clampBezierPoints([-0.5, 0.5, 1.5, 0.5])).toEqual([0, 0.5, 1, 0.5]);
  });

  it('should allow y values outside 0-1 range', () => {
    expect(clampBezierPoints([0.5, -0.5, 0.5, 1.5])).toEqual([0.5, -0.5, 0.5, 1.5]);
  });

  it('should not modify valid points', () => {
    const points: [number, number, number, number] = [0.25, 0.1, 0.25, 1.0];
    expect(clampBezierPoints(points)).toEqual(points);
  });
});

// =============================================================================
// Bezier Evaluation Tests
// =============================================================================

describe('evaluateCubicBezier', () => {
  describe('boundary conditions', () => {
    it('should return 0 at t=0', () => {
      expect(evaluateCubicBezier(0, [0.25, 0.1, 0.25, 1.0])).toBe(0);
    });

    it('should return 1 at t=1', () => {
      expect(evaluateCubicBezier(1, [0.25, 0.1, 0.25, 1.0])).toBe(1);
    });

    it('should clamp t values outside 0-1 range', () => {
      expect(evaluateCubicBezier(-0.5, [0.25, 0.1, 0.25, 1.0])).toBe(0);
      expect(evaluateCubicBezier(1.5, [0.25, 0.1, 0.25, 1.0])).toBe(1);
    });
  });

  describe('linear curve [0, 0, 1, 1]', () => {
    const linear: [number, number, number, number] = [0, 0, 1, 1];

    it('should produce linear output', () => {
      expect(evaluateCubicBezier(0, linear)).toBeCloseTo(0, 5);
      expect(evaluateCubicBezier(0.25, linear)).toBeCloseTo(0.25, 2);
      expect(evaluateCubicBezier(0.5, linear)).toBeCloseTo(0.5, 2);
      expect(evaluateCubicBezier(0.75, linear)).toBeCloseTo(0.75, 2);
      expect(evaluateCubicBezier(1, linear)).toBeCloseTo(1, 5);
    });
  });

  describe('ease curve [0.25, 0.1, 0.25, 1.0]', () => {
    const ease: [number, number, number, number] = [0.25, 0.1, 0.25, 1.0];

    it('should have characteristic ease curve shape', () => {
      // CSS ease starts slow, accelerates, then decelerates
      // At t=0.1, output should be less than linear
      const early = evaluateCubicBezier(0.1, ease);
      expect(early).toBeLessThan(0.1);

      // At t=0.5, should be slightly above linear
      const middle = evaluateCubicBezier(0.5, ease);
      expect(middle).toBeGreaterThan(0.5);
    });

    it('should end faster than linear', () => {
      const result = evaluateCubicBezier(0.75, ease);
      expect(result).toBeGreaterThan(0.75);
    });
  });

  describe('ease-in curve [0.42, 0, 1, 1]', () => {
    const easeIn: [number, number, number, number] = [0.42, 0, 1, 1];

    it('should accelerate', () => {
      const early = evaluateCubicBezier(0.25, easeIn);
      const late = evaluateCubicBezier(0.75, easeIn);

      // Early should be slower than linear
      expect(early).toBeLessThan(0.25);
      // Later difference should be larger (accelerating)
      expect(late).toBeGreaterThan(early * 3);
    });
  });

  describe('ease-out curve [0, 0, 0.58, 1]', () => {
    const easeOut: [number, number, number, number] = [0, 0, 0.58, 1];

    it('should decelerate', () => {
      const early = evaluateCubicBezier(0.25, easeOut);
      const late = evaluateCubicBezier(0.75, easeOut);

      // Early should be faster than linear
      expect(early).toBeGreaterThan(0.25);
      // Late should be closer to 1 (decelerating)
      expect(late).toBeGreaterThan(0.75);
    });
  });

  describe('ease-in-out curve [0.42, 0, 0.58, 1]', () => {
    const easeInOut: [number, number, number, number] = [0.42, 0, 0.58, 1];

    it('should be slow at start and end, fast in middle', () => {
      const early = evaluateCubicBezier(0.25, easeInOut);
      const middle = evaluateCubicBezier(0.5, easeInOut);
      const late = evaluateCubicBezier(0.75, easeInOut);

      // Early should be slower than linear
      expect(early).toBeLessThan(0.25);
      // Middle should be approximately 0.5
      expect(middle).toBeCloseTo(0.5, 1);
      // Late should be faster than linear
      expect(late).toBeGreaterThan(0.75);
    });
  });

  describe('overshoot curve [0.68, -0.55, 0.27, 1.55]', () => {
    const overshoot: [number, number, number, number] = [0.68, -0.55, 0.27, 1.55];

    it('should produce values outside 0-1 range', () => {
      // This curve overshoots at the end
      let foundOvershoot = false;
      for (let t = 0.7; t < 1; t += 0.01) {
        const y = evaluateCubicBezier(t, overshoot);
        if (y > 1) {
          foundOvershoot = true;
          break;
        }
      }
      expect(foundOvershoot).toBe(true);
    });
  });
});

// =============================================================================
// Easing Function Factory Tests
// =============================================================================

describe('createBezierEasing', () => {
  it('should return a function', () => {
    const easing = createBezierEasing([0.25, 0.1, 0.25, 1.0]);
    expect(typeof easing).toBe('function');
  });

  it('should produce same results as evaluateCubicBezier', () => {
    const points: [number, number, number, number] = [0.42, 0, 0.58, 1];
    const easing = createBezierEasing(points);

    for (let t = 0; t <= 1; t += 0.1) {
      expect(easing(t)).toBeCloseTo(evaluateCubicBezier(t, points), 5);
    }
  });

  it('should memoize results for performance', () => {
    const points: [number, number, number, number] = [0.25, 0.1, 0.25, 1.0];
    const easing = createBezierEasing(points);

    // Call multiple times with same value
    const result1 = easing(0.5);
    const result2 = easing(0.5);
    const result3 = easing(0.5);

    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });
});

// =============================================================================
// Preset Tests
// =============================================================================

describe('BEZIER_PRESETS', () => {
  it('should have standard CSS presets', () => {
    expect(BEZIER_PRESETS.ease).toEqual([0.25, 0.1, 0.25, 1.0]);
    expect(BEZIER_PRESETS.easeIn).toEqual([0.42, 0, 1, 1]);
    expect(BEZIER_PRESETS.easeOut).toEqual([0, 0, 0.58, 1]);
    expect(BEZIER_PRESETS.easeInOut).toEqual([0.42, 0, 0.58, 1]);
    expect(BEZIER_PRESETS.linear).toEqual([0, 0, 1, 1]);
  });

  it('should have animation-specific presets', () => {
    expect(BEZIER_PRESETS.easeInQuad).toBeDefined();
    expect(BEZIER_PRESETS.easeOutQuad).toBeDefined();
    expect(BEZIER_PRESETS.easeInOutQuad).toBeDefined();
    expect(BEZIER_PRESETS.easeInCubic).toBeDefined();
    expect(BEZIER_PRESETS.easeOutCubic).toBeDefined();
  });

  it('should all be valid bezier points', () => {
    for (const [, points] of Object.entries(BEZIER_PRESETS)) {
      expect(isValidBezierPoints(points)).toBe(true);
    }
  });
});
