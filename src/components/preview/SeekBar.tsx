/**
 * SeekBar Component
 *
 * Video player seek bar with progress and buffer indicators.
 */

import { useCallback, type MouseEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface SeekBarProps {
  /** Current playback time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Buffered time in seconds */
  buffered?: number;
  /** Callback when user seeks to a position */
  onSeek?: (time: number) => void;
  /** Whether the seek bar is disabled */
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function SeekBar({
  currentTime,
  duration,
  buffered = 0,
  onSeek,
  disabled = false,
}: SeekBarProps) {
  // ===========================================================================
  // Calculations
  // ===========================================================================

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (disabled || !onSeek) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = clickX / rect.width;
      const newTime = percent * duration;

      onSeek(newTime);
    },
    [disabled, onSeek, duration]
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="seek-bar"
      role="slider"
      aria-valuenow={currentTime}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-label="Seek"
      className={`relative h-2 bg-gray-700 rounded cursor-pointer ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      }`}
      onClick={handleClick}
    >
      {/* Buffer Bar */}
      <div
        data-testid="buffer-bar"
        className="absolute top-0 left-0 h-full bg-gray-500 rounded"
        style={{ width: `${bufferPercent}%` }}
      />

      {/* Progress Bar */}
      <div
        className="absolute top-0 left-0 h-full bg-primary rounded"
        style={{ width: `${progressPercent}%` }}
      />
    </div>
  );
}
