/**
 * ShotList Component
 *
 * Displays detected shots with thumbnails and navigation.
 * Allows clicking to jump to shot timecode.
 */

import { memo, useCallback } from 'react';

import type { ShotResult } from '@/bindings';

// =============================================================================
// Types
// =============================================================================

export interface ShotListProps {
  /** Detected shots */
  shots: ShotResult[];
  /** Current playhead position in seconds */
  currentTime?: number;
  /** Callback when shot is clicked */
  onShotClick?: (timeSec: number) => void;
  /** Whether thumbnails should be shown */
  showThumbnails?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const ShotList = memo(function ShotList({
  shots,
  currentTime = 0,
  onShotClick,
  showThumbnails = true,
}: ShotListProps): JSX.Element {
  const handleClick = useCallback(
    (timeSec: number) => {
      onShotClick?.(timeSec);
    },
    [onShotClick]
  );

  if (shots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <svg
          className="mb-3 h-12 w-12 text-editor-text-muted/50"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
          />
        </svg>
        <p className="text-sm text-editor-text-muted">No shots detected</p>
        <p className="mt-1 text-xs text-editor-text-muted/70">
          Run shot detection to identify scene changes
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-center justify-between text-xs text-editor-text-muted">
        <span>{shots.length} shots detected</span>
        <span>Click to navigate</span>
      </div>

      <div className="max-h-[400px] space-y-1 overflow-y-auto">
        {shots.map((shot, index) => (
          <ShotItem
            key={`${shot.startSec}-${index}`}
            shot={shot}
            index={index}
            isActive={currentTime >= shot.startSec && currentTime < shot.endSec}
            onClick={handleClick}
            showThumbnail={showThumbnails}
          />
        ))}
      </div>
    </div>
  );
});

// =============================================================================
// ShotItem Sub-component
// =============================================================================

interface ShotItemProps {
  shot: ShotResult;
  index: number;
  isActive: boolean;
  onClick: (timeSec: number) => void;
  showThumbnail: boolean;
}

const ShotItem = memo(function ShotItem({
  shot,
  index,
  isActive,
  onClick,
  showThumbnail,
}: ShotItemProps): JSX.Element {
  const handleClick = () => onClick(shot.startSec);
  const duration = shot.endSec - shot.startSec;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`flex w-full items-center gap-3 rounded p-2 text-left transition-colors ${
        isActive
          ? 'bg-blue-600/20 ring-1 ring-blue-500'
          : 'bg-editor-surface hover:bg-editor-border'
      }`}
      data-testid={`shot-item-${index}`}
    >
      {/* Thumbnail placeholder */}
      {showThumbnail && (
        <div className="relative h-12 w-20 flex-shrink-0 overflow-hidden rounded bg-editor-bg">
          {shot.keyframePath ? (
            <img
              src={`asset://localhost/${shot.keyframePath}`}
              alt={`Shot ${index + 1}`}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-editor-text-muted">
              Shot {index + 1}
            </div>
          )}
          {/* Confidence badge */}
          {shot.confidence > 0 && (
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] text-white">
              {Math.round(shot.confidence * 100)}%
            </span>
          )}
        </div>
      )}

      {/* Shot info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-editor-text">Shot {index + 1}</span>
          <span className="text-xs text-editor-text-muted">{formatDuration(duration)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-editor-text-muted">
          <span>{formatTimecode(shot.startSec)}</span>
          <span className="text-editor-text-muted/50">→</span>
          <span>{formatTimecode(shot.endSec)}</span>
        </div>
        {shot.confidence && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-editor-bg">
            <div
              className="h-full bg-green-500"
              style={{ width: `${Math.round(shot.confidence * 100)}%` }}
            />
          </div>
        )}
      </div>
    </button>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function formatTimecode(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const frames = Math.floor((seconds % 1) * 30); // Assume 30fps
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)}ms`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
