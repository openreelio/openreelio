/**
 * useAutoFollow Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAutoFollow } from './useAutoFollow';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useEditorToolStore } from '@/stores/editorToolStore';

describe('useAutoFollow', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let rafId: number;
  let now: number;

  const flushNextRaf = (deltaMs = 16): void => {
    const next = rafCallbacks.entries().next();
    if (next.done) return;

    const [id, callback] = next.value;
    rafCallbacks.delete(id);
    now += deltaMs;
    callback(now);
  };

  beforeEach(() => {
    rafCallbacks = new Map();
    rafId = 0;
    now = 1000;

    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++rafId;
      rafCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafCallbacks.delete(id);
    });

    usePlaybackStore.setState({
      isPlaying: false,
      currentTime: 0,
      duration: 120,
      playbackRate: 1,
      volume: 1,
      isMuted: false,
      loop: false,
      syncWithTimeline: true,
    });

    useTimelineStore.setState({
      selectedClipIds: [],
      selectedTrackIds: [],
      zoom: 100,
      scrollX: 0,
      scrollY: 0,
      snapEnabled: true,
      snapToClips: true,
      snapToMarkers: true,
      snapToPlayhead: true,
      linkedSelectionEnabled: true,
    });

    useEditorToolStore.setState({
      activeTool: 'select',
      previousTool: null,
      rippleEnabled: false,
      autoScrollEnabled: true,
      clipboard: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a single RAF loop while playback time updates', () => {
    renderHook(() =>
      useAutoFollow({
        viewportWidth: 500,
      }),
    );

    act(() => {
      usePlaybackStore.setState({ isPlaying: true, currentTime: 4.5 });
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(() => {
      usePlaybackStore.setState({ currentTime: 4.6 });
      usePlaybackStore.setState({ currentTime: 4.7 });
      usePlaybackStore.setState({ currentTime: 4.8 });
    });

    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it('scrolls timeline to follow playhead during playback', () => {
    renderHook(() =>
      useAutoFollow({
        viewportWidth: 500,
      }),
    );

    act(() => {
      usePlaybackStore.setState({ isPlaying: true, currentTime: 4.8 });
    });

    act(() => {
      flushNextRaf();
    });

    expect(useTimelineStore.getState().scrollX).toBeGreaterThan(0);
  });

  it('clamps manual follow scroll within content bounds near sequence end', () => {
    const { result } = renderHook(() =>
      useAutoFollow({
        viewportWidth: 500,
        contentWidth: 1000,
      }),
    );

    act(() => {
      useTimelineStore.setState({ scrollX: 480, zoom: 100 });
      usePlaybackStore.setState({ currentTime: 9.8 });
    });

    act(() => {
      result.current.scrollToPlayhead();
    });

    expect(useTimelineStore.getState().scrollX).toBe(500);
  });

  it('does not overscroll beyond content width during playback follow', () => {
    renderHook(() =>
      useAutoFollow({
        viewportWidth: 500,
        contentWidth: 1000,
      }),
    );

    act(() => {
      usePlaybackStore.setState({ isPlaying: true, currentTime: 9.8 });
    });

    let maxObservedScrollX = useTimelineStore.getState().scrollX;

    for (let index = 0; index < 30; index += 1) {
      act(() => {
        flushNextRaf();
      });

      maxObservedScrollX = Math.max(maxObservedScrollX, useTimelineStore.getState().scrollX);
    }

    expect(maxObservedScrollX).toBeLessThanOrEqual(500);
    expect(useTimelineStore.getState().scrollX).toBeGreaterThan(0);
  });
});
