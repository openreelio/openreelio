import { describe, expect, it } from 'vitest';
import { normalizeMarkerColor } from './markerColor';

describe('normalizeMarkerColor', () => {
  it('should normalize named marker colors', () => {
    expect(normalizeMarkerColor('blue')).toEqual({ r: 0, g: 0, b: 1 });
  });

  it('should normalize hex marker colors with alpha', () => {
    expect(normalizeMarkerColor('#FF000080')).toEqual({ r: 1, g: 0, b: 0, a: 128 / 255 });
  });

  it('should reject invalid marker color strings', () => {
    expect(() => normalizeMarkerColor('not-a-color')).toThrow('Invalid marker color');
  });
});
