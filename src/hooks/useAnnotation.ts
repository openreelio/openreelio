/**
 * useAnnotation Hook
 *
 * Custom hook for managing asset annotations.
 * Provides methods for fetching, analyzing, and managing annotations.
 */

import { useCallback, useEffect, useRef } from 'react';

import { commands } from '@/bindings';
import type {
  AnalysisProvider,
  AnalysisStatus,
  AnalysisType,
  AssetAnnotation,
  CostEstimate,
  ProviderCapabilities,
  ShotDetectionConfig,
} from '@/bindings';
import { useToast } from '@/hooks/useToast';
import { createLogger } from '@/services/logger';
import {
  selectHasCloudProvider,
  selectIsAnalyzed,
  selectIsAnalyzing,
  selectIsStale,
  selectProgress,
  selectShots,
  useAnnotationStore,
} from '@/stores/annotationStore';

const logger = createLogger('useAnnotation');

// =============================================================================
// Types
// =============================================================================

export interface UseAnnotationOptions {
  /** Auto-fetch annotation when asset changes */
  autoFetch?: boolean;
}

export interface UseAnnotationResult {
  // State
  annotation: AssetAnnotation | null;
  analysisStatus: AnalysisStatus | null;
  providers: ProviderCapabilities[];
  selectedProvider: AnalysisProvider;
  costEstimate: CostEstimate | null;
  isLoading: boolean;
  isAnalyzing: boolean;
  progress: number;
  error: string | null;

  // Derived state
  shots: ReturnType<typeof selectShots>;
  isAnalyzed: boolean;
  isStale: boolean;
  hasCloudProvider: boolean;

  // Actions
  fetchAnnotation: (assetId: string) => Promise<void>;
  analyze: (
    assetId: string,
    types?: AnalysisType[],
    shotConfig?: ShotDetectionConfig
  ) => Promise<void>;
  estimateCost: (assetId: string, types?: AnalysisType[]) => Promise<void>;
  deleteAnnotation: (assetId: string) => Promise<void>;
  setSelectedProvider: (provider: AnalysisProvider) => void;
  refreshProviders: () => Promise<void>;
  clearCurrentAsset: () => void;
}

// =============================================================================
// Hook
// =============================================================================

export function useAnnotation(_options: UseAnnotationOptions = {}): UseAnnotationResult {
  // Options reserved for future use (e.g., auto-fetch behavior)
  void _options;
  const { showError, showSuccess } = useToast();

  // Store state
  const annotation = useAnnotationStore((state) => state.currentAnnotation);
  const analysisStatus = useAnnotationStore((state) => state.analysisStatus);
  const providers = useAnnotationStore((state) => state.providers);
  const selectedProvider = useAnnotationStore((state) => state.selectedProvider);
  const costEstimate = useAnnotationStore((state) => state.costEstimate);
  const isLoading = useAnnotationStore((state) => state.isLoading);
  const error = useAnnotationStore((state) => state.error);

  // Derived selectors
  const shots = useAnnotationStore(selectShots);
  const isAnalyzing = useAnnotationStore(selectIsAnalyzing);
  const progress = useAnnotationStore(selectProgress);
  const isAnalyzed = useAnnotationStore(selectIsAnalyzed);
  const isStale = useAnnotationStore(selectIsStale);
  const hasCloudProvider = useAnnotationStore(selectHasCloudProvider);

  // Store actions
  const setAnnotation = useAnnotationStore((state) => state.setAnnotation);
  const setAnalysisStatus = useAnnotationStore((state) => state.setAnalysisStatus);
  const setProviders = useAnnotationStore((state) => state.setProviders);
  const setSelectedProviderAction = useAnnotationStore((state) => state.setSelectedProvider);
  const startAnalysis = useAnnotationStore((state) => state.startAnalysis);
  const completeAnalysis = useAnnotationStore((state) => state.completeAnalysis);
  const failAnalysis = useAnnotationStore((state) => state.failAnalysis);
  const setCostEstimate = useAnnotationStore((state) => state.setCostEstimate);
  const setLoading = useAnnotationStore((state) => state.setLoading);
  const setError = useAnnotationStore((state) => state.setError);
  const clearCurrentAssetAction = useAnnotationStore((state) => state.clearCurrentAsset);

  // Track current asset for cleanup
  const currentAssetRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Fetch annotation for an asset
   */
  const fetchAnnotation = useCallback(
    async (assetId: string) => {
      if (!assetId) return;

      setLoading(true);
      setError(null);
      currentAssetRef.current = assetId;

      try {
        const result = await commands.getAnnotation(assetId);

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        // Only update if still viewing same asset
        if (currentAssetRef.current === assetId) {
          setAnnotation(result.data.annotation);
          setAnalysisStatus(result.data.status);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch annotation';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [setAnnotation, setAnalysisStatus, setLoading, setError]
  );

  /**
   * Perform analysis on an asset
   */
  const analyze = useCallback(
    async (
      assetId: string,
      types: AnalysisType[] = ['shots'],
      shotConfig?: ShotDetectionConfig
    ) => {
      if (!assetId) return;

      startAnalysis(assetId, selectedProvider, types);

      try {
        const result = await commands.analyzeAsset({
          assetId,
          provider: selectedProvider,
          analysisTypes: types,
          shotConfig,
        });

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        completeAnalysis(result.data.annotation);
        showSuccess('Analysis complete');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Analysis failed';
        failAnalysis(message);
        showError(message);
      }
    },
    [selectedProvider, startAnalysis, completeAnalysis, failAnalysis, showSuccess, showError]
  );

  /**
   * Estimate cost for cloud analysis
   */
  const estimateCost = useCallback(
    async (assetId: string, types: AnalysisType[] = ['shots']) => {
      if (!assetId) return;

      try {
        const result = await commands.estimateAnalysisCost(assetId, selectedProvider, types);

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        setCostEstimate(result.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to estimate cost';
        setError(message);
      }
    },
    [selectedProvider, setCostEstimate, setError]
  );

  /**
   * Delete annotation for an asset
   */
  const deleteAnnotation = useCallback(
    async (assetId: string) => {
      if (!assetId) return;

      try {
        const result = await commands.deleteAnnotation(assetId);

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        // Clear current annotation if it's the deleted one
        if (currentAssetRef.current === assetId) {
          setAnnotation(null);
          setAnalysisStatus('notAnalyzed');
        }

        showSuccess('Annotation deleted');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete annotation';
        showError(message);
      }
    },
    [setAnnotation, setAnalysisStatus, showSuccess, showError]
  );

  /**
   * Set selected provider
   */
  const setSelectedProvider = useCallback(
    (provider: AnalysisProvider) => {
      setSelectedProviderAction(provider);
    },
    [setSelectedProviderAction]
  );

  /**
   * Refresh available providers
   */
  const refreshProviders = useCallback(async () => {
    try {
      const result = await commands.getAvailableProviders();

      if (result.status === 'error') {
        throw new Error(result.error);
      }

      setProviders(result.data);
    } catch (err) {
      logger.warn('Failed to fetch providers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [setProviders]);

  /**
   * Clear current asset state
   */
  const clearCurrentAsset = useCallback(() => {
    currentAssetRef.current = null;
    clearCurrentAssetAction();
  }, [clearCurrentAssetAction]);

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Fetch providers on mount
  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    // State
    annotation,
    analysisStatus,
    providers,
    selectedProvider,
    costEstimate,
    isLoading,
    isAnalyzing,
    progress,
    error,

    // Derived state
    shots,
    isAnalyzed,
    isStale,
    hasCloudProvider,

    // Actions
    fetchAnnotation,
    analyze,
    estimateCost,
    deleteAnnotation,
    setSelectedProvider,
    refreshProviders,
    clearCurrentAsset,
  };
}
