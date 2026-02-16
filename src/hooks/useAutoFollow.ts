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
  /** Total scrollable timeline content width in pixels */
  contentWidth?: number;
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

/** Minimum allowed edge margin ratio */
const MIN_EDGE_MARGIN = 0;

/** Maximum allowed edge margin ratio */
const MAX_EDGE_MARGIN = 0.5;

/** Minimum dynamic smoothing factor */
const MIN_DYNAMIC_SMOOTHING = 0.01;

/** Maximum dynamic smoothing factor */
const MAX_DYNAMIC_SMOOTHING = 0.95;

function clampEdgeMargin(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EDGE_MARGIN;
  }

  return Math.max(MIN_EDGE_MARGIN, Math.min(MAX_EDGE_MARGIN, value));
}

function sanitizeContentWidth(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value;
}

function getMaxScrollX(contentWidth: number | null, viewportWidth: number): number | null {
  if (contentWidth === null) {
    return null;
  }

  return Math.max(0, contentWidth - viewportWidth);
}

function clampScrollX(value: number, maxScrollX: number | null): number {
  const minClamped = Number.isFinite(value) ? Math.max(0, value) : 0;

  if (maxScrollX === null) {
    return minClamped;
  }

  return Math.min(maxScrollX, minClamped);
}

function getFrameAwareSmoothing(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return SCROLL_SMOOTHING;
  }

  // Cap at 5 frames to prevent instant jumps after tab refocus or long pauses
  const frameRatio = Math.min(5, Math.max(1, elapsedMs / SCROLL_THROTTLE_MS));
  const smoothing = 1 - Math.pow(1 - SCROLL_SMOOTHING, frameRatio);
  return Math.max(MIN_DYNAMIC_SMOOTHING, Math.min(MAX_DYNAMIC_SMOOTHING, smoothing));
}

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
    contentWidth,
    // trackHeaderWidth is reserved for future use when implementing header-aware scrolling
    edgeMargin = DEFAULT_EDGE_MARGIN,
    isScrubbing = false,
    isDraggingPlayhead = false,
  } = options;

  // Store state
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const setScrollX = useTimelineStore((state) => state.setScrollX);
  const autoScrollEnabled = useEditorToolStore((state) => state.autoScrollEnabled);

  // Refs for animation
  const lastScrollTimeRef = useRef<number>(0);
  const rafIdRef = useRef<number | null>(null);
  const isLoopActiveRef = useRef<boolean>(false);
  const configRef = useRef({
    viewportWidth: Math.max(0, viewportWidth),
    edgeMargin: clampEdgeMargin(edgeMargin),
    contentWidth: sanitizeContentWidth(contentWidth),
  });

  useEffect(() => {
    configRef.current = {
      viewportWidth: Math.max(0, viewportWidth),
      edgeMargin: clampEdgeMargin(edgeMargin),
      contentWidth: sanitizeContentWidth(contentWidth),
    };
  }, [viewportWidth, edgeMargin, contentWidth]);

  /**
   * Calculate whether the playhead is outside the visible area
   * and the new scroll position if needed.
   */
  const calculateScrollPosition = useCallback((): number | null => {
    const {
      viewportWidth: activeViewportWidth,
      edgeMargin: activeEdgeMargin,
      contentWidth: activeContentWidth,
    } = configRef.current;
    if (activeViewportWidth <= 0) return null;

    const maxScrollX = getMaxScrollX(activeContentWidth, activeViewportWidth);

    const playbackState = usePlaybackStore.getState();
    const timelineState = useTimelineStore.getState();

    const currentTime = playbackState.currentTime;
    const zoom = timelineState.zoom;
    const scrollX = timelineState.scrollX;

    if (
      !Number.isFinite(currentTime) ||
      !Number.isFinite(zoom) ||
      zoom <= 0 ||
      !Number.isFinite(scrollX)
    ) {
      return null;
    }

    const playheadPixelX = currentTime * zoom;
    const visibleStart = scrollX;
    const visibleEnd = scrollX + activeViewportWidth;
    const marginPixels = activeViewportWidth * activeEdgeMargin;

    // Check if playhead is outside the visible area (with margin)
    if (playheadPixelX < visibleStart + marginPixels) {
      // Playhead is too far left - scroll left
      return clampScrollX(playheadPixelX - marginPixels, maxScrollX);
    } else if (playheadPixelX > visibleEnd - marginPixels) {
      // Playhead is too far right - scroll right
      return clampScrollX(playheadPixelX - activeViewportWidth + marginPixels, maxScrollX);
    }

    return null; // No scrolling needed
  }, []);

  /**
   * Smooth scroll animation loop
   */
  const animateScroll = useCallback(
    (now: number) => {
      if (!isLoopActiveRef.current) {
        rafIdRef.current = null;
        return;
      }

      const timeSinceLastUpdate = now - lastScrollTimeRef.current;

      // Throttle updates
      if (timeSinceLastUpdate < SCROLL_THROTTLE_MS) {
        rafIdRef.current = requestAnimationFrame(animateScroll);
        return;
      }

      lastScrollTimeRef.current = now;

      // Get current scroll and target
      const currentScrollX = useTimelineStore.getState().scrollX;
      const targetScrollX = calculateScrollPosition();
      const { viewportWidth: activeViewportWidth, contentWidth: activeContentWidth } =
        configRef.current;
      const maxScrollX = getMaxScrollX(activeContentWidth, activeViewportWidth);

      if (targetScrollX === null) {
        if (maxScrollX !== null && currentScrollX > maxScrollX) {
          setScrollX(maxScrollX);
        }
        rafIdRef.current = requestAnimationFrame(animateScroll);
        return;
      }

      // Calculate smooth transition
      const diff = targetScrollX - currentScrollX;
      if (Math.abs(diff) < 0.5) {
        // Close enough, snap to target
        setScrollX(clampScrollX(targetScrollX, maxScrollX));
        rafIdRef.current = requestAnimationFrame(animateScroll);
        return;
      }

      // Apply frame-aware smoothing for more stable motion across varying frame times
      const smoothing = getFrameAwareSmoothing(timeSinceLastUpdate);
      const newScrollX = clampScrollX(currentScrollX + diff * smoothing, maxScrollX);
      setScrollX(newScrollX);

      // Continue animation
      rafIdRef.current = requestAnimationFrame(animateScroll);
    },
    [calculateScrollPosition, setScrollX],
  );

  /**
   * Public method to manually scroll to playhead position
   */
  const scrollToPlayhead = useCallback(() => {
    const newScrollPosition = calculateScrollPosition();
    const { viewportWidth: activeViewportWidth, contentWidth: activeContentWidth } =
      configRef.current;
    const maxScrollX = getMaxScrollX(activeContentWidth, activeViewportWidth);

    if (newScrollPosition !== null) {
      // Instant scroll for manual trigger
      setScrollX(clampScrollX(newScrollPosition, maxScrollX));
    } else {
      if (activeViewportWidth <= 0) return;

      // Center playhead if it's already visible
      const { currentTime } = usePlaybackStore.getState();
      const { zoom } = useTimelineStore.getState();

      if (!Number.isFinite(currentTime) || !Number.isFinite(zoom) || zoom <= 0) {
        return;
      }

      const playheadPixelX = currentTime * zoom;
      const centeredScrollX = playheadPixelX - activeViewportWidth / 2;
      setScrollX(clampScrollX(centeredScrollX, maxScrollX));
    }
  }, [calculateScrollPosition, setScrollX]);

  const isActive =
    isPlaying && autoScrollEnabled && !isScrubbing && !isDraggingPlayhead && viewportWidth > 0;

  /**
   * Main effect for auto-follow during playback
   */
  useEffect(() => {
    isLoopActiveRef.current = isActive;

    if (!isActive) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    if (rafIdRef.current === null) {
      lastScrollTimeRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(animateScroll);
    }
  }, [isActive, animateScroll]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isLoopActiveRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    isActive,
    scrollToPlayhead,
  };
}

export default useAutoFollow;
