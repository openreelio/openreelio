/**
 * DropIndicator Component
 *
 * Visual indicator for clip drop position on the timeline.
 * Shows a vertical line at the drop position with:
 * - Time tooltip showing the drop position in timecode
 * - Color coding: blue for valid, red for invalid drops
 * - Error message for invalid drop reasons
 */

import { memo } from 'react';
import { formatDuration } from '@/utils/formatters';
import type { DropValidity } from '@/utils/dropValidity';

// =============================================================================
// Types
// =============================================================================

export interface DropIndicatorProps {
  /** Horizontal position in pixels */
  position: number;
  /** Drop validity result */
  validity: DropValidity;
  /** Time in seconds at the drop position */
  time: number;
  /** Track height in pixels (for vertical line height) */
  trackHeight?: number;
  /** Whether to show the time tooltip */
  showTimeTooltip?: boolean;
  /** Whether to show the error message */
  showErrorMessage?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const DropIndicator = memo(function DropIndicator({
  position,
  validity,
  time,
  trackHeight = 64,
  showTimeTooltip = true,
  showErrorMessage = true,
}: DropIndicatorProps): JSX.Element {
  const isValid = validity.isValid;

  // Color classes based on validity
  const lineColorClass = isValid ? 'bg-blue-500' : 'bg-red-500';
  const glowClass = isValid
    ? 'shadow-[0_0_8px_rgba(59,130,246,0.6)]'
    : 'shadow-[0_0_8px_rgba(239,68,68,0.6)]';
  const tooltipBgClass = isValid ? 'bg-blue-600' : 'bg-red-600';

  return (
    <div
      data-testid="drop-indicator"
      data-valid={isValid}
      className={`absolute pointer-events-none z-50 transition-all duration-100`}
      style={{
        left: `${position}px`,
        top: 0,
        height: `${trackHeight}px`,
      }}
    >
      {/* Main indicator line */}
      <div
        className={`absolute inset-y-0 w-0.5 ${lineColorClass} ${glowClass}`}
        style={{ left: '-1px' }}
      />

      {/* Diamond marker at top */}
      <div
        className={`absolute -top-1 w-2 h-2 ${lineColorClass} rotate-45`}
        style={{ left: '-4px' }}
      />

      {/* Diamond marker at bottom */}
      <div
        className={`absolute -bottom-1 w-2 h-2 ${lineColorClass} rotate-45`}
        style={{ left: '-4px' }}
      />

      {/* Time tooltip */}
      {showTimeTooltip && (
        <div
          data-testid="drop-indicator-time"
          className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded text-xs font-mono whitespace-nowrap ${tooltipBgClass} text-white`}
        >
          {formatDuration(time)}
        </div>
      )}

      {/* Error message */}
      {showErrorMessage && !isValid && validity.message && (
        <div
          data-testid="drop-indicator-error"
          className="absolute top-1/2 left-4 -translate-y-1/2 px-2 py-1 bg-red-600 text-white text-xs rounded whitespace-nowrap shadow-lg"
        >
          {validity.message}
        </div>
      )}

      {/* Glow effect gradient */}
      <div
        className={`absolute inset-y-0 w-px ${
          isValid
            ? 'bg-gradient-to-b from-blue-400/0 via-blue-400/50 to-blue-400/0'
            : 'bg-gradient-to-b from-red-400/0 via-red-400/50 to-red-400/0'
        }`}
        style={{ left: '-0.5px' }}
      />
    </div>
  );
});
