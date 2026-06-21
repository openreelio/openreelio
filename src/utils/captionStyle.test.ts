import { describe, expect, it } from 'vitest';
import {
  getCaptionFontWeightNumber,
  normalizeCaptionPosition,
  normalizeCaptionStyle,
  parseCaptionHexColor,
  resolveCaptionAnchor,
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

  it('does not preserve unknown style keys during normalization', () => {
    const style = normalizeCaptionStyle({
      fontSize: 64,
      unexpectedKey: 'leak',
    });

    expect(style.fontSize).toBe(64);
    expect(style).not.toHaveProperty('unexpectedKey');
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

  describe('resolveCaptionAnchor', () => {
    // The canonical anchor convention shared by preview and export: the resolved
    // (xPercent, yPercent) is the CENTER of the caption box. The preview applies
    // CSS translate(-50%) on the matching axis and the Rust render path applies
    // y = (h * yPercent) - (text_h / 2) (drawtext) / ASS \an5 (subtitle), so both
    // paths place the same center point at the same screen coordinate.
    const centerStyle = normalizeCaptionStyle({ alignment: 'center' });

    it('anchors the preset bottom caption inside the 5% subtitle safe area', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'bottom', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 95 });
    });

    it('anchors the preset top caption at the 5% top margin', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'top', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 5 });
    });

    it('anchors the preset center caption at the vertical midpoint', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'center', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 50 });
    });

    it('passes through custom xy as the box center', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'custom', xPercent: 25, yPercent: 80 }),
      );

      expect(anchor).toEqual({ xPercent: 25, yPercent: 80 });
    });

    it('derives horizontal anchor from alignment for preset positions', () => {
      const bottom = normalizeCaptionPosition({
        type: 'preset',
        vertical: 'bottom',
        marginPercent: 5,
      });

      expect(
        resolveCaptionAnchor(normalizeCaptionStyle({ alignment: 'left' }), bottom).xPercent,
      ).toBe(10);
      expect(
        resolveCaptionAnchor(normalizeCaptionStyle({ alignment: 'right' }), bottom).xPercent,
      ).toBe(90);
    });
  });
});
