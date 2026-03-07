import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Sequence } from '@/types';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { useRazorTool } from './useRazorTool';

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
      clips: [
        {
          id: 'clip_001',
          assetId: 'asset_001',
          range: { sourceInSec: 0, sourceOutSec: 10 },
          place: { timelineInSec: 0, durationSec: 10 },
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
        },
      ],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1,
    },
  ],
  markers: [],
};

const mockRect = {
  left: 0,
  top: 0,
  width: 800,
  height: 400,
  right: 800,
  bottom: 400,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

describe('useRazorTool', () => {
  beforeEach(() => {
    useEditorToolStore.setState({ activeTool: 'select', previousTool: null });
  });

  it('should split a clip at the clicked timeline position when razor tool is active', () => {
    useEditorToolStore.setState({ activeTool: 'razor' });
    const onSplit = vi.fn();

    const { result } = renderHook(() =>
      useRazorTool({
        sequence: mockSequence,
        zoom: 100,
        scrollX: 0,
        trackHeaderWidth: 192,
        trackHeight: 48,
        onSplit,
      }),
    );

    const handled = result.current.handleTimelineClick(320, 40, mockRect);

    expect(handled).toBe(true);
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onSplit).toHaveBeenCalledWith({
      sequenceId: 'seq_001',
      trackId: 'track_001',
      clipId: 'clip_001',
      splitTime: 1.28,
      ignoreLinkedSelection: false,
    });
  });

  it('should bypass linked selection when Alt is held during razor split', () => {
    useEditorToolStore.setState({ activeTool: 'razor' });
    const onSplit = vi.fn();

    const { result } = renderHook(() =>
      useRazorTool({
        sequence: mockSequence,
        zoom: 100,
        scrollX: 0,
        trackHeaderWidth: 192,
        trackHeight: 48,
        onSplit,
      }),
    );

    const handled = result.current.handleTimelineClick(320, 40, mockRect, { altKey: true });

    expect(handled).toBe(true);
    expect(onSplit).toHaveBeenCalledWith({
      sequenceId: 'seq_001',
      trackId: 'track_001',
      clipId: 'clip_001',
      splitTime: 1.28,
      ignoreLinkedSelection: true,
    });
  });

  it('should expose a custom scissors cursor when razor tool is active', () => {
    useEditorToolStore.setState({ activeTool: 'razor' });

    const { result } = renderHook(() =>
      useRazorTool({
        sequence: mockSequence,
        zoom: 100,
        scrollX: 0,
      }),
    );

    expect(result.current.getCursorStyle()).toContain('url(');
  });
});
