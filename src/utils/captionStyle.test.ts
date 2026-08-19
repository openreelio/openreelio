import { describe, expect, it } from 'vitest';
import {
  CAPTION_SIDE_MARGIN_PERCENT,
  captionAnchorTranslate,
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
    // The canonical anchor convention shared by preview and export. A PRESET
    // position anchors an *edge* of the caption block on its margin line and
    // lets the block grow toward the middle of the frame: "10% from the bottom"
    // is a gap to the bottom of the last line. That is what libass does with
    // the MarginV the burn-in writes, what the drawtext fallback's
    // y = (h * Y) - text_h reproduces, and what the preview's
    // translateY(-100%) draws. A CUSTOM position names a point its author
    // placed by hand, which the burn-in expresses as \pos and every surface
    // centers the block on.
    const centerStyle = normalizeCaptionStyle({ alignment: 'center' });

    it('anchors the bottom of a preset bottom caption on its margin line', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'bottom', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 95, verticalAnchor: 'bottom' });
      expect(captionAnchorTranslate(centerStyle, anchor).y).toBe('-100%');
    });

    it('anchors the top of a preset top caption on its margin line', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'top', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 5, verticalAnchor: 'top' });
      expect(captionAnchorTranslate(centerStyle, anchor).y).toBe('0%');
    });

    it('centers the preset center caption on the vertical midpoint', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'preset', vertical: 'center', marginPercent: 5 }),
      );

      expect(anchor).toEqual({ xPercent: 50, yPercent: 50, verticalAnchor: 'center' });
      expect(captionAnchorTranslate(centerStyle, anchor).y).toBe('-50%');
    });

    it('passes through custom xy as the box center', () => {
      const anchor = resolveCaptionAnchor(
        centerStyle,
        normalizeCaptionPosition({ type: 'custom', xPercent: 25, yPercent: 80 }),
      );

      expect(anchor).toEqual({ xPercent: 25, yPercent: 80, verticalAnchor: 'center' });
      expect(captionAnchorTranslate(centerStyle, anchor).y).toBe('-50%');
    });

    it('derives horizontal anchor from alignment for preset positions', () => {
      const bottom = normalizeCaptionPosition({
        type: 'preset',
        vertical: 'bottom',
        marginPercent: 5,
      });

      const left = normalizeCaptionStyle({ alignment: 'left' });
      const right = normalizeCaptionStyle({ alignment: 'right' });

      expect(resolveCaptionAnchor(left, bottom).xPercent).toBe(CAPTION_SIDE_MARGIN_PERCENT);
      expect(resolveCaptionAnchor(right, bottom).xPercent).toBe(100 - CAPTION_SIDE_MARGIN_PERCENT);
      expect(captionAnchorTranslate(left, resolveCaptionAnchor(left, bottom)).x).toBe('0%');
      expect(captionAnchorTranslate(right, resolveCaptionAnchor(right, bottom)).x).toBe('-100%');
    });
  });
});
