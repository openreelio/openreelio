import type { ColorRgba, TextRenderSpec } from '@/bindings';
import type { TextClipAlignment, TextClipData } from '@/types';

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function toHexByte(value: number): string {
  return clampFinite(Math.round(value), 0, 255, 0).toString(16).padStart(2, '0').toUpperCase();
}

function normalizeAlpha(value: number): number {
  return clampFinite(value, 0, 255, 255) / 255;
}

export function colorRgbaToCss(color: ColorRgba): string {
  const r = clampFinite(Math.round(color.r), 0, 255, 0);
  const g = clampFinite(Math.round(color.g), 0, 255, 0);
  const b = clampFinite(Math.round(color.b), 0, 255, 0);
  const alpha = normalizeAlpha(color.a);

  if (alpha >= 0.999) {
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  }

  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(4))})`;
}

function normalizeAlignment(value: TextRenderSpec['style']['alignment']): TextClipAlignment {
  if (value === 'left' || value === 'right') {
    return value;
  }

  return 'center';
}

export function textRenderSpecToTextClipData(spec: TextRenderSpec): TextClipData {
  const alignment = normalizeAlignment(spec.style.alignment);
  const textData: TextClipData = {
    content: spec.text,
    style: {
      fontFamily: spec.style.fontFamily.trim() || 'Arial',
      fontSize: clampFinite(Math.round(spec.style.fontSizePx), 1, 500, 48),
      fontWeight: clampFinite(Math.round(spec.style.fontWeight), 100, 900, 400),
      color: colorRgbaToCss(spec.style.fillColor),
      backgroundColor: spec.background ? colorRgbaToCss(spec.background.color) : undefined,
      backgroundPadding: spec.background
        ? clampFinite(Math.round(spec.background.paddingPx), 0, 500, 0)
        : 0,
      alignment,
      bold: spec.style.bold,
      italic: spec.style.italic,
      underline: spec.style.underline,
      lineHeight: clampFinite(spec.style.lineHeight, 0.5, 5, 1.2),
      letterSpacing: clampFinite(Math.round(spec.style.letterSpacingPx), -100, 200, 0),
    },
    position: {
      x: clampFinite(spec.position.xPercent / 100, 0, 1, 0.5),
      y: clampFinite(spec.position.yPercent / 100, 0, 1, 0.5),
    },
    rotation: clampFinite(spec.rotationDeg, -360, 360, 0),
    opacity: clampFinite(spec.style.opacity, 0, 1, 1),
  };

  if (spec.shadow) {
    textData.shadow = {
      color: colorRgbaToCss(spec.shadow.color),
      offsetX: clampFinite(Math.round(spec.shadow.offsetXPx), -500, 500, 0),
      offsetY: clampFinite(Math.round(spec.shadow.offsetYPx), -500, 500, 0),
      blur: clampFinite(Math.round(spec.shadow.blurPx), 0, 500, 0),
    };
  }

  if (spec.outline && spec.outline.widthPx > 0) {
    textData.outline = {
      color: colorRgbaToCss(spec.outline.color),
      width: clampFinite(Math.round(spec.outline.widthPx), 0, 100, 0),
    };
  }

  return textData;
}
