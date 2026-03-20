/**
 * useColorCurves Hook Tests
 *
 * BDD-style tests for color curve parsing, serialization, and interpolation utilities.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  parseCurvePoints,
  serializeCurvePoints,
  isIdentityCurve,
  interpolateCurve,
  isAdvancedChannel,
  getDrawMode,
  getIdentityCurve,
  useColorCurves,
  IDENTITY_CURVE,
  FLAT_IDENTITY_CURVE,
} from './useColorCurves';

// =============================================================================
// parseCurvePoints
// =============================================================================

describe('parseCurvePoints', () => {
  it('should parse valid JSON curve points', () => {
    const json = '[{"x":0,"y":0},{"x":0.5,"y":0.7},{"x":1,"y":1}]';
    const result = parseCurvePoints(json);
    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ]);
  });

  it('should clamp values to [0, 1] range', () => {
    const json = '[{"x":-0.5,"y":1.5},{"x":2,"y":-1}]';
    const result = parseCurvePoints(json);
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(1);
    expect(result[1].x).toBe(1);
    expect(result[1].y).toBe(0);
  });

  it('should return identity curve for invalid JSON', () => {
    const result = parseCurvePoints('not-json');
    expect(result).toEqual(IDENTITY_CURVE);
  });

  it('should return identity curve for empty array', () => {
    const result = parseCurvePoints('[]');
    expect(result).toEqual(IDENTITY_CURVE);
  });

  it('should return identity curve for single point', () => {
    const result = parseCurvePoints('[{"x":0.5,"y":0.5}]');
    expect(result).toEqual(IDENTITY_CURVE);
  });

  it('should return identity curve for malformed objects', () => {
    const result = parseCurvePoints('[{"a":1,"b":2}]');
    expect(result).toEqual(IDENTITY_CURVE);
  });
});

// =============================================================================
// serializeCurvePoints
// =============================================================================

describe('serializeCurvePoints', () => {
  it('should serialize points to JSON sorted by x', () => {
    const points = [
      { x: 1, y: 1 },
      { x: 0, y: 0 },
      { x: 0.5, y: 0.7 },
    ];
    const result = serializeCurvePoints(points);
    const parsed = JSON.parse(result);
    expect(parsed[0].x).toBe(0);
    expect(parsed[1].x).toBe(0.5);
    expect(parsed[2].x).toBe(1);
  });

  it('should produce valid JSON round-trip', () => {
    const original = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.2 },
      { x: 1, y: 1 },
    ];
    const json = serializeCurvePoints(original);
    const restored = parseCurvePoints(json);
    expect(restored).toEqual(original);
  });
});

// =============================================================================
// isIdentityCurve
// =============================================================================

describe('isIdentityCurve', () => {
  it('should return true for exact identity curve', () => {
    expect(isIdentityCurve(IDENTITY_CURVE)).toBe(true);
  });

  it('should return true for near-identity curve within tolerance', () => {
    expect(
      isIdentityCurve([
        { x: 0.0005, y: 0.0005 },
        { x: 0.9995, y: 0.9995 },
      ]),
    ).toBe(true);
  });

  it('should return false for modified curve', () => {
    expect(
      isIdentityCurve([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.7 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false);
  });

  it('should return false for single point', () => {
    expect(isIdentityCurve([{ x: 0, y: 0 }])).toBe(false);
  });

  it('should return false for two points not at corners', () => {
    expect(
      isIdentityCurve([
        { x: 0, y: 0.5 },
        { x: 1, y: 1 },
      ]),
    ).toBe(false);
  });
});

// =============================================================================
// interpolateCurve
// =============================================================================

describe('interpolateCurve', () => {
  it('should return empty array for fewer than 2 points', () => {
    expect(interpolateCurve([])).toEqual([]);
    expect(interpolateCurve([{ x: 0.5, y: 0.5 }])).toEqual([]);
  });

  it('should produce linear interpolation for 2 points', () => {
    const result = interpolateCurve(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      10,
    );
    expect(result.length).toBe(11);
    // Midpoint should be approximately (0.5, 0.5)
    const mid = result[5];
    expect(mid.x).toBeCloseTo(0.5, 1);
    expect(mid.y).toBeCloseTo(0.5, 1);
  });

  it('should produce smooth interpolation through 3+ points', () => {
    const result = interpolateCurve(
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.8 },
        { x: 1, y: 1 },
      ],
      50,
    );
    expect(result.length).toBeGreaterThan(20);
    // All values should be within [0, 1]
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  it('should sort points by x before interpolation', () => {
    const result = interpolateCurve(
      [
        { x: 1, y: 1 },
        { x: 0, y: 0 },
      ],
      10,
    );
    // First point should be near x=0, last near x=1
    expect(result[0].x).toBeCloseTo(0, 1);
    expect(result[result.length - 1].x).toBeCloseTo(1, 1);
  });

  it('should handle S-curve shape with 4 points', () => {
    const result = interpolateCurve(
      [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.1 },
        { x: 0.75, y: 0.9 },
        { x: 1, y: 1 },
      ],
      100,
    );
    expect(result.length).toBeGreaterThan(30);
    // All points should be in valid range
    for (const p of result) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});

// =============================================================================
// Advanced Curve Utilities (FLAT_IDENTITY_CURVE, isAdvancedChannel, etc.)
// =============================================================================

describe('FLAT_IDENTITY_CURVE', () => {
  it('should have 2 points at y=0.5', () => {
    expect(FLAT_IDENTITY_CURVE).toEqual([
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ]);
  });
});

describe('isAdvancedChannel', () => {
  it('should return true for hue_vs_hue, hue_vs_sat, luma_vs_sat', () => {
    expect(isAdvancedChannel('hue_vs_hue')).toBe(true);
    expect(isAdvancedChannel('hue_vs_sat')).toBe(true);
    expect(isAdvancedChannel('luma_vs_sat')).toBe(true);
  });

  it('should return false for RGB channels', () => {
    expect(isAdvancedChannel('master')).toBe(false);
    expect(isAdvancedChannel('red')).toBe(false);
    expect(isAdvancedChannel('green')).toBe(false);
    expect(isAdvancedChannel('blue')).toBe(false);
  });
});

describe('useColorCurves', () => {
  it('should clamp dragged control points between their neighbors', () => {
    const onChange = vi.fn();
    const masterCurve = serializeCurvePoints([
      { x: 0, y: 0 },
      { x: 0.25, y: 0.1 },
      { x: 0.75, y: 0.9 },
      { x: 1, y: 1 },
    ]);

    const { result } = renderHook(() =>
      useColorCurves({
        params: {
          master_curve: masterCurve,
          red_curve: serializeCurvePoints(IDENTITY_CURVE),
          green_curve: serializeCurvePoints(IDENTITY_CURVE),
          blue_curve: serializeCurvePoints(IDENTITY_CURVE),
          hue_vs_hue_curve: serializeCurvePoints(FLAT_IDENTITY_CURVE),
          hue_vs_sat_curve: serializeCurvePoints(FLAT_IDENTITY_CURVE),
          luma_vs_sat_curve: serializeCurvePoints(FLAT_IDENTITY_CURVE),
        },
        onChange,
      }),
    );

    act(() => {
      result.current.movePoint(1, 0.9, 0.2);
    });

    const serialized = onChange.mock.calls[0][1] as string;
    const updated = JSON.parse(serialized) as Array<{ x: number; y: number }>;

    expect(updated[1].x).toBeLessThan(updated[2].x);
    expect(updated[1].x).toBeCloseTo(0.749, 3);
    expect(updated[1].y).toBeCloseTo(0.2, 3);
  });
});

describe('getDrawMode', () => {
  it('should return rgb for standard channels', () => {
    expect(getDrawMode('master')).toBe('rgb');
    expect(getDrawMode('red')).toBe('rgb');
    expect(getDrawMode('green')).toBe('rgb');
    expect(getDrawMode('blue')).toBe('rgb');
  });

  it('should return hue for hue-based channels', () => {
    expect(getDrawMode('hue_vs_hue')).toBe('hue');
    expect(getDrawMode('hue_vs_sat')).toBe('hue');
  });

  it('should return luma for luminance-based channel', () => {
    expect(getDrawMode('luma_vs_sat')).toBe('luma');
  });
});

describe('getIdentityCurve', () => {
  it('should return IDENTITY_CURVE for RGB channels', () => {
    expect(getIdentityCurve('master')).toBe(IDENTITY_CURVE);
    expect(getIdentityCurve('red')).toBe(IDENTITY_CURVE);
  });

  it('should return FLAT_IDENTITY_CURVE for advanced channels', () => {
    expect(getIdentityCurve('hue_vs_hue')).toBe(FLAT_IDENTITY_CURVE);
    expect(getIdentityCurve('hue_vs_sat')).toBe(FLAT_IDENTITY_CURVE);
    expect(getIdentityCurve('luma_vs_sat')).toBe(FLAT_IDENTITY_CURVE);
  });
});

describe('parseCurvePoints with custom fallback', () => {
  it('should use FLAT_IDENTITY_CURVE as fallback when provided', () => {
    const result = parseCurvePoints('invalid', FLAT_IDENTITY_CURVE);
    expect(result).toEqual(FLAT_IDENTITY_CURVE);
  });

  it('should use FLAT_IDENTITY_CURVE for empty string with flat fallback', () => {
    const result = parseCurvePoints('', FLAT_IDENTITY_CURVE);
    expect(result).toEqual(FLAT_IDENTITY_CURVE);
  });

  it('should still parse valid JSON regardless of fallback', () => {
    const json = '[{"x":0,"y":0.5},{"x":0.5,"y":0.8},{"x":1,"y":0.5}]';
    const result = parseCurvePoints(json, FLAT_IDENTITY_CURVE);
    expect(result).toHaveLength(3);
    expect(result[1].y).toBe(0.8);
  });
});
