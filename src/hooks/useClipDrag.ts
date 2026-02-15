/**
 * useClipDrag Hook
 *
 * Handles clip drag/resize operations with delta accumulation and grid snapping.
 * Based on react-timeline-editor's row_rnd patterns and OpenCut's element interaction.
 *
 * Features:
 * - Drag threshold to differentiate clicks from drags (5px)
 * - Grid snapping support
 * - Intelligent snap points (clip edges, playhead)
 * - Stale closure prevention via refs
 * - Clean unmount handling
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
import { createLogger } from '@/services/logger';

const logger = createLogger('useClipDrag');

// =============================================================================
// Constants
// =============================================================================

/**
 * Minimum pixel distance before a mouse down + move is considered a drag.
 * Prevents accidental drags when clicking clips.
 */
const DRAG_THRESHOLD_PX = 5;

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
  startY: number;
  originalTimelineIn: number;
  originalSourceIn: number;
  originalSourceOut: number;
  /** If true, bypass linked companion operations for this drag */
  ignoreLinkedSelection?: boolean;
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
  /** Whether currently dragging (past threshold) */
  isDragging: boolean;
  /** Whether mouse is down but not yet past threshold */
  isPendingDrag: boolean;
  /** Current drag type */
  dragType: DragType | null;
  /** Preview position during drag */
  previewPosition: DragPreviewPosition | null;
  /** Currently active snap point (if snapping) */
  activeSnapPoint: SnapPoint | null;
  /** Mouse down handler to start drag */
  handleMouseDown: (e: ReactMouseEvent, type: DragType) => void;
}

/**
 * Internal pending drag state before threshold is exceeded
 */
interface PendingDragState {
  clipId: string;
  type: DragType;
  startX: number;
  startY: number;
  originalTimelineIn: number;
  originalSourceIn: number;
  originalSourceOut: number;
  ignoreLinkedSelection: boolean;
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
    disabled = false,
  } = options;

  // State
  const [isDragging, setIsDragging] = useState(false);
  const [isPendingDrag, setIsPendingDrag] = useState(false);
  const [dragType, setDragType] = useState<DragType | null>(null);
  const [previewPosition, setPreviewPosition] = useState<DragPreviewPosition | null>(null);
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | null>(null);

  // Refs for values accessed in event listeners (prevents stale closures)
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Refs mirroring state for synchronous access in event handlers
  // (state values in closures can be stale during transitions)
  const isDraggingRef = useRef(false);
  const isPendingDragRef = useRef(false);

  // Refs for drag tracking
  const pendingDragRef = useRef<PendingDragState | null>(null);
  const dragDataRef = useRef<ClipDragData | null>(null);
  const previewPositionRef = useRef<DragPreviewPosition | null>(null);
  const isMountedRef = useRef(true);

  // Calculate initial duration with safety guard against zero/negative speed
  const calculateDuration = useCallback(
    (sourceIn: number, sourceOut: number, clipSpeed: number): number => {
      const safeSpeed = clipSpeed > 0 ? clipSpeed : 1;
      return (sourceOut - sourceIn) / safeSpeed;
    },
    [],
  );

  // Calculate preview position based on drag delta
  const calculatePreviewPosition = useCallback(
    (
      deltaX: number,
      type: DragType,
      origTimelineIn: number,
      origSourceIn: number,
      origSourceOut: number,
    ): DragPreviewPosition => {
      const opts = optionsRef.current;

      // Validate inputs - return safe defaults for invalid values
      if (
        !Number.isFinite(deltaX) ||
        !Number.isFinite(origTimelineIn) ||
        !Number.isFinite(origSourceIn) ||
        !Number.isFinite(origSourceOut)
      ) {
        logger.warn('Invalid input values in calculatePreviewPosition', {
          deltaX,
          origTimelineIn,
          origSourceIn,
          origSourceOut,
        });
        return {
          timelineIn: Math.max(0, origTimelineIn || 0),
          sourceIn: Math.max(0, origSourceIn || 0),
          sourceOut: Math.max(0, origSourceOut || 0),
          duration: Math.max(0, (origSourceOut || 0) - (origSourceIn || 0)),
        };
      }

      // Guard against division by zero for zoom
      const safeZoom = opts.zoom > 0 ? opts.zoom : 100;
      const deltaTime = deltaX / safeZoom;
      const clipSpeed = opts.speed && opts.speed > 0 ? opts.speed : 1;
      const clipGridInterval = opts.gridInterval ?? 0;
      const clipMinDuration = opts.minDuration ?? MIN_CLIP_DURATION;
      const clipMaxSourceDuration = opts.maxSourceDuration;

      let newTimelineIn = origTimelineIn;
      let newSourceIn = origSourceIn;
      let newSourceOut = origSourceOut;

      if (type === 'move') {
        // Move: adjust timeline position only
        newTimelineIn = clampTime(origTimelineIn + deltaTime, 0);
        if (clipGridInterval > 0) {
          newTimelineIn = snapToGrid(newTimelineIn, clipGridInterval);
        }
      } else if (type === 'trim-left') {
        // Trim left: adjust both sourceIn and timelineIn
        const rawDelta = deltaTime;

        // Calculate max trim (can't go past source start or leave less than minDuration)
        const maxTrimLeft = -origSourceIn; // Can extend to source start
        const maxTrimRight = (origSourceOut - origSourceIn) / clipSpeed - clipMinDuration;
        const clampedDelta = clampTime(rawDelta, maxTrimLeft, maxTrimRight);

        newSourceIn = origSourceIn + clampedDelta * clipSpeed;
        newTimelineIn = origTimelineIn + clampedDelta;

        // Ensure sourceIn doesn't go negative
        if (newSourceIn < 0) {
          newSourceIn = 0;
          newTimelineIn = origTimelineIn - origSourceIn / clipSpeed;
        }

        if (clipGridInterval > 0) {
          newTimelineIn = snapToGrid(newTimelineIn, clipGridInterval);
          // Recalculate sourceIn based on snapped timelineIn
          const timelineDelta = newTimelineIn - origTimelineIn;
          newSourceIn = origSourceIn + timelineDelta * clipSpeed;
        }
      } else if (type === 'trim-right') {
        // Trim right: adjust sourceOut only
        const rawDelta = deltaTime * clipSpeed;

        // Calculate bounds
        const minSourceOut = origSourceIn + clipMinDuration * clipSpeed;
        const maxSourceOut = clipMaxSourceDuration ?? Number.POSITIVE_INFINITY;

        newSourceOut = clampTime(origSourceOut + rawDelta, minSourceOut, maxSourceOut);

        if (clipGridInterval > 0) {
          const duration = calculateDuration(origSourceIn, newSourceOut, clipSpeed);
          const snappedDuration = snapToGrid(duration, clipGridInterval);
          newSourceOut = origSourceIn + snappedDuration * clipSpeed;

          // Re-clamp after snapping
          newSourceOut = clampTime(newSourceOut, minSourceOut, maxSourceOut);
        }
      }

      return {
        timelineIn: newTimelineIn,
        sourceIn: newSourceIn,
        sourceOut: newSourceOut,
        duration: calculateDuration(newSourceIn, newSourceOut, clipSpeed),
      };
    },
    [calculateDuration],
  );

  // Start actual drag (called when threshold is exceeded)
  const startDrag = useCallback(
    (pending: PendingDragState, initialPreview: DragPreviewPosition) => {
      if (!isMountedRef.current) return;

      const dragData: ClipDragData = {
        clipId: pending.clipId,
        type: pending.type,
        startX: pending.startX,
        startY: pending.startY,
        originalTimelineIn: pending.originalTimelineIn,
        originalSourceIn: pending.originalSourceIn,
        originalSourceOut: pending.originalSourceOut,
      };

      if (pending.ignoreLinkedSelection) {
        dragData.ignoreLinkedSelection = true;
      }

      dragDataRef.current = dragData;
      previewPositionRef.current = initialPreview;

      // Update refs synchronously (for event handlers)
      isPendingDragRef.current = false;
      isDraggingRef.current = true;

      // Update state (for React re-renders)
      setIsPendingDrag(false);
      setIsDragging(true);
      setDragType(pending.type);
      setPreviewPosition(initialPreview);

      // Notify parent
      optionsRef.current.onDragStart?.(dragData);

      logger.debug('Drag started', { clipId: pending.clipId, type: pending.type });
    },
    [],
  );

  // End drag and cleanup
  const endDrag = useCallback((commitDrag: boolean) => {
    if (!isMountedRef.current) return;

    if (commitDrag && dragDataRef.current && previewPositionRef.current) {
      optionsRef.current.onDragEnd?.(dragDataRef.current, previewPositionRef.current);
      logger.debug('Drag ended', {
        clipId: dragDataRef.current.clipId,
        finalPosition: previewPositionRef.current.timelineIn,
      });
    }

    // Reset refs synchronously (for event handlers)
    pendingDragRef.current = null;
    dragDataRef.current = null;
    previewPositionRef.current = null;
    isPendingDragRef.current = false;
    isDraggingRef.current = false;

    // Reset state (for React re-renders)
    setIsPendingDrag(false);
    setIsDragging(false);
    setDragType(null);
    setPreviewPosition(null);
    setActiveSnapPoint(null);
  }, []);

  // Effect to handle global mouse events during drag
  useEffect(() => {
    // Only set up listeners when actively engaged in drag operation
    if (!isPendingDrag && !isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Use refs for current state (avoids stale closure issues during state transitions)
      const isPending = isPendingDragRef.current;
      const isDrag = isDraggingRef.current;

      // Handle pending drag - check if threshold exceeded
      if (isPending && pendingDragRef.current) {
        const pending = pendingDragRef.current;
        const deltaX = Math.abs(e.clientX - pending.startX);
        const deltaY = Math.abs(e.clientY - pending.startY);

        if (deltaX > DRAG_THRESHOLD_PX || deltaY > DRAG_THRESHOLD_PX) {
          // Threshold exceeded - start actual drag
          const actualDeltaX = e.clientX - pending.startX;
          const preview = calculatePreviewPosition(
            actualDeltaX,
            pending.type,
            pending.originalTimelineIn,
            pending.originalSourceIn,
            pending.originalSourceOut,
          );
          startDrag(pending, preview);
        }
        return;
      }

      // Handle active drag
      if (isDrag && dragDataRef.current) {
        const dragData = dragDataRef.current;
        const deltaX = e.clientX - dragData.startX;
        const type = dragData.type;
        const opts = optionsRef.current;

        // Calculate base preview position
        let preview = calculatePreviewPosition(
          deltaX,
          type,
          dragData.originalTimelineIn,
          dragData.originalSourceIn,
          dragData.originalSourceOut,
        );

        // Apply snap points if available (takes priority over grid snapping)
        const currentSnapPoints = opts.snapPoints ?? [];
        const currentSnapThreshold = opts.snapThreshold ?? 0;

        if (currentSnapPoints.length > 0 && currentSnapThreshold > 0 && type === 'move') {
          const snapResult = snapToNearestPoint(
            preview.timelineIn,
            currentSnapPoints,
            currentSnapThreshold,
          );

          if (snapResult.snapped && snapResult.snapPoint) {
            preview = {
              ...preview,
              timelineIn: snapResult.time,
            };
            if (isMountedRef.current) {
              setActiveSnapPoint(snapResult.snapPoint);
            }
          } else {
            if (isMountedRef.current) {
              setActiveSnapPoint(null);
            }
          }
        } else {
          if (isMountedRef.current) {
            setActiveSnapPoint(null);
          }
        }

        previewPositionRef.current = preview;
        if (isMountedRef.current) {
          setPreviewPosition(preview);
        }

        // Notify parent with the computed preview position directly
        opts.onDrag?.(dragData, preview);
      }
    };

    const handleMouseUp = () => {
      // Use refs for current state (avoids stale closure issues)
      const isPending = isPendingDragRef.current;
      const isDrag = isDraggingRef.current;

      // If still pending (didn't exceed threshold), this was a click, not a drag
      if (isPending) {
        endDrag(false);
        return;
      }

      // Commit the drag
      if (isDrag) {
        endDrag(true);
      }
    };

    // Use capture phase to ensure we get events even if other handlers stop propagation
    document.addEventListener('mousemove', handleMouseMove, { capture: true });
    document.addEventListener('mouseup', handleMouseUp, { capture: true });

    // Handle escape key to cancel drag
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        endDrag(false); // Cancel without committing
      }
    };

    // Handle window blur (e.g., alt-tab) to prevent stuck drag state
    const handleWindowBlur = () => {
      if (isDraggingRef.current || isPendingDragRef.current) {
        endDrag(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove, { capture: true });
      document.removeEventListener('mouseup', handleMouseUp, { capture: true });
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('blur', handleWindowBlur);

      // Clean up any pending state if component unmounted during drag
      if (!isMountedRef.current) {
        pendingDragRef.current = null;
        dragDataRef.current = null;
        previewPositionRef.current = null;
        isPendingDragRef.current = false;
        isDraggingRef.current = false;
      }
    };
  }, [isPendingDrag, isDragging, calculatePreviewPosition, startDrag, endDrag]);

  // Mouse down handler to initiate pending drag
  const handleMouseDown = useCallback(
    (e: ReactMouseEvent, type: DragType) => {
      // Only respond to left-click
      if (e.button !== 0 || disabled) return;

      e.preventDefault();
      e.stopPropagation();

      // Store pending drag state
      pendingDragRef.current = {
        clipId,
        type,
        startX: e.clientX,
        startY: e.clientY,
        originalTimelineIn: initialTimelineIn,
        originalSourceIn: initialSourceIn,
        originalSourceOut: initialSourceOut,
        ignoreLinkedSelection: e.altKey,
      };

      // Update ref synchronously (for event handlers)
      isPendingDragRef.current = true;

      // Update state (for React re-renders)
      setIsPendingDrag(true);
      setDragType(type);

      logger.debug('Pending drag initiated', { clipId, type });
    },
    [disabled, clipId, initialTimelineIn, initialSourceIn, initialSourceOut],
  );

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      pendingDragRef.current = null;
      dragDataRef.current = null;
      previewPositionRef.current = null;
      isPendingDragRef.current = false;
      isDraggingRef.current = false;
    };
  }, []);

  return {
    isDragging,
    isPendingDrag,
    dragType,
    previewPosition,
    activeSnapPoint,
    handleMouseDown,
  };
}
