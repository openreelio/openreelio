/**
 * useTimelineClipOperations Hook Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for clip utility functions and drag operation handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimelineClipOperations } from './useTimelineClipOperations';
import type { Sequence, Clip } from '@/types';
import type { ClipMoveData, ClipTrimData } from '@/components/timeline/types';
import type { ClipDragData, DragPreviewPosition } from '@/components/timeline/Clip';

// =============================================================================
// Test Data
// =============================================================================

const mockClip: Clip = {
  id: 'clip_001',
  assetId: 'asset_001',
  range: { sourceInSec: 0, sourceOutSec: 10 },
  place: { timelineInSec: 5, durationSec: 10 },
  transform: {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
};

const mockSequence: Sequence = {
  id: 'seq_001',
  name: 'Main Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: [
    {
      id: 'track_001',
      kind: 'video',
      name: 'Video 1',
      clips: [mockClip],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1.0,
    },
    {
      id: 'track_002',
      kind: 'audio',
      name: 'Audio 1',
      clips: [],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1.0,
    },
  ],
  markers: [],
};

// =============================================================================
// Tests
// =============================================================================

describe('useTimelineClipOperations', () => {
  // ===========================================================================
  // getTrackClips Tests
  // ===========================================================================

  describe('getTrackClips', () => {
    it('should return clips for a valid track', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const clips = result.current.getTrackClips('track_001');
      expect(clips).toHaveLength(1);
      expect(clips[0].id).toBe('clip_001');
    });

    it('should return empty array for track with no clips', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const clips = result.current.getTrackClips('track_002');
      expect(clips).toEqual([]);
    });

    it('should return empty array for non-existent track', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const clips = result.current.getTrackClips('non_existent');
      expect(clips).toEqual([]);
    });

    it('should return empty array when sequence is null', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: null,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const clips = result.current.getTrackClips('track_001');
      expect(clips).toEqual([]);
    });
  });

  // ===========================================================================
  // findClip Tests
  // ===========================================================================

  describe('findClip', () => {
    it('should find clip and return with track id', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const found = result.current.findClip('clip_001');
      expect(found).not.toBeNull();
      expect(found?.clip.id).toBe('clip_001');
      expect(found?.trackId).toBe('track_001');
    });

    it('should return null for non-existent clip', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const found = result.current.findClip('non_existent');
      expect(found).toBeNull();
    });

    it('should return null when sequence is null', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: null,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const found = result.current.findClip('clip_001');
      expect(found).toBeNull();
    });
  });

  // ===========================================================================
  // Drag Preview State Tests
  // ===========================================================================

  describe('drag preview state', () => {
    it('should initialize with null drag preview', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      expect(result.current.dragPreview).toBeNull();
    });

    it('should update drag preview on drag start', () => {
      const selectClip = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
          selectClip,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      act(() => {
        result.current.handleClipDragStart('track_001', dragData);
      });

      expect(result.current.dragPreview).not.toBeNull();
      expect(result.current.dragPreview?.clipId).toBe('clip_001');
    });

    it('should call selectClip on drag start', () => {
      const selectClip = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
          selectClip,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      act(() => {
        result.current.handleClipDragStart('track_001', dragData);
      });

      expect(selectClip).toHaveBeenCalledWith('clip_001');
    });

    it('should update drag preview during drag', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const previewPosition: DragPreviewPosition = {
        timelineIn: 10,
        sourceIn: 0,
        sourceOut: 10,
        duration: 10,
      };

      act(() => {
        result.current.handleClipDrag('track_001', dragData, previewPosition);
      });

      expect(result.current.dragPreview).not.toBeNull();
      expect(result.current.dragPreview?.left).toBe(1000); // 10 * zoom(100)
    });

    it('should clear drag preview on drag end', () => {
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim: undefined,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 10,
        sourceIn: 0,
        sourceOut: 10,
        duration: 10,
      };

      // Start drag to set preview
      act(() => {
        result.current.handleClipDragStart('track_001', dragData);
      });

      expect(result.current.dragPreview).not.toBeNull();

      // End drag
      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(result.current.dragPreview).toBeNull();
    });
  });

  // ===========================================================================
  // Clip Move Handler Tests
  // ===========================================================================

  describe('handleClipDragEnd for move', () => {
    it('should call onClipMove with correct data', () => {
      const onClipMove = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove,
          onClipTrim: undefined,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 15,
        sourceIn: 0,
        sourceOut: 10,
        duration: 10,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipMove).toHaveBeenCalledWith({
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newTimelineIn: 15,
      } satisfies ClipMoveData);
    });

    it('should clamp negative timeline position to 0', () => {
      const onClipMove = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove,
          onClipTrim: undefined,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: -5,
        sourceIn: 0,
        sourceOut: 10,
        duration: 10,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipMove).toHaveBeenCalledWith(
        expect.objectContaining({
          newTimelineIn: 0,
        })
      );
    });

    it('should not call onClipMove when sequence is null', () => {
      const onClipMove = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: null,
          zoom: 100,
          onClipMove,
          onClipTrim: undefined,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'move',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 15,
        sourceIn: 0,
        sourceOut: 10,
        duration: 10,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipMove).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Clip Trim Handler Tests
  // ===========================================================================

  describe('handleClipDragEnd for trim-left', () => {
    it('should call onClipTrim with newSourceIn and newTimelineIn', () => {
      const onClipTrim = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'trim-left',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 7,
        sourceIn: 2,
        sourceOut: 10,
        duration: 8,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipTrim).toHaveBeenCalledWith({
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newSourceIn: 2,
        newTimelineIn: 7,
      } satisfies ClipTrimData);
    });

    it('should clamp negative sourceIn to 0', () => {
      const onClipTrim = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'trim-left',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 3,
        sourceIn: -2,
        sourceOut: 10,
        duration: 12,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipTrim).toHaveBeenCalledWith(
        expect.objectContaining({
          newSourceIn: 0,
          newTimelineIn: 3,
        })
      );
    });
  });

  describe('handleClipDragEnd for trim-right', () => {
    it('should call onClipTrim with newSourceOut only', () => {
      const onClipTrim = vi.fn();
      const { result } = renderHook(() =>
        useTimelineClipOperations({
          sequence: mockSequence,
          zoom: 100,
          onClipMove: undefined,
          onClipTrim,
        })
      );

      const dragData: ClipDragData = {
        clipId: 'clip_001',
        type: 'trim-right',
        startX: 500,
        originalTimelineIn: 5,
        originalSourceIn: 0,
        originalSourceOut: 10,
      };

      const finalPosition: DragPreviewPosition = {
        timelineIn: 5,
        sourceIn: 0,
        sourceOut: 8,
        duration: 8,
      };

      act(() => {
        result.current.handleClipDragEnd('track_001', dragData, finalPosition);
      });

      expect(onClipTrim).toHaveBeenCalledWith({
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        newSourceOut: 8,
      } satisfies ClipTrimData);
    });
  });
});
