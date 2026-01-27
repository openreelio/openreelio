/**
 * useJobs Hook
 *
 * Provides job queue management through Tauri IPC commands.
 * Handles job submission, cancellation, and status tracking.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { JobId, JobInfo, JobType, JobPriority, JobStats } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('Jobs');

// =============================================================================
// Types
// =============================================================================

export interface UseJobsOptions {
  /** Enable automatic polling for job updates */
  enablePolling?: boolean;
  /** Polling interval in milliseconds */
  pollingInterval?: number;
  /** Enable Tauri event listeners for real-time updates */
  enableEvents?: boolean;
}

export interface UseJobsReturn {
  /** List of current jobs */
  jobs: JobInfo[];
  /** Current queue statistics */
  stats: JobStats | null;
  /** Whether jobs are being loaded */
  isLoading: boolean;
  /** Last error that occurred */
  error: string | null;
  /** Submit a new job */
  submitJob: (
    jobType: JobType,
    payload: Record<string, unknown>,
    priority?: JobPriority
  ) => Promise<JobId>;
  /** Cancel a job */
  cancelJob: (jobId: JobId) => Promise<boolean>;
  /** Get a specific job by ID */
  getJob: (jobId: JobId) => Promise<JobInfo | null>;
  /** Refresh job list */
  refreshJobs: () => Promise<void>;
  /** Refresh job statistics */
  refreshStats: () => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLLING_INTERVAL = 2000; // 2 seconds

// =============================================================================
// Job Event Types
// =============================================================================

interface JobProgressEvent {
  jobId: string;
  progress: number;
  message?: string;
}

interface JobCompleteEvent {
  jobId: string;
  result: unknown;
}

interface JobFailedEvent {
  jobId: string;
  error: string;
}

// =============================================================================
// Hook
// =============================================================================

export function useJobs(options: UseJobsOptions = {}): UseJobsReturn {
  const {
    enablePolling = false,
    pollingInterval = DEFAULT_POLLING_INTERVAL,
    enableEvents = true,
  } = options;

  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch all jobs from backend
   */
  const refreshJobs = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await invoke<JobInfo[]>('get_jobs');
      setJobs(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      logger.error('Failed to fetch jobs', { error: err });
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Fetch job statistics from backend
   */
  const refreshStats = useCallback(async () => {
    try {
      const result = await invoke<JobStats>('get_job_stats');
      setStats(result);
    } catch (err) {
      logger.error('Failed to fetch job stats', { error: err });
    }
  }, []);

  /**
   * Submit a new job to the queue
   */
  const submitJob = useCallback(
    async (
      jobType: JobType,
      payload: Record<string, unknown>,
      priority?: JobPriority
    ): Promise<JobId> => {
      try {
        setError(null);

        const jobId = await invoke<JobId>('submit_job', {
          jobType,
          priority,
          payload,
        });

        // Refresh jobs list after submission
        await refreshJobs();
        await refreshStats();

        return jobId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw new Error(message);
      }
    },
    [refreshJobs, refreshStats]
  );

  /**
   * Cancel a job by ID
   */
  const cancelJob = useCallback(
    async (jobId: JobId): Promise<boolean> => {
      try {
        setError(null);

        const cancelled = await invoke<boolean>('cancel_job', { jobId });

        // Refresh jobs list after cancellation
        await refreshJobs();
        await refreshStats();

        return cancelled;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        logger.error('Failed to cancel job', { error: err });
        return false;
      }
    },
    [refreshJobs, refreshStats]
  );

  /**
   * Get a specific job by ID
   */
  const getJob = useCallback(async (jobId: JobId): Promise<JobInfo | null> => {
    try {
      setError(null);

      const job = await invoke<JobInfo | null>('get_job', { jobId });
      return job;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      logger.error('Failed to get job', { error: err });
      return null;
    }
  }, []);

  /**
   * Update a job in the local state
   */
  const updateJobInState = useCallback(
    (jobId: string, updater: (job: JobInfo) => JobInfo) => {
      setJobs((prev) =>
        prev.map((job) => (job.id === jobId ? updater(job) : job))
      );
    },
    []
  );

  // Set up Tauri event listeners for real-time job updates
  useEffect(() => {
    if (!enableEvents) return;

    const setupListeners = async () => {
      // Clean up previous listeners
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];

      try {
        const addListeners = async <T>(
          eventNames: readonly string[],
          handler: Parameters<typeof listen<T>>[1]
        ) => {
          for (const name of eventNames) {
            const unlisten = await listen<T>(name, handler);
            unlistenRefs.current.push(unlisten);
          }
        };

        await addListeners<JobProgressEvent>(
          ['job-progress', 'job:progress'] as const,
          (event) => {
            updateJobInState(event.payload.jobId, (job) => {
              if (job.status.type === 'completed' || job.status.type === 'failed') {
                return job;
              }
              return {
                ...job,
                status: {
                  type: 'running',
                  progress: event.payload.progress,
                  message: event.payload.message,
                },
              };
            });
          }
        );

        await addListeners<JobCompleteEvent>(
          ['job-complete', 'job:completed'] as const,
          (event) => {
            updateJobInState(event.payload.jobId, (job) => {
              if (job.status.type === 'completed') {
                return job;
              }
              return {
                ...job,
                status: {
                  type: 'completed',
                  result: event.payload.result,
                },
                completedAt: new Date().toISOString(),
              };
            });
            void refreshStats();
          }
        );

        await addListeners<JobFailedEvent>(
          ['job-failed', 'job:failed'] as const,
          (event) => {
            updateJobInState(event.payload.jobId, (job) => {
              if (job.status.type === 'failed') {
                return job;
              }
              return {
                ...job,
                status: {
                  type: 'failed',
                  error: event.payload.error,
                },
                completedAt: new Date().toISOString(),
              };
            });
            void refreshStats();
          }
        );
      } catch (err) {
        logger.error('Failed to set up job event listeners', { error: err });
      }
    };

    void setupListeners();

    return () => {
      for (const unlisten of unlistenRefs.current) {
        unlisten();
      }
      unlistenRefs.current = [];
    };
  }, [enableEvents, updateJobInState, refreshStats]);

  // Set up polling for job updates
  useEffect(() => {
    if (!enablePolling) return;

    // Set up polling interval (initial fetch is handled by the mount effect below)
    pollingRef.current = setInterval(() => {
      void refreshJobs();
      void refreshStats();
    }, pollingInterval);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [enablePolling, pollingInterval, refreshJobs, refreshStats]);

  // Initial fetch on mount (runs once)
  useEffect(() => {
    void refreshJobs();
    void refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    jobs,
    stats,
    isLoading,
    error,
    submitJob,
    cancelJob,
    getJob,
    refreshJobs,
    refreshStats,
  };
}
