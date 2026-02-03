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
import { useToastStore } from '@/hooks/useToast';

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

/** Maximum timeline position in seconds (24 hours) */
const MAX_TIMELINE_POSITION = 86400;

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
   * Accounts for scroll offset and validates bounds.
   * Returns -1 if coordinates are invalid or no tracks exist.
   */
  const calculateTrackIndexFromY = useCallback(
    (mouseY: number, scrollY: number): number => {
      // Validate inputs
      if (!Number.isFinite(mouseY) || !Number.isFinite(scrollY)) {
        return 0;
      }

      // No tracks available
      if (!sequence || sequence.tracks.length === 0) {
        return 0;
      }

      // Guard against zero or invalid track height
      const safeTrackHeight = trackHeight > 0 ? trackHeight : DEFAULT_TRACK_HEIGHT;

      const effectiveY = mouseY + scrollY;

      // Negative Y positions should map to first track
      if (effectiveY < 0) {
        return 0;
      }

      const trackIndex = Math.floor(effectiveY / safeTrackHeight);
      const maxIndex = sequence.tracks.length - 1;
      return Math.min(trackIndex, maxIndex);
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
      if (!sequence || sequence.tracks.length === 0) return;

      const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
      if (sourceTrackIndex < 0) return;

      const sourceTrack = sequence.tracks[sourceTrackIndex];

      // Determine target track index (default to source track) with bounds checking
      let effectiveTargetIndex = targetTrackIndex ?? sourceTrackIndex;
      effectiveTargetIndex = Math.max(0, Math.min(effectiveTargetIndex, sequence.tracks.length - 1));

      const targetTrack = sequence.tracks[effectiveTargetIndex];

      // Check if drop is valid (compatible track kinds)
      const isValidDrop = targetTrack
        ? isTrackKindCompatible(sourceTrack.kind, targetTrack.kind)
        : false;

      // Validate preview position values
      const safeTimelineIn = Number.isFinite(previewPosition.timelineIn)
        ? Math.max(0, previewPosition.timelineIn)
        : 0;
      const safeDuration = Number.isFinite(previewPosition.duration)
        ? Math.max(0, previewPosition.duration)
        : 0;

      setDragPreview({
        clipId: data.clipId,
        left: safeTimelineIn * zoom,
        width: safeDuration * zoom,
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
      if (!sequence || sequence.tracks.length === 0) {
        setDragPreview(null);
        return;
      }

      // Validate finalPosition values
      const safeTimelineIn = Number.isFinite(finalPosition.timelineIn)
        ? Math.min(MAX_TIMELINE_POSITION, Math.max(0, finalPosition.timelineIn))
        : 0;
      const safeSourceIn = Number.isFinite(finalPosition.sourceIn)
        ? Math.max(0, finalPosition.sourceIn)
        : 0;
      const safeSourceOut = Number.isFinite(finalPosition.sourceOut)
        ? Math.max(0, finalPosition.sourceOut)
        : 0;

      if (data.type === 'move' && onClipMove) {
        const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
        if (sourceTrackIndex < 0) {
          setDragPreview(null);
          return;
        }

        const sourceTrack = sequence.tracks[sourceTrackIndex];
        const addToast = useToastStore.getState().addToast;

        // Determine if we're moving to a different track
        let newTrackId: string | undefined;

        if (targetTrackIndex !== undefined && targetTrackIndex !== sourceTrackIndex) {
          // Bounds check targetTrackIndex
          const safeTargetIndex = Math.max(0, Math.min(targetTrackIndex, sequence.tracks.length - 1));
          const targetTrack = sequence.tracks[safeTargetIndex];

          // Only set newTrackId if target track exists and is compatible
          if (targetTrack && isTrackKindCompatible(sourceTrack.kind, targetTrack.kind)) {
            newTrackId = targetTrack.id;
          } else if (targetTrack) {
            // Show feedback when cross-track drop is rejected due to incompatibility
            addToast({
              message: `Cannot move ${sourceTrack.kind} clip to ${targetTrack.kind} track`,
              variant: 'warning',
              duration: 3000,
            });
          }
        }

        const moveData: ClipMoveData = {
          sequenceId: sequence.id,
          trackId,
          clipId: data.clipId,
          newTimelineIn: safeTimelineIn,
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
            newSourceIn: safeSourceIn,
            newTimelineIn: safeTimelineIn,
          });
        } else {
          onClipTrim({
            sequenceId: sequence.id,
            trackId,
            clipId: data.clipId,
            newSourceOut: safeSourceOut,
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
   * Batches moves by collecting all move data first to avoid race conditions.
   */
  const handleMultiClipDragEnd = useCallback(
    (
      trackId: string,
      dragData: ClipDragData,
      finalPosition: DragPreviewPosition,
      selectedClipIds: string[],
      targetTrackIndex?: number
    ) => {
      if (!sequence || !onClipMove || sequence.tracks.length === 0) {
        setDragPreview(null);
        return;
      }

      // Validate inputs
      if (!selectedClipIds || selectedClipIds.length === 0) {
        setDragPreview(null);
        return;
      }

      // Validate finalPosition
      const safeTimelineIn = Number.isFinite(finalPosition.timelineIn) ? finalPosition.timelineIn : 0;
      const safeOriginalTimelineIn = Number.isFinite(dragData.originalTimelineIn) ? dragData.originalTimelineIn : 0;

      // Calculate the offset from the primary clip's original position
      const offset = safeTimelineIn - safeOriginalTimelineIn;

      // Determine target track for cross-track moves
      const sourceTrackIndex = sequence.tracks.findIndex((t) => t.id === trackId);
      if (sourceTrackIndex < 0) {
        setDragPreview(null);
        return;
      }

      const sourceTrack = sequence.tracks[sourceTrackIndex];
      const addToast = useToastStore.getState().addToast;
      let newTrackId: string | undefined;

      if (targetTrackIndex !== undefined && targetTrackIndex !== sourceTrackIndex) {
        // Bounds check targetTrackIndex
        const safeTargetIndex = Math.max(0, Math.min(targetTrackIndex, sequence.tracks.length - 1));
        const targetTrack = sequence.tracks[safeTargetIndex];

        if (targetTrack && isTrackKindCompatible(sourceTrack.kind, targetTrack.kind)) {
          newTrackId = targetTrack.id;
        } else if (targetTrack) {
          // Show feedback when cross-track drop is rejected due to incompatibility
          addToast({
            message: `Cannot move ${sourceTrack.kind} clips to ${targetTrack.kind} track`,
            variant: 'warning',
            duration: 3000,
          });
        }
      }

      // Collect all move data first to avoid race conditions
      const moveOperations: ClipMoveData[] = [];

      for (const clipId of selectedClipIds) {
        const clipInfo = findClip(clipId);
        if (!clipInfo) continue;

        // Calculate new position based on offset
        const currentTimelineIn = clipInfo.clip.place.timelineInSec;
        const newTimelineIn = Math.min(MAX_TIMELINE_POSITION, Math.max(0, currentTimelineIn + offset));

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

        moveOperations.push(moveData);
      }

      // Execute all moves (caller should handle batching if needed)
      for (const moveData of moveOperations) {
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
