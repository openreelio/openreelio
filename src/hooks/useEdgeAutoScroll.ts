/**
 * useEdgeAutoScroll Hook
 *
 * Provides automatic scrolling when cursor approaches timeline edges during drag operations.
 * Enhanced with patterns from Remotion's TimelineDragHandler for production-grade UX.
 *
 * Features:
 * - Velocity-based scrolling (faster near edges)
 * - Direction change callbacks for visual feedback
 * - Smooth RAF-based animation with delta time
 * - Support for both container-based and delta-based scrolling
 *
 * @module hooks/useEdgeAutoScroll
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { createLogger } from '@/services/logger';

const logger = createLogger('useEdgeAutoScroll');

// =============================================================================
// Types
// =============================================================================

/** Scroll direction indicator */
export type ScrollDirection = 'left' | 'right' | null;

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
  /** Callback when scroll position changes (receives new absolute position) */
  onScrollChange?: (scrollLeft: number) => void;
  /** Callback when scroll position changes (receives delta) - alternative API */
  onScrollDelta?: (deltaX: number) => void;
  /** Callback when scroll direction changes (for visual indicators) */
  onDirectionChange?: (direction: ScrollDirection) => void;
  /** Width of edge trigger zone in pixels (default: 50) */
  edgeZonePx?: number;
  /** Base scroll speed in pixels per second (default: 150) */
  baseSpeedPxPerSec?: number;
  /** Maximum scroll speed in pixels per second (default: 600) */
  maxSpeedPxPerSec?: number;
}

/**
 * Result returned by useEdgeAutoScroll hook.
 */
export interface UseEdgeAutoScrollResult {
  /** Whether auto-scroll is currently active (scrolling is happening) */
  isAutoScrolling: boolean;
  /** Current scroll direction */
  scrollDirection: ScrollDirection;
  /** Current scroll velocity (pixels per second, negative for left) */
  scrollVelocity: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default zone width at edges that triggers auto-scroll (in pixels) */
const DEFAULT_EDGE_ZONE_PX = 50;

/** Default base scroll speed (pixels per second) */
const DEFAULT_BASE_SPEED_PX_PER_SEC = 150;

/** Default maximum scroll speed (pixels per second) */
const DEFAULT_MAX_SPEED_PX_PER_SEC = 600;

/** Minimum time between updates (ms) to ensure smooth animation */
const MIN_UPDATE_INTERVAL_MS = 8;

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
 * Uses delta-time based velocity calculation for frame-rate independent scrolling.
 *
 * @param options - Auto-scroll configuration
 * @returns Object containing auto-scroll state
 *
 * @example
 * ```tsx
 * const { isAutoScrolling, scrollDirection } = useEdgeAutoScroll({
 *   isActive: isDragging,
 *   getMouseClientX: () => mouseXRef.current,
 *   scrollContainerRef: tracksScrollRef,
 *   contentWidth: duration * zoom,
 *   onScrollChange: setScrollX,
 *   onDirectionChange: (dir) => setShowEdgeIndicator(dir),
 * });
 * ```
 */
export function useEdgeAutoScroll({
  isActive,
  getMouseClientX,
  scrollContainerRef,
  contentWidth,
  onScrollChange,
  onScrollDelta,
  onDirectionChange,
  edgeZonePx = DEFAULT_EDGE_ZONE_PX,
  baseSpeedPxPerSec = DEFAULT_BASE_SPEED_PX_PER_SEC,
  maxSpeedPxPerSec = DEFAULT_MAX_SPEED_PX_PER_SEC,
}: UseEdgeAutoScrollOptions): UseEdgeAutoScrollResult {
  const rafIdRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const isAutoScrollingRef = useRef(false);
  const currentDirectionRef = useRef<ScrollDirection>(null);
  const currentVelocityRef = useRef<number>(0);

  // Reactive state for external consumers
  const [scrollDirection, setScrollDirection] = useState<ScrollDirection>(null);
  const [scrollVelocity, setScrollVelocity] = useState<number>(0);

  /**
   * Calculate scroll velocity based on mouse position within edge zone.
   * Uses physics-based velocity (pixels per second) for frame-rate independence.
   * Returns negative for left scroll, positive for right scroll, 0 for no scroll.
   */
  const calculateVelocity = useCallback(
    (mouseClientX: number): { direction: ScrollDirection; velocity: number } => {
      const container = scrollContainerRef.current;
      if (!container) return { direction: null, velocity: 0 };

      const rect = container.getBoundingClientRect();
      const viewportWidth = rect.width;
      const maxScroll = Math.max(0, contentWidth - viewportWidth);
      const currentScroll = container.scrollLeft;

      // Check left edge
      const distanceFromLeft = mouseClientX - rect.left;
      if (distanceFromLeft < edgeZonePx && currentScroll > 0) {
        // Proximity: 1.0 at edge, 0.0 at zone boundary
        const proximity = Math.max(0, Math.min(1, 1 - distanceFromLeft / edgeZonePx));
        // Exponential curve for more natural acceleration feel
        const velocityFactor = proximity * proximity;
        const velocity = -(baseSpeedPxPerSec + velocityFactor * (maxSpeedPxPerSec - baseSpeedPxPerSec));
        return { direction: 'left', velocity };
      }

      // Check right edge
      const distanceFromRight = rect.right - mouseClientX;
      if (distanceFromRight < edgeZonePx && currentScroll < maxScroll) {
        // Proximity: 1.0 at edge, 0.0 at zone boundary
        const proximity = Math.max(0, Math.min(1, 1 - distanceFromRight / edgeZonePx));
        // Exponential curve for more natural acceleration feel
        const velocityFactor = proximity * proximity;
        const velocity = baseSpeedPxPerSec + velocityFactor * (maxSpeedPxPerSec - baseSpeedPxPerSec);
        return { direction: 'right', velocity };
      }

      return { direction: null, velocity: 0 };
    },
    [scrollContainerRef, contentWidth, edgeZonePx, baseSpeedPxPerSec, maxSpeedPxPerSec]
  );

  /**
   * Animation frame callback for continuous scrolling.
   * Uses delta time for frame-rate independent animation.
   */
  const tick = useCallback(
    (currentTime: number) => {
      if (!isActive) {
        isAutoScrollingRef.current = false;
        currentDirectionRef.current = null;
        currentVelocityRef.current = 0;
        rafIdRef.current = null;
        return;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      // Calculate delta time (clamped to prevent jumps after tab switch)
      const deltaTime = Math.min(
        (currentTime - lastTimeRef.current) / 1000,
        0.1 // Max 100ms delta to prevent huge jumps
      );
      lastTimeRef.current = currentTime;

      // Skip frame if delta is too small
      if (deltaTime < MIN_UPDATE_INTERVAL_MS / 1000) {
        rafIdRef.current = requestAnimationFrame(tick);
        return;
      }

      const mouseX = getMouseClientX();
      const { direction, velocity } = calculateVelocity(mouseX);

      // Handle direction change
      if (direction !== currentDirectionRef.current) {
        currentDirectionRef.current = direction;
        setScrollDirection(direction);
        onDirectionChange?.(direction);

        if (direction !== null) {
          logger.debug('Edge scroll started', { direction, velocity: Math.round(velocity) });
        } else {
          logger.debug('Edge scroll stopped');
        }
      }

      currentVelocityRef.current = velocity;
      setScrollVelocity(velocity);

      if (velocity !== 0) {
        const scrollDelta = velocity * deltaTime;
        const viewportWidth = container.clientWidth;
        const maxScroll = Math.max(0, contentWidth - viewportWidth);
        const newScrollLeft = Math.max(
          0,
          Math.min(maxScroll, container.scrollLeft + scrollDelta)
        );

        if (Math.abs(newScrollLeft - container.scrollLeft) > 0.5) {
          container.scrollLeft = newScrollLeft;
          onScrollChange?.(newScrollLeft);
          onScrollDelta?.(scrollDelta);
          isAutoScrollingRef.current = true;
        }
      } else {
        isAutoScrollingRef.current = false;
      }

      // Continue the loop while active
      rafIdRef.current = requestAnimationFrame(tick);
    },
    [
      isActive,
      scrollContainerRef,
      getMouseClientX,
      calculateVelocity,
      contentWidth,
      onScrollChange,
      onScrollDelta,
      onDirectionChange,
    ]
  );

  // Start/stop the animation loop based on isActive
  useEffect(() => {
    if (isActive) {
      lastTimeRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(tick);
    } else {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      isAutoScrollingRef.current = false;

      // Reset direction when deactivated
      if (currentDirectionRef.current !== null) {
        currentDirectionRef.current = null;
        currentVelocityRef.current = 0;
        setScrollDirection(null);
        setScrollVelocity(0);
        onDirectionChange?.(null);
      }
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isActive, tick, onDirectionChange]);

  return {
    isAutoScrolling: isAutoScrollingRef.current,
    scrollDirection,
    scrollVelocity,
  };
}

// =============================================================================
// Edge Scroll Indicator Component Helper
// =============================================================================

/**
 * Gets CSS class name for edge scroll indicator based on direction.
 * Useful for showing visual feedback during edge scrolling.
 *
 * @param direction - Current scroll direction
 * @returns CSS class name suffix
 */
export function getEdgeScrollIndicatorClass(direction: ScrollDirection): string {
  switch (direction) {
    case 'left':
      return 'edge-scroll-left';
    case 'right':
      return 'edge-scroll-right';
    default:
      return '';
  }
}

/**
 * Gets edge scroll indicator position and visibility.
 *
 * @param direction - Current scroll direction
 * @returns Position ('left' | 'right') and visibility
 */
export function getEdgeScrollIndicatorState(direction: ScrollDirection): {
  visible: boolean;
  position: 'left' | 'right' | null;
} {
  return {
    visible: direction !== null,
    position: direction,
  };
}
