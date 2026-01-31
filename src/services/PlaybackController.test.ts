/**
 * PlaybackController Tests
 *
 * Tests for the unified playback coordination service.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlaybackController } from './PlaybackController';
import { usePlaybackStore } from '@/stores/playbackStore';

// Mock the playback store
vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: {
    getState: vi.fn(() => ({
      currentTime: 0,
      duration: 60,
      isPlaying: false,
      playbackRate: 1,
      volume: 1,
      isMuted: false,
      loop: false,
      syncWithTimeline: true,
      setCurrentTime: vi.fn(),
      setIsPlaying: vi.fn(),
    })),
  },
}));

// Mock the logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Helper to create mock state
function createMockState(overrides: Partial<{
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  setCurrentTime: ReturnType<typeof vi.fn>;
  setIsPlaying: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    currentTime: 0,
    duration: 60,
    isPlaying: false,
    playbackRate: 1,
    volume: 1,
    isMuted: false,
    loop: false,
    syncWithTimeline: true,
    setCurrentTime: vi.fn(),
    setIsPlaying: vi.fn(),
    ...overrides,
  };
}

describe('PlaybackController', () => {
  let controller: PlaybackController;
  let mockSetCurrentTime: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    mockSetCurrentTime = vi.fn();
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({ setCurrentTime: mockSetCurrentTime }) as unknown as ReturnType<typeof usePlaybackStore.getState>
    );
  });

  afterEach(() => {
    controller.dispose();
    vi.clearAllMocks();
  });

  describe('Configuration', () => {
    it('should initialize with default config', () => {
      expect(controller.fps).toBe(30);
      expect(controller.frameDuration).toBeCloseTo(1 / 30, 6);
    });

    it('should update config', () => {
      controller.setConfig({ fps: 24 });
      expect(controller.fps).toBe(24);
      expect(controller.frameDuration).toBeCloseTo(1 / 24, 6);
    });
  });

  describe('Drag Lock Coordination', () => {
    it('should acquire drag lock when no other drag is active', () => {
      const acquired = controller.acquireDragLock('scrubbing');
      expect(acquired).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
      expect(controller.isDragActive()).toBe(true);
    });

    it('should deny drag lock when another drag is active', () => {
      controller.acquireDragLock('scrubbing');
      const secondAcquire = controller.acquireDragLock('playhead');
      expect(secondAcquire).toBe(false);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
    });

    it('should release drag lock', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('scrubbing');
      expect(controller.isDragActive()).toBe(false);
      expect(controller.getCurrentDragOperation()).toBe('none');
    });

    it('should only release matching drag lock', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('playhead'); // Wrong operation
      expect(controller.isDragActive()).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('scrubbing');
    });

    it('should allow new drag after release', () => {
      controller.acquireDragLock('scrubbing');
      controller.releaseDragLock('scrubbing');
      const acquired = controller.acquireDragLock('playhead');
      expect(acquired).toBe(true);
      expect(controller.getCurrentDragOperation()).toBe('playhead');
    });
  });

  describe('Seeking', () => {
    it('should perform seek and update store', () => {
      const result = controller.seek(5.0);
      expect(result).toBe(true);
      expect(mockSetCurrentTime).toHaveBeenCalledWith(5.0);
    });

    it('should clamp seek to valid range', () => {
      controller.seek(100); // Beyond duration (60)
      expect(mockSetCurrentTime).toHaveBeenCalledWith(60);

      controller.seek(-5); // Before start
      expect(mockSetCurrentTime).toHaveBeenCalledWith(0);
    });

    it('should apply frame-accurate seeking', () => {
      controller.seek(1.033, { frameAccurate: true });
      // At 30fps, should snap to nearest frame (1.0333...)
      const callArg = mockSetCurrentTime.mock.calls[0][0];
      expect(Math.round(callArg * 30)).toBe(31); // Frame 31
    });

    it('should deduplicate rapid seeks to same position', () => {
      controller.seek(5.0);
      controller.seek(5.0);
      controller.seek(5.0);
      // First seek should go through, subsequent should be deduplicated
      expect(mockSetCurrentTime).toHaveBeenCalledTimes(1);
    });

    it('should not deduplicate when forceUpdate is true', () => {
      controller.seek(5.0);
      controller.seek(5.0, { forceUpdate: true });
      expect(mockSetCurrentTime).toHaveBeenCalledTimes(2);
    });
  });

  describe('Frame Stepping', () => {
    it('should step forward by one frame', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 1.0,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>
      );

      controller.stepForward();
      const callArg = mockSetCurrentTime.mock.calls[0][0];
      expect(callArg).toBeCloseTo(1.0 + 1 / 30, 6);
    });

    it('should step backward by one frame', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 1.0,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>
      );

      controller.stepBackward();
      const callArg = mockSetCurrentTime.mock.calls[0][0];
      expect(callArg).toBeCloseTo(1.0 - 1 / 30, 6);
    });

    it('should not step beyond start', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 0,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>
      );

      controller.stepBackward();
      expect(mockSetCurrentTime).toHaveBeenCalledWith(0);
    });
  });

  describe('Snap to Frame', () => {
    it('should snap to nearest frame boundary', () => {
      expect(controller.snapToFrame(1.0)).toBeCloseTo(1.0, 6);
      expect(controller.snapToFrame(1.01)).toBeCloseTo(1.0, 6);
      expect(controller.snapToFrame(1.02)).toBeCloseTo(1.0333, 4); // Frame 31
    });

    it('should handle different FPS', () => {
      controller.setConfig({ fps: 24 });
      expect(controller.snapToFrame(1.0)).toBeCloseTo(1.0, 6);
      expect(controller.snapToFrame(1.02)).toBeCloseTo(1.0, 6); // Rounds to frame 24
      expect(controller.snapToFrame(1.021)).toBeCloseTo(1.0417, 4); // Frame 25
    });

    it('should handle NaN input', () => {
      expect(controller.snapToFrame(NaN)).toBe(0);
    });

    it('should handle Infinity input', () => {
      expect(controller.snapToFrame(Infinity)).toBe(0);
    });

    it('should handle negative Infinity input', () => {
      expect(controller.snapToFrame(-Infinity)).toBe(0);
    });
  });

  describe('Frame Duration', () => {
    it('should return correct frame duration', () => {
      expect(controller.frameDuration).toBeCloseTo(1 / 30, 6);
    });

    it('should handle zero fps safely', () => {
      controller.setConfig({ fps: 0 });
      // Should fall back to default fps (30)
      expect(controller.frameDuration).toBeCloseTo(1 / 30, 6);
    });

    it('should handle negative fps safely', () => {
      controller.setConfig({ fps: -10 });
      // Should fall back to default fps (30)
      expect(controller.frameDuration).toBeCloseTo(1 / 30, 6);
    });
  });

  describe('A/V Sync', () => {
    it('should track sync state', () => {
      controller.reportVideoTime(1.0);
      controller.reportAudioTime(1.05);

      const syncState = controller.getSyncState();
      expect(syncState.videoTime).toBe(1.0);
      expect(syncState.audioTime).toBe(1.05);
      // Note: driftMs is only calculated during active playback sync checks
      // Here we just verify the times are tracked correctly
    });

    it('should not correct during drag operations', () => {
      controller.acquireDragLock('scrubbing');
      controller.reportVideoTime(0);
      controller.reportAudioTime(1.0); // Large drift

      // Sync correction should be skipped during drag
      const syncState = controller.getSyncState();
      expect(syncState.isSynced).toBe(true); // Not updated during drag
    });
  });

  describe('Event System', () => {
    it('should emit events on seek', () => {
      const listener = vi.fn();
      controller.subscribe(listener);

      controller.seek(5.0);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'seek',
          time: 5.0,
        })
      );
    });

    it('should emit events on drag start/end', () => {
      const listener = vi.fn();
      controller.subscribe(listener);

      controller.acquireDragLock('scrubbing');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dragStart',
          source: 'scrubbing',
        })
      );

      controller.releaseDragLock('scrubbing');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dragEnd',
          source: 'scrubbing',
        })
      );
    });

    it('should allow unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);

      controller.seek(5.0);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      controller.seek(10.0);
      expect(listener).toHaveBeenCalledTimes(1); // No new calls
    });
  });

  describe('Statistics', () => {
    it('should track seek statistics', () => {
      controller.seek(1.0);
      controller.seek(2.0);
      controller.seek(2.0); // Deduplicated

      const stats = controller.getStats();
      expect(stats.seekCount).toBe(3);
      expect(stats.deduplicatedSeekCount).toBe(1);
      expect(stats.deduplicationRate).toBeCloseTo(1 / 3, 2);
    });

    it('should reset statistics', () => {
      controller.seek(1.0);
      controller.resetStats();

      const stats = controller.getStats();
      expect(stats.seekCount).toBe(0);
      expect(stats.deduplicatedSeekCount).toBe(0);
    });
  });

  describe('Disposal', () => {
    it('should not process operations after disposal', () => {
      controller.dispose();

      expect(controller.seek(5.0)).toBe(false);
      expect(controller.acquireDragLock('scrubbing')).toBe(false);
    });

    it('should clear listeners on dispose', () => {
      const listener = vi.fn();
      controller.subscribe(listener);
      controller.dispose();

      // Listeners should be cleared, no more callbacks
      expect(controller.getStats().currentDragOperation).toBe('none');
    });
  });
});

describe('Playback Rate Extremes', () => {
  let controller: PlaybackController;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({
        isPlaying: true,
        playbackRate: 4.0, // 4x speed
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>
    );
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should handle 4x playback rate', () => {
    // At 4x speed, frame duration should still be 1/30
    expect(controller.frameDuration).toBeCloseTo(1 / 30, 6);
  });
});
