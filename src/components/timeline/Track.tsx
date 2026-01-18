/**
 * Track Component
 *
 * Displays a single track with its clips and controls.
 */

import { Video, Music, Type, Layers, Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, type LucideIcon } from 'lucide-react';
import type { Track as TrackType, Clip as ClipType, TrackKind } from '@/types';
import { Clip, type ClipDragData, type DragPreviewPosition } from './Clip';

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
  /** Selected clip IDs */
  selectedClipIds?: string[];
  /** Mute toggle handler */
  onMuteToggle?: (trackId: string) => void;
  /** Lock toggle handler */
  onLockToggle?: (trackId: string) => void;
  /** Visibility toggle handler */
  onVisibilityToggle?: (trackId: string) => void;
  /** Clip click handler */
  onClipClick?: (clipId: string) => void;
  /** Clip double-click handler */
  onClipDoubleClick?: (clipId: string) => void;
  /** Clip drag start handler */
  onClipDragStart?: (trackId: string, data: ClipDragData) => void;
  /** Clip drag handler */
  onClipDrag?: (trackId: string, data: ClipDragData, deltaX: number) => void;
  /** Clip drag end handler */
  onClipDragEnd?: (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => void;
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
// Component
// =============================================================================

export function Track({
  track,
  clips,
  zoom,
  scrollX = 0,
  duration = 60,
  selectedClipIds = [],
  onMuteToggle,
  onLockToggle,
  onVisibilityToggle,
  onClipClick,
  onClipDoubleClick,
  onClipDragStart,
  onClipDrag,
  onClipDragEnd,
}: TrackProps) {
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
        <span className="flex-1 text-sm text-editor-text truncate">
          {track.name}
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
                <span data-testid="muted-indicator" className="sr-only">Muted</span>
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
                <span data-testid="locked-indicator" className="sr-only">Locked</span>
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
            {track.visible ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Track Content (Clips Area) */}
      <div
        data-testid="track-content"
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
          {clips.map((clip) => (
            <Clip
              key={clip.id}
              clip={clip}
              zoom={zoom}
              selected={selectedClipIds.includes(clip.id)}
              disabled={track.locked}
              onClick={onClipClick}
              onDoubleClick={onClipDoubleClick}
              onDragStart={(data) => onClipDragStart?.(track.id, data)}
              onDrag={(data, deltaX) => onClipDrag?.(track.id, data, deltaX)}
              onDragEnd={(data, finalPosition) => onClipDragEnd?.(track.id, data, finalPosition)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
