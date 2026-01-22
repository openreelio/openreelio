/**
 * useWaveformPeaks Hook
 *
 * Fetches and manages JSON-based waveform peak data for audio visualization.
 * Uses Tauri IPC to communicate with the Rust backend.
 *
 * Features:
 * - Automatic fetch on mount
 * - Caching support
 * - On-demand generation
 * - Utility methods for time-based peak access
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AssetId, WaveformData } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface UseWaveformPeaksOptions {
  /** Input file path for waveform generation (required for generate()) */
  inputPath?: string;
  /** Samples per second for waveform resolution (default: 100) */
  samplesPerSecond?: number;
  /** Whether to fetch on mount (default: true) */
  enabled?: boolean;
  /** Auto-generate if not found (default: false) */
  autoGenerate?: boolean;
}

export interface UseWaveformPeaksReturn {
  /** Waveform peak data (null if not loaded or not generated) */
  data: WaveformData | null;
  /** Whether the waveform is being fetched */
  isLoading: boolean;
  /** Whether the waveform is being generated */
  isGenerating: boolean;
  /** Error message if fetch/generation failed */
  error: string | null;
  /** Manually trigger waveform generation */
  generate: () => Promise<WaveformData | null>;
  /** Refetch waveform data from cache */
  refetch: () => Promise<void>;
  /** Get peak value at a specific time position */
  peakAtTime: (timeSec: number) => number;
  /** Get peaks for a time range */
  peaksInRange: (startSec: number, endSec: number) => number[];
}

// =============================================================================
// Hook
// =============================================================================

export function useWaveformPeaks(
  assetId: AssetId,
  options: UseWaveformPeaksOptions = {}
): UseWaveformPeaksReturn {
  const {
    inputPath,
    samplesPerSecond = 100,
    enabled = true,
    autoGenerate = false,
  } = options;

  const [data, setData] = useState<WaveformData | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);
  // Track previous assetId for change detection
  const prevAssetIdRef = useRef<string | null>(null);

  /**
   * Fetch waveform data from cache
   */
  const fetchWaveform = useCallback(async (): Promise<WaveformData | null> => {
    if (!assetId) return null;

    try {
      const result = await invoke<WaveformData | null>('get_waveform_data', {
        assetId,
      });

      if (isMountedRef.current) {
        setData(result);
        setError(null);
      }

      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to fetch waveform';
      if (isMountedRef.current) {
        setError(errorMessage);
        setData(null);
      }
      return null;
    }
  }, [assetId]);

  /**
   * Generate waveform data via FFmpeg
   */
  const generate = useCallback(async (): Promise<WaveformData | null> => {
    if (!assetId) return null;

    setIsGenerating(true);
    setError(null);

    try {
      const result = await invoke<WaveformData | null>(
        'generate_waveform_for_asset',
        {
          assetId,
          samplesPerSecond,
        }
      );

      if (isMountedRef.current) {
        setData(result);
        setIsGenerating(false);
      }

      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Waveform generation failed';
      if (isMountedRef.current) {
        setError(errorMessage);
        setIsGenerating(false);
      }
      return null;
    }
  }, [assetId, samplesPerSecond]);

  /**
   * Refetch waveform data
   */
  const refetch = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    await fetchWaveform();
    if (isMountedRef.current) {
      setIsLoading(false);
    }
  }, [fetchWaveform]);

  /**
   * Get peak value at a specific time position
   */
  const peakAtTime = useCallback(
    (timeSec: number): number => {
      if (!data || timeSec < 0 || timeSec >= data.durationSec) {
        return 0;
      }
      const index = Math.floor(timeSec * data.samplesPerSecond);
      return data.peaks[index] ?? 0;
    },
    [data]
  );

  /**
   * Get peaks for a time range
   */
  const peaksInRange = useCallback(
    (startSec: number, endSec: number): number[] => {
      if (!data) return [];

      const startIdx = Math.max(
        0,
        Math.floor(startSec * data.samplesPerSecond)
      );
      const endIdx = Math.min(
        data.peaks.length,
        Math.ceil(endSec * data.samplesPerSecond)
      );

      if (startIdx >= data.peaks.length) {
        return [];
      }

      return data.peaks.slice(startIdx, endIdx);
    },
    [data]
  );

  // Fetch on mount and when assetId changes
  useEffect(() => {
    isMountedRef.current = true;

    if (!enabled) {
      setIsLoading(false);
      return;
    }

    // Only refetch if assetId actually changed
    if (prevAssetIdRef.current === assetId && data !== null) {
      setIsLoading(false);
      return;
    }

    prevAssetIdRef.current = assetId;

    const init = async () => {
      setIsLoading(true);
      const result = await fetchWaveform();

      if (isMountedRef.current) {
        setIsLoading(false);

        // Auto-generate if enabled and waveform not found
        if (!result && autoGenerate && inputPath) {
          await generate();
        }
      }
    };

    init();

    return () => {
      isMountedRef.current = false;
    };
  }, [assetId, enabled, fetchWaveform, autoGenerate, inputPath, generate, data]);

  return {
    data,
    isLoading,
    isGenerating,
    error,
    generate,
    refetch,
    peakAtTime,
    peaksInRange,
  };
}
