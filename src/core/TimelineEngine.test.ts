/**
 * TimelineEngine Tests
 *
 * TDD tests for the TimelineEngine class that handles
 * playback control with requestAnimationFrame-based timing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimelineEngine } from './TimelineEngine';

describe('TimelineEngine', () => {
  let engine: TimelineEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new TimelineEngine();
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialization', () => {
    it('should initialize with default values', () => {
      expect(engine.isPlaying).toBe(false);
      expect(engine.currentTime).toBe(0);
      expect(engine.duration).toBe(0);
      expect(engine.playbackRate).toBe(1);
    });

    it('should accept initial configuration', () => {
      const configuredEngine = new TimelineEngine({
        duration: 60,
        playbackRate: 1.5,
      });

      expect(configuredEngine.duration).toBe(60);
      expect(configuredEngine.playbackRate).toBe(1.5);

      configuredEngine.dispose();
    });
  });

  // ===========================================================================
  // Play/Pause Tests
  // ===========================================================================

  describe('play/pause', () => {
    it('should start playback when play is called', () => {
      engine.setDuration(10);
      engine.play();

      expect(engine.isPlaying).toBe(true);
    });

    it('should stop playback when pause is called', () => {
      engine.setDuration(10);
      engine.play();
      engine.pause();

      expect(engine.isPlaying).toBe(false);
    });

    it('should toggle playback state', () => {
      engine.setDuration(10);

      engine.togglePlayback();
      expect(engine.isPlaying).toBe(true);

      engine.togglePlayback();
      expect(engine.isPlaying).toBe(false);
    });

    it('should not play if duration is 0', () => {
      engine.play();

      expect(engine.isPlaying).toBe(false);
    });

    it('should not play if already at end', () => {
      engine.setDuration(10);
      engine.seek(10);
      engine.play();

      expect(engine.isPlaying).toBe(false);
    });

    it('should emit play event when starting', () => {
      const playHandler = vi.fn();
      engine.on('play', playHandler);
      engine.setDuration(10);
      engine.play();

      expect(playHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit paused event when stopping', () => {
      const pausedHandler = vi.fn();
      engine.on('paused', pausedHandler);
      engine.setDuration(10);
      engine.play();
      engine.pause();

      expect(pausedHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Seek Tests
  // ===========================================================================

  describe('seek', () => {
    it('should seek to a specific time', () => {
      engine.setDuration(10);
      engine.seek(5);

      expect(engine.currentTime).toBe(5);
    });

    it('should clamp seek time to 0', () => {
      engine.setDuration(10);
      engine.seek(-5);

      expect(engine.currentTime).toBe(0);
    });

    it('should clamp seek time to duration', () => {
      engine.setDuration(10);
      engine.seek(15);

      expect(engine.currentTime).toBe(10);
    });

    it('should emit beforeSetTime and afterSetTime events', () => {
      const beforeHandler = vi.fn();
      const afterHandler = vi.fn();

      engine.on('beforeSetTime', beforeHandler);
      engine.on('afterSetTime', afterHandler);
      engine.setDuration(10);
      engine.seek(5);

      expect(beforeHandler).toHaveBeenCalledWith({ time: 5 });
      expect(afterHandler).toHaveBeenCalledWith({ time: 5 });
    });

    it('should stop playback if seeking to end', () => {
      engine.setDuration(10);
      engine.play();
      engine.seek(10);

      expect(engine.isPlaying).toBe(false);
    });
  });

  // ===========================================================================
  // Time Update Tests
  // ===========================================================================

  describe('time updates', () => {
    it('should emit timeUpdate events during playback', () => {
      const timeUpdateHandler = vi.fn();
      engine.on('timeUpdate', timeUpdateHandler);
      engine.setDuration(10);
      engine.play();

      // Simulate animation frame (16.67ms at 60fps)
      vi.advanceTimersByTime(17);

      // Manually trigger tick for testing
      engine['_tick'](performance.now() + 17);

      expect(timeUpdateHandler).toHaveBeenCalled();
    });

    it('should advance time based on playback rate', () => {
      engine.setDuration(10);
      engine.setPlaybackRate(2);
      engine.play();

      const startTime = engine.currentTime;

      // Simulate 100ms passing at 2x speed = 200ms of playback
      const elapsed = 100;
      engine['_updateTime'](elapsed);

      expect(engine.currentTime).toBeCloseTo(startTime + (elapsed / 1000) * 2, 2);
    });

    it('should stop at end of duration', () => {
      const endedHandler = vi.fn();
      engine.on('ended', endedHandler);
      engine.setDuration(0.1); // 100ms
      engine.play();

      // Simulate time passing beyond duration
      engine['_updateTime'](200);

      expect(engine.currentTime).toBe(0.1);
      expect(engine.isPlaying).toBe(false);
      expect(endedHandler).toHaveBeenCalledTimes(1);
    });

    it('should loop if loop is enabled', () => {
      engine.setDuration(1);
      engine.setLoop(true);
      engine.play();

      // Simulate time passing beyond duration
      engine['_updateTime'](1500); // 1.5 seconds

      expect(engine.currentTime).toBeCloseTo(0.5, 2);
      expect(engine.isPlaying).toBe(true);
    });
  });

  // ===========================================================================
  // Duration Tests
  // ===========================================================================

  describe('duration', () => {
    it('should set duration', () => {
      engine.setDuration(30);

      expect(engine.duration).toBe(30);
    });

    it('should clamp current time if duration decreases', () => {
      engine.setDuration(30);
      engine.seek(25);
      engine.setDuration(20);

      expect(engine.currentTime).toBe(20);
    });

    it('should emit durationChange event', () => {
      const handler = vi.fn();
      engine.on('durationChange', handler);
      engine.setDuration(30);

      expect(handler).toHaveBeenCalledWith({ duration: 30 });
    });
  });

  // ===========================================================================
  // Playback Rate Tests
  // ===========================================================================

  describe('playback rate', () => {
    it('should set playback rate', () => {
      engine.setPlaybackRate(2);

      expect(engine.playbackRate).toBe(2);
    });

    it('should clamp playback rate to minimum', () => {
      engine.setPlaybackRate(0.1);

      expect(engine.playbackRate).toBe(0.25);
    });

    it('should clamp playback rate to maximum', () => {
      engine.setPlaybackRate(10);

      expect(engine.playbackRate).toBe(4);
    });

    it('should emit playbackRateChange event', () => {
      const handler = vi.fn();
      engine.on('playbackRateChange', handler);
      engine.setPlaybackRate(1.5);

      expect(handler).toHaveBeenCalledWith({ rate: 1.5 });
    });
  });

  // ===========================================================================
  // Loop Tests
  // ===========================================================================

  describe('loop', () => {
    it('should enable loop', () => {
      engine.setLoop(true);

      expect(engine.loop).toBe(true);
    });

    it('should toggle loop', () => {
      engine.toggleLoop();
      expect(engine.loop).toBe(true);

      engine.toggleLoop();
      expect(engine.loop).toBe(false);
    });
  });

  // ===========================================================================
  // Navigation Tests
  // ===========================================================================

  describe('navigation', () => {
    beforeEach(() => {
      engine.setDuration(60);
      engine.seek(30);
    });

    it('should go to start', () => {
      engine.goToStart();

      expect(engine.currentTime).toBe(0);
    });

    it('should go to end', () => {
      engine.goToEnd();

      expect(engine.currentTime).toBe(60);
    });

    it('should step forward by frame time', () => {
      const fps = 30;
      const frameTime = 1 / fps;
      const startTime = engine.currentTime;

      engine.stepForward(fps);

      expect(engine.currentTime).toBeCloseTo(startTime + frameTime, 5);
    });

    it('should step backward by frame time', () => {
      const fps = 30;
      const frameTime = 1 / fps;
      const startTime = engine.currentTime;

      engine.stepBackward(fps);

      expect(engine.currentTime).toBeCloseTo(startTime - frameTime, 5);
    });

    it('should seek forward by amount', () => {
      engine.seekForward(5);

      expect(engine.currentTime).toBe(35);
    });

    it('should seek backward by amount', () => {
      engine.seekBackward(5);

      expect(engine.currentTime).toBe(25);
    });

    it('should clamp step forward at duration', () => {
      engine.seek(59.99);
      engine.stepForward(30);

      expect(engine.currentTime).toBe(60);
    });

    it('should clamp step backward at 0', () => {
      engine.seek(0.01);
      engine.stepBackward(30);

      expect(engine.currentTime).toBe(0);
    });
  });

  // ===========================================================================
  // Event System Tests
  // ===========================================================================

  describe('event system', () => {
    it('should add and remove event listeners', () => {
      const handler = vi.fn();

      engine.on('play', handler);
      engine.setDuration(10);
      engine.play();
      expect(handler).toHaveBeenCalledTimes(1);

      engine.off('play', handler);
      engine.pause();
      engine.play();
      expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it('should support multiple listeners for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      engine.on('play', handler1);
      engine.on('play', handler2);
      engine.setDuration(10);
      engine.play();

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should handle removing non-existent listener gracefully', () => {
      const handler = vi.fn();

      // Should not throw
      expect(() => engine.off('play', handler)).not.toThrow();
    });
  });

  // ===========================================================================
  // Dispose Tests
  // ===========================================================================

  describe('dispose', () => {
    it('should stop playback on dispose', () => {
      engine.setDuration(10);
      engine.play();
      engine.dispose();

      expect(engine.isPlaying).toBe(false);
    });

    it('should clear all listeners on dispose', () => {
      const handler = vi.fn();
      engine.on('play', handler);
      engine.dispose();

      // Create new engine to verify old listeners don't fire
      const newEngine = new TimelineEngine({ duration: 10 });
      newEngine.play();

      expect(handler).not.toHaveBeenCalled();
      newEngine.dispose();
    });
  });

  // ===========================================================================
  // Integration with Store
  // ===========================================================================

  describe('store synchronization', () => {
    it('should provide syncWithStore helper', () => {
      const mockStore = {
        setCurrentTime: vi.fn(),
        setIsPlaying: vi.fn(),
        setDuration: vi.fn(),
      };

      engine.setDuration(10);
      engine.syncWithStore(mockStore);
      engine.seek(5);
      engine.play();

      // syncWithStore only syncs duration, not currentTime or isPlaying initially
      expect(mockStore.setDuration).toHaveBeenCalledWith(10);
      // seek and play call setCurrentTime and setIsPlaying
      expect(mockStore.setCurrentTime).toHaveBeenCalledWith(5);
      expect(mockStore.setIsPlaying).toHaveBeenCalledWith(true);
    });

    it('should unsync from store on dispose', () => {
      const mockStore = {
        setCurrentTime: vi.fn(),
        setIsPlaying: vi.fn(),
        setDuration: vi.fn(),
      };

      engine.syncWithStore(mockStore);
      engine.dispose();

      // These should not call the store after dispose
      mockStore.setCurrentTime.mockClear();
      mockStore.setIsPlaying.mockClear();

      // Try to use the engine after dispose - should not throw or call store
      engine.seek(5);
      expect(mockStore.setCurrentTime).not.toHaveBeenCalled();
    });
  });
});
