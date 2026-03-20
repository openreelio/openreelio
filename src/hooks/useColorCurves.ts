/**
 * useColorCurves Hook
 *
 * Manages state and operations for the Color Curves effect panel.
 * Handles parsing/serialization of curve points stored as JSON strings
 * in effect parameters, and provides CRUD operations for control points.
 *
 * Supports two curve families:
 * - RGB curves: identity = diagonal [(0,0),(1,1)], y maps input→output directly
 * - Advanced curves (H/H, H/S, L/S): identity = flat [(0,0.5),(1,0.5)], y=0.5 = no change
 */

import { useState, useCallback, useMemo } from 'react';
import type { SimpleParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

export type CurveChannel =
  | 'master'
  | 'red'
  | 'green'
  | 'blue'
  | 'hue_vs_hue'
  | 'hue_vs_sat'
  | 'luma_vs_sat';

/** Drawing mode for the curve canvas background */
export type DrawCurveMode = 'rgb' | 'hue' | 'luma';

export interface CurvePoint {
  x: number;
  y: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Identity for RGB curves: diagonal from (0,0) to (1,1) */
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** Identity for advanced curves: flat line at y=0.5 (no change) */
export const FLAT_IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0.5 },
  { x: 1, y: 0.5 },
];

export const CHANNEL_PARAM_MAP: Record<CurveChannel, string> = {
  master: 'master_curve',
  red: 'red_curve',
  green: 'green_curve',
  blue: 'blue_curve',
  hue_vs_hue: 'hue_vs_hue_curve',
  hue_vs_sat: 'hue_vs_sat_curve',
  luma_vs_sat: 'luma_vs_sat_curve',
};

export const CHANNEL_COLORS: Record<CurveChannel, string> = {
  master: '#ffffff',
  red: '#ff4444',
  green: '#44ff44',
  blue: '#4488ff',
  hue_vs_hue: '#ff88ff',
  hue_vs_sat: '#ffaa44',
  luma_vs_sat: '#88ccff',
};

/** Labels for channel tabs, grouped: RGB first, then advanced */
export const RGB_CHANNEL_LABELS: { key: CurveChannel; label: string }[] = [
  { key: 'master', label: 'Master' },
  { key: 'red', label: 'R' },
  { key: 'green', label: 'G' },
  { key: 'blue', label: 'B' },
];

export const ADVANCED_CHANNEL_LABELS: { key: CurveChannel; label: string }[] = [
  { key: 'hue_vs_hue', label: 'H/H' },
  { key: 'hue_vs_sat', label: 'H/S' },
  { key: 'luma_vs_sat', label: 'L/S' },
];

/** All channel labels (for backward compatibility) */
export const CHANNEL_LABELS: { key: CurveChannel; label: string }[] = [
  ...RGB_CHANNEL_LABELS,
  ...ADVANCED_CHANNEL_LABELS,
];

const ADVANCED_CHANNELS: CurveChannel[] = ['hue_vs_hue', 'hue_vs_sat', 'luma_vs_sat'];

/** Returns true if the channel is an advanced curve type (H/H, H/S, L/S) */
export function isAdvancedChannel(channel: CurveChannel): boolean {
  return ADVANCED_CHANNELS.includes(channel);
}

/** Returns the draw mode for a given channel */
export function getDrawMode(channel: CurveChannel): DrawCurveMode {
  if (channel === 'hue_vs_hue' || channel === 'hue_vs_sat') return 'hue';
  if (channel === 'luma_vs_sat') return 'luma';
  return 'rgb';
}

/** Returns the correct identity curve for a channel */
export function getIdentityCurve(channel: CurveChannel): CurvePoint[] {
  return isAdvancedChannel(channel) ? FLAT_IDENTITY_CURVE : IDENTITY_CURVE;
}

// =============================================================================
// Curve Point Utilities
// =============================================================================

/** Parse JSON curve points string from backend into CurvePoint array */
export function parseCurvePoints(
  json: string,
  fallback: CurvePoint[] = IDENTITY_CURVE,
): CurvePoint[] {
  try {
    const parsed = JSON.parse(json);
    if (
      Array.isArray(parsed) &&
      parsed.length >= 2 &&
      parsed.every(
        (p: unknown) =>
          typeof (p as Record<string, unknown>).x === 'number' &&
          typeof (p as Record<string, unknown>).y === 'number',
      )
    ) {
      return (parsed as CurvePoint[]).map((p) => ({
        x: clamp01(p.x),
        y: clamp01(p.y),
      }));
    }
  } catch {
    // Parse failure — return fallback
  }
  return fallback.map((p) => ({ ...p }));
}

/** Serialize curve points to JSON string, sorted by x coordinate */
export function serializeCurvePoints(points: CurvePoint[]): string {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  return JSON.stringify(sorted);
}

/** Check if curve is the identity (no-change) diagonal */
export function isIdentityCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false;
  const [p0, p1] = points;
  return (
    Math.abs(p0.x) < 0.001 &&
    Math.abs(p0.y) < 0.001 &&
    Math.abs(p1.x - 1) < 0.001 &&
    Math.abs(p1.y - 1) < 0.001
  );
}

/** Catmull-Rom spline interpolation through curve control points */
export function interpolateCurve(points: CurvePoint[], numSamples = 100): CurvePoint[] {
  if (points.length < 2) return [];
  const sorted = [...points].sort((a, b) => a.x - b.x);

  if (sorted.length === 2) {
    return Array.from({ length: numSamples + 1 }, (_, i) => {
      const t = i / numSamples;
      return {
        x: sorted[0].x + t * (sorted[1].x - sorted[0].x),
        y: sorted[0].y + t * (sorted[1].y - sorted[0].y),
      };
    });
  }

  const result: CurvePoint[] = [];
  const segSamples = Math.max(10, Math.round(numSamples / (sorted.length - 1)));

  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[Math.max(0, i - 1)];
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    const p3 = sorted[Math.min(sorted.length - 1, i + 2)];

    for (let j = 0; j <= segSamples; j++) {
      const t = j / segSamples;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push({
        x: clamp01(catmullRom(p0.x, p1.x, p2.x, p3.x, t, t2, t3)),
        y: clamp01(catmullRom(p0.y, p1.y, p2.y, p3.y, t, t2, t3)),
      });
    }
  }
  return result;
}

// =============================================================================
// Canvas Drawing
// =============================================================================

const GRID_DIVISIONS = 4;
const POINT_RADIUS = 5;
const GRADIENT_STRIP_HEIGHT = 12;
const MIN_CONTROL_POINT_SPACING = 0.001;

/** HSL hue spectrum colors for hue-based curve backgrounds */
const HUE_SPECTRUM_STOPS: [number, string][] = [
  [0, '#ff0000'],
  [1 / 6, '#ffff00'],
  [2 / 6, '#00ff00'],
  [3 / 6, '#00ffff'],
  [4 / 6, '#0000ff'],
  [5 / 6, '#ff00ff'],
  [1, '#ff0000'],
];

/** Draw the color curve on a canvas context */
export function drawColorCurve(
  ctx: CanvasRenderingContext2D,
  size: number,
  points: CurvePoint[],
  color: string,
  draggingIndex: number | null,
  mode: DrawCurveMode = 'rgb',
): void {
  ctx.clearRect(0, 0, size, size);

  // Background
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, size, size);

  // X-axis gradient strip for advanced modes
  if (mode === 'hue' || mode === 'luma') {
    drawAxisGradient(ctx, size, mode);
  }

  // Grid
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 0.5;
  for (let i = 1; i < GRID_DIVISIONS; i++) {
    const pos = (i / GRID_DIVISIONS) * size;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(size, pos);
    ctx.stroke();
  }

  // Reference line: diagonal for RGB, horizontal center for advanced
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  if (mode === 'rgb') {
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
  } else {
    // Horizontal at y=0.5 (center) for advanced curves
    const centerY = size * 0.5;
    ctx.moveTo(0, centerY);
    ctx.lineTo(size, centerY);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Interpolated curve
  const interpolated = interpolateCurve(points);
  if (interpolated.length > 0) {
    const toX = (v: number): number => v * size;
    const toY = (v: number): number => (1 - v) * size;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(interpolated[0].x), toY(interpolated[0].y));
    for (const p of interpolated) {
      ctx.lineTo(toX(p.x), toY(p.y));
    }
    ctx.stroke();

    // Semi-transparent fill under curve
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = color;
    ctx.lineTo(size, size);
    ctx.lineTo(0, size);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Control points
  for (let i = 0; i < points.length; i++) {
    const cx = points[i].x * size;
    const cy = (1 - points[i].y) * size;
    const active = i === draggingIndex;

    ctx.beginPath();
    ctx.arc(cx, cy, active ? POINT_RADIUS + 2 : POINT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#fff' : color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Draw hue spectrum or luminance gradient strip at bottom of canvas */
function drawAxisGradient(ctx: CanvasRenderingContext2D, size: number, mode: DrawCurveMode): void {
  const y = size - GRADIENT_STRIP_HEIGHT;
  const gradient = ctx.createLinearGradient(0, y, size, y);

  if (mode === 'hue') {
    for (const [stop, color] of HUE_SPECTRUM_STOPS) {
      gradient.addColorStop(stop, color);
    }
  } else {
    // Luminance: black to white
    gradient.addColorStop(0, '#000000');
    gradient.addColorStop(1, '#ffffff');
  }

  ctx.fillStyle = gradient;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(0, y, size, GRADIENT_STRIP_HEIGHT);
  ctx.globalAlpha = 1.0;
}

// =============================================================================
// Hook
// =============================================================================

interface UseColorCurvesOptions {
  params: Record<string, SimpleParamValue>;
  onChange: (paramName: string, value: SimpleParamValue) => void;
}

export function useColorCurves({ params, onChange }: UseColorCurvesOptions) {
  const [activeChannel, setActiveChannel] = useState<CurveChannel>('master');

  const curves = useMemo<Record<CurveChannel, CurvePoint[]>>(
    () => ({
      master: parseCurvePoints(String(params.master_curve ?? ''), IDENTITY_CURVE),
      red: parseCurvePoints(String(params.red_curve ?? ''), IDENTITY_CURVE),
      green: parseCurvePoints(String(params.green_curve ?? ''), IDENTITY_CURVE),
      blue: parseCurvePoints(String(params.blue_curve ?? ''), IDENTITY_CURVE),
      hue_vs_hue: parseCurvePoints(String(params.hue_vs_hue_curve ?? ''), FLAT_IDENTITY_CURVE),
      hue_vs_sat: parseCurvePoints(String(params.hue_vs_sat_curve ?? ''), FLAT_IDENTITY_CURVE),
      luma_vs_sat: parseCurvePoints(String(params.luma_vs_sat_curve ?? ''), FLAT_IDENTITY_CURVE),
    }),
    [
      params.master_curve,
      params.red_curve,
      params.green_curve,
      params.blue_curve,
      params.hue_vs_hue_curve,
      params.hue_vs_sat_curve,
      params.luma_vs_sat_curve,
    ],
  );

  const activePoints = curves[activeChannel];
  const paramName = CHANNEL_PARAM_MAP[activeChannel];

  const updateCurve = useCallback(
    (points: CurvePoint[]) => onChange(paramName, serializeCurvePoints(points)),
    [paramName, onChange],
  );

  const addPoint = useCallback(
    (x: number, y: number) => {
      const pt = { x: clamp01(x), y: clamp01(y) };
      updateCurve([...activePoints, pt].sort((a, b) => a.x - b.x));
    },
    [activePoints, updateCurve],
  );

  const movePoint = useCallback(
    (index: number, x: number, y: number) => {
      const isEndpoint = index === 0 || index === activePoints.length - 1;
      const clampedX = isEndpoint
        ? (activePoints[index]?.x ?? clamp01(x))
        : clampBetweenNeighbors(activePoints, index, clamp01(x));
      const updated = activePoints.map((p, i) =>
        i !== index
          ? p
          : {
              x: clampedX,
              y: clamp01(y),
            },
      );
      updateCurve(updated);
    },
    [activePoints, updateCurve],
  );

  const deletePoint = useCallback(
    (index: number) => {
      if (index === 0 || index === activePoints.length - 1) return;
      updateCurve(activePoints.filter((_, i) => i !== index));
    },
    [activePoints, updateCurve],
  );

  const resetChannel = useCallback(() => {
    const identity = getIdentityCurve(activeChannel);
    updateCurve(identity.map((p) => ({ ...p })));
  }, [activeChannel, updateCurve]);

  const resetAll = useCallback(() => {
    const rgbId = serializeCurvePoints(IDENTITY_CURVE);
    const flatId = serializeCurvePoints(FLAT_IDENTITY_CURVE);
    onChange('master_curve', rgbId);
    onChange('red_curve', rgbId);
    onChange('green_curve', rgbId);
    onChange('blue_curve', rgbId);
    onChange('hue_vs_hue_curve', flatId);
    onChange('hue_vs_sat_curve', flatId);
    onChange('luma_vs_sat_curve', flatId);
  }, [onChange]);

  return {
    activeChannel,
    setActiveChannel,
    curves,
    activePoints,
    addPoint,
    movePoint,
    deletePoint,
    resetChannel,
    resetAll,
  };
}

// =============================================================================
// Internal Helpers
// =============================================================================

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clampBetweenNeighbors(points: CurvePoint[], index: number, x: number): number {
  const previousX = points[index - 1]?.x ?? 0;
  const nextX = points[index + 1]?.x ?? 1;
  if (nextX - previousX <= MIN_CONTROL_POINT_SPACING * 2) {
    return (previousX + nextX) / 2;
  }

  const minX = previousX + MIN_CONTROL_POINT_SPACING;
  const maxX = nextX - MIN_CONTROL_POINT_SPACING;
  return Math.max(minX, Math.min(maxX, x));
}

function catmullRom(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
  t2: number,
  t3: number,
): number {
  return (
    0.5 *
    (2 * v1 +
      (-v0 + v2) * t +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + 3 * v1 - 3 * v2 + v3) * t3)
  );
}
