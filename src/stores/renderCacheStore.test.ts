import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useRenderCacheStore } from './renderCacheStore';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

// Mock the Tauri IPC boundary only.
vi.mock('@/bindings', () => ({
  commands: {
    getCacheStatus: vi.fn(),
    renderPreviewCache: vi.fn(),
    clearRenderCache: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));

import { commands } from '@/bindings';
import type { CacheSegmentStatusDto } from '@/bindings';
import { listen } from '@tauri-apps/api/event';

const cachedSegment: CacheSegmentStatusDto = {
  index: 0,
  startSec: 0,
  endSec: 5,
  state: 'cached',
  fingerprint: '42',
  cachedPath: '/cache/seg-0.mp4',
  flagged: false,
  flagReasons: [],
};

const mockStatus = {
  enabled: true,
  sequenceId: 'seq1',
  totalSegments: 1,
  cachedSegments: 1,
  staleSegments: 0,
  renderingSegments: 0,
  completionPercent: 100,
  totalCachedBytes: 1024,
  maxCacheBytes: 1073741824,
  segmentStates: [cachedSegment],
};

/** Unlisten functions handed out by the mocked `listen`, in registration order. */
function unlistenResults(): Array<() => void> {
  return vi.mocked(listen).mock.results.map((result) => result.value as unknown as () => void);
}

describe('renderCacheStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-seeded per test: the global afterEach restores mocks, which would
    // otherwise strip this implementation after the first case.
    vi.mocked(listen).mockImplementation(() => Promise.resolve(vi.fn()));
    useRenderCacheStore.getState()._resetForTests();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
  });

  afterEach(() => {
    useRenderCacheStore.getState()._resetForTests();
    delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];
  });

  describe('listener ref-counting', () => {
    it('should register each backend event once when several consumers attach', async () => {
      const { attachListeners } = useRenderCacheStore.getState();

      attachListeners();
      attachListeners();

      await waitFor(() => {
        expect(listen).toHaveBeenCalledTimes(3);
      });

      const events = vi.mocked(listen).mock.calls.map(([event]) => event);
      expect(events).toEqual([
        'render-cache-progress',
        'render-cache-complete',
        'render-cache-error',
      ]);
    });

    it('should keep listeners alive until the last consumer detaches', async () => {
      const { attachListeners, detachListeners } = useRenderCacheStore.getState();

      attachListeners();
      attachListeners();

      await waitFor(() => {
        expect(listen).toHaveBeenCalledTimes(3);
      });

      const unlisteners = await Promise.all(unlistenResults());

      detachListeners();
      for (const unlisten of unlisteners) {
        expect(unlisten).not.toHaveBeenCalled();
      }

      detachListeners();
      for (const unlisten of unlisteners) {
        expect(unlisten).toHaveBeenCalledTimes(1);
      }
    });

    it('should register again after a full detach/attach cycle', async () => {
      const { attachListeners, detachListeners } = useRenderCacheStore.getState();

      attachListeners();
      await waitFor(() => expect(listen).toHaveBeenCalledTimes(3));
      detachListeners();

      attachListeners();
      await waitFor(() => expect(listen).toHaveBeenCalledTimes(6));
    });

    it('should not orphan listeners when attach/detach/attach happens inside one registration await', async () => {
      // React StrictMode does exactly this on every dev mount: the second
      // attach starts while the first registration is still awaiting listen().
      // Both would see a live ref-count on resolution, and without a
      // generation stamp the later one silently overwrites the earlier
      // handles, leaving the first set registered forever.
      let releasePending!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePending = resolve;
      });

      const created: Array<() => void> = [];
      vi.mocked(listen).mockImplementation(async () => {
        await gate;
        const unlisten = vi.fn();
        created.push(unlisten);
        return unlisten;
      });

      const { attachListeners, detachListeners } = useRenderCacheStore.getState();

      attachListeners();
      detachListeners();
      attachListeners();

      releasePending();
      await waitFor(() => {
        expect(created.length).toBe(6);
      });

      // Exactly one set survives; the orphaned set must have torn itself down.
      const tornDown = created.filter((unlisten) => vi.mocked(unlisten).mock.calls.length > 0);
      expect(tornDown).toHaveLength(3);

      detachListeners();
      for (const unlisten of created) {
        expect(unlisten).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('renderCache', () => {
    beforeEach(() => {
      vi.mocked(commands.getCacheStatus).mockResolvedValue({
        status: 'ok',
        data: mockStatus,
      } as never);
    });

    it('should pass the requested scope through to the backend', async () => {
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

      await useRenderCacheStore.getState().renderCache('flagged');

      expect(commands.renderPreviewCache).toHaveBeenCalledWith('flagged');
      expect(useRenderCacheStore.getState().isRendering).toBe(true);
    });

    it('should request the whole timeline when the scope is null', async () => {
      vi.mocked(commands.renderPreviewCache).mockResolvedValue({
        status: 'ok',
        data: {
          jobId: 'job-2',
          sequenceId: 'seq1',
          totalSegments: 1,
          segmentsToRender: 1,
          status: 'started',
        },
      } as never);

      await useRenderCacheStore.getState().renderCache(null);

      expect(commands.renderPreviewCache).toHaveBeenCalledWith(null);
    });

    it.each(['already_converging', 'retargeted'] as const)(
      'should leave a running fill untouched when it absorbed the request (%s)',
      async (status) => {
        vi.mocked(commands.renderPreviewCache).mockResolvedValue({
          status: 'ok',
          data: {
            jobId: 'running-job',
            sequenceId: 'seq1',
            totalSegments: 1,
            segmentsToRender: 1,
            status,
          },
        } as never);

        // A fill is already running and has reported progress.
        useRenderCacheStore.setState({ isRendering: true, progress: 42 });

        await useRenderCacheStore.getState().renderCache('flagged');

        // The running fill's own events keep both fields current; this call
        // must neither clear the rendering state nor rewind its progress.
        expect(useRenderCacheStore.getState().isRendering).toBe(true);
        expect(useRenderCacheStore.getState().progress).toBe(42);
        expect(useRenderCacheStore.getState().error).toBeNull();
      },
    );

    it('should not rewind a running fill before the backend has answered', async () => {
      let resolveCall!: (value: unknown) => void;
      vi.mocked(commands.renderPreviewCache).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCall = resolve;
          }) as never,
      );

      useRenderCacheStore.setState({ isRendering: true, progress: 42 });

      const pending = useRenderCacheStore.getState().renderCache('flagged');

      // In flight: nothing may be set optimistically.
      expect(useRenderCacheStore.getState().isRendering).toBe(true);
      expect(useRenderCacheStore.getState().progress).toBe(42);

      resolveCall({
        status: 'ok',
        data: {
          jobId: 'running-job',
          sequenceId: 'seq1',
          totalSegments: 1,
          segmentsToRender: 1,
          status: 'already_converging',
        },
      });
      await pending;

      expect(useRenderCacheStore.getState().progress).toBe(42);
    });

    it('should report a completed cache as fully rendered', async () => {
      vi.mocked(commands.renderPreviewCache).mockResolvedValue({
        status: 'ok',
        data: {
          jobId: 'job-3',
          sequenceId: 'seq1',
          totalSegments: 1,
          segmentsToRender: 0,
          status: 'already_cached',
        },
      } as never);

      await useRenderCacheStore.getState().renderCache('flagged');

      expect(useRenderCacheStore.getState().isRendering).toBe(false);
      expect(useRenderCacheStore.getState().progress).toBe(100);
    });

    it('should surface backend failures without latching a rendering state', async () => {
      vi.mocked(commands.renderPreviewCache).mockResolvedValue({
        status: 'error',
        error: 'ffmpeg exited with 1',
      } as never);

      await useRenderCacheStore.getState().renderCache('flagged');

      expect(useRenderCacheStore.getState().isRendering).toBe(false);
      // A successful status refresh follows and clears `error`; the failure
      // this call reported must survive it, or no UI could ever show it.
      expect(useRenderCacheStore.getState().error).toBe('ffmpeg exited with 1');
    });

    it('should surface a rejected fill request', async () => {
      vi.mocked(commands.renderPreviewCache).mockRejectedValue(new Error('IPC channel closed'));

      await useRenderCacheStore.getState().renderCache('flagged');

      expect(useRenderCacheStore.getState().error).toBe('IPC channel closed');
    });
  });

  describe('dead cached paths', () => {
    it('should remember a path marked dead', () => {
      useRenderCacheStore.getState().markCachedPathDead('/cache/seg-0.mp4');

      expect(useRenderCacheStore.getState().deadCachedPaths.has('/cache/seg-0.mp4')).toBe(true);
    });

    it('should drop death marks once a fresh status snapshot arrives', async () => {
      vi.mocked(commands.getCacheStatus).mockResolvedValue({
        status: 'ok',
        data: mockStatus,
      } as never);

      useRenderCacheStore.getState().markCachedPathDead('/cache/seg-0.mp4');
      await useRenderCacheStore.getState().refreshStatus();

      expect(useRenderCacheStore.getState().deadCachedPaths.size).toBe(0);
    });

    it('should keep death marks when the status refresh failed', async () => {
      vi.mocked(commands.getCacheStatus).mockResolvedValue({
        status: 'error',
        error: 'Failed to load cache manifest',
      } as never);

      useRenderCacheStore.getState().markCachedPathDead('/cache/seg-0.mp4');
      await useRenderCacheStore.getState().refreshStatus();

      expect(useRenderCacheStore.getState().deadCachedPaths.has('/cache/seg-0.mp4')).toBe(true);
    });
  });

  describe('refreshStatus', () => {
    it('should treat "no project open" as an empty status rather than an error', async () => {
      vi.mocked(commands.getCacheStatus).mockResolvedValue({
        status: 'error',
        error: 'No project open',
      } as never);

      await useRenderCacheStore.getState().refreshStatus();

      expect(useRenderCacheStore.getState().status).toBeNull();
      expect(useRenderCacheStore.getState().error).toBeNull();
    });

    it('should stay idle outside the desktop runtime', async () => {
      delete globalThis[DESKTOP_RUNTIME_TEST_FLAG];

      await useRenderCacheStore.getState().refreshStatus();

      expect(commands.getCacheStatus).not.toHaveBeenCalled();
      expect(useRenderCacheStore.getState().status).toBeNull();
      expect(useRenderCacheStore.getState().error).toBeNull();
    });
  });
});
