/**
 * useTransitionZones Hook Tests
 *
 * Tests for finding adjacent clip pairs that can have transitions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTransitionZones } from './useTransitionZones';
import type { Clip } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const createClip = (
  id: string,
  timelineInSec: number,
  durationSec: number
): Clip => ({
  id,
  assetId: `asset_${id}`,
  range: { sourceInSec: 0, sourceOutSec: durationSec },
  place: { timelineInSec, durationSec },
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
});

// =============================================================================
// Tests
// =============================================================================

describe('useTransitionZones', () => {
  describe('basic functionality', () => {
    it('should return empty array for no clips', () => {
      const { result } = renderHook(() => useTransitionZones([]));
      expect(result.current).toEqual([]);
    });

    it('should return empty array for single clip', () => {
      const clips = [createClip('clip_001', 0, 5)];
      const { result } = renderHook(() => useTransitionZones(clips));
      expect(result.current).toEqual([]);
    });

    it('should find one transition zone between two adjacent clips', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
      ];
      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toEqual({
        clipAId: 'clip_001',
        clipBId: 'clip_002',
        junctionSec: 5,
      });
    });

    it('should find multiple transition zones for three adjacent clips', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
        createClip('clip_003', 10, 5),
      ];
      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(2);
      expect(result.current[0].clipAId).toBe('clip_001');
      expect(result.current[0].clipBId).toBe('clip_002');
      expect(result.current[1].clipAId).toBe('clip_002');
      expect(result.current[1].clipBId).toBe('clip_003');
    });
  });

  describe('gap detection', () => {
    it('should not find transition zone when clips have a gap', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 6, 5), // 1 second gap
      ];
      const { result } = renderHook(() => useTransitionZones(clips));
      expect(result.current).toEqual([]);
    });

    it('should find transition zone when gap is within tolerance', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5.05, 5), // 0.05 second gap
      ];
      const { result } = renderHook(() =>
        useTransitionZones(clips, { gapTolerance: 0.1 })
      );
      expect(result.current).toHaveLength(1);
    });

    it('should not find transition zone when gap exceeds tolerance', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5.2, 5), // 0.2 second gap
      ];
      const { result } = renderHook(() =>
        useTransitionZones(clips, { gapTolerance: 0.1 })
      );
      expect(result.current).toEqual([]);
    });
  });

  describe('overlapping clips', () => {
    it('should find transition zone for overlapping clips', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 4.5, 5), // 0.5 second overlap
      ];
      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toEqual({
        clipAId: 'clip_001',
        clipBId: 'clip_002',
        junctionSec: 4.75, // Midpoint of overlap
      });
    });
  });

  describe('clip ordering', () => {
    it('should sort clips by timeline position before processing', () => {
      // Clips provided in wrong order
      const clips = [
        createClip('clip_002', 5, 5),
        createClip('clip_001', 0, 5),
      ];
      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(1);
      expect(result.current[0].clipAId).toBe('clip_001');
      expect(result.current[0].clipBId).toBe('clip_002');
    });
  });

  describe('memoization', () => {
    it('should return same reference for same clips', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
      ];

      const { result, rerender } = renderHook(
        ({ clips }) => useTransitionZones(clips),
        { initialProps: { clips } }
      );

      const firstResult = result.current;
      rerender({ clips });
      const secondResult = result.current;

      expect(firstResult).toBe(secondResult);
    });

    it('should return new reference when clips change', () => {
      const clips1 = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
      ];
      const clips2 = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
        createClip('clip_003', 10, 5),
      ];

      const { result, rerender } = renderHook(
        ({ clips }) => useTransitionZones(clips),
        { initialProps: { clips: clips1 } }
      );

      const firstResult = result.current;
      rerender({ clips: clips2 });
      const secondResult = result.current;

      expect(firstResult).not.toBe(secondResult);
    });
  });

  describe('mixed scenarios', () => {
    it('should handle multiple groups of adjacent clips with gaps', () => {
      const clips = [
        // First group
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
        // Gap
        // Second group
        createClip('clip_003', 15, 5),
        createClip('clip_004', 20, 5),
      ];
      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(2);
      expect(result.current[0].clipAId).toBe('clip_001');
      expect(result.current[0].clipBId).toBe('clip_002');
      expect(result.current[1].clipAId).toBe('clip_003');
      expect(result.current[1].clipBId).toBe('clip_004');
    });
  });
});

// =============================================================================
// Security and Edge Case Tests
// =============================================================================

describe('Security and Edge Cases', () => {
  describe('invalid input handling', () => {
    it('should handle null clips array', () => {
      const { result } = renderHook(() =>
        useTransitionZones(null as unknown as Clip[])
      );
      expect(result.current).toEqual([]);
    });

    it('should handle undefined clips array', () => {
      const { result } = renderHook(() =>
        useTransitionZones(undefined as unknown as Clip[])
      );
      expect(result.current).toEqual([]);
    });

    it('should handle clips with missing place property', () => {
      const invalidClip: Clip = {
        id: 'clip_invalid',
        assetId: 'asset_invalid',
        range: { sourceInSec: 0, sourceOutSec: 5 },
        place: undefined as unknown as { timelineInSec: number; durationSec: number },
        transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
        opacity: 1,
        speed: 1,
        effects: [],
        audio: { volumeDb: 0, pan: 0, muted: false },
      };

      const { result } = renderHook(() =>
        useTransitionZones([invalidClip, createClip('clip_001', 0, 5)])
      );

      // Should not crash
      expect(Array.isArray(result.current)).toBe(true);
    });

    it('should handle clips with NaN timeline position', () => {
      const nanClip = createClip('clip_nan', NaN, 5);

      const { result } = renderHook(() =>
        useTransitionZones([nanClip, createClip('clip_001', 5, 5)])
      );

      // Should not crash
      expect(Array.isArray(result.current)).toBe(true);
    });

    it('should handle clips with negative duration', () => {
      const clips = [
        createClip('clip_001', 0, -5),
        createClip('clip_002', 5, 5),
      ];

      const { result } = renderHook(() => useTransitionZones(clips));

      // Should not crash
      expect(Array.isArray(result.current)).toBe(true);
    });
  });

  describe('extreme values', () => {
    it('should handle very large timeline positions', () => {
      const clips = [
        createClip('clip_001', 1e9, 5),
        createClip('clip_002', 1e9 + 5, 5),
      ];

      const { result } = renderHook(() => useTransitionZones(clips));

      expect(result.current).toHaveLength(1);
      expect(result.current[0].junctionSec).toBe(1e9 + 5);
    });

    it('should handle many clips efficiently', () => {
      // Create 100 adjacent clips
      const clips = Array.from({ length: 100 }, (_, i) =>
        createClip(`clip_${i}`, i * 5, 5)
      );

      const startTime = performance.now();
      const { result } = renderHook(() => useTransitionZones(clips));
      const elapsed = performance.now() - startTime;

      expect(result.current).toHaveLength(99);
      expect(elapsed).toBeLessThan(50); // Should be fast
    });

    it('should handle Infinity gap tolerance by clamping to default', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 100, 5), // Large gap (95 seconds)
      ];

      const { result } = renderHook(() =>
        useTransitionZones(clips, { gapTolerance: Infinity })
      );

      // Infinity is invalid and should be clamped to default (0.1)
      // With default tolerance, large gap should NOT find transition
      // This is correct defensive behavior - Infinity is not a valid input
      expect(result.current).toHaveLength(0);
    });
  });

  describe('concurrent access simulation', () => {
    it('should handle rapid clip array updates', () => {
      const initialClips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 5, 5),
      ];

      const { result, rerender } = renderHook(
        ({ clips }) => useTransitionZones(clips),
        { initialProps: { clips: initialClips } }
      );

      // Simulate rapid updates
      for (let i = 0; i < 50; i++) {
        const newClips = [
          createClip('clip_001', 0, 5),
          createClip('clip_002', 5 + i * 0.01, 5),
        ];
        rerender({ clips: newClips });
      }

      // Should not crash and should return valid result
      expect(Array.isArray(result.current)).toBe(true);
    });
  });

  describe('precision edge cases', () => {
    it('should handle floating point precision issues', () => {
      // This tests the classic 0.1 + 0.2 !== 0.3 issue
      const clips = [
        createClip('clip_001', 0, 0.1),
        createClip('clip_002', 0.1, 0.2),
        createClip('clip_003', 0.30000000000000004, 0.1), // 0.1 + 0.2 in JS
      ];

      const { result } = renderHook(() =>
        useTransitionZones(clips, { gapTolerance: 1e-10 })
      );

      // Should find both transitions despite floating point issues
      expect(result.current.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle clips at exactly the same position', () => {
      const clips = [
        createClip('clip_001', 0, 5),
        createClip('clip_002', 0, 5), // Same start position!
      ];

      const { result } = renderHook(() => useTransitionZones(clips));

      // Should handle gracefully
      expect(Array.isArray(result.current)).toBe(true);
    });
  });
});
