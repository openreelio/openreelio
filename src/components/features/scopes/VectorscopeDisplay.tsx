/**
 * VectorscopeDisplay Component
 *
 * Displays a vectorscope showing color hue and saturation
 * in the Cb/Cr (YUV) color space.
 *
 * Features:
 * - Circular display with color targets
 * - Graticule showing standard color positions
 * - Intensity-based pixel visualization
 * - Skin tone indicator line
 */

import { memo, useRef, useEffect, useCallback } from 'react';
import type { VectorscopeData } from '@/utils/scopeAnalysis';

// =============================================================================
// Types
// =============================================================================

export interface VectorscopeDisplayProps {
  /** Vectorscope data to display */
  data: VectorscopeData;
  /** Size of the display (square) */
  size?: number;
  /** Show color target markers */
  showTargets?: boolean;
  /** Show skin tone line */
  showSkinTone?: boolean;
  /** Show graticule */
  showGraticule?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const COLORS = {
  background: '#1f2937',              // gray-800
  graticule: 'rgba(75, 85, 99, 0.5)', // gray-600
  center: 'rgba(156, 163, 175, 0.6)', // gray-400
  skinTone: 'rgba(251, 191, 36, 0.5)',// amber-400
  pixel: 'rgba(34, 197, 94, 0.8)',    // green-500
};

// Standard color bar positions in Cb/Cr space (normalized 0-1)
// These are the targets for 75% color bars
const COLOR_TARGETS = [
  { name: 'Red', cb: 0.3, cr: 0.85, color: 'rgba(239, 68, 68, 0.8)' },
  { name: 'Magenta', cb: 0.15, cr: 0.7, color: 'rgba(217, 70, 239, 0.8)' },
  { name: 'Blue', cb: 0.15, cr: 0.3, color: 'rgba(59, 130, 246, 0.8)' },
  { name: 'Cyan', cb: 0.7, cr: 0.15, color: 'rgba(6, 182, 212, 0.8)' },
  { name: 'Green', cb: 0.85, cr: 0.3, color: 'rgba(34, 197, 94, 0.8)' },
  { name: 'Yellow', cb: 0.85, cr: 0.7, color: 'rgba(250, 204, 21, 0.8)' },
];

// Skin tone line angle (approximately 123 degrees from horizontal)
const SKIN_TONE_ANGLE = (123 * Math.PI) / 180;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Draws the graticule (circular grid with crosshairs).
 */
function drawGraticule(
  ctx: CanvasRenderingContext2D,
  size: number,
  centerX: number,
  centerY: number
): void {
  const radius = size / 2 - 10;
  ctx.strokeStyle = COLORS.graticule;
  ctx.lineWidth = 1;

  // Draw concentric circles (25%, 50%, 75%, 100%)
  [0.25, 0.5, 0.75, 1.0].forEach((scale) => {
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * scale, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Draw crosshairs
  ctx.beginPath();
  // Horizontal
  ctx.moveTo(centerX - radius, centerY);
  ctx.lineTo(centerX + radius, centerY);
  // Vertical
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX, centerY + radius);
  ctx.stroke();

  // Draw diagonal lines (45 degrees)
  ctx.setLineDash([2, 4]);
  const diagOffset = radius * 0.707; // cos(45) = sin(45) ≈ 0.707
  ctx.beginPath();
  ctx.moveTo(centerX - diagOffset, centerY - diagOffset);
  ctx.lineTo(centerX + diagOffset, centerY + diagOffset);
  ctx.moveTo(centerX - diagOffset, centerY + diagOffset);
  ctx.lineTo(centerX + diagOffset, centerY - diagOffset);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Draws color target markers.
 */
function drawColorTargets(
  ctx: CanvasRenderingContext2D,
  size: number,
  centerX: number,
  centerY: number
): void {
  const radius = size / 2 - 10;
  const targetSize = 8;

  COLOR_TARGETS.forEach(({ cb, cr, color }) => {
    // Convert normalized Cb/Cr (0-1) to canvas coordinates
    // Cb is horizontal (0.5 = center), Cr is vertical (0.5 = center, inverted)
    const x = centerX + (cb - 0.5) * 2 * radius;
    const y = centerY - (cr - 0.5) * 2 * radius;

    // Draw target box
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x - targetSize / 2, y - targetSize / 2, targetSize, targetSize);
  });
}

/**
 * Draws the skin tone indicator line.
 */
function drawSkinToneLine(
  ctx: CanvasRenderingContext2D,
  size: number,
  centerX: number,
  centerY: number
): void {
  const radius = size / 2 - 10;
  ctx.strokeStyle = COLORS.skinTone;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);

  ctx.beginPath();
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(
    centerX + Math.cos(SKIN_TONE_ANGLE) * radius,
    centerY - Math.sin(SKIN_TONE_ANGLE) * radius
  );
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Draws the vectorscope data points.
 */
function drawData(
  ctx: CanvasRenderingContext2D,
  data: VectorscopeData,
  size: number,
  centerX: number,
  centerY: number
): void {
  if (data.size === 0 || data.maxIntensity === 0) return;

  const radius = size / 2 - 10;
  const gridToCanvas = (2 * radius) / data.size;

  // Use image data for efficient rendering
  const imageData = ctx.getImageData(0, 0, size, size);
  const pixels = imageData.data;

  data.grid.forEach((row, gridY) => {
    row.forEach((count, gridX) => {
      if (count === 0) return;

      // Calculate intensity (logarithmic for better visibility)
      const intensity = Math.min(1, Math.log10(count + 1) / Math.log10(data.maxIntensity + 1));

      // Convert grid coordinates to canvas coordinates
      // Grid (0,0) is top-left, corresponds to Cb=-0.5, Cr=+0.5
      const canvasX = Math.floor(centerX - radius + gridX * gridToCanvas);
      const canvasY = Math.floor(centerY - radius + gridY * gridToCanvas);

      // Skip if outside canvas bounds
      if (canvasX < 0 || canvasX >= size || canvasY < 0 || canvasY >= size) return;

      // Set pixel with green tint and intensity-based alpha
      const pixelIndex = (canvasY * size + canvasX) * 4;
      const alpha = Math.floor(intensity * 200 + 55); // 55-255

      // Additive blending with existing pixel
      pixels[pixelIndex] = Math.min(255, pixels[pixelIndex] + 34 * intensity);     // R
      pixels[pixelIndex + 1] = Math.min(255, pixels[pixelIndex + 1] + 197 * intensity); // G
      pixels[pixelIndex + 2] = Math.min(255, pixels[pixelIndex + 2] + 94 * intensity);  // B
      pixels[pixelIndex + 3] = Math.max(pixels[pixelIndex + 3], alpha);             // A
    });
  });

  ctx.putImageData(imageData, 0, 0);
}

// =============================================================================
// Component
// =============================================================================

export const VectorscopeDisplay = memo(function VectorscopeDisplay({
  data,
  size = 256,
  showTargets = true,
  showSkinTone = true,
  showGraticule = true,
  className = '',
}: VectorscopeDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const centerX = size / 2;
  const centerY = size / 2;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, size, size);

    // Draw graticule first (behind data)
    if (showGraticule) {
      drawGraticule(ctx, size, centerX, centerY);
    }

    // Draw skin tone line
    if (showSkinTone) {
      drawSkinToneLine(ctx, size, centerX, centerY);
    }

    // Draw color targets
    if (showTargets) {
      drawColorTargets(ctx, size, centerX, centerY);
    }

    // Draw vectorscope data
    drawData(ctx, data, size, centerX, centerY);

    // Draw center dot
    ctx.fillStyle = COLORS.center;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 2, 0, Math.PI * 2);
    ctx.fill();
  }, [data, size, centerX, centerY, showTargets, showSkinTone, showGraticule]);

  // Render on data or settings change
  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="vectorscope-display"
      width={size}
      height={size}
      className={`rounded ${className}`}
      aria-label="Vectorscope showing color hue and saturation"
    />
  );
});

export default VectorscopeDisplay;
