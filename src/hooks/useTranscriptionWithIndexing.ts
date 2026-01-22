/**
 * useTranscriptionWithIndexing Hook
 *
 * Cross-feature integration hook that combines transcription with search indexing.
 * When transcription completes, results are automatically indexed for search.
 */

import { useCallback } from 'react';
import { useTranscription, type TranscriptionOptions, type TranscriptionResult } from './useTranscription';
import { useSearch } from './useSearch';
import { createLogger } from '@/services/logger';

const logger = createLogger('useTranscriptionWithIndexing');

// =============================================================================
// Types
// =============================================================================

export interface UseTranscriptionWithIndexingOptions {
  /** Whether to automatically index transcriptions for search (default: true) */
  autoIndex?: boolean;
  /** Whether to cache results */
  cacheResults?: boolean;
  /** Maximum cache size */
  maxCacheSize?: number;
}

export interface UseTranscriptionWithIndexingReturn {
  /** Transcribe an asset and optionally index results */
  transcribeAndIndex: (
    assetId: string,
    options?: TranscriptionOptions & { skipIndexing?: boolean }
  ) => Promise<TranscriptionResult | null>;
  /** Submit a transcription job (indexing will happen when job completes) */
  submitTranscriptionJob: (
    assetId: string,
    options?: TranscriptionOptions
  ) => Promise<string>;
  /** Index existing transcription results */
  indexTranscription: (
    assetId: string,
    result: TranscriptionResult
  ) => Promise<void>;
  /** Check if transcription is available */
  isTranscriptionAvailable: () => Promise<boolean>;
  /** Check if search indexing is available */
  isSearchAvailable: () => Promise<boolean>;
  /** Get cached transcription */
  getCachedTranscription: (assetId: string) => TranscriptionResult | null;
  /** Current transcription state */
  transcriptionState: ReturnType<typeof useTranscription>['state'];
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook that integrates transcription with search indexing.
 *
 * @example
 * ```tsx
 * const { transcribeAndIndex, isTranscriptionAvailable } = useTranscriptionWithIndexing();
 *
 * // Transcribe and automatically index for search
 * const result = await transcribeAndIndex(assetId, { language: 'en' });
 *
 * // Now the transcript is searchable
 * const { search } = useSearch();
 * const results = await search('hello');
 * ```
 */
export function useTranscriptionWithIndexing(
  options: UseTranscriptionWithIndexingOptions = {}
): UseTranscriptionWithIndexingReturn {
  const { autoIndex = true, cacheResults = true, maxCacheSize = 50 } = options;

  // Use the transcription hook
  const {
    transcribeAsset,
    submitTranscriptionJob,
    isTranscriptionAvailable,
    getCachedTranscription,
    state: transcriptionState,
  } = useTranscription({ cacheResults, maxCacheSize });

  // Use the search hook for indexing
  const { indexTranscripts, isSearchAvailable } = useSearch();

  /**
   * Index a transcription result for search
   */
  const indexTranscription = useCallback(
    async (assetId: string, result: TranscriptionResult): Promise<void> => {
      if (!result.segments.length) {
        logger.debug('No segments to index', { assetId });
        return;
      }

      try {
        // Convert segments to the format expected by indexTranscripts
        const segments = result.segments.map((seg) => ({
          startTime: seg.startTime,
          endTime: seg.endTime,
          text: seg.text,
        }));

        await indexTranscripts(assetId, segments, result.language);

        logger.info('Transcription indexed for search', {
          assetId,
          segmentCount: segments.length,
          language: result.language,
        });
      } catch (error) {
        // Log but don't throw - indexing failure shouldn't break transcription flow
        logger.error('Failed to index transcription', {
          assetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [indexTranscripts]
  );

  /**
   * Transcribe an asset and optionally index the results
   */
  const transcribeAndIndex = useCallback(
    async (
      assetId: string,
      transcriptionOptions?: TranscriptionOptions & { skipIndexing?: boolean }
    ): Promise<TranscriptionResult | null> => {
      const { skipIndexing, ...options } = transcriptionOptions ?? {};

      // Perform transcription
      const result = await transcribeAsset(assetId, options);

      // Index results if transcription succeeded and indexing is enabled
      if (result && autoIndex && !skipIndexing) {
        const searchAvailable = await isSearchAvailable();
        if (searchAvailable) {
          await indexTranscription(assetId, result);
        } else {
          logger.debug('Search not available, skipping indexing', { assetId });
        }
      }

      return result;
    },
    [transcribeAsset, autoIndex, isSearchAvailable, indexTranscription]
  );

  return {
    transcribeAndIndex,
    submitTranscriptionJob,
    indexTranscription,
    isTranscriptionAvailable,
    isSearchAvailable,
    getCachedTranscription,
    transcriptionState,
  };
}

export default useTranscriptionWithIndexing;
