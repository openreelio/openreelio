/**
 * useScrubbing Hook
 *
 * Handles playhead scrubbing interactions on the timeline.
 * Manages mouse events for scrubbing, playback state preservation,
 * and document-level event listeners.
 *
 * Performance optimizations:
 * - Uses requestAnimationFrame for smooth 60fps updates
 * - Optional direct DOM manipulation for immediate visual feedback
 * - Coordinated drag lock via PlaybackController to prevent conflicts
 */

import { useState, useCallback, useRef, useEffect, type MouseEvent, type RefObject } from 'react';
import type { SnapPoint } from '@/types';
import type { PlayheadHandle } from '@/components/timeline/Playhead';
import { playbackController } from '@/services/PlaybackController';

// =============================================================================
// Types
// =============================================================================

// Removed SEEK_THROTTLE_MS - we now call seek() on every frame for better preview sync
// This matches OpenCut's approach where seek is called on every mousemove

/**
 * Internal scrubbing state.
 */
interface ScrubState {
  wasPlaying: boolean;
  rafId: number | null;
  pendingEvent: globalThis.MouseEvent | null;
  currentTime: number;
}

export interface UseScrubbingOptions {
  /** Whether the timeline is currently playing */
  isPlaying: boolean;
  /** Function to toggle playback state */
  togglePlayback: () => void;
  /** Function to seek to a specific time */
  seek: (time: number) => void;
  /** Function to calculate time from mouse event */
  calculateTimeFromMouseEvent: (
    e: globalThis.MouseEvent | MouseEvent,
    applySnapping?: boolean
  ) => { time: number | null; snapPoint: SnapPoint | null };
  /** Callback when snapping state changes */
  onSnapChange?: (snapPoint: SnapPoint | null) => void;
  /** Reference to playhead for direct DOM manipulation */
  playheadRef?: RefObject<PlayheadHandle | null>;
  /** Current zoom level for pixel calculation */
  zoom?: number;
  /** Current scroll offset for pixel calculation */
  scrollX?: number;
  /** Track header width for pixel calculation */
  trackHeaderWidth?: number;
  /**
   * Track header width used for playhead *visual* positioning.
   *
   * Use this when the playhead is rendered inside a container that is already
   * offset by the track header width (e.g., a clipped overlay that starts at
   * the content area). In that case pass `0` to avoid double-offsetting the
   * playhead during direct DOM updates.
   *
   * Defaults to `trackHeaderWidth` for backwards compatibility.
   */
  playheadTrackHeaderWidth?: number;
}

export interface UseScrubbingResult {
  /** Whether the user is currently scrubbing */
  isScrubbing: boolean;
  /** Handler for mouse down to start scrubbing */
  handleScrubStart: (e: MouseEvent) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for managing playhead scrubbing on the timeline.
 *
 * @param options - Scrubbing configuration options
 * @returns Scrubbing state and handlers
 *
 * @example
 * ```tsx
 * const { isScrubbing, handleScrubStart } = useScrubbing({
 *   isPlaying,
 *   togglePlayback,
 *   seek: setPlayhead,
 *   calculateTimeFromMouseEvent,
 *   playheadRef,
 *   zoom,
 *   scrollX,
 *   trackHeaderWidth,
 * });
 * ```
 */
export function useScrubbing({
  isPlaying,
  togglePlayback,
  seek,
  calculateTimeFromMouseEvent,
  onSnapChange,
  playheadRef,
  zoom = 10,
  scrollX = 0,
  trackHeaderWidth = 192,
  playheadTrackHeaderWidth,
}: UseScrubbingOptions): UseScrubbingResult {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubStateRef = useRef<ScrubState | null>(null);

  // Store event handlers in refs to allow cleanup on unmount
  const handlersRef = useRef<{
    move: ((e: globalThis.MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Store latest values in refs for stable event handler access
  const latestValuesRef = useRef({
    zoom,
    scrollX,
    trackHeaderWidth,
    playheadTrackHeaderWidth: playheadTrackHeaderWidth ?? trackHeaderWidth,
  });
  useEffect(() => {
    latestValuesRef.current = {
      zoom,
      scrollX,
      trackHeaderWidth,
      playheadTrackHeaderWidth: playheadTrackHeaderWidth ?? trackHeaderWidth,
    };
  }, [zoom, scrollX, trackHeaderWidth, playheadTrackHeaderWidth]);

  /**
   * Convert time to pixel position for direct DOM updates.
   */
  const timeToPixel = useCallback((time: number): number => {
    const { zoom: z, scrollX: sx, playheadTrackHeaderWidth: pthw } = latestValuesRef.current;
    return time * z + pthw - sx;
  }, []);

  /**
   * Update playhead position directly via DOM.
   */
  const updatePlayheadDirect = useCallback(
    (time: number) => {
      if (playheadRef?.current) {
        const pixelX = timeToPixel(time);
        playheadRef.current.setPixelPosition(pixelX);
      }
    },
    [playheadRef, timeToPixel]
  );

  /**
   * Process pending mouse event in rAF callback.
   * Updates both playhead visual (direct DOM) and playback store (throttled seek).
   */
  /**
   * Process pending mouse event in rAF callback.
   * Updates both playhead visual (direct DOM) and playback store (seek on every frame).
   */
  const processFrame = useCallback(() => {
    const state = scrubStateRef.current;
    if (!state || !state.pendingEvent) return;

    const result = calculateTimeFromMouseEvent(state.pendingEvent, true);
    if (result.time !== null) {
      state.currentTime = result.time;

      // Update playhead position directly (every frame for smoothness)
      updatePlayheadDirect(result.time);

      // Update playback store for preview sync (every frame - no throttling)
      // This matches OpenCut's approach where seek() is called on every mousemove
      seek(result.time);

      onSnapChange?.(result.snapPoint);
    }

    state.pendingEvent = null;
  }, [calculateTimeFromMouseEvent, updatePlayheadDirect, onSnapChange, seek]);

  // Cleanup function to remove event listeners
  const cleanup = useCallback(() => {
    // Cancel any pending animation frame
    const state = scrubStateRef.current;
    if (state && state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }

    if (handlersRef.current.move) {
      document.removeEventListener('mousemove', handlersRef.current.move);
      handlersRef.current.move = null;
    }
    if (handlersRef.current.up) {
      document.removeEventListener('mouseup', handlersRef.current.up);
      handlersRef.current.up = null;
    }
  }, []);

  // Cleanup on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      cleanup();
      scrubStateRef.current = null;
    };
  }, [cleanup]);

  const handleScrubStart = useCallback(
    (e: MouseEvent) => {
      // Don't start scrubbing if clicking on clips, buttons, or interactive elements
      const target = e.target as HTMLElement;

      // Skip if clicking on a clip
      if (target.closest('[data-testid^="clip-"]')) {
        return;
      }

      // Skip if clicking on buttons or interactive controls
      if (target.tagName === 'BUTTON' || target.closest('button')) {
        return;
      }

      // Skip if clicking on track header (left side controls)
      if (target.closest('[data-testid="track-header"]')) {
        return;
      }

      // Attempt to acquire drag lock - prevents conflicts with playhead drag
      if (!playbackController.acquireDragLock('scrubbing')) {
        return;
      }

      e.preventDefault();
      setIsScrubbing(true);

      // Initialize scrub state
      scrubStateRef.current = {
        wasPlaying: isPlaying,
        rafId: null,
        pendingEvent: null,
        currentTime: 0,
      };

      // Pause playback during scrubbing
      if (isPlaying) {
        togglePlayback();
      }

      // Set initial position (with snapping) - direct DOM update for immediate response
      const result = calculateTimeFromMouseEvent(e, true);
      if (result.time !== null) {
        scrubStateRef.current.currentTime = result.time;
        updatePlayheadDirect(result.time);
        seek(result.time);
        onSnapChange?.(result.snapPoint);
      }

      // Apply ew-resize cursor to entire document during scrubbing
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      // Define event handlers with rAF scheduling
      const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
        const state = scrubStateRef.current;
        if (!state) return;

        // Store pending event for next rAF
        state.pendingEvent = moveEvent;

        // Schedule rAF if not already scheduled
        if (state.rafId === null) {
          state.rafId = requestAnimationFrame(() => {
            if (scrubStateRef.current) {
              scrubStateRef.current.rafId = null;
              processFrame();
            }
          });
        }
      };

      const handleMouseUp = () => {
        const state = scrubStateRef.current;

        // Cancel any pending animation frame
        if (state && state.rafId !== null) {
          cancelAnimationFrame(state.rafId);
        }

        setIsScrubbing(false);
        onSnapChange?.(null);

        // Sync final position to React state and restore playback
        if (state) {
          seek(state.currentTime);

          // Resume playback if it was playing before scrubbing
          if (state.wasPlaying) {
            togglePlayback();
          }
        }
        scrubStateRef.current = null;

        // Restore cursor and user-select
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // Release drag lock
        playbackController.releaseDragLock('scrubbing');

        // Cleanup listeners
        cleanup();
      };

      // Store handlers for potential cleanup on unmount
      handlersRef.current.move = handleMouseMove;
      handlersRef.current.up = handleMouseUp;

      // Add document-level listeners for mouse move and up (passive for performance)
      document.addEventListener('mousemove', handleMouseMove, { passive: true });
      document.addEventListener('mouseup', handleMouseUp);
    },
    [
      isPlaying,
      togglePlayback,
      calculateTimeFromMouseEvent,
      seek,
      onSnapChange,
      cleanup,
      updatePlayheadDirect,
      processFrame,
    ]
  );

  return {
    isScrubbing,
    handleScrubStart,
  };
}
