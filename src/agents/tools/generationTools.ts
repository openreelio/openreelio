/**
 * Generation Tools
 *
 * AI video generation tools for the agent system.
 * These tools enable the agentic engine to generate video content
 * via Seedance 2.0 and other providers.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { useVideoGenStore } from '@/stores/videoGenStore';
import { useProjectStore } from '@/stores/projectStore';
import { createLogger } from '@/services/logger';

const logger = createLogger('GenerationTools');

// =============================================================================
// Tool Definitions
// =============================================================================

const GENERATION_TOOLS: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // Generate Video
  // -------------------------------------------------------------------------
  {
    name: 'generate_video',
    description:
      'Submit an AI video generation request. Returns immediately with a job ID — does not block until completion. Use check_generation_status to monitor progress.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the video to generate',
        },
        mode: {
          type: 'string',
          enum: ['text_to_video', 'image_to_video', 'multimodal'],
          description: 'Generation mode (default: text_to_video)',
        },
        quality: {
          type: 'string',
          enum: ['basic', 'pro', 'cinema'],
          description: 'Quality tier affecting cost and fidelity (default: pro)',
        },
        durationSec: {
          type: 'number',
          description: 'Desired video duration in seconds (5-120, default: 10)',
        },
        referenceAssetIds: {
          type: 'array',
          description: 'Image/video/audio asset IDs to use as generation references',
        },
        aspectRatio: {
          type: 'string',
          description: 'Aspect ratio (16:9, 9:16, 1:1, default: 16:9)',
        },
      },
      required: ['prompt'],
    },
    handler: async (args) => {
      try {
        // Validate prompt is non-empty
        const prompt = (args.prompt as string)?.trim();
        if (!prompt) {
          return { success: false, error: 'Prompt cannot be empty' };
        }

        const referenceAssetIds = Array.isArray(args.referenceAssetIds)
          ? args.referenceAssetIds.filter(
              (id): id is string => typeof id === 'string' && id.trim().length > 0,
            )
          : [];

        // Resolve asset IDs to provider-ready URI lists by media type.
        const referenceImages: string[] = [];
        const referenceVideos: string[] = [];
        const referenceAudio: string[] = [];
        if (referenceAssetIds.length > 0) {
          const assets = useProjectStore.getState().assets;
          const missingIds: string[] = [];
          const unsupportedIds: string[] = [];

          for (const assetId of referenceAssetIds) {
            const asset = assets.get(assetId);
            if (!asset) {
              missingIds.push(assetId);
              continue;
            }

            switch (asset.kind) {
              case 'image':
                referenceImages.push(asset.uri);
                break;
              case 'video':
                referenceVideos.push(asset.uri);
                break;
              case 'audio':
                referenceAudio.push(asset.uri);
                break;
              default:
                unsupportedIds.push(assetId);
                break;
            }
          }

          if (missingIds.length > 0) {
            return {
              success: false,
              error: `Reference asset(s) not found: ${missingIds.join(', ')}`,
            };
          }

          if (unsupportedIds.length > 0) {
            return {
              success: false,
              error: `Reference asset(s) must be image/video/audio: ${unsupportedIds.join(', ')}`,
            };
          }
        }

        // Estimate cost first
        const quality = (args.quality as string) ?? 'pro';
        const durationSec = (args.durationSec as number) ?? 10;

        const estimate = await invoke<{
          estimatedCents: number;
          quality: string;
          durationSec: number;
        }>('estimate_generation_cost', { quality, durationSec });

        logger.info('Video generation cost estimate', {
          cents: estimate.estimatedCents,
          quality,
          durationSec,
        });

        // Submit via store
        const store = useVideoGenStore.getState();
        const jobId = await store.submitGeneration({
          prompt,
          mode: (args.mode as 'text_to_video' | 'image_to_video' | 'multimodal') ?? undefined,
          quality: (args.quality as 'basic' | 'pro' | 'cinema') ?? undefined,
          durationSec: (args.durationSec as number) ?? undefined,
          aspectRatio: (args.aspectRatio as string) ?? undefined,
          referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
          referenceVideos: referenceVideos.length > 0 ? referenceVideos : undefined,
          referenceAudio: referenceAudio.length > 0 ? referenceAudio : undefined,
        });

        return {
          success: true,
          result: {
            jobId,
            estimatedCostCents: estimate.estimatedCents,
            message: `Video generation submitted (est. $${(estimate.estimatedCents / 100).toFixed(2)}). Use check_generation_status with jobId "${jobId}" to monitor progress.`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('generate_video failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Check Generation Status
  // -------------------------------------------------------------------------
  {
    name: 'check_generation_status',
    description:
      'Check the current status of a video generation job. Returns status, progress, and asset ID if completed.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The local job ID returned by generate_video',
        },
      },
      required: ['jobId'],
    },
    handler: async (args) => {
      try {
        const store = useVideoGenStore.getState();
        const job = store.getJob(args.jobId as string);

        if (!job) {
          return {
            success: false,
            error: `Job not found: ${args.jobId}`,
          };
        }

        return {
          success: true,
          result: {
            status: job.status,
            progress: job.progress,
            assetId: job.assetId,
            error: job.error,
            estimatedCostCents: job.estimatedCostCents,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Estimate Generation Cost
  // -------------------------------------------------------------------------
  {
    name: 'estimate_generation_cost',
    description:
      'Estimate the cost of a video generation request without submitting it.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        quality: {
          type: 'string',
          enum: ['basic', 'pro', 'cinema'],
          description: 'Quality tier (default: pro)',
        },
        durationSec: {
          type: 'number',
          description: 'Duration in seconds (default: 10)',
        },
      },
    },
    handler: async (args) => {
      try {
        const quality = (args.quality as string) ?? 'pro';
        const durationSec = (args.durationSec as number) ?? 10;

        const estimate = await invoke<{
          estimatedCents: number;
          quality: string;
          durationSec: number;
        }>('estimate_generation_cost', { quality, durationSec });

        return {
          success: true,
          result: {
            estimatedCents: estimate.estimatedCents,
            quality: estimate.quality,
            durationSec: estimate.durationSec,
            formattedCost: `$${(estimate.estimatedCents / 100).toFixed(2)}`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, error: message };
      }
    },
  },

  // -------------------------------------------------------------------------
  // Cancel Generation
  // -------------------------------------------------------------------------
  {
    name: 'cancel_generation',
    description: 'Cancel a running video generation job.',
    category: 'generation',
    parameters: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The local job ID to cancel',
        },
      },
      required: ['jobId'],
    },
    handler: async (args) => {
      try {
        const store = useVideoGenStore.getState();
        await store.cancelJob(args.jobId as string);

        return {
          success: true,
          result: { cancelled: true, jobId: args.jobId },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('cancel_generation failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all generation tools with the global registry.
 */
export function registerGenerationTools(): void {
  globalToolRegistry.registerMany(GENERATION_TOOLS);
  logger.info('Generation tools registered', { count: GENERATION_TOOLS.length });
}

/**
 * Unregister all generation tools from the global registry.
 */
export function unregisterGenerationTools(): void {
  for (const tool of GENERATION_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Generation tools unregistered', { count: GENERATION_TOOLS.length });
}

/**
 * Get the list of generation tool names.
 */
export function getGenerationToolNames(): string[] {
  return GENERATION_TOOLS.map((t) => t.name);
}
