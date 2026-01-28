/**
 * Annotation Store
 *
 * Zustand store for managing asset annotation state.
 * Handles analysis status, shots, and provider configuration.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type {
  AnalysisProvider,
  AnalysisStatus,
  AnalysisType,
  AssetAnnotation,
  CostEstimate,
  ProviderCapabilities,
  ShotResult,
} from '@/bindings';

// =============================================================================
// Types
// =============================================================================

/** Analysis request state */
export interface AnalysisRequest {
  /** Asset ID being analyzed */
  assetId: string;
  /** Provider being used */
  provider: AnalysisProvider;
  /** Analysis types requested */
  analysisTypes: AnalysisType[];
  /** Whether analysis is in progress */
  isAnalyzing: boolean;
  /** Progress percentage (0-100) */
  progress: number;
  /** Error message if failed */
  error?: string;
}

/** Annotation store state */
export interface AnnotationState {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Current annotation for selected asset */
  currentAnnotation: AssetAnnotation | null;

  /** Analysis status for selected asset */
  analysisStatus: AnalysisStatus | null;

  /** Available analysis providers */
  providers: ProviderCapabilities[];

  /** Currently selected provider */
  selectedProvider: AnalysisProvider;

  /** Active analysis request */
  activeRequest: AnalysisRequest | null;

  /** Cost estimate for pending analysis */
  costEstimate: CostEstimate | null;

  /** Whether panel is loading */
  isLoading: boolean;

  /** Error message */
  error: string | null;

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /** Set current annotation */
  setAnnotation: (annotation: AssetAnnotation | null) => void;

  /** Set analysis status */
  setAnalysisStatus: (status: AnalysisStatus | null) => void;

  /** Set available providers */
  setProviders: (providers: ProviderCapabilities[]) => void;

  /** Set selected provider */
  setSelectedProvider: (provider: AnalysisProvider) => void;

  /** Start analysis request */
  startAnalysis: (assetId: string, provider: AnalysisProvider, types: AnalysisType[]) => void;

  /** Update analysis progress */
  updateProgress: (progress: number) => void;

  /** Complete analysis */
  completeAnalysis: (annotation: AssetAnnotation) => void;

  /** Fail analysis */
  failAnalysis: (error: string) => void;

  /** Set cost estimate */
  setCostEstimate: (estimate: CostEstimate | null) => void;

  /** Set loading state */
  setLoading: (loading: boolean) => void;

  /** Set error */
  setError: (error: string | null) => void;

  /** Reset store */
  reset: () => void;

  /** Clear current asset state */
  clearCurrentAsset: () => void;
}

// =============================================================================
// Initial State
// =============================================================================

const initialState: Pick<
  AnnotationState,
  | 'currentAnnotation'
  | 'analysisStatus'
  | 'providers'
  | 'selectedProvider'
  | 'activeRequest'
  | 'costEstimate'
  | 'isLoading'
  | 'error'
> = {
  currentAnnotation: null,
  analysisStatus: null,
  providers: [],
  selectedProvider: 'ffmpeg' as AnalysisProvider,
  activeRequest: null,
  costEstimate: null,
  isLoading: false,
  error: null,
};

// =============================================================================
// Store
// =============================================================================

export const useAnnotationStore = create<AnnotationState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setAnnotation: (annotation) => set({ currentAnnotation: annotation }),

    setAnalysisStatus: (status) => set({ analysisStatus: status }),

    setProviders: (providers) => set({ providers }),

    setSelectedProvider: (provider) =>
      set({
        selectedProvider: provider,
        costEstimate: null,
      }),

    startAnalysis: (assetId, provider, types) =>
      set({
        activeRequest: {
          assetId,
          provider,
          analysisTypes: types,
          isAnalyzing: true,
          progress: 0,
        },
        analysisStatus: 'inProgress',
        error: null,
      }),

    updateProgress: (progress) =>
      set((state) =>
        state.activeRequest
          ? {
              activeRequest: {
                ...state.activeRequest,
                progress,
              },
            }
          : state
      ),

    completeAnalysis: (annotation) =>
      set({
        currentAnnotation: annotation,
        activeRequest: null,
        analysisStatus: 'completed',
      }),

    failAnalysis: (error) =>
      set((state) => ({
        activeRequest: state.activeRequest
          ? {
              ...state.activeRequest,
              isAnalyzing: false,
              error,
            }
          : null,
        analysisStatus: 'failed',
        error,
      })),

    setCostEstimate: (estimate) => set({ costEstimate: estimate }),

    setLoading: (loading) => set({ isLoading: loading }),

    setError: (error) => set({ error }),

    reset: () => set({ ...initialState }),

    clearCurrentAsset: () =>
      set({
        currentAnnotation: null,
        analysisStatus: null,
        activeRequest: null,
        costEstimate: null,
        error: null,
      }),
  }))
);

// =============================================================================
// Selectors
// =============================================================================

/** Get shots from current annotation */
export const selectShots = (state: AnnotationState): ShotResult[] => {
  const shots = state.currentAnnotation?.analysis?.shots;
  return shots?.results ?? [];
};

/** Check if analysis is in progress */
export const selectIsAnalyzing = (state: AnnotationState): boolean => {
  return state.activeRequest?.isAnalyzing ?? false;
};

/** Check if cloud provider is available */
export const selectHasCloudProvider = (state: AnnotationState): boolean => {
  return state.providers.some((p) => p.provider === 'google_cloud');
};

/** Get analysis progress */
export const selectProgress = (state: AnnotationState): number => {
  return state.activeRequest?.progress ?? 0;
};

/** Check if asset has been analyzed */
export const selectIsAnalyzed = (state: AnnotationState): boolean => {
  return state.analysisStatus === 'completed';
};

/** Check if annotation is stale (asset changed) */
export const selectIsStale = (state: AnnotationState): boolean => {
  return state.analysisStatus === 'stale';
};
