/**
 * ColorCurvesPanel Component
 *
 * Canvas-based color curves editor for precise color correction.
 * Supports RGB channels (Master, R, G, B) and advanced curves
 * (Hue vs Hue, Hue vs Sat, Luma vs Sat) with interactive control
 * points (click to add, drag to move, right-click to delete).
 *
 * Advanced curves display hue spectrum or luminance gradients on the
 * X-axis and use a horizontal center reference line (y=0.5 = no change).
 */

import { memo, useRef, useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { SimpleParamValue } from '@/types';
import {
  useColorCurves,
  drawColorCurve,
  getDrawMode,
  CHANNEL_COLORS,
  RGB_CHANNEL_LABELS,
  ADVANCED_CHANNEL_LABELS,
} from '@/hooks/useColorCurves';

// =============================================================================
// Constants
// =============================================================================

const CANVAS_SIZE = 256;
const HIT_RADIUS = 10;

// =============================================================================
// Props
// =============================================================================

export interface ColorCurvesPanelProps {
  params: Record<string, SimpleParamValue>;
  onChange: (paramName: string, value: SimpleParamValue) => void;
  readOnly?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const ColorCurvesPanel = memo(function ColorCurvesPanel({
  params,
  onChange,
  readOnly = false,
}: ColorCurvesPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const {
    activeChannel,
    setActiveChannel,
    activePoints,
    addPoint,
    movePoint,
    deletePoint,
    resetChannel,
  } = useColorCurves({ params, onChange });

  const drawMode = getDrawMode(activeChannel);

  // Redraw canvas when curve data or drag state changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawColorCurve(
      ctx,
      CANVAS_SIZE,
      activePoints,
      CHANNEL_COLORS[activeChannel],
      draggingIndex,
      drawMode
    );
  }, [activePoints, activeChannel, draggingIndex, drawMode]);

  const getCanvasCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * CANVAS_SIZE,
        y: ((e.clientY - rect.top) / rect.height) * CANVAS_SIZE,
      };
    },
    []
  );

  const findPointAt = useCallback(
    (cx: number, cy: number): number | null => {
      for (let i = 0; i < activePoints.length; i++) {
        const px = activePoints[i].x * CANVAS_SIZE;
        const py = (1 - activePoints[i].y) * CANVAS_SIZE;
        if (Math.sqrt((cx - px) ** 2 + (cy - py) ** 2) <= HIT_RADIUS) return i;
      }
      return null;
    },
    [activePoints]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (readOnly) return;
      e.preventDefault();
      const { x, y } = getCanvasCoords(e);
      const idx = findPointAt(x, y);
      if (idx !== null) {
        setDraggingIndex(idx);
      } else {
        addPoint(x / CANVAS_SIZE, 1 - y / CANVAS_SIZE);
      }
    },
    [readOnly, getCanvasCoords, findPointAt, addPoint]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (draggingIndex === null || readOnly) return;
      const { x, y } = getCanvasCoords(e);
      movePoint(draggingIndex, x / CANVAS_SIZE, 1 - y / CANVAS_SIZE);
    },
    [draggingIndex, readOnly, getCanvasCoords, movePoint]
  );

  const handleMouseUp = useCallback(() => setDraggingIndex(null), []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (readOnly) return;
      e.preventDefault();
      const { x, y } = getCanvasCoords(e);
      const idx = findPointAt(x, y);
      if (idx !== null) deletePoint(idx);
    },
    [readOnly, getCanvasCoords, findPointAt, deletePoint]
  );

  return (
    <div className="space-y-2" data-testid="color-curves-panel">
      {/* Channel Tabs: RGB group */}
      <div className="flex gap-1 flex-wrap">
        {RGB_CHANNEL_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveChannel(key)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              activeChannel === key
                ? 'bg-primary-600 text-white'
                : 'bg-editor-surface text-editor-text-muted hover:text-editor-text'
            }`}
            aria-label={`${label} channel`}
            data-testid={`channel-tab-${key}`}
          >
            {label}
          </button>
        ))}
        {/* Separator */}
        <div className="w-px bg-editor-border mx-0.5" data-testid="channel-separator" />
        {/* Advanced curve tabs */}
        {ADVANCED_CHANNEL_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveChannel(key)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              activeChannel === key
                ? 'bg-primary-600 text-white'
                : 'bg-editor-surface text-editor-text-muted hover:text-editor-text'
            }`}
            aria-label={`${label} curve`}
            data-testid={`channel-tab-${key}`}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={resetChannel}
          disabled={readOnly}
          className="p-1 text-editor-text-muted hover:text-editor-text rounded transition-colors disabled:opacity-50"
          aria-label="Reset channel"
          title="Reset channel"
          data-testid="reset-channel-btn"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Curve Canvas */}
      <canvas
        ref={canvasRef}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="w-full aspect-square rounded border border-editor-border cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        data-testid="color-curves-canvas"
        aria-label={`${activeChannel} curve editor`}
      />

      {/* Point info */}
      <div className="flex justify-between text-xs text-editor-text-muted px-1">
        <span data-testid="point-count">Points: {activePoints.length}</span>
        <span>Right-click to delete</span>
      </div>
    </div>
  );
});

export default ColorCurvesPanel;
