/**
 * useScrubbing Hook
 *
 * Handles playhead scrubbing interactions on the timeline.
 * Manages mouse events for scrubbing, playback state preservation,
 * and document-level event listeners.
 */

import { useState, useCallback, useRef, useEffect, type MouseEvent } from 'react';
import type { SnapPoint } from '@/types';

// =============================================================================
// Types
// =============================================================================

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
 * });
 * ```
 */
export function useScrubbing({
  isPlaying,
  togglePlayback,
  seek,
  calculateTimeFromMouseEvent,
  onSnapChange,
}: UseScrubbingOptions): UseScrubbingResult {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubStartRef = useRef<{ wasPlaying: boolean } | null>(null);

  // Store event handlers in refs to allow cleanup on unmount
  const handlersRef = useRef<{
    move: ((e: globalThis.MouseEvent) => void) | null;
    up: (() => void) | null;
  }>({ move: null, up: null });

  // Cleanup function to remove event listeners
  const cleanup = useCallback(() => {
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
      // Reset scrubbing state if unmounting during scrub
      if (scrubStartRef.current?.wasPlaying) {
        // Note: togglePlayback won't be called here as component is unmounting
        // This is acceptable as the component is being removed
      }
      scrubStartRef.current = null;
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

      e.preventDefault();
      setIsScrubbing(true);

      // Pause playback during scrubbing and remember state
      scrubStartRef.current = { wasPlaying: isPlaying };
      if (isPlaying) {
        togglePlayback();
      }

      // Set initial position (with snapping)
      const result = calculateTimeFromMouseEvent(e, true);
      if (result.time !== null) {
        seek(result.time);
        onSnapChange?.(result.snapPoint);
      }

      // Define event handlers
      const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
        const moveResult = calculateTimeFromMouseEvent(moveEvent, true);
        if (moveResult.time !== null) {
          seek(moveResult.time);
          onSnapChange?.(moveResult.snapPoint);
        }
      };

      const handleMouseUp = () => {
        setIsScrubbing(false);
        onSnapChange?.(null);

        // Resume playback if it was playing before scrubbing
        if (scrubStartRef.current?.wasPlaying) {
          togglePlayback();
        }
        scrubStartRef.current = null;

        // Cleanup listeners
        cleanup();
      };

      // Store handlers for potential cleanup on unmount
      handlersRef.current.move = handleMouseMove;
      handlersRef.current.up = handleMouseUp;

      // Add document-level listeners for mouse move and up
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [isPlaying, togglePlayback, calculateTimeFromMouseEvent, seek, onSnapChange, cleanup]
  );

  return {
    isScrubbing,
    handleScrubStart,
  };
}
