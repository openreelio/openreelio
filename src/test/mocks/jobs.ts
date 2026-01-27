/**
 * Jobs Mock Factories
 *
 * Provides mock factories for job queue related entities.
 * Used for testing job management hooks and components.
 */

import type { JobInfo, JobStats, JobStatusDto } from '@/types';

// =============================================================================
// Job Status Mocks
// =============================================================================

/**
 * Creates a queued job status.
 */
export function createQueuedStatus(): JobStatusDto {
  return { type: 'queued' };
}

/**
 * Creates a running job status with optional progress.
 */
export function createRunningStatus(progress = 0, message?: string): JobStatusDto {
  return {
    type: 'running',
    progress,
    message,
  };
}

/**
 * Creates a completed job status.
 */
export function createCompletedStatus(result: unknown = null): JobStatusDto {
  return { type: 'completed', result };
}

/**
 * Creates a failed job status.
 */
export function createFailedStatus(error: string): JobStatusDto {
  return {
    type: 'failed',
    error,
  };
}

/**
 * Creates a cancelled job status.
 */
export function createCancelledStatus(): JobStatusDto {
  return { type: 'cancelled' };
}

// =============================================================================
// Job Info Mocks
// =============================================================================

/**
 * Default values for JobInfo creation.
 */
const jobDefaults: Omit<JobInfo, 'id'> = {
  jobType: 'proxy_generation',
  priority: 'normal',
  status: { type: 'queued' },
  createdAt: new Date().toISOString(),
};

/**
 * Creates a mock JobInfo with optional overrides.
 *
 * @param overrides - Partial JobInfo properties to override defaults
 * @returns A complete JobInfo object
 *
 * @example
 * const job = createMockJob({ jobType: 'thumbnail_generation', status: createRunningStatus(50) });
 */
export function createMockJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: overrides.id ?? `job_${Math.random().toString(36).substring(7)}`,
    ...jobDefaults,
    ...overrides,
  };
}

/**
 * Creates a mock queued job.
 */
export function createMockQueuedJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return createMockJob({
    status: createQueuedStatus(),
    ...overrides,
  });
}

/**
 * Creates a mock running job with specified progress.
 */
export function createMockRunningJob(progress = 50, overrides: Partial<JobInfo> = {}): JobInfo {
  return createMockJob({
    status: createRunningStatus(progress, 'Processing...'),
    ...overrides,
  });
}

/**
 * Creates a mock completed job.
 */
export function createMockCompletedJob(overrides: Partial<JobInfo> = {}): JobInfo {
  return createMockJob({
    status: createCompletedStatus(),
    ...overrides,
  });
}

/**
 * Creates a mock failed job.
 */
export function createMockFailedJob(error = 'Job failed', overrides: Partial<JobInfo> = {}): JobInfo {
  return createMockJob({
    status: createFailedStatus(error),
    ...overrides,
  });
}

/**
 * Creates multiple mock jobs with different statuses.
 *
 * @param count - Number of jobs to create
 * @returns Array of JobInfo objects with varied statuses
 */
export function createMockJobs(count: number): JobInfo[] {
  const jobs: JobInfo[] = [];
  const statuses: JobStatusDto[] = [
    createQueuedStatus(),
    createRunningStatus(25),
    createRunningStatus(50),
    createRunningStatus(75),
    createCompletedStatus(),
  ];

  for (let i = 0; i < count; i++) {
    jobs.push(
      createMockJob({
        id: `job_${String(i + 1).padStart(3, '0')}`,
        status: statuses[i % statuses.length],
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
      }),
    );
  }

  return jobs;
}

// =============================================================================
// Job Stats Mocks
// =============================================================================

/**
 * Default values for JobStats creation.
 */
const statsDefaults: JobStats = {
  queueLength: 0,
  activeCount: 0,
  runningCount: 0,
  numWorkers: 4,
};

/**
 * Creates mock JobStats with optional overrides.
 *
 * @param overrides - Partial JobStats properties to override defaults
 * @returns A complete JobStats object
 *
 * @example
 * const stats = createMockJobStats({ queueLength: 5, runningCount: 2 });
 */
export function createMockJobStats(overrides: Partial<JobStats> = {}): JobStats {
  return {
    ...statsDefaults,
    ...overrides,
  };
}

/**
 * Creates mock JobStats representing an idle queue.
 */
export function createMockIdleStats(): JobStats {
  return createMockJobStats({
    queueLength: 0,
    activeCount: 0,
    runningCount: 0,
  });
}

/**
 * Creates mock JobStats representing a busy queue.
 */
export function createMockBusyStats(queueLength = 10, runningCount = 4): JobStats {
  return createMockJobStats({
    queueLength,
    activeCount: runningCount,
    runningCount,
    numWorkers: Math.max(4, runningCount),
  });
}

// =============================================================================
// Job Event Payload Mocks
// =============================================================================

/**
 * Creates a mock job progress event payload.
 */
export function createMockJobProgressPayload(
  jobId: string,
  progress: number,
  message?: string,
): { jobId: string; progress: number; message?: string } {
  return {
    jobId,
    progress,
    message,
  };
}

/**
 * Creates a mock job completion event payload.
 */
export function createMockJobCompletionPayload(
  jobId: string,
  result?: unknown,
): { jobId: string; result?: unknown } {
  return {
    jobId,
    result,
  };
}

/**
 * Creates a mock job failure event payload.
 */
export function createMockJobFailurePayload(
  jobId: string,
  error: string,
): { jobId: string; error: string } {
  return {
    jobId,
    error,
  };
}
