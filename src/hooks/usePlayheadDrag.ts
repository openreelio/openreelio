/**
 * usePlayheadDrag Hook
 *
 * Handles direct playhead dragging interactions on the timeline.
 * Supports snapping, playback state preservation, and proper cleanup.
 *
 * @module hooks/usePlayheadDrag
 */

import { useState, useCallback, useRef, useEffect, type RefObject } from 'react';
import type { SnapPoint, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for the usePlayheadDrag hook.
 */
export interface UsePlayheadDragOptions {
  /** Reference to the container element (tracks area) */
  containerRef: RefObject<HTMLElement | null>;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Current horizontal scroll offset */
  scrollX: number;
  /** Total timeline duration in seconds */
  duration: TimeSec;
  /** Track header width offset in pixels */
  trackHeaderWidth: number;
  /** Whether the timeline is currently playing */
  isPlaying: boolean;
  /** Function to toggle playback state */
  togglePlayback: () => void;
  /** Function to seek to a specific time */
  seek: (time: TimeSec) => void;
  /** Whether snapping is enabled */
  snapEnabled: boolean;
  /** Available snap points */
  snapPoints: SnapPoint[];
  /** Snap threshold in seconds */
  snapThreshold: number;
  /** Callback when snapping state changes */
  onSnapChange?: (snapPoint: SnapPoint | null) => void;
}

/**
 * Result returned by usePlayheadDrag hook.
 */
export interface UsePlayheadDragResult {
  /** Whether the user is currently dragging the playhead */
  isDragging: boolean;
  /** Handler for mouse down to start dragging */
  handleDragStart: (e: React.MouseEvent) => void;
  /** Handler for pointer down (for touch support) */
  handlePointerDown: (e: React.PointerEvent) => void;
}

/**
 * Internal state for tracking drag operation.
 */
interface DragState {
  /** Whether playback was active before drag started */
  wasPlaying: boolean;
  /** Initial client X position when drag started */
  startClientX: number;
  /** Initial playhead time when drag started */
  startTime: TimeSec;
}

// =============================================================================
// Constants
// =============================================================================

/** Throttle interval for drag updates (ms) for 60fps */
const DRAG_THROTTLE_MS = 16;

/**
 * Minimum zoom value to prevent division by zero and numerical instability.
 * A zoom of 0.1 means 0.1 pixels per second (1 pixel = 10 seconds).
 */
const MIN_ZOOM = 0.1;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clamp a value between min and max.
 *
 * @param value - The value to clamp
 * @param min - The minimum allowed value
 * @param max - The maximum allowed value
 * @returns The clamped value, or min if inputs are invalid
 *
 * @remarks
 * Handles edge cases where value, min, or max may be NaN or Infinity.
 */
function clamp(value: number, min: number, max: number): number {
  // Defensive: Handle NaN/Infinity for min and max
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? max : safeMin;

  // Defensive: Handle NaN/Infinity for value
  if (!Number.isFinite(value)) {
    return safeMin;
  }

  return Math.max(safeMin, Math.min(safeMax, value));
}

/**
 * Find the nearest snap point within threshold.
 *
 * @param time - The current time to snap from
 * @param snapPoints - Array of available snap points
 * @param threshold - Maximum distance in seconds to consider for snapping
 * @returns Object with snapped state, resulting time, and snap point if found
 *
 * @remarks
 * This function includes defensive programming against:
 * - Empty snap points array
 * - Invalid time values (NaN/Infinity)
 * - Invalid threshold values
 * - Snap points with invalid time values
 */
function findNearestSnapPoint(
  time: TimeSec,
  snapPoints: SnapPoint[],
  threshold: number
): { snapped: boolean; time: TimeSec; snapPoint: SnapPoint | null } {
  // Defensive: Handle empty array
  if (!Array.isArray(snapPoints) || snapPoints.length === 0) {
    return { snapped: false, time, snapPoint: null };
  }

  // Defensive: Handle invalid time
  if (!Number.isFinite(time)) {
    return { snapped: false, time: 0, snapPoint: null };
  }

  // Defensive: Handle invalid threshold
  const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
  if (safeThreshold === 0) {
    return { snapped: false, time, snapPoint: null };
  }

  let nearestPoint: SnapPoint | null = null;
  let nearestDistance = Infinity;

  for (const point of snapPoints) {
    // Defensive: Skip snap points with invalid time values
    if (!point || !Number.isFinite(point.time)) {
      continue;
    }

    const distance = Math.abs(point.time - time);
    if (distance < nearestDistance && distance <= safeThreshold) {
      nearestDistance = distance;
      nearestPoint = point;
    }
  }

  if (nearestPoint) {
    return {
      snapped: true,
      time: nearestPoint.time,
      snapPoint: nearestPoint,
    };
  }

  return { snapped: false, time, snapPoint: null };
}

/**
 * Calculate time from a mouse/pointer event.
 *
 * @param clientX - The client X coordinate from the event
 * @param containerRect - The bounding rect of the container element
 * @param trackHeaderWidth - Width of the track header in pixels
 * @param scrollX - Current horizontal scroll offset
 * @param zoom - Zoom level (pixels per second) - must be > 0
 * @param duration - Total timeline duration in seconds
 * @returns The calculated time, clamped between 0 and duration
 *
 * @remarks
 * This function includes defensive programming against:
 * - Division by zero (zoom <= 0)
 * - NaN/Infinity results from invalid inputs
 * - Negative time values
 * - Time values exceeding duration
 */
function calculateTimeFromEvent(
  clientX: number,
  containerRect: DOMRect,
  trackHeaderWidth: number,
  scrollX: number,
  zoom: number,
  duration: TimeSec
): TimeSec {
  // Defensive: Handle invalid zoom to prevent division by zero
  const safeZoom = Math.max(zoom, MIN_ZOOM);

  // Defensive: Ensure duration is non-negative
  const safeDuration = Math.max(duration, 0);

  // Defensive: Validate numeric inputs are finite
  if (!Number.isFinite(clientX) || !Number.isFinite(scrollX)) {
    return 0;
  }

  const relativeX = clientX - containerRect.left - trackHeaderWidth + scrollX;
  const rawTime = relativeX / safeZoom;

  // Defensive: Handle NaN/Infinity results
  if (!Number.isFinite(rawTime)) {
    return 0;
  }

  return clamp(rawTime, 0, safeDuration);
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for handling direct playhead dragging on the timeline.
 *
 * Features:
 * - Direct playhead manipulation via drag
 * - Snap-to-grid support with visual feedback
 * - Automatic playback pause during drag
 * - Playback restoration after drag
 * - Document-level event capture for reliable tracking
 * - Proper cleanup on unmount
 * - Touch device support via pointer events
 * - Throttled updates for performance
 *
 * @param options - Configuration options for the hook
 * @returns Object containing drag state and event handlers
 *
 * @example
 * ```tsx
 * const { isDragging, handleDragStart, handlePointerDown } = usePlayheadDrag({
 *   containerRef,
 *   zoom,
 *   scrollX,
 *   duration,
 *   trackHeaderWidth: TRACK_HEADER_WIDTH,
 *   isPlaying,
 *   togglePlayback,
 *   seek: setPlayhead,
 *   snapEnabled,
 *   snapPoints,
 *   snapThreshold,
 *   onSnapChange: setActiveSnapPoint,
 * });
 * ```
 */
export function usePlayheadDrag({
  containerRef,
  zoom,
  scrollX,
  duration,
  trackHeaderWidth,
  isPlaying,
  togglePlayback,
  seek,
  snapEnabled,
  snapPoints,
  snapThreshold,
  onSnapChange,
}: UsePlayheadDragOptions): UsePlayheadDragResult {
  // Track dragging state
  const [isDragging, setIsDragging] = useState(false);

  // Store drag state in ref for event handlers
  const dragStateRef = useRef<DragState | null>(null);

  // Store event handler refs for cleanup
  const handlersRef = useRef<{
    move: ((e: MouseEvent | PointerEvent) => void) | null;
    up: ((e: MouseEvent | PointerEvent) => void) | null;
    blur: (() => void) | null;
  }>({
    move: null,
    up: null,
    blur: null,
  });

  // Throttle ref for drag updates
  const lastUpdateTimeRef = useRef<number>(0);

  // Store latest values in refs for stable event handler access
  const latestValuesRef = useRef({
    zoom,
    scrollX,
    duration,
    trackHeaderWidth,
    snapEnabled,
    snapPoints,
    snapThreshold,
    isPlaying,
  });

  // Update latest values ref when props change
  useEffect(() => {
    latestValuesRef.current = {
      zoom,
      scrollX,
      duration,
      trackHeaderWidth,
      snapEnabled,
      snapPoints,
      snapThreshold,
      isPlaying,
    };
  }, [zoom, scrollX, duration, trackHeaderWidth, snapEnabled, snapPoints, snapThreshold, isPlaying]);

  /**
   * Cleanup function to remove document event listeners.
   */
  const cleanup = useCallback(() => {
    if (handlersRef.current.move) {
      document.removeEventListener('mousemove', handlersRef.current.move);
      document.removeEventListener('pointermove', handlersRef.current.move);
      handlersRef.current.move = null;
    }
    if (handlersRef.current.up) {
      document.removeEventListener('mouseup', handlersRef.current.up);
      document.removeEventListener('pointerup', handlersRef.current.up);
      document.removeEventListener('pointercancel', handlersRef.current.up);
      handlersRef.current.up = null;
    }
    if (handlersRef.current.blur) {
      window.removeEventListener('blur', handlersRef.current.blur);
      handlersRef.current.blur = null;
    }
  }, []);

  /**
   * Cleanup on unmount to prevent memory leaks and stale handlers.
   */
  useEffect(() => {
    return () => {
      cleanup();
      // Reset drag state on unmount
      dragStateRef.current = null;
    };
  }, [cleanup]);

  /**
   * Core drag start logic shared between mouse and pointer events.
   */
  const startDrag = useCallback(
    (clientX: number, isPointerEvent: boolean = false) => {
      // Prevent double-triggering from both mouse and pointer events
      if (dragStateRef.current || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const {
        zoom: currentZoom,
        scrollX: currentScrollX,
        duration: currentDuration,
        trackHeaderWidth: currentTrackHeaderWidth,
        isPlaying: currentIsPlaying,
      } = latestValuesRef.current;

      // Calculate initial time from mouse position
      let startTime = calculateTimeFromEvent(
        clientX,
        containerRect,
        currentTrackHeaderWidth,
        currentScrollX,
        currentZoom,
        currentDuration
      );

      // Apply snapping to initial position
      const {
        snapEnabled: se,
        snapPoints: sp,
        snapThreshold: st,
      } = latestValuesRef.current;

      let initialSnapPoint: SnapPoint | null = null;
      if (se && sp.length > 0) {
        const snapResult = findNearestSnapPoint(startTime, sp, st);
        if (snapResult.snapped) {
          startTime = snapResult.time;
          initialSnapPoint = snapResult.snapPoint;
        }
      }

      // Store initial drag state
      dragStateRef.current = {
        wasPlaying: currentIsPlaying,
        startClientX: clientX,
        startTime,
      };

      // Pause playback during drag
      if (currentIsPlaying) {
        togglePlayback();
      }

      // Initial seek to click position (with snapping applied)
      seek(startTime);

      // Notify snap change for initial position
      onSnapChange?.(initialSnapPoint);

      // Set dragging state
      setIsDragging(true);
      lastUpdateTimeRef.current = performance.now();

      // Define move handler
      const handleMove = (e: MouseEvent | PointerEvent) => {
        if (!containerRef.current || !dragStateRef.current) return;

        // Throttle updates for performance
        const now = performance.now();
        if (now - lastUpdateTimeRef.current < DRAG_THROTTLE_MS) return;
        lastUpdateTimeRef.current = now;

        const rect = containerRef.current.getBoundingClientRect();
        const {
          zoom: z,
          scrollX: sx,
          duration: d,
          trackHeaderWidth: thw,
          snapEnabled: se,
          snapPoints: sp,
          snapThreshold: st,
        } = latestValuesRef.current;

        // Calculate time from current position
        let time = calculateTimeFromEvent(e.clientX, rect, thw, sx, z, d);

        // Apply snapping if enabled
        let activeSnapPoint: SnapPoint | null = null;
        if (se && sp.length > 0) {
          const snapResult = findNearestSnapPoint(time, sp, st);
          if (snapResult.snapped) {
            time = snapResult.time;
            activeSnapPoint = snapResult.snapPoint;
          }
        }

        // Update playhead position
        seek(time);

        // Notify snap change
        onSnapChange?.(activeSnapPoint);
      };

      // Define up/end handler
      const handleUp = () => {
        const dragState = dragStateRef.current;

        // Clear snap indicator
        onSnapChange?.(null);

        // Restore playback if it was playing before drag
        if (dragState?.wasPlaying) {
          togglePlayback();
        }

        // Reset drag state
        dragStateRef.current = null;
        setIsDragging(false);

        // Cleanup listeners
        cleanup();
      };

      // Define window blur handler (user switches focus)
      const handleBlur = () => {
        // Treat blur as drag end
        handleUp();
      };

      // Store handlers for cleanup
      handlersRef.current.move = handleMove;
      handlersRef.current.up = handleUp;
      handlersRef.current.blur = handleBlur;

      // Add document-level listeners
      if (isPointerEvent) {
        document.addEventListener('pointermove', handleMove);
        document.addEventListener('pointerup', handleUp);
        document.addEventListener('pointercancel', handleUp);
      } else {
        document.addEventListener('mousemove', handleMove);
        document.addEventListener('mouseup', handleUp);
      }
      window.addEventListener('blur', handleBlur);
    },
    [containerRef, togglePlayback, seek, onSnapChange, cleanup]
  );

  /**
   * Handler for mouse down to start dragging (traditional mouse).
   */
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      // Only handle left mouse button
      if (e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      startDrag(e.clientX, false);
    },
    [startDrag]
  );

  /**
   * Handler for pointer down (touch and stylus support).
   */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only handle primary pointer (touch or left mouse)
      if (!e.isPrimary) return;

      e.preventDefault();
      e.stopPropagation();

      // Capture pointer for reliable tracking
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      startDrag(e.clientX, true);
    },
    [startDrag]
  );

  return {
    isDragging,
    handleDragStart,
    handlePointerDown,
  };
}
