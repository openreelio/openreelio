/**
 * Render Queue Store
 *
 * Specialized render queue management extending the base job system.
 * Provides render-specific features like frame tracking, phase management,
 * priority queuing, and detailed progress.
 *
 * @module stores/renderQueueStore
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { nanoid } from 'nanoid';

// =============================================================================
// Types
// =============================================================================

/** Render job type discriminated union */
export type RenderJobType =
  | VideoRenderConfig
  | StillRenderConfig
  | SequenceRenderConfig;

/** Video render configuration */
interface VideoRenderConfig {
  type: 'video';
  sequenceId: string;
  outputPath: string;
  preset: string;
  codec?: string;
  bitrate?: string;
  resolution?: { width: number; height: number };
  fps?: number;
  range?: { start: number; end: number };
}

/** Still frame render configuration */
interface StillRenderConfig {
  type: 'still';
  sequenceId: string;
  outputPath: string;
  frame: number;
  format: 'png' | 'jpeg' | 'webp';
  quality?: number;
  scale?: number;
}

/** Image sequence render configuration */
interface SequenceRenderConfig {
  type: 'sequence';
  sequenceId: string;
  outputPath: string;
  startFrame: number;
  endFrame: number;
  format: 'png' | 'jpeg' | 'webp' | 'tiff';
  quality?: number;
  concurrency?: number;
}

/** Job status */
export type RenderJobStatus =
  | 'pending'
  | 'rendering'
  | 'encoding'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Render phase */
export type RenderPhase =
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'muxing'
  | 'finalizing';

/** Job priority */
export type RenderPriority = 'low' | 'normal' | 'high';

/** Priority weights for sorting */
const PRIORITY_WEIGHT: Record<RenderPriority, number> = {
  high: 100,
  normal: 50,
  low: 0,
};

/** Maximum retry attempts for a job */
export const MAX_RETRY_COUNT = 3;

/** Maximum number of completed jobs to keep in history */
export const MAX_COMPLETED_JOBS = 50;

/** Age in milliseconds after which completed jobs can be cleaned up */
export const COMPLETED_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Progress information */
export interface RenderProgress {
  /** Progress percentage (0-100) */
  percent: number;
  /** Current frame being processed */
  frame?: number;
  /** Total frames to process */
  totalFrames?: number;
  /** Current phase */
  phase: RenderPhase;
  /** Frames per second */
  fps?: number;
  /** Estimated time remaining (seconds) */
  etaSeconds?: number;
  /** Human-readable message */
  message?: string;
}

/** Render result */
export interface RenderResult {
  /** Output file size in bytes */
  fileSize?: number;
  /** Render duration in seconds */
  duration?: number;
  /** Final output path */
  outputPath?: string;
}

/** A render job */
export interface RenderJob {
  /** Unique job ID */
  id: string;
  /** Job configuration */
  config: RenderJobType;
  /** Current status */
  status: RenderJobStatus;
  /** Progress information */
  progress: RenderProgress;
  /** Priority level */
  priority: RenderPriority;
  /** Creation timestamp */
  createdAt: number;
  /** Start timestamp */
  startedAt?: number;
  /** Completion timestamp */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Render result if completed */
  result?: RenderResult;
  /** Number of retry attempts */
  retryCount: number;
}

/** Queue statistics */
export interface QueueStats {
  total: number;
  pending: number;
  rendering: number;
  encoding: number;
  completed: number;
  failed: number;
  cancelled: number;
}

// =============================================================================
// Store State & Actions
// =============================================================================

interface RenderQueueState {
  /** All render jobs */
  jobs: RenderJob[];
}

interface RenderQueueActions {
  /** Add a new render job */
  addRenderJob: (config: RenderJobType) => string;
  /** Start a pending job */
  startJob: (jobId: string) => void;
  /** Mark job as completed */
  completeJob: (jobId: string, result: RenderResult) => void;
  /** Mark job as failed */
  failJob: (jobId: string, error: string) => void;
  /** Cancel a job */
  cancelJob: (jobId: string) => void;
  /** Update job progress */
  updateProgress: (jobId: string, progress: Partial<RenderProgress>) => void;
  /** Set job priority */
  setPriority: (jobId: string, priority: RenderPriority) => void;
  /** Retry a failed job (respects MAX_RETRY_COUNT) */
  retryJob: (jobId: string) => void;
  /** Remove a job from queue */
  removeJob: (jobId: string) => void;
  /** Clear completed/cancelled/failed jobs */
  clearCompleted: () => void;
  /** Prune old completed jobs (auto-housekeeping) */
  pruneOldJobs: () => void;
  /** Clear all jobs */
  clearAll: () => void;
  /** Get job by ID */
  getJob: (jobId: string) => RenderJob | undefined;
  /** Get pending jobs (sorted by priority) */
  getPendingJobs: () => RenderJob[];
  /** Get active (rendering/encoding) jobs */
  getActiveJobs: () => RenderJob[];
  /** Get queue statistics */
  getStats: () => QueueStats;
  /** Check if job can be retried */
  canRetry: (jobId: string) => boolean;
}

export type RenderQueueStore = RenderQueueState & RenderQueueActions;

// =============================================================================
// Default Progress
// =============================================================================

function createDefaultProgress(): RenderProgress {
  return {
    percent: 0,
    phase: 'preparing',
  };
}

// =============================================================================
// Store Implementation
// =============================================================================

export const useRenderQueueStore = create<RenderQueueStore>()(
  devtools(
    immer((set, get) => ({
      // Initial state
      jobs: [],

      // Add a new render job
      addRenderJob: (config) => {
        const id = nanoid();

        set((state) => {
          const job: RenderJob = {
            id,
            config,
            status: 'pending',
            progress: createDefaultProgress(),
            priority: 'normal',
            createdAt: Date.now(),
            retryCount: 0,
          };
          state.jobs.push(job);
        });

        return id;
      },

      // Start a pending job
      startJob: (jobId) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job && job.status === 'pending') {
            job.status = 'rendering';
            job.startedAt = Date.now();
            job.progress.phase = 'rendering';
          }
        });
      },

      // Complete a job
      completeJob: (jobId, result) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job && (job.status === 'rendering' || job.status === 'encoding')) {
            job.status = 'completed';
            job.completedAt = Date.now();
            job.progress.percent = 100;
            job.progress.phase = 'finalizing';
            job.result = result;
          }
        });
      },

      // Fail a job
      failJob: (jobId, error) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job && (job.status === 'rendering' || job.status === 'encoding')) {
            job.status = 'failed';
            job.completedAt = Date.now();
            job.error = error;
          }
        });
      },

      // Cancel a job
      cancelJob: (jobId) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (
            job &&
            (job.status === 'pending' ||
              job.status === 'rendering' ||
              job.status === 'encoding')
          ) {
            job.status = 'cancelled';
            job.completedAt = Date.now();
          }
        });
      },

      // Update progress
      updateProgress: (jobId, progress) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job) {
            job.progress = { ...job.progress, ...progress };

            // Transition to encoding phase if we hit 100% rendering
            if (
              job.status === 'rendering' &&
              progress.phase === 'encoding'
            ) {
              job.status = 'encoding';
            }
          }
        });
      },

      // Set priority
      setPriority: (jobId, priority) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job) {
            job.priority = priority;
          }
        });
      },

      // Retry a failed job (with retry limit)
      retryJob: (jobId) => {
        set((state) => {
          const job = state.jobs.find((j) => j.id === jobId);
          if (job && (job.status === 'failed' || job.status === 'cancelled')) {
            // Check retry limit
            if (job.retryCount >= MAX_RETRY_COUNT) {
              // Max retries exceeded - leave as failed
              if (!job.error?.includes('Max retries exceeded')) {
                job.error = `${job.error ?? 'Failed'}. Max retries (${MAX_RETRY_COUNT}) exceeded.`;
              }
              return;
            }
            job.status = 'pending';
            job.progress = createDefaultProgress();
            job.error = undefined;
            job.startedAt = undefined;
            job.completedAt = undefined;
            job.result = undefined;
            job.retryCount += 1;
          }
        });
      },

      // Remove a job
      removeJob: (jobId) => {
        set((state) => {
          state.jobs = state.jobs.filter((j) => j.id !== jobId);
        });
      },

      // Clear completed/cancelled/failed jobs
      clearCompleted: () => {
        set((state) => {
          state.jobs = state.jobs.filter(
            (j) =>
              j.status !== 'completed' &&
              j.status !== 'cancelled' &&
              j.status !== 'failed'
          );
        });
      },

      // Clean up old completed jobs (auto-housekeeping)
      pruneOldJobs: () => {
        const now = Date.now();
        set((state) => {
          // Separate active jobs from completed ones
          const activeJobs = state.jobs.filter(
            (j) => j.status === 'pending' || j.status === 'rendering' || j.status === 'encoding'
          );
          const finishedJobs = state.jobs.filter(
            (j) => j.status === 'completed' || j.status === 'cancelled' || j.status === 'failed'
          );

          // Remove jobs older than max age
          const recentFinished = finishedJobs.filter(
            (j) => j.completedAt && now - j.completedAt < COMPLETED_JOB_MAX_AGE_MS
          );

          // Keep only the most recent completed jobs
          const sortedFinished = recentFinished.sort(
            (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)
          );
          const keptFinished = sortedFinished.slice(0, MAX_COMPLETED_JOBS);

          state.jobs = [...activeJobs, ...keptFinished];
        });
      },

      // Clear all jobs
      clearAll: () => {
        set((state) => {
          state.jobs = [];
        });
      },

      // Get job by ID
      getJob: (jobId) => {
        return get().jobs.find((j) => j.id === jobId);
      },

      // Get pending jobs sorted by priority
      getPendingJobs: () => {
        return get()
          .jobs.filter((j) => j.status === 'pending')
          .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]);
      },

      // Get active jobs
      getActiveJobs: () => {
        return get().jobs.filter(
          (j) => j.status === 'rendering' || j.status === 'encoding'
        );
      },

      // Get queue statistics
      getStats: () => {
        const jobs = get().jobs;
        return {
          total: jobs.length,
          pending: jobs.filter((j) => j.status === 'pending').length,
          rendering: jobs.filter((j) => j.status === 'rendering').length,
          encoding: jobs.filter((j) => j.status === 'encoding').length,
          completed: jobs.filter((j) => j.status === 'completed').length,
          failed: jobs.filter((j) => j.status === 'failed').length,
          cancelled: jobs.filter((j) => j.status === 'cancelled').length,
        };
      },

      // Check if a job can be retried
      canRetry: (jobId) => {
        const job = get().jobs.find((j) => j.id === jobId);
        if (!job) return false;
        if (job.status !== 'failed' && job.status !== 'cancelled') return false;
        return job.retryCount < MAX_RETRY_COUNT;
      },
    })),
    { name: 'render-queue-store' }
  )
);

// =============================================================================
// Convenience Hooks
// =============================================================================

/**
 * Hook to get pending render jobs.
 */
export function usePendingRenderJobs() {
  return useRenderQueueStore((state) => state.getPendingJobs());
}

/**
 * Hook to get active render jobs.
 */
export function useActiveRenderJobs() {
  return useRenderQueueStore((state) => state.getActiveJobs());
}

/**
 * Hook to get render queue statistics.
 */
export function useRenderQueueStats() {
  return useRenderQueueStore((state) => state.getStats());
}

/**
 * Hook to get a specific render job.
 */
export function useRenderJob(jobId: string) {
  return useRenderQueueStore((state) => state.getJob(jobId));
}

export default useRenderQueueStore;
