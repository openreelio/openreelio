/**
 * ColorWheelControl Component
 *
 * A single color wheel control for Lift/Gamma/Gain adjustment.
 * Features:
 * - Circular color selector
 * - Luminance slider
 * - Visual feedback with gradient background
 * - Reset button
 *
 * @module components/features/colorGrading/ColorWheelControl
 */

import React, { useRef, useCallback, useEffect, useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  type ColorOffset,
  colorOffsetToCartesian,
  cartesianToColorOffset,
  clampToCircle,
} from '@/utils/colorWheel';

// =============================================================================
// Types
// =============================================================================

export interface ColorWheelControlProps {
  /** Label for this wheel (e.g., "Lift", "Gamma", "Gain") */
  label: string;
  /** Current color offset value */
  value: ColorOffset;
  /** Current luminance value (-1 to 1) */
  luminance: number;
  /** Called when color offset changes */
  onChange: (value: ColorOffset) => void;
  /** Called when luminance changes */
  onLuminanceChange: (value: number) => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const SIZES = {
  sm: { canvas: 100, handle: 8, stroke: 2 },
  md: { canvas: 150, handle: 10, stroke: 2 },
  lg: { canvas: 200, handle: 12, stroke: 3 },
};

// =============================================================================
// Component
// =============================================================================

export function ColorWheelControl({
  label,
  value,
  luminance,
  onChange,
  onLuminanceChange,
  size = 'md',
  disabled = false,
  className = '',
}: ColorWheelControlProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDraggingRef = useRef(false);
  const sizeConfig = SIZES[size];
  const radius = sizeConfig.canvas / 2;

  // Calculate handle position from current value
  const handlePosition = useMemo(() => {
    const cart = colorOffsetToCartesian(value);
    // Scale from -1..1 to canvas coordinates
    return {
      x: radius + cart.x * (radius - sizeConfig.handle),
      y: radius + cart.y * (radius - sizeConfig.handle),
    };
  }, [value, radius, sizeConfig.handle]);

  // Check if handle is at center
  const isCentered = useMemo(() => {
    return value.r === 0 && value.g === 0 && value.b === 0;
  }, [value]);

  // Draw the color wheel
  const drawWheel = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Skip drawing if canvas methods are not available (test environment)
    if (typeof ctx.beginPath !== 'function') return;

    const centerX = radius;
    const centerY = radius;
    const wheelRadius = radius - sizeConfig.handle - 2;

    // Clear canvas
    ctx.clearRect(0, 0, sizeConfig.canvas, sizeConfig.canvas);

    // Check if createRadialGradient is supported (not in JSDOM)
    if (typeof ctx.createRadialGradient === 'function') {
      // Draw color wheel using HSL gradient
      for (let angle = 0; angle < 360; angle++) {
        const startAngle = ((angle - 0.5) * Math.PI) / 180;
        const endAngle = ((angle + 0.5) * Math.PI) / 180;

        const gradient = ctx.createRadialGradient(
          centerX,
          centerY,
          0,
          centerX,
          centerY,
          wheelRadius
        );

        // Center is gray, edge is saturated color
        gradient.addColorStop(0, 'hsl(0, 0%, 50%)');
        gradient.addColorStop(1, `hsl(${angle}, 100%, 50%)`);

        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, wheelRadius, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    } else {
      // Fallback for limited canvas support - just fill with gray
      ctx.beginPath();
      ctx.arc(centerX, centerY, wheelRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#808080';
      ctx.fill();
    }

    // Draw outer ring
    ctx.beginPath();
    ctx.arc(centerX, centerY, wheelRadius, 0, Math.PI * 2);
    ctx.strokeStyle = disabled ? '#666' : '#888';
    ctx.lineWidth = sizeConfig.stroke;
    ctx.stroke();

    // Draw center crosshair
    ctx.beginPath();
    ctx.moveTo(centerX - 5, centerY);
    ctx.lineTo(centerX + 5, centerY);
    ctx.moveTo(centerX, centerY - 5);
    ctx.lineTo(centerX, centerY + 5);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [radius, sizeConfig, disabled]);

  // Draw wheel on mount and when dependencies change
  useEffect(() => {
    drawWheel();
  }, [drawWheel]);

  // Handle mouse/touch interaction
  const handleInteraction = useCallback(
    (clientX: number, clientY: number) => {
      if (disabled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left - radius;
      const y = clientY - rect.top - radius;

      // Normalize to -1..1 range and clamp to circle
      const normalizedX = x / (radius - sizeConfig.handle);
      const normalizedY = y / (radius - sizeConfig.handle);
      const clamped = clampToCircle(normalizedX, normalizedY, 1);

      // Convert to color offset
      const offset = cartesianToColorOffset(clamped.x, clamped.y);
      onChange(offset);
    },
    [disabled, radius, sizeConfig.handle, onChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      isDraggingRef.current = true;
      handleInteraction(e.clientX, e.clientY);
    },
    [disabled, handleInteraction]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      handleInteraction(e.clientX, e.clientY);
    },
    [handleInteraction]
  );

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  // Add global mouse listeners for dragging
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // Handle reset
  const handleReset = useCallback(() => {
    onChange({ r: 0, g: 0, b: 0 });
    onLuminanceChange(0);
  }, [onChange, onLuminanceChange]);

  // Handle luminance slider change
  const handleLuminanceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onLuminanceChange(parseFloat(e.target.value));
    },
    [onLuminanceChange]
  );

  return (
    <div
      data-testid="color-wheel-container"
      className={`flex flex-col items-center gap-2 ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {/* Label */}
      <div className="flex items-center justify-between w-full">
        <span className="text-sm font-medium text-zinc-300">{label}</span>
        <button
          type="button"
          onClick={handleReset}
          className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label="Reset color wheel"
          disabled={disabled}
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Wheel canvas with handle overlay */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          data-testid="color-wheel-canvas"
          width={sizeConfig.canvas}
          height={sizeConfig.canvas}
          className={`rounded-full ${disabled ? 'cursor-not-allowed' : 'cursor-crosshair'}`}
          aria-label={`${label} color wheel`}
          onMouseDown={handleMouseDown}
        />

        {/* Handle indicator */}
        <div
          data-testid="color-wheel-handle"
          data-centered={isCentered}
          className="absolute pointer-events-none"
          style={{
            left: handlePosition.x - sizeConfig.handle / 2,
            top: handlePosition.y - sizeConfig.handle / 2,
            width: sizeConfig.handle,
            height: sizeConfig.handle,
          }}
        >
          <div
            className="w-full h-full rounded-full border-2 border-white shadow-lg"
            style={{
              backgroundColor: isCentered
                ? 'rgba(128, 128, 128, 0.8)'
                : 'rgba(255, 255, 255, 0.9)',
              boxShadow: '0 0 4px rgba(0, 0, 0, 0.5)',
            }}
          />
        </div>
      </div>

      {/* Luminance slider */}
      <div className="w-full flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-4">-</span>
        <input
          type="range"
          min="-1"
          max="1"
          step="0.01"
          value={luminance}
          onChange={handleLuminanceChange}
          className="flex-1 h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
          aria-label={`${label} luminance`}
          disabled={disabled}
        />
        <span className="text-xs text-zinc-500 w-4">+</span>
      </div>

      {/* Luminance value display */}
      <span className="text-xs text-zinc-500">
        {luminance >= 0 ? '+' : ''}
        {(luminance * 100).toFixed(0)}%
      </span>
    </div>
  );
}

export default ColorWheelControl;
