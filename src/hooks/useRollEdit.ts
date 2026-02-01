/**
 * useRollEdit Hook
 *
 * Implements roll editing behavior.
 * Roll edit adjusts the edit point between two adjacent clips,
 * changing one clip's out point and the other's in point simultaneously.
 *
 * @module hooks/useRollEdit
 */

import { useCallback, useRef, useState } from 'react';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Clip } from '@/types';
import { MIN_CLIP_DURATION_SEC } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

export interface EditPoint {
  /** Clip ending at this edit point */
  outgoingClip: Clip;
  /** Clip starting at this edit point */
  incomingClip: Clip;
  /** Track ID where these clips are located */
  trackId: string;
  /** Time position of the edit point */
  editTime: number;
  /** Available source duration for outgoing clip */
  outgoingSourceDuration: number;
  /** Available source duration for incoming clip */
  incomingSourceDuration: number;
}

export interface RollEditState {
  /** Whether roll edit is currently active */
  isRolling: boolean;
  /** The edit point being rolled */
  editPoint: EditPoint | null;
  /** Original edit time */
  originalEditTime: number;
  /** Current roll offset in seconds */
  rollOffset: number;
}

export interface RollEditResult {
  /** New edit time */
  newEditTime: number;
  /** Changes to outgoing clip */
  outgoingClipChange: {
    clipId: string;
    sourceOut: number;
    timelineOut: number;
  };
  /** Changes to incoming clip */
  incomingClipChange: {
    clipId: string;
    sourceIn: number;
    timelineIn: number;
  };
  /** Whether the roll was constrained */
  constrained: boolean;
  /** Constraint reason if constrained */
  constraintReason?: 'outgoing-min' | 'incoming-min' | 'outgoing-source' | 'incoming-source';
}

export interface UseRollEditOptions {
  /** Callback when roll starts */
  onRollStart?: (editPoint: EditPoint) => void;
  /** Callback during roll with changes */
  onRollMove?: (result: RollEditResult) => void;
  /** Callback when roll ends */
  onRollEnd?: (result: RollEditResult) => void;
  /** Callback when roll is cancelled */
  onRollCancel?: (editPoint: EditPoint) => void;
}

export interface UseRollEditReturn {
  /** Whether roll tool is active */
  isRollToolActive: boolean;
  /** Current roll edit state */
  rollState: RollEditState;
  /** Start roll edit at an edit point */
  startRoll: (editPoint: EditPoint) => void;
  /** Update roll during drag */
  updateRoll: (deltaSeconds: number) => RollEditResult | null;
  /** End roll edit and apply changes */
  endRoll: () => RollEditResult | null;
  /** Cancel roll edit and revert */
  cancelRoll: () => void;
  /** Find edit point near a time position */
  findEditPoint: (
    clips: Clip[],
    trackId: string,
    time: number,
    threshold: number,
    getSourceDuration: (clip: Clip) => number
  ) => EditPoint | null;
  /** Calculate roll constraints */
  calculateRollConstraints: (editPoint: EditPoint) => { minOffset: number; maxOffset: number };
}

// =============================================================================
// Helper Functions
// =============================================================================

function getClipDuration(clip: Clip): number {
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
}

function getClipEndTime(clip: Clip): number {
  return clip.place.timelineInSec + getClipDuration(clip);
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for roll editing operations.
 *
 * Roll editing adjusts the cut point between two adjacent clips:
 * - Moving the edit point right extends the outgoing clip and shortens the incoming clip
 * - Moving left shortens the outgoing clip and extends the incoming clip
 * - The overall sequence duration remains unchanged
 *
 * @example
 * ```tsx
 * const { startRoll, updateRoll, endRoll, findEditPoint } = useRollEdit({
 *   onRollEnd: (result) => {
 *     applyRollChanges(result);
 *   },
 * });
 *
 * // Find edit point near mouse position
 * const editPoint = findEditPoint(clips, trackId, timeAtMouse, threshold, getSourceDuration);
 *
 * if (editPoint) {
 *   startRoll(editPoint);
 *   // On mouse move
 *   updateRoll(deltaX / zoom);
 *   // On mouse up
 *   endRoll();
 * }
 * ```
 */
export function useRollEdit(options: UseRollEditOptions = {}): UseRollEditReturn {
  const { onRollStart, onRollMove, onRollEnd, onRollCancel } = options;

  const { activeTool } = useEditorToolStore();

  const [rollState, setRollState] = useState<RollEditState>({
    isRolling: false,
    editPoint: null,
    originalEditTime: 0,
    rollOffset: 0,
  });

  const editPointRef = useRef<EditPoint | null>(null);

  const isRollToolActive = activeTool === 'roll';

  /**
   * Find an edit point near a given time
   */
  const findEditPoint = useCallback(
    (
      clips: Clip[],
      trackId: string,
      time: number,
      threshold: number,
      getSourceDuration: (clip: Clip) => number
    ): EditPoint | null => {
      // Sort clips by timeline position
      const sortedClips = [...clips].sort(
        (a, b) => a.place.timelineInSec - b.place.timelineInSec
      );

      // Find adjacent pairs where an edit point exists
      for (let i = 0; i < sortedClips.length - 1; i++) {
        const outgoing = sortedClips[i];
        const incoming = sortedClips[i + 1];

        const outgoingEnd = getClipEndTime(outgoing);
        const incomingStart = incoming.place.timelineInSec;

        // Check if clips are truly adjacent (no gap)
        const gap = Math.abs(incomingStart - outgoingEnd);
        if (gap > 0.01) continue; // Not adjacent

        // Check if time is near this edit point
        const editTime = outgoingEnd;
        if (Math.abs(time - editTime) <= threshold) {
          return {
            outgoingClip: outgoing,
            incomingClip: incoming,
            trackId,
            editTime,
            outgoingSourceDuration: getSourceDuration(outgoing),
            incomingSourceDuration: getSourceDuration(incoming),
          };
        }
      }

      return null;
    },
    []
  );

  /**
   * Calculate the minimum and maximum roll offset
   */
  const calculateRollConstraints = useCallback(
    (editPoint: EditPoint): { minOffset: number; maxOffset: number } => {
      const { outgoingClip, incomingClip, outgoingSourceDuration } = editPoint;

      // Minimum offset (rolling left, shortening outgoing)
      const outgoingDuration = getClipDuration(outgoingClip);
      const minByOutgoingDuration = -(outgoingDuration - MIN_CLIP_DURATION_SEC);

      // Maximum offset (rolling right, extending outgoing)
      const incomingDuration = getClipDuration(incomingClip);
      const maxByIncomingDuration = incomingDuration - MIN_CLIP_DURATION_SEC;

      // Can't roll right past source availability of outgoing
      const outgoingSourceRemaining = outgoingSourceDuration - outgoingClip.range.sourceOutSec;
      const maxByOutgoingSource = outgoingSourceRemaining / outgoingClip.speed;

      // Can't roll left past source availability of incoming
      const incomingSourceRemaining = incomingClip.range.sourceInSec;
      const minByIncomingSource = -(incomingSourceRemaining / incomingClip.speed);

      const minOffset = Math.max(minByOutgoingDuration, minByIncomingSource);
      const maxOffset = Math.min(maxByIncomingDuration, maxByOutgoingSource);

      return { minOffset, maxOffset };
    },
    []
  );

  /**
   * Start roll edit at an edit point
   */
  const startRoll = useCallback(
    (editPoint: EditPoint) => {
      editPointRef.current = editPoint;

      setRollState({
        isRolling: true,
        editPoint,
        originalEditTime: editPoint.editTime,
        rollOffset: 0,
      });

      onRollStart?.(editPoint);
    },
    [onRollStart]
  );

  /**
   * Calculate roll result for current state
   */
  const calculateRollResult = useCallback(
    (editPoint: EditPoint, offset: number): RollEditResult => {
      const { minOffset, maxOffset } = calculateRollConstraints(editPoint);

      // Constrain offset
      const constrainedOffset = Math.max(minOffset, Math.min(maxOffset, offset));
      const constrained = constrainedOffset !== offset;

      let constraintReason: RollEditResult['constraintReason'];
      if (constrained) {
        if (offset < minOffset) {
          constraintReason = offset < -(getClipDuration(editPoint.outgoingClip) - MIN_CLIP_DURATION_SEC)
            ? 'outgoing-min'
            : 'incoming-source';
        } else {
          constraintReason = offset > (getClipDuration(editPoint.incomingClip) - MIN_CLIP_DURATION_SEC)
            ? 'incoming-min'
            : 'outgoing-source';
        }
      }

      const newEditTime = editPoint.editTime + constrainedOffset;

      // Calculate changes to clips
      const outgoingClipChange = {
        clipId: editPoint.outgoingClip.id,
        sourceOut: editPoint.outgoingClip.range.sourceOutSec + (constrainedOffset * editPoint.outgoingClip.speed),
        timelineOut: newEditTime,
      };

      const incomingClipChange = {
        clipId: editPoint.incomingClip.id,
        sourceIn: editPoint.incomingClip.range.sourceInSec + (constrainedOffset * editPoint.incomingClip.speed),
        timelineIn: newEditTime,
      };

      return {
        newEditTime,
        outgoingClipChange,
        incomingClipChange,
        constrained,
        constraintReason,
      };
    },
    [calculateRollConstraints]
  );

  /**
   * Update roll during drag
   */
  const updateRoll = useCallback(
    (deltaSeconds: number): RollEditResult | null => {
      if (!rollState.isRolling || !rollState.editPoint) {
        return null;
      }

      const newOffset = rollState.rollOffset + deltaSeconds;
      const result = calculateRollResult(rollState.editPoint, newOffset);

      // Update state with actual offset
      const actualOffset = result.newEditTime - rollState.originalEditTime;
      setRollState(prev => ({
        ...prev,
        rollOffset: actualOffset,
      }));

      onRollMove?.(result);

      return result;
    },
    [rollState, calculateRollResult, onRollMove]
  );

  /**
   * End roll edit and apply changes
   */
  const endRoll = useCallback((): RollEditResult | null => {
    if (!rollState.isRolling || !rollState.editPoint) {
      return null;
    }

    const result = calculateRollResult(rollState.editPoint, rollState.rollOffset);

    onRollEnd?.(result);

    setRollState({
      isRolling: false,
      editPoint: null,
      originalEditTime: 0,
      rollOffset: 0,
    });

    return result;
  }, [rollState, calculateRollResult, onRollEnd]);

  /**
   * Cancel roll edit and revert
   */
  const cancelRoll = useCallback(() => {
    if (!rollState.isRolling || !rollState.editPoint) {
      return;
    }

    onRollCancel?.(rollState.editPoint);

    setRollState({
      isRolling: false,
      editPoint: null,
      originalEditTime: 0,
      rollOffset: 0,
    });
  }, [rollState, onRollCancel]);

  return {
    isRollToolActive,
    rollState,
    startRoll,
    updateRoll,
    endRoll,
    cancelRoll,
    findEditPoint,
    calculateRollConstraints,
  };
}

export default useRollEdit;
