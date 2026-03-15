/**
 * useSourceMonitor Hook Tests
 *
 * Integration tests for source monitor state management.
 * Mocks only external boundaries: Tauri IPC (bindings) and Tauri events.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// =============================================================================
// External boundary mocks
// =============================================================================

const mockListenCallback = vi.fn();
const mockUnlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, callback: unknown) => {
    mockListenCallback.mockImplementation(callback as Mock);
    return Promise.resolve(mockUnlisten);
  }),
}));

vi.mock('@/bindings', () => ({
  commands: {
    getSourceState: vi.fn(),
    setSourceAsset: vi.fn(),
    setSourceIn: vi.fn(),
    setSourceOut: vi.fn(),
    setSourcePlayhead: vi.fn(),
    clearSourceInOut: vi.fn(),
  },
}));

vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { commands } from '@/bindings';
import { listen } from '@tauri-apps/api/event';
import { useSourceMonitor } from './useSourceMonitor';

// =============================================================================
// Test Data
// =============================================================================

function makeDto(overrides?: Record<string, unknown>) {
  return {
    assetId: null,
    inPoint: null,
    outPoint: null,
    playheadSec: 0,
    markedDuration: null,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useSourceMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (commands.getSourceState as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto(),
    });
  });

  it('should initialize with empty state and fetch from backend', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    expect(result.current.assetId).toBeNull();
    expect(result.current.inPoint).toBeNull();
    expect(result.current.outPoint).toBeNull();
    expect(result.current.currentTime).toBe(0);
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.duration).toBe(0);

    await waitFor(() => {
      expect(commands.getSourceState).toHaveBeenCalledOnce();
    });
  });

  it('should subscribe to source_monitor:changed events', async () => {
    renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith('source_monitor:changed', expect.any(Function));
    });
  });

  it('should update state when backend event fires', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    act(() => {
      mockListenCallback({
        payload: makeDto({
          assetId: 'asset-1',
          inPoint: 1.5,
          outPoint: 5.0,
          playheadSec: 5.0,
          markedDuration: 3.5,
        }),
      });
    });

    expect(result.current.assetId).toBe('asset-1');
    expect(result.current.inPoint).toBe(1.5);
    expect(result.current.outPoint).toBe(5.0);
    expect(result.current.markedDuration).toBe(3.5);
    await waitFor(() => {
      expect(result.current.currentTime).toBe(5.0);
    });
  });

  it('should load asset via IPC when loadAsset is called', async () => {
    (commands.setSourceAsset as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-2' }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    await act(async () => {
      await result.current.loadAsset('asset-2');
    });

    expect(commands.setSourceAsset).toHaveBeenCalledWith({ assetId: 'asset-2' });
  });

  it('should set in point at current playback time', async () => {
    (commands.setSourceIn as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-1', inPoint: 2.5 }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    // Simulate video playback reaching 2.5s
    act(() => {
      result.current.setCurrentTime(2.5);
    });

    await act(async () => {
      await result.current.setInPoint();
    });

    expect(commands.setSourceIn).toHaveBeenCalledWith({ timeSec: 2.5 });
  });

  it('should set out point at current playback time', async () => {
    (commands.setSourceOut as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-1', outPoint: 8.0 }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    act(() => {
      result.current.setCurrentTime(8.0);
    });

    await act(async () => {
      await result.current.setOutPoint();
    });

    expect(commands.setSourceOut).toHaveBeenCalledWith({ timeSec: 8.0 });
  });

  it('should sync seek updates to the backend source playhead', async () => {
    (commands.setSourcePlayhead as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-1', playheadSec: 5.5 }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    act(() => {
      mockListenCallback({
        payload: makeDto({ assetId: 'asset-1' }),
      });
    });

    act(() => {
      result.current.seek(5.5);
    });

    await waitFor(() => {
      expect(commands.setSourcePlayhead).toHaveBeenCalledWith({ timeSec: 5.5 });
    });
  });

  it('should not resync backend-originated playhead updates', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    act(() => {
      mockListenCallback({
        payload: makeDto({ assetId: 'asset-1', playheadSec: 7.25 }),
      });
    });

    await waitFor(() => {
      expect(result.current.currentTime).toBe(7.25);
    });

    expect(commands.setSourcePlayhead).not.toHaveBeenCalled();
  });

  it('should clear in/out points via IPC', async () => {
    (commands.clearSourceInOut as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-1' }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    await act(async () => {
      await result.current.clearInOut();
    });

    expect(commands.clearSourceInOut).toHaveBeenCalledOnce();
  });

  it('should reset local playback state when asset changes', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    // Simulate playback in progress
    act(() => {
      result.current.setCurrentTime(10.0);
      result.current.setIsPlaying(true);
      result.current.setDuration(30.0);
    });

    expect(result.current.currentTime).toBe(10.0);

    // Backend event: asset changed
    act(() => {
      mockListenCallback({
        payload: makeDto({ assetId: 'new-asset' }),
      });
    });

    // Playback state should reset
    await waitFor(() => {
      expect(result.current.currentTime).toBe(0);
      expect(result.current.isPlaying).toBe(false);
      expect(result.current.duration).toBe(0);
    });
  });

  it('should toggle playback state', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(commands.getSourceState).toHaveBeenCalledOnce();
    });

    expect(result.current.isPlaying).toBe(false);

    act(() => {
      result.current.togglePlayback();
    });

    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.togglePlayback();
    });

    expect(result.current.isPlaying).toBe(false);
  });

  it('should update current time via seek', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(commands.getSourceState).toHaveBeenCalledOnce();
    });

    act(() => {
      result.current.seek(5.5);
    });

    expect(result.current.currentTime).toBe(5.5);
  });

  it('should sync local current time from backend playhead on initial fetch', async () => {
    (commands.getSourceState as Mock).mockResolvedValue({
      status: 'ok',
      data: makeDto({ assetId: 'asset-9', playheadSec: 12.25 }),
    });

    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(result.current.assetId).toBe('asset-9');
      expect(result.current.currentTime).toBe(12.25);
    });
  });

  it('should update playhead when match_frame event loads new asset with position', async () => {
    const { result } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    // Simulate match_frame backend event: asset loaded at source time 13.0
    act(() => {
      mockListenCallback({
        payload: makeDto({
          assetId: 'matched-asset',
          playheadSec: 13.0,
        }),
      });
    });

    await waitFor(() => {
      expect(result.current.assetId).toBe('matched-asset');
      expect(result.current.currentTime).toBe(13.0);
    });
  });

  it('should unsubscribe from events on unmount', async () => {
    const { unmount } = renderHook(() => useSourceMonitor());

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    unmount();

    // unlisten should be called on cleanup
    await waitFor(() => {
      expect(mockUnlisten).toHaveBeenCalled();
    });
  });
});
