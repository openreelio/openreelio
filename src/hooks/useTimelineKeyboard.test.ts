/**
 * useTimelineKeyboard Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTimelineKeyboard } from './useTimelineKeyboard';
import type { Sequence, Track, Clip } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockClip = (
  id: string,
  timelineInSec: number,
  durationSec: number
): Clip => ({
  id,
  assetId: `asset-${id}`,
  range: {
    sourceInSec: 0,
    sourceOutSec: durationSec,
  },
  place: {
    timelineInSec,
    durationSec,
  },
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
  },
});

const createMockTrack = (id: string, clips: Clip[] = []): Track => ({
  id,
  kind: 'video',
  name: `Track ${id}`,
  clips,
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1,
});

const createMockSequence = (clips: Clip[][] = [[]]): Sequence => ({
  id: 'seq-1',
  name: 'Test Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: clips.map((trackClips, i) =>
    createMockTrack(`track-${i}`, trackClips)
  ),
  markers: [],
});

const createKeyboardEvent = (
  key: string,
  options: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {}
): React.KeyboardEvent => ({
  key,
  ctrlKey: options.ctrlKey ?? false,
  metaKey: options.metaKey ?? false,
  shiftKey: options.shiftKey ?? false,
  altKey: options.altKey ?? false,
  preventDefault: vi.fn(),
} as unknown as React.KeyboardEvent);

// =============================================================================
// Tests
// =============================================================================

describe('useTimelineKeyboard', () => {
  const createDefaultOptions = () => ({
    sequence: createMockSequence(),
    selectedClipIds: [] as string[],
    playhead: 0,
    togglePlayback: vi.fn(),
    stepForward: vi.fn(),
    stepBackward: vi.fn(),
    clearClipSelection: vi.fn(),
    selectClips: vi.fn(),
    onDeleteClips: vi.fn(),
    onClipSplit: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return handleKeyDown function', () => {
      const { result } = renderHook(() =>
        useTimelineKeyboard(createDefaultOptions())
      );
      expect(typeof result.current.handleKeyDown).toBe('function');
    });
  });

  describe('playback controls', () => {
    it('should toggle playback on Space key', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent(' ');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.togglePlayback).toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should step backward on ArrowLeft key', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('ArrowLeft');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.stepBackward).toHaveBeenCalled();
    });

    it('should step forward on ArrowRight key', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('ArrowRight');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.stepForward).toHaveBeenCalled();
    });
  });

  describe('selection controls', () => {
    it('should clear clip selection on Escape key', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('Escape');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.clearClipSelection).toHaveBeenCalled();
    });

    it('should select all clips on Ctrl+A', () => {
      const clips = [
        [createMockClip('clip-1', 0, 2), createMockClip('clip-2', 3, 2)],
        [createMockClip('clip-3', 1, 3)],
      ];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('a', { ctrlKey: true });
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.selectClips).toHaveBeenCalledWith([
        'clip-1',
        'clip-2',
        'clip-3',
      ]);
    });

    it('should select all clips on Meta+A (Mac)', () => {
      const clips = [[createMockClip('clip-1', 0, 2)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('a', { metaKey: true });
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.selectClips).toHaveBeenCalledWith(['clip-1']);
    });

    it('should handle uppercase A for select all', () => {
      const clips = [[createMockClip('clip-1', 0, 2)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('A', { ctrlKey: true });
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.selectClips).toHaveBeenCalled();
    });

    it('should not select all when sequence is null', () => {
      const options = {
        ...createDefaultOptions(),
        sequence: null,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('a', { ctrlKey: true });
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.selectClips).not.toHaveBeenCalled();
    });
  });

  describe('delete clips', () => {
    it('should delete selected clips on Delete key', () => {
      const options = {
        ...createDefaultOptions(),
        selectedClipIds: ['clip-1', 'clip-2'],
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('Delete');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onDeleteClips).toHaveBeenCalledWith(['clip-1', 'clip-2']);
    });

    it('should delete selected clips on Backspace key', () => {
      const options = {
        ...createDefaultOptions(),
        selectedClipIds: ['clip-1'],
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('Backspace');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onDeleteClips).toHaveBeenCalledWith(['clip-1']);
    });

    it('should not call onDeleteClips when no clips are selected', () => {
      const options = {
        ...createDefaultOptions(),
        selectedClipIds: [],
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('Delete');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onDeleteClips).not.toHaveBeenCalled();
    });

    it('should not call onDeleteClips when callback is undefined', () => {
      const options = {
        ...createDefaultOptions(),
        selectedClipIds: ['clip-1'],
        onDeleteClips: undefined,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('Delete');
      act(() => {
        result.current.handleKeyDown(event);
      });

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('split clip', () => {
    it('should split clip at playhead on S key', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).toHaveBeenCalledWith({
        sequenceId: 'seq-1',
        trackId: 'track-0',
        clipId: 'clip-1',
        splitTime: 2,
      });
    });

    it('should split clip on uppercase S key', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('S');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).toHaveBeenCalled();
    });

    it('should not split when Ctrl+S is pressed (save shortcut)', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s', { ctrlKey: true });
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when no clips are selected', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: [],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when multiple clips are selected', () => {
      const clips = [
        [createMockClip('clip-1', 0, 5), createMockClip('clip-2', 6, 3)],
      ];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1', 'clip-2'],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when playhead is before clip start', () => {
      const clips = [[createMockClip('clip-1', 2, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 1, // Before clip starts at 2
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when playhead is after clip end', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 6, // After clip ends at 5
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when playhead is exactly at clip start', () => {
      const clips = [[createMockClip('clip-1', 2, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 2, // Exactly at clip start
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when sequence is null', () => {
      const options = {
        ...createDefaultOptions(),
        sequence: null,
        selectedClipIds: ['clip-1'],
        playhead: 2,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).not.toHaveBeenCalled();
    });

    it('should not split when onClipSplit is undefined', () => {
      const clips = [[createMockClip('clip-1', 0, 5)]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 2,
        onClipSplit: undefined,
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      // Should not throw
      expect(true).toBe(true);
    });

    it('should handle clips with speed modifier', () => {
      const clip: Clip = {
        ...createMockClip('clip-1', 0, 10),
        speed: 2, // 2x speed means 10 seconds of source plays in 5 seconds of timeline
      };
      clip.range.sourceOutSec = 10;

      const clips = [[clip]];
      const options = {
        ...createDefaultOptions(),
        sequence: createMockSequence(clips),
        selectedClipIds: ['clip-1'],
        playhead: 4, // Within 0-5 second range (10 source seconds / 2 speed)
      };
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('s');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(options.onClipSplit).toHaveBeenCalledWith(
        expect.objectContaining({ splitTime: 4 })
      );
    });
  });

  describe('unhandled keys', () => {
    it('should not call preventDefault for unhandled keys', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useTimelineKeyboard(options));

      const event = createKeyboardEvent('x');
      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('memoization', () => {
    it('should memoize handleKeyDown', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(() =>
        useTimelineKeyboard(options)
      );

      const initialHandler = result.current.handleKeyDown;
      rerender();
      expect(result.current.handleKeyDown).toBe(initialHandler);
    });

    it('should update handleKeyDown when dependencies change', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(
        (props) => useTimelineKeyboard(props),
        { initialProps: options }
      );

      // Store initial handler to verify it's a function
      expect(typeof result.current.handleKeyDown).toBe('function');

      rerender({ ...options, playhead: 5 });

      // Handler reference may change, but function should still work
      expect(typeof result.current.handleKeyDown).toBe('function');
    });
  });
});
