import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useIdleCacheFill, IDLE_FILL_DELAY_MS } from './useIdleCacheFill';
import { useProjectStore, usePlaybackStore, useSettingsStore } from '@/stores';
import { useRenderCacheStore } from '@/stores/renderCacheStore';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

// Mock only the Tauri IPC boundary; every store below is the real one.
vi.mock('@/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/bindings')>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      renderPreviewCache: vi.fn(),
      getCacheStatus: vi.fn(),
      clearRenderCache: vi.fn(),
    },
  };
});

import { commands } from '@/bindings';

const INITIAL_STATE_VERSION = 7;

/** Simulate a project mutation: the op log advances the state version. */
function commitEdit(): void {
  act(() => {
    useProjectStore.setState({ stateVersion: useProjectStore.getState().stateVersion + 1 });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useIdleCacheFill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;

    vi.mocked(commands.renderPreviewCache).mockResolvedValue({
      status: 'ok',
      data: {
        jobId: 'job-1',
        sequenceId: 'seq1',
        totalSegments: 1,
        segmentsToRender: 1,
        status: 'started',
      },
    } as never);
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'error',
      error: 'No project open',
    } as never);

    useRenderCacheStore.getState()._resetForTests();
    useProjectStore.setState({
      activeSequenceId: 'seq1',
      stateVersion: INITIAL_STATE_VERSION,
    });
    usePlaybackStore.getState().setIsPlaying(false, 'test-setup');
    useSettingsStore.setState((state) => {
      state.settings.performance.backgroundRenderCache = true;
    });
  });

  afterEach(() => {
    useRenderCacheStore.getState()._resetForTests();
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];
  });

  it('should warm up the cache for an already active sequence without any edit', async () => {
    renderHook(() => useIdleCacheFill());

    await advance(IDLE_FILL_DELAY_MS - 100);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();

    await advance(100);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
    expect(commands.renderPreviewCache).toHaveBeenCalledWith('flagged');
  });

  it('should warm up a sequence that becomes active after mount', async () => {
    act(() => {
      useProjectStore.setState({ activeSequenceId: null });
    });

    renderHook(() => useIdleCacheFill());

    await advance(IDLE_FILL_DELAY_MS * 2);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();

    act(() => {
      useProjectStore.setState({ activeSequenceId: 'seq1' });
    });

    await advance(IDLE_FILL_DELAY_MS);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
  });

  it('should arm exactly one warm-up per active sequence', async () => {
    const { rerender } = renderHook(() => useIdleCacheFill());

    await advance(IDLE_FILL_DELAY_MS);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);

    // Rerenders that change nothing must not arm another warm-up.
    rerender();
    act(() => {
      useProjectStore.setState({ activeSequenceId: 'seq1' });
    });
    await advance(IDLE_FILL_DELAY_MS * 2);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);

    act(() => {
      useProjectStore.setState({ activeSequenceId: 'seq2' });
    });
    await advance(IDLE_FILL_DELAY_MS);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(2);
  });

  it('should still warm up under StrictMode', async () => {
    // StrictMode runs mount → cleanup → mount on the same instance, so the
    // refs survive. If the cleanup only cleared the timer, the second mount
    // would see the warm-up as already armed and never schedule one.
    renderHook(() => useIdleCacheFill(), { wrapper: StrictMode });

    await advance(IDLE_FILL_DELAY_MS);

    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
    expect(commands.renderPreviewCache).toHaveBeenCalledWith('flagged');
  });

  it('should not retry a failing fill until the next edit', async () => {
    vi.mocked(commands.renderPreviewCache).mockRejectedValue(new Error('ffmpeg exited with 1'));

    const { rerender } = renderHook(() => useIdleCacheFill());
    await advance(IDLE_FILL_DELAY_MS);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);

    // Neither a bare rerender nor a toggle cycle — the path that normally
    // re-arms a warm-up — may retry a fill that just failed: its error reaches
    // no blocking UI, so the retry would be invisible and unbounded.
    rerender();
    act(() => {
      useSettingsStore.setState((state) => {
        state.settings.performance.backgroundRenderCache = false;
      });
      useSettingsStore.setState((state) => {
        state.settings.performance.backgroundRenderCache = true;
      });
    });
    await advance(IDLE_FILL_DELAY_MS * 2);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);

    // A real edit is the user action that re-arms it.
    commitEdit();
    await advance(IDLE_FILL_DELAY_MS);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(2);
  });

  it('should not warm up when background render caching is disabled', async () => {
    act(() => {
      useSettingsStore.setState((state) => {
        state.settings.performance.backgroundRenderCache = false;
      });
    });

    renderHook(() => useIdleCacheFill());

    await advance(IDLE_FILL_DELAY_MS * 3);

    expect(commands.renderPreviewCache).not.toHaveBeenCalled();
  });

  it('should request a flagged fill once the idle delay elapses after an edit', async () => {
    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(IDLE_FILL_DELAY_MS - 100);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();

    await advance(100);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
    expect(commands.renderPreviewCache).toHaveBeenCalledWith('flagged');
  });

  it('should restart the delay when another edit lands before it elapses', async () => {
    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(1000);

    commitEdit();
    await advance(IDLE_FILL_DELAY_MS - 100);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();

    await advance(100);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
  });

  it('should defer the fill while playing and run it when playback stops', async () => {
    renderHook(() => useIdleCacheFill());

    commitEdit();
    act(() => {
      usePlaybackStore.getState().setIsPlaying(true, 'test');
    });

    await advance(IDLE_FILL_DELAY_MS * 2);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();

    await act(async () => {
      usePlaybackStore.getState().setIsPlaying(false, 'test');
    });

    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
    expect(commands.renderPreviewCache).toHaveBeenCalledWith('flagged');
  });

  it('should never request a fill when background render caching is disabled', async () => {
    act(() => {
      useSettingsStore.setState((state) => {
        state.settings.performance.backgroundRenderCache = false;
      });
    });

    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(IDLE_FILL_DELAY_MS * 3);

    expect(commands.renderPreviewCache).not.toHaveBeenCalled();
  });

  it('should cancel a pending fill when the toggle is switched off mid-delay', async () => {
    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(1000);

    act(() => {
      useSettingsStore.setState((state) => {
        state.settings.performance.backgroundRenderCache = false;
      });
    });

    await advance(IDLE_FILL_DELAY_MS * 2);
    expect(commands.renderPreviewCache).not.toHaveBeenCalled();
  });

  it('should not restart the delay when only the playhead moves', async () => {
    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(1000);

    act(() => {
      usePlaybackStore.setState({ currentTime: 1.5 });
      usePlaybackStore.setState({ currentTime: 1.9 });
    });

    await advance(IDLE_FILL_DELAY_MS - 1000);
    expect(commands.renderPreviewCache).toHaveBeenCalledTimes(1);
  });

  it('should stay inert when no sequence is active', async () => {
    act(() => {
      useProjectStore.setState({ activeSequenceId: null });
    });

    renderHook(() => useIdleCacheFill());

    commitEdit();
    await advance(IDLE_FILL_DELAY_MS * 2);

    expect(commands.renderPreviewCache).not.toHaveBeenCalled();
  });
});
