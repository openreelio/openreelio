/**
 * useSnapDetection Tests
 *
 * Tests snap point detection including the zero-zoom division guard fix.
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSnapDetection } from './useSnapDetection';

describe('useSnapDetection', () => {
  const defaultOptions = {
    enabled: true,
    zoom: 100,
    scrollX: 0,
    playheadTime: 5,
    clipEdges: [0, 10, 10, 20],
    threshold: 10,
  };

  describe('findSnapPoint', () => {
    it('should return snapped time when near a snap point', () => {
      const { result } = renderHook(() => useSnapDetection(defaultOptions));

      const { snappedTime, snapPoint } = result.current.findSnapPoint(4.95);
      expect(snappedTime).toBe(5); // Snaps to playhead
      expect(snapPoint).not.toBeNull();
      expect(snapPoint?.type).toBe('playhead');
    });

    it('should return original time when not near any snap point', () => {
      const { result } = renderHook(() => useSnapDetection(defaultOptions));

      const { snappedTime, snapPoint } = result.current.findSnapPoint(7.5);
      expect(snappedTime).toBe(7.5);
      expect(snapPoint).toBeNull();
    });

    it('should return original time when snapping disabled', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, enabled: false }),
      );

      const { snappedTime, snapPoint } = result.current.findSnapPoint(5.01);
      expect(snappedTime).toBe(5.01);
      expect(snapPoint).toBeNull();
    });

    it('should exclude specified times from snap candidates', () => {
      const { result } = renderHook(() => useSnapDetection(defaultOptions));

      // Exclude the playhead time (5); 4.99 is not close enough to clip edges
      // (0, 10) within threshold/zoom = 10/100 = 0.1, so no snap occurs
      const { snappedTime, snapPoint } = result.current.findSnapPoint(4.99, [5]);
      expect(snappedTime).toBe(4.99);
      expect(snapPoint).toBeNull();
    });

    it('should snap to clip edges', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, playheadTime: 50 }),
      );

      const { snappedTime, snapPoint } = result.current.findSnapPoint(9.95);
      expect(snappedTime).toBe(10);
      expect(snapPoint?.type).toBe('clip-start');
    });

    it('should snap to marker times', () => {
      const { result } = renderHook(() =>
        useSnapDetection({
          ...defaultOptions,
          markerTimes: [15],
          playheadTime: 50,
        }),
      );

      const { snappedTime } = result.current.findSnapPoint(14.95);
      expect(snappedTime).toBe(15);
    });
  });

  describe('zero zoom guard', () => {
    it('should not throw or produce Infinity when zoom is 0', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, zoom: 0 }),
      );

      // Should not throw
      const { snappedTime } = result.current.findSnapPoint(5.01);
      expect(Number.isFinite(snappedTime)).toBe(true);
    });

    it('should not throw when zoom is negative', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, zoom: -1 }),
      );

      const { snappedTime } = result.current.findSnapPoint(5.01);
      expect(Number.isFinite(snappedTime)).toBe(true);
    });

    it('should work normally with positive zoom', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, zoom: 200 }),
      );

      const { snappedTime, snapPoint } = result.current.findSnapPoint(4.98);
      expect(snappedTime).toBe(5);
      expect(snapPoint).not.toBeNull();
    });
  });

  describe('getAllSnapPoints', () => {
    it('should return empty array when disabled', () => {
      const { result } = renderHook(() =>
        useSnapDetection({ ...defaultOptions, enabled: false }),
      );

      const points = result.current.getAllSnapPoints();
      expect(points).toEqual([]);
    });

    it('should include playhead, clip edges, and markers', () => {
      const { result } = renderHook(() =>
        useSnapDetection({
          ...defaultOptions,
          markerTimes: [7.5],
        }),
      );

      const points = result.current.getAllSnapPoints();
      const types = points.map((p) => p.type);
      expect(types).toContain('playhead');
      expect(types).toContain('clip-start');
      expect(types).toContain('marker');
    });

    it('should include grid snap points when gridInterval specified', () => {
      const { result } = renderHook(() =>
        useSnapDetection({
          ...defaultOptions,
          gridInterval: 1,
        }),
      );

      const points = result.current.getAllSnapPoints();
      const gridPoints = points.filter((p) => p.type === 'grid');
      expect(gridPoints.length).toBeGreaterThan(0);
    });

    it('should not include grid points when gridInterval is 0', () => {
      const { result } = renderHook(() =>
        useSnapDetection({
          ...defaultOptions,
          gridInterval: 0,
        }),
      );

      const points = result.current.getAllSnapPoints();
      const gridPoints = points.filter((p) => p.type === 'grid');
      expect(gridPoints).toHaveLength(0);
    });
  });
});
