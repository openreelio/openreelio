/**
 * Jobs Store
 *
 * Manages background job state including render jobs, export jobs, and AI processing.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// =============================================================================
// Types
// =============================================================================

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type JobType = 'render' | 'export' | 'transcode' | 'ai_process' | 'import';

export interface JobProgress {
  current: number;
  total: number;
  percentage: number;
  message?: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  title: string;
  description?: string;
  progress: JobProgress;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface JobsState {
  // State
  jobs: Job[];
  activeJobId: string | null;

  // Actions
  addJob: (job: Omit<Job, 'createdAt' | 'progress' | 'status'>) => void;
  updateJobStatus: (jobId: string, status: JobStatus) => void;
  updateJobProgress: (jobId: string, progress: Partial<JobProgress>) => void;
  setJobError: (jobId: string, error: string) => void;
  removeJob: (jobId: string) => void;
  clearCompletedJobs: () => void;
  cancelJob: (jobId: string) => void;
  retryJob: (jobId: string) => void;
  setActiveJob: (jobId: string | null) => void;
  getJob: (jobId: string) => Job | undefined;
}

// =============================================================================
// Selectors - Use these with useJobsStore(selector) to avoid unnecessary re-renders
// =============================================================================

/** Select pending jobs - use with useJobsStore(selectPendingJobs) */
export const selectPendingJobs = (state: JobsState): Job[] =>
  state.jobs.filter((j) => j.status === 'pending');

/** Select running jobs - use with useJobsStore(selectRunningJobs) */
export const selectRunningJobs = (state: JobsState): Job[] =>
  state.jobs.filter((j) => j.status === 'running');

/** Select completed jobs - use with useJobsStore(selectCompletedJobs) */
export const selectCompletedJobs = (state: JobsState): Job[] =>
  state.jobs.filter((j) => j.status === 'completed');

/** Select failed jobs - use with useJobsStore(selectFailedJobs) */
export const selectFailedJobs = (state: JobsState): Job[] =>
  state.jobs.filter((j) => j.status === 'failed');

/** Select active jobs (pending + running) */
export const selectActiveJobs = (state: JobsState): Job[] =>
  state.jobs.filter((j) => j.status === 'pending' || j.status === 'running');

/** Select job by ID - usage: useJobsStore(state => selectJobById(state, jobId)) */
export const selectJobById = (state: JobsState, jobId: string): Job | undefined =>
  state.jobs.find((j) => j.id === jobId);

// =============================================================================
// Store
// =============================================================================

export const useJobsStore = create<JobsState>()(
  immer((set, get) => ({
    // Initial state
    jobs: [],
    activeJobId: null,

    // Actions
    addJob: (jobData) => {
      set((state) => {
        const newJob: Job = {
          ...jobData,
          status: 'pending',
          createdAt: new Date().toISOString(),
          progress: {
            current: 0,
            total: 100,
            percentage: 0,
          },
        };
        state.jobs.push(newJob);
      });
    },

    updateJobStatus: (jobId: string, status: JobStatus) => {
      set((state) => {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job) {
          job.status = status;
          if (status === 'running' && !job.startedAt) {
            job.startedAt = new Date().toISOString();
          }
          if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            job.completedAt = new Date().toISOString();
          }
        }
      });
    },

    updateJobProgress: (jobId: string, progress: Partial<JobProgress>) => {
      set((state) => {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job) {
          job.progress = { ...job.progress, ...progress };
          if (progress.current !== undefined && progress.total !== undefined) {
            job.progress.percentage = Math.round((progress.current / progress.total) * 100);
          } else if (progress.current !== undefined && job.progress.total) {
            job.progress.percentage = Math.round((progress.current / job.progress.total) * 100);
          }
        }
      });
    },

    setJobError: (jobId: string, error: string) => {
      set((state) => {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job) {
          job.error = error;
          job.status = 'failed';
          job.completedAt = new Date().toISOString();
        }
      });
    },

    removeJob: (jobId: string) => {
      set((state) => {
        state.jobs = state.jobs.filter((j) => j.id !== jobId);
        if (state.activeJobId === jobId) {
          state.activeJobId = null;
        }
      });
    },

    clearCompletedJobs: () => {
      set((state) => {
        state.jobs = state.jobs.filter(
          (j) => j.status !== 'completed' && j.status !== 'failed' && j.status !== 'cancelled'
        );
      });
    },

    cancelJob: (jobId: string) => {
      set((state) => {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job && (job.status === 'pending' || job.status === 'running')) {
          job.status = 'cancelled';
          job.completedAt = new Date().toISOString();
        }
      });
    },

    retryJob: (jobId: string) => {
      set((state) => {
        const job = state.jobs.find((j) => j.id === jobId);
        if (job && (job.status === 'failed' || job.status === 'cancelled')) {
          job.status = 'pending';
          job.error = undefined;
          job.startedAt = undefined;
          job.completedAt = undefined;
          job.progress = {
            current: 0,
            total: job.progress.total,
            percentage: 0,
          };
        }
      });
    },

    setActiveJob: (jobId: string | null) => {
      set((state) => {
        state.activeJobId = jobId;
      });
    },

    getJob: (jobId: string) => {
      return get().jobs.find((j) => j.id === jobId);
    },
  }))
);
