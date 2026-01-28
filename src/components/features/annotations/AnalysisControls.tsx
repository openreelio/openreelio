/**
 * AnalysisControls Component
 *
 * Controls for triggering asset analysis.
 * Includes analysis type selection and run button.
 */

import { useState } from 'react';

import type { AnalysisType, CostEstimate } from '@/bindings';

// =============================================================================
// Types
// =============================================================================

export interface AnalysisControlsProps {
  /** Whether analysis is in progress */
  isAnalyzing: boolean;
  /** Analysis progress (0-100) */
  progress: number;
  /** Whether asset has been analyzed */
  isAnalyzed: boolean;
  /** Whether annotation is stale */
  isStale: boolean;
  /** Whether cloud provider is selected */
  isCloudProvider: boolean;
  /** Cost estimate for cloud analysis */
  costEstimate: CostEstimate | null;
  /** Callback to trigger analysis */
  onAnalyze: (types: AnalysisType[]) => void;
  /** Callback to estimate cost */
  onEstimateCost: (types: AnalysisType[]) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const ANALYSIS_TYPE_LABELS: Record<AnalysisType, string> = {
  shots: 'Shot Detection',
  transcript: 'Transcription',
  objects: 'Object Detection',
  faces: 'Face Detection',
  textOcr: 'Text/OCR',
};

// =============================================================================
// Component
// =============================================================================

export function AnalysisControls({
  isAnalyzing,
  progress,
  isAnalyzed,
  isStale,
  isCloudProvider,
  costEstimate,
  onAnalyze,
  onEstimateCost,
  disabled = false,
}: AnalysisControlsProps): JSX.Element {
  const [selectedTypes, setSelectedTypes] = useState<AnalysisType[]>(['shots']);
  const [showCostConfirm, setShowCostConfirm] = useState(false);

  const handleTypeToggle = (type: AnalysisType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const handleAnalyze = () => {
    if (isCloudProvider && !showCostConfirm) {
      onEstimateCost(selectedTypes);
      setShowCostConfirm(true);
    } else {
      onAnalyze(selectedTypes);
      setShowCostConfirm(false);
    }
  };

  const handleCancel = () => {
    setShowCostConfirm(false);
  };

  // Available types depend on provider (local only supports shots)
  const availableTypes: AnalysisType[] = isCloudProvider
    ? ['shots', 'transcript', 'objects', 'faces', 'textOcr']
    : ['shots'];

  return (
    <div className="space-y-4">
      {/* Analysis Type Selection */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-editor-text-muted">Analysis Types</label>
        <div className="flex flex-wrap gap-2">
          {availableTypes.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => handleTypeToggle(type)}
              disabled={disabled || isAnalyzing}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedTypes.includes(type)
                  ? 'bg-blue-600 text-white'
                  : 'bg-editor-surface text-editor-text hover:bg-editor-border'
              } disabled:cursor-not-allowed disabled:opacity-50`}
              data-testid={`analysis-type-${type}`}
            >
              {ANALYSIS_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Status Badge */}
      {isAnalyzed && !isStale && (
        <div className="flex items-center gap-2 rounded bg-status-success/10 px-3 py-2 text-xs text-status-success">
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              clipRule="evenodd"
            />
          </svg>
          Analysis complete
        </div>
      )}

      {isStale && (
        <div className="flex items-center gap-2 rounded bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          Asset changed - re-analysis recommended
        </div>
      )}

      {/* Progress Bar */}
      {isAnalyzing && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-editor-text-muted">
            <span>Analyzing...</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-editor-surface">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Cost Confirmation */}
      {showCostConfirm && costEstimate && (
        <div className="rounded border border-status-warning/30 bg-status-warning/10 p-3">
          <h4 className="mb-2 text-sm font-medium text-status-warning">Cost Estimate</h4>
          <div className="space-y-1 text-xs text-editor-text-muted">
            <p>
              Estimated cost: <strong>${(costEstimate.estimatedCostCents / 100).toFixed(2)}</strong>
            </p>
            <p>Duration: {Math.round(costEstimate.assetDurationSec)}s</p>
            <ul className="ml-4 mt-2 list-disc">
              {costEstimate.breakdown.map((item, i) => (
                <li key={i}>
                  {ANALYSIS_TYPE_LABELS[item.analysisType as AnalysisType] || item.analysisType}:{' '}
                  {item.rateDescription}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="rounded bg-editor-surface px-3 py-1.5 text-xs text-editor-text hover:bg-editor-border"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAnalyze}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700"
            >
              Confirm & Analyze
            </button>
          </div>
        </div>
      )}

      {/* Analyze Button */}
      {!showCostConfirm && (
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={disabled || isAnalyzing || selectedTypes.length === 0}
          className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="analyze-button"
        >
          {isAnalyzing ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Analyzing...
            </span>
          ) : isAnalyzed && !isStale ? (
            'Re-analyze Asset'
          ) : (
            'Analyze Asset'
          )}
        </button>
      )}
    </div>
  );
}
