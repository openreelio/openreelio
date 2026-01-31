/**
 * TimecodeDisplay Component
 *
 * Professional timecode display component supporting SMPTE and timestamp formats.
 * Uses the centralized timecode utilities from precision.ts for consistent formatting.
 *
 * Features:
 * - SMPTE timecode format (HH:MM:SS:FF)
 * - Timestamp formats (MM:SS, HH:MM:SS, MM:SS.mmm)
 * - Configurable display modes
 * - Monospace font for consistent digit width
 *
 * @module components/timeline/TimecodeDisplay
 */

import { memo, useMemo } from 'react';
import {
  formatTimecode,
  formatTimestamp,
  formatTimestampMs,
  DEFAULT_FPS,
} from '@/constants/precision';

// =============================================================================
// Types
// =============================================================================

/**
 * Display format for the timecode.
 */
export type TimecodeFormat = 'smpte' | 'timestamp' | 'timestamp-ms' | 'frames' | 'seconds';

/**
 * Props for TimecodeDisplay component.
 */
export interface TimecodeDisplayProps {
  /** Time in seconds to display */
  time: number;
  /** Frames per second (for SMPTE and frames format) */
  fps?: number;
  /** Display format */
  format?: TimecodeFormat;
  /** Whether to show hours (for timestamp formats) */
  showHours?: boolean;
  /** Whether to use drop-frame timecode (for SMPTE at 29.97/59.94 fps) */
  dropFrame?: boolean;
  /** Millisecond precision (for timestamp-ms format) */
  msPrecision?: number;
  /** Additional CSS classes */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show separator labels (for SMPTE) */
  showLabels?: boolean;
  /** Optional prefix label */
  label?: string;
}

// =============================================================================
// Constants
// =============================================================================

const SIZE_CLASSES = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
} as const;

// =============================================================================
// Component
// =============================================================================

/**
 * Professional timecode display component.
 *
 * @example
 * ```tsx
 * // SMPTE format at 30fps
 * <TimecodeDisplay time={125.5} format="smpte" fps={30} />
 * // Output: 00:02:05:15
 *
 * // Timestamp with milliseconds
 * <TimecodeDisplay time={125.567} format="timestamp-ms" msPrecision={2} />
 * // Output: 02:05.57
 *
 * // Simple timestamp
 * <TimecodeDisplay time={3725} format="timestamp" showHours />
 * // Output: 01:02:05
 * ```
 */
function TimecodeDisplayComponent({
  time,
  fps = DEFAULT_FPS,
  format = 'smpte',
  showHours = false,
  dropFrame = false,
  msPrecision = 3,
  className = '',
  size = 'md',
  showLabels = false,
  label,
}: TimecodeDisplayProps) {
  const formattedTime = useMemo(() => {
    // Guard against invalid time values - use local variable to avoid parameter reassignment
    const safeTime = (!Number.isFinite(time) || time < 0) ? 0 : time;

    switch (format) {
      case 'smpte':
        return formatTimecode(safeTime, fps, { dropFrame, showLabels });

      case 'timestamp':
        return formatTimestamp(safeTime, showHours);

      case 'timestamp-ms':
        return formatTimestampMs(safeTime, showHours, msPrecision);

      case 'frames': {
        const totalFrames = Math.floor(safeTime * fps);
        return totalFrames.toString().padStart(6, '0');
      }

      case 'seconds':
        return safeTime.toFixed(3) + 's';

      default:
        return formatTimecode(safeTime, fps, { dropFrame });
    }
  }, [time, fps, format, showHours, dropFrame, msPrecision, showLabels]);

  const sizeClass = SIZE_CLASSES[size];

  return (
    <span
      data-testid="timecode-display"
      className={`font-mono tabular-nums ${sizeClass} ${className}`}
    >
      {label && <span className="text-editor-text-muted mr-1">{label}</span>}
      {formattedTime}
    </span>
  );
}

/**
 * Memoized TimecodeDisplay component.
 */
export const TimecodeDisplay = memo(TimecodeDisplayComponent);

// =============================================================================
// Specialized Components
// =============================================================================

/**
 * Current time display with both SMPTE and timestamp formats.
 */
export interface CurrentTimeDisplayProps {
  /** Current time in seconds */
  time: number;
  /** Total duration in seconds */
  duration?: number;
  /** Frames per second */
  fps?: number;
  /** Whether to show duration */
  showDuration?: boolean;
  /** Additional CSS classes */
  className?: string;
}

function CurrentTimeDisplayComponent({
  time,
  duration = 0,
  fps = DEFAULT_FPS,
  showDuration = true,
  className = '',
}: CurrentTimeDisplayProps) {
  return (
    <div
      data-testid="current-time-display"
      className={`flex items-center gap-2 font-mono tabular-nums text-sm ${className}`}
    >
      <TimecodeDisplay time={time} fps={fps} format="smpte" />
      {showDuration && duration > 0 && (
        <>
          <span className="text-editor-text-muted">/</span>
          <TimecodeDisplay time={duration} fps={fps} format="smpte" className="text-editor-text-muted" />
        </>
      )}
    </div>
  );
}

export const CurrentTimeDisplay = memo(CurrentTimeDisplayComponent);

export default TimecodeDisplay;
