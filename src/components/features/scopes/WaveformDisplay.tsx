/**
 * WaveformDisplay Component
 *
 * Displays a waveform monitor showing luminance distribution
 * across the horizontal axis of a video frame.
 *
 * Features:
 * - Shows min/max/average luminance per column
 * - IRE scale markers (0, 7.5, 100, super-white)
 * - Multiple display modes (filled, line, dots)
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { WaveformData } from '@/utils/scopeAnalysis';

// =============================================================================
// Types
// =============================================================================

export type WaveformMode = 'filled' | 'line' | 'intensity';

export interface WaveformDisplayProps {
  /** Waveform data to display */
  data: WaveformData;
  /** Display mode */
  mode?: WaveformMode;
  /** Width of the display */
  width?: number;
  /** Height of the display */
  height?: number;
  /** Waveform color */
  color?: string;
  /** Show IRE scale markers */
  showScale?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = {
  waveform: 'rgba(34, 197, 94, 0.8)',     // green-500
  waveformFill: 'rgba(34, 197, 94, 0.3)',
  grid: 'rgba(75, 85, 99, 0.4)',          // gray-600
  scaleText: 'rgba(156, 163, 175, 0.8)',  // gray-400
  background: '#1f2937',                   // gray-800
  safeZone: 'rgba(34, 197, 94, 0.1)',
  dangerZone: 'rgba(239, 68, 68, 0.1)',
};

// IRE levels (video levels)
const IRE_LEVELS = [
  { value: 0, label: '0', y: 1.0 },       // Black
  { value: 7.5, label: '7.5', y: 0.9706 },// Setup/pedestal (NTSC)
  { value: 50, label: '50', y: 0.5 },     // Mid-gray
  { value: 100, label: '100', y: 0.0 },   // White
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts luminance value (0-255) to Y position on canvas.
 */
function lumToY(lum: number, height: number): number {
  return height - (lum / 255) * height;
}

/**
 * Draws IRE scale markers and labels.
 */
function drawScale(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.scaleText;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.setLineDash([2, 4]);

  IRE_LEVELS.forEach(({ label, y }) => {
    const yPos = y * height;

    // Draw line
    ctx.beginPath();
    ctx.moveTo(25, yPos);
    ctx.lineTo(width, yPos);
    ctx.stroke();

    // Draw label
    ctx.fillText(label, 22, yPos);
  });

  ctx.setLineDash([]);
}

/**
 * Draws danger zones (clipping indicators).
 */
function drawZones(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  // Super-white zone (above 100 IRE)
  ctx.fillStyle = COLORS.dangerZone;
  ctx.fillRect(0, 0, width, height * 0.02);

  // Below black zone
  ctx.fillRect(0, height * 0.98, width, height * 0.02);

  // Safe zone (7.5 to 100 IRE)
  ctx.fillStyle = COLORS.safeZone;
  ctx.fillRect(0, height * 0.02, width, height * 0.94);
}

// =============================================================================
// Component
// =============================================================================

export const WaveformDisplay = memo(function WaveformDisplay({
  data,
  mode = 'filled',
  width = 256,
  height = 200,
  color,
  showScale = true,
  className = '',
}: WaveformDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformColor = color ?? COLORS.waveform;
  const fillColor = color ? `${color}33` : COLORS.waveformFill;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw zones
    drawZones(ctx, width, height);

    // Draw scale
    if (showScale) {
      drawScale(ctx, width, height);
    }

    // Skip if no data
    if (data.columns.length === 0) return;

    const leftPadding = showScale ? 25 : 0;
    const drawWidth = width - leftPadding;
    const colWidth = drawWidth / data.columns.length;

    // Draw waveform based on mode
    switch (mode) {
      case 'filled': {
        // Draw filled area between min and max
        ctx.fillStyle = fillColor;
        ctx.beginPath();

        // Draw max line (top)
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.max, height);
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });

        // Draw min line (bottom, reversed)
        for (let i = data.columns.length - 1; i >= 0; i--) {
          const col = data.columns[i];
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.min, height);
          ctx.lineTo(x, y);
        }

        ctx.closePath();
        ctx.fill();

        // Draw average line
        ctx.strokeStyle = waveformColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.avg, height);
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();
        break;
      }

      case 'line': {
        // Draw min, max, and average as separate lines
        ctx.lineWidth = 1;

        // Max line
        ctx.strokeStyle = `${waveformColor}80`;
        ctx.beginPath();
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.max, height);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Min line
        ctx.beginPath();
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.min, height);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Average line (brighter)
        ctx.strokeStyle = waveformColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth + colWidth / 2;
          const y = lumToY(col.avg, height);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        break;
      }

      case 'intensity': {
        // Draw intensity-based display using distribution data
        data.columns.forEach((col, i) => {
          const x = leftPadding + i * colWidth;

          // Find max count in distribution for normalization
          const maxCount = Math.max(...col.distribution);
          if (maxCount === 0) return;

          col.distribution.forEach((count, lum) => {
            if (count === 0) return;
            const intensity = Math.min(1, count / maxCount);
            const y = lumToY(lum, height);
            ctx.fillStyle = `rgba(34, 197, 94, ${intensity * 0.8})`;
            ctx.fillRect(x, y - 1, Math.max(1, colWidth), 2);
          });
        });
        break;
      }
    }
  }, [data, mode, width, height, waveformColor, fillColor, showScale]);

  // Render on data or settings change
  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="waveform-display"
      width={width}
      height={height}
      className={`rounded ${className}`}
      aria-label="Waveform monitor showing luminance distribution"
    />
  );
});

export default WaveformDisplay;
