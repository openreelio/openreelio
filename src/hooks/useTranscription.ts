/**
 * useTranscription Hook
 *
 * Provides transcription functionality for video/audio assets using Whisper.
 * Handles API calls, progress tracking, and result caching.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  commands,
  type TranscriptionModelDownloadProgressDto,
  type TranscriptionModelDto,
  type TranscriptionStatusDto,
} from '@/bindings';
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
  /** Whisper model to use, or auto to choose the best installed model */
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

export type TranscriptionStatus = TranscriptionStatusDto;
export type TranscriptionModelStatus = TranscriptionModelDto;
export type TranscriptionModelDownloadProgress = TranscriptionModelDownloadProgressDto;

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
    options?: TranscriptionOptions,
  ) => Promise<TranscriptionResult | null>;
  /** Transcribe the audible audio mix of a sequence */
  transcribeSequence: (
    sequenceId?: string | null,
    options?: TranscriptionOptions,
  ) => Promise<TranscriptionResult | null>;
  /** Submit a transcription job to the background queue */
  submitTranscriptionJob: (assetId: string, options?: TranscriptionOptions) => Promise<string>;
  /** Check if transcription is available */
  isTranscriptionAvailable: () => Promise<boolean>;
  /** Read local Whisper readiness and installed model status */
  getTranscriptionStatus: () => Promise<TranscriptionStatus | null>;
  /** Download and install a local Whisper model */
  downloadTranscriptionModel: (
    model: string,
    options?: {
      overwrite?: boolean;
      onProgress?: (progress: TranscriptionModelDownloadProgress) => void;
    },
  ) => Promise<TranscriptionModelStatus | null>;
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

function createTranscriptionCacheKey(assetId: string, options?: TranscriptionOptions): string {
  return JSON.stringify({
    assetId,
    language: options?.language ?? null,
    translate: options?.translate ?? false,
    model: options?.model ?? null,
  });
}

export function useTranscription(options: UseTranscriptionOptions = {}): UseTranscriptionReturn {
  const { cacheResults = true, maxCacheSize = 50 } = options;

  // State
  const [state, setState] = useState<TranscriptionState>({
    isTranscribing: false,
    progress: 0,
    error: null,
    result: null,
  });

  // Mounted ref to prevent setState after unmount (memory leak prevention)
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Cache
  const cacheRef = useRef<Map<string, TranscriptionResult>>(new Map());
  const [cacheSize, setCacheSize] = useState(0);

  const getTranscriptionStatus = useCallback(async (): Promise<TranscriptionStatus | null> => {
    try {
      const result = await commands.getTranscriptionStatus();
      if (result.status === 'error') {
        logger.error('Failed to read transcription status', { error: result.error });
        return null;
      }
      return result.data;
    } catch (error) {
      logger.error('Failed to read transcription status', { error });
      return null;
    }
  }, []);

  const downloadTranscriptionModel = useCallback(
    async (
      model: string,
      downloadOptions?: {
        overwrite?: boolean;
        onProgress?: (progress: TranscriptionModelDownloadProgress) => void;
      },
    ): Promise<TranscriptionModelStatus | null> => {
      let unlisten: (() => void) | null = null;

      try {
        if (downloadOptions?.onProgress) {
          unlisten = await listen<TranscriptionModelDownloadProgress>(
            'transcription:model-download-progress',
            (event) => {
              if (event.payload.model === model) {
                downloadOptions.onProgress?.(event.payload);
              }
            },
          );
        }

        const result = await commands.downloadWhisperModel(
          model,
          downloadOptions?.overwrite ?? false,
        );
        if (result.status === 'error') {
          logger.error('Failed to install transcription model', {
            model,
            error: result.error,
          });
          return null;
        }

        return result.data;
      } catch (error) {
        logger.error('Failed to install transcription model', { model, error });
        return null;
      } finally {
        if (unlisten) {
          unlisten();
        }
      }
    },
    [],
  );

  // Check if transcription is available and usable with at least one installed model
  const isTranscriptionAvailable = useCallback(async (): Promise<boolean> => {
    const status = await getTranscriptionStatus();
    if (status) {
      return status.ready;
    }

    try {
      const available = await invoke<boolean>('is_transcription_available');
      return available;
    } catch (error) {
      logger.error('Failed to check transcription availability', { error });
      return false;
    }
  }, [getTranscriptionStatus]);

  // Get cached transcription
  const getCachedTranscription = useCallback((assetId: string): TranscriptionResult | null => {
    return cacheRef.current.get(createTranscriptionCacheKey(assetId)) || null;
  }, []);

  // Clear cache
  const clearCache = useCallback(() => {
    cacheRef.current.clear();
    if (isMountedRef.current) {
      setCacheSize(0);
    }
  }, []);

  // Add to cache with LRU eviction
  const addToCache = useCallback(
    (assetId: string, result: TranscriptionResult, transcriptionOptions?: TranscriptionOptions) => {
      if (!cacheResults) return;

      const cache = cacheRef.current;
      const cacheKey = createTranscriptionCacheKey(assetId, transcriptionOptions);

      // If at max size, remove oldest entry
      if (cache.size >= maxCacheSize) {
        const firstKey = cache.keys().next().value;
        if (firstKey) {
          cache.delete(firstKey);
        }
      }

      cache.set(cacheKey, result);
      if (isMountedRef.current) {
        setCacheSize(cache.size);
      }
    },
    [cacheResults, maxCacheSize],
  );

  // Transcribe an asset
  const transcribeAsset = useCallback(
    async (
      assetId: string,
      transcriptionOptions?: TranscriptionOptions,
    ): Promise<TranscriptionResult | null> => {
      // Check cache first
      if (cacheResults) {
        const cacheKey = createTranscriptionCacheKey(assetId, transcriptionOptions);
        const cached = cacheRef.current.get(cacheKey);
        if (cached) {
          // LRU refresh: delete and re-insert to move to end
          cacheRef.current.delete(cacheKey);
          cacheRef.current.set(cacheKey, cached);

          logger.debug('Returning cached transcription', { assetId });
          if (isMountedRef.current) {
            setState((prev) => ({ ...prev, result: cached }));
          }
          return cached;
        }
      }

      // Start transcription
      if (isMountedRef.current) {
        setState({
          isTranscribing: true,
          progress: 0,
          error: null,
          result: null,
        });
      }

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

        // Cache result (safe to call even if unmounted)
        addToCache(assetId, result, transcriptionOptions);

        if (isMountedRef.current) {
          setState({
            isTranscribing: false,
            progress: 1,
            error: null,
            result,
          });
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Transcription failed', { assetId, error: errorMessage });

        if (isMountedRef.current) {
          setState({
            isTranscribing: false,
            progress: 0,
            error: errorMessage,
            result: null,
          });
        }

        return null;
      }
    },
    [cacheResults, addToCache],
  );

  const transcribeSequence = useCallback(
    async (
      sequenceId?: string | null,
      transcriptionOptions?: TranscriptionOptions,
    ): Promise<TranscriptionResult | null> => {
      if (isMountedRef.current) {
        setState({
          isTranscribing: true,
          progress: 0,
          error: null,
          result: null,
        });
      }

      try {
        logger.info('Starting sequence transcription', {
          sequenceId,
          options: transcriptionOptions,
        });
        const result = await commands.transcribeSequence(
          sequenceId ?? null,
          transcriptionOptions
            ? {
                language: transcriptionOptions.language ?? null,
                translate: transcriptionOptions.translate ?? null,
                model: transcriptionOptions.model ?? null,
              }
            : null,
        );

        if (result.status === 'error') {
          throw new Error(result.error);
        }

        if (isMountedRef.current) {
          setState({
            isTranscribing: false,
            progress: 1,
            error: null,
            result: result.data,
          });
        }

        return result.data;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Sequence transcription failed', { sequenceId, error: errorMessage });

        if (isMountedRef.current) {
          setState({
            isTranscribing: false,
            progress: 0,
            error: errorMessage,
            result: null,
          });
        }

        return null;
      }
    },
    [],
  );

  // Submit transcription job to background queue
  const submitTranscriptionJob = useCallback(
    async (assetId: string, transcriptionOptions?: TranscriptionOptions): Promise<string> => {
      try {
        logger.info('Submitting transcription job', { assetId });

        const jobId = await invoke<string>('submit_transcription_job', {
          assetId,
          options: transcriptionOptions || null,
        });

        logger.info('Transcription job submitted', { jobId, assetId });

        return jobId;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Failed to submit transcription job', {
          assetId,
          error: errorMessage,
        });
        throw error;
      }
    },
    [],
  );

  return {
    transcribeAsset,
    transcribeSequence,
    submitTranscriptionJob,
    isTranscriptionAvailable,
    getTranscriptionStatus,
    downloadTranscriptionModel,
    getCachedTranscription,
    clearCache,
    state,
    cacheSize,
  };
}
