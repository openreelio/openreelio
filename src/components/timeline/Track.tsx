/**
 * Track Component
 *
 * Displays a single track with its clips and controls.
 */

import { useRef, useMemo, useCallback } from 'react';
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
import { Clip, type ClipDragData, type DragPreviewPosition, type ClickModifiers, type ClipWaveformConfig, type ClipThumbnailConfig } from './Clip';
import { TransitionZone } from './TransitionZone';
import type { DropValidity } from '@/utils/dropValidity';

// =============================================================================
// Types
// =============================================================================

interface TrackProps {
  /** Track data */
  track: TrackType;
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
  getClipThumbnailConfig?: (clipId: string, assetId: string) => ClipThumbnailConfig | undefined;
  /** Snap points for intelligent snapping (clip edges, playhead, etc.) */
  snapPoints?: SnapPoint[];
  /** Snap threshold in seconds (distance within which snapping occurs) */
  snapThreshold?: number;
  /** Whether this track is currently a drop target */
  isDropTarget?: boolean;
  /** Drop validity result when track is a drop target */
  dropValidity?: DropValidity;
  /** Mute toggle handler */
  onMuteToggle?: (trackId: string) => void;
  /** Lock toggle handler */
  onLockToggle?: (trackId: string) => void;
  /** Visibility toggle handler */
  onVisibilityToggle?: (trackId: string) => void;
  /** Clip click handler with modifier keys */
  onClipClick?: (clipId: string, modifiers: ClickModifiers) => void;
  /** Clip double-click handler */
  onClipDoubleClick?: (clipId: string) => void;
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
  onMuteToggle,
  onLockToggle,
  onVisibilityToggle,
  onClipClick,
  onClipDoubleClick,
  onClipDragStart,
  onClipDrag,
  onClipDragEnd,
  onSnapPointChange,
  showTransitionZones = false,
  onTransitionZoneClick,
}: TrackProps) {
  // Ref for measuring viewport width if not provided
  const contentRef = useRef<HTMLDivElement>(null);

  // Calculate actual viewport width (use provided or measure from ref)
  const actualViewportWidth = viewportWidth ?? contentRef.current?.clientWidth ?? DEFAULT_VIEWPORT_WIDTH;

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
    [track.locked, onTransitionZoneClick]
  );

  // Calculate track content width based on duration and zoom
  const contentWidth = duration * zoom;
  const TrackIcon = TrackIcons[track.kind] || Video;

  return (
    <div className="flex border-b border-editor-border">
      {/* Track Header */}
      <div
        data-testid="track-header"
        data-track-kind={track.kind}
        className="w-48 flex-shrink-0 bg-editor-sidebar p-2 flex items-center gap-2 border-r border-editor-border"
      >
        {/* Track type icon */}
        <TrackIcon className="w-4 h-4 text-editor-text-muted" />

        {/* Track name */}
        <span className="flex-1 text-sm text-editor-text truncate">{track.name}</span>

        {/* Track controls */}
        <div className="flex items-center gap-1">
          {/* Mute button */}
          <button
            data-testid="mute-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={() => onMuteToggle?.(track.id)}
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

          {/* Lock button */}
          <button
            data-testid="lock-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={() => onLockToggle?.(track.id)}
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

          {/* Visibility button */}
          <button
            data-testid="visibility-button"
            className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text"
            onClick={() => onVisibilityToggle?.(track.id)}
            title={track.visible ? 'Hide' : 'Show'}
          >
            {track.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
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
          flex-1 h-16 bg-editor-bg relative overflow-hidden transition-colors duration-100
          ${!track.visible ? 'opacity-50' : ''}
          ${isDropTarget && dropValidity?.isValid ? 'bg-blue-500/10 ring-1 ring-blue-500/50 ring-inset' : ''}
          ${isDropTarget && dropValidity && !dropValidity.isValid ? 'bg-red-500/10 ring-1 ring-red-500/50 ring-inset' : ''}
          ${track.locked ? 'cursor-not-allowed' : ''}
        `}
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
              thumbnailConfig={getClipThumbnailConfig?.(clip.id, clip.assetId)}
              snapPoints={snapPoints}
              snapThreshold={snapThreshold}
              onClick={onClipClick}
              onDoubleClick={onClipDoubleClick}
              onDragStart={(data) => onClipDragStart?.(track.id, data)}
              onDrag={(data, previewPosition) => onClipDrag?.(track.id, data, previewPosition)}
              onDragEnd={(data, finalPosition) => onClipDragEnd?.(track.id, data, finalPosition)}
              onSnapPointChange={onSnapPointChange}
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
            <span className="px-3 py-1 bg-red-500/90 text-white text-sm rounded shadow-lg">
              {dropValidity.message}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
