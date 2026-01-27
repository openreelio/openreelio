/**
 * useJobs Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useJobs } from './useJobs';
import type { JobInfo, JobStats } from '@/types';

// =============================================================================
// Mocks
// =============================================================================

const mockInvoke = vi.fn();
const mockListen = vi.fn((event: string, callback: unknown) => {
  void event;
  void callback;
  return Promise.resolve(() => {});
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, callback: unknown) => mockListen(event, callback),
}));

// =============================================================================
// Test Data
// =============================================================================

const mockJobs: JobInfo[] = [
  {
    id: 'job_001',
    jobType: 'proxy_generation',
    priority: 'normal',
    status: { type: 'queued' },
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'job_002',
    jobType: 'thumbnail_generation',
    priority: 'preview',
    status: { type: 'running', progress: 50, message: 'Processing...' },
    createdAt: '2024-01-01T00:01:00Z',
  },
];

const mockStats: JobStats = {
  queueLength: 5,
  activeCount: 2,
  runningCount: 1,
  numWorkers: 4,
};

// =============================================================================
// Tests
// =============================================================================

describe('useJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case 'get_jobs':
          return Promise.resolve(mockJobs);
        case 'get_job_stats':
          return Promise.resolve(mockStats);
        case 'submit_job':
          return Promise.resolve('job_003');
        case 'cancel_job':
          return Promise.resolve(true);
        case 'get_job':
          return Promise.resolve(mockJobs[0]);
        default:
          return Promise.reject(new Error(`Unknown command: ${command}`));
      }
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('initialization', () => {
    it('should fetch jobs on mount', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_jobs', undefined);
    });

    it('should fetch stats on mount', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.stats).toEqual(mockStats);
      });

      expect(mockInvoke).toHaveBeenCalledWith('get_job_stats', undefined);
    });

    it('should set up event listeners when enabled', async () => {
      renderHook(() => useJobs({ enableEvents: true }));

      await waitFor(() => {
        expect(mockListen).toHaveBeenCalled();
      });

      const listenedEvents = mockListen.mock.calls.map(([event]) => event);
      expect(listenedEvents).toEqual(
        expect.arrayContaining([
          'job-progress',
          'job:progress',
          'job-complete',
          'job:completed',
          'job-failed',
          'job:failed',
        ])
      );
    });

    it('should not set up event listeners when disabled', async () => {
      const { result } = renderHook(() => useJobs({ enableEvents: false }));

      // Wait for initial fetch to complete to avoid act warnings
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockListen).not.toHaveBeenCalled();
    });
  });

  describe('submitJob', () => {
    it('should submit a job and return job ID', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let jobId: string | undefined;
      await act(async () => {
        jobId = await result.current.submitJob(
          'waveform_generation',
          { assetId: 'asset_001' },
          'user_request'
        );
      });

      expect(jobId).toBe('job_003');
      expect(mockInvoke).toHaveBeenCalledWith('submit_job', {
        jobType: 'waveform_generation',
        priority: 'user_request',
        payload: { assetId: 'asset_001' },
      });
    });

    it('should refresh jobs after submission', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      await act(async () => {
        await result.current.submitJob('transcription', {});
      });

      // get_jobs should be called at least twice (initial + after submit)
      const getJobsCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      );
      expect(getJobsCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle submission errors', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Set up mock to fail for submit_job
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'submit_job') {
          return Promise.reject(new Error('Queue is full'));
        }
        return Promise.resolve([]);
      });

      await act(async () => {
        try {
          await result.current.submitJob('indexing', {});
        } catch {
          // Expected to throw
        }
      });

      await waitFor(() => {
        expect(result.current.error).toBe('Queue is full');
      });
    });
  });

  describe('cancelJob', () => {
    it('should cancel a job and return success', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      let cancelled = false;
      await act(async () => {
        cancelled = await result.current.cancelJob('job_001');
      });

      expect(cancelled).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('cancel_job', { jobId: 'job_001' });
    });

    it('should refresh jobs after cancellation', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      await act(async () => {
        await result.current.cancelJob('job_001');
      });

      // Verify refresh was called
      const getJobsCalls = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      );
      expect(getJobsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getJob', () => {
    it('should get a specific job by ID', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let job: JobInfo | null = null;
      await act(async () => {
        job = await result.current.getJob('job_001');
      });

      expect(job).toEqual(mockJobs[0]);
      expect(mockInvoke).toHaveBeenCalledWith('get_job', { jobId: 'job_001' });
    });

    it('should return null for non-existent job', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_job') {
          return Promise.resolve(null);
        }
        return Promise.resolve([]);
      });

      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let job: JobInfo | null = null;
      await act(async () => {
        job = await result.current.getJob('nonexistent');
      });

      expect(job).toBeNull();
    });
  });

  describe('refreshJobs', () => {
    it('should manually refresh jobs', async () => {
      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'get_jobs') {
          return Promise.resolve([mockJobs[0]]);
        }
        return Promise.resolve(mockStats);
      });

      await act(async () => {
        await result.current.refreshJobs();
      });

      expect(result.current.jobs).toHaveLength(1);
    });
  });

  describe('polling', () => {
    it('should start polling when enabled', async () => {
      const { result, unmount } = renderHook(() =>
        useJobs({ enablePolling: true, pollingInterval: 100 })
      );

      // Wait for initial fetch
      await waitFor(() => {
        expect(result.current.jobs).toHaveLength(2);
      });

      const initialCallCount = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      ).length;

      // Wait for at least one polling cycle
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });

      const afterPollCallCount = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      ).length;

      expect(afterPollCallCount).toBeGreaterThan(initialCallCount);

      // Clean up
      unmount();
    });

    it('should not poll when disabled', async () => {
      const { result, unmount } = renderHook(() =>
        useJobs({ enablePolling: false, pollingInterval: 100 })
      );

      // Wait for initial fetch to complete
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialCallCount = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      ).length;

      // Wait some time without act() since we're not expecting state changes
      await act(async () => {
        await new Promise((r) => setTimeout(r, 250));
      });

      const afterTimeCallCount = mockInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'get_jobs'
      ).length;

      // Should not have additional calls from polling
      expect(afterTimeCallCount).toBe(initialCallCount);

      // Clean up
      unmount();
    });
  });

  describe('error handling', () => {
    it('should set error state on fetch failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('should clear error on successful operation', async () => {
      // Set up to fail initially
      mockInvoke.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useJobs());

      await waitFor(() => {
        expect(result.current.error).toBe('Network error');
      });

      // Now set up to succeed
      mockInvoke.mockResolvedValue(mockJobs);

      // Refresh should clear error
      await act(async () => {
        await result.current.refreshJobs();
      });

      await waitFor(() => {
        expect(result.current.error).toBeNull();
      });
    });
  });
});
