/**
 * useEdgeAutoScroll Hook
 *
 * Automatically scrolls the timeline when dragging near the edges.
 * This provides a better user experience when dragging clips or the playhead
 * beyond the visible viewport area.
 *
 * Inspired by OpenCut's implementation.
 *
 * @module hooks/useEdgeAutoScroll
 */

import { useEffect, useRef, useCallback } from 'react';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for the useEdgeAutoScroll hook.
 */
export interface UseEdgeAutoScrollOptions {
  /** Whether auto-scroll should be active (e.g., during drag operations) */
  isActive: boolean;
  /** Function to get the current mouse X position (client coordinates) */
  getMouseClientX: () => number;
  /** Reference to the scrollable container for the ruler/content */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /** Total content width in pixels */
  contentWidth: number;
  /** Callback when scroll position changes */
  onScrollChange?: (scrollLeft: number) => void;
}

/**
 * Result returned by useEdgeAutoScroll hook.
 */
export interface UseEdgeAutoScrollResult {
  /** Whether auto-scroll is currently active (scrolling is happening) */
  isAutoScrolling: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Zone width at edges that triggers auto-scroll (in pixels) */
const EDGE_ZONE_PX = 50;

/** Base scroll speed (pixels per frame at 60fps) */
const BASE_SCROLL_SPEED = 8;

/** Maximum scroll speed multiplier at edge */
const MAX_SPEED_MULTIPLIER = 3;

/** Minimum scroll speed multiplier at zone boundary */
const MIN_SPEED_MULTIPLIER = 0.5;

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for automatic edge scrolling during drag operations.
 *
 * When the mouse is near the left or right edge of the container during
 * an active drag operation, this hook will automatically scroll the
 * container in that direction at a speed proportional to how close
 * the mouse is to the edge.
 *
 * @param options - Auto-scroll configuration
 * @returns Object containing auto-scroll state
 *
 * @example
 * ```tsx
 * const { isAutoScrolling } = useEdgeAutoScroll({
 *   isActive: isDragging,
 *   getMouseClientX: () => mouseXRef.current,
 *   scrollContainerRef: tracksScrollRef,
 *   contentWidth: duration * zoom,
 *   onScrollChange: setScrollX,
 * });
 * ```
 */
export function useEdgeAutoScroll({
  isActive,
  getMouseClientX,
  scrollContainerRef,
  contentWidth,
  onScrollChange,
}: UseEdgeAutoScrollOptions): UseEdgeAutoScrollResult {
  const rafIdRef = useRef<number | null>(null);
  const isAutoScrollingRef = useRef(false);

  /**
   * Calculate scroll speed based on mouse position within edge zone.
   * Returns negative for left scroll, positive for right scroll, 0 for no scroll.
   */
  const calculateScrollSpeed = useCallback(
    (mouseClientX: number): number => {
      const container = scrollContainerRef.current;
      if (!container) return 0;

      const rect = container.getBoundingClientRect();
      const viewportWidth = rect.width;
      const maxScroll = Math.max(0, contentWidth - viewportWidth);
      const currentScroll = container.scrollLeft;

      // Check left edge
      const distanceFromLeft = mouseClientX - rect.left;
      if (distanceFromLeft < EDGE_ZONE_PX && currentScroll > 0) {
        // Calculate speed multiplier based on how close to edge (closer = faster)
        const normalizedDistance = distanceFromLeft / EDGE_ZONE_PX;
        const speedMultiplier =
          MAX_SPEED_MULTIPLIER -
          normalizedDistance * (MAX_SPEED_MULTIPLIER - MIN_SPEED_MULTIPLIER);
        return -BASE_SCROLL_SPEED * speedMultiplier;
      }

      // Check right edge
      const distanceFromRight = rect.right - mouseClientX;
      if (distanceFromRight < EDGE_ZONE_PX && currentScroll < maxScroll) {
        // Calculate speed multiplier based on how close to edge (closer = faster)
        const normalizedDistance = distanceFromRight / EDGE_ZONE_PX;
        const speedMultiplier =
          MAX_SPEED_MULTIPLIER -
          normalizedDistance * (MAX_SPEED_MULTIPLIER - MIN_SPEED_MULTIPLIER);
        return BASE_SCROLL_SPEED * speedMultiplier;
      }

      return 0;
    },
    [scrollContainerRef, contentWidth]
  );

  /**
   * Animation frame callback for continuous scrolling.
   */
  const tick = useCallback(() => {
    if (!isActive) {
      isAutoScrollingRef.current = false;
      rafIdRef.current = null;
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      rafIdRef.current = requestAnimationFrame(tick);
      return;
    }

    const mouseX = getMouseClientX();
    const scrollSpeed = calculateScrollSpeed(mouseX);

    if (scrollSpeed !== 0) {
      const viewportWidth = container.clientWidth;
      const maxScroll = Math.max(0, contentWidth - viewportWidth);
      const newScrollLeft = Math.max(0, Math.min(maxScroll, container.scrollLeft + scrollSpeed));

      if (newScrollLeft !== container.scrollLeft) {
        container.scrollLeft = newScrollLeft;
        onScrollChange?.(newScrollLeft);
        isAutoScrollingRef.current = true;
      }
    } else {
      isAutoScrollingRef.current = false;
    }

    // Continue the loop while active
    rafIdRef.current = requestAnimationFrame(tick);
  }, [isActive, scrollContainerRef, getMouseClientX, calculateScrollSpeed, contentWidth, onScrollChange]);

  // Start/stop the animation loop based on isActive
  useEffect(() => {
    if (isActive) {
      rafIdRef.current = requestAnimationFrame(tick);
    } else {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      isAutoScrollingRef.current = false;
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isActive, tick]);

  return {
    isAutoScrolling: isAutoScrollingRef.current,
  };
}
