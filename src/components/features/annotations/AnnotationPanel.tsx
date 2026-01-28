/**
 * AnnotationPanel Component
 *
 * Main panel for displaying and managing asset annotations.
 * Shows analysis controls, detected shots, and annotation data.
 */

import { useEffect, useMemo } from 'react';

import type { AnalysisType } from '@/bindings';
import { useAnnotation } from '@/hooks/useAnnotation';

import { AnalysisControls } from './AnalysisControls';
import { ProviderSelector } from './ProviderSelector';
import { ShotList } from './ShotList';

// =============================================================================
// Types
// =============================================================================

export interface AnnotationPanelProps {
  /** Asset ID to show annotations for */
  assetId: string | null;
  /** Asset name for display */
  assetName?: string;
  /** Current playhead time in seconds */
  currentTime?: number;
  /** Callback when shot is clicked */
  onShotClick?: (timeSec: number) => void;
  /** Optional className for styling */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function AnnotationPanel({
  assetId,
  assetName,
  currentTime = 0,
  onShotClick,
  className = '',
}: AnnotationPanelProps): JSX.Element {
  const {
    // State
    annotation,
    providers,
    selectedProvider,
    costEstimate,
    isLoading,
    isAnalyzing,
    progress,
    error,
    // Derived
    shots,
    isAnalyzed,
    isStale,
    // Actions
    fetchAnnotation,
    analyze,
    estimateCost,
    setSelectedProvider,
    clearCurrentAsset,
  } = useAnnotation();

  // Fetch annotation when asset changes
  useEffect(() => {
    if (assetId) {
      fetchAnnotation(assetId);
    } else {
      clearCurrentAsset();
    }
  }, [assetId, fetchAnnotation, clearCurrentAsset]);

  // Check if cloud provider is selected
  const isCloudProvider = useMemo(() => {
    return selectedProvider === 'google_cloud';
  }, [selectedProvider]);

  // Handler for analyze
  const handleAnalyze = (types: AnalysisType[]) => {
    if (assetId) {
      analyze(assetId, types);
    }
  };

  // Handler for cost estimate
  const handleEstimateCost = (types: AnalysisType[]) => {
    if (assetId) {
      estimateCost(assetId, types);
    }
  };

  // No asset selected state
  if (!assetId) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
        <svg
          className="mb-3 h-16 w-16 text-editor-text-muted/30"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
        <p className="text-sm text-editor-text-muted">No asset selected</p>
        <p className="mt-1 text-xs text-editor-text-muted/70">
          Select an asset to view or create annotations
        </p>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 ${className}`}>
        <svg className="mb-3 h-8 w-8 animate-spin text-blue-500" viewBox="0 0 24 24">
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
        <p className="text-sm text-editor-text-muted">Loading annotation...</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col ${className}`} data-testid="annotation-panel">
      {/* Header */}
      <div className="border-b border-editor-border px-4 py-3">
        <h3 className="text-sm font-medium text-editor-text">Asset Annotation</h3>
        {assetName && <p className="mt-0.5 truncate text-xs text-editor-text-muted">{assetName}</p>}
      </div>

      {/* Error Display */}
      {error && (
        <div className="mx-4 mt-4 rounded border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 space-y-6 overflow-y-auto p-4">
        {/* Provider Selection */}
        <ProviderSelector
          providers={providers}
          selectedProvider={selectedProvider}
          onProviderChange={setSelectedProvider}
          disabled={isAnalyzing}
        />

        {/* Analysis Controls */}
        <AnalysisControls
          isAnalyzing={isAnalyzing}
          progress={progress}
          isAnalyzed={isAnalyzed}
          isStale={isStale}
          isCloudProvider={isCloudProvider}
          costEstimate={costEstimate}
          onAnalyze={handleAnalyze}
          onEstimateCost={handleEstimateCost}
          disabled={!assetId}
        />

        {/* Shots List */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-editor-text-muted">Detected Shots</h4>
          <ShotList shots={shots} currentTime={currentTime} onShotClick={onShotClick} />
        </div>

        {/* Annotation Metadata */}
        {annotation && (
          <div className="space-y-2 border-t border-editor-border pt-4">
            <h4 className="text-xs font-medium text-editor-text-muted">Metadata</h4>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between">
                <dt className="text-editor-text-muted">Created</dt>
                <dd className="text-editor-text">{formatDate(annotation.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-editor-text-muted">Updated</dt>
                <dd className="text-editor-text">{formatDate(annotation.updatedAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-editor-text-muted">Version</dt>
                <dd className="text-editor-text">{annotation.version}</dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}
