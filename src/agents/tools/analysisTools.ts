/**
 * Analysis Tools
 *
 * Timeline analysis tools for the AI agent system.
 * Provides read-only operations to query timeline state.
 *
 * These tools read from Zustand stores (frontend state) instead of calling
 * backend IPC handlers. The data is already available in projectStore,
 * timelineStore, and playbackStore.
 */

import { globalToolRegistry, type ToolDefinition } from '../ToolRegistry';
import { createLogger } from '@/services/logger';
import {
  getTimelineSnapshot,
  getClipById,
  getTrackById,
  getAllClipsOnTrack,
  getClipsAtTime,
  findClipsByAsset,
  findGaps,
  findOverlaps,
} from './storeAccessor';
import { usePlaybackStore } from '@/stores/playbackStore';

const logger = createLogger('AnalysisTools');

// =============================================================================
// Tool Definitions
// =============================================================================

const ANALYSIS_TOOLS: ToolDefinition[] = [
  // ---------------------------------------------------------------------------
  // Get Timeline Info
  // ---------------------------------------------------------------------------
  {
    name: 'get_timeline_info',
    description: 'Get general information about the current timeline/sequence including duration, track count, clip count, and playhead position',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sequenceId: {
          type: 'string',
          description: 'The ID of the sequence (optional, uses active sequence if omitted)',
        },
      },
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        const result = {
          sequenceId: snapshot.sequenceId,
          name: snapshot.sequenceName,
          duration: snapshot.duration,
          trackCount: snapshot.trackCount,
          clipCount: snapshot.clipCount,
          playheadPosition: snapshot.playheadPosition,
          selectedClipIds: snapshot.selectedClipIds,
          selectedTrackIds: snapshot.selectedTrackIds,
        };

        logger.debug('get_timeline_info executed', {
          sequenceId: snapshot.sequenceId,
          trackCount: snapshot.trackCount,
          clipCount: snapshot.clipCount,
        });
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
        assetId: {
          type: 'string',
          description: 'The ID of the asset to search for',
        },
      },
      required: ['assetId'],
    },
    handler: async (args) => {
      try {
        const result = findClipsByAsset(args.assetId as string);

        logger.debug('find_clips_by_asset executed', {
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
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
        minDuration: {
          type: 'number',
          description: 'Minimum gap duration in seconds to report (default: 0)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = findGaps(
          args.trackId as string | undefined,
          (args.minDuration as number | undefined) ?? 0,
        );

        logger.debug('find_gaps executed', { found: result.length });
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
    description: 'Find overlapping clips in the timeline on the same track',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        trackId: {
          type: 'string',
          description: 'The ID of the track to search (optional, searches all tracks if omitted)',
        },
      },
      required: [],
    },
    handler: async (args) => {
      try {
        const result = findOverlaps(args.trackId as string | undefined);

        logger.debug('find_overlaps executed', { found: result.length });
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
        clipId: {
          type: 'string',
          description: 'The ID of the clip',
        },
      },
      required: ['clipId'],
    },
    handler: async (args) => {
      try {
        const result = getClipById(args.clipId as string);

        if (!result) {
          return { success: false, error: `Clip '${args.clipId}' not found` };
        }

        logger.debug('get_clip_info executed', { clipId: args.clipId });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_clip_info failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // List All Clips
  // ---------------------------------------------------------------------------
  {
    name: 'list_all_clips',
    description: 'List all clips across all tracks with their positions and durations',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        logger.debug('list_all_clips executed', { clipCount: snapshot.clips.length });
        return { success: true, result: snapshot.clips };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_all_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // List Tracks
  // ---------------------------------------------------------------------------
  {
    name: 'list_tracks',
    description: 'List all tracks with their type, clip count, and status',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();

        logger.debug('list_tracks executed', { trackCount: snapshot.tracks.length });
        return { success: true, result: snapshot.tracks };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('list_tracks failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Clips at Time
  // ---------------------------------------------------------------------------
  {
    name: 'get_clips_at_time',
    description: 'Find all clips that span a specific time point on the timeline',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        time: {
          type: 'number',
          description: 'The time point in seconds to query',
        },
      },
      required: ['time'],
    },
    handler: async (args) => {
      try {
        const result = getClipsAtTime(args.time as number);

        logger.debug('get_clips_at_time executed', {
          time: args.time,
          found: result.length,
        });
        return { success: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_clips_at_time failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Selected Clips
  // ---------------------------------------------------------------------------
  {
    name: 'get_selected_clips',
    description: 'Get full details of all currently selected clips',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const snapshot = getTimelineSnapshot();
        const selectedSet = new Set(snapshot.selectedClipIds);
        const selectedClips = snapshot.clips.filter((c) => selectedSet.has(c.id));

        logger.debug('get_selected_clips executed', {
          selectedCount: selectedClips.length,
        });
        return { success: true, result: selectedClips };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_selected_clips failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Playhead Position
  // ---------------------------------------------------------------------------
  {
    name: 'get_playhead_position',
    description: 'Get the current playhead time position in seconds',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: async () => {
      try {
        const playback = usePlaybackStore.getState();

        logger.debug('get_playhead_position executed', {
          position: playback.currentTime,
        });
        return {
          success: true,
          result: {
            position: playback.currentTime,
            duration: playback.duration,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_playhead_position failed', { error: message });
        return { success: false, error: message };
      }
    },
  },

  // ---------------------------------------------------------------------------
  // Get Track Clips
  // ---------------------------------------------------------------------------
  {
    name: 'get_track_clips',
    description: 'Get all clips on a specific track',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        trackId: {
          type: 'string',
          description: 'The ID of the track',
        },
      },
      required: ['trackId'],
    },
    handler: async (args) => {
      try {
        const track = getTrackById(args.trackId as string);
        if (!track) {
          return { success: false, error: `Track '${args.trackId}' not found` };
        }

        const clips = getAllClipsOnTrack(args.trackId as string);

        logger.debug('get_track_clips executed', {
          trackId: args.trackId,
          clipCount: clips.length,
        });
        return { success: true, result: { track, clips } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('get_track_clips failed', { error: message });
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
