/**
 * App-level asset drag events used when the host WebView owns native file drops.
 *
 * Tauri/WebView2 on Windows cannot reliably expose HTML5 DataTransfer for internal
 * drags while native OS file dropping is enabled, so timeline asset drags use
 * pointer-driven custom events as the stable in-app channel.
 */

import type { AssetKind } from '@/types';
import type { AssetDropData } from '@/components/timeline/types';

export const TIMELINE_ASSET_DRAG_START_EVENT = 'openreelio:timeline-asset-drag-start';
export const TIMELINE_ASSET_DRAG_MOVE_EVENT = 'openreelio:timeline-asset-drag-move';
export const TIMELINE_ASSET_DRAG_END_EVENT = 'openreelio:timeline-asset-drag-end';
export const TIMELINE_ASSET_DRAG_CANCEL_EVENT = 'openreelio:timeline-asset-drag-cancel';

export interface TimelineAssetDragPayload {
  assetId?: string;
  workspaceRelativePath?: string;
  assetKind?: AssetKind;
  label?: string;
  editMode?: AssetDropData['editMode'];
  sourceIn?: number;
  sourceOut?: number;
}

export interface TimelineAssetDragDetail {
  payload: TimelineAssetDragPayload;
  clientX: number;
  clientY: number;
}

export type TimelineAssetDragCustomEvent = CustomEvent<TimelineAssetDragDetail>;

function dispatchTimelineAssetDragEvent(type: string, detail: TimelineAssetDragDetail): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.dispatchEvent(new CustomEvent<TimelineAssetDragDetail>(type, { detail }));
}

export function emitTimelineAssetDragStart(detail: TimelineAssetDragDetail): void {
  dispatchTimelineAssetDragEvent(TIMELINE_ASSET_DRAG_START_EVENT, detail);
}

export function emitTimelineAssetDragMove(detail: TimelineAssetDragDetail): void {
  dispatchTimelineAssetDragEvent(TIMELINE_ASSET_DRAG_MOVE_EVENT, detail);
}

export function emitTimelineAssetDragEnd(detail: TimelineAssetDragDetail): void {
  dispatchTimelineAssetDragEvent(TIMELINE_ASSET_DRAG_END_EVENT, detail);
}

export function emitTimelineAssetDragCancel(detail: TimelineAssetDragDetail): void {
  dispatchTimelineAssetDragEvent(TIMELINE_ASSET_DRAG_CANCEL_EVENT, detail);
}

export function isTimelineAssetDragCustomEvent(
  event: Event,
): event is TimelineAssetDragCustomEvent {
  return (
    event instanceof CustomEvent &&
    event.detail != null &&
    typeof event.detail.clientX === 'number' &&
    typeof event.detail.clientY === 'number' &&
    event.detail.payload != null
  );
}
