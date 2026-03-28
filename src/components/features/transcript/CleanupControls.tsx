/** Cleanup detection controls for silence and filler word removal. */

import React, { useCallback, useState } from 'react';
import { VolumeX, MessageCircleOff, Trash2, X, Loader2, SlidersHorizontal } from 'lucide-react';
import type { CleanupMode, SilenceDetectionParams } from '@/hooks/useCleanupDetection';
import {
  DEFAULT_SILENCE_PARAMS,
} from '@/hooks/useCleanupDetection';
import type { DetectedRegion } from '@/types';

/** Props for CleanupControls */
export interface CleanupControlsProps {
  /** Currently detected regions */
  detectedRegions: DetectedRegion[];
  /** Whether detection is running */
  isDetecting: boolean;
  /** Whether removal is running */
  isRemoving: boolean;
  /** Current cleanup mode */
  mode: CleanupMode;
  /** Total duration of detected regions */
  totalDurationSec: number;
  /** Error message */
  error: string | null;
  /** Trigger silence detection */
  onDetectSilence: (params?: SilenceDetectionParams) => Promise<void>;
  /** Trigger filler word detection */
  onDetectFillers: (customWords?: string[]) => Promise<void>;
  /** Remove detected regions */
  onRemoveDetected: (paddingSec?: number) => Promise<void>;
  /** Clear detection */
  onClearDetection: () => void;
  /** Read-only mode */
  readOnly?: boolean;
}

/** Toolbar and controls for transcript cleanup operations */
export const CleanupControls: React.FC<CleanupControlsProps> = ({
  detectedRegions,
  isDetecting,
  isRemoving,
  mode,
  totalDurationSec,
  error,
  onDetectSilence,
  onDetectFillers,
  onRemoveDetected,
  onClearDetection,
  readOnly = false,
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_SILENCE_PARAMS.thresholdDb);
  const [minDuration, setMinDuration] = useState(DEFAULT_SILENCE_PARAMS.minDurationSec);

  const handleDetectSilence = useCallback(() => {
    void onDetectSilence({ thresholdDb, minDurationSec: minDuration });
  }, [onDetectSilence, thresholdDb, minDuration]);

  const handleDetectFillers = useCallback(() => {
    void onDetectFillers();
  }, [onDetectFillers]);

  const handleRemove = useCallback(() => {
    void onRemoveDetected();
  }, [onRemoveDetected]);

  const isActive = detectedRegions.length > 0;
  const isProcessing = isDetecting || isRemoving;

  return (
    <div className="border-b border-neutral-700 bg-neutral-800/50">
      {/* Action buttons row */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <button
          onClick={handleDetectSilence}
          disabled={isProcessing || readOnly}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-300"
          title="Detect silence regions"
          aria-label="Detect silence regions"
        >
          {isDetecting && mode === 'silence' ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <VolumeX className="w-3 h-3" />
          )}
          Silences
        </button>

        <button
          onClick={handleDetectFillers}
          disabled={isProcessing || readOnly}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-300"
          title="Detect filler words (um, uh, like...)"
          aria-label="Detect filler words"
        >
          {isDetecting && mode === 'filler' ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <MessageCircleOff className="w-3 h-3" />
          )}
          Fillers
        </button>

        <button
          onClick={() => setShowSettings((v) => !v)}
          className={`p-1 rounded text-xs ${showSettings ? 'bg-primary-600/30 text-primary-400' : 'text-neutral-500 hover:text-neutral-300'}`}
          title="Detection settings"
          aria-label="Toggle detection settings"
          aria-pressed={showSettings}
        >
          <SlidersHorizontal className="w-3 h-3" />
        </button>

        {/* Detection results summary + actions */}
        {isActive && (
          <>
            <span className="text-xs text-neutral-400 ml-2">
              {detectedRegions.length} found ({totalDurationSec.toFixed(1)}s)
            </span>
            <button
              onClick={handleRemove}
              disabled={isProcessing || readOnly}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
              title="Remove all detected regions"
              aria-label={`Remove ${detectedRegions.length} detected regions`}
            >
              {isRemoving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Trash2 className="w-3 h-3" />
              )}
              Remove All
            </button>
            <button
              onClick={onClearDetection}
              disabled={isProcessing}
              className="p-1 text-neutral-500 hover:text-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Clear detection"
              aria-label="Clear detection results"
            >
              <X className="w-3 h-3" />
            </button>
          </>
        )}
      </div>

      {/* Settings panel (collapsible) */}
      {showSettings && (
        <div className="flex items-center gap-4 px-3 py-1.5 border-t border-neutral-700/50 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-400">
            Threshold
            <input
              type="range"
              min={-60}
              max={-10}
              step={1}
              value={thresholdDb}
              onChange={(e) => setThresholdDb(Number(e.target.value))}
              className="w-20 h-1 accent-primary-500"
              aria-label="Silence threshold in dB"
            />
            <span className="text-neutral-500 w-10 text-right">{thresholdDb}dB</span>
          </label>
          <label className="flex items-center gap-1.5 text-neutral-400">
            Min Duration
            <input
              type="range"
              min={0.1}
              max={3.0}
              step={0.1}
              value={minDuration}
              onChange={(e) => setMinDuration(Number(e.target.value))}
              className="w-16 h-1 accent-primary-500"
              aria-label="Minimum silence duration in seconds"
            />
            <span className="text-neutral-500 w-8 text-right">{minDuration.toFixed(1)}s</span>
          </label>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="px-3 py-1 text-xs text-red-400 border-t border-neutral-700/50">
          {error}
        </div>
      )}
    </div>
  );
};
