/**
 * Pointer-driven asset drag source for timeline drops.
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  emitTimelineAssetDragCancel,
  emitTimelineAssetDragEnd,
  emitTimelineAssetDragMove,
  emitTimelineAssetDragStart,
  type TimelineAssetDragPayload,
} from '@/utils/timelineAssetDrag';

const DRAG_START_THRESHOLD_PX = 4;
const DRAG_PREVIEW_OFFSET_X = 14;
const DRAG_PREVIEW_OFFSET_Y = 12;

interface PendingDrag {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  payload: TimelineAssetDragPayload;
  sourceElement: HTMLElement;
  isDragging: boolean;
}

export interface TimelineAssetDragSourceHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

function shouldIgnorePointerDown(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey;
}

function removeBodyDraggingState(): void {
  document.body.classList.remove('timeline-asset-dragging');
}

function getPreviewLabel(payload: TimelineAssetDragPayload): string {
  if (payload.label?.trim()) {
    return payload.label.trim();
  }

  if (payload.workspaceRelativePath?.trim()) {
    const normalizedPath = payload.workspaceRelativePath.replace(/\\/g, '/');
    return normalizedPath.split('/').pop() || normalizedPath;
  }

  return payload.assetId ?? 'Asset';
}

function getKindLabel(payload: TimelineAssetDragPayload): string {
  if (payload.assetKind) {
    return payload.assetKind;
  }

  if (payload.workspaceRelativePath) {
    const extension = payload.workspaceRelativePath.split('.').pop();
    if (extension) {
      return extension.toUpperCase();
    }
  }

  return 'asset';
}

function updateDragPreviewPosition(element: HTMLElement, clientX: number, clientY: number): void {
  element.style.transform = `translate3d(${clientX + DRAG_PREVIEW_OFFSET_X}px, ${
    clientY + DRAG_PREVIEW_OFFSET_Y
  }px, 0)`;
}

function createDragPreviewElement(
  payload: TimelineAssetDragPayload,
  clientX: number,
  clientY: number,
): HTMLElement {
  const preview = document.createElement('div');
  preview.dataset.testid = 'timeline-asset-drag-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.style.position = 'fixed';
  preview.style.left = '0';
  preview.style.top = '0';
  preview.style.zIndex = '2147483647';
  preview.style.maxWidth = '280px';
  preview.style.pointerEvents = 'none';
  preview.style.display = 'flex';
  preview.style.alignItems = 'center';
  preview.style.gap = '8px';
  preview.style.padding = '7px 10px';
  preview.style.border = '1px solid rgba(148, 163, 184, 0.45)';
  preview.style.borderRadius = '6px';
  preview.style.background = 'rgba(15, 23, 42, 0.94)';
  preview.style.color = '#e5e7eb';
  preview.style.boxShadow = '0 14px 32px rgba(0, 0, 0, 0.38)';
  preview.style.backdropFilter = 'blur(10px)';
  preview.style.font =
    '500 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  preview.style.userSelect = 'none';
  preview.style.willChange = 'transform';

  const kind = document.createElement('span');
  kind.textContent = getKindLabel(payload);
  kind.style.flexShrink = '0';
  kind.style.borderRadius = '4px';
  kind.style.padding = '2px 5px';
  kind.style.background = 'rgba(20, 184, 166, 0.16)';
  kind.style.color = '#67e8f9';
  kind.style.fontSize = '10px';
  kind.style.fontWeight = '700';
  kind.style.textTransform = 'uppercase';

  const label = document.createElement('span');
  label.textContent = getPreviewLabel(payload);
  label.style.minWidth = '0';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';

  preview.append(kind, label);
  updateDragPreviewPosition(preview, clientX, clientY);
  document.body.appendChild(preview);
  return preview;
}

function removeDragPreviewElement(element: HTMLElement | null): void {
  element?.remove();
}

export function useTimelineAssetDragSource(
  getPayload: () => TimelineAssetDragPayload | null | undefined,
): TimelineAssetDragSourceHandlers {
  const pendingDragRef = useRef<PendingDrag | null>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);

  const cleanupDocumentListeners = useCallback(
    (
      handlePointerMove: (event: PointerEvent) => void,
      handlePointerUp: (event: PointerEvent) => void,
    ) => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    },
    [],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (shouldIgnorePointerDown(event)) {
        return;
      }

      const payload = getPayload();
      if (!payload || (!payload.assetId && !payload.workspaceRelativePath)) {
        return;
      }

      const sourceElement = event.currentTarget;
      const pendingDrag: PendingDrag = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        payload,
        sourceElement,
        isDragging: false,
      };
      pendingDragRef.current = pendingDrag;

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const currentDrag = pendingDragRef.current;
        if (!currentDrag || pointerEvent.pointerId !== currentDrag.pointerId) {
          return;
        }

        const deltaX = pointerEvent.clientX - currentDrag.startClientX;
        const deltaY = pointerEvent.clientY - currentDrag.startClientY;
        const distance = Math.hypot(deltaX, deltaY);

        if (!currentDrag.isDragging) {
          if (distance < DRAG_START_THRESHOLD_PX) {
            return;
          }

          currentDrag.isDragging = true;
          document.body.classList.add('timeline-asset-dragging');
          removeDragPreviewElement(dragPreviewRef.current);
          dragPreviewRef.current = createDragPreviewElement(
            currentDrag.payload,
            pointerEvent.clientX,
            pointerEvent.clientY,
          );
          try {
            currentDrag.sourceElement.setPointerCapture(currentDrag.pointerId);
          } catch {
            // Pointer capture can fail when the platform already released it.
          }

          emitTimelineAssetDragStart({
            payload: currentDrag.payload,
            clientX: pointerEvent.clientX,
            clientY: pointerEvent.clientY,
          });
        }

        pointerEvent.preventDefault();
        if (dragPreviewRef.current) {
          updateDragPreviewPosition(
            dragPreviewRef.current,
            pointerEvent.clientX,
            pointerEvent.clientY,
          );
        }
        emitTimelineAssetDragMove({
          payload: currentDrag.payload,
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
        });
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        const currentDrag = pendingDragRef.current;
        if (!currentDrag || pointerEvent.pointerId !== currentDrag.pointerId) {
          return;
        }

        cleanupDocumentListeners(handlePointerMove, handlePointerUp);
        pendingDragRef.current = null;
        removeBodyDraggingState();
        removeDragPreviewElement(dragPreviewRef.current);
        dragPreviewRef.current = null;

        try {
          currentDrag.sourceElement.releasePointerCapture(currentDrag.pointerId);
        } catch {
          // Pointer capture may already be gone if the pointer left the WebView.
        }

        if (!currentDrag.isDragging) {
          return;
        }

        pointerEvent.preventDefault();
        const detail = {
          payload: currentDrag.payload,
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
        };

        if (pointerEvent.type === 'pointercancel') {
          emitTimelineAssetDragCancel(detail);
          return;
        }

        emitTimelineAssetDragEnd(detail);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    },
    [cleanupDocumentListeners, getPayload],
  );

  useEffect(() => {
    return () => {
      removeDragPreviewElement(dragPreviewRef.current);
      dragPreviewRef.current = null;
      removeBodyDraggingState();
    };
  }, []);

  return { onPointerDown: handlePointerDown };
}
