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
  /** Frames per second for frame stepping (default: 30) */
  fps?: number;
  /** Current playback rate */
  playbackRate?: number;
  onPlayPause?: () => void;
  onSeek?: (time: number) => void;
  onVolumeChange?: (volume: number) => void;
  onMuteToggle?: () => void;
  onFullscreenToggle?: () => void;
  /** Callback for playback rate change */
  onPlaybackRateChange?: (rate: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

const VOLUME_STEP = 0.1;
const FAST_SEEK_STEP = 1; // For Shift+Arrow (1 second jump)
const DEFAULT_FPS = 30;

// Playback speed presets (shared between J/K/L controls and speed selector)
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

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
  fps = DEFAULT_FPS,
  playbackRate = 1,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onFullscreenToggle,
  onPlaybackRateChange,
}: PlayerControlsProps) {
  const frameTime = 1 / fps;
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

        // Arrow keys: Shift = 1 sec jump, normal = frame step
        case 'ArrowRight':
          e.preventDefault();
          if (e.shiftKey) {
            onSeek?.(Math.min(duration, currentTime + FAST_SEEK_STEP));
          } else {
            onSeek?.(Math.min(duration, currentTime + frameTime));
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.shiftKey) {
            onSeek?.(Math.max(0, currentTime - FAST_SEEK_STEP));
          } else {
            onSeek?.(Math.max(0, currentTime - frameTime));
          }
          break;

        // Frame stepping with . and ,
        case '.':
          e.preventDefault();
          onSeek?.(Math.min(duration, currentTime + frameTime));
          break;
        case ',':
          e.preventDefault();
          onSeek?.(Math.max(0, currentTime - frameTime));
          break;

        // Volume controls
        case 'ArrowUp':
          e.preventDefault();
          onVolumeChange?.(Math.min(1, volume + VOLUME_STEP));
          break;
        case 'ArrowDown':
          e.preventDefault();
          onVolumeChange?.(Math.max(0, volume - VOLUME_STEP));
          break;

        // Jump to start/end
        case 'Home':
          e.preventDefault();
          onSeek?.(0);
          break;
        case 'End':
          e.preventDefault();
          onSeek?.(duration);
          break;

        // J/K/L jog-shuttle controls (industry standard)
        // Note: HTML5 video doesn't support negative playbackRate, so J decreases speed
        case 'j':
        case 'J':
          e.preventDefault();
          // Decrease playback speed
          {
            // Find the closest speed that's less than or equal to current rate
            let currentIndex = SPEED_PRESETS.findIndex(s => s >= playbackRate);
            if (currentIndex === -1) {
              // playbackRate > max preset, go to max
              currentIndex = SPEED_PRESETS.length - 1;
            } else if (currentIndex === 0) {
              // Already at minimum
              currentIndex = 0;
            } else {
              // Step down
              currentIndex = currentIndex - 1;
            }
            onPlaybackRateChange?.(SPEED_PRESETS[currentIndex]);
          }
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          // Stop/pause and reset rate
          if (isPlaying) {
            onPlayPause?.();
          }
          onPlaybackRateChange?.(1);
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          // Increase playback speed
          {
            let currentIndex = SPEED_PRESETS.findIndex(s => s >= playbackRate);
            if (currentIndex === -1) {
              // playbackRate > max preset, stay at max
              currentIndex = SPEED_PRESETS.length - 1;
            } else if (currentIndex === SPEED_PRESETS.length - 1) {
              // Already at maximum
              currentIndex = SPEED_PRESETS.length - 1;
            } else {
              // Step up
              currentIndex = currentIndex + 1;
            }
            onPlaybackRateChange?.(SPEED_PRESETS[currentIndex]);
            if (!isPlaying) {
              onPlayPause?.();
            }
          }
          break;

        // Mute toggle
        case 'm':
        case 'M':
          e.preventDefault();
          onMuteToggle?.();
          break;

        // Fullscreen toggle
        case 'f':
        case 'F':
          e.preventDefault();
          onFullscreenToggle?.();
          break;
      }
    },
    [disabled, currentTime, duration, volume, frameTime, playbackRate, isPlaying, onPlayPause, onSeek, onVolumeChange, onMuteToggle, onFullscreenToggle, onPlaybackRateChange]
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

        {/* Playback Speed Selector */}
        <select
          data-testid="speed-selector"
          className="bg-transparent text-white text-xs px-1 py-0.5 rounded border border-white/20 hover:border-white/40 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          value={playbackRate.toString()}
          onChange={(e) => onPlaybackRateChange?.(parseFloat(e.target.value))}
          disabled={disabled}
          aria-label="Playback speed"
        >
          {SPEED_PRESETS.map((speed) => (
            <option key={speed} value={speed.toString()} className="bg-gray-800">
              {speed}x
            </option>
          ))}
        </select>

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
