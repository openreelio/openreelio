/**
 * Progress Panel Component
 *
 * Detailed progress panel with time estimates for long operations.
 */

import { X, Pause, Play, StopCircle } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface ProgressPanelProps {
  /** Panel title */
  title: string;
  /** Progress value (0-100) */
  progress: number;
  /** Current operation description */
  currentOperation?: string;
  /** Elapsed time in seconds */
  elapsed?: number;
  /** Estimated remaining time in seconds */
  remaining?: number;
  /** Pause callback */
  onPause?: () => void;
  /** Cancel callback */
  onCancel?: () => void;
  /** Is operation paused */
  isPaused?: boolean;
  /** Custom class name */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || seconds === 0) return '--:--';

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// Progress Panel Component
// =============================================================================

export function ProgressPanel({
  title,
  progress,
  currentOperation,
  elapsed,
  remaining,
  onPause,
  onCancel,
  isPaused = false,
  className = '',
}: ProgressPanelProps): JSX.Element {
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div
      className={`bg-surface-overlay rounded-lg border border-border-default p-4 w-96 shadow-lg ${className}`}
      role="progressbar"
      aria-valuenow={clampedProgress}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        {onCancel && (
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-surface-highest text-text-muted hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-surface-base rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-accent-primary transition-all duration-300"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>

      {/* Progress percentage */}
      <div className="text-right text-xs text-text-secondary mb-3">
        {clampedProgress.toFixed(0)}%
      </div>

      {/* Current operation */}
      {currentOperation && (
        <p className="text-xs text-text-muted mb-2 truncate">{currentOperation}</p>
      )}

      {/* Time info */}
      {(elapsed !== undefined || remaining !== undefined) && (
        <div className="flex justify-between text-xs text-text-muted mb-3">
          <span>Elapsed: {formatTime(elapsed)}</span>
          <span>Remaining: ~{formatTime(remaining)}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        {onPause && (
          <button
            onClick={onPause}
            className="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-surface-highest rounded transition-colors flex items-center gap-1.5"
            aria-label={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {isPaused ? 'Resume' : 'Pause'}
          </button>
        )}
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm bg-accent-error/10 text-accent-error hover:bg-accent-error/20 rounded transition-colors flex items-center gap-1.5"
            aria-label="Cancel"
          >
            <StopCircle className="w-3.5 h-3.5" />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
