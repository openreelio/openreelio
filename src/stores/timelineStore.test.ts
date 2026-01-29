/**
 * Timeline Store Tests
 *
 * Tests for Zustand timeline store using TDD methodology.
 * Tests cover playback, selection, view controls, and snap settings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useTimelineStore } from './timelineStore';
import { usePlaybackStore } from './playbackStore';
import type { Clip } from '@/types';

// =============================================================================
// Test Setup
// =============================================================================

describe('timelineStore', () => {
  beforeEach(() => {
    // Reset timeline store (which also resets PlaybackStore internally)
    useTimelineStore.getState().reset();

    // Set duration after reset - this is critical for seek operations to work
    // (seek clamps to duration, so if duration is 0, seek will always result in 0)
    usePlaybackStore.getState().setDuration(60);
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const state = useTimelineStore.getState();
      const playbackState = usePlaybackStore.getState();

      // Playback state is in PlaybackStore (the source of truth)
      expect(playbackState.currentTime).toBe(0);
      expect(playbackState.isPlaying).toBe(false);
      expect(playbackState.playbackRate).toBe(1);

      // View/selection state is in TimelineStore
      expect(state.selectedClipIds).toEqual([]);
      expect(state.selectedTrackIds).toEqual([]);
      expect(state.zoom).toBe(100);
      expect(state.scrollX).toBe(0);
      expect(state.scrollY).toBe(0);
      expect(state.snapEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // Playback Tests
  // ===========================================================================

  describe('playback', () => {
    describe('setPlayhead', () => {
      it('should set playhead to specified time', () => {
        const { setPlayhead } = useTimelineStore.getState();
        setPlayhead(10.5);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(10.5);
      });

      it('should not allow negative playhead', () => {
        const { setPlayhead } = useTimelineStore.getState();
        setPlayhead(-5);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(0);
      });

      it('should handle zero playhead', () => {
        const { setPlayhead } = useTimelineStore.getState();
        setPlayhead(10);
        setPlayhead(0);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(0);
      });
    });

    describe('play', () => {
      it('should set isPlaying to true', () => {
        const { play } = useTimelineStore.getState();
        play();

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
      });
    });

    describe('pause', () => {
      it('should set isPlaying to false', () => {
        usePlaybackStore.getState().play();

        const { pause } = useTimelineStore.getState();
        pause();

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
      });
    });

    describe('togglePlayback', () => {
      it('should toggle from paused to playing', () => {
        const { togglePlayback } = useTimelineStore.getState();
        togglePlayback();

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().isPlaying).toBe(true);
      });

      it('should toggle from playing to paused', () => {
        usePlaybackStore.getState().play();

        const { togglePlayback } = useTimelineStore.getState();
        togglePlayback();

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().isPlaying).toBe(false);
      });
    });

    describe('setPlaybackRate', () => {
      it('should set playback rate', () => {
        const { setPlaybackRate } = useTimelineStore.getState();
        setPlaybackRate(2);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().playbackRate).toBe(2);
      });

      it('should clamp playback rate to minimum 0.1', () => {
        const { setPlaybackRate } = useTimelineStore.getState();
        setPlaybackRate(0.05);

        // PlaybackStore has MIN of 0.25, not 0.1 (that was old TimelineStore logic)
        expect(usePlaybackStore.getState().playbackRate).toBe(0.25);
      });

      it('should clamp playback rate to maximum 4', () => {
        const { setPlaybackRate } = useTimelineStore.getState();
        setPlaybackRate(8);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().playbackRate).toBe(4);
      });
    });

    describe('seekForward', () => {
      it('should move playhead forward', () => {
        // Use seek action to set initial position
        usePlaybackStore.getState().seek(5);

        const { seekForward } = useTimelineStore.getState();
        seekForward(3);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(8);
      });
    });

    describe('seekBackward', () => {
      it('should move playhead backward', () => {
        // Use seek action to set initial position
        usePlaybackStore.getState().seek(10);

        const { seekBackward } = useTimelineStore.getState();
        seekBackward(3);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(7);
      });

      it('should not go below zero', () => {
        // Use seek action to set initial position
        usePlaybackStore.getState().seek(2);

        const { seekBackward } = useTimelineStore.getState();
        seekBackward(5);

        // Verify via PlaybackStore (the source of truth)
        expect(usePlaybackStore.getState().currentTime).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Selection Tests
  // ===========================================================================

  describe('selection', () => {
    describe('selectClip', () => {
      it('should select a single clip', () => {
        const { selectClip } = useTimelineStore.getState();
        selectClip('clip_001');

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_001']);
      });

      it('should replace selection when not adding', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { selectClip } = useTimelineStore.getState();
        selectClip('clip_002');

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_002']);
      });

      it('should add to selection when addToSelection is true', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { selectClip } = useTimelineStore.getState();
        selectClip('clip_002', true);

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_001', 'clip_002']);
      });

      it('should not duplicate clip in selection', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { selectClip } = useTimelineStore.getState();
        selectClip('clip_001', true);

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_001']);
      });
    });

    describe('selectClips', () => {
      it('should select multiple clips', () => {
        const { selectClips } = useTimelineStore.getState();
        selectClips(['clip_001', 'clip_002', 'clip_003']);

        expect(useTimelineStore.getState().selectedClipIds).toEqual([
          'clip_001',
          'clip_002',
          'clip_003',
        ]);
      });

      it('should replace existing selection', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_old'] });

        const { selectClips } = useTimelineStore.getState();
        selectClips(['clip_new']);

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_new']);
      });
    });

    describe('deselectClip', () => {
      it('should remove clip from selection', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001', 'clip_002'] });

        const { deselectClip } = useTimelineStore.getState();
        deselectClip('clip_001');

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_002']);
      });

      it('should handle deselecting non-existent clip', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { deselectClip } = useTimelineStore.getState();
        deselectClip('clip_nonexistent');

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_001']);
      });
    });

    describe('clearClipSelection', () => {
      it('should clear all clip selections', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001', 'clip_002'] });

        const { clearClipSelection } = useTimelineStore.getState();
        clearClipSelection();

        expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
      });
    });

    describe('selectTrack', () => {
      it('should add track to selection', () => {
        const { selectTrack } = useTimelineStore.getState();
        selectTrack('track_001');

        expect(useTimelineStore.getState().selectedTrackIds).toEqual(['track_001']);
      });

      it('should not duplicate track in selection', () => {
        useTimelineStore.setState({ selectedTrackIds: ['track_001'] });

        const { selectTrack } = useTimelineStore.getState();
        selectTrack('track_001');

        expect(useTimelineStore.getState().selectedTrackIds).toEqual(['track_001']);
      });
    });

    describe('deselectTrack', () => {
      it('should remove track from selection', () => {
        useTimelineStore.setState({ selectedTrackIds: ['track_001', 'track_002'] });

        const { deselectTrack } = useTimelineStore.getState();
        deselectTrack('track_001');

        expect(useTimelineStore.getState().selectedTrackIds).toEqual(['track_002']);
      });
    });

    describe('clearTrackSelection', () => {
      it('should clear all track selections', () => {
        useTimelineStore.setState({ selectedTrackIds: ['track_001', 'track_002'] });

        const { clearTrackSelection } = useTimelineStore.getState();
        clearTrackSelection();

        expect(useTimelineStore.getState().selectedTrackIds).toEqual([]);
      });
    });

    describe('selectAll', () => {
      it('should select all provided clips', () => {
        // Use minimal clip structure for test - only id is needed for selectAll
        const clips = [
          { id: 'clip_001' },
          { id: 'clip_002' },
        ] as Clip[];

        const { selectAll } = useTimelineStore.getState();
        selectAll(clips);

        expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_001', 'clip_002']);
      });
    });

    describe('isClipSelected', () => {
      it('should return true for selected clip', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { isClipSelected } = useTimelineStore.getState();

        expect(isClipSelected('clip_001')).toBe(true);
      });

      it('should return false for unselected clip', () => {
        useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

        const { isClipSelected } = useTimelineStore.getState();

        expect(isClipSelected('clip_002')).toBe(false);
      });
    });
  });

  // ===========================================================================
  // View Control Tests
  // ===========================================================================

  describe('view controls', () => {
    describe('setZoom', () => {
      it('should set zoom level', () => {
        const { setZoom } = useTimelineStore.getState();
        setZoom(200);

        expect(useTimelineStore.getState().zoom).toBe(200);
      });

      it('should clamp zoom to minimum (10)', () => {
        const { setZoom } = useTimelineStore.getState();
        setZoom(5);

        expect(useTimelineStore.getState().zoom).toBe(10);
      });

      it('should clamp zoom to maximum (500)', () => {
        const { setZoom } = useTimelineStore.getState();
        setZoom(600);

        expect(useTimelineStore.getState().zoom).toBe(500);
      });
    });

    describe('zoomIn', () => {
      it('should increase zoom by step factor', () => {
        useTimelineStore.setState({ zoom: 100 });

        const { zoomIn } = useTimelineStore.getState();
        zoomIn();

        expect(useTimelineStore.getState().zoom).toBe(120); // 100 * 1.2
      });

      it('should not exceed maximum zoom', () => {
        useTimelineStore.setState({ zoom: 490 });

        const { zoomIn } = useTimelineStore.getState();
        zoomIn();

        expect(useTimelineStore.getState().zoom).toBe(500);
      });
    });

    describe('zoomOut', () => {
      it('should decrease zoom by step factor', () => {
        useTimelineStore.setState({ zoom: 120 });

        const { zoomOut } = useTimelineStore.getState();
        zoomOut();

        expect(useTimelineStore.getState().zoom).toBe(100); // 120 / 1.2
      });

      it('should not go below minimum zoom', () => {
        useTimelineStore.setState({ zoom: 11 });

        const { zoomOut } = useTimelineStore.getState();
        zoomOut();

        expect(useTimelineStore.getState().zoom).toBe(10);
      });
    });

    describe('fitToWindow', () => {
      it('should calculate zoom to fit sequence in viewport', () => {
        const { fitToWindow } = useTimelineStore.getState();
        fitToWindow(60, 600); // 60 seconds, 600px viewport => 10px/sec

        expect(useTimelineStore.getState().zoom).toBe(10);
        expect(useTimelineStore.getState().scrollX).toBe(0);
      });

      it('should not change zoom for invalid duration', () => {
        useTimelineStore.setState({ zoom: 100 });

        const { fitToWindow } = useTimelineStore.getState();
        fitToWindow(0, 600);

        expect(useTimelineStore.getState().zoom).toBe(100);
      });

      it('should not change zoom for invalid viewport', () => {
        useTimelineStore.setState({ zoom: 100 });

        const { fitToWindow } = useTimelineStore.getState();
        fitToWindow(60, 0);

        expect(useTimelineStore.getState().zoom).toBe(100);
      });

      it('should clamp calculated zoom to valid range', () => {
        const { fitToWindow } = useTimelineStore.getState();
        fitToWindow(1, 600); // 1 second, 600px => 600px/sec (exceeds max 500)

        expect(useTimelineStore.getState().zoom).toBe(500);
      });
    });

    describe('setScrollX', () => {
      it('should set horizontal scroll position', () => {
        const { setScrollX } = useTimelineStore.getState();
        setScrollX(100);

        expect(useTimelineStore.getState().scrollX).toBe(100);
      });

      it('should not allow negative scroll', () => {
        const { setScrollX } = useTimelineStore.getState();
        setScrollX(-50);

        expect(useTimelineStore.getState().scrollX).toBe(0);
      });
    });

    describe('setScrollY', () => {
      it('should set vertical scroll position', () => {
        const { setScrollY } = useTimelineStore.getState();
        setScrollY(50);

        expect(useTimelineStore.getState().scrollY).toBe(50);
      });

      it('should not allow negative scroll', () => {
        const { setScrollY } = useTimelineStore.getState();
        setScrollY(-20);

        expect(useTimelineStore.getState().scrollY).toBe(0);
      });
    });

    describe('scrollToPlayhead', () => {
      it('should scroll left when playhead is before visible area', () => {
        // Use seek action instead of setState to ensure proper state update
        usePlaybackStore.getState().seek(1);
        useTimelineStore.setState({ zoom: 100, scrollX: 500 });

        const { scrollToPlayhead } = useTimelineStore.getState();
        scrollToPlayhead(400); // viewport 400px

        // Playhead at 1s * 100px/s = 100px, should scroll to bring it into view
        expect(useTimelineStore.getState().scrollX).toBeLessThan(500);
      });

      it('should scroll right when playhead is after visible area', () => {
        // Use seek action instead of setState to ensure proper state update
        usePlaybackStore.getState().seek(10);
        useTimelineStore.setState({ zoom: 100, scrollX: 0 });

        const { scrollToPlayhead } = useTimelineStore.getState();
        scrollToPlayhead(400); // viewport 400px

        // Playhead at 10s * 100px/s = 1000px, needs scroll to right
        expect(useTimelineStore.getState().scrollX).toBeGreaterThan(0);
      });

      it('should not scroll when playhead is within visible area', () => {
        // Use seek action instead of setState to ensure proper state update
        usePlaybackStore.getState().seek(2);
        useTimelineStore.setState({ zoom: 100, scrollX: 0 });

        const { scrollToPlayhead } = useTimelineStore.getState();
        scrollToPlayhead(400); // viewport 400px, playhead at 200px

        expect(useTimelineStore.getState().scrollX).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Snap Settings Tests
  // ===========================================================================

  describe('snap settings', () => {
    describe('toggleSnap', () => {
      it('should toggle snap enabled state', () => {
        const { toggleSnap } = useTimelineStore.getState();
        toggleSnap();

        expect(useTimelineStore.getState().snapEnabled).toBe(false);

        toggleSnap();

        expect(useTimelineStore.getState().snapEnabled).toBe(true);
      });
    });

    describe('setSnapToClips', () => {
      it('should set snap to clips setting', () => {
        const { setSnapToClips } = useTimelineStore.getState();
        setSnapToClips(false);

        expect(useTimelineStore.getState().snapToClips).toBe(false);
      });
    });

    describe('setSnapToMarkers', () => {
      it('should set snap to markers setting', () => {
        const { setSnapToMarkers } = useTimelineStore.getState();
        setSnapToMarkers(false);

        expect(useTimelineStore.getState().snapToMarkers).toBe(false);
      });
    });

    describe('setSnapToPlayhead', () => {
      it('should set snap to playhead setting', () => {
        const { setSnapToPlayhead } = useTimelineStore.getState();
        setSnapToPlayhead(false);

        expect(useTimelineStore.getState().snapToPlayhead).toBe(false);
      });
    });
  });

  // ===========================================================================
  // Utility Tests
  // ===========================================================================

  describe('utilities', () => {
    describe('timeToPixels', () => {
      it('should convert time to pixels based on zoom', () => {
        useTimelineStore.setState({ zoom: 100 });

        const { timeToPixels } = useTimelineStore.getState();

        expect(timeToPixels(5)).toBe(500); // 5 seconds * 100 px/s
      });

      it('should handle different zoom levels', () => {
        useTimelineStore.setState({ zoom: 50 });

        const { timeToPixels } = useTimelineStore.getState();

        expect(timeToPixels(10)).toBe(500); // 10 seconds * 50 px/s
      });
    });

    describe('pixelsToTime', () => {
      it('should convert pixels to time based on zoom', () => {
        useTimelineStore.setState({ zoom: 100 });

        const { pixelsToTime } = useTimelineStore.getState();

        expect(pixelsToTime(500)).toBe(5); // 500px / 100 px/s = 5s
      });

      it('should handle different zoom levels', () => {
        useTimelineStore.setState({ zoom: 50 });

        const { pixelsToTime } = useTimelineStore.getState();

        expect(pixelsToTime(500)).toBe(10); // 500px / 50 px/s = 10s
      });
    });
  });
});
