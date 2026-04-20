import type { ComponentProps, PointerEventHandler, RefObject, WheelEventHandler } from 'react';
import { RAZOR_CURSOR } from '@/stores/editorToolStore';
import { TRACK_HEADER_WIDTH, TRACK_HEIGHT } from './constants';
import { CacheStatusBar } from './CacheStatusBar';
import { DragPreviewLayer } from './DragPreviewLayer';
import {
  Playhead,
  PLAYHEAD_LINE_HIT_AREA_WIDTH,
  PLAYHEAD_RULER_HEIGHT,
  type PlayheadHandle,
} from './Playhead';
import { SelectionBox } from './SelectionBox';
import { ShotMarkers } from './ShotMarkers';
import { SnapIndicator, type SnapPoint } from './SnapIndicator';
import { TimeRuler } from './TimeRuler';

export interface PendingDropOverlay {
  id: string;
  left: number;
  top: number;
  width: number;
  label: string;
  statusLabel: string;
  statusClassName: string;
  progressPercent: number;
}

export interface RazorGuideState {
  x: number;
  trackCenterY: number;
}

export function TimelineEmptyState(): JSX.Element {
  return (
    <div
      data-testid="timeline"
      className="h-full flex flex-col items-center justify-center text-editor-text-muted bg-editor-panel"
    >
      <svg
        className="w-16 h-16 mb-4 text-editor-text-muted/50"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
        />
      </svg>
      <p className="text-lg font-medium mb-1">No sequence loaded</p>
      <p className="text-sm text-editor-text-muted/70">
        Import media or create a new sequence to start editing
      </p>
    </div>
  );
}

export interface TimelineHeaderLayerProps {
  cacheSegments: ComponentProps<typeof CacheStatusBar>['segments'];
  duration: number;
  zoom: number;
  scrollX: number;
  onSeek: (time: number) => void;
  onWheel: WheelEventHandler<HTMLDivElement>;
}

export function TimelineHeaderLayer({
  cacheSegments,
  duration,
  zoom,
  scrollX,
  onSeek,
  onWheel,
}: TimelineHeaderLayerProps): JSX.Element {
  return (
    <>
      <div className="flex border-b border-editor-border flex-shrink-0">
        <div className="w-48 flex-shrink-0 bg-editor-sidebar border-r border-editor-border flex items-center justify-center">
          <span className="text-xs text-editor-text-muted font-medium uppercase tracking-wider select-none">
            Tracks
          </span>
        </div>
        <div className="flex-1 overflow-hidden" onWheel={onWheel}>
          <div
            data-testid="timeline-ruler-scroll-layer"
            style={{ transform: `translateX(-${scrollX}px)` }}
          >
            <TimeRuler duration={duration} zoom={zoom} scrollX={scrollX} onSeek={onSeek} />
          </div>
        </div>
      </div>

      {cacheSegments.length > 0 && (
        <CacheStatusBar
          segments={cacheSegments}
          duration={duration}
          zoom={zoom}
          scrollX={scrollX}
        />
      )}
    </>
  );
}

export interface TimelineTrackOverlaysProps {
  dragPreview: ComponentProps<typeof DragPreviewLayer>['dragPreview'];
  razorGuide: RazorGuideState | null;
  isRazorActive: boolean;
  pendingDropOverlays: PendingDropOverlay[];
  pendingDropVerticalInsetPx: number;
  pendingDropHeightPx: number;
  activeSnapPoint: SnapPoint | null;
  isSnapIndicatorActive: boolean;
  zoom: number;
  scrollX: number;
  shotMarkers: ComponentProps<typeof ShotMarkers>['shots'];
  viewportWidth: number;
  duration: number;
  onSeekShotMarker: ComponentProps<typeof ShotMarkers>['onSeek'];
  isDraggingOver: boolean;
  selectionRect: ComponentProps<typeof SelectionBox>['rect'];
  isSelecting: boolean;
}

export function TimelineTrackOverlays({
  dragPreview,
  razorGuide,
  isRazorActive,
  pendingDropOverlays,
  pendingDropVerticalInsetPx,
  pendingDropHeightPx,
  activeSnapPoint,
  isSnapIndicatorActive,
  zoom,
  scrollX,
  shotMarkers,
  viewportWidth,
  duration,
  onSeekShotMarker,
  isDraggingOver,
  selectionRect,
  isSelecting,
}: TimelineTrackOverlaysProps): JSX.Element {
  return (
    <>
      <DragPreviewLayer
        dragPreview={dragPreview}
        trackHeaderWidth={TRACK_HEADER_WIDTH}
        trackHeight={TRACK_HEIGHT}
        scrollX={scrollX}
      />
      {isRazorActive && razorGuide && (
        <>
          <div
            data-testid="razor-guide-vertical"
            className="absolute top-0 bottom-0 w-px border-l border-dashed border-amber-200/70 pointer-events-none z-20"
            style={{ left: `${razorGuide.x}px` }}
          />
          <div
            data-testid="razor-guide-horizontal"
            className="absolute h-px border-t border-dashed border-amber-200/40 pointer-events-none z-20"
            style={{
              top: `${razorGuide.trackCenterY}px`,
              left: `${TRACK_HEADER_WIDTH}px`,
              right: 0,
            }}
          />
        </>
      )}
      {pendingDropOverlays.map((overlay) => (
        <div
          key={overlay.id}
          data-testid="pending-workspace-drop"
          className={`absolute border border-dashed rounded-md pointer-events-none z-10 px-2 py-1 shadow-sm ${overlay.statusClassName}`}
          style={{
            left: `${overlay.left}px`,
            top: `${overlay.top + pendingDropVerticalInsetPx}px`,
            width: `${overlay.width}px`,
            height: `${pendingDropHeightPx}px`,
          }}
        >
          <div className="text-[11px] leading-tight truncate font-medium">{overlay.label}</div>
          <div className="text-[10px] mt-1 opacity-90 flex items-center justify-between gap-2">
            <span>{overlay.statusLabel}</span>
            <span>{overlay.progressPercent}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-black/25 overflow-hidden">
            <div
              className="h-full bg-current/90"
              style={{ width: `${overlay.progressPercent}%` }}
            />
          </div>
        </div>
      ))}
      <SnapIndicator
        snapPoint={activeSnapPoint}
        isActive={isSnapIndicatorActive}
        zoom={zoom}
        trackHeaderWidth={TRACK_HEADER_WIDTH}
        scrollX={scrollX}
      />
      {shotMarkers.length > 0 && (
        <ShotMarkers
          shots={shotMarkers}
          zoom={zoom}
          scrollX={scrollX}
          viewportWidth={viewportWidth}
          duration={duration}
          trackHeaderWidth={TRACK_HEADER_WIDTH}
          onSeek={onSeekShotMarker}
        />
      )}
      {isDraggingOver && (
        <div
          data-testid="drop-indicator"
          className="absolute inset-0 bg-primary-500/10 border-2 border-dashed border-primary-500 pointer-events-none flex items-center justify-center"
        >
          <div className="text-primary-400 text-sm font-medium">Drop asset here</div>
        </div>
      )}
      <SelectionBox rect={selectionRect} isActive={isSelecting} />
    </>
  );
}

export interface TimelinePlayheadLayerProps {
  playheadViewportRef: RefObject<HTMLDivElement | null>;
  isRazorActive: boolean;
  playheadLineHitAreaLeft: number;
  onPlayheadRazorPointerDown: PointerEventHandler<HTMLDivElement>;
  playheadRef: RefObject<PlayheadHandle | null>;
  position: number;
  zoom: number;
  scrollX: number;
  isPlaying: boolean;
  isDraggingPlayhead: boolean;
  onPlayheadDragStart?: ComponentProps<typeof Playhead>['onDragStart'];
  onPlayheadPointerDown?: ComponentProps<typeof Playhead>['onPointerDown'];
}

export function TimelinePlayheadLayer({
  playheadViewportRef,
  isRazorActive,
  playheadLineHitAreaLeft,
  onPlayheadRazorPointerDown,
  playheadRef,
  position,
  zoom,
  scrollX,
  isPlaying,
  isDraggingPlayhead,
  onPlayheadDragStart,
  onPlayheadPointerDown,
}: TimelinePlayheadLayerProps): JSX.Element {
  return (
    <div
      ref={playheadViewportRef as RefObject<HTMLDivElement>}
      className="absolute top-0 bottom-0 overflow-hidden pointer-events-none"
      style={{
        left: `${TRACK_HEADER_WIDTH}px`,
        right: 0,
      }}
    >
      {isRazorActive && (
        <div
          data-testid="playhead-razor-hit-area"
          className="absolute select-none touch-none z-40"
          style={{
            top: `${PLAYHEAD_RULER_HEIGHT}px`,
            bottom: 0,
            left: `${playheadLineHitAreaLeft}px`,
            width: `${PLAYHEAD_LINE_HIT_AREA_WIDTH}px`,
            cursor: RAZOR_CURSOR,
            pointerEvents: 'auto',
          }}
          onPointerDown={onPlayheadRazorPointerDown}
        />
      )}
      <Playhead
        ref={playheadRef as RefObject<PlayheadHandle>}
        position={position}
        zoom={zoom}
        scrollX={scrollX}
        trackHeaderWidth={0}
        isPlaying={isPlaying}
        isDragging={isDraggingPlayhead}
        onDragStart={isRazorActive ? undefined : onPlayheadDragStart}
        onPointerDown={isRazorActive ? undefined : onPlayheadPointerDown}
      />
    </div>
  );
}
