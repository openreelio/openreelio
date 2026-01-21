/**
 * useClipDrag Hook
 *
 * Handles clip drag/resize operations with delta accumulation and grid snapping.
 * Based on react-timeline-editor's row_rnd patterns.
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { snapToGrid, clampTime, MIN_CLIP_DURATION } from '@/utils/timeline';
import { snapToNearestPoint, type SnapPoint } from '@/utils/gridSnapping';

// =============================================================================
// Types
// =============================================================================

export type DragType = 'move' | 'trim-left' | 'trim-right';

/**
 * Data passed to drag callbacks
 */
export interface ClipDragData {
  clipId: string;
  type: DragType;
  startX: number;
  originalTimelineIn: number;
  originalSourceIn: number;
  originalSourceOut: number;
}

/**
 * Preview position during drag
 */
export interface DragPreviewPosition {
  timelineIn: number;
  sourceIn: number;
  sourceOut: number;
  duration: number;
}

/**
 * Hook options
 */
export interface UseClipDragOptions {
  /** Clip identifier */
  clipId: string;
  /** Initial timeline position in seconds */
  initialTimelineIn: number;
  /** Initial source in point in seconds */
  initialSourceIn: number;
  /** Initial source out point in seconds */
  initialSourceOut: number;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Whether drag is disabled */
  disabled?: boolean;
  /** Grid interval for snapping (0 = no snapping) */
  gridInterval?: number;
  /** Minimum clip duration in seconds */
  minDuration?: number;
  /** Playback speed multiplier */
  speed?: number;
  /** Maximum source duration (for trim bounds) */
  maxSourceDuration?: number;
  /** Snap points for intelligent snapping (clip edges, playhead, etc.) */
  snapPoints?: SnapPoint[];
  /** Snap threshold in seconds (distance within which snapping occurs) */
  snapThreshold?: number;
  /** Callback when drag starts */
  onDragStart?: (data: ClipDragData) => void;
  /** Callback during drag with preview position */
  onDrag?: (data: ClipDragData, previewPosition: DragPreviewPosition) => void;
  /** Callback when drag ends */
  onDragEnd?: (data: ClipDragData, finalPosition: DragPreviewPosition) => void;
}

/**
 * Hook return value
 */
export interface UseClipDragReturn {
  /** Whether currently dragging */
  isDragging: boolean;
  /** Current drag type */
  dragType: DragType | null;
  /** Preview position during drag */
  previewPosition: DragPreviewPosition | null;
  /** Currently active snap point (if snapping) */
  activeSnapPoint: SnapPoint | null;
  /** Mouse down handler to start drag */
  handleMouseDown: (e: ReactMouseEvent, type: DragType) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useClipDrag(options: UseClipDragOptions): UseClipDragReturn {
  const {
    clipId,
    initialTimelineIn,
    initialSourceIn,
    initialSourceOut,
    zoom,
    disabled = false,
    gridInterval = 0,
    minDuration = MIN_CLIP_DURATION,
    speed = 1,
    maxSourceDuration,
    snapPoints = [],
    snapThreshold = 0,
    onDragStart,
    onDrag,
    onDragEnd,
  } = options;

  // State
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<DragType | null>(null);
  const [previewPosition, setPreviewPosition] = useState<DragPreviewPosition | null>(null);
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | null>(null);

  // Refs for drag tracking
  const dragDataRef = useRef<ClipDragData | null>(null);
  const previewPositionRef = useRef<DragPreviewPosition | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Calculate initial duration
  const calculateDuration = useCallback(
    (sourceIn: number, sourceOut: number): number => {
      return (sourceOut - sourceIn) / speed;
    },
    [speed],
  );

  // Calculate preview position based on drag delta
  const calculatePreviewPosition = useCallback(
    (deltaX: number, type: DragType): DragPreviewPosition => {
      const deltaTime = deltaX / zoom;

      let newTimelineIn = initialTimelineIn;
      let newSourceIn = initialSourceIn;
      let newSourceOut = initialSourceOut;

      if (type === 'move') {
        // Move: adjust timeline position only
        newTimelineIn = clampTime(initialTimelineIn + deltaTime, 0);
        if (gridInterval > 0) {
          newTimelineIn = snapToGrid(newTimelineIn, gridInterval);
        }
      } else if (type === 'trim-left') {
        // Trim left: adjust both sourceIn and timelineIn
        const rawDelta = deltaTime;

        // Calculate max trim (can't go past source start or leave less than minDuration)
        const maxTrimLeft = -initialSourceIn; // Can extend to source start
        const maxTrimRight = (initialSourceOut - initialSourceIn) / speed - minDuration;
        const clampedDelta = clampTime(rawDelta, maxTrimLeft, maxTrimRight);

        newSourceIn = initialSourceIn + clampedDelta * speed;
        newTimelineIn = initialTimelineIn + clampedDelta;

        // Ensure sourceIn doesn't go negative
        if (newSourceIn < 0) {
          newSourceIn = 0;
          newTimelineIn = initialTimelineIn - initialSourceIn / speed;
        }

        if (gridInterval > 0) {
          newTimelineIn = snapToGrid(newTimelineIn, gridInterval);
          // Recalculate sourceIn based on snapped timelineIn
          const timelineDelta = newTimelineIn - initialTimelineIn;
          newSourceIn = initialSourceIn + timelineDelta * speed;
        }
      } else if (type === 'trim-right') {
        // Trim right: adjust sourceOut only
        const rawDelta = deltaTime * speed;

        // Calculate bounds
        const minSourceOut = initialSourceIn + minDuration * speed;
        const maxSourceOut = maxSourceDuration ?? Number.POSITIVE_INFINITY;

        newSourceOut = clampTime(initialSourceOut + rawDelta, minSourceOut, maxSourceOut);

        if (gridInterval > 0) {
          const duration = calculateDuration(initialSourceIn, newSourceOut);
          const snappedDuration = snapToGrid(duration, gridInterval);
          newSourceOut = initialSourceIn + snappedDuration * speed;

          // Re-clamp after snapping
          newSourceOut = clampTime(newSourceOut, minSourceOut, maxSourceOut);
        }
      }

      return {
        timelineIn: newTimelineIn,
        sourceIn: newSourceIn,
        sourceOut: newSourceOut,
        duration: calculateDuration(newSourceIn, newSourceOut),
      };
    },
    [
      zoom,
      initialTimelineIn,
      initialSourceIn,
      initialSourceOut,
      gridInterval,
      minDuration,
      speed,
      maxSourceDuration,
      calculateDuration,
    ],
  );

  // Mouse move handler
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragDataRef.current) return;

      const deltaX = e.clientX - dragDataRef.current.startX;
      const type = dragDataRef.current.type;

      // Calculate base preview position
      let preview = calculatePreviewPosition(deltaX, type);

      // Apply snap points if available (takes priority over grid snapping)
      if (snapPoints.length > 0 && snapThreshold > 0 && type === 'move') {
        const snapResult = snapToNearestPoint(preview.timelineIn, snapPoints, snapThreshold);

        if (snapResult.snapped && snapResult.snapPoint) {
          preview = {
            ...preview,
            timelineIn: snapResult.time,
          };
          setActiveSnapPoint(snapResult.snapPoint);
        } else {
          setActiveSnapPoint(null);
        }
      } else {
        setActiveSnapPoint(null);
      }

      setPreviewPosition(preview);
      previewPositionRef.current = preview;

      // Notify parent with the computed preview position directly
      onDrag?.(dragDataRef.current, preview);
    },
    [calculatePreviewPosition, onDrag, snapPoints, snapThreshold],
  );

  // Mouse up handler
  const handleMouseUp = useCallback(() => {
    if (dragDataRef.current && previewPositionRef.current) {
      onDragEnd?.(dragDataRef.current, previewPositionRef.current);
    }

    // Reset state
    setIsDragging(false);
    setDragType(null);
    setPreviewPosition(null);
    setActiveSnapPoint(null);
    dragDataRef.current = null;
    previewPositionRef.current = null;

    // Remove listeners
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    cleanupRef.current = null;
  }, [onDragEnd, handleMouseMove]);

  // Mouse down handler to start drag
  const handleMouseDown = useCallback(
    (e: ReactMouseEvent, type: DragType) => {
      // Only respond to left-click
      if (e.button !== 0 || disabled) return;

      e.preventDefault();
      e.stopPropagation();

      const dragData: ClipDragData = {
        clipId,
        type,
        startX: e.clientX,
        originalTimelineIn: initialTimelineIn,
        originalSourceIn: initialSourceIn,
        originalSourceOut: initialSourceOut,
      };

      dragDataRef.current = dragData;
      setIsDragging(true);
      setDragType(type);

      // Set initial preview position
      const initialPreview: DragPreviewPosition = {
        timelineIn: initialTimelineIn,
        sourceIn: initialSourceIn,
        sourceOut: initialSourceOut,
        duration: calculateDuration(initialSourceIn, initialSourceOut),
      };
      setPreviewPosition(initialPreview);
      previewPositionRef.current = initialPreview;

      // Notify parent
      onDragStart?.(dragData);

      // Add document listeners
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      // Store cleanup function
      cleanupRef.current = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    },
    [
      disabled,
      clipId,
      initialTimelineIn,
      initialSourceIn,
      initialSourceOut,
      calculateDuration,
      onDragStart,
      handleMouseMove,
      handleMouseUp,
    ],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  return {
    isDragging,
    dragType,
    previewPosition,
    activeSnapPoint,
    handleMouseDown,
  };
}
