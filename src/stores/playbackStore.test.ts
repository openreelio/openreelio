/**
 * Playback Store Tests
 *
 * Tests for the global playback state management store.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { usePlaybackStore } from './playbackStore';

// =============================================================================
// Tests
// =============================================================================

describe('playbackStore', () => {
  beforeEach(() => {
    // Reset store before each test
    usePlaybackStore.setState({
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      volume: 1,
      isMuted: false,
      loop: false,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should have default values', () => {
      const state = usePlaybackStore.getState();

      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);
      expect(state.duration).toBe(0);
      expect(state.playbackRate).toBe(1);
      expect(state.volume).toBe(1);
      expect(state.isMuted).toBe(false);
      expect(state.loop).toBe(false);
    });
  });

  // ===========================================================================
  // Play/Pause Tests
  // ===========================================================================

  describe('play/pause', () => {
    it('should start playback', () => {
      usePlaybackStore.getState().play();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it('should pause playback', () => {
      usePlaybackStore.setState({ isPlaying: true });
      usePlaybackStore.getState().pause();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });

    it('should toggle playback from paused to playing', () => {
      usePlaybackStore.getState().togglePlayback();
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it('should toggle playback from playing to paused', () => {
      usePlaybackStore.setState({ isPlaying: true });
      usePlaybackStore.getState().togglePlayback();
      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });
  });

  // ===========================================================================
  // Seek Tests
  // ===========================================================================

  describe('seeking', () => {
    it('should seek to specified time', () => {
      usePlaybackStore.setState({ duration: 60 });
      usePlaybackStore.getState().seek(30);
      expect(usePlaybackStore.getState().currentTime).toBe(30);
    });

    it('should clamp seek to 0', () => {
      usePlaybackStore.setState({ duration: 60 });
      usePlaybackStore.getState().seek(-10);
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should clamp seek to duration', () => {
      usePlaybackStore.setState({ duration: 60 });
      usePlaybackStore.getState().seek(100);
      expect(usePlaybackStore.getState().currentTime).toBe(60);
    });

    it('should guard against NaN seek input', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seek(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should seek forward by specified amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekForward(10);
      expect(usePlaybackStore.getState().currentTime).toBe(30);
    });

    it('should seek backward by specified amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekBackward(10);
      expect(usePlaybackStore.getState().currentTime).toBe(10);
    });

    it('should guard against NaN seekForward amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekForward(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(20);
    });

    it('should guard against Infinity seekForward amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekForward(Infinity);
      expect(usePlaybackStore.getState().currentTime).toBe(20);
    });

    it('should guard against NaN seekBackward amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekBackward(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(20);
    });

    it('should guard against Infinity seekBackward amount', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 20 });
      usePlaybackStore.getState().seekBackward(Infinity);
      expect(usePlaybackStore.getState().currentTime).toBe(20);
    });

    it('should go to start', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 30 });
      usePlaybackStore.getState().goToStart();
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should go to end', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 30 });
      usePlaybackStore.getState().goToEnd();
      expect(usePlaybackStore.getState().currentTime).toBe(60);
    });
  });

  // ===========================================================================
  // Time Update Tests
  // ===========================================================================

  describe('time updates', () => {
    it('should update current time', () => {
      usePlaybackStore.getState().setCurrentTime(15);
      expect(usePlaybackStore.getState().currentTime).toBe(15);
    });

    it('should clamp time updates when duration is set', () => {
      usePlaybackStore.setState({ duration: 10 });
      usePlaybackStore.getState().setCurrentTime(15);
      expect(usePlaybackStore.getState().currentTime).toBe(10);
    });

    it('should guard against NaN time updates', () => {
      usePlaybackStore.setState({ currentTime: 5, duration: 60 });
      usePlaybackStore.getState().setCurrentTime(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should update duration', () => {
      usePlaybackStore.getState().setDuration(120);
      expect(usePlaybackStore.getState().duration).toBe(120);
    });

    it('should clamp currentTime when duration shrinks', () => {
      usePlaybackStore.setState({ currentTime: 50, duration: 60 });
      usePlaybackStore.getState().setDuration(10);
      const state = usePlaybackStore.getState();
      expect(state.duration).toBe(10);
      expect(state.currentTime).toBe(10);
    });

    it('should guard against invalid duration', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().setDuration(Number.NaN);
      const state = usePlaybackStore.getState();
      expect(state.duration).toBe(0);
      expect(state.currentTime).toBe(10);
    });
  });

  // ===========================================================================
  // Volume Tests
  // ===========================================================================

  describe('volume', () => {
    it('should set volume', () => {
      usePlaybackStore.getState().setVolume(0.5);
      expect(usePlaybackStore.getState().volume).toBe(0.5);
    });

    it('should clamp volume to 0', () => {
      usePlaybackStore.getState().setVolume(-0.5);
      expect(usePlaybackStore.getState().volume).toBe(0);
    });

    it('should clamp volume to 1', () => {
      usePlaybackStore.getState().setVolume(1.5);
      expect(usePlaybackStore.getState().volume).toBe(1);
    });

    it('should guard against NaN volume', () => {
      usePlaybackStore.setState({ volume: 0.7 });
      usePlaybackStore.getState().setVolume(Number.NaN);
      expect(usePlaybackStore.getState().volume).toBe(0.7);
    });

    it('should guard against Infinity volume', () => {
      usePlaybackStore.setState({ volume: 0.7 });
      usePlaybackStore.getState().setVolume(Infinity);
      expect(usePlaybackStore.getState().volume).toBe(0.7);
    });

    it('should toggle mute', () => {
      usePlaybackStore.getState().toggleMute();
      expect(usePlaybackStore.getState().isMuted).toBe(true);
    });

    it('should toggle mute back to unmuted', () => {
      usePlaybackStore.setState({ isMuted: true });
      usePlaybackStore.getState().toggleMute();
      expect(usePlaybackStore.getState().isMuted).toBe(false);
    });

    it('should set muted state directly', () => {
      usePlaybackStore.getState().setMuted(true);
      expect(usePlaybackStore.getState().isMuted).toBe(true);
    });
  });

  // ===========================================================================
  // Playback Rate Tests
  // ===========================================================================

  describe('playback rate', () => {
    it('should set playback rate', () => {
      usePlaybackStore.getState().setPlaybackRate(2);
      expect(usePlaybackStore.getState().playbackRate).toBe(2);
    });

    it('should clamp playback rate to minimum', () => {
      usePlaybackStore.getState().setPlaybackRate(0);
      expect(usePlaybackStore.getState().playbackRate).toBe(0.25);
    });

    it('should clamp playback rate to maximum', () => {
      usePlaybackStore.getState().setPlaybackRate(10);
      expect(usePlaybackStore.getState().playbackRate).toBe(4);
    });

    it('should guard against NaN playback rate', () => {
      usePlaybackStore.setState({ playbackRate: 1.5 });
      usePlaybackStore.getState().setPlaybackRate(Number.NaN);
      expect(usePlaybackStore.getState().playbackRate).toBe(1.5);
    });

    it('should guard against Infinity playback rate', () => {
      usePlaybackStore.setState({ playbackRate: 1.5 });
      usePlaybackStore.getState().setPlaybackRate(Infinity);
      expect(usePlaybackStore.getState().playbackRate).toBe(1.5);
    });
  });

  // ===========================================================================
  // Loop Tests
  // ===========================================================================

  describe('loop', () => {
    it('should toggle loop', () => {
      usePlaybackStore.getState().toggleLoop();
      expect(usePlaybackStore.getState().loop).toBe(true);
    });

    it('should set loop directly', () => {
      usePlaybackStore.getState().setLoop(true);
      expect(usePlaybackStore.getState().loop).toBe(true);
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================

  describe('reset', () => {
    it('should reset playback state', () => {
      usePlaybackStore.setState({
        isPlaying: true,
        currentTime: 30,
        playbackRate: 2,
        volume: 0.5,
        isMuted: true,
      });

      usePlaybackStore.getState().reset();

      const state = usePlaybackStore.getState();
      expect(state.isPlaying).toBe(false);
      expect(state.currentTime).toBe(0);
      expect(state.playbackRate).toBe(1);
      expect(state.volume).toBe(1);
      expect(state.isMuted).toBe(false);
    });
  });

  // ===========================================================================
  // Frame Step Tests
  // ===========================================================================

  describe('frame stepping', () => {
    it('should step forward one frame at 30fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 0 });
      usePlaybackStore.getState().stepForward(30); // 30fps = 1/30 seconds per frame
      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1 / 30, 5);
    });

    it('should step backward one frame at 30fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 1 });
      usePlaybackStore.getState().stepBackward(30);
      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1 - 1 / 30, 5);
    });

    it('should not step below 0', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 0 });
      usePlaybackStore.getState().stepBackward(30);
      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should not step forward with fps=0 (prevent Infinity)', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepForward(0);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step backward with fps=0 (prevent Infinity)', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepBackward(0);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step forward with negative fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepForward(-30);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step backward with negative fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepBackward(-30);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step forward with NaN fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepForward(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step forward with Infinity fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepForward(Infinity);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step backward with NaN fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepBackward(Number.NaN);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });

    it('should not step backward with Infinity fps', () => {
      usePlaybackStore.setState({ duration: 60, currentTime: 10 });
      usePlaybackStore.getState().stepBackward(Infinity);
      expect(usePlaybackStore.getState().currentTime).toBe(10); // unchanged
    });
  });

  // ===========================================================================
  // Sync with Timeline Tests
  // ===========================================================================

  describe('timeline sync', () => {
    it('should have syncWithTimeline flag', () => {
      expect(usePlaybackStore.getState().syncWithTimeline).toBe(true);
    });

    it('should toggle sync with timeline', () => {
      usePlaybackStore.getState().toggleSyncWithTimeline();
      expect(usePlaybackStore.getState().syncWithTimeline).toBe(false);
    });
  });
});
