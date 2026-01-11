/**
 * PlayerControls Component
 *
 * Video player control bar with play/pause, seek, volume, and fullscreen controls.
 */

import { useCallback, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Volume1,
  Maximize,
  Minimize,
  SkipBack,
  SkipForward,
} from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface PlayerControlsProps {
  /** Current playback time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Whether video is currently playing */
  isPlaying: boolean;
  /** Current volume (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Buffered amount in seconds */
  buffered?: number;
  /** Whether in fullscreen mode */
  isFullscreen?: boolean;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Play/pause toggle handler */
  onPlayPause?: () => void;
  /** Seek handler (time in seconds) */
  onSeek?: (time: number) => void;
  /** Volume change handler (0-1) */
  onVolumeChange?: (volume: number) => void;
  /** Mute toggle handler */
  onMuteToggle?: () => void;
  /** Fullscreen toggle handler */
  onFullscreenToggle?: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const SKIP_AMOUNT = 10;
const VOLUME_STEP = 0.1;
const SEEK_STEP = 5;

// =============================================================================
// Utilities
// =============================================================================

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

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
  const seekBarRef = useRef<HTMLDivElement>(null);

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handlePlayPause = useCallback(() => {
    if (!disabled) {
      onPlayPause?.();
    }
  }, [disabled, onPlayPause]);

  const handleSkipBackward = useCallback(() => {
    if (!disabled) {
      const newTime = Math.max(0, currentTime - SKIP_AMOUNT);
      onSeek?.(newTime);
    }
  }, [disabled, currentTime, onSeek]);

  const handleSkipForward = useCallback(() => {
    if (!disabled) {
      const newTime = Math.min(duration, currentTime + SKIP_AMOUNT);
      onSeek?.(newTime);
    }
  }, [disabled, currentTime, duration, onSeek]);

  const handleSeekBarClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!disabled && seekBarRef.current && duration > 0) {
        const rect = seekBarRef.current.getBoundingClientRect();
        const clickPosition = (e.clientX - rect.left) / rect.width;
        const newTime = clickPosition * duration;
        onSeek?.(Math.max(0, Math.min(duration, newTime)));
      }
    },
    [disabled, duration, onSeek]
  );

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!disabled) {
        onVolumeChange?.(parseFloat(e.target.value));
      }
    },
    [disabled, onVolumeChange]
  );

  const handleMuteToggle = useCallback(() => {
    if (!disabled) {
      onMuteToggle?.();
    }
  }, [disabled, onMuteToggle]);

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

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  // Volume icon based on level
  const VolumeIcon = isMuted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="player-controls"
      className="flex flex-col w-full bg-gradient-to-t from-black/80 to-transparent p-2 text-white"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Seek Bar */}
      <div className="mb-2">
        <div
          ref={seekBarRef}
          data-testid="seek-bar"
          role="slider"
          aria-label="Seek"
          aria-valuenow={currentTime}
          aria-valuemin={0}
          aria-valuemax={duration}
          className="relative h-1 bg-white/30 rounded-full cursor-pointer group"
          onClick={handleSeekBarClick}
        >
          {/* Buffer Progress */}
          <div
            data-testid="buffer-bar"
            className="absolute h-full bg-white/50 rounded-full"
            style={{ width: `${bufferedPercent}%` }}
          />
          {/* Play Progress */}
          <div
            className="absolute h-full bg-primary-500 rounded-full"
            style={{ width: `${progressPercent}%` }}
          />
          {/* Scrubber Handle */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `calc(${progressPercent}% - 6px)` }}
          />
        </div>
      </div>

      {/* Controls Row */}
      <div className="flex items-center gap-2">
        {/* Skip Backward */}
        <button
          data-testid="skip-backward-button"
          className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleSkipBackward}
          disabled={disabled}
          aria-label="Skip backward 10 seconds"
        >
          <SkipBack className="w-4 h-4" />
        </button>

        {/* Play/Pause */}
        {isPlaying ? (
          <button
            data-testid="pause-button"
            className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handlePlayPause}
            disabled={disabled}
            aria-label="Pause"
          >
            <Pause className="w-5 h-5" />
          </button>
        ) : (
          <button
            data-testid="play-button"
            className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handlePlayPause}
            disabled={disabled}
            aria-label="Play"
          >
            <Play className="w-5 h-5" />
          </button>
        )}

        {/* Skip Forward */}
        <button
          data-testid="skip-forward-button"
          className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleSkipForward}
          disabled={disabled}
          aria-label="Skip forward 10 seconds"
        >
          <SkipForward className="w-4 h-4" />
        </button>

        {/* Time Display */}
        <div className="flex items-center gap-1 text-sm font-mono">
          <span data-testid="time-display">{formatTime(currentTime)}</span>
          <span>/</span>
          <span data-testid="duration-display">{formatTime(duration)}</span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Volume Controls */}
        <div className="flex items-center gap-1">
          <button
            data-testid="volume-button"
            className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleMuteToggle}
            disabled={disabled}
            aria-label="Toggle mute"
          >
            {isMuted ? (
              <VolumeX data-testid="mute-icon" className="w-4 h-4" />
            ) : (
              <VolumeIcon data-testid="volume-icon" className="w-4 h-4" />
            )}
          </button>
          <input
            data-testid="volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            disabled={disabled}
            aria-label="Volume"
            className="w-16 h-1 bg-white/30 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
              [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
          />
        </div>

        {/* Fullscreen */}
        <button
          data-testid="fullscreen-button"
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
