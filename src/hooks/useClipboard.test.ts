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
import type { CaptionPosition, CaptionStyle, Sequence, Clip, Track, TextClipData } from '@/types';

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
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
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

    it('should preserve explicit timeline duration when copying freeze-frame clips', () => {
      const clip = createTestClip({
        id: 'clip-freeze',
        range: { sourceInSec: 5, sourceOutSec: 5 },
        place: { timelineInSec: 4, durationSec: 3 },
        freezeFrame: true,
      });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-freeze'],
        })
      );

      act(() => {
        result.current.copy();
      });

      const clipboardItem = useEditorToolStore.getState().clipboard?.[0];
      expect(clipboardItem?.clipData.durationSec).toBe(3);
    });

    it('should preserve rich text clip data as a copy-time snapshot', () => {
      const clip = createTestClip({ id: 'clip-text', assetId: 'text:clip-text' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);
      const textData: TextClipData = {
        content: 'Styled title',
        style: {
          fontFamily: 'Inter',
          fontSize: 72,
          fontWeight: 700,
          color: '#F8FAFC',
          backgroundColor: '#111827',
          backgroundPadding: 18,
          alignment: 'center',
          bold: true,
          italic: true,
          underline: true,
          lineHeight: 1.15,
          letterSpacing: 2,
        },
        position: { x: 0.42, y: 0.31 },
        rotation: -8,
        opacity: 0.82,
        outline: { color: '#0F172A', width: 3 },
        shadow: { color: '#000000', offsetX: 8, offsetY: 10, blur: 12 },
      };

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-text'],
          getTextClipData: () => textData,
        })
      );

      act(() => {
        result.current.copy();
      });

      textData.style.fontFamily = 'Mutated Font';
      textData.style.fontSize = 12;
      textData.position.x = 0.9;
      textData.shadow!.blur = 1;

      const clipboardItem = useEditorToolStore.getState().clipboard?.[0];
      expect(clipboardItem?.clipData.textData).toEqual({
        content: 'Styled title',
        style: {
          fontFamily: 'Inter',
          fontSize: 72,
          fontWeight: 700,
          color: '#F8FAFC',
          backgroundColor: '#111827',
          backgroundPadding: 18,
          alignment: 'center',
          bold: true,
          italic: true,
          underline: true,
          lineHeight: 1.15,
          letterSpacing: 2,
        },
        position: { x: 0.42, y: 0.31 },
        rotation: -8,
        opacity: 0.82,
        outline: { color: '#0F172A', width: 3 },
        shadow: { color: '#000000', offsetX: 8, offsetY: 10, blur: 12 },
      });
    });

    it('should preserve caption style and position as a copy-time snapshot', () => {
      const captionStyle: CaptionStyle = {
        fontFamily: 'Pretendard',
        fontSize: 54,
        fontWeight: 800,
        bold: true,
        color: { r: 248, g: 250, b: 252, a: 255 },
        opacity: 0.9,
        backgroundColor: { r: 15, g: 23, b: 42, a: 190 },
        backgroundPadding: 16,
        outlineColor: { r: 0, g: 0, b: 0, a: 255 },
        outlineWidth: 4,
        shadowColor: { r: 0, g: 0, b: 0, a: 220 },
        shadowOffset: 6,
        shadowOffsetX: 5,
        shadowOffsetY: 9,
        shadowBlur: 7,
        alignment: 'center',
        italic: true,
        underline: true,
        lineHeight: 1.18,
        letterSpacing: 1.5,
      };
      const captionPosition: CaptionPosition = {
        type: 'custom',
        xPercent: 43,
        yPercent: 78,
      };
      const clip = createTestClip({
        id: 'caption-1',
        assetId: 'caption:caption-1',
        label: 'Caption copy',
        captionStyle,
        captionPosition,
      });
      const track = {
        ...createTestTrack([clip], 'caption-track-1'),
        kind: 'caption' as const,
      };
      const sequence = createTestSequence([track]);

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['caption-1'],
        })
      );

      act(() => {
        result.current.copy();
      });

      captionStyle.fontFamily = 'Mutated Font';
      captionStyle.color.r = 0;
      captionStyle.shadowBlur = 1;
      if (captionPosition.type === 'custom') {
        captionPosition.xPercent = 4;
      }

      const clipboardCaption = useEditorToolStore.getState().clipboard?.[0]?.clipData.caption;
      expect(clipboardCaption).toEqual({
        text: 'Caption copy',
        startSec: 0,
        endSec: 5,
        style: {
          fontFamily: 'Pretendard',
          fontSize: 54,
          fontWeight: 800,
          bold: true,
          color: { r: 248, g: 250, b: 252, a: 255 },
          opacity: 0.9,
          backgroundColor: { r: 15, g: 23, b: 42, a: 190 },
          backgroundPadding: 16,
          outlineColor: { r: 0, g: 0, b: 0, a: 255 },
          outlineWidth: 4,
          shadowColor: { r: 0, g: 0, b: 0, a: 220 },
          shadowOffset: 6,
          shadowOffsetX: 5,
          shadowOffsetY: 9,
          shadowBlur: 7,
          alignment: 'center',
          italic: true,
          underline: true,
          lineHeight: 1.18,
          letterSpacing: 1.5,
        },
        position: {
          type: 'custom',
          xPercent: 43,
          yPercent: 78,
        },
      });
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

    it('should pass cloned rich clip data to paste handlers', () => {
      const clip = createTestClip({ id: 'clip-text', assetId: 'text:clip-text' });
      const track = createTestTrack([clip]);
      const sequence = createTestSequence([track]);
      const textData: TextClipData = {
        content: 'Paste snapshot',
        style: {
          fontFamily: 'Inter',
          fontSize: 64,
          color: '#FFFFFF',
          backgroundPadding: 8,
          alignment: 'center',
          bold: false,
          italic: false,
          underline: false,
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        position: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      };
      const onPaste = vi.fn((clips) => {
        clips[0].clipData.textData.style.fontSize = 11;
        clips[0].clipData.textData.position.x = 0.1;
      });

      usePlaybackStore.setState({ currentTime: 10 });

      const { result } = renderHook(() =>
        useClipboard({
          sequence,
          selectedClipIds: ['clip-text'],
          getTextClipData: () => textData,
          onPaste,
        })
      );

      act(() => {
        result.current.copy();
      });
      act(() => {
        result.current.paste();
      });

      const clipboardTextData = useEditorToolStore.getState().clipboard?.[0].clipData.textData;
      expect(clipboardTextData?.style.fontSize).toBe(64);
      expect(clipboardTextData?.position.x).toBe(0.5);
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

      // clip-2 ends at 5 + explicit duration 5 = 10
      expect(onDuplicate).toHaveBeenCalledWith(['clip-1', 'clip-2'], 10);
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
