/**
 * Video Generation Store Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVideoGenStore } from './videoGenStore';

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { invoke } = await import('@tauri-apps/api/core');
const mockInvoke = vi.mocked(invoke);

describe('videoGenStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useVideoGenStore.setState({
      jobs: new Map(),
      isPolling: false,
      pollingIntervalId: null,
    });
  });

  afterEach(() => {
    // Stop polling to clean up intervals
    useVideoGenStore.getState().stopPolling();
  });

  describe('submitGeneration', () => {
    it('should submit a video generation job and update state', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'local-1',
        providerJobId: 'remote-1',
        estimatedCostCents: 15,
      });

      const jobId = await useVideoGenStore.getState().submitGeneration({
        prompt: 'A sunset timelapse',
        quality: 'pro',
        durationSec: 30,
      });

      expect(jobId).toBeTruthy();
      const job = useVideoGenStore.getState().getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.prompt).toBe('A sunset timelapse');
      expect(job!.providerJobId).toBe('remote-1');
      expect(job!.estimatedCostCents).toBe(15);
      expect(job!.status).toBe('queued');
    });

    it('should mark job as failed on submission error', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('API key not configured'));

      await expect(
        useVideoGenStore.getState().submitGeneration({
          prompt: 'Test',
        }),
      ).rejects.toThrow('API key not configured');

      const jobs = Array.from(useVideoGenStore.getState().jobs.values());
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('failed');
      expect(jobs[0].error).toBe('API key not configured');
    });

    it('should use default values for optional params', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'l-1',
        providerJobId: 'r-1',
        estimatedCostCents: 5,
      });

      const jobId = await useVideoGenStore.getState().submitGeneration({
        prompt: 'Test',
      });

      const job = useVideoGenStore.getState().getJob(jobId);
      expect(job!.mode).toBe('text_to_video');
      expect(job!.quality).toBe('pro');
      expect(job!.durationSec).toBe(10);
    });
  });

  describe('pollActiveJobs', () => {
    it('should update job status from poll results', async () => {
      // Setup a queued job
      const jobs = new Map();
      jobs.set('job-1', {
        id: 'job-1',
        providerJobId: 'remote-1',
        prompt: 'Test',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'queued' as const,
        progress: 0,
        estimatedCostCents: 5,
        actualCostCents: null,
        assetId: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      useVideoGenStore.setState({ jobs });

      mockInvoke.mockResolvedValueOnce({
        status: 'processing',
        progress: 50,
        message: 'Rendering frames',
        downloadUrl: null,
        durationSec: null,
        hasAudio: null,
        error: null,
      });

      await useVideoGenStore.getState().pollActiveJobs();

      const job = useVideoGenStore.getState().getJob('job-1');
      expect(job!.status).toBe('processing');
      expect(job!.progress).toBe(50);
    });

    it('should stop polling when no active jobs remain', async () => {
      useVideoGenStore.setState({ isPolling: true });

      // No active jobs
      await useVideoGenStore.getState().pollActiveJobs();

      expect(useVideoGenStore.getState().isPolling).toBe(false);
    });
  });

  describe('cancelJob', () => {
    it('should cancel a job and update status', async () => {
      const jobs = new Map();
      jobs.set('job-1', {
        id: 'job-1',
        providerJobId: 'remote-1',
        prompt: 'Test',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'processing' as const,
        progress: 50,
        estimatedCostCents: 5,
        actualCostCents: null,
        assetId: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      useVideoGenStore.setState({ jobs });

      mockInvoke.mockResolvedValueOnce(true);

      await useVideoGenStore.getState().cancelJob('job-1');

      const job = useVideoGenStore.getState().getJob('job-1');
      expect(job!.status).toBe('cancelled');
      expect(job!.completedAt).not.toBeNull();
    });
  });

  describe('clearCompletedJobs', () => {
    it('should remove terminal jobs', () => {
      const jobs = new Map();
      jobs.set('completed-1', {
        id: 'completed-1',
        providerJobId: 'r-1',
        prompt: 'Test',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'completed' as const,
        progress: 100,
        estimatedCostCents: 5,
        actualCostCents: 5,
        assetId: 'asset-1',
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      jobs.set('active-1', {
        id: 'active-1',
        providerJobId: 'r-2',
        prompt: 'Test 2',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'processing' as const,
        progress: 50,
        estimatedCostCents: 5,
        actualCostCents: null,
        assetId: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      useVideoGenStore.setState({ jobs });

      useVideoGenStore.getState().clearCompletedJobs();

      expect(useVideoGenStore.getState().jobs.size).toBe(1);
      expect(useVideoGenStore.getState().getJob('active-1')).toBeDefined();
      expect(useVideoGenStore.getState().getJob('completed-1')).toBeUndefined();
    });
  });

  describe('getActiveJobs', () => {
    it('should return only non-terminal jobs', () => {
      const jobs = new Map();
      jobs.set('active', {
        id: 'active',
        providerJobId: 'r-1',
        prompt: 'T',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'processing' as const,
        progress: 30,
        estimatedCostCents: 5,
        actualCostCents: null,
        assetId: null,
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
      jobs.set('done', {
        id: 'done',
        providerJobId: 'r-2',
        prompt: 'T',
        mode: 'text_to_video' as const,
        quality: 'pro' as const,
        durationSec: 10,
        status: 'completed' as const,
        progress: 100,
        estimatedCostCents: 5,
        actualCostCents: 5,
        assetId: 'a-1',
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      useVideoGenStore.setState({ jobs });

      const active = useVideoGenStore.getState().getActiveJobs();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('active');
    });
  });

  describe('polling lifecycle', () => {
    it('should start and stop polling', () => {
      useVideoGenStore.getState().startPolling();
      expect(useVideoGenStore.getState().isPolling).toBe(true);

      useVideoGenStore.getState().stopPolling();
      expect(useVideoGenStore.getState().isPolling).toBe(false);
    });

    it('should not start polling twice', () => {
      useVideoGenStore.getState().startPolling();
      const firstInterval = useVideoGenStore.getState().pollingIntervalId;

      useVideoGenStore.getState().startPolling();
      const secondInterval = useVideoGenStore.getState().pollingIntervalId;

      expect(firstInterval).toBe(secondInterval);
      useVideoGenStore.getState().stopPolling();
    });
  });
});
