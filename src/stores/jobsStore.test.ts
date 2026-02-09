/**
 * Jobs Store Tests
 *
 * Tests for Zustand jobs store using TDD methodology.
 * Tests cover job lifecycle, progress tracking, and state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useJobsStore,
  selectPendingJobs,
  selectRunningJobs,
  selectCompletedJobs,
  selectFailedJobs,
} from './jobsStore';

// =============================================================================
// Test Setup
// =============================================================================

describe('jobsStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useJobsStore.setState({
      jobs: [],
      activeJobId: null,
    });
  });

  // ===========================================================================
  // Initial State Tests
  // ===========================================================================

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const state = useJobsStore.getState();

      expect(state.jobs).toEqual([]);
      expect(state.activeJobId).toBeNull();
    });
  });

  // ===========================================================================
  // JobType Enumeration Tests
  // ===========================================================================

  describe('JobType enumeration', () => {
    it('should accept all backend IPC job types', () => {
      const backendTypes: Array<import('./jobsStore').JobType> = [
        'proxy_generation',
        'thumbnail_generation',
        'waveform_generation',
        'indexing',
        'transcription',
        'preview_render',
        'final_render',
        'ai_completion',
      ];

      for (const type of backendTypes) {
        useJobsStore.getState().addJob({ id: `job-${type}`, type, title: `Test ${type}` });
      }

      const jobs = useJobsStore.getState().jobs;
      expect(jobs).toHaveLength(backendTypes.length);
      for (const type of backendTypes) {
        expect(jobs.find((j) => j.type === type)).toBeDefined();
      }
    });

    it('should accept all legacy frontend job types', () => {
      const legacyTypes: Array<import('./jobsStore').JobType> = [
        'render',
        'export',
        'transcode',
        'ai_process',
        'import',
      ];

      for (const type of legacyTypes) {
        useJobsStore.getState().addJob({ id: `job-${type}`, type, title: `Test ${type}` });
      }

      expect(useJobsStore.getState().jobs).toHaveLength(legacyTypes.length);
    });
  });

  // ===========================================================================
  // Add Job Tests
  // ===========================================================================

  describe('addJob', () => {
    it('should add a new job with pending status', () => {
      const { addJob } = useJobsStore.getState();

      addJob({
        id: 'job_001',
        type: 'render',
        title: 'Render Video',
      });

      const state = useJobsStore.getState();
      expect(state.jobs.length).toBe(1);
      expect(state.jobs[0].id).toBe('job_001');
      expect(state.jobs[0].status).toBe('pending');
    });

    it('should initialize job with default progress', () => {
      const { addJob } = useJobsStore.getState();

      addJob({
        id: 'job_001',
        type: 'render',
        title: 'Render Video',
      });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.current).toBe(0);
      expect(job.progress.total).toBe(100);
      expect(job.progress.percentage).toBe(0);
    });

    it('should set createdAt timestamp', () => {
      const beforeAdd = new Date().toISOString();
      const { addJob } = useJobsStore.getState();

      addJob({
        id: 'job_001',
        type: 'render',
        title: 'Render Video',
      });

      const afterAdd = new Date().toISOString();
      const job = useJobsStore.getState().jobs[0];
      expect(job.createdAt).toBeDefined();
      expect(job.createdAt >= beforeAdd).toBe(true);
      expect(job.createdAt <= afterAdd).toBe(true);
    });

    it('should add job with optional metadata', () => {
      const { addJob } = useJobsStore.getState();

      addJob({
        id: 'job_001',
        type: 'export',
        title: 'Export Video',
        description: 'Exporting to MP4',
        metadata: { format: 'mp4', resolution: '1080p' },
      });

      const job = useJobsStore.getState().jobs[0];
      expect(job.description).toBe('Exporting to MP4');
      expect(job.metadata).toEqual({ format: 'mp4', resolution: '1080p' });
    });

    it('should add multiple jobs', () => {
      const { addJob } = useJobsStore.getState();

      addJob({ id: 'job_001', type: 'render', title: 'Job 1' });
      addJob({ id: 'job_002', type: 'export', title: 'Job 2' });
      addJob({ id: 'job_003', type: 'transcode', title: 'Job 3' });

      expect(useJobsStore.getState().jobs.length).toBe(3);
    });
  });

  // ===========================================================================
  // Update Job Status Tests
  // ===========================================================================

  describe('updateJobStatus', () => {
    beforeEach(() => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
    });

    it('should update job status to running', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'running');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('running');
    });

    it('should set startedAt when status changes to running', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'running');

      const job = useJobsStore.getState().jobs[0];
      expect(job.startedAt).toBeDefined();
    });

    it('should set completedAt when status changes to completed', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'completed');

      const job = useJobsStore.getState().jobs[0];
      expect(job.completedAt).toBeDefined();
    });

    it('should set completedAt when status changes to failed', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'failed');

      const job = useJobsStore.getState().jobs[0];
      expect(job.completedAt).toBeDefined();
    });

    it('should set completedAt when status changes to cancelled', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'cancelled');

      const job = useJobsStore.getState().jobs[0];
      expect(job.completedAt).toBeDefined();
    });

    it('should not modify startedAt if already set', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('job_001', 'running');

      const firstStartedAt = useJobsStore.getState().jobs[0].startedAt;

      // Pause briefly and update again
      updateJobStatus('job_001', 'running');

      const secondStartedAt = useJobsStore.getState().jobs[0].startedAt;
      expect(firstStartedAt).toBe(secondStartedAt);
    });

    it('should handle non-existent job', () => {
      const { updateJobStatus } = useJobsStore.getState();
      updateJobStatus('nonexistent', 'running');

      // Should not throw, state unchanged
      expect(useJobsStore.getState().jobs.length).toBe(1);
    });
  });

  // ===========================================================================
  // Update Job Progress Tests
  // ===========================================================================

  describe('updateJobProgress', () => {
    beforeEach(() => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
    });

    it('should update progress current value', () => {
      const { updateJobProgress } = useJobsStore.getState();
      updateJobProgress('job_001', { current: 50 });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.current).toBe(50);
      expect(job.progress.percentage).toBe(50);
    });

    it('should update progress with message', () => {
      const { updateJobProgress } = useJobsStore.getState();
      updateJobProgress('job_001', { current: 25, message: 'Rendering frame 25/100' });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.message).toBe('Rendering frame 25/100');
    });

    it('should calculate percentage correctly', () => {
      const { updateJobProgress } = useJobsStore.getState();
      updateJobProgress('job_001', { current: 75, total: 100 });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.percentage).toBe(75);
    });

    it('should calculate percentage with custom total', () => {
      const { updateJobProgress } = useJobsStore.getState();
      updateJobProgress('job_001', { current: 50, total: 200 });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.percentage).toBe(25); // 50/200 = 25%
    });

    it('should round percentage to nearest integer', () => {
      const { updateJobProgress } = useJobsStore.getState();
      updateJobProgress('job_001', { current: 33, total: 100 });

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.percentage).toBe(33);
    });
  });

  // ===========================================================================
  // Set Job Error Tests
  // ===========================================================================

  describe('setJobError', () => {
    beforeEach(() => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
    });

    it('should set error message', () => {
      const { setJobError } = useJobsStore.getState();
      setJobError('job_001', 'Encoding failed');

      const job = useJobsStore.getState().jobs[0];
      expect(job.error).toBe('Encoding failed');
    });

    it('should set status to failed', () => {
      const { setJobError } = useJobsStore.getState();
      setJobError('job_001', 'Encoding failed');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('failed');
    });

    it('should set completedAt timestamp', () => {
      const { setJobError } = useJobsStore.getState();
      setJobError('job_001', 'Encoding failed');

      const job = useJobsStore.getState().jobs[0];
      expect(job.completedAt).toBeDefined();
    });
  });

  // ===========================================================================
  // Remove Job Tests
  // ===========================================================================

  describe('removeJob', () => {
    beforeEach(() => {
      const { addJob } = useJobsStore.getState();
      addJob({ id: 'job_001', type: 'render', title: 'Job 1' });
      addJob({ id: 'job_002', type: 'export', title: 'Job 2' });
    });

    it('should remove job by id', () => {
      const { removeJob } = useJobsStore.getState();
      removeJob('job_001');

      const state = useJobsStore.getState();
      expect(state.jobs.length).toBe(1);
      expect(state.jobs[0].id).toBe('job_002');
    });

    it('should clear activeJobId if removed job was active', () => {
      useJobsStore.setState({ activeJobId: 'job_001' });

      const { removeJob } = useJobsStore.getState();
      removeJob('job_001');

      expect(useJobsStore.getState().activeJobId).toBeNull();
    });

    it('should not affect activeJobId if other job removed', () => {
      useJobsStore.setState({ activeJobId: 'job_001' });

      const { removeJob } = useJobsStore.getState();
      removeJob('job_002');

      expect(useJobsStore.getState().activeJobId).toBe('job_001');
    });
  });

  // ===========================================================================
  // Clear Completed Jobs Tests
  // ===========================================================================

  describe('clearCompletedJobs', () => {
    beforeEach(() => {
      const { addJob, updateJobStatus } = useJobsStore.getState();
      addJob({ id: 'job_pending', type: 'render', title: 'Pending' });
      addJob({ id: 'job_running', type: 'render', title: 'Running' });
      addJob({ id: 'job_completed', type: 'render', title: 'Completed' });
      addJob({ id: 'job_failed', type: 'render', title: 'Failed' });
      addJob({ id: 'job_cancelled', type: 'render', title: 'Cancelled' });

      updateJobStatus('job_running', 'running');
      updateJobStatus('job_completed', 'completed');
      updateJobStatus('job_failed', 'failed');
      updateJobStatus('job_cancelled', 'cancelled');
    });

    it('should remove completed jobs', () => {
      const { clearCompletedJobs } = useJobsStore.getState();
      clearCompletedJobs();

      const jobs = useJobsStore.getState().jobs;
      const hasCompleted = jobs.some((j) => j.status === 'completed');
      expect(hasCompleted).toBe(false);
    });

    it('should remove failed jobs', () => {
      const { clearCompletedJobs } = useJobsStore.getState();
      clearCompletedJobs();

      const jobs = useJobsStore.getState().jobs;
      const hasFailed = jobs.some((j) => j.status === 'failed');
      expect(hasFailed).toBe(false);
    });

    it('should remove cancelled jobs', () => {
      const { clearCompletedJobs } = useJobsStore.getState();
      clearCompletedJobs();

      const jobs = useJobsStore.getState().jobs;
      const hasCancelled = jobs.some((j) => j.status === 'cancelled');
      expect(hasCancelled).toBe(false);
    });

    it('should keep pending and running jobs', () => {
      const { clearCompletedJobs } = useJobsStore.getState();
      clearCompletedJobs();

      const jobs = useJobsStore.getState().jobs;
      expect(jobs.length).toBe(2);
      expect(jobs.some((j) => j.id === 'job_pending')).toBe(true);
      expect(jobs.some((j) => j.id === 'job_running')).toBe(true);
    });
  });

  // ===========================================================================
  // Cancel Job Tests
  // ===========================================================================

  describe('cancelJob', () => {
    it('should cancel pending job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });

      const { cancelJob } = useJobsStore.getState();
      cancelJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('cancelled');
      expect(job.completedAt).toBeDefined();
    });

    it('should cancel running job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobStatus('job_001', 'running');

      const { cancelJob } = useJobsStore.getState();
      cancelJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('cancelled');
    });

    it('should not cancel completed job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobStatus('job_001', 'completed');

      const { cancelJob } = useJobsStore.getState();
      cancelJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('completed');
    });

    it('should not cancel failed job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobStatus('job_001', 'failed');

      const { cancelJob } = useJobsStore.getState();
      cancelJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('failed');
    });
  });

  // ===========================================================================
  // Retry Job Tests
  // ===========================================================================

  describe('retryJob', () => {
    it('should retry failed job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().setJobError('job_001', 'Some error');

      const { retryJob } = useJobsStore.getState();
      retryJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('pending');
      expect(job.error).toBeUndefined();
      expect(job.startedAt).toBeUndefined();
      expect(job.completedAt).toBeUndefined();
    });

    it('should reset progress on retry', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobProgress('job_001', { current: 50 });
      useJobsStore.getState().setJobError('job_001', 'Some error');

      const { retryJob } = useJobsStore.getState();
      retryJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.progress.current).toBe(0);
      expect(job.progress.percentage).toBe(0);
    });

    it('should retry cancelled job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().cancelJob('job_001');

      const { retryJob } = useJobsStore.getState();
      retryJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('pending');
    });

    it('should not retry running job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobStatus('job_001', 'running');

      const { retryJob } = useJobsStore.getState();
      retryJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('running');
    });

    it('should not retry completed job', () => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
      useJobsStore.getState().updateJobStatus('job_001', 'completed');

      const { retryJob } = useJobsStore.getState();
      retryJob('job_001');

      const job = useJobsStore.getState().jobs[0];
      expect(job.status).toBe('completed');
    });
  });

  // ===========================================================================
  // Active Job Tests
  // ===========================================================================

  describe('setActiveJob', () => {
    it('should set active job', () => {
      const { setActiveJob } = useJobsStore.getState();
      setActiveJob('job_001');

      expect(useJobsStore.getState().activeJobId).toBe('job_001');
    });

    it('should clear active job with null', () => {
      useJobsStore.setState({ activeJobId: 'job_001' });

      const { setActiveJob } = useJobsStore.getState();
      setActiveJob(null);

      expect(useJobsStore.getState().activeJobId).toBeNull();
    });
  });

  describe('getJob', () => {
    beforeEach(() => {
      useJobsStore.getState().addJob({
        id: 'job_001',
        type: 'render',
        title: 'Test Job',
      });
    });

    it('should return job by id', () => {
      const { getJob } = useJobsStore.getState();
      const job = getJob('job_001');

      expect(job).toBeDefined();
      expect(job?.id).toBe('job_001');
    });

    it('should return undefined for non-existent job', () => {
      const { getJob } = useJobsStore.getState();
      const job = getJob('nonexistent');

      expect(job).toBeUndefined();
    });
  });

  // ===========================================================================
  // Computed Getters Tests
  // ===========================================================================

  describe('computed getters', () => {
    beforeEach(() => {
      const { addJob, updateJobStatus } = useJobsStore.getState();
      addJob({ id: 'pending_1', type: 'render', title: 'Pending 1' });
      addJob({ id: 'pending_2', type: 'render', title: 'Pending 2' });
      addJob({ id: 'running_1', type: 'export', title: 'Running 1' });
      addJob({ id: 'completed_1', type: 'transcode', title: 'Completed 1' });
      addJob({ id: 'failed_1', type: 'render', title: 'Failed 1' });

      updateJobStatus('running_1', 'running');
      updateJobStatus('completed_1', 'completed');
      updateJobStatus('failed_1', 'failed');
    });

    describe('selectPendingJobs', () => {
      it('should return only pending jobs', () => {
        const state = useJobsStore.getState();
        const pending = selectPendingJobs(state);

        expect(pending.length).toBe(2);
        expect(pending.every((j) => j.status === 'pending')).toBe(true);
      });
    });

    describe('selectRunningJobs', () => {
      it('should return only running jobs', () => {
        const state = useJobsStore.getState();
        const running = selectRunningJobs(state);

        expect(running.length).toBe(1);
        expect(running[0].id).toBe('running_1');
      });
    });

    describe('selectCompletedJobs', () => {
      it('should return only completed jobs', () => {
        const state = useJobsStore.getState();
        const completed = selectCompletedJobs(state);

        expect(completed.length).toBe(1);
        expect(completed[0].id).toBe('completed_1');
      });
    });

    describe('selectFailedJobs', () => {
      it('should return only failed jobs', () => {
        const state = useJobsStore.getState();
        const failed = selectFailedJobs(state);

        expect(failed.length).toBe(1);
        expect(failed[0].id).toBe('failed_1');
      });
    });
  });
});
