/**
 * useTimelineCoordinates Hook Tests
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useTimelineCoordinates } from './useTimelineCoordinates';
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

const createMockRef = (element: HTMLDivElement | null = null) => ({
  current: element,
});

const createMockElement = (rect: DOMRect): HTMLDivElement => {
  const element = document.createElement('div');
  element.getBoundingClientRect = vi.fn().mockReturnValue(rect);
  return element;
};

// =============================================================================
// Tests
// =============================================================================

describe('useTimelineCoordinates', () => {
  const defaultRect: DOMRect = {
    left: 100,
    top: 0,
    width: 800,
    height: 200,
    right: 900,
    bottom: 200,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  };

  const createDefaultOptions = () => ({
    tracksAreaRef: createMockRef(createMockElement(defaultRect)),
    sequence: createMockSequence(),
    zoom: 100,
    scrollX: 0,
    duration: 60,
    snapEnabled: true,
    playhead: 0,
    trackHeaderWidth: 100,
  });

  describe('gridInterval', () => {
    it('should return appropriate grid interval for zoom 100', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 100 })
      );
      expect(result.current.gridInterval).toBe(0.25); // QUARTER_SECOND
    });

    it('should return finer grid interval for higher zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 500 })
      );
      expect(result.current.gridInterval).toBe(1 / 30); // FRAME_30FPS
    });

    it('should return coarser grid interval for lower zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 10 })
      );
      expect(result.current.gridInterval).toBe(5); // FIVE_SECONDS
    });
  });

  describe('snapPoints', () => {
    it('should return empty array when snapEnabled is false', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), snapEnabled: false })
      );
      expect(result.current.snapPoints).toEqual([]);
    });

    it('should return empty array when sequence is null', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), sequence: null })
      );
      expect(result.current.snapPoints).toEqual([]);
    });

    it('should include playhead snap point', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), playhead: 5 })
      );
      const playheadPoint = result.current.snapPoints.find(
        (p) => p.type === 'playhead'
      );
      expect(playheadPoint).toBeDefined();
      expect(playheadPoint?.time).toBe(5);
    });

    it('should include clip start and end snap points', () => {
      const clips = [[createMockClip('clip-1', 2, 3)]];
      const { result } = renderHook(() =>
        useTimelineCoordinates({
          ...createDefaultOptions(),
          sequence: createMockSequence(clips),
        })
      );

      const clipStartPoint = result.current.snapPoints.find(
        (p) => p.type === 'clip-start' && p.time === 2
      );
      const clipEndPoint = result.current.snapPoints.find(
        (p) => p.type === 'clip-end' && p.time === 5
      );

      expect(clipStartPoint).toBeDefined();
      expect(clipEndPoint).toBeDefined();
    });

    it('should include grid snap points', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), duration: 10 })
      );

      const gridPoints = result.current.snapPoints.filter(
        (p) => p.type === 'grid'
      );
      expect(gridPoints.length).toBeGreaterThan(0);
    });
  });

  describe('snapThreshold', () => {
    it('should calculate threshold based on zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 100 })
      );
      expect(result.current.snapThreshold).toBe(0.1); // 10px / 100 zoom
    });

    it('should have smaller threshold at higher zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 500 })
      );
      expect(result.current.snapThreshold).toBe(0.02); // 10px / 500 zoom
    });
  });

  describe('timeToPixel', () => {
    it('should convert time to pixel position', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 100 })
      );
      expect(result.current.timeToPixel(5)).toBe(500);
    });

    it('should scale with zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 200 })
      );
      expect(result.current.timeToPixel(5)).toBe(1000);
    });
  });

  describe('pixelToTime', () => {
    it('should convert pixel position to time', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 100 })
      );
      expect(result.current.pixelToTime(500)).toBe(5);
    });

    it('should scale with zoom', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), zoom: 200 })
      );
      expect(result.current.pixelToTime(1000)).toBe(5);
    });
  });

  describe('calculateTimeFromMouseEvent', () => {
    it('should return null time when ref is null', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({
          ...createDefaultOptions(),
          tracksAreaRef: createMockRef(null),
        })
      );

      const event = { clientX: 300 } as MouseEvent;
      const { time, snapPoint } = result.current.calculateTimeFromMouseEvent(
        event,
        false
      );

      expect(time).toBeNull();
      expect(snapPoint).toBeNull();
    });

    it('should calculate time from mouse position', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates(createDefaultOptions())
      );

      // clientX = 300, rect.left = 100, trackHeaderWidth = 100, scrollX = 0
      // relativeX = 300 - 100 - 100 + 0 = 100
      // time = 100 / 100 = 1
      const event = { clientX: 300 } as MouseEvent;
      const { time } = result.current.calculateTimeFromMouseEvent(event, false);

      expect(time).toBe(1);
    });

    it('should clamp time to 0 minimum', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates(createDefaultOptions())
      );

      const event = { clientX: 50 } as MouseEvent;
      const { time } = result.current.calculateTimeFromMouseEvent(event, false);

      expect(time).toBe(0);
    });

    it('should clamp time to duration maximum', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), duration: 10 })
      );

      const event = { clientX: 5000 } as MouseEvent;
      const { time } = result.current.calculateTimeFromMouseEvent(event, false);

      expect(time).toBe(10);
    });

    it('should account for scroll offset', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({ ...createDefaultOptions(), scrollX: 200 })
      );

      // clientX = 300, rect.left = 100, trackHeaderWidth = 100, scrollX = 200
      // relativeX = 300 - 100 - 100 + 200 = 300
      // time = 300 / 100 = 3
      const event = { clientX: 300 } as MouseEvent;
      const { time } = result.current.calculateTimeFromMouseEvent(event, false);

      expect(time).toBe(3);
    });

    it('should not apply snapping when applySnapping is false', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({
          ...createDefaultOptions(),
          playhead: 1, // Close to calculated time of 1
        })
      );

      const event = { clientX: 305 } as MouseEvent; // Would be ~1.05 seconds
      const { snapPoint } = result.current.calculateTimeFromMouseEvent(
        event,
        false
      );

      expect(snapPoint).toBeNull();
    });

    it('should apply snapping when applySnapping is true and close to snap point', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({
          ...createDefaultOptions(),
          playhead: 1,
        })
      );

      // clientX = 305, relativeX = 105, time = 1.05
      // Playhead at 1, threshold = 0.1 (10px/100zoom)
      // 1.05 is within 0.1 of playhead at 1
      const event = { clientX: 305 } as MouseEvent;
      const { time, snapPoint } = result.current.calculateTimeFromMouseEvent(
        event,
        true
      );

      expect(time).toBe(1); // Snapped to playhead
      expect(snapPoint).toBeDefined();
      expect(snapPoint?.type).toBe('playhead');
    });

    it('should not snap when too far from snap points', () => {
      const { result } = renderHook(() =>
        useTimelineCoordinates({
          ...createDefaultOptions(),
          playhead: 0,
        })
      );

      // clientX = 600, relativeX = 400, time = 4
      // Playhead at 0, threshold = 0.1
      // 4 is not within 0.1 of playhead at 0 (or any grid point near 4)
      const event = { clientX: 600 } as MouseEvent;
      const { snapPoint } = result.current.calculateTimeFromMouseEvent(
        event,
        true
      );

      // May snap to grid, but not to playhead
      if (snapPoint) {
        expect(snapPoint.type).not.toBe('playhead');
      }
    });
  });

  describe('memoization', () => {
    it('should memoize gridInterval', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(() =>
        useTimelineCoordinates(options)
      );

      const initialGridInterval = result.current.gridInterval;
      rerender();
      expect(result.current.gridInterval).toBe(initialGridInterval);
    });

    it('should update gridInterval when zoom changes', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(
        (props) => useTimelineCoordinates(props),
        { initialProps: options }
      );

      const initialGridInterval = result.current.gridInterval;
      rerender({ ...options, zoom: 500 });
      expect(result.current.gridInterval).not.toBe(initialGridInterval);
    });

    it('should memoize snapPoints', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(() =>
        useTimelineCoordinates(options)
      );

      const initialSnapPoints = result.current.snapPoints;
      rerender();
      expect(result.current.snapPoints).toBe(initialSnapPoints);
    });
  });
});
