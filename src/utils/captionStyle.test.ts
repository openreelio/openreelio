import { describe, expect, it } from 'vitest';
import {
  getCaptionFontWeightNumber,
  normalizeCaptionPosition,
  normalizeCaptionStyle,
  parseCaptionHexColor,
} from './captionStyle';

describe('captionStyle utilities', () => {
  it('normalizes legacy partial caption style with modern defaults', () => {
    const style = normalizeCaptionStyle({
      fontSize: 64,
      fontWeight: 700,
      color: '#112233cc',
      shadowOffset: 4,
    });

    expect(style.fontSize).toBe(64);
    expect(style.color).toEqual({ r: 17, g: 34, b: 51, a: 204 });
    expect(style.shadowOffsetX).toBe(4);
    expect(style.shadowOffsetY).toBe(4);
    expect(style.lineHeight).toBe(1.2);
    expect(getCaptionFontWeightNumber(style)).toBe(700);
  });

  it('parses short and alpha hex colors', () => {
    expect(parseCaptionHexColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 255 });
    expect(parseCaptionHexColor('#abcd')).toEqual({ r: 170, g: 187, b: 204, a: 221 });
  });

  it('normalizes custom and preset caption positions', () => {
    expect(normalizeCaptionPosition({ type: 'custom', xPercent: 150, yPercent: -20 })).toEqual({
      type: 'custom',
      xPercent: 100,
      yPercent: 0,
    });

    expect(
      normalizeCaptionPosition({ type: 'preset', vertical: 'top', marginPercent: 60 }),
    ).toEqual({
      type: 'preset',
      vertical: 'top',
      marginPercent: 50,
    });
  });
});
