/**
 * Playhead Component
 *
 * Displays the current playback position on the timeline.
 */

// =============================================================================
// Types
// =============================================================================

interface PlayheadProps {
  /** Current position in seconds */
  position: number;
  /** Zoom level (pixels per second) */
  zoom: number;
  /** Whether playback is active */
  isPlaying?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function Playhead({ position, zoom, isPlaying = false }: PlayheadProps) {
  const leftPosition = position * zoom;

  return (
    <div
      data-testid="playhead"
      data-playing={isPlaying ? 'true' : 'false'}
      className="absolute top-0 h-full w-0.5 bg-primary-500 z-20 pointer-events-none"
      style={{ left: `${leftPosition}px` }}
    >
      {/* Playhead head marker */}
      <div
        data-testid="playhead-head"
        className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-primary-500 rounded-sm transform rotate-45"
      />
    </div>
  );
}
