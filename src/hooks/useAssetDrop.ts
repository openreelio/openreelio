/**
 * useAssetDrop Hook
 *
 * Handles drag-and-drop of assets from the project explorer onto the timeline.
 * Manages drag state, drop position calculation, and track targeting.
 */

import { useState, useCallback, useRef, type DragEvent } from 'react';
import type { Sequence } from '@/types';
import type { AssetDropData } from '@/components/timeline/types';

// Re-export for convenience
export type { AssetDropData } from '@/components/timeline/types';

export interface UseAssetDropOptions {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset */
  scrollX: number;
  /** Vertical scroll offset */
  scrollY: number;
  /** Track header width in pixels */
  trackHeaderWidth: number;
  /** Track height in pixels */
  trackHeight: number;
  /** Callback when asset is dropped */
  onAssetDrop?: (data: AssetDropData) => void;
}

export interface UseAssetDropResult {
  /** Whether an asset is being dragged over the timeline */
  isDraggingOver: boolean;
  /** Handler for drag enter */
  handleDragEnter: (e: DragEvent) => void;
  /** Handler for drag over */
  handleDragOver: (e: DragEvent) => void;
  /** Handler for drag leave */
  handleDragLeave: (e: DragEvent) => void;
  /** Handler for drop */
  handleDrop: (e: DragEvent) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for handling asset drag-and-drop onto the timeline.
 *
 * @param options - Drop handling options
 * @returns Drop state and event handlers
 *
 * @example
 * ```tsx
 * const { isDraggingOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } =
 *   useAssetDrop({
 *     sequence,
 *     zoom,
 *     scrollX,
 *     scrollY,
 *     trackHeaderWidth: TRACK_HEADER_WIDTH,
 *     trackHeight: TRACK_HEIGHT,
 *     onAssetDrop,
 *   });
 * ```
 */
export function useAssetDrop({
  sequence,
  zoom,
  scrollX,
  scrollY,
  trackHeaderWidth,
  trackHeight,
  onAssetDrop,
}: UseAssetDropOptions): UseAssetDropResult {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (
      e.dataTransfer.types.includes('application/json') ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      e.dataTransfer.types.includes('application/json') ||
      e.dataTransfer.types.includes('text/plain')
    ) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);

      if (!sequence || !onAssetDrop) {
        return;
      }

      // Try to get data from different formats
      let jsonData = e.dataTransfer.getData('application/json');
      const textData = e.dataTransfer.getData('text/plain');

      if (!jsonData && textData) {
        // If only text/plain available (asset ID), construct minimal object
        jsonData = JSON.stringify({ id: textData });
      }

      if (!jsonData) {
        return;
      }

      try {
        const assetData = JSON.parse(jsonData);
        if (!assetData.id) return;

        // Calculate timeline position from X coordinate
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width === 0) return;

        const relativeX = e.clientX - rect.left - trackHeaderWidth + scrollX;
        const timelinePosition = Math.max(0, relativeX / zoom);

        // Calculate which track based on Y coordinate
        const relativeY = e.clientY - rect.top + scrollY;
        const trackIndex = Math.floor(relativeY / trackHeight);
        const track = sequence.tracks[trackIndex];

        // Don't allow drop on locked tracks
        if (!track || track.locked) {
          return;
        }

        onAssetDrop({
          assetId: assetData.id,
          trackId: track.id,
          timelinePosition,
        });
      } catch {
        // Invalid JSON data - silently ignore
      }
    },
    [sequence, onAssetDrop, scrollX, scrollY, zoom, trackHeaderWidth, trackHeight]
  );

  return {
    isDraggingOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
