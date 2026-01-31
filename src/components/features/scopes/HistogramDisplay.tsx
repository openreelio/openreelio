/**
 * HistogramDisplay Component
 *
 * Displays a histogram visualization showing the distribution of
 * RGB and luminance values in a video frame.
 *
 * Features:
 * - RGB channel overlay or separate view
 * - Luminance-only mode
 * - Logarithmic scale option for better visibility
 * - Responsive canvas rendering
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { HistogramData } from '@/utils/scopeAnalysis';
import { normalizeHistogram } from '@/utils/scopeAnalysis';

// =============================================================================
// Types
// =============================================================================

export type HistogramMode = 'rgb' | 'luminance' | 'parade';

export interface HistogramDisplayProps {
  /** Histogram data to display */
  data: HistogramData;
  /** Display mode */
  mode?: HistogramMode;
  /** Width of the display */
  width?: number;
  /** Height of the display */
  height?: number;
  /** Use logarithmic scale */
  logarithmic?: boolean;
  /** Show grid lines */
  showGrid?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = {
  red: 'rgba(239, 68, 68, 0.7)',      // red-500
  green: 'rgba(34, 197, 94, 0.7)',    // green-500
  blue: 'rgba(59, 130, 246, 0.7)',    // blue-500
  luminance: 'rgba(255, 255, 255, 0.8)',
  grid: 'rgba(75, 85, 99, 0.3)',      // gray-600
  background: '#1f2937',              // gray-800
};

const PARADE_COLORS = {
  red: 'rgba(239, 68, 68, 0.9)',
  green: 'rgba(34, 197, 94, 0.9)',
  blue: 'rgba(59, 130, 246, 0.9)',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Applies logarithmic scaling to histogram values.
 */
function applyLogScale(values: number[]): number[] {
  return values.map((v) => (v > 0 ? Math.log10(v + 1) / Math.log10(2) : 0));
}

/**
 * Draws a single histogram channel.
 */
function drawChannel(
  ctx: CanvasRenderingContext2D,
  values: number[],
  color: string,
  width: number,
  height: number,
  offsetX: number = 0
): void {
  const barWidth = width / 256;
  ctx.fillStyle = color;

  for (let i = 0; i < 256; i++) {
    const barHeight = values[i] * height;
    if (barHeight > 0) {
      ctx.fillRect(
        offsetX + i * barWidth,
        height - barHeight,
        Math.max(1, barWidth),
        barHeight
      );
    }
  }
}

/**
 * Draws grid lines on the histogram.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);

  // Vertical lines at 25%, 50%, 75%
  [0.25, 0.5, 0.75].forEach((pos) => {
    const x = Math.floor(pos * width);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  });

  // Horizontal lines at 25%, 50%, 75%
  [0.25, 0.5, 0.75].forEach((pos) => {
    const y = Math.floor(pos * height);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  });

  ctx.setLineDash([]);
}

// =============================================================================
// Component
// =============================================================================

export const HistogramDisplay = memo(function HistogramDisplay({
  data,
  mode = 'rgb',
  width = 256,
  height = 128,
  logarithmic = false,
  showGrid = true,
  className = '',
}: HistogramDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    // Draw grid
    if (showGrid) {
      drawGrid(ctx, width, height);
    }

    // Normalize histogram data
    const maxCount = logarithmic
      ? Math.max(
          ...applyLogScale(data.red),
          ...applyLogScale(data.green),
          ...applyLogScale(data.blue),
          ...applyLogScale(data.luminance)
        )
      : data.maxCount;

    if (maxCount === 0) return;

    // Get normalized values
    const getNormalized = (channel: number[]): number[] => {
      const values = logarithmic ? applyLogScale(channel) : channel;
      const max = logarithmic ? maxCount : data.maxCount;
      return normalizeHistogram(values, max);
    };

    // Draw based on mode
    switch (mode) {
      case 'rgb': {
        // Draw channels with blending (red, green, blue overlaid)
        ctx.globalCompositeOperation = 'lighter';
        drawChannel(ctx, getNormalized(data.red), COLORS.red, width, height);
        drawChannel(ctx, getNormalized(data.green), COLORS.green, width, height);
        drawChannel(ctx, getNormalized(data.blue), COLORS.blue, width, height);
        ctx.globalCompositeOperation = 'source-over';
        break;
      }

      case 'luminance': {
        drawChannel(ctx, getNormalized(data.luminance), COLORS.luminance, width, height);
        break;
      }

      case 'parade': {
        // Draw R, G, B side by side
        const sectionWidth = Math.floor(width / 3);
        drawChannel(ctx, getNormalized(data.red), PARADE_COLORS.red, sectionWidth, height, 0);
        drawChannel(ctx, getNormalized(data.green), PARADE_COLORS.green, sectionWidth, height, sectionWidth);
        drawChannel(ctx, getNormalized(data.blue), PARADE_COLORS.blue, sectionWidth, height, sectionWidth * 2);

        // Draw separators
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        [sectionWidth, sectionWidth * 2].forEach((x) => {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        });
        break;
      }
    }
  }, [data, mode, width, height, logarithmic, showGrid]);

  // Render on data or settings change
  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="histogram-display"
      width={width}
      height={height}
      className={`rounded ${className}`}
      aria-label={`Histogram display showing ${mode} distribution`}
    />
  );
});

export default HistogramDisplay;
