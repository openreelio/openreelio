/**
 * Analysis Tools
 *
 * Timeline analysis tools for the AI agent system.
 * Provides read-only operations to query timeline state.
 */

import { invoke } from '@tauri-apps/api/core';
import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';

const logger = createLogger('AnalysisTools');

// =============================================================================
// Types
// =============================================================================

interface TimelineInfo {
  sequenceId: string;
  name: string;
  duration: number;
  trackCount: number;
  clipCount: number;
  frameRate: number;
}

interface ClipInfo {
  id: string;
  assetId: string;
  trackId: string;
  timelineIn: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  hasEffects: boolean;
  effectCount: number;
}

interface GapInfo {
  trackId: string;
  startTime: number;
  endTime: number;
  duration: number;
}

interface OverlapInfo {
  trackId: string;
  clip1Id: string;
  clip2Id: string;
  overlapStart: number;
  overlapEnd: number;
  overlapDuration: number;
}

// =============================================================================
// Tool Definitions
// =============================================================================

const ANALYSIS_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Get Timeline Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_timeline_info',
    description: 'Get general information about the current timeline/sequence',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
      },
      required: ['sequenceId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<TimelineInfo>('get_timeline_info', {
          sequenceId: args.sequenceId as string,
        });

        logger.debug('get_timeline_info executed', { sequenceId: args.sequenceId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_timeline_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Clips by Asset
  // ---------------------------------------------------------------------------
  {
    name: 'find_clips_by_asset',
    description: 'Find all clips in the timeline that use a specific asset',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        assetId: {
          type: 'string',
          description: 'The ID of the asset to search for',
        },
      },
      required: ['sequenceId', 'assetId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<ClipInfo[]>('find_clips_by_asset', {
          sequenceId: args.sequenceId as string,
          assetId: args.assetId as string,
        });

        logger.debug('find_clips_by_asset executed', {
          sequenceId: args.sequenceId,
          assetId: args.assetId,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_clips_by_asset failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Gaps
  // ---------------------------------------------------------------------------
  {
    name: 'find_gaps',
    description: 'Find empty gaps in the timeline between clips',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
        minDuration: {
          type: 'number',
          description: 'Minimum gap duration in seconds to report (default: 0)',
        },
      },
      required: ['sequenceId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<GapInfo[]>('find_timeline_gaps', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string | undefined,
          minDuration: (args.minDuration as number | undefined) ?? 0,
        });

        logger.debug('find_gaps executed', {
          sequenceId: args.sequenceId,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_gaps failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Find Overlaps
  // ---------------------------------------------------------------------------
  {
    name: 'find_overlaps',
    description: 'Find overlapping clips in the timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
      },
      required: ['sequenceId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<OverlapInfo[]>('find_timeline_overlaps', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string | undefined,
        });

        logger.debug('find_overlaps executed', {
          sequenceId: args.sequenceId,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('find_overlaps failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Clip Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_clip_info',
    description: 'Get detailed information about a specific clip',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence',
        },
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
      },
      required: ['sequenceId', 'trackId', 'clipId'],
    },
    handler: async (args) => {
      try {
        const result = await invoke<ClipInfo>('get_clip_info', {
          sequenceId: args.sequenceId as string,
          trackId: args.trackId as string,
          clipId: args.clipId as string,
        });

        logger.debug('get_clip_info executed', { clipId: args.clipId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_clip_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },
];

// =============================================================================
// Registration Functions
// =============================================================================

/**
 * Register all analysis tools with the global registry.
 */
export function registerAnalysisTools(): void {
  globalToolRegistry.registerMany(ANALYSIS_TOOLS);
  logger.info('Analysis tools registered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Unregister all analysis tools from the global registry.
 */
export function unregisterAnalysisTools(): void {
  for (const tool of ANALYSIS_TOOLS) {
    globalToolRegistry.unregister(tool.name);
  }
  logger.info('Analysis tools unregistered', { count: ANALYSIS_TOOLS.length });
}

/**
 * Get the list of analysis tool names.
 */
export function getAnalysisToolNames(): string[] {
  return ANALYSIS_TOOLS.map((t) => t.name);
}
