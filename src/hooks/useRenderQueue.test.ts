/**
 * useRenderQueue Hook Tests
 *
 * Verifies the queue subscribes before batch start and keeps cancellation
 * state aligned with backend responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { useRenderQueue } from './useRenderQueue';
import { DESKTOP_RUNTIME_TEST_FLAG } from '@/services/runtimeEnvironment';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

type EventHandler = (event: { payload: unknown }) => void;

describe('useRenderQueue', () => {
  const handlers = new Map<string, EventHandler>();

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = true;
    vi.mocked(save).mockResolvedValue('/tmp/out.mp4');
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      handlers.set(String(event), handler as EventHandler);
      return () => {
        handlers.delete(String(event));
      };
    });
  });

  afterEach(() => {
    globalThis[DESKTOP_RUNTIME_TEST_FLAG] = undefined;
  });

  it('should subscribe to batch events before a batch starts', () => {
    renderHook(() =>
      useRenderQueue({
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    return waitFor(() => {
      expect(handlers.has('batch-render-progress')).toBe(true);
      expect(handlers.has('batch-item-complete')).toBe(true);
      expect(handlers.has('batch-render-complete')).toBe(true);
    });
  });

  it('should process an immediate batch completion event after startBatchRender', async () => {
    vi.mocked(invoke).mockResolvedValue({
      batchId: 'batch-1',
      jobIds: ['job-1'],
      totalItems: 1,
      status: 'started',
    });

    const { result } = renderHook(() =>
      useRenderQueue({
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    await act(async () => {
      await result.current.addToQueue('youtube_1080p');
    });

    await act(async () => {
      await result.current.startBatchRender();
    });

    await act(async () => {
      handlers.get('batch-item-complete')?.({
        payload: {
          batchId: 'batch-1',
          jobId: 'job-1',
          itemIndex: 0,
          totalItems: 1,
          status: 'completed',
          outputPath: '/tmp/out.mp4',
        },
      });
    });

    await waitFor(() => {
      expect(result.current.queue[0]?.status).toBe('completed');
    });
  });

  it('should not mark a job as cancelled when the backend reports not found', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/out.mp4');
    vi.mocked(invoke).mockResolvedValueOnce({
      batchId: 'batch-1',
      jobIds: ['job-1'],
      totalItems: 1,
      status: 'started',
    });

    const { result } = renderHook(() =>
      useRenderQueue({
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    await act(async () => {
      await result.current.addToQueue('youtube_1080p');
    });

    await act(async () => {
      await result.current.startBatchRender();
    });

    await waitFor(() => {
      expect(result.current.queue[0]?.status).toBe('rendering');
    });

    vi.mocked(invoke).mockResolvedValueOnce({
      jobId: 'job-1',
      cancelled: false,
    });

    await act(async () => {
      await result.current.cancelJob('job-1');
    });

    expect(result.current.queue[0]?.status).toBe('rendering');
  });

  it('should start a queued batch even when the current range inputs become invalid later', async () => {
    vi.mocked(invoke).mockResolvedValue({
      batchId: 'batch-1',
      jobIds: ['job-1'],
      totalItems: 1,
      status: 'started',
    });

    const { result } = renderHook(() =>
      useRenderQueue({
        sequenceId: 'sequence-1',
        sequenceName: 'Sequence',
      }),
    );

    await act(async () => {
      result.current.setUseRange(true);
      result.current.setInPoint(1);
      result.current.setOutPoint(5);
    });

    await act(async () => {
      await result.current.addToQueue('youtube_1080p');
    });

    await act(async () => {
      result.current.setInPoint(8);
      result.current.setOutPoint(4);
    });

    await act(async () => {
      await result.current.startBatchRender();
    });

    expect(invoke).toHaveBeenCalledWith('batch_render', {
      sequenceId: 'sequence-1',
      items: [
        {
          preset: 'youtube_1080p',
          outputPath: '/tmp/out.mp4',
          inPoint: 1,
          outPoint: 5,
        },
      ],
    });
  });
});
