/**
 * useSelectionBox Hook
 *
 * Provides drag-to-select functionality for timeline clips.
 * Creates a selection box that highlights clips within the selected area.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Track } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface Point {
  x: number;
  y: number;
}

export interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UseSelectionBoxOptions {
  /** Reference to the container element */
  containerRef: React.RefObject<HTMLElement>;
  /** Track header width offset */
  trackHeaderWidth: number;
  /** Height of each track */
  trackHeight: number;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Current horizontal scroll position */
  scrollX: number;
  /** Current vertical scroll position */
  scrollY: number;
  /** Array of tracks with clips */
  tracks: Track[];
  /** Callback to update selected clip IDs */
  onSelectClips: (clipIds: string[]) => void;
  /** Currently selected clip IDs (for additive selection) */
  currentSelection?: string[];
  /** Whether selection box is enabled */
  enabled?: boolean;
}

export interface UseSelectionBoxReturn {
  /** Whether a selection is in progress */
  isSelecting: boolean;
  /** Current selection rectangle (null when not selecting) */
  selectionRect: SelectionRect | null;
  /** Handler for mouse down on container - returns true if selection started */
  handleMouseDown: (e: React.MouseEvent) => boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate normalized rectangle from two points
 */
function calculateRect(start: Point, end: Point): SelectionRect {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  return { left, top, width, height };
}

/**
 * Check if two rectangles intersect
 */
function rectsIntersect(
  rect1: SelectionRect,
  rect2: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(
    rect1.left > rect2.right ||
    rect1.left + rect1.width < rect2.left ||
    rect1.top > rect2.bottom ||
    rect1.top + rect1.height < rect2.top
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useSelectionBox({
  containerRef,
  trackHeaderWidth,
  trackHeight,
  zoom,
  scrollX,
  scrollY,
  tracks,
  onSelectClips,
  currentSelection = [],
  enabled = true,
}: UseSelectionBoxOptions): UseSelectionBoxReturn {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);
  const startPointRef = useRef<Point | null>(null);
  const isSelectingRef = useRef(false);
  const isAdditiveRef = useRef(false);
  const baseSelectionRef = useRef<string[]>([]);

  // Store layout props in ref to avoid event listener re-binding on scroll/zoom
  const layoutRef = useRef({ tracks, scrollX, scrollY, zoom });
  layoutRef.current = { tracks, scrollX, scrollY, zoom };

  /**
   * Find clips that intersect with the selection rectangle
   * Uses layoutRef to read current values without causing callback recreation
   */
  const findClipsInRect = useCallback(
    (rect: SelectionRect): string[] => {
      const { tracks: currentTracks, scrollX: currentScrollX, scrollY: currentScrollY, zoom: currentZoom } = layoutRef.current;
      const clipIds: string[] = [];

      currentTracks.forEach((track, trackIndex) => {
        const trackTop = trackIndex * trackHeight - currentScrollY;
        const trackBottom = trackTop + trackHeight;

        track.clips.forEach((clip) => {
          // Calculate clip position in pixels
          const clipLeft = clip.place.timelineInSec * currentZoom - currentScrollX + trackHeaderWidth;
          const clipDuration =
            (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
          const clipWidth = clipDuration * currentZoom;
          const clipRight = clipLeft + clipWidth;

          // Check if clip intersects with selection
          const clipBounds = {
            left: clipLeft,
            top: trackTop,
            right: clipRight,
            bottom: trackBottom,
          };

          if (rectsIntersect(rect, clipBounds)) {
            clipIds.push(clip.id);
          }
        });
      });

      return clipIds;
    },
    [trackHeaderWidth, trackHeight] // Only stable dependencies
  );

  /**
   * Handle mouse down - start selection if clicking on empty area
   * Returns true if selection started, false otherwise
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent): boolean => {
      if (!enabled || !containerRef.current) return false;

      // Only start selection on left click
      if (e.button !== 0) return false;

      // Don't start selection if clicking on a clip or control
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-testid^="clip-"]') ||
        target.closest('[data-testid="track-header"]') ||
        target.closest('button')
      ) {
        return false;
      }

      // Get container bounds
      const containerRect = containerRef.current.getBoundingClientRect();

      // Calculate start point relative to container
      const startPoint: Point = {
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      };

      // Check if Shift is held for additive selection
      isAdditiveRef.current = e.shiftKey;
      baseSelectionRef.current = e.shiftKey ? [...currentSelection] : [];

      startPointRef.current = startPoint;
      isSelectingRef.current = true;
      setIsSelecting(true);
      setSelectionRect({ left: startPoint.x, top: startPoint.y, width: 0, height: 0 });

      e.preventDefault();
      return true;
    },
    [enabled, containerRef, currentSelection]
  );

  /**
   * Handle mouse move - update selection rectangle
   */
  useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelectingRef.current || !startPointRef.current || !containerRef.current) {
        return;
      }

      const containerRect = containerRef.current.getBoundingClientRect();

      // Calculate current point relative to container
      const currentPoint: Point = {
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      };

      // Calculate and set selection rectangle
      const rect = calculateRect(startPointRef.current, currentPoint);
      setSelectionRect(rect);

      // Find clips within the rectangle
      const clipsInRect = findClipsInRect(rect);

      // Merge with base selection if additive
      let selectedClipIds: string[];
      if (isAdditiveRef.current) {
        const combined = new Set([...baseSelectionRef.current, ...clipsInRect]);
        selectedClipIds = Array.from(combined);
      } else {
        selectedClipIds = clipsInRect;
      }

      onSelectClips(selectedClipIds);
    };

    const handleMouseUp = () => {
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
        setIsSelecting(false);
        setSelectionRect(null);
        startPointRef.current = null;
      }
    };

    // Add global listeners for mouse move and up
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [enabled, containerRef, findClipsInRect, onSelectClips]);

  return {
    isSelecting,
    selectionRect,
    handleMouseDown,
  };
}
