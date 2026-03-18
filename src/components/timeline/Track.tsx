/**
 * Track Component
 *
 * Displays a single track with its clips and controls.
 */

import { useRef, useMemo, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Video,
  Music,
  Type,
  Layers,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import type { Track as TrackType, Clip as ClipType, TrackKind, SnapPoint } from '@/types';
import { useVirtualizedClips } from '@/hooks/useVirtualizedClips';
import { useTransitionZones } from '@/hooks/useTransitionZones';
import { ContextMenu, type MenuItemOrDivider } from '@/components/ui';
import type { TrackSwapTarget } from '@/utils/trackReorder';
import {
  Clip,
  type ClipDragData,
  type DragPreviewPosition,
  type ClickModifiers,
  type ClipAudioSettingsPatch,
  type ClipWaveformConfig,
  type ClipThumbnailConfig,
} from './Clip';
import { TransitionZone } from './TransitionZone';
import { useTimelineOperations } from './TimelineOperationsContext';
import type { DropValidity } from '@/utils/dropValidity';
import { TRACK_HEIGHT } from './constants';
import { getTrackHeaderControls } from './trackHeaderControls';

// =============================================================================
// Types
// =============================================================================

interface TrackProps {
  /** Track data */
  track: TrackType;
  /** Sequence ID (needed for gap management commands) */
  sequenceId?: string;
  /** Clips in this track */
  clips: ClipType[];
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Horizontal scroll offset in pixels */
  scrollX?: number;
  /** Total timeline duration in seconds (for setting content width) */
  duration?: number;
  /** Visible viewport width in pixels (for virtualization) */
  viewportWidth?: number;
  /** Selected clip IDs */
  selectedClipIds?: string[];
  /** Function to get waveform config for a clip */
  getClipWaveformConfig?: (clipId: string, assetId: string) => ClipWaveformConfig | undefined;
  /** Function to get thumbnail config for a clip */
  getClipThumbnailConfig?: (
    clipId: string,
    assetId: string,
    trackKind: TrackKind,
  ) => ClipThumbnailConfig | undefined;
  /** Snap points for intelligent snapping (clip edges, playhead, etc.) */
  snapPoints?: SnapPoint[];
  /** Snap threshold in seconds (distance within which snapping occurs) */
  snapThreshold?: number;
  /** Whether this track is currently a drop target */
  isDropTarget?: boolean;
  /** Drop validity result when track is a drop target */
  dropValidity?: DropValidity;
  /** Whether this track is the target for 3-point editing (source monitor active) */
  isEditTarget?: boolean;
  /** Mute toggle handler */
  onMuteToggle?: (trackId: string) => void;
  /** Lock toggle handler */
  onLockToggle?: (trackId: string) => void;
  /** Visibility toggle handler */
  onVisibilityToggle?: (trackId: string) => void;
  /** Delete track handler */
  onDeleteTrack?: (trackId: string) => void;
  /** Whether this track can be deleted */
  canDeleteTrack?: boolean;
  /** Same-kind tracks available for swapping */
  swapTargets?: TrackSwapTarget[];
  /** Swap handler */
  onSwapTracks?: (trackId: string, targetTrackId: string) => void;
  /** Clip click handler with modifier keys */
  onClipClick?: (clipId: string, modifiers: ClickModifiers) => void;
  /** Razor tool click handler */
  onClipRazorClick?: (event: ReactMouseEvent) => void;
  /** Clip double-click handler */
  onClipDoubleClick?: (clipId: string) => void;
  /** Clip audio settings commit handler */
  onClipAudioSettingsChange?: (
    trackId: string,
    clipId: string,
    patch: ClipAudioSettingsPatch,
  ) => void;
  /** Clip drag start handler */
  onClipDragStart?: (trackId: string, data: ClipDragData) => void;
  /** Clip drag handler - receives computed preview position directly */
  onClipDrag?: (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition) => void;
  /** Clip drag end handler */
  onClipDragEnd?: (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => void;
  /** Snap point change handler - called when snap point changes during clip drag */
  onSnapPointChange?: (snapPoint: import('@/types').SnapPoint | null) => void;
  /** Whether to show transition zones between adjacent clips */
  showTransitionZones?: boolean;
  /** Transition zone click handler */
  onTransitionZoneClick?: (clipAId: string, clipBId: string) => void;
  /** Clip context menu handler for speed operations */
  onClipSpeedChange?: (clipId: string, trackId: string, speed: number, reverse: boolean) => void;
  /** Clip reverse handler */
  onClipReverse?: (clipId: string, trackId: string) => void;
  /** Clip freeze frame handler */
  onClipFreezeFrame?: (clipId: string, trackId: string) => void;
}

// =============================================================================
// Track Icons
// =============================================================================

const TrackIcons: Record<TrackKind, LucideIcon> = {
  video: Video,
  audio: Music,
  caption: Type,
  overlay: Layers,
};

// =============================================================================
// Constants
// =============================================================================

/** Default viewport width for virtualization fallback */
const DEFAULT_VIEWPORT_WIDTH = 1200;

/** Buffer zone in pixels for pre-rendering off-screen clips */
const VIRTUALIZATION_BUFFER_PX = 300;

/** Empty array constants for stable references (prevents re-renders from new array allocations) */
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_SNAP_POINTS: SnapPoint[] = [];

// =============================================================================
// Component
// =============================================================================

export function Track({
  track,
  sequenceId,
  clips,
  zoom,
  scrollX = 0,
  duration = 60,
  viewportWidth,
  selectedClipIds = EMPTY_STRING_ARRAY,
  getClipWaveformConfig,
  getClipThumbnailConfig,
  snapPoints = EMPTY_SNAP_POINTS,
  snapThreshold = 0,
  isDropTarget = false,
  dropValidity,
  isEditTarget = false,
  onMuteToggle,
  onLockToggle,
  onVisibilityToggle,
  onDeleteTrack,
  canDeleteTrack = false,
  swapTargets = [],
  onSwapTracks,
  onClipClick,
  onClipRazorClick,
  onClipDoubleClick,
  onClipAudioSettingsChange,
  onClipDragStart,
  onClipDrag,
  onClipDragEnd,
  onSnapPointChange,
  showTransitionZones = false,
  onTransitionZoneClick,
  onClipSpeedChange,
  onClipReverse,
  onClipFreezeFrame,
}: TrackProps) {
  // Ref for measuring viewport width if not provided
  const contentRef = useRef<HTMLDivElement>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Calculate actual viewport width (use provided or measure from ref)
  const actualViewportWidth =
    viewportWidth ?? contentRef.current?.clientWidth ?? DEFAULT_VIEWPORT_WIDTH;

  // Virtualize clips - only render clips visible in viewport + buffer
  const { visibleClips } = useVirtualizedClips(clips, {
    zoom,
    scrollX,
    viewportWidth: actualViewportWidth,
    bufferPx: VIRTUALIZATION_BUFFER_PX,
  });

  // Find transition zones between adjacent clips
  const transitionZones = useTransitionZones(clips);

  // Create clip lookup map for TransitionZone components
  const clipMap = useMemo(() => {
    const map = new Map<string, ClipType>();
    clips.forEach((clip) => map.set(clip.id, clip));
    return map;
  }, [clips]);

  // Handle transition zone click
  const handleTransitionZoneClick = useCallback(
    (clipAId: string, clipBId: string) => {
      if (track.locked) return;
      onTransitionZoneClick?.(clipAId, clipBId);
    },
    [track.locked, onTransitionZoneClick],
  );

  // Calculate track content width based on duration and zoom
  const contentWidth = duration * zoom;
  const TrackIcon = TrackIcons[track.kind] || Video;
  const { showMute, showVisibility } = getTrackHeaderControls(track.kind);
  const contextMenuItems = useMemo<MenuItemOrDivider[]>(() => {
    const items: MenuItemOrDivider[] =
      swapTargets.length === 0
        ? [
            {
              label: `No other ${track.kind} tracks`,
              onClick: () => {},
              disabled: true,
            },
          ]
        : swapTargets.map((target) => ({
            label: `Swap with ${target.name}`,
            onClick: () => onSwapTracks?.(track.id, target.trackId),
          }));

    items.push({ type: 'divider' });
    items.push({
      label: 'Delete track',
      onClick: () => onDeleteTrack?.(track.id),
      disabled: !canDeleteTrack,
      danger: true,
    });

    return items;
  }, [canDeleteTrack, onDeleteTrack, onSwapTracks, swapTargets, track.id, track.kind]);

  const handleHeaderContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

  // Gap context menu state and operations
  const { onCloseGap, onCloseAllGaps } = useTimelineOperations();
  const [gapContextMenu, setGapContextMenu] = useState<{
    x: number;
    y: number;
    gapStart: number;
    gapEnd: number;
  } | null>(null);

  const [clipContextMenu, setClipContextMenu] = useState<{
    x: number;
    y: number;
    clipId: string;
  } | null>(null);

  const handleClipContextMenu = useCallback(
    (event: ReactMouseEvent, clipId: string) => {
      event.preventDefault();
      event.stopPropagation();
      setClipContextMenu({ x: event.clientX, y: event.clientY, clipId });
    },
    [],
  );

  const clipContextMenuItems = useMemo<MenuItemOrDivider[]>(() => {
    if (!clipContextMenu) return [];
    const { clipId } = clipContextMenu;
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) return [];

    return [
      {
        label: clip.reverse ? 'Unreverse' : 'Reverse',
        shortcut: 'R',
        onClick: () => {
          onClipReverse?.(clipId, track.id);
          setClipContextMenu(null);
        },
        disabled: !onClipReverse,
      },
      {
        label: 'Freeze Frame',
        onClick: () => {
          onClipFreezeFrame?.(clipId, track.id);
          setClipContextMenu(null);
        },
        disabled: !onClipFreezeFrame,
      },
      { type: 'divider' as const },
      ...[0.5, 1.0, 2.0, 4.0].map((speed) => ({
        label: `Speed ${Math.round(speed * 100)}%`,
        onClick: () => {
          onClipSpeedChange?.(clipId, track.id, speed, clip.reverse ?? false);
          setClipContextMenu(null);
        },
        disabled: !onClipSpeedChange,
      })),
    ];
  }, [clipContextMenu, track.id, onClipReverse, onClipFreezeFrame, onClipSpeedChange]);

  const handleContentContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (track.locked || !sequenceId) return;

      // Calculate the time position from mouse position
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const mouseX = event.clientX - rect.left + scrollX;
      const timeSec = mouseX / zoom;

      // Check if the click falls in a gap between clips
      const sortedClips = [...clips].sort(
        (a, b) => a.place.timelineInSec - b.place.timelineInSec,
      );

      for (let i = 0; i < sortedClips.length - 1; i++) {
        const currentEnd =
          sortedClips[i].place.timelineInSec + sortedClips[i].place.durationSec;
        const nextStart = sortedClips[i + 1].place.timelineInSec;

        if (nextStart > currentEnd && timeSec >= currentEnd && timeSec < nextStart) {
          event.preventDefault();
          event.stopPropagation();
          setGapContextMenu({
            x: event.clientX,
            y: event.clientY,
            gapStart: currentEnd,
            gapEnd: nextStart,
          });
          return;
        }
      }

      // Check leading gap (before first clip)
      if (sortedClips.length > 0 && sortedClips[0].place.timelineInSec > 0 && timeSec < sortedClips[0].place.timelineInSec) {
        event.preventDefault();
        event.stopPropagation();
        setGapContextMenu({
          x: event.clientX,
          y: event.clientY,
          gapStart: 0,
          gapEnd: sortedClips[0].place.timelineInSec,
        });
        return;
      }
    },
    [track.locked, sequenceId, clips, scrollX, zoom],
  );

  const gapContextMenuItems = useMemo<MenuItemOrDivider[]>(() => {
    if (!gapContextMenu || !sequenceId) return [];
    const gapDuration = gapContextMenu.gapEnd - gapContextMenu.gapStart;
    return [
      {
        label: `Close Gap (${gapDuration.toFixed(2)}s)`,
        onClick: () => {
          onCloseGap?.({
            sequenceId,
            trackId: track.id,
            gapStart: gapContextMenu.gapStart,
            gapEnd: gapContextMenu.gapEnd,
          });
          setGapContextMenu(null);
        },
      },
      {
        label: 'Close All Gaps on Track',
        onClick: () => {
          onCloseAllGaps?.({
            sequenceId,
            trackId: track.id,
          });
          setGapContextMenu(null);
        },
      },
    ];
  }, [gapContextMenu, sequenceId, track.id, onCloseGap, onCloseAllGaps]);

  return (
    <>
      <div
        data-track-row="true"
        data-track-id={track.id}
        data-track-kind={track.kind}
        className="flex border-b border-editor-border"
      >
        {/* Track Header */}
        <div
          data-testid="track-header"
          data-track-kind={track.kind}
          className="w-48 flex-shrink-0 bg-editor-sidebar px-2 py-1.5 flex items-center gap-2 border-r border-editor-border cursor-context-menu"
          style={{ height: TRACK_HEIGHT }}
          title="Right-click to swap or delete this track"
          onContextMenu={handleHeaderContextMenu}
        >
          {/* Track type icon */}
          <TrackIcon className="w-4 h-4 text-editor-text-muted" />

          {/* Track name */}
          <span className="flex-1 min-w-0 text-sm text-editor-text truncate">{track.name}</span>

          {/* Track controls */}
          <div className="flex shrink-0 items-center justify-end gap-1">
            {showMute && (
              <button
                data-testid="mute-button"
                className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
                onClick={(event) => {
                  event.stopPropagation();
                  onMuteToggle?.(track.id);
                }}
                title={track.muted ? 'Unmute' : 'Mute'}
              >
                {track.muted ? (
                  <>
                    <VolumeX className="w-3.5 h-3.5" />
                    <span data-testid="muted-indicator" className="sr-only">
                      Muted
                    </span>
                  </>
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
              </button>
            )}

            {showVisibility && (
              <button
                data-testid="visibility-button"
                className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
                onClick={(event) => {
                  event.stopPropagation();
                  onVisibilityToggle?.(track.id);
                }}
                title={track.visible ? 'Hide' : 'Show'}
              >
                {track.visible ? (
                  <Eye className="w-3.5 h-3.5" />
                ) : (
                  <EyeOff className="w-3.5 h-3.5" />
                )}
              </button>
            )}

            {/* Lock button */}
            <button
              data-testid="lock-button"
              className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
              onClick={(event) => {
                event.stopPropagation();
                onLockToggle?.(track.id);
              }}
              title={track.locked ? 'Unlock' : 'Lock'}
            >
              {track.locked ? (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  <span data-testid="locked-indicator" className="sr-only">
                    Locked
                  </span>
                </>
              ) : (
                <Unlock className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Track Content (Clips Area) */}
        <div
          ref={contentRef}
          data-testid="track-content"
          data-drop-target={isDropTarget}
          data-drop-valid={dropValidity?.isValid}
          className={`
            flex-1 bg-editor-bg relative overflow-hidden transition-colors duration-100
            ${!track.visible ? 'opacity-50' : ''}
            ${isDropTarget && dropValidity?.isValid ? 'bg-blue-500/10 ring-1 ring-blue-500/50 ring-inset' : ''}
            ${isDropTarget && dropValidity && !dropValidity.isValid ? 'bg-red-500/10 ring-1 ring-red-500/50 ring-inset' : ''}
            ${isEditTarget && !isDropTarget ? 'border-l-2 border-cyan-400/60' : ''}
            ${track.locked ? 'cursor-not-allowed' : ''}
          `}
          style={{ height: TRACK_HEIGHT }}
          onContextMenu={handleContentContextMenu}
        >
          {/* Scrollable clips container */}
          <div
            className="absolute inset-0"
            style={{
              width: `${contentWidth}px`,
              transform: `translateX(-${scrollX}px)`,
            }}
          >
            {/* Only render visible clips (virtualized) */}
            {visibleClips.map((clip) => (
              <Clip
                key={clip.id}
                clip={clip}
                zoom={zoom}
                selected={selectedClipIds.includes(clip.id)}
                disabled={track.locked}
                waveformConfig={getClipWaveformConfig?.(clip.id, clip.assetId)}
                thumbnailConfig={getClipThumbnailConfig?.(clip.id, clip.assetId, track.kind)}
                trackKind={track.kind}
                sequenceId={sequenceId}
                trackId={track.id}
                onAudioSettingsChange={(clipId, patch) =>
                  onClipAudioSettingsChange?.(track.id, clipId, patch)
                }
                snapPoints={snapPoints}
                snapThreshold={snapThreshold}
                onClick={onClipClick}
                onRazorClick={onClipRazorClick}
                onDoubleClick={onClipDoubleClick}
                onDragStart={(data) => onClipDragStart?.(track.id, data)}
                onDrag={(data, previewPosition) => onClipDrag?.(track.id, data, previewPosition)}
                onDragEnd={(data, finalPosition) => onClipDragEnd?.(track.id, data, finalPosition)}
                onSnapPointChange={onSnapPointChange}
                onContextMenu={handleClipContextMenu}
              />
            ))}

            {/* Transition zones between adjacent clips */}
            {showTransitionZones &&
              transitionZones.map((zone) => {
                const clipA = clipMap.get(zone.clipAId);
                const clipB = clipMap.get(zone.clipBId);
                if (!clipA || !clipB) return null;

                return (
                  <TransitionZone
                    key={`transition-${zone.clipAId}-${zone.clipBId}`}
                    clipA={clipA}
                    clipB={clipB}
                    zoom={zoom}
                    disabled={track.locked}
                    onClick={handleTransitionZoneClick}
                  />
                );
              })}
          </div>

          {/* Drop validity message overlay */}
          {isDropTarget && dropValidity && !dropValidity.isValid && (
            <div
              data-testid="drop-invalid-overlay"
              className="absolute inset-0 flex items-center justify-center pointer-events-none z-30"
            >
              <span className="px-2 py-0.5 bg-red-500/90 text-white text-xs rounded shadow-lg">
                {dropValidity.message}
              </span>
            </div>
          )}
        </div>
      </div>

      {contextMenuPosition && (
        <ContextMenu
          x={contextMenuPosition.x}
          y={contextMenuPosition.y}
          items={contextMenuItems}
          onClose={() => setContextMenuPosition(null)}
        />
      )}

      {gapContextMenu && (
        <ContextMenu
          x={gapContextMenu.x}
          y={gapContextMenu.y}
          items={gapContextMenuItems}
          onClose={() => setGapContextMenu(null)}
        />
      )}

      {clipContextMenu && (
        <ContextMenu
          x={clipContextMenu.x}
          y={clipContextMenu.y}
          items={clipContextMenuItems}
          onClose={() => setClipContextMenu(null)}
        />
      )}
    </>
  );
}
