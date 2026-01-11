/**
 * Track Component
 *
 * Displays a single track with its clips and controls.
 */

import { Video, Music, Type, Layers, Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, type LucideIcon } from 'lucide-react';
import type { Track as TrackType, Clip as ClipType, TrackKind } from '@/types';
import { Clip } from './Clip';

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
  selectedClipIds = [],
  onMuteToggle,
  onLockToggle,
  onVisibilityToggle,
  onClipClick,
  onClipDoubleClick,
}: TrackProps) {
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
        className={`flex-1 h-16 bg-editor-bg relative ${!track.visible ? 'opacity-50' : ''}`}
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
          />
        ))}
      </div>
    </div>
  );
}
