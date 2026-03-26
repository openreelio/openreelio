/**
 * SmartReframePanel Component
 *
 * AI Smart Reframe controls for cropping video to a target aspect ratio
 * with subject tracking:
 * - Target aspect ratio preset buttons (9:16, 1:1, 4:5, 4:3)
 * - Smoothing slider: crop motion smoothing (1-100)
 * - Zoom slider: additional zoom percentage (0-50)
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

export interface SmartReframePanelProps {
  /** Current effect parameters (target_aspect, smoothing, zoom, detection_mode, analysis_data) */
  params: Record<string, SimpleParamValue>;
  /** Callback when a parameter changes */
  onChange: (paramName: string, value: SimpleParamValue) => void;
  /** Whether the panel is read-only */
  readOnly?: boolean;
  /** Clip context for running reframe analysis */
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
const ZOOM_MIN = 0;
const ZOOM_MAX = 50;

const ASPECT_PRESETS = [
  { value: '9:16', label: '9:16', description: 'Vertical' },
  { value: '1:1', label: '1:1', description: 'Square' },
  { value: '4:5', label: '4:5', description: 'Portrait' },
  { value: '4:3', label: '4:3', description: 'Classic' },
] as const;

// =============================================================================
// Main Component
// =============================================================================

export const SmartReframePanel = memo(function SmartReframePanel({
  params,
  onChange,
  readOnly = false,
  clipContext,
}: SmartReframePanelProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [localAnalysisData, setLocalAnalysisData] = useState('');

  const targetAspect =
    typeof params.target_aspect === 'string' ? params.target_aspect : '9:16';
  const smoothing =
    typeof params.smoothing === 'number' ? params.smoothing : 30;
  const zoom = typeof params.zoom === 'number' ? params.zoom : 0;
  const analysisData =
    typeof params.analysis_data === 'string' ? params.analysis_data : '';
  const latestValuesRef = useRef({
    targetAspect,
    smoothing,
    zoom,
  });

  useEffect(() => {
    latestValuesRef.current = {
      targetAspect,
      smoothing,
      zoom,
    };
  }, [targetAspect, smoothing, zoom]);

  useEffect(() => {
    setLocalAnalysisData(analysisData);
  }, [analysisData, clipContext?.clipId]);

  const effectiveAnalysisData = analysisData || localAnalysisData;
  const isAnalyzed = effectiveAnalysisData.length > 0;

  // Invalidate stale analysis data when key parameters change — the cached
  // keyframes were computed for the previous settings and would produce
  // incorrect crop geometry if reused with different values.
  const invalidateAnalysis = useCallback(() => {
    setLocalAnalysisData('');
    onChange('analysis_data', '');
  }, [onChange]);

  const handleAspectChange = useCallback(
    (value: string) => {
      if (value !== latestValuesRef.current.targetAspect) {
        invalidateAnalysis();
      }
      latestValuesRef.current.targetAspect = value;
      onChange('target_aspect', value);
    },
    [invalidateAnalysis, onChange]
  );

  const handleSmoothingChange = useCallback(
    (value: number) => {
      if (value !== latestValuesRef.current.smoothing) {
        invalidateAnalysis();
      }
      latestValuesRef.current.smoothing = value;
      onChange('smoothing', value);
    },
    [invalidateAnalysis, onChange]
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
      latestValuesRef.current.smoothing = 30;
      onChange('smoothing', 30);
    },
    [onChange]
  );

  const resetZoom = useCallback(() => {
    latestValuesRef.current.zoom = 0;
    onChange('zoom', 0);
  }, [onChange]);

  const handleAnalyze = useCallback(async () => {
    if (!clipContext || isAnalyzing || readOnly) return;

    const { targetAspect, smoothing, zoom } = latestValuesRef.current;

    setIsAnalyzing(true);
    setProgress(0);
    setError(null);

    let unlisten: (() => void) | undefined;

    try {
      unlisten = await listen<{
        clipId: string;
        progress: number;
        phase: string;
      }>('reframe-progress', (event) => {
        if (event.payload.clipId === clipContext.clipId) {
          setProgress(event.payload.progress);
        }
      });

      const result = await invoke<{ analysisData: string }>('smart_reframe', {
        args: {
          sequenceId: clipContext.sequenceId,
          trackId: clipContext.trackId,
          clipId: clipContext.clipId,
          targetAspect,
          smoothing,
          zoom,
        },
      });
      setProgress(100);
      setLocalAnalysisData(result.analysisData);
      onChange('analysis_data', result.analysisData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unlisten?.();
      setIsAnalyzing(false);
    }
  }, [clipContext, isAnalyzing, onChange, readOnly]);

  return (
    <div className="space-y-4" data-testid="smart-reframe-panel">
      {/* Target Aspect Ratio */}
      <div className="space-y-1.5" data-testid="aspect-ratio-selector">
        <span className="text-xs font-medium text-editor-text">
          Target Aspect Ratio
        </span>
        <div className="grid grid-cols-4 gap-1.5">
          {ASPECT_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => handleAspectChange(preset.value)}
              disabled={readOnly}
              aria-pressed={targetAspect === preset.value}
              aria-label={`${preset.label} ${preset.description}`}
              data-testid={`aspect-${preset.value.replace(':', '-')}`}
              className={`flex flex-col items-center gap-0.5 px-2 py-1.5 text-xs rounded border transition-colors
                ${
                  targetAspect === preset.value
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-editor-border bg-editor-bg text-editor-text hover:border-editor-text-muted'
                }
                disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <span className="font-medium">{preset.label}</span>
              <span className="text-[10px] opacity-60">{preset.description}</span>
            </button>
          ))}
        </div>
      </div>

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
              disabled={readOnly || smoothing === 30}
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
          <span className="text-[10px] text-editor-text-muted">Quick</span>
          <span className="text-[10px] text-editor-text-muted">Smooth</span>
        </div>
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
            Reframe analysis complete
          </div>
        ) : (
          <div
            className="text-xs text-editor-text-muted"
            data-testid="analysis-required"
          >
            Analysis required before smart reframe takes effect in render.
          </div>
        )}

        {isAnalyzing ? (
          <div className="space-y-1.5" data-testid="analysis-progress">
            <div className="flex items-center gap-2 text-xs text-editor-text">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analyzing video... {progress}%
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
            {isAnalyzed ? 'Re-analyze' : 'Analyze & Reframe'}
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
