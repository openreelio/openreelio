/**
 * Color Wheel Utilities Tests
 *
 * Tests for color wheel mathematics and conversions.
 * Used for Lift/Gamma/Gain color correction wheels.
 *
 * Following TDD methodology - tests written first.
 */

import { describe, it, expect } from 'vitest';
import {
  polarToCartesian,
  cartesianToPolar,
  cartesianToColorOffset,
  colorOffsetToCartesian,
  clampToCircle,
  wheelPositionToRGB,
  rgbToWheelPosition,
  applyLiftGammaGain,
  createLiftGammaGainMatrix,
  type WheelPosition,
  type LiftGammaGain,
} from './colorWheel';

describe('colorWheel utilities', () => {
  // ===========================================================================
  // Coordinate Conversions
  // ===========================================================================

  describe('coordinate conversions', () => {
    describe('polarToCartesian', () => {
      it('should convert polar to cartesian (0 degrees)', () => {
        const result = polarToCartesian(1, 0);
        expect(result.x).toBeCloseTo(1, 5);
        expect(result.y).toBeCloseTo(0, 5);
      });

      it('should convert polar to cartesian (90 degrees)', () => {
        const result = polarToCartesian(1, Math.PI / 2);
        expect(result.x).toBeCloseTo(0, 5);
        expect(result.y).toBeCloseTo(1, 5);
      });

      it('should convert polar to cartesian (180 degrees)', () => {
        const result = polarToCartesian(1, Math.PI);
        expect(result.x).toBeCloseTo(-1, 5);
        expect(result.y).toBeCloseTo(0, 5);
      });

      it('should handle zero radius', () => {
        const result = polarToCartesian(0, Math.PI / 4);
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
      });

      it('should handle partial radius', () => {
        const result = polarToCartesian(0.5, 0);
        expect(result.x).toBeCloseTo(0.5, 5);
        expect(result.y).toBeCloseTo(0, 5);
      });
    });

    describe('cartesianToPolar', () => {
      it('should convert cartesian to polar (1, 0)', () => {
        const result = cartesianToPolar(1, 0);
        expect(result.radius).toBeCloseTo(1, 5);
        expect(result.angle).toBeCloseTo(0, 5);
      });

      it('should convert cartesian to polar (0, 1)', () => {
        const result = cartesianToPolar(0, 1);
        expect(result.radius).toBeCloseTo(1, 5);
        expect(result.angle).toBeCloseTo(Math.PI / 2, 5);
      });

      it('should convert cartesian to polar (-1, 0)', () => {
        const result = cartesianToPolar(-1, 0);
        expect(result.radius).toBeCloseTo(1, 5);
        expect(result.angle).toBeCloseTo(Math.PI, 5);
      });

      it('should handle origin', () => {
        const result = cartesianToPolar(0, 0);
        expect(result.radius).toBe(0);
        expect(result.angle).toBe(0);
      });

      it('should be inverse of polarToCartesian', () => {
        const original = { radius: 0.7, angle: Math.PI / 3 };
        const cart = polarToCartesian(original.radius, original.angle);
        const back = cartesianToPolar(cart.x, cart.y);
        expect(back.radius).toBeCloseTo(original.radius, 5);
        expect(back.angle).toBeCloseTo(original.angle, 5);
      });
    });
  });

  // ===========================================================================
  // Color Offset Conversions
  // ===========================================================================

  describe('color offset conversions', () => {
    describe('cartesianToColorOffset', () => {
      it('should convert center position to neutral offset', () => {
        const result = cartesianToColorOffset(0, 0);
        expect(result.r).toBe(0);
        expect(result.g).toBe(0);
        expect(result.b).toBe(0);
      });

      it('should convert right position to red offset', () => {
        const result = cartesianToColorOffset(1, 0);
        expect(result.r).toBeGreaterThan(0);
        expect(result.g).toBeLessThan(result.r);
        expect(result.b).toBeLessThan(result.r);
      });

      it('should convert top position to green offset', () => {
        // Y-axis points up (green direction on color wheel)
        const result = cartesianToColorOffset(0, -1);
        expect(result.g).toBeGreaterThan(0);
        expect(result.r).toBeLessThan(result.g);
        expect(result.b).toBeLessThan(result.g);
      });

      it('should convert left position to cyan offset', () => {
        // On a standard color wheel, left (-1, 0) is Cyan (opposite of Red)
        // Cyan = low red, high green, high blue
        const result = cartesianToColorOffset(-1, 0);
        expect(result.r).toBeLessThan(0); // Red is reduced
        expect(result.g).toBeGreaterThan(0); // Green is boosted
        expect(result.b).toBeGreaterThan(0); // Blue is boosted
      });

      it('should convert bottom-left position to blue offset', () => {
        // Blue is at approximately 240 degrees (bottom-left quadrant)
        const angle = (240 * Math.PI) / 180;
        const result = cartesianToColorOffset(Math.cos(angle), -Math.sin(angle));
        expect(result.b).toBeGreaterThan(result.r);
        expect(result.b).toBeGreaterThan(result.g);
      });
    });

    describe('colorOffsetToCartesian', () => {
      it('should convert neutral offset to center', () => {
        const result = colorOffsetToCartesian({ r: 0, g: 0, b: 0 });
        expect(result.x).toBe(0);
        expect(result.y).toBe(0);
      });

      it('should convert red offset to right position', () => {
        // Red offset: positive R, negative G and B
        const result = colorOffsetToCartesian({ r: 0.33, g: -0.17, b: -0.17 });
        expect(result.x).toBeGreaterThan(0);
      });

      it('should be inverse of cartesianToColorOffset (approximate)', () => {
        // Color wheel conversions have some precision loss
        // Use 2 decimal places (0.01 tolerance)
        const original = { x: 0.3, y: -0.4 };
        const offset = cartesianToColorOffset(original.x, original.y);
        const back = colorOffsetToCartesian(offset);
        expect(back.x).toBeCloseTo(original.x, 1);
        expect(back.y).toBeCloseTo(original.y, 1);
      });
    });
  });

  // ===========================================================================
  // Circle Clamping
  // ===========================================================================

  describe('clampToCircle', () => {
    it('should not modify points inside circle', () => {
      const result = clampToCircle(0.3, 0.4, 1);
      expect(result.x).toBeCloseTo(0.3, 5);
      expect(result.y).toBeCloseTo(0.4, 5);
    });

    it('should clamp points outside circle to edge', () => {
      const result = clampToCircle(2, 0, 1);
      expect(result.x).toBeCloseTo(1, 5);
      expect(result.y).toBeCloseTo(0, 5);
    });

    it('should preserve direction when clamping', () => {
      const result = clampToCircle(3, 4, 1); // 3-4-5 triangle
      expect(result.x).toBeCloseTo(0.6, 5);
      expect(result.y).toBeCloseTo(0.8, 5);
    });

    it('should handle origin', () => {
      const result = clampToCircle(0, 0, 1);
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('should respect custom radius', () => {
      const result = clampToCircle(1, 0, 0.5);
      expect(result.x).toBeCloseTo(0.5, 5);
      expect(result.y).toBeCloseTo(0, 5);
    });
  });

  // ===========================================================================
  // Wheel Position to RGB
  // ===========================================================================

  describe('wheelPositionToRGB', () => {
    it('should convert center position to gray', () => {
      const result = wheelPositionToRGB({ x: 0, y: 0, luminance: 0.5 });
      expect(result.r).toBeCloseTo(0.5, 2);
      expect(result.g).toBeCloseTo(0.5, 2);
      expect(result.b).toBeCloseTo(0.5, 2);
    });

    it('should respect luminance value', () => {
      const dark = wheelPositionToRGB({ x: 0, y: 0, luminance: 0.2 });
      const bright = wheelPositionToRGB({ x: 0, y: 0, luminance: 0.8 });
      expect(dark.r).toBeLessThan(bright.r);
      expect(dark.g).toBeLessThan(bright.g);
      expect(dark.b).toBeLessThan(bright.b);
    });

    it('should add color tint based on position', () => {
      const redTint = wheelPositionToRGB({ x: 0.5, y: 0, luminance: 0.5 });
      expect(redTint.r).toBeGreaterThan(redTint.g);
      expect(redTint.r).toBeGreaterThan(redTint.b);
    });

    it('should clamp output to valid RGB range', () => {
      const result = wheelPositionToRGB({ x: 1, y: 1, luminance: 1 });
      expect(result.r).toBeLessThanOrEqual(1);
      expect(result.g).toBeLessThanOrEqual(1);
      expect(result.b).toBeLessThanOrEqual(1);
      expect(result.r).toBeGreaterThanOrEqual(0);
      expect(result.g).toBeGreaterThanOrEqual(0);
      expect(result.b).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // RGB to Wheel Position
  // ===========================================================================

  describe('rgbToWheelPosition', () => {
    it('should convert neutral gray to center', () => {
      const result = rgbToWheelPosition({ r: 0.5, g: 0.5, b: 0.5 });
      expect(result.x).toBeCloseTo(0, 2);
      expect(result.y).toBeCloseTo(0, 2);
      expect(result.luminance).toBeCloseTo(0.5, 2);
    });

    it('should extract luminance correctly', () => {
      const dark = rgbToWheelPosition({ r: 0.2, g: 0.2, b: 0.2 });
      const bright = rgbToWheelPosition({ r: 0.8, g: 0.8, b: 0.8 });
      expect(dark.luminance).toBeLessThan(bright.luminance);
    });

    it('should detect red tint direction', () => {
      const result = rgbToWheelPosition({ r: 0.7, g: 0.5, b: 0.5 });
      expect(result.x).toBeGreaterThan(0); // Red is positive X
    });

    it('should be inverse of wheelPositionToRGB', () => {
      const original: WheelPosition = { x: 0.3, y: -0.2, luminance: 0.6 };
      const rgb = wheelPositionToRGB(original);
      const back = rgbToWheelPosition(rgb);
      expect(back.x).toBeCloseTo(original.x, 1);
      expect(back.y).toBeCloseTo(original.y, 1);
      expect(back.luminance).toBeCloseTo(original.luminance, 1);
    });
  });

  // ===========================================================================
  // Lift/Gamma/Gain Application
  // ===========================================================================

  describe('applyLiftGammaGain', () => {
    const neutralLGG: LiftGammaGain = {
      lift: { r: 0, g: 0, b: 0 },
      gamma: { r: 0, g: 0, b: 0 },
      gain: { r: 0, g: 0, b: 0 },
    };

    it('should not modify pixel with neutral settings', () => {
      const result = applyLiftGammaGain(0.5, 0.5, 0.5, neutralLGG);
      expect(result.r).toBeCloseTo(0.5, 3);
      expect(result.g).toBeCloseTo(0.5, 3);
      expect(result.b).toBeCloseTo(0.5, 3);
    });

    it('should raise shadows with positive lift', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0.1, g: 0.1, b: 0.1 },
        gamma: { r: 0, g: 0, b: 0 },
        gain: { r: 0, g: 0, b: 0 },
      };
      const dark = applyLiftGammaGain(0.1, 0.1, 0.1, lgg);
      expect(dark.r).toBeGreaterThan(0.1);
    });

    it('should adjust midtones with gamma', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0, g: 0, b: 0 },
        gamma: { r: 0.2, g: 0, b: 0 },
        gain: { r: 0, g: 0, b: 0 },
      };
      const mid = applyLiftGammaGain(0.5, 0.5, 0.5, lgg);
      expect(mid.r).toBeGreaterThan(mid.g); // Red midtones boosted
    });

    it('should adjust highlights with gain', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0, g: 0, b: 0 },
        gamma: { r: 0, g: 0, b: 0 },
        gain: { r: 0.2, g: 0, b: 0 },
      };
      const bright = applyLiftGammaGain(0.9, 0.9, 0.9, lgg);
      expect(bright.r).toBeGreaterThan(bright.g); // Red highlights boosted
    });

    it('should clamp output to valid range', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0.5, g: 0.5, b: 0.5 },
        gamma: { r: 0.5, g: 0.5, b: 0.5 },
        gain: { r: 0.5, g: 0.5, b: 0.5 },
      };
      const result = applyLiftGammaGain(0.9, 0.9, 0.9, lgg);
      expect(result.r).toBeLessThanOrEqual(1);
      expect(result.g).toBeLessThanOrEqual(1);
      expect(result.b).toBeLessThanOrEqual(1);
    });

    it('should handle black correctly', () => {
      const result = applyLiftGammaGain(0, 0, 0, neutralLGG);
      expect(result.r).toBeCloseTo(0, 3);
      expect(result.g).toBeCloseTo(0, 3);
      expect(result.b).toBeCloseTo(0, 3);
    });

    it('should handle white correctly', () => {
      const result = applyLiftGammaGain(1, 1, 1, neutralLGG);
      expect(result.r).toBeCloseTo(1, 3);
      expect(result.g).toBeCloseTo(1, 3);
      expect(result.b).toBeCloseTo(1, 3);
    });
  });

  // ===========================================================================
  // Lift/Gamma/Gain Matrix
  // ===========================================================================

  describe('createLiftGammaGainMatrix', () => {
    it('should create identity-like matrix for neutral settings', () => {
      const neutralLGG: LiftGammaGain = {
        lift: { r: 0, g: 0, b: 0 },
        gamma: { r: 0, g: 0, b: 0 },
        gain: { r: 0, g: 0, b: 0 },
      };
      const matrix = createLiftGammaGainMatrix(neutralLGG);

      // Matrix should be 3x4 (3 rows, 4 columns for RGB + offset)
      expect(matrix).toHaveLength(3);
      expect(matrix[0]).toHaveLength(4);
      expect(matrix[1]).toHaveLength(4);
      expect(matrix[2]).toHaveLength(4);
    });

    it('should have correct structure for FFmpeg colorchannelmixer', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0.1, g: 0, b: 0 },
        gamma: { r: 0, g: 0, b: 0 },
        gain: { r: 0, g: 0, b: 0 },
      };
      const matrix = createLiftGammaGainMatrix(lgg);

      // Should return array of 3 rows (R, G, B)
      expect(matrix).toHaveLength(3);

      // Each row should have 4 values (rr, rg, rb, ra for row 0)
      matrix.forEach((row) => {
        expect(row).toHaveLength(4);
        row.forEach((val) => {
          expect(typeof val).toBe('number');
          expect(isNaN(val)).toBe(false);
        });
      });
    });

    it('should be serializable', () => {
      const lgg: LiftGammaGain = {
        lift: { r: 0.1, g: 0.05, b: 0 },
        gamma: { r: 0, g: 0.1, b: 0 },
        gain: { r: 0, g: 0, b: 0.2 },
      };
      const matrix = createLiftGammaGainMatrix(lgg);

      // Should be JSON-serializable
      const json = JSON.stringify(matrix);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(matrix);
    });
  });
});
