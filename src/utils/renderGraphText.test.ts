import { describe, expect, it } from 'vitest';
import type { TextRenderSpec } from '@/bindings';
import { colorRgbaToCss, textRenderSpecToTextClipData } from './renderGraphText';

describe('renderGraphText utilities', () => {
  it('should convert opaque and translucent render colors to CSS colors', () => {
    expect(colorRgbaToCss({ r: 10, g: 20, b: 30, a: 255 })).toBe('#0A141E');
    expect(colorRgbaToCss({ r: 10, g: 20, b: 30, a: 128 })).toBe(
      'rgba(10, 20, 30, 0.502)',
    );
  });

  it('should convert a TextRenderSpec into preview TextClipData', () => {
    const spec: TextRenderSpec = {
      text: 'Graph text',
      style: {
        fontFamily: 'Inter',
        fontSizePx: 64,
        fontWeight: 650,
        bold: true,
        italic: true,
        underline: true,
        alignment: 'right',
        lineHeight: 1.35,
        letterSpacingPx: 2,
        fillColor: { r: 255, g: 10, b: 20, a: 255 },
        opacity: 0.75,
      },
      position: {
        xPercent: 25,
        yPercent: 75,
        anchorXPercent: 100,
        anchorYPercent: 50,
      },
      background: {
        color: { r: 1, g: 2, b: 3, a: 128 },
        paddingPx: 14,
      },
      outline: {
        color: { r: 4, g: 5, b: 6, a: 255 },
        widthPx: 3,
      },
      shadow: {
        color: { r: 7, g: 8, b: 9, a: 128 },
        offsetXPx: 4,
        offsetYPx: 5,
        blurPx: 6,
      },
      rotationDeg: 12,
    };

    expect(textRenderSpecToTextClipData(spec)).toEqual({
      content: 'Graph text',
      style: {
        fontFamily: 'Inter',
        fontSize: 64,
        fontWeight: 650,
        color: '#FF0A14',
        backgroundColor: 'rgba(1, 2, 3, 0.502)',
        backgroundPadding: 14,
        alignment: 'right',
        bold: true,
        italic: true,
        underline: true,
        lineHeight: 1.35,
        letterSpacing: 2,
      },
      position: { x: 0.25, y: 0.75 },
      shadow: {
        color: 'rgba(7, 8, 9, 0.502)',
        offsetX: 4,
        offsetY: 5,
        blur: 6,
      },
      outline: {
        color: '#040506',
        width: 3,
      },
      rotation: 12,
      opacity: 0.75,
    });
  });
});
