/**
 * Video Generation Store
 *
 * Manages AI video generation job state with polling and auto-import.
 * Uses Zustand with Immer for immutable state updates.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@/services/logger';

enableMapSet();

const logger = createLogger('VideoGenStore');

// =============================================================================
// Types
// =============================================================================

export type VideoGenMode = 'text_to_video' | 'image_to_video' | 'multimodal';
export type VideoGenQuality = 'basic' | 'pro' | 'cinema';
export type VideoGenJobStatus =
  | 'submitting'
  | 'queued'
  | 'processing'
  | 'downloading'
  | 'importing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VideoGenJob {
  /** Local UUID */
  id: string;
  /** Remote API job ID (set after submission) */
  providerJobId: string | null;
  /** Generation prompt */
  prompt: string;
  /** Generation mode */
  mode: VideoGenMode;
  /** Quality tier */
  quality: VideoGenQuality;
  /** Requested duration in seconds */
  durationSec: number;
  /** Current job status */
  status: VideoGenJobStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Estimated cost in cents */
  estimatedCostCents: number;
  /** Actual cost in cents (set after completion) */
  actualCostCents: number | null;
  /** Asset ID after import into project */
  assetId: string | null;
  /** Error message if failed */
  error: string | null;
  /** ISO timestamp when created */
  createdAt: string;
  /** ISO timestamp when completed */
  completedAt: string | null;
}

/** Parameters for submitting a new generation */
export interface SubmitGenerationParams {
  prompt: string;
  mode?: VideoGenMode;
  quality?: VideoGenQuality;
  durationSec?: number;
  negativePrompt?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudio?: string[];
  aspectRatio?: string;
  seed?: number;
  lipSyncLanguage?: string;
}

// =============================================================================
// Polling Constants
// =============================================================================

const POLL_INTERVAL_MS = 3000;

// =============================================================================
// Store
// =============================================================================

interface VideoGenState {
  /** All generation jobs (active + recent) */
  jobs: Map<string, VideoGenJob>;
  /** Whether the polling loop is running */
  isPolling: boolean;
  /** Interval ID for the polling loop */
  pollingIntervalId: ReturnType<typeof setInterval> | null;
  /** Prevent overlapping poll cycles */
  isPollInFlight: boolean;
}

interface VideoGenActions {
  /** Submit a new video generation job */
  submitGeneration: (params: SubmitGenerationParams) => Promise<string>;
  /** Poll all active jobs for status updates */
  pollActiveJobs: () => Promise<void>;
  /** Start the polling loop */
  startPolling: () => void;
  /** Stop the polling loop */
  stopPolling: () => void;
  /** Cancel a running job */
  cancelJob: (jobId: string) => Promise<void>;
  /** Handle job completion (download + import) */
  onJobCompleted: (jobId: string) => Promise<void>;
  /** Remove completed/failed jobs from the list */
  clearCompletedJobs: () => void;
  /** Get a job by its local ID */
  getJob: (jobId: string) => VideoGenJob | undefined;
  /** Get all active (non-terminal) jobs */
  getActiveJobs: () => VideoGenJob[];
}

export const useVideoGenStore = create<VideoGenState & VideoGenActions>()(
  immer((set, get) => ({
    // =========================================================================
    // State
    // =========================================================================
    jobs: new Map(),
    isPolling: false,
    pollingIntervalId: null,
    isPollInFlight: false,

    // =========================================================================
    // Actions
    // =========================================================================

    submitGeneration: async (params: SubmitGenerationParams): Promise<string> => {
      const localId = crypto.randomUUID();

      // Add job in submitting state
      set((state) => {
        state.jobs.set(localId, {
          id: localId,
          providerJobId: null,
          prompt: params.prompt,
          mode: params.mode ?? 'text_to_video',
          quality: params.quality ?? 'pro',
          durationSec: params.durationSec ?? 10,
          status: 'submitting',
          progress: 0,
          estimatedCostCents: 0,
          actualCostCents: null,
          assetId: null,
          error: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
        });
      });

      try {
        const result = await invoke<{
          jobId: string;
          providerJobId: string;
          estimatedCostCents: number;
        }>('submit_video_generation', {
          request: {
            prompt: params.prompt,
            mode: params.mode ?? 'text_to_video',
            quality: params.quality ?? 'pro',
            durationSec: params.durationSec ?? 10,
            negativePrompt: params.negativePrompt ?? null,
            referenceImages: params.referenceImages ?? [],
            referenceVideos: params.referenceVideos ?? [],
            referenceAudio: params.referenceAudio ?? [],
            aspectRatio: params.aspectRatio ?? '16:9',
            seed: params.seed ?? null,
            lipSyncLanguage: params.lipSyncLanguage ?? null,
          },
        });

        set((state) => {
          const job = state.jobs.get(localId);
          if (job) {
            // Honor cancel requested during submission
            if (job.status === 'cancelled') return;
            job.providerJobId = result.providerJobId;
            job.estimatedCostCents = result.estimatedCostCents;
            job.status = 'queued';
          }
        });

        // Start polling if not already
        const store = get();
        if (!store.isPolling) {
          store.startPolling();
        }

        logger.info('Video generation submitted', {
          localId,
          providerJobId: result.providerJobId,
          estimatedCostCents: result.estimatedCostCents,
        });

        return localId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          const job = state.jobs.get(localId);
          if (job) {
            job.status = 'failed';
            job.error = message;
          }
        });
        logger.error('Video generation submission failed', { error: message });
        throw error;
      }
    },

    pollActiveJobs: async () => {
      if (get().isPollInFlight) return;
      set((s) => {
        s.isPollInFlight = true;
      });

      try {
        const activeJobs = get().getActiveJobs();

        if (activeJobs.length === 0) {
          get().stopPolling();
          return;
        }

        for (const job of activeJobs) {
          if (!job.providerJobId) continue;
          if (job.status === 'downloading' || job.status === 'importing') continue;

          try {
            const status = await invoke<{
              status: string;
              progress: number | null;
              message: string | null;
              downloadUrl: string | null;
              durationSec: number | null;
              hasAudio: boolean | null;
              error: string | null;
            }>('poll_generation_job', {
              providerJobId: job.providerJobId,
            });

            set((state) => {
              const j = state.jobs.get(job.id);
              if (!j) return;

              switch (status.status) {
                case 'queued':
                  j.status = 'queued';
                  break;
                case 'processing':
                  j.status = 'processing';
                  j.progress = status.progress ?? j.progress;
                  break;
                case 'completed':
                  j.status = 'downloading';
                  j.progress = 100;
                  break;
                case 'failed':
                  j.status = 'failed';
                  j.error = status.error ?? 'Unknown error';
                  j.completedAt = new Date().toISOString();
                  break;
                case 'cancelled':
                  j.status = 'cancelled';
                  j.completedAt = new Date().toISOString();
                  break;
                default:
                  logger.warn('Unknown poll status received', {
                    jobId: job.id,
                    status: status.status,
                  });
                  break;
              }
            });

            // Trigger download+import for completed jobs
            if (status.status === 'completed') {
              get().onJobCompleted(job.id).catch((err) => {
                logger.error('Auto-import failed for job', { jobId: job.id, error: String(err) });
              });
            }
          } catch (error) {
            logger.warn('Poll failed for job', {
              jobId: job.id,
              error: String(error),
            });
          }
        }
      } finally {
        set((s) => {
          s.isPollInFlight = false;
        });
      }
    },

    startPolling: () => {
      const state = get();
      if (state.isPolling) return;

      const intervalId = setInterval(() => {
        get().pollActiveJobs();
      }, POLL_INTERVAL_MS);

      set((s) => {
        s.isPolling = true;
        s.pollingIntervalId = intervalId;
      });

      logger.debug('Video generation polling started');
    },

    stopPolling: () => {
      const state = get();
      if (!state.isPolling) return;

      if (state.pollingIntervalId !== null) {
        clearInterval(state.pollingIntervalId);
      }

      set((s) => {
        s.isPolling = false;
        s.pollingIntervalId = null;
      });

      logger.debug('Video generation polling stopped');
    },

    cancelJob: async (jobId: string) => {
      const job = get().jobs.get(jobId);
      if (!job) return;

      // If no providerJobId yet (still submitting), cancel locally
      if (!job.providerJobId) {
        set((state) => {
          const j = state.jobs.get(jobId);
          if (j) {
            j.status = 'cancelled';
            j.completedAt = new Date().toISOString();
          }
        });
        logger.info('Video generation cancelled locally (no provider ID yet)', { jobId });
        return;
      }

      try {
        await invoke('cancel_generation_job', {
          providerJobId: job.providerJobId,
        });

        set((state) => {
          const j = state.jobs.get(jobId);
          if (j) {
            j.status = 'cancelled';
            j.completedAt = new Date().toISOString();
          }
        });

        logger.info('Video generation cancelled', { jobId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Cancel failed', { jobId, error: message });
        throw new Error(message);
      }
    },

    onJobCompleted: async (jobId: string) => {
      const job = get().jobs.get(jobId);
      if (!job?.providerJobId) return;

      set((state) => {
        const j = state.jobs.get(jobId);
        if (j) j.status = 'downloading';
      });

      try {
        // Download the generated video
        const downloadResult = await invoke<{ outputPath: string }>(
          'download_generated_video',
          { providerJobId: job.providerJobId },
        );

        set((state) => {
          const j = state.jobs.get(jobId);
          if (j) j.status = 'importing';
        });

        // Import as asset
        const importResult = await invoke<{ id: string }>('import_asset', {
          uri: downloadResult.outputPath,
        });

        // Generate thumbnail
        try {
          await invoke('generate_asset_thumbnail', {
            assetId: importResult.id,
          });
        } catch (thumbErr) {
          logger.warn('Thumbnail generation failed', { error: String(thumbErr) });
        }

        set((state) => {
          const j = state.jobs.get(jobId);
          if (j) {
            j.status = 'completed';
            j.assetId = importResult.id;
            j.completedAt = new Date().toISOString();
          }
        });

        logger.info('Video generation completed and imported', {
          jobId,
          assetId: importResult.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => {
          const j = state.jobs.get(jobId);
          if (j) {
            j.status = 'failed';
            j.error = `Import failed: ${message}`;
            j.completedAt = new Date().toISOString();
          }
        });
        logger.error('Download/import failed', { jobId, error: message });
      }
    },

    clearCompletedJobs: () => {
      set((state) => {
        for (const [id, job] of state.jobs) {
          if (
            job.status === 'completed' ||
            job.status === 'failed' ||
            job.status === 'cancelled'
          ) {
            state.jobs.delete(id);
          }
        }
      });
    },

    getJob: (jobId: string) => {
      return get().jobs.get(jobId);
    },

    getActiveJobs: () => {
      const terminalStatuses: VideoGenJobStatus[] = ['completed', 'failed', 'cancelled'];
      return Array.from(get().jobs.values()).filter(
        (job) => !terminalStatuses.includes(job.status),
      );
    },
  })),
);

// =============================================================================
// Selectors
// =============================================================================

export const selectAllJobs = () =>
  Array.from(useVideoGenStore.getState().jobs.values());

export const selectActiveJobs = () =>
  useVideoGenStore.getState().getActiveJobs();

export const selectJobById = (id: string) =>
  useVideoGenStore.getState().getJob(id);
