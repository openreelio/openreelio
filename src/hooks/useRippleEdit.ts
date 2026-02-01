/**
 * useRippleEdit Hook
 *
 * Implements ripple editing behavior for timeline operations.
 * When ripple mode is enabled, deleting or moving clips automatically
 * shifts subsequent clips to maintain continuity.
 *
 * @module hooks/useRippleEdit
 */

import { useCallback } from 'react';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Sequence, Clip, Track } from '@/types';
import { MIN_CLIP_GAP_SEC } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

export interface RippleOperation {
  /** Type of ripple operation */
  type: 'delete' | 'insert' | 'move' | 'trim';
  /** Track ID where the operation occurs */
  trackId: string;
  /** Time position where the operation starts */
  startTime: number;
  /** Amount to shift subsequent clips (positive = right, negative = left) */
  deltaTime: number;
}

export interface RippleResult {
  /** Clips that would be affected by the ripple */
  affectedClips: Array<{
    clipId: string;
    trackId: string;
    originalTime: number;
    newTime: number;
  }>;
  /** Total time shift applied */
  totalDelta: number;
}

export interface UseRippleEditOptions {
  /** Current sequence */
  sequence: Sequence | null;
  /** Whether to apply ripple across all tracks */
  rippleAllTracks?: boolean;
}

export interface UseRippleEditReturn {
  /** Whether ripple mode is currently enabled */
  isRippleEnabled: boolean;
  /** Toggle ripple mode on/off */
  toggleRipple: () => void;
  /** Set ripple mode */
  setRippleEnabled: (enabled: boolean) => void;
  /** Calculate ripple effect for a delete operation */
  calculateDeleteRipple: (clipIds: string[]) => RippleResult;
  /** Calculate ripple effect for an insert operation */
  calculateInsertRipple: (trackId: string, insertTime: number, insertDuration: number) => RippleResult;
  /** Calculate ripple effect for a move operation */
  calculateMoveRipple: (clipId: string, fromTime: number, toTime: number) => RippleResult;
  /** Calculate ripple effect for a trim operation */
  calculateTrimRipple: (clipId: string, originalDuration: number, newDuration: number) => RippleResult;
  /** Get clips that come after a given time on a track */
  getClipsAfter: (trackId: string, time: number, excludeClipIds?: string[]) => Clip[];
  /** Get all clips across all tracks after a given time */
  getAllClipsAfter: (time: number, excludeClipIds?: string[]) => Array<{ clip: Clip; trackId: string }>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate clip duration accounting for speed
 */
function getClipDuration(clip: Clip): number {
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
}

/**
 * Get the end time of a clip
 */
function getClipEndTime(clip: Clip): number {
  return clip.place.timelineInSec + getClipDuration(clip);
}

/**
 * Find a clip by ID in the sequence
 */
function findClipInSequence(
  sequence: Sequence,
  clipId: string
): { clip: Clip; track: Track } | null {
  for (const track of sequence.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) {
      return { clip, track };
    }
  }
  return null;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for ripple editing operations.
 *
 * Ripple editing automatically shifts subsequent clips when:
 * - A clip is deleted (shifts left to fill gap)
 * - A clip is inserted (shifts right to make room)
 * - A clip is moved (maintains relative positions)
 * - A clip is trimmed (shifts based on duration change)
 *
 * @example
 * ```tsx
 * const { isRippleEnabled, calculateDeleteRipple } = useRippleEdit({
 *   sequence,
 *   rippleAllTracks: false,
 * });
 *
 * if (isRippleEnabled) {
 *   const result = calculateDeleteRipple(['clip-1']);
 *   // Apply result.affectedClips changes
 * }
 * ```
 */
export function useRippleEdit(options: UseRippleEditOptions): UseRippleEditReturn {
  const { sequence, rippleAllTracks = false } = options;

  const { rippleEnabled, toggleRipple, setRippleEnabled } = useEditorToolStore();

  /**
   * Get clips that come after a given time on a specific track
   */
  const getClipsAfter = useCallback(
    (trackId: string, time: number, excludeClipIds: string[] = []): Clip[] => {
      if (!sequence) return [];

      const track = sequence.tracks.find(t => t.id === trackId);
      if (!track) return [];

      return track.clips
        .filter(clip => {
          if (excludeClipIds.includes(clip.id)) return false;
          return clip.place.timelineInSec >= time;
        })
        .sort((a, b) => a.place.timelineInSec - b.place.timelineInSec);
    },
    [sequence]
  );

  /**
   * Get all clips across all tracks after a given time
   */
  const getAllClipsAfter = useCallback(
    (time: number, excludeClipIds: string[] = []): Array<{ clip: Clip; trackId: string }> => {
      if (!sequence) return [];

      const result: Array<{ clip: Clip; trackId: string }> = [];

      for (const track of sequence.tracks) {
        for (const clip of track.clips) {
          if (excludeClipIds.includes(clip.id)) continue;
          if (clip.place.timelineInSec >= time) {
            result.push({ clip, trackId: track.id });
          }
        }
      }

      return result.sort((a, b) => a.clip.place.timelineInSec - b.clip.place.timelineInSec);
    },
    [sequence]
  );

  /**
   * Calculate ripple effect for deleting clips
   */
  const calculateDeleteRipple = useCallback(
    (clipIds: string[]): RippleResult => {
      if (!sequence || clipIds.length === 0) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const affectedClips: RippleResult['affectedClips'] = [];
      let totalDelta = 0;

      // Group clips by track for efficient processing
      const clipsByTrack = new Map<string, Clip[]>();

      for (const clipId of clipIds) {
        const found = findClipInSequence(sequence, clipId);
        if (found) {
          const trackClips = clipsByTrack.get(found.track.id) || [];
          trackClips.push(found.clip);
          clipsByTrack.set(found.track.id, trackClips);
        }
      }

      // Process each track
      for (const [trackId, deletedClips] of clipsByTrack) {
        // Sort by timeline position
        deletedClips.sort((a, b) => a.place.timelineInSec - b.place.timelineInSec);

        // Calculate total duration of deleted clips
        const deletedDuration = deletedClips.reduce(
          (sum, clip) => sum + getClipDuration(clip),
          0
        );

        // Find the earliest delete position
        const earliestDeleteTime = deletedClips[0].place.timelineInSec;

        // Get clips after the deletion point on this track
        // Note: rippleAllTracks handling for other tracks is done separately below (line 241+)
        const clipsToShift = getClipsAfter(trackId, earliestDeleteTime, clipIds)
          .map(c => ({ clip: c, trackId }));

        // Calculate new positions
        for (const { clip } of clipsToShift) {
          const newTime = Math.max(
            MIN_CLIP_GAP_SEC,
            clip.place.timelineInSec - deletedDuration
          );

          affectedClips.push({
            clipId: clip.id,
            trackId,
            originalTime: clip.place.timelineInSec,
            newTime,
          });
        }

        totalDelta = Math.max(totalDelta, deletedDuration);
      }

      // If rippling all tracks, process other tracks too
      if (rippleAllTracks && clipsByTrack.size > 0) {
        // Find the earliest delete time across all tracks
        let earliestTime = Infinity;
        let totalDeleteDuration = 0;

        for (const deletedClips of clipsByTrack.values()) {
          for (const clip of deletedClips) {
            if (clip.place.timelineInSec < earliestTime) {
              earliestTime = clip.place.timelineInSec;
            }
            totalDeleteDuration += getClipDuration(clip);
          }
        }

        // Shift clips on other tracks
        for (const track of sequence.tracks) {
          if (clipsByTrack.has(track.id)) continue; // Already processed

          for (const clip of track.clips) {
            if (clip.place.timelineInSec >= earliestTime) {
              const newTime = Math.max(
                MIN_CLIP_GAP_SEC,
                clip.place.timelineInSec - totalDeleteDuration
              );

              affectedClips.push({
                clipId: clip.id,
                trackId: track.id,
                originalTime: clip.place.timelineInSec,
                newTime,
              });
            }
          }
        }
      }

      return { affectedClips, totalDelta: -totalDelta };
    },
    [sequence, rippleAllTracks, getClipsAfter, getAllClipsAfter]
  );

  /**
   * Calculate ripple effect for inserting a clip
   */
  const calculateInsertRipple = useCallback(
    (trackId: string, insertTime: number, insertDuration: number): RippleResult => {
      if (!sequence) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const affectedClips: RippleResult['affectedClips'] = [];

      // Get clips that need to be shifted
      const clipsToShift = rippleAllTracks
        ? getAllClipsAfter(insertTime)
        : getClipsAfter(trackId, insertTime).map(c => ({ clip: c, trackId }));

      for (const { clip, trackId: clipTrackId } of clipsToShift) {
        affectedClips.push({
          clipId: clip.id,
          trackId: clipTrackId,
          originalTime: clip.place.timelineInSec,
          newTime: clip.place.timelineInSec + insertDuration,
        });
      }

      return { affectedClips, totalDelta: insertDuration };
    },
    [sequence, rippleAllTracks, getClipsAfter, getAllClipsAfter]
  );

  /**
   * Calculate ripple effect for moving a clip
   */
  const calculateMoveRipple = useCallback(
    (clipId: string, fromTime: number, toTime: number): RippleResult => {
      if (!sequence) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const found = findClipInSequence(sequence, clipId);
      if (!found) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const clipDuration = getClipDuration(found.clip);
      const deltaTime = toTime - fromTime;

      const affectedClips: RippleResult['affectedClips'] = [];

      if (deltaTime > 0) {
        // Moving right - shift clips between from and to positions
        const clipsInRange = rippleAllTracks
          ? getAllClipsAfter(fromTime + clipDuration, [clipId])
              .filter(c => c.clip.place.timelineInSec < toTime + clipDuration)
          : getClipsAfter(found.track.id, fromTime + clipDuration, [clipId])
              .filter(c => c.place.timelineInSec < toTime + clipDuration)
              .map(c => ({ clip: c, trackId: found.track.id }));

        for (const { clip, trackId } of clipsInRange) {
          affectedClips.push({
            clipId: clip.id,
            trackId,
            originalTime: clip.place.timelineInSec,
            newTime: clip.place.timelineInSec - clipDuration,
          });
        }
      } else if (deltaTime < 0) {
        // Moving left - shift clips between to and from positions
        const clipsInRange = rippleAllTracks
          ? getAllClipsAfter(toTime, [clipId])
              .filter(c => c.clip.place.timelineInSec < fromTime)
          : getClipsAfter(found.track.id, toTime, [clipId])
              .filter(c => c.place.timelineInSec < fromTime)
              .map(c => ({ clip: c, trackId: found.track.id }));

        for (const { clip, trackId } of clipsInRange) {
          affectedClips.push({
            clipId: clip.id,
            trackId,
            originalTime: clip.place.timelineInSec,
            newTime: clip.place.timelineInSec + clipDuration,
          });
        }
      }

      return { affectedClips, totalDelta: deltaTime };
    },
    [sequence, rippleAllTracks, getClipsAfter, getAllClipsAfter]
  );

  /**
   * Calculate ripple effect for trimming a clip
   */
  const calculateTrimRipple = useCallback(
    (clipId: string, originalDuration: number, newDuration: number): RippleResult => {
      if (!sequence) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const found = findClipInSequence(sequence, clipId);
      if (!found) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const deltaTime = newDuration - originalDuration;

      if (Math.abs(deltaTime) < 0.001) {
        return { affectedClips: [], totalDelta: 0 };
      }

      const affectedClips: RippleResult['affectedClips'] = [];
      const clipEndTime = getClipEndTime(found.clip);

      // Get clips after the original end position
      const clipsToShift = rippleAllTracks
        ? getAllClipsAfter(clipEndTime, [clipId])
        : getClipsAfter(found.track.id, clipEndTime, [clipId]).map(c => ({
            clip: c,
            trackId: found.track.id,
          }));

      for (const { clip, trackId } of clipsToShift) {
        const newTime = Math.max(
          MIN_CLIP_GAP_SEC,
          clip.place.timelineInSec + deltaTime
        );

        affectedClips.push({
          clipId: clip.id,
          trackId,
          originalTime: clip.place.timelineInSec,
          newTime,
        });
      }

      return { affectedClips, totalDelta: deltaTime };
    },
    [sequence, rippleAllTracks, getClipsAfter, getAllClipsAfter]
  );

  return {
    isRippleEnabled: rippleEnabled,
    toggleRipple,
    setRippleEnabled,
    calculateDeleteRipple,
    calculateInsertRipple,
    calculateMoveRipple,
    calculateTrimRipple,
    getClipsAfter,
    getAllClipsAfter,
  };
}

export default useRippleEdit;
