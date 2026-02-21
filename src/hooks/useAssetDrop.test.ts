/**
 * useAssetDrop Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAssetDrop } from './useAssetDrop';
import type { Sequence, Track, TrackKind } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockTrack = (id: string, locked = false, kind: TrackKind = 'video'): Track => ({
  id,
  kind,
  name: `Track ${id}`,
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked,
  visible: true,
  volume: 1,
});

const createMockSequence = (trackCount = 2): Sequence => ({
  id: 'seq-1',
  name: 'Test Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: Array.from({ length: trackCount }, (_, i) => createMockTrack(`track-${i}`, i === 1)),
  markers: [],
});

function createMockRect(top: number, height: number, left = 100, width = 800): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function createTrackRowContainer(
  rows: Array<{ trackId: string; top: number; height: number }>,
): HTMLElement {
  const container = document.createElement('div');
  container.getBoundingClientRect = vi.fn().mockReturnValue(createMockRect(0, 220));

  for (const row of rows) {
    const rowElement = document.createElement('div');
    rowElement.dataset.trackRow = 'true';
    rowElement.dataset.trackId = row.trackId;
    rowElement.getBoundingClientRect = vi.fn().mockReturnValue(createMockRect(row.top, row.height));
    container.appendChild(rowElement);
  }

  return container;
}

const createMockDragEvent = (
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  options: Partial<{
    clientX: number;
    clientY: number;
    dataTransferData: Record<string, string>;
    dataTransferTypes: string[];
    currentTarget: HTMLElement;
  }> = {},
) => {
  const {
    clientX = 300,
    clientY = 50,
    dataTransferData = { 'application/json': JSON.stringify({ id: 'asset-1' }) },
    dataTransferTypes = ['application/json'],
    currentTarget = document.createElement('div'),
  } = options;

  // Mock getBoundingClientRect
  currentTarget.getBoundingClientRect = vi.fn().mockReturnValue(createMockRect(0, 200));

  return {
    type,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX,
    clientY,
    currentTarget,
    dataTransfer: {
      types: dataTransferTypes,
      getData: (format: string) => dataTransferData[format] || '',
      dropEffect: 'none',
    },
  } as unknown as React.DragEvent;
};

// =============================================================================
// Tests
// =============================================================================

describe('useAssetDrop', () => {
  const defaultOptions = {
    sequence: createMockSequence(),
    zoom: 100,
    scrollX: 0,
    scrollY: 0,
    trackHeaderWidth: 100,
    trackHeight: 60,
    onAssetDrop: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return isDraggingOver as false initially', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      expect(result.current.isDraggingOver).toBe(false);
    });

    it('should return all required handlers', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      expect(typeof result.current.handleDragEnter).toBe('function');
      expect(typeof result.current.handleDragOver).toBe('function');
      expect(typeof result.current.handleDragLeave).toBe('function');
      expect(typeof result.current.handleDrop).toBe('function');
    });
  });

  describe('handleDragEnter', () => {
    it('should set isDraggingOver to true when valid data types are present', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const event = createMockDragEvent('dragenter');

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingOver).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('should set isDraggingOver to true for text/plain data type', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const event = createMockDragEvent('dragenter', {
        dataTransferTypes: ['text/plain'],
        dataTransferData: { 'text/plain': 'asset-1' },
      });

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingOver).toBe(true);
    });

    it('should set isDraggingOver to true for workspace file drags', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const event = createMockDragEvent('dragenter', {
        dataTransferTypes: ['application/x-workspace-file'],
        dataTransferData: {
          'application/x-workspace-file': 'footage/interview.mp4',
        },
      });

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingOver).toBe(true);
    });

    it('should not set isDraggingOver for unsupported data types', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const event = createMockDragEvent('dragenter', {
        dataTransferTypes: ['image/png'],
        dataTransferData: {},
      });

      act(() => {
        result.current.handleDragEnter(event);
      });

      expect(result.current.isDraggingOver).toBe(false);
    });
  });

  describe('handleDragOver', () => {
    it('should set dropEffect to copy for valid data types', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const event = createMockDragEvent('dragover');

      act(() => {
        result.current.handleDragOver(event);
      });

      expect(event.dataTransfer.dropEffect).toBe('copy');
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('should allow drop during dragover since getData is unavailable in modern browsers', () => {
      // DataTransfer.getData() returns empty strings during dragover in modern
      // Chromium-based browsers (including WebView2/Tauri). Asset kind compatibility
      // is validated in handleDrop instead. During dragover, dropEffect should stay
      // as 'copy' for any non-locked track with supported data types.
      const sequence: Sequence = {
        ...createMockSequence(2),
        tracks: [
          createMockTrack('track-0', false, 'video'),
          createMockTrack('track-1', false, 'audio'),
        ],
      };

      const { result } = renderHook(() =>
        useAssetDrop({
          ...defaultOptions,
          sequence,
        }),
      );

      const event = createMockDragEvent('dragover', {
        clientY: 90,
        dataTransferData: {
          'application/json': JSON.stringify({ id: 'asset-1', kind: 'image' }),
        },
      });

      act(() => {
        result.current.handleDragOver(event);
      });

      expect(event.dataTransfer.dropEffect).toBe('copy');
    });
  });

  describe('handleDragLeave', () => {
    it('should set isDraggingOver to false when drag counter reaches 0', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const enterEvent = createMockDragEvent('dragenter');
      const leaveEvent = createMockDragEvent('dragleave');

      act(() => {
        result.current.handleDragEnter(enterEvent);
      });
      expect(result.current.isDraggingOver).toBe(true);

      act(() => {
        result.current.handleDragLeave(leaveEvent);
      });
      expect(result.current.isDraggingOver).toBe(false);
    });

    it('should handle nested drag enter/leave correctly', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));
      const enterEvent = createMockDragEvent('dragenter');
      const leaveEvent = createMockDragEvent('dragleave');

      // Simulate entering parent then child
      act(() => {
        result.current.handleDragEnter(enterEvent);
        result.current.handleDragEnter(enterEvent);
      });
      expect(result.current.isDraggingOver).toBe(true);

      // Leave child
      act(() => {
        result.current.handleDragLeave(leaveEvent);
      });
      expect(result.current.isDraggingOver).toBe(true);

      // Leave parent
      act(() => {
        result.current.handleDragLeave(leaveEvent);
      });
      expect(result.current.isDraggingOver).toBe(false);
    });
  });

  describe('handleDrop', () => {
    it('should call onAssetDrop with correct data', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        clientX: 300, // 300 - 100 (rect.left) - 100 (trackHeaderWidth) = 100px = 1s at zoom 100
        clientY: 30, // trackIndex 0
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith({
        assetId: 'asset-1',
        trackId: 'track-0',
        timelinePosition: 1, // 100px / 100 zoom
      });
    });

    it('should resolve the exact target track using DOM row hit-testing', () => {
      const sequence: Sequence = {
        ...createMockSequence(2),
        tracks: [createMockTrack('track-0'), createMockTrack('track-1')],
      };

      const onAssetDrop = vi.fn();
      const { result } = renderHook(() =>
        useAssetDrop({
          ...defaultOptions,
          sequence,
          onAssetDrop,
        }),
      );

      const currentTarget = createTrackRowContainer([
        { trackId: 'track-0', top: 0, height: 48 },
        { trackId: 'track-1', top: 48, height: 64 },
      ]);

      const event = createMockDragEvent('drop', {
        clientX: 300,
        clientY: 52, // Inside second row (48-112), but would map to track-0 with fixed 64px math
        currentTarget,
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          trackId: 'track-1',
        }),
      );
    });

    it('should handle text/plain data format', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        dataTransferTypes: ['text/plain'],
        dataTransferData: { 'text/plain': 'asset-2' },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'asset-2' }));
    });

    it('should pass workspaceRelativePath for workspace file drops', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        dataTransferTypes: ['application/json', 'application/x-workspace-file'],
        dataTransferData: {
          'application/json': JSON.stringify({
            workspaceRelativePath: 'footage/interview.mp4',
            kind: 'video',
          }),
          'application/x-workspace-file': 'footage/interview.mp4',
        },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRelativePath: 'footage/interview.mp4',
          assetKind: 'video',
        }),
      );
    });

    it('should parse workspace file payload without JSON metadata', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        dataTransferTypes: ['application/x-workspace-file'],
        dataTransferData: {
          'application/x-workspace-file': 'audio/voiceover.wav',
        },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRelativePath: 'audio/voiceover.wav',
        }),
      );
    });

    it('should not call onAssetDrop when dropping on locked track', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        clientY: 90, // trackIndex 1 which is locked
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).not.toHaveBeenCalled();
    });

    it('should not call onAssetDrop when image is dropped on audio track', () => {
      const sequence: Sequence = {
        ...createMockSequence(2),
        tracks: [
          createMockTrack('track-0', false, 'video'),
          createMockTrack('track-1', false, 'audio'),
        ],
      };

      const onAssetDrop = vi.fn();
      const { result } = renderHook(() =>
        useAssetDrop({
          ...defaultOptions,
          sequence,
          onAssetDrop,
        }),
      );

      const event = createMockDragEvent('drop', {
        clientY: 90, // track-1 (audio)
        dataTransferData: {
          'application/json': JSON.stringify({ id: 'asset-1', kind: 'image' }),
        },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).not.toHaveBeenCalled();
    });

    it('should not call onAssetDrop when sequence is null', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() =>
        useAssetDrop({ ...defaultOptions, sequence: null, onAssetDrop }),
      );

      const event = createMockDragEvent('drop');

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).not.toHaveBeenCalled();
    });

    it('should not call onAssetDrop when onAssetDrop is undefined', () => {
      const { result } = renderHook(() =>
        useAssetDrop({ ...defaultOptions, onAssetDrop: undefined }),
      );

      // Simulate a drag enter first to set isDraggingOver=true
      const enterEvent = createMockDragEvent('dragenter');
      act(() => {
        result.current.handleDragEnter(enterEvent);
      });
      expect(result.current.isDraggingOver).toBe(true);

      const event = createMockDragEvent('drop');

      act(() => {
        result.current.handleDrop(event);
      });

      // Verify drop was handled (preventDefault called) and drag state was reset
      expect(event.preventDefault).toHaveBeenCalled();
      expect(result.current.isDraggingOver).toBe(false);
    });

    it('should handle invalid JSON data gracefully', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        dataTransferData: { 'application/json': 'invalid json' },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).not.toHaveBeenCalled();
    });

    it('should handle missing asset id gracefully', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        dataTransferData: { 'application/json': JSON.stringify({ name: 'test' }) },
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).not.toHaveBeenCalled();
    });

    it('should reset isDraggingOver after drop', () => {
      const { result } = renderHook(() => useAssetDrop(defaultOptions));

      // Enter drag state
      act(() => {
        result.current.handleDragEnter(createMockDragEvent('dragenter'));
      });
      expect(result.current.isDraggingOver).toBe(true);

      // Drop
      act(() => {
        result.current.handleDrop(createMockDragEvent('drop'));
      });
      expect(result.current.isDraggingOver).toBe(false);
    });

    it('should account for scroll offset in position calculation', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() =>
        useAssetDrop({
          ...defaultOptions,
          scrollX: 200,
          scrollY: 0, // No vertical scroll for simpler calculation
          onAssetDrop,
        }),
      );

      const event = createMockDragEvent('drop', {
        clientX: 300,
        clientY: 30, // Track 0 (30 / 60 = 0)
      });

      act(() => {
        result.current.handleDrop(event);
      });

      // Position: (300 - 100 (rect.left) - 100 (trackHeaderWidth) + 200 (scrollX)) / 100 (zoom) = 3
      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          timelinePosition: 3,
          trackId: 'track-0',
        }),
      );
    });

    it('should clamp timeline position to 0 minimum', () => {
      const onAssetDrop = vi.fn();
      const { result } = renderHook(() => useAssetDrop({ ...defaultOptions, onAssetDrop }));

      const event = createMockDragEvent('drop', {
        clientX: 50, // Before track header, would result in negative position
      });

      act(() => {
        result.current.handleDrop(event);
      });

      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          timelinePosition: 0,
        }),
      );
    });
  });
});
