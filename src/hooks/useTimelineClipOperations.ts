/**
 * useTimelineClipOperations Hook
 *
 * Manages clip utility functions and drag operation state for the Timeline component.
 * Extracted from Timeline.tsx to improve maintainability and testability.
 */

import { useState, useCallback } from 'react';
import type { Sequence, Clip } from '@/types';
import type { ClipMoveData, ClipTrimData } from '@/components/timeline/types';
import type { ClipDragData, DragPreviewPosition } from '@/components/timeline/Clip';
import type { DragPreviewState } from '@/components/timeline/DragPreviewLayer';

// =============================================================================
// Types
// =============================================================================

export interface UseTimelineClipOperationsProps {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Current zoom level (pixels per second) */
  zoom: number;
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
  handleClipDrag: (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition) => void;
  /** Handle clip drag end (commit operation) */
  handleClipDragEnd: (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useTimelineClipOperations({
  sequence,
  zoom,
  onClipMove,
  onClipTrim,
  selectClip,
}: UseTimelineClipOperationsProps): UseTimelineClipOperationsResult {
  // ===========================================================================
  // State
  // ===========================================================================
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);

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
   */
  const handleClipDrag = useCallback(
    (trackId: string, data: ClipDragData, previewPosition: DragPreviewPosition) => {
      if (!sequence) return;

      const trackIndex = sequence.tracks.findIndex((t) => t.id === trackId);

      setDragPreview({
        clipId: data.clipId,
        left: previewPosition.timelineIn * zoom,
        width: previewPosition.duration * zoom,
        trackIndex,
      });
    },
    [sequence, zoom]
  );

  /**
   * Handle end of clip drag operation.
   * Commits the move or trim operation and clears the preview.
   */
  const handleClipDragEnd = useCallback(
    (trackId: string, data: ClipDragData, finalPosition: DragPreviewPosition) => {
      if (!sequence) {
        setDragPreview(null);
        return;
      }

      if (data.type === 'move' && onClipMove) {
        onClipMove({
          sequenceId: sequence.id,
          trackId,
          clipId: data.clipId,
          newTimelineIn: Math.max(0, finalPosition.timelineIn),
        });
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
  };
}
