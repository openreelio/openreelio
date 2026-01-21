/**
 * useTranscription Hook
 *
 * Provides transcription functionality for video/audio assets using Whisper.
 * Handles API calls, progress tracking, and result caching.
 */

import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

const logger = createLogger('useTranscription');

// =============================================================================
// Types
// =============================================================================

/** A single transcription segment with timing */
export interface TranscriptionSegment {
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Transcribed text */
  text: string;
}

/** Transcription result from the backend */
export interface TranscriptionResult {
  /** Detected or specified language */
  language: string;
  /** Transcribed segments with timing */
  segments: TranscriptionSegment[];
  /** Total duration in seconds */
  duration: number;
  /** Full transcription text */
  fullText: string;
}

/** Options for transcription */
export interface TranscriptionOptions {
  /** Language code (e.g., "en", "ko") or "auto" for detection */
  language?: string;
  /** Whether to translate to English */
  translate?: boolean;
  /** Whisper model to use (tiny, base, small, medium, large) */
  model?: string;
}

/** State of a transcription operation */
export interface TranscriptionState {
  /** Whether transcription is in progress */
  isTranscribing: boolean;
  /** Current progress (0-1) */
  progress: number;
  /** Error message if transcription failed */
  error: string | null;
  /** Transcription result */
  result: TranscriptionResult | null;
}

/** Options for the useTranscription hook */
export interface UseTranscriptionOptions {
  /** Whether to cache results */
  cacheResults?: boolean;
  /** Maximum cache size (number of transcriptions) */
  maxCacheSize?: number;
}

/** Return type of the useTranscription hook */
export interface UseTranscriptionReturn {
  /** Transcribe an asset */
  transcribeAsset: (
    assetId: string,
    options?: TranscriptionOptions
  ) => Promise<TranscriptionResult | null>;
  /** Submit a transcription job to the background queue */
  submitTranscriptionJob: (
    assetId: string,
    options?: TranscriptionOptions
  ) => Promise<string>;
  /** Check if transcription is available */
  isTranscriptionAvailable: () => Promise<boolean>;
  /** Get cached transcription for an asset */
  getCachedTranscription: (assetId: string) => TranscriptionResult | null;
  /** Clear the transcription cache */
  clearCache: () => void;
  /** Current transcription state */
  state: TranscriptionState;
  /** Cache size */
  cacheSize: number;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTranscription(
  options: UseTranscriptionOptions = {}
): UseTranscriptionReturn {
  const { cacheResults = true, maxCacheSize = 50 } = options;

  // State
  const [state, setState] = useState<TranscriptionState>({
    isTranscribing: false,
    progress: 0,
    error: null,
    result: null,
  });

  // Cache
  const cacheRef = useRef<Map<string, TranscriptionResult>>(new Map());
  const [cacheSize, setCacheSize] = useState(0);

  // Check if transcription is available
  const isTranscriptionAvailable = useCallback(async (): Promise<boolean> => {
    try {
      const available = await invoke<boolean>('is_transcription_available');
      return available;
    } catch (error) {
      logger.error('Failed to check transcription availability', { error });
      return false;
    }
  }, []);

  // Get cached transcription
  const getCachedTranscription = useCallback(
    (assetId: string): TranscriptionResult | null => {
      return cacheRef.current.get(assetId) || null;
    },
    []
  );

  // Clear cache
  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    setCacheSize(0);
  }, []);

  // Add to cache with LRU eviction
  const addToCache = useCallback(
    (assetId: string, result: TranscriptionResult) => {
      if (!cacheResults) return;

      const cache = cacheRef.current;

      // If at max size, remove oldest entry
      if (cache.size >= maxCacheSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      cache.set(assetId, result);
      setCacheSize(cache.size);
    },
    [cacheResults, maxCacheSize]
  );

  // Transcribe an asset
  const transcribeAsset = useCallback(
    async (
      assetId: string,
      transcriptionOptions?: TranscriptionOptions
    ): Promise<TranscriptionResult | null> => {
      // Check cache first
      if (cacheResults) {
        const cached = cacheRef.current.get(assetId);
        if (cached) {
          // LRU refresh: delete and re-insert to move to end
          cacheRef.current.delete(assetId);
          cacheRef.current.set(assetId, cached);

          logger.debug('Returning cached transcription', { assetId });
          setState((prev) => ({ ...prev, result: cached }));
          return cached;
        }
      }

      // Start transcription
      setState({
        isTranscribing: true,
        progress: 0,
        error: null,
        result: null,
      });

      try {
        logger.info('Starting transcription', { assetId, options: transcriptionOptions });

        const result = await invoke<TranscriptionResult>('transcribe_asset', {
          assetId,
          options: transcriptionOptions || null,
        });

        logger.info('Transcription complete', {
          assetId,
          segments: result.segments.length,
          duration: result.duration,
        });

        // Cache result
        addToCache(assetId, result);

        setState({
          isTranscribing: false,
          progress: 1,
          error: null,
          result,
        });

        return result;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Transcription failed', { assetId, error: errorMessage });

        setState({
          isTranscribing: false,
          progress: 0,
          error: errorMessage,
          result: null,
        });

        return null;
      }
    },
    [cacheResults, addToCache]
  );

  // Submit transcription job to background queue
  const submitTranscriptionJob = useCallback(
    async (
      assetId: string,
      transcriptionOptions?: TranscriptionOptions
    ): Promise<string> => {
      try {
        logger.info('Submitting transcription job', { assetId });

        const jobId = await invoke<string>('submit_transcription_job', {
          assetId,
          options: transcriptionOptions || null,
        });

        logger.info('Transcription job submitted', { jobId, assetId });

        return jobId;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error('Failed to submit transcription job', {
          assetId,
          error: errorMessage,
        });
        throw error;
      }
    },
    []
  );

  return {
    transcribeAsset,
    submitTranscriptionJob,
    isTranscriptionAvailable,
    getCachedTranscription,
    clearCache,
    state,
    cacheSize,
  };
}
