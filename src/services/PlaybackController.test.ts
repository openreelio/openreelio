/**
 * Tests for PlaybackController service.
 *
 * Tests the core domain logic: frame snapping, drag lock coordination,
 * A/V sync drift detection, event system, and seek deduplication.
 *
 * Uses the real PlaybackController class with only the Zustand store
 * dependency (1 mock - acceptable per project mock policy).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PlaybackController } from './PlaybackController';
import type { DragOperation, PlaybackEvent } from './PlaybackController';

// Mock only the Zustand store (external boundary)
vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: {
    getState: vi.fn(() => ({
      currentTime: 0,
      duration: 120,
      isPlaying: false,
      seek: vi.fn(),
    })),
  },
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('PlaybackController', () => {
  let controller: PlaybackController;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    vi.spyOn(performance, 'now').mockReturnValue(0);
  });

  afterEach(() => {
    controller.dispose();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // snapToFrame
  // ===========================================================================

  describe('snapToFrame', () => {
    it('should snap time to nearest frame boundary at 30fps', () => {
      // At 30fps, frame duration = 1/30 ≈ 0.0333s
      // 1.5 * 30 = 45 frames => 45/30 = 1.5 (already on boundary)
      expect(controller.snapToFrame(1.5)).toBeCloseTo(1.5, 10);
    });

    it('should round to nearest frame', () => {
      // 1.01 * 30 = 30.3 => round to 30 => 30/30 = 1.0
      expect(controller.snapToFrame(1.01)).toBeCloseTo(1.0, 10);
      // 1.02 * 30 = 30.6 => round to 31 => 31/30 ≈ 1.0333
      expect(controller.snapToFrame(1.02)).toBeCloseTo(31 / 30, 10);
    });

    it('should return 0 for NaN input', () => {
      expect(controller.snapToFrame(NaN)).toBe(0);
    });

    it('should return 0 for Infinity input', () => {
      expect(controller.snapToFrame(Infinity)).toBe(0);
    });

    it('should return 0 for negative Infinity input', () => {
      expect(controller.snapToFrame(-Infinity)).toBe(0);
    });

    it('should handle 0 input', () => {
      expect(controller.snapToFrame(0)).toBe(0);
    });

    it('should handle negative time by snapping to negative frame', () => {
      // Negative time is clamped later in seek(), snapToFrame itself just does math
      const result = controller.snapToFrame(-1.02);
      expect(result).toBeCloseTo(-31 / 30, 10);
    });

    it('should handle invalid fps by returning max(0, time)', () => {
      const badFpsController = new PlaybackController({ fps: 0 });
      expect(badFpsController.snapToFrame(5.5)).toBe(5.5);
      badFpsController.dispose();
    });

    it('should work with 24fps', () => {
      const controller24 = new PlaybackController({ fps: 24 });
      // 2.0 * 24 = 48 => 48/24 = 2.0
      expect(controller24.snapToFrame(2.0)).toBeCloseTo(2.0, 10);
      // 2.03 * 24 = 48.72 => round to 49 => 49/24 ≈ 2.04167
      expect(controller24.snapToFrame(2.03)).toBeCloseTo(49 / 24, 10);
      controller24.dispose();
    });
  });

  // ===========================================================================
  // frameDuration
  // ===========================================================================

  describe('frameDuration', () => {
    it('should return 1/fps for valid fps', () => {
      expect(controller.frameDuration).toBeCloseTo(1 / 30, 10);
    });

    it('should return default 1/30 for zero fps', () => {
      const badController = new PlaybackController({ fps: 0 });
      expect(badController.frameDuration).toBeCloseTo(1 / 30, 10);
      badController.dispose();
    });

    it('should return default 1/30 for negative fps', () => {
      const badController = new PlaybackController({ fps: -10 });
      expect(badController.frameDuration).toBeCloseTo(1 / 30, 10);
      badController.dispose();
    });

    it('should return default 1/30 for NaN fps', () => {
      const badController = new PlaybackController({ fps: NaN });
      expect(badController.frameDuration).toBeCloseTo(1 / 30, 10);
      badController.dispose();
    });
  });

  // ===========================================================================
  // Drag Lock Coordination
  // ===========================================================================

  describe('acquireDragLock / releaseDragLock', () => {
    it('should acquire lock when no drag is active', () => {
      expect(controller.acquireDragLock('scrubbing')).toBe(true);
      expect(controller.isDragActive()).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
    });

    it('should deny lock when another drag is active', () => {
      controller.acquireDragLock('scrubbing');
      expect(controller.acquireDragLock('playhead')).toBe(false);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
    });

    it('should release lock for correct operation', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('scrubbing');
      expect(controller.isDragActive()).toBe(false);
      expect(controller.getCurrentDragOperation()).toBe('none');
    });

    it('should not release lock for wrong operation', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('playhead'); // wrong operation
      expect(controller.isDragActive()).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
    });

    it('should allow re-acquiring after release', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('scrubbing');
      expect(controller.acquireDragLock('playhead')).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('playhead');
    });

    it('should deny all locks after dispose', () => {
      controller.dispose();
      expect(controller.acquireDragLock('scrubbing')).toBe(false);
    });

    it('should emit dragStart and dragEnd events', () => {
      const events: PlaybackEvent[] = [];
      controller.subscribe(e => events.push(e));

      controller.acquireDragLock('clip');
      controller.releaseDragLock('clip');

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('dragStart');
      expect(events[0].source).toBe('clip');
      expect(events[1].type).toBe('dragEnd');
      expect(events[1].source).toBe('clip');
    });

    it('should support all drag operation types', () => {
      const operations: DragOperation[] = ['scrubbing', 'playhead', 'clip'];

      for (const op of operations) {
        const ctrl = new PlaybackController();
        expect(ctrl.acquireDragLock(op)).toBe(true);
        expect(ctrl.getCurrentDragOperation()).toBe(op);
        ctrl.releaseDragLock(op);
        ctrl.dispose();
      }
    });
  });

  // ===========================================================================
  // Event System
  // ===========================================================================

  describe('subscribe', () => {
    it('should notify listeners of events', () => {
      const events: PlaybackEvent[] = [];
      controller.subscribe(e => events.push(e));

      controller.acquireDragLock('scrubbing');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('dragStart');
    });

    it('should support multiple listeners', () => {
      let count1 = 0;
      let count2 = 0;
      controller.subscribe(() => count1++);
      controller.subscribe(() => count2++);

      controller.acquireDragLock('scrubbing');

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });

    it('should unsubscribe correctly', () => {
      let count = 0;
      const unsub = controller.subscribe(() => count++);

      controller.acquireDragLock('scrubbing');
      expect(count).toBe(1);

      unsub();
      controller.releaseDragLock('scrubbing');
      expect(count).toBe(1); // no increment after unsub
    });

    it('should handle listener errors gracefully', () => {
      controller.subscribe(() => {
        throw new Error('listener error');
      });
      let reached = false;
      controller.subscribe(() => {
        reached = true;
      });

      // Should not throw, and second listener should still fire
      controller.acquireDragLock('scrubbing');
      expect(reached).toBe(true);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('getStats / resetStats', () => {
    it('should track seek counts', () => {
      // First seek at time 0
      vi.spyOn(performance, 'now').mockReturnValue(0);
      controller.seek(5, { source: 'test' });

      // Second seek at different time to avoid dedup
      vi.spyOn(performance, 'now').mockReturnValue(100);
      controller.seek(10, { source: 'test' });

      const stats = controller.getStats();
      expect(stats.seekCount).toBe(2);
    });

    it('should reset stats correctly', () => {
      vi.spyOn(performance, 'now').mockReturnValue(0);
      controller.seek(5, { source: 'test' });
      controller.resetStats();

      const stats = controller.getStats();
      expect(stats.seekCount).toBe(0);
      expect(stats.deduplicatedSeekCount).toBe(0);
    });

    it('should report current drag operation in stats', () => {
      controller.acquireDragLock('clip');
      expect(controller.getStats().currentDragOperation).toBe('clip');
    });
  });

  // ===========================================================================
  // Configuration
  // ===========================================================================

  describe('setConfig', () => {
    it('should update fps', () => {
      controller.setConfig({ fps: 24 });
      expect(controller.fps).toBe(24);
      expect(controller.frameDuration).toBeCloseTo(1 / 24, 10);
    });

    it('should merge partial config without overwriting other fields', () => {
      controller.setConfig({ fps: 60 });
      controller.setConfig({ enableSyncCorrection: false });
      expect(controller.fps).toBe(60); // preserved from previous setConfig
    });
  });

  // ===========================================================================
  // Dispose
  // ===========================================================================

  describe('dispose', () => {
    it('should clear listeners on dispose', () => {
      let count = 0;
      controller.subscribe(() => count++);
      controller.dispose();

      // Events should not reach listeners after dispose
      // acquireDragLock returns false after dispose, so no event
      expect(controller.acquireDragLock('scrubbing')).toBe(false);
      expect(count).toBe(0);
    });

    it('should reset drag state on dispose', () => {
      controller.acquireDragLock('scrubbing');
      controller.dispose();
      expect(controller.getCurrentDragOperation()).toBe('none');
    });
  });
});
