/**
 * useSlipEdit Hook
 *
 * Implements slip editing behavior.
 * Slip edit adjusts the source in/out points of a clip without
 * changing its position or duration on the timeline.
 *
 * @module hooks/useSlipEdit
 */

import { useCallback, useRef, useState } from 'react';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Clip } from '@/types';
import { MIN_CLIP_DURATION_SEC } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

export interface SlipEditState {
  /** Whether slip edit is currently active */
  isSlipping: boolean;
  /** Clip being slipped */
  clipId: string | null;
  /** Original source in point before slip */
  originalSourceIn: number;
  /** Original source out point before slip */
  originalSourceOut: number;
  /** Current slip offset in seconds */
  slipOffset: number;
}

export interface SlipEditResult {
  /** New source in point */
  sourceIn: number;
  /** New source out point */
  sourceOut: number;
  /** Whether the slip was constrained */
  constrained: boolean;
}

export interface UseSlipEditOptions {
  /** Callback when slip starts */
  onSlipStart?: (clipId: string) => void;
  /** Callback during slip with new source range */
  onSlipMove?: (clipId: string, sourceIn: number, sourceOut: number) => void;
  /** Callback when slip ends */
  onSlipEnd?: (clipId: string, sourceIn: number, sourceOut: number) => void;
  /** Callback when slip is cancelled */
  onSlipCancel?: (clipId: string) => void;
}

export interface UseSlipEditReturn {
  /** Whether slip tool is active */
  isSlipToolActive: boolean;
  /** Current slip edit state */
  slipState: SlipEditState;
  /** Start slip edit on a clip */
  startSlip: (clip: Clip, sourceDuration: number) => void;
  /** Update slip during drag */
  updateSlip: (deltaSeconds: number) => SlipEditResult | null;
  /** End slip edit and apply changes */
  endSlip: () => SlipEditResult | null;
  /** Cancel slip edit and revert */
  cancelSlip: () => void;
  /** Calculate slip result for a given offset */
  calculateSlip: (
    originalSourceIn: number,
    originalSourceOut: number,
    sourceDuration: number,
    offset: number
  ) => SlipEditResult;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for slip editing operations.
 *
 * Slip editing allows you to change which portion of the source media
 * is shown in a clip without affecting:
 * - The clip's position on the timeline
 * - The clip's duration
 * - Adjacent clips
 *
 * @example
 * ```tsx
 * const { startSlip, updateSlip, endSlip } = useSlipEdit({
 *   onSlipEnd: (clipId, sourceIn, sourceOut) => {
 *     updateClipSourceRange(clipId, sourceIn, sourceOut);
 *   },
 * });
 *
 * // On mouse down on clip with slip tool
 * startSlip(clip, assetDuration);
 *
 * // On mouse move
 * updateSlip(deltaX / zoom);
 *
 * // On mouse up
 * endSlip();
 * ```
 */
export function useSlipEdit(options: UseSlipEditOptions = {}): UseSlipEditReturn {
  const { onSlipStart, onSlipMove, onSlipEnd, onSlipCancel } = options;

  const { activeTool } = useEditorToolStore();

  const [slipState, setSlipState] = useState<SlipEditState>({
    isSlipping: false,
    clipId: null,
    originalSourceIn: 0,
    originalSourceOut: 0,
    slipOffset: 0,
  });

  const sourceDurationRef = useRef<number>(0);

  const isSlipToolActive = activeTool === 'slip';

  /**
   * Calculate slip result for a given offset
   */
  const calculateSlip = useCallback(
    (
      originalSourceIn: number,
      originalSourceOut: number,
      sourceDuration: number,
      offset: number
    ): SlipEditResult => {
      const clipDuration = originalSourceOut - originalSourceIn;

      // Calculate new source range
      let newSourceIn = originalSourceIn + offset;
      let newSourceOut = originalSourceOut + offset;
      let constrained = false;

      // Constrain to source bounds
      if (newSourceIn < 0) {
        newSourceIn = 0;
        newSourceOut = clipDuration;
        constrained = true;
      }

      if (newSourceOut > sourceDuration) {
        newSourceOut = sourceDuration;
        newSourceIn = Math.max(0, sourceDuration - clipDuration);
        constrained = true;
      }

      // Ensure minimum clip duration
      if (newSourceOut - newSourceIn < MIN_CLIP_DURATION_SEC) {
        constrained = true;
      }

      return {
        sourceIn: newSourceIn,
        sourceOut: newSourceOut,
        constrained,
      };
    },
    []
  );

  /**
   * Start slip edit on a clip
   */
  const startSlip = useCallback(
    (clip: Clip, sourceDuration: number) => {
      sourceDurationRef.current = sourceDuration;

      setSlipState({
        isSlipping: true,
        clipId: clip.id,
        originalSourceIn: clip.range.sourceInSec,
        originalSourceOut: clip.range.sourceOutSec,
        slipOffset: 0,
      });

      onSlipStart?.(clip.id);
    },
    [onSlipStart]
  );

  /**
   * Update slip during drag
   */
  const updateSlip = useCallback(
    (deltaSeconds: number): SlipEditResult | null => {
      if (!slipState.isSlipping || !slipState.clipId) {
        return null;
      }

      const newOffset = slipState.slipOffset + deltaSeconds;

      const result = calculateSlip(
        slipState.originalSourceIn,
        slipState.originalSourceOut,
        sourceDurationRef.current,
        newOffset
      );

      // Update state with new offset (constrained)
      const actualOffset = result.sourceIn - slipState.originalSourceIn;
      setSlipState(prev => ({
        ...prev,
        slipOffset: actualOffset,
      }));

      onSlipMove?.(slipState.clipId, result.sourceIn, result.sourceOut);

      return result;
    },
    [slipState, calculateSlip, onSlipMove]
  );

  /**
   * End slip edit and apply changes
   */
  const endSlip = useCallback((): SlipEditResult | null => {
    if (!slipState.isSlipping || !slipState.clipId) {
      return null;
    }

    const result = calculateSlip(
      slipState.originalSourceIn,
      slipState.originalSourceOut,
      sourceDurationRef.current,
      slipState.slipOffset
    );

    onSlipEnd?.(slipState.clipId, result.sourceIn, result.sourceOut);

    setSlipState({
      isSlipping: false,
      clipId: null,
      originalSourceIn: 0,
      originalSourceOut: 0,
      slipOffset: 0,
    });

    return result;
  }, [slipState, calculateSlip, onSlipEnd]);

  /**
   * Cancel slip edit and revert
   */
  const cancelSlip = useCallback(() => {
    if (!slipState.isSlipping || !slipState.clipId) {
      return;
    }

    onSlipCancel?.(slipState.clipId);

    setSlipState({
      isSlipping: false,
      clipId: null,
      originalSourceIn: 0,
      originalSourceOut: 0,
      slipOffset: 0,
    });
  }, [slipState, onSlipCancel]);

  return {
    isSlipToolActive,
    slipState,
    startSlip,
    updateSlip,
    endSlip,
    cancelSlip,
    calculateSlip,
  };
}

export default useSlipEdit;
