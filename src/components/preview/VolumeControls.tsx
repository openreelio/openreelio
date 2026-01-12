/**
 * VolumeControls Component
 *
 * Volume button and slider for media player.
 */

import { useCallback, type ChangeEvent } from 'react';
import { Volume2, Volume1, VolumeX } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface VolumeControlsProps {
  /** Current volume (0-1) */
  volume: number;
  /** Whether audio is muted */
  isMuted: boolean;
  /** Callback when volume changes */
  onVolumeChange?: (volume: number) => void;
  /** Callback when mute is toggled */
  onMuteToggle?: () => void;
  /** Whether controls are disabled */
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function VolumeControls({
  volume,
  isMuted,
  onVolumeChange,
  onMuteToggle,
  disabled = false,
}: VolumeControlsProps) {
  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleMuteToggle = useCallback(() => {
    if (!disabled) {
      onMuteToggle?.();
    }
  }, [disabled, onMuteToggle]);

  const handleVolumeChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (!disabled) {
        onVolumeChange?.(parseFloat(e.target.value));
      }
    },
    [disabled, onVolumeChange]
  );

  // ===========================================================================
  // Render Helpers
  // ===========================================================================

  const renderVolumeIcon = () => {
    if (isMuted || volume === 0) {
      return <VolumeX data-testid="mute-icon" className="w-4 h-4" />;
    }
    if (volume < 0.5) {
      return <Volume1 data-testid="volume-low-icon" className="w-4 h-4" />;
    }
    return <Volume2 data-testid="volume-high-icon" className="w-4 h-4" />;
  };

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div data-testid="volume-controls" className="flex items-center gap-1">
      <button
        data-testid="volume-button"
        type="button"
        className="p-1.5 rounded hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={handleMuteToggle}
        disabled={disabled}
        aria-label="Toggle mute"
      >
        {renderVolumeIcon()}
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
  );
}
