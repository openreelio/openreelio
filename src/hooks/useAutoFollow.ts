/**
 * useAutoFollow Hook
 *
 * Automatically scrolls the timeline to keep the playhead visible during playback.
 * Implements smooth auto-scroll behavior similar to professional NLEs.
 *
 * @module hooks/useAutoFollow
 */

import { useEffect, useRef, useCallback } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useEditorToolStore } from '@/stores/editorToolStore';

// =============================================================================
// Types
// =============================================================================

export interface UseAutoFollowOptions {
  /** Viewport width in pixels (excluding track headers) */
  viewportWidth: number;
  /** Track header width in pixels */
  trackHeaderWidth?: number;
  /** Margin from edge before scrolling (as percentage of viewport, 0-0.5) */
  edgeMargin?: number;
  /** Whether user is currently scrubbing */
  isScrubbing?: boolean;
  /** Whether user is currently dragging the playhead */
  isDraggingPlayhead?: boolean;
}

export interface UseAutoFollowReturn {
  /** Whether auto-follow is currently active */
  isActive: boolean;
  /** Manually trigger scroll to playhead */
  scrollToPlayhead: () => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Default margin from edge (20% of viewport) */
const DEFAULT_EDGE_MARGIN = 0.2;

/** Minimum time between scroll updates (ms) */
const SCROLL_THROTTLE_MS = 16; // ~60fps

/** Animation smoothing factor for scroll (higher = faster) */
const SCROLL_SMOOTHING = 0.15;

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for automatic timeline scrolling during playback.
 *
 * Features:
 * - Keeps playhead visible within configurable margin
 * - Smooth scrolling animation
 * - Pauses when user is interacting (scrubbing, dragging)
 * - Respects auto-scroll toggle setting
 *
 * @example
 * ```tsx
 * const { isActive, scrollToPlayhead } = useAutoFollow({
 *   viewportWidth: 800,
 *   trackHeaderWidth: 192,
 * });
 * ```
 */
export function useAutoFollow(options: UseAutoFollowOptions): UseAutoFollowReturn {
  const {
    viewportWidth,
    // trackHeaderWidth is reserved for future use when implementing header-aware scrolling
    edgeMargin = DEFAULT_EDGE_MARGIN,
    isScrubbing = false,
    isDraggingPlayhead = false,
  } = options;

  // Store state
  const { isPlaying, currentTime } = usePlaybackStore();
  const { zoom, scrollX, setScrollX } = useTimelineStore();
  const { autoScrollEnabled } = useEditorToolStore();

  // Refs for animation
  const lastScrollTimeRef = useRef<number>(0);
  const targetScrollXRef = useRef<number>(scrollX);
  const rafIdRef = useRef<number | null>(null);

  /**
   * Calculate whether the playhead is outside the visible area
   * and the new scroll position if needed.
   */
  const calculateScrollPosition = useCallback((): number | null => {
    if (viewportWidth <= 0) return null;

    const playheadPixelX = currentTime * zoom;
    const visibleStart = scrollX;
    const visibleEnd = scrollX + viewportWidth;
    const marginPixels = viewportWidth * edgeMargin;

    // Check if playhead is outside the visible area (with margin)
    if (playheadPixelX < visibleStart + marginPixels) {
      // Playhead is too far left - scroll left
      return Math.max(0, playheadPixelX - marginPixels);
    } else if (playheadPixelX > visibleEnd - marginPixels) {
      // Playhead is too far right - scroll right
      return playheadPixelX - viewportWidth + marginPixels;
    }

    return null; // No scrolling needed
  }, [currentTime, zoom, scrollX, viewportWidth, edgeMargin]);

  /**
   * Smooth scroll animation loop
   */
  const animateScroll = useCallback(() => {
    const now = performance.now();
    const timeSinceLastUpdate = now - lastScrollTimeRef.current;

    // Throttle updates
    if (timeSinceLastUpdate < SCROLL_THROTTLE_MS) {
      rafIdRef.current = requestAnimationFrame(animateScroll);
      return;
    }

    lastScrollTimeRef.current = now;

    // Get current scroll and target
    const currentScrollX = useTimelineStore.getState().scrollX;
    const targetScrollX = targetScrollXRef.current;

    // Calculate smooth transition
    const diff = targetScrollX - currentScrollX;
    if (Math.abs(diff) < 1) {
      // Close enough, snap to target
      setScrollX(targetScrollX);
      rafIdRef.current = null;
      return;
    }

    // Apply smoothing
    const newScrollX = currentScrollX + diff * SCROLL_SMOOTHING;
    setScrollX(newScrollX);

    // Continue animation
    rafIdRef.current = requestAnimationFrame(animateScroll);
  }, [setScrollX]);

  /**
   * Public method to manually scroll to playhead position
   */
  const scrollToPlayhead = useCallback(() => {
    const newScrollPosition = calculateScrollPosition();
    if (newScrollPosition !== null) {
      // Instant scroll for manual trigger
      setScrollX(newScrollPosition);
    } else {
      // Center playhead if it's already visible
      const playheadPixelX = currentTime * zoom;
      const centeredScrollX = Math.max(0, playheadPixelX - viewportWidth / 2);
      setScrollX(centeredScrollX);
    }
  }, [calculateScrollPosition, currentTime, zoom, viewportWidth, setScrollX]);

  /**
   * Main effect for auto-follow during playback
   */
  useEffect(() => {
    // Don't auto-scroll if:
    // - Not playing
    // - Auto-scroll is disabled
    // - User is interacting with playhead
    if (!isPlaying || !autoScrollEnabled || isScrubbing || isDraggingPlayhead) {
      // Cancel any pending animation
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    // Check if we need to scroll
    const newScrollPosition = calculateScrollPosition();
    if (newScrollPosition !== null) {
      targetScrollXRef.current = newScrollPosition;

      // Start animation if not already running
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(animateScroll);
      }
    }

    // Cleanup
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    isPlaying,
    autoScrollEnabled,
    isScrubbing,
    isDraggingPlayhead,
    currentTime,
    calculateScrollPosition,
    animateScroll,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    isActive: isPlaying && autoScrollEnabled && !isScrubbing && !isDraggingPlayhead,
    scrollToPlayhead,
  };
}

export default useAutoFollow;
