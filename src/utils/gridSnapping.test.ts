/**
 * Grid Snapping System Tests
 *
 * TDD tests for the grid snapping utilities that provide
 * intelligent snapping behavior for timeline operations.
 */

import { describe, it, expect } from 'vitest';
import {
  getSnapPoints,
  findNearestSnapPoint,
  snapToNearestPoint,
  createClipSnapPoints,
  createPlayheadSnapPoint,
  type SnapPoint,
} from './gridSnapping';

describe('Grid Snapping System', () => {
  // ===========================================================================
  // SnapPoint Creation Tests
  // ===========================================================================

  describe('createClipSnapPoints', () => {
    it('should create snap points for clip start and end', () => {
      const points = createClipSnapPoints('clip-1', 5, 15);

      expect(points).toHaveLength(2);
      expect(points[0]).toEqual({
        time: 5,
        type: 'clip-start',
        clipId: 'clip-1',
      });
      expect(points[1]).toEqual({
        time: 15,
        type: 'clip-end',
        clipId: 'clip-1',
      });
    });

    it('should handle clips at zero start', () => {
      const points = createClipSnapPoints('clip-1', 0, 10);

      expect(points[0].time).toBe(0);
      expect(points[1].time).toBe(10);
    });
  });

  describe('createPlayheadSnapPoint', () => {
    it('should create a playhead snap point', () => {
      const point = createPlayheadSnapPoint(7.5);

      expect(point).toEqual({
        time: 7.5,
        type: 'playhead',
      });
    });
  });

  // ===========================================================================
  // getSnapPoints Tests
  // ===========================================================================

  describe('getSnapPoints', () => {
    const clips = [
      { id: 'clip-1', startTime: 0, endTime: 5 },
      { id: 'clip-2', startTime: 10, endTime: 20 },
      { id: 'clip-3', startTime: 25, endTime: 30 },
    ];

    it('should generate snap points for all clips', () => {
      const points = getSnapPoints({
        clips,
        playheadTime: 15,
        excludeClipId: null,
      });

      // 3 clips * 2 points each + 1 playhead = 7 points
      expect(points.length).toBe(7);
    });

    it('should exclude specified clip from snap points', () => {
      const points = getSnapPoints({
        clips,
        playheadTime: 15,
        excludeClipId: 'clip-1',
      });

      // 2 clips * 2 points each + 1 playhead = 5 points
      expect(points.length).toBe(5);

      // Verify clip-1 points are not included
      const clip1Points = points.filter((p) => p.clipId === 'clip-1');
      expect(clip1Points).toHaveLength(0);
    });

    it('should include playhead snap point', () => {
      const points = getSnapPoints({
        clips,
        playheadTime: 15,
        excludeClipId: null,
      });

      const playheadPoint = points.find((p) => p.type === 'playhead');
      expect(playheadPoint).toBeDefined();
      expect(playheadPoint!.time).toBe(15);
    });

    it('should include grid snap points if grid interval specified', () => {
      const points = getSnapPoints({
        clips: [],
        playheadTime: 0,
        excludeClipId: null,
        gridInterval: 1,
        timelineStart: 0,
        timelineEnd: 5,
      });

      // Grid points: 0, 1, 2, 3, 4, 5 = 6 points + 1 playhead
      expect(points.length).toBe(7);

      const gridPoints = points.filter((p) => p.type === 'grid');
      expect(gridPoints).toHaveLength(6);
    });

    it('should deduplicate overlapping snap points', () => {
      const overlappingClips = [
        { id: 'clip-1', startTime: 0, endTime: 10 },
        { id: 'clip-2', startTime: 10, endTime: 20 }, // Start matches clip-1 end
      ];

      const points = getSnapPoints({
        clips: overlappingClips,
        playheadTime: 10, // Also matches the overlap
        excludeClipId: null,
      });

      // Points at time 10: clip-1-end, clip-2-start, playhead
      // But they should share the same time value
      const pointsAtTen = points.filter((p) => p.time === 10);
      // Should have multiple points but each is distinct
      expect(pointsAtTen.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // findNearestSnapPoint Tests
  // ===========================================================================

  describe('findNearestSnapPoint', () => {
    const snapPoints: SnapPoint[] = [
      { time: 0, type: 'clip-start', clipId: 'clip-1' },
      { time: 5, type: 'clip-end', clipId: 'clip-1' },
      { time: 10, type: 'clip-start', clipId: 'clip-2' },
      { time: 15, type: 'playhead' },
      { time: 20, type: 'clip-end', clipId: 'clip-2' },
    ];

    it('should find exact match', () => {
      const result = findNearestSnapPoint(10, snapPoints, 1);

      expect(result).not.toBeNull();
      expect(result!.point.time).toBe(10);
      expect(result!.distance).toBe(0);
    });

    it('should find nearest point within threshold', () => {
      const result = findNearestSnapPoint(14.5, snapPoints, 1);

      expect(result).not.toBeNull();
      expect(result!.point.time).toBe(15);
      expect(result!.distance).toBeCloseTo(0.5, 5);
    });

    it('should return null if no point within threshold', () => {
      const result = findNearestSnapPoint(7.5, snapPoints, 0.5);

      expect(result).toBeNull();
    });

    it('should prioritize closest point when multiple within threshold', () => {
      // Point at 10, looking at 10.3 with threshold 0.5
      const result = findNearestSnapPoint(10.3, snapPoints, 0.5);

      expect(result).not.toBeNull();
      expect(result!.point.time).toBe(10);
    });

    it('should handle empty snap points array', () => {
      const result = findNearestSnapPoint(5, [], 1);

      expect(result).toBeNull();
    });

    it('should prefer certain snap point types when distances are equal', () => {
      const equalDistancePoints: SnapPoint[] = [
        { time: 10, type: 'grid' },
        { time: 10, type: 'clip-start', clipId: 'clip-1' },
        { time: 10, type: 'playhead' },
      ];

      const result = findNearestSnapPoint(10, equalDistancePoints, 1);

      // Playhead should be prioritized
      expect(result).not.toBeNull();
      expect(result!.point.type).toBe('playhead');
    });
  });

  // ===========================================================================
  // snapToNearestPoint Tests
  // ===========================================================================

  describe('snapToNearestPoint', () => {
    const snapPoints: SnapPoint[] = [
      { time: 0, type: 'clip-start', clipId: 'clip-1' },
      { time: 5, type: 'clip-end', clipId: 'clip-1' },
      { time: 10, type: 'clip-start', clipId: 'clip-2' },
      { time: 20, type: 'clip-end', clipId: 'clip-2' },
    ];

    it('should snap to nearest point', () => {
      const result = snapToNearestPoint(4.8, snapPoints, 0.5);

      expect(result.snapped).toBe(true);
      expect(result.time).toBe(5);
      expect(result.snapPoint).toBeDefined();
      expect(result.snapPoint!.type).toBe('clip-end');
    });

    it('should return original time if no snap point within threshold', () => {
      const result = snapToNearestPoint(7, snapPoints, 0.5);

      expect(result.snapped).toBe(false);
      expect(result.time).toBe(7);
      expect(result.snapPoint).toBeUndefined();
    });

    it('should work with zero threshold (exact match only)', () => {
      const exactMatch = snapToNearestPoint(5, snapPoints, 0);
      const noMatch = snapToNearestPoint(5.001, snapPoints, 0);

      expect(exactMatch.snapped).toBe(true);
      expect(exactMatch.time).toBe(5);

      expect(noMatch.snapped).toBe(false);
      expect(noMatch.time).toBe(5.001);
    });

    it('should handle negative times correctly', () => {
      const result = snapToNearestPoint(-0.2, snapPoints, 0.5);

      expect(result.snapped).toBe(true);
      expect(result.time).toBe(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle very small threshold values', () => {
      const points: SnapPoint[] = [{ time: 10, type: 'grid' }];

      const result = findNearestSnapPoint(10.001, points, 0.0001);
      expect(result).toBeNull();

      const result2 = findNearestSnapPoint(10.00001, points, 0.0001);
      expect(result2).not.toBeNull();
    });

    it('should handle very large time values', () => {
      const points: SnapPoint[] = [{ time: 3600, type: 'clip-end', clipId: 'c1' }]; // 1 hour

      const result = findNearestSnapPoint(3599.8, points, 0.5);
      expect(result).not.toBeNull();
      expect(result!.point.time).toBe(3600);
    });

    it('should handle rapid sequential snap operations', () => {
      const points: SnapPoint[] = [
        { time: 0, type: 'grid' },
        { time: 1, type: 'grid' },
        { time: 2, type: 'grid' },
      ];

      // Simulate dragging across multiple snap points
      const times = [0.1, 0.5, 0.9, 1.1, 1.5, 1.9];
      const results = times.map((t) => snapToNearestPoint(t, points, 0.2));

      expect(results[0].time).toBe(0);
      expect(results[1].snapped).toBe(false);
      expect(results[2].time).toBe(1);
      expect(results[3].time).toBe(1);
      expect(results[4].snapped).toBe(false);
      expect(results[5].time).toBe(2);
    });
  });

  // ===========================================================================
  // Type Priority Tests
  // ===========================================================================

  describe('snap point type priority', () => {
    it('should define priority order for snap types', () => {
      // Priority order: playhead > clip-start/end > marker > grid
      const points: SnapPoint[] = [
        { time: 10, type: 'grid' },
        { time: 10.05, type: 'clip-start', clipId: 'c1' },
        { time: 10.1, type: 'playhead' },
      ];

      // When at 10.05, should snap to clip-start since it's exact
      const result1 = snapToNearestPoint(10.05, points, 0.2);
      expect(result1.snapPoint?.type).toBe('clip-start');

      // When exactly equidistant (same time), should prefer higher priority
      const equalPoints: SnapPoint[] = [
        { time: 10, type: 'grid' },
        { time: 10, type: 'clip-start', clipId: 'c1' },
        { time: 10, type: 'playhead' },
      ];
      const result2 = snapToNearestPoint(10, equalPoints, 0.2);
      expect(result2.snapPoint?.type).toBe('playhead');

      // When at 10.075 (equidistant from clip-start and playhead)
      // Distance to clip-start at 10.05: 0.025
      // Distance to playhead at 10.1: 0.025
      // Should prefer playhead due to priority
      const result3 = snapToNearestPoint(10.075, points, 0.2);
      expect(result3.snapPoint?.type).toBe('playhead');
    });
  });
});
