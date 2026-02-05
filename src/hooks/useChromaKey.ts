/**
 * useChromaKey Hook
 *
 * State management for chroma key (green/blue screen) effect parameters.
 * Provides parameter updates, presets, color sampling, and FFmpeg filter generation.
 *
 * @module hooks/useChromaKey
 */

import { useState, useCallback, useMemo, useRef } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ChromaKeyParams {
  /** Key color in hex format (e.g., '#00FF00') */
  keyColor: string;
  /** Similarity/threshold (0-1) - how close colors must match */
  similarity: number;
  /** Softness/blend (0-1) - edge softness */
  softness: number;
  /** Spill suppression (0-1) - reduce color spill on edges */
  spillSuppression: number;
  /** Edge feather in pixels (0-10) - blur the key edges */
  edgeFeather: number;
}

export type ChromaKeyPreset = 'green' | 'blue' | 'magenta';

export interface UseChromaKeyOptions {
  /** Initial parameter values */
  initialParams?: Partial<ChromaKeyParams>;
  /** Called when parameters change */
  onChange?: (params: ChromaKeyParams) => void;
}

export interface UseChromaKeyReturn {
  /** Current parameters */
  params: ChromaKeyParams;
  /** Update a single parameter */
  updateParam: <K extends keyof ChromaKeyParams>(key: K, value: ChromaKeyParams[K]) => void;
  /** Reset to default values */
  reset: () => void;
  /** Apply a preset configuration */
  applyPreset: (preset: ChromaKeyPreset) => void;
  /** Whether color sampling mode is active */
  isSampling: boolean;
  /** Start color sampling mode */
  startSampling: () => void;
  /** Cancel color sampling mode */
  cancelSampling: () => void;
  /** Apply a sampled color and exit sampling mode */
  applySampledColor: (color: string) => void;
  /** Generated FFmpeg filter string */
  ffmpegFilter: string;
  /** Whether parameters have been modified from defaults */
  isDirty: boolean;
}

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_CHROMA_KEY_PARAMS: ChromaKeyParams = {
  keyColor: '#00FF00',
  similarity: 0.3,
  softness: 0.1,
  spillSuppression: 0,
  edgeFeather: 0,
};

const PRESETS: Record<ChromaKeyPreset, Partial<ChromaKeyParams>> = {
  green: {
    keyColor: '#00FF00',
    similarity: 0.3,
    softness: 0.1,
  },
  blue: {
    keyColor: '#0000FF',
    similarity: 0.3,
    softness: 0.1,
  },
  magenta: {
    keyColor: '#FF00FF',
    similarity: 0.25,
    softness: 0.15,
  },
};

const PARAM_CONSTRAINTS: Record<
  keyof Omit<ChromaKeyParams, 'keyColor'>,
  { min: number; max: number }
> = {
  similarity: { min: 0, max: 1 },
  softness: { min: 0, max: 1 },
  spillSuppression: { min: 0, max: 1 },
  edgeFeather: { min: 0, max: 10 },
};

// =============================================================================
// Helper Functions
// =============================================================================

function clampValue(
  key: keyof Omit<ChromaKeyParams, 'keyColor'>,
  value: number
): number {
  const constraint = PARAM_CONSTRAINTS[key];
  return Math.max(constraint.min, Math.min(constraint.max, value));
}

function areParamsEqual(a: ChromaKeyParams, b: ChromaKeyParams): boolean {
  return (
    a.keyColor === b.keyColor &&
    a.similarity === b.similarity &&
    a.softness === b.softness &&
    a.spillSuppression === b.spillSuppression &&
    a.edgeFeather === b.edgeFeather
  );
}

function generateFFmpegFilter(params: ChromaKeyParams): string {
  // Convert hex color to FFmpeg format (0xRRGGBB)
  const colorHex = params.keyColor.replace('#', '0x');

  // Build the chromakey filter
  // FFmpeg chromakey syntax: chromakey=color:similarity:blend:yuv
  const filterParts = [
    `chromakey=color=${colorHex}`,
    `similarity=${params.similarity}`,
    `blend=${params.softness}`,
  ];

  // Note: FFmpeg chromakey doesn't have built-in spill suppression or edge feather
  // These would require additional filters in a filter chain
  // For now, we just include the core chromakey parameters

  return filterParts.join(':');
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useChromaKey(options: UseChromaKeyOptions = {}): UseChromaKeyReturn {
  const { initialParams, onChange } = options;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [params, setParams] = useState<ChromaKeyParams>(() => ({
    ...DEFAULT_CHROMA_KEY_PARAMS,
    ...initialParams,
  }));

  const [isSampling, setIsSampling] = useState(false);

  // Track original values for dirty detection
  const originalParamsRef = useRef<ChromaKeyParams>({
    ...DEFAULT_CHROMA_KEY_PARAMS,
    ...initialParams,
  });

  // ---------------------------------------------------------------------------
  // Computed Values
  // ---------------------------------------------------------------------------

  const isDirty = useMemo(
    () => !areParamsEqual(params, originalParamsRef.current),
    [params]
  );

  const ffmpegFilter = useMemo(() => generateFFmpegFilter(params), [params]);

  // ---------------------------------------------------------------------------
  // Update Parameter
  // ---------------------------------------------------------------------------

  const updateParam = useCallback(
    <K extends keyof ChromaKeyParams>(key: K, value: ChromaKeyParams[K]) => {
      setParams((prev) => {
        let newValue = value;

        // Clamp numeric values
        if (key !== 'keyColor' && typeof value === 'number') {
          newValue = clampValue(
            key as keyof Omit<ChromaKeyParams, 'keyColor'>,
            value
          ) as ChromaKeyParams[K];
        }

        const updated = { ...prev, [key]: newValue };
        onChange?.(updated);
        return updated;
      });
    },
    [onChange]
  );

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    const defaults = { ...DEFAULT_CHROMA_KEY_PARAMS };
    setParams(defaults);
    originalParamsRef.current = defaults;
    onChange?.(defaults);
  }, [onChange]);

  // ---------------------------------------------------------------------------
  // Apply Preset
  // ---------------------------------------------------------------------------

  const applyPreset = useCallback(
    (preset: ChromaKeyPreset) => {
      const presetValues = PRESETS[preset];
      setParams((prev) => {
        const updated = { ...prev, ...presetValues };
        onChange?.(updated);
        return updated;
      });
    },
    [onChange]
  );

  // ---------------------------------------------------------------------------
  // Color Sampling
  // ---------------------------------------------------------------------------

  const startSampling = useCallback(() => {
    setIsSampling(true);
  }, []);

  const cancelSampling = useCallback(() => {
    setIsSampling(false);
  }, []);

  const applySampledColor = useCallback(
    (color: string) => {
      setIsSampling(false);
      updateParam('keyColor', color);
    },
    [updateParam]
  );

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    params,
    updateParam,
    reset,
    applyPreset,
    isSampling,
    startSampling,
    cancelSampling,
    applySampledColor,
    ffmpegFilter,
    isDirty,
  };
}

export default useChromaKey;
