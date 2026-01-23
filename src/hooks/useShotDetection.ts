/**
 * useShotDetection Hook
 *
 * Provides functionality to detect and manage shots/scenes in video files.
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

const logger = createLogger('useShotDetection');

// =============================================================================
// Types
// =============================================================================

/** Configuration options for shot detection */
export interface ShotDetectionConfig {
  /** Scene change detection threshold (0.0 - 1.0). Lower values detect more scene changes */
  threshold?: number;
  /** Minimum shot duration in seconds */
  minShotDuration?: number;
}

/** Detected shot data */
export interface Shot {
  /** Unique shot ID */
  id: string;
  /** Asset ID this shot belongs to */
  assetId: string;
  /** Start time in seconds */
  startSec: number;
  /** End time in seconds */
  endSec: number;
  /** Path to keyframe thumbnail (if generated) */
  keyframePath: string | null;
  /** Quality score (0.0 - 1.0) */
  qualityScore: number | null;
  /** Tags/labels for this shot */
  tags: string[];
}

/** Result of shot detection operation */
export interface ShotDetectionResult {
  /** Number of shots detected */
  shotCount: number;
  /** Detected shots */
  shots: Shot[];
  /** Total video duration in seconds */
  totalDuration: number;
}

/** Hook state */
interface ShotDetectionState {
  isDetecting: boolean;
  isLoading: boolean;
  error: string | null;
  shots: Shot[];
}

/** Hook return type */
export interface UseShotDetectionReturn extends ShotDetectionState {
  /** Detect shots in a video file */
  detectShots: (
    assetId: string,
    videoPath: string,
    config?: ShotDetectionConfig
  ) => Promise<ShotDetectionResult | null>;
  /** Get cached shots for an asset */
  getAssetShots: (assetId: string) => Promise<Shot[]>;
  /** Delete all shots for an asset */
  deleteAssetShots: (assetId: string) => Promise<boolean>;
  /** Check if shot detection is available (requires FFmpeg) */
  isAvailable: () => Promise<boolean>;
  /** Clear any error */
  clearError: () => void;
  /** Clear shots from state */
  clearShots: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for detecting and managing shots/scenes in video files
 *
 * @example
 * ```tsx
 * const { detectShots, shots, isDetecting, error } = useShotDetection();
 *
 * const handleDetect = async () => {
 *   const result = await detectShots(asset.id, asset.uri, {
 *     threshold: 0.3,
 *     minShotDuration: 0.5,
 *   });
 *   if (result) {
 *     console.log(`Detected ${result.shotCount} shots`);
 *   }
 * };
 * ```
 */
export function useShotDetection(): UseShotDetectionReturn {
  const [state, setState] = useState<ShotDetectionState>({
    isDetecting: false,
    isLoading: false,
    error: null,
    shots: [],
  });

  /**
   * Detect shots in a video file
   */
  const detectShots = useCallback(
    async (
      assetId: string,
      videoPath: string,
      config?: ShotDetectionConfig
    ): Promise<ShotDetectionResult | null> => {
      if (!assetId || !videoPath) {
        setState((prev) => ({ ...prev, error: 'Asset ID and video path are required' }));
        return null;
      }

      setState({ isDetecting: true, isLoading: false, error: null, shots: [] });

      try {
        const result = await invoke<ShotDetectionResult>('detect_shots', {
          assetId,
          videoPath,
          config: config
            ? {
                threshold: config.threshold,
                minShotDuration: config.minShotDuration,
              }
            : null,
        });

        logger.info(`Detected ${result.shotCount} shots in ${assetId}`, {
          totalDuration: result.totalDuration,
        });

        setState({
          isDetecting: false,
          isLoading: false,
          error: null,
          shots: result.shots,
        });

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to detect shots', { error: message, assetId });
        setState((prev) => ({ ...prev, isDetecting: false, error: message }));
        return null;
      }
    },
    []
  );

  /**
   * Get cached shots for an asset
   */
  const getAssetShots = useCallback(async (assetId: string): Promise<Shot[]> => {
    if (!assetId) {
      setState((prev) => ({ ...prev, error: 'Asset ID is required' }));
      return [];
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const shots = await invoke<Shot[]>('get_asset_shots', { assetId });

      setState((prev) => ({
        ...prev,
        isLoading: false,
        shots,
      }));

      return shots;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get asset shots', { error: message, assetId });
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
      return [];
    }
  }, []);

  /**
   * Delete all shots for an asset
   */
  const deleteAssetShots = useCallback(async (assetId: string): Promise<boolean> => {
    if (!assetId) {
      setState((prev) => ({ ...prev, error: 'Asset ID is required' }));
      return false;
    }

    try {
      await invoke('delete_asset_shots', { assetId });

      // Clear shots from state if they belong to this asset
      setState((prev) => ({
        ...prev,
        shots: prev.shots.filter((s) => s.assetId !== assetId),
      }));

      logger.info(`Deleted shots for asset ${assetId}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to delete asset shots', { error: message, assetId });
      setState((prev) => ({ ...prev, error: message }));
      return false;
    }
  }, []);

  /**
   * Check if shot detection is available (requires FFmpeg)
   */
  const isAvailable = useCallback(async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('is_shot_detection_available');
    } catch (error) {
      logger.warn('Failed to check shot detection availability', { error });
      return false;
    }
  }, []);

  /**
   * Clear any error
   */
  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  /**
   * Clear shots from state
   */
  const clearShots = useCallback(() => {
    setState((prev) => ({ ...prev, shots: [] }));
  }, []);

  return {
    ...state,
    detectShots,
    getAssetShots,
    deleteAssetShots,
    isAvailable,
    clearError,
    clearShots,
  };
}

export default useShotDetection;
