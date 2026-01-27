/**
 * ShotPanel Component
 *
 * Panel for displaying and managing detected shots in a video asset.
 * Provides shot detection trigger, shot list, and navigation.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Scissors,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { formatDuration } from '@/utils';
import type { Shot, ShotDetectionConfig } from '@/hooks/useShotDetection';

// =============================================================================
// Types
// =============================================================================

export interface ShotPanelProps {
  /** Currently detected shots */
  shots: Shot[];
  /** Whether detection is in progress */
  isDetecting: boolean;
  /** Whether shots are being loaded */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Current playhead time */
  currentTime?: number;
  /** Callback to detect shots */
  onDetectShots: (config?: ShotDetectionConfig) => Promise<void>;
  /** Callback to navigate to a shot */
  onNavigateToShot: (shot: Shot) => void;
  /** Callback to clear error */
  onClearError?: () => void;
}

// =============================================================================
// Sub-components
// =============================================================================

interface ShotListItemProps {
  shot: Shot;
  index: number;
  isActive: boolean;
  onClick: () => void;
}

function ShotListItem({ shot, index, isActive, onClick }: ShotListItemProps) {
  const duration = shot.endSec - shot.startSec;

  return (
    <button
      type="button"
      data-testid={`shot-item-${shot.id}`}
      className={`
        w-full text-left px-3 py-2 rounded-md
        transition-colors duration-100
        ${
          isActive
            ? 'bg-primary-500/20 border border-primary-500/50'
            : 'bg-editor-sidebar hover:bg-editor-highlight border border-transparent'
        }
      `}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-editor-text">
          Shot {index + 1}
        </span>
        <span className="text-xs text-editor-text-muted">
          {duration.toFixed(1)}s
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1 text-xs text-editor-text-muted">
        <span>{formatDuration(shot.startSec)}</span>
        <span>-</span>
        <span>{formatDuration(shot.endSec)}</span>
      </div>
    </button>
  );
}

// =============================================================================
// Component
// =============================================================================

export function ShotPanel({
  shots,
  isDetecting,
  isLoading,
  error,
  currentTime = 0,
  onDetectShots,
  onNavigateToShot,
  onClearError,
}: ShotPanelProps) {
  // ===========================================================================
  // State
  // ===========================================================================

  const [showSettings, setShowSettings] = useState(false);
  const [threshold, setThreshold] = useState(0.3);
  const [minDuration, setMinDuration] = useState(0.5);

  // ===========================================================================
  // Computed Values
  // ===========================================================================

  // Find the current shot based on playhead position
  const currentShotIndex = useMemo(() => {
    if (shots.length === 0) return -1;
    return shots.findIndex(
      (shot) => currentTime >= shot.startSec && currentTime < shot.endSec
    );
  }, [shots, currentTime]);

  const currentShot = currentShotIndex >= 0 ? shots[currentShotIndex] : null;

  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleDetect = useCallback(async () => {
    await onDetectShots({
      threshold,
      minShotDuration: minDuration,
    });
  }, [onDetectShots, threshold, minDuration]);

  const handlePreviousShot = useCallback(() => {
    if (shots.length === 0) return;

    let targetIndex = currentShotIndex - 1;

    // If we're past the start of current shot, go to start of current shot
    if (currentShot && currentTime > currentShot.startSec + 0.5) {
      targetIndex = currentShotIndex;
    }

    // Clamp to valid range
    targetIndex = Math.max(0, targetIndex);

    const targetShot = shots[targetIndex];
    if (targetShot) {
      onNavigateToShot(targetShot);
    }
  }, [shots, currentShotIndex, currentShot, currentTime, onNavigateToShot]);

  const handleNextShot = useCallback(() => {
    if (shots.length === 0) return;

    const targetIndex = Math.min(shots.length - 1, currentShotIndex + 1);
    const targetShot = shots[targetIndex];
    if (targetShot) {
      onNavigateToShot(targetShot);
    }
  }, [shots, currentShotIndex, onNavigateToShot]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div data-testid="shot-panel" className="p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-editor-text flex items-center gap-2">
          <Scissors className="w-4 h-4 text-amber-500" />
          Shot Detection
        </h3>
        <button
          type="button"
          className="p-1 rounded hover:bg-editor-highlight"
          onClick={() => setShowSettings(!showSettings)}
          title="Detection settings"
        >
          <Settings2 className="w-4 h-4 text-editor-text-muted" />
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-md">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-red-400">{error}</p>
              {onClearError && (
                <button
                  type="button"
                  className="text-xs text-red-400 hover:text-red-300 mt-1"
                  onClick={onClearError}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Panel */}
      {showSettings && (
        <div className="mb-4 p-3 bg-editor-sidebar rounded-md space-y-3">
          <div>
            <label
              htmlFor="shot-threshold"
              className="text-xs text-editor-text-muted block mb-1"
            >
              Sensitivity (Threshold)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="shot-threshold"
                type="range"
                min="0.1"
                max="0.9"
                step="0.1"
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
                className="flex-1"
                aria-describedby="threshold-hint"
              />
              <span className="text-xs text-editor-text w-8" aria-hidden="true">
                {threshold}
              </span>
            </div>
            <p id="threshold-hint" className="text-[10px] text-editor-text-muted mt-1">
              Lower = more shots, Higher = fewer shots
            </p>
          </div>

          <div>
            <label
              htmlFor="shot-min-duration"
              className="text-xs text-editor-text-muted block mb-1"
            >
              Min Shot Duration (sec)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="shot-min-duration"
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                value={minDuration}
                onChange={(e) => setMinDuration(parseFloat(e.target.value))}
                className="flex-1"
                aria-label={`Minimum shot duration: ${minDuration} seconds`}
              />
              <span className="text-xs text-editor-text w-8" aria-hidden="true">
                {minDuration}s
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Detect Button / Status */}
      {shots.length === 0 && !isDetecting && !isLoading && (
        <div className="mb-4">
          <button
            type="button"
            data-testid="detect-shots-button"
            className={`
              w-full py-2 px-4 rounded-md
              bg-amber-500/20 hover:bg-amber-500/30
              border border-amber-500/50
              text-amber-400 text-sm font-medium
              transition-colors duration-100
              flex items-center justify-center gap-2
            `}
            onClick={handleDetect}
            disabled={isDetecting}
          >
            <Scissors className="w-4 h-4" />
            Detect Shots
          </button>
          <p className="text-[10px] text-editor-text-muted text-center mt-2">
            Analyze video to find scene changes
          </p>
        </div>
      )}

      {/* Loading State */}
      {(isDetecting || isLoading) && (
        <div className="mb-4 flex flex-col items-center py-4">
          <Loader2 className="w-6 h-6 text-amber-500 animate-spin mb-2" />
          <p className="text-sm text-editor-text-muted">
            {isDetecting ? 'Detecting shots...' : 'Loading shots...'}
          </p>
        </div>
      )}

      {/* Shot List & Navigation */}
      {shots.length > 0 && !isDetecting && !isLoading && (
        <>
          {/* Navigation Controls */}
          <div className="flex items-center justify-between mb-4 p-2 bg-editor-sidebar rounded-md">
            <button
              type="button"
              data-testid="prev-shot-button"
              className="p-1.5 rounded hover:bg-editor-highlight disabled:opacity-30"
              onClick={handlePreviousShot}
              disabled={currentShotIndex <= 0 && (!currentShot || currentTime <= currentShot.startSec + 0.5)}
              title="Previous shot"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <div className="text-center">
              <div className="text-sm font-medium text-editor-text">
                {currentShot ? `Shot ${currentShotIndex + 1}` : 'No shot'}
              </div>
              <div className="text-xs text-editor-text-muted">
                {shots.length} total shots
              </div>
            </div>

            <button
              type="button"
              data-testid="next-shot-button"
              className="p-1.5 rounded hover:bg-editor-highlight disabled:opacity-30"
              onClick={handleNextShot}
              disabled={currentShotIndex >= shots.length - 1}
              title="Next shot"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* Re-detect Button */}
          <button
            type="button"
            className="w-full mb-4 py-1.5 px-3 rounded-md text-xs
              bg-editor-sidebar hover:bg-editor-highlight
              text-editor-text-muted
              flex items-center justify-center gap-1.5"
            onClick={handleDetect}
          >
            <RefreshCw className="w-3 h-3" />
            Re-detect with current settings
          </button>

          {/* Shot List */}
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {shots.map((shot, index) => (
              <ShotListItem
                key={shot.id}
                shot={shot}
                index={index}
                isActive={currentShotIndex === index}
                onClick={() => onNavigateToShot(shot)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default ShotPanel;
