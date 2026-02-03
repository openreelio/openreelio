/**
 * Render Queue Store Tests
 *
 * Tests for render-specific queue management extending the base jobs store.
 * Following TDD methodology - tests written first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  COMPLETED_JOB_MAX_AGE_MS,
  useRenderQueueStore,
} from './renderQueueStore';

describe('renderQueueStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    act(() => {
      useRenderQueueStore.getState().clearAll();
    });
  });

  // ===========================================================================
  // Job Creation
  // ===========================================================================

  describe('job creation', () => {
    it('should add a video render job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      expect(result.current.jobs.length).toBe(1);
      expect(result.current.jobs[0].config.type).toBe('video');
      expect(result.current.jobs[0].status).toBe('pending');
    });

    it('should add a still render job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'still',
          sequenceId: 'seq-123',
          outputPath: '/output/frame.png',
          frame: 150,
          format: 'png',
        });
      });

      expect(result.current.jobs.length).toBe(1);
      expect(result.current.jobs[0].config.type).toBe('still');
    });

    it('should add a sequence render job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'sequence',
          sequenceId: 'seq-123',
          outputPath: '/output/frames/',
          startFrame: 0,
          endFrame: 300,
          format: 'png',
        });
      });

      expect(result.current.jobs.length).toBe(1);
      expect(result.current.jobs[0].config.type).toBe('sequence');
    });

    it('should generate unique job IDs', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
      });

      expect(result.current.jobs[0].id).not.toBe(result.current.jobs[1].id);
    });

    it('should set creation timestamp', () => {
      const { result } = renderHook(() => useRenderQueueStore());
      const before = Date.now();

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      const after = Date.now();
      expect(result.current.jobs[0].createdAt).toBeGreaterThanOrEqual(before);
      expect(result.current.jobs[0].createdAt).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // Job Status Management
  // ===========================================================================

  describe('job status management', () => {
    it('should start a pending job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      act(() => {
        result.current.startJob(jobId);
      });

      expect(result.current.jobs[0].status).toBe('rendering');
      expect(result.current.jobs[0].startedAt).toBeDefined();
    });

    it('should complete a job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.completeJob(jobId, { fileSize: 1024000, duration: 120 });
      });

      expect(result.current.jobs[0].status).toBe('completed');
      expect(result.current.jobs[0].completedAt).toBeDefined();
      expect(result.current.jobs[0].result?.fileSize).toBe(1024000);
    });

    it('should fail a job with error', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.failJob(jobId, 'FFmpeg error: Invalid codec');
      });

      expect(result.current.jobs[0].status).toBe('failed');
      expect(result.current.jobs[0].error).toBe('FFmpeg error: Invalid codec');
    });

    it('should cancel a pending job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      act(() => {
        result.current.cancelJob(jobId);
      });

      expect(result.current.jobs[0].status).toBe('cancelled');
    });

    it('should cancel a running job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.cancelJob(jobId);
      });

      expect(result.current.jobs[0].status).toBe('cancelled');
    });
  });

  // ===========================================================================
  // Progress Tracking
  // ===========================================================================

  describe('progress tracking', () => {
    it('should update progress percentage', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.updateProgress(jobId, {
          percent: 50,
          frame: 150,
          totalFrames: 300,
        });
      });

      expect(result.current.jobs[0].progress.percent).toBe(50);
      expect(result.current.jobs[0].progress.frame).toBe(150);
      expect(result.current.jobs[0].progress.totalFrames).toBe(300);
    });

    it('should update progress phase', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.updateProgress(jobId, { phase: 'encoding' });
      });

      expect(result.current.jobs[0].progress.phase).toBe('encoding');
    });

    it('should update fps and eta', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.updateProgress(jobId, {
          fps: 45.5,
          etaSeconds: 120,
        });
      });

      expect(result.current.jobs[0].progress.fps).toBe(45.5);
      expect(result.current.jobs[0].progress.etaSeconds).toBe(120);
    });

    it('should update progress message', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
      });

      act(() => {
        result.current.updateProgress(jobId, {
          message: 'Encoding frame 150/300',
        });
      });

      expect(result.current.jobs[0].progress.message).toBe('Encoding frame 150/300');
    });
  });

  // ===========================================================================
  // Housekeeping
  // ===========================================================================

  describe('pruneOldJobs', () => {
    it('should drop finished jobs without completedAt', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
        result.current.completeJob(jobId, { fileSize: 1024, duration: 1 });
      });

      act(() => {
        useRenderQueueStore.setState((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job) {
            job.completedAt = undefined;
          }
        });
      });

      act(() => {
        result.current.pruneOldJobs();
      });

      expect(result.current.jobs.find((j) => j.id === jobId)).toBeUndefined();
    });

    it('should remove finished jobs older than max age', () => {
      const now = 1_700_000_000_000;
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);

      try {
        const { result } = renderHook(() => useRenderQueueStore());

        let recentJobId: string = '';
        let oldJobId: string = '';

        act(() => {
          recentJobId = result.current.addRenderJob({
            type: 'video',
            sequenceId: 'seq-recent',
            outputPath: '/output/recent.mp4',
            preset: 'youtube-1080p',
          });
          result.current.startJob(recentJobId);
          result.current.completeJob(recentJobId, { fileSize: 1024, duration: 1 });

          oldJobId = result.current.addRenderJob({
            type: 'video',
            sequenceId: 'seq-old',
            outputPath: '/output/old.mp4',
            preset: 'youtube-1080p',
          });
          result.current.startJob(oldJobId);
          result.current.completeJob(oldJobId, { fileSize: 1024, duration: 1 });
        });

        act(() => {
          useRenderQueueStore.setState((state) => {
            const oldJob = state.jobs.find((j) => j.id === oldJobId);
            if (oldJob) {
              oldJob.completedAt = now - COMPLETED_JOB_MAX_AGE_MS - 1;
            }
          });
        });

        act(() => {
          result.current.pruneOldJobs();
        });

        expect(result.current.jobs.find((j) => j.id === recentJobId)).toBeDefined();
        expect(result.current.jobs.find((j) => j.id === oldJobId)).toBeUndefined();
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // Queue Operations
  // ===========================================================================

  describe('queue operations', () => {
    it('should get pending jobs', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        const id = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(id);
      });

      const pending = result.current.getPendingJobs();
      expect(pending.length).toBe(1);
      expect(pending[0].config.sequenceId).toBe('seq-1');
    });

    it('should get active jobs', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        const id = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(id);
      });

      const active = result.current.getActiveJobs();
      expect(active.length).toBe(1);
      expect(active[0].config.sequenceId).toBe('seq-2');
    });

    it('should remove a job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      expect(result.current.jobs.length).toBe(1);

      act(() => {
        result.current.removeJob(jobId);
      });

      expect(result.current.jobs.length).toBe(0);
    });

    it('should clear completed jobs', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let id1 = '';
      act(() => {
        id1 = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });

        result.current.startJob(id1);
        result.current.completeJob(id1, {});
      });

      expect(result.current.jobs.length).toBe(2);

      act(() => {
        result.current.clearCompleted();
      });

      expect(result.current.jobs.length).toBe(1);
      expect(result.current.jobs[0].status).toBe('pending');
    });

    it('should clear all jobs', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
      });

      expect(result.current.jobs.length).toBe(2);

      act(() => {
        result.current.clearAll();
      });

      expect(result.current.jobs.length).toBe(0);
    });
  });

  // ===========================================================================
  // Priority Queue
  // ===========================================================================

  describe('priority queue', () => {
    it('should set job priority', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      act(() => {
        result.current.setPriority(jobId, 'high');
      });

      expect(result.current.jobs[0].priority).toBe('high');
    });

    it('should sort pending jobs by priority', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        const id2 = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
        result.current.setPriority(id2, 'high');
      });

      const pending = result.current.getPendingJobs();
      expect(pending[0].config.sequenceId).toBe('seq-2'); // High priority first
      expect(pending[1].config.sequenceId).toBe('seq-1');
    });
  });

  // ===========================================================================
  // Retry Jobs
  // ===========================================================================

  describe('retry jobs', () => {
    it('should retry a failed job', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
        result.current.startJob(jobId);
        result.current.failJob(jobId, 'Error');
      });

      expect(result.current.jobs[0].status).toBe('failed');

      act(() => {
        result.current.retryJob(jobId);
      });

      expect(result.current.jobs[0].status).toBe('pending');
      expect(result.current.jobs[0].error).toBeUndefined();
      expect(result.current.jobs[0].retryCount).toBe(1);
    });

    it('should track retry count', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      // Fail and retry multiple times
      act(() => {
        result.current.startJob(jobId);
        result.current.failJob(jobId, 'Error 1');
        result.current.retryJob(jobId);
      });

      expect(result.current.jobs[0].retryCount).toBe(1);

      act(() => {
        result.current.startJob(jobId);
        result.current.failJob(jobId, 'Error 2');
        result.current.retryJob(jobId);
      });

      expect(result.current.jobs[0].retryCount).toBe(2);
    });
  });

  // ===========================================================================
  // Job Lookup
  // ===========================================================================

  describe('job lookup', () => {
    it('should get job by ID', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      let jobId: string = '';
      act(() => {
        jobId = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-123',
          outputPath: '/output/video.mp4',
          preset: 'youtube-1080p',
        });
      });

      const job = result.current.getJob(jobId);
      expect(job?.config.sequenceId).toBe('seq-123');
    });

    it('should return undefined for non-existent job', () => {
      const { result } = renderHook(() => useRenderQueueStore());
      const job = result.current.getJob('non-existent');
      expect(job).toBeUndefined();
    });
  });

  // ===========================================================================
  // Queue Stats
  // ===========================================================================

  describe('queue stats', () => {
    it('should calculate queue statistics', () => {
      const { result } = renderHook(() => useRenderQueueStore());

      act(() => {
        const id1 = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-1',
          outputPath: '/output/video1.mp4',
          preset: 'youtube-1080p',
        });
        result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-2',
          outputPath: '/output/video2.mp4',
          preset: 'youtube-1080p',
        });
        const id3 = result.current.addRenderJob({
          type: 'video',
          sequenceId: 'seq-3',
          outputPath: '/output/video3.mp4',
          preset: 'youtube-1080p',
        });

        result.current.startJob(id1);
        result.current.completeJob(id1, {});
        result.current.startJob(id3);
        result.current.failJob(id3, 'Error');
      });

      const stats = result.current.getStats();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(1);
      expect(stats.rendering).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
    });
  });
});
