/**
 * useTimelineClipOperations Hook
 *
 * Manages clip utility functions and drag operation state for the Timeline component.
 * Extracted from Timeline.tsx to improve maintainability and testability.
 */

import { useState, useCallback } from 'react';
import type { Sequence, Clip, TrackKind } from '@/types';
import type { ClipMoveData, ClipTrimData } from '@/components/timeline/types';
import type { ClipDragData, DragPreviewPosition } from '@/components/timeline/Clip';
import type { DragPreviewState } from '@/components/timeline/DragPreviewLayer';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if two track kinds are compatible for cross-track drag.
 * video and overlay tracks are compatible with each other.
 * audio tracks are only compatible with other audio tracks.
 * caption tracks are only compatible with other caption tracks.
 */
function isTrackKindCompatible(sourceKind: TrackKind, targetKind: TrackKind): boolean {
  // Same kind is always compatible
  if (sourceKind === targetKind) return true;

  // video and overlay are compatible
  if ((sourceKind === 'video' || sourceKind === 'overlay') &&
      (targetKind === 'video' || targetKind === 'overlay')) {
    return true;
  }

  return false;
}

// =============================================================================
// Constants
// =============================================================================

/** Default track height in pixels */
const DEFAULT_TRACK_HEIGHT = 64;

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineClipOperationsProps {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Track height in pixels (for cross-track drag calculation) */
  trackHeight?: number;
  /** Callback for clip move operations */
  onClipMove?: (data: ClipMoveData) => void;
  /** Callback for clip trim operations */
  onClipTrim?: (data: ClipTrimData) => void;
  /** Callback to select a clip */
  selectClip?: (clipId: string) => void;
}

export interface UseTimelineClipOperationsResult {
  /** Current drag preview state */
  dragPreview: DragPreviewState | null;
  /** Get clips for a specific track */
  getTrackClips: (trackId: string) => Clip[];
  /** Find a clip by ID */
  findClip: (clipId: string) => { clip: Clip; trackId: string } | null;
  /** Handle clip drag start */
  handleClipDragStart: (trackId: string, data: ClipDragData) => void;
  /** Handle clip drag (update preview) */
  handleClipDrag: (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition, targetTrackIndex?: number) => void;
  /** Handle clip drag end (commit operation) */
  handleClipDragEnd: (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition, targetTrackIndex?: number) => void;
  /** Handle multi-clip drag end (move multiple selected clips) */
  handleMultiClipDragEnd: (
    trackId: string,
    dragData: ClipDragData,
    finalPosition: DragPreviewPosition,
    selectedClipIds: string[],
    targetTrackIndex?: number
  ) => void;
  /** Calculate track index from Y coordinate */
  calculateTrackIndexFromY: (mouseY: number, scrollY: number) => number;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTimelineClipOperations({
  sequence,
  zoom,
  trackHeight = DEFAULT_TRACK_HEIGHT,
  onClipMove,
  onClipTrim,
  selectClip,
}: UseTimelineClipOperationsProps): UseTimelineClipOperationsResult {
  // ===========================================================================
  // State
  // ===========================================================================
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);

  // ===========================================================================
  // Track Index Calculation
  // ===========================================================================

  /**
   * Calculate track index from mouse Y coordinate.
   * Accounts for scroll offset.
   */
  const calculateTrackIndexFromY = useCallback(
    (mouseY: number, scrollY: number): number => {
      const effectiveY = mouseY + scrollY;
      const trackIndex = Math.floor(effectiveY / trackHeight);
      const maxIndex = sequence ? sequence.tracks.length - 1 : 0;
      return Math.max(0, Math.min(trackIndex, maxIndex));
    },
    [trackHeight, sequence]
  );

  // ===========================================================================
  // Clip Utilities
  // ===========================================================================

  /**
   * Get all clips for a specific track.
   */
  const getTrackClips = useCallback(
    (trackId: string): Clip[] => {
      if (!sequence) return [];
      const track = sequence.tracks.find((t) => t.id === trackId);
      return track?.clips || [];
    },
    [sequence]
  );

  /**
   * Find a clip by ID and return it with its track ID.
   */
  const findClip = useCallback(
    (clipId: string): { clip: Clip; trackId: string } | null => {
      if (!sequence) return null;
      for (const track of sequence.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) {
          return { clip, trackId: track.id };
        }
      }
      return null;
    },
    [sequence]
  );

  // ===========================================================================
  // Drag Handlers
  // ===========================================================================

  /**
   * Handle the start of a clip drag operation.
   * Sets up the drag preview state and selects the clip.
   */
  const handleClipDragStart = useCallback(
    (trackId: string, data: ClipDragData) => {
      // Select the clip being dragged
      selectClip?.(data.clipId);

      if (sequence) {
        const trackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
        const clipInfo = findClip(data.clipId);

        if (clipInfo && trackIndex >= 0) {
          const clipDuration =
            (data.originalSourceOut - data.originalSourceIn) / clipInfo.clip.speed;

          setDragPreview({
            clipId: data.clipId,
            left: data.originalTimelineIn * zoom,
            width: clipDuration * zoom,
            trackIndex,
          });
        }
      }
    },
    [selectClip, sequence, zoom, findClip]
  );

  /**
   * Handle ongoing clip drag (updates preview position).
   * Supports cross-track drag with validity checking.
   */
  const handleClipDrag = useCallback(
    (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition, targetTrackIndex?: number) => {
      if (!sequence) return;

      const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
      const sourceTrack = sequence.tracks[sourceTrackIndex];

      // Determine target track index (default to source track)
      const effectiveTargetIndex = targetTrackIndex ?? sourceTrackIndex;
      const targetTrack = sequence.tracks[effectiveTargetIndex];

      // Check if drop is valid (compatible track kinds)
      const isValidDrop = targetTrack
        ? isTrackKindCompatible(sourceTrack?.kind ?? 'video', targetTrack.kind)
        : false;

      setDragPreview({
        clipId: data.clipId,
        left: previewPosition.timelineIn * zoom,
        width: previewPosition.duration * zoom,
        trackIndex: effectiveTargetIndex,
        isValidDrop,
      });
    },
    [sequence, zoom]
  );

  /**
   * Handle end of clip drag operation.
   * Commits the move or trim operation and clears the preview.
   * Supports cross-track moves to compatible tracks.
   */
  const handleClipDragEnd = useCallback(
    (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition, targetTrackIndex?: number) => {
      if (!sequence) {
        setDragPreview(null);
        return;
      }

      if (data.type === 'move' && onClipMove) {
        const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
        const sourceTrack = sequence.tracks[sourceTrackIndex];

        // Determine if we're moving to a different track
        let newTrackId: string | undefined;

        if (targetTrackIndex !== undefined && targetTrackIndex !== sourceTrackIndex) {
          const targetTrack = sequence.tracks[targetTrackIndex];

          // Only set newTrackId if target track exists and is compatible
          if (targetTrack && isTrackKindCompatible(sourceTrack?.kind ?? 'video', targetTrack.kind)) {
            newTrackId = targetTrack.id;
          }
        }

        const moveData: ClipMoveData = {
          sequenceId: sequence.id,
          trackId,
          clipId: data.clipId,
          newTimelineIn: Math.max(0, finalPosition.timelineIn),
        };

        // Only include newTrackId if it's defined (cross-track move)
        if (newTrackId) {
          moveData.newTrackId = newTrackId;
        }

        onClipMove(moveData);
      } else if ((data.type === 'trim-left' || data.type === 'trim-right') && onClipTrim) {
        if (data.type === 'trim-left') {
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceIn: Math.max(0, finalPosition.sourceIn),
            newTimelineIn: Math.max(0, finalPosition.timelineIn),
          });
        } else {
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceOut: finalPosition.sourceOut,
          });
        }
      }

      setDragPreview(null);
    },
    [sequence, onClipMove, onClipTrim]
  );

  /**
   * Handle end of multi-clip drag operation.
   * Moves all selected clips maintaining their relative positions.
   */
  const handleMultiClipDragEnd = useCallback(
    (
      trackId: string,
      dragData: ClipDragData,
      finalPosition: DragPreviewPosition,
      selectedClipIds: string[],
      targetTrackIndex?: number
    ) => {
      if (!sequence || !onClipMove) {
        setDragPreview(null);
        return;
      }

      // Calculate the offset from the primary clip's original position
      const offset = finalPosition.timelineIn - dragData.originalTimelineIn;

      // Determine target track for cross-track moves
      const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
      const sourceTrack = sequence.tracks[sourceTrackIndex];
      let newTrackId: string | undefined;

      if (targetTrackIndex !== undefined && targetTrackIndex !== sourceTrackIndex) {
        const targetTrack = sequence.tracks[targetTrackIndex];
        if (targetTrack && isTrackKindCompatible(sourceTrack?.kind ?? 'video', targetTrack.kind)) {
          newTrackId = targetTrack.id;
        }
      }

      // Move each selected clip
      for (const clipId of selectedClipIds) {
        const clipInfo = findClip(clipId);
        if (!clipInfo) continue;

        // Calculate new position based on offset
        const currentTimelineIn = clipInfo.clip.place.timelineInSec;
        const newTimelineIn = Math.max(0, currentTimelineIn + offset);

        const moveData: ClipMoveData = {
          sequenceId: sequence.id,
          trackId: clipInfo.trackId,
          clipId,
          newTimelineIn,
        };

        // Only include newTrackId for clips on the source track
        if (newTrackId && clipInfo.trackId === trackId) {
          moveData.newTrackId = newTrackId;
        }

        onClipMove(moveData);
      }

      setDragPreview(null);
    },
    [sequence, onClipMove, findClip]
  );

  // ===========================================================================
  // Return
  // ===========================================================================

  return {
    dragPreview,
    getTrackClips,
    findClip,
    handleClipDragStart,
    handleClipDrag,
    handleClipDragEnd,
    handleMultiClipDragEnd,
    calculateTrackIndexFromY,
  };
}
