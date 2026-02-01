/**
 * useClipboard Hook Tests
 *
 * Tests for clipboard operations (copy, cut, paste, duplicate).
 * Follows TDD methodology.
 *
 * @module hooks/useClipboard.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClipboard } from './useClipboard';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence, Clip, Track } from '@/types';

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

function createTestSequence(tracks: Track[] = []): Sequence {
  return {
    id: 'sequence-1',
    name: 'Test Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks,
    markers: [],
  } as Sequence;
}

// =============================================================================
// Tests
// =============================================================================

describe('useClipboard', () => {
  beforeEach(() => {
    // Reset stores
    useEditorToolStore.getState().clearClipboard();
    useEditorToolStore.getState().reset();
    usePlaybackStore.setState({ currentTime: 0 });
  });

  describe('initial state', () => {
    it('should report empty clipboard initially', () => {
      const { result } = renderHook(() =>
        useClipboard({
          sequence: null,
          selectedClipIds: [],
        })
      );

      expect(result.current.hasClipboard).toBe(false);
      expect(result.current.clipboardCount).toBe(0);
    });

    it('should disable copy when no clips selected', () => {
      const sequence = createTestSequence([createTestTrack([createTestClip()])]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: [],
        })
      );

      expect(result.current.canCopy).toBe(false);
      expect(result.current.canCut).toBe(false);
      expect(result.current.canDuplicate).toBe(false);
    });

    it('should disable paste when clipboard is empty', () => {
      const sequence = createTestSequence([createTestTrack([createTestClip()])]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
        })
      );

      expect(result.current.canPaste).toBe(false);
    });
  });

  describe('copy', () => {
    it('should copy selected clips to clipboard', () => {
      const clip = createTestClip({ id: 'clip-1' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const onCopy = vi.fn();

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
          onCopy,
        })
      );

      expect(result.current.canCopy).toBe(true);

      let copyResult: ReturnType<typeof result.current.copy>;
      act(() => {
        copyResult = result.current.copy();
      });

      expect(copyResult!.success).toBe(true);
      expect(copyResult!.clipIds).toContain('clip-1');
      expect(result.current.hasClipboard).toBe(true);
      expect(result.current.clipboardCount).toBe(1);
      expect(onCopy).toHaveBeenCalled();
    });

    it('should copy multiple clips', () => {
      const clip1 = createTestClip({ id: 'clip-1' });
      const clip2 = createTestClip({ id: 'clip-2', place: { timelineInSec: 5, durationSec: 5 } });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1', 'clip-2'],
        })
      );

      act(() => {
        result.current.copy();
      });

      expect(result.current.clipboardCount).toBe(2);
    });

    it('should fail when no sequence available', () => {
      const { result } = renderHook(() =>
        useClipboard({
          sequence: null,
          selectedClipIds: ['clip-1'],
        })
      );

      let copyResult: ReturnType<typeof result.current.copy>;
      act(() => {
        copyResult = result.current.copy();
      });

      expect(copyResult!.success).toBe(false);
      expect(copyResult!.message).toBe('No sequence available');
    });

    it('should fail when no clips selected', () => {
      const sequence = createTestSequence([createTestTrack([createTestClip()])]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: [],
        })
      );

      let copyResult: ReturnType<typeof result.current.copy>;
      act(() => {
        copyResult = result.current.copy();
      });

      expect(copyResult!.success).toBe(false);
      expect(copyResult!.message).toBe('No clips selected');
    });
  });

  describe('cut', () => {
    it('should copy and delete clips', () => {
      const clip = createTestClip({ id: 'clip-1' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const onCut = vi.fn();
      const onDelete = vi.fn();

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
          onCut,
          onDelete,
        })
      );

      let cutResult: ReturnType<typeof result.current.cut>;
      act(() => {
        cutResult = result.current.cut();
      });

      expect(cutResult!.success).toBe(true);
      expect(result.current.hasClipboard).toBe(true);
      expect(onCut).toHaveBeenCalledWith(['clip-1']);
      expect(onDelete).toHaveBeenCalledWith(['clip-1']);
    });
  });

  describe('paste', () => {
    it('should paste clips at playhead position', () => {
      const clip = createTestClip({ id: 'clip-1' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const onPaste = vi.fn();

      // Set playhead at 10 seconds
      usePlaybackStore.setState({ currentTime: 10 });

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
          onPaste,
        })
      );

      // Copy first
      act(() => {
        result.current.copy();
      });

      expect(result.current.canPaste).toBe(true);

      // Then paste
      let pasteResult: ReturnType<typeof result.current.paste>;
      act(() => {
        pasteResult = result.current.paste();
      });

      expect(pasteResult!.success).toBe(true);
      expect(onPaste).toHaveBeenCalled();

      // Check that the paste time is correct
      const pasteCall = onPaste.mock.calls[0];
      expect(pasteCall[1]).toBe(10); // currentTime
    });

    it('should offset multiple clips correctly when pasting', () => {
      const clip1 = createTestClip({ id: 'clip-1', place: { timelineInSec: 2, durationSec: 5 } });
      const clip2 = createTestClip({ id: 'clip-2', place: { timelineInSec: 5, durationSec: 5 } });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const onPaste = vi.fn();

      // Set playhead at 10 seconds
      usePlaybackStore.setState({ currentTime: 10 });

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1', 'clip-2'],
          onPaste,
        })
      );

      // Copy both clips
      act(() => {
        result.current.copy();
      });

      // Paste
      act(() => {
        result.current.paste();
      });

      const pastedClips = onPaste.mock.calls[0][0];

      // clip-1 was at 2s (earliest), should now be at 10s (playhead)
      // clip-2 was at 5s, should now be at 10 + (5-2) = 13s
      expect(pastedClips.find((c: { clipId: string }) => c.clipId === 'clip-1').clipData.timelineIn).toBe(10);
      expect(pastedClips.find((c: { clipId: string }) => c.clipId === 'clip-2').clipData.timelineIn).toBe(13);
    });

    it('should fail when clipboard is empty', () => {
      const sequence = createTestSequence([createTestTrack()]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: [],
        })
      );

      let pasteResult: ReturnType<typeof result.current.paste>;
      act(() => {
        pasteResult = result.current.paste();
      });

      expect(pasteResult!.success).toBe(false);
      expect(pasteResult!.message).toBe('Clipboard is empty');
    });
  });

  describe('duplicate', () => {
    it('should duplicate clips immediately after selection', () => {
      const clip = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const onDuplicate = vi.fn();

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
          onDuplicate,
        })
      );

      expect(result.current.canDuplicate).toBe(true);

      let dupResult: ReturnType<typeof result.current.duplicate>;
      act(() => {
        dupResult = result.current.duplicate();
      });

      expect(dupResult!.success).toBe(true);
      expect(onDuplicate).toHaveBeenCalledWith(['clip-1'], 5); // 5 = end of clip
    });

    it('should duplicate at the end of the latest clip', () => {
      const clip1 = createTestClip({
        id: 'clip-1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 3 },
      });
      const clip2 = createTestClip({
        id: 'clip-2',
        place: { timelineInSec: 5, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 4 },
      });
      const track = createTestTrack([clip1, clip2]);
      const sequence = createTestSequence([track]);

      const onDuplicate = vi.fn();

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1', 'clip-2'],
          onDuplicate,
        })
      );

      act(() => {
        result.current.duplicate();
      });

      // clip-2 ends at 5 + 4 = 9
      expect(onDuplicate).toHaveBeenCalledWith(['clip-1', 'clip-2'], 9);
    });

    it('should fail when no clips selected', () => {
      const sequence = createTestSequence([createTestTrack()]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: [],
        })
      );

      let dupResult: ReturnType<typeof result.current.duplicate>;
      act(() => {
        dupResult = result.current.duplicate();
      });

      expect(dupResult!.success).toBe(false);
      expect(dupResult!.message).toBe('No clips selected');
    });
  });

  describe('clearClipboard', () => {
    it('should clear the clipboard', () => {
      const clip = createTestClip({ id: 'clip-1' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-1'],
        })
      );

      // Copy first
      act(() => {
        result.current.copy();
      });

      expect(result.current.hasClipboard).toBe(true);

      // Clear
      act(() => {
        result.current.clearClipboard();
      });

      expect(result.current.hasClipboard).toBe(false);
      expect(result.current.clipboardCount).toBe(0);
    });
  });
});
