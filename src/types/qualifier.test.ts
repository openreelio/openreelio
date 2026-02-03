import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUALIFIER_VALUES,
  QUALIFIER_PRESETS,
  QUALIFIER_CONSTRAINTS,
  paramsToQualifierValues,
  isHSLQualifierEffect,
} from './qualifier';

describe('qualifier types', () => {
  describe('DEFAULT_QUALIFIER_VALUES', () => {
    it('should have valid default hue center', () => {
      expect(DEFAULT_QUALIFIER_VALUES.hue_center).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_QUALIFIER_VALUES.hue_center).toBeLessThanOrEqual(360);
    });

    it('should have valid range values', () => {
      expect(DEFAULT_QUALIFIER_VALUES.sat_min).toBeLessThanOrEqual(
        DEFAULT_QUALIFIER_VALUES.sat_max
      );
      expect(DEFAULT_QUALIFIER_VALUES.lum_min).toBeLessThanOrEqual(
        DEFAULT_QUALIFIER_VALUES.lum_max
      );
    });

    it('should have valid hue width', () => {
      expect(DEFAULT_QUALIFIER_VALUES.hue_width).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_QUALIFIER_VALUES.hue_width).toBeLessThanOrEqual(180);
    });

    it('should have valid softness', () => {
      expect(DEFAULT_QUALIFIER_VALUES.softness).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_QUALIFIER_VALUES.softness).toBeLessThanOrEqual(1);
    });

    it('should have valid adjustment values', () => {
      expect(DEFAULT_QUALIFIER_VALUES.hue_shift).toBeGreaterThanOrEqual(-180);
      expect(DEFAULT_QUALIFIER_VALUES.hue_shift).toBeLessThanOrEqual(180);
      expect(DEFAULT_QUALIFIER_VALUES.sat_adjust).toBeGreaterThanOrEqual(-1);
      expect(DEFAULT_QUALIFIER_VALUES.sat_adjust).toBeLessThanOrEqual(1);
      expect(DEFAULT_QUALIFIER_VALUES.lum_adjust).toBeGreaterThanOrEqual(-1);
      expect(DEFAULT_QUALIFIER_VALUES.lum_adjust).toBeLessThanOrEqual(1);
    });

    it('should have invert set to false by default', () => {
      expect(DEFAULT_QUALIFIER_VALUES.invert).toBe(false);
    });
  });

  describe('QUALIFIER_PRESETS', () => {
    it('should have skin_tones preset', () => {
      expect(QUALIFIER_PRESETS.skin_tones).toBeDefined();
      expect(QUALIFIER_PRESETS.skin_tones.hue_center).toBe(20);
    });

    it('should have sky_blue preset', () => {
      expect(QUALIFIER_PRESETS.sky_blue).toBeDefined();
      expect(QUALIFIER_PRESETS.sky_blue.hue_center).toBe(210);
    });

    it('should have foliage preset', () => {
      expect(QUALIFIER_PRESETS.foliage).toBeDefined();
      expect(QUALIFIER_PRESETS.foliage.hue_center).toBe(100);
    });

    it('should have valid values for all presets', () => {
      for (const preset of Object.values(QUALIFIER_PRESETS)) {
        expect(preset.hue_center).toBeGreaterThanOrEqual(0);
        expect(preset.hue_center).toBeLessThanOrEqual(360);
        expect(preset.hue_width).toBeGreaterThanOrEqual(1);
        expect(preset.hue_width).toBeLessThanOrEqual(180);
        expect(preset.sat_min).toBeLessThanOrEqual(preset.sat_max);
        expect(preset.lum_min).toBeLessThanOrEqual(preset.lum_max);
      }
    });
  });

  describe('QUALIFIER_CONSTRAINTS', () => {
    it('should have constraints for all parameters', () => {
      expect(QUALIFIER_CONSTRAINTS.hue_center).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.hue_width).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.sat_min).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.sat_max).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.lum_min).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.lum_max).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.softness).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.hue_shift).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.sat_adjust).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.lum_adjust).toBeDefined();
      expect(QUALIFIER_CONSTRAINTS.invert).toBeDefined();
    });

    it('should have valid constraint values', () => {
      expect(QUALIFIER_CONSTRAINTS.hue_center.min).toBe(0);
      expect(QUALIFIER_CONSTRAINTS.hue_center.max).toBe(360);
      expect(QUALIFIER_CONSTRAINTS.hue_width.min).toBe(1);
      expect(QUALIFIER_CONSTRAINTS.hue_width.max).toBe(180);
      expect(QUALIFIER_CONSTRAINTS.softness.min).toBe(0);
      expect(QUALIFIER_CONSTRAINTS.softness.max).toBe(1);
    });

    it('should have invert constraint as boolean-like', () => {
      expect(QUALIFIER_CONSTRAINTS.invert.min).toBe(0);
      expect(QUALIFIER_CONSTRAINTS.invert.max).toBe(1);
    });
  });

  describe('paramsToQualifierValues', () => {
    it('should convert params to QualifierValues', () => {
      const params = { hue_center: 180, sat_min: 0.5 };
      const values = paramsToQualifierValues(params);
      expect(values.hue_center).toBe(180);
      expect(values.sat_min).toBe(0.5);
    });

    it('should use defaults for missing params', () => {
      const values = paramsToQualifierValues({});
      expect(values).toEqual(DEFAULT_QUALIFIER_VALUES);
    });

    it('should handle partial params', () => {
      const params = { hue_center: 45 };
      const values = paramsToQualifierValues(params);
      expect(values.hue_center).toBe(45);
      expect(values.hue_width).toBe(DEFAULT_QUALIFIER_VALUES.hue_width);
      expect(values.sat_min).toBe(DEFAULT_QUALIFIER_VALUES.sat_min);
    });

    it('should convert string numbers to numbers', () => {
      const params = { hue_center: '90', softness: '0.5' };
      const values = paramsToQualifierValues(params);
      expect(values.hue_center).toBe(90);
      expect(values.softness).toBe(0.5);
    });

    it('should handle boolean invert param', () => {
      const params = { invert: true };
      const values = paramsToQualifierValues(params);
      expect(values.invert).toBe(true);
    });

    it('should handle truthy values for invert', () => {
      const params = { invert: 1 };
      const values = paramsToQualifierValues(params);
      expect(values.invert).toBe(true);
    });

    it('should handle invalid number values by using defaults', () => {
      const params = { hue_center: 'invalid', sat_min: NaN };
      const values = paramsToQualifierValues(params);
      expect(values.hue_center).toBe(DEFAULT_QUALIFIER_VALUES.hue_center);
      expect(values.sat_min).toBe(DEFAULT_QUALIFIER_VALUES.sat_min);
    });

    it('should handle null and undefined values', () => {
      const params = { hue_center: null, sat_min: undefined };
      const values = paramsToQualifierValues(params);
      expect(values.hue_center).toBe(DEFAULT_QUALIFIER_VALUES.hue_center);
      expect(values.sat_min).toBe(DEFAULT_QUALIFIER_VALUES.sat_min);
    });
  });

  describe('isHSLQualifierEffect', () => {
    it('should return true for hsl_qualifier', () => {
      expect(isHSLQualifierEffect('hsl_qualifier')).toBe(true);
    });

    it('should return false for other effects', () => {
      expect(isHSLQualifierEffect('brightness')).toBe(false);
      expect(isHSLQualifierEffect('chroma_key')).toBe(false);
      expect(isHSLQualifierEffect('color_wheels')).toBe(false);
    });

    it('should return false for custom effects', () => {
      expect(isHSLQualifierEffect({ custom: 'test' })).toBe(false);
      expect(isHSLQualifierEffect({ custom: 'hsl_qualifier' })).toBe(false);
    });
  });
});
