/**
 * useAssetDrop Hook
 *
 * Handles drag-and-drop of assets from the project explorer onto the timeline.
 * Manages drag state, drop position calculation, and track targeting.
 */

import { useState, useCallback, useRef, type DragEvent } from 'react';
import type { Sequence } from '@/types';
import type { AssetDropData } from '@/components/timeline/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('useAssetDrop');

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

      logger.debug('Drop event received', {
        hasSequence: !!sequence,
        hasCallback: !!onAssetDrop,
        dataTypes: Array.from(e.dataTransfer.types),
      });

      if (!sequence) {
        logger.warn('Drop ignored: no sequence loaded');
        return;
      }

      if (!onAssetDrop) {
        logger.warn('Drop ignored: no onAssetDrop callback');
        return;
      }

      // Try to get data from different formats
      let jsonData = e.dataTransfer.getData('application/json');
      const textData = e.dataTransfer.getData('text/plain');

      logger.debug('Drop data', { jsonData, textData });

      if (!jsonData && textData) {
        // If only text/plain available (asset ID), construct minimal object
        jsonData = JSON.stringify({ id: textData });
      }

      if (!jsonData) {
        logger.warn('Drop ignored: no valid data in dataTransfer');
        return;
      }

      try {
        const assetData = JSON.parse(jsonData);
        if (!assetData.id) {
          logger.warn('Drop ignored: parsed data has no id', { assetData });
          return;
        }

        // Calculate timeline position from X coordinate
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        if (!rect || rect.width === 0) {
          logger.warn('Drop ignored: invalid target rect', { rect });
          return;
        }

        const relativeX = e.clientX - rect.left - trackHeaderWidth + scrollX;
        const timelinePosition = Math.max(0, relativeX / zoom);

        // Calculate which track based on Y coordinate
        // Note: scrollY is subtracted because when scrolled down, the visual
        // position is higher than the actual track position
        const relativeY = e.clientY - rect.top + scrollY;
        const trackIndex = Math.floor(relativeY / trackHeight);

        logger.debug('Drop position calculated', {
          clientX: e.clientX,
          clientY: e.clientY,
          relativeX,
          relativeY,
          timelinePosition,
          trackIndex,
          scrollX,
          scrollY,
          trackCount: sequence.tracks.length,
        });

        // Validate track index bounds
        if (trackIndex < 0 || trackIndex >= sequence.tracks.length) {
          logger.warn('Drop ignored: track index out of bounds', {
            trackIndex,
            trackCount: sequence.tracks.length,
          });
          return;
        }

        const track = sequence.tracks[trackIndex];

        // Don't allow drop on locked tracks
        if (track.locked) {
          logger.warn('Drop ignored: track is locked', { trackId: track.id });
          return;
        }

        logger.info('Asset drop accepted', {
          assetId: assetData.id,
          trackId: track.id,
          timelinePosition,
        });

        onAssetDrop({
          assetId: assetData.id,
          trackId: track.id,
          timelinePosition,
        });
      } catch (error) {
        logger.error('Drop failed: JSON parse error', { error, jsonData });
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
