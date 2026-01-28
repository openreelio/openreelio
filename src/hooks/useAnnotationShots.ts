/**
 * useAnnotationShots Hook
 *
 * Provides shot data from the annotation system in a format compatible
 * with the existing timeline shot markers.
 *
 * This hook bridges the annotation system with the existing ShotMarkers component.
 */

import { useMemo, useEffect, useCallback } from 'react';

import type { Shot } from '@/hooks/useShotDetection';
import { useAnnotation } from '@/hooks/useAnnotation';
import { shotResultsToShots } from '@/utils/shotConverter';

// =============================================================================
// Types
// =============================================================================

export interface UseAnnotationShotsOptions {
  /** Asset ID to load shots for */
  assetId: string | null;
  /** Callback when seeking to a shot time */
  onSeek?: (timeSec: number) => void;
}

export interface UseAnnotationShotsReturn {
  /** Shots in timeline-compatible format */
  shots: Shot[];
  /** Whether annotation is being loaded */
  isLoading: boolean;
  /** Whether analysis is in progress */
  isAnalyzing: boolean;
  /** Whether asset has been analyzed */
  isAnalyzed: boolean;
  /** Whether annotation is stale */
  isStale: boolean;
  /** Error message if any */
  error: string | null;
  /** Navigate to a specific shot */
  navigateToShot: (shot: Shot) => void;
  /** Navigate to next shot */
  nextShot: (currentTime: number) => Shot | null;
  /** Navigate to previous shot */
  previousShot: (currentTime: number) => Shot | null;
  /** Get shot at a specific time */
  getShotAtTime: (timeSec: number) => Shot | null;
  /** Trigger analysis for current asset */
  analyze: () => Promise<void>;
  /** Refresh annotation data */
  refresh: () => Promise<void>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAnnotationShots({
  assetId,
  onSeek,
}: UseAnnotationShotsOptions): UseAnnotationShotsReturn {
  const {
    shots: rawShots,
    isLoading,
    isAnalyzing,
    isAnalyzed,
    isStale,
    error,
    fetchAnnotation,
    analyze: analyzeAsset,
  } = useAnnotation();

  // Convert ShotResult[] to Shot[] format for timeline compatibility
  const shots = useMemo(() => {
    if (!assetId || rawShots.length === 0) {
      return [];
    }
    return shotResultsToShots(rawShots, assetId);
  }, [rawShots, assetId]);

  // Load annotation when asset changes
  useEffect(() => {
    if (assetId) {
      fetchAnnotation(assetId);
    }
  }, [assetId, fetchAnnotation]);

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const navigateToShot = useCallback(
    (shot: Shot) => {
      if (onSeek) {
        onSeek(shot.startSec);
      }
    },
    [onSeek]
  );

  const getShotAtTime = useCallback(
    (timeSec: number): Shot | null => {
      return shots.find((shot) => timeSec >= shot.startSec && timeSec < shot.endSec) ?? null;
    },
    [shots]
  );

  const nextShot = useCallback(
    (currentTime: number): Shot | null => {
      if (shots.length === 0) return null;

      const nextIndex = shots.findIndex((shot) => shot.startSec > currentTime + 0.1);

      if (nextIndex >= 0) {
        const shot = shots[nextIndex];
        if (onSeek) {
          onSeek(shot.startSec);
        }
        return shot;
      }

      return null;
    },
    [shots, onSeek]
  );

  const previousShot = useCallback(
    (currentTime: number): Shot | null => {
      if (shots.length === 0) return null;

      const currentIndex = shots.findIndex(
        (shot) => currentTime >= shot.startSec && currentTime < shot.endSec
      );

      let targetIndex: number;

      if (currentIndex < 0) {
        const lastShotBeforeTime = shots.reduce((lastIdx, shot, idx) => {
          return shot.endSec <= currentTime ? idx : lastIdx;
        }, -1);

        targetIndex = lastShotBeforeTime >= 0 ? lastShotBeforeTime : 0;
      } else if (currentTime > shots[currentIndex].startSec + 0.5) {
        targetIndex = currentIndex;
      } else {
        targetIndex = Math.max(0, currentIndex - 1);
      }

      if (targetIndex >= 0 && targetIndex < shots.length) {
        const shot = shots[targetIndex];
        if (onSeek) {
          onSeek(shot.startSec);
        }
        return shot;
      }

      return null;
    },
    [shots, onSeek]
  );

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const analyze = useCallback(async () => {
    if (assetId) {
      await analyzeAsset(assetId, ['shots']);
    }
  }, [assetId, analyzeAsset]);

  const refresh = useCallback(async () => {
    if (assetId) {
      await fetchAnnotation(assetId);
    }
  }, [assetId, fetchAnnotation]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    shots,
    isLoading,
    isAnalyzing,
    isAnalyzed,
    isStale,
    error,
    navigateToShot,
    nextShot,
    previousShot,
    getShotAtTime,
    analyze,
    refresh,
  };
}

export default useAnnotationShots;
