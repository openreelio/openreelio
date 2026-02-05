/**
 * MaskCanvas Component
 *
 * SVG-based canvas for drawing and editing masks.
 * Supports rectangle, ellipse, polygon, and bezier shapes.
 *
 * @module components/features/masks/MaskCanvas
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Mask, MaskId, MaskShape, Point2D } from '@/types';
import type { MaskTool } from '@/hooks/useMaskEditor';

// =============================================================================
// Types
// =============================================================================

export interface MaskCanvasProps {
  /** List of masks to render */
  masks: Mask[];
  /** Currently selected mask ID */
  selectedMaskId: MaskId | null;
  /** Active drawing tool */
  activeTool: MaskTool;
  /** Canvas width in pixels */
  width?: number;
  /** Canvas height in pixels */
  height?: number;
  /** Called when a mask is selected */
  onMaskSelect: (id: MaskId | null) => void;
  /** Called when a mask is updated (after transform) */
  onMaskUpdate: (id: MaskId, updates: Partial<Mask>) => void;
  /** Called when a new mask is created */
  onMaskCreate: (shape: MaskShape) => void;
  /** Called when a mask should be deleted */
  onMaskDelete?: (id: MaskId) => void;
  /** Whether interactions are disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
}

interface DrawState {
  isDrawing: boolean;
  startPoint: Point2D | null;
  currentPoint: Point2D | null;
}

interface DragState {
  isDragging: boolean;
  maskId: MaskId | null;
  startPoint: Point2D | null;
  originalShape: MaskShape | null;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;

const MASK_STROKE_COLOR = '#3b82f6'; // blue-500
const MASK_FILL_COLOR = 'rgba(59, 130, 246, 0.2)';
const SELECTED_STROKE_COLOR = '#f97316'; // orange-500
const HANDLE_SIZE = 8;
const MIN_SHAPE_SIZE = 10; // Minimum size in pixels to create a mask

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Converts normalized coordinates (0-1) to pixel coordinates.
 */
function toPixels(normalized: number, dimension: number): number {
  return normalized * dimension;
}

/**
 * Converts pixel coordinates to normalized coordinates (0-1).
 */
function toNormalized(pixels: number, dimension: number): number {
  return Math.max(0, Math.min(1, pixels / dimension));
}

/**
 * Gets mouse position relative to SVG element.
 */
function getMousePosition(
  event: React.MouseEvent | MouseEvent,
  svg: SVGSVGElement
): Point2D {
  const rect = svg.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

// =============================================================================
// Shape Renderers
// =============================================================================

interface ShapeRendererProps {
  mask: Mask;
  width: number;
  height: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

function RectangleShape({
  mask,
  width,
  height,
  isSelected,
  onClick,
  onMouseDown,
}: ShapeRendererProps) {
  const shape = mask.shape as Extract<MaskShape, { type: 'rectangle' }>;
  const centerX = toPixels(shape.x, width);
  const centerY = toPixels(shape.y, height);
  const rectWidth = toPixels(shape.width, width);
  const rectHeight = toPixels(shape.height, height);

  return (
    <rect
      data-testid={`mask-shape-${mask.id}`}
      className={`mask-shape ${isSelected ? 'selected' : ''} ${!mask.enabled ? 'disabled' : ''}`}
      x={centerX - rectWidth / 2}
      y={centerY - rectHeight / 2}
      width={rectWidth}
      height={rectHeight}
      rx={shape.cornerRadius * Math.min(rectWidth, rectHeight) / 2}
      transform={`rotate(${shape.rotation} ${centerX} ${centerY})`}
      fill={MASK_FILL_COLOR}
      stroke={isSelected ? SELECTED_STROKE_COLOR : MASK_STROKE_COLOR}
      strokeWidth={isSelected ? 2 : 1}
      style={{ opacity: mask.enabled ? mask.opacity : 0.3 }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    />
  );
}

function EllipseShape({
  mask,
  width,
  height,
  isSelected,
  onClick,
  onMouseDown,
}: ShapeRendererProps) {
  const shape = mask.shape as Extract<MaskShape, { type: 'ellipse' }>;
  const cx = toPixels(shape.x, width);
  const cy = toPixels(shape.y, height);
  const rx = toPixels(shape.radiusX, width);
  const ry = toPixels(shape.radiusY, height);

  return (
    <ellipse
      data-testid={`mask-shape-${mask.id}`}
      className={`mask-shape ${isSelected ? 'selected' : ''} ${!mask.enabled ? 'disabled' : ''}`}
      cx={cx}
      cy={cy}
      rx={rx}
      ry={ry}
      transform={`rotate(${shape.rotation} ${cx} ${cy})`}
      fill={MASK_FILL_COLOR}
      stroke={isSelected ? SELECTED_STROKE_COLOR : MASK_STROKE_COLOR}
      strokeWidth={isSelected ? 2 : 1}
      style={{ opacity: mask.enabled ? mask.opacity : 0.3 }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    />
  );
}

function PolygonShape({
  mask,
  width,
  height,
  isSelected,
  onClick,
  onMouseDown,
}: ShapeRendererProps) {
  const shape = mask.shape as Extract<MaskShape, { type: 'polygon' }>;
  const points = shape.points
    .map((p) => `${toPixels(p.x, width)},${toPixels(p.y, height)}`)
    .join(' ');

  return (
    <polygon
      data-testid={`mask-shape-${mask.id}`}
      className={`mask-shape ${isSelected ? 'selected' : ''} ${!mask.enabled ? 'disabled' : ''}`}
      points={points}
      fill={MASK_FILL_COLOR}
      stroke={isSelected ? SELECTED_STROKE_COLOR : MASK_STROKE_COLOR}
      strokeWidth={isSelected ? 2 : 1}
      style={{ opacity: mask.enabled ? mask.opacity : 0.3 }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    />
  );
}

function BezierShape({
  mask,
  width,
  height,
  isSelected,
  onClick,
  onMouseDown,
}: ShapeRendererProps) {
  const shape = mask.shape as Extract<MaskShape, { type: 'bezier' }>;

  // Build SVG path from bezier points
  const pathData = useMemo(() => {
    if (shape.points.length === 0) return '';

    const points = shape.points.map((p) => ({
      anchor: {
        x: toPixels(p.anchor.x, width),
        y: toPixels(p.anchor.y, height),
      },
      handleIn: p.handleIn
        ? { x: toPixels(p.handleIn.x, width), y: toPixels(p.handleIn.y, height) }
        : null,
      handleOut: p.handleOut
        ? { x: toPixels(p.handleOut.x, width), y: toPixels(p.handleOut.y, height) }
        : null,
    }));

    let d = `M ${points[0].anchor.x},${points[0].anchor.y}`;

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];

      if (prev.handleOut && curr.handleIn) {
        // Cubic bezier
        d += ` C ${prev.handleOut.x},${prev.handleOut.y} ${curr.handleIn.x},${curr.handleIn.y} ${curr.anchor.x},${curr.anchor.y}`;
      } else if (prev.handleOut) {
        // Quadratic from prev
        d += ` Q ${prev.handleOut.x},${prev.handleOut.y} ${curr.anchor.x},${curr.anchor.y}`;
      } else if (curr.handleIn) {
        // Quadratic to curr
        d += ` Q ${curr.handleIn.x},${curr.handleIn.y} ${curr.anchor.x},${curr.anchor.y}`;
      } else {
        // Line
        d += ` L ${curr.anchor.x},${curr.anchor.y}`;
      }
    }

    if (shape.closed) {
      d += ' Z';
    }

    return d;
  }, [shape.points, shape.closed, width, height]);

  return (
    <path
      data-testid={`mask-shape-${mask.id}`}
      className={`mask-shape ${isSelected ? 'selected' : ''} ${!mask.enabled ? 'disabled' : ''}`}
      d={pathData}
      fill={shape.closed ? MASK_FILL_COLOR : 'none'}
      stroke={isSelected ? SELECTED_STROKE_COLOR : MASK_STROKE_COLOR}
      strokeWidth={isSelected ? 2 : 1}
      style={{ opacity: mask.enabled ? mask.opacity : 0.3 }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    />
  );
}

// =============================================================================
// Selection Handles
// =============================================================================

interface SelectionHandlesProps {
  mask: Mask;
  width: number;
  height: number;
}

function SelectionHandles({ mask, width, height }: SelectionHandlesProps) {
  if (mask.shape.type !== 'rectangle' && mask.shape.type !== 'ellipse') {
    return null; // Only render handles for simple shapes for now
  }

  const shape = mask.shape;
  let handles: Array<{ id: string; x: number; y: number }> = [];

  if (shape.type === 'rectangle') {
    const centerX = toPixels(shape.x, width);
    const centerY = toPixels(shape.y, height);
    const rectWidth = toPixels(shape.width, width);
    const rectHeight = toPixels(shape.height, height);

    handles = [
      { id: 'nw', x: centerX - rectWidth / 2, y: centerY - rectHeight / 2 },
      { id: 'n', x: centerX, y: centerY - rectHeight / 2 },
      { id: 'ne', x: centerX + rectWidth / 2, y: centerY - rectHeight / 2 },
      { id: 'e', x: centerX + rectWidth / 2, y: centerY },
      { id: 'se', x: centerX + rectWidth / 2, y: centerY + rectHeight / 2 },
      { id: 's', x: centerX, y: centerY + rectHeight / 2 },
      { id: 'sw', x: centerX - rectWidth / 2, y: centerY + rectHeight / 2 },
      { id: 'w', x: centerX - rectWidth / 2, y: centerY },
    ];
  } else if (shape.type === 'ellipse') {
    const cx = toPixels(shape.x, width);
    const cy = toPixels(shape.y, height);
    const rx = toPixels(shape.radiusX, width);
    const ry = toPixels(shape.radiusY, height);

    handles = [
      { id: 'n', x: cx, y: cy - ry },
      { id: 'e', x: cx + rx, y: cy },
      { id: 's', x: cx, y: cy + ry },
      { id: 'w', x: cx - rx, y: cy },
    ];
  }

  return (
    <g className="selection-handles">
      {handles.map((handle) => (
        <rect
          key={handle.id}
          data-testid={`handle-${handle.id}`}
          x={handle.x - HANDLE_SIZE / 2}
          y={handle.y - HANDLE_SIZE / 2}
          width={HANDLE_SIZE}
          height={HANDLE_SIZE}
          fill="white"
          stroke={SELECTED_STROKE_COLOR}
          strokeWidth={1}
          style={{ cursor: 'pointer' }}
        />
      ))}
    </g>
  );
}

// =============================================================================
// Drawing Preview
// =============================================================================

interface DrawingPreviewProps {
  tool: MaskTool;
  startPoint: Point2D;
  currentPoint: Point2D;
}

function DrawingPreview({ tool, startPoint, currentPoint }: DrawingPreviewProps) {
  const x = Math.min(startPoint.x, currentPoint.x);
  const y = Math.min(startPoint.y, currentPoint.y);
  const w = Math.abs(currentPoint.x - startPoint.x);
  const h = Math.abs(currentPoint.y - startPoint.y);

  if (tool === 'rectangle') {
    return (
      <rect
        data-testid="drawing-preview"
        x={x}
        y={y}
        width={w}
        height={h}
        fill="rgba(59, 130, 246, 0.1)"
        stroke={MASK_STROKE_COLOR}
        strokeWidth={1}
        strokeDasharray="4 2"
      />
    );
  }

  if (tool === 'ellipse') {
    const cx = (startPoint.x + currentPoint.x) / 2;
    const cy = (startPoint.y + currentPoint.y) / 2;
    const rx = w / 2;
    const ry = h / 2;

    return (
      <ellipse
        data-testid="drawing-preview"
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill="rgba(59, 130, 246, 0.1)"
        stroke={MASK_STROKE_COLOR}
        strokeWidth={1}
        strokeDasharray="4 2"
      />
    );
  }

  return null;
}

// =============================================================================
// Main Component
// =============================================================================

export function MaskCanvas({
  masks,
  selectedMaskId,
  activeTool,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  onMaskSelect,
  onMaskUpdate,
  onMaskCreate,
  onMaskDelete,
  disabled = false,
  className = '',
}: MaskCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Drawing state
  const [drawState, setDrawState] = useState<DrawState>({
    isDrawing: false,
    startPoint: null,
    currentPoint: null,
  });

  // Drag state
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    maskId: null,
    startPoint: null,
    originalShape: null,
  });

  // Refs for callback stability in global event listeners
  const drawStateRef = useRef(drawState);
  const dragStateRef = useRef(dragState);
  const onMaskUpdateRef = useRef(onMaskUpdate);
  const onMaskCreateRef = useRef(onMaskCreate);

  // Keep refs in sync with current values
  useEffect(() => {
    drawStateRef.current = drawState;
  }, [drawState]);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    onMaskUpdateRef.current = onMaskUpdate;
  }, [onMaskUpdate]);

  useEffect(() => {
    onMaskCreateRef.current = onMaskCreate;
  }, [onMaskCreate]);

  // Determine cursor based on tool
  const getCursorClass = useCallback(() => {
    if (disabled) return 'cursor-not-allowed';
    if (activeTool === 'select') return 'cursor-default';
    return 'cursor-crosshair';
  }, [activeTool, disabled]);

  // Handle canvas mouse down (start drawing)
  const handleCanvasMouseDown = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (disabled || !svgRef.current) return;

      // Don't start drawing in select mode
      if (activeTool === 'select') return;

      const pos = getMousePosition(event, svgRef.current);
      setDrawState({
        isDrawing: true,
        startPoint: pos,
        currentPoint: pos,
      });
    },
    [disabled, activeTool]
  );

  // Handle canvas mouse move (update drawing/drag)
  // Uses refs to avoid stale closures in global event listeners
  const handleCanvasMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!svgRef.current) return;
      const pos = getMousePosition(event, svgRef.current);

      const currentDrawState = drawStateRef.current;
      const currentDragState = dragStateRef.current;

      // Update drawing preview
      if (currentDrawState.isDrawing) {
        setDrawState((prev) => ({ ...prev, currentPoint: pos }));
      }

      // Update drag position
      if (currentDragState.isDragging && currentDragState.maskId && currentDragState.startPoint && currentDragState.originalShape) {
        const mask = masks.find((m) => m.id === currentDragState.maskId);
        if (!mask || mask.locked) return;

        const dx = toNormalized(pos.x, width) - toNormalized(currentDragState.startPoint.x, width);
        const dy = toNormalized(pos.y, height) - toNormalized(currentDragState.startPoint.y, height);

        let updatedShape: MaskShape;

        if (currentDragState.originalShape.type === 'rectangle') {
          updatedShape = {
            ...currentDragState.originalShape,
            x: currentDragState.originalShape.x + dx,
            y: currentDragState.originalShape.y + dy,
          };
        } else if (currentDragState.originalShape.type === 'ellipse') {
          updatedShape = {
            ...currentDragState.originalShape,
            x: currentDragState.originalShape.x + dx,
            y: currentDragState.originalShape.y + dy,
          };
        } else {
          updatedShape = currentDragState.originalShape;
        }

        onMaskUpdateRef.current(currentDragState.maskId, { shape: updatedShape });
      }
    },
    [masks, width, height] // Reduced dependencies - using refs for volatile state
  );

  // Handle canvas mouse up (finish drawing/drag)
  // Uses refs to avoid stale closures in global event listeners
  const handleCanvasMouseUp = useCallback(
    () => {
      if (!svgRef.current) return;

      const currentDrawState = drawStateRef.current;
      const currentDragState = dragStateRef.current;

      // Finish drawing
      if (currentDrawState.isDrawing && currentDrawState.startPoint && currentDrawState.currentPoint) {
        const w = Math.abs(currentDrawState.currentPoint.x - currentDrawState.startPoint.x);
        const h = Math.abs(currentDrawState.currentPoint.y - currentDrawState.startPoint.y);

        // Only create mask if it's large enough
        if (w >= MIN_SHAPE_SIZE && h >= MIN_SHAPE_SIZE) {
          const minX = Math.min(currentDrawState.startPoint.x, currentDrawState.currentPoint.x);
          const minY = Math.min(currentDrawState.startPoint.y, currentDrawState.currentPoint.y);

          if (activeTool === 'rectangle') {
            const shape: MaskShape = {
              type: 'rectangle',
              x: toNormalized(minX + w / 2, width),
              y: toNormalized(minY + h / 2, height),
              width: toNormalized(w, width),
              height: toNormalized(h, height),
              cornerRadius: 0,
              rotation: 0,
            };
            onMaskCreateRef.current(shape);
          } else if (activeTool === 'ellipse') {
            const shape: MaskShape = {
              type: 'ellipse',
              x: toNormalized(minX + w / 2, width),
              y: toNormalized(minY + h / 2, height),
              radiusX: toNormalized(w / 2, width),
              radiusY: toNormalized(h / 2, height),
              rotation: 0,
            };
            onMaskCreateRef.current(shape);
          }
        }

        setDrawState({
          isDrawing: false,
          startPoint: null,
          currentPoint: null,
        });
      }

      // Finish dragging
      if (currentDragState.isDragging) {
        setDragState({
          isDragging: false,
          maskId: null,
          startPoint: null,
          originalShape: null,
        });
      }
    },
    [activeTool, width, height] // Reduced dependencies - using refs for volatile state
  );

  // Handle mask click (selection)
  const handleMaskClick = useCallback(
    (id: MaskId) => {
      if (disabled) return;
      if (activeTool === 'select') {
        onMaskSelect(id);
      }
    },
    [disabled, activeTool, onMaskSelect]
  );

  // Handle mask mouse down (start drag)
  const handleMaskMouseDown = useCallback(
    (event: React.MouseEvent, mask: Mask) => {
      if (disabled || !svgRef.current) return;
      if (activeTool !== 'select') return;
      if (mask.locked) return;

      event.stopPropagation();
      const pos = getMousePosition(event, svgRef.current);

      setDragState({
        isDragging: true,
        maskId: mask.id,
        startPoint: pos,
        originalShape: mask.shape,
      });
    },
    [disabled, activeTool]
  );

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (disabled) return;

      if (event.key === 'Escape') {
        // Cancel drawing
        if (drawState.isDrawing) {
          setDrawState({
            isDrawing: false,
            startPoint: null,
            currentPoint: null,
          });
        } else {
          // Deselect
          onMaskSelect(null);
        }
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedMaskId && onMaskDelete) {
          onMaskDelete(selectedMaskId);
        }
      }
    },
    [disabled, drawState.isDrawing, selectedMaskId, onMaskSelect, onMaskDelete]
  );

  // Add global mouse event listeners for drag/draw
  // Track if listeners are attached to avoid duplicate cleanup
  const listenersAttachedRef = useRef(false);

  useEffect(() => {
    const isActive = drawState.isDrawing || dragState.isDragging;

    if (isActive && !listenersAttachedRef.current) {
      listenersAttachedRef.current = true;
      document.addEventListener('mousemove', handleCanvasMouseMove);
      document.addEventListener('mouseup', handleCanvasMouseUp);
    }

    return () => {
      if (listenersAttachedRef.current) {
        listenersAttachedRef.current = false;
        document.removeEventListener('mousemove', handleCanvasMouseMove);
        document.removeEventListener('mouseup', handleCanvasMouseUp);
      }
    };
  }, [drawState.isDrawing, dragState.isDragging, handleCanvasMouseMove, handleCanvasMouseUp]);

  return (
    <svg
      ref={svgRef}
      data-testid="mask-canvas"
      className={`${getCursorClass()} ${className}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      tabIndex={0}
      onMouseDown={handleCanvasMouseDown}
      onKeyDown={handleKeyDown}
      style={{ outline: 'none' }}
    >
      {/* Background */}
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="transparent"
      />

      {/* Render masks */}
      {masks.map((mask) => {
        const isSelected = mask.id === selectedMaskId;
        const commonProps: ShapeRendererProps = {
          mask,
          width,
          height,
          isSelected,
          onClick: () => handleMaskClick(mask.id),
          onMouseDown: (e) => handleMaskMouseDown(e, mask),
        };

        let ShapeComponent: React.FC<ShapeRendererProps>;
        switch (mask.shape.type) {
          case 'rectangle':
            ShapeComponent = RectangleShape;
            break;
          case 'ellipse':
            ShapeComponent = EllipseShape;
            break;
          case 'polygon':
            ShapeComponent = PolygonShape;
            break;
          case 'bezier':
            ShapeComponent = BezierShape;
            break;
          default:
            return null;
        }

        return (
          <g key={mask.id}>
            <ShapeComponent {...commonProps} />
            {isSelected && <SelectionHandles mask={mask} width={width} height={height} />}
          </g>
        );
      })}

      {/* Drawing preview */}
      {drawState.isDrawing && drawState.startPoint && drawState.currentPoint && (
        <DrawingPreview
          tool={activeTool}
          startPoint={drawState.startPoint}
          currentPoint={drawState.currentPoint}
        />
      )}
    </svg>
  );
}

export default MaskCanvas;
