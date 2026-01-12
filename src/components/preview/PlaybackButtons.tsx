/**
 * PlaybackButtons Component
 *
 * Play, pause, and skip buttons for media player.
 */

import { useCallback } from 'react';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface PlaybackButtonsProps {
  /** Whether media is currently playing */
  isPlaying: boolean;
  /** Current playback time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Callback when play/pause toggled */
  onPlayPause?: () => void;
  /** Callback when seeking (time in seconds) */
  onSeek?: (time: number) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Skip amount in seconds */
  skipAmount?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SKIP_AMOUNT = 10;

// =============================================================================
// Component
// =============================================================================

export function PlaybackButtons({
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  disabled = false,
  skipAmount = DEFAULT_SKIP_AMOUNT,
}: PlaybackButtonsProps) {
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
      const newTime = Math.max(0, currentTime - skipAmount);
      onSeek?.(newTime);
    }
  }, [disabled, currentTime, skipAmount, onSeek]);

  const handleSkipForward = useCallback(() => {
    if (!disabled) {
      const newTime = Math.min(duration, currentTime + skipAmount);
      onSeek?.(newTime);
    }
  }, [disabled, currentTime, duration, skipAmount, onSeek]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div data-testid="playback-buttons" className="flex items-center gap-1">
      {/* Skip Backward */}
      <button
        data-testid="skip-backward-button"
        type="button"
        className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleSkipBackward}
        disabled={disabled}
        aria-label={`Skip backward ${skipAmount} seconds`}
      >
        <SkipBack className="w-4 h-4" />
      </button>

      {/* Play/Pause */}
      {isPlaying ? (
        <button
          data-testid="pause-button"
          type="button"
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
          type="button"
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
        type="button"
        className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleSkipForward}
        disabled={disabled}
        aria-label={`Skip forward ${skipAmount} seconds`}
      >
        <SkipForward className="w-4 h-4" />
      </button>
    </div>
  );
}
