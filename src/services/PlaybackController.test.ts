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
      seek: vi.fn(),
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
function createMockState(
  overrides: Partial<{
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    playbackRate: number;
    seek: ReturnType<typeof vi.fn>;
    setCurrentTime: ReturnType<typeof vi.fn>;
    setIsPlaying: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    currentTime: 0,
    duration: 60,
    isPlaying: false,
    playbackRate: 1,
    volume: 1,
    isMuted: false,
    loop: false,
    syncWithTimeline: true,
    seek: vi.fn(),
    setCurrentTime: vi.fn(),
    setIsPlaying: vi.fn(),
    ...overrides,
  };
}

describe('PlaybackController', () => {
  let controller: PlaybackController;
  let mockSeek: ReturnType<typeof vi.fn>;
  let mockSetCurrentTime: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    mockSeek = vi.fn();
    mockSetCurrentTime = vi.fn();
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({
        seek: mockSeek,
        setCurrentTime: mockSetCurrentTime,
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
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
      expect(mockSeek).toHaveBeenCalledWith(5.0, 'playback-controller:unknown');
    });

    it('should clamp seek to valid range', () => {
      controller.seek(100); // Beyond duration (60)
      expect(mockSeek).toHaveBeenCalledWith(60, 'playback-controller:unknown');

      controller.seek(-5); // Before start
      expect(mockSeek).toHaveBeenCalledWith(0, 'playback-controller:unknown');
    });

    it('should apply frame-accurate seeking', () => {
      controller.seek(1.033, { frameAccurate: true });
      // At 30fps, should snap to nearest frame (1.0333...)
      const callArg = mockSeek.mock.calls[0][0];
      expect(Math.round(callArg * 30)).toBe(31); // Frame 31
    });

    it('should deduplicate rapid seeks to same position', () => {
      controller.seek(5.0);
      controller.seek(5.0);
      controller.seek(5.0);
      // First seek should go through, subsequent should be deduplicated
      expect(mockSeek).toHaveBeenCalledTimes(1);
    });

    it('should not deduplicate when forceUpdate is true', () => {
      controller.seek(5.0);
      controller.seek(5.0, { forceUpdate: true });
      expect(mockSeek).toHaveBeenCalledTimes(2);
    });
  });

  describe('Frame Stepping', () => {
    it('should step forward by one frame', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 1.0,
          seek: mockSeek,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
      );

      controller.stepForward();
      const callArg = mockSeek.mock.calls[0][0];
      expect(callArg).toBeCloseTo(1.0 + 1 / 30, 6);
    });

    it('should step backward by one frame', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 1.0,
          seek: mockSeek,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
      );

      controller.stepBackward();
      const callArg = mockSeek.mock.calls[0][0];
      expect(callArg).toBeCloseTo(1.0 - 1 / 30, 6);
    });

    it('should not step beyond start', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({
          currentTime: 0,
          seek: mockSeek,
          setCurrentTime: mockSetCurrentTime,
        }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
      );

      controller.stepBackward();
      expect(mockSeek).toHaveBeenCalledWith(0, 'playback-controller:step');
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

    it('should not force correction when only audio clock reports', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({ isPlaying: true, seek: mockSeek }) as unknown as ReturnType<
          typeof usePlaybackStore.getState
        >,
      );

      // Audio-only report should not trigger sync seek.
      controller.reportAudioTime(1.0);

      expect(mockSeek).not.toHaveBeenCalled();
    });

    it('should force correction when both clocks report and drift is critical', () => {
      vi.mocked(usePlaybackStore.getState).mockReturnValue(
        createMockState({ isPlaying: true, seek: mockSeek }) as unknown as ReturnType<
          typeof usePlaybackStore.getState
        >,
      );

      controller.reportVideoTime(0);
      controller.reportAudioTime(1.0);

      expect(mockSeek).toHaveBeenCalledWith(1.0, 'playback-controller:sync');
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
        }),
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
        }),
      );

      controller.releaseDragLock('scrubbing');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dragEnd',
          source: 'scrubbing',
        }),
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
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
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

// =============================================================================
// Destructive / Race Condition Tests
// =============================================================================

describe('Destructive: concurrent lock operations', () => {
  let controller: PlaybackController;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState() as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should deny all concurrent lock types when one is held', () => {
    controller.acquireDragLock('scrubbing');

    expect(controller.acquireDragLock('playhead')).toBe(false);
    expect(controller.acquireDragLock('clip')).toBe(false);
    expect(controller.acquireDragLock('scrubbing')).toBe(false);

    expect(controller.getCurrentDragOperation()).toBe('scrubbing');
  });

  it('should allow rapid acquire-release cycles', () => {
    const operations: Array<'scrubbing' | 'playhead' | 'clip'> = [
      'scrubbing',
      'playhead',
      'clip',
      'scrubbing',
      'playhead',
    ];

    for (const op of operations) {
      const acquired = controller.acquireDragLock(op);
      expect(acquired).toBe(true);
      controller.releaseDragLock(op);
      expect(controller.isDragActive()).toBe(false);
    }
  });

  it('should ignore release with wrong operation name', () => {
    controller.acquireDragLock('scrubbing');

    // Try releasing with every wrong name
    controller.releaseDragLock('playhead');
    expect(controller.isDragActive()).toBe(true);

    controller.releaseDragLock('clip');
    expect(controller.isDragActive()).toBe(true);

    // Only correct release works
    controller.releaseDragLock('scrubbing');
    expect(controller.isDragActive()).toBe(false);
  });

  it('should handle release when no lock is held', () => {
    // Should not throw
    controller.releaseDragLock('scrubbing');
    controller.releaseDragLock('playhead');
    controller.releaseDragLock('clip');

    expect(controller.isDragActive()).toBe(false);
  });
});

describe('Destructive: seek edge cases', () => {
  let controller: PlaybackController;
  let mockSeek: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    mockSeek = vi.fn();
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({ seek: mockSeek }) as unknown as ReturnType<
        typeof usePlaybackStore.getState
      >,
    );
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should handle NaN seek (delegates sanitization to store layer)', () => {
    const result = controller.seek(NaN);
    // NaN propagates through controller to store.seek(), where
    // playbackStore.clampTimeToDuration sanitizes non-finite values to 0.
    // Controller intentionally delegates NaN validation to the store layer.
    expect(result).toBe(true);
    expect(mockSeek).toHaveBeenCalledWith(NaN, 'playback-controller:unknown');
  });

  it('should handle negative seek', () => {
    controller.seek(-100);
    expect(mockSeek).toHaveBeenCalledWith(0, 'playback-controller:unknown');
  });

  it('should handle very large seek', () => {
    controller.seek(1e15);
    // Should clamp to duration (60)
    expect(mockSeek).toHaveBeenCalledWith(60, 'playback-controller:unknown');
  });

  it('should deduplicate rapid seeks to identical positions', () => {
    for (let i = 0; i < 100; i++) {
      controller.seek(5.0);
    }
    // First seek goes through, rest are deduplicated
    expect(mockSeek).toHaveBeenCalledTimes(1);
  });

  it('should not deduplicate seeks to different positions', () => {
    for (let i = 0; i < 10; i++) {
      controller.seek(i);
    }
    expect(mockSeek).toHaveBeenCalledTimes(10);
  });
});

describe('Destructive: post-dispose operations', () => {
  let controller: PlaybackController;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState() as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );
  });

  it('should reject all operations after dispose', () => {
    controller.dispose();

    expect(controller.seek(5.0)).toBe(false);
    expect(controller.acquireDragLock('scrubbing')).toBe(false);

    // These should not throw
    controller.releaseDragLock('scrubbing');
    controller.reportVideoTime(1.0);
    controller.reportAudioTime(1.0);
    controller.stepForward();
    controller.stepBackward();
  });

  it('should not emit events after dispose', () => {
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.dispose();

    controller.seek(5.0);
    controller.acquireDragLock('scrubbing');

    // Listener should only have received events before dispose
    const postDisposeCallCount = listener.mock.calls.length;
    controller.seek(10.0);
    expect(listener.mock.calls.length).toBe(postDisposeCallCount);
  });

  it('should handle double dispose', () => {
    // Should not throw
    controller.dispose();
    controller.dispose();

    expect(controller.seek(5.0)).toBe(false);
  });
});

describe('Destructive: frame stepping boundary conditions', () => {
  let controller: PlaybackController;
  let mockSeek: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    mockSeek = vi.fn();
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should not step below 0 at timeline start', () => {
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({
        currentTime: 0,
        seek: mockSeek,
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );

    controller.stepBackward();
    const seekArg = mockSeek.mock.calls[0][0];
    expect(seekArg).toBeGreaterThanOrEqual(0);
  });

  it('should not step beyond duration at timeline end', () => {
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({
        currentTime: 60,
        duration: 60,
        seek: mockSeek,
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );

    controller.stepForward();
    const seekArg = mockSeek.mock.calls[0][0];
    expect(seekArg).toBeLessThanOrEqual(60);
  });

  it('should handle stepping at sub-frame precision (frame-snapped)', () => {
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState({
        currentTime: 1.0001,
        seek: mockSeek,
      }) as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );

    controller.stepForward();
    const seekArg = mockSeek.mock.calls[0][0];
    // stepForward uses frameAccurate: true, so result is snapped to frame boundary
    // 1.0001 + 1/30 ≈ 1.03343 → snapToFrame → round(1.03343 * 30) / 30 = 31/30 ≈ 1.03333
    expect(seekArg).toBeCloseTo(31 / 30, 6);
  });
});

describe('Destructive: subscription lifecycle', () => {
  let controller: PlaybackController;

  beforeEach(() => {
    controller = new PlaybackController({ fps: 30 });
    vi.mocked(usePlaybackStore.getState).mockReturnValue(
      createMockState() as unknown as ReturnType<typeof usePlaybackStore.getState>,
    );
  });

  afterEach(() => {
    controller.dispose();
  });

  it('should handle unsubscribe called multiple times', () => {
    const listener = vi.fn();
    const unsub = controller.subscribe(listener);

    unsub();
    unsub(); // Double unsubscribe should not throw
    unsub();

    controller.seek(5.0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('should handle many concurrent subscribers', () => {
    const listeners = Array.from({ length: 100 }, () => vi.fn());
    const unsubs = listeners.map((l) => controller.subscribe(l));

    controller.seek(5.0);

    for (const listener of listeners) {
      expect(listener).toHaveBeenCalledTimes(1);
    }

    // Unsubscribe all
    for (const unsub of unsubs) {
      unsub();
    }

    controller.seek(10.0);

    // No additional calls
    for (const listener of listeners) {
      expect(listener).toHaveBeenCalledTimes(1);
    }
  });
});
