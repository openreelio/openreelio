/**
 * RGBParadeDisplay Component
 *
 * Displays an RGB Parade showing separate waveforms for
 * each color channel (Red, Green, Blue) side by side.
 *
 * Features:
 * - Separate waveform for each RGB channel
 * - Channel-specific colors
 * - Scale markers
 * - Min/max/average visualization
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { RGBParadeData } from '@/utils/scopeAnalysis';

// =============================================================================
// Types
// =============================================================================

export type ParadeMode = 'filled' | 'line';

export interface RGBParadeDisplayProps {
  /** RGB Parade data to display */
  data: RGBParadeData;
  /** Display mode */
  mode?: ParadeMode;
  /** Width of the display */
  width?: number;
  /** Height of the display */
  height?: number;
  /** Show scale markers */
  showScale?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = {
  red: 'rgba(239, 68, 68, 0.9)',
  redFill: 'rgba(239, 68, 68, 0.3)',
  green: 'rgba(34, 197, 94, 0.9)',
  greenFill: 'rgba(34, 197, 94, 0.3)',
  blue: 'rgba(59, 130, 246, 0.9)',
  blueFill: 'rgba(59, 130, 246, 0.3)',
  grid: 'rgba(75, 85, 99, 0.4)',
  separator: 'rgba(75, 85, 99, 0.6)',
  scaleText: 'rgba(156, 163, 175, 0.8)',
  background: '#1f2937',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts value (0-255) to Y position on canvas.
 */
function valueToY(value: number, height: number): number {
  return height - (value / 255) * height;
}

/**
 * Draws scale markers on the left side.
 */
function drawScale(
  ctx: CanvasRenderingContext2D,
  height: number
): void {
  ctx.fillStyle = COLORS.scaleText;
  ctx.font = '9px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  // Draw scale values (0, 64, 128, 192, 255)
  [0, 64, 128, 192, 255].forEach((value) => {
    const y = valueToY(value, height);
    ctx.fillText(value.toString(), 20, y);
  });
}

/**
 * Draws horizontal grid lines.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  leftPadding: number
): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);

  // Draw lines at 0, 64, 128, 192, 255
  [0, 64, 128, 192, 255].forEach((value) => {
    const y = valueToY(value, height);
    ctx.beginPath();
    ctx.moveTo(leftPadding, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  });

  ctx.setLineDash([]);
}

/**
 * Draws a single channel waveform.
 */
function drawChannelWaveform(
  ctx: CanvasRenderingContext2D,
  columns: { min: number; max: number; avg: number }[],
  color: string,
  fillColor: string,
  startX: number,
  sectionWidth: number,
  height: number,
  mode: ParadeMode
): void {
  if (columns.length === 0) return;

  const colWidth = sectionWidth / columns.length;

  if (mode === 'filled') {
    // Draw filled area between min and max
    ctx.fillStyle = fillColor;
    ctx.beginPath();

    // Draw max line (top)
    columns.forEach((col, i) => {
      const x = startX + i * colWidth + colWidth / 2;
      const y = valueToY(col.max, height);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    // Draw min line (bottom, reversed)
    for (let i = columns.length - 1; i >= 0; i--) {
      const col = columns[i];
      const x = startX + i * colWidth + colWidth / 2;
      const y = valueToY(col.min, height);
      ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fill();
  }

  // Draw average line
  ctx.strokeStyle = color;
  ctx.lineWidth = mode === 'filled' ? 1 : 2;
  ctx.beginPath();

  columns.forEach((col, i) => {
    const x = startX + i * colWidth + colWidth / 2;
    const y = valueToY(col.avg, height);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();

  if (mode === 'line') {
    // Draw min/max lines in lighter color
    ctx.strokeStyle = `${color}60`;
    ctx.lineWidth = 1;

    // Max line
    ctx.beginPath();
    columns.forEach((col, i) => {
      const x = startX + i * colWidth + colWidth / 2;
      const y = valueToY(col.max, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Min line
    ctx.beginPath();
    columns.forEach((col, i) => {
      const x = startX + i * colWidth + colWidth / 2;
      const y = valueToY(col.min, height);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

/**
 * Draws channel labels.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  sectionWidth: number,
  leftPadding: number,
  height: number
): void {
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const labels = [
    { text: 'R', color: COLORS.red },
    { text: 'G', color: COLORS.green },
    { text: 'B', color: COLORS.blue },
  ];

  labels.forEach(({ text, color }, i) => {
    ctx.fillStyle = color;
    const x = leftPadding + i * sectionWidth + sectionWidth / 2;
    ctx.fillText(text, x, height + 4);
  });
}

// =============================================================================
// Component
// =============================================================================

export const RGBParadeDisplay = memo(function RGBParadeDisplay({
  data,
  mode = 'filled',
  width = 384,
  height = 200,
  showScale = true,
  className = '',
}: RGBParadeDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasHeight = height + 20; // Extra space for labels

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, canvasHeight);

    const leftPadding = showScale ? 25 : 0;
    const drawWidth = width - leftPadding;
    const sectionWidth = drawWidth / 3;

    // Draw scale
    if (showScale) {
      drawScale(ctx, height);
    }

    // Draw grid
    drawGrid(ctx, width, height, leftPadding);

    // Draw channel separators
    ctx.strokeStyle = COLORS.separator;
    ctx.lineWidth = 1;
    [1, 2].forEach((i) => {
      const x = leftPadding + i * sectionWidth;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    });

    // Draw each channel
    drawChannelWaveform(
      ctx,
      data.red.columns,
      COLORS.red,
      COLORS.redFill,
      leftPadding,
      sectionWidth,
      height,
      mode
    );

    drawChannelWaveform(
      ctx,
      data.green.columns,
      COLORS.green,
      COLORS.greenFill,
      leftPadding + sectionWidth,
      sectionWidth,
      height,
      mode
    );

    drawChannelWaveform(
      ctx,
      data.blue.columns,
      COLORS.blue,
      COLORS.blueFill,
      leftPadding + sectionWidth * 2,
      sectionWidth,
      height,
      mode
    );

    // Draw channel labels
    drawLabels(ctx, sectionWidth, leftPadding, height);
  }, [data, mode, width, height, canvasHeight, showScale]);

  // Render on data or settings change
  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="rgb-parade-display"
      width={width}
      height={canvasHeight}
      className={`rounded ${className}`}
      aria-label="RGB Parade showing separate waveforms for red, green, and blue channels"
    />
  );
});

export default RGBParadeDisplay;
