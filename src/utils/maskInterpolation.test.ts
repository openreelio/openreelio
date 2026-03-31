/**
 * BDD Tests for mask shape interpolation utility.
 *
 * Tests client-side interpolation that mirrors the Rust backend logic
 * for real-time preview during timeline scrubbing.
 */

import { describe, it, expect } from 'vitest';
import type { MaskShape, MaskKeyframe } from '@/types';
import {
  applyEasing,
  cloneMaskShape,
  interpolateMaskShape,
  resolveShapeAtTime,
} from './maskInterpolation';

const EPSILON = 1e-6;

function approx(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(EPSILON);
}

// =============================================================================
// Feature: Easing functions
// =============================================================================

describe('applyEasing', () => {
  it('should return t unchanged for linear easing', () => {
    approx(applyEasing(0.5, 'linear'), 0.5);
  });

  it('should apply quadratic ease-in', () => {
    approx(applyEasing(0.5, 'ease_in'), 0.25);
  });

  it('should apply quadratic ease-out', () => {
    approx(applyEasing(0.5, 'ease_out'), 0.75);
  });

  it('should apply hold easing as zero', () => {
    approx(applyEasing(0.5, 'hold'), 0.0);
    approx(applyEasing(0.99, 'hold'), 0.0);
  });

  it('should apply step easing as binary', () => {
    approx(applyEasing(0.49, 'step'), 0.0);
    approx(applyEasing(0.5, 'step'), 1.0);
  });

  it('should clamp t to valid range', () => {
    approx(applyEasing(-1.0, 'linear'), 0.0);
    approx(applyEasing(2.0, 'linear'), 1.0);
  });
});

// =============================================================================
// Feature: Shape interpolation
// =============================================================================

describe('interpolateMaskShape', () => {
  it('should interpolate rectangle positions at midpoint', () => {
    const a: MaskShape = {
      type: 'rectangle',
      x: 0.2,
      y: 0.2,
      width: 0.4,
      height: 0.3,
      cornerRadius: 0,
      rotation: 0,
    };
    const b: MaskShape = {
      type: 'rectangle',
      x: 0.8,
      y: 0.8,
      width: 0.6,
      height: 0.5,
      cornerRadius: 0,
      rotation: 0,
    };

    const result = interpolateMaskShape(a, b, 0.5);

    expect(result.type).toBe('rectangle');
    if (result.type === 'rectangle') {
      approx(result.x, 0.5);
      approx(result.y, 0.5);
      approx(result.width, 0.5);
      approx(result.height, 0.4);
    }
  });

  it('should return shape_a at t=0', () => {
    const a: MaskShape = {
      type: 'rectangle',
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.5,
      cornerRadius: 0,
      rotation: 0,
    };
    const b: MaskShape = {
      type: 'rectangle',
      x: 0.8,
      y: 0.7,
      width: 0.6,
      height: 0.5,
      cornerRadius: 0,
      rotation: 0,
    };

    const result = interpolateMaskShape(a, b, 0.0);

    if (result.type === 'rectangle') {
      approx(result.x, 0.2);
    }
  });

  it('should interpolate ellipse positions and radii', () => {
    const a: MaskShape = {
      type: 'ellipse',
      x: 0.2,
      y: 0.2,
      radiusX: 0.1,
      radiusY: 0.1,
      rotation: 0,
    };
    const b: MaskShape = {
      type: 'ellipse',
      x: 0.8,
      y: 0.8,
      radiusX: 0.3,
      radiusY: 0.3,
      rotation: 0,
    };

    const result = interpolateMaskShape(a, b, 0.5);

    if (result.type === 'ellipse') {
      approx(result.x, 0.5);
      approx(result.radiusX, 0.2);
    }
  });

  it('should interpolate polygon points pairwise when counts match', () => {
    const a: MaskShape = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
    };
    const b: MaskShape = {
      type: 'polygon',
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.5, y: 0.8 },
      ],
    };

    const result = interpolateMaskShape(a, b, 0.5);

    if (result.type === 'polygon') {
      approx(result.points[0].x, 0.1);
      approx(result.points[0].y, 0.1);
    }
  });

  it('should step between different shape types', () => {
    const rect: MaskShape = {
      type: 'rectangle',
      x: 0.5,
      y: 0.5,
      width: 0.4,
      height: 0.4,
      cornerRadius: 0,
      rotation: 0,
    };
    const ellipse: MaskShape = {
      type: 'ellipse',
      x: 0.5,
      y: 0.5,
      radiusX: 0.2,
      radiusY: 0.2,
      rotation: 0,
    };

    expect(interpolateMaskShape(rect, ellipse, 0.3).type).toBe('rectangle');
    expect(interpolateMaskShape(rect, ellipse, 0.7).type).toBe('ellipse');
  });

  it('should step polygon when point counts differ', () => {
    const tri: MaskShape = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0.5, y: 1 },
      ],
    };
    const quad: MaskShape = {
      type: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
    };

    const resultA = interpolateMaskShape(tri, quad, 0.3);
    if (resultA.type === 'polygon') {
      expect(resultA.points.length).toBe(3);
    }

    const resultB = interpolateMaskShape(tri, quad, 0.7);
    if (resultB.type === 'polygon') {
      expect(resultB.points.length).toBe(4);
    }
  });

  it('should interpolate gradient endpoints', () => {
    const a: MaskShape = {
      type: 'gradient',
      start: { x: 0, y: 0.5 },
      end: { x: 0.5, y: 0.5 },
      gradientType: 'linear',
    };
    const b: MaskShape = {
      type: 'gradient',
      start: { x: 0.5, y: 0.5 },
      end: { x: 1, y: 0.5 },
      gradientType: 'linear',
    };

    const result = interpolateMaskShape(a, b, 0.5);
    if (result.type === 'gradient') {
      approx(result.start.x, 0.25);
      approx(result.end.x, 0.75);
    }
  });
});

// =============================================================================
// Feature: resolveShapeAtTime
// =============================================================================

describe('resolveShapeAtTime', () => {
  const baseShape: MaskShape = {
    type: 'rectangle',
    x: 0.5,
    y: 0.5,
    width: 0.4,
    height: 0.4,
    cornerRadius: 0,
    rotation: 0,
  };

  it('should return base shape when no keyframes exist', () => {
    const result = resolveShapeAtTime(baseShape, undefined, 1.0);
    expect(result).toEqual(baseShape);
  });

  it('should return base shape when keyframes array is empty', () => {
    const result = resolveShapeAtTime(baseShape, [], 1.0);
    expect(result).toEqual(baseShape);
  });

  it('should return first keyframe shape before first keyframe time', () => {
    const kfs: MaskKeyframe[] = [
      { timeOffset: 1.0, shape: { ...baseShape, x: 0.3 } as MaskShape, easing: 'linear' },
      { timeOffset: 3.0, shape: { ...baseShape, x: 0.7 } as MaskShape, easing: 'linear' },
    ];

    const result = resolveShapeAtTime(baseShape, kfs, 0.0);
    if (result.type === 'rectangle') {
      approx(result.x, 0.3);
    }
  });

  it('should return last keyframe shape after last keyframe time', () => {
    const kfs: MaskKeyframe[] = [
      { timeOffset: 0.0, shape: { ...baseShape, x: 0.3 } as MaskShape, easing: 'linear' },
      { timeOffset: 2.0, shape: { ...baseShape, x: 0.7 } as MaskShape, easing: 'linear' },
    ];

    const result = resolveShapeAtTime(baseShape, kfs, 5.0);
    if (result.type === 'rectangle') {
      approx(result.x, 0.7);
    }
  });

  it('should interpolate between keyframes at midpoint', () => {
    const kfs: MaskKeyframe[] = [
      {
        timeOffset: 0.0,
        shape: {
          type: 'rectangle',
          x: 0.2,
          y: 0.2,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
      {
        timeOffset: 2.0,
        shape: {
          type: 'rectangle',
          x: 0.8,
          y: 0.8,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
    ];

    const result = resolveShapeAtTime(baseShape, kfs, 1.0);
    if (result.type === 'rectangle') {
      approx(result.x, 0.5);
      approx(result.y, 0.5);
    }
  });

  it('should apply easing to interpolation', () => {
    const kfs: MaskKeyframe[] = [
      {
        timeOffset: 0.0,
        shape: {
          type: 'rectangle',
          x: 0.0,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'ease_in',
      },
      {
        timeOffset: 2.0,
        shape: {
          type: 'rectangle',
          x: 1.0,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
    ];

    // At t=1.0 (midpoint): raw_t=0.5, ease_in => 0.25
    const result = resolveShapeAtTime(baseShape, kfs, 1.0);
    if (result.type === 'rectangle') {
      approx(result.x, 0.25);
    }
  });

  it('should handle three keyframes correctly', () => {
    const kfs: MaskKeyframe[] = [
      {
        timeOffset: 0.0,
        shape: {
          type: 'rectangle',
          x: 0.0,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
      {
        timeOffset: 1.0,
        shape: {
          type: 'rectangle',
          x: 0.5,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
      {
        timeOffset: 2.0,
        shape: {
          type: 'rectangle',
          x: 1.0,
          y: 0.5,
          width: 0.4,
          height: 0.4,
          cornerRadius: 0,
          rotation: 0,
        },
        easing: 'linear',
      },
    ];

    // Between kf0 and kf1
    const r1 = resolveShapeAtTime(baseShape, kfs, 0.5);
    if (r1.type === 'rectangle') {
      approx(r1.x, 0.25);
    }

    // Between kf1 and kf2
    const r2 = resolveShapeAtTime(baseShape, kfs, 1.5);
    if (r2.type === 'rectangle') {
      approx(r2.x, 0.75);
    }
  });

  it('should return a cloned keyframe shape to avoid mutating source data', () => {
    const polygonShape: MaskShape = {
      type: 'polygon',
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.8, y: 0.1 },
        { x: 0.5, y: 0.8 },
      ],
    };
    const keyframes: MaskKeyframe[] = [{ timeOffset: 0, shape: polygonShape, easing: 'linear' }];

    const resolved = resolveShapeAtTime(baseShape, keyframes, 0);
    expect(resolved).toEqual(polygonShape);

    if (resolved.type !== 'polygon') {
      throw new Error('Expected polygon');
    }

    resolved.points[0].x = 0.25;
    expect((keyframes[0].shape as Extract<MaskShape, { type: 'polygon' }>).points[0].x).toBe(0.1);
  });
});

describe('cloneMaskShape', () => {
  it('should deep-clone nested bezier handles', () => {
    const shape: MaskShape = {
      type: 'bezier',
      points: [
        {
          anchor: { x: 0.2, y: 0.3 },
          handleOut: { x: 0.4, y: 0.5 },
        },
        {
          anchor: { x: 0.8, y: 0.7 },
          handleIn: { x: 0.6, y: 0.5 },
        },
      ],
      closed: false,
    };

    const cloned = cloneMaskShape(shape);
    expect(cloned).toEqual(shape);

    if (cloned.type !== 'bezier') {
      throw new Error('Expected bezier');
    }

    cloned.points[0].anchor.x = 0.9;
    expect((shape as Extract<MaskShape, { type: 'bezier' }>).points[0].anchor.x).toBe(0.2);
  });
});
