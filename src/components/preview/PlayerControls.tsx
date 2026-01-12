/**
 * PlayerControls Component
 *
 * Video player control bar with play/pause, seek, volume, and fullscreen controls.
 */

import { useCallback, type KeyboardEvent } from 'react';
import { Maximize, Minimize } from 'lucide-react';
import { SeekBar } from './SeekBar';
import { PlaybackButtons } from './PlaybackButtons';
import { VolumeControls } from './VolumeControls';
import { formatDuration } from '@/utils/formatters';

// =============================================================================
// Types
// =============================================================================

export interface PlayerControlsProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  volume: number;
  isMuted: boolean;
  buffered?: number;
  isFullscreen?: boolean;
  disabled?: boolean;
  onPlayPause?: () => void;
  onSeek?: (time: number) => void;
  onVolumeChange?: (volume: number) => void;
  onMuteToggle?: () => void;
  onFullscreenToggle?: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const VOLUME_STEP = 0.1;
const SEEK_STEP = 5;

// =============================================================================
// Component
// =============================================================================

export function PlayerControls({
  currentTime,
  duration,
  isPlaying,
  volume,
  isMuted,
  buffered = 0,
  isFullscreen = false,
  disabled = false,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onFullscreenToggle,
}: PlayerControlsProps) {
  const handleFullscreenToggle = useCallback(() => {
    if (!disabled) {
      onFullscreenToggle?.();
    }
  }, [disabled, onFullscreenToggle]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          onPlayPause?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          onSeek?.(Math.min(duration, currentTime + SEEK_STEP));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onSeek?.(Math.max(0, currentTime - SEEK_STEP));
          break;
        case 'ArrowUp':
          e.preventDefault();
          onVolumeChange?.(Math.min(1, volume + VOLUME_STEP));
          break;
        case 'ArrowDown':
          e.preventDefault();
          onVolumeChange?.(Math.max(0, volume - VOLUME_STEP));
          break;
        case 'Home':
          e.preventDefault();
          onSeek?.(0);
          break;
        case 'End':
          e.preventDefault();
          onSeek?.(duration);
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          onMuteToggle?.();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          onFullscreenToggle?.();
          break;
      }
    },
    [disabled, currentTime, duration, volume, onPlayPause, onSeek, onVolumeChange, onMuteToggle, onFullscreenToggle]
  );

  return (
    <div
      data-testid="player-controls"
      className="flex flex-col w-full bg-gradient-to-t from-black/80 to-transparent p-2 text-white"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Seek Bar */}
      <div className="mb-2">
        <SeekBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          onSeek={onSeek}
          disabled={disabled}
        />
      </div>

      {/* Controls Row */}
      <div className="flex items-center gap-2">
        <PlaybackButtons
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          onPlayPause={onPlayPause}
          onSeek={onSeek}
          disabled={disabled}
        />

        <div className="flex items-center gap-1 text-sm font-mono">
          <span data-testid="time-display">{formatDuration(currentTime)}</span>
          <span>/</span>
          <span data-testid="duration-display">{formatDuration(duration)}</span>
        </div>

        <div className="flex-1" />

        <VolumeControls
          volume={volume}
          isMuted={isMuted}
          onVolumeChange={onVolumeChange}
          onMuteToggle={onMuteToggle}
          disabled={disabled}
        />

        <button
          data-testid="fullscreen-button"
          type="button"
          className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleFullscreenToggle}
          disabled={disabled}
          aria-label="Toggle fullscreen"
        >
          {isFullscreen ? (
            <Minimize data-testid="fullscreen-exit-icon" className="w-4 h-4" />
          ) : (
            <Maximize data-testid="fullscreen-enter-icon" className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}
