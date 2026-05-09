import { describe, expect, it } from 'vitest';
import { normalizeMarkerColor } from './markerColor';

describe('normalizeMarkerColor', () => {
  it('should normalize named marker colors', () => {
    expect(normalizeMarkerColor('blue')).toEqual({ r: 0, g: 0, b: 1 });
  });

  it('should accept named colors case-insensitively with surrounding whitespace', () => {
    expect(normalizeMarkerColor('  RED  ')).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('should normalize hex marker colors with alpha', () => {
    expect(normalizeMarkerColor('#FF000080')).toEqual({ r: 1, g: 0, b: 0, a: 128 / 255 });
  });

  it('should accept RGBA objects with values in range', () => {
    expect(normalizeMarkerColor({ r: 1, g: 0.5, b: 0, a: 0.25 })).toEqual({
      r: 1,
      g: 0.5,
      b: 0,
      a: 0.25,
    });
  });

  it('should reject RGBA objects with out-of-range alpha', () => {
    expect(() => normalizeMarkerColor({ r: 0, g: 0, b: 0, a: 1.5 })).toThrow(
      'Invalid marker color',
    );
  });

  it('should return undefined for nullish or empty inputs', () => {
    expect(normalizeMarkerColor(undefined)).toBeUndefined();
    expect(normalizeMarkerColor(null)).toBeUndefined();
    expect(normalizeMarkerColor('   ')).toBeUndefined();
  });

  it('should reject invalid marker color strings', () => {
    expect(() => normalizeMarkerColor('not-a-color')).toThrow('Invalid marker color');
  });
});
