import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useRenderCache } from './useRenderCache';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

// Mock Tauri IPC
vi.mock('@/bindings', () => ({
  commands: {
    getCacheStatus: vi.fn(),
    renderPreviewCache: vi.fn(),
    clearRenderCache: vi.fn(),
  },
}));

// Mock Tauri events — each listen call returns a new unlisten function
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn())),
}));

import { commands } from '@/bindings';

const mockStatus = {
  enabled: true,
  sequenceId: 'seq1',
  totalSegments: 4,
  cachedSegments: 2,
  staleSegments: 1,
  renderingSegments: 0,
  completionPercent: 50.0,
  totalCachedBytes: 1024,
  maxCacheBytes: 1073741824,
  segmentStates: [
    { startSec: 0, endSec: 5, state: 'cached' as const },
    { startSec: 5, endSec: 10, state: 'cached' as const },
    { startSec: 10, endSec: 15, state: 'stale' as const },
    { startSec: 15, endSec: 20, state: 'empty' as const },
  ],
};

describe('useRenderCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];
  });

  it('should load initial cache status on mount', async () => {
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'ok',
      data: mockStatus,
    } as never);

    const { result } = renderHook(() => useRenderCache());

    await waitFor(() => {
      expect(result.current.status).toEqual(mockStatus);
    });

    expect(result.current.segments).toHaveLength(4);
    expect(result.current.error).toBeNull();
  });

  it('should return empty segments when no project open', async () => {
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'error',
      error: 'No project open',
    } as never);

    const { result } = renderHook(() => useRenderCache());

    await waitFor(() => {
      expect(result.current.status).toBeNull();
    });

    expect(result.current.segments).toHaveLength(0);
    expect(result.current.error).toBeNull();
  });

  it('should surface unexpected backend errors', async () => {
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'error',
      error: 'Failed to load cache manifest: invalid json',
    } as never);

    const { result } = renderHook(() => useRenderCache());

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load cache manifest: invalid json');
    });

    expect(result.current.status).toBeNull();
  });

  it('should set isRendering to true after triggering render', async () => {
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'ok',
      data: mockStatus,
    } as never);
    vi.mocked(commands.renderPreviewCache).mockResolvedValue({
      status: 'ok',
      data: { sequenceId: 'seq1', totalSegments: 4, segmentsToRender: 2, status: 'started' },
    } as never);

    const { result } = renderHook(() => useRenderCache());

    await waitFor(() => {
      expect(result.current.status).toEqual(mockStatus);
    });

    await act(async () => {
      await result.current.renderCache();
    });

    expect(result.current.isRendering).toBe(true);
    expect(result.current.progress).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('should reset state after clearing cache', async () => {
    vi.mocked(commands.getCacheStatus).mockResolvedValue({
      status: 'ok',
      data: mockStatus,
    } as never);
    vi.mocked(commands.clearRenderCache).mockResolvedValue({
      status: 'ok',
      data: { sequenceId: 'seq1', cleared: true },
    } as never);

    const { result } = renderHook(() => useRenderCache());

    await waitFor(() => {
      expect(result.current.status).toEqual(mockStatus);
    });

    await act(async () => {
      await result.current.clearCache();
    });

    expect(result.current.isRendering).toBe(false);
    expect(result.current.progress).toBe(0);
  });

  it('should stay idle when Tauri runtime is unavailable', async () => {
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];

    const { result } = renderHook(() => useRenderCache());

    // Give a tick for any potential async work
    await waitFor(() => {
      expect(result.current.status).toBeNull();
    });

    expect(commands.getCacheStatus).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.segments).toHaveLength(0);
  });
});
