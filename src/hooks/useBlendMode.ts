/**
 * useBlendMode Hook
 *
 * Manages blend mode operations for video tracks.
 * Provides utilities to get, set, and reset blend modes.
 *
 * @module hooks/useBlendMode
 */

import { useCallback, useMemo } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import type { BlendMode, Track } from '@/types';
import { DEFAULT_BLEND_MODE } from '@/utils/blendModes';
import { createLogger } from '@/services/logger';

const logger = createLogger('useBlendMode');

// =============================================================================
// Types
// =============================================================================

export interface VideoTrackInfo {
  id: string;
  name: string;
  blendMode: BlendMode;
  locked: boolean;
}

export interface UseBlendModeReturn {
  /** Get the blend mode for a track */
  getBlendMode: (trackId: string) => BlendMode;
  /** Set the blend mode for a track */
  setBlendMode: (trackId: string, blendMode: BlendMode) => Promise<boolean>;
  /** Reset blend mode to default (normal) */
  resetBlendMode: (trackId: string) => Promise<boolean>;
  /** Check if a track is a video track */
  isVideoTrack: (trackId: string) => boolean;
  /** Check if blend mode can be changed for a track */
  canChangeBlendMode: (trackId: string) => boolean;
  /** Get all video tracks with their blend modes */
  getVideoTracks: () => VideoTrackInfo[];
}

// =============================================================================
// Hook
// =============================================================================

export function useBlendMode(): UseBlendModeReturn {
  const executeCommand = useProjectStore((state) => state.executeCommand);
  const getActiveSequence = useProjectStore((state) => state.getActiveSequence);

  // Get all tracks from active sequence
  const tracks = useMemo(() => {
    const sequence = getActiveSequence();
    return sequence?.tracks ?? [];
  }, [getActiveSequence]);

  // Get a specific track by ID
  const getTrack = useCallback(
    (trackId: string): Track | undefined => {
      return tracks.find((track) => track.id === trackId);
    },
    [tracks],
  );

  // Get the blend mode for a track
  const getBlendMode = useCallback(
    (trackId: string): BlendMode => {
      const track = getTrack(trackId);
      return track?.blendMode ?? DEFAULT_BLEND_MODE;
    },
    [getTrack],
  );

  // Check if a track is a video track
  const isVideoTrack = useCallback(
    (trackId: string): boolean => {
      const track = getTrack(trackId);
      return track?.kind === 'video' || track?.kind === 'overlay';
    },
    [getTrack],
  );

  // Check if blend mode can be changed
  const canChangeBlendMode = useCallback(
    (trackId: string): boolean => {
      const track = getTrack(trackId);
      if (!track) return false;
      if (track.locked) return false;
      return track.kind === 'video' || track.kind === 'overlay';
    },
    [getTrack],
  );

  // Set the blend mode for a track
  const setBlendMode = useCallback(
    async (trackId: string, blendMode: BlendMode): Promise<boolean> => {
      const sequence = getActiveSequence();
      if (!sequence) {
        logger.warn('No active sequence');
        return false;
      }

      const currentBlendMode = getBlendMode(trackId);
      if (currentBlendMode === blendMode) {
        // No change needed
        return true;
      }

      try {
        await executeCommand({
          type: 'SetTrackBlendMode',
          payload: {
            sequenceId: sequence.id,
            trackId,
            blendMode,
          },
        });
        return true;
      } catch (error) {
        logger.error('Failed to set blend mode', { trackId, blendMode, error });
        return false;
      }
    },
    [executeCommand, getActiveSequence, getBlendMode],
  );

  // Reset blend mode to default
  const resetBlendMode = useCallback(
    async (trackId: string): Promise<boolean> => {
      return setBlendMode(trackId, DEFAULT_BLEND_MODE);
    },
    [setBlendMode],
  );

  // Get all video tracks with their blend modes
  const getVideoTracks = useCallback((): VideoTrackInfo[] => {
    return tracks
      .filter((track) => track.kind === 'video' || track.kind === 'overlay')
      .map((track) => ({
        id: track.id,
        name: track.name,
        blendMode: track.blendMode ?? DEFAULT_BLEND_MODE,
        locked: track.locked,
      }));
  }, [tracks]);

  return {
    getBlendMode,
    setBlendMode,
    resetBlendMode,
    isVideoTrack,
    canChangeBlendMode,
    getVideoTracks,
  };
}
