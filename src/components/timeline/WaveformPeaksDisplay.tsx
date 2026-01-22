/**
 * WaveformPeaksDisplay Component
 *
 * Canvas-based waveform visualization component that renders audio peaks.
 * Supports multiple display modes: bars, line, and fill.
 *
 * Features:
 * - Efficient canvas rendering for large peak arrays
 * - Source range clipping support
 * - Mirrored display mode for stereo-like appearance
 * - Customizable colors and opacity
 */

import { useEffect, useRef, useMemo, memo } from 'react';

// =============================================================================
// Types
// =============================================================================

export type WaveformDisplayMode = 'bars' | 'line' | 'fill';

export interface WaveformPeaksDisplayProps {
  /** Array of peak values (0.0 - 1.0) */
  peaks: number[] | null | undefined;
  /** Width of the canvas in pixels */
  width: number;
  /** Height of the canvas in pixels */
  height: number;
  /** Waveform color (CSS color string) */
  color?: string;
  /** Waveform opacity (0-1) */
  opacity?: number;
  /** Display mode: bars, line, or fill */
  mode?: WaveformDisplayMode;
  /** Whether to mirror the waveform (stereo-like appearance) */
  mirrored?: boolean;
  /** Samples per second (for clipping calculations) */
  samplesPerSecond?: number;
  /** Source in time for clipping (seconds) */
  sourceInSec?: number;
  /** Source out time for clipping (seconds) */
  sourceOutSec?: number;
  /** Additional CSS class name */
  className?: string;
  /** Background color (default: transparent) */
  backgroundColor?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_COLOR = '#3b82f6'; // Tailwind blue-500
const DEFAULT_MODE: WaveformDisplayMode = 'fill';
const MIN_BAR_WIDTH = 1;
const BAR_GAP = 1;

// =============================================================================
// Component
// =============================================================================

export const WaveformPeaksDisplay = memo(function WaveformPeaksDisplay({
  peaks,
  width,
  height,
  color = DEFAULT_COLOR,
  opacity = 1,
  mode = DEFAULT_MODE,
  mirrored = false,
  samplesPerSecond = 100,
  sourceInSec,
  sourceOutSec,
  className = '',
  backgroundColor,
}: WaveformPeaksDisplayProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Calculate the peaks to display based on source range
  const displayPeaks = useMemo(() => {
    if (!peaks || peaks.length === 0) {
      return [];
    }

    // If no source range specified, use all peaks
    if (sourceInSec === undefined && sourceOutSec === undefined) {
      return peaks;
    }

    const startIndex = Math.max(
      0,
      Math.floor((sourceInSec ?? 0) * samplesPerSecond)
    );
    const endIndex = Math.min(
      peaks.length,
      Math.ceil((sourceOutSec ?? peaks.length / samplesPerSecond) * samplesPerSecond)
    );

    if (startIndex >= peaks.length) {
      return [];
    }

    return peaks.slice(startIndex, endIndex);
  }, [peaks, sourceInSec, sourceOutSec, samplesPerSecond]);

  // Draw waveform on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background if specified
    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
    }

    // No peaks to draw
    if (!displayPeaks || displayPeaks.length === 0) {
      return;
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    const centerY = height / 2;

    switch (mode) {
      case 'bars':
        drawBars(ctx, displayPeaks, width, height, centerY, mirrored);
        break;
      case 'line':
        drawLine(ctx, displayPeaks, width, height, centerY, mirrored);
        break;
      case 'fill':
      default:
        drawFill(ctx, displayPeaks, width, height, centerY, mirrored);
        break;
    }
  }, [displayPeaks, width, height, color, mode, mirrored, backgroundColor]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      role="img"
      aria-label="Audio waveform"
      className={className}
      style={{ opacity }}
    />
  );
});

// =============================================================================
// Drawing Functions
// =============================================================================

/**
 * Draw waveform as vertical bars
 */
function drawBars(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  width: number,
  height: number,
  centerY: number,
  mirrored: boolean
): void {
  const peakCount = peaks.length;
  const barWidth = Math.max(MIN_BAR_WIDTH, (width - peakCount * BAR_GAP) / peakCount);
  const step = Math.max(1, Math.ceil(peakCount / width));

  let x = 0;
  for (let i = 0; i < peakCount; i += step) {
    // Average peaks in this step for smoother display
    let sum = 0;
    let count = 0;
    for (let j = i; j < Math.min(i + step, peakCount); j++) {
      sum += peaks[j];
      count++;
    }
    const peak = count > 0 ? sum / count : 0;

    const barHeight = peak * (mirrored ? centerY : height);

    if (mirrored) {
      // Draw from center up and down
      ctx.fillRect(x, centerY - barHeight, barWidth, barHeight);
      ctx.fillRect(x, centerY, barWidth, barHeight);
    } else {
      // Draw from bottom up
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
    }

    x += barWidth + BAR_GAP;
    if (x >= width) break;
  }
}

/**
 * Draw waveform as a continuous line
 */
function drawLine(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  width: number,
  height: number,
  centerY: number,
  mirrored: boolean
): void {
  const peakCount = peaks.length;
  const step = peakCount / width;

  ctx.beginPath();

  for (let x = 0; x < width; x++) {
    const peakIndex = Math.min(Math.floor(x * step), peakCount - 1);
    const peak = peaks[peakIndex];
    const y = mirrored
      ? centerY - peak * centerY
      : height - peak * height;

    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();

  // Draw mirrored line if enabled
  if (mirrored) {
    ctx.beginPath();

    for (let x = 0; x < width; x++) {
      const peakIndex = Math.min(Math.floor(x * step), peakCount - 1);
      const peak = peaks[peakIndex];
      const y = centerY + peak * centerY;

      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  }
}

/**
 * Draw waveform as a filled area
 */
function drawFill(
  ctx: CanvasRenderingContext2D,
  peaks: number[],
  width: number,
  height: number,
  centerY: number,
  mirrored: boolean
): void {
  const peakCount = peaks.length;
  const step = peakCount / width;

  ctx.beginPath();

  if (mirrored) {
    // Draw top half
    ctx.moveTo(0, centerY);

    for (let x = 0; x < width; x++) {
      const peakIndex = Math.min(Math.floor(x * step), peakCount - 1);
      const peak = peaks[peakIndex];
      const y = centerY - peak * centerY;
      ctx.lineTo(x, y);
    }

    // Draw bottom half (going back)
    for (let x = width - 1; x >= 0; x--) {
      const peakIndex = Math.min(Math.floor(x * step), peakCount - 1);
      const peak = peaks[peakIndex];
      const y = centerY + peak * centerY;
      ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fill();
  } else {
    // Draw from bottom
    ctx.moveTo(0, height);

    for (let x = 0; x < width; x++) {
      const peakIndex = Math.min(Math.floor(x * step), peakCount - 1);
      const peak = peaks[peakIndex];
      const y = height - peak * height;
      ctx.lineTo(x, y);
    }

    // Close path at bottom
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  }
}
