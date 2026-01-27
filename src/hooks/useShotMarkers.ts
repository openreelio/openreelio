/**
 * useShotMarkers Hook
 *
 * Manages shot markers for display on the timeline.
 * Integrates with useShotDetection to load and cache shots per asset.
 *
 * Features:
 * - Automatic loading of cached shots when asset changes
 * - Staleness tracking to prevent race conditions with async operations
 * - Shot navigation (next/previous shot)
 * - Proper cleanup when asset changes mid-detection
 */

import { useEffect, useCallback, useRef } from 'react';
import { useShotDetection, type Shot, type ShotDetectionConfig } from './useShotDetection';
import { createLogger } from '@/services/logger';

const logger = createLogger('useShotMarkers');

// =============================================================================
// Types
// =============================================================================

export interface UseShotMarkersOptions {
  /** Asset ID to load shots for */
  assetId: string | null;
  /** Path to the video file */
  videoPath: string | null;
  /** Whether to auto-load shots from cache on mount */
  autoLoad?: boolean;
  /** Callback when seeking to a shot */
  onSeek?: (timeSec: number) => void;
}

export interface UseShotMarkersReturn {
  /** Detected shots for current asset */
  shots: Shot[];
  /** Whether detection is in progress */
  isDetecting: boolean;
  /** Whether shots are being loaded */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Detect shots for the current asset */
  detectShots: (config?: ShotDetectionConfig) => Promise<void>;
  /** Navigate to a specific shot */
  navigateToShot: (shot: Shot) => void;
  /** Navigate to next shot */
  nextShot: (currentTime: number) => Shot | null;
  /** Navigate to previous shot */
  previousShot: (currentTime: number) => Shot | null;
  /** Get shot at a specific time */
  getShotAtTime: (timeSec: number) => Shot | null;
  /** Clear shots and error */
  clear: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for managing shot markers on the timeline
 *
 * @example
 * ```tsx
 * const { shots, detectShots, navigateToShot, isDetecting } = useShotMarkers({
 *   assetId: selectedAsset?.id ?? null,
 *   videoPath: selectedAsset?.uri ?? null,
 *   onSeek: (time) => seek(time),
 * });
 * ```
 */
export function useShotMarkers({
  assetId,
  videoPath,
  autoLoad = true,
  onSeek,
}: UseShotMarkersOptions): UseShotMarkersReturn {
  const {
    shots,
    isDetecting,
    isLoading,
    error,
    detectShots: detectShotsBase,
    getAssetShots,
    clearError,
    clearShots,
  } = useShotDetection();

  // Track which asset's shots are currently loaded
  const loadedAssetIdRef = useRef<string | null>(null);

  // Track request ID for staleness detection
  // Increments on each new detection request; stale results are discarded
  const requestIdRef = useRef(0);

  // Track if detection is in progress for this asset
  const isDetectingForAssetRef = useRef<string | null>(null);

  // ===========================================================================
  // Load shots when asset changes
  // ===========================================================================

  useEffect(() => {
    if (!autoLoad) return;
    if (!assetId) {
      clearShots();
      clearError();
      loadedAssetIdRef.current = null;
      isDetectingForAssetRef.current = null;
      return;
    }

    // Skip if already loaded for this asset
    if (loadedAssetIdRef.current === assetId) {
      return;
    }

    // Increment request ID to invalidate any in-flight requests
    requestIdRef.current += 1;
    const currentRequestId = requestIdRef.current;

    // Clear previous asset's detection state
    if (isDetectingForAssetRef.current && isDetectingForAssetRef.current !== assetId) {
      logger.debug('Asset changed during detection, discarding previous request', {
        previousAssetId: isDetectingForAssetRef.current,
        newAssetId: assetId,
      });
    }

    // Load cached shots for the new asset
    loadedAssetIdRef.current = assetId;
    getAssetShots(assetId).then(() => {
      // Check if this request is still valid (asset hasn't changed)
      if (requestIdRef.current !== currentRequestId) {
        logger.debug('Discarding stale shot load result', {
          requestId: currentRequestId,
          currentRequestId: requestIdRef.current,
        });
        return;
      }
      // Results are automatically applied by useShotDetection
    });
  }, [assetId, autoLoad, getAssetShots, clearShots, clearError]);

  // ===========================================================================
  // Detect Shots
  // ===========================================================================

  const detectShots = useCallback(
    async (config?: ShotDetectionConfig) => {
      if (!assetId || !videoPath) {
        logger.warn('Cannot detect shots: missing asset ID or video path');
        return;
      }

      // Increment request ID to track this detection
      requestIdRef.current += 1;
      const currentRequestId = requestIdRef.current;
      isDetectingForAssetRef.current = assetId;

      logger.debug('Starting shot detection', {
        assetId,
        requestId: currentRequestId,
        config,
      });

      try {
        const result = await detectShotsBase(assetId, videoPath, config);

        // Check if this request is still valid (asset hasn't changed)
        if (requestIdRef.current !== currentRequestId) {
          logger.debug('Discarding stale shot detection result', {
            requestId: currentRequestId,
            currentRequestId: requestIdRef.current,
            assetId,
          });
          return;
        }

        if (result) {
          logger.info('Shot detection completed', {
            assetId,
            shotCount: result.shotCount,
          });
        }
      } finally {
        if (isDetectingForAssetRef.current === assetId) {
          isDetectingForAssetRef.current = null;
        }
      }
    },
    [assetId, videoPath, detectShotsBase],
  );

  // ===========================================================================
  // Navigation
  // ===========================================================================

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
      return (
        shots.find((shot) => timeSec >= shot.startSec && timeSec < shot.endSec) ?? null
      );
    },
    [shots]
  );

  const nextShot = useCallback(
    (currentTime: number): Shot | null => {
      if (shots.length === 0) return null;

      // Find first shot that starts after current time
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

      // Find the current shot index
      const currentIndex = shots.findIndex(
        (shot) => currentTime >= shot.startSec && currentTime < shot.endSec
      );

      let targetIndex: number;

      if (currentIndex < 0) {
        // Not in any shot - find the last shot that ends before or at current time
        // This handles gaps between shots and time after all shots
        const lastShotBeforeTime = shots.reduce((lastIdx, shot, idx) => {
          return shot.endSec <= currentTime ? idx : lastIdx;
        }, -1);

        if (lastShotBeforeTime >= 0) {
          // Found a shot before current time
          targetIndex = lastShotBeforeTime;
        } else {
          // No shot before current time, go to first shot
          targetIndex = 0;
        }
      } else if (currentTime > shots[currentIndex].startSec + 0.5) {
        // More than 0.5s into current shot, go to start of current shot
        targetIndex = currentIndex;
      } else {
        // At start of current shot, go to previous shot
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

  // ===========================================================================
  // Clear
  // ===========================================================================

  const clear = useCallback(() => {
    // Increment request ID to invalidate any pending operations
    requestIdRef.current += 1;
    clearShots();
    clearError();
    loadedAssetIdRef.current = null;
    isDetectingForAssetRef.current = null;
    logger.debug('Shot markers cleared');
  }, [clearShots, clearError]);

  // ===========================================================================
  // Return
  // ===========================================================================

  return {
    shots,
    isDetecting,
    isLoading,
    error,
    detectShots,
    navigateToShot,
    nextShot,
    previousShot,
    getShotAtTime,
    clear,
  };
}

export default useShotMarkers;
