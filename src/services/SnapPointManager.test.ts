/**
 * SnapPointManager Tests
 *
 * Tests for the optimized snap point management service.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SnapPointManager } from './SnapPointManager';
import type { Clip, Sequence, Track } from '@/types';

// Helper to create a mock clip
function createMockClip(id: string, startTime: number, duration: number): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    place: { timelineInSec: startTime, trackId: 'track-1' },
    range: { sourceInSec: 0, sourceOutSec: duration },
    speed: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, muted: false },
  } as unknown as Clip;
}

// Helper to create a mock sequence
function createMockSequence(clips: Clip[]): Sequence {
  const track: Track = {
    id: 'track-1',
    name: 'Track 1',
    kind: 'video',
    clips,
    volume: 1,
    muted: false,
    locked: false,
    visible: true,
  } as unknown as Track;

  return {
    id: 'sequence-1',
    name: 'Test Sequence',
    tracks: [track],
    duration: 60,
    fps: 30,
    width: 1920,
    height: 1080,
    format: { width: 1920, height: 1080, fps: 30 },
    markers: [],
  } as unknown as Sequence;
}

describe('SnapPointManager', () => {
  let manager: SnapPointManager;

  beforeEach(() => {
    manager = new SnapPointManager({
      enabled: true,
      snapToClips: true,
      snapToGrid: true,
      snapToPlayhead: true,
      snapToMarkers: true,
      zoom: 100,
      gridInterval: 1,
      duration: 60,
    });
  });

  describe('Configuration', () => {
    it('should initialize with provided config', () => {
      const threshold = manager.getSnapThreshold();
      expect(threshold).toBeGreaterThan(0);
    });

    it('should update config', () => {
      manager.updateConfig({ zoom: 200 });
      const threshold = manager.getSnapThreshold();
      expect(threshold).toBeLessThan(0.1); // Threshold decreases with higher zoom
    });

    it('should regenerate grid on config change', () => {
      manager.updateConfig({ gridInterval: 0.5, duration: 10 });
      const snapPoints = manager.getSnapPoints();
      const gridPoints = snapPoints.filter(p => p.type === 'grid');
      expect(gridPoints.length).toBeGreaterThan(0);
    });
  });

  describe('Clip Management', () => {
    it('should add snap points for a clip', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      const snapPoints = manager.getSnapPoints();
      const clipPoints = snapPoints.filter(p => p.type === 'clip-start' || p.type === 'clip-end');

      expect(clipPoints).toContainEqual(expect.objectContaining({ time: 5 })); // in point
      expect(clipPoints).toContainEqual(expect.objectContaining({ time: 15 })); // out point
    });

    it('should update snap points when clip changes', () => {
      const clip1 = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip1);

      // Update clip position
      const clip2 = createMockClip('clip-1', 10, 10);
      manager.updateClip(clip2);

      const snapPoints = manager.getSnapPoints();
      const clipStartPoints = snapPoints.filter(p => p.type === 'clip-start');

      expect(clipStartPoints).not.toContainEqual(expect.objectContaining({ time: 5 }));
      expect(clipStartPoints).toContainEqual(expect.objectContaining({ time: 10 }));
    });

    it('should remove snap points when clip is deleted', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);
      manager.removeClip('clip-1');

      const snapPoints = manager.getSnapPoints();
      const clipPoints = snapPoints.filter(p => p.type === 'clip-start' || p.type === 'clip-end');

      expect(clipPoints).not.toContainEqual(expect.objectContaining({ time: 5 }));
      expect(clipPoints).not.toContainEqual(expect.objectContaining({ time: 15 }));
    });

    it('should handle bulk update from sequence', () => {
      const clips = [
        createMockClip('clip-1', 0, 5),
        createMockClip('clip-2', 10, 5),
        createMockClip('clip-3', 20, 5),
      ];
      const sequence = createMockSequence(clips);

      manager.updateFromSequence(sequence);

      const stats = manager.getStats();
      expect(stats.clipCount).toBe(3);
    });
  });

  describe('Playhead', () => {
    it('should add playhead snap point', () => {
      manager.updatePlayhead(15);

      const snapPoints = manager.getSnapPoints();
      const playheadPoints = snapPoints.filter(p => p.type === 'playhead');

      expect(playheadPoints).toContainEqual(expect.objectContaining({ time: 15 }));
    });

    it('should update playhead position', () => {
      manager.updatePlayhead(15);
      manager.updatePlayhead(20);

      const snapPoints = manager.getSnapPoints();
      const playheadPoints = snapPoints.filter(p => p.type === 'playhead');

      expect(playheadPoints.length).toBe(1);
      expect(playheadPoints[0].time).toBe(20);
    });
  });

  describe('Markers', () => {
    it('should add marker snap points', () => {
      manager.updateMarkers([5, 10, 15]);

      const snapPoints = manager.getSnapPoints();
      const markerPoints = snapPoints.filter(p => p.type === 'marker');

      expect(markerPoints.length).toBe(3);
      expect(markerPoints).toContainEqual(expect.objectContaining({ time: 5 }));
      expect(markerPoints).toContainEqual(expect.objectContaining({ time: 10 }));
      expect(markerPoints).toContainEqual(expect.objectContaining({ time: 15 }));
    });
  });

  describe('Snap Calculation', () => {
    it('should snap to nearest point within threshold', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      const result = manager.snapToNearest(5.05, 0.1);

      expect(result.snapped).toBe(true);
      expect(result.time).toBe(5);
      expect(result.snapPoint).toBeDefined();
    });

    it('should not snap when outside threshold', () => {
      // Disable grid snapping to only test clip snapping
      manager.updateConfig({ snapToGrid: false });
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      // Test position far from clip edges (5 and 15)
      const result = manager.snapToNearest(7.5, 0.1); // Both 5 and 15 are > 0.1 away

      expect(result.snapped).toBe(false);
      expect(result.time).toBe(7.5);
    });

    it('should find nearest among multiple snap points', () => {
      const clip1 = createMockClip('clip-1', 5, 5);
      const clip2 = createMockClip('clip-2', 12, 5);
      manager.updateClip(clip1);
      manager.updateClip(clip2);

      const result = manager.snapToNearest(10.5, 0.6);

      expect(result.snapped).toBe(true);
      expect(result.time).toBe(10); // Closer to clip-1 end than clip-2 start
    });

    it('should exclude clip from snapping when specified', () => {
      // Disable grid snapping to only test clip snapping
      manager.updateConfig({ snapToGrid: false });
      const clip1 = createMockClip('clip-1', 5, 5); // ends at 10
      const clip2 = createMockClip('clip-2', 12, 5); // starts at 12
      manager.updateClip(clip1);
      manager.updateClip(clip2);

      // Try to snap near clip-2 start (12), excluding clip-2
      // Should NOT snap because clip-1 end (10) is more than 0.1 away
      const result = manager.snapToNearest(11.95, 0.1, 'clip-2');

      // Since we're excluding clip-2 and clip-1's closest point (10) is 1.95 away (> 0.1 threshold)
      expect(result.snapped).toBe(false);
    });

    it('should return false when snapping is disabled', () => {
      manager.updateConfig({ enabled: false });
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      const result = manager.snapToNearest(5.05, 0.1);

      expect(result.snapped).toBe(false);
    });
  });

  describe('Grid Snap Points', () => {
    it('should generate grid snap points', () => {
      manager.updateConfig({ gridInterval: 1, duration: 5 });

      const snapPoints = manager.getSnapPoints();
      const gridPoints = snapPoints.filter(p => p.type === 'grid');

      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 0 }));
      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 1 }));
      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 2 }));
      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 3 }));
      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 4 }));
      expect(gridPoints).toContainEqual(expect.objectContaining({ time: 5 }));
    });

    it('should not generate grid points when snapToGrid is false', () => {
      manager.updateConfig({ snapToGrid: false });

      const snapPoints = manager.getSnapPoints();
      const gridPoints = snapPoints.filter(p => p.type === 'grid');

      expect(gridPoints.length).toBe(0);
    });
  });

  describe('Cache Behavior', () => {
    it('should cache snap points', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      // First access - cache miss
      manager.getSnapPoints();
      const stats1 = manager.getStats();

      // Second access - cache hit
      manager.getSnapPoints();
      const stats2 = manager.getStats();

      expect(stats2.cacheHits).toBeGreaterThan(stats1.cacheHits);
    });

    it('should invalidate cache on clip update', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);
      manager.getSnapPoints(); // Build cache - cache miss

      const statsBefore = manager.getStats();
      const missesBeforeUpdate = statsBefore.cacheMisses;

      manager.updateClip(createMockClip('clip-2', 20, 5)); // This invalidates cache
      manager.getSnapPoints(); // This should be a cache miss

      const statsAfter = manager.getStats();

      // Should have at least one more cache miss
      expect(statsAfter.cacheMisses).toBe(missesBeforeUpdate + 1);
    });

    it('should track cache hit rate', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);

      // Generate some cache activity
      manager.getSnapPoints(); // miss
      manager.getSnapPoints(); // hit
      manager.getSnapPoints(); // hit

      const stats = manager.getStats();
      expect(stats.cacheHitRate).toBeGreaterThan(0.5);
    });
  });

  describe('Statistics', () => {
    it('should track update count', () => {
      const clip1 = createMockClip('clip-1', 5, 10);
      const clip2 = createMockClip('clip-2', 20, 5);

      manager.updateClip(clip1);
      manager.updateClip(clip2);
      manager.removeClip('clip-1');

      const stats = manager.getStats();
      expect(stats.updateCount).toBe(3);
    });

    it('should reset statistics', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);
      manager.getSnapPoints();

      manager.resetStats();
      // After reset, subsequent operations should start from 0
      // Note: getStats() itself doesn't increment counters
      const stats = manager.getStats();

      expect(stats.updateCount).toBe(0);
      // After reset, the next getSnapPoints call would be tracked fresh
      // but we haven't called it yet after reset
    });

    it('should report total snap point count', () => {
      const clips = [
        createMockClip('clip-1', 0, 5),
        createMockClip('clip-2', 10, 5),
      ];
      const sequence = createMockSequence(clips);
      manager.updateFromSequence(sequence);
      manager.updatePlayhead(15);

      const stats = manager.getStats();
      expect(stats.totalSnapPoints).toBeGreaterThan(0);
    });
  });

  describe('Clear', () => {
    it('should clear all snap points', () => {
      const clip = createMockClip('clip-1', 5, 10);
      manager.updateClip(clip);
      manager.updatePlayhead(15);
      manager.updateMarkers([10, 20]);

      manager.clear();

      const snapPoints = manager.getSnapPoints();
      const nonGridPoints = snapPoints.filter(p => p.type !== 'grid');
      expect(nonGridPoints.length).toBe(0);
    });
  });

  describe('isNearSnapPoint', () => {
    it('should return true when near a snap point', () => {
      // Disable grid snapping to only test clip snapping
      manager.updateConfig({ snapToGrid: false });
      const clip = createMockClip('clip-1', 5, 10); // in: 5, out: 15
      manager.updateClip(clip);

      expect(manager.isNearSnapPoint(5.05, 0.1)).toBe(true); // Near clip start
      expect(manager.isNearSnapPoint(7.5, 0.1)).toBe(false); // Far from both edges
    });
  });
});

describe('SnapPointManager Edge Cases', () => {
  let manager: SnapPointManager;

  beforeEach(() => {
    manager = new SnapPointManager();
  });

  it('should handle empty sequence', () => {
    manager.updateFromSequence(null);
    const snapPoints = manager.getSnapPoints();
    expect(snapPoints).toBeDefined();
  });

  it('should handle sequence with no clips', () => {
    const sequence = createMockSequence([]);
    manager.updateFromSequence(sequence);
    const stats = manager.getStats();
    expect(stats.clipCount).toBe(0);
  });

  it('should handle clip with speed != 1', () => {
    const clip: Clip = {
      id: 'clip-1',
      assetId: 'asset-1',
      place: { timelineInSec: 0, trackId: 'track-1' },
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: 2, // 2x speed = 5 second duration on timeline
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
      opacity: 1,
      effects: [],
      audio: { volumeDb: 0, muted: false },
    } as unknown as Clip;

    manager.updateClip(clip);
    const snapPoints = manager.getSnapPoints();
    const clipEndPoints = snapPoints.filter(p => p.type === 'clip-end');

    expect(clipEndPoints).toContainEqual(expect.objectContaining({ time: 5 })); // 10 / 2 = 5
  });

  it('should handle very small grid intervals', () => {
    manager.updateConfig({ gridInterval: 0.001, duration: 1 });
    const snapPoints = manager.getSnapPoints();
    expect(snapPoints.length).toBeGreaterThan(100);
  });

  it('should handle zero grid interval', () => {
    manager.updateConfig({ gridInterval: 0 });
    const snapPoints = manager.getSnapPoints();
    const gridPoints = snapPoints.filter(p => p.type === 'grid');
    expect(gridPoints.length).toBe(0);
  });

  it('should handle clip with speed=0 (safeSpeed fallback)', () => {
    const clip: Clip = {
      id: 'clip-zero-speed',
      assetId: 'asset-1',
      place: { timelineInSec: 5, trackId: 'track-1' },
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: 0, // Would cause Infinity without guard
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
      opacity: 1,
      effects: [],
      audio: { volumeDb: 0, muted: false },
    } as unknown as Clip;

    manager.updateClip(clip);
    const snapPoints = manager.getSnapPoints();
    const clipEndPoints = snapPoints.filter(p => p.type === 'clip-end' && p.clipId === 'clip-zero-speed');

    // safeSpeed=1: out = 5 + 10/1 = 15
    expect(clipEndPoints).toContainEqual(expect.objectContaining({ time: 15 }));
    // Verify no Infinity or NaN values
    for (const point of clipEndPoints) {
      expect(Number.isFinite(point.time)).toBe(true);
    }
  });

  it('should handle clip with negative speed (safeSpeed fallback)', () => {
    const clip: Clip = {
      id: 'clip-neg-speed',
      assetId: 'asset-1',
      place: { timelineInSec: 0, trackId: 'track-1' },
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: -2,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchor: { x: 0.5, y: 0.5 } },
      opacity: 1,
      effects: [],
      audio: { volumeDb: 0, muted: false },
    } as unknown as Clip;

    manager.updateClip(clip);
    const snapPoints = manager.getSnapPoints();
    const clipEndPoints = snapPoints.filter(p => p.type === 'clip-end' && p.clipId === 'clip-neg-speed');

    // safeSpeed=1: out = 0 + 10/1 = 10
    expect(clipEndPoints).toContainEqual(expect.objectContaining({ time: 10 }));
  });

  it('should handle removing a clip that does not exist', () => {
    // Should not throw
    manager.removeClip('nonexistent-clip');
    const stats = manager.getStats();
    expect(stats.clipCount).toBe(0);
  });

  it('should handle rapid add/remove cycles', () => {
    for (let i = 0; i < 100; i++) {
      const clip = createMockClip(`clip-${i}`, i, 1);
      manager.updateClip(clip);
    }
    expect(manager.getStats().clipCount).toBe(100);

    for (let i = 0; i < 100; i++) {
      manager.removeClip(`clip-${i}`);
    }
    expect(manager.getStats().clipCount).toBe(0);

    const snapPoints = manager.getSnapPoints();
    const clipPoints = snapPoints.filter(p => p.type === 'clip-start' || p.type === 'clip-end');
    expect(clipPoints.length).toBe(0);
  });

  it('should handle negative grid interval', () => {
    manager.updateConfig({ gridInterval: -1 });
    const snapPoints = manager.getSnapPoints();
    const gridPoints = snapPoints.filter(p => p.type === 'grid');
    expect(gridPoints.length).toBe(0);
  });

  it('should handle concurrent config and clip updates', () => {
    // Simulate rapid interleaved updates
    for (let i = 0; i < 50; i++) {
      manager.updateClip(createMockClip(`clip-${i}`, i * 2, 1));
      manager.updateConfig({ zoom: 100 + i });
    }

    const snapPoints = manager.getSnapPoints();
    expect(snapPoints.length).toBeGreaterThan(0);

    // All points should have finite times
    for (const point of snapPoints) {
      expect(Number.isFinite(point.time)).toBe(true);
    }
  });

  it('should handle snapToNearest with zero threshold', () => {
    const clip = createMockClip('clip-1', 5, 10);
    manager.updateClip(clip);

    const result = manager.snapToNearest(5.001, 0);
    // Zero threshold = nothing should snap
    expect(result.snapped).toBe(false);
    expect(result.time).toBe(5.001);
  });

  it('should handle snapToNearest with negative threshold', () => {
    const clip = createMockClip('clip-1', 5, 10);
    manager.updateClip(clip);

    const result = manager.snapToNearest(5.001, -1);
    // Negative threshold should not snap
    expect(result.snapped).toBe(false);
  });

  it('should preserve clipId in snap results for accurate filtering', () => {
    manager.updateConfig({ snapToGrid: false });
    const clip = createMockClip('clip-1', 5, 10);
    manager.updateClip(clip);

    const result = manager.snapToNearest(5.01, 0.1);
    expect(result.snapped).toBe(true);
    expect(result.snapPoint?.clipId).toBe('clip-1');
  });
});
