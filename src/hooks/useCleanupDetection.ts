/**
 * useCleanupDetection Hook
 *
 * Detects silence regions and filler words for cleanup removal.
 * Provides detection, preview highlighting, and batch removal workflow.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { runProjectBackendMutation } from '@/services/projectMutationGateway';
import type { DetectedRegion, CleanupDetectionResult } from '@/types';

const logger = createLogger('useCleanupDetection');

// =============================================================================
// Types
// =============================================================================

/** Detection mode for the cleanup workflow */
export type CleanupMode = 'silence' | 'filler' | null;

/** Silence detection parameters */
export interface SilenceDetectionParams {
  thresholdDb: number;
  minDurationSec: number;
}

/** Default silence detection parameters */
export const DEFAULT_SILENCE_PARAMS: SilenceDetectionParams = {
  thresholdDb: -35,
  minDurationSec: 0.5,
};

/** Default filler word list */
export const DEFAULT_FILLER_WORDS: string[] = [
  'um',
  'uh',
  'uhm',
  'umm',
  'er',
  'err',
  'ah',
  'ahh',
  'like',
  'you know',
  'i mean',
  'sort of',
  'kind of',
  'basically',
  'actually',
  'literally',
  'right',
  'so',
  'well',
];

/** Default inward padding for removal boundaries */
export const DEFAULT_PADDING_SEC = 0.05;

interface CleanupClipContext {
  sequenceId: string;
  trackId: string;
  clipId: string;
  assetId: string;
  sourceInSec: number;
  sourceOutSec: number;
}

function constrainRegionsToClipRange(
  regions: DetectedRegion[],
  sourceInSec: number,
  sourceOutSec: number,
): DetectedRegion[] {
  return regions.flatMap((region) => {
    const startSec = Math.max(region.startSec, sourceInSec);
    const endSec = Math.min(region.endSec, sourceOutSec);

    if (endSec <= startSec) {
      return [];
    }

    return [
      {
        ...region,
        startSec,
        endSec,
      },
    ];
  });
}

/** Return type of the hook */
export interface UseCleanupDetectionReturn {
  /** Currently detected regions for preview */
  detectedRegions: DetectedRegion[];
  /** Whether detection is in progress */
  isDetecting: boolean;
  /** Whether removal is in progress */
  isRemoving: boolean;
  /** Error from last operation */
  error: string | null;
  /** Current cleanup mode */
  mode: CleanupMode;
  /** Total duration of detected regions */
  totalDurationSec: number;

  /** Detect silence regions with given params */
  detectSilence: (params?: SilenceDetectionParams) => Promise<void>;
  /** Detect filler words with optional custom word list */
  detectFillers: (customWords?: string[]) => Promise<void>;
  /** Remove all currently detected regions */
  removeDetected: (paddingSec?: number) => Promise<void>;
  /** Clear detection results and reset mode */
  clearDetection: () => void;
  /** Check if a source-relative time falls within any detected region */
  isTimeInDetectedRegion: (timeSec: number) => boolean;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useCleanupDetection(): UseCleanupDetectionReturn {
  const [detectedRegions, setDetectedRegions] = useState<DetectedRegion[]>([]);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CleanupMode>(null);
  const [totalDurationSec, setTotalDurationSec] = useState(0);
  const isMountedRef = useRef(true);
  const clipContextRef = useRef<CleanupClipContext | null>(null);
  const selectedClipIds = useTimelineStore((s) => s.selectedClipIds);
  const activeSequenceId = useProjectStore((s) => s.activeSequenceId);
  const sequences = useProjectStore((s) => s.sequences);

  // Cleanup on unmount to prevent state updates on unmounted component
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Resolve current clip context from stores
  // ---------------------------------------------------------------------------
  const clipContext = useMemo<CleanupClipContext | null>(() => {
    if (selectedClipIds.length !== 1 || !activeSequenceId) {
      return null;
    }

    const sequence = sequences.get(activeSequenceId);
    if (!sequence) {
      return null;
    }

    const clipId = selectedClipIds[0];

    for (const track of sequence.tracks) {
      const clip = track.clips.find((item) => item.id === clipId);
      if (clip) {
        return {
          sequenceId: activeSequenceId,
          trackId: track.id,
          clipId: clip.id,
          assetId: clip.assetId,
          sourceInSec: clip.range.sourceInSec,
          sourceOutSec: clip.range.sourceOutSec,
        };
      }
    }

    return null;
  }, [selectedClipIds, activeSequenceId, sequences]);

  useEffect(() => {
    clipContextRef.current = clipContext;
  }, [clipContext]);

  useEffect(() => {
    setDetectedRegions([]);
    setTotalDurationSec(0);
    setError(null);
    setMode(null);
  }, [
    clipContext?.assetId,
    clipContext?.sequenceId,
    clipContext?.trackId,
    clipContext?.clipId,
    clipContext?.sourceInSec,
    clipContext?.sourceOutSec,
  ]);

  // ---------------------------------------------------------------------------
  // Detect silence regions
  // ---------------------------------------------------------------------------
  const detectSilence = useCallback(
    async (params: SilenceDetectionParams = DEFAULT_SILENCE_PARAMS): Promise<void> => {
      if (!clipContext) {
        setError('No clip selected');
        return;
      }

      const requestClipId = clipContext.clipId;

      setIsDetecting(true);
      setError(null);
      setMode('silence');

      try {
        const result = await invoke<CleanupDetectionResult>('detect_silence_regions', {
          args: {
            assetId: clipContext.assetId,
            thresholdDb: params.thresholdDb,
            minDurationSec: params.minDurationSec,
          },
        });

        if (isMountedRef.current && clipContextRef.current?.clipId === requestClipId) {
          const clipScopedRegions = constrainRegionsToClipRange(
            result.regions,
            clipContext.sourceInSec,
            clipContext.sourceOutSec,
          );
          const clipScopedDuration = clipScopedRegions.reduce(
            (total, region) => total + (region.endSec - region.startSec),
            0,
          );

          setDetectedRegions(clipScopedRegions);
          setTotalDurationSec(clipScopedDuration);
          logger.info(
            `Detected ${clipScopedRegions.length} silence regions (${clipScopedDuration.toFixed(1)}s)`,
          );
        }
      } catch (err) {
        if (isMountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          logger.error(`Silence detection failed: ${msg}`);
        }
      } finally {
        if (isMountedRef.current) {
          setIsDetecting(false);
        }
      }
    },
    [clipContext],
  );

  // ---------------------------------------------------------------------------
  // Detect filler words
  // ---------------------------------------------------------------------------
  const detectFillers = useCallback(
    async (customWords?: string[]): Promise<void> => {
      if (!clipContext) {
        setError('No clip selected');
        return;
      }

      const requestClipId = clipContext.clipId;

      setIsDetecting(true);
      setError(null);
      setMode('filler');

      try {
        const result = await invoke<CleanupDetectionResult>('detect_filler_words', {
          args: {
            assetId: clipContext.assetId,
            customWords: customWords ?? [],
          },
        });

        if (isMountedRef.current && clipContextRef.current?.clipId === requestClipId) {
          const clipScopedRegions = constrainRegionsToClipRange(
            result.regions,
            clipContext.sourceInSec,
            clipContext.sourceOutSec,
          );
          const clipScopedDuration = clipScopedRegions.reduce(
            (total, region) => total + (region.endSec - region.startSec),
            0,
          );

          setDetectedRegions(clipScopedRegions);
          setTotalDurationSec(clipScopedDuration);
          logger.info(
            `Detected ${clipScopedRegions.length} filler words (${clipScopedDuration.toFixed(1)}s)`,
          );
        }
      } catch (err) {
        if (isMountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          logger.error(`Filler detection failed: ${msg}`);
        }
      } finally {
        if (isMountedRef.current) {
          setIsDetecting(false);
        }
      }
    },
    [clipContext],
  );

  // ---------------------------------------------------------------------------
  // Remove detected regions
  // ---------------------------------------------------------------------------
  const removeDetected = useCallback(
    async (paddingSec: number = DEFAULT_PADDING_SEC): Promise<void> => {
      if (detectedRegions.length === 0) {
        setError('No regions detected to remove');
        return;
      }

      if (!clipContext) {
        setError('No clip selected');
        return;
      }

      setIsRemoving(true);
      setError(null);

      try {
        const result = await runProjectBackendMutation('removeDetectedRegions', () =>
          invoke<{ success: boolean; removedCount: number }>('remove_detected_regions', {
            args: {
              sequenceId: clipContext.sequenceId,
              trackId: clipContext.trackId,
              clipId: clipContext.clipId,
              regions: detectedRegions,
              paddingSec,
            },
          }),
        );

        if (isMountedRef.current) {
          logger.info(`Removed ${result.removedCount} regions`);
          setDetectedRegions([]);
          setTotalDurationSec(0);
          setMode(null);
        }
      } catch (err) {
        if (isMountedRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          logger.error(`Region removal failed: ${msg}`);
        }
      } finally {
        if (isMountedRef.current) {
          setIsRemoving(false);
        }
      }
    },
    [clipContext, detectedRegions],
  );

  // ---------------------------------------------------------------------------
  // Clear detection
  // ---------------------------------------------------------------------------
  const clearDetection = useCallback((): void => {
    setDetectedRegions([]);
    setTotalDurationSec(0);
    setError(null);
    setMode(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Time-in-region check (for word highlighting)
  // ---------------------------------------------------------------------------
  const isTimeInDetectedRegion = useCallback(
    (timeSec: number): boolean => {
      return detectedRegions.some((r) => timeSec >= r.startSec && timeSec < r.endSec);
    },
    [detectedRegions],
  );

  return {
    detectedRegions,
    isDetecting,
    isRemoving,
    error,
    mode,
    totalDurationSec,
    detectSilence,
    detectFillers,
    removeDetected,
    clearDetection,
    isTimeInDetectedRegion,
  };
}
