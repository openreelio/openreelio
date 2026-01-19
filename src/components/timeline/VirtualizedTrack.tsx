/**
 * VirtualizedTrack Component
 *
 * A performance-optimized Track component that only renders clips
 * visible within the current viewport using horizontal virtualization.
 *
 * This component wraps the standard Track component and adds:
 * - Viewport-based clip filtering
 * - Buffer zone for smooth scrolling
 * - Precomputed clip positions
 *
 * Use this component when dealing with tracks that contain many clips
 * to significantly improve timeline rendering performance.
 */

import { useRef, useCallback, useState, useEffect, memo } from 'react';
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
import type { Track as TrackType, Clip as ClipType, TrackKind } from '@/types';
import {
  Clip,
  type ClipDragData,
  type DragPreviewPosition,
  type ClickModifiers,
  type ClipWaveformConfig,
} from './Clip';
import { useVirtualizedClips, type VirtualizationConfig } from '@/hooks';

// =============================================================================
// Types
// =============================================================================

export interface VirtualizedTrackProps {
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
  /** Selected clip IDs */
  selectedClipIds?: string[];
  /** Viewport width in pixels (for virtualization) */
  viewportWidth?: number;
  /** Buffer zone for pre-rendering clips outside viewport (default: 200px) */
  bufferPx?: number;
  /** Function to get waveform config for a clip */
  getClipWaveformConfig?: (clipId: string, assetId: string) => ClipWaveformConfig | undefined;
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
  /** Clip drag handler */
  onClipDrag?: (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition) => void;
  /** Clip drag end handler */
  onClipDragEnd?: (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => void;
  /** Debug mode - shows virtualization info */
  debug?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BUFFER_PX = 200;
const DEFAULT_VIEWPORT_WIDTH = 1200;

const TrackIcons: Record<TrackKind, LucideIcon> = {
  video: Video,
  audio: Music,
  caption: Type,
  overlay: Layers,
};

// =============================================================================
// Component
// =============================================================================

export const VirtualizedTrack = memo(function VirtualizedTrack({
  track,
  clips,
  zoom,
  scrollX = 0,
  duration = 60,
  selectedClipIds = [],
  viewportWidth = DEFAULT_VIEWPORT_WIDTH,
  bufferPx = DEFAULT_BUFFER_PX,
  getClipWaveformConfig,
  onMuteToggle,
  onLockToggle,
  onVisibilityToggle,
  onClipClick,
  onClipDoubleClick,
  onClipDragStart,
  onClipDrag,
  onClipDragEnd,
  debug = false,
}: VirtualizedTrackProps) {
  // Container ref for measuring actual viewport
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number>(viewportWidth);

  // Measure container width on mount and resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measureWidth = () => {
      const width = container.clientWidth;
      // Only update if we got a valid measurement (>0), otherwise keep prop value
      if (width > 0) {
        setMeasuredWidth(width);
      }
    };

    measureWidth();

    // Use ResizeObserver if available
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measureWidth);
      observer.observe(container);
      return () => observer.disconnect();
    }

    // Fallback to window resize
    window.addEventListener('resize', measureWidth);
    return () => window.removeEventListener('resize', measureWidth);
  }, []);

  // Virtualization config
  const virtualizationConfig: VirtualizationConfig = {
    zoom,
    scrollX,
    viewportWidth: measuredWidth,
    bufferPx,
  };

  // Get virtualized clips
  const { visibleClips, totalClips, renderedClips, isVirtualized } =
    useVirtualizedClips(clips, virtualizationConfig);

  // Calculate track content width based on duration and zoom
  const contentWidth = duration * zoom;
  const TrackIcon = TrackIcons[track.kind] || Video;

  // Handlers
  const handleClipDragStart = useCallback(
    (data: ClipDragData) => {
      onClipDragStart?.(track.id, data);
    },
    [track.id, onClipDragStart]
  );

  const handleClipDrag = useCallback(
    (data: ClipDragData, previewPosition: DragPreviewPosition) => {
      onClipDrag?.(track.id, data, previewPosition);
    },
    [track.id, onClipDrag]
  );

  const handleClipDragEnd = useCallback(
    (data: ClipDragData, finalPosition: DragPreviewPosition) => {
      onClipDragEnd?.(track.id, data, finalPosition);
    },
    [track.id, onClipDragEnd]
  );

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
        <span className="flex-1 text-sm text-editor-text truncate">
          {track.name}
          {/* Debug info */}
          {debug && isVirtualized && (
            <span className="ml-1 text-xs text-green-500">
              ({renderedClips}/{totalClips})
            </span>
          )}
        </span>

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
        ref={containerRef}
        data-testid="track-content"
        data-virtualized={isVirtualized}
        className={`flex-1 h-16 bg-editor-bg relative overflow-hidden ${!track.visible ? 'opacity-50' : ''}`}
      >
        {/* Scrollable clips container */}
        <div
          className="absolute inset-0"
          style={{
            width: `${contentWidth}px`,
            transform: `translateX(-${scrollX}px)`,
          }}
        >
          {visibleClips.map((clip) => (
            <Clip
              key={clip.id}
              clip={clip}
              zoom={zoom}
              selected={selectedClipIds.includes(clip.id)}
              disabled={track.locked}
              waveformConfig={getClipWaveformConfig?.(clip.id, clip.assetId)}
              onClick={onClipClick}
              onDoubleClick={onClipDoubleClick}
              onDragStart={handleClipDragStart}
              onDrag={handleClipDrag}
              onDragEnd={handleClipDragEnd}
            />
          ))}
        </div>

        {/* Debug overlay */}
        {debug && (
          <div className="absolute bottom-0 left-0 bg-black bg-opacity-70 text-xs text-white px-1 py-0.5 pointer-events-none z-50">
            {renderedClips}/{totalClips} clips | viewport: {measuredWidth}px | scroll: {scrollX}px
          </div>
        )}
      </div>
    </div>
  );
});

export default VirtualizedTrack;
