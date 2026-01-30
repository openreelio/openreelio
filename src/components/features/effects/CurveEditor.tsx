/**
 * CurveEditor Component
 *
 * Visual editor for cubic Bezier easing curves used in keyframe animation.
 * Allows users to drag control points or use presets to customize easing.
 */

import { useCallback, useRef, useEffect, memo } from 'react';
import { Copy } from 'lucide-react';
import type { BezierControlPoints } from '@/types';
import { BEZIER_PRESETS, evaluateCubicBezier, type BezierPoints } from '@/utils/bezierCurve';

// =============================================================================
// Types
// =============================================================================

export interface CurveEditorProps {
  /** Current Bezier control points [x1, y1, x2, y2] */
  points: BezierControlPoints;
  /** Callback when control points change */
  onChange: (points: BezierControlPoints) => void;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Width of the curve canvas */
  width?: number;
  /** Height of the curve canvas */
  height?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 200;
const PADDING = 20;
const HANDLE_RADIUS = 8;
const CURVE_SAMPLES = 100;

const PRESET_BUTTONS = [
  { name: 'Linear', points: BEZIER_PRESETS.linear },
  { name: 'Ease', points: BEZIER_PRESETS.ease },
  { name: 'Ease-In', points: BEZIER_PRESETS.easeIn },
  { name: 'Ease-Out', points: BEZIER_PRESETS.easeOut },
  { name: 'Ease-In-Out', points: BEZIER_PRESETS.easeInOut },
] as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert normalized coordinates (0-1) to canvas coordinates
 */
function toCanvasCoords(
  x: number,
  y: number,
  width: number,
  height: number,
  padding: number
): { cx: number; cy: number } {
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  return {
    cx: padding + x * innerWidth,
    cy: padding + (1 - y) * innerHeight, // Flip Y axis
  };
}

/**
 * Convert canvas coordinates to normalized coordinates (0-1)
 */
function toNormalizedCoords(
  cx: number,
  cy: number,
  width: number,
  height: number,
  padding: number
): { x: number; y: number } {
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  return {
    x: (cx - padding) / innerWidth,
    y: 1 - (cy - padding) / innerHeight, // Flip Y axis
  };
}

/**
 * Clamp a value to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// =============================================================================
// Component
// =============================================================================

export const CurveEditor = memo(function CurveEditor({
  points,
  onChange,
  readOnly = false,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: CurveEditorProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef<'p1' | 'p2' | null>(null);

  const [x1, y1, x2, y2] = points;

  // -------------------------------------------------------------------------
  // Canvas Drawing
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.beginPath !== 'function') return;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw background grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;

    // Vertical and horizontal grid lines
    const gridLines = 4;
    const innerWidth = width - PADDING * 2;
    const innerHeight = height - PADDING * 2;

    for (let i = 0; i <= gridLines; i++) {
      const x = PADDING + (i / gridLines) * innerWidth;
      const y = PADDING + (i / gridLines) * innerHeight;

      ctx.beginPath();
      ctx.moveTo(x, PADDING);
      ctx.lineTo(x, height - PADDING);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(PADDING, y);
      ctx.lineTo(width - PADDING, y);
      ctx.stroke();
    }

    // Draw diagonal (linear reference)
    ctx.strokeStyle = '#555';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PADDING, height - PADDING);
    ctx.lineTo(width - PADDING, PADDING);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw control point handles to curve endpoints
    const p0 = toCanvasCoords(0, 0, width, height, PADDING);
    const p1 = toCanvasCoords(x1, y1, width, height, PADDING);
    const p2 = toCanvasCoords(x2, y2, width, height, PADDING);
    const p3 = toCanvasCoords(1, 1, width, height, PADDING);

    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p0.cx, p0.cy);
    ctx.lineTo(p1.cx, p1.cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(p3.cx, p3.cy);
    ctx.lineTo(p2.cx, p2.cy);
    ctx.stroke();

    // Draw the Bezier curve
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const start = toCanvasCoords(0, 0, width, height, PADDING);
    ctx.moveTo(start.cx, start.cy);

    for (let i = 1; i <= CURVE_SAMPLES; i++) {
      const t = i / CURVE_SAMPLES;
      const y = evaluateCubicBezier(t, points as BezierPoints);
      const pos = toCanvasCoords(t, y, width, height, PADDING);
      ctx.lineTo(pos.cx, pos.cy);
    }
    ctx.stroke();

    // Draw control point handles
    const drawHandle = (cx: number, cy: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    // Draw endpoint markers
    ctx.fillStyle = '#999';
    ctx.beginPath();
    ctx.arc(p0.cx, p0.cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p3.cx, p3.cy, 4, 0, Math.PI * 2);
    ctx.fill();

    // Draw control points
    drawHandle(p1.cx, p1.cy, '#ef4444');
    drawHandle(p2.cx, p2.cy, '#22c55e');
  }, [points, width, height, x1, y1, x2, y2]);

  // -------------------------------------------------------------------------
  // Mouse Interaction
  // -------------------------------------------------------------------------

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (readOnly) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const p1 = toCanvasCoords(x1, y1, width, height, PADDING);
      const p2 = toCanvasCoords(x2, y2, width, height, PADDING);

      // Check if clicking on P1
      const dist1 = Math.sqrt((cx - p1.cx) ** 2 + (cy - p1.cy) ** 2);
      if (dist1 <= HANDLE_RADIUS) {
        draggingRef.current = 'p1';
        return;
      }

      // Check if clicking on P2
      const dist2 = Math.sqrt((cx - p2.cx) ** 2 + (cy - p2.cy) ** 2);
      if (dist2 <= HANDLE_RADIUS) {
        draggingRef.current = 'p2';
        return;
      }
    },
    [readOnly, x1, y1, x2, y2, width, height]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (readOnly || !draggingRef.current) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const { x, y } = toNormalizedCoords(cx, cy, width, height, PADDING);

      // Clamp x to [0, 1], allow y to go outside for overshoot
      const clampedX = clamp(x, 0, 1);
      const clampedY = clamp(y, -0.5, 1.5);

      if (draggingRef.current === 'p1') {
        onChange([clampedX, clampedY, x2, y2]);
      } else if (draggingRef.current === 'p2') {
        onChange([x1, y1, clampedX, clampedY]);
      }
    },
    [readOnly, x1, y1, x2, y2, width, height, onChange]
  );

  const handleMouseUp = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const handleMouseLeave = useCallback(() => {
    draggingRef.current = null;
  }, []);

  // -------------------------------------------------------------------------
  // Input Handlers
  // -------------------------------------------------------------------------

  const handleInputChange = useCallback(
    (index: number, value: string) => {
      const num = parseFloat(value);
      if (Number.isNaN(num)) return;

      const newPoints: BezierControlPoints = [...points];

      // Clamp x values (index 0 and 2) to [0, 1]
      if (index === 0 || index === 2) {
        newPoints[index] = clamp(num, 0, 1);
      } else {
        // Allow y values outside 0-1 for overshoot
        newPoints[index] = num;
      }

      onChange(newPoints);
    },
    [points, onChange]
  );

  const handlePresetClick = useCallback(
    (presetPoints: readonly [number, number, number, number]) => {
      onChange([...presetPoints]);
    },
    [onChange]
  );

  const handleCopyClick = useCallback(async () => {
    const cssValue = `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
    try {
      await navigator.clipboard.writeText(cssValue);
    } catch {
      // Clipboard API not available
    }
  }, [x1, y1, x2, y2]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-3">
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        role="img"
        aria-label="Bezier curve editor"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        className={`bg-editor-bg border border-editor-border rounded ${
          readOnly ? 'cursor-default' : 'cursor-crosshair'
        }`}
      />

      {/* Control Point Handles for accessibility */}
      <div className="sr-only">
        <input
          type="range"
          aria-label="Control point P1"
          value={x1}
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => handleInputChange(0, e.target.value)}
          disabled={readOnly}
        />
        <input
          type="range"
          aria-label="Control point P2"
          value={x2}
          min={0}
          max={1}
          step={0.01}
          onChange={(e) => handleInputChange(2, e.target.value)}
          disabled={readOnly}
        />
      </div>

      {/* Numeric Inputs */}
      <div className="grid grid-cols-4 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="bezier-x1" className="text-xs text-editor-text-muted">
            X1
          </label>
          <input
            id="bezier-x1"
            type="number"
            value={x1}
            min={0}
            max={1}
            step={0.01}
            onChange={(e) => handleInputChange(0, e.target.value)}
            disabled={readOnly}
            className="w-full px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bezier-y1" className="text-xs text-editor-text-muted">
            Y1
          </label>
          <input
            id="bezier-y1"
            type="number"
            value={y1}
            min={-0.5}
            max={1.5}
            step={0.01}
            onChange={(e) => handleInputChange(1, e.target.value)}
            disabled={readOnly}
            className="w-full px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bezier-x2" className="text-xs text-editor-text-muted">
            X2
          </label>
          <input
            id="bezier-x2"
            type="number"
            value={x2}
            min={0}
            max={1}
            step={0.01}
            onChange={(e) => handleInputChange(2, e.target.value)}
            disabled={readOnly}
            className="w-full px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bezier-y2" className="text-xs text-editor-text-muted">
            Y2
          </label>
          <input
            id="bezier-y2"
            type="number"
            value={y2}
            min={-0.5}
            max={1.5}
            step={0.01}
            onChange={(e) => handleInputChange(3, e.target.value)}
            disabled={readOnly}
            className="w-full px-2 py-1 text-sm bg-editor-bg border border-editor-border rounded text-editor-text disabled:opacity-50"
          />
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {PRESET_BUTTONS.map(({ name, points: presetPoints }) => (
          <button
            key={name}
            onClick={() => handlePresetClick(presetPoints)}
            disabled={readOnly}
            className="px-2 py-1 text-xs bg-editor-bg border border-editor-border rounded text-editor-text hover:bg-editor-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {name}
          </button>
        ))}
        <button
          onClick={handleCopyClick}
          disabled={readOnly}
          className="px-2 py-1 text-xs bg-editor-bg border border-editor-border rounded text-editor-text hover:bg-editor-border disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          aria-label="Copy CSS value"
        >
          <Copy className="w-3 h-3" />
          Copy
        </button>
      </div>
    </div>
  );
});
