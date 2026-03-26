/**
 * StabilizePanel Component
 *
 * Video stabilization controls with:
 * - Smoothing slider: motion smoothing strength (1-100)
 * - Crop Mode selector: how to handle border artifacts
 * - Zoom slider: percentage zoom to hide borders
 * - Analyze button with progress indicator
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Play, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { SimpleParamValue } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface StabilizePanelProps {
  /** Current effect parameters (smoothing, crop_mode, zoom, analysis_path) */
  params: Record<string, SimpleParamValue>;
  /** Callback when a parameter changes */
  onChange: (paramName: string, value: SimpleParamValue) => void;
  /** Whether the panel is read-only */
  readOnly?: boolean;
  /** Clip context for running stabilization analysis */
  clipContext?: {
    sequenceId: string;
    trackId: string;
    clipId: string;
  };
}

// =============================================================================
// Constants
// =============================================================================

const SMOOTHING_MIN = 1;
const SMOOTHING_MAX = 100;
const ZOOM_MIN = -100;
const ZOOM_MAX = 100;

const CROP_MODES = [
  { value: 'crop', label: 'Crop (Black Fill)' },
  { value: 'none', label: 'None (Keep Original)' },
  { value: 'dynamic', label: 'Dynamic (Auto Zoom)' },
] as const;

// =============================================================================
// Main Component
// =============================================================================

export const StabilizePanel = memo(function StabilizePanel({
  params,
  onChange,
  readOnly = false,
  clipContext,
}: StabilizePanelProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [localAnalysisPath, setLocalAnalysisPath] = useState<string>('');

  const smoothing =
    typeof params.smoothing === 'number' ? params.smoothing : 10;
  const cropMode =
    typeof params.crop_mode === 'string' ? params.crop_mode : 'crop';
  const zoom = typeof params.zoom === 'number' ? params.zoom : 0;
  const analysisPath =
    typeof params.analysis_path === 'string' ? params.analysis_path : '';
  const latestValuesRef = useRef({
    smoothing,
    cropMode,
    zoom,
  });

  useEffect(() => {
    latestValuesRef.current = {
      smoothing,
      cropMode,
      zoom,
    };
  }, [smoothing, cropMode, zoom]);

  useEffect(() => {
    setLocalAnalysisPath(analysisPath);
  }, [analysisPath, clipContext?.clipId]);

  const effectiveAnalysisPath = analysisPath || localAnalysisPath;
  const isAnalyzed = effectiveAnalysisPath.length > 0;

  const handleSmoothingChange = useCallback(
    (value: number) => {
      latestValuesRef.current.smoothing = value;
      onChange('smoothing', value);
    },
    [onChange]
  );

  const handleCropModeChange = useCallback(
    (value: string) => {
      latestValuesRef.current.cropMode = value;
      onChange('crop_mode', value);
    },
    [onChange]
  );

  const handleZoomChange = useCallback(
    (value: number) => {
      latestValuesRef.current.zoom = value;
      onChange('zoom', value);
    },
    [onChange]
  );

  const resetSmoothing = useCallback(
    () => {
      latestValuesRef.current.smoothing = 10;
      onChange('smoothing', 10);
    },
    [onChange]
  );

  const resetZoom = useCallback(() => {
    latestValuesRef.current.zoom = 0;
    onChange('zoom', 0);
  }, [onChange]);

  const handleAnalyze = useCallback(async () => {
    if (!clipContext || isAnalyzing || readOnly) return;

    const { smoothing, cropMode, zoom } = latestValuesRef.current;

    setIsAnalyzing(true);
    setProgress(0);
    setError(null);

    let unlisten: (() => void) | undefined;

    try {
      unlisten = await listen<{
        clipId: string;
        progress: number;
        phase: string;
      }>('stabilize-progress', (event) => {
        if (event.payload.clipId === clipContext.clipId) {
          setProgress(event.payload.progress);
        }
      });

      const result = await invoke<{ transformsPath: string }>('stabilize_clip', {
        args: {
          sequenceId: clipContext.sequenceId,
          trackId: clipContext.trackId,
          clipId: clipContext.clipId,
          smoothing,
          cropMode,
          zoom,
        },
      });

      setProgress(100);
      setLocalAnalysisPath(result.transformsPath);
      onChange('analysis_path', result.transformsPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unlisten?.();
      setIsAnalyzing(false);
    }
  }, [clipContext, isAnalyzing, onChange, readOnly]);

  return (
    <div className="space-y-4" data-testid="stabilize-panel">
      {/* Smoothing */}
      <div className="space-y-1.5" data-testid="smoothing-slider">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-editor-text">
            Smoothing
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs tabular-nums text-editor-text-muted w-8 text-right">
              {smoothing.toFixed(0)}
            </span>
            <button
              type="button"
              onClick={resetSmoothing}
              disabled={readOnly || smoothing === 10}
              aria-label="Reset smoothing"
              className="p-0.5 text-editor-text-muted hover:text-editor-text rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        </div>
        <input
          type="range"
          min={SMOOTHING_MIN}
          max={SMOOTHING_MAX}
          step={1}
          value={smoothing}
          onChange={(e) => handleSmoothingChange(Number(e.target.value))}
          disabled={readOnly}
          aria-label="Smoothing"
          className="w-full h-1.5 rounded-sm appearance-none bg-editor-border cursor-pointer disabled:cursor-not-allowed
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary-500
            [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-primary-500"
        />
        <div className="flex justify-between">
          <span className="text-[10px] text-editor-text-muted">Subtle</span>
          <span className="text-[10px] text-editor-text-muted">Strong</span>
        </div>
      </div>

      {/* Crop Mode */}
      <div className="space-y-1.5" data-testid="crop-mode-select">
        <span className="text-xs font-medium text-editor-text">Crop Mode</span>
        <select
          value={cropMode}
          onChange={(e) => handleCropModeChange(e.target.value)}
          disabled={readOnly}
          aria-label="Crop Mode"
          className="w-full px-2 py-1.5 text-xs rounded bg-editor-bg border border-editor-border text-editor-text
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {CROP_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </select>
      </div>

      {/* Zoom */}
      <div className="space-y-1.5" data-testid="zoom-slider">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-editor-text">Zoom</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs tabular-nums text-editor-text-muted w-10 text-right">
              {zoom > 0 ? `+${zoom.toFixed(0)}%` : `${zoom.toFixed(0)}%`}
            </span>
            <button
              type="button"
              onClick={resetZoom}
              disabled={readOnly || zoom === 0}
              aria-label="Reset zoom"
              className="p-0.5 text-editor-text-muted hover:text-editor-text rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>
        </div>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={zoom}
          onChange={(e) => handleZoomChange(Number(e.target.value))}
          disabled={readOnly}
          aria-label="Zoom"
          className="w-full h-1.5 rounded-sm appearance-none bg-editor-border cursor-pointer disabled:cursor-not-allowed
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary-500
            [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-primary-500"
        />
      </div>

      {/* Analysis status and button */}
      <div className="pt-2 border-t border-editor-border space-y-2">
        {isAnalyzed ? (
          <div
            className="flex items-center gap-2 text-xs text-green-400"
            data-testid="analysis-complete"
          >
            <div className="w-2 h-2 rounded-full bg-green-400" />
            Motion analysis complete
          </div>
        ) : (
          <div
            className="text-xs text-editor-text-muted"
            data-testid="analysis-required"
          >
            Motion analysis required before stabilization takes effect in render.
          </div>
        )}

        {isAnalyzing ? (
          <div className="space-y-1.5" data-testid="analysis-progress">
            <div className="flex items-center gap-2 text-xs text-editor-text">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analyzing motion... {progress}%
            </div>
            <div className="w-full h-1.5 rounded-full bg-editor-border overflow-hidden">
              <div
                className="h-full bg-primary-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={readOnly || !clipContext}
            data-testid="analyze-button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded
              bg-primary-600 hover:bg-primary-500 text-white transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5" />
            {isAnalyzed ? 'Re-analyze Motion' : 'Analyze Motion'}
          </button>
        )}

        {error && (
          <div
            className="text-xs text-red-400"
            data-testid="analysis-error"
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
});
