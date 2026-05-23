import {
  DEFAULT_CAPTION_POSITION,
  DEFAULT_CAPTION_STYLE,
  type CaptionColor,
  type CaptionPosition,
  type CaptionStyle,
  type FontWeight,
  type TextAlignment,
} from '@/types';

type CaptionStyleLike = Partial<CaptionStyle> & Record<string, unknown>;

const HEX_COLOR_PATTERN = /^#?([a-fA-F\d]{3}|[a-fA-F\d]{4}|[a-fA-F\d]{6}|[a-fA-F\d]{8})$/;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  return clamp(Number(value), min, max, fallback);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return fallback;
}

function readAlignment(value: unknown, fallback: TextAlignment): TextAlignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : fallback;
}

function normalizeFontWeight(value: unknown, bold: boolean): FontWeight {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(clamp(value, 100, 900, bold ? 700 : 400));
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'bold') return 'bold';
    if (normalized === 'light') return 'light';
    if (normalized === 'normal') return 'normal';
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return Math.round(clamp(numeric, 100, 900, bold ? 700 : 400));
    }
  }

  return bold ? 'bold' : DEFAULT_CAPTION_STYLE.fontWeight;
}

function normalizeHex(raw: string): string | null {
  const match = raw.trim().match(HEX_COLOR_PATTERN);
  if (!match) {
    return null;
  }

  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
  }

  return hex;
}

export function parseCaptionHexColor(raw: string): CaptionColor | null {
  const hex = normalizeHex(raw);
  if (!hex) {
    return null;
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  };
}

export function captionColorToHex(color: CaptionColor | undefined, fallback = '#ffffff'): string {
  if (!color) {
    return fallback;
  }

  const toHex = (value: number): string =>
    clamp(Math.round(value), 0, 255, 0).toString(16).padStart(2, '0');

  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

export function captionColorToRgba(color: CaptionColor): string {
  const alpha = clamp(color.a / 255, 0, 1, 1);
  return `rgba(${clamp(color.r, 0, 255, 255)}, ${clamp(color.g, 0, 255, 255)}, ${clamp(color.b, 0, 255, 255)}, ${alpha})`;
}

function normalizeCaptionColor(value: unknown, fallback: CaptionColor): CaptionColor {
  if (typeof value === 'string') {
    return parseCaptionHexColor(value) ?? { ...fallback };
  }

  if (value && typeof value === 'object') {
    const candidate = value as Partial<CaptionColor>;
    return {
      r: Math.round(readNumber(candidate.r, fallback.r, 0, 255)),
      g: Math.round(readNumber(candidate.g, fallback.g, 0, 255)),
      b: Math.round(readNumber(candidate.b, fallback.b, 0, 255)),
      a: Math.round(readNumber(candidate.a, fallback.a, 0, 255)),
    };
  }

  return { ...fallback };
}

function normalizeOptionalCaptionColor(value: unknown): CaptionColor | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return normalizeCaptionColor(value, { r: 0, g: 0, b: 0, a: 255 });
}

export function getCaptionFontWeightNumber(style: CaptionStyle): number {
  if (typeof style.fontWeight === 'number') {
    return Math.round(clamp(style.fontWeight, 100, 900, 400));
  }

  if (style.bold) {
    return 700;
  }

  if (style.fontWeight === 'bold') {
    return 700;
  }

  if (style.fontWeight === 'light') {
    return 300;
  }

  return 400;
}

export function normalizeCaptionStyle(style: unknown): CaptionStyle {
  const source: CaptionStyleLike =
    style && typeof style === 'object' ? (style as CaptionStyleLike) : {};
  const defaultShadowOffset = DEFAULT_CAPTION_STYLE.shadowOffset;
  const bold = readBoolean(source.bold, source.fontWeight === 'bold');
  const fontWeight = normalizeFontWeight(source.fontWeight, bold);
  const shadowOffset = readNumber(source.shadowOffset, defaultShadowOffset, -500, 500);

  return {
    ...DEFAULT_CAPTION_STYLE,
    ...source,
    fontFamily:
      typeof source.fontFamily === 'string' && source.fontFamily.trim().length > 0
        ? source.fontFamily.trim()
        : DEFAULT_CAPTION_STYLE.fontFamily,
    fontSize: readNumber(source.fontSize, DEFAULT_CAPTION_STYLE.fontSize, 1, 500),
    fontWeight,
    bold,
    color: normalizeCaptionColor(source.color, DEFAULT_CAPTION_STYLE.color),
    opacity: readNumber(source.opacity, DEFAULT_CAPTION_STYLE.opacity ?? 1, 0, 1),
    backgroundColor: normalizeOptionalCaptionColor(source.backgroundColor),
    backgroundPadding: readNumber(
      source.backgroundPadding,
      DEFAULT_CAPTION_STYLE.backgroundPadding ?? 10,
      0,
      500,
    ),
    outlineColor: normalizeOptionalCaptionColor(source.outlineColor),
    outlineWidth: readNumber(source.outlineWidth, DEFAULT_CAPTION_STYLE.outlineWidth, 0, 100),
    shadowColor: normalizeOptionalCaptionColor(source.shadowColor),
    shadowOffset,
    shadowOffsetX: readNumber(source.shadowOffsetX, shadowOffset, -500, 500),
    shadowOffsetY: readNumber(source.shadowOffsetY, shadowOffset, -500, 500),
    shadowBlur: readNumber(source.shadowBlur, DEFAULT_CAPTION_STYLE.shadowBlur ?? 0, 0, 500),
    alignment: readAlignment(source.alignment, DEFAULT_CAPTION_STYLE.alignment),
    italic: readBoolean(source.italic, DEFAULT_CAPTION_STYLE.italic),
    underline: readBoolean(source.underline, DEFAULT_CAPTION_STYLE.underline),
    lineHeight: readNumber(source.lineHeight, DEFAULT_CAPTION_STYLE.lineHeight ?? 1.2, 0.5, 5),
    letterSpacing: readNumber(
      source.letterSpacing,
      DEFAULT_CAPTION_STYLE.letterSpacing ?? 0,
      -100,
      200,
    ),
  };
}

export function normalizeCaptionPosition(
  position: CaptionPosition | null | undefined,
): CaptionPosition {
  if (!position || typeof position !== 'object') {
    return DEFAULT_CAPTION_POSITION;
  }

  if (position.type === 'custom') {
    return {
      type: 'custom',
      xPercent: readNumber(position.xPercent, 50, 0, 100),
      yPercent: readNumber(position.yPercent, 90, 0, 100),
    };
  }

  const vertical =
    position.vertical === 'top' || position.vertical === 'center' || position.vertical === 'bottom'
      ? position.vertical
      : DEFAULT_CAPTION_POSITION.type === 'preset'
        ? DEFAULT_CAPTION_POSITION.vertical
        : 'bottom';

  return {
    type: 'preset',
    vertical,
    marginPercent: readNumber(position.marginPercent, 5, 0, 50),
  };
}

export function parseCaptionPositionValue(value: unknown): CaptionPosition | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<CaptionPosition> & Record<string, unknown>;

  if (candidate.type === 'custom') {
    return normalizeCaptionPosition({
      type: 'custom',
      xPercent: Number(candidate.xPercent),
      yPercent: Number(candidate.yPercent),
    });
  }

  if (candidate.type === 'preset') {
    const vertical =
      candidate.vertical === 'top' || candidate.vertical === 'center'
        ? candidate.vertical
        : 'bottom';
    return normalizeCaptionPosition({
      type: 'preset',
      vertical,
      marginPercent: Number(candidate.marginPercent),
    });
  }

  if ('xPercent' in candidate || 'yPercent' in candidate || 'x' in candidate || 'y' in candidate) {
    return normalizeCaptionPosition({
      type: 'custom',
      xPercent: Number(candidate.xPercent ?? candidate.x),
      yPercent: Number(candidate.yPercent ?? candidate.y),
    });
  }

  return null;
}

export function resolveCaptionAnchor(
  style: CaptionStyle,
  position: CaptionPosition,
): {
  xPercent: number;
  yPercent: number;
} {
  let xPercent = 50;
  if (style.alignment === 'left') {
    xPercent = 10;
  } else if (style.alignment === 'right') {
    xPercent = 90;
  }

  let yPercent = 90;
  if (position.type === 'custom') {
    xPercent = position.xPercent;
    yPercent = position.yPercent;
  } else if (position.vertical === 'top') {
    yPercent = position.marginPercent;
  } else if (position.vertical === 'center') {
    yPercent = 50;
  } else {
    yPercent = 100 - position.marginPercent;
  }

  return {
    xPercent: readNumber(xPercent, 50, 0, 100),
    yPercent: readNumber(yPercent, 90, 0, 100),
  };
}

export function buildCaptionCssTextShadow(style: CaptionStyle): string | undefined {
  const parts: string[] = [];

  if (style.outlineColor && style.outlineWidth > 0) {
    const width = Math.max(1, Math.round(style.outlineWidth));
    const outline = captionColorToRgba(style.outlineColor);
    parts.push(
      `${-width}px 0 ${outline}`,
      `${width}px 0 ${outline}`,
      `0 ${-width}px ${outline}`,
      `0 ${width}px ${outline}`,
      `${-width}px ${-width}px ${outline}`,
      `${width}px ${-width}px ${outline}`,
      `${-width}px ${width}px ${outline}`,
      `${width}px ${width}px ${outline}`,
    );
  }

  if (style.shadowColor) {
    const offsetX = style.shadowOffsetX ?? style.shadowOffset;
    const offsetY = style.shadowOffsetY ?? style.shadowOffset;
    const blur = style.shadowBlur ?? 0;
    if (offsetX !== 0 || offsetY !== 0 || blur > 0) {
      parts.push(`${offsetX}px ${offsetY}px ${blur}px ${captionColorToRgba(style.shadowColor)}`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : undefined;
}
