/**
 * PlayerControls Component
 *
 * Video player control bar with play/pause, seek, volume, and fullscreen controls.
 * JKL shuttle is handled globally by useKeyboardShortcuts; shuttle speed is
 * passed as a prop from the parent container.
 */

import { useCallback, type KeyboardEvent } from 'react';
import { Maximize, Minimize } from 'lucide-react';
import { SeekBar } from './SeekBar';
import { PlaybackButtons } from './PlaybackButtons';
import { VolumeControls } from './VolumeControls';
import { formatTimecode } from '@/utils/formatters';
import { ShuttleSpeedIndicator } from './ShuttleSpeedIndicator';
import { TimecodeInput } from '@/components/features/preview/TimecodeInput';

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
  /** Current JKL shuttle speed (0 = inactive) */
  shuttleSpeed?: number;
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

// Playback speed presets for the speed selector dropdown
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8] as const;

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
  shuttleSpeed = 0,
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

  // Local keyboard handler for controls-specific shortcuts.
  // J/K/L shuttle is handled globally by useKeyboardShortcuts + useJKLShuttle.
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
    [disabled, currentTime, duration, volume, frameTime, onPlayPause, onSeek, onVolumeChange, onMuteToggle, onFullscreenToggle]
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
          <TimecodeInput
            currentTime={currentTime}
            duration={duration}
            fps={fps}
            onSeek={onSeek}
            disabled={disabled}
          />
          <span>/</span>
          <span data-testid="duration-display">{formatTimecode(duration, fps)}</span>
        </div>

        {/* Shuttle Speed Badge — visible only when shuttle is active */}
        <ShuttleSpeedIndicator
          shuttleSpeed={shuttleSpeed}
          className="static translate-x-0 text-[10px] px-1.5 py-0.5"
        />

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
