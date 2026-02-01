/**
 * useSlideEdit Hook
 *
 * Implements slide editing behavior.
 * Slide edit moves a clip while adjusting the adjacent clips'
 * in/out points to maintain the overall sequence duration.
 *
 * @module hooks/useSlideEdit
 */

import { useCallback, useState } from 'react';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Clip, Track } from '@/types';
import { MIN_CLIP_DURATION_SEC } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

export interface AdjacentClip {
  clip: Clip;
  side: 'before' | 'after';
  sourceDuration: number;
}

export interface SlideEditState {
  /** Whether slide edit is currently active */
  isSliding: boolean;
  /** Clip being slid */
  clipId: string | null;
  /** Original timeline position */
  originalTimelineIn: number;
  /** Previous adjacent clip (if any) */
  previousClip: AdjacentClip | null;
  /** Next adjacent clip (if any) */
  nextClip: AdjacentClip | null;
  /** Current slide offset in seconds */
  slideOffset: number;
}

export interface SlideEditResult {
  /** New timeline position for the sliding clip */
  newTimelineIn: number;
  /** Changes to apply to previous clip (if any) */
  previousClipChange: {
    clipId: string;
    sourceOut: number;
  } | null;
  /** Changes to apply to next clip (if any) */
  nextClipChange: {
    clipId: string;
    sourceIn: number;
  } | null;
  /** Whether the slide was constrained */
  constrained: boolean;
  /** Constraint reason if constrained */
  constraintReason?: 'no-previous' | 'no-next' | 'min-duration' | 'source-limit';
}

export interface UseSlideEditOptions {
  /** Callback when slide starts */
  onSlideStart?: (clipId: string) => void;
  /** Callback during slide with changes */
  onSlideMove?: (result: SlideEditResult) => void;
  /** Callback when slide ends */
  onSlideEnd?: (result: SlideEditResult) => void;
  /** Callback when slide is cancelled */
  onSlideCancel?: (clipId: string) => void;
}

export interface UseSlideEditReturn {
  /** Whether slide tool is active */
  isSlideToolActive: boolean;
  /** Current slide edit state */
  slideState: SlideEditState;
  /** Start slide edit on a clip */
  startSlide: (
    clip: Clip,
    track: Track,
    getPreviousClip: () => AdjacentClip | null,
    getNextClip: () => AdjacentClip | null
  ) => void;
  /** Update slide during drag */
  updateSlide: (deltaSeconds: number) => SlideEditResult | null;
  /** End slide edit and apply changes */
  endSlide: () => SlideEditResult | null;
  /** Cancel slide edit and revert */
  cancelSlide: () => void;
  /** Calculate slide constraints */
  calculateSlideConstraints: (
    slideOffset: number,
    previousClip: AdjacentClip | null,
    nextClip: AdjacentClip | null
  ) => { minOffset: number; maxOffset: number };
}

// =============================================================================
// Helper Functions
// =============================================================================

function getClipDuration(clip: Clip): number {
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for slide editing operations.
 *
 * Slide editing moves a clip left or right while:
 * - Extending/shortening the previous clip's out point
 * - Extending/shortening the next clip's in point
 * - Maintaining the overall sequence duration
 *
 * Unlike a regular move, slide edit doesn't leave gaps or overlap clips.
 *
 * @example
 * ```tsx
 * const { startSlide, updateSlide, endSlide } = useSlideEdit({
 *   onSlideEnd: (result) => {
 *     applySlideChanges(result);
 *   },
 * });
 *
 * // On mouse down on clip with slide tool
 * startSlide(clip, track, getPrevClip, getNextClip);
 *
 * // On mouse move
 * updateSlide(deltaX / zoom);
 *
 * // On mouse up
 * endSlide();
 * ```
 */
export function useSlideEdit(options: UseSlideEditOptions = {}): UseSlideEditReturn {
  const { onSlideStart, onSlideMove, onSlideEnd, onSlideCancel } = options;

  const { activeTool } = useEditorToolStore();

  const [slideState, setSlideState] = useState<SlideEditState>({
    isSliding: false,
    clipId: null,
    originalTimelineIn: 0,
    previousClip: null,
    nextClip: null,
    slideOffset: 0,
  });

  const isSlideToolActive = activeTool === 'slide';

  /**
   * Calculate the minimum and maximum slide offset
   */
  const calculateSlideConstraints = useCallback(
    (
      _slideOffset: number,
      previousClip: AdjacentClip | null,
      nextClip: AdjacentClip | null
    ): { minOffset: number; maxOffset: number } => {
      let minOffset = -Infinity;
      let maxOffset = Infinity;

      // Constraint from previous clip
      if (previousClip) {
        const prevDuration = getClipDuration(previousClip.clip);
        // Can't slide left more than would reduce previous clip below min duration
        minOffset = Math.max(minOffset, -(prevDuration - MIN_CLIP_DURATION_SEC));

        // Source headroom constraint (for future enhancement)
        // const prevSourceRemaining = previousClip.sourceDuration - previousClip.clip.range.sourceOutSec;
      }

      // Constraint from next clip
      if (nextClip) {
        const nextDuration = getClipDuration(nextClip.clip);
        // Can't slide right more than would reduce next clip below min duration
        maxOffset = Math.min(maxOffset, nextDuration - MIN_CLIP_DURATION_SEC);

        // Source headroom constraint (for future enhancement)
        // const nextSourceIn = nextClip.clip.range.sourceInSec;
      }

      // If no adjacent clips, constrain heavily
      if (!previousClip) {
        minOffset = 0;
      }
      if (!nextClip) {
        maxOffset = 0;
      }

      return { minOffset, maxOffset };
    },
    []
  );

  /**
   * Start slide edit on a clip
   */
  const startSlide = useCallback(
    (
      clip: Clip,
      _track: Track,
      getPreviousClip: () => AdjacentClip | null,
      getNextClip: () => AdjacentClip | null
    ) => {
      const previousClip = getPreviousClip();
      const nextClip = getNextClip();

      setSlideState({
        isSliding: true,
        clipId: clip.id,
        originalTimelineIn: clip.place.timelineInSec,
        previousClip,
        nextClip,
        slideOffset: 0,
      });

      onSlideStart?.(clip.id);
    },
    [onSlideStart]
  );

  /**
   * Calculate slide result for current state
   */
  const calculateSlideResult = useCallback(
    (
      originalTimelineIn: number,
      offset: number,
      previousClip: AdjacentClip | null,
      nextClip: AdjacentClip | null
    ): SlideEditResult => {
      const { minOffset, maxOffset } = calculateSlideConstraints(offset, previousClip, nextClip);

      // Constrain offset
      const constrainedOffset = Math.max(minOffset, Math.min(maxOffset, offset));
      const constrained = constrainedOffset !== offset;

      let constraintReason: SlideEditResult['constraintReason'];
      if (constrained) {
        if (!previousClip && offset < 0) constraintReason = 'no-previous';
        else if (!nextClip && offset > 0) constraintReason = 'no-next';
        else constraintReason = 'min-duration';
      }

      const newTimelineIn = originalTimelineIn + constrainedOffset;

      // Calculate changes to adjacent clips
      let previousClipChange: SlideEditResult['previousClipChange'] = null;
      let nextClipChange: SlideEditResult['nextClipChange'] = null;

      if (previousClip && constrainedOffset !== 0) {
        // Extend or shorten previous clip's out point
        previousClipChange = {
          clipId: previousClip.clip.id,
          sourceOut: previousClip.clip.range.sourceOutSec + constrainedOffset,
        };
      }

      if (nextClip && constrainedOffset !== 0) {
        // Extend or shorten next clip's in point
        nextClipChange = {
          clipId: nextClip.clip.id,
          sourceIn: nextClip.clip.range.sourceInSec + constrainedOffset,
        };
      }

      return {
        newTimelineIn,
        previousClipChange,
        nextClipChange,
        constrained,
        constraintReason,
      };
    },
    [calculateSlideConstraints]
  );

  /**
   * Update slide during drag
   */
  const updateSlide = useCallback(
    (deltaSeconds: number): SlideEditResult | null => {
      if (!slideState.isSliding || !slideState.clipId) {
        return null;
      }

      const newOffset = slideState.slideOffset + deltaSeconds;

      const result = calculateSlideResult(
        slideState.originalTimelineIn,
        newOffset,
        slideState.previousClip,
        slideState.nextClip
      );

      // Update state with the actual (potentially constrained) offset
      const actualOffset = result.newTimelineIn - slideState.originalTimelineIn;
      setSlideState(prev => ({
        ...prev,
        slideOffset: actualOffset,
      }));

      onSlideMove?.(result);

      return result;
    },
    [slideState, calculateSlideResult, onSlideMove]
  );

  /**
   * End slide edit and apply changes
   */
  const endSlide = useCallback((): SlideEditResult | null => {
    if (!slideState.isSliding || !slideState.clipId) {
      return null;
    }

    const result = calculateSlideResult(
      slideState.originalTimelineIn,
      slideState.slideOffset,
      slideState.previousClip,
      slideState.nextClip
    );

    onSlideEnd?.(result);

    setSlideState({
      isSliding: false,
      clipId: null,
      originalTimelineIn: 0,
      previousClip: null,
      nextClip: null,
      slideOffset: 0,
    });

    return result;
  }, [slideState, calculateSlideResult, onSlideEnd]);

  /**
   * Cancel slide edit and revert
   */
  const cancelSlide = useCallback(() => {
    if (!slideState.isSliding || !slideState.clipId) {
      return;
    }

    onSlideCancel?.(slideState.clipId);

    setSlideState({
      isSliding: false,
      clipId: null,
      originalTimelineIn: 0,
      previousClip: null,
      nextClip: null,
      slideOffset: 0,
    });
  }, [slideState, onSlideCancel]);

  return {
    isSlideToolActive,
    slideState,
    startSlide,
    updateSlide,
    endSlide,
    cancelSlide,
    calculateSlideConstraints,
  };
}

export default useSlideEdit;
