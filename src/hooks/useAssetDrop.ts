/**
 * useAssetDrop Hook
 *
 * Handles drag-and-drop of assets from the project explorer onto the timeline.
 * Manages drag state, drop position calculation, and track targeting.
 */

import { useState, useCallback, useRef, type DragEvent } from 'react';
import type { Sequence, Asset, AssetKind } from '@/types';
import type { AssetDropData } from '@/components/timeline/types';
import { isAssetCompatibleWithTrack } from '@/utils/dropValidity';
import { resolveTrackDropTarget } from '@/utils/trackDropTarget';
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
  /** Project assets map for asset-kind lookup by ID */
  assets?: Map<string, Asset>;
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

const SUPPORTED_ASSET_KINDS: ReadonlySet<AssetKind> = new Set([
  'video',
  'audio',
  'image',
  'subtitle',
  'font',
  'effectPreset',
  'memePack',
]);

interface ParsedAssetDragData {
  id: string;
  kind?: AssetKind;
}

function hasSupportedDataType(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes('application/json') || dataTransfer.types.includes('text/plain')
  );
}

function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && SUPPORTED_ASSET_KINDS.has(value as AssetKind);
}

function parseDraggedAssetData(dataTransfer: DataTransfer): ParsedAssetDragData | null {
  let jsonData = dataTransfer.getData('application/json');
  const textData = dataTransfer.getData('text/plain');

  if (!jsonData && textData) {
    jsonData = JSON.stringify({ id: textData });
  }

  if (!jsonData) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonData) as { id?: unknown; kind?: unknown };
    if (typeof parsed.id !== 'string') {
      return null;
    }
    const id = parsed.id.trim();
    if (id.length === 0) {
      return null;
    }

    return {
      id,
      kind: isAssetKind(parsed.kind) ? parsed.kind : undefined,
    };
  } catch {
    return null;
  }
}

function resolveAssetKind(
  parsedData: ParsedAssetDragData,
  assets: Map<string, Asset> | undefined,
): AssetKind | undefined {
  if (parsedData.kind) {
    return parsedData.kind;
  }

  return assets?.get(parsedData.id)?.kind;
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
  assets,
}: UseAssetDropOptions): UseAssetDropResult {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (hasSupportedDataType(e.dataTransfer)) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragOver = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!hasSupportedDataType(e.dataTransfer)) {
        return;
      }

      // Default to copy; we'll switch to none for invalid targets.
      e.dataTransfer.dropEffect = 'copy';

      if (!sequence) {
        return;
      }

      const target = e.currentTarget as HTMLElement;
      const resolvedTarget = resolveTrackDropTarget({
        sequence,
        container: target,
        clientY: e.clientY,
        scrollY,
        fallbackTrackHeight: trackHeight,
      });

      if (!resolvedTarget) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      if (resolvedTarget.track.locked) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      const parsedData = parseDraggedAssetData(e.dataTransfer);
      if (!parsedData) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }

      const assetKind = resolveAssetKind(parsedData, assets);
      if (assetKind && !isAssetCompatibleWithTrack(assetKind, resolvedTarget.track.kind)) {
        e.dataTransfer.dropEffect = 'none';
      }
    },
    [sequence, scrollY, trackHeight, assets],
  );

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

      const parsedData = parseDraggedAssetData(e.dataTransfer);

      logger.debug('Drop data parsed', {
        parsedData,
      });

      if (!parsedData) {
        logger.warn('Drop ignored: no valid data in dataTransfer');
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

      const dropTarget = resolveTrackDropTarget({
        sequence,
        container: target,
        clientY: e.clientY,
        scrollY,
        fallbackTrackHeight: trackHeight,
      });

      if (!dropTarget) {
        logger.warn('Drop ignored: unable to resolve target track', {
          clientY: e.clientY,
          trackCount: sequence.tracks.length,
        });
        return;
      }

      const { track, trackIndex } = dropTarget;

      logger.debug('Drop position calculated', {
        clientX: e.clientX,
        clientY: e.clientY,
        relativeX,
        timelinePosition,
        trackIndex,
        trackId: track.id,
        scrollX,
        scrollY,
        trackCount: sequence.tracks.length,
      });

      // Don't allow drop on locked tracks
      if (track.locked) {
        logger.warn('Drop ignored: track is locked', { trackId: track.id });
        return;
      }

      const assetKind = resolveAssetKind(parsedData, assets);
      if (assetKind && !isAssetCompatibleWithTrack(assetKind, track.kind)) {
        logger.warn('Drop ignored: incompatible asset type for target track', {
          assetId: parsedData.id,
          assetKind,
          trackId: track.id,
          trackKind: track.kind,
        });
        return;
      }

      logger.info('Asset drop accepted', {
        assetId: parsedData.id,
        trackId: track.id,
        timelinePosition,
      });

      onAssetDrop({
        assetId: parsedData.id,
        trackId: track.id,
        timelinePosition,
      });
    },
    [sequence, onAssetDrop, scrollX, scrollY, zoom, trackHeaderWidth, trackHeight, assets],
  );

  return {
    isDraggingOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
