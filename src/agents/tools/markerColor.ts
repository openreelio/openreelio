import type { Color } from '@/types';

const MARKER_COLOR_PRESETS: Record<string, Color> = {
  red: { r: 1, g: 0, b: 0 },
  orange: { r: 1, g: 0.5, b: 0 },
  yellow: { r: 1, g: 0.8, b: 0 },
  green: { r: 0, g: 1, b: 0 },
  blue: { r: 0, g: 0, b: 1 },
  purple: { r: 0.5, g: 0, b: 0.5 },
  pink: { r: 1, g: 0.4, b: 0.7 },
  cyan: { r: 0, g: 1, b: 1 },
  white: { r: 1, g: 1, b: 1 },
  black: { r: 0, g: 0, b: 0 },
};

function parseHexMarkerColor(input: string): Color | undefined {
  const normalized = input.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(normalized)) {
    return undefined;
  }

  const color: Color = {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255,
  };

  if (normalized.length === 8) {
    color.a = parseInt(normalized.slice(6, 8), 16) / 255;
  }

  return color;
}

export function normalizeMarkerColor(input: unknown): Color | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    const preset = MARKER_COLOR_PRESETS[normalized];
    if (preset) {
      return { ...preset };
    }

    const parsedHex = parseHexMarkerColor(input);
    if (parsedHex) {
      return parsedHex;
    }

    throw new Error('Invalid marker color. Use a named color or hex (#RRGGBB or #RRGGBBAA).');
  }

  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const raw = input as Partial<Color>;
    const r = Number(raw.r);
    const g = Number(raw.g);
    const b = Number(raw.b);

    if (![r, g, b].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Invalid marker color. RGB values must be numbers between 0 and 1.');
    }

    const color: Color = { r, g, b };
    if (raw.a !== undefined) {
      const a = Number(raw.a);
      if (!Number.isFinite(a) || a < 0 || a > 1) {
        throw new Error('Invalid marker color. Alpha must be a number between 0 and 1.');
      }
      color.a = a;
    }

    return color;
  }

  throw new Error('Invalid marker color. Use a named color, hex string, or an RGBA object.');
}
