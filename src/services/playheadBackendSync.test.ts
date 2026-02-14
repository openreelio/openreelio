import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { usePlaybackStore } from '@/stores/playbackStore';
import {
  _resetPlayheadBackendSyncForTesting,
  startPlayheadBackendSync,
  stopPlayheadBackendSync,
} from './playheadBackendSync';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('./logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

type PlaybackChangedPayload = {
  positionSec?: number;
  sequenceId?: string | null;
  source?: string | null;
  isPlaying?: boolean;
  durationSec?: number | null;
  updatedAt?: string;
};

let eventHandlers = new Map<string, (event: { payload: PlaybackChangedPayload }) => void>();

describe('playheadBackendSync', () => {
  beforeEach(() => {
    eventHandlers = new Map();
    _resetPlayheadBackendSyncForTesting();
    usePlaybackStore.getState().reset();
    usePlaybackStore.getState().setDuration(10);
    mockInvoke.mockResolvedValue({});
    mockListen.mockImplementation(async (eventName, handler) => {
      eventHandlers.set(eventName, handler as (event: { payload: PlaybackChangedPayload }) => void);
      return () => {
        eventHandlers.delete(eventName);
      };
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopPlayheadBackendSync();
    vi.useRealTimers();
  });

  it('syncs immediately on explicit seek events', async () => {
    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-01',
      syncIntervalMs: 120,
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    usePlaybackStore.getState().seek(3.25, 'timeline-scrub');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('set_playhead_position', {
      payload: expect.objectContaining({
        positionSec: 3.25,
        sequenceId: 'seq-01',
        source: 'playhead-backend-sync:timeline-scrub',
        isPlaying: false,
        durationSec: 10,
      }),
    });

    stop();
  });

  it('throttles frequent playback tick updates', async () => {
    vi.useFakeTimers();
    usePlaybackStore.getState().setIsPlaying(true, 'test');

    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-02',
      syncIntervalMs: 100,
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    usePlaybackStore.getState().setCurrentTime(0.1, 'proxy-video-clock');
    usePlaybackStore.getState().setCurrentTime(0.2, 'proxy-video-clock');
    usePlaybackStore.getState().setCurrentTime(0.3, 'proxy-video-clock');

    expect(mockInvoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    await Promise.resolve();
    expect(mockInvoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenLastCalledWith('set_playhead_position', {
      payload: expect.objectContaining({
        positionSec: 0.3,
        sequenceId: 'seq-02',
        source: 'playhead-backend-sync:playback-tick',
      }),
    });

    stop();
  });

  it('ignores seek events that originate from backend-tagged sources', async () => {
    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-03',
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    window.dispatchEvent(
      new CustomEvent('playback-seek', {
        detail: {
          time: 2,
          source: 'backend:playhead-sync',
        },
      }),
    );
    await Promise.resolve();

    expect(mockInvoke).not.toHaveBeenCalled();
    stop();
  });

  it('stops syncing after cleanup', async () => {
    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-04',
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    stop();
    usePlaybackStore.getState().seek(5, 'timeline-scrub');
    await Promise.resolve();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('applies backend playback changes to store without feedback loop', async () => {
    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-05',
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    const handler = eventHandlers.get('playback:changed');
    expect(handler).toBeDefined();

    handler?.({
      payload: {
        positionSec: 4.2,
        sequenceId: 'seq-05',
        source: 'remote-peer',
        isPlaying: true,
        durationSec: 9.5,
        updatedAt: '2026-02-14T12:00:00.000Z',
      },
    });
    await Promise.resolve();

    const state = usePlaybackStore.getState();
    expect(state.currentTime).toBeCloseTo(4.2);
    expect(state.duration).toBeCloseTo(9.5);
    expect(state.isPlaying).toBe(true);
    expect(mockInvoke).not.toHaveBeenCalled();

    stop();
  });

  it('ignores backend updates for a different active sequence', async () => {
    usePlaybackStore.getState().seek(1, 'seed');

    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-active',
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    eventHandlers.get('playback:changed')?.({
      payload: {
        positionSec: 7.3,
        sequenceId: 'seq-other',
        source: 'remote-peer',
        isPlaying: false,
        durationSec: 12,
        updatedAt: '2026-02-14T12:01:00.000Z',
      },
    });
    await Promise.resolve();

    const state = usePlaybackStore.getState();
    expect(state.currentTime).toBeCloseTo(1);
    expect(state.duration).toBeCloseTo(10);
    expect(mockInvoke).not.toHaveBeenCalled();
    stop();
  });

  it('ignores stale backend updates based on updatedAt ordering', async () => {
    const stop = startPlayheadBackendSync({
      getSequenceId: () => 'seq-06',
    });
    await Promise.resolve();
    mockInvoke.mockClear();

    const emit = eventHandlers.get('playback:changed');
    expect(emit).toBeDefined();

    emit?.({
      payload: {
        positionSec: 5,
        sequenceId: 'seq-06',
        source: 'remote-peer',
        isPlaying: false,
        durationSec: 10,
        updatedAt: '2026-02-14T12:02:00.000Z',
      },
    });
    await Promise.resolve();

    emit?.({
      payload: {
        positionSec: 2,
        sequenceId: 'seq-06',
        source: 'remote-peer',
        isPlaying: false,
        durationSec: 10,
        updatedAt: '2026-02-14T12:01:59.000Z',
      },
    });
    await Promise.resolve();

    expect(usePlaybackStore.getState().currentTime).toBeCloseTo(5);
    expect(mockInvoke).not.toHaveBeenCalled();
    stop();
  });
});
