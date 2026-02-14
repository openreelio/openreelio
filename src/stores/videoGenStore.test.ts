/**
 * Video Generation Store Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVideoGenStore, type VideoGenJob } from './videoGenStore';

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

function createJob(overrides: Partial<VideoGenJob> = {}): VideoGenJob {
  return {
    id: 'job-1',
    providerJobId: 'remote-1',
    prompt: 'Test prompt',
    mode: 'text_to_video',
    quality: 'pro',
    durationSec: 10,
    status: 'queued',
    progress: 0,
    estimatedCostCents: 5,
    actualCostCents: null,
    assetId: null,
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('videoGenStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVideoGenStore.setState({
      jobs: new Map(),
      isPolling: false,
      pollingIntervalId: null,
      isPollInFlight: false,
      completionInFlight: new Set(),
    });
  });

  afterEach(() => {
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

    it('given an empty prompt when submitting then it rejects before IPC', async () => {
      await expect(
        useVideoGenStore.getState().submitGeneration({
          prompt: '   ',
        }),
      ).rejects.toThrow('Prompt cannot be empty');

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('given malformed inputs when submitting then payload is normalized defensively', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'local-2',
        providerJobId: 'remote-2',
        estimatedCostCents: 12,
      });

      await useVideoGenStore.getState().submitGeneration({
        prompt: '   normalized prompt   ',
        durationSec: 999,
        aspectRatio: 'invalid-aspect',
        referenceImages: ['  /a.png  ', '', '/b.png', '/c.png', '/d.png', '/e.png', '/f.png', '/g.png', '/h.png', '/i.png', '/j.png'],
        referenceVideos: [' /v1.mp4 ', '/v2.mp4', '/v3.mp4', '/v4.mp4'],
        referenceAudio: [' /a1.wav ', '/a2.wav', '/a3.wav', '/a4.wav'],
      });

      const call = mockInvoke.mock.calls.find((args) => args[0] === 'submit_video_generation');
      expect(call).toBeDefined();

      const request = (call?.[1] as { request: Record<string, unknown> }).request;
      expect(request.prompt).toBe('normalized prompt');
      expect(request.durationSec).toBe(120);
      expect(request.aspectRatio).toBe('16:9');
      expect(request.referenceImages).toEqual([
        '/a.png',
        '/b.png',
        '/c.png',
        '/d.png',
        '/e.png',
        '/f.png',
        '/g.png',
        '/h.png',
        '/i.png',
      ]);
      expect(request.referenceVideos).toEqual(['/v1.mp4', '/v2.mp4', '/v3.mp4']);
      expect(request.referenceAudio).toEqual(['/a1.wav', '/a2.wav', '/a3.wav']);
    });

    it('given NaN durationSec when submitting then defaults to 10', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'local-nan',
        providerJobId: 'remote-nan',
        estimatedCostCents: 10,
      });

      await useVideoGenStore.getState().submitGeneration({
        prompt: 'Test',
        durationSec: Number.NaN,
      });

      const call = mockInvoke.mock.calls.find((args) => args[0] === 'submit_video_generation');
      const request = (call?.[1] as { request: Record<string, unknown> }).request;
      expect(request.durationSec).toBe(10);
    });

    it('given negative durationSec when submitting then clamps to minimum 5', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'local-neg',
        providerJobId: 'remote-neg',
        estimatedCostCents: 10,
      });

      await useVideoGenStore.getState().submitGeneration({
        prompt: 'Test',
        durationSec: -5,
      });

      const call = mockInvoke.mock.calls.find((args) => args[0] === 'submit_video_generation');
      const request = (call?.[1] as { request: Record<string, unknown> }).request;
      expect(request.durationSec).toBe(5);
    });

    it('given Infinity durationSec when submitting then defaults to 10', async () => {
      mockInvoke.mockResolvedValueOnce({
        jobId: 'local-inf',
        providerJobId: 'remote-inf',
        estimatedCostCents: 10,
      });

      await useVideoGenStore.getState().submitGeneration({
        prompt: 'Test',
        durationSec: Infinity,
      });

      const call = mockInvoke.mock.calls.find((args) => args[0] === 'submit_video_generation');
      const request = (call?.[1] as { request: Record<string, unknown> }).request;
      expect(request.durationSec).toBe(10);
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
      const jobs = new Map<string, VideoGenJob>([
        ['job-1', createJob({ id: 'job-1', status: 'queued' })],
      ]);
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

      await useVideoGenStore.getState().pollActiveJobs();

      expect(useVideoGenStore.getState().isPolling).toBe(false);
    });

    it('given network latency when poll is invoked twice then second cycle is skipped', async () => {
      const jobs = new Map<string, VideoGenJob>([
        ['job-1', createJob({ id: 'job-1', status: 'queued' })],
      ]);
      useVideoGenStore.setState({ jobs });

      let resolvePoll: ((value: unknown) => void) | undefined;
      const delayedPoll = new Promise((resolve) => {
        resolvePoll = resolve;
      });

      mockInvoke.mockImplementation(async (command) => {
        if (command === 'poll_generation_job') {
          await delayedPoll;
          return {
            status: 'processing',
            progress: 25,
            message: 'Delayed',
            downloadUrl: null,
            durationSec: null,
            hasAudio: null,
            error: null,
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      });

      const firstPoll = useVideoGenStore.getState().pollActiveJobs();
      const secondPoll = useVideoGenStore.getState().pollActiveJobs();

      expect(useVideoGenStore.getState().isPollInFlight).toBe(true);
      expect(mockInvoke).toHaveBeenCalledTimes(1);

      resolvePoll?.(null);
      await Promise.all([firstPoll, secondPoll]);

      expect(useVideoGenStore.getState().isPollInFlight).toBe(false);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelJob', () => {
    it('should cancel a job and update status', async () => {
      const jobs = new Map<string, VideoGenJob>([
        ['job-1', createJob({ id: 'job-1', status: 'processing', progress: 50 })],
      ]);
      useVideoGenStore.setState({ jobs });

      mockInvoke.mockResolvedValueOnce(true);

      await useVideoGenStore.getState().cancelJob('job-1');

      const job = useVideoGenStore.getState().getJob('job-1');
      expect(job!.status).toBe('cancelled');
      expect(job!.completedAt).not.toBeNull();
    });

    it('should cancel a job in submitting state locally', async () => {
      const jobs = new Map<string, VideoGenJob>([
        ['job-2', createJob({ id: 'job-2', providerJobId: null, status: 'submitting' })],
      ]);
      useVideoGenStore.setState({ jobs });

      await useVideoGenStore.getState().cancelJob('job-2');

      const job = useVideoGenStore.getState().getJob('job-2');
      expect(job!.status).toBe('cancelled');
      expect(job!.completedAt).not.toBeNull();
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('given backend cancellation failure when canceling then error is propagated', async () => {
      const jobs = new Map<string, VideoGenJob>([
        ['job-1', createJob({ id: 'job-1', status: 'processing' })],
      ]);
      useVideoGenStore.setState({ jobs });

      mockInvoke.mockRejectedValueOnce(new Error('cancel failed'));

      await expect(useVideoGenStore.getState().cancelJob('job-1')).rejects.toThrow('cancel failed');
    });
  });

  describe('onJobCompleted', () => {
    it('given duplicate completion triggers when importing then workflow runs once', async () => {
      const jobs = new Map<string, VideoGenJob>([
        ['job-1', createJob({ id: 'job-1', status: 'downloading' })],
      ]);
      useVideoGenStore.setState({ jobs });

      let resolveDownload: ((value: unknown) => void) | undefined;
      const delayedDownload = new Promise((resolve) => {
        resolveDownload = resolve;
      });

      mockInvoke.mockImplementation(async (command) => {
        if (command === 'download_generated_video') {
          await delayedDownload;
          return { outputPath: '/tmp/generated.mp4' };
        }
        if (command === 'import_asset') {
          return { id: 'asset-1' };
        }
        if (command === 'generate_asset_thumbnail') {
          return null;
        }
        throw new Error(`Unexpected command: ${command}`);
      });

      const first = useVideoGenStore.getState().onJobCompleted('job-1');
      const second = useVideoGenStore.getState().onJobCompleted('job-1');

      resolveDownload?.(null);
      await Promise.all([first, second]);

      const downloadCalls = mockInvoke.mock.calls.filter((args) => args[0] === 'download_generated_video');
      expect(downloadCalls).toHaveLength(1);
      expect(useVideoGenStore.getState().completionInFlight.size).toBe(0);

      const job = useVideoGenStore.getState().getJob('job-1');
      expect(job?.status).toBe('completed');
      expect(job?.assetId).toBe('asset-1');
    });
  });

  describe('clearCompletedJobs', () => {
    it('should remove terminal jobs', () => {
      const jobs = new Map<string, VideoGenJob>([
        ['completed-1', createJob({ id: 'completed-1', status: 'completed', assetId: 'asset-1', completedAt: new Date().toISOString() })],
        ['active-1', createJob({ id: 'active-1', status: 'processing', progress: 50 })],
      ]);
      useVideoGenStore.setState({ jobs });

      useVideoGenStore.getState().clearCompletedJobs();

      expect(useVideoGenStore.getState().jobs.size).toBe(1);
      expect(useVideoGenStore.getState().getJob('active-1')).toBeDefined();
      expect(useVideoGenStore.getState().getJob('completed-1')).toBeUndefined();
    });
  });

  describe('getActiveJobs', () => {
    it('should return only non-terminal jobs', () => {
      const jobs = new Map<string, VideoGenJob>([
        ['active', createJob({ id: 'active', status: 'processing', progress: 30 })],
        ['done', createJob({ id: 'done', status: 'completed', progress: 100, assetId: 'a-1', completedAt: new Date().toISOString() })],
      ]);
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

