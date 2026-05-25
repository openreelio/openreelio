/**
 * useAssetDrop Hook
 *
 * Handles drag-and-drop of assets from the project explorer onto the timeline.
 * Manages drag state, drop position calculation, and track targeting.
 */

import { useState, useCallback, useEffect, useRef, type DragEvent, type RefObject } from 'react';
import type { Sequence, Asset, AssetKind } from '@/types';
import type { AssetDropData } from '@/components/timeline/types';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { isAssetCompatibleWithTrack } from '@/utils/dropValidity';
import { resolveTrackDropTarget } from '@/utils/trackDropTarget';
import { createLogger } from '@/services/logger';
import {
  TIMELINE_ASSET_DRAG_CANCEL_EVENT,
  TIMELINE_ASSET_DRAG_END_EVENT,
  TIMELINE_ASSET_DRAG_MOVE_EVENT,
  isTimelineAssetDragCustomEvent,
  type TimelineAssetDragPayload,
} from '@/utils/timelineAssetDrag';

const logger = createLogger('useAssetDrop');
const SOURCE_MONITOR_DRAG_TYPE = 'application/x-openreelio-source';

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
  /** Timeline drop container used by pointer-driven in-app drags */
  dropContainerRef?: RefObject<HTMLElement | null>;
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
  assetId?: string;
  workspaceRelativePath?: string;
  kind?: AssetKind;
  editMode?: AssetDropData['editMode'];
  sourceIn?: number;
  sourceOut?: number;
}

function hasSupportedDataType(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes(SOURCE_MONITOR_DRAG_TYPE) ||
    dataTransfer.types.includes('application/json') ||
    dataTransfer.types.includes('text/plain') ||
    dataTransfer.types.includes('application/x-workspace-file')
  );
}

function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && SUPPORTED_ASSET_KINDS.has(value as AssetKind);
}

function normalizeOptionalTimeSec(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function isEditMode(value: unknown): value is NonNullable<AssetDropData['editMode']> {
  return value === 'insert' || value === 'overwrite';
}

function parseDraggedAssetData(dataTransfer: DataTransfer): ParsedAssetDragData | null {
  let jsonData = dataTransfer.getData(SOURCE_MONITOR_DRAG_TYPE);
  if (!jsonData) {
    jsonData = dataTransfer.getData('application/json');
  }
  const textData = dataTransfer.getData('text/plain');
  const workspaceFileData = dataTransfer.getData('application/x-workspace-file');

  if (!jsonData && workspaceFileData) {
    jsonData = JSON.stringify({ workspaceRelativePath: workspaceFileData });
  }

  if (!jsonData && textData) {
    jsonData = JSON.stringify({ id: textData });
  }

  if (!jsonData) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonData) as {
      id?: unknown;
      assetId?: unknown;
      workspaceRelativePath?: unknown;
      kind?: unknown;
      editMode?: unknown;
      sourceIn?: unknown;
      sourceOut?: unknown;
      inPoint?: unknown;
      outPoint?: unknown;
    };

    const normalizedAssetIdValue =
      typeof parsed.id === 'string'
        ? parsed.id
        : typeof parsed.assetId === 'string'
          ? parsed.assetId
          : undefined;
    const assetId = normalizedAssetIdValue?.trim();

    const normalizedWorkspacePathValue =
      typeof parsed.workspaceRelativePath === 'string'
        ? parsed.workspaceRelativePath
        : typeof workspaceFileData === 'string' && workspaceFileData.length > 0
          ? workspaceFileData
          : undefined;
    const workspaceRelativePath = normalizedWorkspacePathValue?.trim();

    if (!assetId && !workspaceRelativePath) {
      return null;
    }

    const sourceIn = normalizeOptionalTimeSec(parsed.sourceIn ?? parsed.inPoint);
    const sourceOut = normalizeOptionalTimeSec(parsed.sourceOut ?? parsed.outPoint);
    const hasInvalidBoundedRange =
      sourceIn !== undefined && sourceOut !== undefined && sourceOut <= sourceIn;

    return {
      ...(assetId ? { assetId } : {}),
      ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
      kind: isAssetKind(parsed.kind) ? parsed.kind : undefined,
      editMode: isEditMode(parsed.editMode) ? parsed.editMode : undefined,
      ...(sourceIn !== undefined && !hasInvalidBoundedRange ? { sourceIn } : {}),
      ...(sourceOut !== undefined && !hasInvalidBoundedRange ? { sourceOut } : {}),
    };
  } catch {
    if (workspaceFileData.trim().length > 0) {
      return { workspaceRelativePath: workspaceFileData.trim() };
    }
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

  if (!parsedData.assetId) {
    return undefined;
  }

  return assets?.get(parsedData.assetId)?.kind;
}

function parseTimelineAssetDragPayload(
  payload: TimelineAssetDragPayload,
): ParsedAssetDragData | null {
  const assetId = payload.assetId?.trim();
  const workspaceRelativePath = payload.workspaceRelativePath?.trim();

  if (!assetId && !workspaceRelativePath) {
    return null;
  }

  return {
    ...(assetId ? { assetId } : {}),
    ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
    ...(payload.assetKind ? { kind: payload.assetKind } : {}),
    ...(payload.editMode ? { editMode: payload.editMode } : {}),
    ...(payload.sourceIn !== undefined ? { sourceIn: payload.sourceIn } : {}),
    ...(payload.sourceOut !== undefined ? { sourceOut: payload.sourceOut } : {}),
  };
}

function isPointInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
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
  dropContainerRef,
}: UseAssetDropOptions): UseAssetDropResult {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const applyParsedAssetDrop = useCallback(
    (
      parsedData: ParsedAssetDragData,
      container: HTMLElement,
      clientX: number,
      clientY: number,
      source: 'html5' | 'pointer',
    ) => {
      if (!sequence) {
        logger.warn('Drop ignored: no sequence loaded');
        return false;
      }

      if (!onAssetDrop) {
        logger.warn('Drop ignored: no onAssetDrop callback');
        return false;
      }

      if (!parsedData.assetId && !parsedData.workspaceRelativePath) {
        logger.warn(
          'Drop ignored: parsed drop data missing both assetId and workspaceRelativePath',
        );
        return false;
      }

      const rect = container.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        logger.warn('Drop ignored: invalid target rect', { rect });
        return false;
      }

      const relativeX = clientX - rect.left - trackHeaderWidth + scrollX;
      const timelinePosition = Math.max(0, relativeX / zoom);

      const dropTarget = resolveTrackDropTarget({
        sequence,
        container,
        clientY,
        scrollY,
        fallbackTrackHeight: trackHeight,
      });

      if (!dropTarget) {
        logger.warn('Drop ignored: unable to resolve target track', {
          clientY,
          trackCount: sequence.tracks.length,
          source,
        });
        return false;
      }

      const { track, trackIndex } = dropTarget;

      logger.debug('Drop position calculated', {
        clientX,
        clientY,
        relativeX,
        timelinePosition,
        trackIndex,
        trackId: track.id,
        scrollX,
        scrollY,
        trackCount: sequence.tracks.length,
        source,
      });

      if (track.locked) {
        logger.warn('Drop ignored: track is locked', { trackId: track.id, source });
        return false;
      }

      const assetKind = resolveAssetKind(parsedData, assets);
      if (assetKind && !isAssetCompatibleWithTrack(assetKind, track.kind)) {
        logger.warn('Drop ignored: incompatible asset type for target track', {
          assetId: parsedData.assetId,
          workspaceRelativePath: parsedData.workspaceRelativePath,
          assetKind,
          trackId: track.id,
          trackKind: track.kind,
          source,
        });
        return false;
      }

      logger.info('Asset drop accepted', {
        assetId: parsedData.assetId,
        workspaceRelativePath: parsedData.workspaceRelativePath,
        assetKind,
        trackId: track.id,
        timelinePosition,
        source,
      });

      const effectiveEditMode = parsedData.editMode ?? useEditorToolStore.getState().editMode;

      if (parsedData.workspaceRelativePath) {
        onAssetDrop({
          ...(parsedData.assetId ? { assetId: parsedData.assetId } : {}),
          ...(assetKind ? { assetKind } : {}),
          workspaceRelativePath: parsedData.workspaceRelativePath,
          trackId: track.id,
          timelinePosition,
          editMode: effectiveEditMode,
          ...(parsedData.sourceIn !== undefined ? { sourceIn: parsedData.sourceIn } : {}),
          ...(parsedData.sourceOut !== undefined ? { sourceOut: parsedData.sourceOut } : {}),
        });
        return true;
      }

      if (!parsedData.assetId) {
        logger.warn('Drop ignored: asset drop has no assetId', { source });
        return false;
      }

      onAssetDrop({
        ...(assetKind ? { assetKind } : {}),
        assetId: parsedData.assetId,
        trackId: track.id,
        timelinePosition,
        editMode: effectiveEditMode,
        ...(parsedData.sourceIn !== undefined ? { sourceIn: parsedData.sourceIn } : {}),
        ...(parsedData.sourceOut !== undefined ? { sourceOut: parsedData.sourceOut } : {}),
      });
      return true;
    },
    [assets, onAssetDrop, scrollX, scrollY, sequence, trackHeaderWidth, trackHeight, zoom],
  );

  useEffect(() => {
    const handlePointerDragMove = (event: Event) => {
      if (!isTimelineAssetDragCustomEvent(event)) {
        return;
      }

      const container = dropContainerRef?.current;
      if (!container || !sequence || !onAssetDrop) {
        setIsDraggingOver(false);
        return;
      }

      const { clientX, clientY, payload } = event.detail;
      if (!isPointInsideElement(container, clientX, clientY)) {
        setIsDraggingOver(false);
        return;
      }

      const dropTarget = resolveTrackDropTarget({
        sequence,
        container,
        clientY,
        scrollY,
        fallbackTrackHeight: trackHeight,
      });

      if (!dropTarget || dropTarget.track.locked) {
        setIsDraggingOver(false);
        return;
      }

      const assetKind =
        payload.assetKind ?? (payload.assetId ? assets?.get(payload.assetId)?.kind : undefined);
      setIsDraggingOver(!assetKind || isAssetCompatibleWithTrack(assetKind, dropTarget.track.kind));
    };

    const handlePointerDragEnd = (event: Event) => {
      if (!isTimelineAssetDragCustomEvent(event)) {
        return;
      }

      dragCounterRef.current = 0;
      setIsDraggingOver(false);

      const container = dropContainerRef?.current;
      if (!container) {
        return;
      }

      const { clientX, clientY, payload } = event.detail;
      if (!isPointInsideElement(container, clientX, clientY)) {
        return;
      }

      const parsedData = parseTimelineAssetDragPayload(payload);
      if (!parsedData) {
        logger.warn('Pointer drop ignored: no valid asset payload');
        return;
      }

      applyParsedAssetDrop(parsedData, container, clientX, clientY, 'pointer');
    };

    const handlePointerDragCancel = () => {
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
    };

    document.addEventListener(TIMELINE_ASSET_DRAG_MOVE_EVENT, handlePointerDragMove);
    document.addEventListener(TIMELINE_ASSET_DRAG_END_EVENT, handlePointerDragEnd);
    document.addEventListener(TIMELINE_ASSET_DRAG_CANCEL_EVENT, handlePointerDragCancel);

    return () => {
      document.removeEventListener(TIMELINE_ASSET_DRAG_MOVE_EVENT, handlePointerDragMove);
      document.removeEventListener(TIMELINE_ASSET_DRAG_END_EVENT, handlePointerDragEnd);
      document.removeEventListener(TIMELINE_ASSET_DRAG_CANCEL_EVENT, handlePointerDragCancel);
    };
  }, [applyParsedAssetDrop, assets, dropContainerRef, onAssetDrop, scrollY, sequence, trackHeight]);

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

      // NOTE: Asset kind compatibility is validated in handleDrop instead of here.
      // DataTransfer.getData() returns empty strings during dragover in modern
      // Chromium-based browsers (including WebView2/Tauri) for security reasons,
      // so parseDraggedAssetData() would always return null and incorrectly
      // set dropEffect to 'none', preventing the drop from working.
    },
    [sequence, scrollY, trackHeight],
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

      const parsedData = parseDraggedAssetData(e.dataTransfer);

      logger.debug('Drop data parsed', {
        parsedData,
      });

      if (!parsedData) {
        logger.warn('Drop ignored: no valid data in dataTransfer');
        return;
      }

      const target = e.currentTarget as HTMLElement;
      applyParsedAssetDrop(parsedData, target, e.clientX, e.clientY, 'html5');
    },
    [applyParsedAssetDrop, sequence, onAssetDrop],
  );

  return {
    isDraggingOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
