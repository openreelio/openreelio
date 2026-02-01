/**
 * Advanced Edit Mode Hooks Tests
 *
 * Tests for slip, slide, and roll editing operations.
 * Follows TDD methodology.
 *
 * @module hooks/useAdvancedEditModes.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSlipEdit } from './useSlipEdit';
import { useSlideEdit, type AdjacentClip } from './useSlideEdit';
import { useRollEdit } from './useRollEdit';
import { useEditorToolStore } from '@/stores/editorToolStore';
import type { Clip, Track } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    label: 'Test Clip',
    place: {
      timelineInSec: 0,
      durationSec: 5,
    },
    range: {
      sourceInSec: 0,
      sourceOutSec: 5,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      isMuted: false,
      fadeIn: 0,
      fadeOut: 0,
    },
    ...overrides,
  } as Clip;
}

function createTestTrack(clips: Clip[] = [], id = 'track-1'): Track {
  return {
    id,
    kind: 'video',
    name: 'Track 1',
    clips,
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
  } as Track;
}

// =============================================================================
// useSlipEdit Tests
// =============================================================================

describe('useSlipEdit', () => {
  beforeEach(() => {
    useEditorToolStore.getState().reset();
  });

  describe('initial state', () => {
    it('should not be slipping initially', () => {
      const { result } = renderHook(() => useSlipEdit());

      expect(result.current.slipState.isSlipping).toBe(false);
      expect(result.current.slipState.clipId).toBeNull();
    });

    it('should detect slip tool active state', () => {
      const { result } = renderHook(() => useSlipEdit());

      expect(result.current.isSlipToolActive).toBe(false);

      act(() => {
        useEditorToolStore.getState().setActiveTool('slip');
      });

      expect(result.current.isSlipToolActive).toBe(true);
    });
  });

  describe('startSlip', () => {
    it('should initialize slip state', () => {
      const clip = createTestClip({
        range: { sourceInSec: 2, sourceOutSec: 7 },
      });
      const onSlipStart = vi.fn();

      const { result } = renderHook(() => useSlipEdit({ onSlipStart }));

      act(() => {
        result.current.startSlip(clip, 10); // 10s source duration
      });

      expect(result.current.slipState.isSlipping).toBe(true);
      expect(result.current.slipState.clipId).toBe('clip-1');
      expect(result.current.slipState.originalSourceIn).toBe(2);
      expect(result.current.slipState.originalSourceOut).toBe(7);
      expect(onSlipStart).toHaveBeenCalledWith('clip-1');
    });
  });

  describe('calculateSlip', () => {
    it('should calculate new source range for positive offset', () => {
      const { result } = renderHook(() => useSlipEdit());

      const slipResult = result.current.calculateSlip(2, 7, 10, 1);

      expect(slipResult.sourceIn).toBe(3);
      expect(slipResult.sourceOut).toBe(8);
      expect(slipResult.constrained).toBe(false);
    });

    it('should calculate new source range for negative offset', () => {
      const { result } = renderHook(() => useSlipEdit());

      const slipResult = result.current.calculateSlip(2, 7, 10, -1);

      expect(slipResult.sourceIn).toBe(1);
      expect(slipResult.sourceOut).toBe(6);
      expect(slipResult.constrained).toBe(false);
    });

    it('should constrain to source start', () => {
      const { result } = renderHook(() => useSlipEdit());

      // Try to slip left past source start
      const slipResult = result.current.calculateSlip(1, 6, 10, -5);

      expect(slipResult.sourceIn).toBe(0);
      expect(slipResult.sourceOut).toBe(5);
      expect(slipResult.constrained).toBe(true);
    });

    it('should constrain to source end', () => {
      const { result } = renderHook(() => useSlipEdit());

      // Try to slip right past source end
      const slipResult = result.current.calculateSlip(2, 7, 10, 5);

      expect(slipResult.sourceOut).toBe(10);
      expect(slipResult.sourceIn).toBe(5);
      expect(slipResult.constrained).toBe(true);
    });
  });

  describe('updateSlip', () => {
    it('should update slip offset during drag', () => {
      const clip = createTestClip({
        range: { sourceInSec: 2, sourceOutSec: 7 },
      });
      const onSlipMove = vi.fn();

      const { result } = renderHook(() => useSlipEdit({ onSlipMove }));

      act(() => {
        result.current.startSlip(clip, 10);
      });

      act(() => {
        result.current.updateSlip(1);
      });

      expect(result.current.slipState.slipOffset).toBe(1);
      expect(onSlipMove).toHaveBeenCalled();
    });

    it('should return null when not slipping', () => {
      const { result } = renderHook(() => useSlipEdit());

      const updateResult = result.current.updateSlip(1);

      expect(updateResult).toBeNull();
    });
  });

  describe('endSlip', () => {
    it('should finalize slip and reset state', () => {
      const clip = createTestClip({
        range: { sourceInSec: 2, sourceOutSec: 7 },
      });
      const onSlipEnd = vi.fn();

      const { result } = renderHook(() => useSlipEdit({ onSlipEnd }));

      act(() => {
        result.current.startSlip(clip, 10);
      });

      act(() => {
        result.current.updateSlip(1);
      });

      let endResult: ReturnType<typeof result.current.endSlip>;
      act(() => {
        endResult = result.current.endSlip();
      });

      expect(endResult!.sourceIn).toBe(3);
      expect(endResult!.sourceOut).toBe(8);
      expect(result.current.slipState.isSlipping).toBe(false);
      expect(onSlipEnd).toHaveBeenCalledWith('clip-1', 3, 8);
    });
  });

  describe('cancelSlip', () => {
    it('should cancel slip and reset state', () => {
      const clip = createTestClip();
      const onSlipCancel = vi.fn();

      const { result } = renderHook(() => useSlipEdit({ onSlipCancel }));

      act(() => {
        result.current.startSlip(clip, 10);
      });

      act(() => {
        result.current.cancelSlip();
      });

      expect(result.current.slipState.isSlipping).toBe(false);
      expect(onSlipCancel).toHaveBeenCalledWith('clip-1');
    });
  });
});

// =============================================================================
// useSlideEdit Tests
// =============================================================================

describe('useSlideEdit', () => {
  beforeEach(() => {
    useEditorToolStore.getState().reset();
  });

  describe('initial state', () => {
    it('should not be sliding initially', () => {
      const { result } = renderHook(() => useSlideEdit());

      expect(result.current.slideState.isSliding).toBe(false);
    });

    it('should detect slide tool active state', () => {
      const { result } = renderHook(() => useSlideEdit());

      expect(result.current.isSlideToolActive).toBe(false);

      act(() => {
        useEditorToolStore.getState().setActiveTool('slide');
      });

      expect(result.current.isSlideToolActive).toBe(true);
    });
  });

  describe('startSlide', () => {
    it('should initialize slide state with adjacent clips', () => {
      const clip = createTestClip({ place: { timelineInSec: 5, durationSec: 5 } });
      const track = createTestTrack([clip]);

      const prevClip: AdjacentClip = {
        clip: createTestClip({ id: 'prev', place: { timelineInSec: 0, durationSec: 5 } }),
        side: 'before',
        sourceDuration: 10,
      };

      const nextClip: AdjacentClip = {
        clip: createTestClip({ id: 'next', place: { timelineInSec: 10, durationSec: 5 } }),
        side: 'after',
        sourceDuration: 10,
      };

      const onSlideStart = vi.fn();

      const { result } = renderHook(() => useSlideEdit({ onSlideStart }));

      act(() => {
        result.current.startSlide(
          clip,
          track,
          () => prevClip,
          () => nextClip
        );
      });

      expect(result.current.slideState.isSliding).toBe(true);
      expect(result.current.slideState.previousClip).toBe(prevClip);
      expect(result.current.slideState.nextClip).toBe(nextClip);
      expect(onSlideStart).toHaveBeenCalledWith('clip-1');
    });
  });

  describe('calculateSlideConstraints', () => {
    it('should calculate constraints based on adjacent clips', () => {
      const { result } = renderHook(() => useSlideEdit());

      const prevClip: AdjacentClip = {
        clip: createTestClip({
          id: 'prev',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        side: 'before',
        sourceDuration: 10,
      };

      const nextClip: AdjacentClip = {
        clip: createTestClip({
          id: 'next',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        side: 'after',
        sourceDuration: 10,
      };

      const constraints = result.current.calculateSlideConstraints(0, prevClip, nextClip);

      // Can slide left up to (prev duration - min duration)
      expect(constraints.minOffset).toBeLessThan(0);
      // Can slide right up to (next duration - min duration)
      expect(constraints.maxOffset).toBeGreaterThan(0);
    });

    it('should constrain to zero if no previous clip', () => {
      const { result } = renderHook(() => useSlideEdit());

      const nextClip: AdjacentClip = {
        clip: createTestClip({ id: 'next' }),
        side: 'after',
        sourceDuration: 10,
      };

      const constraints = result.current.calculateSlideConstraints(0, null, nextClip);

      expect(constraints.minOffset).toBe(0);
    });

    it('should constrain to zero if no next clip', () => {
      const { result } = renderHook(() => useSlideEdit());

      const prevClip: AdjacentClip = {
        clip: createTestClip({ id: 'prev' }),
        side: 'before',
        sourceDuration: 10,
      };

      const constraints = result.current.calculateSlideConstraints(0, prevClip, null);

      expect(constraints.maxOffset).toBe(0);
    });
  });

  describe('endSlide', () => {
    it('should return slide result with adjacent clip changes', () => {
      const clip = createTestClip({
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const track = createTestTrack([clip]);

      const prevClip: AdjacentClip = {
        clip: createTestClip({
          id: 'prev',
          place: { timelineInSec: 0, durationSec: 5 },
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        side: 'before',
        sourceDuration: 10,
      };

      const nextClip: AdjacentClip = {
        clip: createTestClip({
          id: 'next',
          place: { timelineInSec: 10, durationSec: 5 },
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        side: 'after',
        sourceDuration: 10,
      };

      const { result } = renderHook(() => useSlideEdit());

      act(() => {
        result.current.startSlide(clip, track, () => prevClip, () => nextClip);
      });

      act(() => {
        result.current.updateSlide(1);
      });

      let slideResult: ReturnType<typeof result.current.endSlide>;
      act(() => {
        slideResult = result.current.endSlide();
      });

      expect(slideResult!.newTimelineIn).toBe(6);
      expect(slideResult!.previousClipChange?.clipId).toBe('prev');
      expect(slideResult!.nextClipChange?.clipId).toBe('next');
    });
  });
});

// =============================================================================
// useRollEdit Tests
// =============================================================================

describe('useRollEdit', () => {
  beforeEach(() => {
    useEditorToolStore.getState().reset();
  });

  describe('initial state', () => {
    it('should not be rolling initially', () => {
      const { result } = renderHook(() => useRollEdit());

      expect(result.current.rollState.isRolling).toBe(false);
    });

    it('should detect roll tool active state', () => {
      const { result } = renderHook(() => useRollEdit());

      expect(result.current.isRollToolActive).toBe(false);

      act(() => {
        useEditorToolStore.getState().setActiveTool('roll');
      });

      expect(result.current.isRollToolActive).toBe(true);
    });
  });

  describe('findEditPoint', () => {
    it('should find edit point between adjacent clips', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });

      const { result } = renderHook(() => useRollEdit());

      const editPoint = result.current.findEditPoint(
        [clip1, clip2],
        'track-1',
        5, // Time at edit point
        0.5, // Threshold
        () => 10 // Source duration getter
      );

      expect(editPoint).not.toBeNull();
      expect(editPoint?.outgoingClip.id).toBe('clip-1');
      expect(editPoint?.incomingClip.id).toBe('clip-2');
      expect(editPoint?.editTime).toBe(5);
    });

    it('should return null when no edit point near time', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });

      const { result } = renderHook(() => useRollEdit());

      const editPoint = result.current.findEditPoint(
        [clip1, clip2],
        'track-1',
        2, // Time far from edit point
        0.5, // Threshold
        () => 10
      );

      expect(editPoint).toBeNull();
    });

    it('should not find edit point for non-adjacent clips', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 7, durationSec: 5 }, // Gap of 2s
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });

      const { result } = renderHook(() => useRollEdit());

      const editPoint = result.current.findEditPoint(
        [clip1, clip2],
        'track-1',
        5,
        0.5,
        () => 10
      );

      expect(editPoint).toBeNull();
    });
  });

  describe('calculateRollConstraints', () => {
    it('should calculate roll constraints based on clip durations', () => {
      const editPoint = {
        outgoingClip: createTestClip({
          id: 'outgoing',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        incomingClip: createTestClip({
          id: 'incoming',
          range: { sourceInSec: 2, sourceOutSec: 7 },
        }),
        trackId: 'track-1',
        editTime: 5,
        outgoingSourceDuration: 10,
        incomingSourceDuration: 10,
      };

      const { result } = renderHook(() => useRollEdit());

      const constraints = result.current.calculateRollConstraints(editPoint);

      // Can roll left (limited by outgoing min duration and incoming source)
      expect(constraints.minOffset).toBeLessThan(0);
      // Can roll right (limited by incoming min duration and outgoing source)
      expect(constraints.maxOffset).toBeGreaterThan(0);
    });
  });

  describe('startRoll', () => {
    it('should initialize roll state', () => {
      const editPoint = {
        outgoingClip: createTestClip({ id: 'outgoing' }),
        incomingClip: createTestClip({ id: 'incoming' }),
        trackId: 'track-1',
        editTime: 5,
        outgoingSourceDuration: 10,
        incomingSourceDuration: 10,
      };

      const onRollStart = vi.fn();

      const { result } = renderHook(() => useRollEdit({ onRollStart }));

      act(() => {
        result.current.startRoll(editPoint);
      });

      expect(result.current.rollState.isRolling).toBe(true);
      expect(result.current.rollState.editPoint).toBe(editPoint);
      expect(onRollStart).toHaveBeenCalledWith(editPoint);
    });
  });

  describe('updateRoll', () => {
    it('should update roll offset during drag', () => {
      const editPoint = {
        outgoingClip: createTestClip({
          id: 'outgoing',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        incomingClip: createTestClip({
          id: 'incoming',
          range: { sourceInSec: 2, sourceOutSec: 7 },
        }),
        trackId: 'track-1',
        editTime: 5,
        outgoingSourceDuration: 10,
        incomingSourceDuration: 10,
      };

      const onRollMove = vi.fn();

      const { result } = renderHook(() => useRollEdit({ onRollMove }));

      act(() => {
        result.current.startRoll(editPoint);
      });

      act(() => {
        result.current.updateRoll(1);
      });

      expect(result.current.rollState.rollOffset).toBe(1);
      expect(onRollMove).toHaveBeenCalled();
    });
  });

  describe('endRoll', () => {
    it('should return roll result with clip changes', () => {
      const editPoint = {
        outgoingClip: createTestClip({
          id: 'outgoing',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        incomingClip: createTestClip({
          id: 'incoming',
          range: { sourceInSec: 0, sourceOutSec: 5 },
        }),
        trackId: 'track-1',
        editTime: 5,
        outgoingSourceDuration: 10,
        incomingSourceDuration: 10,
      };

      const onRollEnd = vi.fn();

      const { result } = renderHook(() => useRollEdit({ onRollEnd }));

      act(() => {
        result.current.startRoll(editPoint);
      });

      act(() => {
        result.current.updateRoll(1);
      });

      let rollResult: ReturnType<typeof result.current.endRoll>;
      act(() => {
        rollResult = result.current.endRoll();
      });

      expect(rollResult!.newEditTime).toBe(6);
      expect(rollResult!.outgoingClipChange.sourceOut).toBe(6);
      expect(rollResult!.incomingClipChange.sourceIn).toBe(1);
      expect(result.current.rollState.isRolling).toBe(false);
      expect(onRollEnd).toHaveBeenCalled();
    });
  });

  describe('cancelRoll', () => {
    it('should cancel roll and reset state', () => {
      const editPoint = {
        outgoingClip: createTestClip({ id: 'outgoing' }),
        incomingClip: createTestClip({ id: 'incoming' }),
        trackId: 'track-1',
        editTime: 5,
        outgoingSourceDuration: 10,
        incomingSourceDuration: 10,
      };

      const onRollCancel = vi.fn();

      const { result } = renderHook(() => useRollEdit({ onRollCancel }));

      act(() => {
        result.current.startRoll(editPoint);
      });

      act(() => {
        result.current.cancelRoll();
      });

      expect(result.current.rollState.isRolling).toBe(false);
      expect(onRollCancel).toHaveBeenCalledWith(editPoint);
    });
  });
});
